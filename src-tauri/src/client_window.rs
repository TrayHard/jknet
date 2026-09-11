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

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

    // Looking for the window and building one are a single step. The command
    // is a plain `fn` on Tauri's blocking pool, so two clicks on the same gear
    // inside the same instant arrive on two threads: without this, both see no
    // window and both build one.
    let _step = state.client_windows().enter();

    if let Some(window) = app.get_webview_window(&label) {
        raise(&window);
        return Ok(());
    }

    // `WebviewUrl::App` is a path inside the bundled frontend, and the router
    // is a `HashRouter`, so the route has to be a fragment of `index.html`.
    let url = WebviewUrl::App(format!("index.html#/client/{}", client.id).into());
    let built = WebviewWindowBuilder::new(&app, &label, url)
        .title(&client.name)
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(false)
        .background_color(BACKGROUND)
        .build();

    match built {
        Ok(_) => {
            log::info!("opened the client window {label}");
            Ok(())
        }
        // The window turned out to be there. Whoever else holds the label
        // holds it for this same client — labels are built from the slug — so
        // the answer to the click is that window, not a message about a name
        // the player has never seen.
        Err(tauri::Error::WebviewLabelAlreadyExists(_)) => {
            log::info!("the client window {label} was already open");
            if let Some(window) = app.get_webview_window(&label) {
                raise(&window);
            }
            Ok(())
        }
        Err(e) => Err(crate::error::AppError::State(format!(
            "cannot open the window of {}: {e}",
            client.id
        ))),
    }
}

/// Brings a window the player already has in front of them.
///
/// `show` and `unminimize` are here because the window may have been hidden by
/// `closeOnLaunch` or minimised by the player, and `set_focus` alone leaves
/// both states as they were. Every step is best effort: a window that will not
/// come up is not worth an error over a card the player can click again.
fn raise(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
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
