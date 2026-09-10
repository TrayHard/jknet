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

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

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
    let index = engines::match_asset(engine.rules_for_host(), names.iter().copied())?;
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
// One install per client
// ---------------------------------------------------------------------------

/// The clients an install is running for, managed by Tauri next to
/// [`crate::state::AppState`].
///
/// Two installs of the same client would stream into the same `.part` file and
/// then wipe and refill the same `engine\` folder, one behind the other, and
/// leave the player with a folder that holds half of each build. The interface
/// disables its buttons while an install runs; this refuses the call that gets
/// through anyway, from a double click, a second window, or a retry.
#[derive(Debug, Default)]
pub struct InstallState {
    busy: Mutex<HashSet<String>>,
}

impl InstallState {
    /// Claims a client for the caller, or refuses because someone holds it.
    fn claim<'a>(&'a self, client_id: &str) -> Result<InstallGuard<'a>> {
        let mut busy = self
            .busy
            .lock()
            .map_err(|_| AppError::State("the engine install lock is poisoned".into()))?;
        if !busy.insert(client_id.to_string()) {
            return Err(AppError::Busy(format!(
                "an engine installation is already running for {client_id}. Wait for it to finish."
            )));
        }
        Ok(InstallGuard {
            state: self,
            client_id: client_id.to_string(),
        })
    }
}

/// Releases the claim when the install ends, however it ends.
#[derive(Debug)]
struct InstallGuard<'a> {
    state: &'a InstallState,
    client_id: String,
}

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        match self.state.busy.lock() {
            Ok(mut busy) => {
                busy.remove(&self.client_id);
            }
            // A poisoned lock would keep the client busy until the launcher
            // restarts, which is worse than the panic that poisoned it.
            Err(e) => log::error!("cannot release the install claim of {}: {e}", self.client_id),
        }
    }
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/// Downloads a release and unpacks it into the client's `engine\` folder.
///
/// `tag` picks a release by name; `None` takes the newest one. The client
/// record comes back updated, and the caller does not have to re-read it.
///
/// A second call for the same client is refused before anything touches the
/// disk, and without a progress event: the event would replace the running
/// install's progress bar with an error the player did not cause.
pub async fn install(
    app: &AppHandle,
    installs: &InstallState,
    paths: &DataPaths,
    client_id: &str,
    tag: Option<&str>,
) -> Result<Client> {
    let _claim = installs.claim(client_id)?;
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

    let engine_dir = extract_target(paths, client_id);
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

    // --- slice: game core ---
    // A game whose engine folder is not a search root leaves the build's own
    // `base\*.pk3` unreachable, so they are mirrored into `home\base\` right
    // here. The launch path does it again on every start; doing it now is what
    // makes a client complete the moment the progress bar says «ready».
    if !client.game.spec().launch_layout.engine_dir_on_search_path() {
        let home_dir = paths.client_home_dir(client_id);
        sync_engine_archives(&engine_dir, &home_dir)?;
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
        // The archive normally lives on a CDN outside `api.github.com`, where
        // the anonymous quota does not apply, but a redirect back to the API
        // exists and the answer has to read as a wait, not as a dead link.
        if let Some(message) = rate_limit_message(response.headers(), status.as_u16()) {
            return Err(AppError::RateLimited(message));
        }
        return Err(AppError::Network(format!(
            "{} answered {status}",
            release.asset_url
        )));
    }
    let total = response.content_length().unwrap_or(release.asset_size);

    // A partial file must never be mistaken for a finished one, so the bytes
    // land next to the target and are renamed once the stream ends.
    //
    // The sink is `tokio::fs`, not `std::fs`: a blocking `write_all` between
    // two `await`s holds a runtime worker for the length of a disk write, and
    // this loop runs it for every chunk of a 50 MB archive. The heavy step
    // after it, unpacking, goes to `spawn_blocking` for the same reason.
    let partial = file.with_extension("part");
    let mut sink = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| AppError::io_path("cannot create", &partial, e))?;
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
            .await
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
    // `flush` alone empties the buffer of the writer; `sync_all` is what makes
    // the bytes survive a power cut, and the rename below must not promote a
    // file the disk has not taken yet.
    sink.flush()
        .await
        .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
    sink.sync_all()
        .await
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
// The archives an engine build ships with itself
// ---------------------------------------------------------------------------

// --- slice: game core ---

/// Folder both the unpacked build and the client's `home\` keep archives in.
const BASE_FOLDER: &str = "base";

/// The one folder an engine archive is ever unpacked into.
///
/// A function rather than an inline `join`, and it exists to be pinned by a
/// test. [`extract_archive`] empties its target before filling it, and the
/// client folder holds one other root that must never meet that behaviour:
/// `basepath\`, whose `base` entry is a junction into the player's game folder
/// (see [`crate::launch::prepare_basepath`]). Unpacking there would empty the
/// junction, and emptying a junction empties the game.
pub(crate) fn extract_target(paths: &DataPaths, client_id: &str) -> PathBuf {
    paths.client_engine_dir(client_id)
}

/// Names of the pk3 files the unpacked build itself ships, lowercase.
///
/// The one answer to "is this file the player's or the engine's". Read from
/// disk rather than from a list in the registry, because the list would have to
/// be right about a release nobody has downloaded yet.
///
/// An unreadable or missing `engine\base\` answers with an empty set: a client
/// whose engine is not installed has no engine files, which is the truth.
pub fn bundled_archive_names(engine_dir: &Path) -> HashSet<String> {
    let Ok(entries) = fs::read_dir(engine_dir.join(BASE_FOLDER)) else {
        return HashSet::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_ascii_lowercase();
            let is_file = entry.metadata().map(|meta| meta.is_file()).unwrap_or(false);
            (is_file && name.ends_with(".pk3")).then_some(name)
        })
        .collect()
}

/// Copies every `engine\base\*.pk3` into `home\base\`, skipping what is
/// already there unchanged. Returns the names it copied.
///
/// --- slice: game core ---
/// Jedi Outcast needs this. Its layout hands `fs_basepath` to the game folder
/// (see [`crate::launch`]), which leaves `clients\<slug>\engine\` off the
/// search path — and that is where JK2MV keeps `assetsmv.pk3` and
/// `assetsmv2.pk3`, the archives its own modules need. `home\base\` is the one
/// root left that JKNet may write into.
///
/// Idempotent by size and modification time, so the common call copies nothing
/// and touches no disk beyond one `read_dir` and one `metadata` per file. The
/// copy stamps the source's modification time onto the destination, because
/// `fs::copy` does not promise to carry it over and a lost timestamp would
/// make every launch copy the same two megabytes again.
///
/// Called from two places: after an install, so a fresh client is complete,
/// and before every launch, so a client created before this existed repairs
/// itself without a reinstall.
pub fn sync_engine_archives(engine_dir: &Path, home_dir: &Path) -> Result<Vec<String>> {
    let source_dir = engine_dir.join(BASE_FOLDER);
    let Ok(entries) = fs::read_dir(&source_dir) else {
        // No `base\` in the build: nothing of the engine's to mirror.
        return Ok(Vec::new());
    };

    let sources: Vec<(String, PathBuf, fs::Metadata)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            if !name.to_ascii_lowercase().ends_with(".pk3") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| (name, entry.path(), meta))
        })
        .collect();
    if sources.is_empty() {
        return Ok(Vec::new());
    }

    let target_dir = home_dir.join(BASE_FOLDER);
    paths::create_dir(&target_dir)?;

    let mut copied = Vec::new();
    for (name, source, meta) in sources {
        let target = target_dir.join(&name);
        if !needs_copy(&meta, &target) {
            continue;
        }
        fs::copy(&source, &target)
            .map_err(|e| AppError::io_path("cannot copy the engine archive into", &target, e))?;
        stamp_modified(&target, &meta);
        copied.push(name);
    }

    if copied.is_empty() {
        log::debug!("{} is already in sync", target_dir.display());
    } else {
        log::info!(
            "copied {} engine archive(s) into {}: {}",
            copied.len(),
            target_dir.display(),
            copied.join(", ")
        );
    }
    Ok(copied)
}

/// Copies `source` over `target` unless the two already match, and says
/// whether it copied.
///
/// The same rule [`sync_engine_archives`] applies to a whole folder, exposed
/// for the callers that copy one named file: the menu modules and the retail
/// archives of [`crate::launch::prepare_basepath`]. Size and modification time
/// decide, and the copy is stamped with the source's time, so a second call
/// costs one `metadata` per file and no bytes.
///
/// A missing source is not an error and not a copy: a patch archive a player
/// does not have is exactly that case.
pub(crate) fn copy_if_changed(source: &Path, target: &Path) -> Result<bool> {
    let Ok(meta) = fs::metadata(source) else {
        return Ok(false);
    };
    if !meta.is_file() || !needs_copy(&meta, target) {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    fs::copy(source, target)
        .map_err(|e| AppError::io_path("cannot copy into", target, e))?;
    stamp_modified(target, &meta);
    Ok(true)
}

/// Whether the mirrored copy is missing, a different size, or a different age.
///
/// A destination whose metadata cannot be read counts as missing: copying a
/// file twice is cheap, and skipping one that is not really there is not.
fn needs_copy(source: &fs::Metadata, target: &Path) -> bool {
    let Ok(existing) = fs::metadata(target) else {
        return true;
    };
    if existing.len() != source.len() {
        return true;
    }
    match (existing.modified(), source.modified()) {
        (Ok(there), Ok(here)) => there != here,
        // A platform that will not report modification times leaves the size
        // as the only signal, and the size already matched.
        _ => false,
    }
}

/// Gives the copy the modification time of the original.
///
/// A failure costs one redundant copy on the next launch and nothing else, so
/// it is logged rather than propagated.
fn stamp_modified(target: &Path, source: &fs::Metadata) {
    let Ok(modified) = source.modified() else {
        return;
    };
    let stamped = File::options()
        .write(true)
        .open(target)
        .and_then(|file| file.set_modified(modified));
    if let Err(e) = stamped {
        log::warn!("cannot stamp the modification time of {}: {e}", target.display());
    }
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
    use std::io::{Cursor, Write};
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

    // --- slice: game core ---

    #[test]
    fn the_jk2mv_archive_unpacks_into_an_exe_and_a_base_folder() {
        // The real layout, listed from `jk2mv-v1.4.1-win32-x64-portable.zip`
        // on 2026-09-10: one top folder, the executables at its root and two
        // pk3 files in `base\`.
        let temp = tempfile::tempdir().expect("temp dir");
        let archive = temp.path().join("jk2mv.zip");
        write_zip(
            &archive,
            &[
                ("jk2mv-v1.4.1-win32-x64-portable/base/assetsmv.pk3", b"mv" as &[u8]),
                ("jk2mv-v1.4.1-win32-x64-portable/base/assetsmv2.pk3", b"mv2"),
                ("jk2mv-v1.4.1-win32-x64-portable/jk2mvmp.exe", b"MZ"),
                ("jk2mv-v1.4.1-win32-x64-portable/jk2mvded.exe", b"MZ"),
                ("jk2mv-v1.4.1-win32-x64-portable/jk2mvmenu_x64.dll", b"dll"),
                ("jk2mv-v1.4.1-win32-x64-portable/SDL2.dll", b"dll"),
            ],
        );

        let engine_dir = temp.path().join("engine");
        extract_archive(&archive, &engine_dir).expect("extraction succeeds");
        // The top folder is flattened, so the executable is where the engine
        // registry says it is.
        assert!(engine_dir.join("jk2mvmp.exe").is_file());
        // And the menu module ends up next to the binary that loads it, which
        // is also the working directory of the process.
        assert!(engine_dir.join("jk2mvmenu_x64.dll").is_file());
        // The engine's own archives stay here: `fs_basepath` points at this
        // folder, so they are on the search path where the archive put them.
        assert!(engine_dir.join("base").join("assetsmv.pk3").is_file());
        assert!(engine_dir.join("base").join("assetsmv2.pk3").is_file());
    }

    /// A client folder with an unpacked JK2MV in it: the executable, the menu
    /// module and the two archives the build ships in `base\`.
    fn jk2mv_client(root: &Path) -> (PathBuf, PathBuf) {
        let engine_dir = root.join("engine");
        let home_dir = root.join("home");
        fs::create_dir_all(engine_dir.join("base")).expect("engine base");
        fs::write(engine_dir.join("jk2mvmp.exe"), b"MZ").expect("exe");
        fs::write(engine_dir.join("base").join("assetsmv.pk3"), b"mv").expect("assetsmv");
        fs::write(engine_dir.join("base").join("assetsmv2.pk3"), b"mv2").expect("assetsmv2");
        (engine_dir, home_dir)
    }

    #[test]
    fn the_archives_of_the_build_are_mirrored_into_the_home_folder() {
        // Jedi Outcast keeps the game folder on `fs_basepath`, so this copy is
        // the only way JK2MV's own archives reach the search path.
        let temp = tempfile::tempdir().expect("temp dir");
        let (engine_dir, home_dir) = jk2mv_client(temp.path());

        let copied = sync_engine_archives(&engine_dir, &home_dir).expect("the first sync");
        assert_eq!(copied.len(), 2, "{copied:?}");
        assert!(copied.contains(&"assetsmv.pk3".to_string()));
        assert!(copied.contains(&"assetsmv2.pk3".to_string()));
        assert_eq!(
            fs::read(home_dir.join("base").join("assetsmv.pk3")).expect("the copy"),
            b"mv"
        );
        // Only archives travel: the executable and the DLLs stay next to the
        // binary, where the working directory of the process points.
        assert!(!home_dir.join("base").join("jk2mvmp.exe").exists());
    }

    #[test]
    fn a_second_sync_copies_nothing() {
        let temp = tempfile::tempdir().expect("temp dir");
        let (engine_dir, home_dir) = jk2mv_client(temp.path());

        sync_engine_archives(&engine_dir, &home_dir).expect("the first sync");
        let again = sync_engine_archives(&engine_dir, &home_dir).expect("the second sync");
        assert!(again.is_empty(), "{again:?}");

        // Idempotence is what makes the call on every launch free, so the size
        // and the modification time both have to survive the copy.
        let source = fs::metadata(engine_dir.join("base").join("assetsmv.pk3")).expect("source");
        let copy = fs::metadata(home_dir.join("base").join("assetsmv.pk3")).expect("copy");
        assert_eq!(source.len(), copy.len());
        assert_eq!(
            source.modified().expect("source time"),
            copy.modified().expect("copy time")
        );
    }

    #[test]
    fn a_new_build_replaces_the_mirrored_archive() {
        let temp = tempfile::tempdir().expect("temp dir");
        let (engine_dir, home_dir) = jk2mv_client(temp.path());
        sync_engine_archives(&engine_dir, &home_dir).expect("the first sync");

        // An engine update writes a different archive under the same name.
        fs::write(engine_dir.join("base").join("assetsmv.pk3"), b"mv 1.4.2")
            .expect("a newer archive");
        let copied = sync_engine_archives(&engine_dir, &home_dir).expect("the sync after an update");
        assert_eq!(copied, vec!["assetsmv.pk3".to_string()]);
        assert_eq!(
            fs::read(home_dir.join("base").join("assetsmv.pk3")).expect("the copy"),
            b"mv 1.4.2"
        );
    }

    #[test]
    fn a_rebuilt_archive_of_the_same_size_is_recognised_by_its_age() {
        let temp = tempfile::tempdir().expect("temp dir");
        let (engine_dir, home_dir) = jk2mv_client(temp.path());
        sync_engine_archives(&engine_dir, &home_dir).expect("the first sync");

        // Same two bytes, newer file: only the modification time tells them
        // apart, which is why the check does not stop at the size.
        let source = engine_dir.join("base").join("assetsmv.pk3");
        fs::write(&source, b"MV").expect("a rebuilt archive");
        File::options()
            .write(true)
            .open(&source)
            .expect("open the source")
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60))
            .expect("age the source");

        let copied = sync_engine_archives(&engine_dir, &home_dir).expect("the sync");
        assert_eq!(copied, vec!["assetsmv.pk3".to_string()]);
        assert_eq!(
            fs::read(home_dir.join("base").join("assetsmv.pk3")).expect("the copy"),
            b"MV"
        );
    }

    #[test]
    fn a_build_without_archives_is_synced_without_writing_anything() {
        // The Jedi Academy forks ship DLLs in `base\` and no pk3 at all, and
        // an engine that is not installed yet has no `base\` folder.
        let temp = tempfile::tempdir().expect("temp dir");
        let engine_dir = temp.path().join("engine");
        let home_dir = temp.path().join("home");

        assert!(sync_engine_archives(&engine_dir, &home_dir)
            .expect("a missing build is not an error")
            .is_empty());
        assert!(!home_dir.exists(), "nothing to copy means nothing created");

        fs::create_dir_all(engine_dir.join("base")).expect("engine base");
        fs::write(engine_dir.join("base").join("cgamex86.dll"), b"dll").expect("module");
        assert!(sync_engine_archives(&engine_dir, &home_dir)
            .expect("a build with no archives")
            .is_empty());
        assert!(!home_dir.exists());
    }

    #[test]
    fn an_engine_archive_is_only_ever_unpacked_into_the_engine_folder() {
        // `extract_archive` empties its target before filling it, and the
        // client folder holds one root that must never meet that: `basepath\`,
        // whose `base` entry is a junction into the player's game folder.
        let paths = DataPaths::new(PathBuf::from("C:\\JKNet"));
        let target = extract_target(&paths, "jk2");

        assert_eq!(target, paths.client_engine_dir("jk2"));
        assert_eq!(
            target.file_name().and_then(|name| name.to_str()),
            Some("engine")
        );
        assert_ne!(target, paths.client_basepath_dir("jk2"));
        assert_ne!(target, paths.client_home_dir("jk2"));
        assert!(!target.starts_with(paths.client_basepath_dir("jk2")));
    }

    #[test]
    fn unpacking_a_build_leaves_the_base_root_of_the_client_alone() {
        // The same rule, run rather than read: the extraction clears its own
        // folder and touches no sibling.
        let temp = tempfile::tempdir().expect("temp dir");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let link_stand_in = paths.client_basepath_dir("jk2").join("base");
        fs::create_dir_all(&link_stand_in).expect("the base root");
        fs::write(link_stand_in.join("assets0.pk3"), b"the player's game").expect("an archive");

        let archive = temp.path().join("jk2mv.zip");
        write_zip(&archive, &[("jk2mvmp.exe", b"MZ"), ("base/assetsmv.pk3", b"mv")]);
        extract_archive(&archive, &extract_target(&paths, "jk2")).expect("extraction succeeds");

        assert!(paths.client_engine_dir("jk2").join("jk2mvmp.exe").is_file());
        assert!(
            link_stand_in.join("assets0.pk3").is_file(),
            "the base root of the client is none of the installer's business"
        );
    }

    #[test]
    fn one_named_file_is_copied_only_when_it_differs() {
        let temp = tempfile::tempdir().expect("temp dir");
        let source = temp.path().join("jk2mvmenu_x64.dll");
        let target = temp.path().join("basepath").join("jk2mvmenu_x64.dll");
        fs::write(&source, b"menu").expect("the source");

        assert!(copy_if_changed(&source, &target).expect("the first copy"));
        assert!(!copy_if_changed(&source, &target).expect("the second call"));

        fs::write(&source, b"menu of 1.4.2").expect("a newer build");
        assert!(copy_if_changed(&source, &target).expect("the copy after an update"));
        assert_eq!(fs::read(&target).expect("the copy"), b"menu of 1.4.2".to_vec());

        // A source that is not there is not a failure: a patch archive the
        // player has not got looks exactly like this.
        assert!(!copy_if_changed(&temp.path().join("missing.pk3"), &target)
            .expect("a missing source"));
    }

    #[test]
    fn the_bundled_names_are_the_pk3_files_of_the_build() {
        // What `library.rs` asks to tell the player's files from the engine's.
        let temp = tempfile::tempdir().expect("temp dir");
        let (engine_dir, _home_dir) = jk2mv_client(temp.path());
        fs::write(engine_dir.join("base").join("notes.txt"), b"read me").expect("a stray file");

        let names = bundled_archive_names(&engine_dir);
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(names.contains("assetsmv.pk3"));
        assert!(names.contains("assetsmv2.pk3"));

        // Lowercase, because the engine's file lister does not care about case
        // and neither may the comparison that hides these files.
        fs::write(engine_dir.join("base").join("Extra.PK3"), b"pk3").expect("a loud name");
        assert!(bundled_archive_names(&engine_dir).contains("extra.pk3"));

        assert!(bundled_archive_names(temp.path().join("nothing").as_path()).is_empty());
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

    #[test]
    fn one_install_per_client_at_a_time() {
        let installs = InstallState::default();
        let first = installs
            .claim("everyday")
            .expect("the first install claims the client");
        let second = installs
            .claim("everyday")
            .expect_err("the second install of the same client is refused");
        assert!(
            matches!(second, AppError::Busy(_)),
            "unexpected error: {second}"
        );

        // A different client is a different folder and a different archive.
        let other = installs.claim("duel").expect("another client is free");
        drop(other);

        drop(first);
        installs
            .claim("everyday")
            .expect("the claim is released when the install ends");
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
