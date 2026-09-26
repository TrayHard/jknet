//! The send queue.
//!
//! [`crate::chat::chat_send`] answers with a client id at once and leaves the
//! message here. The queue is first in, first out per conversation: the
//! first entry of a conversation that has not failed goes out, and the ones
//! behind it wait, so two messages never arrive in the other order. An entry
//! uploads its attachments (register, then the bytes unless the service
//! already holds them), then sends the message with the same client id on
//! every attempt, so a send whose answer was lost is stored once.
//!
//! | Failure                         | What the entry does                        |
//! | ------------------------------- | ------------------------------------------ |
//! | the network, `429`, a `5xx`     | waits 1 s, 2 s, 4 s … up to 30 s, and gives up 10 minutes after its first attempt |
//! | `file_gone`, `file_not_ready`   | registers and uploads its files again, once |
//! | any other refusal               | `failed` with the reason, until **Retry** or **Discard** |
//!
//! The queue lives in memory. `chat:outbox` carries the entries of one
//! conversation after every step.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};
use crate::online::{is_retryable, ChatMessage, NewMessage, OnlineClient};
use crate::timestamp;

use super::{
    account, emit, emit_outbox, files, my_id, noted, schedule_state, ChatState, SendDraft,
    EVENT_MESSAGE,
};

/// The first wait after a failed attempt.
const MIN_BACKOFF: Duration = Duration::from_secs(1);
/// The longest wait between two attempts.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How long an entry keeps trying before it is `failed`.
const GIVE_UP_AFTER: Duration = Duration::from_secs(10 * 60);

/// Where an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutboxStatus {
    /// Waiting for its turn, or for the next attempt.
    Queued,
    Uploading,
    Sending,
    /// Given up: waits for **Retry** or **Discard**.
    Failed,
}

/// Why an entry failed, as the code the frontend translates: the service's
/// reason for a refusal (`not_friends`, `too_long`, `quota_account` …), or
/// the code of the launcher's own error (`network` for a connection that
/// never worked). The whole sentence goes to the log.
fn failure_code(error: &AppError) -> String {
    match error {
        AppError::Online { code, .. } => code.clone(),
        other => other.code().to_string(),
    }
}

/// One message on its way.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    pub client_id: String,
    pub conversation_id: String,
    pub body: String,
    pub cards: Vec<Value>,
    /// Handles of the staged files.
    pub attachments: Vec<String>,
    pub reply_seq: Option<u64>,
    pub status: OutboxStatus,
    /// Set on a `failed` entry: see [`failure_code`].
    pub error: Option<String>,
    /// RFC 3339: when the player pressed Send.
    pub created_at: String,
    #[serde(skip)]
    first_try: Option<Instant>,
    #[serde(skip)]
    attempts: u32,
    #[serde(skip)]
    not_before: Option<Instant>,
    /// The file id each attachment got, once it is up.
    #[serde(skip)]
    file_ids: Vec<Option<String>>,
    /// Whether the files were registered a second time after `file_gone`.
    #[serde(skip)]
    reregistered: bool,
}

impl OutboxEntry {
    pub fn new(client_id: &str, conversation_id: &str, draft: SendDraft) -> OutboxEntry {
        OutboxEntry {
            client_id: client_id.to_string(),
            conversation_id: conversation_id.to_string(),
            file_ids: vec![None; draft.attachments.len()],
            body: draft.body,
            cards: draft.cards,
            attachments: draft.attachments,
            reply_seq: draft.reply_seq,
            status: OutboxStatus::Queued,
            error: None,
            created_at: timestamp::now_rfc3339(),
            first_try: None,
            attempts: 0,
            not_before: None,
            reregistered: false,
        }
    }

    fn uploads_left(&self) -> bool {
        self.file_ids.iter().any(Option::is_none)
    }

    /// Each attachment that is up, as `(handle, file id)`.
    fn uploaded(&self) -> Vec<(String, String)> {
        self.attachments
            .iter()
            .zip(&self.file_ids)
            .filter_map(|(handle, id)| id.clone().map(|id| (handle.clone(), id)))
            .collect()
    }
}

/// The `chat:outbox` event: the queue of one conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxView {
    pub conversation_id: String,
    pub entries: Vec<OutboxEntry>,
}

/// What a failed attempt turned into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retry {
    /// Try again after this long.
    After(Duration),
    /// The entry is `failed` now.
    GaveUp,
    /// The entry is gone: discarded, or settled by its frame meanwhile.
    Gone,
}

/// The queue, in the order the player wrote.
#[derive(Debug, Default)]
pub struct Outbox {
    entries: Vec<OutboxEntry>,
}

impl Outbox {
    pub fn push(&mut self, entry: OutboxEntry) {
        self.entries.push(entry);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn all(&self) -> Vec<OutboxEntry> {
        self.entries.clone()
    }

    pub fn entries_of(&self, conversation_id: &str) -> Vec<OutboxEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.conversation_id == conversation_id)
            .cloned()
            .collect()
    }

    pub fn get(&self, client_id: &str) -> Option<&OutboxEntry> {
        self.entries.iter().find(|entry| entry.client_id == client_id)
    }

    fn get_mut(&mut self, client_id: &str) -> Option<&mut OutboxEntry> {
        self.entries
            .iter_mut()
            .find(|entry| entry.client_id == client_id)
    }

    /// Starts every entry whose turn it is and whose wait is over, and
    /// answers their client ids. The first entry of a conversation that has
    /// not failed is its head; a head in flight or waiting holds the rest.
    pub fn start_ready(&mut self, now: Instant) -> Vec<String> {
        let mut heads = std::collections::HashSet::new();
        let mut started = Vec::new();
        for entry in &mut self.entries {
            if entry.status == OutboxStatus::Failed {
                continue;
            }
            if !heads.insert(entry.conversation_id.clone()) {
                continue;
            }
            if entry.status != OutboxStatus::Queued {
                continue;
            }
            if entry.not_before.is_some_and(|at| at > now) {
                continue;
            }
            entry.status = if entry.uploads_left() {
                OutboxStatus::Uploading
            } else {
                OutboxStatus::Sending
            };
            entry.first_try.get_or_insert(now);
            entry.not_before = None;
            started.push(entry.client_id.clone());
        }
        started
    }

    /// How long until the next waiting head may start, if one waits. The
    /// driver sleeps exactly this long with a timer per failure; the tests
    /// read it to see the wait.
    #[cfg(test)]
    fn next_wait(&self, now: Instant) -> Option<Duration> {
        self.entries
            .iter()
            .filter(|entry| entry.status == OutboxStatus::Queued)
            .filter_map(|entry| entry.not_before)
            .map(|at| at.saturating_duration_since(now))
            .min()
    }

    pub fn set_status(&mut self, client_id: &str, status: OutboxStatus) {
        if let Some(entry) = self.get_mut(client_id) {
            entry.status = status;
        }
    }

    pub fn set_file_id(&mut self, client_id: &str, index: usize, file_id: String) {
        if let Some(slot) = self
            .get_mut(client_id)
            .and_then(|entry| entry.file_ids.get_mut(index))
        {
            *slot = Some(file_id);
        }
    }

    /// The message went out. Answers its conversation.
    pub fn succeeded(&mut self, client_id: &str) -> Option<String> {
        self.take(client_id).map(|entry| entry.conversation_id)
    }

    /// The service's frame of the message arrived: the entry is done, whether
    /// or not its own answer ever does.
    pub fn matched(&mut self, client_id: &str) -> Option<String> {
        self.take(client_id).map(|entry| entry.conversation_id)
    }

    /// The player dropped it.
    pub fn discard(&mut self, client_id: &str) -> Option<OutboxEntry> {
        self.take(client_id)
    }

    fn take(&mut self, client_id: &str) -> Option<OutboxEntry> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.client_id == client_id)?;
        Some(self.entries.remove(index))
    }

    /// An attempt failed in a way that may pass: schedules the next one, or
    /// gives up once the entry has tried for [`GIVE_UP_AFTER`].
    pub fn retry_later(&mut self, client_id: &str, error: &AppError, now: Instant) -> Retry {
        let Some(entry) = self.get_mut(client_id) else {
            return Retry::Gone;
        };
        entry.attempts += 1;
        let first = *entry.first_try.get_or_insert(now);
        if now.duration_since(first) >= GIVE_UP_AFTER {
            entry.status = OutboxStatus::Failed;
            entry.error = Some(failure_code(error));
            entry.not_before = None;
            return Retry::GaveUp;
        }
        let wait = backoff(entry.attempts);
        entry.status = OutboxStatus::Queued;
        entry.not_before = Some(now + wait);
        Retry::After(wait)
    }

    /// An attempt was refused for good.
    pub fn fail(&mut self, client_id: &str, error: &AppError) -> Option<String> {
        let entry = self.get_mut(client_id)?;
        entry.status = OutboxStatus::Failed;
        entry.error = Some(failure_code(error));
        entry.not_before = None;
        Some(entry.conversation_id.clone())
    }

    /// The service lost the files of an entry: registers them again, once.
    /// Answers `false` when that already happened.
    pub fn reregister(&mut self, client_id: &str) -> bool {
        let Some(entry) = self.get_mut(client_id) else {
            return false;
        };
        if entry.reregistered || entry.attachments.is_empty() {
            return false;
        }
        entry.reregistered = true;
        entry.file_ids = vec![None; entry.attachments.len()];
        entry.status = OutboxStatus::Queued;
        entry.not_before = None;
        true
    }

    /// **Retry** on a failed entry: a fresh start, with the same client id.
    pub fn retry(&mut self, client_id: &str) -> Option<String> {
        let entry = self.get_mut(client_id)?;
        if entry.status != OutboxStatus::Failed {
            return Some(entry.conversation_id.clone());
        }
        entry.status = OutboxStatus::Queued;
        entry.error = None;
        entry.attempts = 0;
        entry.first_try = None;
        entry.not_before = None;
        entry.reregistered = false;
        Some(entry.conversation_id.clone())
    }

    /// The connection is back: every waiting entry may go now.
    pub fn flush(&mut self) {
        for entry in &mut self.entries {
            if entry.status == OutboxStatus::Queued {
                entry.not_before = None;
            }
        }
    }

    /// Whether an entry still carries this staged file.
    pub fn holds_attachment(&self, handle: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.attachments.iter().any(|attached| attached == handle))
    }

    /// Drops the entries of a conversation the player is no longer in.
    pub fn remove_conversation(&mut self, conversation_id: &str) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|entry| entry.conversation_id != conversation_id);
        before != self.entries.len()
    }

    /// Whether any entry is in flight, for the tests.
    #[cfg(test)]
    fn busy(&self) -> bool {
        self.entries.iter().any(|entry| {
            matches!(entry.status, OutboxStatus::Uploading | OutboxStatus::Sending)
        })
    }
}

/// 1 s, 2 s, 4 s … up to 30 s.
fn backoff(attempts: u32) -> Duration {
    let doubled = MIN_BACKOFF.saturating_mul(1u32 << attempts.saturating_sub(1).min(5));
    doubled.min(MAX_BACKOFF)
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/// Starts every entry whose turn it is. Cheap and idempotent: called after
/// every send, answer, retry, resync and timer.
pub fn kick(app: &AppHandle) {
    let chat = app.state::<ChatState>();
    let started = chat.outbox().start_ready(Instant::now());
    for client_id in started {
        if let Some(conversation_id) = chat
            .outbox()
            .get(&client_id)
            .map(|entry| entry.conversation_id.clone())
        {
            emit_outbox(app, &conversation_id);
        }
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            run(&handle, &client_id).await;
            kick(&handle);
        });
    }
}

/// The connection is back: every waiting entry goes now.
pub fn flush(app: &AppHandle) {
    app.state::<ChatState>().outbox().flush();
    kick(app);
}

/// One attempt of one entry, and what its outcome does to the queue.
async fn run(app: &AppHandle, client_id: &str) {
    let result = attempt(app, client_id).await;
    let chat = app.state::<ChatState>();
    match result {
        Ok((message, uploaded)) => {
            let conversation = chat.outbox().succeeded(client_id);
            // The staged copies are the files now, whether the answer or
            // the frame of the message settled the entry first.
            chat.remember_files([&message]);
            files::settle_sent(app, uploaded);
            // The frame of the message may be late or never come: the socket
            // may be down. The answer is the same message.
            let me = my_id(app);
            let viewed = chat.is_viewed(&message.conversation_id);
            chat.book().apply_message(me.as_deref(), &message, viewed);
            emit(app, EVENT_MESSAGE, &message);
            if let Some(conversation) = conversation {
                emit_outbox(app, &conversation);
            }
            schedule_state(app);
        }
        Err(error) => {
            let conversation = chat
                .outbox()
                .get(client_id)
                .map(|entry| entry.conversation_id.clone());
            let Some(conversation) = conversation else {
                return;
            };
            if is_file_lost(&error) && chat.outbox().reregister(client_id) {
                log::info!("chat: the files of {client_id} are gone on the service, uploading again");
            } else if is_retryable(&error) {
                match chat.outbox().retry_later(client_id, &error, Instant::now()) {
                    Retry::After(wait) => {
                        log::debug!("chat: sending {client_id} failed ({error}), again in {wait:?}");
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(wait).await;
                            kick(&handle);
                        });
                    }
                    Retry::GaveUp => log::warn!("chat: gave up sending {client_id}: {error}"),
                    Retry::Gone => {}
                }
            } else {
                log::warn!("chat: sending {client_id} was refused: {error}");
                chat.outbox().fail(client_id, &error);
            }
            emit_outbox(app, &conversation);
            schedule_state(app);
        }
    }
}

/// Whether the service lost the files an entry registered: a pending file
/// expires an hour after its registration.
fn is_file_lost(error: &AppError) -> bool {
    matches!(error, AppError::Online { code, .. } if code == "file_gone" || code == "file_not_ready")
}

/// Uploads what is left of the attachments of one entry, then sends it.
/// Answers the message and each attachment as `(handle, file id)`.
async fn attempt(app: &AppHandle, client_id: &str) -> Result<(ChatMessage, Vec<(String, String)>)> {
    let ctx = account(app)?;
    let chat = app.state::<ChatState>();
    let entry = chat
        .outbox()
        .get(client_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("queued message {client_id}")))?;
    let online = app.state::<OnlineClient>();

    for (index, handle) in entry.attachments.iter().enumerate() {
        if entry.file_ids.get(index).is_some_and(Option::is_some) {
            continue;
        }
        let staged = chat.staged().get(handle).cloned().ok_or_else(|| {
            AppError::InvalidInput(format!("the attachment {handle} is no longer staged"))
        })?;
        let file_id =
            files::upload(app, &online, &ctx, &entry.conversation_id, handle, &staged).await?;
        chat.outbox().set_file_id(client_id, index, file_id);
    }

    let uploaded: Vec<(String, String)> = chat
        .outbox()
        .get(client_id)
        .map(OutboxEntry::uploaded)
        .unwrap_or_default();
    let file_ids: Vec<String> = uploaded.iter().map(|(_, id)| id.clone()).collect();
    chat.outbox().set_status(client_id, OutboxStatus::Sending);
    emit_outbox(app, &entry.conversation_id);

    let message = NewMessage {
        client_id: entry.client_id.clone(),
        body: entry.body.clone(),
        cards: entry.cards.clone(),
        file_ids,
        reply_seq: entry.reply_seq,
    };
    let sent = noted(
        app,
        online
            .chat_send(&ctx, &entry.conversation_id, &message)
            .await,
    )?;
    Ok((sent, uploaded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(client_id: &str, conversation: &str) -> OutboxEntry {
        OutboxEntry::new(
            client_id,
            conversation,
            SendDraft {
                body: format!("text of {client_id}"),
                ..SendDraft::default()
            },
        )
    }

    fn network() -> AppError {
        AppError::Network("connection reset".into())
    }

    #[test]
    fn one_head_per_conversation_goes_out_and_the_rest_wait() {
        let mut outbox = Outbox::default();
        outbox.push(entry("a1", "a"));
        outbox.push(entry("a2", "a"));
        outbox.push(entry("b1", "b"));
        let now = Instant::now();
        assert_eq!(outbox.start_ready(now), ["a1", "b1"]);
        // Both heads are in flight, so nothing else starts.
        assert!(outbox.start_ready(now).is_empty());
        assert_eq!(outbox.succeeded("a1").as_deref(), Some("a"));
        assert_eq!(outbox.start_ready(now), ["a2"]);
        assert!(outbox.busy());
    }

    #[test]
    fn an_entry_keeps_its_client_id_through_every_retry() {
        let mut outbox = Outbox::default();
        outbox.push(entry("01J0CLIENT", "a"));
        let now = Instant::now();
        assert_eq!(outbox.start_ready(now), ["01J0CLIENT"]);
        assert_eq!(
            outbox.retry_later("01J0CLIENT", &network(), now),
            Retry::After(Duration::from_secs(1))
        );
        // Not before its wait is over.
        assert!(outbox.start_ready(now).is_empty());
        assert_eq!(outbox.next_wait(now), Some(Duration::from_secs(1)));
        let later = now + Duration::from_secs(1);
        assert_eq!(outbox.start_ready(later), ["01J0CLIENT"]);
        assert_eq!(outbox.all()[0].client_id, "01J0CLIENT");
    }

    #[test]
    fn a_waiting_head_holds_the_messages_behind_it() {
        let mut outbox = Outbox::default();
        outbox.push(entry("a1", "a"));
        outbox.push(entry("a2", "a"));
        let now = Instant::now();
        outbox.start_ready(now);
        outbox.retry_later("a1", &network(), now);
        // a2 must not overtake a1 while a1 waits for its next attempt.
        assert!(outbox.start_ready(now).is_empty());
    }

    #[test]
    fn the_backoff_doubles_to_thirty_seconds() {
        let waits: Vec<u64> = (1..=8).map(|attempt| backoff(attempt).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn an_entry_gives_up_after_ten_minutes_of_trying() {
        let mut outbox = Outbox::default();
        outbox.push(entry("a1", "a"));
        let start = Instant::now();
        outbox.start_ready(start);
        assert!(matches!(outbox.retry_later("a1", &network(), start), Retry::After(_)));
        let late = start + GIVE_UP_AFTER;
        assert_eq!(outbox.retry_later("a1", &network(), late), Retry::GaveUp);
        let failed = &outbox.all()[0];
        assert_eq!(failed.status, OutboxStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("network"));
    }

    #[test]
    fn a_failed_entry_steps_aside_and_retry_starts_it_afresh() {
        let mut outbox = Outbox::default();
        outbox.push(entry("a1", "a"));
        outbox.push(entry("a2", "a"));
        let now = Instant::now();
        outbox.start_ready(now);
        let refusal = AppError::Online {
            code: "not_friends".into(),
            message: "You are no longer friends".into(),
        };
        assert_eq!(outbox.fail("a1", &refusal).as_deref(), Some("a"));
        assert_eq!(
            outbox.get("a1").and_then(|e| e.error.clone()),
            Some("not_friends".to_string())
        );
        // The failed one waits for the player; the next one goes.
        assert_eq!(outbox.start_ready(now), ["a2"]);
        outbox.succeeded("a2");
        assert_eq!(outbox.retry("a1").as_deref(), Some("a"));
        let retried = outbox.get("a1").expect("still queued");
        assert_eq!((retried.status, retried.error.clone()), (OutboxStatus::Queued, None));
        assert_eq!(outbox.start_ready(now), ["a1"]);
    }

    #[test]
    fn lost_files_are_registered_again_once() {
        let mut outbox = Outbox::default();
        outbox.push(OutboxEntry::new(
            "a1",
            "a",
            SendDraft {
                attachments: vec!["h1".into(), "h2".into()],
                ..SendDraft::default()
            },
        ));
        let now = Instant::now();
        assert_eq!(outbox.start_ready(now), ["a1"]);
        assert_eq!(outbox.get("a1").map(|e| e.status), Some(OutboxStatus::Uploading));
        outbox.set_file_id("a1", 0, "f1".into());
        outbox.set_file_id("a1", 1, "f2".into());
        assert!(!outbox.get("a1").expect("queued").uploads_left());

        assert!(outbox.reregister("a1"));
        assert!(outbox.get("a1").expect("queued").uploads_left());
        assert!(!outbox.reregister("a1"), "only once");
        // A message without files has nothing to register again.
        outbox.push(entry("b1", "b"));
        assert!(!outbox.reregister("b1"));
    }

    #[test]
    fn a_matched_or_discarded_entry_leaves_and_a_late_answer_finds_nothing() {
        let mut outbox = Outbox::default();
        outbox.push(entry("a1", "a"));
        outbox.push(entry("a2", "a"));
        assert_eq!(outbox.matched("a1").as_deref(), Some("a"));
        assert_eq!(outbox.succeeded("a1"), None);
        assert_eq!(outbox.retry_later("a1", &network(), Instant::now()), Retry::Gone);
        assert!(outbox.discard("a2").is_some());
        assert!(outbox.all().is_empty());
    }

    #[test]
    fn a_flush_ends_every_wait() {
        let mut outbox = Outbox::default();
        outbox.push(entry("a1", "a"));
        let now = Instant::now();
        outbox.start_ready(now);
        outbox.retry_later("a1", &network(), now);
        outbox.flush();
        assert_eq!(outbox.start_ready(now), ["a1"]);
    }

    #[test]
    fn an_entry_reaches_the_frontend_without_its_bookkeeping() {
        let json = serde_json::to_value(entry("01J0CLIENT", "a")).expect("serializes");
        assert_eq!(json["clientId"], "01J0CLIENT");
        assert_eq!(json["status"], "queued");
        assert_eq!(json["error"], Value::Null);
        assert!(json.get("attempts").is_none() && json.get("fileIds").is_none());
        // A failure is the code the frontend translates.
        let mut outbox = Outbox::default();
        outbox.push(entry("01J0CLIENT", "a"));
        outbox.fail(
            "01J0CLIENT",
            &AppError::Online { code: "too_long".into(), message: "x".into() },
        );
        let json = serde_json::to_value(outbox.all()).expect("serializes");
        assert_eq!(json[0]["error"], "too_long");
        assert_eq!(json[0]["status"], "failed");
        assert_eq!(failure_code(&AppError::Network("reset".into())), "network");
    }
}
