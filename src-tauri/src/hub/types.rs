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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
///
/// `status` is a string rather than an enumeration on purpose, like every
/// other enumeration of the contract here: a hub that grows a fourth status
/// must not turn the whole friends list into a parse error on an older
/// launcher. The three the contract has are [`Presence::ONLINE`],
/// [`Presence::IN_GAME`] and [`Presence::OFFLINE`].
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

/// A presence nobody has said anything about is an offline one, which is also
/// what the hub decides after 90 s without a heartbeat.
impl Default for Presence {
    fn default() -> Self {
        Presence {
            status: Presence::OFFLINE.to_string(),
            server_address: None,
            server_name: None,
            client_name: None,
            since: String::new(),
        }
    }
}

impl Presence {
    /// In the launcher, with no game running.
    pub const ONLINE: &'static str = "online";
    /// A game started from the launcher is open, on a server or on its menu.
    pub const IN_GAME: &'static str = "in_game";
    /// Not here. Derived by the hub from a missing heartbeat.
    pub const OFFLINE: &'static str = "offline";

    /// Whether the launcher may report this status in a `PUT /v1/presence`.
    ///
    /// Only two of the three are reportable. A launcher that is closing does
    /// not announce it; the hub times the player out after 90 s instead, which
    /// is also what covers a launcher killed from the task manager.
    pub fn is_reportable(&self) -> bool {
        self.status == Presence::ONLINE || self.status == Presence::IN_GAME
    }

    /// Whether the player has a game open right now.
    pub fn in_game(&self) -> bool {
        self.status == Presence::IN_GAME
    }
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

/// What the launcher would report to say it is where this presence says.
///
/// A field it has nothing for is left out rather than sent as `null`: the
/// contract reads both the same way, and an absent key keeps the request
/// readable in a packet log.
impl From<&Presence> for PresenceUpdate {
    fn from(presence: &Presence) -> Self {
        PresenceUpdate {
            status: presence.status.clone(),
            server_address: presence.server_address.clone(),
            server_name: presence.server_name.clone(),
            client_name: presence.client_name.clone(),
        }
    }
}

/// The answer of `GET /v1/me`, which only the tests read: see
/// [`HubClient::get_me`](super::client::HubClient::get_me).
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub user: HubUser,
    pub presence: Presence,
}

/// Someone on the friends list, with where they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequest {
    pub id: String,
    pub from: HubUser,
    pub to: HubUser,
    #[serde(default)]
    pub created_at: String,
}

/// The answer of `GET /v1/friends`: the list and both request queues.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Read back off the wire and never used: the launcher asked for this
    /// provider a moment ago and already knows which it was.
    #[allow(dead_code)]
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

// ---------------------------------------------------------------------------
// The live socket
// ---------------------------------------------------------------------------

/// One frame of `GET /v1/ws`: `{ type, payload, at }`.
///
/// The payload is left unparsed because every frame type carries a different
/// one, and a frame the launcher does not know has to be ignored rather than
/// break the ones after it.
#[derive(Debug, Clone, Deserialize)]
pub struct LiveFrame {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Payload of the `presence.updated` frame, and of the `friends:presence`
/// Tauri event it turns into.
///
/// The hub sends it only when a presence field actually changes. A heartbeat
/// that repeats what it said last time produces no frame, so silence means
/// "nothing moved", never "the friend is gone".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PresenceUpdated {
    pub user_id: String,
    pub presence: Presence,
}

/// Payload of the `friend.removed` frame.
///
/// It arrives for a friendship that ended and, on the real hub, for a request
/// that was declined or cancelled as well: one code for "that relationship is
/// no longer there", whichever of the three lists it was in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FriendRemoved {
    pub user_id: String,
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
