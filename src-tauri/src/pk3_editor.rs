//! --- slice: pk3 editor ---
//! One open pk3 archive, edited entry by entry and written back whole.
//!
//! A session is opened on the archive of a file of a bundle draft or of a
//! file of the library of a client, and lives here until it is closed. Every
//! edit answers with the whole session, so the dialog never merges two
//! answers: it drops the last one into its cache.
//!
//! Nothing touches the archive until **Save**. An added or replaced entry is
//! kept as a file under `cache\pk3-editor\<sessionId>\`, at the path the entry
//! has inside the archive; a removal, a rename and the state of every entry
//! live in memory. **Save** writes a new archive into a temporary file beside
//! the old one — unchanged entries copied with `raw_copy_file`, so nothing is
//! decompressed and recompressed, edited ones deflated — and renames it over
//! the old one. A failure anywhere leaves the old archive exactly as it was.
//!
//! After the write the owner of the archive is brought up to date: a file of
//! a draft gets its new size, hash, kind, library card and listing, and a file
//! that came from JKHub gets the `modified: true` origin that makes a publish
//! upload it instead of pointing at the record; a file of the library gets its
//! sidecar and hash re-read, and the two events an install sends.
//!
//! The taxonomy, the picture headers and the code pages are
//! [`crate::file_preview_contents`]'s: the editor reads an entry exactly the
//! way the preview reads it, so a picture that shows 256×256 there shows
//! 256×256 here. The path rules are [`crate::bundles::manifest::check_path`]'s,
//! for the same reason a manifest has them: a path that leaves its folder must
//! not reach the disk.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::bundles::draft::{self, DraftOrigin};
use crate::bundles::listing;
use crate::bundles::manifest::{self, FileKind, FileRoot};
use crate::bundles::{draft_key, sha256_of, BundlesState};
use crate::error::{AppError, Result};
use crate::file_preview_contents::{
    check_picture_request, code_page_of_language, decode_picture, decode_text, encoding_of,
    extension_of, image_size, is_picture_extension, is_text, picture_format, picture_from_bytes,
    read_prefix, strings_language, PreviewImageData, PreviewTextData, MAX_IMAGE_BYTES,
    MAX_TEXT_BYTES,
};
use crate::paths::{self, DataPaths};
use crate::state::AppState;
use crate::{archive, clients, engine_install, library, user_files};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// Entries one session holds at most: the limit of the walk every other
/// reader of a pk3 applies, so an archive that declares more is edited by
/// its first [`archive::MAX_ENTRIES`] entries or not at all.
const MAX_ENTRIES: usize = archive::MAX_ENTRIES;

/// Bytes of a file added from the disk or put over an entry: the limit a
/// file of a bundle has, which is also the biggest archive a draft carries.
const MAX_SOURCE_BYTES: u64 = manifest::MAX_FILE_BYTES;

/// Files one call of `pk3_editor_add_files` takes.
const MAX_ADDED_FILES: usize = 500;

/// Bytes of the head of an entry read to fill in its picture size or its
/// code page: the same prefix the preview reads a header from.
const HEADER_BYTES: u64 = crate::file_preview_contents::IMAGE_HEADER_BYTES;

/// Bytes read across one archive while the session is being opened, headers
/// of every entry together. Past it an entry is listed without its size or
/// its code page, which is what an archive of fifty thousand textures costs
/// otherwise.
const HEADER_BUDGET_BYTES: u64 = 32 * 1024 * 1024;

/// Quality of a JPEG the editor writes when a picture is converted into the
/// format of the entry it replaces.
const JPEG_QUALITY: u8 = 90;

// ---------------------------------------------------------------------------
// The wire types
// ---------------------------------------------------------------------------

/// Where the archive of a session comes from.
///
/// A file of the cache of JKHub and a file of the catalogue of bundles are
/// not here on purpose: those are read through the preview, never edited,
/// because the launcher does not own them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Pk3EditorTarget {
    #[serde(rename_all = "camelCase")]
    Draft {
        draft_id: String,
        scope: String,
        root: FileRoot,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    Library { client_id: String, item_id: String },
}

/// What an entry is, read off its path alone: what the tree draws an icon
/// for and what the panel opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pk3EntryKind {
    Image,
    Text,
    Model,
    Sound,
    Map,
    Other,
}

/// What the session has done to an entry since the archive was opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pk3EntryState {
    Unchanged,
    Modified,
    Added,
    Renamed,
    Removed,
}

/// The header of a picture, when it could be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pk3EntryImage {
    pub width: u32,
    pub height: u32,
    /// `jpg`, `png` or `tga`.
    pub format: String,
}

/// The code page a text entry is read and written in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pk3EntryText {
    pub encoding: String,
}

/// One entry of the archive as the session sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pk3EditorEntry {
    pub path: String,
    pub size: u64,
    pub kind: Pk3EntryKind,
    pub state: Pk3EntryState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<Pk3EntryImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<Pk3EntryText>,
    /// The path the entry had when the archive was opened, on a rename.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
}

/// One open archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pk3EditorSession {
    pub id: String,
    pub target: Pk3EditorTarget,
    /// Where the archive lies on this machine.
    pub archive_path: String,
    /// An edit is waiting for **Save**.
    pub dirty: bool,
    pub entries: Vec<Pk3EditorEntry>,
    /// Bytes of the archive on disk.
    pub bytes: u64,
    /// The archive can be read but not written here.
    pub read_only: bool,
}

/// The archive as **Save** wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pk3EditorSaved {
    pub sha256: String,
    pub size: u64,
    /// Entries the written archive holds.
    pub entries: usize,
}

/// How many files `pk3_editor_extract` wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pk3ExtractResult {
    pub files: usize,
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/// Where an entry came from in the archive the session opened.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Source {
    /// Index in the central directory, which is what a raw copy needs.
    index: usize,
    /// The path the entry had then, forward slashes.
    path: String,
}

/// One entry of an open session.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    /// The path the entry has now.
    path: String,
    /// `None` for an entry added in this session.
    source: Option<Source>,
    /// The file under the session folder that holds the new bytes.
    staged: Option<PathBuf>,
    size: u64,
    removed: bool,
    image: Option<Pk3EntryImage>,
    text: Option<Pk3EntryText>,
}

impl Record {
    fn state(&self) -> Pk3EntryState {
        match &self.source {
            _ if self.removed => Pk3EntryState::Removed,
            None => Pk3EntryState::Added,
            Some(source) if source.path != self.path => Pk3EntryState::Renamed,
            Some(_) if self.staged.is_some() => Pk3EntryState::Modified,
            Some(_) => Pk3EntryState::Unchanged,
        }
    }

    fn renamed_from(&self) -> Option<String> {
        self.source
            .as_ref()
            .filter(|source| source.path != self.path)
            .map(|source| source.path.clone())
    }

    fn view(&self) -> Pk3EditorEntry {
        Pk3EditorEntry {
            path: self.path.clone(),
            size: self.size,
            kind: entry_kind(&self.path),
            state: self.state(),
            image: self.image.clone(),
            text: self.text.clone(),
            renamed_from: self.renamed_from(),
        }
    }
}

/// One archive open in the editor.
#[derive(Debug)]
struct Session {
    id: String,
    target: Pk3EditorTarget,
    archive_path: PathBuf,
    /// `cache\pk3-editor\<id>\`: where the bytes of an edit wait for **Save**.
    work_dir: PathBuf,
    read_only: bool,
    bytes: u64,
    entries: Vec<Record>,
}

impl Session {
    fn dirty(&self) -> bool {
        self.entries
            .iter()
            .any(|record| record.state() != Pk3EntryState::Unchanged)
    }

    fn view(&self) -> Pk3EditorSession {
        Pk3EditorSession {
            id: self.id.clone(),
            target: self.target.clone(),
            archive_path: self.archive_path.display().to_string(),
            dirty: self.dirty(),
            entries: self.entries.iter().map(Record::view).collect(),
            bytes: self.bytes,
            read_only: self.read_only,
        }
    }

    /// The record at a path, whether it is marked for removal or not.
    fn find(&self, path: &str) -> Option<usize> {
        self.entries
            .iter()
            .position(|record| record.path == path)
            .or_else(|| {
                self.entries
                    .iter()
                    .position(|record| record.path.eq_ignore_ascii_case(path))
            })
    }

    /// The record at a path that is still part of the archive.
    fn find_live(&self, path: &str) -> Result<usize> {
        self.find(path)
            .filter(|at| !self.entries[*at].removed)
            .ok_or_else(|| AppError::NotFound(format!("{path} in the archive")))
    }

    /// Refuses an edit of an archive that is only open for reading.
    fn writable(&self) -> Result<()> {
        if self.read_only {
            return Err(AppError::InvalidInput(format!(
                "{} is open for reading only",
                self.archive_path.display()
            )));
        }
        Ok(())
    }

    /// Refuses a path another live entry already holds. The engine reads a
    /// pk3 path without case, so two entries that differ only in case are
    /// one entry to the game and a collision here.
    fn free(&self, path: &str, except: usize) -> Result<()> {
        let taken = self.entries.iter().enumerate().any(|(at, record)| {
            at != except && !record.removed && record.path.eq_ignore_ascii_case(path)
        });
        if taken {
            return Err(AppError::AlreadyExists(format!("{path} in the archive")));
        }
        Ok(())
    }
}

/// Every archive open in this launcher, by session id.
type Sessions = Mutex<HashMap<String, Session>>;

/// The open archives of the editor, managed by Tauri next to
/// [`crate::state::AppState`].
///
/// One lock over every session: an edit reads and writes files while it holds
/// it, and that is on purpose. The dialog is modal, one archive is open at a
/// time, and a lock taken for the whole of an edit is what makes a rename of
/// a folder and a save of the archive indivisible without a second lock per
/// session.
#[derive(Default)]
pub struct Pk3EditorState {
    sessions: Arc<Sessions>,
}

impl Pk3EditorState {
    fn sessions(&self) -> Arc<Sessions> {
        Arc::clone(&self.sessions)
    }
}

fn lock(sessions: &Sessions) -> Result<std::sync::MutexGuard<'_, HashMap<String, Session>>> {
    sessions
        .lock()
        .map_err(|_| AppError::State("the pk3 editor lock is poisoned".into()))
}

/// Runs `work` on one open session and answers with the session as it is
/// afterwards.
fn edit(
    sessions: &Sessions,
    session_id: &str,
    work: impl FnOnce(&mut Session) -> Result<()>,
) -> Result<Pk3EditorSession> {
    user_files::valid_id(session_id)
        .map_err(|_| AppError::InvalidInput(format!("{session_id:?} is not a session id")))?;
    let mut open = lock(sessions)?;
    let session = open
        .get_mut(session_id)
        .ok_or_else(|| AppError::NotFound("pk3 editor session; open the archive again".into()))?;
    session.writable()?;
    work(session)?;
    Ok(session.view())
}

/// Reads one open session without changing it.
fn read<T>(
    sessions: &Sessions,
    session_id: &str,
    work: impl FnOnce(&Session) -> Result<T>,
) -> Result<T> {
    user_files::valid_id(session_id)
        .map_err(|_| AppError::InvalidInput(format!("{session_id:?} is not a session id")))?;
    let open = lock(sessions)?;
    let session = open
        .get(session_id)
        .ok_or_else(|| AppError::NotFound("pk3 editor session; open the archive again".into()))?;
    work(session)
}

// ---------------------------------------------------------------------------
// Paths and kinds
// ---------------------------------------------------------------------------

/// The kind the tree draws for a path.
///
/// Pictures first, because a `.tga` is never text; then the taxonomy of the
/// preview, so an entry the panel opens in the editor is exactly an entry
/// [`is_text`] calls text. `.fontdat` is not among them: it is the binary
/// glyph table of the renderer, and a text editor over it writes a file no
/// renderer will load.
fn entry_kind(path: &str) -> Pk3EntryKind {
    let lower = path.to_ascii_lowercase();
    let extension = extension_of(&lower);
    if is_picture_extension(extension) {
        return Pk3EntryKind::Image;
    }
    match extension {
        "bsp" => Pk3EntryKind::Map,
        "wav" | "mp3" | "ogg" | "flac" | "m4a" => Pk3EntryKind::Sound,
        "glm" | "gla" | "md3" | "mdx" | "ase" | "obj" => Pk3EntryKind::Model,
        _ if is_text(&lower) => Pk3EntryKind::Text,
        _ => Pk3EntryKind::Other,
    }
}

/// The code page a text entry is written in: the language folder decides for
/// a StringEd file, everything else is UTF-8.
fn write_encoding(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    match extension_of(&lower) {
        "str" | "sp" => code_page_of_language(&strings_language(&lower)),
        _ => "utf-8",
    }
}

/// The bytes of a text in the code page of its entry.
///
/// `encoding_rs` writes a character no single-byte page has as a numeric
/// reference rather than refusing, which is what the game's own tools do to
/// a `.str` file typed in the wrong language.
fn encode_text(text: &str, encoding: &str) -> Vec<u8> {
    let page = match encoding {
        "windows-1251" => encoding_rs::WINDOWS_1251,
        "windows-1250" => encoding_rs::WINDOWS_1250,
        "windows-1252" => encoding_rs::WINDOWS_1252,
        _ => encoding_rs::UTF_8,
    };
    page.encode(text).0.into_owned()
}

/// A path the archive and the session folder can both hold.
fn check_entry_path(path: &str) -> Result<&str> {
    manifest::check_path(path)?;
    Ok(path)
}

/// A folder argument: the root as an empty string, any other folder without
/// its trailing slash.
fn check_folder(folder: &str) -> Result<String> {
    let folder = folder.trim().trim_matches('/').to_string();
    if !folder.is_empty() {
        check_entry_path(&folder)?;
    }
    Ok(folder)
}

fn join_path(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

/// Whether a path lies in a folder or is that folder itself.
fn is_under(path: &str, folder: &str) -> bool {
    folder.is_empty()
        || path.eq_ignore_ascii_case(folder)
        || path.len() > folder.len()
            && path[..folder.len()].eq_ignore_ascii_case(folder)
            && path.as_bytes()[folder.len()] == b'/'
}

/// The name a card shows for a pk3: its file name without the extension.
fn display_name_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name).to_string()
}

// ---------------------------------------------------------------------------
// Reading the archive
// ---------------------------------------------------------------------------

/// Opens the archive of a session for reading.
fn open_archive(path: &Path) -> Result<ZipArchive<BufReader<File>>> {
    let file = File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    ZipArchive::new(BufReader::new(file))
        .map_err(|e| AppError::Archive(format!("{} is not a readable pk3: {e}", path.display())))
}

/// The header of a picture or the code page of a text file, from the first
/// bytes of an entry.
fn probe(path: &str, bytes: &[u8]) -> (Option<Pk3EntryImage>, Option<Pk3EntryText>) {
    match entry_kind(path) {
        Pk3EntryKind::Image => {
            let image = picture_format(path, bytes).map(|format| {
                let (width, height) = image_size(format, bytes);
                Pk3EntryImage {
                    width,
                    height,
                    format: format.to_string(),
                }
            });
            (image, None)
        }
        Pk3EntryKind::Text => (
            None,
            Some(Pk3EntryText {
                encoding: encoding_of(path, bytes).to_string(),
            }),
        ),
        _ => (None, None),
    }
}

/// Every file entry of the archive, in the order of the central directory,
/// with the headers of as many of them as the budget pays for.
///
/// Two entries whose paths differ only in their separators are one entry to
/// the engine, so the second is left out with a line in the log: the session
/// would otherwise hold two rows nothing can tell apart.
fn read_records(path: &Path) -> Result<Vec<Record>> {
    let mut zip = open_archive(path)?;
    let found: Vec<(usize, String)> = archive::walk(&zip, MAX_ENTRIES).collect();
    if found.len() == MAX_ENTRIES && zip.len() > MAX_ENTRIES {
        log::warn!(
            "pk3 editor: {} declares {} entries, the session keeps the first {MAX_ENTRIES}",
            path.display(),
            zip.len()
        );
    }
    let mut records: Vec<Record> = Vec::with_capacity(found.len());
    let mut seen: HashMap<String, ()> = HashMap::with_capacity(found.len());
    for (index, entry_path) in found {
        if seen.insert(entry_path.to_ascii_lowercase(), ()).is_some() {
            log::warn!(
                "pk3 editor: {} carries {entry_path} twice, the session keeps the first",
                path.display()
            );
            continue;
        }
        let size = zip.by_index_raw(index)?.size();
        records.push(Record {
            path: entry_path.clone(),
            source: Some(Source {
                index,
                path: entry_path,
            }),
            staged: None,
            size,
            removed: false,
            image: None,
            text: None,
        });
    }

    let mut budget = HEADER_BUDGET_BYTES;
    for record in &mut records {
        if budget == 0 {
            break;
        }
        if !matches!(entry_kind(&record.path), Pk3EntryKind::Image | Pk3EntryKind::Text) {
            continue;
        }
        let index = record.source.as_ref().map(|source| source.index).unwrap_or(0);
        let want = HEADER_BYTES.min(budget);
        match read_prefix(&mut zip, index, want) {
            Ok((bytes, _)) => {
                budget = budget.saturating_sub(bytes.len() as u64);
                let (image, text) = probe(&record.path, &bytes);
                record.image = image;
                record.text = text;
            }
            // A compression method this build cannot read is still an entry
            // of the archive; it only has no header to show.
            Err(e) => log::warn!("pk3 editor: cannot read the head of {}: {e}", record.path),
        }
    }
    Ok(records)
}

/// The bytes of an entry as they would be written, at most `limit` of them,
/// and whether more were left.
fn entry_bytes(session: &Session, at: usize, limit: u64) -> Result<(Vec<u8>, bool)> {
    let record = &session.entries[at];
    if let Some(staged) = &record.staged {
        let file = File::open(staged).map_err(|e| AppError::io_path("cannot read", staged, e))?;
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| AppError::io_path("cannot read", staged, e))?;
        let more = bytes.len() as u64 > limit;
        bytes.truncate(limit as usize);
        return Ok((bytes, more));
    }
    let index = record
        .source
        .as_ref()
        .ok_or_else(|| AppError::NotFound(format!("the bytes of {}", record.path)))?
        .index;
    let mut zip = open_archive(&session.archive_path)?;
    read_prefix(&mut zip, index, limit)
}

// ---------------------------------------------------------------------------
// Staging an edit
// ---------------------------------------------------------------------------

/// Where the bytes of an edited entry wait for **Save**: under the session
/// folder, at the path the entry has inside the archive.
fn staged_path(session: &Session, path: &str) -> Result<PathBuf> {
    check_entry_path(path)?;
    engine_install::safe_entry_path(&session.work_dir, path)
}

/// Puts bytes under the path of an entry and records them on it.
fn stage_bytes(session: &mut Session, at: usize, bytes: &[u8]) -> Result<()> {
    let target = staged_path(session, &session.entries[at].path.clone())?;
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    fs::write(&target, bytes).map_err(|e| AppError::io_path("cannot write", &target, e))?;
    let record = &mut session.entries[at];
    let (image, text) = probe(&record.path, &bytes[..bytes.len().min(HEADER_BYTES as usize)]);
    record.staged = Some(target);
    record.size = bytes.len() as u64;
    record.removed = false;
    record.image = image;
    record.text = text;
    Ok(())
}

/// Copies a file of the disk under the path of an entry and records it.
fn stage_file(session: &mut Session, at: usize, source: &Path) -> Result<()> {
    let meta = fs::metadata(source).map_err(|e| AppError::io_path("cannot read", source, e))?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!(
            "{} is not a file",
            source.display()
        )));
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{} is bigger than the {} MiB an entry of a pk3 may be",
            source.display(),
            MAX_SOURCE_BYTES / (1024 * 1024)
        )));
    }
    let target = staged_path(session, &session.entries[at].path.clone())?;
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    fs::copy(source, &target).map_err(|e| AppError::io_path("cannot copy into", &target, e))?;
    let head = read_head(&target, HEADER_BYTES)?;
    let record = &mut session.entries[at];
    let (image, text) = probe(&record.path, &head);
    record.staged = Some(target);
    record.size = meta.len();
    record.removed = false;
    record.image = image;
    record.text = text;
    Ok(())
}

/// The first bytes of a file on disk.
fn read_head(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|e| AppError::io_path("cannot read", path, e))?;
    let mut bytes = Vec::new();
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::io_path("cannot read", path, e))?;
    Ok(bytes)
}

/// Adds a record for a path the archive has not got, or revives the one it
/// has, and answers with its place in the list.
fn record_for(session: &mut Session, path: &str) -> Result<usize> {
    check_entry_path(path)?;
    if let Some(at) = session.find(path) {
        session.free(path, at)?;
        session.entries[at].removed = false;
        return Ok(at);
    }
    if session.entries.iter().filter(|record| !record.removed).count() >= MAX_ENTRIES {
        return Err(AppError::InvalidInput(format!(
            "a pk3 the editor writes holds at most {MAX_ENTRIES} entries"
        )));
    }
    session.entries.push(Record {
        path: path.to_string(),
        source: None,
        staged: None,
        size: 0,
        removed: false,
        image: None,
        text: None,
    });
    Ok(session.entries.len() - 1)
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/// The format an entry keeps, by its extension: a picture put over it is
/// converted to this one, so the path the game looks up never changes.
fn entry_picture_format(path: &str) -> Option<&'static str> {
    match extension_of(&path.to_ascii_lowercase()) {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "tga" => Some("tga"),
        _ => None,
    }
}

/// The bytes of a picture in the format of the entry it replaces.
fn convert_picture(bytes: &[u8], from: &str, to: &str) -> Result<Vec<u8>> {
    if from == to {
        return Ok(bytes.to_vec());
    }
    let decoded = decode_picture(bytes, from)?;
    // Eight bits a channel, the only depth the renderer loads, and alpha
    // only where the source had it.
    let picture = if decoded.color().has_alpha() {
        image::DynamicImage::ImageRgba8(decoded.to_rgba8())
    } else {
        image::DynamicImage::ImageRgb8(decoded.to_rgb8())
    };
    let mut out = Cursor::new(Vec::new());
    match to {
        "jpg" => {
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
            picture
                .to_rgb8()
                .write_with_encoder(encoder)
                .map_err(|e| AppError::Image(e.to_string()))?;
        }
        "png" => picture
            .write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| AppError::Image(e.to_string()))?,
        "tga" => picture
            .write_to(&mut out, image::ImageFormat::Tga)
            .map_err(|e| AppError::Image(e.to_string()))?,
        other => return Err(AppError::Image(format!("{other} is not a picture format"))),
    }
    Ok(out.into_inner())
}

/// Says in the log what a player is about to see in the game: a texture that
/// is not a power of two on both sides, or a picture of another size than the
/// one it replaces, changes how the engine samples it.
fn report_picture_size(path: &str, before: Option<&Pk3EntryImage>, after: &Pk3EntryImage) {
    if let Some(before) = before {
        if before.width > 0 && (before.width, before.height) != (after.width, after.height) {
            log::warn!(
                "pk3 editor: {path} was {}×{} and is now {}×{}",
                before.width,
                before.height,
                after.width,
                after.height
            );
        }
    }
    let power_of_two = |side: u32| side > 0 && side.is_power_of_two();
    if !power_of_two(after.width) || !power_of_two(after.height) {
        log::warn!(
            "pk3 editor: {path} is {}×{}, which is not a power of two on both sides",
            after.width,
            after.height
        );
    }
}

// ---------------------------------------------------------------------------
// Opening and closing a session
// ---------------------------------------------------------------------------

/// Where the archive of a target lies, and whether it may be written.
fn resolve(data: &DataPaths, target: &Pk3EditorTarget) -> Result<(PathBuf, bool)> {
    match target {
        Pk3EditorTarget::Draft {
            draft_id,
            scope,
            root,
            path,
        } => {
            if FileKind::of_path(path) != FileKind::Pk3 {
                return Err(AppError::InvalidInput(format!(
                    "{path} is not a pk3, and only a pk3 is edited here"
                )));
            }
            // The record has to name the file: a path that is merely on disk
            // under the folder of the draft is not a file of the draft.
            let draft = draft::read_draft(data, draft_id)?;
            listing::find_draft_file(&draft, scope, *root, path)?;
            let archive = draft::file_path(data, draft_id, scope, *root, path)?;
            if !archive.is_file() {
                return Err(AppError::NotFound(format!("{path} of the draft {draft_id}")));
            }
            Ok((archive, false))
        }
        Pk3EditorTarget::Library { client_id, item_id } => {
            let archive = library::item_path(data, client_id, item_id)?;
            // An archive of the engine build mirrored into `home\base\` is
            // not the player's file: the toggle and the delete refuse it, and
            // so does every edit here.
            let read_only = library::is_engine_item(data, client_id, item_id)?;
            Ok((archive, read_only))
        }
    }
}

/// The key a save claims while it rewrites the archive of a target: the same
/// key a publish, an install or a deletion of the same owner takes.
fn busy_key(target: &Pk3EditorTarget) -> String {
    match target {
        Pk3EditorTarget::Draft { draft_id, .. } => draft_key(draft_id),
        Pk3EditorTarget::Library { client_id, .. } => client_id.clone(),
    }
}

/// Opens a session on the archive of a target, or answers with the one that
/// is already open on it.
fn open_session(
    sessions: &Sessions,
    data: &DataPaths,
    target: Pk3EditorTarget,
) -> Result<Pk3EditorSession> {
    let (archive_path, read_only) = resolve(data, &target)?;
    let mut open = lock(sessions)?;
    if let Some(session) = open
        .values()
        .find(|session| session.archive_path == archive_path)
    {
        return Ok(session.view());
    }
    sweep(data, &open);

    let bytes = fs::metadata(&archive_path)
        .map_err(|e| AppError::io_path("cannot read", &archive_path, e))?
        .len();
    let entries = read_records(&archive_path)?;
    let id = user_files::id();
    let work_dir = pk3_editor_dir(data).join(&id);
    let session = Session {
        id: id.clone(),
        target,
        archive_path,
        work_dir,
        read_only,
        bytes,
        entries,
    };
    let view = session.view();
    log::info!(
        "pk3 editor: {} opened as session {id} with {} entries{}",
        session.archive_path.display(),
        session.entries.len(),
        if read_only { ", read only" } else { "" }
    );
    open.insert(id, session);
    Ok(view)
}

/// `cache\pk3-editor\`: one folder per open session.
fn pk3_editor_dir(data: &DataPaths) -> PathBuf {
    data.cache.join("pk3-editor")
}

/// Removes the folders of sessions nothing holds any more: what a launcher
/// that was killed with the dialog open leaves behind.
fn sweep(data: &DataPaths, open: &HashMap<String, Session>) {
    let root = pk3_editor_dir(data);
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if open.contains_key(&name) {
            continue;
        }
        if let Err(e) = fs::remove_dir_all(entry.path()) {
            log::warn!("pk3 editor: cannot remove {}: {e}", entry.path().display());
        }
    }
}

/// Ends a session and throws away what it kept beside the archive.
fn close_session(sessions: &Sessions, session_id: &str) -> Result<()> {
    let removed = lock(sessions)?.remove(session_id);
    if let Some(session) = removed {
        if session.work_dir.exists() {
            if let Err(e) = fs::remove_dir_all(&session.work_dir) {
                log::warn!(
                    "pk3 editor: cannot remove {}: {e}",
                    session.work_dir.display()
                );
            }
        }
        log::info!("pk3 editor: session {session_id} closed");
    }
    Ok(())
}

/// Throws every unsaved edit away and reads the archive again.
fn reset(session: &mut Session) -> Result<()> {
    if session.work_dir.exists() {
        fs::remove_dir_all(&session.work_dir)
            .map_err(|e| AppError::io_path("cannot empty", &session.work_dir, e))?;
    }
    session.bytes = fs::metadata(&session.archive_path)
        .map_err(|e| AppError::io_path("cannot read", &session.archive_path, e))?
        .len();
    session.entries = read_records(&session.archive_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The edits
// ---------------------------------------------------------------------------

/// The text of an entry, decoded by the code page its path and its bytes
/// give it, at most [`MAX_TEXT_BYTES`] of it.
fn read_text(session: &Session, path: &str) -> Result<PreviewTextData> {
    let at = session.find_live(path)?;
    if entry_kind(&session.entries[at].path) != Pk3EntryKind::Text {
        return Err(AppError::InvalidInput(format!("{path} is not a text file")));
    }
    let (bytes, truncated) = entry_bytes(session, at, MAX_TEXT_BYTES)?;
    let encoding = encoding_of(path, &bytes);
    Ok(PreviewTextData {
        text: decode_text(&bytes, encoding),
        encoding: encoding.to_string(),
        truncated,
    })
}

/// A picture of an entry as the webview can show it.
fn read_image(session: &Session, path: &str, max_size: Option<u32>) -> Result<PreviewImageData> {
    let at = session.find_live(path)?;
    check_picture_request(path, max_size)?;
    let (bytes, more) = entry_bytes(session, at, MAX_IMAGE_BYTES)?;
    if more {
        return Err(AppError::InvalidInput(format!(
            "{path} is bigger than the {} MiB the editor reads",
            MAX_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    picture_from_bytes(path, &bytes, max_size)
}

/// Writes the text of an entry into the session, creating the entry when the
/// archive has not got it.
fn write_text(session: &mut Session, path: &str, text: &str) -> Result<()> {
    check_entry_path(path)?;
    if entry_kind(path) != Pk3EntryKind::Text {
        return Err(AppError::InvalidInput(format!(
            "{path} is not a text file; replace it with a file from the disk instead"
        )));
    }
    let bytes = encode_text(text, write_encoding(path));
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "the text of {path} is bigger than the {} KiB the editor writes",
            MAX_TEXT_BYTES / 1024
        )));
    }
    let at = record_for(session, path)?;
    stage_bytes(session, at, &bytes)
}

/// Puts a file of the disk over an entry. A picture is converted into the
/// format of the entry; everything else is copied as it is.
fn replace(session: &mut Session, path: &str, source: &Path) -> Result<()> {
    let at = session.find_live(path)?;
    let Some(target_format) = entry_picture_format(&session.entries[at].path) else {
        return stage_file(session, at, source);
    };

    let meta = fs::metadata(source).map_err(|e| AppError::io_path("cannot read", source, e))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{} is bigger than the {} MiB picture the editor reads",
            source.display(),
            MAX_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = read_head(source, MAX_IMAGE_BYTES)?;
    let name = source.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let Some(source_format) = picture_format(name, &bytes) else {
        return Err(AppError::InvalidInput(format!(
            "{} is not a picture, and {path} is one",
            source.display()
        )));
    };
    let converted = convert_picture(&bytes, source_format, target_format)?;
    let before = session.entries[at].image.clone();
    stage_bytes(session, at, &converted)?;
    if let Some(after) = session.entries[at].image.clone() {
        report_picture_size(path, before.as_ref(), &after);
    }
    Ok(())
}

/// Adds files of the disk into a folder of the archive. The name of an entry
/// is the name of the file in lower case, the way the archives of the game
/// spell theirs; a file on a path the archive already has replaces it.
fn add_files(session: &mut Session, folder: &str, sources: &[PathBuf]) -> Result<()> {
    let folder = check_folder(folder)?;
    if sources.len() > MAX_ADDED_FILES {
        return Err(AppError::InvalidInput(format!(
            "at most {MAX_ADDED_FILES} files go into an archive in one step"
        )));
    }
    for source in sources {
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                AppError::InvalidInput(format!("{} has no file name", source.display()))
            })?
            .to_ascii_lowercase();
        let path = join_path(&folder, &name);
        let at = record_for(session, &path)?;
        stage_file(session, at, source)?;
    }
    Ok(())
}

/// Marks entries for removal. A path with a trailing slash takes the folder
/// with everything under it.
///
/// An entry that came out of the archive stays in the list, crossed out,
/// until **Save** or **Discard**; one added in this session has nothing to
/// go back to and leaves the list at once.
fn remove(session: &mut Session, paths: &[String]) -> Result<()> {
    for path in paths {
        let path = path.trim();
        if let Some(folder) = path.strip_suffix('/') {
            let folder = check_folder(folder)?;
            for at in (0..session.entries.len()).rev() {
                if !session.entries[at].removed && is_under(&session.entries[at].path, &folder) {
                    drop_entry(session, at);
                }
            }
            continue;
        }
        let at = session.find_live(path)?;
        drop_entry(session, at);
    }
    Ok(())
}

/// Removes one record, and with it the bytes it staged.
fn drop_entry(session: &mut Session, at: usize) {
    if let Some(staged) = session.entries[at].staged.take() {
        if let Err(e) = fs::remove_file(&staged) {
            log::warn!("pk3 editor: cannot remove {}: {e}", staged.display());
        }
    }
    if session.entries[at].source.is_none() {
        session.entries.remove(at);
        return;
    }
    let record = &mut session.entries[at];
    record.removed = true;
    record.image = None;
    record.text = None;
}

/// Renames an entry, or a folder with everything under it when both paths
/// end in a slash.
fn rename(session: &mut Session, from: &str, to: &str) -> Result<()> {
    let from = from.trim();
    let to = to.trim();
    let folders = (from.ends_with('/'), to.ends_with('/'));
    if folders.0 != folders.1 {
        return Err(AppError::InvalidInput(
            "a folder is renamed into a folder: both paths end in a slash".into(),
        ));
    }
    if folders.0 {
        let from = check_folder(from)?;
        let to = check_folder(to)?;
        if from.is_empty() || to.is_empty() {
            return Err(AppError::InvalidInput(
                "the root of an archive has no name to change".into(),
            ));
        }
        if is_under(&to, &from) && !to.eq_ignore_ascii_case(&from) {
            return Err(AppError::InvalidInput(format!(
                "{from}/ cannot move into itself"
            )));
        }
        let moved: Vec<usize> = (0..session.entries.len())
            .filter(|at| !session.entries[*at].removed && is_under(&session.entries[*at].path, &from))
            .collect();
        if moved.is_empty() {
            return Err(AppError::NotFound(format!("{from}/ in the archive")));
        }
        let renamed: Vec<(usize, String)> = moved
            .iter()
            .map(|at| {
                let path = &session.entries[*at].path;
                let tail = &path[from.len()..];
                (*at, format!("{to}{tail}"))
            })
            .collect();
        for (at, path) in &renamed {
            check_entry_path(path)?;
            if !moved.contains(&session.find(path).unwrap_or(*at)) {
                session.free(path, *at)?;
            }
        }
        for (at, path) in renamed {
            move_entry(session, at, path)?;
        }
        return Ok(());
    }

    let at = session.find_live(from)?;
    check_entry_path(to)?;
    session.free(to, at)?;
    move_entry(session, at, to.to_string())
}

/// Gives one record a new path and moves the bytes it staged with it.
fn move_entry(session: &mut Session, at: usize, path: String) -> Result<()> {
    if session.entries[at].path == path {
        return Ok(());
    }
    if let Some(staged) = session.entries[at].staged.clone() {
        let target = staged_path(session, &path)?;
        if let Some(parent) = target.parent() {
            paths::create_dir(parent)?;
        }
        fs::rename(&staged, &target)
            .map_err(|e| AppError::io_path("cannot move", &target, e))?;
        session.entries[at].staged = Some(target);
    }
    // The kind of an entry follows its extension, so a rename can turn a
    // picture into a text file and back. Only then is the head of the entry
    // read again: a folder of five thousand textures moves without opening
    // the archive once.
    let same_kind = entry_kind(&session.entries[at].path) == entry_kind(&path);
    session.entries[at].path = path;
    if !same_kind {
        let (bytes, _) = entry_bytes(session, at, HEADER_BYTES)?;
        let (image, text) = probe(&session.entries[at].path, &bytes);
        session.entries[at].image = image;
        session.entries[at].text = text;
    }
    Ok(())
}

/// Writes entries, or whole folders by a trailing slash, into a folder of
/// the disk, and says how many files went.
fn extract(session: &Session, paths: &[String], target_dir: &Path) -> Result<usize> {
    if !target_dir.is_dir() {
        return Err(AppError::NotFound(format!(
            "the folder {}",
            target_dir.display()
        )));
    }
    let mut wanted: Vec<usize> = Vec::new();
    for path in paths {
        let path = path.trim();
        if let Some(folder) = path.strip_suffix('/') {
            let folder = check_folder(folder)?;
            for at in 0..session.entries.len() {
                if !session.entries[at].removed && is_under(&session.entries[at].path, &folder) {
                    wanted.push(at);
                }
            }
            continue;
        }
        wanted.push(session.find_live(path)?);
    }
    wanted.sort_unstable();
    wanted.dedup();

    let mut written = 0;
    for at in wanted {
        let record = &session.entries[at];
        let target = engine_install::safe_entry_path(target_dir, &record.path)?;
        if let Some(parent) = target.parent() {
            paths::create_dir(parent)?;
        }
        if let Some(staged) = &record.staged {
            fs::copy(staged, &target)
                .map_err(|e| AppError::io_path("cannot copy into", &target, e))?;
        } else {
            let index = record
                .source
                .as_ref()
                .ok_or_else(|| AppError::NotFound(format!("the bytes of {}", record.path)))?
                .index;
            let mut zip = open_archive(&session.archive_path)?;
            let mut entry = zip.by_index(index)?;
            let file =
                File::create(&target).map_err(|e| AppError::io_path("cannot write", &target, e))?;
            let mut out = BufWriter::new(file);
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| AppError::io_path("cannot write", &target, e))?;
            out.flush()
                .map_err(|e| AppError::io_path("cannot write", &target, e))?;
        }
        written += 1;
    }
    Ok(written)
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/// Writes the archive again and renames it over the old one.
///
/// The new archive is built next to the old one and only takes its place
/// once it is closed and complete: every failure before that leaves the old
/// archive untouched, which is the whole reason a pk3 is not edited in place.
fn write_archive(session: &Session) -> Result<(u64, usize)> {
    let temp = session
        .archive_path
        .with_extension(format!("{}.tmp", user_files::id()));
    let result = write_into(session, &temp);
    match result {
        Ok(entries) => {
            fs::rename(&temp, &session.archive_path).map_err(|e| {
                let _ = fs::remove_file(&temp);
                AppError::io_path("cannot replace", &session.archive_path, e)
            })?;
            let size = fs::metadata(&session.archive_path)
                .map_err(|e| AppError::io_path("cannot read", &session.archive_path, e))?
                .len();
            Ok((size, entries))
        }
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// Builds the new archive in `temp` and answers with how many entries it
/// holds. The reader of the old archive is closed before the caller renames.
fn write_into(session: &Session, temp: &Path) -> Result<usize> {
    if let Some(parent) = temp.parent() {
        paths::create_dir(parent)?;
    }
    let mut zip = open_archive(&session.archive_path)?;
    let file = File::create(temp).map_err(|e| AppError::io_path("cannot write", temp, e))?;
    let mut writer = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut written = 0;

    for record in &session.entries {
        if record.removed {
            continue;
        }
        match (&record.staged, &record.source) {
            (Some(staged), _) => {
                writer.start_file(&record.path, options)?;
                let mut source =
                    File::open(staged).map_err(|e| AppError::io_path("cannot read", staged, e))?;
                std::io::copy(&mut source, &mut writer)
                    .map_err(|e| AppError::io_path("cannot write", temp, e))?;
            }
            // Untouched bytes move across compressed as they are: nothing is
            // inflated and deflated again, so a save costs the size of the
            // archive and not the time of recompressing it.
            (None, Some(source)) => {
                let entry = zip.by_index_raw(source.index)?;
                if record.path == source.path {
                    writer.raw_copy_file(entry)?;
                } else {
                    writer.raw_copy_file_rename(entry, &record.path)?;
                }
            }
            (None, None) => {
                return Err(AppError::Archive(format!(
                    "{} has no bytes to write",
                    record.path
                )))
            }
        }
        written += 1;
    }

    let mut out = writer.finish()?;
    out.flush()
        .map_err(|e| AppError::io_path("cannot write", temp, e))?;
    let file = out
        .into_inner()
        .map_err(|e| AppError::io_path("cannot write", temp, e.into_error()))?;
    file.sync_all()
        .map_err(|e| AppError::io_path("cannot write", temp, e))?;
    drop(file);
    drop(zip);
    Ok(written)
}

/// Rewrites the archive of a session and reads it back into the session.
///
/// Answers with the hash, the size and the entry count of what was written:
/// the owner of the archive needs all three, and so does the dialog.
fn save(sessions: &Sessions, session_id: &str) -> Result<Pk3EditorSaved> {
    user_files::valid_id(session_id)
        .map_err(|_| AppError::InvalidInput(format!("{session_id:?} is not a session id")))?;
    let mut open = lock(sessions)?;
    let session = open
        .get_mut(session_id)
        .ok_or_else(|| AppError::NotFound("pk3 editor session; open the archive again".into()))?;
    session.writable()?;

    if !session.dirty() {
        let entries = session.entries.iter().filter(|e| !e.removed).count();
        return Ok(Pk3EditorSaved {
            sha256: sha256_of(&session.archive_path)?,
            size: session.bytes,
            entries,
        });
    }

    let (size, entries) = write_archive(session)?;
    let sha256 = sha256_of(&session.archive_path)?;
    log::info!(
        "pk3 editor: {} written with {entries} entries, {size} bytes, {sha256}",
        session.archive_path.display()
    );
    reset(session)?;
    Ok(Pk3EditorSaved {
        sha256,
        size,
        entries,
    })
}

// ---------------------------------------------------------------------------
// The owner of the archive
// ---------------------------------------------------------------------------

/// The origin a file of a draft carries once the editor has rewritten it.
///
/// A JKHub file is already covered: its origin keeps the hash JKHub served,
/// and [`crate::bundles::draft::DraftFile::source`] turns a file that no
/// longer hashes to it into a blob with `origin.modified: true`. A file taken
/// out of the library of a client is not: its provenance would still send an
/// install to the JKHub record, which would fetch the original over the edit.
/// So the provenance becomes that same JKHub origin, with the hash the file
/// had before the edit.
fn rewritten_origin(origin: DraftOrigin, previous_sha256: &str) -> DraftOrigin {
    match origin {
        DraftOrigin::Client {
            provenance: Some(provenance),
            ..
        } if provenance.source == "jkhub" => DraftOrigin::Jkhub {
            file_id: provenance.file_id,
            version: provenance.version,
            title: Some(provenance.title).filter(|title| !title.is_empty()),
            url: Some(provenance.url).filter(|url| !url.is_empty()),
            sha256: previous_sha256.to_string(),
        },
        other => other,
    }
}

/// Brings the owner of the archive up to date after a save.
///
/// A file of a draft gets its size, hash, kind, library card, listing and
/// origin; a file of the library gets its sidecar and its hash read again,
/// which is also what drops the note that says JKHub served it.
fn update_owner(data: &DataPaths, target: &Pk3EditorTarget, archive_path: &Path) -> Result<()> {
    match target {
        Pk3EditorTarget::Draft {
            draft_id,
            scope,
            root,
            path,
        } => {
            let size = fs::metadata(archive_path)
                .map_err(|e| AppError::io_path("cannot read", archive_path, e))?
                .len();
            let sha256 = sha256_of(archive_path)?;
            let draft = draft::edit_draft(data, draft_id, |draft| {
                let file = listing::find_draft_file_mut(draft, scope, *root, path)?;
                let previous = file.sha256.clone();
                let display_name = file
                    .library
                    .as_ref()
                    .map(|library| library.display_name.clone())
                    .unwrap_or_else(|| display_name_of(&file.path));
                file.size = size;
                file.sha256 = sha256.clone();
                file.kind = FileKind::of_path(&file.path);
                file.library = (file.root == FileRoot::Home && file.kind == FileKind::Pk3)
                    .then(|| draft::pk3_info(archive_path, display_name));
                file.listing = (file.kind == FileKind::Pk3)
                    .then(|| listing::listing_of_new_file(data, draft_id, &sha256, archive_path))
                    .flatten();
                file.origin = rewritten_origin(file.origin.clone(), &previous);
                Ok(())
            })?;
            // The listing of the old hash is named after bytes nothing holds
            // any more.
            listing::prune_draft_listings(data, &draft);
            Ok(())
        }
        Pk3EditorTarget::Library { client_id, item_id } => {
            library::refresh_rewritten_item(data, client_id, item_id)?;
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Runs blocking archive work off the runtime.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::State(format!("the pk3 editor thread stopped: {e}")))?
}

/// Opens the archive of a target, or answers with the session already open
/// on it.
#[tauri::command]
pub async fn pk3_editor_open(
    state: tauri::State<'_, AppState>,
    editor: tauri::State<'_, Pk3EditorState>,
    target: Pk3EditorTarget,
) -> Result<Pk3EditorSession> {
    let data = state.paths()?;
    let sessions = editor.sessions();
    off_thread(move || open_session(&sessions, &data, target)).await
}

/// The session as it is now.
#[tauri::command]
pub fn pk3_editor_state(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
) -> Result<Pk3EditorSession> {
    read(&editor.sessions, session_id.trim(), |session| {
        Ok(session.view())
    })
}

/// The text of an entry, up to 512 KiB of it.
#[tauri::command]
pub async fn pk3_editor_read_text(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    path: String,
) -> Result<PreviewTextData> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    let path = path.trim().to_string();
    off_thread(move || read(&sessions, &session_id, |session| read_text(session, &path))).await
}

/// A picture of an entry, at its own size or as a thumbnail.
#[tauri::command]
pub async fn pk3_editor_read_image(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    path: String,
    max_size: Option<u32>,
) -> Result<PreviewImageData> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    let path = path.trim().to_string();
    off_thread(move || {
        read(&sessions, &session_id, |session| {
            read_image(session, &path, max_size)
        })
    })
    .await
}

/// Writes the text of an entry in its code page; a path the archive has not
/// got creates the entry.
#[tauri::command]
pub async fn pk3_editor_write_text(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    path: String,
    text: String,
) -> Result<Pk3EditorSession> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    let path = path.trim().to_string();
    off_thread(move || {
        edit(&sessions, &session_id, |session| {
            write_text(session, &path, &text)
        })
    })
    .await
}

/// Puts a file of the disk over an entry.
#[tauri::command]
pub async fn pk3_editor_replace(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    path: String,
    source_path: String,
) -> Result<Pk3EditorSession> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    let path = path.trim().to_string();
    let source = PathBuf::from(source_path);
    off_thread(move || {
        edit(&sessions, &session_id, |session| {
            replace(session, &path, &source)
        })
    })
    .await
}

/// Adds files of the disk into a folder of the archive.
#[tauri::command]
pub async fn pk3_editor_add_files(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    folder: String,
    source_paths: Vec<String>,
) -> Result<Pk3EditorSession> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    let sources: Vec<PathBuf> = source_paths.into_iter().map(PathBuf::from).collect();
    off_thread(move || {
        edit(&sessions, &session_id, |session| {
            add_files(session, &folder, &sources)
        })
    })
    .await
}

/// Marks entries, or whole folders, for removal.
#[tauri::command]
pub async fn pk3_editor_remove(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<Pk3EditorSession> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    off_thread(move || edit(&sessions, &session_id, |session| remove(session, &paths))).await
}

/// Renames an entry, or a folder with everything under it.
#[tauri::command]
pub async fn pk3_editor_rename(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<Pk3EditorSession> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    off_thread(move || {
        edit(&sessions, &session_id, |session| {
            rename(session, &from, &to)
        })
    })
    .await
}

/// Writes entries, or whole folders, into a folder of the disk.
#[tauri::command]
pub async fn pk3_editor_extract(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
    paths: Vec<String>,
    target_dir: String,
) -> Result<Pk3ExtractResult> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    let target = PathBuf::from(target_dir);
    off_thread(move || {
        read(&sessions, &session_id, |session| {
            extract(session, &paths, &target).map(|files| Pk3ExtractResult { files })
        })
    })
    .await
}

/// Rewrites the archive and brings its owner up to date. The session stays
/// open on the archive that was written.
#[tauri::command]
pub async fn pk3_editor_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bundles: tauri::State<'_, BundlesState>,
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
) -> Result<Pk3EditorSaved> {
    let data = state.paths()?;
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    let (target, archive_path) = read(&sessions, &session_id, |session| {
        Ok((session.target.clone(), session.archive_path.clone()))
    })?;
    // Held until the owner is written: a publish, an install or a deletion of
    // the same draft or client must not read the archive half rewritten.
    let _claim = bundles.claim(&busy_key(&target), BundlesState::EDIT)?;

    let saved = {
        let sessions = Arc::clone(&sessions);
        let session_id = session_id.clone();
        off_thread(move || save(&sessions, &session_id)).await?
    };

    {
        let data = data.clone();
        let target = target.clone();
        off_thread(move || update_owner(&data, &target, &archive_path)).await?;
    }

    if let Pk3EditorTarget::Library { client_id, .. } = &target {
        clients::emit_changed(&app, client_id);
        library::notify(&app, client_id);
    }
    Ok(saved)
}

/// Throws every unsaved edit away.
#[tauri::command]
pub async fn pk3_editor_discard(
    editor: tauri::State<'_, Pk3EditorState>,
    session_id: String,
) -> Result<Pk3EditorSession> {
    let sessions = editor.sessions();
    let session_id = session_id.trim().to_string();
    off_thread(move || edit(&sessions, &session_id, reset)).await
}

/// Ends the session and deletes what it kept beside the archive.
#[tauri::command]
pub fn pk3_editor_close(editor: tauri::State<'_, Pk3EditorState>, session_id: String) -> Result<()> {
    close_session(&editor.sessions, session_id.trim())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use crate::bundles::draft::test_support::{component, empty_draft, put_draft_file};
    use crate::engines::LaunchMode;
    use crate::game::Game;
    use crate::jkhub::types::Provenance;

    /// A pk3 on disk with the given entries, stored so a test can read the
    /// bytes back out of the file without a decompressor.
    fn write_pk3(path: &Path, entries: &[(&str, &[u8])]) {
        fs::create_dir_all(path.parent().expect("a parent")).expect("the parent folder");
        let file = File::create(path).expect("the archive is created");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, body) in entries {
            if name.ends_with('/') {
                writer
                    .add_directory(name.trim_end_matches('/'), options)
                    .expect("a folder");
                continue;
            }
            writer.start_file(*name, options).expect("an entry starts");
            writer.write_all(body).expect("the entry is written");
        }
        writer.finish().expect("the archive is closed");
    }

    /// The entries of an archive on disk, path and bytes, sorted by path.
    fn read_pk3(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut zip = open_archive(path).expect("the archive opens");
        let found: Vec<(usize, String)> = archive::walk(&zip, MAX_ENTRIES).collect();
        let mut entries = Vec::new();
        for (index, name) in found {
            let mut bytes = Vec::new();
            zip.by_index(index)
                .expect("the entry")
                .read_to_end(&mut bytes)
                .expect("the bytes");
            entries.push((name, bytes));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    /// A minimal, valid 1×1 PNG, so a conversion has something to decode.
    fn png_1x1() -> Vec<u8> {
        let picture = image::RgbImage::from_pixel(1, 1, image::Rgb([7, 8, 9]));
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(picture)
            .write_to(&mut out, image::ImageFormat::Png)
            .expect("a png");
        out.into_inner()
    }

    /// A session on an archive, with its work folder under `root`.
    fn session_on(root: &Path, archive_path: &Path) -> Session {
        let id = user_files::id();
        Session {
            id: id.clone(),
            target: Pk3EditorTarget::Library {
                client_id: "duel".into(),
                item_id: "base/skin.pk3".into(),
            },
            archive_path: archive_path.to_path_buf(),
            work_dir: root.join("pk3-editor").join(id),
            read_only: false,
            bytes: fs::metadata(archive_path).map(|meta| meta.len()).unwrap_or(0),
            entries: read_records(archive_path).expect("the archive reads"),
            }
    }

    fn paths_of(root: &Path) -> DataPaths {
        DataPaths::new(root.to_path_buf())
    }

    // --- the archive and the states of its entries ---

    #[test]
    fn opening_an_archive_lists_its_files_with_their_kinds_sizes_and_headers() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        let png = png_1x1();
        write_pk3(
            &archive,
            &[
                ("models/players/reborn/", b"" as &[u8]),
                ("models/players/reborn/model.glm", b"geometry"),
                ("models/players/reborn/icon_default.png", &png),
                ("sound/chars/taunt.mp3", b"taunt"),
                ("maps/duel.bsp", b"map"),
                ("README.txt", b"read me"),
            ],
        );
        let session = session_on(temp.path(), &archive);
        let view = session.view();
        assert!(!view.dirty);
        assert!(!view.read_only);
        assert_eq!(view.bytes, fs::metadata(&archive).unwrap().len());

        // Folders are not entries, and every file is in the order of the
        // central directory.
        let paths: Vec<&str> = view.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "models/players/reborn/model.glm",
                "models/players/reborn/icon_default.png",
                "sound/chars/taunt.mp3",
                "maps/duel.bsp",
                "README.txt",
            ]
        );
        let kinds: Vec<Pk3EntryKind> = view.entries.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            [
                Pk3EntryKind::Model,
                Pk3EntryKind::Image,
                Pk3EntryKind::Sound,
                Pk3EntryKind::Map,
                Pk3EntryKind::Text,
            ]
        );
        assert!(view.entries.iter().all(|e| e.state == Pk3EntryState::Unchanged));
        assert_eq!(view.entries[0].size, 8);

        // The header of a picture and the code page of a text file come off
        // the first bytes of the entry.
        assert_eq!(
            view.entries[1].image,
            Some(Pk3EntryImage {
                width: 1,
                height: 1,
                format: "png".into()
            })
        );
        assert!(view.entries[1].text.is_none());
        assert_eq!(
            view.entries[4].text,
            Some(Pk3EntryText {
                encoding: "utf-8".into()
            })
        );
    }

    #[test]
    fn a_backslash_entry_and_its_twin_become_one_row() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("dup.pk3");
        write_pk3(
            &archive,
            &[
                ("models\\players\\kyle\\model.glm", b"first" as &[u8]),
                ("models/players/kyle/model.glm", b"second"),
            ],
        );
        let session = session_on(temp.path(), &archive);
        assert_eq!(session.entries.len(), 1);
        assert_eq!(session.entries[0].path, "models/players/kyle/model.glm");
        assert_eq!(session.entries[0].size, 5);
    }

    #[test]
    fn every_edit_moves_the_entry_into_its_own_state() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_pk3(
            &archive,
            &[
                ("scripts/kyle.shader", b"shader" as &[u8]),
                ("README.txt", b"read me"),
                ("maps/duel.bsp", b"map"),
            ],
        );
        let mut session = session_on(temp.path(), &archive);
        assert!(!session.dirty());

        write_text(&mut session, "README.txt", "changed").expect("the text is written");
        write_text(&mut session, "notes/new.txt", "fresh").expect("a new entry");
        rename(&mut session, "scripts/kyle.shader", "scripts/jan.shader").expect("the rename");
        remove(&mut session, &["maps/duel.bsp".to_string()]).expect("the removal");

        let by_path: HashMap<String, Pk3EditorEntry> = session
            .view()
            .entries
            .into_iter()
            .map(|entry| (entry.path.clone(), entry))
            .collect();
        assert_eq!(by_path["README.txt"].state, Pk3EntryState::Modified);
        assert_eq!(by_path["notes/new.txt"].state, Pk3EntryState::Added);
        assert_eq!(by_path["scripts/jan.shader"].state, Pk3EntryState::Renamed);
        assert_eq!(
            by_path["scripts/jan.shader"].renamed_from.as_deref(),
            Some("scripts/kyle.shader")
        );
        assert_eq!(by_path["maps/duel.bsp"].state, Pk3EntryState::Removed);
        assert!(session.dirty());

        // An added entry that goes leaves the list; one of the archive stays,
        // crossed out, until Discard.
        remove(&mut session, &["notes/new.txt".to_string()]).expect("the added entry goes");
        assert!(session.find("notes/new.txt").is_none());

        reset(&mut session).expect("discard");
        assert!(!session.dirty());
        assert_eq!(session.entries.len(), 3);
        assert!(session
            .view()
            .entries
            .iter()
            .all(|entry| entry.state == Pk3EntryState::Unchanged));
    }

    #[test]
    fn a_folder_is_removed_renamed_and_extracted_whole() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("maps.pk3");
        write_pk3(
            &archive,
            &[
                ("levelshots/duel.jpg", b"jpeg" as &[u8]),
                ("maps/duel.bsp", b"map"),
                ("maps/sub/duel.lightmap", b"light"),
                ("README.txt", b"read me"),
            ],
        );
        let mut session = session_on(temp.path(), &archive);

        rename(&mut session, "maps/", "maps2/").expect("the folder moves");
        let paths: Vec<String> = session.entries.iter().map(|e| e.path.clone()).collect();
        assert!(paths.contains(&"maps2/duel.bsp".to_string()));
        assert!(paths.contains(&"maps2/sub/duel.lightmap".to_string()));
        assert!(!paths.contains(&"maps/duel.bsp".to_string()));

        // Extraction writes the paths of the archive under the chosen folder.
        let out = temp.path().join("out");
        fs::create_dir_all(&out).expect("the target folder");
        let files = extract(
            &session,
            &["maps2/".to_string(), "README.txt".to_string()],
            &out,
        )
        .expect("the extraction");
        assert_eq!(files, 3);
        assert_eq!(
            fs::read(out.join("maps2").join("duel.bsp")).expect("the map"),
            b"map"
        );
        assert!(out.join("maps2").join("sub").join("duel.lightmap").is_file());
        assert!(out.join("README.txt").is_file());
        assert!(!out.join("levelshots").exists());

        remove(&mut session, &["maps2/".to_string()]).expect("the folder goes");
        assert_eq!(
            session
                .view()
                .entries
                .iter()
                .filter(|entry| entry.state == Pk3EntryState::Removed)
                .count(),
            2
        );
    }

    // --- the path rules ---

    #[test]
    fn a_path_that_leaves_the_archive_is_refused_everywhere() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_pk3(&archive, &[("README.txt", b"read me" as &[u8])]);
        let mut session = session_on(temp.path(), &archive);

        for path in [
            "../escape.txt",
            "/rooted.txt",
            "a\\b.txt",
            "c:/drive.txt",
            "a/./b.txt",
            "a//b.txt",
        ] {
            let refused = write_text(&mut session, path, "x").expect_err(path);
            assert!(matches!(refused, AppError::InvalidInput(_)), "{path}: {refused}");
        }
        let long = format!("{}.txt", "x".repeat(manifest::MAX_PATH_LEN));
        assert!(write_text(&mut session, &long, "x").is_err());

        // The rename obeys the same rules, and refuses to mix a folder with
        // an entry.
        assert!(rename(&mut session, "README.txt", "../out.txt").is_err());
        assert!(rename(&mut session, "README.txt", "docs/").is_err());

        // Two live entries cannot share a path, whatever their case.
        write_text(&mut session, "docs/notes.txt", "x").expect("a second entry");
        let clash = rename(&mut session, "README.txt", "docs/NOTES.txt").expect_err("the clash");
        assert!(matches!(clash, AppError::AlreadyExists(_)), "{clash}");
    }

    #[test]
    fn a_read_only_session_refuses_every_edit() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("assetsmv.pk3");
        write_pk3(&archive, &[("README.txt", b"read me" as &[u8])]);
        let mut session = session_on(temp.path(), &archive);
        session.read_only = true;

        let sessions: Sessions = Mutex::new(HashMap::new());
        let id = session.id.clone();
        sessions.lock().unwrap().insert(id.clone(), session);

        let refused = edit(&sessions, &id, |session| {
            write_text(session, "README.txt", "x")
        })
        .expect_err("a read only archive");
        assert!(matches!(refused, AppError::InvalidInput(_)), "{refused}");
        // Reading it still works.
        let text = read(&sessions, &id, |session| read_text(session, "README.txt"))
            .expect("the text reads");
        assert_eq!(text.text, "read me");
    }

    // --- the encodings ---

    #[test]
    fn a_strings_file_is_written_in_the_code_page_of_its_language_and_the_rest_in_utf_8() {
        assert_eq!(write_encoding("strings/russian/menus.str"), "windows-1251");
        assert_eq!(write_encoding("strings/polish/menus.str"), "windows-1250");
        assert_eq!(write_encoding("strings/english/menus.str"), "windows-1252");
        assert_eq!(write_encoding("strip/sp_ingame.sp"), "windows-1252");
        assert_eq!(write_encoding("scripts/kyle.shader"), "utf-8");
        assert_eq!(write_encoding("README.TXT"), "utf-8");

        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("strings.pk3");
        write_pk3(&archive, &[("README.txt", b"read me" as &[u8])]);
        let mut session = session_on(temp.path(), &archive);

        write_text(&mut session, "strings/russian/menus.str", "Реборн").expect("the strings file");
        let at = session.find_live("strings/russian/menus.str").expect("the entry");
        let staged = session.entries[at].staged.clone().expect("the staged file");
        let bytes = fs::read(&staged).expect("the bytes");
        // Windows-1251, one byte a letter, and nothing of UTF-8 in it.
        assert_eq!(bytes.len(), 6);
        assert_eq!(bytes, encoding_rs::WINDOWS_1251.encode("Реборн").0.into_owned());
        assert_eq!(
            session.entries[at].text,
            Some(Pk3EntryText {
                encoding: "windows-1251".into()
            })
        );
        // And it reads back as what was typed.
        assert_eq!(
            read_text(&session, "strings/russian/menus.str").expect("the text").text,
            "Реборн"
        );

        // A shader keeps UTF-8.
        write_text(&mut session, "scripts/kyle.shader", "// Реборн").expect("the shader");
        let at = session.find_live("scripts/kyle.shader").expect("the entry");
        let staged = session.entries[at].staged.clone().expect("the staged file");
        assert_eq!(fs::read(&staged).expect("the bytes"), "// Реборн".as_bytes());

        // Bytes that are not a text file are not written as one.
        let refused = write_text(&mut session, "maps/duel.bsp", "x").expect_err("a map");
        assert!(matches!(refused, AppError::InvalidInput(_)), "{refused}");
    }

    #[test]
    fn a_text_entry_is_read_in_the_code_page_its_bytes_and_its_folder_give_it() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("rus.pk3");
        let cyrillic = encoding_rs::WINDOWS_1251.encode("Реборн").0.into_owned();
        write_pk3(
            &archive,
            &[
                ("strings/russian/menus.str", &cyrillic),
                ("README.txt", b"read me" as &[u8]),
            ],
        );
        let session = session_on(temp.path(), &archive);
        let strings = read_text(&session, "strings/russian/menus.str").expect("the strings file");
        assert_eq!(strings.encoding, "windows-1251");
        assert_eq!(strings.text, "Реборн");
        assert!(!strings.truncated);

        let readme = read_text(&session, "README.txt").expect("the readme");
        assert_eq!(readme.encoding, "utf-8");
        assert_eq!(readme.text, "read me");

        // A picture is not text and a text file is not a picture.
        assert!(read_text(&session, "nothing.txt").is_err());
    }

    // --- pictures ---

    #[test]
    fn a_picture_put_over_an_entry_keeps_the_format_of_the_entry() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_pk3(
            &archive,
            &[
                ("models/players/kyle/body.jpg", b"\xFF\xD8not a real jpeg" as &[u8]),
                ("README.txt", b"read me"),
            ],
        );
        let source = temp.path().join("body.png");
        fs::write(&source, png_1x1()).expect("the source picture");
        let mut session = session_on(temp.path(), &archive);

        replace(&mut session, "models/players/kyle/body.jpg", &source).expect("the replacement");
        let at = session.find_live("models/players/kyle/body.jpg").expect("the entry");
        assert_eq!(session.entries[at].state(), Pk3EntryState::Modified);
        let image = session.entries[at].image.clone().expect("a header");
        assert_eq!(image.format, "jpg", "the entry keeps its own format");
        assert_eq!((image.width, image.height), (1, 1));
        let staged = session.entries[at].staged.clone().expect("the staged file");
        assert!(fs::read(&staged).expect("the bytes").starts_with(&[0xFF, 0xD8]));

        // A file that is not a picture cannot stand in for one.
        let text = temp.path().join("notes.txt");
        fs::write(&text, b"not a picture").expect("the text file");
        let refused =
            replace(&mut session, "models/players/kyle/body.jpg", &text).expect_err("not a picture");
        assert!(matches!(refused, AppError::InvalidInput(_)), "{refused}");

        // An entry that is not a picture takes any file as it is.
        replace(&mut session, "README.txt", &text).expect("any file over a text entry");
        let at = session.find_live("README.txt").expect("the entry");
        let staged = session.entries[at].staged.clone().expect("the staged file");
        assert_eq!(fs::read(&staged).expect("the bytes"), b"not a picture");
    }

    #[test]
    fn a_picture_is_read_out_of_the_session_before_the_archive() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_pk3(&archive, &[("gfx/menus/logo.png", png_1x1().as_slice())]);
        let source = temp.path().join("other.png");
        let other = image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3]));
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(other)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("a png");
        fs::write(&source, bytes.into_inner()).expect("the source picture");

        let mut session = session_on(temp.path(), &archive);
        let before = read_image(&session, "gfx/menus/logo.png", None).expect("the picture");
        assert_eq!((before.width, before.height), (1, 1));
        assert!(before.data_url.starts_with("data:image/png;base64,"));

        replace(&mut session, "gfx/menus/logo.png", &source).expect("the replacement");
        let after = read_image(&session, "gfx/menus/logo.png", None).expect("the new picture");
        assert_eq!((after.width, after.height), (2, 2));

        // A thumbnail is asked for by side, and a side of zero is refused.
        assert!(read_image(&session, "gfx/menus/logo.png", Some(0)).is_err());
        // A file that is not a picture is refused before anything is read.
        assert!(read_image(&session, "gfx/menus/logo.png", Some(1)).is_ok());
    }

    // --- adding files ---

    #[test]
    fn files_are_added_under_lower_case_names_and_replace_what_stands_there() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_pk3(&archive, &[("README.txt", b"read me" as &[u8])]);
        let first = temp.path().join("Kyle.Shader");
        fs::write(&first, b"first").expect("the source");
        let second = temp.path().join("kyle.shader");
        fs::create_dir_all(temp.path().join("other")).expect("a folder");
        let second = temp.path().join("other").join(second.file_name().unwrap());
        fs::write(&second, b"second").expect("the source");

        let mut session = session_on(temp.path(), &archive);
        add_files(&mut session, "scripts", &[first]).expect("the first file");
        let at = session.find_live("scripts/kyle.shader").expect("the entry");
        assert_eq!(session.entries[at].state(), Pk3EntryState::Added);
        assert_eq!(session.entries[at].size, 5);

        add_files(&mut session, "scripts", &[second]).expect("the second file");
        assert_eq!(
            session.entries.iter().filter(|e| !e.removed).count(),
            2,
            "the same path is one entry"
        );
        let at = session.find_live("scripts/kyle.shader").expect("the entry");
        assert_eq!(session.entries[at].size, 6);

        // The root of the archive takes files too.
        let third = temp.path().join("notes.txt");
        fs::write(&third, b"notes").expect("the source");
        add_files(&mut session, "", &[third]).expect("a file at the root");
        assert!(session.find_live("notes.txt").is_ok());
    }

    // --- saving ---

    #[test]
    fn save_writes_every_live_entry_and_leaves_the_old_archive_alone_on_failure() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_pk3(
            &archive,
            &[
                ("scripts/kyle.shader", b"shader" as &[u8]),
                ("README.txt", b"read me"),
                ("maps/duel.bsp", b"map"),
            ],
        );
        let before = fs::read(&archive).expect("the bytes of the archive");
        let source = temp.path().join("notes.txt");
        fs::write(&source, b"added").expect("the source");

        let session = session_on(temp.path(), &archive);
        let sessions: Sessions = Mutex::new(HashMap::new());
        let id = session.id.clone();
        sessions.lock().unwrap().insert(id.clone(), session);

        edit(&sessions, &id, |session| {
            write_text(session, "README.txt", "changed")?;
            rename(session, "scripts/kyle.shader", "scripts/jan.shader")?;
            remove(session, &["maps/duel.bsp".to_string()])?;
            add_files(session, "notes", std::slice::from_ref(&source))
        })
        .expect("the edits");

        let saved = save(&sessions, &id).expect("the archive is written");
        // Three of the four live entries went in: the removed one did not.
        assert_eq!(saved.entries, 3);
        assert_eq!(saved.size, fs::metadata(&archive).unwrap().len());
        assert_eq!(saved.sha256.len(), 64);
        assert_ne!(fs::read(&archive).expect("the new bytes"), before);

        let written = read_pk3(&archive);
        let names: Vec<&str> = written.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            ["README.txt", "notes/notes.txt", "scripts/jan.shader"],
            "the removed entry is gone and the renamed one carries its new path"
        );
        assert_eq!(written[0].1, b"changed");
        assert_eq!(written[1].1, b"added");
        // The renamed entry kept the bytes it had, copied compressed.
        assert_eq!(written[2].1, b"shader");

        // The session is open on what was written, and nothing is pending.
        let view = pk3_editor_state_of(&sessions, &id);
        assert!(!view.dirty);
        assert_eq!(view.entries.len(), 3);
        assert!(view
            .entries
            .iter()
            .all(|entry| entry.state == Pk3EntryState::Unchanged));
        assert_eq!(view.bytes, saved.size);

        // A save with nothing to write answers with the archive as it lies.
        let again = save(&sessions, &id).expect("the second save");
        assert_eq!(again.sha256, saved.sha256);
        assert_eq!(again.size, saved.size);

        // A staged entry whose bytes are gone stops the write, and the
        // archive on disk is exactly what the last save left.
        let kept = fs::read(&archive).expect("the bytes");
        edit(&sessions, &id, |session| {
            write_text(session, "README.txt", "half written")?;
            let at = session.find_live("README.txt")?;
            let staged = session.entries[at].staged.clone().expect("the staged file");
            fs::remove_file(&staged).expect("the staged bytes go");
            Ok(())
        })
        .expect("the edit");
        let failed = save(&sessions, &id).expect_err("the write cannot finish");
        assert!(matches!(failed, AppError::Io { .. }), "{failed}");
        assert_eq!(fs::read(&archive).expect("the bytes"), kept);
        // And no temporary file is left beside it.
        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .expect("the folder")
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    /// The view of a session, for a test that has no Tauri state around it.
    fn pk3_editor_state_of(sessions: &Sessions, id: &str) -> Pk3EditorSession {
        read(sessions, id, |session| Ok(session.view())).expect("the session")
    }

    #[test]
    fn closing_a_session_takes_its_folder_with_it() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_pk3(&archive, &[("README.txt", b"read me" as &[u8])]);
        let session = session_on(temp.path(), &archive);
        let work_dir = session.work_dir.clone();
        let id = session.id.clone();
        let sessions: Sessions = Mutex::new(HashMap::new());
        sessions.lock().unwrap().insert(id.clone(), session);

        edit(&sessions, &id, |session| {
            write_text(session, "README.txt", "changed")
        })
        .expect("the edit");
        assert!(work_dir.join("README.txt").is_file());

        close_session(&sessions, &id).expect("the session closes");
        assert!(!work_dir.exists());
        assert!(sessions.lock().unwrap().is_empty());
        // A second close is not an error: the dialog closes twice under
        // StrictMode.
        close_session(&sessions, &id).expect("the second close");
        assert!(read(&sessions, &id, |_| Ok(())).is_err());
    }

    // --- the owner of the archive ---

    #[test]
    fn saving_a_file_of_a_draft_writes_its_size_hash_library_listing_and_origin() {
        let temp = tempfile::tempdir().expect("a folder");
        let data = paths_of(temp.path());
        let mut draft = empty_draft(&data, Game::JediAcademy, "Duel night");
        draft.components.push(component("mp", "Duel", "openjk", &[LaunchMode::Multiplayer]));

        // A pk3 of the draft that came out of the library of a client, with
        // the note that says JKHub served it.
        let archive = draft::file_path(&data, &draft.id, "mp", FileRoot::Home, "base/skin.pk3")
            .expect("a draft path");
        write_pk3(
            &archive,
            &[
                ("models/players/kyle/model.glm", b"geometry" as &[u8]),
                ("README.txt", b"read me"),
            ],
        );
        let mut file = put_draft_file(
            &data,
            &draft.id,
            "mp",
            FileRoot::Home,
            "base/skin.pk3",
            &fs::read(&archive).expect("the archive"),
            DraftOrigin::Client {
                client_id: "duel".into(),
                item_id: "base/skin.pk3".into(),
                provenance: Some(Provenance {
                    source: "jkhub".into(),
                    file_id: 1201,
                    version: Some("1.2".into()),
                    updated_at: None,
                    installed_at: "2026-09-01T00:00:00Z".into(),
                    title: "Kyle".into(),
                    url: "https://jkhub.org/files/1201".into(),
                }),
            },
        );
        file.library = Some(draft::pk3_info(&archive, "Kyle skin".into()));
        let before = file.sha256.clone();
        draft.components[0].files.push(file);
        draft::write_draft(&data, &draft).expect("the draft is written");

        let target = Pk3EditorTarget::Draft {
            draft_id: draft.id.clone(),
            scope: "mp".into(),
            root: FileRoot::Home,
            path: "base/skin.pk3".into(),
        };
        let mut session = session_on(temp.path(), &archive);
        session.target = target.clone();
        let id = session.id.clone();
        let sessions: Sessions = Mutex::new(HashMap::new());
        sessions.lock().unwrap().insert(id.clone(), session);

        edit(&sessions, &id, |session| {
            write_text(session, "README.txt", "edited by the player")
        })
        .expect("the edit");
        let saved = save(&sessions, &id).expect("the archive is written");
        update_owner(&data, &target, &archive).expect("the owner is updated");

        let draft = draft::read_draft(&data, &draft.id).expect("the draft reads");
        let file = &draft.components[0].files[0];
        assert_eq!(file.size, saved.size);
        assert_eq!(file.sha256, saved.sha256);
        assert_ne!(file.sha256, before);
        assert_eq!(file.kind, FileKind::Pk3);
        let library = file.library.as_ref().expect("a library card");
        assert_eq!(library.display_name, "Kyle skin", "the name the author gave it stays");
        assert_eq!(library.entries, 2);
        let listing = file.listing.as_ref().expect("a listing");
        assert!(listing::draft_listing_path(&data, &draft.id, &file.sha256).is_file());
        assert_eq!(listing.sha256.len(), 64);

        // The provenance became the origin a publish uploads: the record is
        // named, the file is a blob, and `modified` says why.
        assert_eq!(
            file.origin,
            DraftOrigin::Jkhub {
                file_id: 1201,
                version: Some("1.2".into()),
                title: Some("Kyle".into()),
                url: Some("https://jkhub.org/files/1201".into()),
                sha256: before.clone(),
            }
        );
        assert!(file.is_blob());
        let manifest_file = file.manifest_file();
        assert_eq!(
            serde_json::to_value(&manifest_file).expect("the manifest entry")["origin"]["modified"],
            true
        );

        // The listing of the bytes that are gone is not kept.
        let old = listing::draft_listing_path(&data, &draft.id, &before);
        assert!(!old.is_file(), "{}", old.display());
    }

    #[test]
    fn an_origin_that_is_not_a_jkhub_note_is_left_as_it_was() {
        let disk = DraftOrigin::Disk {
            source_path: r"D:\downloads\skin.pk3".into(),
        };
        assert_eq!(rewritten_origin(disk.clone(), "abcd"), disk);

        // A JKHub file needs nothing here: its origin already keeps the hash
        // JKHub served, and the new hash is what makes it `modified`.
        let jkhub = DraftOrigin::Jkhub {
            file_id: 7,
            version: None,
            title: None,
            url: None,
            sha256: "old".into(),
        };
        assert_eq!(rewritten_origin(jkhub.clone(), "abcd"), jkhub);

        // A file of a client with no note is a blob already.
        let plain = DraftOrigin::Client {
            client_id: "duel".into(),
            item_id: "base/skin.pk3".into(),
            provenance: None,
        };
        assert_eq!(rewritten_origin(plain.clone(), "abcd"), plain);
    }

    #[test]
    fn saving_a_file_of_the_library_re_reads_its_sidecar_and_drops_the_jkhub_note() {
        let temp = tempfile::tempdir().expect("a folder");
        let data = paths_of(temp.path());
        let home = data.client_dir("duel").join("home").join("base");
        fs::create_dir_all(&home).expect("the client home");
        let archive = home.join("skin.pk3");
        write_pk3(
            &archive,
            &[("models/players/kyle/model.glm", b"geometry" as &[u8])],
        );

        let target = Pk3EditorTarget::Library {
            client_id: "duel".into(),
            item_id: "base/skin.pk3".into(),
        };
        // The path the editor opens is the file itself, and it is nobody's
        // engine archive.
        let (resolved, read_only) = resolve(&data, &target).expect("the target resolves");
        assert_eq!(resolved, archive);
        assert!(!read_only);

        let mut session = session_on(temp.path(), &archive);
        session.target = target.clone();
        let id = session.id.clone();
        let sessions: Sessions = Mutex::new(HashMap::new());
        sessions.lock().unwrap().insert(id.clone(), session);

        let source = temp.path().join("notes.txt");
        fs::write(&source, b"read me").expect("the source");
        edit(&sessions, &id, |session| {
            add_files(session, "", std::slice::from_ref(&source))
        })
        .expect("the edit");
        let saved = save(&sessions, &id).expect("the archive is written");
        update_owner(&data, &target, &archive).expect("the owner is updated");

        let items = library::read_library(&data, "duel").expect("the library reads");
        let item = items.iter().find(|item| item.id == "base/skin.pk3").expect("the item");
        assert_eq!(item.size, saved.size);
        assert_eq!(item.sha1.as_deref().map(str::len), Some(40));
    }

    #[test]
    fn a_draft_file_that_is_not_a_pk3_or_not_in_the_record_does_not_open() {
        let temp = tempfile::tempdir().expect("a folder");
        let data = paths_of(temp.path());
        let mut draft = empty_draft(&data, Game::JediAcademy, "Duel night");
        draft.components.push(component("mp", "Duel", "openjk", &[LaunchMode::Multiplayer]));
        draft::write_draft(&data, &draft).expect("the draft is written");

        let cfg = Pk3EditorTarget::Draft {
            draft_id: draft.id.clone(),
            scope: "mp".into(),
            root: FileRoot::Home,
            path: "base/autoexec.cfg".into(),
        };
        let refused = resolve(&data, &cfg).expect_err("a cfg is not edited here");
        assert!(matches!(refused, AppError::InvalidInput(_)), "{refused}");

        let unknown = Pk3EditorTarget::Draft {
            draft_id: draft.id.clone(),
            scope: "mp".into(),
            root: FileRoot::Home,
            path: "base/skin.pk3".into(),
        };
        let refused = resolve(&data, &unknown).expect_err("no such file of the draft");
        assert!(matches!(refused, AppError::NotFound(_)), "{refused}");
    }

    #[test]
    fn a_save_claims_the_key_its_owner_uses() {
        let bundles = BundlesState::default();
        let draft = Pk3EditorTarget::Draft {
            draft_id: "d1".into(),
            scope: "mp".into(),
            root: FileRoot::Home,
            path: "base/skin.pk3".into(),
        };
        assert_eq!(busy_key(&draft), draft_key("d1"));
        let client = Pk3EditorTarget::Library {
            client_id: "duel".into(),
            item_id: "base/skin.pk3".into(),
        };
        assert_eq!(busy_key(&client), "duel");

        let held = bundles
            .claim(&busy_key(&client), BundlesState::EDIT)
            .expect("the claim");
        let refused = bundles
            .claim(&busy_key(&client), BundlesState::INSTALL)
            .expect_err("an install while a save runs");
        assert!(matches!(refused, AppError::Busy(_)), "{refused}");
        assert!(refused.to_string().contains("a pk3 edit"), "{refused}");
        drop(held);
        bundles
            .claim(&busy_key(&client), BundlesState::INSTALL)
            .expect("released with the guard");
    }

    // --- the wire ---

    #[test]
    fn the_session_reaches_the_frontend_under_the_names_ipc_ts_declares() {
        // The dialog reads these fields by name; a rename here is a screen
        // that shows nothing, so the shape is pinned rather than described.
        let target: Pk3EditorTarget = serde_json::from_str(
            r#"{"kind":"draft","draftId":"d1","scope":"mp","root":"home","path":"base/skin.pk3"}"#,
        )
        .expect("the target the frontend sends");
        assert_eq!(
            target,
            Pk3EditorTarget::Draft {
                draft_id: "d1".into(),
                scope: "mp".into(),
                root: FileRoot::Home,
                path: "base/skin.pk3".into(),
            }
        );
        let library: Pk3EditorTarget =
            serde_json::from_str(r#"{"kind":"library","clientId":"duel","itemId":"base/skin.pk3"}"#)
                .expect("the other target");

        let session = Pk3EditorSession {
            id: "s1".into(),
            target: library.clone(),
            archive_path: r"D:\clients\duel\home\base\skin.pk3".into(),
            dirty: true,
            entries: vec![Pk3EditorEntry {
                path: "gfx/menus/logo.png".into(),
                size: 12,
                kind: Pk3EntryKind::Image,
                state: Pk3EntryState::Renamed,
                image: Some(Pk3EntryImage {
                    width: 256,
                    height: 128,
                    format: "png".into(),
                }),
                text: None,
                renamed_from: Some("gfx/menus/old.png".into()),
            }],
            bytes: 4096,
            read_only: false,
        };
        let value = serde_json::to_value(&session).expect("the session serializes");
        assert_eq!(value["id"], "s1");
        assert_eq!(value["target"]["kind"], "library");
        assert_eq!(value["target"]["clientId"], "duel");
        assert_eq!(value["target"]["itemId"], "base/skin.pk3");
        assert_eq!(value["archivePath"], r"D:\clients\duel\home\base\skin.pk3");
        assert_eq!(value["dirty"], true);
        assert_eq!(value["bytes"], 4096);
        assert_eq!(value["readOnly"], false);
        let entry = &value["entries"][0];
        assert_eq!(entry["path"], "gfx/menus/logo.png");
        assert_eq!(entry["size"], 12);
        assert_eq!(entry["kind"], "image");
        assert_eq!(entry["state"], "renamed");
        assert_eq!(entry["image"]["width"], 256);
        assert_eq!(entry["image"]["format"], "png");
        assert_eq!(entry["renamedFrom"], "gfx/menus/old.png");
        assert!(entry.get("text").is_none(), "a field with nothing in it is left out");

        let saved = serde_json::to_value(Pk3EditorSaved {
            sha256: "ab".into(),
            size: 9,
            entries: 3,
        })
        .expect("the answer of a save");
        assert_eq!(saved["sha256"], "ab");
        assert_eq!(saved["size"], 9);
        assert_eq!(saved["entries"], 3);
        assert_eq!(
            serde_json::to_value(Pk3ExtractResult { files: 5 }).expect("the answer of an extract")
                ["files"],
            5
        );

        // Every state and every kind the frontend switches on.
        let states = [
            Pk3EntryState::Unchanged,
            Pk3EntryState::Modified,
            Pk3EntryState::Added,
            Pk3EntryState::Renamed,
            Pk3EntryState::Removed,
        ];
        let names: Vec<String> = states
            .iter()
            .map(|state| serde_json::to_value(state).expect("a state").to_string())
            .collect();
        assert_eq!(
            names,
            [
                "\"unchanged\"",
                "\"modified\"",
                "\"added\"",
                "\"renamed\"",
                "\"removed\""
            ]
        );
        let kinds = [
            Pk3EntryKind::Image,
            Pk3EntryKind::Text,
            Pk3EntryKind::Model,
            Pk3EntryKind::Sound,
            Pk3EntryKind::Map,
            Pk3EntryKind::Other,
        ];
        let names: Vec<String> = kinds
            .iter()
            .map(|kind| serde_json::to_value(kind).expect("a kind").to_string())
            .collect();
        assert_eq!(
            names,
            [
                "\"image\"",
                "\"text\"",
                "\"model\"",
                "\"sound\"",
                "\"map\"",
                "\"other\""
            ]
        );
    }

    // --- the folder of a session ---

    #[test]
    fn opening_an_archive_twice_answers_with_the_one_session_and_sweeps_the_rest() {
        let temp = tempfile::tempdir().expect("a folder");
        let data = paths_of(temp.path());
        let home = data.client_dir("duel").join("home").join("base");
        fs::create_dir_all(&home).expect("the client home");
        write_pk3(&home.join("skin.pk3"), &[("README.txt", b"read me" as &[u8])]);

        // A folder left behind by a launcher that was killed with the dialog
        // open.
        let stale = pk3_editor_dir(&data).join("stale-session");
        fs::create_dir_all(&stale).expect("the stale folder");

        let sessions: Sessions = Mutex::new(HashMap::new());
        let target = Pk3EditorTarget::Library {
            client_id: "duel".into(),
            item_id: "base/skin.pk3".into(),
        };
        let first = open_session(&sessions, &data, target.clone()).expect("the session opens");
        let second = open_session(&sessions, &data, target).expect("the same archive again");
        assert_eq!(first.id, second.id);
        assert_eq!(sessions.lock().unwrap().len(), 1);
        assert!(!stale.exists(), "the stale folder is swept on the first open");
    }
}
