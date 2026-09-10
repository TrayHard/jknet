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
//! | `game_files`     | finding `GameData` with `assets0.pk3`..`assets3.pk3` |
//! | `engines`        | static registry of engine builds                |
//! | `engine_install` | GitHub releases, downloads and archive unpacking |
//! | `clients`        | named engine instances on disk                  |
//! | `servers`        | master server queries, ping and the server cache |
//! | `launch`         | starting a client and watching it run           |
//! | `library`        | pk3 files of one client, in its `home\` folder  |
//! | `levelshots`     | map pictures extracted from the player's pk3 files |
//! | `hub`            | the JKNet hub: its wire types and its HTTP client |
//! | `account`        | signing in to the hub and owning the account    |
//! | `friends`        | friends, presence and invites on top of `hub`   |

mod account;
mod clients;
mod engine_install;
mod engines;
mod error;
mod friends;
mod game_files;
// The one client of hub API v1. `account` calls its sign-in half and
// `friends` the rest, so a token is attached to a request in one place and
// one connection pool serves both.
mod hub;
mod launch;
mod levelshots;
mod library;
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
        // --- slice: installer ---
        // `relaunch()` after the update installer hands control back.
        .plugin(tauri_plugin_process::init())
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
            // From here on a hub that refuses the stored token signs the
            // launcher out, instead of leaving a signed-in sidebar over a
            // screen where every call fails. The client reports the refusal,
            // `account` owns what it means.
            let signed_out = app.handle().clone();
            app.state::<hub::HubClient>()
                .report_refusals_to(move |token| {
                    account::expire_session(&signed_out, token);
                });
            // --- slice: friends ---
            // The heartbeat and the live socket. Both start signed out and
            // cost nothing until a token appears, and neither of them touches
            // the window, so nothing here can hold up the first frame.
            friends::start(app.handle());

            log::info!("JKNet {} started", app.package_info().version);
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
        // One connection pool for every call to the hub. Where to call and
        // who to call as come from the settings at the moment of the call, so
        // nothing here goes stale when the player signs in or points the
        // launcher at another hub.
        .manage(hub::HubClient::new())
        // --- slice: friends ---
        // The presence the launcher reports and whether the live socket is
        // up. Kept apart from `AppState` for the same reason as the two above:
        // a background task must not queue behind a settings write.
        .manage(FriendsState::default())
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::update_settings,
            paths::get_data_paths,
            game_files::detect_game_files,
            game_files::inspect_game_files,
            engines::list_engines,
            clients::list_clients,
            clients::create_client,
            clients::update_client,
            clients::delete_client,
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
            servers::get_server_status,
            servers::list_trusted_servers,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
