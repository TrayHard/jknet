//! JKNet launcher core.
//!
//! Builds the Tauri application: plugins, shared state and the command
//! surface the React frontend calls through `src/lib/ipc.ts`.
//!
//! Module map:
//!
//! | Module           | Responsibility                                  |
//! | ---------------- | ----------------------------------------------- |
//! | `paths`          | data folders under `%LOCALAPPDATA%\JKNet` and their command |
//! | `settings`       | `settings.json` and its two commands            |
//! | `state`          | shared state injected into every command        |
//! | `game_files`     | finding `GameData` with `assets0.pk3`..`assets3.pk3` |
//! | `engines`        | static registry of engine builds                |
//! | `engine_install` | GitHub releases, downloads and archive unpacking |
//! | `clients`        | named engine instances on disk                  |
//! | `servers`        | master server queries, ping and the server cache |
//! | `launch`         | starting a client and watching it run           |
//! | `library`        | pk3 files of one client, in its `home\` folder  |

mod clients;
mod engine_install;
mod engines;
mod error;
mod game_files;
mod launch;
mod library;
mod paths;
mod servers;
mod settings;
mod state;
mod timestamp;

use engine_install::InstallState;
use launch::LaunchState;
use state::AppState;
use tauri_plugin_log::{Target, TargetKind};

/// Keeps a log file small enough to attach to a bug report.
const MAX_LOG_FILE_SIZE: u128 = 2 * 1024 * 1024;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::bootstrap();
    let log_dir = app_state
        .paths()
        .map(|paths| paths.logs)
        .unwrap_or_else(|_| std::env::temp_dir().join("JKNet").join("logs"));

    tauri::Builder::default()
        .plugin(
            // Stdout and a file, and deliberately no `TargetKind::Webview`:
            // `src/main.tsx` mirrors the frontend console into this plugin, so
            // a webview target would send every line straight back to it.
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(MAX_LOG_FILE_SIZE)
                .target(Target::new(TargetKind::Stdout))
                .target(Target::new(TargetKind::Folder {
                    path: log_dir,
                    file_name: Some("jknet".to_string()),
                }))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // --- slice: installer ---
        // `relaunch()` after the update installer hands control back.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_window_state::Builder::default().build())?;
                // --- slice: installer ---
                // The updater is desktop only: it has no mobile backend.
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            log::info!("JKNet {} started", app.package_info().version);
            Ok(())
        })
        .manage(app_state)
        // --- slice: launch ---
        // The running game lives in its own managed value: a process handle
        // has no business sitting behind the settings lock. The set of clients
        // with an install in flight is separate for the same reason.
        .manage(LaunchState::default())
        .manage(InstallState::default())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
