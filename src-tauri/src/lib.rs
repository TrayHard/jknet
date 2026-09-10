//! JKNet launcher core.
//!
//! Builds the Tauri application: plugins, shared state and the command
//! surface the React frontend calls through `src/lib/ipc.ts`.
//!
//! Module map:
//!
//! | Module        | Responsibility                                     |
//! | ------------- | -------------------------------------------------- |
//! | `paths`       | data folders under `%LOCALAPPDATA%\JKNet` and their command |
//! | `settings`    | `settings.json` and its two commands                |
//! | `state`       | shared state injected into every command            |
//! | `game_files`  | finding `GameData` with `assets0.pk3`..`assets3.pk3` |
//! | `engines`     | static registry of engine builds                    |
//! | `clients`     | named engine instances on disk                      |
//! | `servers`     | server browser (stub)                               |
//! | `launch`      | starting a client (stub)                            |
//! | `library`     | pk3 files of one client, in its `home\` folder      |

mod clients;
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
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;
            log::info!("JKNet {} started", app.package_info().version);
            Ok(())
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::update_settings,
            paths::get_data_paths,
            game_files::detect_game_files,
            game_files::inspect_game_files,
            engines::list_engines,
            clients::list_clients,
            clients::create_client,
            clients::rename_client,
            clients::delete_client,
            servers::list_servers,
            servers::refresh_servers,
            launch::launch_client,
            // --- slice: library ---
            library::list_library,
            library::inspect_pk3,
            library::add_library_files,
            library::set_library_item_enabled,
            library::remove_library_item,
            library::rename_library_item,
            library::find_library_conflicts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
