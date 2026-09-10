//! Signing in to the hub and owning the account, as commands.
//!
//! The sign-in is a browser round trip with no deep link: the launcher asks
//! the hub for a session, opens the session's URL in the system browser, and
//! then polls the session until the provider sends the player back. Nothing
//! listens on a port and no custom URL scheme is registered, so nothing has to
//! survive a firewall prompt or a second launcher installed next to this one.
//!
//! ```text
//! frontend            core                       hub                browser
//!    | begin_sign_in    |                         |                    |
//!    |----------------->| POST /v1/auth/login-sessions                  |
//!    |                  |------------------------>|                    |
//!    |                  |<-- id, url (pending) ---|                    |
//!    |                  |------- open url -------------------------->  |
//!    |<-- sessionId ----|                         |<-- authorize ------|
//!    | poll_sign_in     |                         |                    |
//!    |----------------->| GET /v1/auth/login-sessions/{id}             |
//!    |                  |------------------------>|                    |
//!    |<-- pending ------|<-- pending -------------|                    |
//!    |   (every 2 s)    |                         |                    |
//!    |----------------->|------------------------>|                    |
//!    |<-- done, user ---|<-- done, token, user ---|                    |
//! ```
//!
//! The token stops in the core. It is written into `settings.json` and put on
//! the `Authorization` header of every later call; `get_settings` strips it
//! out, so the webview is never given a string worth stealing. What the
//! frontend gets instead is [`AccountState`]: whether a token exists, and who
//! it belongs to.

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, Result};
use crate::hub::{
    is_http_url, is_local_hub, normalize_display_name, HubClient, HubContext, HubUser, SignInPoll,
    PROVIDERS,
};
use crate::settings::Settings;
use crate::state::AppState;

/// Emitted whenever the launcher signs in, signs out, or changes the account
/// it is signed in as.
pub const ACCOUNT_CHANGED_EVENT: &str = "account:changed";

/// Payload of [`ACCOUNT_CHANGED_EVENT`].
///
/// `Deserialize` as well as `Serialize`: `crate::friends` listens for this
/// event to start and stop its heartbeat and its live socket, and a listener
/// receives the payload as the JSON text it was emitted as.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountChanged {
    pub signed_in: bool,
    /// What moved the account. The background tasks read `signed_in` alone;
    /// the window needs the difference between the two ways to end up signed
    /// out, because only one of them is worth a message on screen.
    pub reason: AccountChangeReason,
}

/// Why the account changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountChangeReason {
    /// A sign-in finished.
    SignedIn,
    /// The player pressed **Sign out**.
    SignedOut,
    /// The display name changed; the account is the same one.
    Renamed,
    /// The player deleted the account on the hub.
    Deleted,
    /// The hub refused the stored token, so the launcher forgot it. Nobody
    /// asked for this one, which is why the window says so out loud.
    Expired,
}

/// What the frontend is allowed to know about the account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    /// Whether this build has a hub to talk to at all.
    ///
    /// False in a release build until `hub::RELEASE_HUB_URL` names the public
    /// origin, and until then the whole account and friends interface is one
    /// sentence saying so. The player turns it on for their machine by typing
    /// an address into **Hub address** on the Settings screen, which is why
    /// that field stays visible in this state.
    pub hub_configured: bool,
    /// Whether a token is on file. It says nothing about whether the hub still
    /// accepts it: finding that out costs a request, and the sidebar has to
    /// paint before one could answer.
    pub hub_signed_in: bool,
    /// The account as it was when the launcher last heard from the hub.
    pub hub_user: Option<HubUser>,
    /// The hub this launcher talks to, so the Settings screen can show it.
    /// Empty when there is none.
    pub hub_url: String,
    /// Whether that hub runs on this machine, which is what makes the
    /// Developer sign-in button appear.
    pub local_hub: bool,
}

/// What `begin_sign_in` hands back: the session to poll and the URL that was
/// opened, so a player whose browser stayed shut can open it by hand.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInStart {
    pub session_id: String,
    pub url: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Reads the account out of the settings, without touching the network.
#[tauri::command]
pub fn get_account_state(state: tauri::State<'_, AppState>) -> Result<AccountState> {
    let settings = state.settings()?;
    Ok(account_state(&settings))
}

/// Opens a sign-in session and sends the player to the browser.
///
/// The command opens the URL itself rather than handing it to the frontend:
/// the answer of the hub is the one string that decides where the player's
/// browser goes, and it is checked for an `http` scheme in the core, one step
/// away from anything a webview could be talked into.
#[tauri::command]
pub async fn begin_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    provider: String,
) -> Result<SignInStart> {
    let settings = state.settings()?;
    let ctx = HubContext::from_settings(&settings);
    // --- slice: hub gate ---
    // Before the provider check, so a build with no hub says "the service is
    // not open yet" rather than "the developer sign-in only works against a
    // hub on this machine" — a sentence about a hub that does not exist.
    if !ctx.configured() {
        return Err(AppError::HubNotConfigured);
    }
    let provider = check_provider(&provider, &ctx)?;

    let session = hub
        .create_login_session(&ctx, provider, device_name().as_deref())
        .await?;

    if !is_http_url(&session.url) {
        return Err(AppError::InvalidInput(format!(
            "the hub answered with {:?}, which is not a URL the launcher opens",
            session.url
        )));
    }

    app.opener()
        .open_url(session.url.clone(), None::<&str>)
        .map_err(|e| {
            AppError::Launch(format!("the system browser did not open the sign-in page: {e}"))
        })?;

    log::info!("sign-in session {} opened for {provider}", session.id);
    Ok(SignInStart {
        session_id: session.id,
        url: session.url,
    })
}

/// Reads a sign-in session once. The frontend calls this every 2 s while the
/// browser tab is open.
///
/// On `done` the token and the account are written to `settings.json` before
/// the command answers, so a launcher closed the instant the player sees their
/// name is still signed in when it opens again.
#[tauri::command]
pub async fn poll_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    session_id: String,
) -> Result<SignInPoll> {
    let settings = state.settings()?;
    let ctx = HubContext::from_settings(&settings);
    let session = hub.poll_login_session(&ctx, &session_id).await?;

    if session.status != "done" {
        return Ok(SignInPoll {
            status: session.status,
            user: None,
            error: session.error,
        });
    }

    match (session.token, session.user) {
        (Some(token), Some(user)) => {
            store_account(&state, Some(token), Some(user.clone()))?;
            announce(&app, true, AccountChangeReason::SignedIn);
            log::info!("signed in as {} via {}", user.display_name, user.provider);
            Ok(SignInPoll {
                status: "done".into(),
                user: Some(user),
                error: None,
            })
        }
        // The contract hands out the token exactly once. A second read that
        // finds the session done is the same sign-in seen twice, which is
        // fine as long as the first read stored something.
        _ => match (ctx.signed_in(), settings.hub_user.clone()) {
            (true, Some(user)) => Ok(SignInPoll {
                status: "done".into(),
                user: Some(user),
                error: None,
            }),
            _ => Err(AppError::Hub {
                code: "conflict".into(),
                message: "this sign-in was already used. Start again.".into(),
            }),
        },
    }
}

/// Forgets the account on this machine and invalidates the token on the hub.
///
/// A hub that cannot be reached does not keep the player signed in: the local
/// half runs whatever the remote half answered, because the alternative is a
/// Sign out button that does nothing while the network is down.
#[tauri::command]
pub async fn sign_out(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
) -> Result<()> {
    let settings = state.settings()?;
    let ctx = HubContext::from_settings(&settings);

    if ctx.signed_in() {
        if let Err(e) = hub.logout(&ctx).await {
            log::warn!("the hub did not confirm the sign-out: {e}");
        }
    }

    store_account(&state, None, None)?;
    announce(&app, false, AccountChangeReason::SignedOut);
    log::info!("signed out");
    Ok(())
}

/// Renames the account.
///
/// The name is cleaned and measured here first: the hub applies the same rules
/// and would answer `400`, but a round trip to be told "too short" is a round
/// trip the player waits through.
///
/// The rename reaches this launcher alone. The hub sends `me.updated` to the
/// owner of the token and to nobody else, because a friend receiving it would
/// read someone else's profile as their own. Friends learn the new name from
/// `GET /v1/friends`, which the Friends screen polls anyway.
#[tauri::command]
pub async fn update_display_name(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    display_name: String,
) -> Result<HubUser> {
    let name = normalize_display_name(&display_name)?;
    let settings = state.settings()?;
    let ctx = HubContext::from_settings(&settings);

    let user = hub.patch_me(&ctx, &name).await?;
    store_account(&state, ctx.token.clone(), Some(user.clone()))?;
    // Signed in either way; the payload exists so a listener knows to reread
    // the account rather than to work out what changed.
    announce(&app, true, AccountChangeReason::Renamed);
    Ok(user)
}

/// Deletes the account, its friendships, its requests and its invites.
///
/// Nothing on this machine goes with it: clients, library files and settings
/// are the launcher's, not the hub's.
#[tauri::command]
pub async fn delete_account(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
) -> Result<()> {
    let settings = state.settings()?;
    let ctx = HubContext::from_settings(&settings);

    hub.delete_me(&ctx).await?;
    store_account(&state, None, None)?;
    announce(&app, false, AccountChangeReason::Deleted);
    log::info!("the hub account was deleted");
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Builds the answer of `get_account_state` from a settings document.
///
/// Pure, so the rules it encodes — a blank token is not a sign-in, a build
/// with no hub is signed out, the Developer button belongs to a local hub —
/// are tested without a hub.
///
/// It never fails and never touches the network, which is what lets the
/// sidebar and the Account card paint on the first frame of a launcher whose
/// hub is switched off.
fn account_state(settings: &Settings) -> AccountState {
    let ctx = HubContext::from_settings(settings);
    account_state_of(ctx, settings.hub_user.clone())
}

/// The same answer, built from the address and token that are actually in
/// force rather than from the document they came out of.
///
/// Split from [`account_state`] for the one state a debug build cannot reach
/// through `settings.json`: a blank stored address means "the default of this
/// build", and that default is a hub in a debug build. The release state —
/// no hub at all — is a `HubContext` with a blank `base_url`, which this takes
/// directly, so both halves of the switch are covered by one `cargo test`.
fn account_state_of(ctx: HubContext, user: Option<HubUser>) -> AccountState {
    let configured = ctx.configured();
    AccountState {
        hub_configured: configured,
        // Everything below follows the address. With no hub there is nobody to
        // be signed in to, no account to name, and the Developer button would
        // open a sign-in that cannot start.
        hub_signed_in: ctx.signed_in(),
        hub_user: if configured { user } else { None },
        local_hub: configured && is_local_hub(&ctx.base_url),
        hub_url: ctx.base_url,
    }
}

/// Refuses a provider the contract does not have, and the developer provider
/// against a hub that is not on this machine.
fn check_provider<'a>(provider: &'a str, ctx: &HubContext) -> Result<&'a str> {
    if !PROVIDERS.contains(&provider) {
        return Err(AppError::InvalidInput(format!(
            "sign-in provider {provider:?}"
        )));
    }
    if provider == "dev" && !is_local_hub(&ctx.base_url) {
        return Err(AppError::InvalidInput(
            "the developer sign-in only works against a hub on this machine".into(),
        ));
    }
    Ok(provider)
}

/// The name the hub shows next to the session, so a player can tell the
/// machine they are signing in from. Absent is fine: the field is optional.
fn device_name() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// Writes the token and the account into `settings.json`.
///
/// The document is read from disk first, like every other write in the
/// launcher: signing in must not undo a favourite server starred a second
/// earlier from another screen.
fn store_account(
    state: &AppState,
    token: Option<String>,
    user: Option<HubUser>,
) -> Result<()> {
    let mut settings = Settings::current(state)?;
    settings.hub_token = token;
    settings.hub_user = user;
    settings.save(state)?;
    state.set_settings(settings)
}

/// Tells every screen that the account changed.
///
/// A failed emit is logged and swallowed: the command it followed has already
/// done its work, and turning "the sidebar did not refresh" into "signing out
/// failed" would be a lie.
fn announce(app: &tauri::AppHandle, signed_in: bool, reason: AccountChangeReason) {
    let payload = AccountChanged { signed_in, reason };
    if let Err(e) = app.emit(ACCOUNT_CHANGED_EVENT, payload) {
        log::warn!("cannot emit {ACCOUNT_CHANGED_EVENT}: {e}");
    }
}

// ---------------------------------------------------------------------------
// An expired session
// ---------------------------------------------------------------------------

/// Forgets a token the hub no longer accepts.
///
/// Called from [`crate::hub::HubClient`] when a request that carried a token
/// came back `401`, which is what an expired token — the contract gives one 90
/// days — or one revoked on another machine looks like from here. Without this
/// the sidebar keeps showing a name while every call and every heartbeat fails,
/// until the player works out that **Sign out** is the cure.
///
/// The call comes into this module rather than the settings on purpose: the
/// account is the one writer of `hub_token` and `hub_user`, so the transition
/// lives next to every other write of those two fields, and one event name is
/// emitted from one place.
///
/// A token that is already gone — the second `401` of a burst, or a player who
/// signed out while the request was in flight — leaves everything alone and
/// announces nothing.
pub fn expire_session(app: &tauri::AppHandle, token: &str) {
    let state = app.state::<AppState>();
    let mut settings = match Settings::current(&state) {
        Ok(settings) => settings,
        Err(e) => {
            log::warn!("cannot read the settings to forget a refused token: {e}");
            return;
        }
    };
    if !clear_session(&mut settings, token) {
        return;
    }

    // The file first, then memory. A file that refuses the write is worth a
    // line in the log and nothing more: the launcher still has to stop using a
    // token the hub refuses, and every later call reads the copy in memory.
    if let Err(e) = settings.save(&state) {
        log::warn!("cannot write the settings after a refused token: {e}");
    }
    if let Err(e) = state.set_settings(settings) {
        log::warn!("cannot forget a refused token: {e}");
        return;
    }

    log::warn!("the hub refused the token: signed out");
    announce(app, false, AccountChangeReason::Expired);
}

/// Clears the token and the cached account, if `token` is still the one in
/// force.
///
/// Pure, and the whole state transition of an expired session: what it leaves
/// behind is a signed-out document that still names its hub, so the Sign in
/// button on the next screen talks to the same one.
///
/// The comparison is what makes a burst of refusals do the work once, and what
/// keeps a `401` that belongs to a previous session from signing out the one
/// the player has just started.
fn clear_session(settings: &mut Settings, token: &str) -> bool {
    let current = settings.hub_token.as_deref().map(str::trim);
    if current != Some(token.trim()) {
        return false;
    }
    settings.hub_token = None;
    settings.hub_user = None;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_in_settings() -> Settings {
        Settings {
            // Named rather than taken from `Settings::default()`: the default
            // follows the build profile, and these tests are about the account
            // and not about which hub a profile ships with.
            hub_url: crate::hub::DEV_HUB_URL.into(),
            hub_token: Some("0123456789abcdef".into()),
            hub_user: Some(HubUser {
                id: "01JBX7Q2".into(),
                display_name: "Kyle Katarn".into(),
                avatar_url: None,
                provider: "jkhub".into(),
                provider_name: "kyle_k".into(),
                created_at: "2026-09-10T10:00:00Z".into(),
            }),
            ..Settings::default()
        }
    }

    #[test]
    fn the_account_state_follows_the_token_and_the_hub() {
        let state = account_state(&signed_in_settings());
        assert!(state.hub_configured);
        assert!(state.hub_signed_in);
        assert_eq!(state.hub_user.expect("a user").display_name, "Kyle Katarn");
        // The development hub runs here, so the Developer button shows.
        assert!(state.local_hub);
        assert_eq!(state.hub_url, crate::hub::DEV_HUB_URL);
    }

    // --- slice: hub gate ---

    /// A context with a token and whatever address the case is about. A blank
    /// one is what a release build builds until `RELEASE_HUB_URL` names an
    /// origin, and what a debug build cannot produce from `settings.json`.
    fn signed_in_at(base_url: &str) -> HubContext {
        HubContext {
            base_url: base_url.into(),
            token: Some("0123456789abcdef".into()),
        }
    }

    fn stored_user() -> Option<HubUser> {
        signed_in_settings().hub_user
    }

    #[test]
    fn a_build_without_a_hub_is_signed_out_and_says_which_of_the_two_it_is() {
        // The token is deliberately still there: a player who signed in
        // against a hub of their own and then lost the address must not keep a
        // signed-in sidebar over screens with nothing behind them.
        let state = account_state_of(signed_in_at(""), stored_user());
        assert!(!state.hub_configured);
        assert!(!state.hub_signed_in);
        assert_eq!(state.hub_user, None);
        assert!(!state.local_hub);
        // Empty rather than an address nothing answers at: the Settings screen
        // prints this string in the **Hub address** field.
        assert_eq!(state.hub_url, "");
    }

    #[test]
    fn typing_an_address_switches_the_feature_on_without_a_new_build() {
        // How a self-hoster or a tester turns the hub on, and how the whole
        // Account and Friends interface comes back.
        assert!(!account_state_of(signed_in_at(""), stored_user()).hub_configured);

        let state = account_state_of(
            signed_in_at(&crate::hub::normalize_hub_url("https://hub.jknet.gg/")),
            stored_user(),
        );
        assert!(state.hub_configured);
        assert!(state.hub_signed_in);
        assert_eq!(state.hub_url, "https://hub.jknet.gg");
        assert!(!state.local_hub);
    }

    #[test]
    fn the_state_reaches_the_frontend_in_camel_case() {
        // `AccountState` in `src/lib/ipc.ts` switches on this field name.
        let json = serde_json::to_string(&account_state(&signed_in_settings()))
            .expect("the state serializes");
        assert!(json.contains("\"hubConfigured\":true"), "{json}");
    }

    #[test]
    fn a_blank_token_is_not_a_sign_in() {
        // What a hand-edited `settings.json` produces, and what would otherwise
        // give the player a signed-in sidebar and a 401 on every click.
        let mut settings = signed_in_settings();
        settings.hub_token = Some("   ".into());
        assert!(!account_state(&settings).hub_signed_in);

        settings.hub_token = None;
        assert!(!account_state(&settings).hub_signed_in);
    }

    #[test]
    fn a_remote_hub_hides_the_developer_button() {
        let mut settings = signed_in_settings();
        settings.hub_url = "https://hub.jknet.gg".into();
        let state = account_state(&settings);
        assert!(!state.local_hub);
        assert_eq!(state.hub_url, "https://hub.jknet.gg");
    }

    #[test]
    fn a_refused_token_leaves_a_signed_out_document_that_still_names_its_hub() {
        let mut settings = signed_in_settings();
        settings.hub_url = "https://hub.jknet.gg".into();
        assert!(clear_session(&mut settings, "0123456789abcdef"));

        assert_eq!(settings.hub_token, None);
        assert_eq!(settings.hub_user, None);
        assert!(!account_state(&settings).hub_signed_in);
        // The address is not part of the session: signing in again has to go
        // to the hub the player chose, not back to the development one.
        assert_eq!(settings.hub_url, "https://hub.jknet.gg");
    }

    #[test]
    fn a_burst_of_refusals_signs_the_player_out_once() {
        // The Friends screen has four calls in flight at a time, and an expired
        // token brings all four back as 401. Only the first of them may write
        // the settings and announce the sign-out.
        let mut settings = signed_in_settings();
        assert!(clear_session(&mut settings, "0123456789abcdef"));
        assert!(!clear_session(&mut settings, "0123456789abcdef"));
    }

    #[test]
    fn a_refusal_that_belongs_to_an_older_session_is_ignored() {
        // The player signed out and in again while a request was in flight.
        // Acting on its answer would sign out the session they just started.
        let mut settings = signed_in_settings();
        assert!(!clear_session(&mut settings, "an-older-token"));
        assert!(settings.hub_token.is_some());
        assert!(settings.hub_user.is_some());
    }

    #[test]
    fn the_reason_reaches_the_window_in_camel_case() {
        // The window tells an expired session from a sign-out by this field,
        // and it reads the payload as the JSON text it was emitted as.
        let json = serde_json::to_string(&AccountChanged {
            signed_in: false,
            reason: AccountChangeReason::Expired,
        })
        .expect("the payload serializes");
        assert_eq!(json, r#"{"signedIn":false,"reason":"expired"}"#);

        let read: AccountChanged =
            serde_json::from_str(&json).expect("the payload reads back");
        assert!(!read.signed_in);
        assert_eq!(read.reason, AccountChangeReason::Expired);
    }

    #[test]
    fn the_developer_provider_is_refused_against_a_hub_on_the_internet() {
        let remote = HubContext {
            base_url: "https://hub.jknet.gg".into(),
            token: None,
        };
        // The dev provider hands out an account for any name typed into a
        // form. Offering it against someone else's hub offers an open door.
        assert!(check_provider("dev", &remote).is_err());
        assert!(check_provider("jkhub", &remote).is_ok());

        let local = HubContext {
            base_url: crate::hub::DEV_HUB_URL.into(),
            token: None,
        };
        assert!(check_provider("dev", &local).is_ok());
        assert!(check_provider("steam", &local).is_err());
        assert!(check_provider("", &local).is_err());
    }
}
