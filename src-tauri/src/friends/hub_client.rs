//! The subset of the hub the friends slice needs, and a client for it.
//!
//! --- slice: friends (temporary, replaced by hub module at merge) ---
//!
//! [`HubApi`] is the seam. Everything else in `friends/` calls the hub through
//! this trait and never through a concrete type, so the merge with the account
//! slice is one edit: point [`connect`] at `crate::hub::HubClient` and delete
//! [`ContractHubClient`]. Nothing else in the module knows what is behind the
//! trait object.
//!
//! [`ContractHubClient`] is written from `hub-api.md` alone — the hub service
//! is built in parallel and was never reachable while this was written, so the
//! only thing that has run against it is the mock in `scripts/mock-hub.mjs`.

use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, Result};
use crate::settings::Settings;

use super::types::{
    Friend, FriendRequest, FriendsPayload, HubErrorBody, Invite, NewInvite, Presence,
    PresenceUpdate, RequestOutcome,
};

/// Where the hub lives when the settings name no other address. The contract
/// calls this the development default; the production address is still open.
pub const DEFAULT_HUB_URL: &str = "http://127.0.0.1:8787";

/// How long one call may take before it counts as a failure.
///
/// Generous next to a local socket and mean next to a hung TLS handshake: the
/// presence heartbeat runs every 30 s, so a request still in flight when the
/// next tick comes has already lost its turn.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The calls the friends slice makes.
///
/// Deliberately smaller than the contract: sign-in, `GET /v1/me` and account
/// deletion belong to the account slice and are absent here on purpose, so the
/// two implementations cannot drift on anything this module cares about.
#[async_trait]
pub trait HubApi: Send + Sync {
    /// `GET /v1/friends`.
    async fn get_friends(&self) -> Result<FriendsPayload>;
    /// `POST /v1/friends/requests` with a display name, `provider:name` or id.
    async fn send_friend_request(&self, query: &str) -> Result<RequestOutcome>;
    /// `POST /v1/friends/requests/{id}/accept`.
    async fn accept_request(&self, id: &str) -> Result<Friend>;
    /// `DELETE /v1/friends/requests/{id}`: declines one, cancels the other.
    async fn decline_request(&self, id: &str) -> Result<()>;
    /// `DELETE /v1/friends/{userId}`.
    async fn remove_friend(&self, user_id: &str) -> Result<()>;
    /// `PUT /v1/presence`.
    async fn put_presence(&self, update: &PresenceUpdate) -> Result<Presence>;
    /// `POST /v1/invites`.
    async fn create_invite(&self, invite: &NewInvite) -> Result<Invite>;
    /// `GET /v1/invites`: the pending ones addressed to me.
    async fn list_invites(&self) -> Result<Vec<Invite>>;
    /// `DELETE /v1/invites/{id}`.
    async fn dismiss_invite(&self, id: &str) -> Result<()>;
    /// The full `ws://…/v1/ws?token=…` address of the live socket.
    fn ws_url(&self) -> String;
}

/// The client the launcher uses until the account slice lands.
pub struct ContractHubClient {
    /// Base address without a trailing slash, `http://127.0.0.1:8787`.
    base: String,
    /// The bearer token, 64 hex characters per the contract.
    token: String,
}

/// Builds the hub client for the settings in force, or `None` when nobody is
/// signed in.
///
/// This function and [`ContractHubClient`] are the whole seam. At merge the
/// body becomes `crate::hub::HubClient::from_settings(settings)` and the
/// return type becomes that client; every caller already speaks [`HubApi`].
pub fn connect(settings: &Settings) -> Option<ContractHubClient> {
    let token = settings.hub_token.as_deref()?.trim();
    if token.is_empty() {
        return None;
    }
    let base = settings
        .hub_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(DEFAULT_HUB_URL);
    Some(ContractHubClient {
        base: base.trim_end_matches('/').to_string(),
        token: token.to_string(),
    })
}

/// One connection pool for the whole process.
///
/// A client per call would open a fresh TCP connection for every heartbeat,
/// and on Windows would leave each one in `TIME_WAIT` for two minutes.
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("JKNet/", env!("CARGO_PKG_VERSION")))
            .build()
            // `build` fails only when the TLS backend cannot start, and a
            // launcher without HTTPS cannot install an engine either.
            .unwrap_or_else(|e| {
                log::error!("cannot build the HTTP client: {e}; using the default one");
                reqwest::Client::new()
            })
    })
}

impl ContractHubClient {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        http().get(self.url(path)).bearer_auth(&self.token)
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        http().post(self.url(path)).bearer_auth(&self.token)
    }

    fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        http().delete(self.url(path)).bearer_auth(&self.token)
    }
}

/// Turns the response into the value it carries, or into an [`AppError`].
async fn read<T: DeserializeOwned>(response: Response) -> Result<T> {
    let response = check(response).await?;
    let url = response.url().to_string();
    response
        .json::<T>()
        .await
        .map_err(|e| AppError::Hub(format!("the hub answered {url} with something unreadable: {e}")))
}

/// Checks the status and drops the body: for the calls that answer `204`.
async fn read_empty(response: Response) -> Result<()> {
    check(response).await.map(|_| ())
}

/// Maps a refusal onto the error variant whose cure matches.
///
/// The codes come from the `Errors` line of the contract. `unauthorized` is
/// not [`AppError::SignedOut`]: the launcher holds a token it believes in, and
/// telling the player to sign in when the hub revoked the token is right, but
/// telling them so in the hub's own words is more useful than a generic line.
async fn check(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let url = response.url().to_string();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<HubErrorBody>(&body)
        .map(|parsed| parsed.error)
        .unwrap_or_default();
    log::debug!("hub {status} for {url}: {} {}", detail.code, detail.message);

    Err(match detail.code.as_str() {
        "not_found" => AppError::NotFound(detail.message),
        "invalid" => AppError::InvalidInput(detail.message),
        "rate_limited" => AppError::RateLimited(detail.message),
        "unauthorized" => AppError::Hub(format!(
            "{} Sign in again on the Settings screen.",
            detail.message
        )),
        _ if status == StatusCode::TOO_MANY_REQUESTS => AppError::RateLimited(detail.message),
        _ => AppError::Hub(detail.message),
    })
}

/// Sends a body and reads the answer, naming the call in a transport failure.
async fn send<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
    body: &impl Serialize,
) -> Result<T> {
    read(request.json(body).send().await?).await
}

#[async_trait]
impl HubApi for ContractHubClient {
    async fn get_friends(&self) -> Result<FriendsPayload> {
        read(self.get("/v1/friends").send().await?).await
    }

    async fn send_friend_request(&self, query: &str) -> Result<RequestOutcome> {
        let response = check(
            self.post("/v1/friends/requests")
                .json(&serde_json::json!({ "query": query }))
                .send()
                .await?,
        )
        .await?;

        // Two happy endings share one endpoint: `201` is a request the other
        // side has to accept, `200` is a friendship, because they had already
        // asked. The status is the only thing that tells them apart.
        let created = response.status() == StatusCode::CREATED;
        let url = response.url().to_string();
        let text = response
            .text()
            .await
            .map_err(|e| AppError::Hub(format!("cannot read the answer of {url}: {e}")))?;
        let unreadable =
            |e: serde_json::Error| AppError::Hub(format!("{url} answered oddly: {e}"));

        if created {
            let request: FriendRequest = serde_json::from_str(&text).map_err(unreadable)?;
            Ok(RequestOutcome::Requested { request })
        } else {
            #[derive(serde::Deserialize)]
            struct Accepted {
                friend: Friend,
            }
            let accepted: Accepted = serde_json::from_str(&text).map_err(unreadable)?;
            Ok(RequestOutcome::Accepted {
                friend: accepted.friend,
            })
        }
    }

    async fn accept_request(&self, id: &str) -> Result<Friend> {
        read(
            self.post(&format!("/v1/friends/requests/{id}/accept"))
                .send()
                .await?,
        )
        .await
    }

    async fn decline_request(&self, id: &str) -> Result<()> {
        read_empty(
            self.delete(&format!("/v1/friends/requests/{id}"))
                .send()
                .await?,
        )
        .await
    }

    async fn remove_friend(&self, user_id: &str) -> Result<()> {
        read_empty(self.delete(&format!("/v1/friends/{user_id}")).send().await?).await
    }

    async fn put_presence(&self, update: &PresenceUpdate) -> Result<Presence> {
        send(
            http().put(self.url("/v1/presence")).bearer_auth(&self.token),
            update,
        )
        .await
    }

    async fn create_invite(&self, invite: &NewInvite) -> Result<Invite> {
        send(self.post("/v1/invites"), invite).await
    }

    async fn list_invites(&self) -> Result<Vec<Invite>> {
        read(self.get("/v1/invites").send().await?).await
    }

    async fn dismiss_invite(&self, id: &str) -> Result<()> {
        read_empty(self.delete(&format!("/v1/invites/{id}")).send().await?).await
    }

    fn ws_url(&self) -> String {
        ws_url(&self.base, &self.token)
    }
}

/// Turns the API address into the address of the live socket.
///
/// `http` becomes `ws` and `https` becomes `wss`, which is the whole
/// transformation: the contract puts the socket on the same host and port as
/// the API. An address with neither scheme is left alone, because a hub
/// reachable at `ws://…` in a test rig is still a hub.
///
/// The token is not escaped. It is 64 hex characters per the contract, and
/// [`connect`] refuses anything that could need escaping.
pub fn ws_url(base: &str, token: &str) -> String {
    let base = base.trim_end_matches('/');
    let socket = match base.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        _ => base.to_string(),
    };
    format!("{socket}/v1/ws?token={token}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(url: Option<&str>, token: Option<&str>) -> Settings {
        Settings {
            hub_url: url.map(str::to_string),
            hub_token: token.map(str::to_string),
            ..Settings::default()
        }
    }

    #[test]
    fn there_is_no_client_without_a_token() {
        assert!(connect(&settings(None, None)).is_none());
        assert!(connect(&settings(Some("http://hub.test"), None)).is_none());
        // A file edited by hand can hold a blank token, and a blank bearer is
        // not an anonymous request: it is a 401 on every tick of the heartbeat.
        assert!(connect(&settings(Some("http://hub.test"), Some("   "))).is_none());
    }

    #[test]
    fn a_missing_address_falls_back_to_the_development_hub() {
        let client = connect(&settings(None, Some("abc"))).expect("a client");
        assert_eq!(client.base, DEFAULT_HUB_URL);
        assert_eq!(client.url("/v1/friends"), "http://127.0.0.1:8787/v1/friends");
    }

    #[test]
    fn a_trailing_slash_does_not_double_up_in_a_path() {
        // `settings.json` is edited by hand often enough that this is a real
        // shape, and `//v1/friends` is a 404 on most routers.
        let client = connect(&settings(Some("https://hub.jknet.org/"), Some("abc")))
            .expect("a client");
        assert_eq!(client.url("/v1/me"), "https://hub.jknet.org/v1/me");
    }

    #[test]
    fn the_socket_address_follows_the_scheme_of_the_api() {
        assert_eq!(
            ws_url("http://127.0.0.1:8787", "dead"),
            "ws://127.0.0.1:8787/v1/ws?token=dead"
        );
        assert_eq!(
            ws_url("https://hub.jknet.org", "beef"),
            "wss://hub.jknet.org/v1/ws?token=beef"
        );
        // A path prefix belongs to the hub, so it stays in front of `/v1`.
        assert_eq!(
            ws_url("https://example.test/hub/", "f00d"),
            "wss://example.test/hub/v1/ws?token=f00d"
        );
        // Already a socket address: left alone rather than mangled.
        assert_eq!(ws_url("ws://localhost:1", "x"), "ws://localhost:1/v1/ws?token=x");
    }

    #[test]
    fn the_client_of_a_signed_in_player_points_at_its_own_socket() {
        let client =
            connect(&settings(Some("http://127.0.0.1:8787"), Some("ab12"))).expect("a client");
        assert_eq!(client.ws_url(), "ws://127.0.0.1:8787/v1/ws?token=ab12");
    }
}
