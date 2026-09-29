//! Importing an existing portable client into JKNet.
//!
//! The source folder is treated as a snapshot. JKNet recognises a supported
//! engine by its executable, copies its client files into the client's
//! `engine\` folder, and never writes back to the source. Retail asset archives
//! stay shared through the configured game folder instead of being duplicated.
//! An explicit option may remove the source only after a byte-for-byte
//! verification. The separate `home\` folder stays available for everything
//! the imported engine writes after JKNet starts it.

use std::{
    collections::{BTreeSet, HashSet},
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    clients::{self, Client, EngineOrigin},
    engine_install,
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
const PROGRESS_EVENT: &str = "clients:import-progress";
const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

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
    pub screenshot_size_bytes: u64,
    pub demo_count: u64,
    pub demo_size_bytes: u64,
    pub config_count: u64,
    pub config_size_bytes: u64,
    pub config_files: Vec<ClientImportFile>,
    pub pk3_count: u64,
    pub pk3_size_bytes: u64,
    pub pk3_files: Vec<ClientImportFile>,
    pub required_files: Vec<ClientImportFile>,
    pub mod_folders: Vec<String>,
    pub recommended_fs_game: Option<String>,
    pub can_upgrade_engine: bool,
}

/// One source file shown in the import dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientImportFile {
    pub path: String,
    pub size_bytes: u64,
}

/// Optional file categories chosen in the import dialog.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientImportSelection {
    pub screenshots: bool,
    pub demos: bool,
    pub configs: bool,
    pub pk3: bool,
    #[serde(default)]
    pub excluded_configs: Vec<String>,
    #[serde(default)]
    pub excluded_pk3: Vec<String>,
}

impl ClientImportSelection {
    fn all(&self) -> bool {
        self.screenshots
            && self.demos
            && self.configs
            && self.pk3
            && self.excluded_configs.is_empty()
            && self.excluded_pk3.is_empty()
    }
}

/// Progress of one import request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientImportProgress {
    pub request_id: String,
    pub client_id: Option<String>,
    /// `copy`, `prepare`, `media`, `upgrade`, `delete`, `done` or `error`.
    pub phase: &'static str,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub current_file: Option<String>,
}

/// Result of one completed import.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientImportResult {
    pub client: Client,
    pub media_imported: u64,
    pub media_warning: Option<String>,
    pub engine_upgraded: bool,
    pub engine_upgrade_warning: Option<String>,
    pub source_deleted: bool,
    pub source_delete_warning: Option<String>,
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

#[derive(Debug)]
struct PreparedImport {
    inspection: Inspection,
    selection: ClientImportSelection,
    result: ClientImportResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportFileKind {
    Screenshot,
    Demo,
    Config,
    Pk3,
    RetailAsset,
    Other,
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
#[allow(clippy::too_many_arguments)]
pub async fn import_client(
    app: AppHandle,
    source_path: String,
    name: String,
    fs_game: Option<String>,
    launch_args: String,
    selection: ClientImportSelection,
    delete_source: bool,
    upgrade_engine: bool,
    request_id: String,
) -> Result<ClientImportResult> {
    validate_request_id(&request_id)?;
    let result = import_client_inner(
        &app,
        source_path,
        name,
        fs_game,
        launch_args,
        selection,
        delete_source,
        upgrade_engine,
        &request_id,
    )
    .await;
    if result.is_err() {
        emit_progress(&app, &request_id, None, "error", 0, 0, None);
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn import_client_inner(
    app: &AppHandle,
    source_path: String,
    name: String,
    fs_game: Option<String>,
    launch_args: String,
    selection: ClientImportSelection,
    delete_source: bool,
    upgrade_engine: bool,
    request_id: &str,
) -> Result<ClientImportResult> {
    let inspect_path = source_path.clone();
    let inspection =
        tauri::async_runtime::spawn_blocking(move || inspect(Path::new(&inspect_path)))
            .await
            .map_err(|error| {
                AppError::State(format!("the client inspection thread stopped: {error}"))
            })??;
    validate_selection(&selection, &inspection)?;
    if delete_source && !selection.all() {
        return Err(AppError::InvalidInput(
            "select every file category before deleting the source folder".into(),
        ));
    }
    let imports = app.state::<ImportState>();
    let _claim = imports.claim(&inspection.source)?;
    let state = app.state::<AppState>();
    if delete_source {
        validate_source_removal(&state, &inspection.source)?;
    }

    let work_app = app.clone();
    let work_request_id = request_id.to_string();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let state = work_app.state::<AppState>();
        prepare_import(
            &work_app,
            &state,
            inspection,
            name,
            fs_game,
            launch_args,
            selection,
            &work_request_id,
        )
    })
    .await
    .map_err(|error| AppError::State(format!("the client import thread stopped: {error}")))??;

    let mut prepared = prepared;
    let client_id = prepared.result.client.id.clone();
    let paths = state.paths()?;
    if upgrade_engine {
        emit_progress(app, request_id, Some(&client_id), "upgrade", 0, 0, None);
        let installs = app.state::<engine_install::InstallState>();
        match engine_install::install(app, installs.inner(), &paths, &client_id, None).await {
            Ok(client) => {
                prepared.result.client = client;
                prepared.result.engine_upgraded = true;
            }
            Err(error) => {
                log::warn!("cannot upgrade imported client {client_id}: {error}");
                prepared.result.engine_upgrade_warning = Some(error.to_string());
                prepared.result.client = clients::read_record(&paths, &client_id)?;
            }
        }
    }

    if delete_source {
        let can_delete = prepared.result.media_warning.is_none()
            && (!upgrade_engine || prepared.result.engine_upgraded);
        if can_delete {
            emit_progress(app, request_id, Some(&client_id), "delete", 0, 0, None);
            let verify_target = if prepared.result.engine_upgraded {
                engine_install::imported_snapshot_dir(&paths, &client_id)
            } else {
                paths.client_engine_dir(&client_id)
            };
            let inspection = &prepared.inspection;
            match verify_snapshot(inspection, &prepared.selection, &verify_target)
                .and_then(|()| remove_source(&inspection.source))
            {
                Ok(()) => prepared.result.source_deleted = true,
                Err(error) => {
                    log::warn!(
                        "cannot delete imported source {}: {error}",
                        prepared.inspection.source.display()
                    );
                    prepared.result.source_delete_warning = Some(error.to_string());
                }
            }
        } else {
            prepared.result.source_delete_warning = Some(
                "the source folder was kept because a requested import step did not finish".into(),
            );
        }
    }

    clients::emit_changed(app, &client_id);
    emit_progress(app, request_id, Some(&client_id), "done", 1, 1, None);
    Ok(prepared.result)
}

#[allow(clippy::too_many_arguments)]
fn prepare_import(
    app: &AppHandle,
    state: &AppState,
    inspection: Inspection,
    name: String,
    fs_game: Option<String>,
    launch_args: String,
    selection: ClientImportSelection,
    request_id: &str,
) -> Result<PreparedImport> {
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

    let selected_bytes = inspection
        .files
        .iter()
        .filter(|file| selected(file, &selection, inspection.engine.game))
        .map(|file| file.size)
        .sum();
    let mut progress = CopyProgress::new(app, request_id, selected_bytes);
    let copied = copy_snapshot(
        &inspection.files,
        &inspection.source,
        &engine_dir,
        &selection,
        inspection.engine.game,
        |bytes, relative| progress.advance(bytes, relative),
    );
    if let Err(error) = copied {
        remove_failed_import(&client_dir);
        return Err(error);
    }
    emit_progress(
        app,
        request_id,
        Some(&id),
        "prepare",
        selected_bytes,
        selected_bytes,
        None,
    );
    let home_dir = paths.client_home_dir(&id);
    if let Err(error) = mirror_playable_content(&inspection, &engine_dir, &home_dir, &selection) {
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
    emit_progress(
        app,
        request_id,
        Some(&client.id),
        "media",
        selected_bytes,
        selected_bytes,
        None,
    );
    let media = media::import_client_tree(state, &client, &engine_dir);
    let (media_imported, media_warning) = match media {
        Ok(count) => (count, None),
        Err(error) => {
            log::warn!("media import for {}: {error}", client.id);
            (0, Some(error.to_string()))
        }
    };

    log::info!(
        "imported client {} from {} as {} ({}, {} file(s), {} media item(s))",
        client.id,
        inspection.source.display(),
        client.engine_id,
        client.game.display_name(),
        inspection.files.len(),
        media_imported
    );
    Ok(PreparedImport {
        inspection,
        selection,
        result: ClientImportResult {
            client,
            media_imported,
            media_warning,
            engine_upgraded: false,
            engine_upgrade_warning: None,
            source_deleted: false,
            source_delete_warning: None,
        },
    })
}

fn validate_request_id(request_id: &str) -> Result<()> {
    if request_id.is_empty()
        || request_id.len() > 64
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppError::InvalidInput(
            "the client import request id is invalid".into(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    request_id: &str,
    client_id: Option<&str>,
    phase: &'static str,
    processed_bytes: u64,
    total_bytes: u64,
    current_file: Option<String>,
) {
    if let Err(error) = app.emit(
        PROGRESS_EVENT,
        ClientImportProgress {
            request_id: request_id.to_string(),
            client_id: client_id.map(str::to_string),
            phase,
            processed_bytes,
            total_bytes,
            current_file,
        },
    ) {
        log::warn!("cannot emit {PROGRESS_EVENT}: {error}");
    }
}

struct CopyProgress<'a> {
    app: &'a AppHandle,
    request_id: &'a str,
    processed: u64,
    total: u64,
    last_emit: Instant,
}

impl<'a> CopyProgress<'a> {
    fn new(app: &'a AppHandle, request_id: &'a str, total: u64) -> Self {
        Self {
            app,
            request_id,
            processed: 0,
            total,
            last_emit: Instant::now()
                .checked_sub(PROGRESS_INTERVAL)
                .unwrap_or_else(Instant::now),
        }
    }

    fn advance(&mut self, bytes: u64, relative: &Path) {
        self.processed = self.processed.saturating_add(bytes).min(self.total);
        if self.processed != self.total && self.last_emit.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        self.last_emit = Instant::now();
        emit_progress(
            self.app,
            self.request_id,
            None,
            "copy",
            self.processed,
            self.total,
            Some(relative.to_string_lossy().replace('\\', "/")),
        );
    }
}

fn classify(file: &SourceFile, game: Game) -> ImportFileKind {
    let extension = file
        .relative
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let in_folder = |folder: &str| {
        file.relative.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|part| part.eq_ignore_ascii_case(folder))
        })
    };
    if ["png", "jpg", "jpeg", "tga", "bmp"].contains(&extension.as_str())
        && in_folder("screenshots")
    {
        ImportFileKind::Screenshot
    } else if game.demo_extensions().contains(&extension.as_str()) && in_folder("demos") {
        ImportFileKind::Demo
    } else if extension == "cfg" {
        ImportFileKind::Config
    } else if is_retail_asset(file, game) {
        ImportFileKind::RetailAsset
    } else if extension == "pk3" {
        ImportFileKind::Pk3
    } else {
        ImportFileKind::Other
    }
}

fn is_retail_asset(file: &SourceFile, game: Game) -> bool {
    let mut components = file.relative.components();
    let Some(folder) = components.next() else {
        return false;
    };
    if !folder
        .as_os_str()
        .to_str()
        .is_some_and(|folder| folder.eq_ignore_ascii_case(paths::BASE_FOLDER))
    {
        return false;
    }
    let Some(name) = components.next() else {
        return false;
    };
    if components.next().is_some() {
        return false;
    }
    name.as_os_str().to_str().is_some_and(|name| {
        game.spec()
            .assets
            .iter()
            .any(|asset| asset.name.eq_ignore_ascii_case(name))
    })
}

fn relative_key(relative: &Path) -> String {
    relative.to_string_lossy().replace('\\', "/")
}

fn validate_selection(selection: &ClientImportSelection, inspection: &Inspection) -> Result<()> {
    validate_excluded_files(
        "config",
        &selection.excluded_configs,
        inspection,
        ImportFileKind::Config,
    )?;
    validate_excluded_files(
        "pk3",
        &selection.excluded_pk3,
        inspection,
        ImportFileKind::Pk3,
    )?;
    Ok(())
}

fn validate_excluded_files(
    label: &str,
    excluded: &[String],
    inspection: &Inspection,
    expected_kind: ImportFileKind,
) -> Result<()> {
    let mut unique = HashSet::new();
    for path in excluded {
        if !unique.insert(path) {
            return Err(AppError::InvalidInput(format!(
                "the excluded {label} file is listed more than once"
            )));
        }
        let known = inspection.files.iter().any(|file| {
            classify(file, inspection.engine.game) == expected_kind
                && relative_key(&file.relative) == *path
        });
        if !known {
            return Err(AppError::InvalidInput(format!(
                "the excluded {label} file is not part of this client: {path}"
            )));
        }
    }
    Ok(())
}

fn selected(file: &SourceFile, selection: &ClientImportSelection, game: Game) -> bool {
    match classify(file, game) {
        ImportFileKind::Screenshot => selection.screenshots,
        ImportFileKind::Demo => selection.demos,
        ImportFileKind::Config => {
            selection.configs
                && !selection
                    .excluded_configs
                    .iter()
                    .any(|path| *path == relative_key(&file.relative))
        }
        ImportFileKind::Pk3 => {
            selection.pk3
                && !selection
                    .excluded_pk3
                    .iter()
                    .any(|path| *path == relative_key(&file.relative))
        }
        ImportFileKind::RetailAsset => false,
        ImportFileKind::Other => true,
    }
}

fn validate_source_removal(state: &AppState, source: &Path) -> Result<()> {
    if source.parent().is_none() {
        return Err(AppError::InvalidInput(
            "a filesystem root cannot be deleted after import".into(),
        ));
    }
    let paths = state.paths()?;
    if source.starts_with(&paths.root) || paths.root.starts_with(source) {
        return Err(AppError::InvalidInput(
            "a folder inside JKNet data cannot be deleted as an import source".into(),
        ));
    }
    let settings = state.settings()?;
    for configured in settings.game_data_paths.values() {
        let Ok(configured) = fs::canonicalize(configured) else {
            continue;
        };
        if source.starts_with(&configured) || configured.starts_with(source) {
            return Err(AppError::InvalidInput(
                "the configured game folder cannot be deleted after import".into(),
            ));
        }
    }
    Ok(())
}

fn verify_snapshot(
    inspection: &Inspection,
    selection: &ClientImportSelection,
    snapshot: &Path,
) -> Result<()> {
    let snapshot = fs::canonicalize(snapshot)
        .map_err(|error| AppError::io_path("cannot verify", snapshot, error))?;
    for file in &inspection.files {
        if !selected(file, selection, inspection.engine.game) {
            continue;
        }
        let destination = snapshot.join(&file.relative);
        if verified_hash(&file.path, &inspection.source, file.size)?
            != verified_hash(&destination, &snapshot, file.size)?
        {
            return Err(AppError::InvalidInput(format!(
                "the imported copy of {} does not match its source",
                file.relative.display()
            )));
        }
    }
    Ok(())
}

fn verified_hash(path: &Path, allowed_root: &Path, expected_size: u64) -> Result<[u8; 32]> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AppError::io_path("cannot verify", path, error))?;
    let canonical =
        fs::canonicalize(path).map_err(|error| AppError::io_path("cannot verify", path, error))?;
    if !metadata.file_type().is_file()
        || metadata.len() != expected_size
        || !canonical.starts_with(allowed_root)
    {
        return Err(AppError::InvalidInput(format!(
            "the client file {} changed before source deletion",
            path.display()
        )));
    }
    hash_file(path)
}

fn hash_file(path: &Path) -> Result<[u8; 32]> {
    let file = File::open(path).map_err(|error| AppError::io_path("cannot verify", path, error))?;
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, file);
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let mut digest = Sha256::new();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| AppError::io_path("cannot verify", path, error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

fn remove_source(source: &Path) -> Result<()> {
    fs::remove_dir_all(source)
        .map_err(|error| AppError::io_path("cannot delete the imported source", source, error))
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
    let mut screenshot_size_bytes = 0u64;
    let mut demo_count = 0u64;
    let mut demo_size_bytes = 0u64;
    let mut config_count = 0u64;
    let mut config_size_bytes = 0u64;
    let mut config_files = Vec::new();
    let mut pk3_count = 0u64;
    let mut pk3_size_bytes = 0u64;
    let mut pk3_files = Vec::new();
    let mut required_files = Vec::new();
    let mut mod_folders = BTreeSet::new();
    for file in &files {
        let extension = file
            .path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        match classify(file, engine.game) {
            ImportFileKind::Screenshot => {
                screenshot_count += 1;
                screenshot_size_bytes += file.size;
            }
            ImportFileKind::Demo => {
                demo_count += 1;
                demo_size_bytes += file.size;
            }
            ImportFileKind::Config => {
                config_count += 1;
                config_size_bytes += file.size;
                config_files.push(ClientImportFile {
                    path: relative_key(&file.relative),
                    size_bytes: file.size,
                });
            }
            ImportFileKind::Pk3 => {
                pk3_count += 1;
                pk3_size_bytes += file.size;
                pk3_files.push(ClientImportFile {
                    path: relative_key(&file.relative),
                    size_bytes: file.size,
                });
            }
            ImportFileKind::Other => required_files.push(ClientImportFile {
                path: relative_key(&file.relative),
                size_bytes: file.size,
            }),
            ImportFileKind::RetailAsset => {}
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
        screenshot_size_bytes,
        demo_count,
        demo_size_bytes,
        config_count,
        config_size_bytes,
        config_files,
        pk3_count,
        pk3_size_bytes,
        pk3_files,
        required_files,
        mod_folders,
        recommended_fs_game,
        can_upgrade_engine: engine.installable,
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

#[allow(clippy::too_many_arguments)]
fn copy_snapshot(
    files: &[SourceFile],
    source_root: &Path,
    target: &Path,
    selection: &ClientImportSelection,
    game: Game,
    mut on_progress: impl FnMut(u64, &Path),
) -> Result<()> {
    paths::create_dir(target)?;
    let source_root = fs::canonicalize(source_root)
        .map_err(|error| AppError::io_path("cannot inspect", source_root, error))?;
    for source in files {
        if !selected(source, selection, game) {
            continue;
        }
        let relative = source.relative.clone();
        copy_file(
            &source.path,
            source.size,
            &source_root,
            &target.join(&source.relative),
            &mut |bytes| on_progress(bytes, &relative),
        )?;
    }
    Ok(())
}

/// Mirrors the folders the game treats as writable into `home\`.
///
/// Jedi Academy already searches the imported snapshot as `fs_basepath`, but
/// Jedi Outcast uses JKNet's separate `basepath\`. Keeping `base\` and every
/// detected mod under `home\` makes the imported configuration and mod files
/// visible to both layouts. The imported snapshot remains under `engine\`
/// either way, without the retail archives supplied by the shared game folder.
fn mirror_playable_content(
    inspection: &Inspection,
    snapshot: &Path,
    home: &Path,
    selection: &ClientImportSelection,
) -> Result<()> {
    paths::create_dir(&home.join(paths::BASE_FOLDER))?;
    let snapshot_root = fs::canonicalize(snapshot)
        .map_err(|error| AppError::io_path("cannot inspect", snapshot, error))?;
    for source in &inspection.files {
        if !selected(source, selection, inspection.engine.game) {
            continue;
        }
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

        copy_file(
            &snapshot.join(&source.relative),
            source.size,
            &snapshot_root,
            &home.join(&source.relative),
            &mut |_| {},
        )?;
    }
    Ok(())
}

fn copy_file(
    source: &Path,
    expected_size: u64,
    allowed_root: &Path,
    destination: &Path,
    on_progress: &mut dyn FnMut(u64),
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
    let input =
        File::open(source).map_err(|error| AppError::io_path("cannot read", source, error))?;
    let output = File::create(destination)
        .map_err(|error| AppError::io_path("cannot import into", destination, error))?;
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, input);
    let mut writer = BufWriter::with_capacity(COPY_BUFFER_BYTES, output);
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let mut copied = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| AppError::io_path("cannot read", source, error))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| AppError::io_path("cannot import into", destination, error))?;
        copied += read as u64;
        on_progress(read as u64);
    }
    writer
        .flush()
        .map_err(|error| AppError::io_path("cannot import into", destination, error))?;
    if copied != expected_size {
        return Err(AppError::InvalidInput(format!(
            "the client file {} changed during import",
            source.display()
        )));
    }
    let after = fs::symlink_metadata(source)
        .map_err(|error| AppError::io_path("cannot inspect", source, error))?;
    if !after.file_type().is_file() || after.len() != expected_size {
        return Err(AppError::InvalidInput(format!(
            "the client file {} changed during import",
            source.display()
        )));
    }
    fs::set_permissions(destination, metadata.permissions()).map_err(|error| {
        AppError::io_path("cannot preserve permissions for", destination, error)
    })?;
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

    fn all_selection() -> ClientImportSelection {
        ClientImportSelection {
            screenshots: true,
            demos: true,
            configs: true,
            pk3: true,
            excluded_configs: Vec::new(),
            excluded_pk3: Vec::new(),
        }
    }

    fn portable_client(root: &Path) {
        fs::create_dir_all(root.join("base/screenshots")).unwrap();
        fs::create_dir_all(root.join("japro/demos")).unwrap();
        fs::write(root.join("eternaljk.x86.exe"), b"MZ").unwrap();
        fs::write(root.join("base/screenshots/shot.jpg"), b"jpg").unwrap();
        fs::write(root.join("japro/demos/duel.dm_26"), b"demo").unwrap();
        fs::write(root.join("japro/autoexec.cfg"), b"seta name player").unwrap();
        fs::write(root.join("japro/client.pk3"), b"pk3").unwrap();
        fs::write(root.join("base/assets0.pk3"), b"retail").unwrap();
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
        assert_eq!(found.preview.screenshot_size_bytes, 3);
        assert_eq!(found.preview.demo_count, 1);
        assert_eq!(found.preview.demo_size_bytes, 4);
        assert_eq!(found.preview.config_count, 1);
        assert_eq!(found.preview.config_size_bytes, 16);
        assert_eq!(found.preview.config_files.len(), 1);
        assert_eq!(found.preview.config_files[0].path, "japro/autoexec.cfg");
        assert_eq!(found.preview.pk3_count, 1);
        assert_eq!(found.preview.pk3_size_bytes, 3);
        assert_eq!(found.preview.pk3_files.len(), 1);
        assert_eq!(found.preview.pk3_files[0].path, "japro/client.pk3");
        assert!(found
            .preview
            .pk3_files
            .iter()
            .all(|file| file.path != "base/assets0.pk3"));
        assert_eq!(found.preview.required_files.len(), 1);
        assert_eq!(found.preview.required_files[0].path, "eternaljk.x86.exe");
        assert_eq!(found.preview.mod_folders, vec!["japro"]);
        assert_eq!(found.preview.recommended_fs_game.as_deref(), Some("japro"));
        assert!(found.preview.can_upgrade_engine);
    }

    #[test]
    fn snapshot_copy_preserves_client_files_without_retail_assets() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        portable_client(&source);
        let files = collect_files(&source).unwrap();

        copy_snapshot(
            &files,
            &source,
            &target,
            &all_selection(),
            Game::JediAcademy,
            |_, _| {},
        )
        .unwrap();

        for file in files {
            if is_retail_asset(&file, Game::JediAcademy) {
                assert!(!target.join(file.relative).exists());
                continue;
            }
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

        assert!(copy_snapshot(
            &files,
            &source,
            &target,
            &all_selection(),
            Game::JediAcademy,
            |_, _| {},
        )
        .is_err());
    }

    #[test]
    fn deletion_verification_detects_a_same_size_change() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        portable_client(&source);
        let inspection = inspect(&source).unwrap();
        copy_snapshot(
            &inspection.files,
            &inspection.source,
            &target,
            &all_selection(),
            inspection.engine.game,
            |_, _| {},
        )
        .unwrap();
        fs::write(source.join("japro/client.pk3"), b"new").unwrap();

        assert!(verify_snapshot(&inspection, &all_selection(), &target).is_err());
    }

    #[test]
    fn playable_content_is_mirrored_without_retail_archives() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let home = temp.path().join("home");
        portable_client(&source);
        let inspection = inspect(&source).unwrap();

        let snapshot = temp.path().join("snapshot");
        copy_snapshot(
            &inspection.files,
            &inspection.source,
            &snapshot,
            &all_selection(),
            inspection.engine.game,
            |_, _| {},
        )
        .unwrap();
        mirror_playable_content(&inspection, &snapshot, &home, &all_selection()).unwrap();

        assert!(!home.join("base/screenshots/shot.jpg").exists());
        assert_eq!(fs::read(home.join("japro/client.pk3")).unwrap(), b"pk3");
        assert!(!home.join("base/assets0.pk3").exists());
        assert!(!home.join("eternaljk.x86.exe").exists());
    }

    #[test]
    fn unselected_categories_are_not_copied_or_mirrored() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let snapshot = temp.path().join("snapshot");
        let home = temp.path().join("home");
        portable_client(&source);
        let inspection = inspect(&source).unwrap();
        let selection = ClientImportSelection {
            screenshots: false,
            demos: false,
            configs: false,
            pk3: false,
            excluded_configs: Vec::new(),
            excluded_pk3: Vec::new(),
        };

        copy_snapshot(
            &inspection.files,
            &inspection.source,
            &snapshot,
            &selection,
            inspection.engine.game,
            |_, _| {},
        )
        .unwrap();
        mirror_playable_content(&inspection, &snapshot, &home, &selection).unwrap();

        assert!(snapshot.join("eternaljk.x86.exe").is_file());
        assert!(!snapshot.join("base/screenshots/shot.jpg").exists());
        assert!(!snapshot.join("japro/demos/duel.dm_26").exists());
        assert!(!snapshot.join("japro/autoexec.cfg").exists());
        assert!(!snapshot.join("japro/client.pk3").exists());
        assert!(!snapshot.join("base/assets0.pk3").exists());
        assert!(!home.join("japro/client.pk3").exists());
    }

    #[test]
    fn individual_config_and_pk3_exclusions_are_honoured() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let snapshot = temp.path().join("snapshot");
        portable_client(&source);
        fs::write(source.join("japro/keep.cfg"), b"keep").unwrap();
        fs::write(source.join("japro/keep.pk3"), b"keep").unwrap();
        let inspection = inspect(&source).unwrap();
        let selection = ClientImportSelection {
            screenshots: true,
            demos: true,
            configs: true,
            pk3: true,
            excluded_configs: vec!["japro/autoexec.cfg".into()],
            excluded_pk3: vec!["japro/client.pk3".into()],
        };
        validate_selection(&selection, &inspection).unwrap();

        copy_snapshot(
            &inspection.files,
            &inspection.source,
            &snapshot,
            &selection,
            inspection.engine.game,
            |_, _| {},
        )
        .unwrap();

        assert!(!snapshot.join("japro/autoexec.cfg").exists());
        assert!(snapshot.join("japro/keep.cfg").is_file());
        assert!(!snapshot.join("japro/client.pk3").exists());
        assert!(snapshot.join("japro/keep.pk3").is_file());
        assert!(!snapshot.join("base/assets0.pk3").exists());
    }

    #[test]
    fn retail_assets_cannot_be_excluded_as_optional_pk3_files() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        portable_client(&source);
        let inspection = inspect(&source).unwrap();
        let mut selection = all_selection();
        selection.excluded_pk3.push("base/assets0.pk3".into());

        assert!(validate_selection(&selection, &inspection).is_err());
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
