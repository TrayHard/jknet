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

// ---------------------------------------------------------------------------
// --- slice: chat ---
// The chat API, `/v1/chat/*`
// ---------------------------------------------------------------------------
//
// Every structure below reaches the frontend as it came off the wire, so its
// JSON is the contract's. Cards stay `serde_json::Value`: the service
// validates them, the frontend renders them, and the core only carries them.
// A `null` sender, reply author or system id means "Deleted account" and is
// kept as `None` rather than dropped.

/// A conversation as the service computes it for the signed-in player.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    /// `direct`, `group` or `server`.
    pub kind: String,
    /// `None` for a direct conversation and for a group nobody named: the
    /// frontend then prints the names of the members.
    #[serde(default)]
    pub title: Option<String>,
    /// The owner of a group or the host of a server chat.
    #[serde(default)]
    pub owner_id: Option<String>,
    /// A direct conversation whose peer deleted the account holds the viewer
    /// alone.
    #[serde(default)]
    pub members: Vec<ChatMember>,
    #[serde(default)]
    pub last_seq: u64,
    #[serde(default)]
    pub last_message: Option<ChatMessage>,
    /// The viewer's own read marker.
    #[serde(default)]
    pub read_seq: u64,
    /// Messages at or below this `seq` are hidden from the viewer.
    #[serde(default)]
    pub visible_from_seq: u64,
    /// Unread messages of others, capped at 100 by the service.
    #[serde(default)]
    pub unread: u32,
    #[serde(default)]
    pub unread_mentions: u32,
    /// `all`, `mentions` or `mute`.
    #[serde(default = "notify_all")]
    pub notify: String,
    /// `false` for a direct conversation after unfriending or with a deleted
    /// account: the thread is read-only. Absent reads as read-only.
    #[serde(default)]
    pub can_send: bool,
    #[serde(default)]
    pub history_for_new_members: bool,
    /// Set on a server chat only, and never more than these two ids.
    #[serde(default)]
    pub server: Option<ServerChatRef>,
    #[serde(default)]
    pub created_at: String,
}

fn notify_all() -> String {
    "all".to_string()
}

/// The private server a server chat belongs to.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChatRef {
    pub host_id: String,
    /// `jknet_session` of the server: 16 hex characters.
    pub session_id: String,
}

/// One member of a conversation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMember {
    pub user: OnlineUser,
    /// `owner` or `member`.
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub joined_at: String,
    /// Another member's marker is `None` unless both sides share read
    /// receipts; the viewer's own is always there.
    #[serde(default)]
    pub read_seq: Option<u64>,
}

/// One message of a conversation, addressed by `(conversationId, seq)`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub conversation_id: String,
    pub seq: u64,
    /// `None` on a system message, and on a user message of a deleted
    /// account.
    #[serde(default)]
    pub sender_id: Option<String>,
    /// The ULID the sending launcher made, which is how its outbox finds the
    /// message again.
    #[serde(default)]
    pub client_id: Option<String>,
    /// `user` or `system`.
    #[serde(default = "kind_user")]
    pub kind: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub cards: Vec<serde_json::Value>,
    #[serde(default)]
    pub files: Vec<FileRef>,
    /// The members this message mentions, the author of the message it
    /// replies to included.
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default)]
    pub reply_to: Option<ReplyRef>,
    #[serde(default)]
    pub reactions: Vec<ReactionGroup>,
    #[serde(default)]
    pub system: Option<SystemEvent>,
    #[serde(default)]
    pub created_at: String,
}

fn kind_user() -> String {
    "user".to_string()
}

impl ChatMessage {
    /// Whether this message was written by `me`. A deleted account's message
    /// has no sender and is never anybody's own.
    pub fn is_from(&self, me: Option<&str>) -> bool {
        me.is_some() && self.sender_id.as_deref() == me
    }

    /// Whether a player wrote it, as opposed to the service.
    pub fn is_user(&self) -> bool {
        self.kind != "system"
    }
}

/// What a system message records: `created`, `memberAdded`, `renamed`,
/// `historyForNewMembers` and the rest of the contract's list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEvent {
    pub event: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
}

/// The quote of the message a reply answers.
///
/// Two shapes on the wire: `{seq, senderId, excerpt}`, or `{seq, missing:
/// true}` when the original expired or is hidden from the viewer. The
/// frontend receives the same two shapes, so it can tell them apart by the
/// presence of `missing`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRef {
    pub seq: u64,
    #[serde(default)]
    pub sender_id: Option<String>,
    #[serde(default)]
    pub excerpt: String,
    #[serde(default)]
    pub missing: bool,
}

impl Serialize for ReplyRef {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        if self.missing {
            let mut out = serializer.serialize_struct("ReplyRef", 2)?;
            out.serialize_field("seq", &self.seq)?;
            out.serialize_field("missing", &true)?;
            return out.end();
        }
        let mut out = serializer.serialize_struct("ReplyRef", 3)?;
        out.serialize_field("seq", &self.seq)?;
        out.serialize_field("senderId", &self.sender_id)?;
        out.serialize_field("excerpt", &self.excerpt)?;
        out.end()
    }
}

/// The players who reacted to a message with one emoji.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionGroup {
    pub emoji: String,
    #[serde(default)]
    pub user_ids: Vec<String>,
}

/// A file attached to a message, or registered for one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub media_type: String,
    /// `image`, `video`, `demo`, `config`, `archive`, `executable` or
    /// `other`, as the service classified the bytes.
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub danger: bool,
    #[serde(default)]
    pub meta: Option<FileMeta>,
}

/// What the sender's launcher said about a file when it registered it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// `media`, `file` or `clipboard`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// An invitation into a group, for a player who asked to be asked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInvite {
    pub conversation_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub invited_by: OnlineUser,
    #[serde(default)]
    pub member_count: u32,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub expires_at: String,
}

/// The chat settings of the account, `ChatSettings` in the contract: the
/// two reciprocal privacy switches and who may add the player to a group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatPrivacy {
    pub share_read_receipts: bool,
    pub share_typing: bool,
    /// `friends` or `ask`.
    pub group_add: String,
}

/// A missing settings row means the defaults, on the service and here.
impl Default for ChatPrivacy {
    fn default() -> Self {
        ChatPrivacy {
            share_read_receipts: true,
            share_typing: true,
            group_add: "friends".to_string(),
        }
    }
}

/// A partial update of [`ChatPrivacy`], `PATCH /v1/chat/settings`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPrivacyPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_read_receipts: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_typing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_add: Option<String>,
}

/// How much of the account's file allowance is used.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatQuota {
    pub used_bytes: u64,
    pub quota_bytes: u64,
    /// When the oldest file expires and frees its bytes.
    pub next_free_at: Option<String>,
}

/// The answer of `GET /v1/chat/conversations`: everything the launcher
/// keeps about chat, in one document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatSyncDoc {
    pub conversations: Vec<Conversation>,
    pub group_invites: Vec<GroupInvite>,
    pub settings: ChatPrivacy,
    pub quota: ChatQuota,
}

/// One page of history, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<ChatMessage>,
    pub has_before: bool,
    pub has_after: bool,
}

/// One page of search results, newest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchPage {
    pub results: Vec<SearchHit>,
    /// Opaque: handed back as `before` for the next page.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message: ChatMessage,
}

/// The answer of `POST /v1/chat/files` and of the upload that follows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRegistration {
    pub file: FileRef,
    /// `false` when the account already stored the same bytes: the launcher
    /// skips the upload.
    #[serde(default)]
    pub needs_upload: bool,
}

/// A player the service did not add to a group, and why: `not_friend`,
/// `member`, `full` or `cooldown`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub user_id: String,
    pub reason: String,
}

/// The answer of `POST /v1/chat/groups`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupResult {
    pub conversation: Conversation,
    #[serde(default, deserialize_with = "user_ids")]
    pub added: Vec<String>,
    #[serde(default, deserialize_with = "user_ids")]
    pub invited: Vec<String>,
    #[serde(default)]
    pub refused: Vec<Refusal>,
}

/// The answer of `POST /v1/chat/groups/{id}/members`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AddResult {
    #[serde(deserialize_with = "user_ids")]
    pub added: Vec<String>,
    #[serde(deserialize_with = "user_ids")]
    pub invited: Vec<String>,
    pub refused: Vec<Refusal>,
}

/// Reads a list of players as ids, whether the service lists ids, users or
/// members: the three shapes name the same people, and the frontend matches
/// them against the friends list by id.
fn user_ids<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let values = Vec::<serde_json::Value>::deserialize(deserializer)?;
    Ok(values
        .iter()
        .filter_map(|value| {
            value
                .as_str()
                .or_else(|| value.get("id").and_then(serde_json::Value::as_str))
                .or_else(|| value.pointer("/user/id").and_then(serde_json::Value::as_str))
                .map(str::to_string)
        })
        .collect())
}

/// What `POST /v1/chat/conversations/{id}/messages` carries.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessage {
    pub client_id: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cards: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_seq: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(id: &str) -> serde_json::Value {
        json!({
            "id": id, "displayName": id, "avatarUrl": null, "provider": "dev",
            "providerName": id, "createdAt": "2026-09-26T10:00:00Z"
        })
    }

    /// A message the way the contract writes it, with everything a message
    /// can carry.
    fn wire_message() -> serde_json::Value {
        json!({
            "conversationId": "01JCONV", "seq": 42, "senderId": "01HKYLE",
            "clientId": "01JCLIENT", "kind": "user", "body": "gg <@01HME>",
            "cards": [{ "type": "map", "v": 1, "fallbackText": "mp/ffa3", "game": "ja", "name": "mp/ffa3" }],
            "files": [{
                "id": "01JFILE", "name": "shot.jpg", "size": 812345, "mediaType": "image/jpeg",
                "class": "image", "danger": false,
                "meta": { "width": 1920, "height": 1080, "durationMs": null, "origin": "media" }
            }],
            "mentions": ["01HME"],
            "replyTo": { "seq": 40, "senderId": null, "excerpt": "who left?" },
            "reactions": [{ "emoji": "👍", "userIds": ["01HME"] }],
            "system": null,
            "createdAt": "2026-09-26T10:42:00Z"
        })
    }

    #[test]
    fn a_conversation_of_the_contract_reads_and_writes_back_the_same() {
        let wire = json!({
            "id": "01JCONV", "kind": "group", "title": null, "ownerId": "01HKYLE",
            "members": [
                { "user": user("01HME"), "role": "member", "joinedAt": "2026-09-26T10:00:00Z", "readSeq": 40 },
                { "user": user("01HKYLE"), "role": "owner", "joinedAt": "2026-09-26T10:00:00Z", "readSeq": null }
            ],
            "lastSeq": 42, "lastMessage": wire_message(),
            "readSeq": 40, "visibleFromSeq": 0, "unread": 2, "unreadMentions": 1,
            "notify": "mentions", "canSend": true, "historyForNewMembers": false,
            "server": null, "createdAt": "2026-09-26T10:00:00Z"
        });
        let conversation: Conversation = serde_json::from_value(wire.clone()).expect("parses");
        assert_eq!(conversation.members[1].read_seq, None, "a hidden marker stays hidden");
        assert_eq!(conversation.members[0].read_seq, Some(40));
        let message = conversation.last_message.as_ref().expect("a last message");
        let reply = message.reply_to.as_ref().expect("a reply");
        assert_eq!(reply.sender_id, None, "a deleted author stays unnamed");
        assert!(!reply.missing);

        // What reaches the frontend is what came off the wire, minus the
        // `avatarUrl: null` and `admin` of `User`, which is not chat's.
        let back = serde_json::to_value(&conversation).expect("writes");
        for key in ["lastSeq", "readSeq", "unread", "unreadMentions", "notify", "canSend"] {
            assert_eq!(back[key], wire[key], "{key}");
        }
        assert_eq!(back["lastMessage"]["replyTo"], wire["lastMessage"]["replyTo"]);
        assert_eq!(back["lastMessage"]["files"][0]["meta"]["width"], 1920);
        assert_eq!(back["lastMessage"]["cards"], wire["lastMessage"]["cards"]);
        assert_eq!(back["members"][1]["readSeq"], serde_json::Value::Null);
        let again: Conversation = serde_json::from_value(back).expect("parses again");
        assert_eq!(again, conversation);
    }

    #[test]
    fn a_reply_to_a_missing_message_keeps_its_own_shape() {
        let missing: ReplyRef =
            serde_json::from_value(json!({ "seq": 7, "missing": true })).expect("parses");
        assert!(missing.missing);
        assert_eq!(
            serde_json::to_value(&missing).expect("writes"),
            json!({ "seq": 7, "missing": true })
        );
        let present: ReplyRef = serde_json::from_value(
            json!({ "seq": 8, "senderId": "01HKYLE", "excerpt": "duel?" }),
        )
        .expect("parses");
        assert_eq!(
            serde_json::to_value(&present).expect("writes"),
            json!({ "seq": 8, "senderId": "01HKYLE", "excerpt": "duel?" })
        );
    }

    #[test]
    fn a_system_message_and_a_deleted_accounts_message_keep_their_nulls() {
        let system: ChatMessage = serde_json::from_value(json!({
            "conversationId": "c", "seq": 3, "senderId": null, "kind": "system",
            "system": { "event": "memberLeft", "userId": null, "by": null },
            "createdAt": "2026-09-26T10:00:00Z"
        }))
        .expect("parses");
        assert!(!system.is_user());
        let back = serde_json::to_value(&system).expect("writes");
        assert_eq!(
            back["system"],
            json!({ "event": "memberLeft", "userId": null, "by": null })
        );
        assert_eq!(back["senderId"], serde_json::Value::Null);

        let history: ChatMessage = serde_json::from_value(json!({
            "conversationId": "c", "seq": 4, "senderId": null, "kind": "user",
            "body": "hi <@deleted>", "system": { "event": "historyForNewMembers", "on": true, "by": "01HKYLE" }
        }))
        .expect("parses");
        assert!(history.is_user());
        assert_eq!(history.system.and_then(|event| event.on), Some(true));
    }

    #[test]
    fn a_sync_document_reads_with_every_part_and_with_none() {
        let doc: ChatSyncDoc = serde_json::from_value(json!({
            "conversations": [{ "id": "c", "kind": "direct", "canSend": false, "members": [] }],
            "groupInvites": [{
                "conversationId": "g", "title": "Saber school", "invitedBy": user("01HMARA"),
                "memberCount": 3, "createdAt": "2026-09-26T10:00:00Z", "expiresAt": "2026-10-03T10:00:00Z"
            }],
            "settings": { "shareReadReceipts": false, "shareTyping": true, "groupAdd": "ask" },
            "quota": { "usedBytes": 1024, "quotaBytes": 1073741824, "nextFreeAt": null }
        }))
        .expect("parses");
        assert_eq!(doc.conversations[0].notify, "all");
        assert!(!doc.conversations[0].can_send);
        assert_eq!(doc.group_invites[0].member_count, 3);
        assert_eq!(doc.settings.group_add, "ask");
        assert_eq!(doc.quota.quota_bytes, 1_073_741_824);

        // An empty document is the defaults: sharing on, adding by friends.
        let empty: ChatSyncDoc = serde_json::from_value(json!({})).expect("parses");
        assert_eq!(empty.settings, ChatPrivacy::default());
        assert!(empty.settings.share_read_receipts && empty.settings.share_typing);
    }

    #[test]
    fn the_players_of_a_group_answer_read_as_ids_in_any_of_three_shapes() {
        let result: GroupResult = serde_json::from_value(json!({
            "conversation": { "id": "g", "kind": "group" },
            "added": ["01HKYLE", { "id": "01HJAN" }, { "user": user("01HMARA") }],
            "invited": [],
            "refused": [{ "userId": "01HDASH", "reason": "not_friend" }]
        }))
        .expect("parses");
        assert_eq!(result.added, ["01HKYLE", "01HJAN", "01HMARA"]);
        assert_eq!(result.refused[0].reason, "not_friend");
        let added: AddResult = serde_json::from_value(json!({ "invited": ["01HLUKE"] })).expect("parses");
        assert_eq!((added.added.len(), added.invited.len()), (0, 1));
    }

    #[test]
    fn a_new_message_leaves_out_what_it_does_not_carry() {
        let plain = NewMessage {
            client_id: "01JCLIENT".into(),
            body: "gg".into(),
            ..NewMessage::default()
        };
        assert_eq!(
            serde_json::to_value(&plain).expect("writes"),
            json!({ "clientId": "01JCLIENT", "body": "gg" })
        );
        let full = NewMessage {
            file_ids: vec!["01JFILE".into()],
            reply_seq: Some(40),
            ..plain
        };
        let value = serde_json::to_value(&full).expect("writes");
        assert_eq!(value["fileIds"], json!(["01JFILE"]));
        assert_eq!(value["replySeq"], 40);
        let patch = ChatPrivacyPatch {
            share_typing: Some(false),
            ..ChatPrivacyPatch::default()
        };
        assert_eq!(
            serde_json::to_value(&patch).expect("writes"),
            json!({ "shareTyping": false })
        );
    }

    #[test]
    fn a_file_registration_reads_both_answers() {
        let registered: FileRegistration = serde_json::from_value(json!({
            "file": { "id": "01JFILE", "name": "demo.dm_26", "size": 10, "mediaType": "application/octet-stream",
                      "class": "demo", "danger": false, "meta": null },
            "needsUpload": true
        }))
        .expect("parses");
        assert!(registered.needs_upload);
        // The upload answers `{file}` alone.
        let uploaded: FileRegistration = serde_json::from_value(json!({
            "file": { "id": "01JFILE", "name": "x.exe", "class": "executable", "danger": true }
        }))
        .expect("parses");
        assert!(!uploaded.needs_upload && uploaded.file.danger);
    }
}
