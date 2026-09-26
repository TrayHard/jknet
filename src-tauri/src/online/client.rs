//! The typed client of JKNet Online, over `reqwest`.
//!
//! One [`OnlineClient`] lives in Tauri's managed state and holds nothing but the
//! HTTP connection pool. Where to call and who to call as changes whenever the
//! player signs in or points the launcher at another service, so both travel in a
//! [`OnlineContext`] built from the settings at the moment of the call rather than
//! being frozen into the client at startup.
//!
//! Five rules of the contract are implemented here and nowhere else:
//!
//! - a request needs a service to go to: a build whose base URL is blank refuses
//!   with [`AppError::OnlineNotConfigured`] instead of opening a socket;
//! - a request takes at most 10 s;
//! - a failed request is retried once, and only when the connection itself was
//!   refused or reset, which is what a service restarting under the player looks
//!   like;
//! - a refusal carries `{"error":{"code","message"}}`, and that code is what
//!   [`AppError::Online`] keeps, because the cure for `provider_error` (wait for
//!   JKHub) has nothing in common with the cure for `conflict` (pick another
//!   name);
//! - a `401` to a request that carried a token means the service will not take that
//!   token again, so the launcher forgets it. Every call to the service passes
//!   through [`OnlineClient::call`], which is why this lives here rather than in
//!   each command and background task that could meet one.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::settings::Settings;

use super::types::{
    Friend, FriendsList, Invite, LoginSession, Me, NewInvite, OnlineUser, Presence, PresenceUpdate,
    RelayGrant, SendRequestResult,
};
// --- slice: chat ---
use super::types::{
    AddResult, ChatMessage, ChatPrivacy, ChatPrivacyPatch, ChatSyncDoc, Conversation, FileMeta,
    FileRegistration, GroupResult, MessagePage, NewMessage, ReactionGroup, SearchPage,
};

/// Where the service runs while it is being developed: `npm run tauri dev` and
/// `scripts/mock-online.mjs` on the same machine.
pub const DEV_ONLINE_URL: &str = "http://127.0.0.1:8787";

/// Where the service runs for a player who installed the launcher.
///
/// The production origin shared by installed launchers. The service handles
/// OAuth credentials and account data; players need no local service.
pub const RELEASE_ONLINE_URL: &str = "https://api.jknet.app";

/// The service this build talks to unless the player names another one.
///
/// The split follows the build profile rather than a cvar or an environment
/// variable, because the two audiences are exactly the two profiles. A debug
/// build is a developer with `scripts/mock-online.mjs` or the real service on
/// `localhost`; a release build connects to [`RELEASE_ONLINE_URL`]. Either way the
/// **JKNet Online address** field on the Settings screen overrides it, which is what
/// lets a tester or a self-hoster switch the feature on without a new build.
pub fn default_online_url() -> &'static str {
    default_online_url_for(cfg!(debug_assertions))
}

/// The half of [`default_online_url`] that does not read the build profile.
///
/// Split out so one `cargo test` run covers both answers: the profile is fixed
/// while the tests run, so a branch chosen by `cfg!` would never be tested in
/// the profile it does not belong to.
pub fn default_online_url_for(debug: bool) -> &'static str {
    if debug {
        DEV_ONLINE_URL
    } else {
        RELEASE_ONLINE_URL
    }
}

/// The whole budget of one request, connection included.
const TIMEOUT: Duration = Duration::from_secs(10);

// --- slice: bundles ---
/// How long the transfer client waits for a connection to open.
///
/// The transfer client carries the files of a bundle, which run to hundreds
/// of megabytes, so it cannot live under [`TIMEOUT`]: a whole-request budget
/// would cut every upload that a home connection takes more than ten seconds
/// over. It has two narrower limits instead, this one and
/// [`TRANSFER_STALL_TIMEOUT`].
const TRANSFER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a transfer may go without a byte arriving before it is called
/// dead. Applies to every read of a response, and resets after each one.
const TRANSFER_STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Providers the service knows. `dev` only answers on a service started with
/// `JKNET_ONLINE_DEV_PROVIDER=1`, which in practice means a service on this machine.
pub const PROVIDERS: [&str; 3] = ["jkhub", "discord", "dev"];

// --- slice: chat ---
/// The path prefix of the chat API. A refusal under it names its cause in
/// `details.reason`, which [`chat_refusal`] turns into the code.
const CHAT_PREFIX: &str = "/v1/chat/";

/// The code of a service that has no chat API at all: an older deployment
/// answers every `/v1/chat/*` route with `404 No such endpoint`. The chat
/// screens say "Chat is not available" on it instead of an error.
pub const CHAT_UNAVAILABLE_CODE: &str = "chat_unavailable";

/// Where a page of history starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageAnchor {
    /// The newest page.
    Latest,
    /// The messages right before this `seq`.
    Before(u64),
    /// The messages right after this `seq`.
    After(u64),
    /// A page with this `seq` in the middle, for a jump to a search result.
    Around(u64),
}

/// The filters of `GET /v1/chat/search`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    pub q: String,
    pub conversation_id: Option<String>,
    pub sender_id: Option<String>,
    /// `file`, `image`, `video`, `card` or `link`.
    pub has: Option<String>,
    /// The `nextCursor` of the previous page.
    pub before: Option<String>,
    pub limit: Option<u32>,
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/// Where to call and who to call as.
#[derive(Clone, Default)]
pub struct OnlineContext {
    /// Base URL without a trailing slash, such as `http://127.0.0.1:8787`.
    pub base_url: String,
    /// The bearer token, absent while the player is signed out.
    pub token: Option<String>,
}

/// Prints the address and never the token: a `{:?}` added while chasing a bug
/// must not put the one stealable string of the launcher into `jknet.log`.
impl std::fmt::Debug for OnlineContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnlineContext")
            .field("base_url", &self.base_url)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl OnlineContext {
    /// Reads the address and the token out of the settings document.
    pub fn from_settings(settings: &Settings) -> OnlineContext {
        OnlineContext {
            base_url: normalize_online_url(&settings.online_url),
            token: settings
                .online_token
                .as_ref()
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty()),
        }
    }

    /// Whether this build has a service to talk to at all.
    pub fn configured(&self) -> bool {
        online_configured(&self.base_url)
    }

    /// Whether a token is on file. Says nothing about whether the service still
    /// accepts it.
    ///
    /// A launcher with no service is never signed in, however old a token a
    /// hand-edited `settings.json` carries: there is nowhere to send it, so
    /// every screen that switches on this answer has to show the signed-out
    /// half.
    pub fn signed_in(&self) -> bool {
        self.configured() && self.token.is_some()
    }

    /// The token, or the refusal an authenticated call owes the caller.
    ///
    /// Asking the service without one would spend a round trip to be told the same
    /// thing, and the message would be the service's rather than the launcher's.
    fn token(&self) -> Result<&str> {
        self.token.as_deref().ok_or_else(|| AppError::Online {
            code: "unauthorized".into(),
            message: "Sign in to JKNet Online first.".into(),
        })
    }

    /// Joins the base URL with a path that already starts with a slash.
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    /// The address of the live socket, or `None` while signed out or while
    /// this build has no service: a socket without a token is a `401` the
    /// moment it opens.
    ///
    /// The address carries no token. `crate::friends::live` sends it in the
    /// `Authorization` header of the upgrade request, as every other call
    /// does, because an address is what log lines, proxies and error messages
    /// copy. Launchers up to 0.5.0 put it in `?token=`, which the service
    /// still accepts from them.
    pub fn ws_url(&self) -> Option<String> {
        if !self.signed_in() {
            return None;
        }
        Some(format!("{}/v1/ws", ws_base(&self.base_url)))
    }
}

/// Turns the API address into the address of the live socket.
///
/// `http` becomes `ws` and `https` becomes `wss`, which is the whole
/// transformation: the contract puts the socket on the same host, port and
/// path prefix as the API. An address that is already a socket address is left
/// alone, because a service reachable at `ws://…` in a test rig is still a service.
fn ws_base(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match base.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        _ => base.to_string(),
    }
}

/// Trims a service URL and drops the trailing slash, so joining a path never
/// produces `//v1/me`.
///
/// A blank address falls back to [`default_online_url`], which is itself blank in
/// a release build — so the answer may be an empty string, and every caller
/// asks [`online_configured`] before it starts a request.
pub fn normalize_online_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return default_online_url().to_string();
    }
    trimmed.to_string()
}

/// Whether there is a service to call at this address.
///
/// One question, asked wherever a service call or a service screen begins, so "the
/// service is not open yet" is one answer rather than an empty-string check
/// repeated in a dozen places.
///
/// The address handed in is the effective one, already through
/// [`normalize_online_url`]: `OnlineContext::base_url`, or the `online_url` of a
/// settings document, which the patch normalizes on the way in. Blank means
/// this build ships without a service and the player has named none — the state
/// the Account card explains instead of offering sign-in buttons.
pub fn online_configured(url: &str) -> bool {
    !url.trim().trim_end_matches('/').is_empty()
}

/// Whether a URL is one the launcher may hand to the system browser or call.
///
/// Anything but HTTP is refused on the spot: the service answers with a URL the
/// launcher opens without asking, and a `file:` or a `javascript:` there would
/// turn a compromised service into code running on the player's machine.
pub fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Whether the service runs on this machine.
///
/// The Developer sign-in button exists only for a local service: the `dev`
/// provider hands out an account for any name typed into a form, so offering
/// it against a service on the internet would be offering an unlocked door.
pub fn is_local_online(url: &str) -> bool {
    let after_scheme = match url.trim().to_ascii_lowercase().split_once("://") {
        Some((_, rest)) => rest.to_string(),
        None => return false,
    };
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_string();
    // `user:password@host:port` — the host is what is left after the last `@`.
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = match host_port.strip_prefix('[') {
        // An IPv6 literal keeps its colons, so the port cannot be split off
        // before the closing bracket.
        Some(rest) => rest.split(']').next().unwrap_or_default(),
        None => host_port.split(':').next().unwrap_or_default(),
    };

    if host == "localhost" {
        return true;
    }
    // Parsed, not matched on a prefix: `127.0.0.1.attacker.example` starts
    // with `127.` and resolves to whatever its owner wants it to.
    host.parse::<std::net::IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

/// Refuses a path segment that could climb out of the API.
///
/// Ids are opaque ULIDs in the contract, so anything outside the alphabet of
/// an identifier is either a bug on the frontend or an attempt to reach
/// another endpoint through `../`.
pub fn path_segment(value: &str) -> Result<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("an empty id".into()));
    }
    let clean = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !clean {
        return Err(AppError::InvalidInput(format!("id {trimmed:?}")));
    }
    Ok(trimmed)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// The path prefix of the sign-in endpoints.
///
/// A `401` from one of these is not an expired session to act on.
/// `POST /v1/auth/logout` answers it for a token the service has already forgotten,
/// and the sign-out that made the call is clearing the same token anyway — so
/// acting on it would tell a player who pressed **Sign out** that their session
/// expired.
const AUTH_PREFIX: &str = "/v1/auth/";

/// What the client does about a token the service refused.
///
/// A callback rather than an `AppHandle`, for two reasons. This module has no
/// business knowing that "the service refused the token" means "sign the launcher
/// out": `lib.rs` wires the two together. And a handle in this struct would
/// make the test binary of the crate link the whole window runtime for a handle
/// no test ever sets — a binary that then fails to load before the first test
/// runs, which is how this was found.
type RefusalHook = Box<dyn Fn(&str) + Send + Sync + 'static>;

// --- slice: bundles ---
/// Whether a call carries the bearer token.
///
/// The public routes of the bundle catalogue answer without a token and answer
/// more with one: `likedByMe` on every card, and the owner's own hidden bundle.
/// That third case is what the boolean of [`OnlineClient::call`] could not say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    /// Never send the token, whether or not there is one.
    None,
    /// Send the token when the player is signed in; go without it otherwise.
    Optional,
    /// Refuse before the request when there is no token to send.
    Required,
}

impl From<bool> for Auth {
    fn from(required: bool) -> Self {
        if required {
            Auth::Required
        } else {
            Auth::None
        }
    }
}

/// The connection pool shared by every call to the service.
pub struct OnlineClient {
    /// `None` when `reqwest` could not start, which on Windows means the TLS
    /// backend failed. Every call then refuses instead of panicking: a broken
    /// service client must not take the launcher's window with it.
    http: Option<reqwest::Client>,
    // --- slice: bundles ---
    /// The second pool, for the files of bundles. Built without the
    /// whole-request budget of `http` and with the two narrower limits of
    /// [`TRANSFER_CONNECT_TIMEOUT`] and [`TRANSFER_STALL_TIMEOUT`] instead.
    /// `None` for the same reason `http` can be.
    transfer: Option<reqwest::Client>,
    /// Where a refused token is reported. Set once from `setup`; empty in the
    /// tests, which have no launcher to sign out of.
    on_refusal: OnceLock<RefusalHook>,
    /// Holds that report to one caller at a time.
    ///
    /// The Friends screen has several calls in flight at once, and an expired
    /// token brings every one of them back as `401`. The lock plus the check
    /// the hook makes against the token in force turn that burst into one write
    /// and one event. Nothing is awaited while it is held.
    expiry: Mutex<()>,
}

impl Default for OnlineClient {
    fn default() -> Self {
        OnlineClient::new()
    }
}

impl OnlineClient {
    pub fn new() -> OnlineClient {
        let built = reqwest::Client::builder()
            .user_agent(concat!("JKNet/", env!("CARGO_PKG_VERSION")))
            .timeout(TIMEOUT)
            .gzip(true)
            .build();
        let http = match built {
            Ok(http) => Some(http),
            Err(e) => {
                log::error!("the service client could not start: {e}");
                None
            }
        };
        // --- slice: bundles ---
        // No gzip: the bodies are pk3 and exe files, and the service sends them
        // as they are.
        let transfer = match reqwest::Client::builder()
            .user_agent(concat!("JKNet/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(TRANSFER_CONNECT_TIMEOUT)
            .read_timeout(TRANSFER_STALL_TIMEOUT)
            .build()
        {
            Ok(transfer) => Some(transfer),
            Err(e) => {
                log::error!("the transfer client could not start: {e}");
                None
            }
        };
        OnlineClient {
            http,
            transfer,
            on_refusal: OnceLock::new(),
            expiry: Mutex::new(()),
        }
    }

    /// Says what to do with a token the service refuses.
    ///
    /// Called once from `setup`. Until then, and in the tests, a refused token
    /// is an error and nothing else.
    pub fn report_refusals_to(&self, forget: impl Fn(&str) + Send + Sync + 'static) {
        if self.on_refusal.set(Box::new(forget)).is_err() {
            log::warn!("the service client already knows where to report a refused token");
        }
    }

    /// Reports a token the service refused, one caller at a time.
    fn note_refused_token(&self, token: &str) {
        let Some(forget) = self.on_refusal.get() else {
            return;
        };
        // Sync from start to finish, so no future holds this lock across an
        // await point.
        let _busy = self.expiry.lock().unwrap_or_else(|e| e.into_inner());
        forget(token);
    }

    fn http(&self) -> Result<&reqwest::Client> {
        self.http
            .as_ref()
            .ok_or_else(|| AppError::Network("the HTTP client failed to start".into()))
    }

    // --- slice: bundles ---
    fn transfer(&self) -> Result<&reqwest::Client> {
        self.transfer
            .as_ref()
            .ok_or_else(|| AppError::Network("the transfer client failed to start".into()))
    }

    // -- Auth ---------------------------------------------------------------

    /// Opens a sign-in session. The answer carries the URL for the browser.
    pub async fn create_login_session(
        &self,
        ctx: &OnlineContext,
        provider: &str,
        device_name: Option<&str>,
    ) -> Result<LoginSession> {
        let body = serde_json::json!({
            "provider": provider,
            "deviceName": device_name,
        });
        self.call(ctx, Method::POST, "/v1/auth/login-sessions", Some(body), Auth::None)
            .await?
            .json()
    }

    /// Reads a sign-in session. `token` and `user` arrive once, on the first
    /// read that finds it `done`.
    pub async fn poll_login_session(&self, ctx: &OnlineContext, id: &str) -> Result<LoginSession> {
        let path = format!("/v1/auth/login-sessions/{}", path_segment(id)?);
        self.call(ctx, Method::GET, &path, None, Auth::None).await?.json()
    }

    /// Invalidates the token on the service. The launcher forgets it either way.
    pub async fn logout(&self, ctx: &OnlineContext) -> Result<()> {
        self.call(ctx, Method::POST, "/v1/auth/logout", None, Auth::Required)
            .await
            .map(|_| ())
    }

    // -- Me -----------------------------------------------------------------

    /// Reads the account and its presence from the service.
    ///
    /// The sidebar and the Account card answer from the copy in
    /// `settings.json`, which every write keeps current; the one command that
    /// calls this is the end of a sign-in, which reads the `admin` flag the
    /// login session does not carry. It is also the one call that would notice
    /// a token invalidated somewhere else, and the mock tests walk it.
    pub async fn get_me(&self, ctx: &OnlineContext) -> Result<Me> {
        self.call(ctx, Method::GET, "/v1/me", None, Auth::Required)
            .await?
            .json()
    }

    /// Renames the account. The service answers `409 conflict` when the name is
    /// taken, which reaches the screen as such.
    pub async fn patch_me(&self, ctx: &OnlineContext, display_name: &str) -> Result<OnlineUser> {
        let body = serde_json::json!({ "displayName": display_name });
        self.call(ctx, Method::PATCH, "/v1/me", Some(body), Auth::Required)
            .await?
            .json()
    }

    /// Deletes the account together with its friendships, requests and
    /// invites. Nothing on this machine is touched.
    pub async fn delete_me(&self, ctx: &OnlineContext) -> Result<()> {
        self.call(ctx, Method::DELETE, "/v1/me", None, Auth::Required)
            .await
            .map(|_| ())
    }

    // -- Friends ------------------------------------------------------------

    pub async fn get_friends(&self, ctx: &OnlineContext) -> Result<FriendsList> {
        self.call(ctx, Method::GET, "/v1/friends", None, Auth::Required)
            .await?
            .json()
    }

    /// Asks someone to be a friend. `query` is a display name, a
    /// `provider:providerName` pair or a user id.
    ///
    /// When the other side had already asked, the service makes the friendship on
    /// the spot and answers `200` instead of `201`; the status code is the
    /// only thing that tells the two answers apart.
    pub async fn send_friend_request(
        &self,
        ctx: &OnlineContext,
        query: &str,
    ) -> Result<SendRequestResult> {
        let body = serde_json::json!({ "query": query });
        let response = self
            .call(ctx, Method::POST, "/v1/friends/requests", Some(body), Auth::Required)
            .await?;

        if response.status == StatusCode::CREATED {
            return Ok(SendRequestResult {
                request: Some(response.json()?),
                friend: None,
            });
        }

        #[derive(serde::Deserialize)]
        struct Accepted {
            friend: Friend,
        }
        let accepted: Accepted = response.json()?;
        Ok(SendRequestResult {
            request: None,
            friend: Some(accepted.friend),
        })
    }

    pub async fn accept_request(&self, ctx: &OnlineContext, id: &str) -> Result<Friend> {
        let path = format!("/v1/friends/requests/{}/accept", path_segment(id)?);
        self.call(ctx, Method::POST, &path, None, Auth::Required)
            .await?
            .json()
    }

    /// Declines a request addressed to me, or cancels one I sent: the contract
    /// gives both sides the same endpoint.
    pub async fn decline_request(&self, ctx: &OnlineContext, id: &str) -> Result<()> {
        let path = format!("/v1/friends/requests/{}", path_segment(id)?);
        self.call(ctx, Method::DELETE, &path, None, Auth::Required)
            .await
            .map(|_| ())
    }

    pub async fn remove_friend(&self, ctx: &OnlineContext, user_id: &str) -> Result<()> {
        let path = format!("/v1/friends/{}", path_segment(user_id)?);
        self.call(ctx, Method::DELETE, &path, None, Auth::Required)
            .await
            .map(|_| ())
    }

    // -- Presence and invites ----------------------------------------------

    /// Says where the player is. Sent at startup, on game start and exit, and
    /// as a heartbeat every 30 s; the service calls a silent player offline after
    /// 90 s.
    pub async fn put_presence(
        &self,
        ctx: &OnlineContext,
        update: &PresenceUpdate,
    ) -> Result<Presence> {
        let body = to_value(update)?;
        self.call(ctx, Method::PUT, "/v1/presence", Some(body), Auth::Required)
            .await?
            .json()
    }

    pub async fn create_invite(&self, ctx: &OnlineContext, invite: &NewInvite) -> Result<Invite> {
        let body = to_value(invite)?;
        self.call(ctx, Method::POST, "/v1/invites", Some(body), Auth::Required)
            .await?
            .json()
    }

    /// Invites addressed to me and still open.
    pub async fn list_invites(&self, ctx: &OnlineContext) -> Result<Vec<Invite>> {
        self.call(ctx, Method::GET, "/v1/invites", None, Auth::Required)
            .await?
            .json()
    }

    pub async fn dismiss_invite(&self, ctx: &OnlineContext, id: &str) -> Result<()> {
        let path = format!("/v1/invites/{}", path_segment(id)?);
        self.call(ctx, Method::DELETE, &path, None, Auth::Required)
            .await
            .map(|_| ())
    }

    // -- Relay (slice: play with friends) -----------------------------------

    /// Asks for a relay session: a port on a node for a limited time, and the
    /// ticket and key the tunnel opens it with.
    ///
    /// The service answers `503 relay_unavailable` when the relay is off or full,
    /// `403 relay_quota` when the account holds a session already or used up
    /// its day, `429 rate_limited` past twelve requests a minute.
    pub async fn create_relay_session(
        &self,
        ctx: &OnlineContext,
        game: &str,
        preferred_nodes: &[String],
    ) -> Result<RelayGrant> {
        let body = serde_json::json!({ "game": game, "preferredNodes": preferred_nodes });
        self.call(ctx, Method::POST, "/v1/relay/sessions", Some(body), Auth::Required)
            .await
            .map_err(relay_refusal)?
            .json()
    }

    /// Extends the ticket of a relay session. The same document with a later
    /// `expiresAt` and a new ticket; the key stays the same.
    pub async fn renew_relay_session(&self, ctx: &OnlineContext, id: &str) -> Result<RelayGrant> {
        let path = format!("/v1/relay/sessions/{}/renew", path_segment(id)?);
        self.call(ctx, Method::POST, &path, None, Auth::Required)
            .await
            .map_err(relay_refusal)?
            .json()
    }

    /// Closes a relay session. A second call, or a session the service has
    /// already closed, is not an error on the service side.
    pub async fn close_relay_session(&self, ctx: &OnlineContext, id: &str) -> Result<()> {
        let path = format!("/v1/relay/sessions/{}", path_segment(id)?);
        self.call(ctx, Method::DELETE, &path, None, Auth::Required)
            .await
            .map(|_| ())
    }

    // -- Transport ----------------------------------------------------------

    pub async fn community(&self, ctx: &OnlineContext, method: Method, path: &str, body: Option<Value>, auth: bool) -> Result<Value> {
        self.call(ctx, method, path, body, auth.into()).await?.json()
    }

    // --- slice: bundles ---

    /// One JSON call of the bundles contract, parsed into the caller's type.
    ///
    /// The bundle routes are many and small, and `crate::bundles` names each
    /// of them next to the command that uses it; a method per route here
    /// would be a second copy of that list.
    pub async fn request<T: DeserializeOwned>(
        &self,
        ctx: &OnlineContext,
        method: Method,
        path: &str,
        body: Option<Value>,
        auth: Auth,
    ) -> Result<T> {
        self.call(ctx, method, path, body, auth).await?.json()
    }

    /// `PUT /v1/blobs/{sha256}`: uploads one file of a bundle.
    ///
    /// The body is a stream the caller builds from the file on disk, so a
    /// 500 MB pk3 never sits in memory; `size` becomes the `Content-Length`
    /// the service insists on. A `200` for a hash the service already holds
    /// is the same answer as a `201`, and the caller need not know which.
    ///
    /// No retry here: the stream is spent by the first attempt, and only the
    /// caller can build another one. The transport failure comes back as
    /// [`AppError::Network`] so it can decide to.
    pub async fn put_blob(
        &self,
        ctx: &OnlineContext,
        sha256: &str,
        size: u64,
        body: reqwest::Body,
    ) -> Result<BlobReceipt> {
        self.check_context(ctx)?;
        ctx.token()?;
        let path = format!("/v1/blobs/{}", path_segment(sha256)?);
        self.put_stream(ctx, &path, size, body).await?.json()
    }

    // --- slice: chat ---
    /// Uploads a stream of `size` bytes to `path` on the transfer client,
    /// with the token: the body of a bundle file or of a chat file.
    ///
    /// No retry, for the reason [`OnlineClient::put_blob`] gives: the stream
    /// is spent by the first attempt.
    pub async fn put_stream(
        &self,
        ctx: &OnlineContext,
        path: &str,
        size: u64,
        body: reqwest::Body,
    ) -> Result<OnlineResponse> {
        self.check_context(ctx)?;
        let token = ctx.token()?;
        let response = self
            .transfer()?
            .put(ctx.url(path))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(body)
            .send()
            .await
            .map_err(|e| transport_error(&Method::PUT, path, &e))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| transport_error(&Method::PUT, path, &e))?;
        log::info!("online PUT {path} -> {}", status.as_u16());
        if !status.is_success() {
            if refuses_the_token(status, path) {
                self.note_refused_token(token);
            }
            return Err(service_error(path, status, &bytes));
        }
        Ok(OnlineResponse {
            status,
            body: bytes.to_vec(),
        })
    }

    /// `GET /v1/blobs/{sha256}`: opens the stream of one file of a bundle.
    ///
    /// `from` asks for the tail of the file after that many bytes, which is
    /// how an interrupted download resumes; the caller checks whether the
    /// answer is a `206` before appending. The route is public, and a token
    /// on file is not sent: nothing about a file depends on who asks.
    ///
    /// The response is handed back whole rather than as bytes, because the
    /// caller streams it to disk with its own progress events.
    pub async fn get_blob(
        &self,
        ctx: &OnlineContext,
        sha256: &str,
        from: u64,
    ) -> Result<reqwest::Response> {
        self.check_context(ctx)?;
        let path = format!("/v1/blobs/{}", path_segment(sha256)?);
        self.get_stream(ctx, &path, from, Auth::None).await
    }

    // --- slice: chat ---
    /// Opens the stream of `path` on the transfer client with the token,
    /// from byte `start` on: the content of a chat file, which only members
    /// may read. The caller checks for `206` before it appends to a partial
    /// file.
    pub async fn get_range(
        &self,
        ctx: &OnlineContext,
        path: &str,
        start: u64,
    ) -> Result<reqwest::Response> {
        self.get_stream(ctx, path, start, Auth::Required).await
    }

    /// The one GET of the transfer client, anonymous for a bundle file and
    /// authenticated for a chat file.
    async fn get_stream(
        &self,
        ctx: &OnlineContext,
        path: &str,
        from: u64,
        auth: Auth,
    ) -> Result<reqwest::Response> {
        self.check_context(ctx)?;
        let token = match auth {
            Auth::None => None,
            Auth::Optional => ctx.token.as_deref(),
            Auth::Required => Some(ctx.token()?),
        };
        let mut request = self.transfer()?.get(ctx.url(path));
        if let Some(token) = token {
            request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| transport_error(&Method::GET, path, &e))?;
        let status = response.status();
        log::info!("online GET {path} -> {}", status.as_u16());
        if !status.is_success() {
            let bytes = response
                .bytes()
                .await
                .map_err(|e| transport_error(&Method::GET, path, &e))?;
            if let Some(token) = token.filter(|_| refuses_the_token(status, path)) {
                self.note_refused_token(token);
            }
            return Err(service_error(path, status, &bytes));
        }
        Ok(response)
    }

    /// `HEAD /v1/blobs/{sha256}`: whether the store holds a file, without
    /// fetching it. `false` for a `404`; any other refusal is an error.
    ///
    /// A publish asks this before it uploads a picture of the description or
    /// a listing the version did not list as missing: the answer costs one
    /// round trip, the upload it saves costs the file.
    pub async fn head_blob(&self, ctx: &OnlineContext, sha256: &str) -> Result<bool> {
        self.check_context(ctx)?;
        let path = format!("/v1/blobs/{}", path_segment(sha256)?);
        let response = self
            .transfer()?
            .head(ctx.url(&path))
            .send()
            .await
            .map_err(|e| transport_error(&Method::HEAD, &path, &e))?;
        let status = response.status();
        log::info!("online HEAD {path} -> {}", status.as_u16());
        if status == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !status.is_success() {
            let bytes = response
                .bytes()
                .await
                .map_err(|e| transport_error(&Method::HEAD, &path, &e))?;
            return Err(online_error(status, &bytes));
        }
        Ok(true)
    }

    /// The two refusals every call makes before opening a socket.
    fn check_context(&self, ctx: &OnlineContext) -> Result<()> {
        // No service in this build, and no address the player typed either. The
        // refusal comes before the log line on purpose: a launcher with the
        // feature switched off must not fill `jknet.log` with a failure a
        // player can do nothing about.
        if !ctx.configured() {
            return Err(AppError::OnlineNotConfigured);
        }
        if !is_http_url(&ctx.base_url) {
            return Err(AppError::InvalidInput(format!(
                "the service address {:?} is not an http:// or https:// URL",
                ctx.base_url
            )));
        }
        Ok(())
    }

    /// Sends one request and turns anything but a 2xx into an [`AppError`].
    ///
    /// The retry is deliberately narrow. A service that answered with an error has
    /// made up its mind, and a POST that reached it must not be sent twice —
    /// so only a connection that never carried a byte is tried again.
    async fn call(
        &self,
        ctx: &OnlineContext,
        method: Method,
        path: &str,
        body: Option<Value>,
        auth: Auth,
    ) -> Result<OnlineResponse> {
        self.check_context(ctx)?;
        let url = ctx.url(path);
        let token = match auth {
            Auth::None => None,
            Auth::Optional => ctx.token.as_deref(),
            Auth::Required => Some(ctx.token()?),
        };
        let payload = match body {
            Some(value) => Some(
                serde_json::to_vec(&value)
                    .map_err(|e| AppError::json("cannot serialize a service request", e))?,
            ),
            None => None,
        };

        let mut attempt = 0;
        let response = loop {
            let mut request = self.http()?.request(method.clone(), &url);
            if let Some(token) = token {
                request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
            }
            if let Some(payload) = &payload {
                request = request
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(payload.clone());
            }

            match request.send().await {
                Ok(response) => break response,
                Err(e) if attempt == 0 && is_connection_reset(&e) => {
                    attempt += 1;
                    log::warn!("online {method} {path}: {e}, retrying once");
                }
                Err(e) => return Err(transport_error(&method, path, &e)),
            }
        };

        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|e| transport_error(&method, path, &e))?
            .to_vec();
        log::info!("online {method} {path} -> {}", status.as_u16());

        if !status.is_success() {
            // The token that just went out is the one the service refused, so the
            // launcher stops claiming to be signed in with it. Only a request
            // that carried one, and never the sign-in endpoints.
            if let Some(token) = token.filter(|_| refuses_the_token(status, path)) {
                self.note_refused_token(token);
            }
            return Err(service_error(path, status, &body));
        }
        Ok(OnlineResponse { status, body })
    }
}

// ---------------------------------------------------------------------------
// --- slice: chat ---
// The chat API, one method per route. Ids go through `path_segment`, so a
// conversation id can never climb out of `/v1/chat/`.
// ---------------------------------------------------------------------------

impl OnlineClient {
    /// `GET /v1/chat/conversations`: every conversation, the group invites,
    /// the settings and the file quota.
    pub async fn chat_sync(&self, ctx: &OnlineContext) -> Result<ChatSyncDoc> {
        self.request(ctx, Method::GET, "/v1/chat/conversations", None, Auth::Required)
            .await
    }

    pub async fn chat_conversation(&self, ctx: &OnlineContext, id: &str) -> Result<Conversation> {
        let path = format!("/v1/chat/conversations/{}", path_segment(id)?);
        self.request(ctx, Method::GET, &path, None, Auth::Required).await
    }

    /// `PUT /v1/chat/direct/{userId}`: the direct conversation with a friend,
    /// made on the first call and returned as it is on every later one.
    pub async fn chat_open_direct(&self, ctx: &OnlineContext, user_id: &str) -> Result<Conversation> {
        let path = format!("/v1/chat/direct/{}", path_segment(user_id)?);
        self.request(ctx, Method::PUT, &path, None, Auth::Required).await
    }

    /// `POST /v1/chat/groups`. The same `client_id` twice answers the group
    /// the first call made.
    pub async fn chat_create_group(
        &self,
        ctx: &OnlineContext,
        client_id: &str,
        title: Option<&str>,
        member_ids: &[String],
    ) -> Result<GroupResult> {
        let mut body = serde_json::json!({ "clientId": client_id, "memberIds": member_ids });
        if let Some(title) = title {
            body["title"] = Value::String(title.to_string());
        }
        self.request(ctx, Method::POST, "/v1/chat/groups", Some(body), Auth::Required)
            .await
    }

    /// `PATCH /v1/chat/groups/{id}`: the title, the history setting, or both.
    /// The owner only; anybody else gets `owner_only`.
    pub async fn chat_patch_group(
        &self,
        ctx: &OnlineContext,
        id: &str,
        title: Option<&str>,
        history_for_new_members: Option<bool>,
    ) -> Result<Conversation> {
        let path = format!("/v1/chat/groups/{}", path_segment(id)?);
        let mut body = serde_json::Map::new();
        if let Some(title) = title {
            body.insert("title".into(), Value::String(title.to_string()));
        }
        if let Some(on) = history_for_new_members {
            body.insert("historyForNewMembers".into(), Value::Bool(on));
        }
        self.request(ctx, Method::PATCH, &path, Some(Value::Object(body)), Auth::Required)
            .await
    }

    pub async fn chat_add_members(
        &self,
        ctx: &OnlineContext,
        id: &str,
        user_ids: &[String],
    ) -> Result<AddResult> {
        let path = format!("/v1/chat/groups/{}/members", path_segment(id)?);
        let body = serde_json::json!({ "userIds": user_ids });
        self.request(ctx, Method::POST, &path, Some(body), Auth::Required)
            .await
    }

    /// Accepts a pending group invite.
    pub async fn chat_join_group(&self, ctx: &OnlineContext, id: &str) -> Result<Conversation> {
        let path = format!("/v1/chat/groups/{}/join", path_segment(id)?);
        self.request(ctx, Method::POST, &path, None, Auth::Required).await
    }

    /// Declines an invite addressed to `user_id` when that is the caller,
    /// cancels it when the caller sent it or owns the group.
    pub async fn chat_remove_group_invite(
        &self,
        ctx: &OnlineContext,
        id: &str,
        user_id: &str,
    ) -> Result<()> {
        let path = format!(
            "/v1/chat/groups/{}/invites/{}",
            path_segment(id)?,
            path_segment(user_id)?
        );
        self.request(ctx, Method::DELETE, &path, None, Auth::Required).await
    }

    /// Leaves a group or a server chat (`user_id` is the caller), or removes
    /// somebody from one (the owner or the host).
    pub async fn chat_remove_member(
        &self,
        ctx: &OnlineContext,
        id: &str,
        user_id: &str,
    ) -> Result<()> {
        let path = format!(
            "/v1/chat/conversations/{}/members/{}",
            path_segment(id)?,
            path_segment(user_id)?
        );
        self.request(ctx, Method::DELETE, &path, None, Auth::Required).await
    }

    /// `PATCH /v1/chat/servers/{sessionId}`: the history setting of a server
    /// chat. The host only.
    pub async fn chat_patch_server(
        &self,
        ctx: &OnlineContext,
        session_id: &str,
        history_for_new_members: bool,
    ) -> Result<Conversation> {
        let path = format!("/v1/chat/servers/{}", path_segment(session_id)?);
        let body = serde_json::json!({ "historyForNewMembers": history_for_new_members });
        self.request(ctx, Method::PATCH, &path, Some(body), Auth::Required)
            .await
    }

    /// One page of history. `limit` is clamped by the service to 200.
    pub async fn chat_messages(
        &self,
        ctx: &OnlineContext,
        id: &str,
        anchor: PageAnchor,
        limit: Option<u32>,
    ) -> Result<MessagePage> {
        let mut path = format!("/v1/chat/conversations/{}/messages", path_segment(id)?);
        let mut query = Vec::new();
        match anchor {
            PageAnchor::Latest => {}
            PageAnchor::Before(seq) => query.push(format!("before={seq}")),
            PageAnchor::After(seq) => query.push(format!("after={seq}")),
            PageAnchor::Around(seq) => query.push(format!("around={seq}")),
        }
        if let Some(limit) = limit {
            query.push(format!("limit={}", limit.clamp(1, 200)));
        }
        if !query.is_empty() {
            path.push('?');
            path.push_str(&query.join("&"));
        }
        self.request(ctx, Method::GET, &path, None, Auth::Required).await
    }

    /// Sends a message. A replay of the same `clientId` answers the stored
    /// message with `200` instead of `201`, and the caller need not know which.
    pub async fn chat_send(
        &self,
        ctx: &OnlineContext,
        id: &str,
        message: &NewMessage,
    ) -> Result<ChatMessage> {
        let path = format!("/v1/chat/conversations/{}/messages", path_segment(id)?);
        let body = to_value(message)?;
        self.request(ctx, Method::POST, &path, Some(body), Auth::Required)
            .await
    }

    /// Moves the read marker. The service keeps it monotonic and clamps it to
    /// the last message, and answers the marker it kept.
    pub async fn chat_read(&self, ctx: &OnlineContext, id: &str, seq: u64) -> Result<u64> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Answer {
            read_seq: u64,
        }
        let path = format!("/v1/chat/conversations/{}/read", path_segment(id)?);
        let body = serde_json::json!({ "seq": seq });
        let answer: Answer = self
            .request(ctx, Method::POST, &path, Some(body), Auth::Required)
            .await?;
        Ok(answer.read_seq)
    }

    /// Adds or takes back one reaction, and answers the reactions of the
    /// message after the change.
    pub async fn chat_react(
        &self,
        ctx: &OnlineContext,
        id: &str,
        seq: u64,
        emoji: &str,
        on: bool,
    ) -> Result<Vec<ReactionGroup>> {
        #[derive(serde::Deserialize)]
        struct Answer {
            #[serde(default)]
            reactions: Vec<ReactionGroup>,
        }
        let path = format!("/v1/chat/conversations/{}/reactions", path_segment(id)?);
        let body = serde_json::json!({ "seq": seq, "emoji": emoji, "on": on });
        let answer: Answer = self
            .request(ctx, Method::PUT, &path, Some(body), Auth::Required)
            .await?;
        Ok(answer.reactions)
    }

    /// `all`, `mentions` or `mute` for one conversation, for this account.
    pub async fn chat_set_notify(
        &self,
        ctx: &OnlineContext,
        id: &str,
        notify: &str,
    ) -> Result<Conversation> {
        let path = format!("/v1/chat/conversations/{}/notify", path_segment(id)?);
        let body = serde_json::json!({ "notify": notify });
        self.request(ctx, Method::PUT, &path, Some(body), Auth::Required)
            .await
    }

    pub async fn chat_search(&self, ctx: &OnlineContext, query: &SearchQuery) -> Result<SearchPage> {
        let mut path = format!(
            "/v1/chat/search?q={}",
            utf8_percent_encode(query.q.trim(), NON_ALPHANUMERIC)
        );
        let mut push = |key: &str, value: Option<&str>| {
            if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
                path.push_str(&format!("&{key}={}", utf8_percent_encode(value, NON_ALPHANUMERIC)));
            }
        };
        push("conversationId", query.conversation_id.as_deref());
        push("senderId", query.sender_id.as_deref());
        push("has", query.has.as_deref());
        push("before", query.before.as_deref());
        if let Some(limit) = query.limit {
            path.push_str(&format!("&limit={}", limit.clamp(1, 50)));
        }
        self.request(ctx, Method::GET, &path, None, Auth::Required).await
    }

    /// `POST /v1/chat/files`: registers a file for one conversation before its
    /// bytes go up.
    pub async fn chat_register_file(
        &self,
        ctx: &OnlineContext,
        conversation_id: &str,
        name: &str,
        size: u64,
        sha256: &str,
        meta: Option<&FileMeta>,
    ) -> Result<FileRegistration> {
        let mut body = serde_json::json!({
            "conversationId": conversation_id,
            "name": name,
            "size": size,
            "sha256": sha256,
        });
        if let Some(meta) = meta {
            body["meta"] = to_value(meta)?;
        }
        self.request(ctx, Method::POST, "/v1/chat/files", Some(body), Auth::Required)
            .await
    }

    /// `PUT /v1/chat/files/{id}/content`: the bytes of a registered file.
    pub async fn chat_upload_file(
        &self,
        ctx: &OnlineContext,
        file_id: &str,
        size: u64,
        body: reqwest::Body,
    ) -> Result<FileRegistration> {
        let path = format!("/v1/chat/files/{}/content", path_segment(file_id)?);
        let response = self.put_stream(ctx, &path, size, body).await?;
        // The upload answers `{file}` alone; the registration shape is reused
        // with `needsUpload` false, which is what an uploaded file is.
        response.json()
    }

    /// `GET /v1/chat/files/{id}/content` from byte `start`: the bytes of a
    /// file, with its SHA-256 as the `ETag`.
    pub async fn chat_file_content(
        &self,
        ctx: &OnlineContext,
        file_id: &str,
        start: u64,
    ) -> Result<reqwest::Response> {
        let path = format!("/v1/chat/files/{}/content", path_segment(file_id)?);
        self.get_range(ctx, &path, start).await
    }

    pub async fn chat_settings(&self, ctx: &OnlineContext) -> Result<ChatPrivacy> {
        self.request(ctx, Method::GET, "/v1/chat/settings", None, Auth::Required)
            .await
    }

    pub async fn chat_update_settings(
        &self,
        ctx: &OnlineContext,
        patch: &ChatPrivacyPatch,
    ) -> Result<ChatPrivacy> {
        let body = to_value(patch)?;
        self.request(ctx, Method::PATCH, "/v1/chat/settings", Some(body), Auth::Required)
            .await
    }
}

// The routes of server chats. Their callers are the server-chat hooks of
// hosting and joining, which land after the plumbing that carries these.
#[allow(dead_code)]
impl OnlineClient {
    /// `PUT /v1/chat/servers/{sessionId}`: the host opens the chat of the
    /// server it runs now. `409 not_hosting` until its presence says so.
    pub async fn chat_open_server(
        &self,
        ctx: &OnlineContext,
        session_id: &str,
    ) -> Result<Conversation> {
        let path = format!("/v1/chat/servers/{}", path_segment(session_id)?);
        self.request(ctx, Method::PUT, &path, None, Auth::Required).await
    }

    /// A guest joins the chat of a friend's server.
    pub async fn chat_join_server(
        &self,
        ctx: &OnlineContext,
        session_id: &str,
        host_user_id: &str,
    ) -> Result<Conversation> {
        let path = format!("/v1/chat/servers/{}/join", path_segment(session_id)?);
        let body = serde_json::json!({ "hostUserId": host_user_id });
        self.request(ctx, Method::POST, &path, Some(body), Auth::Required)
            .await
    }

    /// The host ends the chat of its server. A second call is not an error.
    pub async fn chat_close_server(&self, ctx: &OnlineContext, session_id: &str) -> Result<()> {
        let path = format!("/v1/chat/servers/{}", path_segment(session_id)?);
        self.request(ctx, Method::DELETE, &path, None, Auth::Required).await
    }
}

/// Whether a failure is worth another attempt of the same request later: the
/// network, a rate limit, or a service that failed on its own side.
///
/// A refusal with a reason — not a friend, too long, not the owner — will be
/// refused again, so it is not.
pub fn is_retryable(error: &AppError) -> bool {
    match error {
        AppError::Network(_) => true,
        AppError::Online { code, .. } => {
            matches!(code.as_str(), "rate_limited" | "internal" | "provider_error")
        }
        _ => false,
    }
}

/// Whether the service answered that it has no chat API at all.
pub fn is_chat_unavailable(error: &AppError) -> bool {
    matches!(error, AppError::Online { code, .. } if code == CHAT_UNAVAILABLE_CODE)
}

/// The error of a refused request, by the path it was refused on.
fn service_error(path: &str, status: StatusCode, body: &[u8]) -> AppError {
    if path.starts_with(CHAT_PREFIX) {
        chat_refusal(status, body)
    } else {
        online_error(status, body)
    }
}

/// A refusal of the chat API.
///
/// The chat routes answer with the codes of the contract and name the cause
/// in `details.reason`: `403 forbidden` is `owner_only` in one place and
/// `not_friends` in another, and the screens need the cause. So the reason
/// becomes the code the frontend reads. A service without chat routes answers
/// `404 No such endpoint`, which becomes [`CHAT_UNAVAILABLE_CODE`].
fn chat_refusal(status: StatusCode, body: &[u8]) -> AppError {
    let error = online_error(status, body);
    let AppError::Online { code, message } = error else {
        return error;
    };
    if status == StatusCode::NOT_FOUND
        && code == "not_found"
        && message.trim().eq_ignore_ascii_case("no such endpoint")
    {
        return AppError::Online {
            code: CHAT_UNAVAILABLE_CODE.to_string(),
            message: "this JKNet Online service has no chat".to_string(),
        };
    }
    match refusal_reason(body) {
        Some(reason) => AppError::Online { code: reason, message },
        None => AppError::Online { code, message },
    }
}

/// `error.details.reason` of an error document, when it is a code: lower
/// case letters and underscores, like the codes it stands in for.
fn refusal_reason(body: &[u8]) -> Option<String> {
    let document: Value = serde_json::from_slice(body).ok()?;
    let reason = document.pointer("/error/details/reason")?.as_str()?.trim();
    let is_code = !reason.is_empty()
        && reason.len() <= 40
        && reason.chars().all(|c| c.is_ascii_lowercase() || c == '_');
    is_code.then(|| reason.to_string())
}

// --- slice: play with friends ---
/// The refusal of the relay API that has a variant of its own here: the relay
/// is off or full. The quota refusal is [`AppError::RelayQuota`] already,
/// since [`online_error`] reads its details; everything else stays what
/// [`OnlineClient::call`] made of it.
fn relay_refusal(error: AppError) -> AppError {
    match error {
        AppError::Online { code, message } if code == "relay_unavailable" => {
            AppError::RelayUnavailable(message)
        }
        other => other,
    }
}

/// Serializes a request body without the `json` feature of `reqwest`, which
/// would pull a second copy of `serde_json` into the build for no gain.
fn to_value<T: serde::Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| AppError::json("cannot serialize a service request", e))
}

// --- slice: bundles ---
/// The answer of `PUT /v1/blobs/{sha256}`: the hash and size the service
/// stored, which are the two things the caller sent.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobReceipt {
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

/// A 2xx answer, kept as bytes so the caller can decide what to parse.
pub struct OnlineResponse {
    pub status: StatusCode,
    pub body: Vec<u8>,
}

impl OnlineResponse {
    /// Parses the body. A `204` and an empty body parse as `null`, which is
    /// what makes `T = ()` work for the endpoints that answer with nothing.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        let text: &[u8] = if self.body.is_empty() {
            b"null"
        } else {
            &self.body
        };
        serde_json::from_slice(text)
            .map_err(|e| AppError::json("cannot parse the answer of the service", e))
    }
}

/// Turns the contract's error document into an [`AppError::Online`].
///
/// A service that answered with something else — a proxy page, an empty body —
/// still produces a code, derived from the status, so the frontend never has
/// to tell "no code" apart from "a code I do not know".
fn online_error(status: StatusCode, body: &[u8]) -> AppError {
    #[derive(serde::Deserialize)]
    struct Envelope {
        error: Body,
    }
    #[derive(serde::Deserialize)]
    struct Body {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
        #[serde(default)]
        details: Option<Value>,
    }

    if let Ok(envelope) = serde_json::from_slice::<Envelope>(body) {
        let Body { code, message, details } = envelope.error;
        if !code.trim().is_empty() {
            let message = if message.trim().is_empty() {
                message_for_status(status)
            } else if status == StatusCode::PAYLOAD_TOO_LARGE {
                // --- slice: bundles ---
                // The service spells its body limit as `invalid` in the
                // words of its framework; the size is what the player
                // needs to hear about.
                format!("{}: {message}", message_for_status(status))
            } else {
                message
            };
            // --- slice: play with friends ---
            // The details name the quota and when the time of the day comes
            // back, which the words of the message only suggest.
            if code == "relay_quota" {
                let detail = |key: &str| {
                    details
                        .as_ref()
                        .and_then(|details| details.get(key))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                };
                return AppError::RelayQuota {
                    message,
                    quota: detail("reason"),
                    resets_at: detail("resetsAt"),
                };
            }
            return AppError::Online { code, message };
        }
    }

    AppError::Online {
        code: code_for_status(status).to_string(),
        message: message_for_status(status),
    }
}

/// The sentence for an answer that carried none, or none worth printing.
///
/// --- slice: bundles ---
/// A `413` is the one status the bundle routes name on their own: a file
/// over the limit of `PUT /v1/blobs/{sha256}`, a manifest over the limit of
/// a version. "Answered 413" says nothing to a player. The frontend prints
/// the message through `onlineErrorMessage`, without the `online <code>:`
/// prefix, and has no catalog key for `too_large`, so this sentence is what
/// the player reads.
fn message_for_status(status: StatusCode) -> String {
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        return "the service refused the size of the request".to_string();
    }
    format!("the service answered {}", status.as_u16())
}

/// Whether this answer means the service will not take the token again.
///
/// A `401` says so, and only a `401`: `403 forbidden` is a token the service knows
/// and an action it will not allow, which is not a reason to sign anybody out.
fn refuses_the_token(status: StatusCode, path: &str) -> bool {
    status == StatusCode::UNAUTHORIZED && !path.starts_with(AUTH_PREFIX)
}

/// The contract's code that matches an HTTP status.
fn code_for_status(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 | 422 => "invalid",
        401 => "unauthorized",
        403 => "forbidden",
        404 => "not_found",
        409 => "conflict",
        // --- slice: bundles ---
        // Not a code of the contract's error documents: the service answers
        // its body limits as `invalid`. This is for a `413` that arrives
        // without a document, from a proxy or a service that stopped early.
        413 => "too_large",
        429 => "rate_limited",
        502..=504 => "provider_error",
        _ => "internal",
    }
}

/// Names the call that failed, because "connection refused" alone says nothing
/// in a log that also holds the server browser and the engine downloads.
fn transport_error(method: &Method, path: &str, e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        return AppError::Network(format!("the service did not answer {method} {path} within 10 s"));
    }
    AppError::Network(format!("online {method} {path}: {e}"))
}

/// Whether the connection never carried the request.
///
/// `is_connect` covers a refused or unresolvable address; the walk down the
/// source chain catches a socket the service closed mid-handshake, which is what a
/// service restarting under a running launcher produces.
fn is_connection_reset(e: &reqwest::Error) -> bool {
    if e.is_connect() {
        return true;
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    while let Some(error) = source {
        if let Some(io) = error.downcast_ref::<std::io::Error>() {
            return matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::ConnectionRefused
            );
        }
        source = std::error::Error::source(error);
    }
    false
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

/// The bounds the contract puts on a display name.
const NAME_MIN: usize = 3;
const NAME_MAX: usize = 24;

/// Cleans a display name the way the service will, and refuses what it would.
///
/// The service sanitizes and validates for itself; doing the same here turns a
/// round trip and a `400` into an answer while the player is still typing, and
/// keeps the launcher from sending a name that only looks different because it
/// carries a Quake colour code.
pub fn normalize_display_name(raw: &str) -> Result<String> {
    let without_colours = strip_colour_codes(raw);
    let name = without_colours.split_whitespace().collect::<Vec<_>>().join(" ");

    let length = name.chars().count();
    if !(NAME_MIN..=NAME_MAX).contains(&length) {
        return Err(AppError::InvalidInput(format!(
            "a display name is {NAME_MIN} to {NAME_MAX} characters, this one is {length}"
        )));
    }
    if let Some(bad) = name.chars().find(|c| !is_name_char(*c)) {
        return Err(AppError::InvalidInput(format!(
            "a display name holds letters, digits, spaces, _ and -, not {bad:?}"
        )));
    }
    Ok(name)
}

/// Letters and digits of any alphabet, plus the three separators the contract
/// allows. Cyrillic is deliberately not excluded: the community is not
/// English-only, and the service's own rule says "letters".
fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == ' ' || c == '_' || c == '-'
}

/// Removes `^0`–`^9`, the colour codes of the Quake 3 engine family.
fn strip_colour_codes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^' && chars.peek().is_some_and(|next| next.is_ascii_digit()) {
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_url_loses_its_trailing_slash_and_a_blank_one_falls_back() {
        assert_eq!(normalize_online_url("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
        assert_eq!(normalize_online_url("  https://online.jknet.gg  "), "https://online.jknet.gg");
        assert_eq!(normalize_online_url("   "), default_online_url());
        // Joining must never produce a double slash: the service routes on the
        // exact path and `//v1/me` is a 404 on most frameworks.
        let ctx = OnlineContext {
            base_url: normalize_online_url("http://127.0.0.1:8787/"),
            token: None,
        };
        assert_eq!(ctx.url("/v1/me"), "http://127.0.0.1:8787/v1/me");
    }

    #[test]
    fn a_debug_build_talks_to_the_local_service_and_a_release_build_to_the_public_service() {
        // Both branches in one run: `cfg!(debug_assertions)` is fixed while
        // the tests execute, so the profile they are not built in would never
        // be covered.
        assert_eq!(default_online_url_for(true), DEV_ONLINE_URL);
        assert_eq!(default_online_url_for(false), RELEASE_ONLINE_URL);
        assert_eq!(default_online_url(), default_online_url_for(cfg!(debug_assertions)));

        assert_eq!(RELEASE_ONLINE_URL, "https://api.jknet.app");
        assert!(online_configured(RELEASE_ONLINE_URL));
        assert!(online_configured(DEV_ONLINE_URL));
    }

    #[test]
    fn an_address_is_configured_when_something_is_left_after_trimming() {
        assert!(online_configured("https://online.jknet.gg"));
        assert!(online_configured("  http://127.0.0.1:8787/  "));
        assert!(!online_configured(""));
        assert!(!online_configured("   "));
        assert!(!online_configured("/"));

        // The question is asked about the effective address, not about the raw
        // field: an empty field means "the default of this build", and the
        // default selects a local or public service for the build profile.
        assert_eq!(
            online_configured(&normalize_online_url("")),
            online_configured(default_online_url())
        );
    }

    #[tokio::test]
    async fn a_build_without_a_service_refuses_before_it_opens_a_socket() {
        // The whole point of the release gate: no request, no log line, and a
        // refusal the frontend can tell from a network failure.
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: String::new(),
            token: Some("0123456789abcdef".into()),
        };
        assert!(!ctx.configured());
        // A token in a hand-edited `settings.json` does not make a launcher
        // with no service signed in.
        assert!(!ctx.signed_in());
        assert_eq!(ctx.ws_url(), None);

        match client.get_friends(&ctx).await {
            Err(AppError::OnlineNotConfigured) => {}
            other => panic!("expected a refusal, got {:?}", other.map(|_| "a list")),
        }
    }

    #[test]
    fn the_socket_address_follows_the_scheme_of_the_api() {
        let signed_in = |base: &str| OnlineContext {
            base_url: normalize_online_url(base),
            token: Some("dead".into()),
        };
        // The token travels in a header, never in the address.
        assert_eq!(
            signed_in("http://127.0.0.1:8787").ws_url().expect("a socket"),
            "ws://127.0.0.1:8787/v1/ws"
        );
        assert_eq!(
            signed_in("https://online.jknet.gg/").ws_url().expect("a socket"),
            "wss://online.jknet.gg/v1/ws"
        );
        // A path prefix belongs to the service, so it stays in front of `/v1`.
        assert_eq!(
            signed_in("https://example.test/online/").ws_url().expect("a socket"),
            "wss://example.test/online/v1/ws"
        );

        // Signed out there is nothing to authenticate the socket with, and a
        // socket without a token is a 401 the moment it opens.
        let signed_out = OnlineContext {
            base_url: DEV_ONLINE_URL.into(),
            token: None,
        };
        assert_eq!(signed_out.ws_url(), None);
    }

    #[test]
    fn only_http_urls_reach_the_browser() {
        assert!(is_http_url("http://127.0.0.1:8787/v1/auth/dev/start"));
        assert!(is_http_url("HTTPS://online.example/x"));
        // The service hands out this URL and the launcher opens it unattended.
        assert!(!is_http_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("ftp://example"));
        assert!(!is_http_url(""));
    }

    #[test]
    fn a_local_service_is_recognised_through_ports_and_credentials() {
        assert!(is_local_online("http://127.0.0.1:8787"));
        assert!(is_local_online("http://localhost:8787/"));
        assert!(is_local_online("http://127.0.0.2:8787"));
        assert!(is_local_online("http://[::1]:8787"));
        assert!(is_local_online("HTTP://LOCALHOST"));

        assert!(!is_local_online("https://online.jknet.gg"));
        assert!(!is_local_online(""));
        // The Developer button decides on this answer, so a name that merely
        // starts with the local one must not pass.
        assert!(!is_local_online("https://localhost.attacker.example"));
        assert!(!is_local_online("https://127.0.0.1.attacker.example"));
        // Credentials in front of a remote host are the classic disguise.
        assert!(!is_local_online("https://localhost@evil.example/x"));
    }

    #[test]
    fn a_path_segment_may_not_climb_out_of_the_api() {
        assert_eq!(path_segment("01JBX7Q2").expect("a ULID passes"), "01JBX7Q2");
        assert_eq!(path_segment(" 01JBX7Q2 ").expect("trimmed"), "01JBX7Q2");
        assert!(path_segment("../auth/logout").is_err());
        assert!(path_segment("a/b").is_err());
        assert!(path_segment("a?b=c").is_err());
        assert!(path_segment("").is_err());
    }

    #[test]
    fn a_display_name_is_cleaned_before_it_is_judged() {
        assert_eq!(normalize_display_name("  Kyle   Katarn ").expect("valid"), "Kyle Katarn");
        assert_eq!(normalize_display_name("^1Kyle^7").expect("valid"), "Kyle");
        assert_eq!(normalize_display_name("Кайл_К").expect("valid"), "Кайл_К");

        // Too short once the colour codes are gone, which is the case a length
        // check on the raw string would let through.
        assert!(normalize_display_name("^1a^7").is_err());
        assert!(normalize_display_name("ab").is_err());
        assert!(normalize_display_name(&"a".repeat(25)).is_err());
        assert!(normalize_display_name("kyle<script>").is_err());
    }

    #[test]
    fn an_error_document_keeps_its_code() {
        let body = br#"{"error":{"code":"provider_error","message":"JKHub sign-in is not configured yet"}}"#;
        match online_error(StatusCode::SERVICE_UNAVAILABLE, body) {
            AppError::Online { code, message } => {
                assert_eq!(code, "provider_error");
                assert_eq!(message, "JKHub sign-in is not configured yet");
            }
            other => panic!("expected a service error, got {other:?}"),
        }
    }

    // --- slice: play with friends ---
    #[test]
    fn a_relay_quota_refusal_keeps_its_details() {
        let body = br#"{"error":{"code":"relay_quota","message":"Your relay time for today is used up","details":{"reason":"daily_time","resetsAt":"2026-09-26T00:00:00Z"}}}"#;
        match online_error(StatusCode::FORBIDDEN, body) {
            AppError::RelayQuota { message, quota, resets_at } => {
                assert_eq!(message, "Your relay time for today is used up");
                assert_eq!(quota.as_deref(), Some("daily_time"));
                assert_eq!(resets_at.as_deref(), Some("2026-09-26T00:00:00Z"));
            }
            other => panic!("expected a relay quota, got {other:?}"),
        }
        // Without details, or with details of another shape, the words stay.
        let body = br#"{"error":{"code":"relay_quota","message":"You already use the relay for another server","details":["active_session"]}}"#;
        match online_error(StatusCode::FORBIDDEN, body) {
            AppError::RelayQuota { message, quota, resets_at } => {
                assert_eq!(message, "You already use the relay for another server");
                assert_eq!((quota, resets_at), (None, None));
            }
            other => panic!("expected a relay quota, got {other:?}"),
        }
        // The other refusal of the relay gets its variant from the mapper.
        let body = br#"{"error":{"code":"relay_unavailable","message":"The JKNet relay is not available on this service"}}"#;
        match relay_refusal(online_error(StatusCode::SERVICE_UNAVAILABLE, body)) {
            AppError::RelayUnavailable(message) => {
                assert_eq!(message, "The JKNet relay is not available on this service");
            }
            other => panic!("expected the relay to be unavailable, got {other:?}"),
        }
    }

    #[test]
    fn a_body_that_is_not_the_contract_still_produces_a_code() {
        // A proxy in front of the service, or a service that crashed mid-answer.
        match online_error(StatusCode::UNAUTHORIZED, b"<html>Bad gateway</html>") {
            AppError::Online { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected a service error, got {other:?}"),
        }
        match online_error(StatusCode::IM_A_TEAPOT, b"") {
            AppError::Online { code, .. } => assert_eq!(code, "internal"),
            other => panic!("expected a service error, got {other:?}"),
        }
    }

    // --- slice: bundles ---
    #[test]
    fn a_413_says_the_size_was_refused_with_or_without_a_document() {
        // A proxy answered on its own, without the contract's document.
        match online_error(StatusCode::PAYLOAD_TOO_LARGE, b"<html>Request Entity Too Large</html>") {
            AppError::Online { code, message } => {
                assert_eq!(code, "too_large");
                assert_eq!(message, "the service refused the size of the request");
            }
            other => panic!("expected a service error, got {other:?}"),
        }
        // The service itself: its body limit answers `invalid` in the words
        // of its framework, and the sentence about the size goes in front.
        let body = br#"{"error":{"code":"invalid","message":"length limit exceeded"}}"#;
        match online_error(StatusCode::PAYLOAD_TOO_LARGE, body) {
            AppError::Online { code, message } => {
                assert_eq!(code, "invalid");
                assert_eq!(
                    message,
                    "the service refused the size of the request: length limit exceeded"
                );
            }
            other => panic!("expected a service error, got {other:?}"),
        }
        // The rendered form keeps the prefix the frontend strips.
        let rendered = online_error(StatusCode::PAYLOAD_TOO_LARGE, b"").to_string();
        assert_eq!(rendered, "online too_large: the service refused the size of the request");
    }

    #[test]
    fn only_a_401_outside_the_sign_in_endpoints_forgets_the_token() {
        assert!(refuses_the_token(StatusCode::UNAUTHORIZED, "/v1/friends"));
        assert!(refuses_the_token(StatusCode::UNAUTHORIZED, "/v1/me"));

        // The sign-out endpoint answers 401 for a token the service has already
        // forgotten. Acting on it would tell a player who pressed Sign out
        // that their session expired.
        assert!(!refuses_the_token(StatusCode::UNAUTHORIZED, "/v1/auth/logout"));
        // A token the service knows, doing something it will not allow.
        assert!(!refuses_the_token(StatusCode::FORBIDDEN, "/v1/friends"));
        assert!(!refuses_the_token(StatusCode::NOT_FOUND, "/v1/friends"));
        assert!(!refuses_the_token(StatusCode::TOO_MANY_REQUESTS, "/v1/presence"));
    }

    #[test]
    fn an_empty_body_parses_as_the_unit_answer_of_a_204() {
        let response = OnlineResponse {
            status: StatusCode::NO_CONTENT,
            body: Vec::new(),
        };
        response.json::<()>().expect("204 carries nothing");
    }

    // --- slice: chat ---
    #[test]
    fn a_chat_refusal_takes_its_reason_as_the_code() {
        let body = br#"{"error":{"code":"forbidden","message":"Only the owner can rename the group","details":{"reason":"owner_only"}}}"#;
        match service_error("/v1/chat/groups/01J", StatusCode::FORBIDDEN, body) {
            AppError::Online { code, message } => {
                assert_eq!(code, "owner_only");
                assert_eq!(message, "Only the owner can rename the group");
            }
            other => panic!("expected a chat refusal, got {other:?}"),
        }
        // Without a reason the code of the document stays.
        let body = br#"{"error":{"code":"not_found","message":"No such conversation"}}"#;
        match service_error("/v1/chat/conversations/01J", StatusCode::NOT_FOUND, body) {
            AppError::Online { code, .. } => assert_eq!(code, "not_found"),
            other => panic!("expected a chat refusal, got {other:?}"),
        }
        // A reason that is not a code does not replace one.
        let body = br#"{"error":{"code":"invalid","message":"x","details":{"reason":"Not A Code"}}}"#;
        match service_error("/v1/chat/files", StatusCode::BAD_REQUEST, body) {
            AppError::Online { code, .. } => assert_eq!(code, "invalid"),
            other => panic!("expected a chat refusal, got {other:?}"),
        }
        // Outside the chat API the details are left alone, as before.
        let body = br#"{"error":{"code":"forbidden","message":"x","details":{"reason":"owner_only"}}}"#;
        match service_error("/v1/friends", StatusCode::FORBIDDEN, body) {
            AppError::Online { code, .. } => assert_eq!(code, "forbidden"),
            other => panic!("expected a service error, got {other:?}"),
        }
    }

    #[test]
    fn a_service_without_chat_routes_marks_the_chat_unavailable() {
        // What the service's fallback route answers, and what the mock's does.
        for body in [
            &br#"{"error":{"code":"not_found","message":"No such endpoint"}}"#[..],
            &br#"{"error":{"code":"not_found","message":"no such endpoint"}}"#[..],
        ] {
            let error = service_error("/v1/chat/conversations", StatusCode::NOT_FOUND, body);
            assert!(is_chat_unavailable(&error), "{error:?}");
        }
        // A conversation the player is not in is an ordinary 404.
        let body = br#"{"error":{"code":"not_found","message":"No such conversation"}}"#;
        let error = service_error("/v1/chat/conversations/01J", StatusCode::NOT_FOUND, body);
        assert!(!is_chat_unavailable(&error));
        // And the same fallback outside chat means something else.
        let body = br#"{"error":{"code":"not_found","message":"No such endpoint"}}"#;
        let error = service_error("/v1/bundles/x", StatusCode::NOT_FOUND, body);
        assert!(!is_chat_unavailable(&error));
    }

    #[test]
    fn only_the_network_a_rate_limit_and_a_failing_service_are_retried() {
        assert!(is_retryable(&AppError::Network("reset".into())));
        for code in ["rate_limited", "internal", "provider_error"] {
            assert!(is_retryable(&AppError::Online { code: code.into(), message: "x".into() }));
        }
        for code in ["not_friends", "too_long", "unauthorized", "not_found", "file_gone"] {
            assert!(!is_retryable(&AppError::Online { code: code.into(), message: "x".into() }));
        }
        assert!(!is_retryable(&AppError::SignedOut));
    }

    #[test]
    fn a_context_never_prints_its_token() {
        let ctx = OnlineContext {
            base_url: "http://127.0.0.1:8787".into(),
            token: Some("0123456789abcdef".into()),
        };
        let printed = format!("{ctx:?}");
        assert!(!printed.contains("0123456789abcdef"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
    }

    #[test]
    fn an_authenticated_call_refuses_before_it_leaves_the_launcher() {
        let ctx = OnlineContext {
            base_url: DEV_ONLINE_URL.into(),
            token: None,
        };
        assert!(!ctx.signed_in());
        match ctx.token() {
            Err(AppError::Online { code, .. }) => assert_eq!(code, "unauthorized"),
            other => panic!("expected an unauthorized refusal, got {other:?}"),
        }
    }
}
