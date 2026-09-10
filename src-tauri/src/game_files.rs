//! Finding the player's copy of Jedi Academy and of Jedi Outcast.
//!
//! JKNet needs one folder per game: the `GameData` directory that holds the
//! `base\assets*.pk3` archives of that game. It reads those files and never
//! writes into the game folder, so Steam, GOG and a disc install are equally
//! good.
//!
//! Detection is a search over candidates, not a guess: every candidate is
//! reported with its game, its source and the state of the asset files, and the
//! user confirms one of them. Which archives a game needs, which folder names
//! identify it and which patch levels it has come from
//! [`crate::game::GameSpec`]; nothing about either game is written down here.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::game::{Game, GameSpec};
use crate::state::AppState;

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
    // --- slice: game core ---
    /// False for an archive a patch adds. Its absence costs the copy a version,
    /// not its validity.
    pub required: bool,
}

/// A folder that may be the `GameData` of one game.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameFilesCandidate {
    // --- slice: game core ---
    /// The game this folder was checked against. The same folder is never a
    /// candidate for both: the two games ship different archives.
    pub game: Game,
    pub path: String,
    pub source: GameFilesSource,
    pub assets: Vec<AssetFile>,
    /// True when every required archive is in place.
    pub valid: bool,
    // --- slice: game core ---
    /// Patch level read off the archives: `1.04` for Jedi Outcast, `None` for
    /// Jedi Academy, whose two builds carry the same four files.
    pub version: Option<String>,
    /// One sentence about a copy that works but is not what the player wants —
    /// a Jedi Outcast install without the 1.04 patch. `None` when there is
    /// nothing to say.
    pub warning: Option<String>,
}

/// What [`detect_game_files`] answers with: the candidates of both games.
///
/// A struct and not a flat list, because the interface shows one row per game
/// and an empty list for one of them is a state it has to render.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGameFiles {
    pub ja: Vec<GameFilesCandidate>,
    pub jo: Vec<GameFilesCandidate>,
}

impl DetectedGameFiles {
    fn slot(&mut self, game: Game) -> &mut Vec<GameFilesCandidate> {
        match game {
            Game::JediAcademy => &mut self.ja,
            Game::JediOutcast => &mut self.jo,
        }
    }
}

/// Lists every `GameData` folder JKNet can find, per game, best first.
///
/// The saved folder comes first, then Steam, then GOG. Duplicates are removed
/// by path within one game, so a folder found twice keeps the source listed
/// first.
#[tauri::command]
pub fn detect_game_files(state: tauri::State<'_, AppState>) -> Result<DetectedGameFiles> {
    let settings = state.settings()?;
    let mut found = DetectedGameFiles::default();

    for game in Game::ALL {
        let list = found.slot(game);

        if let Some(configured) = settings.game_data_path(game) {
            push_candidate(
                list,
                game,
                Path::new(configured),
                GameFilesSource::Configured,
            );
        }
        for path in steam_candidates(game.spec()) {
            push_candidate(list, game, &path, GameFilesSource::Steam);
        }
        for path in gog_candidates(game.spec()) {
            push_candidate(list, game, &path, GameFilesSource::Gog);
        }
    }

    log::info!(
        "detected game files: {} for Jedi Academy, {} for Jedi Outcast",
        found.ja.len(),
        found.jo.len()
    );
    Ok(found)
}

/// Inspects one folder the user picked in the dialog, against one game.
///
/// Accepts either the `GameData` folder or the install root that contains it.
/// The game is an argument rather than something to guess: a Jedi Outcast
/// folder and a Jedi Academy folder look alike from the outside, and telling
/// the player their Jedi Academy copy is broken because they pointed the Jedi
/// Outcast row at it would be the wrong answer twice over.
#[tauri::command]
pub fn validate_game_data(game: Game, path: String) -> Result<GameFilesCandidate> {
    let dir = normalize_game_data_dir(Path::new(&path));
    Ok(inspect(game, &dir, GameFilesSource::Manual))
}

/// Refuses a folder that is not a usable `GameData` of this game, naming what
/// is missing.
///
/// The launch path calls this before it starts an engine: a game that opens and
/// then dies on a missing archive is a worse answer than a sentence.
pub(crate) fn validate(game: Game, dir: &Path) -> Result<()> {
    let candidate = inspect(game, dir, GameFilesSource::Configured);
    if candidate.valid {
        return Ok(());
    }
    let missing: Vec<&str> = candidate
        .assets
        .iter()
        .filter(|asset| asset.required && !asset.present)
        .map(|asset| asset.name.as_str())
        .collect();
    Err(AppError::GameDataMissing {
        game: game.display_name(),
        reason: format!(
            "{} is missing from base in {}",
            missing.join(", "),
            candidate.path
        ),
    })
}

/// Adds a candidate unless the same path is already in the list.
fn push_candidate(
    list: &mut Vec<GameFilesCandidate>,
    game: Game,
    path: &Path,
    source: GameFilesSource,
) {
    let dir = normalize_game_data_dir(path);
    let key = dir.to_string_lossy().to_lowercase();
    if list.iter().any(|c| c.path.to_lowercase() == key) {
        return;
    }
    let candidate = inspect(game, &dir, source);
    // A folder found by scanning is only worth reporting when it holds the
    // assets; a folder the user chose is reported either way.
    if candidate.valid || source == GameFilesSource::Configured {
        list.push(candidate);
    }
}

/// Reads the state of one game's asset archives inside `dir\base`.
fn inspect(game: Game, dir: &Path, source: GameFilesSource) -> GameFilesCandidate {
    let spec = game.spec();
    let base = dir.join("base");
    let assets: Vec<AssetFile> = spec
        .assets
        .iter()
        .map(|asset| {
            let metadata = fs::metadata(base.join(asset.name)).ok();
            AssetFile {
                name: asset.name.to_string(),
                present: metadata.is_some(),
                size: metadata.map(|m| m.len()),
                required: asset.required,
            }
        })
        .collect();

    let valid = assets.iter().all(|a| !a.required || a.present);
    let present: Vec<&str> = assets
        .iter()
        .filter(|a| a.present)
        .map(|a| a.name.as_str())
        .collect();
    let version = valid.then(|| spec.detect_version(&present)).flatten();

    GameFilesCandidate {
        game,
        path: dir.to_string_lossy().to_string(),
        source,
        warning: version.and_then(|found| patch_warning(spec, found)),
        version: version.map(str::to_string),
        valid,
        assets,
    }
}

/// Says so when a copy works but is not the build the servers run.
///
/// Jedi Outcast is the case this exists for: JK2MV runs 1.02, 1.03 and 1.04
/// out of one executable, so an unpatched copy is playable — and then finds
/// almost nothing on the master list, because the servers are on 1.04.
fn patch_warning(spec: &GameSpec, found: &str) -> Option<String> {
    let wanted = spec.wanted_version?;
    if found == wanted {
        return None;
    }
    let marker = spec
        .versions
        .iter()
        .find(|version| version.label == wanted)
        .map(|version| version.marker)
        .unwrap_or("the patch archive");
    Some(format!(
        "This copy is {found}: base\\{marker} is missing. \
         JK2MV plays it, but almost every server runs {wanted}. \
         Install the {wanted} patch."
    ))
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

/// True when a folder name names this game and not the other one.
fn names_the_game(spec: &GameSpec, name: &str) -> bool {
    let lower = name.to_lowercase();
    spec.install_dir_hints
        .iter()
        .any(|hint| lower.contains(hint))
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

/// Every `GameData` folder of this game reachable through a Steam library.
#[cfg(windows)]
fn steam_candidates(spec: &GameSpec) -> Vec<PathBuf> {
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
        .flat_map(|library| {
            game_dirs_in(spec, &library.join("steamapps").join("common"))
        })
        .collect()
}

#[cfg(not(windows))]
fn steam_candidates(_spec: &GameSpec) -> Vec<PathBuf> {
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

/// Every `GameData` folder of this game reachable through a GOG install.
#[cfg(windows)]
fn gog_candidates(spec: &GameSpec) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = gog_registry_paths(spec)
        .iter()
        .map(|path| path.join("GameData"))
        .collect();
    dirs.extend(game_dirs_in(spec, Path::new(r"C:\GOG Games")));
    dirs
}

#[cfg(not(windows))]
fn gog_candidates(_spec: &GameSpec) -> Vec<PathBuf> {
    Vec::new()
}

/// Reads the install path of this game out of the GOG registry keys.
///
/// Two routes, because GOG writes two records. `GOG.com\Games\<id>` is the one
/// Galaxy keeps and it carries a readable `gameName`; the uninstall key of the
/// offline installer carries only an `InstallLocation`, so it is looked up by
/// the product id from the game table.
#[cfg(windows)]
fn gog_registry_paths(spec: &GameSpec) -> Vec<PathBuf> {
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
            // Either the title names the game, or the key is the product id
            // JKNet has written down for it.
            let by_name = names_the_game(spec, &name);
            let by_id = spec.gog_product_id == Some(id.trim());
            if !by_name && !by_id {
                continue;
            }
            if let Ok(path) = game.get_value::<String, _>("path") {
                if !path.is_empty() {
                    found.push(PathBuf::from(path));
                }
            }
        }
    }

    // The offline installer's own uninstall entry, for a copy Galaxy never saw.
    if let Some(key) = spec.gog_uninstall_key {
        for root in [key.to_string(), key.replace(r"SOFTWARE\", r"SOFTWARE\WOW6432Node\")] {
            let Ok(entry) = hklm.open_subkey_with_flags(&root, KEY_READ) else {
                continue;
            };
            if let Ok(path) = entry.get_value::<String, _>("InstallLocation") {
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

/// Looks for installs of one game inside a folder of games and returns their
/// `GameData` subfolders.
///
/// Matching by name rather than by a fixed string, because Steam, GOG and the
/// disc release all spell the title differently. The hints of the two games
/// never overlap, which is what keeps a Jedi Outcast folder out of the Jedi
/// Academy list — see the test in [`crate::game`].
fn game_dirs_in(spec: &GameSpec, parent: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| names_the_game(spec, &entry.file_name().to_string_lossy()))
        .map(|entry| entry.path().join("GameData"))
        .collect()
}

/// The `GameData` folders the settings hold, for the modules that scan them.
///
/// Skips a game with no folder rather than reporting an empty path: a caller
/// that indexed `""` would read the working directory.
pub(crate) fn configured_dirs(settings: &crate::settings::Settings) -> BTreeMap<Game, PathBuf> {
    Game::ALL
        .into_iter()
        .filter_map(|game| {
            settings
                .game_data_path(game)
                .map(|path| (game, PathBuf::from(path)))
        })
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
        let candidate = inspect(Game::JediAcademy, Path::new("Z:\\nowhere"), GameFilesSource::Manual);
        assert!(!candidate.valid);
        assert_eq!(candidate.assets.len(), 4);
        assert!(candidate.assets.iter().all(|a| !a.present));
        // Nothing is claimed about the version of a folder that holds nothing.
        assert_eq!(candidate.version, None);
        assert_eq!(candidate.warning, None);
    }

    // --- slice: game core ---

    /// Builds a `GameData` folder with the named archives inside `base`.
    fn game_data(dir: &Path, archives: &[&str]) -> PathBuf {
        let base = dir.join("base");
        fs::create_dir_all(&base).expect("the base folder is created");
        for name in archives {
            fs::write(base.join(name), b"pk3").expect("an archive is written");
        }
        dir.to_path_buf()
    }

    #[test]
    fn a_jedi_outcast_folder_needs_two_archives_and_reports_its_patch() {
        let temp = tempfile::tempdir().expect("temp dir");

        // Retail 1.02: playable, and worth a warning.
        let retail = game_data(&temp.path().join("retail"), &["assets0.pk3", "assets1.pk3"]);
        let candidate = inspect(Game::JediOutcast, &retail, GameFilesSource::Manual);
        assert!(candidate.valid, "1.02 is a working copy");
        assert_eq!(candidate.version.as_deref(), Some("1.02"));
        let warning = candidate.warning.expect("1.02 is warned about");
        assert!(warning.contains("assets5.pk3"), "{warning}");
        assert!(warning.contains("1.04"), "{warning}");

        // 1.03 is still not what the servers run.
        let patched = game_data(
            &temp.path().join("patched"),
            &["assets0.pk3", "assets1.pk3", "assets2.pk3"],
        );
        let candidate = inspect(Game::JediOutcast, &patched, GameFilesSource::Manual);
        assert_eq!(candidate.version.as_deref(), Some("1.03"));
        assert!(candidate.warning.is_some());

        // 1.04, what Steam and GOG hand out: nothing to say.
        let current = game_data(
            &temp.path().join("current"),
            &["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets5.pk3"],
        );
        let candidate = inspect(Game::JediOutcast, &current, GameFilesSource::Manual);
        assert!(candidate.valid);
        assert_eq!(candidate.version.as_deref(), Some("1.04"));
        assert_eq!(candidate.warning, None);
        // Every archive of the set is reported, patch ones marked optional.
        assert_eq!(candidate.assets.len(), 4);
        assert_eq!(
            candidate
                .assets
                .iter()
                .filter(|asset| asset.required)
                .count(),
            2
        );
    }

    #[test]
    fn a_jedi_outcast_folder_without_assets1_is_broken() {
        let temp = tempfile::tempdir().expect("temp dir");
        let half = game_data(&temp.path().join("half"), &["assets0.pk3", "assets5.pk3"]);
        let candidate = inspect(Game::JediOutcast, &half, GameFilesSource::Manual);
        assert!(!candidate.valid);
        // A version is not guessed for a copy that cannot start.
        assert_eq!(candidate.version, None);

        let refusal = validate(Game::JediOutcast, &half).expect_err("it is refused");
        let text = refusal.to_string();
        assert!(text.contains("Jedi Outcast"), "{text}");
        assert!(text.contains("assets1.pk3"), "{text}");
        // The archive a patch adds is never named as missing.
        assert!(!text.contains("assets2.pk3"), "{text}");
    }

    #[test]
    fn a_jedi_academy_folder_still_needs_all_four() {
        let temp = tempfile::tempdir().expect("temp dir");
        let three = game_data(
            &temp.path().join("three"),
            &["assets0.pk3", "assets1.pk3", "assets2.pk3"],
        );
        assert!(!inspect(Game::JediAcademy, &three, GameFilesSource::Manual).valid);

        let four = game_data(
            &temp.path().join("four"),
            &["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3"],
        );
        let candidate = inspect(Game::JediAcademy, &four, GameFilesSource::Manual);
        assert!(candidate.valid);
        // 1.00 and 1.01 carry the same files, so no version is claimed.
        assert_eq!(candidate.version, None);
        assert_eq!(candidate.warning, None);
        assert!(validate(Game::JediAcademy, &four).is_ok());
    }

    #[test]
    fn the_two_games_do_not_accept_each_other_s_folder() {
        let temp = tempfile::tempdir().expect("temp dir");
        // A Jedi Outcast 1.04 install has no `assets3.pk3`, so it can never
        // pass as Jedi Academy — which is what keeps a folder pointed at the
        // wrong row from launching the wrong game.
        let jo = game_data(
            &temp.path().join("jo"),
            &["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets5.pk3"],
        );
        assert!(inspect(Game::JediOutcast, &jo, GameFilesSource::Manual).valid);
        assert!(!inspect(Game::JediAcademy, &jo, GameFilesSource::Manual).valid);
    }

    #[test]
    fn a_folder_name_is_matched_against_one_game_only() {
        assert!(names_the_game(
            Game::JediOutcast.spec(),
            "Star Wars Jedi Knight II - Jedi Outcast"
        ));
        assert!(!names_the_game(
            Game::JediAcademy.spec(),
            "Star Wars Jedi Knight II - Jedi Outcast"
        ));
        assert!(names_the_game(Game::JediAcademy.spec(), "Jedi Academy"));
        assert!(!names_the_game(Game::JediOutcast.spec(), "Jedi Academy"));
        assert!(!names_the_game(Game::JediAcademy.spec(), "Quake III Arena"));
    }

    #[test]
    fn the_install_root_is_accepted_in_place_of_game_data() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("Jedi Outcast");
        game_data(&root.join("GameData"), &["assets0.pk3", "assets1.pk3"]);

        let candidate =
            validate_game_data(Game::JediOutcast, root.to_string_lossy().to_string())
                .expect("the folder is inspected");
        assert!(candidate.valid);
        assert!(candidate.path.ends_with("GameData"), "{}", candidate.path);
        assert_eq!(candidate.game, Game::JediOutcast);
    }

    #[test]
    fn the_configured_folders_skip_the_game_nobody_set_up() {
        let mut settings = crate::settings::Settings::default();
        assert!(configured_dirs(&settings).is_empty());

        settings
            .game_data_paths
            .insert(Game::JediAcademy, "D:\\GameData".to_string());
        let dirs = configured_dirs(&settings);
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[&Game::JediAcademy], PathBuf::from("D:\\GameData"));
    }
}
