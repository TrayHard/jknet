//! JKNet launcher core.
//!
//! Builds the Tauri application: plugins, shared state and the command
//! surface the React frontend calls through `src/lib/ipc.ts`.
//!
//! Module map:
//!
//! | Module           | Responsibility                                  |
//! | ---------------- | ----------------------------------------------- |
//! | `paths`          | data folders under `%LOCALAPPDATA%\org.jknet.launcher` and their command |
//! | `settings`       | `settings.json` and its two commands            |
//! | `state`          | shared state injected into every command        |
//! | `game`           | the two games and every constant that differs between them |
//! | `game_files`     | finding the `GameData` of each game and its archives |
//! | `engines`        | static registry of engine builds                |
//! | `engine_install` | GitHub releases, downloads and archive unpacking |
//! | `clients`        | named engine instances on disk                  |
//! | `client_window`  | the separate window that edits one client       |
//! | `servers`        | master server queries, ping and the server cache |
//! | `launch`         | starting a client and watching it run           |
//! | `launch_tokens`  | one cvar at a time inside a client's argument line |
//! | `library`        | pk3 files of one client, in its `home\` folder  |
//! | `levelshots`     | map pictures extracted from the player's pk3 files |
//! | `online`         | JKNet Online: its wire types and its HTTP client |
//! | `account`        | signing in to the service and owning the account |
//! | `friends`        | friends, presence and invites on top of `online` |
//! | `jkhub`          | browsing jkhub.org and installing its files     |

mod account;
// --- slice: client window ---
// Opening, finding and closing the `client-<slug>` windows. Kept apart from
// `clients` because it is about windows, not records, and `clients` has to
// stay callable from a test with no Tauri runtime around it.
mod client_window;
mod clients;
mod engine_install;
mod engines;
mod error;
mod friends;
mod game;
mod game_files;
// --- slice: jkhub ---
// The public pages of jkhub.org, read behind a limiter and a cache. The module
// owns its own HTTP client because a guest download needs the cookie jar the
// file page was served with, which `online` has no reason to share.
mod jkhub;
mod launch;
// --- slice: client window ---
// Reading and writing one cvar inside the launch arguments of a client, so a
// dropdown and a hand-written command line edit the same string.
mod launch_tokens;
mod levelshots;
mod library;
// The one client of JKNet Online API v1. `account` calls its sign-in half and
// `friends` the rest, so a token is attached to a request in one place and
// one connection pool serves both.
mod online;
mod paths;
mod servers;
mod settings;
mod state;
mod timestamp;

use std::path::PathBuf;

use engine_install::InstallState;
use friends::FriendsState;
use launch::LaunchState;
use levelshots::LevelshotState;
use servers::RefreshState;
use state::AppState;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

/// Keeps a log file small enough to attach to a bug report.
const MAX_LOG_FILE_SIZE: u128 = 2 * 1024 * 1024;

/// Resolves the folder that holds `settings.json`.
///
/// Tauri answers `%LOCALAPPDATA%\org.jknet.launcher`, the folder named after
/// the bundle identifier. That is on purpose: the NSIS installer owns
/// `%LOCALAPPDATA%\JKNet`, and its uninstaller offers to delete exactly the
/// folder resolved here. The two fallbacks cover a machine where the resolver
/// finds nothing, and go to stderr because the log file lives under the path
/// this function returns.
fn resolve_config_root(app: &tauri::App) -> PathBuf {
    match app.path().app_local_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("jknet: {e}, resolving the data folder from the environment");
            paths::config_root().unwrap_or_else(|e| {
                eprintln!("jknet: {e}, falling back to the temp folder");
                std::env::temp_dir().join("org.jknet.launcher")
            })
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // --- slice: i18n ---
        // `locale()` alone: a launcher set to «System language» has to know
        // which language Windows is in before the first screen paints.
        .plugin(tauri_plugin_os::init())
        // --- slice: installer ---
        // `relaunch()` after the update installer hands control back.
        .plugin(tauri_plugin_process::init())
        // --- slice: client window ---
        // The launcher is one application with one way out. A client window
        // has no navigation of its own, so a `main` that closed while two of
        // them stayed open would leave a process alive behind windows that
        // cannot reach anything else. Both events are handled: `CloseRequested`
        // is the ordinary path and `Destroyed` covers a close that skipped it.
        //
        // Both are logged for every window, not only for `main`. A window that
        // refuses to close and a window that closed without the frontend
        // noticing look the same from outside; the log tells them apart,
        // because a click on the close button that reached the core leaves a
        // `close requested` line with the label of the window it came from.
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    log::info!("window {label}: close requested");
                }
                tauri::WindowEvent::Destroyed => {
                    log::info!("window {label}: destroyed");
                }
                _ => return,
            }
            if label != "main" {
                return;
            }
            // Best effort by design: `close_all` logs whatever refuses to
            // close and never panics, so the way out of the launcher cannot be
            // blocked by a window that is already gone.
            client_window::close_all(window.app_handle());
        })
        .setup(|app| {
            // Everything below needs the config root, and the config root needs
            // an `AppHandle`, so the whole bootstrap lives in `setup`. Nothing
            // from the webview can arrive first: Tauri runs `setup` inside
            // `build()`, before the event loop starts pumping messages.
            let config_root = resolve_config_root(app);
            // Earlier builds wrote into `%LOCALAPPDATA%\JKNet`. Their files
            // move here once, before anything reads `settings.json`. The report
            // waits for the log plugin a few lines down.
            let migration = match paths::legacy_config_root() {
                Ok(legacy_root) => {
                    let report = paths::migrate_legacy_root(&legacy_root, &config_root);
                    Some((legacy_root, report))
                }
                Err(e) => {
                    eprintln!("jknet: {e}, skipping the move out of the old data folder");
                    None
                }
            };

            let app_state = AppState::bootstrap(config_root);
            let log_dir = app_state
                .paths()
                .map(|paths| paths.logs)
                .unwrap_or_else(|_| std::env::temp_dir().join("org.jknet.launcher").join("logs"));

            // Stdout and a file, and deliberately no `TargetKind::Webview`:
            // `src/main.tsx` mirrors the frontend console into this plugin, so
            // a webview target would send every line straight back to it.
            //
            // `targets` replaces the plugin's own list, and `target` would
            // extend it. The default list holds `TargetKind::LogDir`, which
            // writes `JKNet.log` into `app_log_dir()` — the same folder, and on
            // a case-insensitive disk the same file, as the folder target
            // below. Two appenders on one file wrote every line twice.
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .level(log::LevelFilter::Info)
                    .max_file_size(MAX_LOG_FILE_SIZE)
                    .targets([
                        Target::new(TargetKind::Stdout),
                        Target::new(TargetKind::Folder {
                            path: log_dir,
                            file_name: Some("jknet".to_string()),
                        }),
                    ])
                    .build(),
            )?;
            if let Some((legacy_root, report)) = &migration {
                report.report(legacy_root, &app_state.config_root);
            }
            // --- slice: maps ---
            // The asset protocol serves `cache\levelshots\` to the webview.
            // `tauri.conf.json` scopes it to the folder under `$APPLOCALDATA`;
            // this adds the resolved one, which differs when the player moved
            // the data folder with `dataDirOverride`.
            if let Ok(paths) = app_state.paths() {
                levelshots::allow_cache_folder(app.handle(), &paths);
            }
            app.manage(app_state);

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_window_state::Builder::default().build())?;
                // --- slice: installer ---
                // The updater is desktop only: it has no mobile backend.
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // --- slice: account ---
            // From here on a service that refuses the stored token signs the
            // launcher out, instead of leaving a signed-in sidebar over a
            // screen where every call fails. The client reports the refusal,
            // `account` owns what it means.
            let signed_out = app.handle().clone();
            app.state::<online::OnlineClient>()
                .report_refusals_to(move |token| {
                    account::expire_session(&signed_out, token);
                });
            // --- slice: friends ---
            // The heartbeat and the live socket. Both start signed out and
            // cost nothing until a token appears, and neither of them touches
            // the window, so nothing here can hold up the first frame.
            friends::start(app.handle());
            // --- slice: jkhub ---
            // One client, one cookie jar and one limiter for the whole run.
            // Built here rather than per call: the session a `csrfKey` belongs
            // to is the session that jar holds.
            jkhub::manage(app.handle());
            // --- slice: jkhub index startup ---
            // Which folder the bundled category trees and catalogue indexes
            // come from, and what is missing from it. A build that shipped
            // without one used to be noticed as a crawl the day somebody
            // searched; now it is a line in the first page of the log.
            jkhub::snapshot::check(app.handle());
            // And the index itself, a few seconds from now: building it under
            // a player who has already typed a word is what this replaces.
            // Nothing here blocks the window — the work is a spawned task, and
            // the plan is usually «nothing».
            jkhub::prewarm::start(app.handle());
            // --- review: downloads of failed installs are never removed ---
            // An install that ended yesterday cannot be resumed by any screen
            // open today, so its archive goes. A scan of a folder with a
            // handful of entries, and a failure inside is a line in the log.
            if let Ok(paths) = app.state::<AppState>().paths() {
                jkhub::download::sweep(&paths, jkhub::download::KEPT_FOR);
            }

            log::info!("JKNet {} started", app.package_info().version);
            // --- slice: online gate ---
            // The first question a report about a missing Friends screen has
            // to answer: this build has no service, or it has one and cannot reach
            // it. The address is not a secret; the token never appears here.
            match app.state::<AppState>().settings() {
                Ok(settings) => {
                    let url = online::normalize_online_url(&settings.online_url);
                    if online::online_configured(&url) {
                        log::info!("online: {url}");
                    } else {
                        log::info!(
                            "online: not configured in this build, so the account and friends screens stay switched off"
                        );
                    }
                }
                Err(e) => log::warn!("cannot read the service address: {e}"),
            }
            Ok(())
        })
        // --- slice: launch ---
        // The running game lives in its own managed value: a process handle
        // has no business sitting behind the settings lock. The set of clients
        // with an install in flight is separate for the same reason.
        .manage(LaunchState::default())
        .manage(InstallState::default())
        // --- slice: maps ---
        // One rebuild of the levelshot index at a time, and the set of maps
        // nothing on this disk has a picture for.
        .manage(LevelshotState::default())
        // --- slice: account ---
        // One connection pool for every call to the service. Where to call and
        // who to call as come from the settings at the moment of the call, so
        // nothing here goes stale when the player signs in or points the
        // launcher at another service.
        .manage(online::OnlineClient::new())
        // --- slice: friends ---
        // The presence the launcher reports and whether the live socket is
        // up. Kept apart from `AppState` for the same reason as the two above:
        // a background task must not queue behind a settings write.
        .manage(FriendsState::default())
        // --- slice: servers browser ---
        // Which tabs of which game have a scan in flight. Two tabs may scan at
        // once, one tab may not scan twice: the guard lives here rather than in
        // a disabled button, because a reloaded window would press it again.
        .manage(RefreshState::default())
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::update_settings,
            paths::get_data_paths,
            game_files::detect_game_files,
            // --- slice: game core ---
            // The two games and the names the interface prints for them.
            game::list_games,
            // `inspect_game_files` became `validate_game_data`: the same work
            // for one folder, plus the game it is being checked against.
            game_files::validate_game_data,
            engines::list_engines,
            clients::list_clients,
            clients::create_client,
            clients::update_client,
            clients::delete_client,
            // --- slice: client window ---
            client_window::open_client_window,
            launch_tokens::read_launch_cvars,
            launch_tokens::write_launch_cvar,
            launch::preview_launch_args,
            launch::launch_client,
            // --- slice: library ---
            library::list_library,
            library::inspect_pk3,
            library::add_library_files,
            library::set_library_item_enabled,
            library::remove_library_item,
            library::rename_library_item,
            library::find_library_conflicts,
            // --- slice: launch ---
            engines::list_engine_releases,
            engines::install_engine,
            engines::check_engine_update,
            launch::get_running_game,
            launch::stop_game,
            // --- slice: servers ---
            servers::get_cached_servers,
            servers::refresh_servers,
            servers::refresh_addresses,
            servers::refresh_lan,
            servers::get_server_status,
            servers::set_server_favorite,
            servers::add_server_history,
            // --- slice: maps ---
            levelshots::get_levelshot,
            levelshots::rebuild_levelshots,
            levelshots::list_levelshots,
            // --- slice: account ---
            account::get_account_state,
            account::begin_sign_in,
            account::poll_sign_in,
            account::sign_out,
            account::update_display_name,
            account::delete_account,
            // --- slice: friends ---
            friends::get_friends_state,
            friends::send_friend_request,
            friends::accept_friend_request,
            friends::decline_friend_request,
            friends::remove_friend,
            friends::send_invite,
            friends::dismiss_invite,
            friends::join_friend,
            // --- slice: jkhub ---
            jkhub::jkhub_categories,
            jkhub::jkhub_list,
            jkhub::jkhub_file,
            jkhub::jkhub_resolve_download,
            jkhub::jkhub_install,
            jkhub::jkhub_open,
            jkhub::jkhub_clear_cache,
            // --- slice: jkhub index ---
            jkhub::jkhub_search,
            jkhub::jkhub_index_status,
            jkhub::jkhub_refresh_index,
            // --- slice: jkhub index startup ---
            jkhub::jkhub_cancel_index,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
