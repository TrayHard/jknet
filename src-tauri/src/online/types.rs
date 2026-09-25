//! Wire types of JKNet Online API v1.
//!
//! Every structure here mirrors the contract one to one and travels in both
//! directions: the service sends it as JSON, and the same structure reaches the
//! frontend as the answer of a command. Field names are camelCase on the wire.
//!
//! Two rules keep this file forward compatible with a service that ships before
//! the launcher does. Enumerations of the contract (`provider`, `status`) are
//! plain strings, so a provider added on the server does not turn every answer
//! into a parse error; and every optional field carries `#[serde(default)]`,
//! because the contract says both sides ignore what they do not know.

use serde::{Deserialize, Serialize};

/// A service account. `User` in the contract.
///
/// The launcher caches this in `settings.json` under `onlineUser`, so the sidebar
/// can print a name before the first request to the service answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineUser {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// `jkhub`, `discord` or `dev`.
    pub provider: String,
    /// The name the provider knows the player by, such as a JKHub login.
    pub provider_name: String,
    /// RFC 3339 in UTC. Empty when the service leaves it out.
    #[serde(default)]
    pub created_at: String,
    // --- slice: bundles ---
    /// Whether the account reviews bundles, copied out of [`Me::admin`] at
    /// sign-in and cached with the rest of the account. Not a field of the
    /// contract's `User`: the service says it on `GET /v1/me` alone, so every
    /// `User` that arrives inside a friend or a request reads as `false`.
    #[serde(default)]
    pub admin: bool,
}

/// Where a player is right now.
///
/// `status` is a string rather than an enumeration on purpose, like every
/// other enumeration of the contract here: a service that grows a fourth status
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
    // --- slice: play with friends ---
    /// The private server this player hosts. A friend's presence carries the
    /// service's view for this player (`canJoin`, the password only where it
    /// is true); the launcher's own carries the whole object.
    #[serde(default)]
    pub hosting: Option<HostingInfo>,
}

/// A presence nobody has said anything about is an offline one, which is also
/// what the service decides after 90 s without a heartbeat.
impl Default for Presence {
    fn default() -> Self {
        Presence {
            status: Presence::OFFLINE.to_string(),
            server_address: None,
            server_name: None,
            client_name: None,
            since: String::new(),
            hosting: None,
        }
    }
}

// --- slice: play with friends ---
/// The `hosting` object of a presence and of an invite: a private server one
/// player runs for friends.
///
/// The host's launcher sends it whole — the password, `joinPolicy` and
/// `joinUserIds` included. The service forwards each friend a view of their
/// own: no `joinUserIds`, `canJoin` set, and the password only where
/// `canJoin` is true. An invite carries the password to its one recipient.
///
/// `game` and `joinPolicy` are strings, like every enumeration of the
/// contract here: a value a newer launcher sends must not turn a friend list
/// into a parse error. `Debug` leaves the password out.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostingInfo {
    /// `jknet_session` of the server: 16 hex characters the launcher made.
    /// Not the id of a relay session.
    pub session_id: String,
    /// `ja` or `jo`.
    pub game: String,
    /// `fs_game`, `None` for `base`.
    #[serde(default, rename = "mod")]
    pub mod_name: Option<String>,
    #[serde(default)]
    pub map: Option<String>,
    #[serde(default)]
    pub gametype: u32,
    #[serde(default)]
    pub players: u32,
    #[serde(default)]
    pub max_players: u32,
    /// `a.b.c.d:port` of the host's network, at most four.
    #[serde(default)]
    pub lan_addresses: Vec<String>,
    /// `a.b.c.d:port` of the relay session, when the relay carries the server.
    #[serde(default)]
    pub relay_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// `friends`, `selected` or `invite`.
    #[serde(default)]
    pub join_policy: String,
    /// The friends who join without an invite under `selected`. Only on the
    /// host's own copy: the service drops it from what friends see.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_user_ids: Option<Vec<String>>,
    /// Whether the friend reading this may join without an invite. Set by the
    /// service on the copy it forwards; the host never sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_join: Option<bool>,
}

impl std::fmt::Debug for HostingInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Every field named: a new one fails to build until it is listed here.
        let HostingInfo {
            session_id,
            game,
            mod_name,
            map,
            gametype,
            players,
            max_players,
            lan_addresses,
            relay_address,
            password,
            join_policy,
            join_user_ids,
            can_join,
        } = self;
        f.debug_struct("HostingInfo")
            .field("session_id", session_id)
            .field("game", game)
            .field("mod_name", mod_name)
            .field("map", map)
            .field("gametype", gametype)
            .field("players", players)
            .field("max_players", max_players)
            .field("lan_addresses", lan_addresses)
            .field("relay_address", relay_address)
            .field("password", &password.as_ref().map(|_| "<redacted>"))
            .field("join_policy", join_policy)
            .field("join_user_ids", join_user_ids)
            .field("can_join", can_join)
            .finish()
    }
}

impl Presence {
    /// In the launcher, with no game running.
    pub const ONLINE: &'static str = "online";
    /// A game started from the launcher is open, on a server or on its menu.
    pub const IN_GAME: &'static str = "in_game";
    /// Not here. Derived by the service from a missing heartbeat.
    pub const OFFLINE: &'static str = "offline";

    /// Whether the launcher may report this status in a `PUT /v1/presence`.
    ///
    /// Only two of the three are reportable. A launcher that is closing does
    /// not announce it; the service times the player out after 90 s instead, which
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
    /// `online` or `in_game`; the service decides when someone is `offline`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    // --- slice: play with friends ---
    /// The private server this launcher runs, whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosting: Option<HostingInfo>,
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
            hosting: presence.hosting.clone(),
        }
    }
}

/// The answer of `GET /v1/me`: see
/// [`OnlineClient::get_me`](super::client::OnlineClient::get_me).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub user: OnlineUser,
    #[serde(default)]
    pub presence: Presence,
    // --- slice: bundles ---
    /// Whether this account may review bundle versions that carry executables.
    /// A service older than the bundles feature leaves it out.
    #[serde(default)]
    pub admin: bool,
}

/// Someone on the friends list, with where they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friend {
    pub user: OnlineUser,
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
    pub from: OnlineUser,
    pub to: OnlineUser,
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
    pub from: OnlineUser,
    pub server_address: String,
    #[serde(default)]
    pub server_name: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub created_at: String,
    /// RFC 3339 in UTC; the service drops an invite ten minutes after it is made.
    #[serde(default)]
    pub expires_at: String,
    // --- slice: play with friends ---
    /// The private server the invite leads to, `None` for an ordinary one.
    #[serde(default)]
    pub hosting: Option<HostingInfo>,
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
    // --- slice: play with friends ---
    /// The private server, with its password, for an invite of `host_invite`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosting: Option<HostingInfo>,
}

// ---------------------------------------------------------------------------
// --- slice: play with friends ---
// The relay API, `/v1/relay/*`
// ---------------------------------------------------------------------------

/// One relay node as the service describes it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayNode {
    pub id: String,
    #[serde(default)]
    pub region: String,
    /// `a.b.c.d:port` of the control port the tunnel talks to.
    pub control_address: String,
}

/// The limits the service set for one relay session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RelayLimits {
    pub max_guests: u32,
    pub guest_bytes_per_sec: u64,
    pub session_bytes_per_sec: u64,
}

/// What is left of the account's relay time today.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RelayQuota {
    pub daily_seconds_left: u64,
}

/// The answer of `POST /v1/relay/sessions` and of its `/renew`.
///
/// `ticket` and `hostKey` are base64url without padding. The ticket is opaque
/// here: the tunnel hands it to the node as it is. The host key signs every
/// message between the two and never leaves memory.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayGrant {
    /// The relay session: 16 hex characters, the `session_id` of every message.
    pub session_id: String,
    pub node: RelayNode,
    pub ticket: String,
    pub host_key: String,
    /// RFC 3339: when the ticket runs out.
    pub expires_at: String,
    #[serde(default)]
    pub keepalive_secs: Option<u16>,
    #[serde(default)]
    pub limits: RelayLimits,
    #[serde(default)]
    pub quota: RelayQuota,
}

/// The ticket and the key must not reach a log line through `{:?}`.
impl std::fmt::Debug for RelayGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayGrant")
            .field("session_id", &self.session_id)
            .field("node", &self.node)
            .field("ticket", &"<redacted>")
            .field("host_key", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
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
    pub user: Option<OnlineUser>,
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
/// The service sends it only when a presence field actually changes. A heartbeat
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
/// It arrives for a friendship that ended and, on the real service, for a request
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
    pub user: Option<OnlineUser>,
    /// What the provider said when `status` is `error`.
    pub error: Option<String>,
}
