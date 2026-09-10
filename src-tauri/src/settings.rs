//! Launcher settings: one JSON document in the config root.
//!
//! `update_settings` replaces the whole document. The frontend holds the
//! current value in a React Query cache and sends the merged object, so a
//! partial patch type would only add a second shape to keep in sync.

use std::fs;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths;
use crate::state::AppState;

/// Everything the launcher remembers between runs, except window geometry
/// (that belongs to `tauri-plugin-window-state`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Folder with `base\assets0.pk3`..`assets3.pk3`, confirmed by the user.
    /// `None` means the first run has not finished yet.
    pub game_data_path: Option<String>,
    /// Client started by the Play button. `None` disables the button.
    pub default_client_id: Option<String>,
    /// Hide the launcher window while the game is running.
    pub close_on_launch: bool,
    /// Absolute path that replaces the config root for `clients`, `library`,
    /// `cache` and `logs`. Ignored when it is relative or blank.
    pub data_dir_override: Option<String>,

    // --- slice: launch ---
    /// Extra tokens appended to every command line, exactly as a player would
    /// type them in a shortcut: `+set r_mode -1 +set cl_renderer rd-rend2`.
    /// Split on whitespace with double-quoted groups kept whole.
    pub extra_launch_args: String,
}

impl Settings {
    /// Reads `settings.json`. A missing file yields the defaults; a corrupted
    /// file is an error, so the launcher never silently drops a player's
    /// configuration.
    pub fn load(state: &AppState) -> Result<Settings> {
        let file = paths::settings_file(&state.config_root);
        match fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| AppError::json(format!("cannot parse {}", file.display()), e)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(AppError::io_path("cannot read", &file, e)),
        }
    }

    /// Writes `settings.json`, creating the config root when needed.
    pub fn save(&self, state: &AppState) -> Result<()> {
        paths::create_dir(&state.config_root)?;
        let file = paths::settings_file(&state.config_root);
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::json("cannot serialize settings", e))?;
        fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
    }
}

/// Returns the current settings.
#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Result<Settings> {
    state.settings()
}

/// Replaces the settings document and recreates the data folders, which may
/// have moved because `dataDirOverride` changed.
#[tauri::command]
pub fn update_settings(
    state: tauri::State<'_, AppState>,
    settings: Settings,
) -> Result<Settings> {
    settings.save(&state)?;
    state.set_settings(settings.clone())?;
    state.paths()?.ensure()?;
    log::info!("settings updated, data root is {}", state.paths()?.root.display());
    Ok(settings)
}
