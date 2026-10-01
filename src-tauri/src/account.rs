//! Signing in to the service and owning the account, as commands.
//!
//! The sign-in is a browser round trip with no deep link. The launcher
//! listens on an ephemeral port of `127.0.0.1`, asks the service for a
//! session that names that address and the S256 challenge of a verifier it
//! keeps, and opens the session's URL in the system browser. When the
//! provider sends the player back, the service sends the browser on to the
//! listener with a one-time code, and the core trades the code and the
//! verifier for the token. The token never appears in a poll, so whoever
//! else knows the session — somebody who created one and sent its link to
//! the player, say — cannot collect it. No custom URL scheme is registered,
//! and a listener on loopback needs no firewall rule.
//!
//! ```text
//! frontend          core + listener             online              browser
//!    | begin_sign_in  |                            |                     |
//!    |--------------->| bind 127.0.0.1:0           |                     |
//!    |                | POST /v1/auth/login-sessions                     |
//!    |                | {redirectUri, codeChallenge}                     |
//!    |                |--------------------------->|                     |
//!    |                |<-- id, url (pending) ------|                     |
//!    |                |------- open url ---------------------------->    |
//!    |<-- sessionId --|                            |<-- authorize -------|
//!    | poll_sign_in   |                            |--- 302 redirectUri  |
//!    |  (every 2 s)   |<-- GET /jknet/signin?session=..&code=.. ---------|
//!    |                | POST .../{id}/token {code, codeVerifier}         |
//!    |                |--------------------------->|                     |
//!    |                |<-- token, user ------------|                     |
//!    |                |--- "Signed in" page ----------------------------> |
//!    |<-- done, user -|                            |                     |
//! ```
//!
//! The listener and the exchange are [`LoopbackSignIn`]; the listener itself
//! is `crate::online::loopback`. The exchange runs as soon as the browser
//! arrives, whether or not a screen is polling, and [`SignInState`] keeps
//! how it ended for the next `poll_sign_in`. That poll also asks the service,
//! for the two things only the service knows: that the session failed or
//! expired, and that the service is older than the loopback sign-in. Such a
//! service ignores `redirectUri`, shows its own page and hands the token to
//! the poll, the way launchers 0.4.0 to 0.9.0 sign in; a token in the poll of
//! a loopback session is that sign and nothing else, and the core takes it.
//!
//! The token stops in the core. It is written into `settings.json` and put on
//! the `Authorization` header of every later call; `get_settings` strips it
//! out, so the webview is never given a string worth stealing. What the
//! frontend gets instead is [`AccountState`]: whether a token exists, and who
//! it belongs to.

use std::future::Future;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::error::{AppError, Result};
use crate::online::loopback::{CodeVerifier, LoopbackListener, Reply, Served};
use crate::online::{
    is_http_url, is_local_online, normalize_display_name, DeviceSession, LoginSession, Loopback,
    OnlineClient, OnlineContext, OnlineUser, SignInPoll, PROVIDERS,
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
    /// The player deleted the account on the service.
    Deleted,
    /// The service refused the stored token, so the launcher forgot it. Nobody
    /// asked for this one, which is why the window says so out loud.
    Expired,
}

/// What the frontend is allowed to know about the account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    /// Whether this build has a service to talk to at all.
    ///
    /// Follows the effective service address. Release builds use the public
    /// origin; **JKNet Online address** can override it for testing or self-hosting.
    pub online_configured: bool,
    /// Whether a token is on file. It says nothing about whether the service still
    /// accepts it: finding that out costs a request, and the sidebar has to
    /// paint before one could answer.
    pub online_signed_in: bool,
    /// The account as it was when the launcher last heard from the service.
    pub online_user: Option<OnlineUser>,
    /// The service this launcher talks to, so the Settings screen can show it.
    /// Empty when there is none.
    pub online_url: String,
    /// Whether that service runs on this machine, which is what makes the
    /// Developer sign-in button appear.
    pub local_online: bool,
    // --- slice: bundles ---
    /// Whether the account reviews bundle versions, as the service said at
    /// the last sign-in. False while signed out. The **Review queue** button
    /// of the Bundles tab hangs off it.
    pub is_admin: bool,
    /// Whether the account may manage the featured server mod list.
    pub is_server_mod_admin: bool,
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
/// the answer of the service is the one string that decides where the player's
/// browser goes, and it is checked for an `http` scheme in the core, one step
/// away from anything a webview could be talked into.
///
/// --- slice: sign-in binding ---
/// The session is a loopback one (see the module notes). Its listener runs
/// on a task of its own from here until the browser comes back, the
/// sign-in is cancelled or replaced by the next one, or the session's time
/// is up.
#[tauri::command]
pub async fn begin_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    signins: tauri::State<'_, SignInState>,
    provider: String,
) -> Result<SignInStart> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    // --- slice: online gate ---
    // Before the provider check, so a build with no service says "the service is
    // not open yet" rather than "the developer sign-in only works against a
    // service on this machine" — a sentence about a service that does not exist.
    if !ctx.configured() {
        return Err(AppError::OnlineNotConfigured);
    }
    let provider = check_provider(&provider, &ctx)?;

    // A second press of a sign-in button starts over: the listener of the
    // first one stops here.
    signins.stop(None);

    let signin = LoopbackSignIn::open(&online, &ctx, provider, device_name().as_deref()).await?;
    let session = signin.session().clone();

    if !is_http_url(&session.url) {
        return Err(AppError::InvalidInput(format!(
            "the service answered with {:?}, which is not a URL the launcher opens",
            session.url
        )));
    }

    let (stop, stopped) = oneshot::channel();
    signins.track(&session.id, stop);
    spawn_listener(app.clone(), signin, ctx, stopped);

    if let Err(e) = app.opener().open_url(session.url.clone(), None::<&str>) {
        signins.stop(Some(&session.id));
        return Err(AppError::Launch(format!(
            "the system browser did not open the sign-in page: {e}"
        )));
    }

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
///
/// --- slice: sign-in binding ---
/// A loopback session answers from [`SignInState`] once its listener has
/// ended, and asks the service until then; see the module notes for what
/// the service's answer can change. A session this launcher is not waiting
/// for is read the old way.
#[tauri::command]
pub async fn poll_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    signins: tauri::State<'_, SignInState>,
    session_id: String,
) -> Result<SignInPoll> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);

    let waiting = match signins.progress(&session_id) {
        Progress::Ended(end) => return Ok(end.poll()),
        Progress::Waiting => true,
        Progress::NotOurs => false,
    };
    let session = online.poll_login_session(&ctx, &session_id).await?;

    if waiting {
        match loopback_poll(&session) {
            LoopbackPoll::Pending => {
                // The listener may have finished while the service answered.
                return Ok(match signins.progress(&session_id) {
                    Progress::Ended(end) => end.poll(),
                    _ => SignInPoll {
                        status: "pending".into(),
                        user: None,
                        error: None,
                    },
                });
            }
            LoopbackPoll::Over => {
                signins.stop(Some(&session_id));
                return Ok(SignInPoll {
                    status: session.status,
                    user: None,
                    error: session.error,
                });
            }
            LoopbackPoll::OlderService => {
                log::info!(
                    "the service handed the token of sign-in {session_id} to the poll: it predates \
                     the loopback sign-in, so the listener stops and the poll's token is taken"
                );
                signins.stop(Some(&session_id));
            }
        }
    }

    if session.status != "done" {
        return Ok(SignInPoll {
            status: session.status,
            user: None,
            error: session.error,
        });
    }

    match (session.token, session.user) {
        (Some(token), Some(user)) => {
            let user = finish_sign_in(&app, &ctx.base_url, token, user).await?;
            Ok(SignInPoll {
                status: "done".into(),
                user: Some(user),
                error: None,
            })
        }
        // The contract hands out the token exactly once. A second read that
        // finds the session done is the same sign-in seen twice, which is
        // fine as long as the first read stored something.
        _ => match (ctx.signed_in(), settings.online_user.clone()) {
            (true, Some(user)) => Ok(SignInPoll {
                status: "done".into(),
                user: Some(user),
                error: None,
            }),
            _ => Err(AppError::Online {
                code: "conflict".into(),
                message: "this sign-in was already used. Start again.".into(),
            }),
        },
    }
}

// --- slice: sign-in binding ---
/// Stops the sign-in in progress: its listener closes, and the session on
/// the service expires on its own. **Cancel** on the waiting screen.
#[tauri::command]
pub fn cancel_sign_in(signins: tauri::State<'_, SignInState>) -> Result<()> {
    if signins.stop(None) {
        log::info!("sign-in cancelled");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// --- slice: sign-in binding ---
// The loopback sign-in: the listener, the verifier and the exchange, and
// what the commands remember about the one in progress.
// ---------------------------------------------------------------------------

/// How long the listener waits for the browser: the ten minutes a login
/// session may stay pending on the service, and half a minute for the
/// redirect of a sign-in finished in its last seconds. The clock starts
/// after the service answered, so the session ends first.
const LISTEN_FOR: Duration = Duration::from_secs(10 * 60 + 30);

/// How often the exchange is tried when the service refuses it as one
/// request too many from this address, and how long it waits in between.
/// The code works for five minutes; this stays well inside them. The
/// browser tab waits on its page meanwhile.
const EXCHANGE_ATTEMPTS: u32 = 6;
const EXCHANGE_RETRY: Duration = Duration::from_secs(10);

/// A loopback sign-in opened on the service: the listener bound before the
/// session so the session could name its port, the verifier behind the
/// session's challenge, and the session.
pub(crate) struct LoopbackSignIn {
    listener: LoopbackListener,
    verifier: CodeVerifier,
    session: LoginSession,
}

impl LoopbackSignIn {
    /// Binds the listener and opens the session.
    pub(crate) async fn open(
        online: &OnlineClient,
        ctx: &OnlineContext,
        provider: &str,
        device_name: Option<&str>,
    ) -> Result<LoopbackSignIn> {
        let listener = LoopbackListener::bind().await?;
        let verifier = CodeVerifier::new()?;
        let redirect_uri = listener.redirect_uri();
        let code_challenge = verifier.challenge();
        let session = online
            .open_login_session(
                ctx,
                provider,
                device_name,
                Some(&Loopback {
                    redirect_uri: &redirect_uri,
                    code_challenge: &code_challenge,
                }),
            )
            .await?;
        Ok(LoopbackSignIn {
            listener,
            verifier,
            session,
        })
    }

    /// The session as the service opened it.
    pub(crate) fn session(&self) -> &LoginSession {
        &self.session
    }

    /// Waits for the browser, trades its code and the verifier for the
    /// token, and hands token and account to `keep` before the browser is
    /// shown its page, so the page says what actually happened.
    pub(crate) async fn wait<T, F, Fut>(
        self,
        online: &OnlineClient,
        ctx: &OnlineContext,
        ttl: Duration,
        cancel: impl Future<Output = ()>,
        keep: F,
    ) -> Served<Result<T>>
    where
        F: FnOnce(String, OnlineUser) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let LoopbackSignIn {
            listener,
            verifier,
            session,
        } = self;
        let id = session.id.as_str();
        listener
            .serve(id, ttl, cancel, move |code| async move {
                let outcome = match exchange_code(online, ctx, id, &code, &verifier).await {
                    Ok(LoginSession {
                        token: Some(token),
                        user: Some(user),
                        ..
                    }) => keep(token, user).await,
                    Ok(_) => Err(AppError::Online {
                        code: "internal".into(),
                        message: "the service took the sign-in code but sent no token".into(),
                    }),
                    Err(e) => Err(e),
                };
                let reply = match &outcome {
                    Ok(_) => Reply::SignedIn,
                    Err(e) => Reply::Failed(failure_text(e)),
                };
                (reply, outcome)
            })
            .await
    }
}

/// `POST /v1/auth/login-sessions/{id}/token`, tried again while the service
/// refuses it as too many requests from this address: a room of players
/// behind one router signing in at once. Any other answer is final.
async fn exchange_code(
    online: &OnlineClient,
    ctx: &OnlineContext,
    id: &str,
    code: &str,
    verifier: &CodeVerifier,
) -> Result<LoginSession> {
    let mut attempt = 1;
    loop {
        match online
            .exchange_login_code(ctx, id, code, verifier.secret())
            .await
        {
            Err(AppError::Online { code: refusal, .. })
                if refusal == "rate_limited" && attempt < EXCHANGE_ATTEMPTS =>
            {
                attempt += 1;
                log::warn!("the sign-in code exchange was refused as too many, retrying");
                tokio::time::sleep(EXCHANGE_RETRY).await;
            }
            other => return other,
        }
    }
}

/// The sentence of a failed exchange, for the browser's page and the
/// waiting screen: the service's own words when it gave some.
fn failure_text(error: &AppError) -> String {
    match error {
        AppError::Online { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

/// Runs the listener of `signin` to its end and records the end in
/// [`SignInState`]. A sign-in that was stopped records nothing: whoever
/// stopped it has already forgotten it.
fn spawn_listener(
    app: tauri::AppHandle,
    signin: LoopbackSignIn,
    ctx: OnlineContext,
    stopped: oneshot::Receiver<()>,
) {
    let session_id = signin.session().id.clone();
    tauri::async_runtime::spawn(async move {
        let online = app.state::<OnlineClient>();
        let keep_app = app.clone();
        let base_url = ctx.base_url.clone();
        let served = signin
            .wait(
                &online,
                &ctx,
                LISTEN_FOR,
                async move {
                    // A sent stop and a dropped sender both end the wait.
                    let _ = stopped.await;
                },
                move |token, user| async move {
                    finish_sign_in(&keep_app, &base_url, token, user).await
                },
            )
            .await;
        let end = match served {
            Served::Finished(Ok(user)) => SignInEnd::SignedIn(user),
            Served::Finished(Err(e)) => {
                log::warn!("sign-in {session_id} failed at the code exchange: {e}");
                SignInEnd::Failed(failure_text(&e))
            }
            Served::TimedOut => {
                log::info!("sign-in {session_id}: the browser did not come back in time");
                SignInEnd::TimedOut
            }
            Served::Cancelled => return,
        };
        app.state::<SignInState>().end(&session_id, end);
    });
}

/// Stores a token the service handed out, with the account it belongs to,
/// and tells every screen. The end of every sign-in, the loopback one and the
/// old one alike.
async fn finish_sign_in(
    app: &tauri::AppHandle,
    base_url: &str,
    token: String,
    mut user: OnlineUser,
) -> Result<OnlineUser> {
    // --- slice: bundles ---
    // The login session carries the user and not the `admin` flag of
    // `GET /v1/me`. One more call with the fresh token reads it; a service
    // that cannot answer leaves the flag off, which costs an administrator
    // one sign-in and a player nothing.
    let signed = OnlineContext {
        base_url: base_url.to_string(),
        token: Some(token.clone()),
    };
    match app.state::<OnlineClient>().get_me(&signed).await {
        Ok(me) => {
            user.admin = me.admin;
            user.server_mod_admin = me.server_mod_admin;
        }
        Err(e) => log::warn!("cannot read the account after sign-in: {e}"),
    }
    store_account(&app.state::<AppState>(), Some(token), Some(user.clone()))?;
    announce(app, true, AccountChangeReason::SignedIn);
    log::info!("signed in as {} via {}", user.display_name, user.provider);
    Ok(user)
}

/// The loopback sign-in in progress, at most one, and how it ended.
///
/// Kept in Tauri's managed state because the listener outlives the command
/// that started it: the exchange runs whether or not a screen is polling,
/// and the next poll reads how it went from here.
#[derive(Default)]
pub struct SignInState {
    current: Mutex<Option<TrackedSignIn>>,
}

struct TrackedSignIn {
    session_id: String,
    /// Dropping it stops the listener. `None` once the listener has ended.
    stop: Option<oneshot::Sender<()>>,
    ended: Option<SignInEnd>,
}

/// How a loopback sign-in ended.
#[derive(Debug, Clone, PartialEq)]
enum SignInEnd {
    /// The token is stored.
    SignedIn(OnlineUser),
    /// The exchange failed; the service's words.
    Failed(String),
    /// The browser never came back.
    TimedOut,
}

impl SignInEnd {
    /// What `poll_sign_in` answers for it.
    fn poll(&self) -> SignInPoll {
        match self {
            SignInEnd::SignedIn(user) => SignInPoll {
                status: "done".into(),
                user: Some(user.clone()),
                error: None,
            },
            SignInEnd::Failed(message) => SignInPoll {
                status: "error".into(),
                user: None,
                error: Some(message.clone()),
            },
            SignInEnd::TimedOut => SignInPoll {
                status: "expired".into(),
                user: None,
                error: None,
            },
        }
    }
}

/// Where a session stands for this launcher.
#[derive(Debug, Clone, PartialEq)]
enum Progress {
    /// Not the loopback sign-in in progress: read the old way.
    NotOurs,
    /// Its listener is still waiting.
    Waiting,
    /// Its listener has ended so.
    Ended(SignInEnd),
}

impl SignInState {
    fn lock(&self) -> MutexGuard<'_, Option<TrackedSignIn>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts following `session_id`. Whatever was followed before is
    /// forgotten, and its listener stops with its sender.
    fn track(&self, session_id: &str, stop: oneshot::Sender<()>) {
        *self.lock() = Some(TrackedSignIn {
            session_id: session_id.to_string(),
            stop: Some(stop),
            ended: None,
        });
    }

    fn progress(&self, session_id: &str) -> Progress {
        match self.lock().as_ref() {
            Some(tracked) if tracked.session_id == session_id => match &tracked.ended {
                Some(end) => Progress::Ended(end.clone()),
                None => Progress::Waiting,
            },
            _ => Progress::NotOurs,
        }
    }

    /// Records how the listener of `session_id` ended, if that sign-in is
    /// still the one followed. The end stays until the next sign-in, so a
    /// poll that comes twice reads it twice.
    fn end(&self, session_id: &str, end: SignInEnd) {
        let mut current = self.lock();
        if let Some(tracked) = current
            .as_mut()
            .filter(|tracked| tracked.session_id == session_id)
        {
            tracked.stop = None;
            tracked.ended = Some(end);
        }
    }

    /// Stops the listener of `session_id`, or of whichever sign-in is
    /// followed with `None`, and forgets it. True when there was one.
    fn stop(&self, session_id: Option<&str>) -> bool {
        let mut current = self.lock();
        let matches = current
            .as_ref()
            .is_some_and(|tracked| session_id.is_none_or(|id| id == tracked.session_id));
        if matches {
            *current = None;
        }
        matches
    }
}

/// What the service's answer to the poll of a loopback session means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoopbackPoll {
    /// Still going: pending, or done and on its way to the listener, which
    /// does the exchange.
    Pending,
    /// Failed or expired on the service: the listener has nothing to wait for.
    Over,
    /// Done with the token in the poll: a service older than the loopback
    /// sign-in, which ignored `redirectUri`. The poll's token is the token.
    OlderService,
}

fn loopback_poll(session: &LoginSession) -> LoopbackPoll {
    match session.status.as_str() {
        "pending" => LoopbackPoll::Pending,
        "done" if session.token.is_some() => LoopbackPoll::OlderService,
        "done" => LoopbackPoll::Pending,
        _ => LoopbackPoll::Over,
    }
}

/// Forgets the account on this machine and invalidates the token on the service.
///
/// A service that cannot be reached does not keep the player signed in: the local
/// half runs whatever the remote half answered, because the alternative is a
/// Sign out button that does nothing while the network is down.
#[tauri::command]
pub async fn sign_out(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
) -> Result<()> {
    sign_out_here(&app, &state, &online).await
}

/// The body of [`sign_out`], which signing out this launcher's own session
/// from the devices card runs too.
async fn sign_out_here(
    app: &tauri::AppHandle,
    state: &AppState,
    online: &OnlineClient,
) -> Result<()> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);

    if ctx.signed_in() {
        if let Err(e) = online.logout(&ctx).await {
            log::warn!("the service did not confirm the sign-out: {e}");
        }
    }

    store_account(state, None, None)?;
    announce(app, false, AccountChangeReason::SignedOut);
    log::info!("signed out");
    Ok(())
}

/// Renames the account.
///
/// The name is cleaned and measured here first: the service applies the same rules
/// and would answer `400`, but a round trip to be told "too short" is a round
/// trip the player waits through.
///
/// The rename reaches this launcher alone. The service sends `me.updated` to the
/// owner of the token and to nobody else, because a friend receiving it would
/// read someone else's profile as their own. Friends learn the new name from
/// `GET /v1/friends`, which the Friends screen polls anyway.
#[tauri::command]
pub async fn update_display_name(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    display_name: String,
) -> Result<OnlineUser> {
    let name = normalize_display_name(&display_name)?;
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);

    let mut user = online.patch_me(&ctx, &name).await?;
    // --- slice: bundles ---
    // `PATCH /v1/me` answers with the contract's `User`, which has no `admin`
    // flag; the one read at sign-in survives the rename.
    user.admin = settings
        .online_user
        .as_ref()
        .is_some_and(|known| known.admin);
    user.server_mod_admin = settings
        .online_user
        .as_ref()
        .is_some_and(|known| known.server_mod_admin);
    store_account(&state, ctx.token.clone(), Some(user.clone()))?;
    // Signed in either way; the payload exists so a listener knows to reread
    // the account rather than to work out what changed.
    announce(&app, true, AccountChangeReason::Renamed);
    Ok(user)
}

// --- slice: communities ---
/// Whether the account shows among the regular players of communities: the
/// `showInRegulars` of `GET /v1/me`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegularsPrivacy {
    /// `None` when the service is older than the communities feature and has
    /// no such setting: the Settings card then says so instead of a switch.
    pub show_in_regulars: Option<bool>,
}

/// Reads the setting from the service. It is not cached in `settings.json`:
/// the card that shows it is the only reader, and the service is where the
/// setting lives, for every device of the account.
#[tauri::command]
pub async fn get_regulars_privacy(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
) -> Result<RegularsPrivacy> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    let me = online.get_me(&ctx).await?;
    Ok(RegularsPrivacy {
        show_in_regulars: me.show_in_regulars,
    })
}

/// Shows the account among the regular players of communities, or hides it.
///
/// Hiding it makes the service forget the days of play it counted. The
/// answer of `PATCH /v1/me` is the account as the service has it now, and it
/// replaces the stored copy — the name the sidebar prints included — as long
/// as the launcher is still signed in with the token the request carried.
#[tauri::command]
pub async fn set_show_in_regulars(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    show: bool,
) -> Result<RegularsPrivacy> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    let user = online.patch_show_in_regulars(&ctx, show).await?;
    if refresh_user(&state, ctx.token.as_deref(), user)? {
        announce(&app, true, AccountChangeReason::Renamed);
    }
    Ok(RegularsPrivacy {
        show_in_regulars: Some(show),
    })
}

/// Replaces the stored account with the one the service just answered, and
/// says whether anything a screen prints changed.
///
/// The flags of the stored copy survive: the contract's `User` carries none
/// (see [`update_display_name`]). Nothing is written when the token of the
/// request is no longer the one on file — a sign-out or another sign-in
/// finished while the request was out — so an answer cannot bring a
/// session back.
fn refresh_user(state: &AppState, token: Option<&str>, mut user: OnlineUser) -> Result<bool> {
    let mut settings = Settings::current(state)?;
    if token.is_none() || settings.online_token.as_deref() != token {
        return Ok(false);
    }
    let Some(known) = settings.online_user.as_ref() else {
        return Ok(false);
    };
    if known.id != user.id {
        return Ok(false);
    }
    user.admin = known.admin;
    user.server_mod_admin = known.server_mod_admin;
    if *known == user {
        return Ok(false);
    }
    settings.online_user = Some(user);
    settings.save(state)?;
    state.set_settings(settings)?;
    Ok(true)
}

/// Deletes the account, its friendships, its requests and its invites.
///
/// Nothing on this machine goes with it: clients, library files and settings
/// are the launcher's, not the service's.
#[tauri::command]
pub async fn delete_account(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
) -> Result<()> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);

    online.delete_me(&ctx).await?;
    store_account(&state, None, None)?;
    announce(&app, false, AccountChangeReason::Deleted);
    log::info!("the service account was deleted");
    Ok(())
}

// ---------------------------------------------------------------------------
// --- slice: web app ---
// Devices and sessions: every launcher and browser signed in to the account,
// and signing one of them out from here.
// ---------------------------------------------------------------------------

/// The id the service gave this launcher's own session, as the last listing
/// marked it `current`, with the token it was listed with.
///
/// Kept so that **Sign out** on this launcher's own row runs the sign-out of
/// this machine rather than deleting the token under its feet, which would
/// read as an expired session. The token is kept beside the id because a
/// sign-in in between makes the id someone else's.
#[derive(Default)]
pub struct SessionsState {
    current: Mutex<Option<CurrentSession>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CurrentSession {
    token: String,
    id: String,
}

impl SessionsState {
    fn remember(&self, current: Option<CurrentSession>) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = current;
    }

    /// The id of this launcher's session, while the token it was listed
    /// with is still the one in force.
    fn current_id(&self, token: Option<&str>) -> Option<String> {
        let current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        current
            .as_ref()
            .filter(|known| token.map(str::trim) == Some(known.token.as_str()))
            .map(|known| known.id.clone())
    }
}

/// Every launcher and browser signed in to the account, the most recently
/// used first. The session of this launcher is the one marked `current`.
#[tauri::command]
pub async fn get_sessions(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    sessions: tauri::State<'_, SessionsState>,
) -> Result<Vec<DeviceSession>> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    let list = online.list_sessions(&ctx).await?;
    sessions.remember(current_of(&list, ctx.token.as_deref()));
    Ok(list)
}

/// Signs devices of the account out: the session `id`, or with `others`
/// every session but this launcher's.
///
/// The device learns on its next request: a launcher at its next heartbeat
/// at the latest, a browser at once, since its socket closes. With no `id`,
/// or with the id of this launcher's own session, this is **Sign out** of
/// this machine.
#[tauri::command]
pub async fn revoke_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    sessions: tauri::State<'_, SessionsState>,
    id: Option<String>,
    others: bool,
) -> Result<()> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    let current = sessions.current_id(ctx.token.as_deref());
    match revoke_target(id, others, current.as_deref())? {
        RevokeTarget::Others => {
            online.revoke_other_sessions(&ctx).await?;
            log::info!("signed out every other device");
            Ok(())
        }
        RevokeTarget::One(id) => {
            online.revoke_session(&ctx, &id).await?;
            log::info!("signed a device out");
            Ok(())
        }
        RevokeTarget::ThisLauncher => {
            sessions.remember(None);
            sign_out_here(&app, &state, &online).await
        }
    }
}

/// What `revoke_session` was asked to sign out.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RevokeTarget {
    /// Every session of the account but this launcher's.
    Others,
    /// One session of another device.
    One(String),
    /// This launcher: its own sign-out.
    ThisLauncher,
}

/// Reads the arguments of `revoke_session`. `current` is the id of this
/// launcher's session, when a listing named it.
fn revoke_target(id: Option<String>, others: bool, current: Option<&str>) -> Result<RevokeTarget> {
    let id = id.map(|id| id.trim().to_string());
    match (id, others) {
        (Some(_), true) => Err(AppError::InvalidInput(
            "name one session or every other one, not both".into(),
        )),
        (None, true) => Ok(RevokeTarget::Others),
        (None, false) => Ok(RevokeTarget::ThisLauncher),
        (Some(id), false) if id.is_empty() => {
            Err(AppError::InvalidInput("the session id is empty".into()))
        }
        (Some(id), false) if current == Some(id.as_str()) => Ok(RevokeTarget::ThisLauncher),
        (Some(id), false) => Ok(RevokeTarget::One(id)),
    }
}

/// The session a listing marks as this launcher's, bound to the token that
/// listed it.
fn current_of(list: &[DeviceSession], token: Option<&str>) -> Option<CurrentSession> {
    let token = token.map(str::trim).filter(|token| !token.is_empty())?;
    list.iter()
        .find(|session| session.current)
        .map(|session| CurrentSession {
            token: token.to_string(),
            id: session.id.clone(),
        })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Builds the answer of `get_account_state` from a settings document.
///
/// Pure, so the rules it encodes — a blank token is not a sign-in, a build
/// with no service is signed out, the Developer button belongs to a local service —
/// are tested without a service.
///
/// It never fails and never touches the network, which is what lets the
/// sidebar and the Account card paint on the first frame of a launcher whose
/// service is switched off.
fn account_state(settings: &Settings) -> AccountState {
    let ctx = OnlineContext::from_settings(settings);
    account_state_of(ctx, settings.online_user.clone())
}

/// The same answer, built from the address and token that are actually in
/// force rather than from the document they came out of.
///
/// Split from [`account_state`] for the one state a debug build cannot reach
/// through `settings.json`: a blank stored address means "the default of this
/// build", and that default is a service in a debug build. The release state —
/// no service at all — is an `OnlineContext` with a blank `base_url`, which
/// this takes directly, so both halves of the switch are covered by one
/// `cargo test`.
fn account_state_of(ctx: OnlineContext, user: Option<OnlineUser>) -> AccountState {
    let configured = ctx.configured();
    AccountState {
        online_configured: configured,
        // Everything below follows the address. With no service there is nobody to
        // be signed in to, no account to name, and the Developer button would
        // open a sign-in that cannot start.
        online_signed_in: ctx.signed_in(),
        is_admin: configured && ctx.signed_in() && user.as_ref().is_some_and(|user| user.admin),
        is_server_mod_admin: configured
            && ctx.signed_in()
            && user.as_ref().is_some_and(|user| user.server_mod_admin),
        online_user: if configured { user } else { None },
        local_online: configured && is_local_online(&ctx.base_url),
        online_url: ctx.base_url,
    }
}

/// Refuses a provider the contract does not have, and the developer provider
/// against a service that is not on this machine.
fn check_provider<'a>(provider: &'a str, ctx: &OnlineContext) -> Result<&'a str> {
    if !PROVIDERS.contains(&provider) {
        return Err(AppError::InvalidInput(format!(
            "sign-in provider {provider:?}"
        )));
    }
    if provider == "dev" && !is_local_online(&ctx.base_url) {
        return Err(AppError::InvalidInput(
            "the developer sign-in only works against a service on this machine".into(),
        ));
    }
    Ok(provider)
}

/// The name the service shows next to the session, so a player can tell the
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
fn store_account(state: &AppState, token: Option<String>, user: Option<OnlineUser>) -> Result<()> {
    let mut settings = Settings::current(state)?;
    settings.online_token = token;
    settings.online_user = user;
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

/// Forgets a token the service no longer accepts.
///
/// Called from [`crate::online::OnlineClient`] when a request that carried a token
/// came back `401`, which is what an expired token — the contract gives one 90
/// days — or one revoked on another machine looks like from here. Without this
/// the sidebar keeps showing a name while every call and every heartbeat fails,
/// until the player works out that **Sign out** is the cure.
///
/// The call comes into this module rather than the settings on purpose: the
/// account is the one writer of `online_token` and `online_user`, so the transition
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
    // token the service refuses, and every later call reads the copy in memory.
    if let Err(e) = settings.save(&state) {
        log::warn!("cannot write the settings after a refused token: {e}");
    }
    if let Err(e) = state.set_settings(settings) {
        log::warn!("cannot forget a refused token: {e}");
        return;
    }

    log::warn!("the service refused the token: signed out");
    announce(app, false, AccountChangeReason::Expired);
}

/// Clears the token and the cached account, if `token` is still the one in
/// force.
///
/// Pure, and the whole state transition of an expired session: what it leaves
/// behind is a signed-out document that still names its service, so the Sign in
/// button on the next screen talks to the same one.
///
/// The comparison is what makes a burst of refusals do the work once, and what
/// keeps a `401` that belongs to a previous session from signing out the one
/// the player has just started.
fn clear_session(settings: &mut Settings, token: &str) -> bool {
    let current = settings.online_token.as_deref().map(str::trim);
    if current != Some(token.trim()) {
        return false;
    }
    settings.online_token = None;
    settings.online_user = None;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_in_settings() -> Settings {
        Settings {
            // Named rather than taken from `Settings::default()`: the default
            // follows the build profile, and these tests are about the account
            // and not about which service a profile ships with.
            online_url: crate::online::DEV_ONLINE_URL.into(),
            online_token: Some("0123456789abcdef".into()),
            online_user: Some(OnlineUser {
                id: "01JBX7Q2".into(),
                display_name: "Kyle Katarn".into(),
                avatar_url: None,
                provider: "jkhub".into(),
                provider_name: "kyle_k".into(),
                created_at: "2026-09-10T10:00:00Z".into(),
                admin: false,
                server_mod_admin: false,
            }),
            ..Settings::default()
        }
    }

    #[test]
    fn the_account_state_follows_the_token_and_the_service() {
        let state = account_state(&signed_in_settings());
        assert!(state.online_configured);
        assert!(state.online_signed_in);
        assert!(!state.is_admin);
        assert!(!state.is_server_mod_admin);
        assert_eq!(
            state.online_user.expect("a user").display_name,
            "Kyle Katarn"
        );
        // The development service runs here, so the Developer button shows.
        assert!(state.local_online);
        assert_eq!(state.online_url, crate::online::DEV_ONLINE_URL);
    }

    // --- slice: bundles ---

    #[test]
    fn the_admin_flag_follows_the_cached_account_and_the_sign_in() {
        let mut settings = signed_in_settings();
        if let Some(user) = settings.online_user.as_mut() {
            user.admin = true;
            user.server_mod_admin = true;
        }
        assert!(account_state(&settings).is_admin);
        assert!(account_state(&settings).is_server_mod_admin);

        // The flag is a property of a session, so a token that is gone takes
        // it with it, whatever the cached copy of the user still says.
        settings.online_token = None;
        assert!(!account_state(&settings).is_admin);
        assert!(!account_state(&settings).is_server_mod_admin);

        // A `GET /v1/me` of a service older than bundles carries no flag, and
        // so does a `User` inside a friend: both read as a plain account.
        let me: crate::online::Me =
            serde_json::from_str(r#"{"user":{"id":"01J","displayName":"Kyle","provider":"jkhub","providerName":"kyle"}}"#)
                .expect("an older answer parses");
        assert!(!me.admin);
        assert!(!me.server_mod_admin);
        let me: crate::online::Me =
            serde_json::from_str(r#"{"user":{"id":"01J","displayName":"Kyle","provider":"jkhub","providerName":"kyle"},"presence":{"status":"online"},"admin":true,"serverModAdmin":true}"#)
                .expect("the answer parses");
        assert!(me.admin);
        assert!(me.server_mod_admin);
        assert!(
            !me.user.admin,
            "the flag lives on the answer, not on the user"
        );
    }

    // --- slice: communities ---
    #[test]
    fn the_regulars_setting_reads_out_of_me_and_is_unknown_to_an_older_service() {
        let me: crate::online::Me = serde_json::from_str(
            r#"{"user":{"id":"01J","displayName":"Kyle","provider":"jkhub","providerName":"kyle"}}"#,
        )
        .expect("an older answer parses");
        assert_eq!(me.show_in_regulars, None);
        for (text, show) in [("true", true), ("false", false)] {
            let me: crate::online::Me = serde_json::from_str(&format!(
                r#"{{"user":{{"id":"01J","displayName":"Kyle","provider":"jkhub","providerName":"kyle"}},"showInRegulars":{text}}}"#
            ))
            .expect("the answer parses");
            assert_eq!(me.show_in_regulars, Some(show));
        }
        let answer = serde_json::to_value(RegularsPrivacy {
            show_in_regulars: Some(false),
        })
        .expect("serializes");
        assert_eq!(answer, serde_json::json!({ "showInRegulars": false }));
    }

    // --- slice: online gate ---

    /// A context with a token and whatever address the case is about, including
    /// a blank effective address for testing the unconfigured-service state.
    fn signed_in_at(base_url: &str) -> OnlineContext {
        OnlineContext {
            base_url: base_url.into(),
            token: Some("0123456789abcdef".into()),
        }
    }

    fn stored_user() -> Option<OnlineUser> {
        signed_in_settings().online_user
    }

    #[test]
    fn a_build_without_a_service_is_signed_out_and_says_which_of_the_two_it_is() {
        // The token is deliberately still there: a player who signed in
        // against a service of their own and then lost the address must not keep a
        // signed-in sidebar over screens with nothing behind them.
        let state = account_state_of(signed_in_at(""), stored_user());
        assert!(!state.online_configured);
        assert!(!state.online_signed_in);
        assert_eq!(state.online_user, None);
        assert!(!state.local_online);
        // Empty rather than an address nothing answers at: the Settings screen
        // prints this string in the **JKNet Online address** field.
        assert_eq!(state.online_url, "");
    }

    #[test]
    fn typing_an_address_switches_the_feature_on_without_a_new_build() {
        // How a self-hoster or a tester turns the service on, and how the whole
        // Account and Friends interface comes back.
        assert!(!account_state_of(signed_in_at(""), stored_user()).online_configured);

        let state = account_state_of(
            signed_in_at(&crate::online::normalize_online_url(
                "https://online.jknet.gg/",
            )),
            stored_user(),
        );
        assert!(state.online_configured);
        assert!(state.online_signed_in);
        assert_eq!(state.online_url, "https://online.jknet.gg");
        assert!(!state.local_online);
    }

    #[test]
    fn the_state_reaches_the_frontend_in_camel_case() {
        // `AccountState` in `src/lib/ipc.ts` switches on this field name.
        let json = serde_json::to_string(&account_state(&signed_in_settings()))
            .expect("the state serializes");
        assert!(json.contains("\"onlineConfigured\":true"), "{json}");
    }

    #[test]
    fn a_blank_token_is_not_a_sign_in() {
        // What a hand-edited `settings.json` produces, and what would otherwise
        // give the player a signed-in sidebar and a 401 on every click.
        let mut settings = signed_in_settings();
        settings.online_token = Some("   ".into());
        assert!(!account_state(&settings).online_signed_in);

        settings.online_token = None;
        assert!(!account_state(&settings).online_signed_in);
    }

    #[test]
    fn a_remote_service_hides_the_developer_button() {
        let mut settings = signed_in_settings();
        settings.online_url = "https://online.jknet.gg".into();
        let state = account_state(&settings);
        assert!(!state.local_online);
        assert_eq!(state.online_url, "https://online.jknet.gg");
    }

    #[test]
    fn a_refused_token_leaves_a_signed_out_document_that_still_names_its_service() {
        let mut settings = signed_in_settings();
        settings.online_url = "https://online.jknet.gg".into();
        assert!(clear_session(&mut settings, "0123456789abcdef"));

        assert_eq!(settings.online_token, None);
        assert_eq!(settings.online_user, None);
        assert!(!account_state(&settings).online_signed_in);
        // The address is not part of the session: signing in again has to go
        // to the service the player chose, not back to the development one.
        assert_eq!(settings.online_url, "https://online.jknet.gg");
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
        assert!(settings.online_token.is_some());
        assert!(settings.online_user.is_some());
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

        let read: AccountChanged = serde_json::from_str(&json).expect("the payload reads back");
        assert!(!read.signed_in);
        assert_eq!(read.reason, AccountChangeReason::Expired);
    }

    // --- slice: web app ---

    fn listed(id: &str, current: bool) -> DeviceSession {
        DeviceSession {
            id: id.into(),
            client: "launcher".into(),
            current,
            ..DeviceSession::default()
        }
    }

    #[test]
    fn signing_a_device_out_names_one_session_every_other_one_or_this_launcher() {
        assert_eq!(
            revoke_target(None, true, None).unwrap(),
            RevokeTarget::Others
        );
        assert_eq!(
            revoke_target(Some(" 01JPHONE ".into()), false, Some("01JPC")).unwrap(),
            RevokeTarget::One("01JPHONE".into())
        );
        // No id, or the id of this launcher's own session: the sign-out of
        // this machine, not a token deleted under its feet.
        assert_eq!(
            revoke_target(None, false, None).unwrap(),
            RevokeTarget::ThisLauncher
        );
        assert_eq!(
            revoke_target(Some("01JPC".into()), false, Some("01JPC")).unwrap(),
            RevokeTarget::ThisLauncher
        );
        // Not knowing which session is ours, an id is somebody else's.
        assert_eq!(
            revoke_target(Some("01JPC".into()), false, None).unwrap(),
            RevokeTarget::One("01JPC".into())
        );
        assert!(revoke_target(Some("01JPHONE".into()), true, None).is_err());
        assert!(revoke_target(Some("  ".into()), false, None).is_err());
    }

    #[test]
    fn this_launchers_session_is_known_only_for_the_token_that_listed_it() {
        let list = [listed("01JPHONE", false), listed("01JPC", true)];
        let sessions = SessionsState::default();
        sessions.remember(current_of(&list, Some("0123456789abcdef")));
        assert_eq!(
            sessions.current_id(Some("0123456789abcdef")).as_deref(),
            Some("01JPC")
        );
        // Signed out, or signed in again in between: the id is not ours.
        assert_eq!(sessions.current_id(None), None);
        assert_eq!(sessions.current_id(Some("fedcba9876543210")), None);

        // A listing without a current row, or without a token, remembers nothing.
        assert_eq!(
            current_of(&[listed("01JPHONE", false)], Some("0123456789abcdef")),
            None
        );
        assert_eq!(current_of(&list, None), None);
        assert_eq!(current_of(&list, Some(" ")), None);
    }

    #[test]
    fn the_sessions_of_the_contract_read_with_and_without_a_device() {
        let answer: serde_json::Value = serde_json::json!({ "sessions": [
            { "id": "01JWEB", "client": "web", "device": "phone", "deviceName": "JKNet web · Android · Chrome",
              "createdAt": "2026-09-26T10:00:00Z", "lastUsedAt": "2026-09-27T10:00:00Z",
              "expiresAt": "2026-12-25T10:00:00Z", "current": false, "online": true, "push": true },
            { "id": "01JPC", "client": "launcher", "device": null, "deviceName": null,
              "createdAt": "2026-09-20T10:00:00Z", "lastUsedAt": "2026-09-27T09:00:00Z",
              "expiresAt": "2026-12-19T10:00:00Z", "current": true, "online": false, "push": false }
        ]});
        let read: crate::online::DeviceSessions = serde_json::from_value(answer).expect("parses");
        let [phone, pc] = read.sessions.as_slice() else {
            panic!("two sessions")
        };
        assert_eq!(
            (phone.client.as_str(), phone.device.as_deref()),
            ("web", Some("phone"))
        );
        assert!(phone.online && phone.push && !phone.current);
        assert_eq!(
            (pc.device.as_deref(), pc.device_name.as_deref()),
            (None, None)
        );
        assert!(pc.current);

        // The frontend gets the same names back.
        let json = serde_json::to_value(phone).expect("writes");
        assert_eq!(json["deviceName"], "JKNet web · Android · Chrome");
        assert_eq!(json["lastUsedAt"], "2026-09-27T10:00:00Z");
    }

    /// The devices card against a service that is actually running: two
    /// launchers of one account, one signs the other out, then a third comes
    /// and goes with **Sign out of all other devices**.
    ///
    /// Ignored for the reason of `friends::online_tests`: it needs the real
    /// service on `127.0.0.1:8787` with the developer provider on. Run it by
    /// hand:
    ///
    /// ```text
    /// cargo test --lib -- --ignored --nocapture account::tests::devices
    /// ```
    #[tokio::test]
    #[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1"]
    async fn devices_are_listed_and_signed_out_against_the_real_service() {
        use crate::friends::online_tests::sign_in;

        let client = OnlineClient::new();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_secs()
            % 100_000;
        // The developer provider gives one account per name: three sign-ins
        // with one name are three devices of one account.
        let name = format!("Test Devices {stamp}");
        let pc = sign_in(&client, &name).await;
        let laptop = sign_in(&client, &name).await;
        assert_eq!(pc.user.id, laptop.user.id, "one account");

        let outcome = async {
            let listed = client
                .list_sessions(&pc.ctx)
                .await
                .map_err(|e| format!("GET /v1/me/sessions: {e}"))?;
            println!("GET /v1/me/sessions -> {listed:?}");
            let mine = current_of(&listed, pc.ctx.token.as_deref())
                .ok_or("no session is marked current")?;
            let theirs = client
                .list_sessions(&laptop.ctx)
                .await
                .map_err(|e| format!("GET /v1/me/sessions as the laptop: {e}"))?;
            let other = current_of(&theirs, laptop.ctx.token.as_deref())
                .ok_or("the laptop has no current session")?;
            if mine.id == other.id || !listed.iter().any(|row| row.id == other.id) {
                return Err(format!("the two launchers are not two rows: {listed:?}"));
            }
            if listed
                .iter()
                .any(|row| row.client != "launcher" || row.device.is_some())
            {
                return Err(format!(
                    "a launcher's session reads as the web app: {listed:?}"
                ));
            }

            // One device: the laptop's next call is refused.
            let target = revoke_target(Some(other.id.clone()), false, Some(&mine.id))
                .map_err(|e| e.to_string())?;
            let RevokeTarget::One(id) = target else {
                return Err("the laptop's row reads as this launcher".into());
            };
            client
                .revoke_session(&pc.ctx, &id)
                .await
                .map_err(|e| format!("DELETE /v1/me/sessions/{{id}}: {e}"))?;
            match client.get_me(&laptop.ctx).await {
                Err(AppError::Online { code, .. }) if code == "unauthorized" => {}
                other => return Err(format!("the signed-out laptop still gets {other:?}")),
            }
            let after = client
                .list_sessions(&pc.ctx)
                .await
                .map_err(|e| format!("GET /v1/me/sessions: {e}"))?;
            if after.iter().any(|row| row.id == id) {
                return Err(format!("the laptop is still listed: {after:?}"));
            }

            // Every other device: a third comes, and goes with the others.
            let phone = sign_in(&client, &name).await;
            client
                .revoke_other_sessions(&pc.ctx)
                .await
                .map_err(|e| format!("DELETE /v1/me/sessions?others=true: {e}"))?;
            match client.get_me(&phone.ctx).await {
                Err(AppError::Online { code, .. }) if code == "unauthorized" => {}
                other => return Err(format!("the third device still gets {other:?}")),
            }
            let alone = client
                .list_sessions(&pc.ctx)
                .await
                .map_err(|e| format!("GET /v1/me/sessions: {e}"))?;
            if alone.len() != 1 || !alone[0].current {
                return Err(format!("this launcher is not alone: {alone:?}"));
            }
            Ok::<(), String>(())
        }
        .await;

        match client.delete_me(&pc.ctx).await {
            Ok(()) => println!("DELETE /v1/me -> 204"),
            Err(e) => println!("DELETE /v1/me failed: {e}"),
        }
        outcome.expect("the scenario");
    }

    // --- slice: sign-in binding ---

    fn polled(status: &str, token: Option<&str>) -> LoginSession {
        serde_json::from_value(serde_json::json!({
            "id": "01JSIGNIN",
            "status": status,
            "token": token,
        }))
        .expect("a login session")
    }

    #[test]
    fn only_a_token_in_the_poll_of_a_loopback_session_means_an_older_service() {
        assert_eq!(
            loopback_poll(&polled("pending", None)),
            LoopbackPoll::Pending
        );
        // Done without a token: the browser is on its way to the listener,
        // which exchanges the code.
        assert_eq!(loopback_poll(&polled("done", None)), LoopbackPoll::Pending);
        assert_eq!(
            loopback_poll(&polled("done", Some("0123456789abcdef"))),
            LoopbackPoll::OlderService
        );
        assert_eq!(loopback_poll(&polled("error", None)), LoopbackPoll::Over);
        assert_eq!(loopback_poll(&polled("expired", None)), LoopbackPoll::Over);
        // A token next to a status that is not `done` is not a sign-in.
        assert_eq!(
            loopback_poll(&polled("error", Some("0123456789abcdef"))),
            LoopbackPoll::Over
        );
    }

    #[test]
    fn the_sign_in_in_progress_is_followed_until_it_ends_or_stops() {
        let signins = SignInState::default();
        assert_eq!(signins.progress("01JA"), Progress::NotOurs);

        let (stop, mut stopped) = oneshot::channel::<()>();
        signins.track("01JA", stop);
        assert_eq!(signins.progress("01JA"), Progress::Waiting);
        assert_eq!(signins.progress("01JB"), Progress::NotOurs);
        assert!(!signins.stop(Some("01JB")), "another session stops nothing");
        assert!(stopped
            .try_recv()
            .is_err_and(|e| e == oneshot::error::TryRecvError::Empty));

        // The end stays readable, twice, and names what the poll answers.
        let user = stored_user().expect("a user");
        signins.end("01JA", SignInEnd::SignedIn(user.clone()));
        for _ in 0..2 {
            let Progress::Ended(end) = signins.progress("01JA") else {
                panic!("the end is kept");
            };
            let poll = end.poll();
            assert_eq!(poll.status, "done");
            assert_eq!(poll.user, Some(user.clone()));
        }

        // A new sign-in replaces the old one and stops its listener.
        let (stop, mut stopped) = oneshot::channel::<()>();
        signins.track("01JB", stop);
        assert_eq!(signins.progress("01JA"), Progress::NotOurs);
        // The end of a sign-in that is no longer followed is dropped.
        signins.end("01JA", SignInEnd::TimedOut);
        assert_eq!(signins.progress("01JB"), Progress::Waiting);

        // Cancel: the listener's sender goes, and the session is forgotten.
        assert!(signins.stop(None));
        assert!(stopped
            .try_recv()
            .is_err_and(|e| e == oneshot::error::TryRecvError::Closed));
        assert_eq!(signins.progress("01JB"), Progress::NotOurs);
        assert!(!signins.stop(None));
    }

    #[test]
    fn how_a_sign_in_ended_reads_as_a_poll() {
        let failed = SignInEnd::Failed("The sign-in code or its verifier is wrong".into()).poll();
        assert_eq!(failed.status, "error");
        assert_eq!(
            failed.error.as_deref(),
            Some("The sign-in code or its verifier is wrong")
        );
        let late = SignInEnd::TimedOut.poll();
        assert_eq!((late.status.as_str(), late.error), ("expired", None));
    }

    /// Opens a loopback sign-in on `ctx` and waits for its code, which the
    /// stand-in delivers by itself when no browser opened the form. The
    /// token and the account, or how the listener ended.
    async fn loopback_against_the_mock(
        client: &OnlineClient,
        ctx: &OnlineContext,
    ) -> (LoginSession, Served<Result<(String, OnlineUser)>>) {
        let signin = LoopbackSignIn::open(client, ctx, "dev", Some("TESTBOX"))
            .await
            .expect("the dev provider opens a loopback session");
        let session = signin.session().clone();
        let served = signin
            .wait(
                client,
                ctx,
                Duration::from_secs(10),
                std::future::pending(),
                |token, user| async move { Ok((token, user)) },
            )
            .await;
        (session, served)
    }

    /// The loopback sign-in against `scripts/mock-online.mjs`, which plays
    /// the browser of the dev provider. Ignored like `online::mock_tests`:
    /// it needs Node and a free port.
    #[tokio::test]
    #[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
    async fn account_signs_in_on_loopback_against_the_mock() {
        let mock = crate::online::mock_tests::MockOnline::start(8811);
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: mock.base_url(),
            token: None,
        };
        let (session, served) = loopback_against_the_mock(&client, &ctx).await;
        let (token, user) = match served {
            Served::Finished(Ok(pair)) => pair,
            Served::Finished(Err(e)) => panic!("the exchange failed: {e}"),
            Served::Cancelled => panic!("cancelled"),
            Served::TimedOut => panic!("the code never came"),
        };
        assert_eq!(user.provider, "dev");

        // The poll says done and never carries the token.
        let polled = client
            .poll_login_session(&ctx, &session.id)
            .await
            .expect("the session reads");
        assert_eq!(polled.status, "done");
        assert!(polled.token.is_none(), "the poll handed out the token");
        assert_eq!(loopback_poll(&polled), LoopbackPoll::Pending);

        // The code works once.
        match client
            .exchange_login_code(&ctx, &session.id, "spent", "x".repeat(43).as_str())
            .await
        {
            Err(AppError::Online { code, .. }) => assert_eq!(code, "invalid"),
            other => panic!("expected a refusal, got {other:?}"),
        }

        let signed = OnlineContext {
            base_url: mock.base_url(),
            token: Some(token),
        };
        let me = client.get_me(&signed).await.expect("the token works");
        assert_eq!(me.user.id, user.id);
    }

    #[tokio::test]
    #[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
    async fn account_takes_the_poll_token_of_a_service_older_than_the_loopback_sign_in() {
        let mock = crate::online::mock_tests::MockOnline::start_with(
            8812,
            &[("MOCK_ONLINE_IGNORE_LOOPBACK", "1")],
        );
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: mock.base_url(),
            token: None,
        };
        let signin = LoopbackSignIn::open(&client, &ctx, "dev", None)
            .await
            .expect("an older service opens the session all the same");
        let id = signin.session().id.clone();

        let mut seen = None;
        for _ in 0..40 {
            let polled = client
                .poll_login_session(&ctx, &id)
                .await
                .expect("the session reads");
            if polled.status != "pending" {
                seen = Some(polled);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let polled = seen.expect("the dev session completes");
        assert_eq!(loopback_poll(&polled), LoopbackPoll::OlderService);
        assert!(polled.user.is_some());
        drop(signin);
    }

    #[tokio::test]
    #[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
    async fn account_legacy_sessions_are_refused_once_the_switch_is_off() {
        let mock = crate::online::mock_tests::MockOnline::start_with(
            8813,
            &[("MOCK_ONLINE_LEGACY_SIGNIN", "0")],
        );
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: mock.base_url(),
            token: None,
        };
        match client.create_login_session(&ctx, "dev", None).await {
            Err(AppError::Online { code, message }) => {
                assert_eq!(code, "invalid");
                assert!(message.contains("update JKNet"), "{message}");
            }
            other => panic!("expected the legacy refusal, got {other:?}"),
        }
        // The launcher's own sign-in does not depend on the switch.
        let (_, served) = loopback_against_the_mock(&client, &ctx).await;
        assert!(matches!(served, Served::Finished(Ok(_))));
    }

    /// Repeats a call the service refused as one too many from this address:
    /// the online tests sign in more players a minute than it lets through.
    async fn patiently<T, Fut>(what: &str, mut call: impl FnMut() -> Fut) -> Result<T>
    where
        Fut: Future<Output = Result<T>>,
    {
        for attempt in 1..=9 {
            match call().await {
                Err(AppError::Online { code, .. }) if code == "rate_limited" => {
                    println!("{what} refused as too many, attempt {attempt}; waiting");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                other => return other,
            }
        }
        call().await
    }

    /// A browser page of the sign-in, asked again while the service refuses
    /// it as too many. Redirects are not followed, so a callback answers
    /// with the `302` itself.
    async fn browser_page(url: &str) -> reqwest::Response {
        let browser = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .expect("a client");
        for attempt in 1..=9 {
            let response = browser.get(url).send().await.expect("the page answers");
            if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
                return response;
            }
            println!("a sign-in page refused as too many, attempt {attempt}; waiting");
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        panic!("the service kept refusing a sign-in page as too many");
    }

    /// The dev provider's form of `session`, then its callback with `name`:
    /// the callback's answer, not followed.
    async fn dev_callback(session: &LoginSession, name: &str) -> reqwest::Response {
        let form = browser_page(&session.url)
            .await
            .text()
            .await
            .expect("the dev form is text");
        let state = crate::friends::online_tests::hidden_state(&form)
            .expect("the dev form carries a state")
            .to_string();
        browser_page(&format!(
            "{}/v1/auth/dev/callback?state={state}&name={}",
            crate::online::DEV_ONLINE_URL,
            name.replace(' ', "%20")
        ))
        .await
    }

    /// The session and the one-time code of a loopback session opened with a
    /// listener nobody serves: the code is read off the redirect instead.
    async fn loopback_code_by_hand(
        client: &OnlineClient,
        ctx: &OnlineContext,
        name: &str,
    ) -> (LoginSession, CodeVerifier, String) {
        let listener = LoopbackListener::bind().await.expect("a loopback port");
        let redirect_uri = listener.redirect_uri();
        let verifier = CodeVerifier::new().expect("random bytes");
        let challenge = verifier.challenge();
        let loopback = Loopback {
            redirect_uri: &redirect_uri,
            code_challenge: &challenge,
        };
        let session = patiently("POST /v1/auth/login-sessions", || {
            client.open_login_session(ctx, "dev", Some("cargo test"), Some(&loopback))
        })
        .await
        .expect("the service opens a loopback session");
        let callback = dev_callback(&session, name).await;
        assert_eq!(
            callback.status(),
            reqwest::StatusCode::FOUND,
            "the callback of a loopback session redirects"
        );
        let location = callback
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let prefix = format!("{redirect_uri}?session={}&code=", session.id);
        let code = location
            .strip_prefix(&prefix)
            .unwrap_or_else(|| {
                panic!(
                    "the redirect goes elsewhere: {}",
                    location.split('?').next().unwrap_or_default()
                )
            })
            .to_string();
        assert_eq!(code.len(), 43, "32 bytes of base64url");
        drop(listener);
        (session, verifier, code)
    }

    /// The loopback sign-in against the real service: the session's poll says
    /// `done` and never carries the token, a wrong code or verifier is
    /// refused without saying which, and the right pair works once.
    ///
    /// Ignored like the devices test above; run it by hand:
    ///
    /// ```text
    /// cargo test --lib -- --ignored --nocapture account::tests::account_loopback
    /// ```
    #[tokio::test]
    #[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1"]
    async fn account_loopback_code_is_exchanged_once_and_never_polled_against_the_real_service() {
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: crate::online::DEV_ONLINE_URL.into(),
            token: None,
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_secs()
            % 100_000;
        let (session, verifier, code) =
            loopback_code_by_hand(&client, &ctx, &format!("Test Loopback {stamp}")).await;

        // Whoever polls the session learns that it is done, and no more.
        let polled = client
            .poll_login_session(&ctx, &session.id)
            .await
            .expect("the session reads");
        println!(
            "GET /v1/auth/login-sessions/{} -> {}, token {}, user {}",
            session.id,
            polled.status,
            polled.token.is_some(),
            polled.user.is_some()
        );
        assert_eq!(polled.status, "done");
        assert!(polled.token.is_none(), "the poll handed out the token");
        assert!(polled.user.is_none(), "the poll named the account");

        let refused = |outcome: Result<LoginSession>| match outcome {
            Err(AppError::Online { code, message }) => {
                assert_eq!(code, "invalid");
                message
            }
            other => panic!("expected 400 invalid, got {other:?}"),
        };
        let other = CodeVerifier::new().expect("random bytes");
        let wrong_verifier = refused(
            patiently("the exchange", || {
                client.exchange_login_code(&ctx, &session.id, &code, other.secret())
            })
            .await,
        );
        let not_the_code = "A".repeat(43);
        let wrong_code = refused(
            patiently("the exchange", || {
                client.exchange_login_code(&ctx, &session.id, &not_the_code, verifier.secret())
            })
            .await,
        );
        assert_eq!(
            wrong_verifier, wrong_code,
            "the refusal says which one was wrong"
        );

        let done = patiently("the exchange", || {
            client.exchange_login_code(&ctx, &session.id, &code, verifier.secret())
        })
        .await
        .expect("the right code and verifier give the token");
        let token = done.token.expect("the exchange carries the token");
        let user = done.user.expect("and the account");
        assert_eq!(done.status, "done");

        // Once.
        refused(
            patiently("the exchange", || {
                client.exchange_login_code(&ctx, &session.id, &code, verifier.secret())
            })
            .await,
        );

        let signed = OnlineContext {
            base_url: ctx.base_url.clone(),
            token: Some(token),
        };
        let me = client.get_me(&signed).await.expect("the token works");
        assert_eq!(me.user.id, user.id);
        client.delete_me(&signed).await.expect("the account goes");
    }

    #[tokio::test]
    #[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1"]
    async fn account_loopback_session_burns_after_five_wrong_exchanges_against_the_real_service() {
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: crate::online::DEV_ONLINE_URL.into(),
            token: None,
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_secs()
            % 100_000;
        let (session, verifier, code) =
            loopback_code_by_hand(&client, &ctx, &format!("Test Burnt {stamp}")).await;

        let wrong = CodeVerifier::new().expect("random bytes");
        for attempt in 1..=5 {
            match patiently("the exchange", || {
                client.exchange_login_code(&ctx, &session.id, &code, wrong.secret())
            })
            .await
            {
                Err(AppError::Online { code, message }) => {
                    assert_eq!(code, "invalid");
                    println!("wrong exchange {attempt} -> {message}");
                }
                other => panic!("expected 400 invalid, got {other:?}"),
            }
        }
        // The session is over: the right pair comes too late.
        match patiently("the exchange", || {
            client.exchange_login_code(&ctx, &session.id, &code, verifier.secret())
        })
        .await
        {
            Err(AppError::Online { code, .. }) => assert_eq!(code, "invalid"),
            other => panic!("the burnt session still hands out a token: {other:?}"),
        }
        let polled = client
            .poll_login_session(&ctx, &session.id)
            .await
            .expect("the session reads");
        assert_eq!(polled.status, "error");
        assert_eq!(loopback_poll(&polled), LoopbackPoll::Over);
        assert!(polled.token.is_none());
    }

    /// Launchers 0.4.0 to 0.9.0 and the community site sign in the old way,
    /// the token in the poll. The service keeps taking that while
    /// `JKNET_ONLINE_LEGACY_SIGNIN` is on, which is its default.
    #[tokio::test]
    #[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1"]
    async fn account_legacy_sign_in_still_works_against_the_real_service() {
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: crate::online::DEV_ONLINE_URL.into(),
            token: None,
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_secs()
            % 100_000;
        let session = patiently("POST /v1/auth/login-sessions", || {
            client.create_login_session(&ctx, "dev", Some("cargo test"))
        })
        .await
        .expect("a legacy session opens while the switch is on");
        let page = dev_callback(&session, &format!("Test Legacy {stamp}")).await;
        assert!(page.status().is_success(), "{}", page.status());
        let page = page.text().await.expect("text");
        assert!(page.contains("You can return to JKNet"), "{page}");

        let polled = client
            .poll_login_session(&ctx, &session.id)
            .await
            .expect("the session reads");
        assert_eq!(polled.status, "done");
        let token = polled
            .token
            .expect("the old sign-in gets its token in the poll");
        let signed = OnlineContext {
            base_url: ctx.base_url.clone(),
            token: Some(token),
        };
        client.delete_me(&signed).await.expect("the account goes");
    }

    #[test]
    fn the_developer_provider_is_refused_against_a_service_on_the_internet() {
        let remote = OnlineContext {
            base_url: "https://online.jknet.gg".into(),
            token: None,
        };
        // The dev provider hands out an account for any name typed into a
        // form. Offering it against someone else's service offers an open door.
        assert!(check_provider("dev", &remote).is_err());
        assert!(check_provider("jkhub", &remote).is_ok());

        let local = OnlineContext {
            base_url: crate::online::DEV_ONLINE_URL.into(),
            token: None,
        };
        assert!(check_provider("dev", &local).is_ok());
        assert!(check_provider("steam", &local).is_err());
        assert!(check_provider("", &local).is_err());
    }
}
