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
//! the outbox try at once whatever was waiting for the network.
//!
//! Read markers are here too: a conversation read in a window is marked read
//! at once on this side, and the service hears about it after a second of
//! quiet, one request per conversation.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::friends::FriendsState;
use crate::online::{is_chat_unavailable, OnlineClient, OnlineContext};
use crate::state::AppState;

use super::{
    account, drop_conversation, emit, emit_state_now, lock, my_id, noted, outbox, schedule_state,
    ChatState, EVENT_RESYNC,
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
            emit_state_now(app);
            emit(app, EVENT_RESYNC, ResyncView { reset });
            outbox::flush(app);
        }
        Err(e) if is_chat_unavailable(&e) => {
            log::info!("chat: this JKNet Online service has no chat API");
        }
        Err(e) => log::debug!("chat: cannot read the sync document: {e}"),
    }
}

/// Whether the settings still name the account `ctx` was made for.
fn same_account(app: &AppHandle, ctx: &OnlineContext) -> bool {
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
    {
        let mut pending = lock(&chat.read_pending);
        let entry = pending.entry(conversation_id.to_string()).or_insert(0);
        *entry = (*entry).max(seq);
    }
    schedule_state(app);
    if chat.read_flush.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(READ_DEBOUNCE).await;
        flush_reads(&handle).await;
    });
}

/// Sends every read marker that gathered.
async fn flush_reads(app: &AppHandle) {
    let chat = app.state::<ChatState>();
    // Cleared before the requests go out, so a marker queued meanwhile
    // schedules the next flush rather than waiting for this one.
    chat.read_flush.store(false, Ordering::Release);
    let pending: Vec<(String, u64)> = lock(&chat.read_pending).drain().collect();
    let Ok(ctx) = account(app) else {
        return;
    };
    let me = my_id(app);
    let online = app.state::<OnlineClient>();
    for (conversation_id, seq) in pending {
        match noted(app, online.chat_read(&ctx, &conversation_id, seq).await) {
            Ok(read_seq) => {
                chat.book()
                    .read_locally(me.as_deref(), &conversation_id, read_seq);
            }
            Err(e) => log::debug!("chat: cannot move the read marker of {conversation_id}: {e}"),
        }
    }
}
