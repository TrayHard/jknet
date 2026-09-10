//! The on-disk cache of the JKHub reader.
//!
//! Layout, under the data root:
//!
//! ```text
//! cache\jkhub\categories-<game>.json      the tree, 7 days
//! cache\jkhub\list-<id>-<sort>-<page>.json one page of a listing, 30 min
//! cache\jkhub\file-<id>.json               one file page, 30 min
//! cache\jkhub\downloads\<fileId>\<name>    the archive, until it is installed
//! ```
//!
//! The tree has a third source below the two of them: a snapshot bundled with
//! the build (`snapshot.rs`). It is read only when the cache holds nothing,
//! and the walk that follows overwrites it here.
//!
//! Two rules decide the design:
//!
//! * the site tells the launcher how long to keep a page. Guest pages come
//!   with `Cache-Control: max-age=900`, and that number wins over the default
//!   below when it is there (report, section 6);
//! * a cached copy past its lifetime is still better than an error. When the
//!   site cannot be reached the reader serves the stale copy and marks the
//!   answer, so the screen can say the list is old instead of showing nothing.
//!
//! Thumbnails are deliberately absent: the webview loads them straight from
//! jkhub.org, which is one copy fewer to keep fresh and one folder fewer to
//! grow without bound.

use std::fs;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths::{self, DataPaths};
use crate::timestamp;

/// How long the category tree is treated as current, in seconds.
///
/// A week. The tree changes a few times a year, and walking it costs about
/// twenty requests — a day was short enough that a player who opens the tab
/// most days paid for a walk most days. The file counts inside the tree age
/// with it and can lag the site by that week; nothing else in it moves.
pub const CATEGORIES_TTL: u64 = 7 * 24 * 60 * 60;

/// How long a listing page or a file page is treated as current, in seconds.
pub const PAGE_TTL: u64 = 30 * 60;

/// Shortest lifetime accepted from the site, so a `max-age=0` on one answer
/// cannot turn the reader into a request per render.
const MIN_TTL: u64 = 60;

/// Longest lifetime accepted from the site.
const MAX_TTL: u64 = 24 * 60 * 60;

/// What every cached document is wrapped in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<T> {
    /// RFC 3339, for the person who opens the file.
    fetched_at: String,
    /// The same moment in Unix seconds, for the freshness check.
    fetched_unix: u64,
    /// Lifetime in seconds, from the site when it said so.
    ttl: u64,
    payload: T,
}

/// A cached document and whether it is still current.
#[derive(Debug, Clone)]
pub struct Cached<T> {
    pub payload: T,
    pub fetched_at: String,
    pub fresh: bool,
}

/// The cache folder of this module, created on demand.
pub fn dir(data: &DataPaths) -> Result<PathBuf> {
    let dir = data.cache.join("jkhub");
    paths::create_dir(&dir)?;
    Ok(dir)
}

/// Folder the archive of one file is downloaded into.
pub fn download_dir(data: &DataPaths, file_id: u32) -> Result<PathBuf> {
    let dir = dir(data)?.join("downloads").join(file_id.to_string());
    paths::create_dir(&dir)?;
    Ok(dir)
}

/// Reads a cached document, whether or not it is still fresh.
///
/// An unreadable or unparsable file is a miss, not a failure: the shape of a
/// cached document changes with the code, and an old one must not stop the
/// launcher from asking the site again.
pub fn read<T: DeserializeOwned>(data: &DataPaths, name: &str) -> Option<Cached<T>> {
    let file = dir(data).ok()?.join(name);
    let text = fs::read_to_string(&file).ok()?;
    let envelope: Envelope<T> = match serde_json::from_str(&text) {
        Ok(envelope) => envelope,
        Err(e) => {
            log::debug!("dropping {}: {e}", file.display());
            return None;
        }
    };
    let age = timestamp::now_unix().saturating_sub(envelope.fetched_unix);
    Some(Cached {
        fresh: age < envelope.ttl,
        fetched_at: envelope.fetched_at,
        payload: envelope.payload,
    })
}

/// Writes a document with the lifetime the site asked for.
///
/// A write failure is logged and swallowed: a full disk must not stop a
/// listing from being shown.
pub fn write<T: Serialize>(data: &DataPaths, name: &str, payload: &T, ttl: u64) -> String {
    let fetched_at = timestamp::now_rfc3339();
    let envelope = Envelope {
        fetched_at: fetched_at.clone(),
        fetched_unix: timestamp::now_unix(),
        ttl,
        payload,
    };
    match dir(data).and_then(|dir| {
        let file = dir.join(name);
        let text = serde_json::to_string(&envelope)
            .map_err(|e| AppError::json("cannot serialize a JKHub cache entry", e))?;
        fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
    }) {
        Ok(()) => {}
        Err(e) => log::warn!("jkhub cache: {e}"),
    }
    fetched_at
}

/// Picks the lifetime for a document: what the site said, or the default.
pub fn ttl_from(max_age: Option<u64>, default: u64) -> u64 {
    max_age
        .map(|seconds| seconds.clamp(MIN_TTL, MAX_TTL))
        .unwrap_or(default)
}

/// Name of the cached category tree of one game.
pub fn categories_name(game: &str) -> String {
    format!("categories-{game}.json")
}

/// Name of one cached page of one listing.
pub fn listing_name(category_id: u32, sort: &str, page: u32) -> String {
    format!("list-{category_id}-{sort}-{page}.json")
}

/// Name of one cached file page.
pub fn file_name(file_id: u32) -> String {
    format!("file-{file_id}.json")
}

/// Deletes everything this module keeps on disk.
///
/// Includes the downloaded archives: they are a cache too, kept only until
/// the file they carry is installed.
pub fn clear(data: &DataPaths) -> Result<()> {
    let dir = data.cache.join("jkhub");
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io_path("cannot clear", &dir, e))?;
    log::info!("cleared {}", dir.display());
    Ok(())
}

/// Deletes the archive of one file once it has been installed.
pub fn forget_download(data: &DataPaths, file_id: u32) {
    let Ok(cache) = dir(data) else { return };
    let dir = cache.join("downloads").join(file_id.to_string());
    if !dir.exists() {
        return;
    }
    if let Err(e) = fs::remove_dir_all(&dir) {
        log::warn!("cannot remove {}: {e}", dir.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, DataPaths) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let paths = DataPaths::new(dir.path().to_path_buf());
        paths.ensure().expect("the layout is created");
        (dir, paths)
    }

    #[test]
    fn a_document_comes_back_fresh_and_then_stale() {
        let (_guard, data) = paths();
        write(&data, "file-1.json", &vec!["a".to_string()], 3600);
        let cached: Cached<Vec<String>> = read(&data, "file-1.json").expect("it is there");
        assert!(cached.fresh);
        assert_eq!(cached.payload, vec!["a".to_string()]);
        assert!(!cached.fetched_at.is_empty());

        // A lifetime of zero seconds is already spent by the time it is read.
        write(&data, "file-2.json", &1_u32, 0);
        let cached: Cached<u32> = read(&data, "file-2.json").expect("it is there");
        assert!(!cached.fresh, "a spent entry is still returned, marked stale");
        assert_eq!(cached.payload, 1);
    }

    #[test]
    fn a_document_of_the_wrong_shape_is_a_miss_rather_than_a_failure() {
        let (_guard, data) = paths();
        write(&data, "file-3.json", &"text".to_string(), 3600);
        let cached: Option<Cached<u32>> = read(&data, "file-3.json");
        assert!(cached.is_none());
        assert!(read::<u32>(&data, "not-written.json").is_none());
    }

    #[test]
    fn the_lifetime_the_site_asks_for_wins_inside_sane_bounds() {
        assert_eq!(ttl_from(Some(900), PAGE_TTL), 900);
        assert_eq!(ttl_from(None, PAGE_TTL), PAGE_TTL);
        assert_eq!(ttl_from(Some(0), PAGE_TTL), MIN_TTL, "no request per render");
        assert_eq!(ttl_from(Some(u64::MAX), PAGE_TTL), MAX_TTL);
    }

    #[test]
    fn clearing_removes_the_folder_and_survives_a_second_call() {
        let (_guard, data) = paths();
        write(&data, "file-4.json", &1_u32, 60);
        let downloads = download_dir(&data, 7).expect("the folder is created");
        assert!(downloads.starts_with(data.cache.join("jkhub")));
        std::fs::write(downloads.join("x.zip"), b"zip").expect("a file lands there");

        clear(&data).expect("it clears");
        assert!(!data.cache.join("jkhub").exists());
        clear(&data).expect("a second call is a no-op");
    }

    #[test]
    fn an_installed_file_loses_its_archive_and_keeps_the_rest() {
        let (_guard, data) = paths();
        let kept = download_dir(&data, 1).expect("folder");
        let gone = download_dir(&data, 2).expect("folder");
        std::fs::write(kept.join("a.zip"), b"a").expect("write");
        std::fs::write(gone.join("b.zip"), b"b").expect("write");

        forget_download(&data, 2);
        assert!(kept.exists());
        assert!(!gone.exists());
        forget_download(&data, 2);
    }

    #[test]
    fn cache_names_carry_everything_that_changes_the_answer() {
        assert_eq!(categories_name("ja"), "categories-ja.json");
        assert_eq!(listing_name(13, "file_updated", 2), "list-13-file_updated-2.json");
        assert_eq!(file_name(1486), "file-1486.json");
    }
}
