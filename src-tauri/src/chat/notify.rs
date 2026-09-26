//! Notifications of chat messages: what a message deserves, and showing it.
//!
//! The core decides, never a window: two windows would otherwise both toast
//! the same message, and a launcher hidden in the tray has no window awake
//! enough to decide anything. Every `chat.message` frame of the live socket
//! comes through [`incoming`], which asks [`decide`] and then carries out the
//! answer. Messages that arrive through a resync (a reconnect, a sign-in)
//! are history catching up and notify nothing; the counters show them.
//!
//! ## The decision
//!
//! [`decide`] is pure, so the whole matrix is tested without a window. In
//! order, the first rule that matches wins:
//!
//! 1. The player's own message, or a system message: nothing.
//! 2. A mention of the player or a reply to the player's message is
//!    "mentioned".
//! 3. A muted conversation that does not mention the player: nothing. Its
//!    counter grows, and it is left out of the unread total; its mention
//!    count is not.
//! 4. A conversation set to mentions only, and no mention: nothing.
//! 5. A window shows the conversation, is focused and is scrolled to the
//!    bottom: nothing, the message is read the moment it lands.
//! 6. **Do not disturb**, or quiet hours (local time, across midnight):
//!    nothing, unless it mentions the player and **Mentions break through**
//!    is on (D7). Counters still grow, and a message silenced here is not
//!    kept for the summary after the game either.
//! 7. A game started from JKNet runs and **Do not disturb in game** is on:
//!    the message waits for the one summary after the game.
//! 8. Otherwise: a toast in the launcher window when it is focused, a
//!    Windows notification when no window of the launcher is, and a sound.
//!
//! ## What the player sees
//!
//! | Delivery | How |
//! | --- | --- |
//! | toast | `chat:notify {conversationId, seq, title, text, mention}` to `main` |
//! | Windows notification | `tauri-winrt-notification`; a click opens the conversation (`chat::window::open_conversation`) |
//! | sound | `PlaySoundW` on `resources/sounds/<soundName>/{message,mention}.wav` |
//! | summary | one Windows notification after the last game exits |
//!
//! The core has no translations. The few words it prints itself — "New
//! message" when the text is hidden, "Deleted account", the summary and the
//! hint of the first hide into the tray — come from the labels the main
//! window hands the tray (`tray::set_tray_labels`), in English until then.
//!
//! Windows shows a notification only for an application it knows by its
//! AppUserModelID. The installer gives the Start menu shortcut the bundle
//! identifier, `org.jknet.launcher`, as that ID; a debug build borrows the
//! ID of PowerShell, which every Windows has.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::launch::LaunchState;
use crate::online::{ChatMessage, Conversation};
use crate::settings::{is_chat_sound, ChatNotifications, QuietHours, DEFAULT_CHAT_SOUND};
use crate::state::AppState;

use super::{lock, my_id, ChatState};

/// A toast for the launcher window.
pub const EVENT_NOTIFY: &str = "chat:notify";

/// The launcher window, the only one that shows toasts.
const MAIN_LABEL: &str = "main";

/// One conversation raises at most one Windows notification this often; the
/// messages in between still count. A mention is never held back.
const OS_PACE: Duration = Duration::from_secs(3);

/// Sounds do not overlap: a burst of messages is one chime.
const SOUND_PACE: Duration = Duration::from_secs(1);

/// The longest text a toast carries. Windows cuts a notification much
/// shorter anyway; the rest of the message is one click away.
const MAX_TEXT_CHARS: usize = 200;

/// Messages kept for the summary after a game, so a game left running over
/// a weekend does not grow the list without end.
const MAX_HELD: usize = 1000;

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/// What the message is, as far as notifying goes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Incoming {
    /// Written by the player, on this device or another.
    pub own: bool,
    /// Written by the service: a member joined, the group was renamed.
    pub system: bool,
    /// It mentions the player or replies to a message of the player.
    pub mentioned: bool,
}

impl Incoming {
    pub fn of(message: &ChatMessage, me: Option<&str>) -> Incoming {
        // The service lists the author of the replied message among the
        // mentions; the reply itself is read too, for a service that does
        // not. A deleted account is nobody, so `None` never matches.
        let mentioned = me.is_some_and(|me| {
            message.mentions.iter().any(|id| id == me)
                || message
                    .reply_to
                    .as_ref()
                    .is_some_and(|reply| reply.sender_id.as_deref() == Some(me))
        });
        Incoming {
            own: message.is_from(me),
            system: !message.is_user(),
            mentioned,
        }
    }
}

/// The notification level of one conversation, set on the service.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Level {
    #[default]
    All,
    Mentions,
    Mute,
}

impl Level {
    /// Reads `notify` of a conversation. A value a newer service sends
    /// notifies like `all`: a missed message is worse than one toast too many.
    pub fn of(notify: &str) -> Level {
        match notify {
            "mute" => Level::Mute,
            "mentions" => Level::Mentions,
            _ => Level::All,
        }
    }
}

/// The conversation a message arrived in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConvCtx {
    pub notify: Level,
    /// A window shows it, focused and scrolled to the bottom.
    pub viewed: bool,
}

/// The launcher and the clock at the moment the message arrived.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NotifyCtx {
    /// Minutes since local midnight.
    pub minute_of_day: u16,
    /// A game started from JKNet is running.
    pub in_game: bool,
    /// The launcher window is on the screen and focused.
    pub main_focused: bool,
    /// Some window of the launcher is focused: the launcher, the chat window
    /// or a client window.
    pub any_focused: bool,
}

/// What a message gets. All `false` is silence; the counters grow anyway.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Delivery {
    /// A toast in the launcher window.
    pub in_app: bool,
    /// A Windows notification.
    pub os: bool,
    pub sound: bool,
    /// Kept for the one summary after the game.
    pub summary: bool,
}

impl Delivery {
    pub fn is_silent(&self) -> bool {
        *self == Delivery::default()
    }
}

/// Decides what one message deserves. The rules and their order are in the
/// module documentation.
pub fn decide(msg: &Incoming, conv: &ConvCtx, s: &ChatNotifications, ctx: &NotifyCtx) -> Delivery {
    let silent = Delivery::default();
    if msg.own || msg.system {
        return silent;
    }
    match conv.notify {
        Level::Mute | Level::Mentions if !msg.mentioned => return silent,
        _ => {}
    }
    if conv.viewed {
        return silent;
    }
    let quiet = s.dnd
        || s.quiet_hours
            .as_ref()
            .is_some_and(|range| in_quiet_hours(range, ctx.minute_of_day));
    if quiet && !(msg.mentioned && s.mentions_break_dnd) {
        return silent;
    }
    if ctx.in_game && s.dnd_in_game {
        return Delivery {
            summary: s.summary_after_game,
            ..silent
        };
    }
    Delivery {
        in_app: s.in_app && ctx.main_focused,
        os: s.os && !ctx.any_focused,
        sound: s.sound,
        summary: false,
    }
}

/// Whether a minute of the day falls inside quiet hours: from `from` up to,
/// not including, `to`. A range whose `to` comes first runs across midnight;
/// one whose ends are equal, or that does not parse, is never quiet.
pub fn in_quiet_hours(range: &QuietHours, minute_of_day: u16) -> bool {
    let Some((from, to)) = range.minutes() else {
        return false;
    };
    if from <= to {
        from <= minute_of_day && minute_of_day < to
    } else {
        minute_of_day >= from || minute_of_day < to
    }
}

// ---------------------------------------------------------------------------
// What notifications remember
// ---------------------------------------------------------------------------

/// One message kept for the summary after a game.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Held {
    conversation_id: String,
    seq: u64,
    mentioned: bool,
}

/// The messages waiting for the summary, and the pace of notifications and
/// sounds. Lives in [`ChatState`] and goes with the account.
#[derive(Debug, Default)]
pub(crate) struct NotifyBook {
    held: Vec<Held>,
    last_os: HashMap<String, Instant>,
    last_sound: Option<Instant>,
}

impl NotifyBook {
    fn hold(&mut self, conversation_id: &str, seq: u64, mentioned: bool) {
        if self.held.len() >= MAX_HELD
            || self
                .held
                .iter()
                .any(|held| held.conversation_id == conversation_id && held.seq == seq)
        {
            return;
        }
        self.held.push(Held {
            conversation_id: conversation_id.to_string(),
            seq,
            mentioned,
        });
    }

    fn take_held(&mut self) -> Vec<Held> {
        std::mem::take(&mut self.held)
    }

    /// Thins a delivery out to the pace: a Windows notification per
    /// conversation every [`OS_PACE`] unless it mentions the player, and a
    /// sound every [`SOUND_PACE`].
    fn pace(&mut self, conversation_id: &str, mentioned: bool, now: Instant, mut delivery: Delivery) -> Delivery {
        if delivery.os {
            let recent = self
                .last_os
                .get(conversation_id)
                .is_some_and(|at| now.duration_since(*at) < OS_PACE);
            if recent && !mentioned {
                delivery.os = false;
            } else {
                self.last_os.insert(conversation_id.to_string(), now);
            }
        }
        if delivery.sound {
            if self
                .last_sound
                .is_some_and(|at| now.duration_since(at) < SOUND_PACE)
            {
                delivery.sound = false;
            } else {
                self.last_sound = Some(now);
            }
        }
        delivery
    }
}

/// What the summary after a game counts: the held messages the player has
/// not read meanwhile (in the compact chat window over the game, say), of
/// conversations still there.
fn count_unread(held: &[Held], still_unread: impl Fn(&str, u64) -> bool) -> Summary {
    let mut conversations = HashSet::new();
    let mut messages = 0;
    let mut mentioned = false;
    let mut only = None;
    for message in held {
        if !still_unread(&message.conversation_id, message.seq) {
            continue;
        }
        messages += 1;
        mentioned |= message.mentioned;
        if conversations.insert(message.conversation_id.as_str()) {
            only = Some(message.conversation_id.clone());
        }
    }
    Summary {
        messages,
        conversations: conversations.len(),
        mentioned,
        only: if conversations.len() == 1 { only } else { None },
    }
}

/// The count behind the summary after a game.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Summary {
    messages: usize,
    conversations: usize,
    /// One of them mentions the player.
    mentioned: bool,
    /// The conversation, when there is only one: a click opens it.
    only: Option<String>,
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/// The words a notification is made of, from the labels of the main window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyTexts {
    pub new_message: String,
    pub deleted_account: String,
}

/// The title and the text of a toast for `message`.
///
/// A direct conversation is titled with the sender; a group or a server chat
/// with its title, and the sender goes in front of the text. `show_text`
/// off, the text only says that a message came.
pub fn compose(
    message: &ChatMessage,
    conversation: Option<&Conversation>,
    show_text: bool,
    texts: &NotifyTexts,
) -> (String, String) {
    let sender = name_of(message.sender_id.as_deref(), conversation, texts);
    let title = conversation
        .filter(|conversation| conversation.kind != "direct")
        .and_then(|conversation| conversation.title.as_deref())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    let text = if show_text {
        preview(message, conversation, texts)
    } else {
        texts.new_message.clone()
    };
    let (title, text) = match title {
        Some(title) if show_text => (title, format!("{sender}: {text}")),
        Some(title) => (title, text),
        None => (sender, text),
    };
    (line(&title), line(&text))
}

/// One printable line: white space collapsed, then control characters
/// dropped (Windows refuses them in the XML of a notification) and the
/// bidirectional overrides that could make a name or a text read backwards.
fn line(text: &str) -> String {
    collapse(text)
        .chars()
        .filter(|c| !c.is_control() && !is_bidi_control(*c))
        .collect()
}

fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// The name a member goes by in this conversation.
fn name_of(user_id: Option<&str>, conversation: Option<&Conversation>, texts: &NotifyTexts) -> String {
    let Some(user_id) = user_id else {
        return texts.deleted_account.clone();
    };
    conversation
        .and_then(|conversation| {
            conversation
                .members
                .iter()
                .find(|member| member.user.id == user_id)
        })
        .map(|member| member.user.display_name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "JKNet".to_string())
}

/// The text of a message on one line: mention tokens as `@name`, white space
/// collapsed, cut at [`MAX_TEXT_CHARS`]. A message without text shows what
/// its first card says of itself, or the names of its files.
fn preview(message: &ChatMessage, conversation: Option<&Conversation>, texts: &NotifyTexts) -> String {
    let mut text = collapse(&names_for_mentions(&message.body, conversation, texts));
    if text.is_empty() {
        text = message
            .cards
            .iter()
            .filter_map(|card| card.get("fallbackText").and_then(|value| value.as_str()))
            .map(collapse)
            .find(|text| !text.is_empty())
            .unwrap_or_default();
    }
    if text.is_empty() && !message.files.is_empty() {
        let names: Vec<&str> = message.files.iter().map(|file| file.name.as_str()).collect();
        text = collapse(&names.join(", "));
    }
    if text.is_empty() {
        text = texts.new_message.clone();
    }
    cut(text, MAX_TEXT_CHARS)
}

/// Replaces `<@id>` and `<@deleted>` with the names of the members.
fn names_for_mentions(body: &str, conversation: Option<&Conversation>, texts: &NotifyTexts) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("<@") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('>') {
            Some(end) if end > 0 && end <= 64 && !after[..end].contains(char::is_whitespace) => {
                let id = &after[..end];
                let name = if id == "deleted" {
                    texts.deleted_account.clone()
                } else {
                    name_of(Some(id), conversation, texts)
                };
                out.push('@');
                out.push_str(&name);
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str("<@");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One line: every run of white space, line breaks included, is one space.
fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Cuts a text to `max` characters, with an ellipsis when it was longer.
fn cut(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let mut short: String = text.chars().take(max.saturating_sub(1)).collect();
    short.push('…');
    short
}

/// Fills `{messages}` and `{chats}` of the summary label.
fn summary_text(template: &str, messages: usize, chats: usize) -> String {
    template
        .replace("{messages}", &messages.to_string())
        .replace("{chats}", &chats.to_string())
}

// ---------------------------------------------------------------------------
// Carrying it out
// ---------------------------------------------------------------------------

/// The `chat:notify` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyEvent {
    conversation_id: String,
    seq: u64,
    title: String,
    text: String,
    mention: bool,
}

/// Follows the games JKNet starts: the summary goes out when the game exits.
/// Called once from `chat::start`.
pub(super) fn start(app: &AppHandle) {
    let handle = app.clone();
    app.listen("launch:game-exited", move |_| {
        let handle = handle.clone();
        // Off the thread that emitted: the summary reads settings and may
        // show a notification.
        tauri::async_runtime::spawn(async move { after_game(&handle) });
    });
}

/// Decides and delivers the notification of one message of the live socket.
pub(super) fn incoming(app: &AppHandle, message: &ChatMessage) {
    let settings = match app.state::<AppState>().settings() {
        Ok(settings) => settings,
        Err(e) => {
            log::debug!("chat: no notification, the settings are unreadable: {e}");
            return;
        }
    };
    let chat = app.state::<ChatState>();
    let me = my_id(app);
    let conversation = chat.book().get(&message.conversation_id).cloned();
    let msg = Incoming::of(message, me.as_deref());
    let conv = ConvCtx {
        notify: Level::of(conversation.as_ref().map_or("all", |c| c.notify.as_str())),
        viewed: chat.is_viewed(&message.conversation_id),
    };
    let ctx = context(app);
    let s = &settings.chat_notifications;
    let decided = decide(&msg, &conv, s, &ctx);
    if decided.is_silent() {
        return;
    }
    if decided.summary {
        lock(&chat.notify).hold(&message.conversation_id, message.seq, msg.mentioned);
        return;
    }
    let delivery = lock(&chat.notify).pace(&message.conversation_id, msg.mentioned, Instant::now(), decided);
    log::debug!(
        "chat: message {}#{} notifies {delivery:?}",
        message.conversation_id,
        message.seq
    );

    let labels = crate::tray::labels(app);
    let texts = NotifyTexts {
        new_message: labels.new_message.clone(),
        deleted_account: labels.deleted_account.clone(),
    };
    let (title, text) = compose(message, conversation.as_ref(), s.show_text, &texts);
    if delivery.in_app {
        let event = NotifyEvent {
            conversation_id: message.conversation_id.clone(),
            seq: message.seq,
            title: title.clone(),
            text: text.clone(),
            mention: msg.mentioned,
        };
        if let Err(e) = app.emit_to(MAIN_LABEL, EVENT_NOTIFY, event) {
            log::debug!("cannot emit {EVENT_NOTIFY}: {e}");
        }
    }
    if delivery.os {
        show_toast(app, title, text, Some(Some(message.conversation_id.clone())));
    }
    if delivery.sound {
        play_sound(app, &s.sound_name, msg.mentioned);
    }
}

/// The launcher and the clock right now.
fn context(app: &AppHandle) -> NotifyCtx {
    use chrono::Timelike;
    let now = chrono::Local::now();
    let in_game = app
        .state::<LaunchState>()
        .current()
        .map(|game| game.is_some())
        .unwrap_or(false);
    let windows = app.webview_windows();
    let focused = |window: &tauri::WebviewWindow| {
        window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false)
    };
    NotifyCtx {
        minute_of_day: (now.hour() * 60 + now.minute()) as u16,
        in_game,
        main_focused: windows.get(MAIN_LABEL).is_some_and(focused),
        any_focused: windows.values().any(focused),
    }
}

/// The one notification after the last game exits: how many of the
/// messages held back are still unread, in how many conversations.
fn after_game(app: &AppHandle) {
    let chat = app.state::<ChatState>();
    let held = lock(&chat.notify).take_held();
    if held.is_empty() {
        return;
    }
    let summary = {
        let book = chat.book();
        count_unread(&held, |conversation_id, seq| {
            book.get(conversation_id)
                .is_some_and(|summary| seq > summary.read_seq)
        })
    };
    if summary.messages == 0 {
        return;
    }
    let Ok(settings) = app.state::<AppState>().settings() else {
        return;
    };
    let s = &settings.chat_notifications;
    if !s.summary_after_game {
        return;
    }
    // Do not disturb and quiet hours hold at the moment the game ends too,
    // with the same way through for mentions (D7).
    let quiet = s.dnd
        || s.quiet_hours
            .as_ref()
            .is_some_and(|range| in_quiet_hours(range, context(app).minute_of_day));
    if quiet && !(summary.mentioned && s.mentions_break_dnd) {
        return;
    }
    log::info!(
        "chat: {} message(s) in {} conversation(s) arrived during the game",
        summary.messages,
        summary.conversations
    );
    let labels = crate::tray::labels(app);
    let text = summary_text(&labels.summary, summary.messages, summary.conversations);
    show_toast(app, labels.summary_title.clone(), text, Some(summary.only));
    if s.sound {
        play_sound(app, &s.sound_name, summary.mentioned);
    }
}

/// Shows a Windows notification. `open` is what a click shows: `Some(None)`
/// the list of chats, `Some(Some(id))` a conversation, `None` the launcher
/// window.
pub(crate) fn show_toast(app: &AppHandle, title: String, text: String, open: Option<Option<String>>) {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        // The installer names the Start menu shortcut with the bundle
        // identifier; a debug build has no shortcut and borrows PowerShell's.
        let app_id = if cfg!(debug_assertions) {
            Toast::POWERSHELL_APP_ID.to_string()
        } else {
            app.config().identifier.clone()
        };
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let clicked = handle.clone();
            // The launcher plays its own sound, so the notification is mute.
            let toast = Toast::new(&app_id)
                .title(&title)
                .text1(&text)
                .sound(None)
                .on_activated(move |_| {
                    match open.clone() {
                        Some(conversation_id) => {
                            super::window::open_conversation(&clicked, conversation_id)
                        }
                        None => crate::tray::show_main(&clicked),
                    }
                    Ok(())
                });
            if let Err(e) = toast.show() {
                log::warn!("chat: cannot show a Windows notification: {e}");
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, open);
        log::debug!("chat: no notification area on this system: {title}: {text}");
    }
}

/// Plays the chat sound the player picked, the mention one for a mention.
pub(crate) fn play_sound(app: &AppHandle, sound_name: &str, mentioned: bool) {
    let Some(path) = sound_path(app, sound_name, mentioned) else {
        return;
    };
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated path that lives through the
        // call; with SND_ASYNC the function takes its own copy and returns.
        // No module handle: the sound is a file. SND_NODEFAULT keeps Windows
        // from beeping its own sound when the file cannot be played.
        let played = unsafe {
            PlaySoundW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                SND_FILENAME | SND_ASYNC | SND_NODEFAULT,
            )
        };
        if played == 0 {
            log::debug!("chat: cannot play {}", path.display());
        }
    }
    #[cfg(not(windows))]
    log::debug!("chat: no sound player on this system for {}", path.display());
}

/// The file of a sound. The folder next to the binary, where the installer
/// and `tauri_build` put it; a debug build whose target folder went stale
/// falls back to the repository, as the JKHub snapshots do.
fn sound_path(app: &AppHandle, sound_name: &str, mentioned: bool) -> Option<PathBuf> {
    let name = if is_chat_sound(sound_name) {
        sound_name
    } else {
        DEFAULT_CHAT_SOUND
    };
    let relative = sound_file(name, mentioned);
    if let Ok(path) = app
        .path()
        .resolve(&relative, tauri::path::BaseDirectory::Resource)
    {
        if path.is_file() {
            return Some(path);
        }
    }
    if cfg!(debug_assertions) {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&relative);
        if path.is_file() {
            return Some(path);
        }
    }
    log::warn!("chat: the sound {relative} is missing from this installation");
    None
}

/// Where a sound lies under the resource folder.
fn sound_file(name: &str, mentioned: bool) -> String {
    let kind = if mentioned { "mention" } else { "message" };
    format!("resources/sounds/{name}/{kind}.wav")
}

/// Plays a sound for the settings screen, so the player hears what a name
/// means before picking it. The settings are not read: the screen names the
/// sound it shows.
#[tauri::command]
pub async fn chat_preview_sound(app: AppHandle, sound_name: String, mention: Option<bool>) -> crate::error::Result<()> {
    if !is_chat_sound(&sound_name) {
        return Err(crate::error::AppError::InvalidInput(format!(
            "{sound_name:?} is not a chat sound"
        )));
    }
    play_sound(&app, &sound_name, mention.unwrap_or(false));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::online::{ChatMember, FileRef, OnlineUser};
    use crate::settings::CHAT_SOUNDS;

    fn quiet(from: &str, to: &str) -> QuietHours {
        QuietHours {
            from: from.into(),
            to: to.into(),
        }
    }

    const fn at(hours: u16, minutes: u16) -> u16 {
        hours * 60 + minutes
    }

    /// A plain message of a friend, nobody looking, launcher in the tray at
    /// noon, default settings: the Windows notification and the sound.
    fn plain() -> (Incoming, ConvCtx, ChatNotifications, NotifyCtx) {
        (
            Incoming::default(),
            ConvCtx::default(),
            ChatNotifications::default(),
            NotifyCtx {
                minute_of_day: at(12, 0),
                ..NotifyCtx::default()
            },
        )
    }

    const OS_AND_SOUND: Delivery = Delivery {
        in_app: false,
        os: true,
        sound: true,
        summary: false,
    };

    #[test]
    fn a_plain_message_to_a_launcher_in_the_tray_notifies_windows_and_plays() {
        let (msg, conv, s, ctx) = plain();
        assert_eq!(decide(&msg, &conv, &s, &ctx), OS_AND_SOUND);
    }

    #[test]
    fn own_and_system_messages_never_notify() {
        let (_, conv, s, ctx) = plain();
        for msg in [
            Incoming { own: true, ..Incoming::default() },
            Incoming { system: true, ..Incoming::default() },
            Incoming { own: true, mentioned: true, ..Incoming::default() },
            Incoming { system: true, mentioned: true, ..Incoming::default() },
        ] {
            assert!(decide(&msg, &conv, &s, &ctx).is_silent(), "{msg:?}");
        }
    }

    #[test]
    fn levels_let_mentions_through_and_nothing_else() {
        let (_, _, s, ctx) = plain();
        let plain_msg = Incoming::default();
        let mention = Incoming { mentioned: true, ..Incoming::default() };
        for (level, plain_notifies) in [(Level::All, true), (Level::Mentions, false), (Level::Mute, false)] {
            let conv = ConvCtx { notify: level, viewed: false };
            assert_eq!(!decide(&plain_msg, &conv, &s, &ctx).is_silent(), plain_notifies, "{level:?}");
            // A mention notifies at every level, muted chats included.
            assert_eq!(decide(&mention, &conv, &s, &ctx), OS_AND_SOUND, "{level:?}");
        }
        assert_eq!(Level::of("mute"), Level::Mute);
        assert_eq!(Level::of("mentions"), Level::Mentions);
        assert_eq!(Level::of("all"), Level::All);
        assert_eq!(Level::of("everything-new"), Level::All, "an unknown level notifies");
    }

    #[test]
    fn a_conversation_on_screen_is_read_not_notified() {
        let (_, _, s, ctx) = plain();
        let conv = ConvCtx { notify: Level::All, viewed: true };
        assert!(decide(&Incoming::default(), &conv, &s, &ctx).is_silent());
        let mention = Incoming { mentioned: true, ..Incoming::default() };
        assert!(decide(&mention, &conv, &s, &ctx).is_silent());
    }

    #[test]
    fn focus_picks_the_toast_or_the_windows_notification() {
        let (msg, conv, s, mut ctx) = plain();
        // The launcher window in front: a toast in it, and the sound.
        ctx.main_focused = true;
        ctx.any_focused = true;
        assert_eq!(
            decide(&msg, &conv, &s, &ctx),
            Delivery { in_app: true, os: false, sound: true, summary: false }
        );
        // The chat window or a client window in front: no toast (it is the
        // launcher window's), no Windows notification, the sound.
        ctx.main_focused = false;
        assert_eq!(
            decide(&msg, &conv, &s, &ctx),
            Delivery { in_app: false, os: false, sound: true, summary: false }
        );
        // Switches off stay off.
        let off = ChatNotifications { in_app: false, os: false, sound: false, ..ChatNotifications::default() };
        ctx.main_focused = true;
        assert!(decide(&msg, &conv, &off, &ctx).is_silent());
        ctx = NotifyCtx::default();
        assert!(decide(&msg, &conv, &off, &ctx).is_silent());
    }

    #[test]
    fn do_not_disturb_and_quiet_hours_silence_mentions_too_unless_they_break_through() {
        let (_, _, _, noon) = plain();
        let night = NotifyCtx { minute_of_day: at(23, 30), ..noon };
        let dnd = ChatNotifications { dnd: true, ..ChatNotifications::default() };
        let quiet_hours = ChatNotifications {
            quiet_hours: Some(quiet("23:00", "08:00")),
            ..ChatNotifications::default()
        };
        let plain_msg = Incoming::default();
        let mention = Incoming { mentioned: true, ..Incoming::default() };
        for level in [Level::All, Level::Mentions, Level::Mute] {
            let conv = ConvCtx { notify: level, viewed: false };
            for (s, ctx) in [(&dnd, &noon), (&quiet_hours, &night)] {
                // D7 off: everything is silent, mentions and replies included.
                assert!(decide(&plain_msg, &conv, s, ctx).is_silent(), "{level:?}");
                assert!(decide(&mention, &conv, s, ctx).is_silent(), "{level:?}");
                // D7 on: a mention or a reply notifies, in a muted chat too;
                // a plain message stays silent.
                let breaks = ChatNotifications { mentions_break_dnd: true, ..s.clone() };
                assert_eq!(decide(&mention, &conv, &breaks, ctx), OS_AND_SOUND, "{level:?}");
                assert!(decide(&plain_msg, &conv, &breaks, ctx).is_silent(), "{level:?}");
            }
            // Outside quiet hours the same settings notify as usual.
            if level == Level::All {
                assert_eq!(decide(&plain_msg, &conv, &quiet_hours, &noon), OS_AND_SOUND);
            }
        }
    }

    #[test]
    fn quiet_hours_run_across_midnight_and_an_empty_range_is_never_quiet() {
        let night = quiet("23:00", "08:00");
        for (minute, expected) in [
            (at(22, 59), false),
            (at(23, 0), true),
            (at(23, 59), true),
            (at(0, 0), true),
            (at(7, 59), true),
            (at(8, 0), false),
            (at(12, 0), false),
        ] {
            assert_eq!(in_quiet_hours(&night, minute), expected, "{minute}");
        }
        let lunch = quiet("12:00", "13:30");
        assert!(!in_quiet_hours(&lunch, at(11, 59)));
        assert!(in_quiet_hours(&lunch, at(12, 0)));
        assert!(in_quiet_hours(&lunch, at(13, 29)));
        assert!(!in_quiet_hours(&lunch, at(13, 30)));
        let empty = quiet("09:00", "09:00");
        assert!((0..24 * 60).all(|minute| !in_quiet_hours(&empty, minute)));
        // A range that does not parse silences nothing.
        let broken = quiet("23:00", "8");
        assert!((0..24 * 60).all(|minute| !in_quiet_hours(&broken, minute)));
    }

    #[test]
    fn a_game_holds_messages_for_the_summary() {
        let (msg, conv, s, mut ctx) = plain();
        ctx.in_game = true;
        assert_eq!(
            decide(&msg, &conv, &s, &ctx),
            Delivery { summary: true, ..Delivery::default() }
        );
        let mention = Incoming { mentioned: true, ..Incoming::default() };
        assert_eq!(
            decide(&mention, &conv, &s, &ctx),
            Delivery { summary: true, ..Delivery::default() }
        );
        // No summary wanted: the game keeps them silent all the same.
        let no_summary = ChatNotifications { summary_after_game: false, ..s.clone() };
        assert!(decide(&msg, &conv, &no_summary, &ctx).is_silent());
        // Do not disturb in game off: notified as usual.
        let loud = ChatNotifications { dnd_in_game: false, ..s.clone() };
        assert_eq!(decide(&msg, &conv, &loud, &ctx), OS_AND_SOUND);
        // Silenced by DND first: not kept for the summary either.
        let dnd = ChatNotifications { dnd: true, ..s.clone() };
        assert!(decide(&msg, &conv, &dnd, &ctx).is_silent());
        // A muted chat is not in the summary; its mention is.
        let muted = ConvCtx { notify: Level::Mute, viewed: false };
        assert!(decide(&msg, &muted, &s, &ctx).is_silent());
        assert!(decide(&mention, &muted, &s, &ctx).summary);
    }

    /// Every combination of the inputs keeps the promises that do not depend
    /// on the order of the rules.
    #[test]
    fn the_whole_matrix_keeps_its_promises() {
        const SWITCHES: u32 = 11;
        let levels = [Level::All, Level::Mentions, Level::Mute];
        let minutes = [at(3, 0), at(12, 0), at(23, 30)];
        let mut cases = 0;
        for bits in 0..1u32 << SWITCHES {
        for level in levels {
        for minute in minutes {
            cases += 1;
            let on = |bit: u32| bits & (1 << bit) != 0;
            let (own, system, mentioned, viewed) = (on(0), on(1), on(2), on(3));
            let (dnd, breaks, has_range, in_game) = (on(4), on(5), on(6), on(7));
            let (dnd_in_game, main_focused, other_focused) = (on(8), on(9), on(10));
            let range = has_range.then(|| quiet("23:00", "08:00"));
            let msg = Incoming { own, system, mentioned };
            let conv = ConvCtx { notify: level, viewed };
            let s = ChatNotifications {
                dnd,
                mentions_break_dnd: breaks,
                quiet_hours: range.clone(),
                dnd_in_game,
                ..ChatNotifications::default()
            };
            let range = range.as_ref();
            let ctx = NotifyCtx {
                minute_of_day: minute,
                in_game,
                main_focused,
                any_focused: main_focused || other_focused,
            };
            let d = decide(&msg, &conv, &s, &ctx);
            let quiet_now = dnd || range.is_some_and(|r| in_quiet_hours(r, minute));
            let case = format!("{msg:?} {conv:?} {s:?} {ctx:?} -> {d:?}");
            if own || system || viewed {
                assert!(d.is_silent(), "{case}");
            }
            if level != Level::All && !mentioned {
                assert!(d.is_silent(), "{case}");
            }
            if quiet_now && !(mentioned && breaks) {
                assert!(d.is_silent(), "{case}");
            }
            if in_game && dnd_in_game {
                assert!(!d.in_app && !d.os && !d.sound, "{case}");
            }
            if d.summary {
                assert!(in_game && dnd_in_game && !d.in_app && !d.os && !d.sound, "{case}");
            }
            assert!(!(d.in_app && d.os), "a toast and a notification never both: {case}");
            assert!(!d.in_app || main_focused, "{case}");
            assert!(!d.os || !(main_focused || other_focused), "{case}");
            // And the one case that must notify: a mention that breaks
            // through, nobody looking, no game.
            if !own && !system && mentioned && !viewed && breaks && !(in_game && dnd_in_game) {
                assert!(!d.is_silent(), "{case}");
            }
        }
        }
        }
        assert_eq!(cases, (1 << SWITCHES) * 3 * 3);
    }

    #[test]
    fn a_mention_or_a_reply_to_the_player_counts_as_mentioned() {
        let mut message = message("c", 5, Some(KYLE));
        assert!(!Incoming::of(&message, Some(ME)).mentioned);
        message.mentions = vec![ME.into()];
        assert!(Incoming::of(&message, Some(ME)).mentioned);
        message.mentions.clear();
        message.reply_to = Some(
            serde_json::from_value(serde_json::json!({ "seq": 2, "senderId": ME, "excerpt": "gg" }))
                .expect("a reply"),
        );
        assert!(Incoming::of(&message, Some(ME)).mentioned);
        // Signed out, nobody is mentioned; a deleted account is nobody.
        assert!(!Incoming::of(&message, None).mentioned);
        message.reply_to.as_mut().expect("reply").sender_id = None;
        assert!(!Incoming::of(&message, Some(ME)).mentioned);

        let own = super::super::test_support::message("c", 6, Some(ME));
        assert!(Incoming::of(&own, Some(ME)).own);
        let deleted = super::super::test_support::message("c", 7, None);
        assert!(!Incoming::of(&deleted, Some(ME)).own, "a deleted account is never the player");
        let mut system = super::super::test_support::message("c", 8, None);
        system.kind = "system".into();
        assert!(Incoming::of(&system, Some(ME)).system);
    }

    fn texts() -> NotifyTexts {
        NotifyTexts {
            new_message: "New message".into(),
            deleted_account: "Deleted account".into(),
        }
    }

    #[test]
    fn a_direct_message_is_titled_with_its_sender() {
        let conversation = conversation("c", 4, 4);
        let mut m = message("c", 5, Some(KYLE));
        m.body = "gg\n\n  <@01HME000000000000000000000> rematch?".into();
        let (title, text) = compose(&m, Some(&conversation), true, &texts());
        assert_eq!(title, KYLE, "test members are named by their id");
        assert_eq!(text, format!("gg @{ME} rematch?"));
        // Text hidden: only that a message came.
        assert_eq!(
            compose(&m, Some(&conversation), false, &texts()),
            (KYLE.to_string(), "New message".to_string())
        );
    }

    #[test]
    fn a_group_message_is_titled_with_the_group_and_names_its_sender() {
        let mut group = conversation("g", 1, 1);
        group.kind = "group".into();
        group.title = Some("Saber school".into());
        group.members.push(ChatMember {
            user: OnlineUser { display_name: "Jan Ors".into(), ..user("01HJAN") },
            ..ChatMember::default()
        });
        let mut m = message("g", 2, Some("01HJAN"));
        m.body = "<@deleted> left, <@01HJAN> stays, <@ broken".into();
        let (title, text) = compose(&m, Some(&group), true, &texts());
        assert_eq!(title, "Saber school");
        assert_eq!(text, "Jan Ors: @Deleted account left, @Jan Ors stays, <@ broken");
        let (title, text) = compose(&m, Some(&group), false, &texts());
        assert_eq!((title.as_str(), text.as_str()), ("Saber school", "New message"));

        // An untitled group is titled with the sender; a deleted account's
        // message with "Deleted account".
        group.title = None;
        let mut gone = message("g", 3, None);
        gone.body = "still here".into();
        assert_eq!(
            compose(&gone, Some(&group), true, &texts()),
            ("Deleted account".to_string(), "still here".to_string())
        );
        // A conversation the core does not know yet still gets a title.
        assert_eq!(compose(&gone, None, true, &texts()).0, "Deleted account");
        assert_eq!(compose(&m, None, true, &texts()).0, "JKNet");
    }

    #[test]
    fn a_message_without_text_shows_its_card_or_its_files() {
        let conversation = conversation("c", 1, 1);
        let mut m = message("c", 2, Some(KYLE));
        m.body = "   ".into();
        m.cards = vec![serde_json::json!({ "type": "map", "fallbackText": "Map: Bespin (mp/duel7)" })];
        assert_eq!(compose(&m, Some(&conversation), true, &texts()).1, "Map: Bespin (mp/duel7)");
        m.cards.clear();
        m.files = vec![
            FileRef { id: "f1".into(), name: "shot.png".into(), ..FileRef::default() },
            FileRef { id: "f2".into(), name: "duel.dm_26".into(), ..FileRef::default() },
        ];
        assert_eq!(compose(&m, Some(&conversation), true, &texts()).1, "shot.png, duel.dm_26");
        m.files.clear();
        assert_eq!(compose(&m, Some(&conversation), true, &texts()).1, "New message");
        // A long text is cut.
        m.body = "a".repeat(500);
        let text = compose(&m, Some(&conversation), true, &texts()).1;
        assert_eq!(text.chars().count(), MAX_TEXT_CHARS);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn a_hostile_text_reaches_the_notification_as_one_plain_line() {
        let mut conversation = conversation("c", 1, 1);
        conversation.members[1].user.display_name = "Ky\u{202E}le\u{0007}".into();
        let mut m = message("c", 2, Some(KYLE));
        m.body = "<toast>&amp;\u{0000}\u{2066}evil\u{2069}\r\n\tdone".into();
        let (title, text) = compose(&m, Some(&conversation), true, &texts());
        assert_eq!(title, "Kyle");
        // Markup stays text: the notification crate escapes it.
        assert_eq!(text, "<toast>&amp;evil done");
    }

    #[test]
    fn notifications_keep_a_pace_and_mentions_skip_the_queue() {
        let mut book = NotifyBook::default();
        let start = Instant::now();
        let all = Delivery { in_app: false, os: true, sound: true, summary: false };
        assert_eq!(book.pace("c", false, start, all), all);
        // Half a second later, same conversation: no second notification or
        // chime.
        let soon = start + Duration::from_millis(500);
        assert!(book.pace("c", false, soon, all).is_silent());
        // Another conversation gets its notification; the chime still waits.
        assert_eq!(
            book.pace("d", false, soon, all),
            Delivery { sound: false, ..all }
        );
        // A mention is never held back.
        let later = start + Duration::from_millis(1500);
        assert_eq!(book.pace("c", true, later, all), all);
        // After the pace, a plain message notifies again.
        let much_later = start + Duration::from_secs(5);
        assert_eq!(book.pace("c", false, much_later, all), all);
    }

    #[test]
    fn the_summary_counts_what_is_still_unread() {
        let mut book = NotifyBook::default();
        book.hold("a", 1, false);
        book.hold("a", 1, false); // the same message twice counts once
        book.hold("a", 2, true);
        book.hold("b", 7, false);
        book.hold("gone", 3, false);
        let held = book.take_held();
        assert!(book.take_held().is_empty(), "taken once");
        // `a` was read up to 1 in the compact window; `gone` was left.
        let summary = count_unread(&held, |id, seq| match id {
            "a" => seq > 1,
            "b" => true,
            _ => false,
        });
        assert_eq!(
            summary,
            Summary { messages: 2, conversations: 2, mentioned: true, only: None }
        );
        let one = count_unread(&held, |id, _| id == "b");
        assert_eq!(one.only.as_deref(), Some("b"));
        assert_eq!(summary_text("Messages: {messages}, chats: {chats}", 12, 3), "Messages: 12, chats: 3");
    }

    #[test]
    fn every_sound_has_both_files_in_the_repository() {
        for name in CHAT_SOUNDS {
            for mentioned in [false, true] {
                let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(sound_file(name, mentioned));
                let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
                assert_eq!(&bytes[..4], b"RIFF", "{}", path.display());
                assert_eq!(&bytes[8..12], b"WAVE", "{}", path.display());
                assert!(bytes.len() < 64 * 1024, "a chime, not a song: {}", path.display());
            }
        }
    }
}
