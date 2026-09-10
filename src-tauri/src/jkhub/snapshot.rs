//! The category tree that ships inside the launcher.
//!
//! Walking the tree of one game costs about twenty requests to jkhub.org, and
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

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::game::Game;

use super::types::JkhubCategory;

/// Folder of the snapshots inside the bundle, as `tauri.conf.json` lists it.
pub const RESOURCE_DIR: &str = "resources/jkhub";

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

/// Where the bundled snapshots live in this installation.
///
/// A resolver that finds nothing is logged and answers `None`: the reader then
/// behaves as it did before the snapshots existed.
pub fn bundled_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    match app
        .path()
        .resolve(RESOURCE_DIR, tauri::path::BaseDirectory::Resource)
    {
        Ok(dir) => Some(dir),
        Err(e) => {
            log::warn!("jkhub: no bundled category snapshots, {e}");
            None
        }
    }
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
            assert!(
                snapshot.categories.len() >= 15,
                "{}: {} categories",
                file_name(game),
                snapshot.categories.len()
            );
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
