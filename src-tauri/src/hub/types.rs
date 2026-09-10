//! Wire types of the JKNet hub API v1.
//!
//! Every structure here mirrors the contract one to one and travels in both
//! directions: the hub sends it as JSON, and the same structure reaches the
//! frontend as the answer of a command. Field names are camelCase on the wire.
//!
//! Two rules keep this file forward compatible with a hub that ships before
//! the launcher does. Enumerations of the contract (`provider`, `status`) are
//! plain strings, so a provider added on the server does not turn every answer
//! into a parse error; and every optional field carries `#[serde(default)]`,
//! because the contract says both sides ignore what they do not know.

use serde::{Deserialize, Serialize};

/// A hub account. `User` in the contract.
///
/// The launcher caches this in `settings.json` under `hubUser`, so the sidebar
/// can print a name before the first request to the hub answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubUser {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// `jkhub`, `discord` or `dev`.
    pub provider: String,
    /// The name the provider knows the player by, such as a JKHub login.
    pub provider_name: String,
    /// RFC 3339 in UTC. Empty when the hub leaves it out.
    #[serde(default)]
    pub created_at: String,
}

/// Where a player is right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    /// `online`, `in_game` or `offline`.
    pub status: String,
    #[serde(default)]
    pub server_address: Option<String>,
    #[serde(default)]
    pub server_name: Option<String>,
    /// Name of the JKNet client the player started the game with.
    #[serde(default)]
    pub client_name: Option<String>,
    /// RFC 3339 in UTC.
    #[serde(default)]
    pub since: String,
}

/// What `PUT /v1/presence` carries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUpdate {
    /// `online` or `in_game`; the hub decides when someone is `offline`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
}

/// The answer of `GET /v1/me`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub user: HubUser,
    pub presence: Presence,
}

/// Someone on the friends list, with where they are.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friend {
    pub user: HubUser,
    pub presence: Presence,
    /// RFC 3339 in UTC.
    #[serde(default)]
    pub friends_since: String,
}

/// A friend request, in either direction. `Request` in the contract, renamed
/// here because `Request` alone would read as an HTTP request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequest {
    pub id: String,
    pub from: HubUser,
    pub to: HubUser,
    #[serde(default)]
    pub created_at: String,
}

/// The answer of `GET /v1/friends`: the list and both request queues.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsList {
    #[serde(default)]
    pub friends: Vec<Friend>,
    #[serde(default)]
    pub incoming: Vec<FriendRequest>,
    #[serde(default)]
    pub outgoing: Vec<FriendRequest>,
}

/// What `POST /v1/friends/requests` produced.
///
/// The contract answers `201` with a request, or `200` with a friendship when
/// the other side had already asked. One structure with two optional fields
/// keeps that fork readable on the frontend: exactly one of them is set.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequestResult {
    pub request: Option<FriendRequest>,
    pub friend: Option<Friend>,
}

/// An invitation to a server, addressed to one friend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub from: HubUser,
    pub server_address: String,
    #[serde(default)]
    pub server_name: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub created_at: String,
    /// RFC 3339 in UTC; the hub drops an invite ten minutes after it is made.
    #[serde(default)]
    pub expires_at: String,
}

/// What `POST /v1/invites` carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewInvite {
    pub to_user_id: String,
    pub server_address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One browser round trip of the sign-in.
///
/// The launcher opens `url` in the system browser and then polls the session
/// until its `status` leaves `pending`. `token` and `user` arrive exactly once,
/// on the first read that finds the session `done`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginSession {
    pub id: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub url: String,
    /// `pending`, `done`, `error` or `expired`.
    pub status: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub user: Option<HubUser>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A [`LoginSession`] with the token taken out, which is what a command may
/// return to the frontend.
///
/// The token never leaves the core: `poll_sign_in` writes it into
/// `settings.json` and hands the frontend the user instead.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInPoll {
    /// `pending`, `done`, `error` or `expired`.
    pub status: String,
    pub user: Option<HubUser>,
    /// What the provider said when `status` is `error`.
    pub error: Option<String>,
}
