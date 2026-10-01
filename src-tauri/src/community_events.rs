//! The events of communities in the core: the `community.event` frames of
//! the live socket, the notifications they become and the calendar file of
//! an event. The cover of an event goes up through `community_images`, the
//! same dialog and checks as the logo and the cover of a community.
//!
//! ## Frames
//!
//! The service sends `community.event` with `kind` = `created`, `changed`,
//! `cancelled` or `reminder` and a summary of the event (`notify.rs` of the
//! service). Every frame reaches every window as `community:event`, so the
//! calendar, the page of the event and the sidebar's count read again. What
//! the player is told is decided here, by [`decide`], from the switches of
//! **Community notifications** (`settings::CommunityNotifications`):
//!
//! | Frame | Switch | Toast | Windows notification |
//! | --- | --- | --- | --- |
//! | `created` | **New events of your subscriptions** | yes | while no launcher window is focused and **Windows notifications** is on |
//! | `reminder` | **Remind of events 15 minutes before** | yes | the same |
//! | `changed`, `cancelled` | none: they always come | yes | the same |
//!
//! A click on the Windows notification brings the launcher window back and
//! sends it `community:open-event`, which opens `#/events/:id`.
//!
//! The news of a community come as `community.post`, with a summary of the
//! post: its title and the start of its text. They reach every window as
//! `community:post` and follow **News of your subscriptions** the way a new
//! event follows its switch ([`decide_post`]); a click on the Windows
//! notification sends `community:open-post`, which opens the **News** tab of
//! the community.
//!
//! The core has no translations: the words of the notifications are the
//! labels the launcher window hands over with
//! [`community_event_labels`], in English until then. A label holds
//! `{community}`, `{title}`, `{when}` and `{place}`; `{when}` is the local
//! time of the start as `YYYY-MM-DD HH:MM`, which reads the same in every
//! language.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::settings::CommunityNotifications;
use crate::state::AppState;

/// Every window: a frame arrived, with what it deserves.
pub const EVENT_FRAME: &str = "community:event";
/// The launcher window: open the page of an event.
pub const EVENT_OPEN: &str = "community:open-event";
/// Every window: a post of the news arrived, with what it deserves.
pub const POST_FRAME: &str = "community:post";
/// The launcher window: open the news of a community.
pub const POST_OPEN: &str = "community:open-post";

const MAIN_LABEL: &str = "main";

/// The longest title and name a notification carries.
const MAX_LINE_CHARS: usize = 120;
/// The largest calendar file the launcher writes.
const MAX_ICS_BYTES: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/// Why the service sent a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameKind {
    Created,
    Changed,
    Cancelled,
    Reminder,
}

impl FrameKind {
    fn of(value: &str) -> Option<FrameKind> {
        match value {
            "created" => Some(FrameKind::Created),
            "changed" => Some(FrameKind::Changed),
            "cancelled" => Some(FrameKind::Cancelled),
            "reminder" => Some(FrameKind::Reminder),
            _ => None,
        }
    }
}

/// The event a frame names, as the service sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummary {
    pub id: String,
    pub community_id: String,
    pub community_name: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    /// Where to connect, or `None` for an event outside the game.
    #[serde(default)]
    pub address: Option<String>,
}

/// One `community.event` frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventFrame {
    pub kind: FrameKind,
    pub event: EventSummary,
}

/// A ULID of the service: 26 letters and digits.
fn is_id(value: &str) -> bool {
    value.len() == 26 && value.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Reads the payload of a frame, or `None` for a kind this launcher does not
/// know or a summary of another shape: a newer service may send more.
pub fn parse(payload: Value) -> Option<EventFrame> {
    #[derive(Deserialize)]
    struct Wire {
        kind: String,
        event: EventSummary,
    }
    let wire: Wire = serde_json::from_value(payload).ok()?;
    let kind = FrameKind::of(&wire.kind)?;
    if !is_id(&wire.event.id) || !is_id(&wire.event.community_id) {
        return None;
    }
    Some(EventFrame {
        kind,
        event: wire.event,
    })
}

/// What a frame deserves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Delivery {
    /// A toast in the launcher window.
    pub toast: bool,
    /// A Windows notification.
    pub os: bool,
}

/// The rules of the table in the module's documentation. `focused`: a window
/// of the launcher has the focus, so the toast is enough.
pub fn decide(kind: FrameKind, settings: &CommunityNotifications, focused: bool) -> Delivery {
    let wanted = match kind {
        FrameKind::Created => settings.new_events,
        FrameKind::Reminder => settings.reminders,
        FrameKind::Changed | FrameKind::Cancelled => true,
    };
    Delivery {
        toast: wanted,
        os: wanted && settings.os && !focused,
    }
}

/// What every window hears of a frame.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventNotice {
    pub kind: FrameKind,
    pub event: EventSummary,
    /// The settings let a toast through.
    pub toast: bool,
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

/// The post a `community.post` frame names, as the service sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSummary {
    pub id: String,
    pub community_id: String,
    pub community_name: String,
    /// One line, or empty: a post may have no title.
    #[serde(default)]
    pub title: String,
    /// The start of the text without its Markdown.
    #[serde(default)]
    pub excerpt: String,
}

/// Reads the payload of a `community.post` frame, or `None` for a summary
/// of another shape.
pub fn parse_post(payload: Value) -> Option<PostSummary> {
    #[derive(Deserialize)]
    struct Wire {
        post: PostSummary,
    }
    let wire: Wire = serde_json::from_value(payload).ok()?;
    (is_id(&wire.post.id) && is_id(&wire.post.community_id)).then_some(wire.post)
}

/// The rule of a post: a toast while **News of your subscriptions** is on,
/// a Windows notification as for an event.
pub fn decide_post(settings: &CommunityNotifications, focused: bool) -> Delivery {
    Delivery {
        toast: settings.news,
        os: settings.news && settings.os && !focused,
    }
}

/// What every window hears of a `community.post` frame.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostNotice {
    pub post: PostSummary,
    /// The settings let a toast through.
    pub toast: bool,
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/// The words of the Windows notifications, finished in the language on
/// screen except for the slots `{community}`, `{title}`, `{when}`, `{place}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EventLabels {
    pub created: String,
    pub created_text: String,
    pub changed: String,
    pub changed_text: String,
    pub cancelled: String,
    pub cancelled_text: String,
    pub reminder: String,
    pub reminder_text: String,
    /// The place of an event outside the game.
    pub offline: String,
    /// The title of a post's notification: `{community}`.
    pub post: String,
}

impl Default for EventLabels {
    fn default() -> Self {
        EventLabels {
            created: "{community} announced an event".into(),
            created_text: "{title} · {when}".into(),
            changed: "Event changed: {title}".into(),
            changed_text: "{community} · {when}".into(),
            cancelled: "Event cancelled: {title}".into(),
            cancelled_text: "{community} · {when}".into(),
            reminder: "In 15 minutes: {title}".into(),
            reminder_text: "{community} · {place}".into(),
            offline: "Outside the game".into(),
            post: "News from {community}".into(),
        }
    }
}

/// The labels the launcher window handed over.
#[derive(Default)]
pub struct CommunityEventsState {
    labels: Mutex<EventLabels>,
}

impl CommunityEventsState {
    fn labels(&self) -> EventLabels {
        self.labels
            .lock()
            .map(|labels| labels.clone())
            .unwrap_or_default()
    }
}

/// One printable line: white space collapsed, control and bidirectional
/// characters dropped, cut at [`MAX_LINE_CHARS`]. Windows refuses control
/// characters in the XML of a notification.
fn line(text: &str) -> String {
    let clean: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    if clean.chars().count() <= MAX_LINE_CHARS {
        return clean;
    }
    let mut short: String = clean.chars().take(MAX_LINE_CHARS - 1).collect();
    short.push('…');
    short
}

/// The start in local time, `YYYY-MM-DD HH:MM`, or the text as it came.
fn local_when(starts_at: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(starts_at) {
        Ok(at) => at
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string(),
        Err(_) => starts_at.to_string(),
    }
}

/// Fills the slots of a label. A value never fills a slot of another value:
/// each slot is replaced once, in one pass over the template.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 64);
    let mut rest = template;
    'outer: while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        for (name, value) in values {
            let slot = format!("{{{name}}}");
            if after.starts_with(&slot) {
                out.push_str(value);
                rest = &after[slot.len()..];
                continue 'outer;
            }
        }
        out.push('{');
        rest = &after[1..];
    }
    out.push_str(rest);
    out
}

/// The title and the text of the Windows notification of a frame.
pub fn compose(frame: &EventFrame, labels: &EventLabels, when: &str) -> (String, String) {
    let event = &frame.event;
    let community = line(&event.community_name);
    let title = line(&event.title);
    let place = match event.address.as_deref() {
        Some(address) if !address.trim().is_empty() => line(address),
        _ => line(&labels.offline),
    };
    let values = [
        ("community", community.as_str()),
        ("title", title.as_str()),
        ("when", when),
        ("place", place.as_str()),
    ];
    let (head, body) = match frame.kind {
        FrameKind::Created => (&labels.created, &labels.created_text),
        FrameKind::Changed => (&labels.changed, &labels.changed_text),
        FrameKind::Cancelled => (&labels.cancelled, &labels.cancelled_text),
        FrameKind::Reminder => (&labels.reminder, &labels.reminder_text),
    };
    (line(&fill(head, &values)), line(&fill(body, &values)))
}

/// The title and the text of the Windows notification of a post: the label
/// with the community, then the post's title and the start of its text.
pub fn compose_post(post: &PostSummary, labels: &EventLabels) -> (String, String) {
    let community = line(&post.community_name);
    let title = line(&post.title);
    let excerpt = line(&post.excerpt);
    let head = line(&fill(&labels.post, &[("community", community.as_str())]));
    let body = match (title.is_empty(), excerpt.is_empty()) {
        (false, false) => line(&format!("{title} · {excerpt}")),
        (false, true) => title,
        (true, _) => excerpt,
    };
    (head, body)
}

// ---------------------------------------------------------------------------
// Carrying it out
// ---------------------------------------------------------------------------

/// Whether a window of the launcher is on the screen and has the focus.
fn any_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false))
}

/// One `community.event` frame of the live socket: every window hears it,
/// and the player is told as [`decide`] says.
pub fn frame(app: &AppHandle, payload: Value) {
    let Some(frame) = parse(payload) else {
        log::debug!("live frame community.event of another shape ignored");
        return;
    };
    let settings = app
        .state::<AppState>()
        .settings()
        .map(|settings| settings.community_notifications)
        .unwrap_or_default();
    let delivery = decide(frame.kind, &settings, any_focused(app));
    log::debug!(
        "community event {} {:?} notifies {delivery:?}",
        frame.event.id,
        frame.kind
    );
    let notice = EventNotice {
        kind: frame.kind,
        event: frame.event.clone(),
        toast: delivery.toast,
    };
    if let Err(e) = app.emit(EVENT_FRAME, notice) {
        log::debug!("cannot emit {EVENT_FRAME}: {e}");
    }
    if delivery.os {
        let labels = app.state::<CommunityEventsState>().labels();
        let (title, text) = compose(&frame, &labels, &local_when(&frame.event.starts_at));
        let id = frame.event.id.clone();
        crate::chat::notify::show_toast_with(app, title, text, move |clicked| open_event(clicked, &id));
    }
}

/// Brings the launcher window back on the page of an event.
pub fn open_event(app: &AppHandle, event_id: &str) {
    crate::tray::show_main(app);
    if let Err(e) = app.emit_to(MAIN_LABEL, EVENT_OPEN, event_id.to_string()) {
        log::debug!("cannot emit {EVENT_OPEN}: {e}");
    }
}

/// One `community.post` frame of the live socket: every window hears it,
/// and the player is told as [`decide_post`] says.
pub fn post_frame(app: &AppHandle, payload: Value) {
    let Some(post) = parse_post(payload) else {
        log::debug!("live frame community.post of another shape ignored");
        return;
    };
    let settings = app
        .state::<AppState>()
        .settings()
        .map(|settings| settings.community_notifications)
        .unwrap_or_default();
    let delivery = decide_post(&settings, any_focused(app));
    log::debug!("community post {} notifies {delivery:?}", post.id);
    let notice = PostNotice {
        post: post.clone(),
        toast: delivery.toast,
    };
    if let Err(e) = app.emit(POST_FRAME, notice) {
        log::debug!("cannot emit {POST_FRAME}: {e}");
    }
    if delivery.os {
        let labels = app.state::<CommunityEventsState>().labels();
        let (title, text) = compose_post(&post, &labels);
        let community = post.community_id.clone();
        crate::chat::notify::show_toast_with(app, title, text, move |clicked| open_post(clicked, &community));
    }
}

/// Brings the launcher window back on the news of a community.
pub fn open_post(app: &AppHandle, community_id: &str) {
    crate::tray::show_main(app);
    if let Err(e) = app.emit_to(MAIN_LABEL, POST_OPEN, community_id.to_string()) {
        log::debug!("cannot emit {POST_OPEN}: {e}");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The words of the Windows notifications of events, in the language on screen.
#[tauri::command]
pub fn community_event_labels(
    state: tauri::State<'_, CommunityEventsState>,
    labels: EventLabels,
) -> Result<()> {
    let mut current = state
        .labels
        .lock()
        .map_err(|_| AppError::State("the labels of event notifications are poisoned".into()))?;
    *current = labels;
    Ok(())
}

/// The name a calendar file is offered under: letters, digits, `-`, `_`,
/// `.` and spaces of the name asked for, ending in `.ics`.
pub fn ics_file_name(asked: &str) -> String {
    let kept: String = asked
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .take(80)
        .collect();
    let stem = kept.trim().trim_end_matches(".ics").trim_matches('.').trim();
    if stem.is_empty() {
        "event.ics".to_string()
    } else {
        format!("{stem}.ics")
    }
}

/// Whether a text is a calendar file this launcher wrote: one `VCALENDAR`
/// of reasonable size.
pub fn is_calendar(text: &str) -> bool {
    text.len() <= MAX_ICS_BYTES
        && text.starts_with("BEGIN:VCALENDAR\r\n")
        && text.ends_with("END:VCALENDAR\r\n")
}

/// Saves the calendar file of an event where the player says: the system's
/// save dialog, then the text as it came. `None`: the dialog was cancelled.
#[tauri::command]
pub async fn community_save_ics(
    app: AppHandle,
    window: tauri::Window,
    name: String,
    text: String,
) -> Result<Option<String>> {
    if !is_calendar(&text) {
        return Err(AppError::InvalidInput("not a calendar file of an event".into()));
    }
    let name = ics_file_name(&name);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_file_name(&name)
        .add_filter("iCalendar", &["ics"])
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let Some(target) = rx
        .await
        .ok()
        .flatten()
        .and_then(|path| path.into_path().ok())
    else {
        return Ok(None);
    };
    let written = target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&written, text.as_bytes()).map_err(|e| AppError::io_path("cannot save", &written, e))
    })
    .await
    .map_err(|e| AppError::State(format!("saving the calendar file did not finish: {e}")))??;
    log::info!("community events: saved a calendar file as {}", target.display());
    Ok(Some(
        target
            .file_name()
            .map(|file| file.to_string_lossy().into_owned())
            .unwrap_or(name),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EVENT: &str = "01M3T9GB85ZXHWXZKTXE4CAD09";
    const COMMUNITY: &str = "01M3T9GB7Z88GC0R33HAT705C0";

    /// The `changed` frame of the service's test, `payload` only.
    fn changed() -> Value {
        json!({
            "kind": "changed",
            "event": {
                "id": EVENT,
                "communityId": COMMUNITY,
                "communityName": "Duel Masters",
                "title": "Duel Cup",
                "startsAt": "2026-10-02T00:13:28Z",
                "endsAt": "2026-10-02T03:13:28Z",
                "address": "1.1.1.1:29070"
            }
        })
    }

    #[test]
    fn a_frame_of_the_service_reads_whole() {
        let frame = parse(changed()).expect("the frame of the service reads");
        assert_eq!(frame.kind, FrameKind::Changed);
        assert_eq!(frame.event.id, EVENT);
        assert_eq!(frame.event.community_id, COMMUNITY);
        assert_eq!(frame.event.community_name, "Duel Masters");
        assert_eq!(frame.event.title, "Duel Cup");
        assert_eq!(frame.event.starts_at, "2026-10-02T00:13:28Z");
        assert_eq!(frame.event.address.as_deref(), Some("1.1.1.1:29070"));
        for kind in ["created", "cancelled", "reminder"] {
            let mut payload = changed();
            payload["kind"] = json!(kind);
            assert!(parse(payload).is_some(), "{kind} reads");
        }
    }

    #[test]
    fn an_event_outside_the_game_has_no_address() {
        let mut payload = changed();
        payload["kind"] = json!("reminder");
        payload["event"]["address"] = Value::Null;
        assert_eq!(parse(payload).expect("reads").event.address, None);
        let mut missing = changed();
        missing["event"].as_object_mut().unwrap().remove("address");
        assert_eq!(parse(missing).expect("reads").event.address, None);
    }

    #[test]
    fn frames_of_another_shape_are_left_alone() {
        let mut unknown = changed();
        unknown["kind"] = json!("rescheduled");
        assert!(parse(unknown).is_none(), "a kind of a newer service");
        let mut bad_id = changed();
        bad_id["event"]["id"] = json!("../me");
        assert!(parse(bad_id).is_none());
        let mut no_title = changed();
        no_title["event"].as_object_mut().unwrap().remove("title");
        assert!(parse(no_title).is_none());
        assert!(parse(json!({ "kind": "created" })).is_none());
        assert!(parse(json!("created")).is_none());
        // A field the launcher does not know yet is no reason to drop the frame.
        let mut more = changed();
        more["event"]["cover"] = json!("abc");
        more["extra"] = json!(1);
        assert!(parse(more).is_some());
    }

    #[test]
    fn the_switches_decide_the_toast_and_the_windows_notification() {
        let on = CommunityNotifications::default();
        let quiet = CommunityNotifications {
            new_events: false,
            reminders: false,
            news: false,
            os: true,
        };
        let no_os = CommunityNotifications {
            os: false,
            ..CommunityNotifications::default()
        };
        let both = Delivery { toast: true, os: true };
        let toast = Delivery { toast: true, os: false };
        let nothing = Delivery::default();
        // (kind, settings, focused) -> delivery
        let table = [
            (FrameKind::Created, &on, false, both),
            (FrameKind::Created, &on, true, toast),
            (FrameKind::Created, &quiet, false, nothing),
            (FrameKind::Created, &no_os, false, toast),
            (FrameKind::Reminder, &on, false, both),
            (FrameKind::Reminder, &quiet, false, nothing),
            (FrameKind::Reminder, &no_os, true, toast),
            // A change and a cancellation of an answered event always come.
            (FrameKind::Changed, &quiet, false, both),
            (FrameKind::Cancelled, &quiet, true, toast),
            (FrameKind::Cancelled, &no_os, false, toast),
        ];
        for (kind, settings, focused, want) in table {
            assert_eq!(decide(kind, settings, focused), want, "{kind:?} {settings:?} focused={focused}");
        }
    }

    #[test]
    fn the_notification_fills_the_labels_with_plain_lines() {
        let frame = parse(changed()).unwrap();
        let labels = EventLabels::default();
        let (title, text) = compose(&frame, &labels, "2026-10-02 03:13");
        assert_eq!(title, "Event changed: Duel Cup");
        assert_eq!(text, "Duel Masters · 2026-10-02 03:13");

        let mut reminder = frame.clone();
        reminder.kind = FrameKind::Reminder;
        assert_eq!(compose(&reminder, &labels, "x").1, "Duel Masters · 1.1.1.1:29070");
        reminder.event.address = None;
        assert_eq!(compose(&reminder, &labels, "x").1, "Duel Masters · Outside the game");

        // Russian labels, as the window hands them over.
        let russian = EventLabels {
            created: "{community} объявило событие".into(),
            created_text: "{title} · {when}".into(),
            ..EventLabels::default()
        };
        let mut created = frame.clone();
        created.kind = FrameKind::Created;
        created.event.title = "Турнир дуэлей:\nКубок осени\u{202E}".into();
        let (title, text) = compose(&created, &russian, "2026-10-03 19:00");
        assert_eq!(title, "Duel Masters объявило событие");
        assert_eq!(text, "Турнир дуэлей: Кубок осени · 2026-10-03 19:00");

        // A value that looks like a slot stays text.
        let mut tricky = frame.clone();
        tricky.event.title = "{community}".into();
        assert_eq!(compose(&tricky, &labels, "x").0, "Event changed: {community}");

        // A long title is cut.
        let mut long = frame;
        long.event.title = "x".repeat(500);
        assert!(compose(&long, &labels, "x").0.chars().count() <= MAX_LINE_CHARS);
    }

    /// The `community.post` frame of the service's test, `payload` only.
    fn post() -> Value {
        json!({
            "post": {
                "communityId": COMMUNITY,
                "communityName": "Duel Masters",
                "excerpt": "Ladder The ladder opens on Friday at the arena.",
                "id": EVENT,
                "title": "Season two"
            }
        })
    }

    #[test]
    fn a_post_of_the_service_reads_whole_and_others_are_left_alone() {
        let read = parse_post(post()).expect("the frame of the service reads");
        assert_eq!(read.id, EVENT);
        assert_eq!(read.community_id, COMMUNITY);
        assert_eq!(read.community_name, "Duel Masters");
        assert_eq!(read.title, "Season two");
        assert_eq!(read.excerpt, "Ladder The ladder opens on Friday at the arena.");
        // A post without a title, and a field the launcher does not know yet.
        let mut untitled = post();
        untitled["post"]["title"] = json!("");
        untitled["post"]["pinned"] = json!(true);
        assert_eq!(parse_post(untitled).expect("reads").title, "");
        let mut bad_id = post();
        bad_id["post"]["communityId"] = json!("../me");
        assert!(parse_post(bad_id).is_none());
        let mut no_name = post();
        no_name["post"].as_object_mut().unwrap().remove("communityName");
        assert!(parse_post(no_name).is_none());
        assert!(parse_post(json!({ "kind": "created" })).is_none());
        assert!(parse_post(changed()).is_none(), "an event is no post");
    }

    #[test]
    fn the_news_switch_decides_the_toast_of_a_post() {
        let on = CommunityNotifications::default();
        assert_eq!(decide_post(&on, false), Delivery { toast: true, os: true });
        assert_eq!(decide_post(&on, true), Delivery { toast: true, os: false });
        let off = CommunityNotifications {
            news: false,
            ..CommunityNotifications::default()
        };
        assert_eq!(decide_post(&off, false), Delivery::default());
        let no_os = CommunityNotifications {
            os: false,
            ..CommunityNotifications::default()
        };
        assert_eq!(decide_post(&no_os, false), Delivery { toast: true, os: false });
        // The events' switches do not speak for the news.
        let events_off = CommunityNotifications {
            new_events: false,
            reminders: false,
            ..CommunityNotifications::default()
        };
        assert_eq!(decide_post(&events_off, false), Delivery { toast: true, os: true });
    }

    #[test]
    fn the_notification_of_a_post_names_the_community_and_the_post() {
        let labels = EventLabels::default();
        let read = parse_post(post()).unwrap();
        let (title, text) = compose_post(&read, &labels);
        assert_eq!(title, "News from Duel Masters");
        assert_eq!(text, "Season two · Ladder The ladder opens on Friday at the arena.");
        let untitled = PostSummary {
            title: String::new(),
            ..read.clone()
        };
        assert_eq!(compose_post(&untitled, &labels).1, "Ladder The ladder opens on Friday at the arena.");
        let bare = PostSummary {
            excerpt: String::new(),
            ..read.clone()
        };
        assert_eq!(compose_post(&bare, &labels).1, "Season two");
        let russian = EventLabels {
            post: "Новость в {community}".into(),
            ..EventLabels::default()
        };
        assert_eq!(compose_post(&read, &russian).0, "Новость в Duel Masters");
        let long = PostSummary {
            excerpt: "x".repeat(400),
            ..read
        };
        assert!(compose_post(&long, &labels).1.chars().count() <= MAX_LINE_CHARS);
    }

    #[test]
    fn labels_default_to_english_and_an_older_window_may_send_fewer() {
        let labels: EventLabels = serde_json::from_value(json!({ "created": "{community} hat ein Event angekündigt" })).unwrap();
        assert_eq!(labels.created, "{community} hat ein Event angekündigt");
        assert_eq!(labels.reminder, EventLabels::default().reminder);
    }

    #[test]
    fn the_local_time_reads_the_same_in_every_language() {
        let when = local_when("2026-10-03T16:00:00Z");
        assert_eq!(when.len(), "2026-10-03 19:00".len());
        assert!(when.starts_with("2026-10-0"));
        assert_eq!(local_when("not a time"), "not a time");
    }

    #[test]
    fn a_calendar_file_keeps_to_its_shape_and_its_name() {
        assert!(is_calendar("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"));
        assert!(!is_calendar("BEGIN:VCALENDAR\nEND:VCALENDAR\n"));
        assert!(!is_calendar("<script>"));
        let huge = format!("BEGIN:VCALENDAR\r\n{}END:VCALENDAR\r\n", "x".repeat(MAX_ICS_BYTES));
        assert!(!is_calendar(&huge));
        assert_eq!(ics_file_name("duel-cup.ics"), "duel-cup.ics");
        assert_eq!(ics_file_name("duel-cup"), "duel-cup.ics");
        assert_eq!(ics_file_name("..\\..\\Windows\\evil.ics"), "Windowsevil.ics");
        assert_eq!(ics_file_name("Турнир"), "event.ics");
        assert_eq!(ics_file_name("..."), "event.ics");
    }
}
