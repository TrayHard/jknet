//! Previewing a pk3 of a draft or of the catalogue the way the Library
//! screen previews a file of a client: the same session of
//! `file_preview::prepare`, the same grid of characters, hilts, weapons,
//! maps and sounds, and the same `get_file_preview_assets` and
//! `release_file_preview` afterwards.
//!
//! What differs is where the archive comes from and what it is previewed
//! against. A file of a draft is already on disk, in the `files\` folder of
//! the draft. A file of the catalogue is fetched first: from the store of
//! the service into `cache\bundles\preview\<sha256>.<ext>`, checked by its
//! hash and kept for the next preview, with `bundles:preview-progress`
//! along the way; or from jkhub.org the way an install fetches it, with the
//! pk3 of the manifest's name taken out of the archive of the record. Both
//! are previewed against the retail archives of the game alone
//! (`dependencies(…, None, game)`): a bundle belongs to no client yet.
//!
//! The same cache folder holds the small files of the store the
//! **Contents** dialog reads whole — a listing, a config — through
//! [`cached_blob_bytes`].

use std::fs;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, Result};
use crate::file_preview::{self, FilePreview};
use crate::game::Game;
use crate::jkhub::{self, JkhubState};
use crate::online::{OnlineClient, OnlineContext};
use crate::paths::{self, DataPaths};
use crate::state::AppState;

use super::draft;
use super::install;
use super::listing;
use super::manifest::{self, FileKind, FileRoot, FileSource as ManifestSource, Manifest, ManifestFile, MAX_FILE_BYTES};
use super::sha256_hex;
use super::types::PreviewProgress;

/// Event the preview dialog listens to while a file of the store comes down.
pub const PROGRESS_EVENT: &str = "bundles:preview-progress";

/// Shortest gap between two progress events of one download, in
/// milliseconds.
const PROGRESS_INTERVAL_MS: u128 = 150;

// ---------------------------------------------------------------------------
// The cache of files of the store
// ---------------------------------------------------------------------------

/// A small file of the store, whole: from `target` when the file there
/// hashes right, from `GET /v1/blobs/{sha256}` otherwise, written to
/// `target` for the next call. A file over `max_bytes` is refused before
/// it is read to the end.
pub(crate) async fn cached_blob_bytes(
    online: &OnlineClient,
    ctx: &OnlineContext,
    sha256: &str,
    target: &Path,
    max_bytes: u64,
) -> Result<Vec<u8>> {
    if let Ok(bytes) = fs::read(target) {
        if sha256_hex(&bytes) == sha256 {
            return Ok(bytes);
        }
        log::warn!("bundles: {} does not match its hash, fetching it again", target.display());
    }
    let response = online.get_blob(ctx, sha256, 0).await?;
    if response.content_length().is_some_and(|length| length > max_bytes) {
        return Err(too_big(sha256, max_bytes));
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("the download stopped: {e}")))?;
        if bytes.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err(too_big(sha256, max_bytes));
        }
        bytes.extend_from_slice(&chunk);
    }
    if sha256_hex(&bytes) != sha256 {
        return Err(AppError::BundleFile {
            path: sha256.to_string(),
            reason: "the fetched file does not match its hash".into(),
        });
    }
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    crate::user_files::write_bytes(target, &bytes)?;
    Ok(bytes)
}

fn too_big(sha256: &str, max_bytes: u64) -> AppError {
    AppError::InvalidInput(format!(
        "{sha256} is bigger than the {} KiB this dialog reads",
        max_bytes / 1024
    ))
}

/// A file of the store on disk at `target`: left alone when the file there
/// has the size and hash of the manifest, streamed down into `target.part`
/// and moved into place otherwise. `report` hears the bytes so far and the
/// bytes in all.
async fn cached_blob_file(
    online: &OnlineClient,
    ctx: &OnlineContext,
    sha256: &str,
    size: u64,
    target: &Path,
    report: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<()> {
    if fs::metadata(target).is_ok_and(|meta| meta.is_file() && meta.len() == size)
        && install::hash_off_thread(target).await? == sha256
    {
        report(size, size);
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    let partial = target.with_extension("part");
    let response = online.get_blob(ctx, sha256, 0).await?;
    let total = response.content_length().unwrap_or(size);
    if total > MAX_FILE_BYTES {
        return Err(too_big(sha256, MAX_FILE_BYTES));
    }
    let mut sink = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| AppError::io_path("cannot create", &partial, e))?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    let mut last = std::time::Instant::now();
    report(0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("the download stopped: {e}")))?;
        received += chunk.len() as u64;
        if received > MAX_FILE_BYTES {
            drop(sink);
            let _ = fs::remove_file(&partial);
            return Err(too_big(sha256, MAX_FILE_BYTES));
        }
        sink.write_all(&chunk)
            .await
            .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
        if last.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
            last = std::time::Instant::now();
            report(received, total);
        }
    }
    sink.flush()
        .await
        .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
    drop(sink);
    report(received, total);
    if install::hash_off_thread(&partial).await? != sha256 {
        let _ = fs::remove_file(&partial);
        return Err(AppError::BundleFile {
            path: sha256.to_string(),
            reason: "the fetched file does not match the hash of the manifest".into(),
        });
    }
    if target.exists() {
        fs::remove_file(target).map_err(|e| AppError::io_path("cannot replace", target, e))?;
    }
    fs::rename(&partial, target).map_err(|e| AppError::io_path("cannot move into", target, e))?;
    Ok(())
}

/// Where a previewed file of the catalogue lies: the hash of the manifest
/// with the extension of the path, so the preview opens it as a pk3.
fn preview_path(paths: &DataPaths, file: &ManifestFile) -> PathBuf {
    let name = file.path.rsplit('/').next().unwrap_or(&file.path);
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| !ext.is_empty() && ext.chars().all(|ch| ch.is_ascii_alphanumeric()))
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "bin".to_string());
    paths
        .bundle_preview_cache_dir()
        .join(format!("{}.{extension}", file.sha256))
}

// ---------------------------------------------------------------------------
// The file of the catalogue
// ---------------------------------------------------------------------------

/// The file of a manifest at `path` of `scope` and `root`.
pub(crate) fn manifest_file<'a>(manifest: &'a Manifest, scope: &str, root: FileRoot, path: &str) -> Result<&'a ManifestFile> {
    let list: &[ManifestFile] = if scope == manifest::SHARED_SCOPE {
        &manifest.shared.files
    } else {
        let component = manifest
            .component(scope)
            .ok_or_else(|| AppError::NotFound(format!("component {scope} of the bundle")))?;
        match root {
            FileRoot::Home => &component.files,
            FileRoot::Engine => &component.overlay.files,
        }
    };
    list.iter()
        .find(|file| file.root == root && file.path.eq_ignore_ascii_case(path))
        .ok_or_else(|| AppError::NotFound(format!("{}/{path} in {scope}", root.as_str())))
}

/// Refuses a file the preview cannot open.
fn require_pk3(path: &str) -> Result<()> {
    if FileKind::of_path(path) != FileKind::Pk3 {
        return Err(AppError::InvalidInput(format!(
            "{path} is not a pk3, and only a pk3 can be previewed"
        )));
    }
    Ok(())
}

/// Fetches a file of the catalogue into the preview cache, or finds it
/// there, and answers with its path.
async fn fetch_for_preview(
    app: &AppHandle,
    online: &OnlineClient,
    ctx: &OnlineContext,
    jkhub: &JkhubState,
    paths: &DataPaths,
    file: &ManifestFile,
) -> Result<PathBuf> {
    let target = preview_path(paths, file);
    match &file.source {
        ManifestSource::Blob => {
            let (handle, sha256) = (app.clone(), file.sha256.clone());
            let mut report = move |downloaded: u64, total: u64| {
                let progress = PreviewProgress {
                    sha256: sha256.clone(),
                    downloaded,
                    total,
                };
                if let Err(e) = handle.emit(PROGRESS_EVENT, progress) {
                    log::warn!("cannot emit {PROGRESS_EVENT}: {e}");
                }
            };
            cached_blob_file(online, ctx, &file.sha256, file.size, &target, &mut report)
                .await
                .map_err(|e| match e {
                    AppError::BundleFile { .. } => e,
                    other => AppError::BundleFile {
                        path: file.path.clone(),
                        reason: other.to_string(),
                    },
                })?;
        }
        ManifestSource::Jkhub { file_id, .. } => {
            let file_id = *file_id;
            // What JKHub serves today may differ from the manifest, the way
            // an install allows for: the file is kept under the hash of the
            // manifest and reused by its presence, not by its hash.
            if fs::metadata(&target).is_ok_and(|meta| meta.is_file() && meta.len() > 0) {
                return Ok(target);
            }
            let _guard = jkhub.claim(file_id)?;
            let mut report = |_: u64, _: u64| {};
            let archive = install::fetch_jkhub_archive(app, jkhub, paths, file_id, &mut report).await?;
            let file_name = file.path.rsplit('/').next().unwrap_or(&file.path).to_string();
            let staging = paths.bundle_preview_cache_dir().join(format!("jkhub-{file_id}"));
            let (archive_path, target_for_move, manifest_path) = (archive.archive.clone(), target.clone(), file.path.clone());
            tauri::async_runtime::spawn_blocking(move || -> Result<()> {
                let contents = jkhub::install::read_archive(&archive_path)?;
                let entry = contents
                    .pk3
                    .iter()
                    .find(|entry| entry.file_name.eq_ignore_ascii_case(&file_name))
                    .cloned()
                    .ok_or_else(|| AppError::BundleFile {
                        path: manifest_path.clone(),
                        reason: format!("JKHub record {file_id} holds no {file_name}"),
                    })?;
                paths::create_dir(&staging)?;
                let written = jkhub::install::extract(&archive_path, &[entry], &staging)?;
                let landed = staging.join(written.first().map(String::as_str).unwrap_or(&file_name));
                if target_for_move.exists() {
                    let _ = fs::remove_file(&target_for_move);
                }
                fs::rename(&landed, &target_for_move)
                    .map_err(|e| AppError::io_path("cannot move into", &target_for_move, e))?;
                let _ = fs::remove_dir_all(&staging);
                Ok(())
            })
            .await
            .map_err(|e| AppError::State(format!("the unpacker stopped: {e}")))??;
            jkhub::cache::forget_download(paths, file_id);
        }
    }
    Ok(target)
}

/// Opens the preview session of an archive against the retail archives of
/// the game, on a blocking thread, and allows its icons for the webview.
async fn open_session(app: &AppHandle, state: &AppState, archive: PathBuf, game: Game) -> Result<FilePreview> {
    let data = state.paths()?;
    let deps = file_preview::dependencies(&data, &state.settings()?, None, game)?;
    let preview = tauri::async_runtime::spawn_blocking(move || file_preview::prepare(&data, vec![archive], deps))
        .await
        .map_err(|e| AppError::State(e.to_string()))??;
    file_preview::allow_icons(app, &preview);
    Ok(preview)
}

/// The archive of a draft to preview, checked to be a pk3 that is there.
pub(crate) fn draft_archive(paths: &DataPaths, draft_id: &str, scope: &str, root: FileRoot, path: &str) -> Result<(PathBuf, Game)> {
    let draft = draft::read_draft(paths, draft_id)?;
    let file = listing::find_draft_file(&draft, scope, root, path)?;
    require_pk3(&file.path)?;
    let archive = draft::file_path(paths, draft_id, scope, root, &file.path)?;
    if !archive.is_file() {
        return Err(AppError::NotFound(format!("the file {} of the draft", file.path)));
    }
    Ok((archive, draft.game))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Previews a pk3 of a draft.
#[tauri::command]
pub async fn preview_draft_file(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    draft_id: String,
    scope: String,
    root: FileRoot,
    path: String,
) -> Result<FilePreview> {
    let (archive, game) = draft_archive(&state.paths()?, &draft_id, scope.trim(), root, path.trim())?;
    open_session(&app, &state, archive, game).await
}

/// Previews a pk3 of a version of the catalogue, fetched first from the
/// store or from JKHub. Progress arrives through `bundles:preview-progress`
/// for the store and `jkhub:download-progress` for JKHub.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_bundle_file(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    jkhub: tauri::State<'_, JkhubState>,
    bundle_id: String,
    version_id: String,
    scope: String,
    root: FileRoot,
    path: String,
) -> Result<FilePreview> {
    let paths = state.paths()?;
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let (_, version) = super::fetch_version(&online, &ctx, bundle_id.trim(), version_id.trim()).await?;
    let manifest = &version.manifest;
    let game = Game::from_id(&manifest.game).ok_or_else(|| {
        AppError::BundleUnavailable(format!("the game {:?} is not one of ours", manifest.game))
    })?;
    let file = manifest_file(manifest, scope.trim(), root, path.trim())?;
    require_pk3(&file.path)?;
    manifest::check_path(&file.path)?;
    manifest::check_sha256(&file.sha256)?;
    let archive = fetch_for_preview(&app, &online, &ctx, &jkhub, &paths, file).await?;
    open_session(&app, &state, archive, game).await
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;
    use crate::bundles::draft::test_support::{component, empty_draft, put_draft_file};
    use crate::bundles::draft::DraftOrigin;
    use crate::bundles::manifest::test_support::{file, manifest as design_manifest};
    use crate::engines::LaunchMode;

    #[test]
    fn a_file_of_the_manifest_is_found_by_scope_root_and_path() {
        let manifest = design_manifest();
        let japro = manifest_file(&manifest, "mp", FileRoot::Home, "ETERNALJK/japro-assets.pk3").expect("found");
        assert!(matches!(japro.source, ManifestSource::Jkhub { file_id: 3937, .. }));
        let exe = manifest_file(&manifest, "mp", FileRoot::Engine, "eternaljk.x86.exe").expect("the overlay");
        assert_eq!(exe.kind, FileKind::Exe);
        assert!(require_pk3(&exe.path).is_err());
        require_pk3(&japro.path).expect("a pk3");
        let shared = manifest_file(&manifest, "shared", FileRoot::Home, "base/rus_sp.pk3").expect("shared");
        assert_eq!(shared.source, ManifestSource::Blob);
        assert!(matches!(
            manifest_file(&manifest, "mp", FileRoot::Home, "eternaljk.x86.exe").unwrap_err(),
            AppError::NotFound(_)
        ));
        assert!(matches!(
            manifest_file(&manifest, "mme", FileRoot::Home, "base/rus_sp.pk3").unwrap_err(),
            AppError::NotFound(_)
        ));

        // The cache path carries the hash and the extension of the path.
        let paths = DataPaths::new(PathBuf::from("C:\\JKNet"));
        assert_eq!(
            preview_path(&paths, shared),
            paths.bundle_preview_cache_dir().join(format!("{}.pk3", shared.sha256))
        );
        let odd = file(FileRoot::Home, "base/README", ManifestSource::Blob);
        assert!(preview_path(&paths, &odd).to_string_lossy().ends_with(".bin"));
    }

    #[test]
    fn a_pk3_of_a_draft_opens_a_preview_session_without_a_client() {
        let temp = tempfile::tempdir().expect("a data root");
        let state = AppState::bootstrap(temp.path().to_path_buf());
        let paths = state.paths().unwrap();
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "eternaljk", &[LaunchMode::Multiplayer]));
        let mut pk3 = Vec::new();
        {
            let mut writer = ZipWriter::new(std::io::Cursor::new(&mut pk3));
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for (name, body) in [
                ("models/players/hero/model.glm", b"model" as &[u8]),
                ("models/players/hero/model_default.skin", b"body,models/players/hero/body"),
                ("sound/chars/hero/misc/taunt1.mp3", b"voice"),
                ("maps/duel.bsp", b"map"),
                ("scripts/duel.arena", b"{ map duel }"),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(body).unwrap();
            }
            writer.finish().unwrap();
        }
        let file = put_draft_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "base/hero.pk3",
            &pk3,
            DraftOrigin::Disk {
                source_path: "D:/hero.pk3".into(),
            },
        );
        draft.components[0].files.push(file);
        draft.components[0].files.push(put_draft_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "base/autoexec.cfg",
            b"seta cg_fov 97\n",
            DraftOrigin::Disk {
                source_path: "D:/autoexec.cfg".into(),
            },
        ));
        draft::write_draft(&paths, &draft).unwrap();

        let (archive, game) = draft_archive(&paths, &draft.id, "mp", FileRoot::Home, "base/HERO.pk3").expect("the archive");
        assert_eq!(game, Game::JediAcademy);
        assert!(archive.is_file());
        // No game folder in the settings of a fresh state: the dependencies
        // are empty, and the session opens on the archive alone.
        let deps = file_preview::dependencies(&paths, &state.settings().unwrap(), None, game).unwrap();
        assert!(deps.is_empty());
        let preview = file_preview::prepare(&paths, vec![archive], deps).expect("the session opens");
        assert_eq!(preview.archives, ["hero.pk3"]);
        let kinds: Vec<&str> = preview.entries.iter().map(|entry| entry.kind.as_str()).collect();
        assert!(kinds.contains(&"skin"), "{kinds:?}");
        assert!(kinds.contains(&"map"), "{kinds:?}");
        file_preview::release_file_preview(preview.id).unwrap();

        // Not a pk3, not there, not a scope.
        assert!(matches!(
            draft_archive(&paths, &draft.id, "mp", FileRoot::Home, "base/autoexec.cfg").unwrap_err(),
            AppError::InvalidInput(_)
        ));
        assert!(matches!(
            draft_archive(&paths, &draft.id, "mp", FileRoot::Home, "base/ghost.pk3").unwrap_err(),
            AppError::NotFound(_)
        ));
        assert!(matches!(
            draft_archive(&paths, &draft.id, "sp", FileRoot::Home, "base/hero.pk3").unwrap_err(),
            AppError::NotFound(_)
        ));
    }
}
