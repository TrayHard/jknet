//! The typed client of the JKNet hub, over `reqwest`.
//!
//! One [`HubClient`] lives in Tauri's managed state and holds nothing but the
//! HTTP connection pool. Where to call and who to call as changes whenever the
//! player signs in or points the launcher at another hub, so both travel in a
//! [`HubContext`] built from the settings at the moment of the call rather than
//! being frozen into the client at startup.
//!
//! Four rules of the contract are implemented here and nowhere else:
//!
//! - a request takes at most 10 s;
//! - a failed request is retried once, and only when the connection itself was
//!   refused or reset, which is what a hub restarting under the player looks
//!   like;
//! - a refusal carries `{"error":{"code","message"}}`, and that code is what
//!   [`AppError::Hub`] keeps, because the cure for `provider_error` (wait for
//!   JKHub) has nothing in common with the cure for `conflict` (pick another
//!   name);
//! - a `401` to a request that carried a token means the hub will not take that
//!   token again, so the launcher forgets it. Every call to the hub passes
//!   through [`HubClient::call`], which is why this lives here rather than in
//!   each of the fourteen commands that could meet one.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::settings::Settings;

use super::types::{
    Friend, FriendsList, HubUser, Invite, LoginSession, Me, NewInvite, Presence, PresenceUpdate,
    SendRequestResult,
};

/// Where the hub runs while it is being developed. The production address is
/// not decided yet, so the field stays editable on the Settings screen.
pub const DEFAULT_HUB_URL: &str = "http://127.0.0.1:8787";

/// The whole budget of one request, connection included.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Providers the hub knows. `dev` only answers on a hub started with
/// `HUB_DEV_PROVIDER=1`, which in practice means a hub on this machine.
pub const PROVIDERS: [&str; 3] = ["jkhub", "discord", "dev"];

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/// Where to call and who to call as.
#[derive(Clone, Default)]
pub struct HubContext {
    /// Base URL without a trailing slash, such as `http://127.0.0.1:8787`.
    pub base_url: String,
    /// The bearer token, absent while the player is signed out.
    pub token: Option<String>,
}

/// Prints the address and never the token: a `{:?}` added while chasing a bug
/// must not put the one stealable string of the launcher into `jknet.log`.
impl std::fmt::Debug for HubContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HubContext")
            .field("base_url", &self.base_url)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl HubContext {
    /// Reads the address and the token out of the settings document.
    pub fn from_settings(settings: &Settings) -> HubContext {
        HubContext {
            base_url: normalize_hub_url(&settings.hub_url),
            token: settings
                .hub_token
                .as_ref()
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty()),
        }
    }

    /// Whether a token is on file. Says nothing about whether the hub still
    /// accepts it.
    pub fn signed_in(&self) -> bool {
        self.token.is_some()
    }

    /// The token, or the refusal an authenticated call owes the caller.
    ///
    /// Asking the hub without one would spend a round trip to be told the same
    /// thing, and the message would be the hub's rather than the launcher's.
    fn token(&self) -> Result<&str> {
        self.token.as_deref().ok_or_else(|| AppError::Hub {
            code: "unauthorized".into(),
            message: "Sign in to JKNet first.".into(),
        })
    }

    /// Joins the base URL with a path that already starts with a slash.
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    /// The full address of the live socket, or `None` while signed out.
    ///
    /// `GET /v1/ws` authenticates with a query parameter rather than a header,
    /// because a browser-style WebSocket handshake carries no `Authorization`.
    /// The token is not escaped: the contract makes it 64 hex characters, and
    /// [`HubContext::from_settings`] keeps whatever the sign-in stored.
    pub fn ws_url(&self) -> Option<String> {
        let token = self.token.as_deref()?;
        Some(format!("{}/v1/ws?token={token}", ws_base(&self.base_url)))
    }
}

/// Turns the API address into the address of the live socket.
///
/// `http` becomes `ws` and `https` becomes `wss`, which is the whole
/// transformation: the contract puts the socket on the same host, port and
/// path prefix as the API. An address that is already a socket address is left
/// alone, because a hub reachable at `ws://…` in a test rig is still a hub.
fn ws_base(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match base.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        _ => base.to_string(),
    }
}

/// Trims a hub URL and drops the trailing slash, so joining a path never
/// produces `//v1/me`. A blank address falls back to the development hub.
pub fn normalize_hub_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_HUB_URL.to_string();
    }
    trimmed.to_string()
}

/// Whether a URL is one the launcher may hand to the system browser or call.
///
/// Anything but HTTP is refused on the spot: the hub answers with a URL the
/// launcher opens without asking, and a `file:` or a `javascript:` there would
/// turn a compromised hub into code running on the player's machine.
pub fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Whether the hub runs on this machine.
///
/// The Developer sign-in button exists only for a local hub: the `dev`
/// provider hands out an account for any name typed into a form, so offering
/// it against a hub on the internet would be offering an unlocked door.
pub fn is_local_hub(url: &str) -> bool {
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
/// `POST /v1/auth/logout` answers it for a token the hub has already forgotten,
/// and the sign-out that made the call is clearing the same token anyway — so
/// acting on it would tell a player who pressed **Sign out** that their session
/// expired.
const AUTH_PREFIX: &str = "/v1/auth/";

/// What the client does about a token the hub refused.
///
/// A callback rather than an `AppHandle`, for two reasons. This module has no
/// business knowing that "the hub refused the token" means "sign the launcher
/// out": `lib.rs` wires the two together. And a handle in this struct would
/// make the test binary of the crate link the whole window runtime for a handle
/// no test ever sets — a binary that then fails to load before the first test
/// runs, which is how this was found.
type RefusalHook = Box<dyn Fn(&str) + Send + Sync + 'static>;

/// The connection pool shared by every call to the hub.
pub struct HubClient {
    /// `None` when `reqwest` could not start, which on Windows means the TLS
    /// backend failed. Every call then refuses instead of panicking: a broken
    /// hub client must not take the launcher's window with it.
    http: Option<reqwest::Client>,
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

impl Default for HubClient {
    fn default() -> Self {
        HubClient::new()
    }
}

impl HubClient {
    pub fn new() -> HubClient {
        let built = reqwest::Client::builder()
            .user_agent(concat!("JKNet/", env!("CARGO_PKG_VERSION")))
            .timeout(TIMEOUT)
            .gzip(true)
            .build();
        let http = match built {
            Ok(http) => Some(http),
            Err(e) => {
                log::error!("the hub client could not start: {e}");
                None
            }
        };
        HubClient {
            http,
            on_refusal: OnceLock::new(),
            expiry: Mutex::new(()),
        }
    }

    /// Says what to do with a token the hub refuses.
    ///
    /// Called once from `setup`. Until then, and in the tests, a refused token
    /// is an error and nothing else.
    pub fn report_refusals_to(&self, forget: impl Fn(&str) + Send + Sync + 'static) {
        if self.on_refusal.set(Box::new(forget)).is_err() {
            log::warn!("the hub client already knows where to report a refused token");
        }
    }

    /// Reports a token the hub refused, one caller at a time.
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

    // -- Auth ---------------------------------------------------------------

    /// Opens a sign-in session. The answer carries the URL for the browser.
    pub async fn create_login_session(
        &self,
        ctx: &HubContext,
        provider: &str,
        device_name: Option<&str>,
    ) -> Result<LoginSession> {
        let body = serde_json::json!({
            "provider": provider,
            "deviceName": device_name,
        });
        self.call(ctx, Method::POST, "/v1/auth/login-sessions", Some(body), false)
            .await?
            .json()
    }

    /// Reads a sign-in session. `token` and `user` arrive once, on the first
    /// read that finds it `done`.
    pub async fn poll_login_session(&self, ctx: &HubContext, id: &str) -> Result<LoginSession> {
        let path = format!("/v1/auth/login-sessions/{}", path_segment(id)?);
        self.call(ctx, Method::GET, &path, None, false).await?.json()
    }

    /// Invalidates the token on the hub. The launcher forgets it either way.
    pub async fn logout(&self, ctx: &HubContext) -> Result<()> {
        self.call(ctx, Method::POST, "/v1/auth/logout", None, true)
            .await
            .map(|_| ())
    }

    // -- Me -----------------------------------------------------------------

    /// Reads the account and its presence from the hub.
    ///
    /// No command calls it: the sidebar and the Account card answer from the
    /// copy in `settings.json`, which every write keeps current. It stays
    /// because it is the one call that would notice a token invalidated
    /// somewhere else, and because the mock tests walk the whole contract.
    #[allow(dead_code)]
    pub async fn get_me(&self, ctx: &HubContext) -> Result<Me> {
        self.call(ctx, Method::GET, "/v1/me", None, true)
            .await?
            .json()
    }

    /// Renames the account. The hub answers `409 conflict` when the name is
    /// taken, which reaches the screen as such.
    pub async fn patch_me(&self, ctx: &HubContext, display_name: &str) -> Result<HubUser> {
        let body = serde_json::json!({ "displayName": display_name });
        self.call(ctx, Method::PATCH, "/v1/me", Some(body), true)
            .await?
            .json()
    }

    /// Deletes the account together with its friendships, requests and
    /// invites. Nothing on this machine is touched.
    pub async fn delete_me(&self, ctx: &HubContext) -> Result<()> {
        self.call(ctx, Method::DELETE, "/v1/me", None, true)
            .await
            .map(|_| ())
    }

    // -- Friends ------------------------------------------------------------

    pub async fn get_friends(&self, ctx: &HubContext) -> Result<FriendsList> {
        self.call(ctx, Method::GET, "/v1/friends", None, true)
            .await?
            .json()
    }

    /// Asks someone to be a friend. `query` is a display name, a
    /// `provider:providerName` pair or a user id.
    ///
    /// When the other side had already asked, the hub makes the friendship on
    /// the spot and answers `200` instead of `201`; the status code is the
    /// only thing that tells the two answers apart.
    pub async fn send_friend_request(
        &self,
        ctx: &HubContext,
        query: &str,
    ) -> Result<SendRequestResult> {
        let body = serde_json::json!({ "query": query });
        let response = self
            .call(ctx, Method::POST, "/v1/friends/requests", Some(body), true)
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

    pub async fn accept_request(&self, ctx: &HubContext, id: &str) -> Result<Friend> {
        let path = format!("/v1/friends/requests/{}/accept", path_segment(id)?);
        self.call(ctx, Method::POST, &path, None, true)
            .await?
            .json()
    }

    /// Declines a request addressed to me, or cancels one I sent: the contract
    /// gives both sides the same endpoint.
    pub async fn decline_request(&self, ctx: &HubContext, id: &str) -> Result<()> {
        let path = format!("/v1/friends/requests/{}", path_segment(id)?);
        self.call(ctx, Method::DELETE, &path, None, true)
            .await
            .map(|_| ())
    }

    pub async fn remove_friend(&self, ctx: &HubContext, user_id: &str) -> Result<()> {
        let path = format!("/v1/friends/{}", path_segment(user_id)?);
        self.call(ctx, Method::DELETE, &path, None, true)
            .await
            .map(|_| ())
    }

    // -- Presence and invites ----------------------------------------------

    /// Says where the player is. Sent at startup, on game start and exit, and
    /// as a heartbeat every 30 s; the hub calls a silent player offline after
    /// 90 s.
    pub async fn put_presence(
        &self,
        ctx: &HubContext,
        update: &PresenceUpdate,
    ) -> Result<Presence> {
        let body = to_value(update)?;
        self.call(ctx, Method::PUT, "/v1/presence", Some(body), true)
            .await?
            .json()
    }

    pub async fn create_invite(&self, ctx: &HubContext, invite: &NewInvite) -> Result<Invite> {
        let body = to_value(invite)?;
        self.call(ctx, Method::POST, "/v1/invites", Some(body), true)
            .await?
            .json()
    }

    /// Invites addressed to me and still open.
    pub async fn list_invites(&self, ctx: &HubContext) -> Result<Vec<Invite>> {
        self.call(ctx, Method::GET, "/v1/invites", None, true)
            .await?
            .json()
    }

    pub async fn dismiss_invite(&self, ctx: &HubContext, id: &str) -> Result<()> {
        let path = format!("/v1/invites/{}", path_segment(id)?);
        self.call(ctx, Method::DELETE, &path, None, true)
            .await
            .map(|_| ())
    }

    // -- Transport ----------------------------------------------------------

    /// Sends one request and turns anything but a 2xx into an [`AppError`].
    ///
    /// The retry is deliberately narrow. A hub that answered with an error has
    /// made up its mind, and a POST that reached it must not be sent twice —
    /// so only a connection that never carried a byte is tried again.
    async fn call(
        &self,
        ctx: &HubContext,
        method: Method,
        path: &str,
        body: Option<Value>,
        auth: bool,
    ) -> Result<HubResponse> {
        if !is_http_url(&ctx.base_url) {
            return Err(AppError::InvalidInput(format!(
                "the hub address {:?} is not an http:// or https:// URL",
                ctx.base_url
            )));
        }
        let url = ctx.url(path);
        let token = if auth { Some(ctx.token()?) } else { None };
        let payload = match body {
            Some(value) => Some(
                serde_json::to_vec(&value)
                    .map_err(|e| AppError::json("cannot serialize a hub request", e))?,
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
                    log::warn!("hub {method} {path}: {e}, retrying once");
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
        log::info!("hub {method} {path} -> {}", status.as_u16());

        if !status.is_success() {
            // The token that just went out is the one the hub refused, so the
            // launcher stops claiming to be signed in with it. Only a request
            // that carried one, and never the sign-in endpoints.
            if let Some(token) = token.filter(|_| refuses_the_token(status, path)) {
                self.note_refused_token(token);
            }
            return Err(hub_error(status, &body));
        }
        Ok(HubResponse { status, body })
    }
}

/// Serializes a request body without the `json` feature of `reqwest`, which
/// would pull a second copy of `serde_json` into the build for no gain.
fn to_value<T: serde::Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| AppError::json("cannot serialize a hub request", e))
}

/// A 2xx answer, kept as bytes so the caller can decide what to parse.
pub struct HubResponse {
    pub status: StatusCode,
    pub body: Vec<u8>,
}

impl HubResponse {
    /// Parses the body. A `204` and an empty body parse as `null`, which is
    /// what makes `T = ()` work for the endpoints that answer with nothing.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        let text: &[u8] = if self.body.is_empty() {
            b"null"
        } else {
            &self.body
        };
        serde_json::from_slice(text)
            .map_err(|e| AppError::json("cannot parse the answer of the hub", e))
    }
}

/// Turns the contract's error document into an [`AppError::Hub`].
///
/// A hub that answered with something else — a proxy page, an empty body —
/// still produces a code, derived from the status, so the frontend never has
/// to tell "no code" apart from "a code I do not know".
fn hub_error(status: StatusCode, body: &[u8]) -> AppError {
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
    }

    if let Ok(envelope) = serde_json::from_slice::<Envelope>(body) {
        if !envelope.error.code.trim().is_empty() {
            return AppError::Hub {
                code: envelope.error.code,
                message: if envelope.error.message.trim().is_empty() {
                    format!("the hub answered {}", status.as_u16())
                } else {
                    envelope.error.message
                },
            };
        }
    }

    AppError::Hub {
        code: code_for_status(status).to_string(),
        message: format!("the hub answered {}", status.as_u16()),
    }
}

/// Whether this answer means the hub will not take the token again.
///
/// A `401` says so, and only a `401`: `403 forbidden` is a token the hub knows
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
        429 => "rate_limited",
        502..=504 => "provider_error",
        _ => "internal",
    }
}

/// Names the call that failed, because "connection refused" alone says nothing
/// in a log that also holds the server browser and the engine downloads.
fn transport_error(method: &Method, path: &str, e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        return AppError::Network(format!("the hub did not answer {method} {path} within 10 s"));
    }
    AppError::Network(format!("hub {method} {path}: {e}"))
}

/// Whether the connection never carried the request.
///
/// `is_connect` covers a refused or unresolvable address; the walk down the
/// source chain catches a socket the hub closed mid-handshake, which is what a
/// hub restarting under a running launcher produces.
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

/// Cleans a display name the way the hub will, and refuses what it would.
///
/// The hub sanitizes and validates for itself; doing the same here turns a
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
/// English-only, and the hub's own rule says "letters".
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
    fn a_hub_url_loses_its_trailing_slash_and_a_blank_one_falls_back() {
        assert_eq!(normalize_hub_url("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
        assert_eq!(normalize_hub_url("  https://hub.jknet.gg  "), "https://hub.jknet.gg");
        assert_eq!(normalize_hub_url("   "), DEFAULT_HUB_URL);
        // Joining must never produce a double slash: the hub routes on the
        // exact path and `//v1/me` is a 404 on most frameworks.
        let ctx = HubContext {
            base_url: normalize_hub_url("http://127.0.0.1:8787/"),
            token: None,
        };
        assert_eq!(ctx.url("/v1/me"), "http://127.0.0.1:8787/v1/me");
    }

    #[test]
    fn the_socket_address_follows_the_scheme_of_the_api() {
        let signed_in = |base: &str| HubContext {
            base_url: normalize_hub_url(base),
            token: Some("dead".into()),
        };
        assert_eq!(
            signed_in("http://127.0.0.1:8787").ws_url().expect("a socket"),
            "ws://127.0.0.1:8787/v1/ws?token=dead"
        );
        assert_eq!(
            signed_in("https://hub.jknet.gg/").ws_url().expect("a socket"),
            "wss://hub.jknet.gg/v1/ws?token=dead"
        );
        // A path prefix belongs to the hub, so it stays in front of `/v1`.
        assert_eq!(
            signed_in("https://example.test/hub/").ws_url().expect("a socket"),
            "wss://example.test/hub/v1/ws?token=dead"
        );

        // Signed out there is nothing to authenticate the socket with, and a
        // socket without a token is a 401 the moment it opens.
        let signed_out = HubContext {
            base_url: DEFAULT_HUB_URL.into(),
            token: None,
        };
        assert_eq!(signed_out.ws_url(), None);
    }

    #[test]
    fn only_http_urls_reach_the_browser() {
        assert!(is_http_url("http://127.0.0.1:8787/v1/auth/dev/start"));
        assert!(is_http_url("HTTPS://hub.example/x"));
        // The hub hands out this URL and the launcher opens it unattended.
        assert!(!is_http_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("ftp://example"));
        assert!(!is_http_url(""));
    }

    #[test]
    fn a_local_hub_is_recognised_through_ports_and_credentials() {
        assert!(is_local_hub("http://127.0.0.1:8787"));
        assert!(is_local_hub("http://localhost:8787/"));
        assert!(is_local_hub("http://127.0.0.2:8787"));
        assert!(is_local_hub("http://[::1]:8787"));
        assert!(is_local_hub("HTTP://LOCALHOST"));

        assert!(!is_local_hub("https://hub.jknet.gg"));
        assert!(!is_local_hub(""));
        // The Developer button decides on this answer, so a name that merely
        // starts with the local one must not pass.
        assert!(!is_local_hub("https://localhost.attacker.example"));
        assert!(!is_local_hub("https://127.0.0.1.attacker.example"));
        // Credentials in front of a remote host are the classic disguise.
        assert!(!is_local_hub("https://localhost@evil.example/x"));
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
        match hub_error(StatusCode::SERVICE_UNAVAILABLE, body) {
            AppError::Hub { code, message } => {
                assert_eq!(code, "provider_error");
                assert_eq!(message, "JKHub sign-in is not configured yet");
            }
            other => panic!("expected a hub error, got {other:?}"),
        }
    }

    #[test]
    fn a_body_that_is_not_the_contract_still_produces_a_code() {
        // A proxy in front of the hub, or a hub that crashed mid-answer.
        match hub_error(StatusCode::UNAUTHORIZED, b"<html>Bad gateway</html>") {
            AppError::Hub { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected a hub error, got {other:?}"),
        }
        match hub_error(StatusCode::IM_A_TEAPOT, b"") {
            AppError::Hub { code, .. } => assert_eq!(code, "internal"),
            other => panic!("expected a hub error, got {other:?}"),
        }
    }

    #[test]
    fn only_a_401_outside_the_sign_in_endpoints_forgets_the_token() {
        assert!(refuses_the_token(StatusCode::UNAUTHORIZED, "/v1/friends"));
        assert!(refuses_the_token(StatusCode::UNAUTHORIZED, "/v1/me"));

        // The sign-out endpoint answers 401 for a token the hub has already
        // forgotten. Acting on it would tell a player who pressed Sign out
        // that their session expired.
        assert!(!refuses_the_token(StatusCode::UNAUTHORIZED, "/v1/auth/logout"));
        // A token the hub knows, doing something it will not allow.
        assert!(!refuses_the_token(StatusCode::FORBIDDEN, "/v1/friends"));
        assert!(!refuses_the_token(StatusCode::NOT_FOUND, "/v1/friends"));
        assert!(!refuses_the_token(StatusCode::TOO_MANY_REQUESTS, "/v1/presence"));
    }

    #[test]
    fn an_empty_body_parses_as_the_unit_answer_of_a_204() {
        let response = HubResponse {
            status: StatusCode::NO_CONTENT,
            body: Vec::new(),
        };
        response.json::<()>().expect("204 carries nothing");
    }

    #[test]
    fn a_context_never_prints_its_token() {
        let ctx = HubContext {
            base_url: "http://127.0.0.1:8787".into(),
            token: Some("0123456789abcdef".into()),
        };
        let printed = format!("{ctx:?}");
        assert!(!printed.contains("0123456789abcdef"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
    }

    #[test]
    fn an_authenticated_call_refuses_before_it_leaves_the_launcher() {
        let ctx = HubContext {
            base_url: DEFAULT_HUB_URL.into(),
            token: None,
        };
        assert!(!ctx.signed_in());
        match ctx.token() {
            Err(AppError::Hub { code, .. }) => assert_eq!(code, "unauthorized"),
            other => panic!("expected an unauthorized refusal, got {other:?}"),
        }
    }
}
