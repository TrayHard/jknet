//! The pk3 library of a client.
//!
//! A library file is a pk3 with a skin, a hilt, a map or a mod. It belongs to
//! one client, not to the launcher: JKNet never writes into the game folder,
//! so the engine sees the files through `fs_homepath`, which is the client's
//! `home\` folder:
//!
//! ```text
//! clients\<slug>\home\base\        files the engine always loads
//! clients\<slug>\home\<fs_game>\   files only that mod loads
//! clients\<slug>\library.json      the metadata sidecar of this module
//! ```
//!
//! Two rules of `codemp/qcommon/files.cpp` (OpenJK `master` @ `1a6a6434`)
//! decide the whole design:
//!
//! * `FS_AddGameDirectory` (`files.cpp:3089`) lists only the `.pk3` extension,
//!   so a file renamed to `name.pk3.disabled` stays on disk and stops being
//!   loaded. That rename is what the toggle on a card does.
//! * The list is sorted by `paksort` (`files.cpp:3025`), a case-insensitive
//!   path compare that pushes `dl_` names last, and every archive is prepended
//!   to the search path (`files.cpp:3152`). The archive that sorts last
//!   therefore answers first: when two pk3 files carry the same internal
//!   path, the last one wins.
//!
//! Disk is the source of truth. The sidecar only remembers what an archive
//! cannot tell — the name the player gave a file and where it came from — and
//! a missing entry is rebuilt by inspecting the pk3, so deleting the sidecar
//! costs nothing but the display names.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::Emitter;
use zip::ZipArchive;

use crate::error::{AppError, Result};
use crate::paths::{self, DataPaths};
use crate::state::AppState;
use crate::timestamp;

/// Metadata document next to `client.json`.
const SIDECAR: &str = "library.json";

/// What the engine's file lister ignores, which is how a file is disabled.
const DISABLED_SUFFIX: &str = ".disabled";

/// Folder used when the caller does not name one. The engine always loads it.
const DEFAULT_FOLDER: &str = "base";

/// Entries `inspect_pk3` returns as a preview of the archive.
const NOTABLE_ENTRIES: usize = 20;

/// Longest conflict list the screen can show without becoming a wall of text.
const MAX_CONFLICT_PATHS: usize = 200;

/// Share of entries under `sound\` or `music\` that makes an archive a sound
/// pack rather than something else that happens to ship audio.
const SOUND_SHARE: usize = 60;

/// Longest display name accepted by `rename_library_item`.
const MAX_DISPLAY_NAME: usize = 96;

/// Emitted after every change so an open Library screen can refetch.
const EVENT_CHANGED: &str = "library:changed";

// --- slice: jkhub ---
/// Folder inside `home\` the launcher keeps its own notes in.
///
/// It sits under `home\` rather than next to `client.json` so that a client
/// folder copied by hand carries its notes with its files. The engine lists
/// only `.pk3` names, so a folder starting with a dot is invisible to it.
const NOTES_FOLDER: &str = ".jknet";

/// Where each installed file came from, keyed by `<folder>/<file name>`.
const PROVENANCE: &str = "provenance.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// What kind of content a pk3 holds. The player filters by this on the
/// Library screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryCategory {
    Skin,
    Hilt,
    Map,
    Mod,
    Hud,
    Sound,
    Other,
}

/// One pk3 in the home folder of one client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    /// `<folder>/<file name>`, always with the enabled `.pk3` spelling, so the
    /// id survives the toggle.
    pub id: String,
    /// `base` or the `fs_game` folder the file belongs to.
    pub folder: String,
    /// File name with the `.pk3` extension, without `.disabled`.
    pub file_name: String,
    /// Name on the card. Defaults to the file name without its extension.
    pub display_name: String,
    pub category: LibraryCategory,
    pub size: u64,
    /// False when the file on disk carries the `.pk3.disabled` name.
    pub enabled: bool,
    /// UTC time the file appeared in the client, RFC 3339.
    pub added_at: String,
    /// Where the file came from: `local` for a file added from disk,
    /// `jkhub` for one the JKHub tab installed.
    pub source: Option<String>,
    // --- slice: jkhub ---
    /// What the JKHub tab wrote down about this file, when it installed it.
    /// `None` for anything added by hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<crate::jkhub::types::Provenance>,
    /// SHA-1 of the whole archive, `None` when the file could not be read.
    pub sha1: Option<String>,
    /// Free text the player typed. Nothing writes it yet.
    pub notes: Option<String>,
}

/// What `inspect_pk3` reads out of an archive without installing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pk3Report {
    pub path: String,
    pub file_name: String,
    pub category: LibraryCategory,
    /// Files inside the archive, directory entries excluded.
    pub entry_count: usize,
    /// The first [`NOTABLE_ENTRIES`] entries, for a preview.
    pub notable_entries: Vec<String>,
    pub size: u64,
    pub sha1: String,
    /// First segment of every internal path, deduplicated and sorted.
    pub top_level: Vec<String>,
}

/// A file `add_library_files` refused, with the reason to print next to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub file_name: String,
    pub reason: String,
    /// Free file name to retry with, set when the name was taken.
    pub suggested_name: Option<String>,
    /// Id of the item that already holds the same bytes.
    pub existing_id: Option<String>,
}

/// Outcome of one call to `add_library_files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub added: Vec<LibraryItem>,
    pub skipped: Vec<SkippedFile>,
}

/// One internal path that more than one enabled archive carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryConflict {
    /// Path inside the archives, lowercase, forward slashes.
    pub path: String,
    pub folder: String,
    /// Ids of the items that carry the path, in the engine's load order.
    pub files: Vec<String>,
    /// Id of the item the engine actually reads: the last one loaded.
    pub winner: String,
}

/// What `find_library_conflicts` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictReport {
    pub conflicts: Vec<LibraryConflict>,
    /// Conflicting paths found before the cap was applied.
    pub total: usize,
    /// True when `conflicts` holds only the first [`MAX_CONFLICT_PATHS`].
    pub truncated: bool,
    /// Ids of every item taking part in a conflict.
    pub files: Vec<String>,
}

/// Payload of `library:changed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryChanged {
    client_id: String,
}

/// The part of an item the archive cannot tell, kept in `library.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemMeta {
    display_name: String,
    category: LibraryCategory,
    size: u64,
    sha1: Option<String>,
    added_at: String,
    source: Option<String>,
    notes: Option<String>,
}

/// The sidecar document: item id to metadata.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Sidecar {
    items: BTreeMap<String, ItemMeta>,
}

/// One pk3 as the scanner found it on disk.
#[derive(Debug, Clone)]
struct ScannedFile {
    folder: String,
    /// Enabled spelling of the name, whatever the file is called right now.
    file_name: String,
    enabled: bool,
    path: PathBuf,
    size: u64,
    /// Unix seconds, 0 when the platform refused to report it.
    modified: u64,
}

impl ScannedFile {
    fn id(&self) -> String {
        item_id(&self.folder, &self.file_name)
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Lists the library of one client, refreshing the sidecar from disk.
///
/// The scan is what makes a file copied in by hand show up: the sidecar is
/// filled in for anything it does not know and pruned of anything that is
/// gone.
#[tauri::command]
pub fn list_library(state: tauri::State<'_, AppState>, client_id: String) -> Result<Vec<LibraryItem>> {
    let data = state.paths()?;
    read_library(&data, &client_id)
}

/// Reads an archive without installing it: category, size, SHA-1 and a
/// preview of what is inside.
#[tauri::command]
pub fn inspect_pk3(path: String) -> Result<Pk3Report> {
    inspect(Path::new(&path))
}

/// Copies pk3 files into a client and records what they are.
///
/// A file is refused rather than overwritten: the same bytes under another
/// name are a duplicate, the same name with other bytes is a collision, and
/// both answers name what to do next.
#[tauri::command]
pub fn add_library_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    paths: Vec<String>,
    folder: Option<String>,
) -> Result<AddResult> {
    let data = state.paths()?;
    let result = add_files(&data, &client_id, &paths, folder.as_deref())?;
    if !result.added.is_empty() {
        notify(&app, &client_id);
    }
    Ok(result)
}

/// Enables or disables one file by renaming it between `.pk3` and
/// `.pk3.disabled`, which is how the engine's file lister sees it.
#[tauri::command]
pub fn set_library_item_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    id: String,
    enabled: bool,
) -> Result<LibraryItem> {
    let data = state.paths()?;
    let item = set_enabled(&data, &client_id, &id, enabled)?;
    notify(&app, &client_id);
    Ok(item)
}

/// Deletes one file and forgets its metadata.
#[tauri::command]
pub fn remove_library_item(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    id: String,
) -> Result<()> {
    let data = state.paths()?;
    remove_item(&data, &client_id, &id)?;
    notify(&app, &client_id);
    Ok(())
}

/// Renames the card, never the file: a pk3 name is part of the engine's load
/// order, so changing it would change which archive wins a conflict.
#[tauri::command]
pub fn rename_library_item(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    id: String,
    display_name: String,
) -> Result<LibraryItem> {
    let data = state.paths()?;
    let item = rename_item(&data, &client_id, &id, &display_name)?;
    notify(&app, &client_id);
    Ok(item)
}

/// Finds internal paths carried by more than one enabled archive and says
/// which archive the engine reads.
#[tauri::command]
pub fn find_library_conflicts(
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<ConflictReport> {
    let data = state.paths()?;
    conflicts(&data, &client_id)
}

// ---------------------------------------------------------------------------
// Library reading
// ---------------------------------------------------------------------------

/// Scans the client's home folder and merges the result with the sidecar.
fn read_library(data: &DataPaths, client_id: &str) -> Result<Vec<LibraryItem>> {
    let dir = client_dir(data, client_id)?;
    let files = scan(&dir.join("home"));
    let mut sidecar = read_sidecar(&dir);
    // --- slice: jkhub ---
    let provenance = read_provenance(&dir);
    let mut changed = false;
    let mut items = Vec::with_capacity(files.len());
    let mut present = BTreeSet::new();

    for file in &files {
        let id = file.id();
        present.insert(id.clone());
        let meta = match sidecar.items.get(&id) {
            // A size that no longer matches means the file was replaced on
            // disk, so its category and hash have to be read again.
            Some(meta) if meta.size == file.size => meta.clone(),
            _ => {
                changed = true;
                let meta = describe(file);
                sidecar.items.insert(id.clone(), meta.clone());
                meta
            }
        };
        // --- slice: jkhub ---
        // The record of a JKHub install outranks whatever the sidecar
        // remembers: it is the only one of the two that names a file id.
        let from_jkhub = provenance.get(&id).cloned();
        let source = match &from_jkhub {
            Some(entry) => Some(entry.source.clone()),
            None => meta.source,
        };
        items.push(LibraryItem {
            id,
            folder: file.folder.clone(),
            file_name: file.file_name.clone(),
            display_name: meta.display_name,
            category: meta.category,
            size: file.size,
            enabled: file.enabled,
            added_at: meta.added_at,
            source,
            sha1: meta.sha1,
            notes: meta.notes,
            provenance: from_jkhub,
        });
    }

    let before = sidecar.items.len();
    sidecar.items.retain(|id, _| present.contains(id));
    changed |= sidecar.items.len() != before;
    if changed {
        write_sidecar(&dir, &sidecar)?;
    }

    items.sort_by(|a, b| {
        a.folder
            .cmp(&b.folder)
            .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
    });
    Ok(items)
}

/// Reads what an archive itself can tell about a file the sidecar has never
/// seen.
///
/// A pk3 that will not open is still listed, as `other` without a hash: one
/// broken download must not hide the rest of the library.
fn describe(file: &ScannedFile) -> ItemMeta {
    let (category, sha1) = match inspect(&file.path) {
        Ok(report) => (report.category, Some(report.sha1)),
        Err(e) => {
            log::warn!("cannot read {}: {e}", file.path.display());
            (LibraryCategory::Other, None)
        }
    };
    ItemMeta {
        display_name: default_display_name(&file.file_name),
        category,
        size: file.size,
        sha1,
        added_at: timestamp::from_unix_seconds(file.modified),
        source: None,
        notes: None,
    }
}

/// Lists every pk3 one level below `home`, enabled or not, one entry per id.
///
/// An unreadable folder is skipped instead of failing the scan, for the same
/// reason `clients.rs` skips a broken `client.json`. A file that exists under
/// both spellings at once — `skin.pk3` and `skin.pk3.disabled` side by side,
/// which only a hand edit produces — counts once, as enabled: that is what the
/// engine sees.
fn scan(home: &Path) -> Vec<ScannedFile> {
    let mut files = scan_all(home);
    files.sort_by(|a, b| {
        a.folder
            .cmp(&b.folder)
            .then_with(|| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()))
            .then_with(|| b.enabled.cmp(&a.enabled))
    });
    files.dedup_by(|a, b| {
        a.folder == b.folder && a.file_name.eq_ignore_ascii_case(&b.file_name)
    });
    files
}

/// The raw listing, duplicates and all.
fn scan_all(home: &Path) -> Vec<ScannedFile> {
    let Ok(folders) = fs::read_dir(home) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for folder in folders.flatten() {
        let folder_path = folder.path();
        if !folder_path.is_dir() {
            continue;
        }
        let Some(folder_name) = folder.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(&folder_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some((file_name, enabled)) = split_state(name) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            files.push(ScannedFile {
                folder: folder_name.clone(),
                file_name,
                enabled,
                path,
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|since| since.as_secs())
                    .unwrap_or(0),
            });
        }
    }
    files
}

/// Splits a file name into its enabled spelling and its state.
///
/// Returns `None` for anything that is neither `name.pk3` nor
/// `name.pk3.disabled`, which is how a config or a screenshot in the same
/// folder is ignored.
fn split_state(name: &str) -> Option<(String, bool)> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".pk3") {
        return Some((name.to_string(), true));
    }
    let stripped = lower.strip_suffix(DISABLED_SUFFIX)?;
    if stripped.ends_with(".pk3") {
        // `to_ascii_lowercase` keeps byte offsets, so the prefix is safe.
        return Some((name[..stripped.len()].to_string(), false));
    }
    None
}

/// `<folder>/<file name>`: unique inside a client and stable across a toggle.
fn item_id(folder: &str, file_name: &str) -> String {
    format!("{folder}/{file_name}")
}

/// Splits an id back into a folder and a file name, refusing anything that
/// could point outside the client's home folder.
fn parse_item_id(id: &str) -> Result<(String, String)> {
    let Some((folder, file_name)) = id.split_once('/') else {
        return Err(AppError::InvalidInput(format!("malformed item id {id:?}")));
    };
    safe_segment(folder, "folder")?;
    safe_segment(file_name, "file name")?;
    if split_state(file_name).map(|(_, enabled)| enabled) != Some(true) {
        return Err(AppError::InvalidInput(format!(
            "item id {id:?} does not name a pk3"
        )));
    }
    Ok((folder.to_string(), file_name.to_string()))
}

/// The name a card shows until the player renames it.
fn default_display_name(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name)
        .to_string()
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/// Opens an archive read-only and reports what it holds.
fn inspect(path: &Path) -> Result<Pk3Report> {
    let file = File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let size = file
        .metadata()
        .map_err(|e| AppError::io_path("cannot read", path, e))?
        .len();
    let archive = ZipArchive::new(BufReader::new(file)).map_err(|e| {
        AppError::InvalidInput(format!("{} is not a readable pk3: {e}", path.display()))
    })?;

    let entries: Vec<String> = archive
        .file_names()
        .map(|name| name.replace('\\', "/"))
        .filter(|name| !name.ends_with('/'))
        .collect();

    let mut top_level: Vec<String> = entries
        .iter()
        .map(|entry| entry.split('/').next().unwrap_or(entry).to_ascii_lowercase())
        .collect();
    top_level.sort();
    top_level.dedup();

    Ok(Pk3Report {
        path: path.display().to_string(),
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
        category: classify(&entries),
        entry_count: entries.len(),
        notable_entries: entries.iter().take(NOTABLE_ENTRIES).cloned().collect(),
        size,
        sha1: sha1_of(path)?,
        top_level,
    })
}

/// Decides what an archive is from the paths it carries.
///
/// The order is a priority, not a preference. A module binary makes the file a
/// mod whatever assets ship with it, a `.bsp` makes it a map, and only then do
/// the asset folders decide. Sound comes last because half the packs in the
/// game ship a few audio files.
fn classify(entries: &[String]) -> LibraryCategory {
    let mut module = false;
    let mut map = false;
    let mut skin = false;
    let mut hilt = false;
    let mut hud = false;
    let mut audio = 0usize;

    for entry in entries {
        let entry = entry.to_ascii_lowercase();
        // `cgamex86.dll`, `uix86.dll`, `jampgamex86.dll` and their 64-bit
        // spellings, plus the Quake 3 virtual machine modules.
        if entry.ends_with(".dll") || entry.ends_with(".qvm") {
            module = true;
        }
        if entry.starts_with("maps/") && entry.ends_with(".bsp") {
            map = true;
        }
        if entry.starts_with("models/players/") {
            skin = true;
        }
        if entry.starts_with("models/weapons2/saber")
            || (entry.starts_with("ext_data/sabers/") && entry.ends_with(".sab"))
        {
            hilt = true;
        }
        if entry.starts_with("gfx/hud/") || (entry.starts_with("ui/") && entry.ends_with(".menu")) {
            hud = true;
        }
        if entry.starts_with("sound/") || entry.starts_with("music/") {
            audio += 1;
        }
    }

    if module {
        LibraryCategory::Mod
    } else if map {
        LibraryCategory::Map
    } else if skin {
        LibraryCategory::Skin
    } else if hilt {
        LibraryCategory::Hilt
    } else if hud {
        LibraryCategory::Hud
    } else if audio > 0 && audio * 100 >= entries.len() * SOUND_SHARE {
        LibraryCategory::Sound
    } else {
        LibraryCategory::Other
    }
}

/// SHA-1 of the whole file, streamed so a 400 MB archive costs one buffer.
fn sha1_of(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut hasher = Sha1::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| AppError::io_path("cannot read", path, e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(digest[..].iter().fold(String::new(), |mut text, byte| {
        use std::fmt::Write;
        // Writing into a String cannot fail; the result is discarded on
        // purpose so the fold stays an expression.
        let _ = write!(text, "{byte:02x}");
        text
    }))
}

// ---------------------------------------------------------------------------
// Adding, toggling, removing
// ---------------------------------------------------------------------------

/// Copies files into `home\<folder>\` and records them.
fn add_files(
    data: &DataPaths,
    client_id: &str,
    sources: &[String],
    folder: Option<&str>,
) -> Result<AddResult> {
    let folder = normalise_folder(folder)?;
    let dir = client_dir(data, client_id)?;
    let target = dir.join("home").join(&folder);
    paths::create_dir(&target)?;

    // Refreshes the sidecar first, so a duplicate check sees files that were
    // copied in behind the launcher's back.
    let existing = read_library(data, client_id)?;
    let mut sidecar = read_sidecar(&dir);
    let mut taken: BTreeSet<String> = existing
        .iter()
        .filter(|item| item.folder == folder)
        .map(|item| item.file_name.to_lowercase())
        .collect();
    let mut by_hash: HashMap<String, String> = existing
        .iter()
        .filter_map(|item| item.sha1.clone().map(|hash| (hash, item.id.clone())))
        .collect();

    let mut added = Vec::new();
    let mut skipped = Vec::new();

    for source in sources {
        let path = PathBuf::from(source);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();

        if !file_name.to_ascii_lowercase().ends_with(".pk3") {
            skipped.push(skip(source, &file_name, "only .pk3 files can be added"));
            continue;
        }
        if !path.is_file() {
            skipped.push(skip(source, &file_name, "the file is not there any more"));
            continue;
        }
        let report = match inspect(&path) {
            Ok(report) => report,
            Err(e) => {
                skipped.push(skip(source, &file_name, &e.to_string()));
                continue;
            }
        };
        if let Some(existing_id) = by_hash.get(&report.sha1) {
            let mut entry = skip(
                source,
                &file_name,
                &format!("the same archive is already installed as {existing_id}"),
            );
            entry.existing_id = Some(existing_id.clone());
            skipped.push(entry);
            continue;
        }
        if taken.contains(&file_name.to_lowercase()) {
            let mut entry = skip(
                source,
                &file_name,
                "a different file with this name is already installed",
            );
            entry.suggested_name = Some(free_name(&file_name, &taken));
            skipped.push(entry);
            continue;
        }

        let destination = target.join(&file_name);
        fs::copy(&path, &destination)
            .map_err(|e| AppError::io_path("cannot copy into", &destination, e))?;

        let id = item_id(&folder, &file_name);
        let meta = ItemMeta {
            display_name: default_display_name(&file_name),
            category: report.category,
            size: report.size,
            sha1: Some(report.sha1.clone()),
            added_at: timestamp::now_rfc3339(),
            source: Some("local".to_string()),
            notes: None,
        };
        sidecar.items.insert(id.clone(), meta.clone());
        taken.insert(file_name.to_lowercase());
        by_hash.insert(report.sha1, id.clone());
        added.push(LibraryItem {
            id,
            folder: folder.clone(),
            file_name,
            display_name: meta.display_name,
            category: meta.category,
            size: meta.size,
            enabled: true,
            added_at: meta.added_at,
            source: meta.source,
            sha1: meta.sha1,
            notes: None,
            provenance: None,
        });
    }

    if !added.is_empty() {
        write_sidecar(&dir, &sidecar)?;
        log::info!("added {} file(s) to client {client_id}", added.len());
    }
    Ok(AddResult { added, skipped })
}

fn skip(path: &str, file_name: &str, reason: &str) -> SkippedFile {
    SkippedFile {
        path: path.to_string(),
        file_name: file_name.to_string(),
        reason: reason.to_string(),
        suggested_name: None,
        existing_id: None,
    }
}

/// Appends `_2`, `_3` and so on until the name is free in the target folder.
fn free_name(file_name: &str, taken: &BTreeSet<String>) -> String {
    let (stem, extension) = file_name
        .rsplit_once('.')
        .unwrap_or((file_name, "pk3"));
    (2..)
        .map(|n| format!("{stem}_{n}.{extension}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .unwrap_or_else(|| file_name.to_string())
}

/// Renames the file between `.pk3` and `.pk3.disabled`.
fn set_enabled(
    data: &DataPaths,
    client_id: &str,
    id: &str,
    enabled: bool,
) -> Result<LibraryItem> {
    let dir = client_dir(data, client_id)?;
    let (folder, file_name) = parse_item_id(id)?;
    let folder_path = dir.join("home").join(&folder);
    let on = folder_path.join(&file_name);
    let off = folder_path.join(format!("{file_name}{DISABLED_SUFFIX}"));

    let (from, to) = if enabled { (&off, &on) } else { (&on, &off) };
    if !to.exists() {
        if !from.is_file() {
            return Err(AppError::NotFound(format!("library item {id}")));
        }
        fs::rename(from, to).map_err(|e| AppError::io_path("cannot rename", from, e))?;
        log::info!(
            "{} {id} in client {client_id}",
            if enabled { "enabled" } else { "disabled" }
        );
    }

    read_library(data, client_id)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::NotFound(format!("library item {id}")))
}

/// Deletes the file and its metadata.
fn remove_item(data: &DataPaths, client_id: &str, id: &str) -> Result<()> {
    let dir = client_dir(data, client_id)?;
    let (folder, file_name) = parse_item_id(id)?;
    let folder_path = dir.join("home").join(&folder);
    let candidates = [
        folder_path.join(&file_name),
        folder_path.join(format!("{file_name}{DISABLED_SUFFIX}")),
    ];

    let mut removed = false;
    for path in &candidates {
        if path.is_file() {
            fs::remove_file(path).map_err(|e| AppError::io_path("cannot delete", path, e))?;
            removed = true;
        }
    }
    if !removed {
        return Err(AppError::NotFound(format!("library item {id}")));
    }

    let mut sidecar = read_sidecar(&dir);
    sidecar.items.remove(id);
    write_sidecar(&dir, &sidecar)?;
    log::info!("removed {id} from client {client_id}");
    Ok(())
}

/// Sets the display name, leaving the file alone.
fn rename_item(
    data: &DataPaths,
    client_id: &str,
    id: &str,
    display_name: &str,
) -> Result<LibraryItem> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err(AppError::InvalidInput("the name is empty".into()));
    }
    if display_name.chars().count() > MAX_DISPLAY_NAME {
        return Err(AppError::InvalidInput(format!(
            "the name is longer than {MAX_DISPLAY_NAME} characters"
        )));
    }

    let dir = client_dir(data, client_id)?;
    parse_item_id(id)?;
    // The scan fills the sidecar in, so the entry is there for any real item.
    read_library(data, client_id)?;
    let mut sidecar = read_sidecar(&dir);
    let Some(meta) = sidecar.items.get_mut(id) else {
        return Err(AppError::NotFound(format!("library item {id}")));
    };
    meta.display_name = display_name.to_string();
    write_sidecar(&dir, &sidecar)?;

    read_library(data, client_id)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::NotFound(format!("library item {id}")))
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/// Last conflict report per client, keyed by what the folder looked like.
///
/// Opening every archive of a full library costs hundreds of milliseconds, and
/// the screen asks again on every refetch. The signature covers names, sizes
/// and modification times, so any change on disk misses the cache by itself.
static CONFLICT_CACHE: LazyLock<Mutex<HashMap<String, (String, ConflictReport)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Finds internal paths that more than one enabled archive of a folder holds.
fn conflicts(data: &DataPaths, client_id: &str) -> Result<ConflictReport> {
    let dir = client_dir(data, client_id)?;
    let mut files = scan(&dir.join("home"));
    files.retain(|file| file.enabled);
    files.sort_by(|a, b| {
        a.folder
            .cmp(&b.folder)
            .then_with(|| pak_order(&a.file_name).cmp(&pak_order(&b.file_name)))
    });

    let signature = files
        .iter()
        .map(|file| format!("{}|{}|{}|{}", file.folder, file.file_name, file.size, file.modified))
        .collect::<Vec<_>>()
        .join("\n");
    if let Ok(cache) = CONFLICT_CACHE.lock() {
        if let Some((cached_signature, report)) = cache.get(client_id) {
            if cached_signature == &signature {
                return Ok(report.clone());
            }
        }
    }

    // Path to the indices of the files that carry it, already in load order.
    let mut owners: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, file) in files.iter().enumerate() {
        let Ok(archive) = File::open(&file.path).map(BufReader::new).and_then(|reader| {
            ZipArchive::new(reader).map_err(std::io::Error::other)
        }) else {
            log::warn!("cannot read {} while looking for conflicts", file.path.display());
            continue;
        };
        for entry in archive.file_names() {
            if entry.ends_with('/') || entry.ends_with('\\') {
                continue;
            }
            let key = format!("{}\u{1}{}", file.folder, entry.replace('\\', "/").to_ascii_lowercase());
            owners.entry(key).or_default().push(index);
        }
    }

    let mut clashing: Vec<(String, Vec<usize>)> = owners
        .into_iter()
        .filter(|(_, indices)| indices.len() > 1)
        .collect();
    clashing.sort_by(|a, b| a.0.cmp(&b.0));

    let total = clashing.len();
    let truncated = total > MAX_CONFLICT_PATHS;
    let mut involved = BTreeSet::new();
    let conflicts: Vec<LibraryConflict> = clashing
        .into_iter()
        .take(MAX_CONFLICT_PATHS)
        .map(|(key, indices)| {
            let (folder, path) = key.split_once('\u{1}').unwrap_or(("", key.as_str()));
            let ids: Vec<String> = indices.iter().map(|&index| files[index].id()).collect();
            for id in &ids {
                involved.insert(id.clone());
            }
            // `files` is sorted in load order, so the last owner wins.
            let winner = ids.last().cloned().unwrap_or_default();
            LibraryConflict {
                path: path.to_string(),
                folder: folder.to_string(),
                files: ids,
                winner,
            }
        })
        .collect();

    let report = ConflictReport {
        conflicts,
        total,
        truncated,
        files: involved.into_iter().collect(),
    };
    if let Ok(mut cache) = CONFLICT_CACHE.lock() {
        cache.insert(client_id.to_string(), (signature, report.clone()));
    }
    Ok(report)
}

/// Sort key of `paksort` in `codemp/qcommon/files.cpp:3025`: a `dl_` archive
/// always loads after the rest, the others compare case-insensitively.
///
/// Shared with `levelshots.rs`, which reads the same archives in the same
/// order to decide which map picture the player actually sees.
pub(crate) fn pak_order(file_name: &str) -> (u8, String) {
    let lower = file_name.to_ascii_lowercase();
    let downloaded = u8::from(lower.starts_with("dl_"));
    (downloaded, lower)
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/// Folder of a client, refusing an id that is not a plain folder name.
fn client_dir(data: &DataPaths, client_id: &str) -> Result<PathBuf> {
    safe_segment(client_id, "client id")?;
    let dir = data.client_dir(client_id);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("client {client_id}")));
    }
    Ok(dir)
}

/// Rejects anything that is not a single, harmless path segment.
///
/// Ids and folder names arrive from the frontend, so this is what keeps a
/// crafted `..\..` from reaching a file outside the client's home folder.
fn safe_segment(value: &str, what: &str) -> Result<()> {
    let bad = value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', ':'])
        || value.chars().any(char::is_control);
    if bad {
        return Err(AppError::InvalidInput(format!(
            "{what} {value:?} is not a plain name"
        )));
    }
    Ok(())
}

/// Trims the folder argument and falls back to `base`.
fn normalise_folder(folder: Option<&str>) -> Result<String> {
    let folder = folder.map(str::trim).filter(|value| !value.is_empty());
    let folder = folder.unwrap_or(DEFAULT_FOLDER);
    safe_segment(folder, "folder")?;
    Ok(folder.to_string())
}

/// Reads `library.json`, treating an unreadable one as empty.
///
/// Every field of the sidecar is derivable from the archive, so a corrupt
/// document costs the display names and nothing else. Refusing to list the
/// library over it would be the worse trade.
fn read_sidecar(client_dir: &Path) -> Sidecar {
    let file = client_dir.join(SIDECAR);
    let Ok(text) = fs::read_to_string(&file) else {
        return Sidecar::default();
    };
    match serde_json::from_str(&text) {
        Ok(sidecar) => sidecar,
        Err(e) => {
            log::warn!("cannot parse {}: {e}, rebuilding it", file.display());
            Sidecar::default()
        }
    }
}

fn write_sidecar(client_dir: &Path, sidecar: &Sidecar) -> Result<()> {
    let file = client_dir.join(SIDECAR);
    let text = serde_json::to_string_pretty(sidecar)
        .map_err(|e| AppError::json("cannot serialize the library sidecar", e))?;
    fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
}

// --- slice: jkhub ---

/// Reads `home\.jknet\provenance.json`, treating an unreadable one as empty.
///
/// Provenance is a note, not a source of truth: the file on disk is. A
/// document the launcher cannot parse costs the JKHub badge on a card and
/// nothing else, so it is logged and skipped rather than propagated.
pub(crate) fn read_provenance(
    client_dir: &Path,
) -> BTreeMap<String, crate::jkhub::types::Provenance> {
    let file = client_dir.join("home").join(NOTES_FOLDER).join(PROVENANCE);
    let Ok(text) = fs::read_to_string(&file) else {
        return BTreeMap::new();
    };
    match serde_json::from_str(&text) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("cannot parse {}: {e}, ignoring it", file.display());
            BTreeMap::new()
        }
    }
}

/// Writes the provenance document, creating `home\.jknet\` if needed.
pub(crate) fn write_provenance(
    client_dir: &Path,
    entries: &BTreeMap<String, crate::jkhub::types::Provenance>,
) -> Result<()> {
    let dir = client_dir.join("home").join(NOTES_FOLDER);
    paths::create_dir(&dir)?;
    let file = dir.join(PROVENANCE);
    let text = serde_json::to_string_pretty(entries)
        .map_err(|e| AppError::json("cannot serialize the provenance sidecar", e))?;
    fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
}

/// Tells an open Library screen that the client's files changed.
pub(crate) fn notify(app: &tauri::AppHandle, client_id: &str) {
    let payload = LibraryChanged {
        client_id: client_id.to_string(),
    };
    if let Err(e) = app.emit(EVENT_CHANGED, payload) {
        log::warn!("cannot emit {EVENT_CHANGED}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;

    /// Writes a pk3 with the given internal paths and one byte of content
    /// each, which is all the classifier and the conflict finder look at.
    fn write_pk3(path: &Path, entries: &[&str]) {
        let file = File::create(path).expect("test archive");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for entry in entries {
            writer.start_file(*entry, options).expect("start entry");
            writer.write_all(entry.as_bytes()).expect("write entry");
        }
        writer.finish().expect("finish archive");
    }

    /// A data root of its own for one test, removed when the guard drops.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(name: &str) -> TempRoot {
            let root = std::env::temp_dir()
                .join("jknet-library-tests")
                .join(format!("{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("temp root");
            TempRoot(root)
        }

        /// Builds a data root with one client folder in it.
        fn client(&self, id: &str) -> (DataPaths, PathBuf) {
            let data = DataPaths::new(self.0.clone());
            let home = data.client_dir(id).join("home").join("base");
            fs::create_dir_all(&home).expect("client home");
            (data, home)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn classifier_reads_the_folders_of_an_archive() {
        assert_eq!(
            classify(&["models/players/kyle/model.glm".into()]),
            LibraryCategory::Skin
        );
        assert_eq!(
            classify(&["ext_data/sabers/reborn.sab".into()]),
            LibraryCategory::Hilt
        );
        assert_eq!(
            classify(&["models/weapons2/saber_kyle/saber_w.md3".into()]),
            LibraryCategory::Hilt
        );
        assert_eq!(classify(&["maps/mp/ffa3.bsp".into()]), LibraryCategory::Map);
        assert_eq!(
            classify(&["cgamex86.dll".into(), "models/players/kyle/model.glm".into()]),
            LibraryCategory::Mod,
            "a module binary outranks the assets shipped with it"
        );
        assert_eq!(classify(&["vm/jampgame.qvm".into()]), LibraryCategory::Mod);
        assert_eq!(classify(&["gfx/hud/health.jpg".into()]), LibraryCategory::Hud);
        assert_eq!(classify(&["ui/jamp/ingame.menu".into()]), LibraryCategory::Hud);
        assert_eq!(
            classify(&["sound/chars/kyle/misc/hi.mp3".into(), "music/mp/duel.mp3".into()]),
            LibraryCategory::Sound
        );
        assert_eq!(
            classify(&["readme.txt".into(), "sound/one.wav".into()]),
            LibraryCategory::Other,
            "half the entries is under the share a sound pack needs"
        );
        assert_eq!(classify(&[]), LibraryCategory::Other);
    }

    #[test]
    fn inspection_reports_entries_and_a_hash() {
        let root = TempRoot::new("inspect");
        let path = root.0.join("skin.pk3");
        write_pk3(&path, &["models/players/jaden/model.glm", "readme.txt"]);

        let report = inspect(&path).expect("inspect");
        assert_eq!(report.category, LibraryCategory::Skin);
        assert_eq!(report.entry_count, 2);
        assert_eq!(report.top_level, vec!["models", "readme.txt"]);
        assert_eq!(report.sha1.len(), 40);
        assert!(report.sha1.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn a_file_that_is_not_a_zip_is_refused() {
        let root = TempRoot::new("broken");
        let path = root.0.join("broken.pk3");
        fs::write(&path, b"not a zip at all").expect("write");
        let error = inspect(&path).expect_err("must refuse");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
    }

    #[test]
    fn disabled_files_keep_their_identity() {
        assert_eq!(split_state("skin.pk3"), Some(("skin.pk3".into(), true)));
        assert_eq!(split_state("Skin.PK3"), Some(("Skin.PK3".into(), true)));
        assert_eq!(
            split_state("skin.pk3.disabled"),
            Some(("skin.pk3".into(), false))
        );
        assert_eq!(split_state("jampconfig.cfg"), None);
        assert_eq!(split_state("notes.txt.disabled"), None);
    }

    #[test]
    fn an_item_id_cannot_leave_the_home_folder() {
        assert_eq!(
            parse_item_id("base/skin.pk3").unwrap(),
            ("base".to_string(), "skin.pk3".to_string())
        );
        assert!(parse_item_id("skin.pk3").is_err());
        assert!(parse_item_id("../../windows/skin.pk3").is_err());
        assert!(parse_item_id("base/..").is_err());
        assert!(parse_item_id("base/notes.txt").is_err());
    }

    #[test]
    fn toggling_renames_the_file_in_place() {
        let root = TempRoot::new("toggle");
        let (data, home) = root.client("everyday");
        write_pk3(&home.join("skin.pk3"), &["models/players/jaden/model.glm"]);

        let item = set_enabled(&data, "everyday", "base/skin.pk3", false).expect("disable");
        assert!(!item.enabled);
        assert!(home.join("skin.pk3.disabled").is_file());
        assert!(!home.join("skin.pk3").exists());
        assert_eq!(item.category, LibraryCategory::Skin);

        let item = set_enabled(&data, "everyday", "base/skin.pk3", true).expect("enable");
        assert!(item.enabled);
        assert!(home.join("skin.pk3").is_file());
        assert!(!home.join("skin.pk3.disabled").exists());
    }

    #[test]
    fn the_same_archive_is_not_installed_twice() {
        let root = TempRoot::new("duplicate");
        let (data, home) = root.client("everyday");
        let source = root.0.join("hilt.pk3");
        write_pk3(&source, &["ext_data/sabers/reborn.sab"]);

        let first = add_files(&data, "everyday", &[source.display().to_string()], None)
            .expect("first add");
        assert_eq!(first.added.len(), 1);
        assert_eq!(first.added[0].id, "base/hilt.pk3");
        assert_eq!(first.added[0].category, LibraryCategory::Hilt);
        assert!(home.join("hilt.pk3").is_file());

        // The same bytes under another name are still the same archive.
        let renamed = root.0.join("hilt-copy.pk3");
        fs::copy(&source, &renamed).expect("copy");
        let second = add_files(&data, "everyday", &[renamed.display().to_string()], None)
            .expect("second add");
        assert!(second.added.is_empty());
        assert_eq!(second.skipped.len(), 1);
        assert_eq!(second.skipped[0].existing_id.as_deref(), Some("base/hilt.pk3"));
    }

    #[test]
    fn a_name_collision_suggests_a_free_name() {
        let root = TempRoot::new("collision");
        let (data, _home) = root.client("everyday");
        let first = root.0.join("a").join("map.pk3");
        let second = root.0.join("b").join("map.pk3");
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        write_pk3(&first, &["maps/mp/ffa3.bsp"]);
        write_pk3(&second, &["maps/mp/ffa5.bsp"]);

        add_files(&data, "everyday", &[first.display().to_string()], None).expect("first");
        let result =
            add_files(&data, "everyday", &[second.display().to_string()], None).expect("second");
        assert!(result.added.is_empty());
        assert_eq!(result.skipped[0].suggested_name.as_deref(), Some("map_2.pk3"));
    }

    #[test]
    fn only_pk3_files_are_accepted() {
        let root = TempRoot::new("extension");
        let (data, _home) = root.client("everyday");
        let source = root.0.join("readme.txt");
        fs::write(&source, b"hello").expect("write");
        let result = add_files(&data, "everyday", &[source.display().to_string()], None)
            .expect("add");
        assert!(result.added.is_empty());
        assert_eq!(result.skipped.len(), 1);
        assert!(result.skipped[0].reason.contains(".pk3"));
    }

    #[test]
    fn the_last_archive_of_a_folder_wins_a_conflict() {
        let root = TempRoot::new("conflicts");
        let (data, home) = root.client("everyday");
        let shared = "models/players/jaden_male/model.glm";
        write_pk3(&home.join("a-skins.pk3"), &[shared, "models/players/a/only.md3"]);
        write_pk3(&home.join("z-skins.pk3"), &[shared]);
        write_pk3(&home.join("m-skins.pk3"), &[shared]);

        let report = conflicts(&data, "everyday").expect("conflicts");
        assert_eq!(report.total, 1);
        assert!(!report.truncated);
        let conflict = &report.conflicts[0];
        assert_eq!(conflict.path, shared);
        assert_eq!(conflict.files.len(), 3);
        assert_eq!(conflict.winner, "base/z-skins.pk3");
        assert_eq!(report.files.len(), 3);
    }

    #[test]
    fn a_downloaded_archive_wins_over_a_later_name() {
        // `paksort` puts `dl_` last whatever the rest of the name says.
        assert!(pak_order("dl_extra.pk3") > pak_order("zzz.pk3"));
        assert!(pak_order("assets0.pk3") < pak_order("assets1.pk3"));
        assert_eq!(pak_order("Skin.PK3").1, "skin.pk3");
    }

    #[test]
    fn a_disabled_archive_takes_part_in_no_conflict() {
        let root = TempRoot::new("conflicts-disabled");
        let (data, home) = root.client("everyday");
        let shared = "models/players/jaden_male/model.glm";
        write_pk3(&home.join("a-skins.pk3"), &[shared]);
        write_pk3(&home.join("z-skins.pk3.disabled"), &[shared]);

        let report = conflicts(&data, "everyday").expect("conflicts");
        assert_eq!(report.total, 0);
        assert!(report.conflicts.is_empty());
    }

    #[test]
    fn the_scan_fills_the_sidecar_and_prunes_it() {
        let root = TempRoot::new("sidecar");
        let (data, home) = root.client("everyday");
        write_pk3(&home.join("map.pk3"), &["maps/mp/ffa3.bsp"]);

        let items = read_library(&data, "everyday").expect("list");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].display_name, "map");
        assert_eq!(items[0].category, LibraryCategory::Map);
        assert!(items[0].sha1.is_some());

        let renamed = rename_item(&data, "everyday", "base/map.pk3", "  FFA pack  ")
            .expect("rename");
        assert_eq!(renamed.display_name, "FFA pack");
        assert!(home.join("map.pk3").is_file(), "the file keeps its name");

        remove_item(&data, "everyday", "base/map.pk3").expect("remove");
        assert!(read_library(&data, "everyday").expect("list").is_empty());
        let sidecar = read_sidecar(&data.client_dir("everyday"));
        assert!(sidecar.items.is_empty());
    }

    #[test]
    fn a_file_present_under_both_names_counts_once() {
        let root = TempRoot::new("both-names");
        let (data, home) = root.client("everyday");
        write_pk3(&home.join("skin.pk3"), &["models/players/jaden/model.glm"]);
        write_pk3(&home.join("skin.pk3.disabled"), &["models/players/jaden/model.glm"]);

        let items = read_library(&data, "everyday").expect("list");
        assert_eq!(items.len(), 1);
        assert!(items[0].enabled, "the engine loads the enabled spelling");
    }

    #[test]
    fn an_unknown_client_is_a_not_found() {
        let root = TempRoot::new("missing");
        let data = DataPaths::new(root.0.clone());
        let error = read_library(&data, "nobody").expect_err("must refuse");
        assert!(matches!(error, AppError::NotFound(_)), "{error}");
    }

    /// Manual check against a real archive. Run with
    /// `cargo test -- --ignored assets` on a machine with the game installed.
    #[test]
    #[ignore = "needs the game installed"]
    fn inspects_a_real_asset_archive() {
        let path = Path::new(
            "D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData\\base\\assets1.pk3",
        );
        if !path.is_file() {
            eprintln!("skipped: {} is not there", path.display());
            return;
        }
        let report = inspect(path).expect("inspect assets1.pk3");
        eprintln!(
            "assets1.pk3: category {:?}, {} entries, {} bytes, sha1 {}",
            report.category, report.entry_count, report.size, report.sha1
        );
        eprintln!("top level: {:?}", report.top_level);
        assert!(report.entry_count > 0);
    }
}
