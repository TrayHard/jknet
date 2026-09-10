//! Shared state of the launcher, managed by Tauri and injected into commands.
//!
//! The state keeps two things: the fixed config root and the settings loaded
//! from it. Everything else — the data paths, the client list — is derived on
//! demand, so nothing can go stale after the user moves the data folder.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::{AppError, Result};
use crate::paths::{self, DataPaths};
use crate::settings::Settings;

pub struct AppState {
    /// `%LOCALAPPDATA%\JKNet`: the folder that holds `settings.json`.
    pub config_root: PathBuf,
    settings: Mutex<Settings>,
}

impl AppState {
    /// Loads the state at startup. Never fails: a launcher that cannot read
    /// its settings must still open a window and say so.
    ///
    /// Both fallbacks are logged to stderr rather than to the log plugin,
    /// because the log target itself depends on the paths resolved here.
    pub fn bootstrap() -> AppState {
        let config_root = paths::config_root().unwrap_or_else(|e| {
            eprintln!("jknet: {e}, falling back to the temp folder");
            std::env::temp_dir().join("JKNet")
        });

        let state = AppState {
            config_root,
            settings: Mutex::new(Settings::default()),
        };

        match Settings::load(&state) {
            Ok(settings) => {
                if let Ok(mut guard) = state.settings.lock() {
                    *guard = settings;
                }
            }
            Err(e) => eprintln!("jknet: {e}, starting with default settings"),
        }

        if let Err(e) = state.paths().and_then(|paths| paths.ensure()) {
            eprintln!("jknet: {e}");
        }

        state
    }

    /// Returns a copy of the current settings.
    pub fn settings(&self) -> Result<Settings> {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| AppError::State("settings lock is poisoned".into()))
    }

    /// Replaces the in-memory settings. The caller writes the file.
    pub fn set_settings(&self, settings: Settings) -> Result<()> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|_| AppError::State("settings lock is poisoned".into()))?;
        *guard = settings;
        Ok(())
    }

    /// Resolves the data folders for the settings in force right now.
    pub fn paths(&self) -> Result<DataPaths> {
        let settings = self.settings()?;
        Ok(DataPaths::new(paths::data_root(
            &self.config_root,
            settings.data_dir_override.as_deref(),
        )))
    }
}
