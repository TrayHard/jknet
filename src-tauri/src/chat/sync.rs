//! Keeping the summaries in step with the service.
//!
//! One task reads the sync document, `GET /v1/chat/conversations`, whenever
//! what the core holds may be stale:
//!
//! - the live socket opened again ([`FriendsState::bump_epoch`]): frames sent
//!   while it was down are not replayed;
//! - a frame asked for it (`chat.resync` after the socket lagged, or read
//!   receipts switched on or off);
//! - the account changed: everything of the previous one is forgotten first,
//!   `cache\chat\` included;
//! - the socket is down: then at most once a minute, so the badges still move.
//!
//! Each answer replaces the book, goes out as `chat:state` and then as
//! `chat:resync` with the conversations whose `lastSeq` went back, and lets
//! the outbox and the read markers try at once whatever was waiting for the
//! network.
//!
//! Read markers are here too: a conversation read in a window is marked read
//! at once on this side, and the service hears about it after a second of
//! quiet, one request per conversation. A marker the network or a busy
//! service lost waits and goes again at the pace of the outbox; a fresh
//! sync document does not undo it on this side, and sends it at once.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::friends::FriendsState;
use crate::online::{is_chat_unavailable, is_retryable, OnlineClient, OnlineContext};
use crate::state::AppState;

use super::{
    account, drop_conversation, emit, emit_state_now, lock, my_id, noted, outbox, schedule_state,
    Book, ChatState, EVENT_RESYNC,
};

/// How long after startup the first sync document is read when the socket
/// has not opened by then.
const FIRST_SYNC_DELAY: Duration = Duration::from_secs(2);

/// How often the sync document is read while the socket is down.
const OFFLINE_REFRESH: Duration = Duration::from_secs(60);

/// How long read markers gather before they go out.
const READ_DEBOUNCE: Duration = Duration::from_secs(1);

/// The `chat:resync` event.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResyncView {
    /// Conversations whose threads the windows drop and load again from the
    /// last page.
    pub reset: Vec<String>,
}

/// Starts the sync task. It lives as long as the process and costs nothing
/// while signed out.
pub(super) fn start(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let (mut epochs, mut account_changes) = {
            let friends = handle.state::<FriendsState>();
            (friends.connected_epochs(), friends.account_changes())
        };
        tokio::time::sleep(FIRST_SYNC_DELAY).await;
        resync(&handle).await;
        loop {
            let chat = handle.state::<ChatState>();
            tokio::select! {
                changed = epochs.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    resync(&handle).await;
                }
                changed = account_changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    forget_account(&handle);
                    resync(&handle).await;
                }
                _ = chat.wake.notified() => resync(&handle).await,
                _ = tokio::time::sleep(OFFLINE_REFRESH) => {
                    if !handle.state::<FriendsState>().live() && is_stale(&chat) {
                        resync(&handle).await;
                    }
                }
            }
        }
    });
}

/// Whether the sync document is older than [`OFFLINE_REFRESH`].
fn is_stale(chat: &ChatState) -> bool {
    lock(&chat.synced_at).is_none_or(|at| at.elapsed() >= OFFLINE_REFRESH)
}

/// Reads the sync document and replaces what the core holds with it.
pub(super) async fn resync(app: &AppHandle) {
    let Ok(ctx) = account(app) else {
        return;
    };
    let answer = app.state::<OnlineClient>().chat_sync(&ctx).await;
    // The player switched accounts while the request was out: the answer
    // belongs to the account before.
    if !same_account(app, &ctx) {
        return;
    }
    match noted(app, answer) {
        Ok(doc) => {
            let chat = app.state::<ChatState>();
            chat.remember_files(
                doc.conversations
                    .iter()
                    .filter_map(|conversation| conversation.last_message.as_ref()),
            );
            let reset = chat.book().replace(doc);
            *lock(&chat.synced_at) = Some(Instant::now());
            if !reset.is_empty() {
                log::warn!(
                    "chat: {} conversation(s) went back in history, the service was restored",
                    reset.len()
                );
            }
            // The document may predate the markers still on their way.
            let (marks, waiting) = {
                let mut marks = lock(&chat.read_pending);
                for id in &reset {
                    marks.remove(id);
                }
                (marks.all(), marks.connection_back())
            };
            let me = my_id(app);
            keep_reads(&mut chat.book(), me.as_deref(), &marks);
            emit_state_now(app);
            emit(app, EVENT_RESYNC, ResyncView { reset });
            outbox::flush(app);
            if waiting {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move { flush_reads(&handle).await });
            }
        }
        Err(e) if is_chat_unavailable(&e) => {
            log::info!("chat: this JKNet Online service has no chat API");
        }
        Err(e) => log::debug!("chat: cannot read the sync document: {e}"),
    }
}

/// Whether the settings still name the account `ctx` was made for.
pub(super) fn same_account(app: &AppHandle, ctx: &OnlineContext) -> bool {
    app.state::<AppState>().settings().is_ok_and(|settings| {
        let now = OnlineContext::from_settings(&settings);
        now.base_url == ctx.base_url && now.token == ctx.token
    })
}

/// Forgets the previous account: the book, the queue, the drafts and the
/// files it downloaded. The windows drop every thread it had.
fn forget_account(app: &AppHandle) {
    let known = app.state::<ChatState>().forget();
    log::info!("chat: the account changed, {} conversation(s) forgotten", known.len());
    if let Ok(paths) = app.state::<AppState>().paths() {
        let dir = paths.chat_cache_dir();
        tauri::async_runtime::spawn_blocking(move || {
            if dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    log::warn!("chat: cannot remove {}: {e}", dir.display());
                }
            }
        });
    }
    emit_state_now(app);
    if !known.is_empty() {
        emit(app, EVENT_RESYNC, ResyncView { reset: known });
    }
}

/// Fetches one conversation the book does not know, or cannot count.
pub(super) async fn refresh_conversation(app: &AppHandle, conversation_id: &str) {
    let Ok(ctx) = account(app) else {
        return;
    };
    let answer = app
        .state::<OnlineClient>()
        .chat_conversation(&ctx, conversation_id)
        .await;
    match noted(app, answer) {
        Ok(conversation) => {
            app.state::<ChatState>().book().upsert(conversation);
            schedule_state(app);
        }
        // Not a member any more, and the frame that said so was missed.
        Err(AppError::Online { code, .. }) if code == "not_found" => {
            drop_conversation(app, conversation_id, "removed");
        }
        Err(e) => log::debug!("chat: cannot read conversation {conversation_id}: {e}"),
    }
}

/// Marks a conversation read up to its last message: at once on this side,
/// and on the service after [`READ_DEBOUNCE`] of quiet.
pub(super) fn queue_read(app: &AppHandle, conversation_id: &str) {
    let chat = app.state::<ChatState>();
    let me = my_id(app);
    let seq = {
        let mut book = chat.book();
        let Some(seq) = book.get(conversation_id).map(|summary| summary.last_seq) else {
            return;
        };
        if seq == 0 || !book.read_locally(me.as_deref(), conversation_id, seq) {
            return;
        }
        seq
    };
    lock(&chat.read_pending).queue(conversation_id, seq);
    schedule_state(app);
    schedule_reads(app, READ_DEBOUNCE);
}

/// Sends the read markers after `wait`, unless a flush is already due.
fn schedule_reads(app: &AppHandle, wait: Duration) {
    let chat = app.state::<ChatState>();
    if chat.read_flush.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(wait).await;
        flush_reads(&handle).await;
    });
}

/// Sends every read marker that gathered. One the network or a busy
/// service lost waits for the next attempt; one the service refused goes.
async fn flush_reads(app: &AppHandle) {
    let chat = app.state::<ChatState>();
    // Cleared before the requests go out, so a marker queued meanwhile
    // schedules the next flush rather than waiting for this one.
    chat.read_flush.store(false, Ordering::Release);
    // Signed out, the markers wait: the next account forgets them.
    let Ok(ctx) = account(app) else {
        return;
    };
    let batch = lock(&chat.read_pending).take();
    if batch.is_empty() {
        return;
    }
    let me = my_id(app);
    let online = app.state::<OnlineClient>();
    let mut retry = false;
    for (conversation_id, seq) in batch {
        let answer = noted(app, online.chat_read(&ctx, &conversation_id, seq).await);
        // The player switched accounts while the request was out: the
        // markers of the account before were forgotten with it.
        if !same_account(app, &ctx) {
            return;
        }
        match answer {
            Ok(read_seq) => {
                lock(&chat.read_pending).sent(&conversation_id, seq);
                chat.book()
                    .read_locally(me.as_deref(), &conversation_id, read_seq);
            }
            Err(e) if is_retryable(&e) => {
                log::debug!("chat: cannot move the read marker of {conversation_id} yet: {e}");
                lock(&chat.read_pending).failed(&conversation_id, seq);
                retry = true;
            }
            Err(e) => {
                log::debug!("chat: the read marker of {conversation_id} was refused: {e}");
                lock(&chat.read_pending).refused(&conversation_id, seq);
            }
        }
    }
    if !retry {
        return;
    }
    let next = lock(&chat.read_pending).retry_after(Instant::now());
    match next {
        Some(wait) => schedule_reads(app, wait),
        None => log::warn!("chat: read markers keep failing, they wait for the next sync"),
    }
}

/// Puts the markers still on their way back on a book a sync document just
/// replaced: the document may be older than they are.
fn keep_reads(book: &mut Book, me: Option<&str>, marks: &[(String, u64)]) {
    for (conversation_id, seq) in marks {
        book.read_locally(me, conversation_id, *seq);
    }
}

/// Read markers on their way to the service: the highest seq read in each
/// conversation, and the pace of attempts after a failure.
#[derive(Debug, Default)]
pub(super) struct ReadMarks {
    /// Waiting for the next flush, by conversation.
    waiting: HashMap<String, u64>,
    /// Sent and not answered yet, by conversation.
    sending: HashMap<String, u64>,
    /// Flushes in a row that lost a marker.
    failures: u32,
    /// When the first of those flushes was.
    failing_since: Option<Instant>,
}

impl ReadMarks {
    /// Queues a marker. The higher one of a conversation wins.
    pub(super) fn queue(&mut self, conversation_id: &str, seq: u64) {
        raise(&mut self.waiting, conversation_id, seq);
    }

    /// Takes every waiting marker for one flush.
    fn take(&mut self) -> Vec<(String, u64)> {
        let batch: Vec<(String, u64)> = self.waiting.drain().collect();
        for (conversation_id, seq) in &batch {
            raise(&mut self.sending, conversation_id, *seq);
        }
        batch
    }

    /// The service took a marker: the network works again.
    fn sent(&mut self, conversation_id: &str, seq: u64) {
        self.settle(conversation_id, seq);
        self.failures = 0;
        self.failing_since = None;
    }

    /// The service refused a marker, and would refuse it again.
    fn refused(&mut self, conversation_id: &str, seq: u64) {
        self.settle(conversation_id, seq);
    }

    /// A marker was lost on the way: it waits for the next flush.
    fn failed(&mut self, conversation_id: &str, seq: u64) {
        self.settle(conversation_id, seq);
        raise(&mut self.waiting, conversation_id, seq);
    }

    /// Drops the answered marker, unless a later flush sent a higher one.
    fn settle(&mut self, conversation_id: &str, seq: u64) {
        if self
            .sending
            .get(conversation_id)
            .is_some_and(|sent| *sent <= seq)
        {
            self.sending.remove(conversation_id);
        }
    }

    /// Counts a flush that lost markers, and answers when the next one goes:
    /// the wait of the outbox, or `None` once markers failed for as long as
    /// the outbox tries. They keep waiting then, for the next sync document
    /// or the next conversation read.
    fn retry_after(&mut self, now: Instant) -> Option<Duration> {
        self.failures = self.failures.saturating_add(1);
        let since = *self.failing_since.get_or_insert(now);
        (now.duration_since(since) < outbox::GIVE_UP_AFTER).then(|| outbox::backoff(self.failures))
    }

    /// A sync document came: the connection works, so the count of failures
    /// starts again. Answers whether markers wait to go out.
    fn connection_back(&mut self) -> bool {
        self.failures = 0;
        self.failing_since = None;
        !self.waiting.is_empty()
    }

    /// Every marker waiting or in flight, the higher one of a conversation.
    fn all(&self) -> Vec<(String, u64)> {
        let mut all = self.sending.clone();
        for (conversation_id, seq) in &self.waiting {
            raise(&mut all, conversation_id, *seq);
        }
        all.into_iter().collect()
    }

    /// Forgets the markers of a conversation the player left, or whose
    /// history went back.
    pub(super) fn remove(&mut self, conversation_id: &str) {
        self.waiting.remove(conversation_id);
        self.sending.remove(conversation_id);
    }

    /// Forgets everything: the account changed.
    pub(super) fn clear(&mut self) {
        *self = ReadMarks::default();
    }
}

/// Raises the marker of a conversation to `seq`.
fn raise(marks: &mut HashMap<String, u64>, conversation_id: &str, seq: u64) {
    let entry = marks.entry(conversation_id.to_string()).or_insert(0);
    *entry = (*entry).max(seq);
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::online::ChatSyncDoc;

    #[test]
    fn a_lost_read_marker_waits_for_the_next_flush_and_a_refused_one_goes() {
        let mut marks = ReadMarks::default();
        marks.queue("a", 5);
        marks.queue("a", 3);
        marks.queue("b", 2);
        let mut batch = marks.take();
        batch.sort();
        assert_eq!(batch, [("a".to_string(), 5), ("b".to_string(), 2)]);
        assert!(marks.waiting.is_empty());

        // `a` was read further while its marker was out, and then lost.
        marks.queue("a", 7);
        marks.failed("a", 5);
        marks.refused("b", 2);
        assert_eq!(marks.take(), [("a".to_string(), 7)]);
        marks.failed("a", 7);
        assert_eq!(marks.take(), [("a".to_string(), 7)]);
        marks.sent("a", 7);
        assert!(marks.all().is_empty());
        assert!(marks.take().is_empty());
    }

    #[test]
    fn an_answer_to_an_older_marker_leaves_the_newer_one_in_flight() {
        let mut marks = ReadMarks::default();
        marks.queue("a", 4);
        marks.take();
        marks.queue("a", 9);
        marks.take();
        marks.sent("a", 4);
        assert_eq!(marks.all(), [("a".to_string(), 9)]);
        marks.sent("a", 9);
        assert!(marks.all().is_empty());
    }

    #[test]
    fn lost_markers_go_again_at_the_pace_of_the_outbox_and_stop_after_its_window() {
        let mut marks = ReadMarks::default();
        let start = Instant::now();
        assert_eq!(marks.retry_after(start), Some(Duration::from_secs(1)));
        assert_eq!(marks.retry_after(start), Some(Duration::from_secs(2)));
        assert_eq!(marks.retry_after(start), Some(Duration::from_secs(4)));
        // The service took one: the pace starts again.
        marks.sent("a", 1);
        assert_eq!(marks.retry_after(start), Some(Duration::from_secs(1)));
        assert_eq!(marks.retry_after(start + outbox::GIVE_UP_AFTER), None);

        // The markers stay after the timer stops, and a sync document
        // sends them and starts the count again.
        marks.queue("a", 3);
        assert!(marks.connection_back());
        assert_eq!(
            marks.retry_after(start + outbox::GIVE_UP_AFTER),
            Some(Duration::from_secs(1))
        );
        marks.take();
        assert!(!marks.connection_back());
    }

    #[test]
    fn a_sync_document_older_than_a_marker_on_its_way_does_not_bring_the_unread_back() {
        let mut marks = ReadMarks::default();
        marks.queue("dm", 8);
        marks.queue("gone", 4);
        marks.take();
        marks.failed("dm", 8);
        marks.remove("gone");

        // The service never heard of the marker: its document still counts
        // the messages as unread.
        let mut stale = conversation("dm", 8, 5);
        stale.unread = 3;
        let mut book = Book::default();
        book.replace(ChatSyncDoc {
            conversations: vec![stale],
            ..ChatSyncDoc::default()
        });
        keep_reads(&mut book, Some(ME), &marks.all());
        let summary = book.get("dm").expect("known");
        assert_eq!(
            (summary.read_seq, summary.unread, summary.unread_mentions),
            (8, 0, 0)
        );
        assert_eq!(marks.all(), [("dm".to_string(), 8)]);
    }
}
