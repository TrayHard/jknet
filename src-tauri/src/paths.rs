//! Where JKNet keeps its own files.
//!
//! Two roots, on purpose:
//!
//! * The **config root** is Tauri's app local data folder,
//!   `%LOCALAPPDATA%\org.jknet.launcher`. It holds `settings.json` and nothing
//!   else. It cannot move, otherwise the launcher would have to find its
//!   settings before reading its settings.
//! * The **data root** holds `clients\`, `library\`, `cache\` and `logs\`. It
//!   equals the config root until the user sets `data_dir_override`, which is
//!   what a player with a small system disk does.
//!
//! The config root is named after the bundle identifier for a reason. The NSIS
//! installer in `currentUser` mode puts the program itself into
//! `%LOCALAPPDATA%\JKNet`, and its uninstaller wipes
//! `%LOCALAPPDATA%\org.jknet.launcher` when the player ticks **Delete app
//! data**. Player files therefore live in the second folder, away from the
//! executable and inside the folder the uninstaller offers to clean.
//! `migrate_legacy_root` carries over what earlier builds wrote into the
//! first one.
//!
//! Nothing here ever writes into the game folder: JKNet only reads
//! `base\assets0.pk3`..`assets3.pk3` from it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::state::AppState;

/// Bundle identifier from `tauri.conf.json`. `app_local_data_dir()` appends it
/// to `%LOCALAPPDATA%`, and the fallback below does the same by hand.
const APP_IDENTIFIER: &str = "org.jknet.launcher";

/// Folder earlier builds used, and the folder the installer puts
/// `JKNet.exe` into. The two collided, which is why the config root moved.
const LEGACY_APP_FOLDER: &str = "JKNet";

/// Everything the launcher owns inside a root. The legacy folder also holds
/// `JKNet.exe`, `uninstall.exe` and `resources\`, which belong to the
/// installer: the migration never touches those.
const OWNED_ENTRIES: [&str; 5] = ["settings.json", "clients", "library", "cache", "logs"];

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

/// Returns `%LOCALAPPDATA%`, or the closest thing the system offers.
///
/// Falls back to the system temp folder when `LOCALAPPDATA` is missing, which
/// happens in stripped-down CI containers but not on a player machine.
fn local_data_base() -> Result<PathBuf> {
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
    Ok(base)
}

/// Returns `%LOCALAPPDATA%\org.jknet.launcher`, the folder that holds
/// `settings.json`.
///
/// This repeats what `app.path().app_local_data_dir()` does. The launcher asks
/// Tauri first and calls this only when the resolver fails, so the two answers
/// cannot drift apart.
pub fn config_root() -> Result<PathBuf> {
    Ok(local_data_base()?.join(APP_IDENTIFIER))
}

/// Returns `%LOCALAPPDATA%\JKNet`, the root earlier builds wrote into.
pub fn legacy_config_root() -> Result<PathBuf> {
    Ok(local_data_base()?.join(LEGACY_APP_FOLDER))
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

/// What one migration run did.
///
/// The migration happens before the log plugin is up, because the plugin logs
/// into the folder the migration fills. The run therefore collects its lines
/// and the caller replays them with [`Migration::report`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Migration {
    /// Entries moved into the new root, by name.
    pub moved: Vec<String>,
    /// Entries left in the old root, each with the reason.
    pub skipped: Vec<String>,
    /// True when the old root held nothing else and was removed.
    pub removed_old_root: bool,
}

impl Migration {
    /// True when the run changed nothing on disk.
    pub fn is_empty(&self) -> bool {
        self.moved.is_empty() && self.skipped.is_empty() && !self.removed_old_root
    }

    /// Writes the collected lines to the log, once there is one.
    pub fn report(&self, old_root: &Path, new_root: &Path) {
        if self.is_empty() {
            return;
        }
        for name in &self.moved {
            log::info!(
                "migrated {name} from {} to {}",
                old_root.display(),
                new_root.display()
            );
        }
        for reason in &self.skipped {
            log::warn!("left in {}: {reason}", old_root.display());
        }
        if self.removed_old_root {
            log::info!("removed the empty {}", old_root.display());
        }
    }
}

/// Moves the launcher's own files out of an older `%LOCALAPPDATA%\JKNet`.
///
/// Runs at most once in practice: the first success puts `settings.json` in the
/// new root, and the presence of that file stops every later run. The migration
/// also stops when the old root does not exist, when it is the new root, or
/// when it holds none of the five entries the launcher owns.
///
/// Every step is best effort. A failed entry stays where it is and lands in
/// `skipped`, because nothing here may keep the launcher from starting.
pub fn migrate_legacy_root(old_root: &Path, new_root: &Path) -> Migration {
    let mut report = Migration::default();

    if old_root == new_root || !old_root.is_dir() {
        return report;
    }
    if new_root.join("settings.json").exists() {
        return report;
    }
    if !OWNED_ENTRIES.iter().any(|name| old_root.join(name).exists()) {
        return report;
    }
    if let Err(e) = fs::create_dir_all(new_root) {
        report
            .skipped
            .push(format!("cannot create {}: {e}", new_root.display()));
        return report;
    }

    for name in OWNED_ENTRIES {
        let from = old_root.join(name);
        if !from.exists() {
            continue;
        }
        let to = new_root.join(name);
        if to.exists() {
            report
                .skipped
                .push(format!("{name}: the new root already has it"));
            continue;
        }
        match move_entry(&from, &to) {
            Ok(()) => report.moved.push(name.to_string()),
            Err(e) => report.skipped.push(format!("{name}: {e}")),
        }
    }

    if is_empty_dir(old_root) && fs::remove_dir(old_root).is_ok() {
        report.removed_old_root = true;
    }

    report
}

/// Moves one file or folder.
///
/// `rename` covers the usual case. It fails when the two roots sit on different
/// volumes, and then a copy followed by a delete does the same job.
fn move_entry(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            if from.is_dir() {
                copy_dir(from, to)?;
                fs::remove_dir_all(from)
            } else if from.is_file() {
                fs::copy(from, to)?;
                fs::remove_file(from)
            } else {
                Err(rename_error)
            }
        }
    }
}

/// Copies a folder with everything under it.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// True when the folder exists and holds nothing.
fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

/// The two roots as strings, for the Settings screen.
///
/// The frontend needs the resolved paths for two things: printing them and
/// handing the data root to the opener plugin. Both want text, so the command
/// converts once here instead of in every caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPathsView {
    /// `%LOCALAPPDATA%\org.jknet.launcher`: the folder with `settings.json`.
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

    use tempfile::TempDir;

    /// Builds `old\` and `new\` inside one temp folder, so a rename between
    /// them stays on a single volume.
    fn two_roots() -> (TempDir, PathBuf, PathBuf) {
        let temp = TempDir::new().expect("temp dir");
        let old_root = temp.path().join("old");
        let new_root = temp.path().join("new");
        fs::create_dir_all(&old_root).expect("old root");
        (temp, old_root, new_root)
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, text).expect("write");
    }

    #[test]
    fn layout_hangs_off_the_root() {
        let paths = DataPaths::new(PathBuf::from("C:\\JKNet"));
        assert!(paths.clients.ends_with("clients"));
        assert!(paths.logs.ends_with("logs"));
        assert_eq!(paths.client_dir("everyday"), paths.clients.join("everyday"));
    }

    #[test]
    fn a_relative_override_is_ignored() {
        let config = Path::new("C:\\Users\\player\\AppData\\Local\\org.jknet.launcher");
        assert_eq!(data_root(config, Some("  ")), config);
        assert_eq!(data_root(config, Some("data")), config);
        assert_eq!(data_root(config, None), config);
    }

    #[cfg(windows)]
    #[test]
    fn an_absolute_override_wins() {
        let config = Path::new("C:\\Users\\player\\AppData\\Local\\org.jknet.launcher");
        assert_eq!(
            data_root(config, Some("D:\\Games\\JKNet")),
            PathBuf::from("D:\\Games\\JKNet")
        );
    }

    #[test]
    fn the_two_roots_are_named_after_the_bundle() {
        let config = config_root().expect("config root");
        let legacy = legacy_config_root().expect("legacy root");
        assert!(config.ends_with(APP_IDENTIFIER));
        assert!(legacy.ends_with(LEGACY_APP_FOLDER));
        assert_ne!(config, legacy);
        assert_eq!(config.parent(), legacy.parent());
    }

    #[test]
    fn migration_moves_the_five_entries_and_nothing_else() {
        let (_temp, old_root, new_root) = two_roots();
        write(&old_root.join("settings.json"), "{}");
        write(&old_root.join("clients").join("everyday").join("client.json"), "{}");
        write(&old_root.join("library").join("skin.pk3"), "pk3");
        write(&old_root.join("cache").join("servers.json"), "[]");
        write(&old_root.join("logs").join("jknet.log"), "line");
        write(&old_root.join("JKNet.exe"), "MZ");
        write(&old_root.join("resources").join("trusted_servers.json"), "[]");

        let report = migrate_legacy_root(&old_root, &new_root);

        assert_eq!(report.moved, OWNED_ENTRIES);
        assert!(report.skipped.is_empty());
        assert!(!report.removed_old_root);

        assert!(new_root.join("settings.json").is_file());
        assert!(new_root
            .join("clients")
            .join("everyday")
            .join("client.json")
            .is_file());
        assert!(new_root.join("library").join("skin.pk3").is_file());
        assert!(new_root.join("cache").join("servers.json").is_file());
        assert!(new_root.join("logs").join("jknet.log").is_file());

        assert!(old_root.join("JKNet.exe").is_file());
        assert!(old_root
            .join("resources")
            .join("trusted_servers.json")
            .is_file());
        assert!(!old_root.join("clients").exists());
        assert!(!old_root.join("settings.json").exists());
    }

    #[test]
    fn migration_removes_an_old_root_that_holds_nothing_else() {
        let (_temp, old_root, new_root) = two_roots();
        write(&old_root.join("settings.json"), "{}");
        write(&old_root.join("logs").join("jknet.log"), "line");

        let report = migrate_legacy_root(&old_root, &new_root);

        assert_eq!(report.moved, ["settings.json", "logs"]);
        assert!(report.removed_old_root);
        assert!(!old_root.exists());
    }

    #[test]
    fn migration_stops_when_the_new_root_already_has_settings() {
        let (_temp, old_root, new_root) = two_roots();
        write(&old_root.join("settings.json"), "{\"old\":true}");
        write(&new_root.join("settings.json"), "{\"new\":true}");

        let report = migrate_legacy_root(&old_root, &new_root);

        assert!(report.is_empty());
        assert!(old_root.join("settings.json").is_file());
        assert_eq!(
            fs::read_to_string(new_root.join("settings.json")).expect("read"),
            "{\"new\":true}"
        );
    }

    #[test]
    fn migration_keeps_an_entry_the_new_root_already_has() {
        let (_temp, old_root, new_root) = two_roots();
        write(&old_root.join("settings.json"), "{}");
        write(&old_root.join("logs").join("old.log"), "old");
        write(&new_root.join("logs").join("new.log"), "new");

        let report = migrate_legacy_root(&old_root, &new_root);

        assert_eq!(report.moved, ["settings.json"]);
        assert_eq!(report.skipped, ["logs: the new root already has it"]);
        assert!(old_root.join("logs").join("old.log").is_file());
        assert!(new_root.join("logs").join("new.log").is_file());
    }

    #[test]
    fn migration_does_nothing_without_launcher_files() {
        let (_temp, old_root, new_root) = two_roots();
        write(&old_root.join("JKNet.exe"), "MZ");

        assert!(migrate_legacy_root(&old_root, &new_root).is_empty());
        assert!(!new_root.exists());
        assert!(old_root.join("JKNet.exe").is_file());
    }

    #[test]
    fn migration_does_nothing_without_an_old_root() {
        let (_temp, old_root, new_root) = two_roots();
        fs::remove_dir(&old_root).expect("remove old root");

        assert!(migrate_legacy_root(&old_root, &new_root).is_empty());
        assert!(!new_root.exists());
    }

    #[test]
    fn migration_does_nothing_when_both_roots_are_one_folder() {
        let (_temp, old_root, _new_root) = two_roots();
        write(&old_root.join("settings.json"), "{}");

        assert!(migrate_legacy_root(&old_root, &old_root).is_empty());
        assert!(old_root.join("settings.json").is_file());
    }

    #[test]
    fn a_copied_folder_keeps_its_tree() {
        let temp = TempDir::new().expect("temp dir");
        let from = temp.path().join("from");
        let to = temp.path().join("to");
        write(&from.join("a.txt"), "a");
        write(&from.join("deep").join("b.txt"), "b");

        copy_dir(&from, &to).expect("copy");

        assert_eq!(fs::read_to_string(to.join("a.txt")).expect("read"), "a");
        assert_eq!(
            fs::read_to_string(to.join("deep").join("b.txt")).expect("read"),
            "b"
        );
        assert!(from.join("a.txt").is_file());
    }

    #[test]
    fn a_moved_file_leaves_nothing_behind() {
        let temp = TempDir::new().expect("temp dir");
        let from = temp.path().join("from.txt");
        let to = temp.path().join("to.txt");
        write(&from, "text");

        move_entry(&from, &to).expect("move");

        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&to).expect("read"), "text");
    }
}
