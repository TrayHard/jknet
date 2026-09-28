//! Importing an existing portable client into JKNet.
//!
//! The source folder is treated as a snapshot. JKNet recognises a supported
//! engine by its executable, copies every regular file into the client's
//! `engine\` folder, and never writes back to the source. The separate
//! `home\` folder stays available for everything the imported engine writes
//! after JKNet starts it.

use std::{
    collections::{BTreeSet, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{
    clients::{self, Client, EngineOrigin},
    engines::{self, Engine},
    error::{AppError, Result},
    game::Game,
    host_system::HostSystem,
    media, paths,
    state::AppState,
    timestamp,
};

const IMPORT_VERSION: &str = "imported";
const MAX_IMPORT_FILES: usize = 200_000;
const MAX_IMPORT_DEPTH: usize = 48;

/// Summary shown before a folder is copied.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientImportPreview {
    pub source_path: String,
    pub suggested_name: String,
    pub engine_id: String,
    pub engine_name: String,
    pub game: Game,
    pub file_count: u64,
    pub size_bytes: u64,
    pub screenshot_count: u64,
    pub demo_count: u64,
    pub mod_folders: Vec<String>,
    pub recommended_fs_game: Option<String>,
}

/// Result of one completed import.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientImportResult {
    pub client: Client,
    pub media_imported: u64,
    pub media_warning: Option<String>,
}

#[derive(Debug)]
struct SourceFile {
    path: PathBuf,
    relative: PathBuf,
    size: u64,
}

#[derive(Debug)]
struct Inspection {
    source: PathBuf,
    engine: &'static Engine,
    files: Vec<SourceFile>,
    preview: ClientImportPreview,
}

/// Source folders with an import in flight.
///
/// The button is disabled while its own request runs, but a second window can
/// choose the same folder. Refusing the second call protects the destination
/// from two copies built from a source that may be changing under them.
#[derive(Debug, Default)]
pub struct ImportState {
    busy: Mutex<HashSet<PathBuf>>,
}

impl ImportState {
    fn claim(&self, source: &Path) -> Result<ImportGuard<'_>> {
        let mut busy = self
            .busy
            .lock()
            .map_err(|_| AppError::State("the client import lock is poisoned".into()))?;
        if !busy.insert(source.to_path_buf()) {
            return Err(AppError::Busy(
                "This client folder is already being imported. Wait for it to finish.".into(),
            ));
        }
        Ok(ImportGuard {
            state: self,
            source: source.to_path_buf(),
        })
    }
}

#[derive(Debug)]
struct ImportGuard<'a> {
    state: &'a ImportState,
    source: PathBuf,
}

impl Drop for ImportGuard<'_> {
    fn drop(&mut self) {
        match self.state.busy.lock() {
            Ok(mut busy) => {
                busy.remove(&self.source);
            }
            Err(error) => log::error!(
                "cannot release the client import claim of {}: {error}",
                self.source.display()
            ),
        }
    }
}

/// Inspects an existing client folder without changing it.
#[tauri::command]
pub async fn inspect_client_import(source_path: String) -> Result<ClientImportPreview> {
    tauri::async_runtime::spawn_blocking(move || Ok(inspect(Path::new(&source_path))?.preview))
        .await
        .map_err(|error| {
            AppError::State(format!("the client inspection thread stopped: {error}"))
        })?
}

/// Copies an existing portable client and creates its JKNet record.
#[tauri::command]
pub async fn import_client(
    app: AppHandle,
    source_path: String,
    name: String,
    fs_game: Option<String>,
    launch_args: String,
) -> Result<ClientImportResult> {
    let work_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = work_app.state::<AppState>();
        let imports = work_app.state::<ImportState>();
        import_client_blocking(
            &work_app,
            &state,
            &imports,
            source_path,
            name,
            fs_game,
            launch_args,
        )
    })
    .await
    .map_err(|error| AppError::State(format!("the client import thread stopped: {error}")))?
}

fn import_client_blocking(
    app: &AppHandle,
    state: &AppState,
    imports: &ImportState,
    source_path: String,
    name: String,
    fs_game: Option<String>,
    launch_args: String,
) -> Result<ClientImportResult> {
    let inspection = inspect(Path::new(&source_path))?;
    let _claim = imports.claim(&inspection.source)?;
    let name = clients::validate_name(&name)?;
    let fs_game = clients::validate_fs_game(fs_game.as_deref().unwrap_or_default())?;
    let paths = state.paths()?;

    let _records = state.client_records().enter();
    let taken = clients::read_all(&paths)?
        .into_iter()
        .map(|client| client.id)
        .collect::<Vec<_>>();
    let id = clients::unique_slug(&name, &taken);
    let client_dir = paths.client_dir(&id);
    let engine_dir = paths.client_engine_dir(&id);
    if client_dir.exists() {
        return Err(AppError::AlreadyExists(client_dir.display().to_string()));
    }
    if client_dir.starts_with(&inspection.source) {
        return Err(AppError::InvalidInput(
            "the selected folder contains JKNet's destination folder".into(),
        ));
    }
    paths.ensure()?;

    let copied = copy_snapshot(&inspection.files, &inspection.source, &engine_dir);
    if let Err(error) = copied {
        remove_failed_import(&client_dir);
        return Err(error);
    }
    let home_dir = paths.client_home_dir(&id);
    if let Err(error) = mirror_playable_content(&inspection, &engine_dir, &home_dir) {
        remove_failed_import(&client_dir);
        return Err(error);
    }

    let client = Client {
        id,
        name,
        engine_id: inspection.engine.id.to_string(),
        game: inspection.engine.game,
        engine_version: Some(IMPORT_VERSION.into()),
        engine_origin: EngineOrigin::Imported,
        created_at: timestamp::now_rfc3339(),
        engine_installed_at: Some(timestamp::now_rfc3339()),
        engine_published_at: None,
        fs_game: fs_game.or_else(|| inspection.preview.recommended_fs_game.clone()),
        launch_args: launch_args.trim().to_string(),
        modes: inspection.engine.modes(),
        bundle: None,
    };
    if let Err(error) = clients::write_record(&paths, &client) {
        remove_failed_import(&client_dir);
        return Err(error);
    }
    drop(_records);

    // Existing screenshots and demos live inside the copied snapshot rather
    // than in `home\`. Put content-addressed copies in the shared Media bank
    // immediately; later files written into `home\` are found by its regular
    // refresh.
    let media = media::import_client_tree(state, &client, &engine_dir);
    let (media_imported, media_warning) = match media {
        Ok(count) => (count, None),
        Err(error) => {
            log::warn!("media import for {}: {error}", client.id);
            (0, Some(error.to_string()))
        }
    };

    clients::emit_changed(app, &client.id);
    log::info!(
        "imported client {} from {} as {} ({}, {} file(s), {} media item(s))",
        client.id,
        inspection.source.display(),
        client.engine_id,
        client.game.display_name(),
        inspection.files.len(),
        media_imported
    );
    Ok(ClientImportResult {
        client,
        media_imported,
        media_warning,
    })
}

fn inspect(source: &Path) -> Result<Inspection> {
    let source = fs::canonicalize(source)
        .map_err(|error| AppError::io_path("cannot open the client folder", source, error))?;
    if !source.is_dir() {
        return Err(AppError::InvalidInput(
            "select the folder that contains the client executable".into(),
        ));
    }
    let matches = engines::all()
        .iter()
        .filter(|engine| engine.installed_executable(&source).is_file())
        .collect::<Vec<_>>();
    let engine = match matches.as_slice() {
        [engine] => *engine,
        [] => {
            let names = engines::all()
                .iter()
                .map(|engine| engine.executable)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(AppError::InvalidInput(format!(
                "the folder has no supported client executable. Expected one of: {names}"
            )));
        }
        many => {
            let names = many
                .iter()
                .map(|engine| engine.name)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(AppError::InvalidInput(format!(
                "the folder contains more than one supported client: {names}. Select a folder with one client."
            )));
        }
    };
    engine.require_host(HostSystem::current())?;

    let files = collect_files(&source)?;
    if files.is_empty() {
        return Err(AppError::InvalidInput("the client folder is empty".into()));
    }
    let mut screenshot_count = 0u64;
    let mut demo_count = 0u64;
    let mut mod_folders = BTreeSet::new();
    for file in &files {
        let normalized = file.relative.to_string_lossy().replace('\\', "/");
        let lower = normalized.to_ascii_lowercase();
        let extension = file
            .path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ["png", "jpg", "jpeg", "tga", "bmp"].contains(&extension.as_str())
            && lower.contains("/screenshots/")
        {
            screenshot_count += 1;
        }
        if engine.game.demo_extensions().contains(&extension.as_str()) && lower.contains("/demos/")
        {
            demo_count += 1;
        }
        if matches!(
            extension.as_str(),
            "pk3" | "cfg" | "dm_15" | "dm_16" | "dm_25" | "dm_26"
        ) {
            if let Some(folder) = first_folder(&file.relative) {
                if !folder.eq_ignore_ascii_case(paths::BASE_FOLDER) {
                    mod_folders.insert(folder);
                }
            }
        }
    }
    let mod_folders = mod_folders.into_iter().collect::<Vec<_>>();
    let recommended_fs_game = engine
        .default_fs_game
        .filter(|folder| source.join(folder).is_dir())
        .map(str::to_string)
        .or_else(|| (mod_folders.len() == 1).then(|| mod_folders[0].clone()));
    let suggested_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(engine.name)
        .to_string();
    let preview = ClientImportPreview {
        source_path: source.display().to_string(),
        suggested_name,
        engine_id: engine.id.to_string(),
        engine_name: engine.name.to_string(),
        game: engine.game,
        file_count: files.len() as u64,
        size_bytes: files.iter().map(|file| file.size).sum(),
        screenshot_count,
        demo_count,
        mod_folders,
        recommended_fs_game,
    };
    Ok(Inspection {
        source,
        engine,
        files,
        preview,
    })
}

fn collect_files(root: &Path) -> Result<Vec<SourceFile>> {
    let mut files = Vec::new();
    collect_under(root, root, 0, &mut files)?;
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(files)
}

fn collect_under(root: &Path, dir: &Path, depth: usize, files: &mut Vec<SourceFile>) -> Result<()> {
    if depth > MAX_IMPORT_DEPTH {
        return Err(AppError::InvalidInput(format!(
            "the client folder is nested more than {MAX_IMPORT_DEPTH} levels deep"
        )));
    }
    let entries = fs::read_dir(dir)
        .map_err(|error| AppError::io_path("cannot read the client folder", dir, error))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| AppError::io_path("cannot read the client folder", dir, error))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|error| AppError::io_path("cannot inspect", &path, error))?;
        if kind.is_symlink() {
            return Err(AppError::InvalidInput(format!(
                "the client folder contains a link at {}. Replace it with regular files before importing.",
                path.display()
            )));
        }
        if kind.is_dir() {
            collect_under(root, &path, depth + 1, files)?;
            continue;
        }
        if !kind.is_file() {
            return Err(AppError::InvalidInput(format!(
                "the client folder contains an unsupported entry at {}",
                path.display()
            )));
        }
        if files.len() >= MAX_IMPORT_FILES {
            return Err(AppError::InvalidInput(format!(
                "the client folder contains more than {MAX_IMPORT_FILES} files"
            )));
        }
        let metadata = entry
            .metadata()
            .map_err(|error| AppError::io_path("cannot inspect", &path, error))?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| AppError::State("an imported file escaped its source folder".into()))?
            .to_path_buf();
        files.push(SourceFile {
            path,
            relative,
            size: metadata.len(),
        });
    }
    Ok(())
}

fn copy_snapshot(files: &[SourceFile], source_root: &Path, target: &Path) -> Result<()> {
    paths::create_dir(target)?;
    let source_root = fs::canonicalize(source_root)
        .map_err(|error| AppError::io_path("cannot inspect", source_root, error))?;
    for source in files {
        copy_file(
            &source.path,
            source.size,
            &source_root,
            &target.join(&source.relative),
        )?;
    }
    Ok(())
}

/// Mirrors the folders the game treats as writable into `home\`.
///
/// Jedi Academy already searches the imported snapshot as `fs_basepath`, but
/// Jedi Outcast uses JKNet's separate `basepath\`. Keeping `base\` and every
/// detected mod under `home\` makes the imported configuration and mod files
/// visible to both layouts. The untouched, complete snapshot remains under
/// `engine\` either way.
fn mirror_playable_content(inspection: &Inspection, snapshot: &Path, home: &Path) -> Result<()> {
    paths::create_dir(&home.join(paths::BASE_FOLDER))?;
    let snapshot_root = fs::canonicalize(snapshot)
        .map_err(|error| AppError::io_path("cannot inspect", snapshot, error))?;
    for source in &inspection.files {
        let Some(folder) = source.relative.components().next() else {
            continue;
        };
        let Some(folder) = folder.as_os_str().to_str() else {
            continue;
        };
        let is_base = folder.eq_ignore_ascii_case(paths::BASE_FOLDER);
        let is_mod = inspection
            .preview
            .mod_folders
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(folder));
        if !is_base && !is_mod {
            continue;
        }

        // The complete originals stay in `engine\` and are copied into the
        // shared Media bank below. Mirroring them would make the next Media
        // refresh report the same file twice for one client.
        let is_media = source.relative.components().any(|component| {
            component.as_os_str().to_str().is_some_and(|part| {
                matches!(part.to_ascii_lowercase().as_str(), "screenshots" | "demos")
            })
        });
        if is_media {
            continue;
        }

        // The retail archives stay in the complete engine snapshot. JKNet
        // supplies them from the configured game folder, so duplicating them
        // in the writable tree would spend several gigabytes for no benefit.
        let is_retail_asset = is_base
            && source
                .relative
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    inspection
                        .engine
                        .game
                        .spec()
                        .assets
                        .iter()
                        .any(|asset| asset.name.eq_ignore_ascii_case(name))
                });
        if is_retail_asset {
            continue;
        }
        copy_file(
            &snapshot.join(&source.relative),
            source.size,
            &snapshot_root,
            &home.join(&source.relative),
        )?;
    }
    Ok(())
}

fn copy_file(
    source: &Path,
    expected_size: u64,
    allowed_root: &Path,
    destination: &Path,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| AppError::io_path("cannot inspect", source, error))?;
    let canonical = fs::canonicalize(source)
        .map_err(|error| AppError::io_path("cannot inspect", source, error))?;
    if !metadata.file_type().is_file()
        || !canonical.starts_with(allowed_root)
        || metadata.len() != expected_size
    {
        return Err(AppError::InvalidInput(format!(
            "the client file {} changed during import",
            source.display()
        )));
    }
    if let Some(parent) = destination.parent() {
        paths::create_dir(parent)?;
    }
    let copied = fs::copy(source, destination)
        .map_err(|error| AppError::io_path("cannot import into", destination, error))?;
    if copied != expected_size {
        return Err(AppError::InvalidInput(format!(
            "the client file {} changed during import",
            source.display()
        )));
    }
    if let Ok(modified) = fs::metadata(source).and_then(|metadata| metadata.modified()) {
        if let Err(error) = File::options()
            .write(true)
            .open(destination)
            .and_then(|file| file.set_modified(modified))
        {
            log::warn!(
                "cannot preserve the date of {}: {error}",
                destination.display()
            );
        }
    }
    Ok(())
}

fn first_folder(relative: &Path) -> Option<String> {
    let mut components = relative.components();
    let first = components.next()?.as_os_str().to_str()?;
    components.next()?;
    Some(first.to_string())
}

fn remove_failed_import(dir: &Path) {
    if let Err(error) = fs::remove_dir_all(dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::error!(
                "cannot remove failed client import {}: {error}",
                dir.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn portable_client(root: &Path) {
        fs::create_dir_all(root.join("base/screenshots")).unwrap();
        fs::create_dir_all(root.join("japro/demos")).unwrap();
        fs::write(root.join("eternaljk.x86.exe"), b"MZ").unwrap();
        fs::write(root.join("base/screenshots/shot.jpg"), b"jpg").unwrap();
        fs::write(root.join("japro/demos/duel.dm_26"), b"demo").unwrap();
        fs::write(root.join("japro/client.pk3"), b"pk3").unwrap();
    }

    #[test]
    fn inspection_recognises_the_engine_mod_and_media() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("My EternalJK");
        portable_client(&source);

        let found = inspect(&source).unwrap();

        assert_eq!(found.preview.engine_id, "eternaljk");
        assert_eq!(found.preview.game, Game::JediAcademy);
        assert_eq!(found.preview.suggested_name, "My EternalJK");
        assert_eq!(found.preview.screenshot_count, 1);
        assert_eq!(found.preview.demo_count, 1);
        assert_eq!(found.preview.mod_folders, vec!["japro"]);
        assert_eq!(found.preview.recommended_fs_game.as_deref(), Some("japro"));
    }

    #[test]
    fn snapshot_copy_preserves_every_regular_file() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        portable_client(&source);
        let files = collect_files(&source).unwrap();

        copy_snapshot(&files, &source, &target).unwrap();

        for file in files {
            assert_eq!(
                fs::read(&file.path).unwrap(),
                fs::read(target.join(file.relative)).unwrap()
            );
        }
    }

    #[test]
    fn a_source_that_changes_after_inspection_is_refused() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        portable_client(&source);
        let files = collect_files(&source).unwrap();
        fs::write(source.join("japro/client.pk3"), b"changed after inspection").unwrap();

        assert!(copy_snapshot(&files, &source, &target).is_err());
    }

    #[test]
    fn playable_content_is_mirrored_without_retail_archives() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let home = temp.path().join("home");
        portable_client(&source);
        fs::write(source.join("base/assets0.pk3"), b"retail").unwrap();
        let inspection = inspect(&source).unwrap();

        let snapshot = temp.path().join("snapshot");
        copy_snapshot(&inspection.files, &inspection.source, &snapshot).unwrap();
        mirror_playable_content(&inspection, &snapshot, &home).unwrap();

        assert!(!home.join("base/screenshots/shot.jpg").exists());
        assert_eq!(fs::read(home.join("japro/client.pk3")).unwrap(), b"pk3");
        assert!(!home.join("base/assets0.pk3").exists());
        assert!(!home.join("eternaljk.x86.exe").exists());
    }

    #[test]
    fn links_are_refused_instead_of_followed() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        portable_client(&source);
        #[cfg(unix)]
        std::os::unix::fs::symlink(temp.path(), source.join("linked")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(temp.path(), source.join("linked")).is_err() {
            // Windows without Developer Mode refuses unprivileged symbolic
            // links. The behavior is covered on hosts that can create one.
            return;
        }

        assert!(collect_files(&source).is_err());
    }
}
