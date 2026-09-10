//! Finding the player's copy of Jedi Academy.
//!
//! JKNet needs one folder: the `GameData` directory that holds
//! `base\assets0.pk3`..`assets3.pk3`. It reads those files and never writes
//! into the game folder, so Steam, GOG and a disc install are equally good.
//!
//! Detection is a search over candidates, not a guess: every candidate is
//! reported with its source and the state of the four asset files, and the
//! user confirms one of them.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::state::AppState;

/// The four asset archives shipped with the retail game.
const ASSET_FILES: [&str; 4] = [
    "assets0.pk3",
    "assets1.pk3",
    "assets2.pk3",
    "assets3.pk3",
];

/// Where a candidate folder came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameFilesSource {
    /// The folder already saved in the settings.
    Configured,
    /// Found through the Steam registry key and `libraryfolders.vdf`.
    Steam,
    /// Found through the GOG registry keys or `C:\GOG Games`.
    Gog,
    /// Picked by the user in the folder dialog.
    Manual,
}

/// One asset archive inside `<GameData>\base`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFile {
    pub name: String,
    pub present: bool,
    /// Size in bytes, `None` when the file is missing or unreadable.
    pub size: Option<u64>,
}

/// A folder that may be the game's `GameData`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameFilesCandidate {
    pub path: String,
    pub source: GameFilesSource,
    pub assets: Vec<AssetFile>,
    /// True when all four asset archives are in place.
    pub valid: bool,
}

/// Lists every `GameData` folder JKNet can find, best candidate first.
///
/// The saved folder comes first, then Steam, then GOG. Duplicates are removed
/// by path, so a folder found twice keeps the source listed first.
#[tauri::command]
pub fn detect_game_files(state: tauri::State<'_, AppState>) -> Result<Vec<GameFilesCandidate>> {
    let mut candidates: Vec<GameFilesCandidate> = Vec::new();

    if let Some(configured) = state.settings()?.game_data_path {
        push_candidate(
            &mut candidates,
            Path::new(&configured),
            GameFilesSource::Configured,
        );
    }

    for path in steam_candidates() {
        push_candidate(&mut candidates, &path, GameFilesSource::Steam);
    }

    for path in gog_candidates() {
        push_candidate(&mut candidates, &path, GameFilesSource::Gog);
    }

    log::info!("detected {} game files candidate(s)", candidates.len());
    Ok(candidates)
}

/// Inspects one folder the user picked in the dialog.
///
/// Accepts either the `GameData` folder or the install root that contains it.
#[tauri::command]
pub fn inspect_game_files(path: String) -> Result<GameFilesCandidate> {
    let dir = normalize_game_data_dir(Path::new(&path));
    Ok(inspect(&dir, GameFilesSource::Manual))
}

/// Refuses a folder that is not a usable `GameData`, naming what is missing.
///
/// The launch path calls this before it starts an engine: a game that opens
/// and then dies on a missing archive is a worse answer than a sentence.
pub(crate) fn validate(dir: &Path) -> Result<()> {
    let candidate = inspect(dir, GameFilesSource::Configured);
    if candidate.valid {
        return Ok(());
    }
    let missing: Vec<&str> = candidate
        .assets
        .iter()
        .filter(|asset| !asset.present)
        .map(|asset| asset.name.as_str())
        .collect();
    Err(AppError::NotFound(format!(
        "game files in {}: {} is missing from base",
        candidate.path,
        missing.join(", ")
    )))
}

/// Adds a candidate unless the same path is already in the list.
fn push_candidate(list: &mut Vec<GameFilesCandidate>, path: &Path, source: GameFilesSource) {
    let dir = normalize_game_data_dir(path);
    let key = dir.to_string_lossy().to_lowercase();
    if list.iter().any(|c| c.path.to_lowercase() == key) {
        return;
    }
    let candidate = inspect(&dir, source);
    // A folder found by scanning is only worth reporting when it holds the
    // assets; a folder the user chose is reported either way.
    if candidate.valid || source == GameFilesSource::Configured {
        list.push(candidate);
    }
}

/// Reads the state of the four asset archives inside `dir\base`.
fn inspect(dir: &Path, source: GameFilesSource) -> GameFilesCandidate {
    let base = dir.join("base");
    let assets: Vec<AssetFile> = ASSET_FILES
        .iter()
        .map(|name| {
            let metadata = fs::metadata(base.join(name)).ok();
            AssetFile {
                name: (*name).to_string(),
                present: metadata.is_some(),
                size: metadata.map(|m| m.len()),
            }
        })
        .collect();

    GameFilesCandidate {
        path: dir.to_string_lossy().to_string(),
        source,
        valid: assets.iter().all(|a| a.present),
        assets,
    }
}

/// Returns the folder that should hold `base\assets0.pk3`.
///
/// Players often pick the install root, so when `<path>\GameData\base` exists
/// and `<path>\base` does not, the subfolder wins.
fn normalize_game_data_dir(path: &Path) -> PathBuf {
    if path.join("base").is_dir() {
        return path.to_path_buf();
    }
    let nested = path.join("GameData");
    if nested.join("base").is_dir() {
        return nested;
    }
    path.to_path_buf()
}

/// Folder names Steam and GOG use for the game inside a library.
const INSTALL_DIR_HINT: &str = "jedi academy";

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

/// Every `GameData` folder reachable through a Steam library.
#[cfg(windows)]
fn steam_candidates() -> Vec<PathBuf> {
    let Some(steam_root) = steam_root() else {
        return Vec::new();
    };

    let mut libraries = vec![steam_root.clone()];
    let vdf = steam_root.join("steamapps").join("libraryfolders.vdf");
    if let Ok(text) = fs::read_to_string(&vdf) {
        libraries.extend(parse_library_paths(&text).into_iter().map(PathBuf::from));
    }

    libraries
        .iter()
        .flat_map(|library| game_dirs_in(&library.join("steamapps").join("common")))
        .collect()
}

#[cfg(not(windows))]
fn steam_candidates() -> Vec<PathBuf> {
    Vec::new()
}

/// Reads `HKCU\Software\Valve\Steam\SteamPath`.
#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Valve\Steam", KEY_READ)
        .ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    if path.is_empty() {
        return None;
    }
    // Steam writes forward slashes into the registry.
    Some(PathBuf::from(path.replace('/', "\\")))
}

/// Extracts library paths from `libraryfolders.vdf`.
///
/// Handles both layouts Steam has used: `"path" "D:\\SteamLibrary"` inside a
/// numbered block, and the older `"1" "D:\\SteamLibrary"` pair.
fn parse_library_paths(vdf: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in vdf.lines() {
        let mut tokens = line.split('"').filter(|part| !part.trim().is_empty());
        let (Some(key), Some(value)) = (tokens.next(), tokens.next()) else {
            continue;
        };
        let is_path_key = key.eq_ignore_ascii_case("path") || key.chars().all(|c| c.is_ascii_digit());
        if is_path_key && value.contains(['\\', '/']) {
            paths.push(value.replace("\\\\", "\\"));
        }
    }
    paths
}

// ---------------------------------------------------------------------------
// GOG
// ---------------------------------------------------------------------------

/// Every `GameData` folder reachable through a GOG install.
#[cfg(windows)]
fn gog_candidates() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = gog_registry_paths()
        .iter()
        .map(|path| path.join("GameData"))
        .collect();
    dirs.extend(game_dirs_in(Path::new(r"C:\GOG Games")));
    dirs
}

#[cfg(not(windows))]
fn gog_candidates() -> Vec<PathBuf> {
    Vec::new()
}

/// Reads the install path of every GOG game whose name mentions Jedi Academy.
#[cfg(windows)]
fn gog_registry_paths() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let roots = [r"SOFTWARE\WOW6432Node\GOG.com\Games", r"SOFTWARE\GOG.com\Games"];
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut found = Vec::new();

    for root in roots {
        let Ok(games) = hklm.open_subkey_with_flags(root, KEY_READ) else {
            continue;
        };
        for id in games.enum_keys().flatten() {
            let Ok(game) = games.open_subkey_with_flags(&id, KEY_READ) else {
                continue;
            };
            let name: String = game.get_value("gameName").unwrap_or_default();
            if !name.to_lowercase().contains(INSTALL_DIR_HINT) {
                continue;
            }
            if let Ok(path) = game.get_value::<String, _>("path") {
                if !path.is_empty() {
                    found.push(PathBuf::from(path));
                }
            }
        }
    }
    found
}

// ---------------------------------------------------------------------------
// Shared scanning
// ---------------------------------------------------------------------------

/// Looks for game installs inside a folder of games and returns their
/// `GameData` subfolders.
///
/// Matching by name rather than by a fixed string, because Steam, GOG and the
/// disc release all spell the title differently.
fn game_dirs_in(parent: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .contains(INSTALL_DIR_HINT)
        })
        .map(|entry| entry.path().join("GameData"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_paths_from_the_current_vdf_layout() {
        let vdf = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"label"		""
	}
}
"#;
        let paths = parse_library_paths(vdf);
        assert_eq!(
            paths,
            vec![
                "C:\\Program Files (x86)\\Steam".to_string(),
                "D:\\SteamLibrary".to_string(),
            ]
        );
    }

    #[test]
    fn reads_paths_from_the_old_vdf_layout() {
        let vdf = "\"LibraryFolders\"\n{\n\t\"1\"\t\t\"D:\\\\SteamLibrary\"\n}\n";
        assert_eq!(parse_library_paths(vdf), vec!["D:\\SteamLibrary".to_string()]);
    }

    #[test]
    fn ignores_labels_and_sizes() {
        let vdf = "\t\"label\"\t\t\"\"\n\t\"totalsize\"\t\t\"0\"\n";
        assert!(parse_library_paths(vdf).is_empty());
    }

    #[test]
    fn a_folder_without_assets_is_not_valid() {
        let candidate = inspect(Path::new("Z:\\nowhere"), GameFilesSource::Manual);
        assert!(!candidate.valid);
        assert_eq!(candidate.assets.len(), 4);
        assert!(candidate.assets.iter().all(|a| !a.present));
    }
}
