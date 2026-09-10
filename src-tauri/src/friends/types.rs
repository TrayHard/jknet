//! Wire types of the JKNet hub, API v1.
//!
//! --- slice: friends (temporary, replaced by hub module at merge) ---
//!
//! Every structure here mirrors one entry of the `## Types` table of the hub
//! contract. Field names are camelCase on the wire in both directions, and
//! unknown fields are ignored on purpose: the contract says both sides may add
//! keys without breaking the other one, which is what lets an older launcher
//! keep talking to a newer hub.
//!
//! These types reach the frontend unchanged, so `src/lib/ipc.ts` repeats them
//! one to one.

use serde::{Deserialize, Serialize};

/// A person on the hub. `providerName` is the name at the identity provider
/// (`kyle_k` on JKHub); `displayName` is what the player picked in JKNet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubUser {
    pub id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    /// `jkhub`, `discord` or `dev`.
    pub provider: String,
    pub provider_name: String,
    /// RFC 3339 in UTC.
    pub created_at: String,
}

/// Where a player is right now.
///
/// `Offline` is never sent by the launcher: the hub derives it from a missing
/// heartbeat. It is here because the hub reports it for friends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceStatus {
    Online,
    InGame,
    #[default]
    Offline,
}

impl PresenceStatus {
    /// Whether the hub accepts this status in a `PUT /v1/presence` body.
    ///
    /// Only two of the three are reportable. A launcher that is closing does
    /// not announce it; the hub times the player out after 90 s instead, which
    /// is also what covers a launcher killed from the task manager.
    pub fn is_reportable(self) -> bool {
        matches!(self, PresenceStatus::Online | PresenceStatus::InGame)
    }
}

/// The presence of one player, as the hub stores it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Presence {
    pub status: PresenceStatus,
    /// `ip:port` of the server the player is on.
    pub server_address: Option<String>,
    /// Host name of that server with the Quake colour codes removed.
    pub server_name: Option<String>,
    /// Name of the JKNet client the player started.
    pub client_name: Option<String>,
    /// RFC 3339 time the status last changed.
    pub since: String,
}

/// Body of `PUT /v1/presence`.
///
/// A field the launcher has nothing for is left out rather than sent as
/// `null`: the contract treats both the same, and an absent key keeps the
/// request readable in a packet log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUpdate {
    pub status: PresenceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
}

impl From<&Presence> for PresenceUpdate {
    fn from(presence: &Presence) -> Self {
        PresenceUpdate {
            status: presence.status,
            server_address: presence.server_address.clone(),
            server_name: presence.server_name.clone(),
            client_name: presence.client_name.clone(),
        }
    }
}

/// One friendship, with the friend's presence attached.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Friend {
    pub user: HubUser,
    pub presence: Presence,
    /// RFC 3339 in UTC.
    pub friends_since: String,
}

/// A friend request, incoming or outgoing depending on which list holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FriendRequest {
    pub id: String,
    pub from: HubUser,
    pub to: HubUser,
    pub created_at: String,
}

/// An invitation to a server, addressed to one friend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub from: HubUser,
    pub server_address: String,
    pub server_name: Option<String>,
    pub message: Option<String>,
    pub created_at: String,
    /// RFC 3339; the hub drops the invite ten minutes after it was made.
    pub expires_at: String,
}

/// Body of `POST /v1/invites`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewInvite {
    pub to_user_id: String,
    pub server_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The answer of `GET /v1/friends`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FriendsPayload {
    pub friends: Vec<Friend>,
    pub incoming: Vec<FriendRequest>,
    pub outgoing: Vec<FriendRequest>,
}

/// What `POST /v1/friends/requests` answered with.
///
/// The contract has two happy endings: `201` with the new request, and `200`
/// with a friendship, which is what happens when the other side had already
/// asked. The tag reaches the frontend so the screen can say "Request sent" or
/// "You are now friends" without guessing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum RequestOutcome {
    /// `201 Request`: the other side has to accept.
    Requested { request: FriendRequest },
    /// `200 { friend }`: the pending request from the other side was accepted.
    Accepted { friend: Friend },
}

/// The body the hub sends with a refusal: `{ "error": { code, message } }`.
#[derive(Debug, Clone, Deserialize)]
pub struct HubErrorBody {
    pub error: HubErrorDetail,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct HubErrorDetail {
    pub code: String,
    pub message: String,
}

impl Default for HubErrorDetail {
    fn default() -> Self {
        HubErrorDetail {
            code: "internal".into(),
            message: "the hub gave no reason".into(),
        }
    }
}

/// One frame of the WebSocket: `{ type, payload, at }`.
#[derive(Debug, Clone, Deserialize)]
pub struct LiveFrame {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Payload of the `presence.updated` frame, and of the `friends:presence`
/// Tauri event it turns into.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PresenceUpdated {
    pub user_id: String,
    pub presence: Presence,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_presence_statuses_use_the_names_of_the_contract() {
        let json = serde_json::to_string(&PresenceStatus::InGame).expect("serializes");
        assert_eq!(json, "\"in_game\"");
        let parsed: PresenceStatus =
            serde_json::from_str("\"online\"").expect("parses");
        assert_eq!(parsed, PresenceStatus::Online);
        assert!(PresenceStatus::Online.is_reportable());
        assert!(PresenceStatus::InGame.is_reportable());
        assert!(!PresenceStatus::Offline.is_reportable());
    }

    #[test]
    fn a_presence_update_leaves_out_what_it_does_not_know() {
        // The hub reads an absent key and an explicit null the same way, and a
        // body of four nulls is unreadable in a log.
        let body = PresenceUpdate {
            status: PresenceStatus::Online,
            server_address: None,
            server_name: None,
            client_name: Some("Everyday".into()),
        };
        let json = serde_json::to_string(&body).expect("serializes");
        assert_eq!(json, r#"{"status":"online","clientName":"Everyday"}"#);
    }

    #[test]
    fn a_friend_parses_from_the_shape_the_contract_documents() {
        let friend: Friend = serde_json::from_str(
            r#"{
                "user": {
                    "id": "01J",
                    "displayName": "Kyle",
                    "avatarUrl": null,
                    "provider": "jkhub",
                    "providerName": "kyle_k",
                    "createdAt": "2026-01-02T03:04:05Z"
                },
                "presence": {
                    "status": "in_game",
                    "serverAddress": "203.0.113.10:29070",
                    "serverName": "EU FFA",
                    "clientName": "Everyday",
                    "since": "2026-09-10T10:00:00Z"
                },
                "friendsSince": "2026-05-05T00:00:00Z",
                "somethingTheHubAddedLater": 7
            }"#,
        )
        .expect("a friend parses");

        assert_eq!(friend.user.display_name, "Kyle");
        assert_eq!(friend.presence.status, PresenceStatus::InGame);
        assert_eq!(
            friend.presence.server_address.as_deref(),
            Some("203.0.113.10:29070")
        );
        assert_eq!(friend.friends_since, "2026-05-05T00:00:00Z");
    }

    #[test]
    fn a_missing_optional_field_is_not_an_error() {
        // Every list the screen renders comes from one of these, and a hub that
        // omits an empty list must not blank the whole screen.
        let payload: FriendsPayload = serde_json::from_str("{}").expect("parses");
        assert!(payload.friends.is_empty());
        assert!(payload.incoming.is_empty());
        assert!(payload.outgoing.is_empty());

        let invite: Invite = serde_json::from_str(
            r#"{"id":"i1","from":{"id":"u1"},"serverAddress":"1.2.3.4:29070",
                "createdAt":"x","expiresAt":"y"}"#,
        )
        .expect("an invite without a name parses");
        assert_eq!(invite.server_name, None);
        assert_eq!(invite.from.id, "u1");
    }

    #[test]
    fn a_refusal_without_a_body_still_names_a_code() {
        let detail = HubErrorDetail::default();
        assert_eq!(detail.code, "internal");
        let body: HubErrorBody =
            serde_json::from_str(r#"{"error":{"code":"conflict"}}"#).expect("parses");
        assert_eq!(body.error.code, "conflict");
        assert_eq!(body.error.message, "the hub gave no reason");
    }
}
