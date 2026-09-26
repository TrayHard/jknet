//! Friends chat: direct conversations, groups and the chat of a private
//! server, on top of the chat API of JKNet Online.
//!
//! The service is the truth. On this device the core is the only writer: it
//! keeps a summary of every conversation, queues and retries what the player
//! sends, moves read markers, and decides what a frame of the live socket
//! means. A window displays what the core emits and reports what it shows —
//! which conversation, whether it is focused and scrolled to the bottom — so
//! two windows never send the same read marker or count a message twice.
//!
//! | File        | What it holds                                               |
//! | ----------- | ----------------------------------------------------------- |
//! | `sync.rs`   | the sync document, the connection epoch, resync, the reset of a thread whose `lastSeq` went back, account changes, read markers |
//! | `outbox.rs` | the send queue: uploads, sends, retries                     |
//! | `frames.rs` | the `chat.*` frames of the live socket                      |
//! | `files.rs`  | attachments: staging and metadata strip, upload, the download cache, save, import |
//! | `cards.rs`  | cards: the rules of the service, building, a card as a profile form or a config document, the danger scan of binds and configs |
//! | `links.rs`  | links: which open at once, which ask first, opening in the system browser |
//! | `server.rs` | the chat of a private server: the host opens and closes it, guests join it |
//! | `window.rs` | the separate chat window and its compact mode, where a notification opens a conversation |
//! | `notify.rs` | what a message deserves (toast, Windows notification, sound, the summary after a game) and showing it |
//!
//! Live frames are hints and the REST answers are the truth: a reconnect, a
//! `chat.resync` or a sign-in refetches the whole sync document, and a window
//! that sees a gap in `seq` fetches what is after the last message it has.
//!
//! ## Events
//!
//! | Event         | Payload                                 | When                        |
//! | ------------- | --------------------------------------- | --------------------------- |
//! | `chat:state`  | [`ChatStateView`], at most every 100 ms | any summary, invite or setting moved |
//! | `chat:message`| `Message`                               | a message arrived or was sent |
//! | `chat:read`   | `{conversationId, userId, seq}`         | a read marker moved          |
//! | `chat:reaction`| `{conversationId, seq, userId, emoji, on}` | a reaction changed        |
//! | `chat:typing` | `{conversationId, userIds}`             | who is typing changed        |
//! | `chat:outbox` | `{conversationId, entries}`             | the queue of one conversation changed |
//! | `chat:removed`| `{conversationId, reason}`              | the player is no longer in it |
//! | `chat:resync` | `{reset: conversationId[]}`             | the sync document was read again |
//! | `chat:draft`  | `{conversationId, text}`                | a draft changed              |
//! | `chat:upload` | `{handle, sent, total}`                 | an attachment is going up    |
//! | `chat:download` | `{fileId, received, total, path?, status}` | a file is coming down, arrived (`cached`), failed (`remote`) or is `gone` |
//! | `chat:files-staged` | `{files, refused}`, to the drop window only | files dropped on a composer were staged |
//! | `chat:open`   | `{conversationId}`, to `chat` or `main` | show this conversation, or the list for `null` |
//! | `chat:notify` | `{conversationId, seq, title, text, mention}`, to `main` | a message deserves a toast in the launcher window |
//! | `chat:window` | `{open, compact, alwaysOnTop, opacity}` | the chat window opened, closed or changed mode |
//!
//! A window that receives `chat:resync` drops the threads listed in `reset`
//! (their `lastSeq` went back, which means the service database was
//! restored) and fetches what is after the last message of every other
//! thread it holds.

pub mod cards;
pub mod files;
pub mod frames;
pub mod links;
#[cfg(test)]
mod mock_tests;
pub mod notify;
#[cfg(test)]
mod online_tests;
mod outbox;
pub mod server;
mod sync;
pub mod window;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::error::{AppError, Result};
use crate::friends::FriendsState;
use crate::online::{
    is_chat_unavailable, path_segment, AddResult, ChatMessage, ChatPrivacy, ChatPrivacyPatch,
    ChatQuota, ChatSyncDoc, Conversation, FileMeta, GroupInvite, GroupResult, MessagePage,
    OnlineClient, OnlineContext, PageAnchor, ReactionGroup, SearchPage, SearchQuery,
};
use crate::state::AppState;

use frames::{DraftChange, ReactionChange, ReadMark, Removal};
use outbox::{OutboxEntry, OutboxView};

/// The whole state of chat, debounced.
pub const EVENT_STATE: &str = "chat:state";
/// One message, as the service stored it.
pub const EVENT_MESSAGE: &str = "chat:message";
pub const EVENT_READ: &str = "chat:read";
pub const EVENT_REACTION: &str = "chat:reaction";
pub const EVENT_TYPING: &str = "chat:typing";
pub const EVENT_OUTBOX: &str = "chat:outbox";
pub const EVENT_REMOVED: &str = "chat:removed";
pub const EVENT_RESYNC: &str = "chat:resync";
pub const EVENT_DRAFT: &str = "chat:draft";
pub const EVENT_UPLOAD: &str = "chat:upload";

/// The longest body the launcher sends. The service has the same default
/// limit and is the one that enforces it; refusing here spares a request
/// that would come back `too_long`.
const MAX_BODY_CHARS: usize = 4000;

/// Cards and files one message may carry, as the service counts them.
const MAX_CARDS: usize = cards::CARDS_MAX;
const MAX_ATTACHMENTS: usize = 10;

/// A draft longer than this is a paste accident, not a message.
const MAX_DRAFT_CHARS: usize = 16_000;

/// How often a typing hint for one conversation goes out.
const TYPING_THROTTLE: Duration = Duration::from_secs(3);

/// The service caps `unread` here; the local count follows the same rule so a
/// badge never jumps down when the next sync document arrives.
const UNREAD_CAP: u32 = 100;

/// How long `chat:state` waits for more changes before it goes out.
const STATE_DEBOUNCE: Duration = Duration::from_millis(100);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Everything chat keeps between calls. Memory only: the service holds the
/// history, and a launcher that restarts reads the sync document again.
pub struct ChatState {
    /// `false` after the service answered that it has no chat API.
    available: AtomicBool,
    /// The summaries, the invites, the settings, the quota and who types.
    book: Mutex<Book>,
    /// What each window shows, by window label.
    viewing: Mutex<HashMap<String, Viewing>>,
    /// Unsent text by conversation, shared by every window.
    drafts: Mutex<HashMap<String, String>>,
    outbox: Mutex<outbox::Outbox>,
    /// Files picked for a message and not sent yet, by handle.
    staged: Mutex<HashMap<String, Staged>>,
    /// What messages said about their files, and the downloads.
    files: Mutex<files::FileBook>,
    /// When a typing hint last went out, by conversation.
    typing_sent: Mutex<HashMap<String, Instant>>,
    /// Read markers on their way to the service.
    read_pending: Mutex<sync::ReadMarks>,
    read_flush: AtomicBool,
    state_pending: AtomicBool,
    /// Wakes the sync task for a resync outside the connection epoch.
    wake: Notify,
    /// When the sync document was last read.
    synced_at: Mutex<Option<Instant>>,
    /// The chat of the private server this launcher hosts, and the joins of
    /// friends' servers still trying.
    servers: Mutex<server::ServerChats>,
    /// Messages kept for the summary after a game, and the pace of
    /// notifications and sounds.
    notify: Mutex<notify::NotifyBook>,
}

impl Default for ChatState {
    fn default() -> Self {
        ChatState {
            available: AtomicBool::new(true),
            book: Mutex::new(Book::default()),
            viewing: Mutex::new(HashMap::new()),
            drafts: Mutex::new(HashMap::new()),
            outbox: Mutex::new(outbox::Outbox::default()),
            staged: Mutex::new(HashMap::new()),
            files: Mutex::new(files::FileBook::default()),
            typing_sent: Mutex::new(HashMap::new()),
            read_pending: Mutex::new(sync::ReadMarks::default()),
            read_flush: AtomicBool::new(false),
            state_pending: AtomicBool::new(false),
            wake: Notify::new(),
            synced_at: Mutex::new(None),
            servers: Mutex::new(server::ServerChats::default()),
            notify: Mutex::new(notify::NotifyBook::default()),
        }
    }
}

/// A poisoned lock answers with the value in it: nothing here is half
/// written for long, and a chat that stops because an unrelated thread
/// panicked would be the worse failure. The same rule as `FriendsState`.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl ChatState {
    pub(crate) fn book(&self) -> MutexGuard<'_, Book> {
        lock(&self.book)
    }

    pub(crate) fn outbox(&self) -> MutexGuard<'_, outbox::Outbox> {
        lock(&self.outbox)
    }

    fn staged(&self) -> MutexGuard<'_, HashMap<String, Staged>> {
        lock(&self.staged)
    }

    fn files(&self) -> MutexGuard<'_, files::FileBook> {
        lock(&self.files)
    }

    pub(crate) fn servers(&self) -> MutexGuard<'_, server::ServerChats> {
        lock(&self.servers)
    }

    /// Notes the files of messages on their way to a window, so a save or
    /// an import later knows the name and whether the bytes are a program.
    pub(crate) fn remember_files<'a>(&self, messages: impl IntoIterator<Item = &'a ChatMessage>) {
        self.files().remember_messages(messages);
    }

    /// Whether the window with this label has a composer open: that is
    /// where a file dropped on it goes.
    fn composer_open(&self, label: &str) -> bool {
        lock(&self.viewing)
            .get(label)
            .is_some_and(|viewing| viewing.composer)
    }

    fn drafts(&self) -> MutexGuard<'_, HashMap<String, String>> {
        lock(&self.drafts)
    }

    pub fn available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    /// Records whether the service has a chat API. Answers whether that
    /// changed, which is when the windows hear about it.
    fn set_available(&self, available: bool) -> bool {
        self.available.swap(available, Ordering::Relaxed) != available
    }

    /// Asks the sync task for a fresh sync document.
    pub(crate) fn request_resync(&self) {
        self.wake.notify_one();
    }

    /// Whether a window shows this conversation, is focused and is scrolled
    /// to the bottom: then a new message is read the moment it arrives.
    pub(crate) fn is_viewed(&self, conversation_id: &str) -> bool {
        lock(&self.viewing).values().any(|viewing| viewing.sees(conversation_id))
    }

    /// Forgets everything of the account: summaries, drafts, the queue and
    /// the staged files. Answers the conversations that were known, which
    /// the windows drop.
    pub(crate) fn forget(&self) -> Vec<String> {
        let known = {
            let mut book = self.book();
            let known: Vec<String> = book.summaries.keys().cloned().collect();
            *book = Book::default();
            known
        };
        self.outbox().clear();
        self.drafts().clear();
        self.staged().clear();
        *self.files() = files::FileBook::default();
        lock(&self.typing_sent).clear();
        lock(&self.read_pending).clear();
        *lock(&self.synced_at) = None;
        // A server that keeps running opens a chat of the next account at
        // its next heartbeat.
        *self.servers() = server::ServerChats::default();
        // The next account's summary after a game counts its own messages.
        *lock(&self.notify) = notify::NotifyBook::default();
        self.available.store(true, Ordering::Relaxed);
        known
    }

    /// The document `chat_get_state` answers and `chat:state` carries.
    pub fn view(&self, signed_in: bool, connected: bool) -> ChatStateView {
        let book = self.book();
        let (unread_total, mention_total) = book.totals();
        ChatStateView {
            available: self.available(),
            signed_in,
            connected,
            conversations: book.conversations(),
            group_invites: book.invites.clone(),
            privacy: book.privacy.clone(),
            quota: book.quota.clone(),
            unread_total,
            mention_total,
            outbox: self.outbox().all(),
        }
    }
}

/// What one window shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Viewing {
    conversation_id: Option<String>,
    focused: bool,
    at_bottom: bool,
    /// Whether its composer is open, which is where a dropped file goes.
    composer: bool,
}

impl Viewing {
    fn sees(&self, conversation_id: &str) -> bool {
        self.focused && self.at_bottom && self.conversation_id.as_deref() == Some(conversation_id)
    }
}

/// A file picked for a message: the copy the launcher uploads, and what the
/// service is told about it when it is registered.
///
/// The staging commands of [`files`] fill the map; the outbox reads it, and
/// once the message is sent the copy becomes the cached copy of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Staged {
    /// The stripped copy under `cache\chat\staging\`.
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    /// Lower-case hex SHA-256 of the copy.
    pub sha256: String,
    pub meta: Option<FileMeta>,
}

/// The state of chat as the windows read it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStateView {
    /// `false` when the service has no chat API: the screens say so.
    pub available: bool,
    pub signed_in: bool,
    /// Whether the live socket is up.
    pub connected: bool,
    /// Newest activity first.
    pub conversations: Vec<Conversation>,
    pub group_invites: Vec<GroupInvite>,
    /// `None` until the first sync document.
    pub privacy: Option<ChatPrivacy>,
    pub quota: Option<ChatQuota>,
    /// Unread messages of the conversations that are not muted.
    pub unread_total: u32,
    /// Unread mentions of every conversation, muted ones included.
    pub mention_total: u32,
    /// Every message waiting to go out, in the order it was written.
    pub outbox: Vec<OutboxEntry>,
}

// ---------------------------------------------------------------------------
// The book: summaries and what frames do to them
// ---------------------------------------------------------------------------

/// What the core knows about the conversations of the account. Pure data
/// with the rules that move it, so the rules are tested without a window.
#[derive(Debug, Default)]
pub(crate) struct Book {
    pub summaries: BTreeMap<String, Conversation>,
    pub invites: Vec<GroupInvite>,
    pub privacy: Option<ChatPrivacy>,
    pub quota: Option<ChatQuota>,
    /// Who is typing in which conversation, until when.
    typing: HashMap<String, HashMap<String, Instant>>,
}

/// What a message did to the book.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct MessageApplied {
    /// The conversation is in the book. A message of an unknown one means a
    /// conversation to fetch.
    pub known: bool,
    /// The message is newer than the summary. A replayed or old one moves
    /// nothing.
    pub fresh: bool,
    /// Its sender was typing there, and is not any more.
    pub typing_stopped: bool,
}

impl Book {
    /// Replaces everything with a fresh sync document, and answers the
    /// conversations whose `lastSeq` went back: the service database was
    /// restored, and the windows must drop what they hold of those threads.
    pub fn replace(&mut self, doc: ChatSyncDoc) -> Vec<String> {
        let mut reset = Vec::new();
        let mut summaries = BTreeMap::new();
        for conversation in doc.conversations {
            if let Some(previous) = self.summaries.get(&conversation.id) {
                if conversation.last_seq < previous.last_seq {
                    reset.push(conversation.id.clone());
                }
            }
            summaries.insert(conversation.id.clone(), conversation);
        }
        self.typing.retain(|id, _| summaries.contains_key(id));
        self.summaries = summaries;
        self.invites = doc.group_invites;
        self.privacy = Some(doc.settings);
        self.quota = Some(doc.quota);
        reset
    }

    pub fn get(&self, id: &str) -> Option<&Conversation> {
        self.summaries.get(id)
    }

    /// Takes a conversation the service answered or pushed.
    pub fn upsert(&mut self, conversation: Conversation) {
        self.invites.retain(|invite| invite.conversation_id != conversation.id);
        self.summaries.insert(conversation.id.clone(), conversation);
    }

    /// Drops a conversation. Answers whether it was there.
    pub fn remove(&mut self, id: &str) -> bool {
        self.typing.remove(id);
        self.summaries.remove(id).is_some()
    }

    /// Moves a summary for a message that arrived or was sent.
    ///
    /// `viewed` means a window shows the conversation at its bottom, so the
    /// message is read rather than unread. A message of `me` moves the read
    /// marker to itself, as the service does for the sender. A deleted
    /// account's message has no sender and counts as unread like any other.
    pub fn apply_message(
        &mut self,
        me: Option<&str>,
        message: &ChatMessage,
        viewed: bool,
    ) -> MessageApplied {
        let mut applied = MessageApplied::default();
        if let Some(sender) = message.sender_id.as_deref() {
            applied.typing_stopped = self.stop_typing(&message.conversation_id, sender);
        }
        let Some(summary) = self.summaries.get_mut(&message.conversation_id) else {
            return applied;
        };
        applied.known = true;
        if message.seq <= summary.last_seq {
            return applied;
        }
        applied.fresh = true;
        summary.last_seq = message.seq;
        summary.last_message = Some(message.clone());

        if message.is_from(me) {
            summary.read_seq = summary.read_seq.max(message.seq);
            summary.unread = 0;
            summary.unread_mentions = 0;
            set_member_read(summary, me, message.seq);
        } else if !viewed
            && message.is_user()
            && message.seq > summary.read_seq.max(summary.visible_from_seq)
        {
            summary.unread = (summary.unread + 1).min(UNREAD_CAP);
            if me.is_some_and(|me| message.mentions.iter().any(|id| id == me)) {
                summary.unread_mentions = (summary.unread_mentions + 1).min(UNREAD_CAP);
            }
        }
        applied
    }

    /// Moves a read marker. Answers `(known, refresh)`: `refresh` when the
    /// player's own marker moved short of the last message, which leaves the
    /// unread count unknown until the conversation is fetched again.
    pub fn apply_read(&mut self, me: Option<&str>, mark: &ReadMark) -> (bool, bool) {
        let Some(summary) = self.summaries.get_mut(&mark.conversation_id) else {
            return (false, false);
        };
        if me == Some(mark.user_id.as_str()) {
            summary.read_seq = summary.read_seq.max(mark.seq);
            set_member_read(summary, me, summary.read_seq);
            if summary.read_seq >= summary.last_seq {
                summary.unread = 0;
                summary.unread_mentions = 0;
                return (true, false);
            }
            return (true, summary.unread > 0 || summary.unread_mentions > 0);
        }
        set_member_read(summary, Some(&mark.user_id), mark.seq);
        (true, false)
    }

    /// Marks a conversation read up to `seq` on this side, ahead of the
    /// service's answer. Answers whether anything moved.
    pub fn read_locally(&mut self, me: Option<&str>, conversation_id: &str, seq: u64) -> bool {
        let Some(summary) = self.summaries.get_mut(conversation_id) else {
            return false;
        };
        if seq <= summary.read_seq && summary.unread == 0 && summary.unread_mentions == 0 {
            return false;
        }
        summary.read_seq = summary.read_seq.max(seq);
        set_member_read(summary, me, summary.read_seq);
        if summary.read_seq >= summary.last_seq {
            summary.unread = 0;
            summary.unread_mentions = 0;
        }
        true
    }

    /// Applies one reaction to the last message of a summary, when that is
    /// the message it is about. Answers whether the summary changed.
    pub fn apply_reaction(&mut self, change: &ReactionChange) -> bool {
        let Some(message) = self
            .summaries
            .get_mut(&change.conversation_id)
            .and_then(|summary| summary.last_message.as_mut())
            .filter(|message| message.seq == change.seq)
        else {
            return false;
        };
        toggle_reaction(&mut message.reactions, &change.user_id, &change.emoji, change.on)
    }

    /// Puts the reactions a command answered on the last message, when that
    /// is the one they belong to.
    pub fn set_reactions(&mut self, conversation_id: &str, seq: u64, reactions: &[ReactionGroup]) {
        if let Some(message) = self
            .summaries
            .get_mut(conversation_id)
            .and_then(|summary| summary.last_message.as_mut())
            .filter(|message| message.seq == seq)
        {
            message.reactions = reactions.to_vec();
        }
    }

    pub fn set_typing(&mut self, conversation_id: &str, user_id: &str, until: Instant) {
        self.typing
            .entry(conversation_id.to_string())
            .or_default()
            .insert(user_id.to_string(), until);
    }

    fn stop_typing(&mut self, conversation_id: &str, user_id: &str) -> bool {
        self.typing
            .get_mut(conversation_id)
            .is_some_and(|users| users.remove(user_id).is_some())
    }

    /// Who is typing in a conversation at `now`, the expired hints dropped.
    pub fn typing_in(&mut self, conversation_id: &str, now: Instant) -> Vec<String> {
        let Some(users) = self.typing.get_mut(conversation_id) else {
            return Vec::new();
        };
        users.retain(|_, until| *until > now);
        let mut ids: Vec<String> = users.keys().cloned().collect();
        ids.sort();
        if users.is_empty() {
            self.typing.remove(conversation_id);
        }
        ids
    }

    pub fn upsert_invite(&mut self, invite: GroupInvite) {
        self.invites
            .retain(|known| known.conversation_id != invite.conversation_id);
        self.invites.push(invite);
        self.invites.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    }

    pub fn remove_invite(&mut self, conversation_id: &str) -> bool {
        let before = self.invites.len();
        self.invites
            .retain(|invite| invite.conversation_id != conversation_id);
        before != self.invites.len()
    }

    /// Takes the settings the service answered. Answers whether the read
    /// receipts switch flipped: other members' markers then appear or
    /// disappear, and only a fresh sync document carries them (D8).
    pub fn set_privacy(&mut self, privacy: ChatPrivacy) -> bool {
        let flipped = self
            .privacy
            .as_ref()
            .is_some_and(|known| known.share_read_receipts != privacy.share_read_receipts);
        self.privacy = Some(privacy);
        flipped
    }

    /// Whether typing hints may go out. Unknown settings read as the
    /// defaults, which share.
    pub fn shares_typing(&self) -> bool {
        self.privacy.as_ref().is_none_or(|privacy| privacy.share_typing)
    }

    /// Whether a typing hint for this conversation may go out: the player
    /// shares typing and may write there. The composer of a read-only
    /// conversation is gone, and this holds when a call comes anyway.
    pub fn may_type(&self, conversation_id: &str) -> bool {
        self.shares_typing()
            && self
                .summaries
                .get(conversation_id)
                .is_some_and(|summary| summary.can_send)
    }

    /// The summaries, newest activity first.
    pub fn conversations(&self) -> Vec<Conversation> {
        let mut list: Vec<Conversation> = self.summaries.values().cloned().collect();
        list.sort_by(|a, b| {
            activity(b)
                .cmp(activity(a))
                .then_with(|| b.id.cmp(&a.id))
        });
        list
    }

    /// `(unread, mentions)`: unread without the muted conversations, and
    /// mentions of every conversation, muted ones included.
    pub fn totals(&self) -> (u32, u32) {
        self.summaries.values().fold((0, 0), |(unread, mentions), summary| {
            let muted = summary.notify == "mute";
            (
                unread + if muted { 0 } else { summary.unread },
                mentions + summary.unread_mentions,
            )
        })
    }
}

/// When a conversation last moved, for the order of the list.
fn activity(conversation: &Conversation) -> &str {
    conversation
        .last_message
        .as_ref()
        .map(|message| message.created_at.as_str())
        .filter(|at| !at.is_empty())
        .unwrap_or(conversation.created_at.as_str())
}

/// Moves the marker of one member forward.
fn set_member_read(summary: &mut Conversation, user_id: Option<&str>, seq: u64) {
    let Some(user_id) = user_id else {
        return;
    };
    if let Some(member) = summary
        .members
        .iter_mut()
        .find(|member| member.user.id == user_id)
    {
        member.read_seq = Some(member.read_seq.unwrap_or(0).max(seq));
    }
}

/// Adds or takes back one user's emoji. Answers whether anything changed.
fn toggle_reaction(groups: &mut Vec<ReactionGroup>, user_id: &str, emoji: &str, on: bool) -> bool {
    let position = groups.iter().position(|group| group.emoji == emoji);
    if on {
        match position {
            Some(index) if groups[index].user_ids.iter().any(|id| id == user_id) => false,
            Some(index) => {
                groups[index].user_ids.push(user_id.to_string());
                true
            }
            None => {
                groups.push(ReactionGroup {
                    emoji: emoji.to_string(),
                    user_ids: vec![user_id.to_string()],
                });
                true
            }
        }
    } else {
        let Some(index) = position else {
            return false;
        };
        let before = groups[index].user_ids.len();
        groups[index].user_ids.retain(|id| id != user_id);
        let changed = before != groups[index].user_ids.len();
        if groups[index].user_ids.is_empty() {
            groups.remove(index);
        }
        changed
    }
}

// ---------------------------------------------------------------------------
// Startup and shared pieces
// ---------------------------------------------------------------------------

/// Starts the sync task and opens the download cache to the asset protocol.
/// Called once from `setup`, next to `friends::start`.
pub fn start(app: &AppHandle) {
    files::start(app);
    sync::start(app);
    // --- slice: chat notifications ---
    // The summary of the messages a game held back goes out when it exits.
    notify::start(app);
}

/// The live socket came up or went down: `connected` of `chat:state` moved.
pub fn connection_changed(app: &AppHandle) {
    if app.try_state::<ChatState>().is_some() {
        schedule_state(app);
    }
}

/// Forgets what a closed window showed, so a conversation it left open does
/// not stay "viewed" and swallow the unread count.
pub fn forget_window(app: &AppHandle, label: &str) {
    if let Some(chat) = app.try_state::<ChatState>() {
        lock(&chat.viewing).remove(label);
    }
}

/// A new client id: a ULID, 48 bits of milliseconds and 80 random bits in
/// Crockford's base 32, the form the service expects.
pub(crate) fn new_client_id() -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
        & ((1u64 << 48) - 1);
    let mut random = [0u8; 16];
    if getrandom::fill(&mut random[6..]).is_err() {
        // No system randomness: the hasher's keys are random per process,
        // and the counter keeps two ids of the same millisecond apart.
        use std::hash::{BuildHasher, Hasher};
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        random[8..].copy_from_slice(&hasher.finish().to_be_bytes());
    }
    let value = (u128::from(millis) << 80) | (u128::from_be_bytes(random) & ((1u128 << 80) - 1));
    (0..26)
        .map(|index| ALPHABET[((value >> (125 - 5 * index)) & 0x1f) as usize] as char)
        .collect()
}

/// Emits and swallows the failure, like the live socket does: `emit` fails
/// only for a window that has gone.
pub(crate) fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    if let Err(e) = app.emit(event, payload) {
        log::debug!("cannot emit {event}: {e}");
    }
}

/// The document of `chat:state` and `chat_get_state` right now.
fn current_view(app: &AppHandle) -> ChatStateView {
    let signed_in = app
        .state::<AppState>()
        .settings()
        .map(|settings| OnlineContext::from_settings(&settings).signed_in())
        .unwrap_or(false);
    let connected = app.state::<FriendsState>().live();
    app.state::<ChatState>().view(signed_in, connected)
}

/// Emits `chat:state` at most every [`STATE_DEBOUNCE`]: a burst of frames is
/// one repaint.
pub(crate) fn schedule_state(app: &AppHandle) {
    let chat = app.state::<ChatState>();
    if chat.state_pending.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STATE_DEBOUNCE).await;
        handle
            .state::<ChatState>()
            .state_pending
            .store(false, Ordering::Release);
        publish_state(&handle, current_view(&handle));
    });
}

/// Emits `chat:state` now, for the answer of a resync that the windows wait
/// for before they act on `chat:resync`.
pub(crate) fn emit_state_now(app: &AppHandle) {
    publish_state(app, current_view(app));
}

/// Sends the state to the windows and its unread counts to the tray icon.
fn publish_state(app: &AppHandle, view: ChatStateView) {
    // --- slice: chat notifications ---
    // The badge of the tray icon; its menu and tooltip carry the words the
    // main window sends, counts included.
    crate::tray::set_unread(app, view.unread_total > 0 || view.mention_total > 0);
    emit(app, EVENT_STATE, view);
}

/// Emits the queue of one conversation.
pub(crate) fn emit_outbox(app: &AppHandle, conversation_id: &str) {
    let entries = app.state::<ChatState>().outbox().entries_of(conversation_id);
    emit(
        app,
        EVENT_OUTBOX,
        OutboxView {
            conversation_id: conversation_id.to_string(),
            entries,
        },
    );
}

/// The id of the signed-in account, as the settings cache it.
pub(crate) fn my_id(app: &AppHandle) -> Option<String> {
    app.state::<AppState>()
        .settings()
        .ok()
        .and_then(|settings| settings.online_user)
        .map(|user| user.id)
}

/// Where to call and who to call as, or the refusal that names the cure:
/// the same two refusals as the commands of friends.
pub(crate) fn account(app: &AppHandle) -> Result<OnlineContext> {
    let ctx = OnlineContext::from_settings(&app.state::<AppState>().settings()?);
    if !ctx.configured() {
        return Err(AppError::OnlineNotConfigured);
    }
    if !ctx.signed_in() {
        return Err(AppError::SignedOut);
    }
    Ok(ctx)
}

/// Passes the answer of a chat call through, noting on the way whether the
/// service has a chat API at all.
pub(crate) fn noted<T>(app: &AppHandle, result: Result<T>) -> Result<T> {
    let chat = app.state::<ChatState>();
    let changed = match &result {
        Ok(_) => chat.set_available(true),
        Err(e) if is_chat_unavailable(e) => chat.set_available(false),
        Err(_) => false,
    };
    if changed {
        schedule_state(app);
    }
    result
}

/// Takes a conversation a command answered into the book.
fn keep(app: &AppHandle, conversation: &Conversation) {
    app.state::<ChatState>().book().upsert(conversation.clone());
    schedule_state(app);
}

/// Drops a conversation the player left, and tells the windows.
fn drop_conversation(app: &AppHandle, conversation_id: &str, reason: &str) {
    let chat = app.state::<ChatState>();
    let known = chat.book().remove(conversation_id);
    let queued = chat.outbox().remove_conversation(conversation_id);
    chat.drafts().remove(conversation_id);
    lock(&chat.read_pending).remove(conversation_id);
    chat.servers().removed(conversation_id, reason);
    if queued {
        emit_outbox(app, conversation_id);
    }
    if known {
        emit(
            app,
            EVENT_REMOVED,
            Removal {
                conversation_id: conversation_id.to_string(),
                reason: reason.to_string(),
            },
        );
        schedule_state(app);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Everything the chat screens draw from, in one answer.
#[tauri::command]
pub async fn chat_get_state(app: AppHandle) -> Result<ChatStateView> {
    Ok(current_view(&app))
}

/// One page of history. `around` wins over `before`, and `before` over
/// `after`; none of them is the newest page.
#[tauri::command]
pub async fn chat_get_messages(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    before: Option<u64>,
    after: Option<u64>,
    around: Option<u64>,
    limit: Option<u32>,
) -> Result<MessagePage> {
    let ctx = account(&app)?;
    let anchor = match (around, before, after) {
        (Some(seq), _, _) => PageAnchor::Around(seq),
        (None, Some(seq), _) => PageAnchor::Before(seq),
        (None, None, Some(seq)) => PageAnchor::After(seq),
        (None, None, None) => PageAnchor::Latest,
    };
    let page = noted(
        &app,
        online
            .chat_messages(&ctx, &conversation_id, anchor, limit)
            .await,
    )?;
    app.state::<ChatState>().remember_files(&page.messages);
    Ok(page)
}

/// The direct conversation with a friend, made on first use.
#[tauri::command]
pub async fn chat_open_direct(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    user_id: String,
) -> Result<Conversation> {
    let ctx = account(&app)?;
    let conversation = noted(&app, online.chat_open_direct(&ctx, &user_id).await)?;
    keep(&app, &conversation);
    Ok(conversation)
}

/// What the composer hands the core.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendDraft {
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub cards: Vec<Value>,
    /// Handles of staged files.
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub reply_seq: Option<u64>,
}

/// Queues a message and answers its client id at once. The outbox uploads
/// the attachments and sends it; `chat:outbox` follows every step, and the
/// message itself arrives as `chat:message`.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    conversation_id: String,
    draft: SendDraft,
) -> Result<String> {
    account(&app)?;
    let conversation_id = path_segment(&conversation_id)?.to_string();
    let draft = check_draft(draft)?;
    let client_id = new_client_id();
    let chat = app.state::<ChatState>();
    chat.outbox()
        .push(OutboxEntry::new(&client_id, &conversation_id, draft));
    // The text is on its way, so the draft of the conversation is spent.
    if chat.drafts().remove(&conversation_id).is_some() {
        emit(
            &app,
            EVENT_DRAFT,
            DraftChange {
                conversation_id: conversation_id.clone(),
                text: String::new(),
            },
        );
    }
    emit_outbox(&app, &conversation_id);
    schedule_state(&app);
    outbox::kick(&app);
    Ok(client_id)
}

/// The refusals a send would meet on the service, answered before it is
/// queued. Answers the draft with its cards cleaned and completed the way
/// the service reads them (`cards::prepare`); a card the service would
/// refuse is refused here as `online` with `details.code` `card`.
fn check_draft(mut draft: SendDraft) -> Result<SendDraft> {
    if draft.body.trim().is_empty() && draft.cards.is_empty() && draft.attachments.is_empty() {
        return Err(AppError::InvalidInput("an empty message".into()));
    }
    let length = draft.body.chars().count();
    if length > MAX_BODY_CHARS {
        return Err(AppError::InvalidInput(format!(
            "a message is at most {MAX_BODY_CHARS} characters, this one is {length}"
        )));
    }
    if draft.cards.len() > MAX_CARDS {
        return Err(AppError::InvalidInput(format!(
            "a message carries at most {MAX_CARDS} cards"
        )));
    }
    if draft.attachments.len() > MAX_ATTACHMENTS {
        return Err(AppError::InvalidInput(format!(
            "a message carries at most {MAX_ATTACHMENTS} files"
        )));
    }
    draft.cards = cards::prepare(&draft.cards)?;
    Ok(draft)
}

/// Sends a failed message again, with the same client id.
#[tauri::command]
pub async fn chat_retry(app: AppHandle, client_id: String) -> Result<()> {
    let conversation = app.state::<ChatState>().outbox().retry(&client_id);
    let conversation =
        conversation.ok_or_else(|| AppError::NotFound(format!("queued message {client_id}")))?;
    emit_outbox(&app, &conversation);
    schedule_state(&app);
    outbox::kick(&app);
    Ok(())
}

/// Drops a queued or failed message. A message already on its way may still
/// arrive; the queue simply stops waiting for it.
#[tauri::command]
pub async fn chat_discard(app: AppHandle, client_id: String) -> Result<()> {
    let entry = app.state::<ChatState>().outbox().discard(&client_id);
    if let Some(entry) = entry {
        files::drop_staged(&app, &entry.attachments);
        emit_outbox(&app, &entry.conversation_id);
        schedule_state(&app);
    }
    Ok(())
}

/// A window says what it shows. A conversation shown in a focused window at
/// its bottom is read up to its last message.
#[tauri::command]
pub async fn chat_set_viewing(
    app: AppHandle,
    window: tauri::Window,
    conversation_id: Option<String>,
    focused: bool,
    at_bottom: bool,
    composer: bool,
) -> Result<()> {
    let viewing = Viewing {
        conversation_id: conversation_id.filter(|id| !id.trim().is_empty()),
        focused,
        at_bottom,
        composer,
    };
    let read = viewing
        .conversation_id
        .clone()
        .filter(|id| viewing.sees(id));
    lock(&app.state::<ChatState>().viewing).insert(window.label().to_string(), viewing);
    if let Some(conversation_id) = read {
        sync::queue_read(&app, &conversation_id);
    }
    Ok(())
}

/// Marks a conversation read up to its last message.
#[tauri::command]
pub async fn chat_mark_read(app: AppHandle, conversation_id: String) -> Result<()> {
    sync::queue_read(&app, &conversation_id);
    Ok(())
}

/// Tells the other members the player is typing: at most once every 3 s per
/// conversation, never while the player hides typing (D8), and never where
/// the player cannot write (a direct conversation with a former friend, D2).
/// A hint with no socket to carry it is dropped.
#[tauri::command]
pub async fn chat_typing(
    app: AppHandle,
    friends: tauri::State<'_, FriendsState>,
    conversation_id: String,
) -> Result<()> {
    let conversation_id = path_segment(&conversation_id)?.to_string();
    let chat = app.state::<ChatState>();
    if !chat.book().may_type(&conversation_id) {
        return Ok(());
    }
    let now = Instant::now();
    {
        let mut sent = lock(&chat.typing_sent);
        if sent
            .get(&conversation_id)
            .is_some_and(|at| now.duration_since(*at) < TYPING_THROTTLE)
        {
            return Ok(());
        }
        sent.insert(conversation_id.clone(), now);
    }
    friends.send_frame(typing_frame(&conversation_id));
    Ok(())
}

/// The frame of a typing hint, as the socket carries it to the service.
pub(crate) fn typing_frame(conversation_id: &str) -> String {
    serde_json::json!({
        "type": "chat.typing",
        "payload": { "conversationId": conversation_id },
    })
    .to_string()
}

/// Adds or takes back a reaction; answers the reactions of the message.
#[tauri::command]
pub async fn chat_react(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    seq: u64,
    emoji: String,
    on: bool,
) -> Result<Vec<ReactionGroup>> {
    let ctx = account(&app)?;
    let reactions = noted(
        &app,
        online
            .chat_react(&ctx, &conversation_id, seq, &emoji, on)
            .await,
    )?;
    app.state::<ChatState>()
        .book()
        .set_reactions(&conversation_id, seq, &reactions);
    schedule_state(&app);
    Ok(reactions)
}

/// Makes a group of friends. A blank title leaves the group unnamed.
#[tauri::command]
pub async fn chat_create_group(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    title: Option<String>,
    member_ids: Vec<String>,
) -> Result<GroupResult> {
    let ctx = account(&app)?;
    let title = title.map(|title| title.trim().to_string()).filter(|t| !t.is_empty());
    let client_id = new_client_id();
    let result = noted(
        &app,
        online
            .chat_create_group(&ctx, &client_id, title.as_deref(), &member_ids)
            .await,
    )?;
    keep(&app, &result.conversation);
    Ok(result)
}

/// Renames a group. The owner only: anybody else gets `owner_only` (D5).
#[tauri::command]
pub async fn chat_rename_group(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    title: String,
) -> Result<Conversation> {
    let ctx = account(&app)?;
    let conversation = noted(
        &app,
        online
            .chat_patch_group(&ctx, &conversation_id, Some(title.trim()), None)
            .await,
    )?;
    keep(&app, &conversation);
    Ok(conversation)
}

/// Whether members who join from now on see the history (D1): the owner of a
/// group, or the host of a server chat. Anybody else gets `owner_only`; a
/// guest of a server chat gets it without a request (`server::set_history`).
#[tauri::command]
pub async fn chat_set_history_for_new_members(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    on: bool,
) -> Result<Conversation> {
    let ctx = account(&app)?;
    let known = app
        .state::<ChatState>()
        .book()
        .get(&conversation_id)
        .cloned();
    let summary = match known {
        Some(summary) => summary,
        None => noted(&app, online.chat_conversation(&ctx, &conversation_id).await)?,
    };
    let answer = match (summary.kind.as_str(), summary.server.as_ref()) {
        ("group", _) => {
            online
                .chat_patch_group(&ctx, &conversation_id, None, Some(on))
                .await
        }
        ("server", Some(server)) => {
            return server::set_history(&app, &online, &ctx, server, on).await;
        }
        _ => {
            return Err(AppError::InvalidInput(
                "only a group or a server chat has a history setting".into(),
            ))
        }
    };
    let conversation = noted(&app, answer)?;
    keep(&app, &conversation);
    Ok(conversation)
}

/// Adds friends to a group; the ones who asked to be asked get an invite.
#[tauri::command]
pub async fn chat_add_members(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    user_ids: Vec<String>,
) -> Result<AddResult> {
    let ctx = account(&app)?;
    noted(
        &app,
        online
            .chat_add_members(&ctx, &conversation_id, &user_ids)
            .await,
    )
}

/// Removes a member: the owner of a group or the host of a server chat.
#[tauri::command]
pub async fn chat_remove_member(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    user_id: String,
) -> Result<()> {
    let ctx = account(&app)?;
    noted(
        &app,
        online
            .chat_remove_member(&ctx, &conversation_id, &user_id)
            .await,
    )
}

/// Leaves a group or a server chat.
#[tauri::command]
pub async fn chat_leave(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
) -> Result<()> {
    let ctx = account(&app)?;
    let me = my_id(&app).ok_or(AppError::SignedOut)?;
    noted(
        &app,
        online.chat_remove_member(&ctx, &conversation_id, &me).await,
    )?;
    drop_conversation(&app, &conversation_id, "left");
    Ok(())
}

/// Accepts a group invite, which answers the group, or declines it.
#[tauri::command]
pub async fn chat_answer_group_invite(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    accept: bool,
) -> Result<Option<Conversation>> {
    let ctx = account(&app)?;
    let answer = if accept {
        let conversation = noted(&app, online.chat_join_group(&ctx, &conversation_id).await)?;
        keep(&app, &conversation);
        Some(conversation)
    } else {
        let me = my_id(&app).ok_or(AppError::SignedOut)?;
        noted(
            &app,
            online
                .chat_remove_group_invite(&ctx, &conversation_id, &me)
                .await,
        )?;
        None
    };
    if app
        .state::<ChatState>()
        .book()
        .remove_invite(&conversation_id)
    {
        schedule_state(&app);
    }
    Ok(answer)
}

/// `all`, `mentions` or `mute` for one conversation.
#[tauri::command]
pub async fn chat_set_notify(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    conversation_id: String,
    notify: String,
) -> Result<Conversation> {
    let ctx = account(&app)?;
    if !matches!(notify.as_str(), "all" | "mentions" | "mute") {
        return Err(AppError::InvalidInput(format!(
            "notify is all, mentions or mute, not {notify:?}"
        )));
    }
    let conversation = noted(
        &app,
        online
            .chat_set_notify(&ctx, &conversation_id, &notify)
            .await,
    )?;
    keep(&app, &conversation);
    Ok(conversation)
}

/// Searches the conversations of the player. `cursor` is the `nextCursor`
/// of the previous page.
#[tauri::command]
pub async fn chat_search(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    q: String,
    conversation_id: Option<String>,
    sender_id: Option<String>,
    has: Option<String>,
    cursor: Option<String>,
) -> Result<SearchPage> {
    let ctx = account(&app)?;
    if q.trim().is_empty() {
        return Err(AppError::InvalidInput("an empty search".into()));
    }
    let query = SearchQuery {
        q,
        conversation_id,
        sender_id,
        has,
        before: cursor,
        limit: None,
    };
    let page = noted(&app, online.chat_search(&ctx, &query).await)?;
    app.state::<ChatState>()
        .remember_files(page.results.iter().map(|hit| &hit.message));
    Ok(page)
}

/// The chat settings of the account, read from the service.
#[tauri::command]
pub async fn chat_get_privacy(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
) -> Result<ChatPrivacy> {
    let ctx = account(&app)?;
    let privacy = noted(&app, online.chat_settings(&ctx).await)?;
    take_privacy(&app, privacy.clone());
    Ok(privacy)
}

/// Changes some of the chat settings; the fields left out stay.
#[tauri::command]
pub async fn chat_update_privacy(
    app: AppHandle,
    online: tauri::State<'_, OnlineClient>,
    patch: ChatPrivacyPatch,
) -> Result<ChatPrivacy> {
    let ctx = account(&app)?;
    if let Some(group_add) = patch.group_add.as_deref() {
        if !matches!(group_add, "friends" | "ask") {
            return Err(AppError::InvalidInput(format!(
                "groupAdd is friends or ask, not {group_add:?}"
            )));
        }
    }
    let privacy = noted(&app, online.chat_update_settings(&ctx, &patch).await)?;
    take_privacy(&app, privacy.clone());
    Ok(privacy)
}

/// Keeps the settings the service answered, and refetches the sync document
/// when the read receipts switch flipped.
fn take_privacy(app: &AppHandle, privacy: ChatPrivacy) {
    let chat = app.state::<ChatState>();
    if chat.book().set_privacy(privacy) {
        chat.request_resync();
    }
    schedule_state(app);
}

/// The draft of one conversation, empty when there is none.
#[tauri::command]
pub async fn chat_get_draft(app: AppHandle, conversation_id: String) -> Result<String> {
    Ok(app
        .state::<ChatState>()
        .drafts()
        .get(&conversation_id)
        .cloned()
        .unwrap_or_default())
}

/// Keeps the draft of one conversation, so the drawer, the chat window and a
/// reopened thread show the same text. Empty text removes it.
#[tauri::command]
pub async fn chat_set_draft(app: AppHandle, conversation_id: String, text: String) -> Result<()> {
    let conversation_id = path_segment(&conversation_id)?.to_string();
    if text.chars().count() > MAX_DRAFT_CHARS {
        return Err(AppError::InvalidInput(format!(
            "a draft is at most {MAX_DRAFT_CHARS} characters"
        )));
    }
    let changed = {
        let chat = app.state::<ChatState>();
        let mut drafts = chat.drafts();
        if text.is_empty() {
            drafts.remove(&conversation_id).is_some()
        } else {
            drafts.insert(conversation_id.clone(), text.clone()).as_deref() != Some(text.as_str())
        }
    };
    if changed {
        emit(&app, EVENT_DRAFT, DraftChange { conversation_id, text });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use crate::online::{ChatMember, ChatMessage, Conversation, OnlineUser};

    pub const ME: &str = "01HME000000000000000000000";
    pub const KYLE: &str = "01HKYLE0000000000000000000";

    pub fn user(id: &str) -> OnlineUser {
        OnlineUser {
            id: id.into(),
            display_name: id.into(),
            provider: "dev".into(),
            provider_name: id.into(),
            ..OnlineUser::default()
        }
    }

    pub fn conversation(id: &str, last_seq: u64, read_seq: u64) -> Conversation {
        Conversation {
            id: id.into(),
            kind: "direct".into(),
            members: vec![
                ChatMember {
                    user: user(ME),
                    role: "member".into(),
                    joined_at: String::new(),
                    read_seq: Some(read_seq),
                },
                ChatMember {
                    user: user(KYLE),
                    role: "member".into(),
                    joined_at: String::new(),
                    read_seq: Some(0),
                },
            ],
            last_seq,
            read_seq,
            notify: "all".into(),
            can_send: true,
            created_at: "2026-09-26T10:00:00Z".into(),
            ..Conversation::default()
        }
    }

    pub fn message(conversation: &str, seq: u64, sender: Option<&str>) -> ChatMessage {
        ChatMessage {
            conversation_id: conversation.into(),
            seq,
            sender_id: sender.map(str::to_string),
            kind: "user".into(),
            body: format!("message {seq}"),
            created_at: format!("2026-09-26T10:{:02}:00Z", seq % 60),
            ..ChatMessage::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::online::ChatSyncDoc;

    fn book_with(conversations: Vec<Conversation>) -> Book {
        let mut book = Book::default();
        book.replace(ChatSyncDoc {
            conversations,
            ..ChatSyncDoc::default()
        });
        book
    }

    #[test]
    fn a_sync_doc_with_a_lower_last_seq_puts_that_conversation_in_reset() {
        let mut book = book_with(vec![conversation("a", 40, 40), conversation("b", 7, 7)]);
        // The service database was restored: `a` went back to 12, `b` moved
        // on, `c` is new.
        let reset = book.replace(ChatSyncDoc {
            conversations: vec![
                conversation("a", 12, 12),
                conversation("b", 9, 7),
                conversation("c", 3, 0),
            ],
            ..ChatSyncDoc::default()
        });
        assert_eq!(reset, ["a"]);
        assert_eq!(book.get("a").map(|c| c.last_seq), Some(12));
        assert_eq!(book.summaries.len(), 3);
        // Settings and quota come with the document.
        assert_eq!(book.privacy, Some(ChatPrivacy::default()));
        // A first document resets nothing: there is nothing to go back from.
        assert!(Book::default()
            .replace(ChatSyncDoc {
                conversations: vec![conversation("a", 1, 0)],
                ..ChatSyncDoc::default()
            })
            .is_empty());
    }

    #[test]
    fn a_message_of_another_member_counts_as_unread_and_a_mention_as_both() {
        let mut book = book_with(vec![conversation("a", 2, 2)]);
        let applied = book.apply_message(Some(ME), &message("a", 3, Some(KYLE)), false);
        assert_eq!(
            applied,
            MessageApplied { known: true, fresh: true, typing_stopped: false }
        );
        let summary = book.get("a").expect("known");
        assert_eq!((summary.last_seq, summary.unread, summary.unread_mentions), (3, 1, 0));
        assert_eq!(summary.last_message.as_ref().map(|m| m.seq), Some(3));

        let mut mention = message("a", 4, Some(KYLE));
        mention.mentions = vec![ME.into()];
        book.apply_message(Some(ME), &mention, false);
        let summary = book.get("a").expect("known");
        assert_eq!((summary.unread, summary.unread_mentions), (2, 1));

        // The same message again, from the socket after the send answer:
        // nothing moves.
        let again = book.apply_message(Some(ME), &mention, false);
        assert!(again.known && !again.fresh);
        assert_eq!(book.get("a").map(|c| c.unread), Some(2));
    }

    #[test]
    fn a_deleted_account_message_is_unread_and_never_the_players_own() {
        let mut book = book_with(vec![conversation("a", 0, 0)]);
        // `senderId: null` on a user message: the account is gone.
        book.apply_message(Some(ME), &message("a", 1, None), false);
        assert_eq!(book.get("a").map(|c| c.unread), Some(1));
        // Signed out, nobody is `me`, and still nothing is "own".
        assert!(!message("a", 1, None).is_from(None));
        assert!(!message("a", 1, Some(ME)).is_from(None));
    }

    #[test]
    fn an_own_message_reads_the_conversation_and_a_viewed_one_stays_read() {
        let mut book = book_with(vec![conversation("a", 5, 3)]);
        book.summaries.get_mut("a").expect("known").unread = 2;
        book.apply_message(Some(ME), &message("a", 6, Some(ME)), false);
        let summary = book.get("a").expect("known");
        assert_eq!((summary.read_seq, summary.unread), (6, 0));
        assert_eq!(summary.members[0].read_seq, Some(6));

        // A window shows the thread at its bottom: the message is read there.
        book.apply_message(Some(ME), &message("a", 7, Some(KYLE)), true);
        assert_eq!(book.get("a").map(|c| (c.last_seq, c.unread)), Some((7, 0)));
    }

    #[test]
    fn system_messages_and_hidden_history_do_not_count() {
        let mut book = book_with(vec![conversation("a", 10, 0)]);
        book.summaries.get_mut("a").expect("known").visible_from_seq = 20;
        let mut system = message("a", 11, None);
        system.kind = "system".into();
        book.apply_message(Some(ME), &system, false);
        assert_eq!(book.get("a").map(|c| c.unread), Some(0));
        // Below the join of the player: the service would not count it
        // either.
        book.apply_message(Some(ME), &message("a", 12, Some(KYLE)), false);
        assert_eq!(book.get("a").map(|c| c.unread), Some(0));
    }

    #[test]
    fn unread_stops_at_the_cap_of_the_service() {
        let mut book = book_with(vec![conversation("a", 0, 0)]);
        for seq in 1..=150 {
            book.apply_message(Some(ME), &message("a", seq, Some(KYLE)), false);
        }
        assert_eq!(book.get("a").map(|c| c.unread), Some(UNREAD_CAP));
    }

    #[test]
    fn a_message_of_an_unknown_conversation_asks_for_it() {
        let mut book = Book::default();
        let applied = book.apply_message(Some(ME), &message("new", 1, Some(KYLE)), false);
        assert!(!applied.known && !applied.fresh);
    }

    #[test]
    fn read_markers_move_forward_only() {
        let mut book = book_with(vec![conversation("a", 10, 4)]);
        book.summaries.get_mut("a").expect("known").unread = 6;
        // Kyle read up to 8: his marker, not the unread count.
        let kyle = ReadMark { conversation_id: "a".into(), user_id: KYLE.into(), seq: 8 };
        assert_eq!(book.apply_read(Some(ME), &kyle), (true, false));
        assert_eq!(book.get("a").map(|c| c.members[1].read_seq), Some(Some(8)));
        let older = ReadMark { seq: 5, ..kyle.clone() };
        book.apply_read(Some(ME), &older);
        assert_eq!(book.get("a").map(|c| c.members[1].read_seq), Some(Some(8)));

        // Another device of mine read part of it: the count is unknown now.
        let mine = ReadMark { conversation_id: "a".into(), user_id: ME.into(), seq: 7 };
        assert_eq!(book.apply_read(Some(ME), &mine), (true, true));
        // And then all of it.
        let all = ReadMark { seq: 10, ..mine };
        assert_eq!(book.apply_read(Some(ME), &all), (true, false));
        assert_eq!(book.get("a").map(|c| (c.read_seq, c.unread)), Some((10, 0)));
    }

    #[test]
    fn totals_leave_muted_unread_out_but_keep_its_mentions() {
        let mut loud = conversation("a", 3, 0);
        loud.unread = 3;
        loud.unread_mentions = 1;
        let mut muted = conversation("b", 5, 0);
        muted.notify = "mute".into();
        muted.unread = 5;
        muted.unread_mentions = 2;
        let book = book_with(vec![loud, muted]);
        assert_eq!(book.totals(), (3, 3));
    }

    #[test]
    fn the_list_is_newest_activity_first() {
        let mut quiet = conversation("quiet", 0, 0);
        quiet.created_at = "2026-09-26T09:00:00Z".into();
        let mut busy = conversation("busy", 1, 0);
        busy.last_message = Some(message("busy", 1, Some(KYLE)));
        let mut fresh = conversation("fresh", 0, 0);
        fresh.created_at = "2026-09-26T23:00:00Z".into();
        let book = book_with(vec![quiet, busy, fresh]);
        let order: Vec<String> = book.conversations().into_iter().map(|c| c.id).collect();
        assert_eq!(order, ["fresh", "busy", "quiet"]);
    }

    #[test]
    fn reactions_toggle_on_the_last_message() {
        let mut summary = conversation("a", 1, 1);
        summary.last_message = Some(message("a", 1, Some(KYLE)));
        let mut book = book_with(vec![summary]);
        let on = ReactionChange {
            conversation_id: "a".into(),
            seq: 1,
            user_id: ME.into(),
            emoji: "👍".into(),
            on: true,
        };
        assert!(book.apply_reaction(&on));
        assert!(!book.apply_reaction(&on), "the same reaction twice is one");
        let reactions = |book: &Book| {
            book.get("a")
                .and_then(|c| c.last_message.clone())
                .map(|m| m.reactions)
                .unwrap_or_default()
        };
        assert_eq!(reactions(&book)[0].user_ids, [ME]);
        assert!(book.apply_reaction(&ReactionChange { on: false, ..on.clone() }));
        assert!(reactions(&book).is_empty(), "an empty group goes");
        // A reaction to an older message leaves the summary alone.
        assert!(!book.apply_reaction(&ReactionChange { seq: 0, ..on }));
    }

    #[test]
    fn typing_hints_expire_and_a_message_ends_them() {
        let mut book = book_with(vec![conversation("a", 0, 0)]);
        let now = Instant::now();
        book.set_typing("a", KYLE, now + Duration::from_secs(6));
        assert_eq!(book.typing_in("a", now), [KYLE]);
        assert!(book.typing_in("a", now + Duration::from_secs(7)).is_empty());

        book.set_typing("a", KYLE, now + Duration::from_secs(6));
        let applied = book.apply_message(Some(ME), &message("a", 1, Some(KYLE)), false);
        assert!(applied.typing_stopped);
        assert!(book.typing_in("a", now).is_empty());
    }

    #[test]
    fn a_receipts_switch_that_flips_asks_for_a_fresh_document() {
        let mut book = book_with(Vec::new());
        assert!(!book.set_privacy(ChatPrivacy::default()));
        assert!(book.set_privacy(ChatPrivacy {
            share_read_receipts: false,
            ..ChatPrivacy::default()
        }));
        // Typing alone does not change what the sync document carries.
        assert!(!book.set_privacy(ChatPrivacy {
            share_read_receipts: false,
            share_typing: false,
            ..ChatPrivacy::default()
        }));
        assert!(!book.shares_typing());
    }

    #[test]
    fn a_typing_hint_goes_only_where_the_player_may_write() {
        let mut read_only = conversation("unfriended", 3, 3);
        read_only.can_send = false;
        let mut book = book_with(vec![conversation("dm", 3, 3), read_only]);
        assert!(book.may_type("dm"));
        // The friendship ended: the direct conversation is read-only (D2).
        assert!(!book.may_type("unfriended"));
        // Nothing is known of this one yet.
        assert!(!book.may_type("unknown"));
        // Hiding typing silences every conversation (D8).
        book.set_privacy(ChatPrivacy {
            share_typing: false,
            ..ChatPrivacy::default()
        });
        assert!(!book.may_type("dm"));
    }

    #[test]
    fn joining_a_group_drops_its_invite() {
        let mut book = Book::default();
        book.upsert_invite(GroupInvite {
            conversation_id: "g".into(),
            invited_by: user(KYLE),
            ..GroupInvite::default()
        });
        book.upsert(conversation("g", 1, 0));
        assert!(book.invites.is_empty());
    }

    #[test]
    fn forgetting_the_account_clears_everything_and_names_what_was_known() {
        let chat = ChatState::default();
        chat.book().replace(ChatSyncDoc {
            conversations: vec![conversation("a", 1, 0), conversation("b", 1, 0)],
            ..ChatSyncDoc::default()
        });
        chat.drafts().insert("a".into(), "half a thought".into());
        chat.outbox()
            .push(OutboxEntry::new("c1", "a", SendDraft { body: "hi".into(), ..SendDraft::default() }));
        chat.set_available(false);

        assert_eq!(chat.forget(), ["a", "b"]);
        let view = chat.view(false, false);
        assert!(view.conversations.is_empty() && view.outbox.is_empty());
        assert!(view.available, "the next account may well have chat");
        assert!(chat.drafts().is_empty());
    }

    #[test]
    fn a_viewed_conversation_needs_focus_and_the_bottom() {
        let chat = ChatState::default();
        let window = |conversation: &str, focused: bool, at_bottom: bool| Viewing {
            conversation_id: Some(conversation.into()),
            focused,
            at_bottom,
            composer: false,
        };
        lock(&chat.viewing).insert("main".into(), window("a", true, false));
        assert!(!chat.is_viewed("a"));
        lock(&chat.viewing).insert("chat".into(), window("a", true, true));
        assert!(chat.is_viewed("a"));
        assert!(!chat.is_viewed("b"));
    }

    #[test]
    fn a_client_id_is_a_ulid() {
        let first = new_client_id();
        let second = new_client_id();
        assert_eq!(first.len(), 26);
        assert_ne!(first, second);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_digit() || (c.is_ascii_uppercase() && !"ILOU".contains(c))));
        // The first character holds three bits of a 48-bit time: 0 to 7.
        assert!(first.as_bytes()[0] <= b'7', "{first}");
        // Time-ordered: an id made later never sorts before.
        std::thread::sleep(Duration::from_millis(2));
        assert!(new_client_id()[..10] >= first[..10]);
    }

    #[test]
    fn a_draft_is_checked_before_it_is_queued() {
        let draft = |body: &str| SendDraft { body: body.into(), ..SendDraft::default() };
        assert!(check_draft(draft("gg")).is_ok());
        assert!(check_draft(draft("   \n")).is_err());
        assert!(check_draft(draft(&"a".repeat(MAX_BODY_CHARS))).is_ok());
        assert!(check_draft(draft(&"a".repeat(MAX_BODY_CHARS + 1))).is_err());
        // A card alone is a message, and it goes out complete.
        let card = SendDraft {
            cards: vec![serde_json::json!({ "type": "map", "game": "ja", "name": "mp/ffa3" })],
            ..SendDraft::default()
        };
        let checked = check_draft(card).expect("a card alone is a message");
        assert_eq!(
            checked.cards,
            [serde_json::json!({ "type": "map", "v": 1, "fallbackText": "Map: mp/ffa3",
                                 "game": "ja", "name": "mp/ffa3" })]
        );
        // A card the service would refuse never reaches the queue.
        let broken = SendDraft {
            cards: vec![serde_json::json!({ "type": "map", "v": 1 })],
            ..SendDraft::default()
        };
        let refusal = check_draft(broken).expect_err("a map card without a map");
        assert_eq!(refusal.details()["code"], cards::CARD);
        let too_many = SendDraft {
            attachments: vec!["h".into(); MAX_ATTACHMENTS + 1],
            ..SendDraft::default()
        };
        assert!(check_draft(too_many).is_err());
    }

    #[test]
    fn the_state_reaches_the_frontend_in_camel_case() {
        let chat = ChatState::default();
        let json = serde_json::to_value(chat.view(true, false)).expect("serializes");
        for key in [
            "available",
            "signedIn",
            "connected",
            "conversations",
            "groupInvites",
            "privacy",
            "quota",
            "unreadTotal",
            "mentionTotal",
            "outbox",
        ] {
            assert!(json.get(key).is_some(), "{key} is missing from {json}");
        }
    }
}
