//! Files of chat: what the player attaches, and what the others sent.
//!
//! A file reaches a message only through the core. A window never names a
//! path: the core's own dialog, a drop on a window whose composer is open,
//! an item of the Media screen or a picture on the clipboard become a
//! *staged* file — a copy under `cache\chat\staging\<handle>`, stripped of
//! what a picture records about where and when it was taken, and hashed —
//! and the window keeps only the opaque handle. The outbox uploads the copy
//! and sends the message; the copy then moves into the download cache under
//! the id the service gave the file, so the sender never downloads it back.
//!
//! | Step     | What happens |
//! | -------- | ------------ |
//! | stage    | refuses `settings.json` of the config root and its temporary siblings, and any file that holds the session token; refuses more than 25 MiB before reading; strips JPEG `APP1`/`APP13` and PNG `eXIf`/`tEXt`/`iTXt`/`zTXt`; hashes the copy |
//! | upload   | registers the file, then sends the bytes unless the account stored them already; `chat:upload` at most every 250 ms |
//! | download | into `cache\chat\files\<fileId>`, resumed from `<fileId>.part` with a range, checked against the SHA-256 the service sends as its `ETag`; at most 1 GiB, the files shown least recently go first; `chat:download` |
//! | save     | the core's save dialog; a program, or an archive with programs inside, needs `confirmed`; the saved copy gets a `Zone.Identifier` stream with `ZoneId=3` |
//! | import   | a demo or a screenshot into the folder of a client that the Media screen scans |
//!
//! The cache is keyed by the file id rather than by the hash: a message
//! names its files by id, and the wire `FileRef` carries no hash. The hash
//! arrives with the bytes, as the `ETag` of the download.
//!
//! Nothing here opens a received file with the shell.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, CONTENT_RANGE, ETAG};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, Result};
use crate::online::{
    is_chat_unavailable, path_segment, ChatMessage, FileMeta, FileRef, OnlineClient,
    OnlineContext,
};
use crate::paths::DataPaths;
use crate::state::AppState;
use crate::{clients, engines, media, timestamp, user_files};

use super::{
    account, emit, new_client_id, noted, ChatState, Staged, EVENT_UPLOAD, MAX_ATTACHMENTS,
};

/// The progress of one download, and how it ended.
pub const EVENT_DOWNLOAD: &str = "chat:download";
/// Files dropped on a window, staged: sent to that window only.
pub const EVENT_FILES_STAGED: &str = "chat:files-staged";

/// The code of the refusal of a save that has to be confirmed first. It
/// travels like a refusal of the chat API, as `details.code` of an `online`
/// error, so the frontend reads it where it reads the others.
pub const CONFIRM_DANGER: &str = "confirm_danger";

/// The largest file chat carries, the service's default limit.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

/// How much of the download cache stays on disk.
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;

/// A partial download nobody resumed for this long goes.
const STALE_PART: Duration = Duration::from_secs(24 * 60 * 60);

/// How often `chat:upload` and `chat:download` go out for one file.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// How long a command waits for a download another command started.
const DOWNLOAD_WAIT: Duration = Duration::from_secs(30 * 60);

/// The folders inside `cache\chat\`.
const STAGING_DIR: &str = "staging";
const FILES_DIR: &str = "files";
const PART_SUFFIX: &str = ".part";

/// What the service accepts as the width or the height of a picture.
const MAX_PICTURE_SIDE: u32 = 16_384;

/// The longest name the service keeps.
const MAX_NAME_CHARS: usize = 120;

/// File refs remembered for saves and imports; past this the memory starts
/// over, and a later page fills it again.
const KNOWN_LIMIT: usize = 10_000;

/// Where a staged file came from, as `meta.origin` tells the service.
const ORIGIN_FILE: &str = "file";
const ORIGIN_MEDIA: &str = "media";
const ORIGIN_CLIPBOARD: &str = "clipboard";

/// Extensions the service classifies as programs whatever the bytes say.
const PROGRAM_EXTENSIONS: &[&str] = &[
    "exe", "com", "scr", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "hta", "msi", "msp", "msix", "appx", "lnk", "url", "pif", "cpl", "dll", "sys", "inf", "reg",
    "jar", "scf", "chm", "iso", "img", "vhd", "vhdx", "application", "gadget", "xll", "docm",
    "xlsm", "pptm",
];

/// Entries that make an archive a carrier of programs, on top of
/// [`PROGRAM_EXTENSIONS`]: `.so` runs on another system, and a `.dll` in a
/// pk3 is how old servers pushed code onto players.
const PROGRAM_ENTRY_EXTENSIONS: &[&str] = &["so"];

/// Magic numbers of Mach-O programs, both byte orders, and of fat binaries.
const MACH_O: [&[u8]; 5] = [
    b"\xFE\xED\xFA\xCE",
    b"\xFE\xED\xFA\xCF",
    b"\xCE\xFA\xED\xFE",
    b"\xCF\xFA\xED\xFE",
    b"\xCA\xFE\xBA\xBE",
];

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// A staged file, as the composer shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    /// What `chat_send` names the file by.
    pub handle: String,
    pub name: String,
    pub size: u64,
    /// The class the service will most likely give the bytes.
    pub class_guess: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// `file`, `media` or `clipboard`.
    pub origin: String,
}

/// Where the bytes of a file are on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalStatus {
    Cached,
    Downloading,
    /// On the service only; a download may be asked for.
    Remote,
    /// The service no longer has it: "file unavailable".
    Gone,
}

/// The answer of `chat_file_local`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLocal {
    pub status: LocalStatus,
    /// The cached copy, once `cached`.
    pub path: Option<String>,
}

/// The `chat:download` event. `path` and `status: cached` when the file is
/// complete; `status: remote` when the download failed and may be tried
/// again; `status: gone` when the service no longer has the file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file_id: String,
    received: u64,
    total: u64,
    path: Option<String>,
    status: LocalStatus,
}

/// The `chat:files-staged` event. `refused` names each dropped file that did
/// not stage, with the error as every command answers one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesStaged {
    files: Vec<StagedFile>,
    refused: Vec<Value>,
}

/// The `chat:upload` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    handle: String,
    sent: u64,
    total: u64,
}

/// Where `chat_file_import` puts a file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTarget {
    /// `demo` or `screenshot`.
    pub kind: String,
    pub client_id: String,
}

// ---------------------------------------------------------------------------
// What the core knows about files
// ---------------------------------------------------------------------------

/// The files of messages the core has passed on, and the downloads.
#[derive(Debug, Default)]
pub(crate) struct FileBook {
    /// What the service said about each file, by id: the name a save
    /// proposes and whether the bytes are a program.
    known: HashMap<String, FileRef>,
    /// Downloads in flight, by file id.
    downloading: HashSet<String>,
    /// Files the service answered it no longer has.
    gone: HashSet<String>,
}

impl FileBook {
    pub fn remember(&mut self, file: &FileRef) {
        if file.id.is_empty() {
            return;
        }
        if self.known.len() >= KNOWN_LIMIT && !self.known.contains_key(&file.id) {
            self.known.clear();
        }
        self.known.insert(file.id.clone(), file.clone());
    }

    pub fn remember_messages<'a>(&mut self, messages: impl IntoIterator<Item = &'a ChatMessage>) {
        for message in messages {
            for file in &message.files {
                self.remember(file);
            }
        }
    }

    fn known(&self, file_id: &str) -> Option<FileRef> {
        self.known.get(file_id).cloned()
    }
}

/// Takes a download for one file; dropped, it lets the next one start.
struct Claim {
    app: AppHandle,
    file_id: String,
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.app
            .state::<ChatState>()
            .files()
            .downloading
            .remove(&self.file_id);
    }
}

// ---------------------------------------------------------------------------
// Startup and drops
// ---------------------------------------------------------------------------

/// Opens the download cache to the asset protocol, which is how a window
/// shows a received picture, and tidies what the last run left: nothing
/// staged survives a restart, and the cache keeps to its limit.
pub(super) fn start(app: &AppHandle) {
    let Ok(paths) = app.state::<AppState>().paths() else {
        return;
    };
    let files = files_dir_of(&paths);
    let staging = staging_dir_of(&paths);
    match std::fs::create_dir_all(&files) {
        Err(e) => log::warn!("chat: cannot create {}: {e}", files.display()),
        Ok(()) => match app.asset_protocol_scope().allow_directory(&files, false) {
            Ok(()) => log::info!("asset protocol: serving {}", files.display()),
            Err(e) => log::warn!("chat: cannot serve {}: {e}", files.display()),
        },
    }
    tauri::async_runtime::spawn_blocking(move || {
        if staging.exists() {
            if let Err(e) = std::fs::remove_dir_all(&staging) {
                log::warn!("chat: cannot empty {}: {e}", staging.display());
            }
        }
        match evict(&files, CACHE_LIMIT, None, SystemTime::now()) {
            Ok(removed) if !removed.is_empty() => {
                log::info!("chat: {} cached file(s) removed to keep the cache small", removed.len());
            }
            Ok(_) => {}
            Err(e) => log::warn!("chat: cannot tidy {}: {e}", files.display()),
        }
    });
}

/// Files dropped on a window. They go to its composer when it reports one
/// open; otherwise the drop belongs to the screen underneath and chat leaves
/// it alone. The window hears `chat:files-staged` with what staged and what
/// did not.
pub fn dropped(app: &AppHandle, label: &str, paths: &[PathBuf]) {
    if !matches!(label, "main" | "chat") || paths.is_empty() {
        return;
    }
    let Some(chat) = app.try_state::<ChatState>() else {
        return;
    };
    if !chat.composer_open(label) {
        return;
    }
    let (app, label, paths) = (app.clone(), label.to_string(), paths.to_vec());
    tauri::async_runtime::spawn(async move {
        let mut files = Vec::new();
        let mut refused = Vec::new();
        for (index, path) in paths.into_iter().enumerate() {
            let name = display_name(&path);
            if index >= MAX_ATTACHMENTS {
                let error = AppError::InvalidInput(format!(
                    "a message carries at most {MAX_ATTACHMENTS} files"
                ));
                refused.push(refusal(&name, &error));
                continue;
            }
            match stage_from_disk(&app, path, ORIGIN_FILE).await {
                Ok(file) => files.push(file),
                Err(e) => {
                    log::info!("chat: the dropped file {name} was not staged: {e}");
                    refused.push(refusal(&name, &e));
                }
            }
        }
        if let Err(e) = app.emit_to(label.as_str(), EVENT_FILES_STAGED, FilesStaged { files, refused }) {
            log::debug!("cannot emit {EVENT_FILES_STAGED}: {e}");
        }
    });
}

fn refusal(name: &str, error: &AppError) -> Value {
    serde_json::json!({
        "name": name,
        "error": serde_json::to_value(error).unwrap_or(Value::Null),
    })
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

// ---------------------------------------------------------------------------
// Staging commands
// ---------------------------------------------------------------------------

/// The system file dialog, from the core, over the window that asked. All
/// or nothing: when one file cannot be staged, none is, and the refusal
/// names why. A cancelled dialog answers an empty list.
#[tauri::command]
pub async fn chat_pick_files(app: AppHandle, window: tauri::Window) -> Result<Vec<StagedFile>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .pick_files(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(Vec::new());
    };
    let paths: Vec<PathBuf> = picked
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();
    if paths.len() > MAX_ATTACHMENTS {
        return Err(AppError::InvalidInput(format!(
            "a message carries at most {MAX_ATTACHMENTS} files"
        )));
    }
    let mut staged: Vec<StagedFile> = Vec::new();
    for path in paths {
        match stage_from_disk(&app, path, ORIGIN_FILE).await {
            Ok(file) => staged.push(file),
            Err(e) => {
                for file in &staged {
                    forget_staged(&app, &file.handle);
                }
                return Err(e);
            }
        }
    }
    Ok(staged)
}

/// An item of the Media screen. A TGA or BMP screenshot goes as a PNG:
/// chat shows PNG and JPEG pictures, and the rest would arrive as a file.
#[tauri::command]
pub async fn chat_stage_media(app: AppHandle, media_id: String) -> Result<StagedFile> {
    let worker = app.clone();
    let (staged, file) = blocking("staging a media item", move || {
        let state = worker.state::<AppState>();
        let paths = state.paths()?;
        let secret = state.settings()?.online_token;
        let item = media::find_item(&state, &media_id)?;
        let source = media::media_file(&state, &item)?;
        let size = file_size(&source)?;
        let mut name = format!("{}.{}", item.name, item.extension);
        check_size(&name, size)?;
        let mut bytes = read_bounded(&source, &name)?;
        let extension = item.extension.to_ascii_lowercase();
        if item.kind == "screenshots" && matches!(extension.as_str(), "tga" | "bmp") {
            let format = if extension == "tga" {
                image::ImageFormat::Tga
            } else {
                image::ImageFormat::Bmp
            };
            bytes = to_png(&bytes, format)?;
            name = format!("{}.png", item.name);
        }
        stage_bytes(&staging_dir_of(&paths), &name, bytes, ORIGIN_MEDIA, secret.as_deref())
    })
    .await?;
    keep_staged(&app, &file.handle, staged);
    Ok(file)
}

/// The picture on the clipboard, as a PNG.
#[tauri::command]
pub async fn chat_stage_clipboard_image(app: AppHandle) -> Result<StagedFile> {
    let worker = app.clone();
    let (staged, file) = blocking("staging the clipboard", move || {
        let state = worker.state::<AppState>();
        let paths = state.paths()?;
        let secret = state.settings()?.online_token;
        let image = worker
            .clipboard()
            .read_image()
            .map_err(|e| AppError::NotFound(format!("a picture on the clipboard ({e})")))?;
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 {
            return Err(AppError::NotFound("a picture on the clipboard".into()));
        }
        let png = rgba_to_png(width, height, image.rgba().to_vec())?;
        let name = format!("clipboard-{}.png", stamp());
        stage_bytes(&staging_dir_of(&paths), &name, png, ORIGIN_CLIPBOARD, secret.as_deref())
    })
    .await?;
    keep_staged(&app, &file.handle, staged);
    Ok(file)
}

/// Takes a staged file back. A message in the outbox that carries it keeps
/// it until it is sent.
#[tauri::command]
pub async fn chat_unstage(app: AppHandle, handle: String) -> Result<()> {
    let handle = path_segment(&handle)?.to_string();
    let held = app.state::<ChatState>().outbox().holds_attachment(&handle);
    if !held {
        forget_staged(&app, &handle);
    }
    Ok(())
}

/// Stages one file from disk off the async runtime and keeps it.
async fn stage_from_disk(app: &AppHandle, source: PathBuf, origin: &'static str) -> Result<StagedFile> {
    let state = app.state::<AppState>();
    let config_root = state.config_root.clone();
    let paths = state.paths()?;
    let secret = state.settings()?.online_token;
    let (staged, file) = blocking("staging a file", move || {
        stage_file(&paths, &config_root, secret.as_deref(), &source, origin)
    })
    .await?;
    keep_staged(app, &file.handle, staged);
    Ok(file)
}

fn keep_staged(app: &AppHandle, handle: &str, staged: Staged) {
    app.state::<ChatState>()
        .staged()
        .insert(handle.to_string(), staged);
}

/// Drops a staged file and its copy.
fn forget_staged(app: &AppHandle, handle: &str) {
    let staged = app.state::<ChatState>().staged().remove(handle);
    if let Some(staged) = staged {
        remove_quietly(&staged.path);
    }
}

/// The staged files of a message the player discarded.
pub(super) fn drop_staged(app: &AppHandle, handles: &[String]) {
    for handle in handles {
        let held = app.state::<ChatState>().outbox().holds_attachment(handle);
        if !held {
            forget_staged(app, handle);
        }
    }
}

/// The files of a message that went out: each staged copy becomes the cached
/// copy of the file id the service gave it, so the sender's own pictures
/// show without a download.
pub(super) fn settle_sent(app: &AppHandle, uploaded: Vec<(String, String)>) {
    if uploaded.is_empty() {
        return;
    }
    let Ok(dir) = files_dir(app) else {
        return;
    };
    let chat = app.state::<ChatState>();
    let mut moves = Vec::new();
    for (handle, file_id) in uploaded {
        // Another queued message still carries it: it stays staged.
        if chat.outbox().holds_attachment(&handle) {
            continue;
        }
        let staged = chat.staged().remove(&handle);
        if let Some(staged) = staged {
            moves.push((staged.path, dir.join(file_id)));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        for (from, to) in moves {
            if let Err(e) = adopt(&from, &to) {
                log::debug!("chat: cannot keep {} as {}: {e}", from.display(), to.display());
                remove_quietly(&from);
            }
        }
    });
}

/// Moves a staged copy into the cache, unless the cache has the file.
fn adopt(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        return std::fs::remove_file(from);
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from, to)
}

// ---------------------------------------------------------------------------
// Staging, the pure part
// ---------------------------------------------------------------------------

/// Stages one file from disk. Every refusal comes before the bytes are read:
/// the session file, a folder, anything larger than a chat file may be.
pub(crate) fn stage_file(
    paths: &DataPaths,
    config_root: &Path,
    secret: Option<&str>,
    source: &Path,
    origin: &str,
) -> Result<(Staged, StagedFile)> {
    let name = display_name(source);
    if is_session_file(config_root, source) {
        return Err(AppError::InvalidInput(format!(
            "{name} holds the JKNet session and is never sent"
        )));
    }
    let size = file_size(source)?;
    check_size(&name, size)?;
    let bytes = read_bounded(source, &name)?;
    stage_bytes(&staging_dir_of(paths), &name, bytes, origin, secret)
}

/// Stages bytes: strips the metadata of a picture, writes the copy under
/// `staging` and hashes it.
///
/// `secret` is the session token: bytes that hold it are refused whatever
/// the file is called, which covers a copy or a link of `settings.json`
/// under another name.
pub(crate) fn stage_bytes(
    staging: &Path,
    name: &str,
    bytes: Vec<u8>,
    origin: &str,
    secret: Option<&str>,
) -> Result<(Staged, StagedFile)> {
    let name = sanitize_name(name);
    check_size(&name, bytes.len() as u64)?;
    if bytes.is_empty() {
        return Err(AppError::InvalidInput(format!("{name} is empty")));
    }
    if let Some(secret) = secret.map(str::trim).filter(|secret| secret.len() >= 16) {
        if contains(&bytes, secret.as_bytes()) {
            return Err(AppError::InvalidInput(format!(
                "{name} holds the JKNet session and is never sent"
            )));
        }
    }
    let bytes = strip_metadata(&bytes).unwrap_or(bytes);
    let class = classify(&name, &bytes);
    let (width, height) = match (class, picture_size(&bytes)) {
        ("image", Some((width, height))) => (Some(width), Some(height)),
        _ => (None, None),
    };
    let sha256 = crate::bundles::sha256_hex(&bytes);
    let handle = new_client_id();
    std::fs::create_dir_all(staging)
        .map_err(|e| AppError::io_path("cannot create", staging, e))?;
    let path = staging.join(&handle);
    std::fs::write(&path, &bytes).map_err(|e| AppError::io_path("cannot write", &path, e))?;
    let size = bytes.len() as u64;
    let staged = Staged {
        path,
        name: name.clone(),
        size,
        sha256,
        meta: Some(FileMeta {
            width,
            height,
            duration_ms: None,
            origin: Some(origin.to_string()),
        }),
    };
    let file = StagedFile {
        handle,
        name,
        size,
        class_guess: class.to_string(),
        width,
        height,
        origin: origin.to_string(),
    };
    Ok((staged, file))
}

/// Whether `source` is `settings.json` of the config root, or one of its
/// temporary siblings (`settings.<id>.tmp`): the file with the session token.
/// Links and junctions are followed first.
pub(crate) fn is_session_file(config_root: &Path, source: &Path) -> bool {
    let resolved = std::fs::canonicalize(source).ok();
    let root = std::fs::canonicalize(config_root).ok();
    let is_session = |path: &Path| {
        let in_root = path.parent().is_some_and(|parent| {
            parent == config_root || root.as_deref().is_some_and(|root| parent == root)
        });
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        in_root && name.starts_with("settings.")
    };
    is_session(source) || resolved.as_deref().is_some_and(is_session)
}

fn check_size(name: &str, size: u64) -> Result<()> {
    if size > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{name} is {:.1} MiB, and a chat file is at most 25 MiB",
            size as f64 / (1024.0 * 1024.0)
        )));
    }
    Ok(())
}

fn file_size(path: &Path) -> Result<u64> {
    let meta = std::fs::metadata(path).map_err(|e| AppError::io_path("cannot read", path, e))?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!("{} is not a file", display_name(path))));
    }
    Ok(meta.len())
}

/// Reads a whole file of at most [`MAX_FILE_BYTES`], even one that grows
/// while it is read.
fn read_bounded(path: &Path, name: &str) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::io_path("cannot read", path, e))?;
    check_size(name, bytes.len() as u64)?;
    Ok(bytes)
}

/// The first bytes of a file, what a class is told by.
fn read_head(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut head = Vec::new();
    file.take(limit)
        .read_to_end(&mut head)
        .map_err(|e| AppError::io_path("cannot read", path, e))?;
    Ok(head)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

/// `2026-09-26-143205` for the name of a clipboard picture.
fn stamp() -> String {
    timestamp::now_rfc3339()
        .trim_end_matches('Z')
        .replace('T', "-")
        .replace(':', "")
}

/// A picture of the clipboard as a PNG; without its alpha channel when that
/// is opaque, which is what a screenshot is, and half the size.
fn rgba_to_png(width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<u8>> {
    let picture = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| AppError::Image("the clipboard picture has the wrong size".into()))?;
    let opaque = picture.pixels().all(|pixel| pixel.0[3] == u8::MAX);
    let picture = image::DynamicImage::ImageRgba8(picture);
    let picture = if opaque {
        image::DynamicImage::ImageRgb8(picture.to_rgb8())
    } else {
        picture
    };
    let mut png = Vec::new();
    picture.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(png)
}

/// A TGA or BMP screenshot re-encoded as a PNG.
fn to_png(bytes: &[u8], format: image::ImageFormat) -> Result<Vec<u8>> {
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PICTURE_SIDE);
    limits.max_image_height = Some(MAX_PICTURE_SIDE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let picture = reader.decode()?;
    let mut png = Vec::new();
    picture.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(png)
}

// ---------------------------------------------------------------------------
// Names and classes
// ---------------------------------------------------------------------------

/// The name the service will keep, cleaned the same way: no path
/// separators, no control or bidi characters, no trailing dots or spaces,
/// no reserved Windows device name, at most 120 characters.
pub(crate) fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !is_unsafe_name_char(*c))
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim_start().to_string();
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if cleaned.is_empty() || reserved {
        "file".to_string()
    } else {
        cleaned
    }
}

fn is_unsafe_name_char(c: char) -> bool {
    matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        || c.is_control()
        || matches!(c, '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// The final extension, lower case, ignoring the trailing dots and spaces
/// Windows drops from a name anyway.
fn extension(name: &str) -> Option<String> {
    let name = name.trim_end_matches(['.', ' ']);
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let (_, extension) = file.rsplit_once('.')?;
    (!extension.is_empty()).then(|| extension.to_ascii_lowercase())
}

/// The class the service gives bytes, told the same way from the name and
/// the first bytes. A program is told first, and an SVG is never a picture.
pub(crate) fn classify(name: &str, head: &[u8]) -> &'static str {
    if is_program(name, head) {
        return "executable";
    }
    if picture_type(head).is_some() {
        return "image";
    }
    if head.get(4..8) == Some(&b"ftyp"[..]) || head.starts_with(b"\x1A\x45\xDF\xA3") {
        return "video";
    }
    if archive_kind(head).is_some() {
        return "archive";
    }
    match extension(name).as_deref() {
        Some("dm_25" | "dm_26" | "dm_15") => "demo",
        Some("cfg") if is_text(head) => "config",
        _ => "other",
    }
}

/// Whether bytes are a program, or a name that Windows would run.
fn is_program(name: &str, head: &[u8]) -> bool {
    head.starts_with(b"MZ")
        || head.starts_with(b"\x7FELF")
        || head.starts_with(b"#!")
        || MACH_O.iter().any(|magic| head.starts_with(magic))
        || extension(name).is_some_and(|extension| PROGRAM_EXTENSIONS.contains(&extension.as_str()))
}

/// UTF-8 without NUL. A multi-byte character cut by the end of the head is
/// not a reason to call the file binary.
fn is_text(head: &[u8]) -> bool {
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

/// `png`, `jpeg`, `gif` or `webp`, by the signature.
fn picture_type(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(PNG_SIGNATURE) {
        Some("png")
    } else if head.starts_with(b"\xFF\xD8\xFF") {
        Some("jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("gif")
    } else if head.starts_with(b"RIFF") && head.get(8..12) == Some(&b"WEBP"[..]) {
        Some("webp")
    } else {
        None
    }
}

/// `zip` (a pk3 too), `rar` or `7z`, by the signature.
fn archive_kind(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"PK\x03\x04") {
        Some("zip")
    } else if head.starts_with(b"Rar!\x1A\x07") {
        Some("rar")
    } else if head.starts_with(b"7z\xBC\xAF\x27\x1C") {
        Some("7z")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Picture metadata
// ---------------------------------------------------------------------------

/// The picture without what it records about its taking, or `None` when the
/// bytes are not a JPEG or a PNG.
///
/// A JPEG loses `APP1` (Exif, with GPS and the camera; XMP), `APP13`
/// (Photoshop, IPTC), comments, the `MPF` index of the pictures stored after
/// the first one, and whatever follows its end — which is where those
/// pictures, with their own Exif, are. The one thing kept of Exif is the
/// orientation, rewritten as a block of its own, so a photo taken upright
/// does not arrive on its side. A PNG loses `eXIf`, `tEXt`, `iTXt`, `zTXt`
/// and whatever follows `IEND`. A structure that breaks is cut where it
/// breaks: nothing after it can be read to be checked.
pub(crate) fn strip_metadata(bytes: &[u8]) -> Option<Vec<u8>> {
    match picture_type(bytes)? {
        "jpeg" => Some(strip_jpeg(bytes)),
        "png" => Some(strip_png(bytes)),
        _ => None,
    }
}

fn strip_jpeg(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[..2]);
    let mut pos = 2;
    let mut orientation_kept = false;
    while pos < bytes.len() {
        // What sits between segments and is not a marker is junk a decoder
        // skips as well.
        if bytes[pos] != 0xFF {
            pos += 1;
            continue;
        }
        while bytes.get(pos) == Some(&0xFF) {
            pos += 1;
        }
        let Some(&marker) = bytes.get(pos) else {
            break;
        };
        pos += 1;
        match marker {
            0xD9 => {
                out.extend_from_slice(&[0xFF, 0xD9]);
                break;
            }
            0x00 => {}
            0x01 | 0xD0..=0xD7 => out.extend_from_slice(&[0xFF, marker]),
            _ => {
                let Some(length) = bytes.get(pos..pos + 2) else {
                    break;
                };
                let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
                let Some(segment) = bytes.get(pos..pos + length).filter(|_| length >= 2) else {
                    break;
                };
                pos += length;
                let payload = &segment[2..];
                if drops_segment(marker, payload) {
                    if marker == 0xE1 && !orientation_kept {
                        if let Some(orientation) = exif_orientation(payload) {
                            out.extend_from_slice(&orientation_segment(orientation));
                            orientation_kept = true;
                        }
                    }
                } else {
                    out.extend_from_slice(&[0xFF, marker]);
                    out.extend_from_slice(segment);
                }
                if marker == 0xDA {
                    let start = pos;
                    pos = scan_end(bytes, pos);
                    out.extend_from_slice(&bytes[start..pos]);
                }
            }
        }
    }
    out
}

/// The end of the entropy-coded data of a scan: the next marker that is not
/// a stuffed byte, a restart or padding.
fn scan_end(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() {
        if bytes[pos] == 0xFF
            && bytes
                .get(pos + 1)
                .is_some_and(|next| !matches!(next, 0x00 | 0xD0..=0xD7 | 0xFF))
        {
            break;
        }
        pos += 1;
    }
    pos
}

/// The JPEG segments that record where, when and with what a picture was
/// taken.
fn drops_segment(marker: u8, payload: &[u8]) -> bool {
    match marker {
        0xE1 | 0xED | 0xFE => true,
        0xE2 => payload.starts_with(b"MPF\0"),
        _ => false,
    }
}

/// The orientation of an Exif block, when it turns the picture.
fn exif_orientation(payload: &[u8]) -> Option<u16> {
    let tiff = payload.strip_prefix(b"Exif\0\0")?;
    let big = match tiff.get(..4)? {
        b"MM\0*" => true,
        b"II*\0" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = tiff.get(at..at + 2)?;
        Some(if big {
            u16::from_be_bytes([b[0], b[1]])
        } else {
            u16::from_le_bytes([b[0], b[1]])
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = tiff.get(at..at + 4)?;
        let b = [b[0], b[1], b[2], b[3]];
        Some(if big { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
    };
    let ifd = usize::try_from(u32_at(4)?).ok()?;
    let count = usize::from(u16_at(ifd)?);
    (0..count.min(512)).find_map(|index| {
        let entry = ifd + 2 + index * 12;
        (u16_at(entry)? == 0x0112)
            .then(|| u16_at(entry + 8))
            .flatten()
            .filter(|value| (2..=8).contains(value))
    })
}

/// An `APP1` Exif block that records an orientation and nothing else.
fn orientation_segment(orientation: u16) -> Vec<u8> {
    let mut payload = Vec::with_capacity(32);
    payload.extend_from_slice(b"Exif\0\0");
    // Big-endian TIFF, IFD0 right after the header, one entry: Orientation,
    // SHORT, one value, padded to four bytes; no next IFD.
    payload.extend_from_slice(b"MM\0*");
    payload.extend_from_slice(&8u32.to_be_bytes());
    payload.extend_from_slice(&1u16.to_be_bytes());
    payload.extend_from_slice(&0x0112u16.to_be_bytes());
    payload.extend_from_slice(&3u16.to_be_bytes());
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend_from_slice(&orientation.to_be_bytes());
    payload.extend_from_slice(&[0, 0]);
    payload.extend_from_slice(&0u32.to_be_bytes());
    let mut segment = vec![0xFF, 0xE1];
    segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    segment.extend_from_slice(&payload);
    segment
}

fn strip_png(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(PNG_SIGNATURE);
    let mut pos = PNG_SIGNATURE.len();
    while let Some(header) = bytes.get(pos..pos + 8) {
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let kind = &header[4..8];
        let Some(chunk) = pos
            .checked_add(12)
            .and_then(|end| end.checked_add(length))
            .and_then(|end| bytes.get(pos..end))
        else {
            break;
        };
        pos += chunk.len();
        if !matches!(kind, b"eXIf" | b"tEXt" | b"iTXt" | b"zTXt") {
            out.extend_from_slice(chunk);
        }
        if kind == b"IEND" {
            break;
        }
    }
    out
}

/// The width and height of a PNG, JPEG, GIF or WebP picture, when both are
/// what the service accepts.
pub(crate) fn picture_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let be32 = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at + 4)?;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    let le16 = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at + 2)?;
        Some(u32::from(u16::from_le_bytes([b[0], b[1]])))
    };
    let size = match picture_type(bytes)? {
        "png" if bytes.get(12..16) == Some(&b"IHDR"[..]) => (be32(16)?, be32(20)?),
        "gif" => (le16(6)?, le16(8)?),
        "jpeg" => jpeg_size(bytes)?,
        "webp" => webp_size(bytes)?,
        _ => return None,
    };
    let fits = |side: u32| (1..=MAX_PICTURE_SIDE).contains(&side);
    (fits(size.0) && fits(size.1)).then_some(size)
}

/// The size a JPEG's start-of-frame declares.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut pos = 2;
    loop {
        while *bytes.get(pos)? != 0xFF {
            pos += 1;
        }
        while *bytes.get(pos)? == 0xFF {
            pos += 1;
        }
        let marker = *bytes.get(pos)?;
        pos += 1;
        match marker {
            0xD9 | 0xDA => return None,
            0x00 | 0x01 | 0xD0..=0xD7 => continue,
            _ => {}
        }
        let length = usize::from(u16::from_be_bytes([*bytes.get(pos)?, *bytes.get(pos + 1)?]));
        if length < 2 {
            return None;
        }
        if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let height = u16::from_be_bytes([*bytes.get(pos + 3)?, *bytes.get(pos + 4)?]);
            let width = u16::from_be_bytes([*bytes.get(pos + 5)?, *bytes.get(pos + 6)?]);
            return Some((u32::from(width), u32::from(height)));
        }
        pos += length;
    }
}

/// The canvas of a WebP picture: lossy, lossless or extended.
fn webp_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let le24 = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at + 3)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], 0]))
    };
    match bytes.get(12..16)? {
        b"VP8 " => {
            let b = bytes.get(26..30)?;
            let width = u32::from(u16::from_le_bytes([b[0], b[1]]) & 0x3FFF);
            let height = u32::from(u16::from_le_bytes([b[2], b[3]]) & 0x3FFF);
            Some((width, height))
        }
        b"VP8L" => {
            let b = bytes.get(21..25)?;
            let bits = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        }
        b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// Registers one staged file for the conversation and uploads its bytes,
/// with `chat:upload` along the way. Answers the file id.
pub(super) async fn upload(
    app: &AppHandle,
    online: &OnlineClient,
    ctx: &OnlineContext,
    conversation_id: &str,
    handle: &str,
    staged: &Staged,
) -> Result<String> {
    let progress_app = app.clone();
    let progress_handle = handle.to_string();
    let total = staged.size;
    let mut sent = 0u64;
    let mut last: Option<Instant> = None;
    let on_chunk = move |read: u64| {
        sent += read;
        let now = Instant::now();
        if sent >= total || last.is_none_or(|at| now.duration_since(at) >= PROGRESS_EVERY) {
            last = Some(now);
            emit(
                &progress_app,
                EVENT_UPLOAD,
                UploadProgress {
                    handle: progress_handle.clone(),
                    sent,
                    total,
                },
            );
        }
    };
    noted(app, put_staged(online, ctx, conversation_id, staged, on_chunk).await)
}

/// Registers a staged file and uploads its bytes unless the account stored
/// the same ones already. `on_chunk` hears every chunk that goes up.
pub(crate) async fn put_staged(
    online: &OnlineClient,
    ctx: &OnlineContext,
    conversation_id: &str,
    staged: &Staged,
    on_chunk: impl FnMut(u64) + Send + 'static,
) -> Result<String> {
    let registration = online
        .chat_register_file(
            ctx,
            conversation_id,
            &staged.name,
            staged.size,
            &staged.sha256,
            staged.meta.as_ref(),
        )
        .await?;
    let file_id = registration.file.id;
    if !registration.needs_upload {
        return Ok(file_id);
    }
    let body = crate::bundles::publish::file_body(&staged.path, on_chunk).await?;
    online
        .chat_upload_file(ctx, &file_id, staged.size, body)
        .await?;
    Ok(file_id)
}

// ---------------------------------------------------------------------------
// Download and the cache
// ---------------------------------------------------------------------------

/// Where the bytes of a file are here. `download` fetches one that is not;
/// the answer is then `downloading`, and `chat:download` tells the rest.
#[tauri::command]
pub async fn chat_file_local(app: AppHandle, file_id: String, download: bool) -> Result<FileLocal> {
    let file_id = path_segment(&file_id)?.to_string();
    let path = files_dir(&app)?.join(&file_id);
    if path.is_file() {
        shown(&app, &path);
        return Ok(FileLocal {
            status: LocalStatus::Cached,
            path: Some(path.display().to_string()),
        });
    }
    let status = {
        let chat = app.state::<ChatState>();
        let book = chat.files();
        if book.gone.contains(&file_id) {
            Some(LocalStatus::Gone)
        } else if book.downloading.contains(&file_id) {
            Some(LocalStatus::Downloading)
        } else if !download {
            Some(LocalStatus::Remote)
        } else {
            None
        }
    };
    if let Some(status) = status {
        return Ok(FileLocal { status, path: None });
    }
    account(&app)?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ensure_cached(&handle, &file_id).await {
            log::debug!("chat: the download of {file_id} ended: {e}");
        }
    });
    Ok(FileLocal {
        status: LocalStatus::Downloading,
        path: None,
    })
}

/// The cached copy of a file, downloaded first when there is none. A second
/// caller waits for the download the first one started.
pub(crate) async fn ensure_cached(app: &AppHandle, file_id: &str) -> Result<PathBuf> {
    let file_id = path_segment(file_id)?.to_string();
    let dir = files_dir(app)?;
    let target = dir.join(&file_id);
    let started = Instant::now();
    loop {
        if target.is_file() {
            shown(app, &target);
            return Ok(target);
        }
        let claimed = {
            let chat = app.state::<ChatState>();
            let mut book = chat.files();
            if book.gone.contains(&file_id) {
                return Err(gone_error());
            }
            book.downloading.insert(file_id.clone())
        };
        if claimed {
            break;
        }
        if started.elapsed() > DOWNLOAD_WAIT {
            return Err(AppError::Busy(format!("the download of {file_id} takes too long")));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _claim = Claim {
        app: app.clone(),
        file_id: file_id.clone(),
    };
    let ctx = account(app)?;
    let online = app.state::<OnlineClient>();
    let progress_app = app.clone();
    let progress_id = file_id.clone();
    let mut last: Option<Instant> = None;
    let mut report = move |received: u64, total: u64| {
        let now = Instant::now();
        if last.is_none_or(|at| now.duration_since(at) >= PROGRESS_EVERY) {
            last = Some(now);
            emit(
                &progress_app,
                EVENT_DOWNLOAD,
                DownloadProgress {
                    file_id: progress_id.clone(),
                    received,
                    total,
                    path: None,
                    status: LocalStatus::Downloading,
                },
            );
        }
    };
    let result = noted(app, fetch(&online, &ctx, &dir, &file_id, &mut report).await);
    match result {
        Ok(path) => {
            let (keep, cache) = (path.clone(), dir.clone());
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = evict(&cache, CACHE_LIMIT, Some(&keep), SystemTime::now()) {
                    log::warn!("chat: cannot tidy {}: {e}", cache.display());
                }
            });
            shown(app, &path);
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            emit(
                app,
                EVENT_DOWNLOAD,
                DownloadProgress {
                    file_id,
                    received: size,
                    total: size,
                    path: Some(path.display().to_string()),
                    status: LocalStatus::Cached,
                },
            );
            Ok(path)
        }
        Err(e) => {
            let status = status_after(&e);
            if status == LocalStatus::Gone {
                app.state::<ChatState>().files().gone.insert(file_id.clone());
                log::info!("chat: the file {file_id} is no longer on the service");
            } else {
                log::warn!("chat: cannot download {file_id}: {e}");
            }
            emit(
                app,
                EVENT_DOWNLOAD,
                DownloadProgress {
                    file_id,
                    received: 0,
                    total: 0,
                    path: None,
                    status,
                },
            );
            Err(e)
        }
    }
}

/// Downloads one file into `dir` as `<fileId>`, resuming `<fileId>.part`
/// with a range. The bytes are checked against the SHA-256 the service sends
/// as the `ETag` before they become the cached copy; a partial file that
/// fails the check goes, so the next attempt starts over.
pub(crate) async fn fetch(
    online: &OnlineClient,
    ctx: &OnlineContext,
    dir: &Path,
    file_id: &str,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<PathBuf> {
    let file_id = path_segment(file_id)?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::io_path("cannot create", dir, e))?;
    let target = dir.join(file_id);
    if tokio::fs::metadata(&target).await.is_ok_and(|meta| meta.is_file()) {
        return Ok(target);
    }
    let partial = dir.join(format!("{file_id}{PART_SUFFIX}"));
    let have = tokio::fs::metadata(&partial)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    let response = match online.chat_file_content(ctx, file_id, have).await {
        // A partial file the service will not continue, a range past its
        // end for one: start over, once.
        Err(e) if have > 0 && restarts(&e) => {
            log::info!("chat: the partial download of {file_id} was refused ({e}), starting over");
            let _ = tokio::fs::remove_file(&partial).await;
            online.chat_file_content(ctx, file_id, 0).await?
        }
        other => other?,
    };
    // A service that ignored the range sends the whole file: the partial
    // one goes, or two copies would be spliced.
    let resuming = have > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
    let expected = etag_sha256(response.headers());
    let total = if resuming {
        range_total(response.headers()).or_else(|| response.content_length().map(|rest| have + rest))
    } else {
        response.content_length()
    };
    let mut received = if resuming { have } else { 0 };
    let mut sink = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resuming)
        .truncate(!resuming)
        .open(&partial)
        .await
        .map_err(|e| AppError::io_path("cannot create", &partial, e))?;
    progress(received, total.unwrap_or(0));
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("the download stopped: {e}")))?;
        received += chunk.len() as u64;
        if received > MAX_FILE_BYTES {
            drop(sink);
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(AppError::Network(format!(
                "the file {file_id} is larger than a chat file may be"
            )));
        }
        sink.write_all(&chunk)
            .await
            .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
        progress(received, total.unwrap_or(0));
    }
    sink.flush()
        .await
        .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
    drop(sink);
    if let Some(total) = total.filter(|total| *total != received) {
        return Err(AppError::Network(format!(
            "the download of {file_id} stopped at {received} of {total} bytes"
        )));
    }
    if let Some(expected) = expected {
        let hashed = partial.clone();
        let actual = tauri::async_runtime::spawn_blocking(move || crate::bundles::sha256_of(&hashed))
            .await
            .map_err(|e| AppError::State(format!("the hash of {file_id} did not finish: {e}")))??;
        if actual != expected {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(AppError::Network(format!(
                "the download of {file_id} does not match its hash"
            )));
        }
    }
    tokio::fs::rename(&partial, &target)
        .await
        .map_err(|e| AppError::io_path("cannot finish", &target, e))?;
    Ok(target)
}

/// Whether a refusal of a ranged download means "start over": not one that
/// says the file, the account or the chat API is gone.
fn restarts(error: &AppError) -> bool {
    match error {
        AppError::Online { code, .. } => {
            !is_gone(error)
                && !is_chat_unavailable(error)
                && !matches!(code.as_str(), "unauthorized" | "rate_limited")
        }
        _ => false,
    }
}

/// The service no longer has the file, or this account may no longer read
/// it: either way it cannot be fetched.
fn is_gone(error: &AppError) -> bool {
    matches!(error, AppError::Online { code, .. } if code == "file_gone" || code == "not_found")
}

/// What a failed download leaves a file as: `gone` for good, `remote` when
/// another attempt may work.
pub(crate) fn status_after(error: &AppError) -> LocalStatus {
    if is_gone(error) {
        LocalStatus::Gone
    } else {
        LocalStatus::Remote
    }
}

fn gone_error() -> AppError {
    AppError::Online {
        code: "file_gone".into(),
        message: "the file is no longer stored".into(),
    }
}

/// The SHA-256 the service sends as the `ETag` of a chat file.
fn etag_sha256(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(ETAG)?.to_str().ok()?.trim();
    let value = value.strip_prefix("W/").unwrap_or(value);
    let value = value.trim_matches('"').to_ascii_lowercase();
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}

/// The whole size a `Content-Range: bytes a-b/total` names.
fn range_total(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    value.rsplit_once('/')?.1.trim().parse().ok()
}

/// A cached file was shown: it moves to the end of the eviction queue, and
/// the asset protocol may serve it by this very path.
fn shown(app: &AppHandle, path: &Path) {
    touch(path);
    if let Err(e) = app.asset_protocol_scope().allow_file(path) {
        log::warn!("chat: cannot serve {}: {e}", path.display());
    }
}

/// Moves the modification time to now. The cache evicts by it, because
/// Windows does not keep access times current by default.
fn touch(path: &Path) {
    let result = std::fs::File::options()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(SystemTime::now()));
    if let Err(e) = result {
        log::debug!("chat: cannot mark {} as shown: {e}", path.display());
    }
}

/// Keeps the cache under `limit`: partial downloads older than a day go,
/// then the files shown least recently, never `keep`. Answers what went.
pub(crate) fn evict(
    dir: &Path,
    limit: u64,
    keep: Option<&Path>,
    now: SystemTime,
) -> std::io::Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(removed),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let path = entry.path();
        let modified = meta.modified().unwrap_or(now);
        let is_part = path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(PART_SUFFIX));
        let age = now.duration_since(modified).unwrap_or_default();
        if is_part && age > STALE_PART {
            if std::fs::remove_file(&path).is_ok() {
                removed.push(path);
            }
            continue;
        }
        files.push((modified, meta.len(), path));
    }
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in files {
        if total <= limit {
            break;
        }
        if keep.is_some_and(|keep| keep == path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            removed.push(path);
        }
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/// Saves a file where the player says, through the core's save dialog over
/// the window that asked. A program, or an archive with programs inside or
/// one that cannot be looked into, is refused with [`CONFIRM_DANGER`] until
/// `confirmed`. The saved copy is marked as downloaded from the internet, so
/// Windows warns before it runs whatever it is. `None`: the dialog was
/// cancelled.
#[tauri::command]
pub async fn chat_file_save(
    app: AppHandle,
    window: tauri::Window,
    file_id: String,
    confirmed: bool,
) -> Result<Option<String>> {
    let file_id = path_segment(&file_id)?.to_string();
    let cached = ensure_cached(&app, &file_id).await?;
    let known = app.state::<ChatState>().files().known(&file_id);
    let name = sanitize_name(known.as_ref().map_or("file", |file| file.name.as_str()));
    let flagged = known.as_ref().is_some_and(|file| file.danger);
    let (checked, checked_name) = (cached.clone(), name.clone());
    let reasons = blocking("checking a file", move || {
        danger_reasons(&checked, &checked_name, flagged)
    })
    .await?;
    if !reasons.is_empty() && !confirmed {
        return Err(AppError::Online {
            code: CONFIRM_DANGER.into(),
            message: reasons.join("; "),
        });
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_file_name(&name)
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let Some(target) = rx.await.ok().flatten().and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    let saved = target.clone();
    blocking("saving a file", move || save_copy(&cached, &saved)).await?;
    log::info!("chat: saved the file {file_id} as {}", target.display());
    Ok(Some(target.display().to_string()))
}

/// Copies the cached file and marks the copy.
fn save_copy(cached: &Path, target: &Path) -> Result<()> {
    std::fs::copy(cached, target).map_err(|e| AppError::io_path("cannot save", target, e))?;
    if let Err(e) = mark_from_internet(target) {
        log::warn!("chat: cannot mark {} as downloaded: {e}", target.display());
    }
    Ok(())
}

/// Writes the `Zone.Identifier` stream a browser writes: SmartScreen and
/// Office then treat the file as one from the internet.
#[cfg(windows)]
pub(crate) fn mark_from_internet(path: &Path) -> std::io::Result<()> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    std::fs::write(PathBuf::from(stream), b"[ZoneTransfer]\r\nZoneId=3\r\n")
}

#[cfg(not(windows))]
pub(crate) fn mark_from_internet(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Why a file must be confirmed before it is saved; empty when it need not.
pub(crate) fn danger_reasons(path: &Path, name: &str, flagged: bool) -> Result<Vec<String>> {
    let head = read_head(path, 4096)?;
    let mut reasons = Vec::new();
    if flagged || is_program(name, &head) {
        reasons.push(format!("{name} is a program"));
    }
    match inspect_archive(path, &head) {
        ArchiveVerdict::Programs(entries) => {
            reasons.push(format!("the archive holds programs: {}", entries.join(", ")));
        }
        ArchiveVerdict::Unreadable => {
            reasons.push("the archive cannot be looked into".to_string());
        }
        ArchiveVerdict::NotArchive | ArchiveVerdict::Clean => {}
    }
    Ok(reasons)
}

/// What an archive holds, as far as the save is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveVerdict {
    NotArchive,
    Clean,
    /// The entries that are programs, the first twenty.
    Programs(Vec<String>),
    /// A RAR, which the launcher cannot read, or an archive that does not
    /// open: what it holds is unknown.
    Unreadable,
}

/// Lists the entries of a zip (a pk3 is one) or a 7z from their directory,
/// without unpacking anything, and names the ones that are programs.
pub(crate) fn inspect_archive(path: &Path, head: &[u8]) -> ArchiveVerdict {
    let names: Vec<String> = match archive_kind(head) {
        None => return ArchiveVerdict::NotArchive,
        Some("zip") => {
            let Ok(file) = std::fs::File::open(path) else {
                return ArchiveVerdict::Unreadable;
            };
            let Ok(archive) = zip::ZipArchive::new(std::io::BufReader::new(file)) else {
                return ArchiveVerdict::Unreadable;
            };
            crate::archive::names(&archive, crate::archive::MAX_ENTRIES)
        }
        Some("7z") => {
            let Ok(reader) = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
            else {
                return ArchiveVerdict::Unreadable;
            };
            reader
                .archive()
                .files
                .iter()
                .filter(|entry| !entry.is_directory)
                .take(crate::archive::MAX_ENTRIES)
                .map(|entry| entry.name.clone())
                .collect()
        }
        Some(_) => return ArchiveVerdict::Unreadable,
    };
    let programs: Vec<String> = names
        .into_iter()
        .filter(|name| is_program_entry(name))
        .take(20)
        .collect();
    if programs.is_empty() {
        ArchiveVerdict::Clean
    } else {
        ArchiveVerdict::Programs(programs)
    }
}

fn is_program_entry(name: &str) -> bool {
    extension(name).is_some_and(|extension| {
        PROGRAM_EXTENSIONS.contains(&extension.as_str())
            || PROGRAM_ENTRY_EXTENSIONS.contains(&extension.as_str())
    })
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Puts a demo or a screenshot into a client, where the Media screen finds
/// it: `home\<mod folder>\demos\` or `home\<mod folder>\screenshots\`, the
/// mod folder being the one the client plays. Answers the path.
#[tauri::command]
pub async fn chat_file_import(app: AppHandle, file_id: String, target: ImportTarget) -> Result<String> {
    let file_id = path_segment(&file_id)?.to_string();
    let kind = match target.kind.as_str() {
        "demo" => ImportKind::Demo,
        "screenshot" => ImportKind::Screenshot,
        other => {
            return Err(AppError::InvalidInput(format!(
                "a file is imported as a demo or a screenshot, not as {other:?}"
            )))
        }
    };
    let client_id = path_segment(&target.client_id)?.to_string();
    let cached = ensure_cached(&app, &file_id).await?;
    let known = app.state::<ChatState>().files().known(&file_id);
    let name = known.map_or_else(|| "file".to_string(), |file| file.name);
    let paths = app.state::<AppState>().paths()?;
    let placed = blocking("importing a file", move || {
        import_file(&paths, &client_id, kind, &name, &cached)
    })
    .await?;
    log::info!("chat: imported the file {file_id} as {}", placed.display());
    Ok(placed.display().to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImportKind {
    Demo,
    Screenshot,
}

fn import_file(
    paths: &DataPaths,
    client_id: &str,
    kind: ImportKind,
    name: &str,
    cached: &Path,
) -> Result<PathBuf> {
    let client = clients::read_record(paths, client_id)?;
    let engine = engines::require(&client.engine_id)?;
    let folder = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game)
        .unwrap_or("base");
    user_files::valid_folder(folder)?;
    let root = paths.client_home_dir(&client.id).join(folder);
    let head = read_head(cached, 4096)?;
    let target = import_destination(&root, kind, name, &head, client.game.demo_extensions())?;
    let parent = target.parent().unwrap_or(&root);
    std::fs::create_dir_all(parent).map_err(|e| AppError::io_path("cannot create", parent, e))?;
    let temp = parent.join(format!(".{}.importing", new_client_id()));
    std::fs::copy(cached, &temp).map_err(|e| AppError::io_path("cannot copy", &temp, e))?;
    std::fs::rename(&temp, &target).map_err(|e| {
        remove_quietly(&temp);
        AppError::io_path("cannot import", &target, e)
    })?;
    Ok(target)
}

/// Where an imported file lands inside the mod folder `root` of a client.
///
/// A demo keeps its name and must carry an extension of the client's game.
/// A screenshot must be a PNG or a JPEG and gets the extension its bytes
/// say. A name that starts with `jknet-` gets `chat-` in front, because the
/// Media screen leaves those names to the launcher's own files; a name that
/// is taken gets `-2`, `-3` and so on.
pub(crate) fn import_destination(
    root: &Path,
    kind: ImportKind,
    name: &str,
    head: &[u8],
    demo_extensions: &[&str],
) -> Result<PathBuf> {
    let name = sanitize_name(name);
    let (stem, dot_extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), extension.to_ascii_lowercase()),
        _ => (name.clone(), String::new()),
    };
    let (folder, extension) = match kind {
        ImportKind::Demo => {
            if is_program(&name, head) || !demo_extensions.contains(&dot_extension.as_str()) {
                return Err(AppError::InvalidInput(format!(
                    "{name} is not a demo of this client's game"
                )));
            }
            ("demos", dot_extension)
        }
        ImportKind::Screenshot => {
            let extension = match picture_type(head) {
                Some("png") => "png",
                Some("jpeg") => "jpg",
                _ => {
                    return Err(AppError::InvalidInput(format!(
                        "{name} is not a PNG or JPEG picture"
                    )))
                }
            };
            ("screenshots", extension.to_string())
        }
    };
    let stem = if stem.to_lowercase().starts_with("jknet-") {
        format!("chat-{stem}")
    } else {
        stem
    };
    let dir = root.join(folder);
    for attempt in 1..=1000u32 {
        let candidate = if attempt == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{attempt}.{extension}")
        };
        let path = dir.join(candidate);
        if !path.exists() {
            return Ok(path);
        }
    }
    Err(AppError::AlreadyExists(format!("{stem}.{extension}")))
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

fn staging_dir_of(paths: &DataPaths) -> PathBuf {
    paths.chat_cache_dir().join(STAGING_DIR)
}

fn files_dir_of(paths: &DataPaths) -> PathBuf {
    paths.chat_cache_dir().join(FILES_DIR)
}

fn files_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(files_dir_of(&app.state::<AppState>().paths()?))
}

fn remove_quietly(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::debug!("chat: cannot remove {}: {e}", path.display());
        }
    }
}

/// Runs disk work off the async runtime.
async fn blocking<T, F>(what: &'static str, job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::State(format!("{what} did not finish: {e}")))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::Cursor;

    /// A JPEG segment: marker, length, payload.
    pub fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0xFF, marker];
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// A little-endian Exif block with an orientation and a GPS position:
    /// 55° 45' 12.34" N.
    pub fn exif_with_gps(orientation: u16) -> Vec<u8> {
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II*\0");
        tiff.extend_from_slice(&8u32.to_le_bytes());
        // IFD0: Orientation, and the pointer to the GPS IFD.
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]);
        let gps_at: u32 = 8 + 2 + 2 * 12 + 4;
        tiff.extend_from_slice(&0x8825u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&gps_at.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        // The GPS IFD: GPSLatitudeRef N, GPSLatitude as three rationals.
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&0x0001u16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&2u32.to_le_bytes());
        tiff.extend_from_slice(b"N\0\0\0");
        let rationals_at: u32 = gps_at + 2 + 2 * 12 + 4;
        tiff.extend_from_slice(&0x0002u16.to_le_bytes());
        tiff.extend_from_slice(&5u16.to_le_bytes());
        tiff.extend_from_slice(&3u32.to_le_bytes());
        tiff.extend_from_slice(&rationals_at.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(&GPS_RATIONALS);
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        payload
    }

    /// The latitude as the rationals of [`exif_with_gps`] store it.
    pub const GPS_RATIONALS: [u8; 24] = [
        55, 0, 0, 0, 1, 0, 0, 0, 45, 0, 0, 0, 1, 0, 0, 0, 0xD2, 0x04, 0, 0, 100, 0, 0, 0,
    ];

    /// A 16 × 8 JPEG as a camera would write it: Exif with GPS, Photoshop
    /// data, a comment, and a second picture after the end.
    pub fn jpeg_with_gps() -> Vec<u8> {
        let mut picture = image::RgbImage::new(16, 8);
        for (x, y, pixel) in picture.enumerate_pixels_mut() {
            *pixel = image::Rgb([(x * 16) as u8, (y * 32) as u8, 90]);
        }
        let mut plain = Vec::new();
        image::DynamicImage::ImageRgb8(picture)
            .write_to(&mut Cursor::new(&mut plain), image::ImageFormat::Jpeg)
            .expect("encode");
        let mut out = plain[..2].to_vec();
        out.extend(segment(0xE1, &exif_with_gps(6)));
        out.extend(segment(0xED, b"Photoshop 3.0\08BIM\x04\x04 caption: garage"));
        out.extend(segment(0xFE, b"taken at home"));
        out.extend_from_slice(&plain[2..]);
        out.extend_from_slice(b"\xFF\xD8TRAILING-PICTURE-WITH-GPS");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = (data.len() as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        let crc = crc32(&chunk[4..]);
        chunk.extend_from_slice(&crc.to_be_bytes());
        chunk
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let picture = image::RgbImage::from_pixel(width, height, image::Rgb([200, 30, 30]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(picture)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode");
        out
    }

    fn set_age(path: &Path, now: SystemTime, age: Duration) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .and_then(|file| file.set_modified(now - age))
            .expect("the time moves");
    }

    fn zip_with(entries: &[&str]) -> Vec<u8> {
        use std::io::Write;
        let mut bytes = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut bytes));
            for entry in entries {
                writer
                    .start_file(*entry, zip::write::SimpleFileOptions::default())
                    .expect("an entry");
                writer.write_all(b"data").expect("its bytes");
            }
            writer.finish().expect("the directory");
        }
        bytes
    }

    #[test]
    fn a_jpeg_loses_its_exif_gps_and_keeps_its_picture_and_orientation() {
        let original = jpeg_with_gps();
        assert!(contains(&original, &GPS_RATIONALS));
        let stripped = strip_metadata(&original).expect("a JPEG");

        assert!(!contains(&stripped, &GPS_RATIONALS), "the GPS position is gone");
        assert!(!contains(&stripped, b"II*\0"), "the camera's Exif block is gone");
        assert!(!contains(&stripped, b"Photoshop"), "APP13 is gone");
        assert!(!contains(&stripped, b"taken at home"), "the comment is gone");
        assert!(!contains(&stripped, b"TRAILING"), "what followed the end is gone");
        assert!(stripped.ends_with(&[0xFF, 0xD9]));

        // The orientation survives as a block of its own.
        assert!(contains(&stripped, b"Exif\0\0MM\0*"));
        let app1 = stripped
            .windows(2)
            .position(|pair| pair == [0xFF, 0xE1])
            .expect("the orientation block");
        let length = usize::from(u16::from_be_bytes([stripped[app1 + 2], stripped[app1 + 3]]));
        assert_eq!(exif_orientation(&stripped[app1 + 4..app1 + 2 + length]), Some(6));

        let decoded = image::load_from_memory(&stripped).expect("still a picture");
        assert_eq!((decoded.width(), decoded.height()), (16, 8));
        assert_eq!(picture_size(&stripped), Some((16, 8)));
        assert_eq!(picture_size(&original), Some((16, 8)));
    }

    #[test]
    fn a_jpeg_without_a_turn_keeps_no_exif_at_all() {
        let turned = jpeg_with_gps();
        // Replace the Exif block by one that says "upright".
        let upright = segment(0xE1, &exif_with_gps(1));
        let old = segment(0xE1, &exif_with_gps(6));
        let at = turned.windows(old.len()).position(|w| w == old.as_slice()).expect("the block");
        let picture = [&turned[..at], &upright[..], &turned[at + old.len()..]].concat();
        let stripped = strip_metadata(&picture).expect("a JPEG");
        assert!(!contains(&stripped, b"Exif"));
        // Nothing but the picture changes when there is nothing to strip.
        assert_eq!(strip_metadata(&stripped), Some(stripped.clone()));
    }

    #[test]
    fn a_png_loses_its_text_and_exif_chunks() {
        let plain = png(4, 3);
        let ihdr_end = PNG_SIGNATURE.len() + 25;
        let mut marked = plain[..ihdr_end].to_vec();
        marked.extend(png_chunk(b"tEXt", b"Comment\0shot at 55.75N 37.61E"));
        marked.extend(png_chunk(b"iTXt", b"XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"));
        marked.extend(png_chunk(b"zTXt", b"Author\0\0x\x9c\x03\0\0\0\0\x01"));
        marked.extend(png_chunk(b"eXIf", &exif_with_gps(1)[6..]));
        marked.extend_from_slice(&plain[ihdr_end..]);
        marked.extend_from_slice(b"TRAILING");

        let stripped = strip_metadata(&marked).expect("a PNG");
        let gone: [&[u8]; 6] = [b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"TRAILING", &GPS_RATIONALS];
        for kind in gone {
            assert!(!contains(&stripped, kind), "{:?} survived", String::from_utf8_lossy(kind));
        }
        assert_eq!(stripped, plain, "exactly the picture the encoder wrote");
        let decoded = image::load_from_memory(&stripped).expect("still a picture");
        assert_eq!((decoded.width(), decoded.height()), (4, 3));
        assert_eq!(picture_size(&stripped), Some((4, 3)));
    }

    #[test]
    fn other_bytes_are_not_touched() {
        assert_eq!(strip_metadata(b"GIF89a\x02\0\x02\0"), None);
        assert_eq!(strip_metadata(b"just text"), None);
    }

    #[test]
    fn pictures_report_their_size() {
        assert_eq!(picture_size(b"GIF89a\x40\x01\xF0\x00rest"), Some((320, 240)));
        let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a".to_vec();
        lossy.extend_from_slice(&640u16.to_le_bytes());
        lossy.extend_from_slice(&480u16.to_le_bytes());
        assert_eq!(picture_size(&lossy), Some((640, 480)));
        let mut lossless = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        let bits: u32 = (100 - 1) | ((50 - 1) << 14);
        lossless.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(picture_size(&lossless), Some((100, 50)));
        let mut extended = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        extended.extend_from_slice(&[0x7F, 0x07, 0x00]);
        extended.extend_from_slice(&[0x37, 0x04, 0x00]);
        assert_eq!(picture_size(&extended), Some((1920, 1080)));
        // Beyond what the service accepts: no size at all.
        assert_eq!(picture_size(b"GIF89a\xFF\xFF\x01\x00"), None);
        assert_eq!(picture_size(b"not a picture"), None);
    }

    #[test]
    fn classes_follow_the_service() {
        assert_eq!(classify("shot.png", b"MZ\x90\0"), "executable", "a program named .png");
        assert_eq!(classify("run.sh", b"#!/bin/sh"), "executable");
        assert_eq!(classify("tool", b"\xCF\xFA\xED\xFE"), "executable");
        assert_eq!(classify("notes.txt.lnk", b"L\0\0\0"), "executable");
        assert_eq!(classify("setup.exe. ", b"text"), "executable", "Windows drops the dots");
        assert_eq!(classify("shot.jpg", b"\xFF\xD8\xFF\xE0"), "image");
        assert_eq!(classify("logo.svg", b"<svg xmlns"), "other", "an SVG is never a picture");
        assert_eq!(classify("clip.mp4", b"\0\0\0\x20ftypisom"), "video");
        assert_eq!(classify("clip.webm", b"\x1A\x45\xDF\xA3"), "video");
        assert_eq!(classify("maps.pk3", b"PK\x03\x04"), "archive");
        assert_eq!(classify("mods.7z", b"7z\xBC\xAF\x27\x1C"), "archive");
        assert_eq!(classify("duel.dm_26", b"\x01\x02"), "demo");
        assert_eq!(classify("binds.cfg", b"bind x \"say hi\"\n"), "config");
        assert_eq!(classify("binds.cfg", b"bind\0x"), "other");
        assert_eq!(classify("ru.cfg", &"бинд".as_bytes()[..7]), "config", "a cut character is still text");
        assert_eq!(classify("readme", b"hello"), "other");
    }

    #[test]
    fn names_are_cleaned_like_the_service_cleans_them() {
        assert_eq!(sanitize_name(r"..\..\evil/..\name.txt"), "....evil..name.txt");
        assert_eq!(sanitize_name("report.pdf\u{202E}exe.txt"), "report.pdfexe.txt");
        assert_eq!(sanitize_name("trailing. . "), "trailing");
        assert_eq!(sanitize_name("CON.txt"), "file");
        assert_eq!(sanitize_name("com7"), "file");
        assert_eq!(sanitize_name("compass.cfg"), "compass.cfg");
        assert_eq!(sanitize_name("  \u{0007} "), "file");
        assert_eq!(sanitize_name(&"x".repeat(300)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn staging_refuses_settings_json_and_its_temporary_siblings() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let root = temp.path().join("root");
        std::fs::create_dir_all(&root).expect("the config root");
        for name in ["settings.json", "settings.0123abcd.tmp", "notes.txt"] {
            std::fs::write(root.join(name), b"{}").expect("a file");
        }
        assert!(is_session_file(&root, &root.join("settings.json")));
        assert!(is_session_file(&root, &root.join("SETTINGS.JSON")));
        assert!(is_session_file(&root, &root.join("settings.0123abcd.tmp")));
        assert!(is_session_file(&root, &root.join(".").join("settings.json")));
        assert!(!is_session_file(&root, &root.join("notes.txt")));
        // A settings.json elsewhere is somebody's file, not the session.
        std::fs::write(temp.path().join("settings.json"), b"{}").expect("a file");
        assert!(!is_session_file(&root, &temp.path().join("settings.json")));

        let paths = DataPaths::new(temp.path().join("data"));
        let refused = stage_file(&paths, &root, None, &root.join("settings.json"), ORIGIN_FILE);
        assert!(matches!(refused, Err(AppError::InvalidInput(ref reason)) if reason.contains("session")));
        assert!(!staging_dir_of(&paths).exists(), "nothing was copied");
        let (staged, file) =
            stage_file(&paths, &root, None, &root.join("notes.txt"), ORIGIN_FILE).expect("staged");
        assert_eq!((file.name.as_str(), file.class_guess.as_str(), file.size), ("notes.txt", "other", 2));
        assert_eq!(std::fs::read(&staged.path).expect("the copy"), b"{}");
    }

    #[test]
    fn staging_refuses_the_session_token_an_empty_file_and_a_large_one() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let secret = "0123456789abcdef0123456789abcdef";
        let copy = format!("{{\"onlineToken\": \"{secret}\"}}").into_bytes();
        let refused = stage_bytes(temp.path(), "backup.txt", copy.clone(), ORIGIN_FILE, Some(secret));
        assert!(matches!(refused, Err(AppError::InvalidInput(_))));
        assert!(stage_bytes(temp.path(), "backup.txt", copy, ORIGIN_FILE, None).is_ok());
        assert!(stage_bytes(temp.path(), "empty.txt", Vec::new(), ORIGIN_FILE, None).is_err());

        let big = temp.path().join("big.mp4");
        std::fs::File::create(&big)
            .and_then(|file| file.set_len(MAX_FILE_BYTES + 1))
            .expect("a large file");
        let paths = DataPaths::new(temp.path().join("data"));
        let refused = stage_file(&paths, temp.path(), None, &big, ORIGIN_FILE);
        assert!(matches!(refused, Err(AppError::InvalidInput(ref reason)) if reason.contains("25 MiB")));
        assert!(stage_file(&paths, temp.path(), None, temp.path(), ORIGIN_FILE).is_err(), "a folder");
    }

    #[test]
    fn a_staged_picture_is_the_stripped_copy_and_its_hash() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let original = jpeg_with_gps();
        let (staged, file) =
            stage_bytes(temp.path(), "IMG_0001.JPG", original.clone(), ORIGIN_CLIPBOARD, None)
                .expect("staged");
        let copy = std::fs::read(&staged.path).expect("the copy");
        assert_eq!(copy, strip_metadata(&original).expect("a JPEG"));
        assert_eq!(staged.sha256, crate::bundles::sha256_hex(&copy));
        assert_eq!((staged.size, file.size), (copy.len() as u64, copy.len() as u64));
        assert_eq!((file.width, file.height, file.class_guess.as_str()), (Some(16), Some(8), "image"));
        assert_eq!(staged.meta.as_ref().and_then(|meta| meta.origin.as_deref()), Some("clipboard"));
        assert_eq!(staged.path, temp.path().join(&file.handle));
        let wire = serde_json::to_value(&file).expect("serializes");
        assert_eq!(wire["classGuess"], "image");
        assert_eq!(wire["origin"], "clipboard");
    }

    #[test]
    fn a_clipboard_picture_goes_as_a_png_without_its_alpha_when_opaque() {
        let png = rgba_to_png(2, 2, vec![255; 16]).expect("encoded");
        let decoded = image::load_from_memory(&png).expect("a picture");
        assert_eq!(decoded.color(), image::ColorType::Rgb8);
        let clear = rgba_to_png(2, 2, vec![0; 16]).expect("encoded");
        assert_eq!(image::load_from_memory(&clear).expect("a picture").color(), image::ColorType::Rgba8);
        assert!(rgba_to_png(2, 2, vec![0; 3]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_saved_file_is_marked_as_downloaded_from_the_internet() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let cached = temp.path().join("cached");
        std::fs::write(&cached, b"MZ\x90\0").expect("the cached copy");
        let saved = temp.path().join("tool.exe");
        save_copy(&cached, &saved).expect("saved");
        assert_eq!(std::fs::read(&saved).expect("the copy"), b"MZ\x90\0");
        let stream = PathBuf::from(format!("{}:Zone.Identifier", saved.display()));
        let zone = std::fs::read_to_string(stream).expect("the stream");
        assert_eq!(zone, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }

    #[test]
    fn an_archive_with_programs_inside_needs_a_confirmation() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let write = |name: &str, bytes: &[u8]| {
            let path = temp.path().join(name);
            std::fs::write(&path, bytes).expect("a file");
            path
        };
        let armed = write("mod.pk3", &zip_with(&["maps/duel.bsp", "jampgamex86.dll", "tools/setup.exe."]));
        let head = read_head(&armed, 4096).expect("the head");
        assert_eq!(
            inspect_archive(&armed, &head),
            ArchiveVerdict::Programs(vec!["jampgamex86.dll".into(), "tools/setup.exe.".into()])
        );
        let reasons = danger_reasons(&armed, "mod.pk3", false).expect("checked");
        assert_eq!(reasons.len(), 1);
        assert!(reasons[0].contains("jampgamex86.dll"), "{reasons:?}");

        let clean = write("skins.pk3", &zip_with(&["models/players/kyle/model.glm", "shaders/k.shader"]));
        assert_eq!(inspect_archive(&clean, &read_head(&clean, 4096).expect("head")), ArchiveVerdict::Clean);
        assert!(danger_reasons(&clean, "skins.pk3", false).expect("checked").is_empty());

        let rar = write("mod.rar", b"Rar!\x1A\x07\x01\0rest");
        assert_eq!(inspect_archive(&rar, b"Rar!\x1A\x07\x01\0"), ArchiveVerdict::Unreadable);
        let broken = write("broken.zip", b"PK\x03\x04 and nothing that opens");
        assert_eq!(inspect_archive(&broken, b"PK\x03\x04"), ArchiveVerdict::Unreadable);
        assert_eq!(inspect_archive(&clean, b"plain"), ArchiveVerdict::NotArchive);
    }

    #[test]
    fn a_program_needs_a_confirmation_whatever_it_is_called() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let program = temp.path().join("cached");
        std::fs::write(&program, b"MZ\x90\0\x03").expect("a file");
        assert_eq!(danger_reasons(&program, "shot.png", false).expect("checked").len(), 1);
        let picture = temp.path().join("picture");
        std::fs::write(&picture, png(2, 2)).expect("a file");
        assert!(danger_reasons(&picture, "shot.png", false).expect("checked").is_empty());
        // The service's flag is enough on its own.
        assert_eq!(danger_reasons(&picture, "shot.png", true).expect("checked").len(), 1);
    }

    #[test]
    fn the_cache_drops_the_least_recently_shown_files_first() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let dir = temp.path();
        let now = SystemTime::now();
        let file = |name: &str, size: usize, age_minutes: u64| {
            let path = dir.join(name);
            std::fs::write(&path, vec![7u8; size]).expect("a file");
            set_age(&path, now, Duration::from_secs(age_minutes * 60));
            path
        };
        let oldest = file("01OLDEST", 100, 180);
        let older = file("02OLDER", 100, 120);
        let recent = file("03RECENT", 100, 60);
        let stale = file("04STALLED.part", 10, 25 * 60);
        let fresh = file("05GOING.part", 10, 0);

        // 310 bytes left after the stalled download; the limit is 250. The
        // oldest file is the one on screen, so the next oldest goes.
        let removed = evict(dir, 250, Some(&oldest), now).expect("tidied");
        assert_eq!(removed, vec![stale.clone(), older.clone()]);
        assert!(oldest.exists() && recent.exists() && fresh.exists());
        assert!(!older.exists() && !stale.exists());

        // Shown again, a file moves to the back of the queue.
        touch(&oldest);
        let removed = evict(dir, 150, None, SystemTime::now()).expect("tidied");
        assert_eq!(removed, vec![recent]);
        assert!(oldest.exists());
        assert!(evict(&dir.join("missing"), 0, None, now).expect("nothing").is_empty());
    }

    #[test]
    fn file_gone_and_not_found_leave_a_file_gone() {
        let refusal = |code: &str| AppError::Online { code: code.into(), message: "x".into() };
        assert_eq!(status_after(&refusal("file_gone")), LocalStatus::Gone);
        assert_eq!(status_after(&refusal("not_found")), LocalStatus::Gone);
        assert_eq!(status_after(&refusal("chat_unavailable")), LocalStatus::Remote);
        assert_eq!(status_after(&AppError::Network("reset".into())), LocalStatus::Remote);
        assert_eq!(status_after(&gone_error()), LocalStatus::Gone);
        // A refused range starts over; a lost file does not.
        assert!(restarts(&refusal("internal")));
        assert!(!restarts(&refusal("file_gone")));
        assert!(!restarts(&AppError::Network("reset".into())));
        let wire = serde_json::to_value(FileLocal { status: LocalStatus::Gone, path: None })
            .expect("serializes");
        assert_eq!(wire, serde_json::json!({ "status": "gone", "path": null }));
    }

    #[test]
    fn the_hash_and_the_size_come_from_the_headers() {
        let mut headers = HeaderMap::new();
        let hash = "ab".repeat(32);
        headers.insert(ETAG, format!("\"{}\"", hash.to_uppercase()).parse().expect("a header"));
        headers.insert(CONTENT_RANGE, "bytes 100-199/200".parse().expect("a header"));
        assert_eq!(etag_sha256(&headers), Some(hash.clone()));
        assert_eq!(range_total(&headers), Some(200));
        headers.insert(ETAG, format!("W/\"{hash}\"").parse().expect("a header"));
        assert_eq!(etag_sha256(&headers), Some(hash));
        headers.insert(ETAG, "\"v2\"".parse().expect("a header"));
        assert_eq!(etag_sha256(&headers), None, "not a hash: nothing to check against");
    }

    #[test]
    fn an_import_lands_where_the_media_screen_looks() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let root = temp.path().join("home").join("base");
        let demos: &[&str] = &["dm_25", "dm_26"];
        let demo = import_destination(&root, ImportKind::Demo, "duel.dm_26", b"\x01\x02", demos)
            .expect("a demo");
        assert_eq!(demo, root.join("demos").join("duel.dm_26"));
        assert!(import_destination(&root, ImportKind::Demo, "duel.dm_15", b"\x01", demos).is_err(), "another game");
        assert!(import_destination(&root, ImportKind::Demo, "duel.dm_26", b"MZ", demos).is_err(), "a program");

        let shot = import_destination(&root, ImportKind::Screenshot, "shot.bin", b"\xFF\xD8\xFF\xE0", demos)
            .expect("a screenshot");
        assert_eq!(shot, root.join("screenshots").join("shot.jpg"));
        assert!(import_destination(&root, ImportKind::Screenshot, "shot.png", b"GIF89a", demos).is_err());

        // The launcher's own prefix, and a taken name.
        std::fs::create_dir_all(root.join("demos")).expect("the folder");
        std::fs::write(root.join("demos").join("chat-jknet-x.dm_26"), b"").expect("taken");
        let renamed = import_destination(&root, ImportKind::Demo, "jknet-x.dm_26", b"\x01", demos)
            .expect("a demo");
        assert_eq!(renamed, root.join("demos").join("chat-jknet-x-2.dm_26"));
    }

    #[test]
    fn a_sent_file_becomes_the_cached_copy() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let staged = temp.path().join("staging").join("HANDLE");
        std::fs::create_dir_all(staged.parent().expect("a parent")).expect("the folder");
        std::fs::write(&staged, b"bytes").expect("staged");
        let cached = temp.path().join("files").join("01FILE");
        adopt(&staged, &cached).expect("moved");
        assert_eq!(std::fs::read(&cached).expect("cached"), b"bytes");
        assert!(!staged.exists());
        // A cache that has it already keeps its copy.
        std::fs::write(&staged, b"other").expect("staged again");
        adopt(&staged, &cached).expect("dropped");
        assert_eq!(std::fs::read(&cached).expect("cached"), b"bytes");
        assert!(!staged.exists());
    }

    #[test]
    fn the_book_remembers_files_of_messages() {
        let mut book = FileBook::default();
        let message = ChatMessage {
            files: vec![FileRef { id: "01F".into(), name: "a.exe".into(), danger: true, ..FileRef::default() }],
            ..ChatMessage::default()
        };
        book.remember_messages([&message]);
        assert!(book.known("01F").is_some_and(|file| file.danger));
        assert!(book.known("02F").is_none());
    }
}
