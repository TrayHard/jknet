//! The category tree that ships inside the launcher.
//!
//! Walking the tree of one game costs about ten requests to jkhub.org, and
//! the first open of the tab used to pay all of them before a single card
//! appeared. The tree changes a few times a year, so a copy of it is bundled
//! with the build: the tab renders from that copy immediately and the real
//! walk happens behind the answer (see [`super::source::decide`]).
//!
//! The files live at `src-tauri/resources/jkhub/categories-<game>.json` and are
//! registered in `bundle.resources` of `tauri.conf.json`. They are regenerated
//! before a release by `scripts/refresh-jkhub-categories.ps1`, which runs the
//! ignored test at the bottom of this file.
//!
//! A snapshot is never authoritative: it is dated, its file counts are as old
//! as the crawl that made it, and a missing or damaged file is a miss rather
//! than a failure — the launcher then walks the tree before answering, the way
//! it did before this file existed.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::game::Game;

use super::types::JkhubCategory;

/// Folder of the snapshots inside the bundle, as `tauri.conf.json` lists it.
pub const RESOURCE_DIR: &str = "resources/jkhub";

/// The same folder inside the repository.
///
/// Read only by a development build, and only when the folder next to the
/// binary is missing a file: `tauri_build` copies `bundle.resources` when the
/// build script runs, and a snapshot added afterwards is not a reason for
/// cargo to run it again. `build.rs` now makes it one; this is the second half
/// of the same fix, for a target folder that went stale before it did.
pub const MANIFEST_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/jkhub");

/// One game's tree, as the site had it on the day of the crawl.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// The game the tree was walked for. Written so a file opened by hand
    /// names itself, and checked on read so a mixed-up pair of files is a miss
    /// rather than the wrong tree.
    pub game: Game,
    /// RFC 3339 moment the crawl ran.
    pub generated_at: String,
    /// Depth first, exactly what `jkhub_categories` answers with.
    pub categories: Vec<JkhubCategory>,
}

/// Name of the snapshot of one game. The same name the disk cache uses, which
/// is deliberate: the two hold the same document.
pub fn file_name(game: Game) -> String {
    format!("categories-{}.json", game.id())
}

/// Reads a snapshot out of a text, saying why it is unusable.
pub fn parse(text: &str, game: Game) -> Result<Snapshot> {
    let snapshot: Snapshot = serde_json::from_str(text)
        .map_err(|e| AppError::json("cannot parse a JKHub category snapshot", e))?;
    if snapshot.game != game {
        return Err(AppError::InvalidInput(format!(
            "the JKHub snapshot of {} holds the tree of {}",
            game.id(),
            snapshot.game.id()
        )));
    }
    if snapshot.categories.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "the JKHub snapshot of {} holds no categories",
            game.id()
        )));
    }
    Ok(snapshot)
}

/// Reads the bundled snapshot of one game, or answers `None`.
///
/// Every failure is a miss: a build without the resource, a file the installer
/// dropped, a document written by an older version of these types. The tab
/// must open in all of them, and the walk behind it fixes the tree anyway.
pub fn read(dir: &Path, game: Game) -> Option<Snapshot> {
    let file = dir.join(file_name(game));
    let text = std::fs::read_to_string(&file).ok()?;
    match parse(&text, game) {
        Ok(snapshot) => Some(snapshot),
        Err(e) => {
            log::warn!("jkhub: ignoring {}, {e}", file.display());
            None
        }
    }
}

/// Every snapshot file a build is expected to carry: a category tree and a
/// catalogue index per game.
pub fn expected_files() -> Vec<String> {
    let mut names = Vec::with_capacity(Game::ALL.len() * 2);
    for game in Game::ALL {
        names.push(file_name(game));
        names.push(super::index::file_name(game));
    }
    names
}

/// The expected files this folder does not hold, in the order above.
pub fn missing_in(dir: &Path) -> Vec<String> {
    expected_files()
        .into_iter()
        .filter(|name| !dir.join(name).is_file())
        .collect()
}

/// Which of the two folders serves the snapshots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Next to the binary, where the installer and `tauri_build` put it.
    Resource,
    /// Inside the repository, for a development build whose target folder went
    /// stale.
    Manifest,
}

/// Picks the folder to read snapshots from.
///
/// Pure, because the three ways this goes are the part worth a test and none
/// of them needs an app handle:
///
/// | Folder next to the binary | Repository folder | Build | Answer |
/// | --- | --- | --- | --- |
/// | complete | either | either | next to the binary |
/// | incomplete | complete | debug | the repository |
/// | incomplete | incomplete | debug | next to the binary |
/// | incomplete | either | release | next to the binary |
///
/// The release build never reaches for the repository: the folder is not on
/// the player's disk, and a launcher that silently read one would hide exactly
/// the packaging mistake this check exists to report.
pub fn choose(resource_complete: bool, manifest_complete: bool, debug: bool) -> Origin {
    if resource_complete {
        return Origin::Resource;
    }
    if debug && manifest_complete {
        return Origin::Manifest;
    }
    Origin::Resource
}

/// Resolved once per run, so the line that says which folder served the
/// snapshots is printed once rather than on every keystroke of the search.
static FOLDER: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Where the bundled snapshots live in this installation.
///
/// A resolver that finds nothing is logged and answers `None`: the reader then
/// behaves as it did before the snapshots existed.
pub fn bundled_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    FOLDER.get_or_init(|| locate(app)).clone()
}

/// The resolution behind [`bundled_dir`], run once.
fn locate(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let resolved = match app
        .path()
        .resolve(RESOURCE_DIR, tauri::path::BaseDirectory::Resource)
    {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("jkhub: no bundled snapshots, {e}");
            return None;
        }
    };

    let missing = missing_in(&resolved);
    let repository = PathBuf::from(MANIFEST_DIR);
    let origin = choose(
        missing.is_empty(),
        missing_in(&repository).is_empty(),
        cfg!(debug_assertions),
    );
    match origin {
        Origin::Resource => {
            if missing.is_empty() {
                log::info!("jkhub: snapshots served from {}", resolved.display());
            } else {
                log::warn!(
                    "jkhub: {} is missing {}. The tab falls back to crawling jkhub.org for what \
                     the missing file would have held.",
                    resolved.display(),
                    missing.join(", ")
                );
            }
            Some(resolved)
        }
        Origin::Manifest => {
            log::warn!(
                "jkhub: {} is missing {}, so this development build serves the snapshots from {} \
                 instead. A release copies them next to the binary.",
                resolved.display(),
                missing.join(", "),
                repository.display()
            );
            Some(repository)
        }
    }
}

/// Says in the log which folder serves the snapshots, and names whatever is
/// missing from it.
///
/// Called at startup so a build that shipped without a snapshot says so once,
/// in the first lines of the log, rather than being noticed as a crawl the day
/// a player opens the tab.
pub fn check(app: &tauri::AppHandle) {
    let Some(dir) = bundled_dir(app) else {
        log::warn!(
            "jkhub: this build carries no snapshots, so the tab crawls jkhub.org before it can \
             search"
        );
        return;
    };
    let missing = missing_in(&dir);
    if missing.is_empty() {
        return;
    }
    log::warn!(
        "jkhub: the snapshot folder {} is missing {}",
        dir.display(),
        missing.join(", ")
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jkhub::types::JkhubGame;

    fn tree() -> Vec<JkhubCategory> {
        vec![JkhubCategory {
            id: 41,
            slug: "jedi-academy".into(),
            name: "Jedi Academy".into(),
            parent_id: None,
            game: JkhubGame::Ja,
            file_count: Some(3299),
            has_files: false,
            url: "https://jkhub.org/files/category/41-jedi-academy/".into(),
            section: None,
            site_id: None,
        }]
    }

    fn snapshot(game: Game) -> Snapshot {
        Snapshot {
            game,
            generated_at: "2026-09-10T00:00:00Z".into(),
            categories: tree(),
        }
    }

    #[test]
    fn a_snapshot_survives_a_write_and_a_read() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let written = snapshot(Game::JediAcademy);
        std::fs::write(
            dir.path().join(file_name(Game::JediAcademy)),
            serde_json::to_string_pretty(&written).expect("it serializes"),
        )
        .expect("it writes");

        let back = read(dir.path(), Game::JediAcademy).expect("it is there");
        assert_eq!(back, written);
        assert!(
            read(dir.path(), Game::JediOutcast).is_none(),
            "the other game has no file here"
        );
    }

    #[test]
    fn the_file_name_carries_the_game() {
        assert_eq!(file_name(Game::JediAcademy), "categories-ja.json");
        assert_eq!(file_name(Game::JediOutcast), "categories-jo.json");
    }

    #[test]
    fn a_snapshot_of_the_wrong_game_or_shape_is_refused() {
        let text = serde_json::to_string(&snapshot(Game::JediOutcast)).expect("it serializes");
        let error = parse(&text, Game::JediAcademy).expect_err("the games disagree");
        assert!(error.to_string().contains("holds the tree of"), "{error}");

        let empty = serde_json::to_string(&Snapshot {
            game: Game::JediAcademy,
            generated_at: "2026-09-10T00:00:00Z".into(),
            categories: Vec::new(),
        })
        .expect("it serializes");
        let error = parse(&empty, Game::JediAcademy).expect_err("an empty tree is no tree");
        assert!(error.to_string().contains("no categories"), "{error}");

        assert!(parse("{", Game::JediAcademy).is_err());
    }

    #[test]
    fn a_damaged_file_is_a_miss_rather_than_a_failure() {
        let dir = tempfile::tempdir().expect("a temp dir");
        std::fs::write(dir.path().join(file_name(Game::JediAcademy)), "not json")
            .expect("it writes");
        assert!(read(dir.path(), Game::JediAcademy).is_none());
    }

    /// The bundled files themselves, as the build will ship them.
    #[test]
    fn the_bundled_snapshots_parse_and_name_their_own_game() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(RESOURCE_DIR);
        for game in Game::ALL {
            let snapshot = read(&dir, game)
                .unwrap_or_else(|| panic!("{} ships a snapshot", file_name(game)));
            assert_eq!(snapshot.game, game);
            assert!(!snapshot.generated_at.is_empty());
            // --- slice: jkhub catalog ---
            // The tree is pruned to the eight sections, so a count of nodes
            // says only how many subcategories Maps had that day. What has to
            // hold is that every section of this game is in the file: one
            // missing is a shelf the tab cannot show at all.
            for section in &crate::jkhub::sections::SECTIONS {
                let Some(id) = section.id(game) else { continue };
                assert!(
                    snapshot.categories.iter().any(|entry| entry.id == id),
                    "{}: the {} section is not in the tree",
                    file_name(game),
                    section.key
                );
            }
            assert!(
                snapshot.categories.iter().any(|entry| entry.has_files),
                "{}: the tab needs a category to land on",
                file_name(game)
            );
            assert!(
                snapshot
                    .categories
                    .iter()
                    .all(|entry| entry.game.matches(game)),
                "{}: a shelf of the other game leaked in",
                file_name(game)
            );
        }
    }

    /// The four files a build is expected to carry, in the folder the build
    /// script copies from.
    ///
    /// This is the regression the whole fix answers: the launcher shipped an
    /// index nobody could read, because the folder it was copied into never
    /// got the file. The copy is `build.rs`'s job; making sure the source
    /// holds all four is this test's.
    #[test]
    fn the_repository_folder_holds_every_snapshot_and_all_of_them_parse() {
        let dir = PathBuf::from(MANIFEST_DIR);
        assert!(
            missing_in(&dir).is_empty(),
            "{} is missing {:?}",
            dir.display(),
            missing_in(&dir)
        );
        assert_eq!(expected_files().len(), 4, "two files per game");

        for game in Game::ALL {
            assert!(
                read(&dir, game).is_some(),
                "{} does not parse",
                file_name(game)
            );
            let index = crate::jkhub::index::read_from(&dir, game)
                .unwrap_or_else(|| panic!("{} does not parse", crate::jkhub::index::file_name(game)));
            assert_eq!(index.game, game);
        }
    }

    /// The fallback that keeps a development build off jkhub.org.
    #[test]
    fn a_development_build_falls_back_to_the_repository_folder() {
        // The shipped case: what sits next to the binary is complete.
        assert_eq!(choose(true, true, true), Origin::Resource);
        assert_eq!(choose(true, false, true), Origin::Resource);
        assert_eq!(choose(true, false, false), Origin::Resource);

        // The reported case: a target folder that tauri-build never refreshed.
        assert_eq!(choose(false, true, true), Origin::Manifest);

        // A release never reads the repository, and neither does a debug build
        // whose repository folder is missing the same file.
        assert_eq!(choose(false, true, false), Origin::Resource);
        assert_eq!(choose(false, false, true), Origin::Resource);
    }

    /// A folder short of one file is a folder the resolver has to name.
    #[test]
    fn a_missing_snapshot_is_named_rather_than_counted() {
        let dir = tempfile::tempdir().expect("a temp dir");
        assert_eq!(missing_in(dir.path()).len(), 4);

        std::fs::write(dir.path().join(file_name(Game::JediAcademy)), "{}").expect("it writes");
        let missing = missing_in(dir.path());
        assert_eq!(missing.len(), 3);
        assert!(
            !missing.contains(&file_name(Game::JediAcademy)),
            "{missing:?}"
        );
        assert!(
            missing.contains(&crate::jkhub::index::file_name(Game::JediAcademy)),
            "the index of the same game is a separate file: {missing:?}"
        );
    }

    /// A snapshot the installer leaves behind is a file nobody reads.
    #[test]
    fn the_bundle_carries_the_snapshot_folder() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tauri.conf.json"
        ))
        .expect("tauri.conf.json is readable");
        let config: serde_json::Value =
            serde_json::from_str(&text).expect("tauri.conf.json is valid JSON");
        let resources = config["bundle"]["resources"]
            .as_array()
            .expect("bundle.resources is a list");
        assert!(
            resources
                .iter()
                .filter_map(|entry| entry.as_str())
                .any(|entry| entry.trim_end_matches('/') == RESOURCE_DIR),
            "bundle.resources must list {RESOURCE_DIR}, or the snapshots never \
             leave this repository: {resources:?}"
        );
    }

    /// Rewrites `resources/jkhub/categories-*.json` from the live site.
    ///
    /// Ignored by default: a test suite must not walk another project's site.
    /// Run it before a release with `scripts/refresh-jkhub-categories.ps1`, or
    /// by hand with
    /// `cargo test -- --ignored --nocapture jkhub::snapshot::tests::live_rebuild`.
    ///
    /// The walk costs about twenty paced requests per game and uses the same
    /// code path the launcher uses, so what ships is what the reader would
    /// have produced anyway.
    #[test]
    #[ignore = "talks to jkhub.org"]
    fn live_rebuild_the_bundled_snapshots() {
        use crate::jkhub::client::JkhubClient;
        use crate::jkhub::source;
        use crate::timestamp;

        let client = JkhubClient::new().expect("a client");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime");
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(RESOURCE_DIR);
        std::fs::create_dir_all(&dir).expect("the folder exists");

        for game in Game::ALL {
            let categories = runtime
                .block_on(source::crawl_tree(&client, game))
                .unwrap_or_else(|e| panic!("the {} tree walks: {e}", game.id()));
            let snapshot = Snapshot {
                game,
                generated_at: timestamp::now_rfc3339(),
                categories,
            };
            let file = dir.join(file_name(game));
            let text = serde_json::to_string_pretty(&snapshot).expect("it serializes");
            std::fs::write(&file, format!("{text}\n")).expect("it writes");
            println!(
                "live: {} holds {} categories, {} bytes",
                file.display(),
                snapshot.categories.len(),
                text.len() + 1
            );
        }
    }
}
