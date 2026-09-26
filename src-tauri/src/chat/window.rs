//! The separate chat window, and its compact mode over a game.
//!
//! The main window shows chats in a drawer. The chat window is the same
//! surface in a window of its own: the list beside the thread when it is
//! full, one conversation in a narrow, always-on-top window when it is
//! compact, so a player in a windowed game keeps the chat in sight.
//!
//! ## One window
//!
//! There is one chat window, labelled `chat`. A second [`open_chat_window`]
//! finds it by that label, raises it and sends it `chat:open` with the
//! conversation to show, instead of opening a duplicate. The capability file
//! `capabilities/chat-window.json` grants its permissions by the same label.
//! The route travels as the fragment `#/chat` or `#/chat/<id>` of
//! `index.html`, for the reasons [`crate::client_window`] gives for its own.
//!
//! ## Compact mode
//!
//! [`chat_window_set_compact`] turns the window into the compact one and
//! back. Each mode keeps its own bounds, its own «always on top» switch and,
//! for the compact mode, an opacity; all of it lives in `settings.json`
//! under `chatWindow`, so the window comes back the way the player left it.
//! `tauri-plugin-window-state` is told to leave this window alone
//! (`lib.rs`): it keeps one set of bounds per label, and it would save the
//! compact bounds as the full ones.
//!
//! Opacity needs a window the desktop shows through. The window is built
//! transparent, and its webview gets the launcher's background colour, so it
//! paints like any other window. Only in the compact mode below 100 % does
//! the webview background turn transparent: the page then paints its own
//! background at the opacity `chat:window` names, and the game shows through
//! the rest. A page that ignores the opacity stays opaque, never blank.
//!
//! ## Events
//!
//! | Event         | Payload                                       | Target |
//! | ------------- | --------------------------------------------- | ------ |
//! | `chat:open`   | `{conversationId}`, `null` for the list       | `chat` (or `main`, see [`open_conversation`]) |
//! | `chat:window` | [`ChatWindowView`]                            | all    |
//!
//! ## Diagnostics
//!
//! Opening, raising, switching modes and every failure are lines in
//! `logs\JKNet.log` with the bounds in physical pixels: a compact window that
//! comes up in the wrong place or not on top is otherwise invisible to a bug
//! report.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::error::{AppError, Result};
use crate::settings::{ChatWindowSettings, Settings, WindowBounds, CHAT_OPEN_IN_WINDOW};
use crate::state::{AppState, StepLock};

/// The label of the chat window. `capabilities/chat-window.json` names it,
/// and so does the drop handler of `chat::files`. Change one, change all.
pub const LABEL: &str = "chat";

/// The core asks a window to show a conversation, or the list for `null`.
pub const EVENT_OPEN: &str = "chat:open";
/// The mode, the switches and the opacity of the chat window changed.
pub const EVENT_WINDOW: &str = "chat:window";

/// The label of the launcher window, where the chat drawer lives.
const MAIN_LABEL: &str = "main";

/// The title the taskbar and Alt+Tab show. The core has no translations; the
/// window draws its own title bar in the player's language.
const TITLE: &str = "JKNet Chat";

/// The list beside the thread: the list alone is 300 px wide, so the full
/// mode is as wide as the chat window was drawn, and never narrower than the
/// list plus a thread worth reading.
const FULL_SIZE: (f64, f64) = (960.0, 680.0);
const FULL_MIN: (f64, f64) = (640.0, 420.0);

/// One conversation over a game.
const COMPACT_SIZE: (f64, f64) = (360.0, 520.0);
const COMPACT_MIN: (f64, f64) = (320.0, 420.0);

/// How far a compact window placed for the first time keeps from the corner
/// of the screen, in logical pixels.
const COMPACT_MARGIN: f64 = 16.0;

/// The opacity slider of the compact mode, in percent.
pub const MIN_OPACITY: u8 = 40;
pub const MAX_OPACITY: u8 = 100;

/// Same first paint as the main window, whose `backgroundColor` in
/// `tauri.conf.json` is `#0B0E14`.
const BACKGROUND: Color = Color(0x0B, 0x0E, 0x14, 255);
/// The webview background of a see-through compact window: nothing, so the
/// page's own translucent background is all there is.
const SEE_THROUGH: Color = Color(0, 0, 0, 0);

/// How long the bounds wait after the last move or resize before they are
/// written: a drag is dozens of events and one write.
const SAVE_DELAY: Duration = Duration::from_secs(1);

/// How much of a saved window's top edge has to lie on a screen for the
/// window to be put back there: enough to grab and drag it.
const GRIP_WIDTH: u32 = 64;
const GRIP_HEIGHT: u32 = 16;

/// Windows parks a minimised window at -32000, -32000 and reports the move.
const MINIMIZED_POSITION: i32 = -32000;

/// Conversation ids are ULIDs; anything past this is not one.
const MAX_ID_LEN: usize = 64;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// What the core keeps about the chat window between calls.
#[derive(Default)]
pub struct ChatWindowState {
    /// Finding the window and building one are one step, as for the client
    /// windows: two clicks in the same instant must not build two.
    step: StepLock,
    /// `chatWindow` of the settings, read on first use and written back
    /// from here. `None` until then.
    prefs: Mutex<Option<ChatWindowSettings>>,
    /// A write of the bounds is waiting for [`SAVE_DELAY`].
    save_pending: AtomicBool,
}

impl ChatWindowState {
    fn prefs(&self) -> MutexGuard<'_, Option<ChatWindowSettings>> {
        // Nothing in here is half written for long; a poisoned lock keeps
        // its value, the same rule as the rest of chat.
        self.prefs.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The two modes of the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Full,
    Compact,
}

impl Mode {
    fn of(compact: bool) -> Mode {
        if compact {
            Mode::Compact
        } else {
            Mode::Full
        }
    }

    /// The inner size of a window of this mode placed for the first time,
    /// in logical pixels.
    fn size(self) -> (f64, f64) {
        match self {
            Mode::Full => FULL_SIZE,
            Mode::Compact => COMPACT_SIZE,
        }
    }

    /// The smallest inner size of this mode, in logical pixels.
    fn min(self) -> (f64, f64) {
        match self {
            Mode::Full => FULL_MIN,
            Mode::Compact => COMPACT_MIN,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Mode::Full => "full",
            Mode::Compact => "compact",
        }
    }
}

// The readings of `chatWindow` that depend on the mode. Kept here rather
// than in `settings.rs`, which stores the document and knows nothing of
// windows.
impl ChatWindowSettings {
    fn mode(&self) -> Mode {
        Mode::of(self.compact)
    }

    /// Whether the window stays on top in the mode it is in.
    fn on_top(&self) -> bool {
        match self.mode() {
            Mode::Full => self.always_on_top,
            Mode::Compact => self.compact_always_on_top,
        }
    }

    fn set_on_top(&mut self, on: bool) {
        match self.mode() {
            Mode::Full => self.always_on_top = on,
            Mode::Compact => self.compact_always_on_top = on,
        }
    }

    /// The opacity of the compact mode, held to the slider's range: the file
    /// is the player's to edit, and a window at 0 % is a window lost.
    fn opacity(&self) -> u8 {
        self.compact_opacity.clamp(MIN_OPACITY, MAX_OPACITY)
    }

    /// Whether the desktop shows through the window right now.
    fn see_through(&self) -> bool {
        self.compact && self.opacity() < MAX_OPACITY
    }

    fn bounds_of(&self, mode: Mode) -> Option<WindowBounds> {
        match mode {
            Mode::Full => self.bounds,
            Mode::Compact => self.compact_bounds,
        }
    }

    fn set_bounds(&mut self, mode: Mode, bounds: WindowBounds) {
        match mode {
            Mode::Full => self.bounds = Some(bounds),
            Mode::Compact => self.compact_bounds = Some(bounds),
        }
    }
}

/// The chat window as the windows see it: `chat_window_state` answers it and
/// `chat:window` carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWindowView {
    /// Whether the chat window exists right now.
    pub open: bool,
    pub compact: bool,
    /// «Always on top» of the mode the window is in.
    pub always_on_top: bool,
    /// Opacity of the compact mode in percent. The page applies it only
    /// while `compact` is on; the full mode is always opaque.
    pub opacity: u8,
}

impl ChatWindowView {
    fn of(prefs: &ChatWindowSettings, open: bool) -> ChatWindowView {
        ChatWindowView {
            open,
            compact: prefs.compact,
            always_on_top: prefs.on_top(),
            opacity: prefs.opacity(),
        }
    }
}

/// Payload of `chat:open`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest {
    conversation_id: Option<String>,
}

/// The preferences, read from the settings on first use.
fn load<'a>(
    app: &AppHandle,
    guard: &'a mut MutexGuard<'_, Option<ChatWindowSettings>>,
) -> &'a mut ChatWindowSettings {
    guard.get_or_insert_with(|| match app.state::<AppState>().settings() {
        Ok(settings) => settings.chat_window,
        Err(e) => {
            log::warn!("chat window: {e}, starting from the default window");
            ChatWindowSettings::default()
        }
    })
}

/// A copy of the preferences.
fn prefs(app: &AppHandle) -> ChatWindowSettings {
    let state = app.state::<ChatWindowState>();
    let mut guard = state.prefs();
    load(app, &mut guard).clone()
}

/// Changes the preferences in memory and answers them as they now are. The
/// caller decides when they reach the disk.
fn update(app: &AppHandle, change: impl FnOnce(&mut ChatWindowSettings)) -> ChatWindowSettings {
    let state = app.state::<ChatWindowState>();
    let mut guard = state.prefs();
    let prefs = load(app, &mut guard);
    change(prefs);
    prefs.clone()
}

/// Writes the preferences into `settings.json`, if they differ from what the
/// file holds. The file wins for every other field, as in every writer of
/// the settings.
fn persist(app: &AppHandle) {
    let Some(prefs) = app.state::<ChatWindowState>().prefs().clone() else {
        return;
    };
    let state = app.state::<AppState>();
    let result = (|| -> Result<()> {
        let mut document = Settings::current(&state)?;
        if document.chat_window == prefs {
            return Ok(());
        }
        document.chat_window = prefs;
        document.save(&state)?;
        state.set_settings(document)
    })();
    if let Err(e) = result {
        log::warn!("chat window: cannot save its bounds and switches: {e}");
    }
}

/// Writes the preferences [`SAVE_DELAY`] from now, once for a burst.
fn schedule_persist(app: &AppHandle) {
    let state = app.state::<ChatWindowState>();
    if state.save_pending.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_DELAY).await;
        handle
            .state::<ChatWindowState>()
            .save_pending
            .store(false, Ordering::Release);
        persist(&handle);
    });
}

/// The view right now.
fn view(app: &AppHandle) -> ChatWindowView {
    ChatWindowView::of(&prefs(app), app.get_webview_window(LABEL).is_some())
}

fn emit_view(app: &AppHandle, view: ChatWindowView) {
    if let Err(e) = app.emit(EVENT_WINDOW, view) {
        log::debug!("cannot emit {EVENT_WINDOW}: {e}");
    }
}

fn emit_open(app: &AppHandle, label: &str, conversation_id: Option<String>) {
    if let Err(e) = app.emit_to(label, EVENT_OPEN, OpenRequest { conversation_id }) {
        log::debug!("cannot emit {EVENT_OPEN} to {label}: {e}");
    }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/// A conversation id fit for the route, `None` for none. Blank counts as
/// none; anything but the letters of an id is refused, because the id
/// becomes part of the window's address.
fn clean_id(conversation_id: Option<String>) -> Result<Option<String>> {
    let Some(id) = conversation_id else {
        return Ok(None);
    };
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    let fits = id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !fits {
        return Err(AppError::InvalidInput(format!(
            "{id:?} is not a conversation id"
        )));
    }
    Ok(Some(id.to_string()))
}

/// The path the chat window is opened at, for [`WebviewUrl::App`]: the
/// route as a fragment of `index.html`, like a client window's.
fn window_path(conversation_id: Option<&str>) -> String {
    match conversation_id {
        Some(id) => format!("index.html#/chat/{id}"),
        None => "index.html#/chat".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// A rectangle in physical pixels: the work area of a screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Area {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Area {
    fn work_area_of(monitor: &Monitor) -> Area {
        let area = monitor.work_area();
        Area {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        }
    }
}

/// A logical size in physical pixels at `scale`. A scale Windows could not
/// report counts as 1.
fn physical(size: (f64, f64), scale: f64) -> (u32, u32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (
        (size.0 * scale).round().max(1.0) as u32,
        (size.1 * scale).round().max(1.0) as u32,
    )
}

/// The width and height two rectangles share.
fn overlap(a: (i64, i64, i64, i64), b: (i64, i64, i64, i64)) -> (i64, i64) {
    let width = (a.0 + a.2).min(b.0 + b.2) - a.0.max(b.0);
    let height = (a.1 + a.3).min(b.1 + b.3) - a.1.max(b.1);
    (width.max(0), height.max(0))
}

/// Whether a saved window would come back where the player can grab it:
/// its top edge lies on a screen by at least a grip's worth. A screen that
/// was unplugged since, or a resolution that shrank, puts the window back
/// where a new one would go instead. With no screen known the saved bounds
/// are trusted.
fn reachable(bounds: &WindowBounds, areas: &[Area]) -> bool {
    if areas.is_empty() {
        return true;
    }
    let strip = (
        i64::from(bounds.x),
        i64::from(bounds.y),
        i64::from(bounds.width),
        i64::from(bounds.height.min(GRIP_HEIGHT)),
    );
    let need = (
        i64::from(bounds.width.min(GRIP_WIDTH)),
        i64::from(bounds.height.min(GRIP_HEIGHT)),
    );
    areas.iter().any(|area| {
        let area = (
            i64::from(area.x),
            i64::from(area.y),
            i64::from(area.width),
            i64::from(area.height),
        );
        let (width, height) = overlap(strip, area);
        width >= need.0 && height >= need.1
    })
}

/// Saved bounds grown to the mode's minimum: the minimum of the full mode
/// is larger than the compact one, and a file edited by hand may say
/// anything.
fn fit(bounds: WindowBounds, min: (u32, u32)) -> WindowBounds {
    WindowBounds {
        width: bounds.width.max(min.0),
        height: bounds.height.max(min.1),
        ..bounds
    }
}

/// Where a window of this mode goes when it has no saved bounds: the full
/// window in the middle of the screen, the compact one in its top right
/// corner, where a game's own interface is thinnest. Never larger than the
/// screen, never smaller than the mode's minimum. Without a screen the
/// window keeps `fallback` as its position.
fn default_bounds(
    mode: Mode,
    area: Option<Area>,
    scale: f64,
    fallback: (i32, i32),
) -> WindowBounds {
    let (mut width, mut height) = physical(mode.size(), scale);
    let min = physical(mode.min(), scale);
    let Some(area) = area else {
        return WindowBounds {
            x: fallback.0,
            y: fallback.1,
            width,
            height,
        };
    };
    width = width.min(area.width).max(min.0);
    height = height.min(area.height).max(min.1);
    let (x, y) = match mode {
        Mode::Full => (
            area.x + ((i64::from(area.width) - i64::from(width)) / 2) as i32,
            area.y + ((i64::from(area.height) - i64::from(height)) / 2) as i32,
        ),
        Mode::Compact => {
            let margin = physical((COMPACT_MARGIN, COMPACT_MARGIN), scale).0 as i64;
            (
                (i64::from(area.x) + i64::from(area.width) - i64::from(width) - margin)
                    .max(i64::from(area.x)) as i32,
                area.y + margin as i32,
            )
        }
    };
    WindowBounds {
        x,
        y,
        width,
        height,
    }
}

/// Whether a reading of the window is its real place. A minimised window
/// reports a parking spot and a zero size, and a maximised one the screen:
/// neither is where the player put it.
fn is_real(bounds: &WindowBounds) -> bool {
    bounds.width > 0
        && bounds.height > 0
        && bounds.x > MINIMIZED_POSITION
        && bounds.y > MINIMIZED_POSITION
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/// Where the window is now, or `None` while it is minimised or maximised.
fn read_bounds(window: &tauri::Window) -> Option<WindowBounds> {
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let bounds = WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    is_real(&bounds).then_some(bounds)
}

/// On top or not, and the webview background of the mode. Every step is
/// best effort: a window that stays below the game is a nuisance, not a
/// failure to report to the player.
fn dress(window: &WebviewWindow, prefs: &ChatWindowSettings) {
    if let Err(e) = window.set_always_on_top(prefs.on_top()) {
        log::warn!("chat window: cannot set always on top: {e}");
    }
    let background = if prefs.see_through() {
        SEE_THROUGH
    } else {
        BACKGROUND
    };
    if let Err(e) = window.set_background_color(Some(background)) {
        log::warn!("chat window: cannot set the background: {e}");
    }
}

/// Puts the window where its mode was last, or where a new window of that
/// mode goes.
fn place(window: &WebviewWindow, prefs: &ChatWindowSettings) -> Result<WindowBounds> {
    let mode = prefs.mode();
    let scale = window.scale_factor().unwrap_or(1.0);
    let areas: Vec<Area> = window
        .available_monitors()
        .map(|monitors| monitors.iter().map(Area::work_area_of).collect())
        .unwrap_or_default();
    let target = match prefs
        .bounds_of(mode)
        .filter(|bounds| reachable(bounds, &areas))
    {
        Some(saved) => fit(saved, physical(mode.min(), scale)),
        None => {
            let area = window
                .current_monitor()
                .ok()
                .flatten()
                .or_else(|| window.primary_monitor().ok().flatten())
                .map(|monitor| Area::work_area_of(&monitor));
            let fallback = window
                .outer_position()
                .map(|position| (position.x, position.y))
                .unwrap_or((0, 0));
            default_bounds(mode, area, scale, fallback)
        }
    };
    // The floor first: a compact window cannot shrink below the full mode's
    // minimum, and a full one grows to its own on the way.
    let min = mode.min();
    window
        .set_min_size(Some(LogicalSize::new(min.0, min.1)))
        .map_err(refused("set the minimum size"))?;
    window
        .set_size(PhysicalSize::new(target.width, target.height))
        .map_err(refused("resize"))?;
    window
        .set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(refused("move"))?;
    Ok(target)
}

/// A refusal of the window system as the error the launcher reports.
fn refused(what: &'static str) -> impl FnOnce(tauri::Error) -> AppError {
    move |e| AppError::State(format!("chat window: cannot {what}: {e}"))
}

/// Brings the window in front of the player: shown, restored, focused.
fn raise(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Moves the window into the other mode, or does nothing but re-apply the
/// switches when it is in that mode already.
fn switch(app: &AppHandle, window: &WebviewWindow, compact: bool) -> Result<ChatWindowSettings> {
    let before = prefs(app);
    if before.compact == compact {
        dress(window, &before);
        return Ok(before);
    }
    // The bounds of the mode being left, from the window itself: the events
    // have already recorded them, but the window is the one to believe.
    if let Some(bounds) = read_bounds(&window.as_ref().window()) {
        update(app, |prefs| prefs.set_bounds(before.mode(), bounds));
    }
    let now = update(app, |prefs| prefs.compact = compact);
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    dress(window, &now);
    let target = place(window, &now)?;
    log::info!(
        "chat window: {} mode at {},{} {}x{} (physical), always on top {}, opacity {}%",
        now.mode().name(),
        target.x,
        target.y,
        target.width,
        target.height,
        now.on_top(),
        now.opacity()
    );
    persist(app);
    Ok(now)
}

/// Opens the chat window, or raises the one that is open and tells it which
/// conversation to show. `compact` switches the mode when it is given and
/// keeps the last one when it is not.
fn open(app: &AppHandle, conversation_id: Option<String>, compact: Option<bool>) -> Result<()> {
    let conversation_id = clean_id(conversation_id)?;
    let state = app.state::<ChatWindowState>();
    // Looking for the window and building one are a single step; nothing
    // below awaits, so the guard never crosses a suspension point.
    let _step = state.step.enter();

    if let Some(window) = app.get_webview_window(LABEL) {
        log::info!("chat window: open, raising it");
        if let Some(on) = compact {
            switch(app, &window, on)?;
            emit_view(app, view(app));
        }
        raise(&window);
        emit_open(app, LABEL, conversation_id);
        return Ok(());
    }

    let chosen = match compact {
        Some(on) if on != prefs(app).compact => {
            let changed = update(app, |prefs| prefs.compact = on);
            persist(app);
            changed
        }
        _ => prefs(app),
    };
    let mode = chosen.mode();
    let path = window_path(conversation_id.as_deref());
    log::info!("chat window: opening in the {} mode at {path}", mode.name());
    let (width, height) = mode.size();
    let (min_width, min_height) = mode.min();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(path.into()))
        .title(TITLE)
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .resizable(true)
        .decorations(false)
        .always_on_top(chosen.on_top())
        .background_color(BACKGROUND)
        // Shown once it stands where it belongs: a window that appears in
        // one place and jumps to another reads as a glitch.
        .visible(false);
    // See-through needs a window built for it; its webview background is
    // what `dress` switches afterwards.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);

    match builder.build() {
        Ok(window) => {
            dress(&window, &chosen);
            match place(&window, &chosen) {
                Ok(target) => log::info!(
                    "opened the chat window at {},{} {}x{} (physical), always on top {}",
                    target.x,
                    target.y,
                    target.width,
                    target.height,
                    chosen.on_top()
                ),
                Err(e) => log::warn!("chat window: opened, but cannot place it: {e}"),
            }
            raise(&window);
            emit_view(app, ChatWindowView::of(&chosen, true));
            Ok(())
        }
        // Somebody else built it between the look and the build: the answer
        // to the click is that window.
        Err(tauri::Error::WebviewLabelAlreadyExists(_)) => {
            log::info!("chat window: already open");
            if let Some(window) = app.get_webview_window(LABEL) {
                raise(&window);
            }
            emit_open(app, LABEL, conversation_id);
            Ok(())
        }
        Err(e) => {
            log::error!("cannot build the chat window: {e}");
            Err(AppError::State(format!("cannot open the chat window: {e}")))
        }
    }
}

// ---------------------------------------------------------------------------
// Window events
// ---------------------------------------------------------------------------

/// Follows the chat window as the player moves and resizes it, and writes
/// where it was when it goes. Called from the window event handler in
/// `lib.rs` for the window labelled [`LABEL`].
pub fn track(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let Some(bounds) = read_bounds(window) else {
                return;
            };
            let state = app.state::<ChatWindowState>();
            let changed = {
                let mut guard = state.prefs();
                let prefs = load(app, &mut guard);
                let mode = prefs.mode();
                let changed = prefs.bounds_of(mode) != Some(bounds);
                if changed {
                    prefs.set_bounds(mode, bounds);
                }
                changed
            };
            if changed {
                schedule_persist(app);
            }
        }
        WindowEvent::Destroyed => {
            log::info!("chat window: closed");
            persist(app);
            emit_view(app, ChatWindowView::of(&prefs(app), false));
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Opening from the core
// ---------------------------------------------------------------------------

/// Where the player wants chats: `true` for the drawer of the launcher.
fn opens_in_main(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .settings()
        .map(|settings| is_main(&settings.chat_open_in))
        .unwrap_or(true)
}

/// `chatOpenIn` read leniently: only `window` means the chat window, and a
/// value a newer launcher wrote means the default, the launcher window.
fn is_main(open_in: &str) -> bool {
    open_in != CHAT_OPEN_IN_WINDOW
}

/// Shows the launcher window and asks its drawer for the conversation.
/// Answers `false` when there is no launcher window to show.
fn show_in_main(app: &AppHandle, conversation_id: Option<String>) -> bool {
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        return false;
    };
    raise(&main);
    emit_open(app, MAIN_LABEL, conversation_id);
    true
}

/// Opens the chat window off the calling thread. Building a window on the
/// thread that pumps the event loop is the deadlock `client_window` explains,
/// and a click on a notification or the tray arrives on that thread.
fn open_in_window(app: &AppHandle, conversation_id: Option<String>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = open(&handle, conversation_id, None) {
            log::warn!("chat window: cannot open: {e}");
        }
    });
}

/// Shows a conversation the player clicked in a notification.
///
/// `chatOpenIn` decides where: `main` asks the drawer of the launcher
/// window, but only while that window is on the screen. A launcher hidden in
/// the tray or while the game runs stays hidden, and the conversation opens
/// in the chat window, which is small enough to sit over the game.
/// `conversation_id` `None` shows the list.
pub fn open_conversation(app: &AppHandle, conversation_id: Option<String>) {
    let main_visible = app
        .get_webview_window(MAIN_LABEL)
        .and_then(|main| main.is_visible().ok())
        .unwrap_or(false);
    if opens_in_main(app) && main_visible && show_in_main(app, conversation_id.clone()) {
        return;
    }
    open_in_window(app, conversation_id);
}

/// **Open chats** of the tray: `chatOpenIn` alone decides, and `main` brings
/// the launcher back from the tray with its drawer open.
pub fn open_chats(app: &AppHandle, conversation_id: Option<String>) {
    if opens_in_main(app) && show_in_main(app, conversation_id.clone()) {
        return;
    }
    open_in_window(app, conversation_id);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Opens the chat window on a conversation, or on the list without one, or
/// raises the open window and sends it `chat:open`. `compact` switches the
/// mode; without it the window opens in the mode it was last in.
///
/// `async` for the reason [`crate::client_window::open_client_window`] is:
/// a window built on the thread of the event loop never finishes loading.
#[tauri::command]
pub async fn open_chat_window(
    app: AppHandle,
    conversation_id: Option<String>,
    compact: Option<bool>,
) -> Result<()> {
    open(&app, conversation_id, compact)
}

/// The chat window's mode, switches and opacity.
#[tauri::command]
pub async fn chat_window_state(app: AppHandle) -> Result<ChatWindowView> {
    Ok(view(&app))
}

/// Turns the compact mode on or off. With no chat window open the choice is
/// kept for the next one.
#[tauri::command]
pub async fn chat_window_set_compact(app: AppHandle, on: bool) -> Result<ChatWindowView> {
    let state = app.state::<ChatWindowState>();
    let _step = state.step.enter();
    match app.get_webview_window(LABEL) {
        Some(window) => {
            switch(&app, &window, on)?;
        }
        None => {
            update(&app, |prefs| prefs.compact = on);
            persist(&app);
        }
    }
    let view = view(&app);
    emit_view(&app, view.clone());
    Ok(view)
}

/// «Always on top» of the mode the window is in: each mode keeps its own.
#[tauri::command]
pub async fn chat_window_set_always_on_top(app: AppHandle, on: bool) -> Result<ChatWindowView> {
    let state = app.state::<ChatWindowState>();
    let _step = state.step.enter();
    let prefs = update(&app, |prefs| prefs.set_on_top(on));
    if let Some(window) = app.get_webview_window(LABEL) {
        dress(&window, &prefs);
    }
    log::info!(
        "chat window: always on top {on} in the {} mode",
        prefs.mode().name()
    );
    persist(&app);
    let view = view(&app);
    emit_view(&app, view.clone());
    Ok(view)
}

/// The opacity of the compact mode, 40 to 100 percent.
#[tauri::command]
pub async fn chat_window_set_opacity(app: AppHandle, opacity: u8) -> Result<ChatWindowView> {
    if !(MIN_OPACITY..=MAX_OPACITY).contains(&opacity) {
        return Err(AppError::InvalidInput(format!(
            "opacity {opacity} is outside {MIN_OPACITY}..={MAX_OPACITY}"
        )));
    }
    let state = app.state::<ChatWindowState>();
    let _step = state.step.enter();
    let prefs = update(&app, |prefs| prefs.compact_opacity = opacity);
    if let Some(window) = app.get_webview_window(LABEL) {
        dress(&window, &prefs);
    }
    // A slider sends a value per step; the file gets the one it stops at.
    schedule_persist(&app);
    let view = view(&app);
    emit_view(&app, view.clone());
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: i32, y: i32, width: u32, height: u32) -> WindowBounds {
        WindowBounds {
            x,
            y,
            width,
            height,
        }
    }

    const SCREEN: Area = Area {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    /// A second screen to the left of the first, at 150 %.
    const LEFT: Area = Area {
        x: -2560,
        y: 0,
        width: 2560,
        height: 1400,
    };

    #[test]
    fn the_route_is_the_list_or_one_conversation() {
        assert_eq!(window_path(None), "index.html#/chat");
        assert_eq!(
            window_path(Some("01JC0Z8N1H3V4M5Q6R7S8T9V0W")),
            "index.html#/chat/01JC0Z8N1H3V4M5Q6R7S8T9V0W"
        );
        // The same form as a client window's: a fragment of `index.html`,
        // which survives `Url::join` in both modes.
        let joined = format!("http://tauri.localhost/{}", window_path(Some("abc")));
        assert_eq!(joined.split_once('#').unwrap().1, "/chat/abc");
    }

    #[test]
    fn only_an_id_reaches_the_address() {
        assert_eq!(clean_id(None).unwrap(), None);
        assert_eq!(clean_id(Some("  ".into())).unwrap(), None);
        assert_eq!(
            clean_id(Some(" 01JC0Z8N1H ".into())).unwrap().as_deref(),
            Some("01JC0Z8N1H")
        );
        for hostile in [
            "../settings",
            "a/b",
            "a#b",
            "a?b=1",
            "a b",
            "ы",
            &"a".repeat(65),
        ] {
            let error = clean_id(Some(hostile.to_string())).expect_err(hostile);
            assert!(
                matches!(error, AppError::InvalidInput(_)),
                "{hostile}: {error:?}"
            );
        }
    }

    #[test]
    fn each_mode_keeps_its_own_switch_and_only_the_compact_one_sees_through() {
        let mut prefs = ChatWindowSettings::default();
        assert_eq!(prefs.mode(), Mode::Full);
        assert!(!prefs.on_top(), "the full window starts like any window");
        assert!(!prefs.see_through(), "the full window is always opaque");

        prefs.compact = true;
        assert!(prefs.on_top(), "the compact window starts over the game");
        assert!(prefs.see_through(), "90 % by default");

        prefs.set_on_top(false);
        assert!(!prefs.compact_always_on_top && !prefs.always_on_top);
        prefs.compact = false;
        prefs.set_on_top(true);
        assert!(prefs.always_on_top && !prefs.compact_always_on_top);

        prefs.compact = true;
        prefs.compact_opacity = 100;
        assert!(!prefs.see_through(), "100 % needs no see-through webview");
        // A hand-edited file cannot lose the window.
        prefs.compact_opacity = 0;
        assert_eq!(prefs.opacity(), MIN_OPACITY);
        assert!(prefs.see_through());
        prefs.compact_opacity = 250;
        assert_eq!(prefs.opacity(), MAX_OPACITY);
    }

    #[test]
    fn the_view_names_the_switch_of_the_current_mode() {
        let mut prefs = ChatWindowSettings {
            always_on_top: true,
            compact_always_on_top: false,
            compact_opacity: 55,
            ..ChatWindowSettings::default()
        };
        let full = ChatWindowView::of(&prefs, true);
        assert_eq!(
            full,
            ChatWindowView {
                open: true,
                compact: false,
                always_on_top: true,
                opacity: 55
            }
        );
        prefs.compact = true;
        assert!(!ChatWindowView::of(&prefs, false).always_on_top);
        let json = serde_json::to_value(ChatWindowView::of(&prefs, false)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"open": false, "compact": true, "alwaysOnTop": false, "opacity": 55})
        );
    }

    #[test]
    fn bounds_belong_to_the_mode_they_were_taken_in() {
        let mut prefs = ChatWindowSettings::default();
        prefs.set_bounds(Mode::Full, bounds(10, 20, 1000, 700));
        prefs.compact = true;
        prefs.set_bounds(prefs.mode(), bounds(1500, 16, 360, 520));
        assert_eq!(prefs.bounds, Some(bounds(10, 20, 1000, 700)));
        assert_eq!(prefs.compact_bounds, Some(bounds(1500, 16, 360, 520)));
        assert_eq!(prefs.bounds_of(Mode::Full), prefs.bounds);
    }

    #[test]
    fn a_saved_window_comes_back_only_where_it_can_be_grabbed() {
        let areas = [SCREEN, LEFT];
        assert!(reachable(&bounds(100, 100, 960, 680), &areas));
        // On the second screen, left of the primary one.
        assert!(reachable(&bounds(-1500, 50, 360, 520), &areas));
        // Its title bar hangs just over the right edge, still grabbable.
        assert!(reachable(&bounds(1850, 400, 960, 680), &areas));
        // Only a sliver over the edge: not enough to drag.
        assert!(!reachable(&bounds(1900, 400, 960, 680), &areas));
        // The top edge above every screen, even if the body is on one.
        assert!(!reachable(&bounds(100, -600, 960, 680), &areas));
        // The second screen was unplugged.
        assert!(!reachable(&bounds(-1500, 50, 360, 520), &[SCREEN]));
        // No screen known: trust the file.
        assert!(reachable(&bounds(-1500, 50, 360, 520), &[]));
    }

    #[test]
    fn saved_bounds_grow_to_the_minimum_of_their_mode() {
        let small = bounds(5, 6, 300, 200);
        assert_eq!(fit(small, (640, 420)), bounds(5, 6, 640, 420));
        let large = bounds(5, 6, 1200, 900);
        assert_eq!(fit(large, (640, 420)), large);
    }

    #[test]
    fn a_new_full_window_is_centred_and_a_compact_one_sits_in_the_top_right_corner() {
        let full = default_bounds(Mode::Full, Some(SCREEN), 1.0, (0, 0));
        assert_eq!(full, bounds(480, 180, 960, 680));

        let compact = default_bounds(Mode::Compact, Some(SCREEN), 1.0, (0, 0));
        assert_eq!(compact, bounds(1920 - 360 - 16, 16, 360, 520));

        // At 150 % the sizes and the margin scale, the corner is the same.
        let scaled = default_bounds(Mode::Compact, Some(LEFT), 1.5, (0, 0));
        assert_eq!(scaled, bounds(-2560 + 2560 - 540 - 24, 24, 540, 780));
    }

    #[test]
    fn a_new_window_fits_a_small_screen_but_not_below_its_minimum() {
        let small = Area {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        };
        let full = default_bounds(Mode::Full, Some(small), 1.0, (0, 0));
        assert_eq!((full.width, full.height), (800, 600));
        assert_eq!((full.x, full.y), (0, 0));

        let tiny = Area {
            x: 0,
            y: 0,
            width: 500,
            height: 300,
        };
        let full = default_bounds(Mode::Full, Some(tiny), 1.0, (0, 0));
        assert_eq!((full.width, full.height), (640, 420), "the minimum wins");
        let compact = default_bounds(Mode::Compact, Some(tiny), 1.0, (0, 0));
        assert_eq!((compact.width, compact.height), (360, 420));
        assert!(
            compact.x >= 0,
            "the corner never pushes it off the left edge"
        );
    }

    #[test]
    fn without_a_screen_a_new_window_keeps_its_position() {
        let compact = default_bounds(Mode::Compact, None, 1.25, (70, 80));
        assert_eq!(compact, bounds(70, 80, 450, 650));
    }

    #[test]
    fn logical_sizes_turn_into_pixels_even_on_a_scale_windows_did_not_report() {
        assert_eq!(physical((360.0, 520.0), 1.0), (360, 520));
        assert_eq!(physical((360.0, 520.0), 1.25), (450, 650));
        assert_eq!(physical((360.0, 520.0), 0.0), (360, 520));
        assert_eq!(physical((360.0, 520.0), f64::NAN), (360, 520));
    }

    #[test]
    fn a_minimised_window_is_not_where_the_player_put_it() {
        assert!(is_real(&bounds(100, 100, 960, 680)));
        assert!(
            is_real(&bounds(-1500, 50, 360, 520)),
            "a screen on the left"
        );
        assert!(!is_real(&bounds(-32000, -32000, 160, 28)));
        assert!(!is_real(&bounds(100, 100, 0, 0)));
    }

    #[test]
    fn only_the_window_setting_keeps_chats_out_of_the_launcher() {
        assert!(is_main(crate::settings::CHAT_OPEN_IN_MAIN));
        assert!(!is_main(CHAT_OPEN_IN_WINDOW));
        assert!(is_main("popup"), "an unknown value is the default");
    }

    #[test]
    fn the_modes_leave_room_for_what_they_show() {
        // The split surface draws a 300 px list beside the thread.
        assert!(Mode::Full.min().0 >= 300.0 + 320.0);
        assert!(Mode::Full.size().0 >= Mode::Full.min().0);
        assert!(
            Mode::Compact.size().0 < Mode::Full.min().0,
            "compact is the narrow one"
        );
        assert!(Mode::Compact.size().0 >= Mode::Compact.min().0);
        assert!(Mode::Compact.size().1 >= Mode::Compact.min().1);
    }
}
