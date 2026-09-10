//! Map pictures, the `levelshots/` art the game ships inside its archives.
//!
//! The launcher owns none of these images. Jedi Academy keeps 56 of them in
//! `base\assets0.pk3`, and every custom map carries its own inside its pk3.
//! This module reads the files the player already has, copies the pictures
//! into `cache\levelshots\` and hands the webview a path it may load through
//! Tauri's asset protocol. Nothing is downloaded and nothing is bundled: the
//! art belongs to Raven Software and to the map authors.
//!
//! ```text
//! cache\levelshots\
//!   index.json      what was found and which files it was found in
//!   mp__ffa1.jpg    one picture per map, the key flattened with `__`
//! ```
//!
//! The **key** is the map name the way a server reports it, lowercased:
//! `mp/ffa1`, `mb2_smuggler`. A zip entry `levelshots/MP/FFA1.JPG` and a
//! server answering `mapname\MP/FFA1` therefore meet on the same key, which
//! is the whole point — the Quake 3 file system is case-insensitive and the
//! canonical spelling is lowercase.
//!
//! A rebuild reads the sources in the order the engine would load them, so
//! the picture that wins here is the picture the player sees in game:
//! loose files first, then the pk3 files of the same folder sorted by
//! `paksort`, then the next folder. `FS_AddGameDirectory`
//! (`codemp/qcommon/files.cpp:3078`) pushes the directory onto the search
//! path before its archives, so an archive answers first; the last archive
//! pushed answers before the ones pushed earlier.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};

use image::codecs::jpeg::JpegEncoder;
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use zip::ZipArchive;

use crate::error::{AppError, Result};
use crate::library::pak_order;
use crate::paths::{self, DataPaths};
use crate::settings::Settings;
use crate::state::AppState;
use crate::timestamp;

/// Folder of the extracted pictures inside `cache\`.
const CACHE_DIR: &str = "levelshots";

/// The index document inside that folder.
const INDEX_FILE: &str = "index.json";

/// Folder the game keeps map pictures in, inside an archive and on disk.
const ENTRY_PREFIX: &str = "levelshots/";

/// Extensions the game reads for a levelshot, in the order it tries them.
const IMAGE_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "tga"];

/// Longest side a cached picture may have. The retail levelshots are 512×512;
/// the community HQ packs go to 2048 and would fill the cache folder with
/// megabytes nobody can see in a 320 px panel.
const MAX_SIDE: u32 = 1024;

/// Quality of a re-encoded JPEG. Only pictures above [`MAX_SIDE`] are encoded
/// at all: everything else is copied byte for byte.
const JPEG_QUALITY: u8 = 85;

/// Refuses an archive entry too large to be a picture, before it is read into
/// memory. A 32 MB levelshot does not exist; a crafted pk3 does.
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

/// Longest key the cache accepts, before the extension.
const MAX_KEY_LEN: usize = 120;

/// Told to the window after the index changed.
const EVENT_CHANGED: &str = "levelshots:changed";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// One picture in the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapShot {
    /// File name inside `cache\levelshots\`: the key with `/` written `__`.
    pub file: String,
    /// The pk3 or the loose file this came out of, for the log and the docs.
    pub source: String,
    pub width: u32,
    pub height: u32,
}

/// One file the index was built from, as it looked at the time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStamp {
    pub path: String,
    /// Modification time in Unix seconds, `0` when the system reports none.
    pub mtime: u64,
    pub size: u64,
}

/// `cache\levelshots\index.json`.
///
/// Every field carries `serde(default)`, so an index written by an older build
/// still loads; a broken one is treated as missing and rebuilt.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Index {
    /// When the last full rebuild finished, RFC 3339 in UTC.
    pub built_at: String,
    /// The sources of that rebuild, in the order they were read.
    pub sources: Vec<SourceStamp>,
    /// Key to picture. A `BTreeMap` so the document stays diffable.
    pub maps: BTreeMap<String, MapShot>,
}

/// The answer of [`get_levelshot`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Levelshot {
    /// Absolute path of the cached file. The frontend turns it into a URL with
    /// `convertFileSrc`; the asset protocol scope covers this folder alone.
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// What one rebuild did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildStats {
    /// Pictures in the index afterwards.
    pub maps: usize,
    /// Files that were read.
    pub sources: usize,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// State of the module, managed by Tauri next to `AppState`.
#[derive(Default)]
pub struct LevelshotState {
    /// Held for the length of one lookup, so ten cards mounting at once cause
    /// one rebuild instead of ten. Async, because the work goes through
    /// `spawn_blocking` and the guard has to survive an `await`.
    gate: tokio::sync::Mutex<()>,
    /// Keys a targeted lookup already failed to find. A server list holds
    /// hundreds of maps nobody has installed, and without this every one of
    /// them would reopen the central directory of a 561 MB archive. Cleared
    /// by every rebuild, because a rebuild is what a new pk3 causes.
    misses: Mutex<HashSet<String>>,
}

impl LevelshotState {
    /// True when a targeted lookup for this key already came back empty.
    fn is_known_miss(&self, key: &str) -> bool {
        self.misses
            .lock()
            .map(|misses| misses.contains(key))
            .unwrap_or(false)
    }

    fn remember_miss(&self, key: &str) {
        if let Ok(mut misses) = self.misses.lock() {
            misses.insert(key.to_string());
        }
    }

    fn forget_misses(&self) {
        if let Ok(mut misses) = self.misses.lock() {
            misses.clear();
        }
    }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// Turns a map name as a server reports it into the key of the index.
///
/// Servers answer `mapname` in whatever case the operator typed: `MP/FFA1`,
/// `mp/ffa1`, sometimes with a backslash. The engine does not care and neither
/// does this. A build that answers the whole file name loses the `maps/`
/// folder and the `.bsp` extension as well, so every spelling of one map ends
/// up on one key.
pub fn map_key(name: &str) -> String {
    let lower = name.trim().replace('\\', "/").to_ascii_lowercase();
    let trimmed = lower.trim_matches('/');
    let without_folder = trimmed.strip_prefix("maps/").unwrap_or(trimmed);
    without_folder
        .strip_suffix(".bsp")
        .unwrap_or(without_folder)
        .to_string()
}

/// Turns a path inside `levelshots\` into the key of the index, or `None` when
/// the entry is not a picture the launcher can use.
///
/// Takes the whole entry path, so `levelshots/MP/FFA1.JPG` gives `mp/ffa1`
/// and a folder entry such as `levelshots/mp/` gives nothing.
fn entry_key(entry: &str) -> Option<(String, String)> {
    let lower = entry.replace('\\', "/").to_ascii_lowercase();
    let rest = lower.strip_prefix(ENTRY_PREFIX)?;
    let (stem, extension) = rest.rsplit_once('.')?;
    if !IMAGE_EXTENSIONS.contains(&extension) || stem.is_empty() {
        return None;
    }
    Some((stem.to_string(), extension.to_string()))
}

/// The file name a key gets inside `cache\levelshots\`.
///
/// The key becomes one flat name — `mp/ffa1` is written `mp__ffa1` — so the
/// cache folder never grows a subfolder. `None` rejects a key that could name
/// anything else: entry paths come out of an archive a stranger built, and
/// `..` inside one must not reach a parent folder even by accident.
fn cache_file_name(key: &str, extension: &str) -> Option<String> {
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return None;
    }
    let safe = key.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.' | '+')
            })
    });
    if !safe {
        return None;
    }
    Some(format!("{}.{extension}", key.replace('/', "__")))
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// One file a rebuild reads.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    /// A pk3. Every `levelshots/` entry inside it is indexed.
    Archive(PathBuf),
    /// A picture lying in a `levelshots\` folder, with the key it carries.
    Loose { path: PathBuf, key: String },
}

impl Source {
    fn path(&self) -> &Path {
        match self {
            Source::Archive(path) => path,
            Source::Loose { path, .. } => path,
        }
    }
}

/// Everything a rebuild reads, in the order the engine would load it.
///
/// Later wins. The retail archives come first, then the clients in slug order,
/// so a map a player installed into a client beats the stock picture of the
/// same name — which is what the player sees in game.
fn collect_sources(paths: &DataPaths, settings: &Settings) -> Vec<Source> {
    let mut sources = Vec::new();

    if let Some(game) = settings
        .game_data_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        collect_from_folder(&Path::new(game).join("base"), &mut sources);
    }

    // Every mod folder of every client, not only `base` and the client's own
    // `fs_game`: reading the folders costs one `read_dir` each and spares this
    // module a second copy of the rule that resolves `fs_game`.
    for client in sorted_dir_names(&paths.clients) {
        let home = paths.client_dir(&client).join("home");
        for mod_folder in sorted_dir_names(&home) {
            collect_from_folder(&home.join(mod_folder), &mut sources);
        }
    }

    sources
}

/// Subfolder names of `dir`, sorted, so a rebuild reads the same order twice.
fn sorted_dir_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// Adds the sources of one game folder: its loose pictures, then its archives.
fn collect_from_folder(folder: &Path, out: &mut Vec<Source>) {
    collect_loose(&folder.join(ENTRY_PREFIX.trim_end_matches('/')), "", out);

    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut archives: Vec<((u8, String), PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !name.to_ascii_lowercase().ends_with(".pk3") {
                return None;
            }
            Some((pak_order(&name), entry.path()))
        })
        .collect();
    // The engine sorts the same way and prepends each archive to the search
    // path, so the archive that sorts last is the one that answers.
    archives.sort();
    out.extend(archives.into_iter().map(|(_, path)| Source::Archive(path)));
}

/// Walks a `levelshots\` folder on disk and adds every picture in it.
fn collect_loose(dir: &Path, prefix: &str, out: &mut Vec<Source>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut found: Vec<Source> = Vec::new();
    let mut folders: Vec<(String, PathBuf)> = Vec::new();

    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            folders.push((format!("{prefix}{}/", name.to_ascii_lowercase()), entry.path()));
            continue;
        }
        if let Some((stem, _)) = entry_key(&format!("{ENTRY_PREFIX}{prefix}{name}")) {
            found.push(Source::Loose {
                path: entry.path(),
                key: stem,
            });
        }
    }

    found.sort_by(|a, b| a.path().cmp(b.path()));
    out.extend(found);
    folders.sort();
    for (nested_prefix, path) in folders {
        collect_loose(&path, &nested_prefix, out);
    }
}

/// Size and modification time of every source, which is what a rebuild
/// compares against the index to decide whether it has anything to do.
fn stamps(sources: &[Source]) -> Vec<SourceStamp> {
    sources
        .iter()
        .map(|source| {
            let path = source.path();
            let meta = fs::metadata(path).ok();
            SourceStamp {
                path: path.display().to_string(),
                mtime: meta
                    .as_ref()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|since| since.as_secs())
                    .unwrap_or(0),
                size: meta.map(|meta| meta.len()).unwrap_or(0),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/// Reads a picture, caps it and writes it into the cache folder.
///
/// JPEG and PNG within [`MAX_SIDE`] are copied byte for byte: re-encoding
/// a 512×512 retail levelshot only makes it worse. Anything larger is
/// downscaled, and TGA is always converted because no browser reads it.
fn store_image(
    bytes: &[u8],
    key: &str,
    extension: &str,
    source: &str,
    dir: &Path,
) -> Result<Option<MapShot>> {
    let format = match extension {
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "tga" => ImageFormat::Tga,
        _ => return Ok(None),
    };
    // TGA carries no magic number, so the format comes from the entry name
    // rather than from `with_guessed_format`.
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format).into_dimensions()?;
    if width == 0 || height == 0 {
        return Ok(None);
    }

    let fits = width.max(height) <= MAX_SIDE;
    let target_extension = match format {
        ImageFormat::Jpeg => "jpg",
        // A converted TGA becomes a PNG: it may carry an alpha channel and it
        // is usually flat art, where PNG is both smaller and lossless.
        _ => "png",
    };
    let Some(file_name) = cache_file_name(key, target_extension) else {
        log::warn!("levelshot key {key:?} from {source} is not a usable file name");
        return Ok(None);
    };

    let (encoded, width, height) = if fits && format != ImageFormat::Tga {
        (bytes.to_vec(), width, height)
    } else {
        let decoded = ImageReader::with_format(Cursor::new(bytes), format).decode()?;
        let decoded = if fits {
            decoded
        } else {
            decoded.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle)
        };
        let mut out = Vec::new();
        if format == ImageFormat::Jpeg {
            // The JPEG encoder refuses an alpha channel, and a decoded picture
            // may well have one.
            decoded
                .to_rgb8()
                .write_with_encoder(JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY))?;
        } else {
            decoded.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)?;
        }
        (out, decoded.width(), decoded.height())
    };

    let file = dir.join(&file_name);
    // A picture the webview is showing may be locked on Windows. That costs
    // this one map its update, not the whole rebuild.
    if let Err(e) = fs::write(&file, &encoded) {
        log::warn!("cannot write {}: {e}", file.display());
        return Ok(None);
    }

    Ok(Some(MapShot {
        file: file_name,
        source: source.to_string(),
        width,
        height,
    }))
}

/// Adds every `levelshots/` entry of one archive to `maps`.
fn scan_archive(path: &Path, dir: &Path, maps: &mut BTreeMap<String, MapShot>) -> Result<()> {
    let file = File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    let names: Vec<String> = archive
        .file_names()
        .filter(|name| entry_key(name).is_some())
        .map(|name| name.to_string())
        .collect();

    let source = path.display().to_string();
    for name in names {
        let Some((key, extension)) = entry_key(&name) else {
            continue;
        };
        let Some(bytes) = read_entry(&mut archive, &name, path)? else {
            continue;
        };
        if let Some(shot) = store_image(&bytes, &key, &extension, &source, dir)? {
            maps.insert(key, shot);
        }
    }
    Ok(())
}

/// Reads one archive entry, or `None` when it is too big to be a picture.
fn read_entry(
    archive: &mut ZipArchive<BufReader<File>>,
    name: &str,
    path: &Path,
) -> Result<Option<Vec<u8>>> {
    let mut entry = archive.by_name(name)?;
    if entry.size() > MAX_ENTRY_BYTES {
        log::warn!(
            "{name} in {} is {} bytes, too large for a levelshot",
            path.display(),
            entry.size()
        );
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::io_path("cannot read an entry of", path, e))?;
    Ok(Some(bytes))
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/// `cache\levelshots\`.
fn cache_dir(paths: &DataPaths) -> PathBuf {
    paths.cache.join(CACHE_DIR)
}

/// Reads the index, or `None` when there is none and when the one on disk is
/// unreadable. A cache that cannot be parsed is a cache that gets rebuilt.
fn load_index(dir: &Path) -> Option<Index> {
    let file = dir.join(INDEX_FILE);
    let text = fs::read_to_string(&file).ok()?;
    match serde_json::from_str(&text) {
        Ok(index) => Some(index),
        Err(e) => {
            log::warn!("cannot parse {}: {e}, rebuilding", file.display());
            None
        }
    }
}

fn save_index(dir: &Path, index: &Index) -> Result<()> {
    let file = dir.join(INDEX_FILE);
    let text = serde_json::to_string_pretty(index)
        .map_err(|e| AppError::json("cannot serialize the levelshot index", e))?;
    fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
}

/// Rebuilds the index from scratch and returns it with what it cost.
fn rebuild(paths: &DataPaths, settings: &Settings) -> Result<(Index, RebuildStats)> {
    let started = Instant::now();
    let dir = cache_dir(paths);
    paths::create_dir(&dir)?;

    let sources = collect_sources(paths, settings);
    let mut maps: BTreeMap<String, MapShot> = BTreeMap::new();
    for source in &sources {
        let outcome = match source {
            Source::Archive(path) => scan_archive(path, &dir, &mut maps),
            Source::Loose { path, key } => store_loose(path, key, &dir, &mut maps),
        };
        // One damaged pk3 costs its own pictures and nothing else: a player
        // with a half-downloaded map still gets art for the rest.
        if let Err(e) = outcome {
            log::warn!("cannot read {}: {e}", source.path().display());
        }
    }

    let index = Index {
        built_at: timestamp::now_rfc3339(),
        sources: stamps(&sources),
        maps,
    };
    save_index(&dir, &index)?;
    remove_orphans(&dir, &index);

    let stats = RebuildStats {
        maps: index.maps.len(),
        sources: index.sources.len(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    log::info!(
        "levelshots: {} pictures from {} sources in {} ms",
        stats.maps,
        stats.sources,
        stats.elapsed_ms
    );
    Ok((index, stats))
}

/// Adds one loose picture to `maps`.
fn store_loose(
    path: &Path,
    key: &str,
    dir: &Path,
    maps: &mut BTreeMap<String, MapShot>,
) -> Result<()> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bytes = fs::read(path).map_err(|e| AppError::io_path("cannot read", path, e))?;
    let source = path.display().to_string();
    if let Some(shot) = store_image(&bytes, key, &extension, &source, dir)? {
        maps.insert(key.to_string(), shot);
    }
    Ok(())
}

/// Deletes cached pictures no key points at any more.
///
/// Best effort: a file the webview has open stays until the next rebuild.
fn remove_orphans(dir: &Path, index: &Index) {
    let kept: HashSet<&str> = index.maps.values().map(|shot| shot.file.as_str()).collect();
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == INDEX_FILE || kept.contains(name.as_str()) {
            continue;
        }
        if let Err(e) = fs::remove_file(entry.path()) {
            log::warn!("cannot remove {}: {e}", entry.path().display());
        }
    }
}

/// Returns the index, rebuilding it when it is missing or out of date.
///
/// Out of date means any source changed size or modification time, a source
/// disappeared, or a new pk3 appeared. Nothing else triggers a rebuild: the
/// retail archives never change, and reading four `metadata` calls on every
/// lookup costs nothing.
fn ensure_index(paths: &DataPaths, settings: &Settings) -> Result<(Index, bool)> {
    let dir = cache_dir(paths);
    let Some(index) = load_index(&dir) else {
        return rebuild(paths, settings).map(|(index, _)| (index, true));
    };
    let current = stamps(&collect_sources(paths, settings));
    if current == index.sources {
        return Ok((index, false));
    }
    rebuild(paths, settings).map(|(index, _)| (index, true))
}

/// Turns an index entry into the answer of the command, or `None` when the
/// file behind it is gone — a player who emptied `cache\` gets a rebuild on
/// the next source change instead of a broken image.
fn resolve(index: &Index, dir: &Path, key: &str) -> Option<Levelshot> {
    let shot = index.maps.get(key)?;
    let file = dir.join(&shot.file);
    if !file.is_file() {
        return None;
    }
    Some(Levelshot {
        path: file.display().to_string(),
        width: shot.width,
        height: shot.height,
    })
}

/// Looks for one key in the sources without rebuilding the whole index.
///
/// This is what makes a map pk3 the player dropped in a minute ago work: the
/// index is current by its own rules — no source changed — but the map was
/// never asked for before. The scan reads only the central directory of each
/// archive and extracts at most one entry.
fn find_one(paths: &DataPaths, settings: &Settings, key: &str) -> Result<Option<MapShot>> {
    let dir = cache_dir(paths);
    paths::create_dir(&dir)?;
    let wanted: Vec<String> = IMAGE_EXTENSIONS
        .iter()
        .map(|extension| format!("{key}.{extension}"))
        .collect();

    let mut found: Option<MapShot> = None;
    for source in collect_sources(paths, settings) {
        let outcome = match &source {
            Source::Loose { path, key: loose } if loose == key => {
                let mut maps = BTreeMap::new();
                let stored = store_loose(path, key, &dir, &mut maps);
                stored.map(|()| maps.remove(key))
            }
            Source::Loose { .. } => Ok(None),
            Source::Archive(path) => find_in_archive(path, &wanted, key, &dir),
        };
        match outcome {
            // Later wins, exactly as in a rebuild.
            Ok(Some(shot)) => found = Some(shot),
            Ok(None) => {}
            Err(e) => log::warn!("cannot read {}: {e}", source.path().display()),
        }
    }
    Ok(found)
}

/// Extracts `levelshots/<key>.<ext>` from one archive, if it is in there.
fn find_in_archive(
    path: &Path,
    wanted: &[String],
    key: &str,
    dir: &Path,
) -> Result<Option<MapShot>> {
    let file = File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    let Some(name) = archive
        .file_names()
        .find(|name| {
            let lower = name.replace('\\', "/").to_ascii_lowercase();
            lower
                .strip_prefix(ENTRY_PREFIX)
                .is_some_and(|rest| wanted.iter().any(|candidate| candidate == rest))
        })
        .map(|name| name.to_string())
    else {
        return Ok(None);
    };

    let Some((_, extension)) = entry_key(&name) else {
        return Ok(None);
    };
    let Some(bytes) = read_entry(&mut archive, &name, path)? else {
        return Ok(None);
    };
    store_image(&bytes, key, &extension, &path.display().to_string(), dir)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The picture of one map, or `null` when nothing the player owns has one.
///
/// The lookup goes through three stages. The index is brought up to date when
/// a source changed; a hit answers from it; a miss falls back to a targeted
/// scan for `levelshots/<map>.*`, so a pk3 added while the launcher was open
/// works without a full rebuild. A second miss on the same key is remembered
/// and answered without touching the disk.
#[tauri::command]
pub async fn get_levelshot(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    shots: tauri::State<'_, LevelshotState>,
    map: String,
) -> Result<Option<Levelshot>> {
    let key = map_key(&map);
    if key.is_empty() {
        return Ok(None);
    }
    let paths = state.paths()?;
    let settings = state.settings()?;
    let dir = cache_dir(&paths);

    // One lookup at a time: the Servers screen mounts a card per row, and
    // without the gate the first ten of them would each start a rebuild.
    let _gate = shots.gate.lock().await;

    let (index, rebuilt) = blocking("the levelshot index", {
        let paths = paths.clone();
        let settings = settings.clone();
        move || ensure_index(&paths, &settings)
    })
    .await?;
    if rebuilt {
        shots.forget_misses();
        notify(&app);
    }
    if let Some(shot) = resolve(&index, &dir, &key) {
        return Ok(Some(shot));
    }
    if shots.is_known_miss(&key) {
        return Ok(None);
    }

    let found = blocking("a levelshot lookup", {
        let paths = paths.clone();
        let key = key.clone();
        move || find_one(&paths, &settings, &key)
    })
    .await?;

    let Some(shot) = found else {
        shots.remember_miss(&key);
        return Ok(None);
    };
    // The index gains the picture so the next run answers from it.
    let mut index = index;
    index.maps.insert(key.clone(), shot);
    save_index(&dir, &index)?;
    Ok(resolve(&index, &dir, &key))
}

/// Reads every source again, whatever the index says. The Settings screen's
/// **Rebuild** button, and the way out of a cache somebody edited by hand.
#[tauri::command]
pub async fn rebuild_levelshots(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    shots: tauri::State<'_, LevelshotState>,
) -> Result<RebuildStats> {
    let paths = state.paths()?;
    let settings = state.settings()?;

    let _gate = shots.gate.lock().await;
    let (_, stats) = blocking("the levelshot rebuild", move || rebuild(&paths, &settings)).await?;
    shots.forget_misses();
    notify(&app);
    Ok(stats)
}

/// Every map the launcher has a picture for, sorted. The Settings card counts
/// them; a screen that wants one picture asks [`get_levelshot`] instead.
#[tauri::command]
pub async fn list_levelshots(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    shots: tauri::State<'_, LevelshotState>,
) -> Result<Vec<String>> {
    let paths = state.paths()?;
    let settings = state.settings()?;

    let _gate = shots.gate.lock().await;
    let (index, rebuilt) = blocking("the levelshot index", move || {
        ensure_index(&paths, &settings)
    })
    .await?;
    if rebuilt {
        shots.forget_misses();
        notify(&app);
    }
    Ok(index.maps.into_keys().collect())
}

/// Runs disk and picture work off the async runtime.
///
/// Reading a 561 MB archive and re-encoding a picture are both blocking, and
/// the runtime has to keep answering the rest of the launcher meanwhile.
async fn blocking<T, F>(what: &'static str, job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::Image(format!("{what} did not finish: {e}")))?
}

/// Tells an open window that the index changed.
fn notify(app: &AppHandle) {
    if let Err(e) = app.emit(EVENT_CHANGED, ()) {
        log::warn!("cannot emit {EVENT_CHANGED}: {e}");
    }
}

/// Lets the webview read the cache folder through the asset protocol.
///
/// The static scope in `tauri.conf.json` covers `$APPLOCALDATA/cache/**`,
/// which is where the folder is unless the player set `dataDirOverride`. This
/// adds the resolved folder, so a data folder on another disk shows pictures
/// too. Nothing else is added: the scope stays one folder the launcher owns.
pub fn allow_cache_folder(app: &AppHandle, paths: &DataPaths) {
    use tauri::Manager;

    let dir = cache_dir(paths);
    if let Err(e) = paths::create_dir(&dir) {
        log::warn!("{e}");
        return;
    }
    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, false) {
        log::warn!("cannot serve {}: {e}", dir.display());
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use image::{Rgb, RgbImage};
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;

    /// A picture of the given size, encoded in the given format.
    fn picture(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let mut image = RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), format)
            .expect("encode");
        bytes
    }

    /// Writes a pk3 with the given entries.
    fn write_pk3(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let file = File::create(path).expect("create pk3");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("start entry");
            writer.write_all(bytes).expect("write entry");
        }
        writer.finish().expect("finish pk3");
    }

    /// A data root with a game folder, and the settings that point at it.
    fn workspace() -> (TempDir, DataPaths, Settings) {
        let temp = TempDir::new().expect("temp dir");
        let paths = DataPaths::new(temp.path().join("data"));
        paths.ensure().expect("data folders");
        let game = temp.path().join("GameData");
        fs::create_dir_all(game.join("base")).expect("game folder");
        let settings = Settings {
            game_data_path: Some(game.display().to_string()),
            ..Settings::default()
        };
        (temp, paths, settings)
    }

    #[test]
    fn an_entry_path_becomes_a_lowercase_key() {
        assert_eq!(
            entry_key("levelshots/MP/FFA1.JPG"),
            Some(("mp/ffa1".into(), "jpg".into()))
        );
        assert_eq!(
            entry_key("LevelShots\\mb2_smuggler.TGA"),
            Some(("mb2_smuggler".into(), "tga".into()))
        );
        // A folder entry, a file outside `levelshots/` and a file that is not
        // a picture are all not levelshots.
        assert_eq!(entry_key("levelshots/mp/"), None);
        assert_eq!(entry_key("maps/mp/ffa1.bsp"), None);
        assert_eq!(entry_key("levelshots/readme.txt"), None);
        assert_eq!(entry_key("levelshots/.jpg"), None);
    }

    #[test]
    fn a_map_name_becomes_the_same_key_in_any_case() {
        assert_eq!(map_key("MP/FFA1"), "mp/ffa1");
        assert_eq!(map_key(" mp\\ffa1 "), "mp/ffa1");
        assert_eq!(map_key("MB2_Smuggler"), "mb2_smuggler");
        // A server that answers the whole file name lands on the same key.
        assert_eq!(map_key("maps/mp/ffa3.bsp"), "mp/ffa3");
        assert_eq!(map_key("/mp/ffa3/"), "mp/ffa3");
        assert_eq!(map_key("   "), "");
    }

    #[test]
    fn a_key_flattens_into_one_file_name() {
        assert_eq!(
            cache_file_name("mp/ffa1", "jpg").as_deref(),
            Some("mp__ffa1.jpg")
        );
        assert_eq!(
            cache_file_name("mb2_smuggler", "png").as_deref(),
            Some("mb2_smuggler.png")
        );
        // Nothing that could name a file outside the cache folder.
        assert_eq!(cache_file_name("../secret", "jpg"), None);
        assert_eq!(cache_file_name("mp/../../x", "jpg"), None);
        assert_eq!(cache_file_name("mp//ffa1", "jpg"), None);
        assert_eq!(cache_file_name("C:/windows", "jpg"), None);
        assert_eq!(cache_file_name("", "jpg"), None);
        assert_eq!(cache_file_name(&"a".repeat(MAX_KEY_LEN + 1), "jpg"), None);
    }

    #[test]
    fn sources_follow_the_load_order_of_the_engine() {
        let (_temp, paths, settings) = workspace();
        let base = Path::new(settings.game_data_path.as_deref().unwrap()).join("base");
        write_pk3(&base.join("assets0.pk3"), &[]);
        write_pk3(&base.join("dl_extra.pk3"), &[]);
        write_pk3(&base.join("zzz_maps.pk3"), &[]);
        fs::create_dir_all(base.join("levelshots")).expect("loose folder");
        fs::write(base.join("levelshots").join("loose.jpg"), b"x").expect("loose file");

        let names: Vec<String> = collect_sources(&paths, &settings)
            .iter()
            .map(|source| {
                source
                    .path()
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string()
            })
            .collect();

        // The loose file first, because the engine puts the folder behind its
        // archives; `dl_` archives last, because `paksort` puts them there.
        assert_eq!(
            names,
            ["loose.jpg", "assets0.pk3", "zzz_maps.pk3", "dl_extra.pk3"]
        );
    }

    #[test]
    fn a_changed_pk3_makes_the_index_stale() {
        let (_temp, paths, settings) = workspace();
        let base = Path::new(settings.game_data_path.as_deref().unwrap()).join("base");
        let pk3 = base.join("assets0.pk3");
        write_pk3(
            &pk3,
            &[("levelshots/mp/ffa1.jpg", picture(64, 64, ImageFormat::Jpeg))],
        );

        let (first, rebuilt) = ensure_index(&paths, &settings).expect("first index");
        assert!(rebuilt);
        assert!(first.maps.contains_key("mp/ffa1"));

        let (_, rebuilt) = ensure_index(&paths, &settings).expect("second index");
        assert!(!rebuilt, "an unchanged source must not cost a rebuild");

        // A new archive is a new source, and a new source is a rebuild.
        write_pk3(
            &base.join("zzz_maps.pk3"),
            &[(
                "levelshots/mb2_smuggler.jpg",
                picture(64, 64, ImageFormat::Jpeg),
            )],
        );
        let (third, rebuilt) = ensure_index(&paths, &settings).expect("third index");
        assert!(rebuilt);
        assert!(third.maps.contains_key("mb2_smuggler"));
        assert_eq!(third.sources.len(), 2);
    }

    #[test]
    fn a_tga_becomes_a_png() {
        let (_temp, paths, _settings) = workspace();
        let dir = cache_dir(&paths);
        paths::create_dir(&dir).expect("cache folder");

        let shot = store_image(
            &picture(32, 16, ImageFormat::Tga),
            "mb2_smuggler",
            "tga",
            "test.pk3",
            &dir,
        )
        .expect("store")
        .expect("a picture");

        assert_eq!(shot.file, "mb2_smuggler.png");
        assert_eq!((shot.width, shot.height), (32, 16));
        let written = dir.join(&shot.file);
        assert_eq!(
            image::ImageReader::open(&written)
                .expect("open")
                .with_guessed_format()
                .expect("guess")
                .format(),
            Some(ImageFormat::Png)
        );
    }

    #[test]
    fn a_picture_within_the_cap_is_copied_byte_for_byte() {
        let (_temp, paths, _settings) = workspace();
        let dir = cache_dir(&paths);
        paths::create_dir(&dir).expect("cache folder");

        let bytes = picture(64, 32, ImageFormat::Jpeg);
        let shot = store_image(&bytes, "mp/ffa1", "jpg", "test.pk3", &dir)
            .expect("store")
            .expect("a picture");

        assert_eq!(shot.file, "mp__ffa1.jpg");
        assert_eq!((shot.width, shot.height), (64, 32));
        assert_eq!(fs::read(dir.join(&shot.file)).expect("read"), bytes);
    }

    #[test]
    fn a_picture_above_the_cap_is_downscaled() {
        let (_temp, paths, _settings) = workspace();
        let dir = cache_dir(&paths);
        paths::create_dir(&dir).expect("cache folder");

        let shot = store_image(
            &picture(MAX_SIDE * 2, MAX_SIDE, ImageFormat::Png),
            "huge",
            "png",
            "test.pk3",
            &dir,
        )
        .expect("store")
        .expect("a picture");

        assert_eq!((shot.width, shot.height), (MAX_SIDE, MAX_SIDE / 2));
        let written = image::ImageReader::open(dir.join(&shot.file))
            .expect("open")
            .into_dimensions()
            .expect("dimensions");
        assert_eq!(written, (MAX_SIDE, MAX_SIDE / 2));
    }

    #[test]
    fn the_last_source_wins_and_orphans_go_away() {
        let (_temp, paths, settings) = workspace();
        let base = Path::new(settings.game_data_path.as_deref().unwrap()).join("base");
        write_pk3(
            &base.join("assets0.pk3"),
            &[
                ("levelshots/mp/ffa1.jpg", picture(64, 64, ImageFormat::Jpeg)),
                ("levelshots/mp/ffa2.jpg", picture(64, 64, ImageFormat::Jpeg)),
            ],
        );
        write_pk3(
            &base.join("zzz_pack.pk3"),
            &[("levelshots/mp/ffa1.jpg", picture(32, 16, ImageFormat::Jpeg))],
        );

        let (index, _) = rebuild(&paths, &settings).expect("rebuild");
        let winner = index.maps.get("mp/ffa1").expect("ffa1");
        assert_eq!((winner.width, winner.height), (32, 16));
        assert!(winner.source.ends_with("zzz_pack.pk3"));

        // Drop the second archive and the picture it left behind must go.
        fs::remove_file(base.join("zzz_pack.pk3")).expect("remove");
        let (index, _) = rebuild(&paths, &settings).expect("second rebuild");
        assert_eq!(index.maps.get("mp/ffa1").map(|shot| shot.width), Some(64));

        let files: Vec<String> = fs::read_dir(cache_dir(&paths))
            .expect("cache folder")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        assert_eq!(files.len(), 3, "index.json and two pictures: {files:?}");
    }

    #[test]
    fn a_targeted_lookup_finds_a_map_the_index_never_saw() {
        let (_temp, paths, settings) = workspace();
        let base = Path::new(settings.game_data_path.as_deref().unwrap()).join("base");
        write_pk3(
            &base.join("mb2_smuggler.pk3"),
            &[(
                "levelshots/MB2_Smuggler.jpg",
                picture(48, 24, ImageFormat::Jpeg),
            )],
        );

        let found = find_one(&paths, &settings, "mb2_smuggler")
            .expect("lookup")
            .expect("a picture");
        assert_eq!(found.file, "mb2_smuggler.jpg");
        assert_eq!((found.width, found.height), (48, 24));

        assert!(find_one(&paths, &settings, "mp/ffa1")
            .expect("lookup")
            .is_none());
    }

    #[test]
    fn a_client_folder_beats_the_game_folder() {
        let (_temp, paths, settings) = workspace();
        let base = Path::new(settings.game_data_path.as_deref().unwrap()).join("base");
        write_pk3(
            &base.join("assets0.pk3"),
            &[("levelshots/mp/ffa1.jpg", picture(64, 64, ImageFormat::Jpeg))],
        );
        let home = paths.client_dir("everyday").join("home").join("japlus");
        fs::create_dir_all(&home).expect("client folder");
        write_pk3(
            &home.join("newshots.pk3"),
            &[("levelshots/mp/ffa1.jpg", picture(16, 8, ImageFormat::Jpeg))],
        );

        let (index, _) = rebuild(&paths, &settings).expect("rebuild");
        let shot = index.maps.get("mp/ffa1").expect("ffa1");
        assert_eq!((shot.width, shot.height), (16, 8));
    }

    /// Builds the index from the real installation and prints what it cost.
    ///
    /// Hardcodes a path that exists on one machine, which is why it is
    /// ignored. Run it with:
    ///
    /// ```text
    /// cargo test --lib -- --ignored --nocapture indexes_the_retail_archives
    /// ```
    #[test]
    #[ignore]
    fn indexes_the_retail_archives() {
        let temp = TempDir::new().expect("temp dir");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("data folders");
        let settings = Settings {
            game_data_path: Some(
                "D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData".to_string(),
            ),
            ..Settings::default()
        };

        let (index, stats) = rebuild(&paths, &settings).expect("rebuild");
        println!(
            "{} pictures from {} sources in {} ms",
            stats.maps, stats.sources, stats.elapsed_ms
        );
        let bytes: u64 = fs::read_dir(cache_dir(&paths))
            .expect("cache folder")
            .flatten()
            .filter_map(|entry| entry.metadata().ok())
            .map(|meta| meta.len())
            .sum();
        println!("cache folder: {bytes} bytes");
        for key in ["mp/ffa1", "mp/ffa3", "mp/duel1", "mp/siege_hoth"] {
            let shot = index.maps.get(key).unwrap_or_else(|| panic!("{key}"));
            println!("{key}: {} {}x{}", shot.file, shot.width, shot.height);
        }
        assert!(index.maps.len() >= 56, "{} pictures", index.maps.len());
    }
}
