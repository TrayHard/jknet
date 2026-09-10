//! Where JKNet keeps its own files.
//!
//! Two roots, on purpose:
//!
//! * The **config root** is always `%LOCALAPPDATA%\JKNet`. It holds
//!   `settings.json` and nothing else. It cannot move, otherwise the launcher
//!   would have to find its settings before reading its settings.
//! * The **data root** holds `clients\`, `library\`, `cache\` and `logs\`. It
//!   equals the config root until the user sets `data_dir_override`, which is
//!   what a player with a small system disk does.
//!
//! Nothing here ever writes into the game folder: JKNet only reads
//! `base\assets0.pk3`..`assets3.pk3` from it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::state::AppState;

/// Name of the folder JKNet creates inside `%LOCALAPPDATA%`.
const APP_FOLDER: &str = "JKNet";

/// The four subfolders of the data root.
#[derive(Debug, Clone)]
pub struct DataPaths {
    /// Root of the data folders. Equals the config root unless overridden.
    pub root: PathBuf,
    /// One folder per client: `clients\<slug>\`.
    pub clients: PathBuf,
    /// Downloaded pk3 files shared by all clients.
    pub library: PathBuf,
    /// Server lists, JKHub responses and other throwaway data.
    pub cache: PathBuf,
    /// Rotating log files written by `tauri-plugin-log`.
    pub logs: PathBuf,
}

impl DataPaths {
    /// Builds the layout under `root` without touching the disk.
    pub fn new(root: PathBuf) -> Self {
        DataPaths {
            clients: root.join("clients"),
            library: root.join("library"),
            cache: root.join("cache"),
            logs: root.join("logs"),
            root,
        }
    }

    /// Creates every folder of the layout. Existing folders are left alone.
    pub fn ensure(&self) -> Result<()> {
        for path in [
            &self.root,
            &self.clients,
            &self.library,
            &self.cache,
            &self.logs,
        ] {
            create_dir(path)?;
        }
        Ok(())
    }

    /// Folder of one client: `clients\<slug>\`.
    pub fn client_dir(&self, slug: &str) -> PathBuf {
        self.clients.join(slug)
    }
}

/// Returns `%LOCALAPPDATA%\JKNet`, the folder that holds `settings.json`.
///
/// Falls back to the system temp folder when `LOCALAPPDATA` is missing, which
/// happens in stripped-down CI containers but not on a player's machine.
pub fn config_root() -> Result<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(std::env::temp_dir);

    if base.as_os_str().is_empty() {
        return Err(AppError::Path(
            "LOCALAPPDATA is empty and there is no fallback".into(),
        ));
    }
    Ok(base.join(APP_FOLDER))
}

/// Path of the settings document.
pub fn settings_file(config_root: &Path) -> PathBuf {
    config_root.join("settings.json")
}

/// Resolves the data root: the override when the user set one, the config root
/// otherwise. An override that is blank or relative is ignored.
pub fn data_root(config_root: &Path, override_path: Option<&str>) -> PathBuf {
    match override_path.map(str::trim) {
        Some(value) if !value.is_empty() && Path::new(value).is_absolute() => PathBuf::from(value),
        _ => config_root.to_path_buf(),
    }
}

/// Creates a directory and every missing parent.
pub fn create_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| AppError::io_path("cannot create", path, e))
}

/// The two roots as strings, for the Settings screen.
///
/// The frontend needs the resolved paths for two things: printing them and
/// handing the data root to the opener plugin. Both want text, so the command
/// converts once here instead of in every caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPathsView {
    /// `%LOCALAPPDATA%\JKNet`: the folder that holds `settings.json`.
    pub config_root: String,
    /// Root of `clients\`, `library\`, `cache\` and `logs\`.
    pub data_root: String,
}

/// Returns the folders JKNet writes into, resolved for the current settings.
#[tauri::command]
pub fn get_data_paths(state: tauri::State<'_, AppState>) -> Result<DataPathsView> {
    Ok(DataPathsView {
        config_root: state.config_root.display().to_string(),
        data_root: state.paths()?.root.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_hangs_off_the_root() {
        let paths = DataPaths::new(PathBuf::from("C:\\JKNet"));
        assert!(paths.clients.ends_with("clients"));
        assert!(paths.logs.ends_with("logs"));
        assert_eq!(paths.client_dir("everyday"), paths.clients.join("everyday"));
    }

    #[test]
    fn a_relative_override_is_ignored() {
        let config = Path::new("C:\\Users\\player\\AppData\\Local\\JKNet");
        assert_eq!(data_root(config, Some("  ")), config);
        assert_eq!(data_root(config, Some("data")), config);
        assert_eq!(data_root(config, None), config);
    }

    #[cfg(windows)]
    #[test]
    fn an_absolute_override_wins() {
        let config = Path::new("C:\\Users\\player\\AppData\\Local\\JKNet");
        assert_eq!(
            data_root(config, Some("D:\\Games\\JKNet")),
            PathBuf::from("D:\\Games\\JKNet")
        );
    }
}
