//! Persistent dedicated-server instances and their reusable components.
//!
//! A server instance owns one writable `home\` tree. The engine is installed
//! once in `server-engines\` and a mod is installed once in `server-mods\`;
//! creating an instance copies the mod template into that instance. Files
//! added by JKNet are recorded in `templateFiles`. Files a running game module
//! creates are not, so cloning copies the launch template without copying
//! databases, logs or other instance state.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

use crate::engine_install::{self, ArchiveProgress, InstallState};
use crate::engines;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::hosting::console::{ConsoleOutput, ServerProcess};
use crate::jkhub::source::{HtmlSource, JkhubSource};
use crate::jkhub::types::JkhubDownload;
use crate::jkhub::JkhubState;
use crate::launch::{self, LaunchPlan};
use crate::paths::{self, DataPaths};
use crate::state::AppState;
use crate::timestamp;

const INSTANCE_RECORD: &str = "server.json";
const ENGINE_RECORD: &str = "engine.json";
const MOD_RECORD: &str = "mod.json";
const MOD_FILES: &str = "files";
const MAX_NAME_LEN: usize = 64;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const CHANGED_EVENT: &str = "server-instances:changed";
const ENGINE_PROGRESS_EVENT: &str = "server-instances:engine-progress";
const BASE_ENGINE_ID: &str = "base";
const BASE_ENGINE_NAME: &str = "Base";
const BASE_ENGINE_VERSION: &str = "1.01";
const BASE_DEDICATED_EXE: &str = "jampDed.exe";
const JA_SERVER_MOD_CATEGORY: u32 = 25;
const JO_SERVER_MOD_CATEGORY: u32 = 43;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerEngineInstall {
    pub engine_id: String,
    pub version: String,
    pub published_at: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerEngineView {
    pub engine_id: String,
    pub name: String,
    pub game: Game,
    pub can_host: bool,
    pub installable: bool,
    pub installed: Option<ServerEngineInstall>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerEngineProgress {
    pub engine_id: String,
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerMod {
    pub id: String,
    pub name: String,
    pub game: Game,
    pub folder: String,
    pub source: ServerModSource,
    pub files: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServerModSource {
    Disk { path: String },
    Jkhub { file_id: u32, url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    /// Relative to the instance folder, for example `home/japlus/server.cfg`.
    pub path: String,
    /// `config`, `user`, or `mod:<id>`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInstance {
    pub id: String,
    pub name: String,
    pub game: Game,
    pub engine_id: String,
    pub mod_id: Option<String>,
    pub mod_folder: Option<String>,
    pub port: u16,
    pub public: bool,
    pub startup_config: String,
    pub engine_args: String,
    pub mod_args: String,
    pub template_files: Vec<TemplateFile>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInstanceView {
    #[serde(flatten)]
    pub instance: ServerInstance,
    pub status: ServerProcessStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerProcessStatus {
    pub state: String,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub exit_code: Option<u32>,
    pub log_tail: Vec<String>,
}

impl ServerProcessStatus {
    fn stopped() -> Self {
        Self {
            state: "stopped".into(),
            pid: None,
            started_at: None,
            exit_code: None,
            log_tail: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateServerInstance {
    pub name: String,
    pub game: Game,
    pub engine_id: String,
    pub mod_id: Option<String>,
    pub port: Option<u16>,
    pub public: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateServerInstance {
    pub name: String,
    pub engine_id: String,
    pub mod_id: Option<String>,
    pub port: u16,
    pub public: bool,
    pub startup_config: String,
    pub engine_args: String,
    pub mod_args: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerFile {
    pub path: String,
    pub size: u64,
    pub kind: String,
    pub template: bool,
    pub source: Option<String>,
}

struct RunningInstance {
    process: Arc<ServerProcess>,
    started_at: String,
}

#[derive(Default)]
pub struct ServerInstancesState {
    running: Mutex<HashMap<String, RunningInstance>>,
}

impl ServerInstancesState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, RunningInstance>>> {
        self.running
            .lock()
            .map_err(|_| AppError::State("the server instance lock is poisoned".into()))
    }

    fn status(&self, id: &str) -> Result<ServerProcessStatus> {
        let mut running = self.lock()?;
        let Some(entry) = running.get(id) else {
            return Ok(ServerProcessStatus::stopped());
        };
        if let Some(code) = entry.process.exit_code() {
            let tail = entry.process.output().tail(200);
            entry.process.close();
            running.remove(id);
            return Ok(ServerProcessStatus {
                state: "stopped".into(),
                pid: None,
                started_at: None,
                exit_code: Some(code),
                log_tail: tail,
            });
        }
        Ok(ServerProcessStatus {
            state: "running".into(),
            pid: Some(entry.process.pid()),
            started_at: Some(entry.started_at.clone()),
            exit_code: None,
            log_tail: entry.process.output().tail(200),
        })
    }

    fn refuse_if_running(&self, id: &str) -> Result<()> {
        if self.status(id)?.state == "running" {
            return Err(AppError::Busy(format!("server instance {id} is running")));
        }
        Ok(())
    }
}

#[tauri::command]
pub fn list_server_engines(state: tauri::State<'_, AppState>) -> Result<Vec<ServerEngineView>> {
    let paths = state.paths()?;
    let settings = state.settings()?;
    let base_installed = settings
        .game_data_path(Game::JediAcademy)
        .map(PathBuf::from)
        .map(|path| path.join(BASE_DEDICATED_EXE))
        .filter(|path| path.is_file())
        .map(|_| ServerEngineInstall {
            engine_id: BASE_ENGINE_ID.into(),
            version: BASE_ENGINE_VERSION.into(),
            published_at: String::new(),
            installed_at: String::new(),
        });
    let mut views = vec![ServerEngineView {
        engine_id: BASE_ENGINE_ID.into(),
        name: BASE_ENGINE_NAME.into(),
        game: Game::JediAcademy,
        can_host: true,
        installable: false,
        installed: base_installed,
    }];
    views.extend(engines::all().iter().map(|engine| ServerEngineView {
        engine_id: engine.id.to_string(),
        name: engine.name.to_string(),
        game: engine.game,
        can_host: engine.dedicated.is_some(),
        installable: true,
        installed: read_json_optional(&paths.server_engine_dir(engine.id).join(ENGINE_RECORD)),
    }));
    Ok(views)
}

#[tauri::command]
pub async fn install_server_engine(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    installs: tauri::State<'_, InstallState>,
    processes: tauri::State<'_, ServerInstancesState>,
    engine_id: String,
    tag: Option<String>,
) -> Result<ServerEngineInstall> {
    let paths = state.paths()?;
    if engine_id == BASE_ENGINE_ID {
        return Err(AppError::InvalidInput(
            "Base uses the dedicated server from the configured Jedi Academy game files".into(),
        ));
    }
    let engine = engines::require(&engine_id)?;
    if engine.dedicated.is_none() {
        return Err(AppError::InvalidInput(format!(
            "{} does not ship a dedicated server",
            engine.name
        )));
    }
    for instance in read_all_instances(&paths)? {
        if instance.engine_id == engine_id && processes.status(&instance.id)?.state == "running" {
            return Err(AppError::Busy(format!(
                "{} is running with {}",
                instance.name, engine.name
            )));
        }
    }
    let key = format!("server-engine:{engine_id}");
    let _claim = installs.claim(&key)?;
    let target = paths.server_engine_dir(&engine_id);
    let app_for_progress = app.clone();
    let id_for_progress = engine_id.clone();
    let release = engine_install::install_release_into(
        &paths,
        engine,
        tag.as_deref(),
        &target,
        move |step| {
            let (phase, downloaded, total, message) = match step {
                ArchiveProgress::Reused => {
                    ("download", 1, 1, "Archive is already downloaded".into())
                }
                ArchiveProgress::Downloading { downloaded, total } => {
                    ("download", downloaded, total, "Downloading engine".into())
                }
            };
            let _ = app_for_progress.emit(
                ENGINE_PROGRESS_EVENT,
                ServerEngineProgress {
                    engine_id: id_for_progress.clone(),
                    phase: phase.into(),
                    downloaded,
                    total,
                    message,
                },
            );
        },
    )
    .await?;
    let installed = ServerEngineInstall {
        engine_id: engine_id.clone(),
        version: release.tag,
        published_at: release.published_at,
        installed_at: timestamp::now_rfc3339(),
    };
    write_json(&target.join(ENGINE_RECORD), &installed)?;
    emit_changed(&app, None);
    Ok(installed)
}

#[tauri::command]
pub fn list_server_mods(state: tauri::State<'_, AppState>) -> Result<Vec<ServerMod>> {
    let paths = state.paths()?;
    let mut mods = read_records::<ServerMod>(&paths.server_mods, MOD_RECORD)?;
    mods.sort_by_key(|item| item.name.to_lowercase());
    Ok(mods)
}

#[tauri::command]
pub fn add_server_mod_from_disk(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    game: Game,
    folder: String,
    source_path: String,
) -> Result<ServerMod> {
    let paths = state.paths()?;
    let source = PathBuf::from(source_path.trim());
    if !source.exists() {
        return Err(AppError::NotFound(source.display().to_string()));
    }
    let staged = tempfile::tempdir().map_err(|e| AppError::io_path("cannot stage", &source, e))?;
    stage_mod_source(&source, staged.path())?;
    let record = create_mod_record(
        &paths,
        &name,
        game,
        &folder,
        ServerModSource::Disk {
            path: source.display().to_string(),
        },
        staged.path(),
    )?;
    emit_changed(&app, None);
    Ok(record)
}

#[tauri::command]
pub async fn add_server_mod_from_jkhub(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    file_id: u32,
    name: String,
    game: Game,
    folder: String,
) -> Result<ServerMod> {
    let paths = state.paths()?;
    let http = jkhub.client()?;
    let _claim = jkhub.claim(file_id)?;
    let view = HtmlSource::new(http, &paths).file(file_id).await?;
    if !view.file.game.matches(game) {
        return Err(AppError::InvalidInput(
            "This JKHub file belongs to another game".into(),
        ));
    }
    let required_category = server_mod_category(game);
    if view.file.category_id != Some(required_category) {
        return Err(AppError::InvalidInput(format!(
            "JKHub file {file_id} is not in the Server-Side category for {}",
            game.display_name()
        )));
    }
    let resolved = crate::jkhub::download::resolve(http, file_id, &view.file.slug).await?;
    let (url, file_name, size) = match resolved {
        JkhubDownload::Hosted {
            url,
            file_name,
            size,
            ..
        } => (url, file_name, size),
        JkhubDownload::External { url } => {
            return Err(AppError::InvalidInput(format!(
                "JKHub file {file_id} is hosted outside JKHub: {url}"
            )))
        }
    };
    let download_dir = crate::jkhub::cache::download_dir(&paths, file_id)?;
    let archive =
        crate::jkhub::download::fetch(&app, http, file_id, &url, &download_dir, &file_name, size)
            .await?;
    let staged = tempfile::tempdir().map_err(|e| AppError::io_path("cannot stage", &archive, e))?;
    stage_mod_source(&archive, staged.path())?;
    let record = create_mod_record(
        &paths,
        &name,
        game,
        &folder,
        ServerModSource::Jkhub {
            file_id,
            url: view.file.url,
        },
        staged.path(),
    )?;
    crate::jkhub::cache::forget_download(&paths, file_id);
    emit_changed(&app, None);
    Ok(record)
}

#[tauri::command]
pub fn delete_server_mod(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    mod_id: String,
) -> Result<()> {
    let paths = state.paths()?;
    if read_all_instances(&paths)?
        .iter()
        .any(|instance| instance.mod_id.as_deref() == Some(mod_id.as_str()))
    {
        return Err(AppError::Busy(format!(
            "server mod {mod_id} is used by a server instance"
        )));
    }
    let dir = paths.server_mod_dir(&mod_id);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("server mod {mod_id}")));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io_path("cannot delete", &dir, e))?;
    emit_changed(&app, None);
    Ok(())
}

#[tauri::command]
pub fn list_server_instances(
    state: tauri::State<'_, AppState>,
    processes: tauri::State<'_, ServerInstancesState>,
) -> Result<Vec<ServerInstanceView>> {
    let paths = state.paths()?;
    let mut instances = read_all_instances(&paths)?;
    instances.sort_by_key(|item| item.name.to_lowercase());
    instances
        .into_iter()
        .map(|instance| {
            let status = processes.status(&instance.id)?;
            Ok(ServerInstanceView { instance, status })
        })
        .collect()
}

#[tauri::command]
pub fn create_server_instance(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    input: CreateServerInstance,
) -> Result<ServerInstanceView> {
    let paths = state.paths()?;
    let instance = create_instance(&paths, input)?;
    emit_changed(&app, Some(&instance.id));
    Ok(ServerInstanceView {
        instance,
        status: ServerProcessStatus::stopped(),
    })
}

#[tauri::command]
pub fn clone_server_instance(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    server_id: String,
    name: String,
) -> Result<ServerInstanceView> {
    let paths = state.paths()?;
    let original = read_instance(&paths, &server_id)?;
    let id = next_slug(&paths.servers, &validate_name(&name)?, "server");
    let target_dir = paths.server_dir(&id);
    paths::create_dir(&target_dir)?;
    paths::create_dir(&target_dir.join("home").join("base"))?;
    for template in &original.template_files {
        let source = safe_relative(&paths.server_dir(&original.id), &template.path)?;
        if !source.is_file() {
            continue;
        }
        let target = safe_relative(&target_dir, &template.path)?;
        if let Some(parent) = target.parent() {
            paths::create_dir(parent)?;
        }
        fs::copy(&source, &target).map_err(|e| AppError::io_path("cannot clone", &source, e))?;
    }
    let now = timestamp::now_rfc3339();
    let clone = ServerInstance {
        id,
        name: validate_name(&name)?,
        created_at: now.clone(),
        updated_at: now,
        ..original
    };
    write_instance(&paths, &clone)?;
    emit_changed(&app, Some(&clone.id));
    Ok(ServerInstanceView {
        instance: clone,
        status: ServerProcessStatus::stopped(),
    })
}

#[tauri::command]
pub fn update_server_instance(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    processes: tauri::State<'_, ServerInstancesState>,
    server_id: String,
    input: UpdateServerInstance,
) -> Result<ServerInstanceView> {
    processes.refuse_if_running(&server_id)?;
    let paths = state.paths()?;
    let mut instance = read_instance(&paths, &server_id)?;
    validate_server_engine(&input.engine_id, instance.game)?;
    if input.port == 0 {
        return Err(AppError::InvalidInput("server port cannot be zero".into()));
    }
    let new_mod = input
        .mod_id
        .as_deref()
        .map(|id| read_mod(&paths, id))
        .transpose()?;
    if new_mod
        .as_ref()
        .is_some_and(|item| item.game != instance.game)
    {
        return Err(AppError::InvalidInput(
            "the server mod belongs to another game".into(),
        ));
    }
    let old_folder = instance.mod_folder.as_deref().unwrap_or("base").to_string();
    let new_folder = new_mod
        .as_ref()
        .map(|item| item.folder.as_str())
        .unwrap_or("base")
        .to_string();
    if instance.mod_id != input.mod_id {
        replace_instance_mod(&paths, &mut instance, new_mod.as_ref())?;
        move_startup_config(&paths, &mut instance, &old_folder, &new_folder)?;
    }
    instance.name = validate_name(&input.name)?;
    instance.engine_id = input.engine_id;
    instance.mod_id = new_mod.as_ref().map(|item| item.id.clone());
    instance.mod_folder = new_mod.as_ref().map(|item| item.folder.clone());
    instance.port = input.port;
    instance.public = input.public;
    instance.startup_config = validate_file_name(&input.startup_config)?;
    instance.engine_args = input.engine_args.trim().to_string();
    instance.mod_args = input.mod_args.trim().to_string();
    instance.updated_at = timestamp::now_rfc3339();
    write_instance(&paths, &instance)?;
    emit_changed(&app, Some(&instance.id));
    Ok(ServerInstanceView {
        instance,
        status: ServerProcessStatus::stopped(),
    })
}

#[tauri::command]
pub fn delete_server_instance(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    processes: tauri::State<'_, ServerInstancesState>,
    server_id: String,
) -> Result<()> {
    processes.refuse_if_running(&server_id)?;
    let paths = state.paths()?;
    read_instance(&paths, &server_id)?;
    let dir = paths.server_dir(&server_id);
    unlink_basepath(&dir)?;
    fs::remove_dir_all(&dir).map_err(|e| AppError::io_path("cannot delete", &dir, e))?;
    emit_changed(&app, Some(&server_id));
    Ok(())
}

#[tauri::command]
pub fn server_instance_open_folder(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<()> {
    let paths = state.paths()?;
    let instance = read_instance(&paths, &server_id)?;
    let dir = paths.server_dir(&instance.id);
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| {
            AppError::Launch(format!(
                "the file manager did not open {}: {e}",
                dir.display()
            ))
        })?;
    Ok(())
}

#[tauri::command]
pub fn list_server_instance_files(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<Vec<ServerFile>> {
    let paths = state.paths()?;
    let instance = read_instance(&paths, &server_id)?;
    let dir = paths.server_dir(&instance.id);
    let manifest: HashMap<&str, &str> = instance
        .template_files
        .iter()
        .map(|item| (item.path.as_str(), item.source.as_str()))
        .collect();
    let mut files = Vec::new();
    for root in ["home", "logs"] {
        collect_files(&dir, &dir.join(root), &manifest, &mut files)?;
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

#[tauri::command]
pub fn read_server_instance_text(
    state: tauri::State<'_, AppState>,
    server_id: String,
    path: String,
) -> Result<String> {
    let paths = state.paths()?;
    let instance = read_instance(&paths, &server_id)?;
    let file = instance_file(&paths, &instance, &path, false)?;
    let metadata =
        fs::metadata(&file).map_err(|e| AppError::io_path("cannot inspect", &file, e))?;
    if metadata.len() > MAX_TEXT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{} is too large to edit as text",
            file.display()
        )));
    }
    fs::read_to_string(&file).map_err(|e| AppError::io_path("cannot read", &file, e))
}

#[tauri::command]
pub fn save_server_instance_text(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    processes: tauri::State<'_, ServerInstancesState>,
    server_id: String,
    path: String,
    text: String,
    template: bool,
) -> Result<ServerFile> {
    processes.refuse_if_running(&server_id)?;
    if text.len() as u64 > MAX_TEXT_BYTES {
        return Err(AppError::InvalidInput("the text file is too large".into()));
    }
    let paths = state.paths()?;
    let mut instance = read_instance(&paths, &server_id)?;
    let file = instance_file(&paths, &instance, &path, true)?;
    if let Some(parent) = file.parent() {
        paths::create_dir(parent)?;
    }
    fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))?;
    set_template(&mut instance, &path, template, "user");
    instance.updated_at = timestamp::now_rfc3339();
    write_instance(&paths, &instance)?;
    emit_changed(&app, Some(&server_id));
    file_view(&paths.server_dir(&server_id), &file, &instance)
}

#[tauri::command]
pub fn add_server_instance_files(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    processes: tauri::State<'_, ServerInstancesState>,
    server_id: String,
    destination: String,
    source_paths: Vec<String>,
) -> Result<Vec<ServerFile>> {
    processes.refuse_if_running(&server_id)?;
    let paths = state.paths()?;
    let mut instance = read_instance(&paths, &server_id)?;
    let destination = normalize_relative(&destination)?;
    if destination != "home" && !destination.starts_with("home/") {
        return Err(AppError::InvalidInput(
            "server files can only be added under home".into(),
        ));
    }
    let root = paths.server_dir(&server_id);
    let target = safe_relative(&root, &destination)?;
    paths::create_dir(&target)?;
    let mut copied = Vec::new();
    for source in source_paths {
        let source = PathBuf::from(source);
        if source.is_dir() {
            let folder = source
                .file_name()
                .ok_or_else(|| AppError::InvalidInput("the source folder has no name".into()))?;
            copy_tree(&source, &target.join(folder), &mut copied)?;
        } else if source.is_file() {
            let name = source
                .file_name()
                .ok_or_else(|| AppError::InvalidInput("the source file has no name".into()))?;
            let file = target.join(name);
            fs::copy(&source, &file).map_err(|e| AppError::io_path("cannot copy", &source, e))?;
            copied.push(file);
        } else {
            return Err(AppError::NotFound(source.display().to_string()));
        }
    }
    for file in &copied {
        let relative = relative_string(&root, file)?;
        set_template(&mut instance, &relative, true, "user");
    }
    instance.updated_at = timestamp::now_rfc3339();
    write_instance(&paths, &instance)?;
    emit_changed(&app, Some(&server_id));
    copied
        .iter()
        .map(|file| file_view(&root, file, &instance))
        .collect()
}

#[tauri::command]
pub fn set_server_instance_file_template(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    server_id: String,
    path: String,
    template: bool,
) -> Result<ServerFile> {
    let paths = state.paths()?;
    let mut instance = read_instance(&paths, &server_id)?;
    let file = instance_file(&paths, &instance, &path, false)?;
    set_template(&mut instance, &path, template, "user");
    instance.updated_at = timestamp::now_rfc3339();
    write_instance(&paths, &instance)?;
    emit_changed(&app, Some(&server_id));
    file_view(&paths.server_dir(&server_id), &file, &instance)
}

#[tauri::command]
pub fn delete_server_instance_file(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    processes: tauri::State<'_, ServerInstancesState>,
    server_id: String,
    path: String,
) -> Result<()> {
    processes.refuse_if_running(&server_id)?;
    let paths = state.paths()?;
    let mut instance = read_instance(&paths, &server_id)?;
    let file = instance_file(&paths, &instance, &path, false)?;
    if file.is_dir() {
        fs::remove_dir_all(&file).map_err(|e| AppError::io_path("cannot delete", &file, e))?;
        let prefix = format!("{}/", normalize_relative(&path)?);
        instance
            .template_files
            .retain(|item| item.path != path && !item.path.starts_with(&prefix));
    } else {
        fs::remove_file(&file).map_err(|e| AppError::io_path("cannot delete", &file, e))?;
        set_template(&mut instance, &path, false, "user");
    }
    instance.updated_at = timestamp::now_rfc3339();
    write_instance(&paths, &instance)?;
    emit_changed(&app, Some(&server_id));
    Ok(())
}

#[tauri::command]
pub fn start_server_instance(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    processes: tauri::State<'_, ServerInstancesState>,
    server_id: String,
) -> Result<ServerProcessStatus> {
    processes.refuse_if_running(&server_id)?;
    let paths = state.paths()?;
    let settings = state.settings()?;
    let mut instance = read_instance(&paths, &server_id)?;
    let server_mod = instance
        .mod_id
        .as_deref()
        .map(|id| read_mod(&paths, id))
        .transpose()?;
    let mut instance_changed = false;
    if let Some(server_mod) = &server_mod {
        instance_changed |= repair_instance_mod_layout(&paths, &mut instance, server_mod)?;
    }
    if instance_changed {
        instance.updated_at = timestamp::now_rfc3339();
        write_instance(&paths, &instance)?;
    }
    let required_arch = server_mod.as_ref().and_then(server_mod_architecture);
    let game_data = settings
        .game_data_path(instance.game)
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            AppError::NotFound(format!("{} game files", instance.game.display_name()))
        })?;
    let (engine_name, engine_version, engine_dir, executable) =
        if is_base_engine(&instance.engine_id, instance.game) {
            if required_arch == Some("x86_64") {
                return Err(AppError::InvalidInput(
                    "Base cannot load this 64-bit server mod".into(),
                ));
            }
            let executable = game_data.join(BASE_DEDICATED_EXE);
            if !executable.is_file() {
                return Err(AppError::NotFound(executable.display().to_string()));
            }
            (
                BASE_ENGINE_NAME.to_string(),
                BASE_ENGINE_VERSION.to_string(),
                game_data.clone(),
                executable,
            )
        } else {
            let engine = engines::require_for_game(&instance.engine_id, instance.game)?;
            let engine_dir = paths.server_engine_dir(&instance.engine_id);
            let installed: ServerEngineInstall = read_json(&engine_dir.join(ENGINE_RECORD))?;
            let executable = match required_arch {
                Some(arch) => engine
                    .dedicated_executable_for_arch(&engine_dir, arch)
                    .ok_or_else(|| {
                        AppError::InvalidInput(format!(
                            "{} needs the {arch} dedicated server; reinstall the server engine",
                            server_mod
                                .as_ref()
                                .map(|item| item.name.as_str())
                                .unwrap_or("the selected mod")
                        ))
                    })?,
                None => engine.dedicated_executable(&engine_dir).ok_or_else(|| {
                    AppError::NotFound(format!(
                        "the dedicated server of {} is not installed",
                        engine.name
                    ))
                })?,
            };
            (
                engine.name.to_string(),
                installed.version,
                engine_dir,
                executable,
            )
        };
    let home_dir = paths.server_home_dir(&instance.id);
    paths::create_dir(&home_dir.join("base"))?;
    if !instance
        .game
        .spec()
        .launch_layout
        .engine_dir_on_search_path()
    {
        engine_install::sync_engine_archives(&engine_dir, &home_dir)?;
    }
    let base_dir = if instance.game.spec().launch_layout.needs_own_basepath() {
        launch::prepare_external_basepath(
            instance.game,
            &paths.server_dir(&instance.id),
            &engine_dir,
            &game_data,
        )?
    } else {
        paths.server_dir(&instance.id).join("basepath")
    };
    let empty: Vec<String> = Vec::new();
    let mut args = launch::root_args(&LaunchPlan {
        game: instance.game,
        game_data: &game_data,
        engine_dir: &engine_dir,
        base_dir: &base_dir,
        home_dir: &home_dir,
        fs_game: instance.mod_folder.as_deref(),
        settings_args: &empty,
        client_args: &empty,
        profile_args: &empty,
        extra_args: &empty,
        connect: None,
    });
    args.extend(launch::split_args(&instance.engine_args));
    args.extend(launch::split_args(&instance.mod_args));
    push_set(
        &mut args,
        "dedicated",
        if instance.public { "2" } else { "1" },
    );
    push_set(&mut args, "net_port", &instance.port.to_string());
    args.push("+exec".into());
    args.push(instance.startup_config.clone());

    let log_path = paths
        .server_dir(&instance.id)
        .join("logs")
        .join("console.log");
    let output = Arc::new(ConsoleOutput::with_log(&log_path));
    output.note(&format!(
        "starting {} {} for server instance {}",
        engine_name, engine_version, instance.id
    ));
    let process = Arc::new(ServerProcess::spawn(
        &executable,
        &engine_dir,
        &args,
        output,
    )?);
    let status = ServerProcessStatus {
        state: "running".into(),
        pid: Some(process.pid()),
        started_at: Some(timestamp::now_rfc3339()),
        exit_code: None,
        log_tail: process.output().tail(200),
    };
    processes.lock()?.insert(
        instance.id.clone(),
        RunningInstance {
            process,
            started_at: status.started_at.clone().unwrap_or_default(),
        },
    );
    emit_changed(&app, Some(&instance.id));
    Ok(status)
}

#[tauri::command]
pub fn stop_server_instance(
    app: AppHandle,
    processes: tauri::State<'_, ServerInstancesState>,
    server_id: String,
) -> Result<ServerProcessStatus> {
    let mut running = processes.lock()?;
    let Some(entry) = running.remove(&server_id) else {
        return Ok(ServerProcessStatus::stopped());
    };
    let _ = entry.process.type_line("quit");
    if entry.process.wait(Duration::from_secs(3)).is_none() {
        entry.process.terminate();
        let _ = entry.process.wait(Duration::from_secs(2));
    }
    let code = entry.process.exit_code();
    let tail = entry.process.output().tail(200);
    entry.process.close();
    drop(running);
    emit_changed(&app, Some(&server_id));
    Ok(ServerProcessStatus {
        state: "stopped".into(),
        pid: None,
        started_at: None,
        exit_code: code,
        log_tail: tail,
    })
}

fn server_mod_category(game: Game) -> u32 {
    match game {
        Game::JediAcademy => JA_SERVER_MOD_CATEGORY,
        Game::JediOutcast => JO_SERVER_MOD_CATEGORY,
    }
}

fn is_base_engine(engine_id: &str, game: Game) -> bool {
    engine_id == BASE_ENGINE_ID && game == Game::JediAcademy
}

fn validate_server_engine(engine_id: &str, game: Game) -> Result<()> {
    if engine_id == BASE_ENGINE_ID {
        return if is_base_engine(engine_id, game) {
            Ok(())
        } else {
            Err(AppError::InvalidInput(
                "Base is only available for Jedi Academy".into(),
            ))
        };
    }
    let engine = engines::require_for_game(engine_id, game)?;
    if engine.dedicated.is_none() {
        return Err(AppError::InvalidInput(format!(
            "{} does not ship a dedicated server",
            engine.name
        )));
    }
    Ok(())
}

fn create_instance(paths: &DataPaths, input: CreateServerInstance) -> Result<ServerInstance> {
    paths.ensure()?;
    let name = validate_name(&input.name)?;
    validate_server_engine(&input.engine_id, input.game)?;
    let server_mod = input
        .mod_id
        .as_deref()
        .map(|id| read_mod(paths, id))
        .transpose()?;
    if server_mod
        .as_ref()
        .is_some_and(|item| item.game != input.game)
    {
        return Err(AppError::InvalidInput(
            "the server mod belongs to another game".into(),
        ));
    }
    let id = next_slug(&paths.servers, &name, "server");
    let dir = paths.server_dir(&id);
    let home = paths.server_home_dir(&id);
    paths::create_dir(&home.join("base"))?;
    let now = timestamp::now_rfc3339();
    let mut instance = ServerInstance {
        id,
        name: name.clone(),
        game: input.game,
        engine_id: input.engine_id,
        mod_id: server_mod.as_ref().map(|item| item.id.clone()),
        mod_folder: server_mod.as_ref().map(|item| item.folder.clone()),
        port: input.port.unwrap_or(input.game.spec().server_port),
        public: input.public.unwrap_or(false),
        startup_config: "server.cfg".into(),
        engine_args: String::new(),
        mod_args: String::new(),
        template_files: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    if instance.port == 0 {
        return Err(AppError::InvalidInput("server port cannot be zero".into()));
    }
    if let Some(server_mod) = &server_mod {
        copy_mod_into_instance(paths, &mut instance, server_mod)?;
    }
    let folder = instance.mod_folder.as_deref().unwrap_or("base");
    let config = dir.join("home").join(folder).join("server.cfg");
    paths::create_dir(config.parent().unwrap_or(&home))?;
    fs::write(&config, default_config(&name, input.game))
        .map_err(|e| AppError::io_path("cannot write", &config, e))?;
    set_template(
        &mut instance,
        &relative_string(&dir, &config)?,
        true,
        "config",
    );
    write_instance(paths, &instance)?;
    Ok(instance)
}

fn replace_instance_mod(
    paths: &DataPaths,
    instance: &mut ServerInstance,
    server_mod: Option<&ServerMod>,
) -> Result<()> {
    let root = paths.server_dir(&instance.id);
    let old_sources: BTreeSet<String> = instance
        .template_files
        .iter()
        .filter(|item| item.source.starts_with("mod:"))
        .map(|item| item.path.clone())
        .collect();
    for path in &old_sources {
        let file = safe_relative(&root, path)?;
        if file.is_file() {
            fs::remove_file(&file).map_err(|e| AppError::io_path("cannot replace", &file, e))?;
        }
    }
    instance
        .template_files
        .retain(|item| !item.source.starts_with("mod:"));
    if let Some(server_mod) = server_mod {
        copy_mod_into_instance(paths, instance, server_mod)?;
    }
    Ok(())
}

/// Keeps the instance's authored startup config active when its mod changes.
///
/// Mod files are reusable templates, while the config belongs to the
/// instance. A change from `base` to `japlus` (or back) therefore moves the
/// config into the folder the engine will search after `fs_game` changes. If
/// the mod ships a config with the same name, the instance's config wins.
fn move_startup_config(
    paths: &DataPaths,
    instance: &mut ServerInstance,
    old_folder: &str,
    new_folder: &str,
) -> Result<()> {
    if old_folder == new_folder {
        return Ok(());
    }
    let root = paths.server_dir(&instance.id);
    let source = root
        .join("home")
        .join(old_folder)
        .join(&instance.startup_config);
    if !source.is_file() {
        return Ok(());
    }
    let target = root
        .join("home")
        .join(new_folder)
        .join(&instance.startup_config);
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    fs::copy(&source, &target)
        .map_err(|e| AppError::io_path("cannot move server config", &source, e))?;
    fs::remove_file(&source)
        .map_err(|e| AppError::io_path("cannot move server config", &source, e))?;
    let old_relative = relative_string(&root, &source)?;
    let new_relative = relative_string(&root, &target)?;
    let source_kind = instance
        .template_files
        .iter()
        .find(|item| item.path == old_relative)
        .map(|item| item.source.clone())
        .unwrap_or_else(|| "config".into());
    instance
        .template_files
        .retain(|item| item.path != old_relative && item.path != new_relative);
    instance.template_files.push(TemplateFile {
        path: new_relative,
        source: source_kind,
    });
    normalize_manifest(&mut instance.template_files);
    Ok(())
}

fn copy_mod_into_instance(
    paths: &DataPaths,
    instance: &mut ServerInstance,
    server_mod: &ServerMod,
) -> Result<()> {
    let source_root = paths.server_mod_dir(&server_mod.id).join(MOD_FILES);
    let instance_root = paths.server_dir(&instance.id);
    for relative in &server_mod.files {
        let source = safe_relative(&source_root, relative)?;
        let target_relative = mod_instance_path(&server_mod.folder, relative)?;
        let target = safe_relative(&instance_root, &target_relative)?;
        if target.exists() {
            match instance
                .template_files
                .iter()
                .find(|item| item.path == target_relative)
            {
                Some(item) if !item.source.starts_with("mod:") => continue,
                None => return Err(AppError::AlreadyExists(target.display().to_string())),
                Some(_) => {}
            }
        }
        if let Some(parent) = target.parent() {
            paths::create_dir(parent)?;
        }
        fs::copy(&source, &target).map_err(|e| AppError::io_path("cannot copy", &source, e))?;
        instance.template_files.push(TemplateFile {
            path: target_relative.clone(),
            source: format!("mod:{}", server_mod.id),
        });
        copy_wrapped_server_module(&source, &target, &instance_root, instance, server_mod)?;
    }
    normalize_manifest(&mut instance.template_files);
    Ok(())
}

/// Maps a reusable mod archive into the writable `home` tree.
///
/// Server distributions commonly contain a GameData-shaped root with both
/// `base/` and the mod folder. Archives that already contain only the mod's
/// files remain supported: their root files land in the selected mod folder.
fn mod_instance_path(folder: &str, relative: &str) -> Result<String> {
    let relative = normalize_relative(relative)?;
    let first = relative.split('/').next().unwrap_or_default();
    if first.eq_ignore_ascii_case(folder) || first.eq_ignore_ascii_case("base") {
        Ok(format!("home/{relative}"))
    } else {
        Ok(format!("home/{folder}/{relative}"))
    }
}

fn legacy_mod_instance_path(folder: &str, relative: &str) -> Result<String> {
    Ok(format!("home/{folder}/{}", normalize_relative(relative)?))
}

/// Moves files created by the first server-manager build out of
/// `home/<mod>/<mod>` and `home/<mod>/base` without replacing instance data.
fn repair_instance_mod_layout(
    paths: &DataPaths,
    instance: &mut ServerInstance,
    server_mod: &ServerMod,
) -> Result<bool> {
    let instance_root = paths.server_dir(&instance.id);
    let source_tag = format!("mod:{}", server_mod.id);
    let mut changed = false;

    for relative in &server_mod.files {
        let old_relative = legacy_mod_instance_path(&server_mod.folder, relative)?;
        let new_relative = mod_instance_path(&server_mod.folder, relative)?;
        if old_relative == new_relative {
            continue;
        }
        let Some(index) = instance
            .template_files
            .iter()
            .position(|item| item.path == old_relative && item.source == source_tag)
        else {
            continue;
        };
        let old_path = safe_relative(&instance_root, &old_relative)?;
        let new_path = safe_relative(&instance_root, &new_relative)?;
        if !old_path.is_file() {
            instance.template_files.remove(index);
            changed = true;
            continue;
        }
        if new_path.exists() {
            let target_is_instance_file = instance
                .template_files
                .iter()
                .any(|item| item.path == new_relative && !item.source.starts_with("mod:"));
            if !target_is_instance_file {
                return Err(AppError::AlreadyExists(new_path.display().to_string()));
            }
            fs::remove_file(&old_path)
                .map_err(|e| AppError::io_path("cannot remove obsolete mod file", &old_path, e))?;
            instance.template_files.remove(index);
        } else {
            if let Some(parent) = new_path.parent() {
                paths::create_dir(parent)?;
            }
            fs::rename(&old_path, &new_path)
                .map_err(|e| AppError::io_path("cannot move mod file", &old_path, e))?;
            instance.template_files[index].path = new_relative;
        }
        changed = true;
    }

    let source_root = paths.server_mod_dir(&server_mod.id).join(MOD_FILES);
    for relative in &server_mod.files {
        let source = safe_relative(&source_root, relative)?;
        let target_relative = mod_instance_path(&server_mod.folder, relative)?;
        let target = safe_relative(&instance_root, &target_relative)?;
        changed |=
            copy_wrapped_server_module(&source, &target, &instance_root, instance, server_mod)?;
    }

    normalize_manifest(&mut instance.template_files);
    for obsolete in [
        instance_root
            .join("home")
            .join(&server_mod.folder)
            .join(&server_mod.folder),
        instance_root
            .join("home")
            .join(&server_mod.folder)
            .join("base"),
    ] {
        if obsolete.is_dir() {
            let _ = fs::remove_dir(&obsolete);
        }
    }
    Ok(changed)
}

/// Extracts a native Windows game module from its conventional pk3 wrapper.
///
/// Several legacy server mods distribute the DLL this way. OpenJK indexes the
/// pk3 as game data but intentionally loads native libraries only as loose
/// files, so the server manager materialises that one named entry beside the
/// wrapper. No other archive entry is extracted.
fn copy_wrapped_server_module(
    source: &Path,
    target: &Path,
    instance_root: &Path,
    instance: &mut ServerInstance,
    server_mod: &ServerMod,
) -> Result<bool> {
    let Some(module_name) = wrapped_server_module_name(source) else {
        return Ok(false);
    };
    let module = target.parent().unwrap_or(instance_root).join(module_name);
    let relative = relative_string(instance_root, &module)?;
    if module.exists() {
        return Ok(false);
    }

    let reader = fs::File::open(source)
        .map_err(|e| AppError::io_path("cannot open server module wrapper", source, e))?;
    let mut archive = zip::ZipArchive::new(reader)?;
    let index = (0..archive.len())
        .find(|index| {
            archive
                .by_index(*index)
                .ok()
                .and_then(|entry| {
                    Path::new(entry.name())
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(|name| name.eq_ignore_ascii_case(module_name))
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            AppError::Archive(format!(
                "{} does not contain {module_name}",
                source.display()
            ))
        })?;
    let mut entry = archive.by_index(index)?;
    if let Some(parent) = module.parent() {
        paths::create_dir(parent)?;
    }
    let temporary = module.with_extension("dll.tmp");
    let mut output = fs::File::create(&temporary)
        .map_err(|e| AppError::io_path("cannot create server module", &temporary, e))?;
    std::io::copy(&mut entry, &mut output)
        .map_err(|e| AppError::io_path("cannot extract server module", &temporary, e))?;
    drop(output);
    if module.exists() {
        fs::remove_file(&module)
            .map_err(|e| AppError::io_path("cannot replace server module", &module, e))?;
    }
    fs::rename(&temporary, &module)
        .map_err(|e| AppError::io_path("cannot install server module", &module, e))?;
    set_template(instance, &relative, true, &format!("mod:{}", server_mod.id));
    Ok(true)
}

fn wrapped_server_module_name(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    if name.eq_ignore_ascii_case("jampgamex86.pk3") {
        Some("jampgamex86.dll")
    } else if name.eq_ignore_ascii_case("jampgamex86_64.pk3") {
        Some("jampgamex86_64.dll")
    } else {
        None
    }
}

/// Architecture of the native game module shipped by a server mod.
///
/// An archive may also contain Linux and macOS modules. Only the Windows DLL
/// or its conventional pk3 wrapper decides which dedicated executable can
/// load the mod.
fn server_mod_architecture(server_mod: &ServerMod) -> Option<&'static str> {
    let mut x86 = false;
    let mut x64 = false;
    for relative in &server_mod.files {
        let name = Path::new(relative)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        x86 |= matches!(name.as_str(), "jampgamex86.dll" | "jampgamex86.pk3");
        x64 |= matches!(name.as_str(), "jampgamex86_64.dll" | "jampgamex86_64.pk3");
    }
    match (x86, x64) {
        (true, false) => Some("x86"),
        (false, true) => Some("x86_64"),
        _ => None,
    }
}

fn create_mod_record(
    paths: &DataPaths,
    name: &str,
    game: Game,
    folder: &str,
    source: ServerModSource,
    staged: &Path,
) -> Result<ServerMod> {
    paths.ensure()?;
    let name = validate_name(name)?;
    let folder = validate_component(folder, "mod folder")?;
    let id = next_slug(&paths.server_mods, &name, "mod");
    let dir = paths.server_mod_dir(&id);
    let files_root = dir.join(MOD_FILES);
    paths::create_dir(&files_root)?;
    let mut copied = Vec::new();
    copy_tree(staged, &files_root, &mut copied)?;
    let mut files = copied
        .iter()
        .map(|path| relative_string(&files_root, path))
        .collect::<Result<Vec<_>>>()?;
    files.sort();
    files.dedup();
    if files.is_empty() {
        let _ = fs::remove_dir_all(&dir);
        return Err(AppError::InvalidInput(
            "the server mod contains no files".into(),
        ));
    }
    let record = ServerMod {
        id,
        name,
        game,
        folder,
        source,
        files,
        created_at: timestamp::now_rfc3339(),
    };
    write_json(&dir.join(MOD_RECORD), &record)?;
    Ok(record)
}

fn stage_mod_source(source: &Path, target: &Path) -> Result<()> {
    if source.is_dir() {
        let mut copied = Vec::new();
        return copy_tree(source, target, &mut copied);
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "zip" {
        return engine_install::extract_archive(source, target);
    }
    paths::create_dir(target)?;
    let name = source
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("the source file has no name".into()))?;
    fs::copy(source, target.join(name)).map_err(|e| AppError::io_path("cannot copy", source, e))?;
    Ok(())
}

fn collect_files(
    instance_root: &Path,
    folder: &Path,
    manifest: &HashMap<&str, &str>,
    out: &mut Vec<ServerFile>,
) -> Result<()> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry.map_err(|e| AppError::io_path("cannot list", folder, e))?;
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|e| AppError::io_path("cannot inspect", &path, e))?
            .is_dir()
        {
            collect_files(instance_root, &path, manifest, out)?;
            continue;
        }
        let relative = relative_string(instance_root, &path)?;
        let metadata = entry
            .metadata()
            .map_err(|e| AppError::io_path("cannot inspect", &path, e))?;
        out.push(ServerFile {
            kind: file_kind(&relative),
            size: metadata.len(),
            template: manifest.contains_key(relative.as_str()),
            source: manifest
                .get(relative.as_str())
                .map(|value| (*value).to_string()),
            path: relative,
        });
    }
    Ok(())
}

fn file_view(root: &Path, file: &Path, instance: &ServerInstance) -> Result<ServerFile> {
    let relative = relative_string(root, file)?;
    let template = instance
        .template_files
        .iter()
        .find(|item| item.path == relative);
    Ok(ServerFile {
        path: relative.clone(),
        size: fs::metadata(file)
            .map_err(|e| AppError::io_path("cannot inspect", file, e))?
            .len(),
        kind: file_kind(&relative),
        template: template.is_some(),
        source: template.map(|item| item.source.clone()),
    })
}

fn file_kind(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "cfg" => "config",
        "pk3" => "pk3",
        "dll" | "so" | "dylib" => "module",
        "db" | "sqlite" | "sqlite3" => "database",
        "log" => "log",
        "txt" | "json" | "xml" | "yaml" | "yml" | "ini" => "text",
        _ => "other",
    }
    .into()
}

fn set_template(instance: &mut ServerInstance, path: &str, enabled: bool, source: &str) {
    let normalized = normalize_relative(path).unwrap_or_else(|_| path.replace('\\', "/"));
    instance
        .template_files
        .retain(|item| item.path != normalized);
    if enabled {
        instance.template_files.push(TemplateFile {
            path: normalized,
            source: source.into(),
        });
    }
    normalize_manifest(&mut instance.template_files);
}

fn normalize_manifest(files: &mut Vec<TemplateFile>) {
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.dedup_by(|left, right| left.path == right.path);
}

fn instance_file(
    paths: &DataPaths,
    instance: &ServerInstance,
    relative: &str,
    writable: bool,
) -> Result<PathBuf> {
    let relative = normalize_relative(relative)?;
    if relative != "home"
        && !relative.starts_with("home/")
        && (!(!writable && relative.starts_with("logs/")))
    {
        return Err(AppError::InvalidInput(
            "server files must be under home or logs".into(),
        ));
    }
    let file = safe_relative(&paths.server_dir(&instance.id), &relative)?;
    if !writable && !file.exists() {
        return Err(AppError::NotFound(file.display().to_string()));
    }
    Ok(file)
}

fn read_all_instances(paths: &DataPaths) -> Result<Vec<ServerInstance>> {
    read_records(&paths.servers, INSTANCE_RECORD)
}

fn read_instance(paths: &DataPaths, id: &str) -> Result<ServerInstance> {
    let id = validate_component(id, "server id")?;
    read_json(&paths.server_dir(&id).join(INSTANCE_RECORD))
}

fn write_instance(paths: &DataPaths, instance: &ServerInstance) -> Result<()> {
    write_json(
        &paths.server_dir(&instance.id).join(INSTANCE_RECORD),
        instance,
    )
}

fn read_mod(paths: &DataPaths, id: &str) -> Result<ServerMod> {
    let id = validate_component(id, "server mod id")?;
    read_json(&paths.server_mod_dir(&id).join(MOD_RECORD))
}

fn read_records<T: for<'de> Deserialize<'de>>(root: &Path, record: &str) -> Result<Vec<T>> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(Vec::new());
    };
    let mut records = Vec::new();
    for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
        let file = entry.path().join(record);
        if !file.is_file() {
            continue;
        }
        match read_json(&file) {
            Ok(value) => records.push(value),
            Err(error) => log::warn!("skipping {}: {error}", file.display()),
        }
    }
    Ok(records)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path).map_err(|e| AppError::io_path("cannot read", path, e))?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidInput(format!("{} is not valid JSON: {e}", path.display())))
}

fn read_json_optional<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    read_json(path).ok()
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        paths::create_dir(parent)?;
    }
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::State(format!("cannot serialize {}: {e}", path.display())))?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, format!("{text}\n"))
        .map_err(|e| AppError::io_path("cannot write", &temporary, e))?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| AppError::io_path("cannot replace", path, e))?;
    }
    fs::rename(&temporary, path).map_err(|e| AppError::io_path("cannot rename", path, e))
}

fn validate_name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_NAME_LEN {
        return Err(AppError::InvalidInput(format!(
            "the name must contain 1 to {MAX_NAME_LEN} characters"
        )));
    }
    Ok(value.to_string())
}

fn validate_component(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(AppError::InvalidInput(format!(
            "{label} must use letters, digits, '-' or '_'"
        )));
    }
    Ok(value.to_string())
}

fn validate_file_name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
    {
        return Err(AppError::InvalidInput(
            "the startup config must be one file name".into(),
        ));
    }
    Ok(value.to_string())
}

fn next_slug(root: &Path, name: &str, fallback: &str) -> String {
    let mut base = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            base.push(ch.to_ascii_lowercase());
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base = base.trim_matches('-');
    let base = if base.is_empty() { fallback } else { base };
    if !root.join(base).exists() {
        return base.to_string();
    }
    (2..)
        .map(|number| format!("{base}-{number}"))
        .find(|candidate| !root.join(candidate).exists())
        .unwrap_or_else(|| format!("{base}-{}", timestamp::now_unix()))
}

fn normalize_relative(value: &str) -> Result<String> {
    let normalized = value.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::InvalidInput(format!(
                    "{value} points outside the server instance"
                )))
            }
        }
    }
    if parts.is_empty() {
        return Err(AppError::InvalidInput("the server path is empty".into()));
    }
    Ok(parts.join("/"))
}

fn safe_relative(root: &Path, relative: &str) -> Result<PathBuf> {
    let normalized = normalize_relative(relative)?;
    let mut path = root.to_path_buf();
    for part in normalized.split('/') {
        path.push(part);
    }
    Ok(path)
}

fn relative_string(root: &Path, path: &Path) -> Result<String> {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| {
            AppError::InvalidInput(format!("{} is outside {}", path.display(), root.display()))
        })
}

fn copy_tree(source: &Path, target: &Path, copied: &mut Vec<PathBuf>) -> Result<()> {
    paths::create_dir(target)?;
    let entries = fs::read_dir(source).map_err(|e| AppError::io_path("cannot list", source, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| AppError::io_path("cannot list", source, e))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::io_path("cannot inspect", &from, e))?;
        if file_type.is_symlink() {
            return Err(AppError::InvalidInput(format!(
                "{} is a link and cannot be imported",
                from.display()
            )));
        }
        if file_type.is_dir() {
            copy_tree(&from, &to, copied)?;
        } else if file_type.is_file() {
            if let Some(parent) = to.parent() {
                paths::create_dir(parent)?;
            }
            fs::copy(&from, &to).map_err(|e| AppError::io_path("cannot copy", &from, e))?;
            copied.push(to);
        }
    }
    Ok(())
}

fn unlink_basepath(instance_dir: &Path) -> Result<()> {
    let link = instance_dir.join("basepath").join("base");
    if let Ok(metadata) = fs::symlink_metadata(&link) {
        if metadata.file_type().is_symlink() {
            fs::remove_dir(&link).map_err(|e| AppError::io_path("cannot unlink", &link, e))?;
        }
    }
    Ok(())
}

fn push_set(args: &mut Vec<String>, name: &str, value: &str) {
    args.push("+set".into());
    args.push(name.into());
    args.push(value.into());
}

fn default_config(name: &str, game: Game) -> String {
    let map = match game {
        Game::JediAcademy => "mp/ffa3",
        Game::JediOutcast => "ffa_bespin",
    };
    format!(
        "// Created by JKNet for this server instance.\nset sv_hostname \"{}\"\nset sv_maxclients 16\nset g_gametype 0\nmap {}\n",
        name.replace('"', ""),
        map
    )
}

fn emit_changed(app: &AppHandle, server_id: Option<&str>) {
    let payload = server_id.unwrap_or_default().to_string();
    if let Err(error) = app.emit(CHANGED_EVENT, payload) {
        log::warn!("cannot emit {CHANGED_EVENT}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;

    #[test]
    fn server_mod_categories_match_the_two_jkhub_server_side_shelves() {
        assert_eq!(server_mod_category(Game::JediAcademy), 25);
        assert_eq!(server_mod_category(Game::JediOutcast), 43);
    }

    #[test]
    fn base_is_only_a_jedi_academy_server_engine() {
        assert!(validate_server_engine(BASE_ENGINE_ID, Game::JediAcademy).is_ok());
        assert!(validate_server_engine(BASE_ENGINE_ID, Game::JediOutcast).is_err());
    }

    #[test]
    fn relative_paths_cannot_leave_an_instance() {
        assert_eq!(
            normalize_relative("home\\base\\server.cfg").unwrap(),
            "home/base/server.cfg"
        );
        assert!(normalize_relative("../settings.json").is_err());
        assert!(normalize_relative("C:\\outside.txt").is_err());
    }

    #[test]
    fn game_data_shaped_mods_keep_base_and_mod_folders_at_home_root() {
        assert_eq!(
            mod_instance_path("japlus", "japlus/jampgamex86.pk3").unwrap(),
            "home/japlus/jampgamex86.pk3"
        );
        assert_eq!(
            mod_instance_path("japlus", "base/japlus_gla_anims.pk3").unwrap(),
            "home/base/japlus_gla_anims.pk3"
        );
        assert_eq!(
            mod_instance_path("japlus", "readme.txt").unwrap(),
            "home/japlus/readme.txt"
        );
    }

    #[test]
    fn ja_plus_requires_a_32_bit_dedicated_server() {
        let mut server_mod = test_server_mod(vec!["japlus/jampgamex86.pk3"]);
        assert_eq!(server_mod_architecture(&server_mod), Some("x86"));
        server_mod.files = vec!["japlus/jampgamex86_64.dll".into()];
        assert_eq!(server_mod_architecture(&server_mod), Some("x86_64"));
        server_mod.files.push("japlus/jampgamex86.pk3".into());
        assert_eq!(server_mod_architecture(&server_mod), None);
    }

    #[test]
    fn a_wrapped_ja_plus_module_is_materialised_as_a_loose_dll() {
        let temp = TempDir::new().unwrap();
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().unwrap();
        let source = paths
            .server_mod_dir("japlus")
            .join(MOD_FILES)
            .join("japlus/jampgamex86.pk3");
        paths::create_dir(source.parent().unwrap()).unwrap();
        write_test_zip(&source, "jampgamex86.dll", b"JA+ module");
        let server_mod = test_server_mod(vec!["japlus/jampgamex86.pk3"]);
        let mut instance = test_instance(Vec::new());

        copy_mod_into_instance(&paths, &mut instance, &server_mod).unwrap();

        let home = paths.server_home_dir("server").join("japlus");
        assert!(home.join("jampgamex86.pk3").is_file());
        assert_eq!(
            fs::read(home.join("jampgamex86.dll")).unwrap(),
            b"JA+ module"
        );
        assert!(instance.template_files.iter().any(|item| {
            item.path == "home/japlus/jampgamex86.dll" && item.source == "mod:japlus"
        }));
    }

    #[test]
    fn legacy_nested_mod_layout_is_repaired_without_replacing_the_config() {
        let temp = TempDir::new().unwrap();
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().unwrap();
        let root = paths.server_dir("server");
        paths::create_dir(&root.join("home/japlus/japlus")).unwrap();
        paths::create_dir(&root.join("home/japlus/base")).unwrap();
        fs::write(root.join("home/japlus/japlus/admin.cfg"), "edited admin").unwrap();
        fs::write(root.join("home/japlus/japlus/server.cfg"), "mod sample").unwrap();
        fs::write(root.join("home/japlus/base/anims.pk3"), "anims").unwrap();
        fs::write(root.join("home/japlus/server.cfg"), "instance config").unwrap();
        let server_mod = test_server_mod(vec![
            "japlus/admin.cfg",
            "japlus/server.cfg",
            "base/anims.pk3",
        ]);
        let mut instance = test_instance(vec![
            TemplateFile {
                path: "home/japlus/japlus/admin.cfg".into(),
                source: "mod:japlus".into(),
            },
            TemplateFile {
                path: "home/japlus/japlus/server.cfg".into(),
                source: "mod:japlus".into(),
            },
            TemplateFile {
                path: "home/japlus/base/anims.pk3".into(),
                source: "mod:japlus".into(),
            },
            TemplateFile {
                path: "home/japlus/server.cfg".into(),
                source: "config".into(),
            },
        ]);

        assert!(repair_instance_mod_layout(&paths, &mut instance, &server_mod).unwrap());

        assert_eq!(
            fs::read_to_string(root.join("home/japlus/admin.cfg")).unwrap(),
            "edited admin"
        );
        assert_eq!(
            fs::read_to_string(root.join("home/japlus/server.cfg")).unwrap(),
            "instance config"
        );
        assert!(root.join("home/base/anims.pk3").is_file());
        assert!(!root.join("home/japlus/japlus").exists());
        assert!(!root.join("home/japlus/base").exists());
        assert!(instance
            .template_files
            .iter()
            .any(|item| { item.path == "home/japlus/admin.cfg" && item.source == "mod:japlus" }));
        assert!(instance
            .template_files
            .iter()
            .any(|item| { item.path == "home/japlus/server.cfg" && item.source == "config" }));
    }

    #[test]
    fn a_clone_copies_only_manifest_files() {
        let temp = TempDir::new().unwrap();
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().unwrap();
        let source = paths.server_dir("source");
        paths::create_dir(&source.join("home/base")).unwrap();
        paths::create_dir(&source.join("logs")).unwrap();
        fs::write(source.join("home/base/server.cfg"), "set sv_hostname test").unwrap();
        fs::write(source.join("home/base/users.db"), "instance data").unwrap();
        fs::write(source.join("logs/console.log"), "instance log").unwrap();
        let record = ServerInstance {
            id: "source".into(),
            name: "Source".into(),
            game: Game::JediAcademy,
            engine_id: "openjk".into(),
            mod_id: None,
            mod_folder: None,
            port: 29070,
            public: false,
            startup_config: "server.cfg".into(),
            engine_args: String::new(),
            mod_args: String::new(),
            template_files: vec![TemplateFile {
                path: "home/base/server.cfg".into(),
                source: "config".into(),
            }],
            created_at: timestamp::now_rfc3339(),
            updated_at: timestamp::now_rfc3339(),
        };
        write_instance(&paths, &record).unwrap();

        let target = paths.server_dir("copy");
        paths::create_dir(&target).unwrap();
        for item in &record.template_files {
            let from = safe_relative(&source, &item.path).unwrap();
            let to = safe_relative(&target, &item.path).unwrap();
            paths::create_dir(to.parent().unwrap()).unwrap();
            fs::copy(from, to).unwrap();
        }

        assert!(target.join("home/base/server.cfg").is_file());
        assert!(!target.join("home/base/users.db").exists());
        assert!(!target.join("logs/console.log").exists());
    }

    #[test]
    fn template_switch_is_stable_and_unique() {
        let mut instance = ServerInstance {
            id: "server".into(),
            name: "Server".into(),
            game: Game::JediAcademy,
            engine_id: "openjk".into(),
            mod_id: None,
            mod_folder: None,
            port: 29070,
            public: false,
            startup_config: "server.cfg".into(),
            engine_args: String::new(),
            mod_args: String::new(),
            template_files: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        set_template(&mut instance, "home/base/a.cfg", true, "user");
        set_template(&mut instance, "home\\base\\a.cfg", true, "user");
        assert_eq!(instance.template_files.len(), 1);
        set_template(&mut instance, "home/base/a.cfg", false, "user");
        assert!(instance.template_files.is_empty());
    }

    #[test]
    fn changing_mod_moves_the_instance_startup_config() {
        let temp = TempDir::new().unwrap();
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().unwrap();
        let root = paths.server_dir("server");
        paths::create_dir(&root.join("home/base")).unwrap();
        paths::create_dir(&root.join("home/japlus")).unwrap();
        fs::write(root.join("home/base/server.cfg"), "set sv_hostname mine").unwrap();
        fs::write(
            root.join("home/japlus/server.cfg"),
            "set sv_hostname mod-default",
        )
        .unwrap();
        let mut instance = ServerInstance {
            id: "server".into(),
            name: "Server".into(),
            game: Game::JediAcademy,
            engine_id: "openjk".into(),
            mod_id: None,
            mod_folder: None,
            port: 29070,
            public: false,
            startup_config: "server.cfg".into(),
            engine_args: String::new(),
            mod_args: String::new(),
            template_files: vec![
                TemplateFile {
                    path: "home/base/server.cfg".into(),
                    source: "config".into(),
                },
                TemplateFile {
                    path: "home/japlus/server.cfg".into(),
                    source: "mod:japlus".into(),
                },
            ],
            created_at: String::new(),
            updated_at: String::new(),
        };

        move_startup_config(&paths, &mut instance, "base", "japlus").unwrap();

        assert!(!root.join("home/base/server.cfg").exists());
        assert_eq!(
            fs::read_to_string(root.join("home/japlus/server.cfg")).unwrap(),
            "set sv_hostname mine"
        );
        assert_eq!(instance.template_files.len(), 1);
        assert_eq!(instance.template_files[0].path, "home/japlus/server.cfg");
        assert_eq!(instance.template_files[0].source, "config");
    }

    fn test_server_mod(files: Vec<&str>) -> ServerMod {
        ServerMod {
            id: "japlus".into(),
            name: "JA+".into(),
            game: Game::JediAcademy,
            folder: "japlus".into(),
            source: ServerModSource::Disk {
                path: "test".into(),
            },
            files: files.into_iter().map(str::to_string).collect(),
            created_at: String::new(),
        }
    }

    fn test_instance(template_files: Vec<TemplateFile>) -> ServerInstance {
        ServerInstance {
            id: "server".into(),
            name: "Server".into(),
            game: Game::JediAcademy,
            engine_id: "openjk".into(),
            mod_id: Some("japlus".into()),
            mod_folder: Some("japlus".into()),
            port: 29070,
            public: false,
            startup_config: "server.cfg".into(),
            engine_args: String::new(),
            mod_args: String::new(),
            template_files,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn write_test_zip(path: &Path, name: &str, body: &[u8]) {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(body).unwrap();
            writer.finish().unwrap();
        }
        fs::write(path, buffer.into_inner()).unwrap();
    }
}
