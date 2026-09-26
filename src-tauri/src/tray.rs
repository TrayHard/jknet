//! The icon in the notification area, and how the launcher closes.
//!
//! Chat keeps arriving and a private server keeps running when the player
//! closes the launcher window, so by default the close button hides it into
//! the tray (D6). The tray icon is the way back: a left click shows the
//! window, and its menu opens the launcher, opens chats, switches **Do not
//! disturb** and quits.
//!
//! ## Closing and quitting
//!
//! [`close_action`] is the one rule: the launcher window hides when
//! `closeToTray` is on, the tray icon exists and the player is not quitting;
//! every other close is a close. The core applies it in the window handler
//! of `lib.rs` before anything else looks at the close, and the frontend
//! asks for it through `app_close_action` before its own guard dialogs.
//!
//! **Quit** in the tray (and `app_quit`) marks the launcher as quitting,
//! shows the window and closes it the usual way, so the questions about a
//! running server and an unsaved draft still come. A guard that is
//! cancelled calls `app_quit_cancelled`; a minute later the mark lapses on
//! its own anyway, so a lost cancel cannot turn the close button into
//! **Quit** for the rest of the run.
//!
//! The first hide ever shows a Windows notification saying where the
//! launcher went, emits `app:tray-hint` and writes `closeToTrayHintSeen`.
//!
//! ## Labels
//!
//! The core has no translations. The main window sends the words of the
//! menu, the tooltip and the few texts of notifications through
//! `set_tray_labels`, finished (counts included), again on every change of
//! the language or of the unread count; until then they are English. The
//! unread badge on the icon is the core's own: a dot painted over the
//! window icon while any chat has unread messages.
//!
//! ## Starting
//!
//! The launcher window is created hidden (`tauri.conf.json`). `setup` shows
//! it, unless Windows started the launcher (`--autostart`, see
//! `tauri-plugin-autostart`) and `startMinimized` is on. A second start of
//! the launcher never gets that far: `tauri-plugin-single-instance` ends it
//! and raises this one ([`raise_from_second_start`]).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, Result};
use crate::settings::Settings;
use crate::state::AppState;

/// The id of the one tray icon.
pub const TRAY_ID: &str = "main";

/// The argument `tauri-plugin-autostart` starts the launcher with.
pub const AUTOSTART_ARG: &str = "--autostart";

/// The first hide into the tray happened: the frontend may say so too.
pub const EVENT_TRAY_HINT: &str = "app:tray-hint";

/// The launcher window.
const MAIN_LABEL: &str = "main";

/// How long **Quit** waits for its close before the close button hides into
/// the tray again.
const QUIT_LAPSES_AFTER: Duration = Duration::from_secs(60);

/// Ids of the menu items.
const ITEM_OPEN: &str = "open";
const ITEM_CHAT: &str = "chat";
const ITEM_DND: &str = "dnd";
const ITEM_QUIT: &str = "quit";

/// The unread badge: `--red-500` of the launcher's tokens, on a ring of the
/// window background so it stands off the blue of the icon.
const BADGE: [u8; 3] = [0xEF, 0x44, 0x44];
const BADGE_RING: [u8; 3] = [0x0B, 0x0E, 0x14];

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/// The words of the tray and of the notifications the core shows, in the
/// language on screen. Every field is optional on the wire and defaults to
/// English, so an older frontend that sends five of them still works.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrayLabels {
    /// **Open JKNet**.
    pub open: String,
    /// **Open chats**, with the unread count when there is one.
    pub chat: String,
    /// **Do not disturb**.
    pub dnd: String,
    /// **Quit**.
    pub quit: String,
    /// The tooltip of the icon, with the unread count when there is one.
    pub tooltip: String,
    /// The text of a notification whose message text is hidden.
    pub new_message: String,
    /// The sender of a message whose account was deleted.
    pub deleted_account: String,
    /// The title of the summary after a game.
    pub summary_title: String,
    /// The text of that summary: `{messages}` and `{chats}` are the counts.
    pub summary: String,
    /// The notification of the first hide into the tray.
    pub hint_title: String,
    pub hint: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        TrayLabels {
            open: "Open JKNet".into(),
            chat: "Open chats".into(),
            dnd: "Do not disturb".into(),
            quit: "Quit".into(),
            tooltip: "JKNet".into(),
            new_message: "New message".into(),
            deleted_account: "Deleted account".into(),
            summary_title: "Messages while you played".into(),
            summary: "Messages: {messages}, chats: {chats}".into(),
            hint_title: "JKNet is still running".into(),
            hint: "Closing the window keeps JKNet in the tray, so chats and your server stay online. Quit it from the tray icon.".into(),
        }
    }
}

/// A menu text as Windows reads it: `&` marks a mnemonic, `&&` is an
/// ampersand.
fn menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// What the tray keeps between calls.
#[derive(Default)]
pub struct TrayState {
    labels: Mutex<TrayLabels>,
    #[cfg(desktop)]
    items: Mutex<Option<MenuItems>>,
    /// The icon was built: without it a hidden window has no way back, so
    /// the close button closes.
    ready: AtomicBool,
    /// Whether the icon shows the badge now; `None` before the first count.
    unread: Mutex<Option<bool>>,
    /// The hint of the first hide went out in this run.
    hint_shown: AtomicBool,
}

#[cfg(desktop)]
struct MenuItems {
    open: tauri::menu::MenuItem<tauri::Wry>,
    chat: tauri::menu::MenuItem<tauri::Wry>,
    dnd: tauri::menu::CheckMenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
}

/// A poisoned lock answers with the value in it, as in `chat`.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The labels in force.
pub fn labels(app: &AppHandle) -> TrayLabels {
    app.try_state::<TrayState>()
        .map(|state| lock(&state.labels).clone())
        .unwrap_or_default()
}

/// Whether the player asked to quit and the close is under way.
#[derive(Default)]
pub struct Lifecycle {
    quitting: AtomicBool,
    /// Bumped by every **Quit** and every cancel, so the timer of an old
    /// **Quit** does not clear a newer one.
    generation: AtomicU64,
}

impl Lifecycle {
    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::Acquire)
    }

    /// Marks the launcher as quitting; answers the mark's generation.
    fn begin(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.quitting.store(true, Ordering::Release);
        generation
    }

    /// A guard dialog was cancelled: the close button hides again.
    fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.quitting.store(false, Ordering::Release);
    }

    /// The minute of one **Quit** ran out: clears the mark, unless a later
    /// **Quit** or cancel owns it now.
    fn lapse(&self, generation: u64) {
        if self.generation.load(Ordering::Acquire) == generation {
            self.quitting.store(false, Ordering::Release);
        }
    }
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/// What the close button of a window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// Hide the launcher window into the tray.
    Hide,
    /// Close the window as usual.
    Close,
}

/// The rule, pure: only the launcher window hides, only when the player
/// wants it, only while the tray icon exists and never while quitting.
pub fn close_action(label: &str, close_to_tray: bool, tray_ready: bool, quitting: bool) -> CloseAction {
    if label == MAIN_LABEL && close_to_tray && tray_ready && !quitting {
        CloseAction::Hide
    } else {
        CloseAction::Close
    }
}

/// [`close_action`] for a window of this launcher, right now.
pub fn close_action_of(app: &AppHandle, label: &str) -> CloseAction {
    let close_to_tray = app
        .state::<AppState>()
        .settings()
        .map(|settings| settings.close_to_tray)
        .unwrap_or(true);
    let tray_ready = app
        .try_state::<TrayState>()
        .is_some_and(|state| state.ready.load(Ordering::Acquire));
    let quitting = app
        .try_state::<Lifecycle>()
        .is_some_and(|lifecycle| lifecycle.quitting());
    close_action(label, close_to_tray, tray_ready, quitting)
}

/// Hides the launcher window into the tray. Called by the window handler of
/// `lib.rs` for a close of `main` that [`close_action_of`] says hides.
pub fn hide_to_tray(window: &tauri::Window) {
    if let Err(e) = window.hide() {
        log::warn!("window {}: cannot hide in the tray: {e}", window.label());
        return;
    }
    log::info!("window {}: hidden in the tray", window.label());
    note_hidden(window.app_handle());
}

/// The first hide ever: a notification says where the launcher went, once.
fn note_hidden(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let app_state = app.state::<AppState>();
    let seen = app_state
        .settings()
        .map(|settings| settings.close_to_tray_hint_seen)
        .unwrap_or(true);
    if seen || state.hint_shown.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Err(e) = Settings::edit(&app_state, |settings| settings.close_to_tray_hint_seen = true) {
        log::warn!("tray: cannot note that the hint was shown: {e}");
    }
    if let Err(e) = app.emit(EVENT_TRAY_HINT, ()) {
        log::debug!("cannot emit {EVENT_TRAY_HINT}: {e}");
    }
    let labels = labels(app);
    crate::chat::notify::show_toast(app, labels.hint_title, labels.hint, None);
}

/// Shows the launcher window: from the tray, from a notification, from a
/// second start. Shown before it is restored and focused, because a window
/// hidden in the tray is neither minimized nor able to take the focus.
pub fn show_main(app: &AppHandle) {
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let _ = main.show();
    let _ = main.unminimize();
    let _ = main.set_focus();
}

/// Starts leaving the launcher: the mark, the window shown so its guards can
/// ask, and the usual close.
pub fn quit(app: &AppHandle) {
    let Some(lifecycle) = app.try_state::<Lifecycle>() else {
        app.exit(0);
        return;
    };
    let generation = lifecycle.begin();
    log::info!("quit asked for");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUIT_LAPSES_AFTER).await;
        handle.state::<Lifecycle>().lapse(generation);
    });
    match app.get_webview_window(MAIN_LABEL) {
        Some(main) => {
            show_main(app);
            if let Err(e) = main.close() {
                log::warn!("cannot close the launcher window, leaving anyway: {e}");
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

/// Whether a start is Windows starting the launcher with the player's
/// session and the player wants it to stay in the tray.
pub fn starts_hidden<S: AsRef<str>>(args: &[S], start_minimized: bool) -> bool {
    start_minimized && args.iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

/// The callback of `tauri-plugin-single-instance`: somebody started the
/// launcher again. It runs in this, the first, process; the second one has
/// already ended. A second start by Windows at sign-in changes nothing.
pub fn raise_from_second_start(app: &AppHandle, args: &[String]) {
    if args.iter().any(|arg| arg == AUTOSTART_ARG) {
        log::info!("a second start with Windows ignored, JKNet is already running");
        return;
    }
    log::info!("a second start of JKNet raised this one");
    show_main(app);
}

// ---------------------------------------------------------------------------
// The icon
// ---------------------------------------------------------------------------

/// Builds the tray icon with its menu. Called once from `setup`; a failure
/// is logged and leaves the launcher without a tray, and the close button
/// then closes.
#[cfg(desktop)]
pub fn build(app: &AppHandle) {
    match try_build(app) {
        Ok(()) => {
            app.state::<TrayState>().ready.store(true, Ordering::Release);
            log::info!("tray: icon ready");
        }
        Err(e) => log::error!("tray: cannot build the icon, closing the window will quit: {e}"),
    }
    // The check mark follows **Do not disturb**, whoever changed it.
    let handle = app.clone();
    tauri::Listener::listen(app, crate::settings::CHAT_NOTIFICATIONS_EVENT, move |event| {
        match serde_json::from_str::<crate::settings::ChatNotificationsChanged>(event.payload()) {
            Ok(changed) => set_dnd_mark(&handle, changed.chat_notifications.dnd),
            Err(e) => log::debug!("tray: unreadable settings event: {e}"),
        }
    });
}

#[cfg(desktop)]
fn try_build(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let state = app.state::<TrayState>();
    let labels = lock(&state.labels).clone();
    let dnd = app
        .state::<AppState>()
        .settings()
        .map(|settings| settings.chat_notifications.dnd)
        .unwrap_or(false);
    let items = MenuItems {
        open: MenuItem::with_id(app, ITEM_OPEN, menu_text(&labels.open), true, None::<&str>)?,
        chat: MenuItem::with_id(app, ITEM_CHAT, menu_text(&labels.chat), true, None::<&str>)?,
        dnd: CheckMenuItem::with_id(app, ITEM_DND, menu_text(&labels.dnd), true, dnd, None::<&str>)?,
        quit: MenuItem::with_id(app, ITEM_QUIT, menu_text(&labels.quit), true, None::<&str>)?,
    };
    let menu = Menu::with_items(
        app,
        &[
            &items.open,
            &items.chat,
            &PredefinedMenuItem::separator(app)?,
            &items.dnd,
            &PredefinedMenuItem::separator(app)?,
            &items.quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(&labels.tooltip)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ITEM_OPEN => show_main(app),
            ITEM_CHAT => crate::chat::window::open_chats(app, None),
            ITEM_DND => toggle_dnd(app),
            ITEM_QUIT => quit(app),
            other => log::debug!("tray: unknown menu item {other}"),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    *lock(&state.items) = Some(items);
    Ok(())
}

/// **Do not disturb** of the tray menu: flips the switch in the settings and
/// tells every window.
#[cfg(desktop)]
fn toggle_dnd(app: &AppHandle) {
    let state = app.state::<AppState>();
    match Settings::edit(&state, |settings| {
        settings.chat_notifications.dnd = !settings.chat_notifications.dnd;
    }) {
        Ok(settings) => {
            log::info!("tray: do not disturb {}", if settings.chat_notifications.dnd { "on" } else { "off" });
            set_dnd_mark(app, settings.chat_notifications.dnd);
            crate::settings::emit_chat_notifications(app, &settings);
        }
        Err(e) => {
            log::warn!("tray: cannot switch do not disturb: {e}");
            // The item flipped its own mark on the click; put it back.
            let dnd = state
                .settings()
                .map(|settings| settings.chat_notifications.dnd)
                .unwrap_or(false);
            set_dnd_mark(app, dnd);
        }
    }
}

#[cfg(desktop)]
fn set_dnd_mark(app: &AppHandle, on: bool) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let items = lock(&state.items);
    if let Some(items) = items.as_ref() {
        if let Err(e) = items.dnd.set_checked(on) {
            log::debug!("tray: cannot mark do not disturb: {e}");
        }
    }
}

/// Puts the unread badge on the icon or takes it off. Called with every
/// `chat:state`; does nothing while the badge is already right.
pub fn set_unread(app: &AppHandle, unread: bool) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    if !state.ready.load(Ordering::Acquire) {
        return;
    }
    {
        let mut shown = lock(&state.unread);
        if *shown == Some(unread) {
            return;
        }
        *shown = Some(unread);
    }
    #[cfg(desktop)]
    {
        let (Some(tray), Some(icon)) = (app.tray_by_id(TRAY_ID), app.default_window_icon()) else {
            return;
        };
        let image = if unread {
            tauri::image::Image::new_owned(
                with_badge(icon.rgba(), icon.width(), icon.height()),
                icon.width(),
                icon.height(),
            )
        } else {
            icon.clone().to_owned()
        };
        if let Err(e) = tray.set_icon(Some(image)) {
            log::debug!("tray: cannot change the icon: {e}");
        }
    }
}

/// Paints the unread dot into the top-right corner of an RGBA picture: a
/// disc of [`BADGE`] with a ring of [`BADGE_RING`], edges smoothed.
pub fn with_badge(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    if out.len() != (width as usize) * (height as usize) * 4 || width == 0 || height == 0 {
        return out;
    }
    let size = width.min(height) as f32;
    let radius = size * 0.22;
    let ring = (size * 0.06).max(1.0);
    let outer = radius + ring;
    let (cx, cy) = (width as f32 - outer, outer);
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let distance = (dx * dx + dy * dy).sqrt();
            let outer_cover = (outer + 0.5 - distance).clamp(0.0, 1.0);
            if outer_cover <= 0.0 {
                continue;
            }
            let inner_cover = (radius + 0.5 - distance).clamp(0.0, 1.0);
            let index = ((y * width + x) * 4) as usize;
            let pixel = &mut out[index..index + 4];
            // The ring over the icon, then the disc over the ring.
            blend(pixel, BADGE_RING, outer_cover);
            blend(pixel, BADGE, inner_cover);
        }
    }
    out
}

/// Lays an opaque colour over one RGBA pixel with the given cover.
fn blend(pixel: &mut [u8], color: [u8; 3], cover: f32) {
    if cover <= 0.0 {
        return;
    }
    let under_alpha = pixel[3] as f32 / 255.0;
    let alpha = cover + under_alpha * (1.0 - cover);
    for channel in 0..3 {
        let over = color[channel] as f32 * cover;
        let under = pixel[channel] as f32 * under_alpha * (1.0 - cover);
        pixel[channel] = if alpha > 0.0 {
            ((over + under) / alpha).round().clamp(0.0, 255.0) as u8
        } else {
            0
        };
    }
    pixel[3] = (alpha * 255.0).round().clamp(0.0, 255.0) as u8;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The words of the tray menu, its tooltip and the notifications of the
/// core, finished, in the language on screen.
#[tauri::command]
pub async fn set_tray_labels(app: AppHandle, labels: TrayLabels) -> Result<()> {
    let state = app.state::<TrayState>();
    {
        let mut current = lock(&state.labels);
        if *current == labels {
            return Ok(());
        }
        *current = labels.clone();
    }
    #[cfg(desktop)]
    {
        if let Some(items) = lock(&state.items).as_ref() {
            for (item, text) in [
                (&items.open, &labels.open),
                (&items.chat, &labels.chat),
                (&items.quit, &labels.quit),
            ] {
                if let Err(e) = item.set_text(menu_text(text)) {
                    log::debug!("tray: cannot relabel a menu item: {e}");
                }
            }
            if let Err(e) = items.dnd.set_text(menu_text(&labels.dnd)) {
                log::debug!("tray: cannot relabel a menu item: {e}");
            }
        }
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            if let Err(e) = tray.set_tooltip(Some(&labels.tooltip)) {
                log::debug!("tray: cannot set the tooltip: {e}");
            }
        }
    }
    Ok(())
}

/// What the close button of the calling window does: `hide` into the tray
/// or `close`. An answer `hide` counts as the first hide for the hint: the
/// window hides next.
#[tauri::command]
pub async fn app_close_action(app: AppHandle, window: tauri::Window) -> Result<CloseAction> {
    let action = close_action_of(&app, window.label());
    if action == CloseAction::Hide {
        note_hidden(&app);
    }
    Ok(action)
}

/// **Quit**: the usual close of the launcher window, with its questions.
#[tauri::command]
pub async fn app_quit(app: AppHandle) -> Result<()> {
    quit(&app);
    Ok(())
}

/// A question on the way out was answered **Cancel**: the launcher stays,
/// and its close button hides into the tray again.
#[tauri::command]
pub async fn app_quit_cancelled(app: AppHandle) -> Result<()> {
    app.state::<Lifecycle>().cancel();
    log::info!("quit cancelled");
    Ok(())
}

/// Whether Windows starts the launcher with the player's session.
#[tauri::command]
pub async fn get_autostart(app: AppHandle) -> Result<bool> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .is_enabled()
            .map_err(|e| AppError::State(format!("cannot read the start with Windows: {e}")))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(false)
    }
}

/// Turns the start with Windows on or off; answers what is in force after.
/// The launcher then starts with `--autostart`, and `startMinimized` keeps
/// it in the tray.
#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        let changed = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        changed.map_err(|e| AppError::State(format!("cannot change the start with Windows: {e}")))?;
        log::info!("start with Windows {}", if enabled { "on" } else { "off" });
        manager
            .is_enabled()
            .map_err(|e| AppError::State(format!("cannot read the start with Windows: {e}")))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Err(AppError::InvalidInput("this system has no start with the session".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_launcher_window_hides_and_only_when_it_should() {
        use CloseAction::{Close, Hide};
        assert_eq!(close_action("main", true, true, false), Hide);
        // The player switched it off (D6 allows it), or is quitting.
        assert_eq!(close_action("main", false, true, false), Close);
        assert_eq!(close_action("main", true, true, true), Close);
        // No tray icon, no way back: the close closes.
        assert_eq!(close_action("main", true, false, false), Close);
        // Every other window closes as it always did.
        for label in ["chat", "client-everyday"] {
            assert_eq!(close_action(label, true, true, false), Close, "{label}");
        }
        assert_eq!(serde_json::to_string(&Hide).expect("serializes"), r#""hide""#);
        assert_eq!(serde_json::to_string(&Close).expect("serializes"), r#""close""#);
    }

    #[test]
    fn quit_lapses_after_its_minute_unless_a_newer_one_owns_it() {
        let lifecycle = Lifecycle::default();
        assert!(!lifecycle.quitting());
        let first = lifecycle.begin();
        assert!(lifecycle.quitting());
        lifecycle.lapse(first);
        assert!(!lifecycle.quitting(), "the minute ran out");

        let old = lifecycle.begin();
        let new = lifecycle.begin();
        lifecycle.lapse(old);
        assert!(lifecycle.quitting(), "the older timer leaves the newer quit alone");
        lifecycle.lapse(new);
        assert!(!lifecycle.quitting());

        let cancelled = lifecycle.begin();
        lifecycle.cancel();
        assert!(!lifecycle.quitting());
        let again = lifecycle.begin();
        lifecycle.lapse(cancelled);
        assert!(lifecycle.quitting(), "a cancelled quit's timer does not end the next one");
        lifecycle.lapse(again);
    }

    #[test]
    fn only_a_start_with_windows_stays_in_the_tray() {
        assert!(starts_hidden(&["JKNet.exe", AUTOSTART_ARG], true));
        assert!(!starts_hidden(&["JKNet.exe", AUTOSTART_ARG], false), "the player wants the window");
        assert!(!starts_hidden(&["JKNet.exe"], true), "a start by hand opens the window");
        assert!(!starts_hidden::<&str>(&[], true));
    }

    #[test]
    fn labels_default_to_english_and_an_older_frontend_sends_five() {
        let labels: TrayLabels = serde_json::from_str(
            r#"{"open":"JKNet öffnen","chat":"Chats öffnen (3)","dnd":"Nicht stören","quit":"Beenden","tooltip":"JKNet: 3"}"#,
        )
        .expect("five labels");
        assert_eq!(labels.chat, "Chats öffnen (3)");
        assert_eq!(labels.new_message, TrayLabels::default().new_message);
        assert!(TrayLabels::default().summary.contains("{messages}"));
        assert!(TrayLabels::default().summary.contains("{chats}"));
        assert_eq!(menu_text("Salt & Pepper"), "Salt && Pepper");
    }

    #[test]
    fn the_badge_is_a_red_dot_in_the_top_right_corner() {
        let (width, height) = (32u32, 32u32);
        let icon: Vec<u8> = (0..width * height).flat_map(|_| [0x20, 0x60, 0xE0, 0xFF]).collect();
        let badged = with_badge(&icon, width, height);
        assert_eq!(badged.len(), icon.len());
        let pixel = |x: u32, y: u32| {
            let i = ((y * width + x) * 4) as usize;
            [badged[i], badged[i + 1], badged[i + 2], badged[i + 3]]
        };
        // The centre of the dot: 0.22 of the size in radius, one ring in.
        let outer = 32.0 * 0.22 + 32.0 * 0.06;
        let (cx, cy) = ((32.0 - outer) as u32, outer as u32);
        assert_eq!(pixel(cx, cy), [BADGE[0], BADGE[1], BADGE[2], 0xFF]);
        // The rest of the icon is untouched.
        assert_eq!(pixel(2, 30), [0x20, 0x60, 0xE0, 0xFF]);
        assert_eq!(pixel(2, 2), [0x20, 0x60, 0xE0, 0xFF]);
        // Over a transparent corner the dot is still opaque.
        let clear = vec![0u8; (width * height * 4) as usize];
        let badged = with_badge(&clear, width, height);
        let i = ((cy * width + cx) * 4) as usize;
        assert_eq!(&badged[i..i + 4], &[BADGE[0], BADGE[1], BADGE[2], 0xFF]);
        // A buffer that does not match its size is left alone.
        assert_eq!(with_badge(&[1, 2, 3], 4, 4), vec![1, 2, 3]);
    }
}
