//! The `chat.*` frames of the live socket.
//!
//! `crate::friends::live` hands every frame whose type starts with `chat.`
//! to [`handle`]. A frame is parsed into a [`Frame`], applied to
//! [`ChatState`] by [`apply`], which touches no window and no network and
//! answers what should happen next as a list of [`Effect`]s; [`handle`] then
//! runs them. The split keeps the rules testable without a running launcher.
//!
//! | Frame                       | What it does                                   | Event          |
//! | --------------------------- | ---------------------------------------------- | -------------- |
//! | `chat.message`              | moves the summary, settles the outbox entry    | `chat:message` |
//! | `chat.read`                 | moves a read marker                            | `chat:read`    |
//! | `chat.typing`               | notes who types, until `ttlMs` runs out        | `chat:typing`  |
//! | `chat.reaction`             | patches the last message of the summary        | `chat:reaction`|
//! | `chat.conversation`         | replaces one summary                           | `chat:state`   |
//! | `chat.conversation.removed` | drops one summary, its queue and its draft     | `chat:removed` |
//! | `chat.groupInvite`          | adds an invite                                 | `chat:state`   |
//! | `chat.groupInvite.removed`  | drops an invite                                | `chat:state`   |
//! | `chat.settings`             | replaces the privacy settings                  | `chat:state`   |
//! | `chat.resync`               | the socket lagged: read the sync document again| `chat:resync`  |
//!
//! A frame of a kind this build does not know is logged and dropped, the
//! same rule the socket applies to every other frame.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::online::{ChatMessage, ChatPrivacy, Conversation, GroupInvite};

use super::{
    emit, emit_outbox, lock, my_id, schedule_state, sync, ChatState, EVENT_MESSAGE, EVENT_REACTION,
    EVENT_READ, EVENT_REMOVED, EVENT_TYPING,
};

/// How long a typing hint lasts when the frame does not say.
const DEFAULT_TYPING_TTL_MS: u64 = 6000;

/// The longest a typing hint is believed, whatever the frame says.
const MAX_TYPING_TTL_MS: u64 = 30_000;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// `chat.read`, and the `chat:read` event it becomes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMark {
    pub conversation_id: String,
    pub user_id: String,
    pub seq: u64,
}

/// `chat.typing` as the service sends it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingHint {
    pub conversation_id: String,
    pub user_id: String,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
}

/// The `chat:typing` event: everybody typing in one conversation now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingNow {
    pub conversation_id: String,
    pub user_ids: Vec<String>,
}

/// `chat.reaction`, and the `chat:reaction` event it becomes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionChange {
    pub conversation_id: String,
    pub seq: u64,
    pub user_id: String,
    pub emoji: String,
    pub on: bool,
}

/// `chat.conversation.removed`, and the `chat:removed` event it becomes.
/// `reason` is `left`, `removed`, `ended` or `account_deleted`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub conversation_id: String,
    #[serde(default)]
    pub reason: String,
}

/// The `chat:draft` event.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftChange {
    pub conversation_id: String,
    pub text: String,
}

/// One frame, parsed.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Message(Box<ChatMessage>),
    Read(ReadMark),
    Typing(TypingHint),
    Reaction(ReactionChange),
    Conversation(Box<Conversation>),
    Removed(Removal),
    GroupInvite(GroupInvite),
    GroupInviteRemoved(String),
    Settings(ChatPrivacy),
    Resync,
    Unknown(String),
}

/// Reads one frame. The payload of an unknown kind is not looked at.
pub fn parse(kind: &str, payload: Value) -> Result<Frame, serde_json::Error> {
    #[derive(Deserialize)]
    struct MessagePayload {
        message: ChatMessage,
    }
    #[derive(Deserialize)]
    struct ConversationPayload {
        conversation: Conversation,
    }
    #[derive(Deserialize)]
    struct InvitePayload {
        invite: GroupInvite,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct InviteRemovedPayload {
        conversation_id: String,
    }
    #[derive(Deserialize)]
    struct SettingsPayload {
        settings: ChatPrivacy,
    }

    Ok(match kind {
        "chat.message" => {
            Frame::Message(Box::new(serde_json::from_value::<MessagePayload>(payload)?.message))
        }
        "chat.read" => Frame::Read(serde_json::from_value(payload)?),
        "chat.typing" => Frame::Typing(serde_json::from_value(payload)?),
        "chat.reaction" => Frame::Reaction(serde_json::from_value(payload)?),
        "chat.conversation" => Frame::Conversation(Box::new(
            serde_json::from_value::<ConversationPayload>(payload)?.conversation,
        )),
        "chat.conversation.removed" => Frame::Removed(serde_json::from_value(payload)?),
        "chat.groupInvite" => {
            Frame::GroupInvite(serde_json::from_value::<InvitePayload>(payload)?.invite)
        }
        "chat.groupInvite.removed" => Frame::GroupInviteRemoved(
            serde_json::from_value::<InviteRemovedPayload>(payload)?.conversation_id,
        ),
        "chat.settings" => {
            Frame::Settings(serde_json::from_value::<SettingsPayload>(payload)?.settings)
        }
        "chat.resync" => Frame::Resync,
        other => Frame::Unknown(other.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/// What a frame asks for after it moved the state.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Emit one event to every window.
    Emit { event: &'static str, payload: Value },
    /// The summaries moved: `chat:state`, debounced.
    State,
    /// The queue of one conversation moved: `chat:outbox`.
    Outbox(String),
    /// A window shows this conversation: read it up to its last message.
    MarkRead(String),
    /// Fetch one conversation the book does not know or cannot count.
    Refresh(String),
    /// Read the whole sync document again.
    Resync,
    /// Emit `chat:typing` again for this conversation once the hint ran out.
    TypingExpires { conversation_id: String, after: Duration },
}

fn emit_effect<T: Serialize>(event: &'static str, payload: &T) -> Effect {
    Effect::Emit {
        event,
        payload: serde_json::to_value(payload).unwrap_or(Value::Null),
    }
}

/// Applies one frame to the state of chat. `me` is the signed-in account;
/// `now` is the clock the typing hints expire by.
pub fn apply(chat: &ChatState, me: Option<&str>, frame: Frame, now: Instant) -> Vec<Effect> {
    let mut effects = Vec::new();
    match frame {
        Frame::Message(message) => {
            let conversation_id = message.conversation_id.clone();
            let viewed = chat.is_viewed(&conversation_id);
            let applied = chat.book().apply_message(me, &message, viewed);
            // The service sends a message to every device of its sender, and
            // that is how an entry whose answer was lost still leaves the
            // queue.
            if message.is_from(me) {
                if let Some(client_id) = message.client_id.as_deref() {
                    if chat.outbox().matched(client_id).is_some() {
                        effects.push(Effect::Outbox(conversation_id.clone()));
                    }
                }
            }
            if !applied.known {
                effects.push(Effect::Refresh(conversation_id.clone()));
            }
            if applied.fresh {
                effects.push(Effect::State);
                if viewed && !message.is_from(me) {
                    effects.push(Effect::MarkRead(conversation_id.clone()));
                }
            }
            if applied.typing_stopped {
                let user_ids = chat.book().typing_in(&conversation_id, now);
                effects.push(emit_effect(
                    super::EVENT_TYPING,
                    &TypingNow { conversation_id, user_ids },
                ));
            }
            effects.insert(0, emit_effect(EVENT_MESSAGE, &*message));
        }
        Frame::Read(mark) => {
            let (known, refresh) = chat.book().apply_read(me, &mark);
            if known {
                effects.push(Effect::State);
            }
            if refresh {
                effects.push(Effect::Refresh(mark.conversation_id.clone()));
            }
            effects.insert(0, emit_effect(EVENT_READ, &mark));
        }
        Frame::Typing(hint) => {
            // The service never echoes the player's own hint; a second device
            // of the same account is still the player. A player who hides
            // typing sees nobody typing (D8): the service enforces it, and a
            // hint that slips through a settings change is dropped here.
            if me == Some(hint.user_id.as_str()) || !chat.book().shares_typing() {
                return effects;
            }
            let ttl = Duration::from_millis(
                hint.ttl_ms
                    .unwrap_or(DEFAULT_TYPING_TTL_MS)
                    .min(MAX_TYPING_TTL_MS),
            );
            let user_ids = {
                let mut book = chat.book();
                book.set_typing(&hint.conversation_id, &hint.user_id, now + ttl);
                book.typing_in(&hint.conversation_id, now)
            };
            effects.push(emit_effect(
                EVENT_TYPING,
                &TypingNow {
                    conversation_id: hint.conversation_id.clone(),
                    user_ids,
                },
            ));
            effects.push(Effect::TypingExpires {
                conversation_id: hint.conversation_id,
                after: ttl,
            });
        }
        Frame::Reaction(change) => {
            if chat.book().apply_reaction(&change) {
                effects.push(Effect::State);
            }
            effects.insert(0, emit_effect(EVENT_REACTION, &change));
        }
        Frame::Conversation(conversation) => {
            chat.book().upsert(*conversation);
            effects.push(Effect::State);
        }
        Frame::Removed(removal) => {
            let id = removal.conversation_id.clone();
            let known = chat.book().remove(&id);
            if chat.outbox().remove_conversation(&id) {
                effects.push(Effect::Outbox(id.clone()));
            }
            chat.drafts().remove(&id);
            lock(&chat.read_pending).remove(&id);
            // Told even when the book did not have it: a window may hold the
            // thread from before the last sync document.
            effects.push(emit_effect(EVENT_REMOVED, &removal));
            if known {
                effects.push(Effect::State);
            }
        }
        Frame::GroupInvite(invite) => {
            chat.book().upsert_invite(invite);
            effects.push(Effect::State);
        }
        Frame::GroupInviteRemoved(conversation_id) => {
            if chat.book().remove_invite(&conversation_id) {
                effects.push(Effect::State);
            }
        }
        Frame::Settings(privacy) => {
            if chat.book().set_privacy(privacy) {
                effects.push(Effect::Resync);
            }
            effects.push(Effect::State);
        }
        Frame::Resync => effects.push(Effect::Resync),
        Frame::Unknown(kind) => log::debug!("live frame {kind} ignored"),
    }
    effects
}

/// Reads one `chat.*` frame of the live socket and does what it says.
pub fn handle(app: &AppHandle, kind: &str, payload: Value) {
    let frame = match parse(kind, payload) {
        Ok(frame) => frame,
        Err(e) => {
            log::debug!("unreadable {kind}: {e}");
            return;
        }
    };
    let me = my_id(app);
    let effects = apply(&app.state::<ChatState>(), me.as_deref(), frame, Instant::now());
    run(app, effects);
}

/// Carries out what [`apply`] asked for.
pub(super) fn run(app: &AppHandle, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Emit { event, payload } => emit(app, event, payload),
            Effect::State => schedule_state(app),
            Effect::Outbox(conversation_id) => emit_outbox(app, &conversation_id),
            Effect::MarkRead(conversation_id) => sync::queue_read(app, &conversation_id),
            Effect::Refresh(conversation_id) => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    sync::refresh_conversation(&handle, &conversation_id).await;
                });
            }
            Effect::Resync => app.state::<ChatState>().request_resync(),
            Effect::TypingExpires { conversation_id, after } => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    // A little past the hint, so the entry has expired by the
                    // time it is looked at.
                    tokio::time::sleep(after + Duration::from_millis(50)).await;
                    let user_ids = handle
                        .state::<ChatState>()
                        .book()
                        .typing_in(&conversation_id, Instant::now());
                    emit(&handle, EVENT_TYPING, TypingNow { conversation_id, user_ids });
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::outbox::OutboxEntry;
    use super::super::test_support::*;
    use super::super::{SendDraft, Viewing};
    use super::*;
    use crate::online::ChatSyncDoc;

    fn state_with(conversations: Vec<Conversation>) -> ChatState {
        let chat = ChatState::default();
        chat.book().replace(ChatSyncDoc {
            conversations,
            ..ChatSyncDoc::default()
        });
        chat
    }

    fn emitted(effects: &[Effect]) -> Vec<&'static str> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Emit { event, .. } => Some(*event),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn every_kind_of_the_contract_parses_and_an_unknown_one_is_dropped() {
        let message = serde_json::json!({ "message": {
            "conversationId": "c", "seq": 3, "senderId": KYLE, "clientId": null,
            "kind": "user", "body": "gg", "cards": [], "files": [], "mentions": [],
            "replyTo": null, "reactions": [], "system": null, "createdAt": "2026-09-26T10:00:00Z"
        }});
        assert!(matches!(parse("chat.message", message), Ok(Frame::Message(m)) if m.seq == 3));
        let read = serde_json::json!({ "conversationId": "c", "userId": KYLE, "seq": 2 });
        assert!(matches!(parse("chat.read", read), Ok(Frame::Read(r)) if r.seq == 2));
        let typing = serde_json::json!({ "conversationId": "c", "userId": KYLE, "ttlMs": 6000 });
        assert!(matches!(parse("chat.typing", typing), Ok(Frame::Typing(t)) if t.ttl_ms == Some(6000)));
        let reaction = serde_json::json!({
            "conversationId": "c", "seq": 1, "userId": KYLE, "emoji": "👍", "on": true
        });
        assert!(matches!(parse("chat.reaction", reaction), Ok(Frame::Reaction(_))));
        let conversation = serde_json::json!({ "conversation": { "id": "c", "kind": "group" } });
        assert!(matches!(
            parse("chat.conversation", conversation),
            Ok(Frame::Conversation(c)) if c.kind == "group" && c.notify == "all" && !c.can_send
        ));
        let removed = serde_json::json!({ "conversationId": "c", "reason": "ended" });
        assert!(matches!(
            parse("chat.conversation.removed", removed),
            Ok(Frame::Removed(r)) if r.reason == "ended"
        ));
        let invite = serde_json::json!({ "invite": {
            "conversationId": "g", "title": "Saber school", "invitedBy": user(KYLE),
            "memberCount": 3, "createdAt": "", "expiresAt": ""
        }});
        assert!(matches!(parse("chat.groupInvite", invite), Ok(Frame::GroupInvite(_))));
        let gone = serde_json::json!({ "conversationId": "g" });
        assert!(matches!(
            parse("chat.groupInvite.removed", gone),
            Ok(Frame::GroupInviteRemoved(id)) if id == "g"
        ));
        let settings = serde_json::json!({ "settings": { "shareReadReceipts": false } });
        assert!(matches!(
            parse("chat.settings", settings),
            Ok(Frame::Settings(s)) if !s.share_read_receipts && s.share_typing
        ));
        assert_eq!(parse("chat.resync", serde_json::json!({})).ok(), Some(Frame::Resync));
        assert_eq!(
            parse("chat.somethingNew", serde_json::json!({ "x": 1 })).ok(),
            Some(Frame::Unknown("chat.somethingNew".into()))
        );
        // A known kind with a broken payload is an error, not a panic.
        assert!(parse("chat.read", serde_json::json!({ "seq": "x" })).is_err());
    }

    #[test]
    fn a_message_frame_moves_the_summary_and_is_emitted_first() {
        let chat = state_with(vec![conversation("c", 2, 2)]);
        let effects = apply(
            &chat,
            Some(ME),
            Frame::Message(Box::new(message("c", 3, Some(KYLE)))),
            Instant::now(),
        );
        assert_eq!(emitted(&effects), [EVENT_MESSAGE]);
        assert!(matches!(effects[0], Effect::Emit { event: EVENT_MESSAGE, .. }));
        assert!(effects.contains(&Effect::State));
        assert_eq!(chat.book().get("c").map(|c| c.unread), Some(1));
    }

    #[test]
    fn a_message_of_a_viewed_conversation_is_read_at_once() {
        let chat = state_with(vec![conversation("c", 2, 2)]);
        lock(&chat.viewing).insert(
            "main".into(),
            Viewing {
                conversation_id: Some("c".into()),
                focused: true,
                at_bottom: true,
                composer: true,
            },
        );
        let effects = apply(
            &chat,
            Some(ME),
            Frame::Message(Box::new(message("c", 3, Some(KYLE)))),
            Instant::now(),
        );
        assert!(effects.contains(&Effect::MarkRead("c".into())));
        assert_eq!(chat.book().get("c").map(|c| c.unread), Some(0));
    }

    #[test]
    fn an_own_message_settles_its_outbox_entry_by_client_id() {
        let chat = state_with(vec![conversation("c", 2, 2)]);
        chat.outbox().push(OutboxEntry::new(
            "01J0CLIENT",
            "c",
            SendDraft { body: "gg".into(), ..SendDraft::default() },
        ));
        let mut own = message("c", 3, Some(ME));
        own.client_id = Some("01J0CLIENT".into());
        let effects = apply(&chat, Some(ME), Frame::Message(Box::new(own)), Instant::now());
        assert!(effects.contains(&Effect::Outbox("c".into())));
        assert!(chat.outbox().all().is_empty());

        // Somebody else's message with the same client id is not ours.
        chat.outbox().push(OutboxEntry::new(
            "01J0OTHER",
            "c",
            SendDraft { body: "gg".into(), ..SendDraft::default() },
        ));
        let mut theirs = message("c", 4, Some(KYLE));
        theirs.client_id = Some("01J0OTHER".into());
        apply(&chat, Some(ME), Frame::Message(Box::new(theirs)), Instant::now());
        assert_eq!(chat.outbox().all().len(), 1);
    }

    #[test]
    fn a_message_of_an_unknown_conversation_fetches_it() {
        let chat = state_with(Vec::new());
        let effects = apply(
            &chat,
            Some(ME),
            Frame::Message(Box::new(message("new", 1, Some(KYLE)))),
            Instant::now(),
        );
        assert!(effects.contains(&Effect::Refresh("new".into())));
        // The window still hears about the message.
        assert_eq!(emitted(&effects), [EVENT_MESSAGE]);
    }

    #[test]
    fn a_read_frame_is_emitted_and_a_partial_own_read_refreshes() {
        let chat = state_with(vec![conversation("c", 10, 2)]);
        chat.book().summaries.get_mut("c").expect("known").unread = 8;
        let mark = ReadMark { conversation_id: "c".into(), user_id: ME.into(), seq: 5 };
        let effects = apply(&chat, Some(ME), Frame::Read(mark), Instant::now());
        assert_eq!(emitted(&effects), [EVENT_READ]);
        assert!(effects.contains(&Effect::Refresh("c".into())));
    }

    #[test]
    fn typing_is_emitted_with_everybody_typing_and_expires() {
        let chat = state_with(vec![conversation("c", 0, 0)]);
        let hint = TypingHint {
            conversation_id: "c".into(),
            user_id: KYLE.into(),
            ttl_ms: Some(6000),
        };
        let now = Instant::now();
        let effects = apply(&chat, Some(ME), Frame::Typing(hint.clone()), now);
        match &effects[0] {
            Effect::Emit { event, payload } => {
                assert_eq!(*event, EVENT_TYPING);
                assert_eq!(payload["userIds"], serde_json::json!([KYLE]));
            }
            other => panic!("expected chat:typing, got {other:?}"),
        }
        assert!(effects.contains(&Effect::TypingExpires {
            conversation_id: "c".into(),
            after: Duration::from_secs(6),
        }));
        // The player's own hint from another device is not "somebody typing".
        let own = TypingHint { user_id: ME.into(), ..hint.clone() };
        assert!(apply(&chat, Some(ME), Frame::Typing(own), now).is_empty());
        // Hiding typing hides everybody's (D8).
        chat.book().set_privacy(ChatPrivacy { share_typing: false, ..ChatPrivacy::default() });
        assert!(apply(&chat, Some(ME), Frame::Typing(hint), now).is_empty());
    }

    #[test]
    fn a_removed_conversation_takes_its_queue_and_draft_along() {
        let chat = state_with(vec![conversation("c", 1, 1)]);
        chat.outbox().push(OutboxEntry::new(
            "01J0CLIENT",
            "c",
            SendDraft { body: "gg".into(), ..SendDraft::default() },
        ));
        chat.drafts().insert("c".into(), "draft".into());
        let effects = apply(
            &chat,
            Some(ME),
            Frame::Removed(Removal { conversation_id: "c".into(), reason: "ended".into() }),
            Instant::now(),
        );
        assert_eq!(emitted(&effects), [EVENT_REMOVED]);
        assert!(effects.contains(&Effect::Outbox("c".into())));
        assert!(chat.book().get("c").is_none());
        assert!(chat.outbox().all().is_empty());
        assert!(chat.drafts().is_empty());
    }

    #[test]
    fn settings_that_flip_read_receipts_resync() {
        let chat = state_with(Vec::new());
        let hidden = ChatPrivacy { share_read_receipts: false, ..ChatPrivacy::default() };
        let effects = apply(&chat, Some(ME), Frame::Settings(hidden), Instant::now());
        assert!(effects.contains(&Effect::Resync));
        assert!(effects.contains(&Effect::State));
        let effects = apply(&chat, Some(ME), Frame::Resync, Instant::now());
        assert_eq!(effects, [Effect::Resync]);
    }

    #[test]
    fn invites_come_and_go() {
        let chat = state_with(Vec::new());
        let invite = GroupInvite {
            conversation_id: "g".into(),
            invited_by: user(KYLE),
            ..GroupInvite::default()
        };
        apply(&chat, Some(ME), Frame::GroupInvite(invite), Instant::now());
        assert_eq!(chat.book().invites.len(), 1);
        let effects = apply(&chat, Some(ME), Frame::GroupInviteRemoved("g".into()), Instant::now());
        assert_eq!(effects, [Effect::State]);
        assert!(chat.book().invites.is_empty());
    }

    #[test]
    fn an_unknown_kind_does_nothing() {
        let chat = state_with(Vec::new());
        assert!(apply(&chat, Some(ME), Frame::Unknown("chat.poll".into()), Instant::now()).is_empty());
    }
}
