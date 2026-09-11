//! Shared state of the launcher, managed by Tauri and injected into commands.
//!
//! The state keeps two things: the fixed config root and the settings loaded
//! from it. Everything else — the data paths, the client list — is derived on
//! demand, so nothing can go stale after the user moves the data folder.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use crate::error::{AppError, Result};
use crate::paths::{self, DataPaths};
use crate::settings::Settings;

pub struct AppState {
    /// `%LOCALAPPDATA%\org.jknet.launcher`: the folder with `settings.json`.
    pub config_root: PathBuf,
    settings: Mutex<Settings>,
    // --- slice: client window ---
    client_records: StepLock,
    client_windows: StepLock,
}

impl AppState {
    /// Loads the state at startup. Never fails: a launcher that cannot read
    /// its settings must still open a window and say so.
    ///
    /// The caller resolves `config_root`, because the answer comes from
    /// `app.path().app_local_data_dir()` and this type has no `AppHandle`.
    ///
    /// Both fallbacks are logged to stderr rather than to the log plugin,
    /// because the log target itself depends on the paths resolved here.
    pub fn bootstrap(config_root: PathBuf) -> AppState {
        let state = AppState {
            config_root,
            settings: Mutex::new(Settings::default()),
            client_records: StepLock::default(),
            client_windows: StepLock::default(),
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

    // --- slice: client window ---

    /// The lock every read-modify-write of a `client.json` goes through.
    ///
    /// One lock for every client rather than one per client: a record is a few
    /// hundred bytes of JSON, and the launcher never saves two of them at once
    /// outside a test. See [`crate::clients::edit_record`].
    pub fn client_records(&self) -> &StepLock {
        &self.client_records
    }

    /// The lock that turns «is the window open? then open it» into one step.
    /// See [`crate::client_window::open_client_window`].
    pub fn client_windows(&self) -> &StepLock {
        &self.client_windows
    }
}

// --- slice: client window ---

/// A lock that guards no value: it holds a queue in front of a sequence of
/// steps that has to run whole.
///
/// Commands of the launcher are plain `fn`, and Tauri hands those to a pool of
/// blocking threads, so two of them genuinely run at the same moment. A client
/// has a window of its own next to the card of it in the main window, and both
/// edit the same record, which makes «read the file, change one field, write
/// the file» a sequence that must not interleave with itself.
#[derive(Debug, Default)]
pub struct StepLock(Mutex<()>);

impl StepLock {
    /// Waits for whoever is inside the sequence, then enters it. The sequence
    /// ends where the returned guard drops.
    ///
    /// A panic under this lock poisons it, and the poisoning is ignored —
    /// unlike everywhere else in the launcher, where a poisoned lock becomes
    /// an error. There is no value behind this one to leave half-written, and
    /// the rule it keeps, one thread at a time, holds again the moment the
    /// guard drops. Refusing every later edit until the launcher restarts
    /// would be the larger failure.
    pub fn enter(&self) -> MutexGuard<'_, ()> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
