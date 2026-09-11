//! The separate window that edits one client.
//!
//! The gear on a client card used to open a modal dialog over the Clients
//! screen. A dialog can hold three fields; the window holds the engine, the
//! mod folder, the video mode, the volumes, the player name, the frame and
//! network limits, the raw argument line and a preview of the command line the
//! engine will receive — and it leaves the main window usable while the player
//! reads all of it.
//!
//! ## Labels
//!
//! One window per client, labelled `client-<slug>`. The label is the identity
//! Tauri works with: a second call to [`open_client_window`] finds the window
//! by it and raises that one instead of opening a duplicate, and the
//! capability file `capabilities/client-window.json` grants its permissions by
//! matching `client-*`. Client slugs are lowercase ASCII with hyphens
//! ([`crate::clients`]), which is inside the alphabet Tauri allows in a label.
//!
//! ## Lifetime
//!
//! A client window never outlives the launcher. Closing `main` closes every
//! one of them ([`close_all`], wired to the window event in `lib.rs`), because
//! an app whose last visible window is a settings page nobody can navigate out
//! of is an app that looks like it failed to quit. Deleting a client closes
//! its window for the same reason, and `closeOnLaunch` hides and shows them
//! along with the main window.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::clients;
use crate::error::Result;
use crate::state::AppState;

/// Prefix of every client window label, and the pattern the capability file
/// matches. Change one and change the other.
const LABEL_PREFIX: &str = "client-";

/// Inner size of a fresh client window.
const WIDTH: f64 = 720.0;
const HEIGHT: f64 = 720.0;

/// Below this the two-column rows of the video and network cards wrap into an
/// unreadable stack.
const MIN_WIDTH: f64 = 640.0;
const MIN_HEIGHT: f64 = 600.0;

/// Same first paint as the main window, whose `backgroundColor` in
/// `tauri.conf.json` is `#0B0E14`. Anything else flashes on open.
const BACKGROUND: tauri::window::Color = tauri::window::Color(0x0B, 0x0E, 0x14, 255);

/// The window label of a client.
pub fn label_for(client_id: &str) -> String {
    format!("{LABEL_PREFIX}{client_id}")
}

/// True for the label of any client window.
pub fn is_client_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Opens the editing window of a client, or raises the one already open.
///
/// The client is read before the window is built, so a call naming a record
/// that is not there fails with `NotFound` instead of opening a window that
/// would show an error and nothing else. The name becomes the window title.
#[tauri::command]
pub fn open_client_window(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<()> {
    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    let label = label_for(&client.id);

    if let Some(window) = app.get_webview_window(&label) {
        // Already open: raise it. `show` and `unminimize` are here because the
        // window may have been hidden by `closeOnLaunch` or minimised by the
        // player, and `set_focus` alone leaves both states as they were.
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    // `WebviewUrl::App` is a path inside the bundled frontend, and the router
    // is a `HashRouter`, so the route has to be a fragment of `index.html`.
    let url = WebviewUrl::App(format!("index.html#/client/{}", client.id).into());
    WebviewWindowBuilder::new(&app, &label, url)
        .title(&client.name)
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(false)
        .background_color(BACKGROUND)
        .build()
        .map_err(|e| {
            crate::error::AppError::State(format!("cannot open the window of {}: {e}", client.id))
        })?;
    log::info!("opened the client window {label}");
    Ok(())
}

/// Closes the window of one client, if it is open.
pub fn close_for(app: &AppHandle, client_id: &str) {
    let label = label_for(client_id);
    if let Some(window) = app.get_webview_window(&label) {
        if let Err(e) = window.close() {
            log::warn!("cannot close {label}: {e}");
        }
    }
}

/// Closes every client window.
///
/// Called when `main` goes away. `close` rather than `destroy`: the window has
/// nothing to ask the player about, and `close` is what the frontend listeners
/// see coming.
pub fn close_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if !is_client_label(&label) {
            continue;
        }
        if let Err(e) = window.close() {
            log::warn!("cannot close {label}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_names_its_client_and_nothing_else() {
        assert_eq!(label_for("everyday"), "client-everyday");
        assert!(is_client_label(&label_for("duel-japro")));
        assert!(!is_client_label("main"));
    }
}
