//! Getting an engine build from GitHub onto the disk.
//!
//! Three jobs, in the order a player triggers them:
//!
//! 1. **Ask** — read the last ten releases of the project through the GitHub
//!    REST API and keep only those that carry a Windows 32-bit archive.
//! 2. **Download** — stream the archive into `cache\downloads\`, reusing a file
//!    that is already there with the right size.
//! 3. **Unpack** — wipe `clients\<slug>\engine\` and extract into it, then
//!    write the installed tag into `client.json`.
//!
//! Every step reports through the `launch:engine-install-progress` event, so
//! the Clients screen can show a progress bar without polling.
//!
//! Requests carry no token. GitHub allows 60 anonymous calls an hour per
//! address, which is plenty for four engines behind a ten-minute cache, and
//! the rate-limit answer is turned into a sentence a player can act on.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::clients::{self, Client};
use crate::engines::{self, Engine, EngineRelease};
use crate::error::{AppError, Result};
use crate::paths::{self, DataPaths};
use crate::timestamp;

/// Releases asked for in one call. Ten is what the Clients screen offers.
const RELEASES_PER_PAGE: usize = 10;

/// How long a release list is treated as current, in seconds.
const CACHE_TTL: u64 = 10 * 60;

/// Event the frontend listens to while an engine is being installed.
const PROGRESS_EVENT: &str = "launch:engine-install-progress";

/// Shortest gap between two download progress events, in milliseconds. A
/// 50 MB archive would otherwise emit thousands of them.
const PROGRESS_INTERVAL_MS: u128 = 150;

/// GitHub rejects a request without a User-Agent, so this is not optional.
fn user_agent() -> String {
    format!("JKNet/{} (+https://github.com/JACoders/OpenJK)", env!("CARGO_PKG_VERSION"))
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/// Payload of `launch:engine-install-progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub client_id: String,
    /// `download`, `extract`, `done` or `error`.
    pub phase: &'static str,
    /// Bytes written so far. Zero outside the download phase.
    pub downloaded: u64,
    /// Bytes expected, zero when the server sent no length.
    pub total: u64,
    /// One line for the card: a file name, a step, or the failure.
    pub message: String,
}

/// Sends one progress event. A failed emit is logged, never propagated: the
/// install must not fail because a window went away.
fn emit(app: &AppHandle, progress: InstallProgress) {
    if let Err(e) = app.emit(PROGRESS_EVENT, progress) {
        log::warn!("cannot emit {PROGRESS_EVENT}: {e}");
    }
}

// ---------------------------------------------------------------------------
// Release list and its cache
// ---------------------------------------------------------------------------

/// What `cache\releases\<engine_id>.json` holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedReleases {
    /// Fetch time in RFC 3339, for the person who opens the file.
    fetched_at: String,
    /// The same moment in Unix seconds, for the freshness check.
    fetched_at_unix: u64,
    releases: Vec<EngineRelease>,
}

impl CachedReleases {
    fn is_fresh(&self, now: u64) -> bool {
        now.saturating_sub(self.fetched_at_unix) < CACHE_TTL
    }
}

/// The in-memory half of the cache, one entry per engine.
fn memory_cache() -> &'static Mutex<HashMap<String, CachedReleases>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedReleases>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns the releases of an engine that carry a Windows 32-bit archive,
/// newest first.
///
/// Order of preference: a fresh entry in memory, a fresh file in `cache\`,
/// then GitHub. When GitHub cannot be reached the stale file is served with a
/// warning, because an outdated list beats an empty screen.
pub async fn releases(engine: &'static Engine, cache_dir: &Path) -> Result<Vec<EngineRelease>> {
    if !engine.installable {
        return Ok(Vec::new());
    }
    let now = timestamp::now_unix();

    if let Some(cached) = read_memory(engine.id) {
        if cached.is_fresh(now) {
            return Ok(cached.releases);
        }
    }

    let file = release_cache_file(cache_dir, engine.id);
    let on_disk = read_disk(&file);
    if let Some(cached) = &on_disk {
        if cached.is_fresh(now) {
            write_memory(engine.id, cached.clone());
            return Ok(cached.releases.clone());
        }
    }

    match fetch_releases(engine).await {
        Ok(releases) => {
            let cached = CachedReleases {
                fetched_at: timestamp::now_rfc3339(),
                fetched_at_unix: now,
                releases,
            };
            write_disk(&file, &cached);
            write_memory(engine.id, cached.clone());
            Ok(cached.releases)
        }
        Err(e) => match on_disk {
            Some(cached) => {
                log::warn!(
                    "{}: {e}, serving the release list cached at {}",
                    engine.id,
                    cached.fetched_at
                );
                Ok(cached.releases)
            }
            None => Err(e),
        },
    }
}

fn release_cache_file(cache_dir: &Path, engine_id: &str) -> PathBuf {
    cache_dir.join("releases").join(format!("{engine_id}.json"))
}

fn read_memory(engine_id: &str) -> Option<CachedReleases> {
    memory_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(engine_id).cloned())
}

fn write_memory(engine_id: &str, cached: CachedReleases) {
    if let Ok(mut guard) = memory_cache().lock() {
        guard.insert(engine_id.to_string(), cached);
    }
}

/// Reads the cache file. A corrupt file is treated as a missing one: it holds
/// nothing a player would miss.
fn read_disk(file: &Path) -> Option<CachedReleases> {
    let text = fs::read_to_string(file).ok()?;
    match serde_json::from_str(&text) {
        Ok(cached) => Some(cached),
        Err(e) => {
            log::warn!("ignoring unreadable release cache {}: {e}", file.display());
            None
        }
    }
}

fn write_disk(file: &Path, cached: &CachedReleases) {
    let Some(parent) = file.parent() else { return };
    if let Err(e) = paths::create_dir(parent) {
        log::warn!("cannot cache the release list: {e}");
        return;
    }
    match serde_json::to_string_pretty(cached) {
        Ok(text) => {
            if let Err(e) = fs::write(file, text) {
                log::warn!("cannot write {}: {e}", file.display());
            }
        }
        Err(e) => log::warn!("cannot serialize the release list: {e}"),
    }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/// The part of a GitHub release JKNet reads.
#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(user_agent())
        .gzip(true)
        .build()
        .map_err(AppError::from)
}

/// Asks GitHub for the last releases and keeps the ones JKNet can install.
async fn fetch_releases(engine: &'static Engine) -> Result<Vec<EngineRelease>> {
    let url = format!(
        "https://api.github.com/repos/{}/releases?per_page={RELEASES_PER_PAGE}",
        engine.repo
    );
    let response = http_client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        if let Some(message) = rate_limit_message(response.headers(), status.as_u16()) {
            return Err(AppError::RateLimited(message));
        }
        return Err(AppError::Network(format!(
            "GitHub answered {status} for {}",
            engine.repo
        )));
    }

    let body = response.bytes().await?;
    let raw: Vec<GithubRelease> = serde_json::from_slice(&body)
        .map_err(|e| AppError::json(format!("cannot parse the releases of {}", engine.repo), e))?;

    let releases: Vec<EngineRelease> = raw
        .into_iter()
        .filter(|release| !release.draft)
        .filter(|release| engine.allow_prerelease || !release.prerelease)
        .filter_map(|release| to_engine_release(engine, release))
        .collect();

    log::info!(
        "{}: {} release(s) with a Windows build",
        engine.id,
        releases.len()
    );
    Ok(releases)
}

/// Turns a GitHub release into ours, or drops it when no asset matches.
fn to_engine_release(engine: &Engine, release: GithubRelease) -> Option<EngineRelease> {
    let names: Vec<&str> = release
        .assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect();
    let index = engines::match_asset(engine.asset_rules, names.iter().copied())?;
    let asset = &release.assets[index];

    Some(EngineRelease {
        name: release
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| release.tag_name.clone()),
        tag: release.tag_name,
        published_at: release.published_at.unwrap_or_default(),
        prerelease: release.prerelease,
        asset_name: asset.name.clone(),
        asset_size: asset.size,
        asset_url: asset.browser_download_url.clone(),
    })
}

/// Recognises a refusal caused by the anonymous quota and says when it lifts.
///
/// GitHub answers 403 (and, since 2023, sometimes 429) with
/// `x-ratelimit-remaining: 0` and a reset time in Unix seconds.
fn rate_limit_message(headers: &reqwest::header::HeaderMap, status: u16) -> Option<String> {
    if status != 403 && status != 429 {
        return None;
    }
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())?;
    if remaining.trim() != "0" {
        return None;
    }
    let minutes = headers
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|reset| reset.saturating_sub(timestamp::now_unix()).div_ceil(60));

    Some(match minutes {
        Some(minutes) if minutes > 0 => format!(
            "GitHub is not answering any more requests from this address for another {minutes} minute(s). Engine lists and downloads work again after that."
        ),
        _ => "GitHub is not answering any more requests from this address right now. Try again in a few minutes.".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/// Downloads a release and unpacks it into the client's `engine\` folder.
///
/// `tag` picks a release by name; `None` takes the newest one. The client
/// record comes back updated, and the caller does not have to re-read it.
pub async fn install(
    app: &AppHandle,
    paths: &DataPaths,
    client_id: &str,
    tag: Option<&str>,
) -> Result<Client> {
    match install_inner(app, paths, client_id, tag).await {
        Ok(client) => Ok(client),
        Err(e) => {
            log::error!("installing an engine for {client_id} failed: {e}");
            emit(
                app,
                InstallProgress {
                    client_id: client_id.to_string(),
                    phase: "error",
                    downloaded: 0,
                    total: 0,
                    message: e.to_string(),
                },
            );
            Err(e)
        }
    }
}

async fn install_inner(
    app: &AppHandle,
    paths: &DataPaths,
    client_id: &str,
    tag: Option<&str>,
) -> Result<Client> {
    let mut client = clients::read_record(paths, client_id)?;
    let engine = engines::require(&client.engine_id)?;
    if !engine.installable {
        return Err(AppError::InvalidInput(format!(
            "{} cannot be installed automatically: {}",
            engine.name,
            engine.not_installable_reason.unwrap_or("no reason recorded")
        )));
    }

    let available = releases(engine, &paths.cache).await?;
    let release = match tag {
        Some(tag) => available
            .into_iter()
            .find(|release| release.tag == tag)
            .ok_or_else(|| {
                AppError::NotFound(format!("release {tag} of {} with a Windows build", engine.name))
            })?,
        None => available.into_iter().next().ok_or_else(|| {
            AppError::NotFound(format!("a release of {} with a Windows build", engine.name))
        })?,
    };

    let archive = download(app, paths, client_id, engine, &release).await?;

    let engine_dir = paths.client_dir(client_id).join("engine");
    let executable = engine.executable;
    emit(
        app,
        InstallProgress {
            client_id: client_id.to_string(),
            phase: "extract",
            downloaded: release.asset_size,
            total: release.asset_size,
            message: format!("Unpacking {}", release.asset_name),
        },
    );

    // Extraction is CPU and disk work; keeping it off the async runtime keeps
    // the rest of the launcher answering while a 50 MB archive unpacks.
    let target = engine_dir.clone();
    tauri::async_runtime::spawn_blocking(move || extract_archive(&archive, &target))
        .await
        .map_err(|e| AppError::Archive(format!("the unpacking task did not finish: {e}")))??;

    let exe = engine_dir.join(executable);
    if !exe.is_file() {
        return Err(AppError::Archive(format!(
            "{} is missing from {} after unpacking {}",
            executable,
            engine_dir.display(),
            release.asset_name
        )));
    }

    client.engine_version = Some(release.tag.clone());
    client.engine_installed_at = Some(timestamp::now_rfc3339());
    client.engine_published_at = Some(release.published_at.clone());
    clients::write_record(paths, &client)?;

    log::info!(
        "installed {} {} into {}",
        engine.name,
        release.tag,
        engine_dir.display()
    );
    emit(
        app,
        InstallProgress {
            client_id: client_id.to_string(),
            phase: "done",
            downloaded: release.asset_size,
            total: release.asset_size,
            message: format!("{} {} is ready", engine.name, release.tag),
        },
    );
    Ok(client)
}

/// Streams the release archive into `cache\downloads\`.
///
/// A file already there with the announced size is taken as is: the same
/// archive serves every client that runs the engine, and the second client is
/// the common case.
async fn download(
    app: &AppHandle,
    paths: &DataPaths,
    client_id: &str,
    engine: &Engine,
    release: &EngineRelease,
) -> Result<PathBuf> {
    let dir = paths.cache.join("downloads");
    paths::create_dir(&dir)?;
    let file = dir.join(format!(
        "{}-{}.zip",
        engine.id,
        sanitize_file_stem(&release.tag)
    ));

    if let Ok(metadata) = fs::metadata(&file) {
        if metadata.len() == release.asset_size && release.asset_size > 0 {
            log::info!("reusing {}", file.display());
            emit(
                app,
                InstallProgress {
                    client_id: client_id.to_string(),
                    phase: "download",
                    downloaded: release.asset_size,
                    total: release.asset_size,
                    message: format!("{} is already downloaded", release.asset_name),
                },
            );
            return Ok(file);
        }
    }

    let response = http_client()?.get(&release.asset_url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "{} answered {status}",
            release.asset_url
        )));
    }
    let total = response.content_length().unwrap_or(release.asset_size);

    // A partial file must never be mistaken for a finished one, so the bytes
    // land next to the target and are renamed once the stream ends.
    let partial = file.with_extension("part");
    let mut sink =
        File::create(&partial).map_err(|e| AppError::io_path("cannot create", &partial, e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    emit(
        app,
        InstallProgress {
            client_id: client_id.to_string(),
            phase: "download",
            downloaded: 0,
            total,
            message: format!("Downloading {}", release.asset_name),
        },
    );

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        sink.write_all(&chunk)
            .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
            last_emit = std::time::Instant::now();
            emit(
                app,
                InstallProgress {
                    client_id: client_id.to_string(),
                    phase: "download",
                    downloaded,
                    total,
                    message: format!("Downloading {}", release.asset_name),
                },
            );
        }
    }
    sink.flush()
        .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
    drop(sink);

    if file.exists() {
        fs::remove_file(&file).map_err(|e| AppError::io_path("cannot replace", &file, e))?;
    }
    fs::rename(&partial, &file).map_err(|e| AppError::io_path("cannot rename", &partial, e))?;
    log::info!("downloaded {downloaded} bytes into {}", file.display());
    Ok(file)
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

/// Replaces the contents of `target` with the contents of the archive.
///
/// The folder is emptied first, so an engine downgrade cannot leave a file
/// from the newer build behind. Entries are checked one by one: an archive is
/// data from the internet, and a `..` in an entry name is how a zip escapes
/// the folder it is supposed to fill.
pub fn extract_archive(archive: &Path, target: &Path) -> Result<()> {
    let reader =
        File::open(archive).map_err(|e| AppError::io_path("cannot open", archive, e))?;
    let mut zip = zip::ZipArchive::new(reader)?;

    let names: Vec<String> = zip.file_names().map(str::to_string).collect();
    let root = single_root(&names);
    if let Some(root) = &root {
        log::info!("flattening the single top folder {root}/ of {}", archive.display());
    }

    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| AppError::io_path("cannot clear", target, e))?;
    }
    paths::create_dir(target)?;

    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        let name = entry.name().to_string();
        let Some(relative) = strip_root(&name, root.as_deref()) else {
            continue; // the top folder entry itself
        };
        let path = safe_entry_path(target, relative)?;

        if entry.is_dir() {
            paths::create_dir(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            paths::create_dir(parent)?;
        }
        let mut out =
            File::create(&path).map_err(|e| AppError::io_path("cannot create", &path, e))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| AppError::io_path("cannot write", &path, e))?;
    }
    Ok(())
}

/// Name of the single top-level folder of an archive, when there is one.
///
/// Some projects wrap everything in `<Name>/`, others put the executable at
/// the root. Flattening the first kind means the executable always sits
/// directly in `engine\`. Of the four engines JKNet installs, none wraps
/// today, so this exists for the release that starts to.
fn single_root(names: &[String]) -> Option<String> {
    let mut root: Option<String> = None;
    for name in names {
        let normalized = name.replace('\\', "/");
        // No separator means a file at the root: nothing to flatten.
        let (head, _) = normalized.split_once('/')?;
        if head.is_empty() {
            return None; // an absolute name, handled by `safe_entry_path`
        }
        match &root {
            Some(current) if current != head => return None,
            Some(_) => {}
            None => root = Some(head.to_string()),
        }
    }
    root
}

/// Drops the flattened top folder from an entry name.
///
/// Returns `None` for the folder entry itself, which has nothing left after
/// the prefix goes.
fn strip_root<'a>(name: &'a str, root: Option<&str>) -> Option<&'a str> {
    let Some(root) = root else {
        return Some(name);
    };
    let rest = name
        .strip_prefix(root)
        .and_then(|rest| rest.strip_prefix('/').or_else(|| rest.strip_prefix('\\')))
        .unwrap_or(name);
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

/// Resolves an archive entry inside `root`, or refuses it.
///
/// Rejected: absolute paths, Windows drive and share prefixes, and any `..`.
/// This is the zip-slip guard; an archive that trips it is treated as broken
/// rather than silently skipped, because a good build never contains one.
fn safe_entry_path(root: &Path, entry: &str) -> Result<PathBuf> {
    let normalized = entry.replace('\\', "/");
    let relative = Path::new(&normalized);
    let mut path = root.to_path_buf();

    for component in relative.components() {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::Archive(format!(
                    "the archive entry {entry} points outside the target folder"
                )))
            }
        }
    }
    if path == root {
        return Err(AppError::Archive(format!(
            "the archive entry {entry} has no name"
        )));
    }
    Ok(path)
}

/// Makes a git tag safe to use as part of a file name.
fn sanitize_file_stem(tag: &str) -> String {
    let cleaned: String = tag
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "release".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    /// Builds a zip in memory and writes it next to the target folder.
    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, body) in entries {
                writer.start_file(*name, options).expect("start entry");
                writer.write_all(body).expect("write entry");
            }
            writer.finish().expect("finish the archive");
        }
        fs::write(path, buffer.into_inner()).expect("write the archive");
    }

    #[test]
    fn a_tag_becomes_a_file_name() {
        assert_eq!(sanitize_file_stem("latest"), "latest");
        assert_eq!(sanitize_file_stem("1.5.8.5"), "1.5.8.5");
        assert_eq!(sanitize_file_stem("release/2026-09"), "release-2026-09");
        assert_eq!(sanitize_file_stem("../../etc"), "..-..-etc");
        assert_eq!(sanitize_file_stem("///"), "release");
    }

    #[test]
    fn a_single_top_folder_is_recognised() {
        let names = vec![
            "TaystJK/".to_string(),
            "TaystJK/taystjk.x86.exe".to_string(),
            "TaystJK/base/cgamex86.dll".to_string(),
        ];
        assert_eq!(single_root(&names).as_deref(), Some("TaystJK"));
    }

    #[test]
    fn an_archive_with_files_at_the_root_is_not_flattened() {
        // The real OpenJK layout: the executable sits at the root.
        let names = vec![
            "openjk.x86.exe".to_string(),
            "base/cgamex86.dll".to_string(),
            "OpenJK/jampgamex86.dll".to_string(),
        ];
        assert_eq!(single_root(&names), None);
    }

    #[test]
    fn two_top_folders_are_not_flattened() {
        let names = vec!["a/one.txt".to_string(), "b/two.txt".to_string()];
        assert_eq!(single_root(&names), None);
    }

    #[test]
    fn stripping_the_root_leaves_the_relative_name() {
        assert_eq!(strip_root("TaystJK/a.exe", Some("TaystJK")), Some("a.exe"));
        assert_eq!(strip_root("TaystJK/", Some("TaystJK")), None);
        assert_eq!(strip_root("a.exe", None), Some("a.exe"));
    }

    #[test]
    fn an_entry_inside_the_target_resolves() {
        let root = Path::new("C:\\JKNet\\clients\\everyday\\engine");
        let path = safe_entry_path(root, "base/cgamex86.dll").expect("a plain entry is allowed");
        assert!(path.starts_with(root));
        assert!(path.ends_with("cgamex86.dll"));
        // Backslashes inside an archive name mean folders too.
        assert!(safe_entry_path(root, "base\\uix86.dll").is_ok());
    }

    #[test]
    fn an_entry_that_escapes_the_target_is_refused() {
        let root = Path::new("C:\\JKNet\\clients\\everyday\\engine");
        for entry in [
            "../../../evil.exe",
            "base/../../evil.exe",
            "/etc/passwd",
            "..\\evil.exe",
            "",
        ] {
            assert!(
                safe_entry_path(root, entry).is_err(),
                "{entry} should be refused"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_letter_in_an_entry_is_refused() {
        let root = Path::new("C:\\JKNet\\clients\\everyday\\engine");
        assert!(safe_entry_path(root, "C:/Windows/System32/evil.dll").is_err());
    }

    #[test]
    fn extraction_flattens_a_single_top_folder() {
        let temp = tempfile::tempdir().expect("temp dir");
        let archive = temp.path().join("engine.zip");
        write_zip(
            &archive,
            &[
                ("TaystJK/taystjk.x86.exe", b"MZ" as &[u8]),
                ("TaystJK/base/cgamex86.dll", b"dll"),
            ],
        );

        let target = temp.path().join("engine");
        extract_archive(&archive, &target).expect("extraction succeeds");
        assert!(target.join("taystjk.x86.exe").is_file());
        assert!(target.join("base").join("cgamex86.dll").is_file());
        assert!(!target.join("TaystJK").exists());
    }

    #[test]
    fn extraction_keeps_a_flat_archive_flat_and_clears_the_folder() {
        let temp = tempfile::tempdir().expect("temp dir");
        let archive = temp.path().join("engine.zip");
        write_zip(
            &archive,
            &[
                ("openjk.x86.exe", b"MZ" as &[u8]),
                ("base/cgamex86.dll", b"dll"),
                ("OpenJK/jampgamex86.dll", b"dll"),
            ],
        );

        let target = temp.path().join("engine");
        paths::create_dir(&target).expect("create the target");
        fs::write(target.join("stale.dll"), b"old").expect("leave a stale file");

        extract_archive(&archive, &target).expect("extraction succeeds");
        assert!(target.join("openjk.x86.exe").is_file());
        assert!(target.join("base").join("cgamex86.dll").is_file());
        assert!(target.join("OpenJK").join("jampgamex86.dll").is_file());
        assert!(!target.join("stale.dll").exists(), "the folder is wiped first");
    }

    #[test]
    fn extraction_refuses_an_archive_that_escapes_the_folder() {
        let temp = tempfile::tempdir().expect("temp dir");
        let archive = temp.path().join("evil.zip");
        write_zip(
            &archive,
            &[
                ("openjk.x86.exe", b"MZ" as &[u8]),
                ("../../evil.exe", b"MZ"),
            ],
        );

        let target = temp.path().join("engine");
        let error = extract_archive(&archive, &target).expect_err("zip slip is refused");
        assert!(
            matches!(error, AppError::Archive(_)),
            "unexpected error: {error}"
        );
        assert!(!temp.path().join("evil.exe").exists());
    }

    #[test]
    fn a_cache_entry_expires_after_ten_minutes() {
        let cached = CachedReleases {
            fetched_at: "2026-09-10T00:00:00Z".into(),
            fetched_at_unix: 1_000_000,
            releases: Vec::new(),
        };
        assert!(cached.is_fresh(1_000_000));
        assert!(cached.is_fresh(1_000_000 + CACHE_TTL - 1));
        assert!(!cached.is_fresh(1_000_000 + CACHE_TTL));
        // A clock that went backwards must not look like a fresh entry from
        // the future turning stale.
        assert!(cached.is_fresh(999_000));
    }

    #[test]
    fn only_an_exhausted_quota_reads_as_a_rate_limit() {
        use reqwest::header::HeaderMap;

        let mut spent = HeaderMap::new();
        spent.insert("x-ratelimit-remaining", "0".parse().expect("header"));
        assert!(rate_limit_message(&spent, 403).is_some());
        assert!(rate_limit_message(&spent, 429).is_some());
        assert!(rate_limit_message(&spent, 404).is_none());

        let mut left = HeaderMap::new();
        left.insert("x-ratelimit-remaining", "37".parse().expect("header"));
        assert!(rate_limit_message(&left, 403).is_none());
        assert!(rate_limit_message(&HeaderMap::new(), 403).is_none());
    }

    /// The one test that needs the internet. Run it by hand:
    /// `cargo test -- --ignored downloads_and_unpacks_the_real_openjk_build`.
    #[test]
    #[ignore = "downloads 6 MB from github.com"]
    fn downloads_and_unpacks_the_real_openjk_build() {
        let engine = engines::find("openjk").expect("openjk is in the registry");
        let temp = tempfile::tempdir().expect("temp dir");

        let found = tauri::async_runtime::block_on(releases(engine, temp.path()))
            .expect("the release list");
        let newest = found.first().expect("at least one release");
        assert!(newest.asset_name.to_lowercase().ends_with(".zip"));
        println!("newest {} release: {} / {}", engine.id, newest.tag, newest.asset_name);

        let archive = temp.path().join("openjk.zip");
        let bytes = tauri::async_runtime::block_on(async {
            http_client()?
                .get(&newest.asset_url)
                .send()
                .await?
                .bytes()
                .await
                .map_err(AppError::from)
        })
        .expect("the archive downloads");
        fs::write(&archive, &bytes).expect("write the archive");
        assert_eq!(bytes.len() as u64, newest.asset_size);

        let target = temp.path().join("engine");
        extract_archive(&archive, &target).expect("the archive unpacks");
        assert!(
            target.join(engine.executable).is_file(),
            "{} is missing from the unpacked build",
            engine.executable
        );
    }
}
