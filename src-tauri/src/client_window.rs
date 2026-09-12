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
//! A client window never outlives the launcher. Closing `main` destroys every
//! one of them ([`close_all`], wired to the window event in `lib.rs`), because
//! an app whose last visible window is a settings page nobody can navigate out
//! of is an app that looks like it failed to quit. Deleting a client closes
//! its window for the same reason, and `closeOnLaunch` hides and shows them
//! along with the main window — `hide`, not `close`, so nothing in this
//! section touches it.
//!
//! ## Diagnostics
//!
//! Every step of opening a window is a line in `logs\JKNet.log`: the label and
//! the URL before the build, the label after it, and the text of the failure
//! instead of a silent `Err`. A window that comes up blank is otherwise
//! invisible to a bug report — the frontend of a window that never mounted
//! cannot write anything either.

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

/// The path a client window is opened at, for [`WebviewUrl::App`].
///
/// The router is a `HashRouter`, so the route is a fragment. Which fragment
/// form survives depends on how Tauri turns the path into an address, and the
/// sources of `tauri` 2.11.5 answer that in two places:
///
/// - `src/manager/webview.rs:444-459` joins the path onto the application URL
///   with `Url::join` — `devUrl` under `npm run tauri dev`, `tauri://localhost`
///   (`http://tauri.localhost` on Windows) in a build. The one path it does not
///   join is the bare `index.html`, special-cased at line 451 as a
///   simplification. `Url::join` keeps the fragment of the relative reference,
///   so `index.html#/client/<id>`, `#/client/<id>` and `/#/client/<id>` all
///   reach the webview with the fragment intact.
/// - `src/protocol/tauri.rs:149-153` strips the query and the fragment before
///   the bundle is read, and `src/manager/mod.rs:384-402` then resolves the
///   remaining path: `index.html` is found by name, while an empty path is
///   turned into `index.html` by the branch at line 397.
///
/// So all three forms work in both modes, and `index.html#/client/<id>` is the
/// one the sources name literally at both ends: the file exists under that name
/// in `frontendDist` and is served under it by Vite, instead of depending on an
/// index fallback. That is why it is the form here.
fn window_path(client_id: &str) -> String {
    format!("index.html#/client/{client_id}")
}

/// Opens the editing window of a client, or raises the one already open.
///
/// The client is read before the window is built, so a call naming a record
/// that is not there fails with `NotFound` instead of opening a window that
/// would show an error and nothing else. The name becomes the window title.
///
/// `async` on purpose, and not for any work that waits. Tauri runs a plain
/// `fn` command on the thread that received the message, which on Windows is
/// the thread pumping the WebView2 message loop, and building a webview from
/// there is the known deadlock of `wry` issue 583: the new window appears,
/// its webview never finishes initialising, and the loop that would close it
/// is the loop that is stuck. The sources say so twice —
/// `tauri-2.11.5/src/webview/webview_window.rs:56-59` and `:113-116`, under
/// «Known issues»: *«You should use `async` commands and separate threads when
/// creating windows»*. An `async` command runs on the async runtime, so the
/// build is dispatched to the event loop instead of being run inside it.
#[tauri::command]
pub async fn open_client_window(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<()> {
    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    let label = label_for(&client.id);

    // Looking for the window and building one are a single step. Two clicks on
    // the same gear inside the same instant arrive as two commands on two
    // threads of the async runtime: without this, both see no window and both
    // build one. Nothing between `enter` and the end of the sequence awaits, so
    // the guard never crosses a suspension point.
    let _step = state.client_windows().enter();

    if let Some(window) = app.get_webview_window(&label) {
        log::info!("the client window {label} is open, raising it");
        raise(&window);
        return Ok(());
    }

    // `WebviewUrl::App` is a path inside the bundled frontend; see
    // [`window_path`] for why the route travels as a fragment of `index.html`.
    let path = window_path(&client.id);
    log::info!("opening the client window {label} at {path}");
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(path.into()))
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
        Err(e) => {
            // The branch that used to answer the frontend and tell the log
            // nothing. A build that fails here is the one failure a blank
            // window cannot report by itself.
            log::error!("cannot build the client window {label}: {e}");
            Err(crate::error::AppError::State(format!(
                "cannot open the window of {}: {e}",
                client.id
            )))
        }
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

/// Destroys every client window.
///
/// Called when `main` goes away.
///
/// --- slice: profiles polish ---
/// `destroy` and not `close`, and the difference is now the whole point.
/// `close` raises `CloseRequested` in the window (`tauri-2.11.5`,
/// `window/mod.rs:1793-1796`), and the client window answers that event with a
/// guard that always prevents the default and, over an unsaved profile, opens
/// a **Discard changes?** dialog. Sent while `main` is on its way out, that
/// question would be asked of a window nobody is looking at — one that may be
/// minimised or was hidden by `closeOnLaunch` — and the process would stay
/// alive behind it waiting for an answer, which is the exact thing this
/// function exists to prevent. `destroy` emits no event and takes the window
/// down (`window/mod.rs:1798-1801`).
///
/// The cost is the honest one: an unsaved profile in a client window is lost
/// when the player quits the launcher. Quitting is not the moment to hold the
/// application open over a form in another window; the two ordinary ways out
/// of that form — **Cancel** and closing the client window itself — still ask.
///
/// [`close_for`] keeps `close`, because a window closed one at a time is a
/// window the player is looking at and can answer for.
pub fn close_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if !is_client_label(&label) {
            continue;
        }
        if let Err(e) = window.destroy() {
            log::warn!("cannot destroy {label}: {e}");
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

    #[test]
    fn the_route_travels_as_a_fragment_of_index_html() {
        assert_eq!(window_path("everyday"), "index.html#/client/everyday");
        // Not the bare `index.html`: that path is the one Tauri skips joining,
        // and the window would open on the route of the main one.
        assert_ne!(window_path("everyday"), "index.html");
        // The fragment has to survive `Url::join`, and it is what `App` reads
        // to decide that this document is a client window.
        assert!(window_path("duel-japro").contains("#/client/"));
    }

    /// The address the window ends up at, in both modes: Tauri joins the path
    /// onto the application URL, and the asset handler then drops the fragment
    /// (`tauri-2.11.5/src/manager/webview.rs:444-459`, `src/protocol/tauri.rs:149-153`).
    #[test]
    fn the_path_joins_onto_both_application_urls() {
        let path = window_path("everyday");
        for base in ["http://localhost:1420/", "http://tauri.localhost/"] {
            let joined = format!("{base}{path}");
            let document = joined.split('#').next().unwrap();
            let fragment = joined.split_once('#').unwrap().1;
            assert_eq!(document, format!("{base}index.html"));
            assert_eq!(fragment, "/client/everyday");
        }
    }
}
