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
use tauri::Emitter;
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
}

/// What the frontend is allowed to know about the account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    /// Whether a token is on file. It says nothing about whether the hub still
    /// accepts it: finding that out costs a request, and the sidebar has to
    /// paint before one could answer.
    pub hub_signed_in: bool,
    /// The account as it was when the launcher last heard from the hub.
    pub hub_user: Option<HubUser>,
    /// The hub this launcher talks to, so the Settings screen can show it.
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
            announce(&app, true);
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
    announce(&app, false);
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
    announce(&app, true);
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
    announce(&app, false);
    log::info!("the hub account was deleted");
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Builds the answer of `get_account_state` from a settings document.
///
/// Pure, so the rules it encodes — a blank token is not a sign-in, the
/// Developer button belongs to a local hub — are tested without a hub.
fn account_state(settings: &Settings) -> AccountState {
    let ctx = HubContext::from_settings(settings);
    AccountState {
        hub_signed_in: ctx.signed_in(),
        hub_user: settings.hub_user.clone(),
        local_hub: is_local_hub(&ctx.base_url),
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
fn announce(app: &tauri::AppHandle, signed_in: bool) {
    if let Err(e) = app.emit(ACCOUNT_CHANGED_EVENT, AccountChanged { signed_in }) {
        log::warn!("cannot emit {ACCOUNT_CHANGED_EVENT}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_in_settings() -> Settings {
        Settings {
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
        assert!(state.hub_signed_in);
        assert_eq!(state.hub_user.expect("a user").display_name, "Kyle Katarn");
        // The stock hub is the development one, so the Developer button shows.
        assert!(state.local_hub);
        assert_eq!(state.hub_url, crate::hub::DEFAULT_HUB_URL);
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
            base_url: crate::hub::DEFAULT_HUB_URL.into(),
            token: None,
        };
        assert!(check_provider("dev", &local).is_ok());
        assert!(check_provider("steam", &local).is_err());
        assert!(check_provider("", &local).is_err());
    }
}
