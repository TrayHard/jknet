//! Clients: named instances of an engine.
//!
//! A client is what the player actually launches. It owns an engine build, a
//! set of pk3 files and its own settings, and it is identified by the name the
//! player gave it, so two clients can run the same engine with different mods.
//!
//! On disk:
//!
//! ```text
//! clients\<slug>\client.json   the record below
//! clients\<slug>\engine\       engine files, filled by the installer later
//! clients\<slug>\home\base\    fs_homepath: configs, screenshots, mod folders
//! clients\<slug>\basepath\     fs_basepath of a Jedi Outcast client only,
//!                              built at launch by launch::prepare_basepath
//! ```
//!
//! The slug is derived from the first name and never changes afterwards, so a
//! rename cannot break a path that something else already stored.
//!
//! --- slice: game core ---
//! `basepath\base` is a directory junction into the player's game folder, and
//! that makes deleting a client the most dangerous operation in the launcher.
//! [`remove_client_dir`] unlinks it first and refuses to recurse if that
//! fails.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::bundles::BundlesState;
use crate::engine_install::InstallState;
use crate::engines::{self, Engine, LaunchMode};
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::paths::{self, DataPaths};
use crate::settings::Settings;
use crate::state::{AppState, StepLock};
use crate::timestamp;

/// Longest client name the launcher accepts. Long names break the card layout
/// and say nothing extra.
const MAX_NAME_LEN: usize = 48;

/// Longest mod folder the launcher accepts. `fs_game` names a folder inside
/// `home\`, and no mod on JKHub comes close to this.
const MAX_FS_GAME_LEN: usize = 64;

/// A client instance as stored in `client.json`.
///
/// Every field added after the first release carries `serde(default)`, so a
/// `client.json` written by an older build still loads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    /// Slug of the folder: lowercase ASCII with hyphens.
    pub id: String,
    /// Name the player typed.
    pub name: String,
    /// Id from the engine registry.
    pub engine_id: String,
    // --- slice: game core ---
    /// The game this client plays, always the game of its engine. A
    /// `client.json` written before the field existed reads as Jedi Academy,
    /// which is the only game the launcher had.
    #[serde(default)]
    pub game: Game,
    /// Installed engine version, `None` until the engine is downloaded.
    pub engine_version: Option<String>,
    /// UTC creation time, RFC 3339.
    pub created_at: String,

    // --- slice: launch ---
    /// When the engine was unpacked, RFC 3339.
    #[serde(default)]
    pub engine_installed_at: Option<String>,
    /// Publication time of the installed release, RFC 3339. Three of the four
    /// projects publish a rolling `latest` tag, so the tag alone cannot say
    /// whether a newer build exists.
    #[serde(default)]
    pub engine_published_at: Option<String>,
    /// Mod folder the client starts in, passed as `+set fs_game`. `None`
    /// takes the default of the engine, which is `base` for all but jaMME.
    #[serde(default)]
    pub fs_game: Option<String>,

    // --- slice: client launch args ---
    /// Command line of this client, written the way a shortcut is written.
    ///
    /// Split by [`crate::launch::split_args`] and handed to the engine after
    /// the tokens of the **Extra launch arguments** setting, so a client that
    /// repeats a `+set` of the same cvar is the value the engine keeps. Blank
    /// on a record written before the field existed, and blank is the
    /// launcher's own default.
    #[serde(default)]
    pub launch_args: String,

    // --- slice: bundles ---
    /// The modes this client starts in: `multiplayer`, and `single` when its
    /// engine ships a single-player game and the client is meant to play it.
    ///
    /// A client made on the Clients screen gets every mode of its engine; a
    /// client made out of a component of a bundle gets the modes of that
    /// component. Empty on a record written before the field existed, which
    /// reads as every mode of the engine: see [`Client::launch_modes`].
    #[serde(default)]
    pub modes: Vec<LaunchMode>,

    /// The bundle, or the draft of one, this client came out of. `None` for
    /// a client the player assembled by hand, and for every record written
    /// before bundles existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<ClientBundleLink>,
}

impl Client {
    // --- slice: bundles ---
    /// The modes the client may start in, read against its engine.
    ///
    /// The record wins when it names modes the engine has; a record that
    /// names none, or only modes its engine cannot start, reads as every mode
    /// of the engine, so a client written by an older build, or edited by
    /// hand into nonsense, still has a **Play** button.
    pub fn launch_modes(&self, engine: &Engine) -> Vec<LaunchMode> {
        let own: Vec<LaunchMode> = engine
            .modes()
            .into_iter()
            .filter(|mode| self.modes.contains(mode))
            .collect();
        if own.is_empty() {
            engine.modes()
        } else {
            own
        }
    }
}

// --- slice: bundles ---
/// What a client remembers about the bundle, or the draft, it came out of.
///
/// The bundle itself lives on JKNet Online and the draft in the data folder;
/// this is the note that lets a card say **From bundle**, group the clients
/// of one bundle, and lets the catalogue mark a bundle as installed. The
/// names and the labels are copies for the badge, taken at the moment of the
/// link: a bundle renamed on the service keeps its id, and the ids are what
/// every comparison uses.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientBundleLink {
    /// The bundle on the service. `None` for a client installed from a draft
    /// that has not been published yet; filled in when the draft is.
    #[serde(default)]
    pub bundle_id: Option<String>,
    #[serde(default)]
    pub bundle_slug: String,
    #[serde(default)]
    pub bundle_name: String,
    /// The draft the client was installed from with `install_bundle_draft`.
    /// `None` for a client installed from the catalogue.
    #[serde(default)]
    pub draft_id: Option<String>,
    /// The version of the bundle. `None` until a draft the client came from
    /// is published.
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub version_label: String,
    /// The component of the bundle this client is. Empty on a link written
    /// by the first edition, which knew one component per bundle.
    #[serde(default)]
    pub component_id: String,
    #[serde(default)]
    pub component_label: String,
    /// `installed`: the client was created out of the bundle or its draft.
    /// The only role since the second edition; `published` of the first is
    /// read but never written.
    pub role: String,
    /// Whether the component laid files over `engine\` or took files out of
    /// it. An engine update would undo that, so
    /// [`crate::engines::install_engine`] refuses one.
    #[serde(default)]
    pub engine_overlay: bool,
    /// When the link was written, RFC 3339.
    #[serde(default)]
    pub linked_at: String,
    /// `true` while an install of the bundle is running or stopped before
    /// its last step: the link is written first, so a retry can tell the
    /// client it is allowed to continue in, and cleared last. A record
    /// written before the field existed reads as a finished link.
    #[serde(default)]
    pub pending: bool,
}

impl ClientBundleLink {
    /// The client was created by installing the bundle or its draft.
    pub const INSTALLED: &'static str = "installed";
}

/// Lists every client, sorted by name.
#[tauri::command]
pub fn list_clients(state: tauri::State<'_, AppState>) -> Result<Vec<Client>> {
    let paths = state.paths()?;
    let mut clients = read_all(&paths)?;
    clients.sort_by_key(|client| client.name.to_lowercase());
    Ok(clients)
}

/// Creates a client folder layout and its record.
///
/// --- slice: game core ---
/// `game` is required and has to be the game of the engine. Deriving it from
/// the engine alone would be shorter and would hide the mistake the dialog can
/// actually make: sending the engine of the game the player did *not* pick.
#[tauri::command]
pub fn create_client(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    engine_id: String,
    game: Game,
) -> Result<Client> {
    let client = create_record(&state.paths()?, &name, &engine_id, game, None)?;
    emit_changed(&app, &client.id);
    Ok(client)
}

// --- slice: bundles ---
/// The body of [`create_client`]: the folder layout and the record, without
/// the event.
///
/// Split out for the bundle installer, which creates a client the same way
/// and announces it once the install is through, and for the tests, which
/// have no `AppHandle` to announce anything with.
///
/// `modes` is what the client may start in: `None` takes every mode of the
/// engine, which is what the Clients screen makes; a component of a bundle
/// hands its own list, which is cut down to the modes the engine has and
/// refused when nothing is left.
pub(crate) fn create_record(
    paths: &DataPaths,
    name: &str,
    engine_id: &str,
    game: Game,
    modes: Option<&[LaunchMode]>,
) -> Result<Client> {
    let name = validate_name(name)?;
    let engine = engines::require_for_game(engine_id, game)?;
    engine.require_host(crate::host_system::HostSystem::current())?;
    let modes = match modes {
        None => engine.modes(),
        Some(wanted) => {
            let modes: Vec<LaunchMode> = engine
                .modes()
                .into_iter()
                .filter(|mode| wanted.contains(mode))
                .collect();
            if modes.is_empty() {
                return Err(AppError::InvalidInput(format!(
                    "{} starts in none of the modes {:?}",
                    engine.name,
                    wanted.iter().map(|mode| mode.as_str()).collect::<Vec<_>>()
                )));
            }
            modes
        }
    };

    paths.ensure()?;
    let taken = read_all(paths)?
        .into_iter()
        .map(|client| client.id)
        .collect::<Vec<_>>();
    let id = unique_slug(&name, &taken);

    let dir = paths.client_dir(&id);
    if dir.exists() {
        return Err(AppError::AlreadyExists(dir.to_string_lossy().to_string()));
    }
    paths::create_dir(&dir.join("engine"))?;
    paths::create_dir(&dir.join("home").join("base"))?;

    let client = Client {
        id,
        name,
        engine_id: engine_id.to_string(),
        game,
        engine_version: None,
        created_at: timestamp::now_rfc3339(),
        engine_installed_at: None,
        engine_published_at: None,
        fs_game: None,
        launch_args: String::new(),
        modes,
        bundle: None,
    };
    write_record(paths, &client)?;
    log::info!(
        "created client {} on engine {} for {} ({})",
        client.id,
        client.engine_id,
        client.game.display_name(),
        client
            .modes
            .iter()
            .map(|mode| mode.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(client)
}

/// Changes the parts of a client the player may edit: its name, its mod
/// folder and its launch arguments.
///
/// A field left out of the call keeps its value. The folder on disk keeps its
/// slug even when the name changes: a path that another part of the launcher
/// stored must stay valid. An `fs_game` that is blank clears the field, which
/// puts the client back on the default folder of its engine.
///
/// --- slice: client launch args ---
/// `launch_args` is stored as the player wrote it, trimmed at the ends and
/// nothing more. It reaches the engine as its own tokens, and a field that
/// rewrote them would make the engine read something other than what the
/// player can see.
#[tauri::command]
pub fn update_client(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    name: Option<String>,
    fs_game: Option<String>,
    launch_args: Option<String>,
) -> Result<Client> {
    // What the player typed is checked before the lock: a refused value must
    // not cost another window the wait, and it never reaches a record.
    let name = name.map(|name| validate_name(&name)).transpose()?;
    let fs_game = fs_game.map(|value| validate_fs_game(&value)).transpose()?;
    let launch_args = launch_args.map(|line| line.trim().to_string());

    let paths = state.paths()?;
    let client = edit_record(state.client_records(), &paths, &client_id, |client| {
        if let Some(name) = name {
            client.name = name;
        }
        if let Some(fs_game) = fs_game {
            client.fs_game = fs_game;
        }
        if let Some(launch_args) = launch_args {
            client.launch_args = launch_args;
        }
    })?;
    log::info!(
        "updated client {}: name {:?}, fs_game {:?}, launch_args {:?}",
        client.id,
        client.name,
        client.fs_game,
        client.launch_args
    );
    // --- slice: client window ---
    // The card in the main window and the client's own window both show this
    // record, and either of them may be the one that changed it.
    emit_changed(&app, &client.id);
    Ok(client)
}

// --- slice: client window ---

/// Reads a client record, changes it and writes it back without anything else
/// getting between the three steps.
///
/// The lock is what makes them one step. Commands are plain `fn`, so Tauri
/// runs them on its pool of blocking threads: the window of a client and the
/// card of that client in the main window can both be inside this function at
/// the same moment, each holding a whole record built from its own read. The
/// second write would then put back every field the first one had just
/// changed, and nothing would report the loss — the player would simply find
/// their mod folder as it was.
///
/// `edit` runs under the lock and does only what a record needs. Checking what
/// the player typed belongs before the call.
pub(crate) fn edit_record(
    lock: &StepLock,
    paths: &DataPaths,
    client_id: &str,
    edit: impl FnOnce(&mut Client),
) -> Result<Client> {
    let _step = lock.enter();
    let mut client = read_record(paths, client_id)?;
    edit(&mut client);
    write_record(paths, &client)?;
    Ok(client)
}

/// Rewrites the launch arguments of a client and saves the record.
///
/// The `launch_args` half of [`update_client`], reachable from
/// [`crate::launch_tokens`]: a control in the client window edits one cvar
/// inside the line and the whole line comes back here, so there is one writer
/// of `client.json` and one place that announces the change.
///
/// `edit` receives the line as the record carries it, under the lock that
/// saves the answer. A caller that read the line first and handed over a
/// finished string would be writing the state of a moment ago over everything
/// stored since.
pub(crate) fn edit_launch_args(
    app: &AppHandle,
    state: &AppState,
    client_id: &str,
    edit: impl FnOnce(&str) -> String,
) -> Result<Client> {
    let paths = state.paths()?;
    let client = edit_record(state.client_records(), &paths, client_id, |client| {
        let line = edit(&client.launch_args);
        client.launch_args = line.trim().to_string();
    })?;
    log::info!(
        "updated client {}: launch_args {:?}",
        client.id,
        client.launch_args
    );
    emit_changed(app, &client.id);
    Ok(client)
}

/// Payload of `clients:changed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientsChanged {
    /// The client that was created, changed or deleted.
    pub client_id: String,
}

/// Tells every window that a client record is not what it was.
///
/// The launcher now has more than one window showing the same records, and a
/// React Query cache is per window. Without this the card in the main window
/// would keep the old name until something else refetched it.
pub(crate) fn emit_changed(app: &AppHandle, client_id: &str) {
    if let Err(e) = app.emit(
        "clients:changed",
        ClientsChanged {
            client_id: client_id.to_string(),
        },
    ) {
        log::warn!("cannot emit clients:changed: {e}");
    }
}

/// Deletes a client with its engine files and its home folder.
///
/// The folder is removed, not moved to the recycle bin: an engine install is
/// tens of megabytes of files the launcher can download again.
///
/// --- slice: bundles ---
/// A client an engine install or a bundle operation is running for is
/// refused with `AppError::Busy`: a folder deleted under a download would
/// turn that download into an I/O error halfway through, not into a refusal.
#[tauri::command]
pub fn delete_client(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    installs: tauri::State<'_, InstallState>,
    bundles: tauri::State<'_, BundlesState>,
    // --- slice: play with friends ---
    host: tauri::State<'_, crate::hosting::HostState>,
    id: String,
) -> Result<()> {
    // The dedicated server of a private server runs out of this folder.
    host.refuse_if_hosting(&id)?;
    remove_client(state.client_records(), &installs, &bundles, &state.paths()?, &id)?;
    // --- slice: client window ---
    // A window editing a client that no longer exists has nothing to show and
    // every field in it would fail on save.
    crate::client_window::close_for(&app, &id);
    emit_changed(&app, &id);

    // A deleted client must not stay the default one, of the launcher or of
    // its game. The document comes from disk, so this write carries over
    // whatever else changed there.
    let mut settings = Settings::current(&state)?;
    let was_default = settings.default_client_id.as_deref() == Some(id.as_str());
    // --- slice: game core ---
    let before = settings.default_client_ids.len();
    settings.default_client_ids.retain(|_, value| value != &id);
    if was_default || settings.default_client_ids.len() != before {
        settings.default_client_id = if was_default {
            None
        } else {
            settings.default_client_id.clone()
        };
        settings.save(&state)?;
        state.set_settings(settings.clone())?;
        // --- slice: clients page ---
        // The Play button of the Home screen and the badge on a card both read
        // this, and neither went through `update_settings` to learn about it.
        crate::settings::emit_default_clients(&app, &settings);
    }
    Ok(())
}

// --- slice: bundles ---
/// The body of [`delete_client`] up to the point the folder is gone, with
/// the two busy sets handed in so a test can hold a claim against it.
///
/// Both sets are claimed for the deletion rather than looked at: a claim is
/// the one check that cannot be overtaken by an install that starts between
/// the look and the removal. The claims go with the returned guard, that is,
/// at the end of this function.
pub(crate) fn remove_client(
    lock: &StepLock,
    installs: &InstallState,
    bundles: &BundlesState,
    paths: &DataPaths,
    id: &str,
) -> Result<()> {
    let _engine = installs.claim(id)?;
    let _bundle = bundles.claim(id, BundlesState::DELETE)?;
    let dir = paths.client_dir(id);
    // --- slice: client window ---
    // Under the lock of [`edit_record`]: a save that started a moment ago
    // finishes before the folder goes, and one that starts after it finds
    // no record to read instead of writing the folder back into existence.
    let _step = lock.enter();
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("client {id}")));
    }
    remove_client_dir(&dir)?;
    log::info!("deleted client {id}");
    Ok(())
}

// --- slice: clients page ---
/// Returns the folder of one client: `clients\<slug>\`.
///
/// The **Open folder** button of a card is the only caller, and it hands the
/// answer to the `opener` plugin. Built here rather than on the frontend out of
/// `dataRoot` because `dataDirOverride` moves that root and the slug is a
/// detail of this module: a path assembled on the screen would be a second
/// copy of a layout only `paths.rs` is allowed to know.
///
/// The record is read first, so an id that names nothing is a refusal rather
/// than a path to a folder that is not there.
#[tauri::command]
pub fn client_dir(state: tauri::State<'_, AppState>, client_id: String) -> Result<String> {
    folder_of(&state.paths()?, &client_id)
}

/// The body of [`client_dir`], with the layout handed in instead of read out
/// of the state. A `tauri::State` cannot be built outside a running app, and
/// this is the part a test can hold a real folder against.
fn folder_of(paths: &DataPaths, client_id: &str) -> Result<String> {
    let client = read_record(paths, client_id)?;
    Ok(paths.client_dir(&client.id).display().to_string())
}

// --- slice: game core ---

/// Deletes a client folder, unlinking `basepath\base` before anything
/// recursive happens.
///
/// A Jedi Outcast client keeps a directory junction at `basepath\base` that
/// points into the player's game folder — see
/// [`crate::launch::prepare_basepath`]. Windows `RemoveDirectoryW`, which is
/// what [`fs::remove_dir`] calls, deletes a reparse point as the link it is
/// and leaves the target alone; that is the operation this function performs
/// first, and on its own.
///
/// [`fs::remove_dir_all`] documents the same behaviour — it does not follow
/// links, it removes them — and the unlink above is therefore a second lock on
/// the same door. It is here because the cost of that door opening is the
/// player's copy of the game, and because a failure to unlink is reported
/// rather than recursed past: if the link will not go, nothing else does
/// either.
fn remove_client_dir(dir: &Path) -> Result<()> {
    let link = dir
        .join(paths::CLIENT_BASEPATH_DIR)
        .join(paths::BASE_FOLDER);
    if let Ok(meta) = fs::symlink_metadata(&link) {
        // A real folder here is the launcher's own fallback copy, or something
        // the player put inside a client they are deleting. Either way the
        // recursive removal below owns it.
        if meta.file_type().is_symlink() {
            fs::remove_dir(&link).map_err(|e| AppError::io_path("cannot unlink", &link, e))?;
            log::info!("unlinked {}", link.display());
        }
    }
    fs::remove_dir_all(dir).map_err(|e| AppError::io_path("cannot delete", dir, e))
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Reads every `client.json` under `clients\`.
///
/// A folder without a readable record is skipped with a warning rather than
/// failing the whole list: one broken client must not hide the others.
pub(crate) fn read_all(paths: &DataPaths) -> Result<Vec<Client>> {
    let Ok(entries) = fs::read_dir(&paths.clients) else {
        return Ok(Vec::new());
    };
    let mut clients = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let file = entry.path().join("client.json");
        if !file.is_file() {
            continue;
        }
        match read_file(&file) {
            Ok(client) => clients.push(client),
            Err(e) => log::warn!("skipping client folder: {e}"),
        }
    }
    Ok(clients)
}

/// Reads one client record by id.
pub(crate) fn read_record(paths: &DataPaths, id: &str) -> Result<Client> {
    let file = paths.client_dir(id).join("client.json");
    if !file.is_file() {
        return Err(AppError::NotFound(format!("client {id}")));
    }
    read_file(&file)
}

fn read_file(file: &Path) -> Result<Client> {
    let text =
        fs::read_to_string(file).map_err(|e| AppError::io_path("cannot read", file, e))?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::json(format!("cannot parse {}", file.display()), e))
}

pub(crate) fn write_record(paths: &DataPaths, client: &Client) -> Result<()> {
    let dir = paths.client_dir(&client.id);
    paths::create_dir(&dir)?;
    let file = dir.join("client.json");
    let text = serde_json::to_string_pretty(client)
        .map_err(|e| AppError::json("cannot serialize client", e))?;
    fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
}

// ---------------------------------------------------------------------------
// Names and slugs
// ---------------------------------------------------------------------------

/// Trims a name and rejects the empty and the overlong one.
fn validate_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("client name is empty".into()));
    }
    if trimmed.chars().count() > MAX_NAME_LEN {
        return Err(AppError::InvalidInput(format!(
            "client name is longer than {MAX_NAME_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// Checks a mod folder name and turns a blank one into `None`.
///
/// The value reaches the engine as `+set fs_game` and becomes a folder under
/// `home\`, so it has to stay a plain name: a separator, a drive letter or a
/// `..` would send the engine, and the Library screen with it, outside the
/// client. Letters, digits, `_`, `-` and `+` cover every mod folder in use,
/// `+` because of names like `ja+`.
///
/// `pub(crate)` for the bundle installer, which writes the `fsGame` of a
/// manifest through [`edit_record`] and owes the field the same check.
pub(crate) fn validate_fs_game(value: &str) -> Result<Option<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_FS_GAME_LEN {
        return Err(AppError::InvalidInput(format!(
            "the mod folder is longer than {MAX_FS_GAME_LEN} characters"
        )));
    }
    let plain = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '+'));
    if !plain {
        return Err(AppError::InvalidInput(format!(
            "the mod folder {trimmed:?} may hold only letters, digits, _, - and +"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

/// Turns a name into a folder-safe slug: lowercase ASCII letters, digits and
/// single hyphens. A name without usable characters becomes `client`.
fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "client".to_string()
    } else {
        slug
    }
}

/// Appends `-2`, `-3` and so on until the slug is free.
fn unique_slug(name: &str, taken: &[String]) -> String {
    let base = slugify(name);
    if !taken.iter().any(|id| id == &base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.iter().any(|id| id == candidate))
        .unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_lowercase_ascii_with_hyphens() {
        assert_eq!(slugify("Duel japro"), "duel-japro");
        assert_eq!(slugify("FFA JA+"), "ffa-ja");
        assert_eq!(slugify("  Everyday  "), "everyday");
        assert_eq!(slugify("дуэли"), "client");
        assert_eq!(slugify("v1.0.1 test"), "v1-0-1-test");
    }

    #[test]
    fn slugs_do_not_collide() {
        let taken = vec!["everyday".to_string(), "everyday-2".to_string()];
        assert_eq!(unique_slug("Everyday", &taken), "everyday-3");
        assert_eq!(unique_slug("Everyday", &[]), "everyday");
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(validate_name("  Duel  ").unwrap(), "Duel");
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn a_mod_folder_is_one_plain_name() {
        assert_eq!(validate_fs_game("japlus").unwrap().as_deref(), Some("japlus"));
        assert_eq!(validate_fs_game("  mme  ").unwrap().as_deref(), Some("mme"));
        assert_eq!(validate_fs_game("ja+").unwrap().as_deref(), Some("ja+"));
        assert_eq!(validate_fs_game("MB_II-2").unwrap().as_deref(), Some("MB_II-2"));
    }

    #[test]
    fn a_blank_mod_folder_means_the_default_of_the_engine() {
        assert_eq!(validate_fs_game("").unwrap(), None);
        assert_eq!(validate_fs_game("   ").unwrap(), None);
    }

    // --- slice: game core ---

    #[test]
    fn a_client_json_without_a_game_reads_as_jedi_academy() {
        // Every client on every installed launcher has such a record, and
        // Jedi Academy was the only game those clients could play.
        let older: Client = serde_json::from_str(
            r#"{"id":"everyday","name":"Everyday","engineId":"openjk",
                "engineVersion":"latest","createdAt":"2026-09-10T00:00:00Z"}"#,
        )
        .expect("an older record parses");
        assert_eq!(older.game, Game::JediAcademy);
        assert_eq!(older.engine_id, "openjk");
    }

    // --- slice: client launch args ---

    #[test]
    fn a_client_json_without_launch_arguments_reads_as_a_blank_line() {
        // The field arrived after the first release, so every record on every
        // installed launcher lacks it. A missing field is the same as an empty
        // one: the client adds nothing of its own to the command line.
        let older: Client = serde_json::from_str(
            r#"{"id":"everyday","name":"Everyday","engineId":"openjk","game":"ja",
                "engineVersion":"latest","createdAt":"2026-09-10T00:00:00Z"}"#,
        )
        .expect("an older record parses");
        assert_eq!(older.launch_args, "");

        let written: Client = serde_json::from_str(
            r#"{"id":"duel","name":"Duel","engineId":"openjk","game":"ja",
                "engineVersion":null,"createdAt":"2026-09-10T00:00:00Z",
                "launchArgs":"+set r_mode 4"}"#,
        )
        .expect("a record with the field parses");
        assert_eq!(written.launch_args, "+set r_mode 4");

        let json = serde_json::to_string(&written).expect("it serializes");
        assert!(json.contains("\"launchArgs\":\"+set r_mode 4\""), "{json}");
    }

    // --- slice: bundles ---

    #[test]
    fn a_client_json_without_a_bundle_link_reads_as_a_hand_made_client() {
        let older: Client = serde_json::from_str(
            r#"{"id":"everyday","name":"Everyday","engineId":"openjk","game":"ja",
                "engineVersion":"latest","createdAt":"2026-09-10T00:00:00Z"}"#,
        )
        .expect("an older record parses");
        assert_eq!(older.bundle, None);
        // And the field is not written back as `null`: a record of a client
        // nobody linked stays the record it was.
        let json = serde_json::to_string(&older).expect("it serializes");
        assert!(!json.contains("\"bundle\""), "{json}");

        let linked: Client = serde_json::from_str(
            r#"{"id":"duel","name":"Duel","engineId":"taystjk","game":"ja",
                "engineVersion":"v1.6.3","createdAt":"2026-09-10T00:00:00Z",
                "bundle":{"bundleId":"01J","bundleSlug":"taystjka-voip","bundleName":"Taystjka VoIP",
                          "versionId":"01K","versionLabel":"2026.1","role":"installed",
                          "engineOverlay":true,"linkedAt":"2026-09-15T00:00:00Z"}}"#,
        )
        .expect("a linked record parses");
        let link = linked.bundle.clone().expect("the link is read");
        assert_eq!(link.bundle_id.as_deref(), Some("01J"));
        assert_eq!(link.version_id.as_deref(), Some("01K"));
        assert_eq!(link.role, ClientBundleLink::INSTALLED);
        assert!(link.engine_overlay);
        // A link written before `pending`, `draftId` and the component
        // existed is a finished one of an unnamed component.
        assert!(!link.pending);
        assert_eq!(link.draft_id, None);
        assert_eq!(link.component_id, "");
        let json = serde_json::to_string(&linked).expect("it serializes");
        assert!(json.contains("\"engineOverlay\":true"), "{json}");
        assert!(json.contains("\"bundleSlug\":\"taystjka-voip\""), "{json}");
        assert!(json.contains("\"pending\":false"), "{json}");
        assert!(json.contains("\"componentId\":\"\""), "{json}");

        let mut unfinished = linked.clone();
        unfinished.bundle.as_mut().expect("the link").pending = true;
        let json = serde_json::to_string(&unfinished).expect("it serializes");
        let back: Client = serde_json::from_str(&json).expect("it reads back");
        assert!(back.bundle.expect("the link").pending);

        // A client installed from a draft that is not published: no bundle,
        // no version, the draft and the component named.
        let from_draft: Client = serde_json::from_str(
            r#"{"id":"rujka-sp","name":"RUJKA · Single player","engineId":"openjk","game":"ja",
                "engineVersion":"latest","createdAt":"2026-09-16T00:00:00Z","modes":["single"],
                "bundle":{"bundleId":null,"bundleSlug":"","bundleName":"RUJKA","draftId":"d1",
                          "versionId":null,"versionLabel":"3","componentId":"sp",
                          "componentLabel":"Single player","role":"installed",
                          "engineOverlay":false,"linkedAt":"2026-09-16T00:00:00Z","pending":false}}"#,
        )
        .expect("a draft-linked record parses");
        let link = from_draft.bundle.expect("the link");
        assert_eq!(link.bundle_id, None);
        assert_eq!(link.draft_id.as_deref(), Some("d1"));
        assert_eq!(link.component_id, "sp");
        assert_eq!(from_draft.modes, vec![LaunchMode::Single]);
    }

    #[test]
    fn the_modes_of_a_client_come_from_the_record_or_from_the_engine() {
        let openjk = engines::require("openjk").expect("openjk");
        let eternaljk = engines::require("eternaljk").expect("eternaljk");
        // A record written before modes existed: every mode of the engine.
        let older: Client = serde_json::from_str(
            r#"{"id":"everyday","name":"Everyday","engineId":"openjk","game":"ja",
                "engineVersion":"latest","createdAt":"2026-09-10T00:00:00Z"}"#,
        )
        .expect("an older record parses");
        assert!(older.modes.is_empty());
        assert_eq!(older.launch_modes(openjk), [LaunchMode::Multiplayer, LaunchMode::Single]);
        assert_eq!(older.launch_modes(eternaljk), [LaunchMode::Multiplayer]);

        // A component of a bundle that plays the single-player game alone.
        let mut single = older.clone();
        single.modes = vec![LaunchMode::Single];
        assert_eq!(single.launch_modes(openjk), [LaunchMode::Single]);
        // The same record on an engine without that mode reads as the engine.
        assert_eq!(single.launch_modes(eternaljk), [LaunchMode::Multiplayer]);

        // The Clients screen writes every mode of the engine into the record.
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");
        let made = create_record(&paths, "Everyday", "openjk", Game::JediAcademy, None).expect("a client");
        assert_eq!(made.modes, [LaunchMode::Multiplayer, LaunchMode::Single]);
        let text = fs::read_to_string(paths.client_dir(&made.id).join("client.json")).unwrap();
        assert!(text.contains("\"modes\": [
    \"multiplayer\",
    \"single\"
  ]"), "{text}");
        // A component hands its own list, cut down to what the engine has.
        let sp = create_record(&paths, "SP", "openjk", Game::JediAcademy, Some(&[LaunchMode::Single]))
            .expect("a single-player client");
        assert_eq!(sp.modes, [LaunchMode::Single]);
        let error = create_record(&paths, "Odd", "eternaljk", Game::JediAcademy, Some(&[LaunchMode::Single]))
            .expect_err("EternalJK has no single-player game");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        assert!(!paths.client_dir("odd").exists(), "nothing was made for a refused client");
    }

    #[test]
    fn a_client_under_an_install_or_a_bundle_operation_is_not_deleted() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");
        let client = create_record(&paths, "Voip", "openjk", Game::JediAcademy, None).expect("a client");
        let dir = paths.client_dir(&client.id);
        let lock = StepLock::default();
        let installs = InstallState::default();
        let bundles = BundlesState::default();

        // An engine install holds the client.
        let engine = installs.claim(&client.id).expect("the install claims it");
        let error = remove_client(&lock, &installs, &bundles, &paths, &client.id)
            .expect_err("refused while the engine installs");
        assert!(matches!(error, AppError::Busy(_)), "{error}");
        assert!(dir.is_dir(), "the folder survives the refusal");
        drop(engine);

        // A bundle install holds the client.
        let bundle = bundles
            .claim(&client.id, BundlesState::INSTALL)
            .expect("the bundle install claims it");
        let error = remove_client(&lock, &installs, &bundles, &paths, &client.id)
            .expect_err("refused while the bundle installs");
        assert!(matches!(error, AppError::Busy(_)), "{error}");
        assert!(error.to_string().contains("bundle"), "{error}");
        assert!(dir.is_dir());
        drop(bundle);

        // Nobody holds it: the folder goes, and both sets are free again.
        remove_client(&lock, &installs, &bundles, &paths, &client.id).expect("deleted");
        assert!(!dir.exists());
        installs.claim(&client.id).expect("the deletion released its claim");
        bundles
            .claim(&client.id, BundlesState::INSTALL)
            .expect("the deletion released its claim");
        let error = remove_client(&lock, &installs, &bundles, &paths, "ghost")
            .expect_err("an unknown client");
        assert!(matches!(error, AppError::NotFound(_)), "{error}");
    }

    #[test]
    fn a_game_written_into_the_record_reads_back() {
        let record: Client = serde_json::from_str(
            r#"{"id":"duel","name":"Duel","engineId":"jk2mv","game":"jo",
                "engineVersion":null,"createdAt":"2026-09-10T00:00:00Z"}"#,
        )
        .expect("a record parses");
        assert_eq!(record.game, Game::JediOutcast);

        let json = serde_json::to_string(&record).expect("it serializes");
        assert!(json.contains("\"game\":\"jo\""), "{json}");
    }

    /// A client folder with the layout of an installed Jedi Outcast client.
    fn client_layout(root: &Path) -> std::path::PathBuf {
        let dir = root.join("jk2");
        fs::create_dir_all(dir.join(paths::CLIENT_ENGINE_DIR)).expect("the engine folder");
        fs::create_dir_all(dir.join(paths::CLIENT_HOME_DIR).join(paths::BASE_FOLDER))
            .expect("the home folder");
        fs::create_dir_all(dir.join(paths::CLIENT_BASEPATH_DIR)).expect("the base root");
        dir
    }

    #[cfg(windows)]
    #[test]
    fn deleting_a_client_unlinks_the_game_folder_instead_of_emptying_it() {
        // The one operation in the launcher that could cost a player their
        // copy of the game. `basepath\base` is a junction into it; the removal
        // has to take the link and leave the folder.
        let game = tempfile::tempdir().expect("a game root");
        let game_base = game.path().join("GameData").join("base");
        fs::create_dir_all(&game_base).expect("the game base folder");
        fs::write(game_base.join("assets0.pk3"), b"the player's own copy").expect("an archive");

        let clients = tempfile::tempdir().expect("a clients root");
        let dir = client_layout(clients.path());
        let link = dir.join(paths::CLIENT_BASEPATH_DIR).join(paths::BASE_FOLDER);
        junction::create(&game_base, &link).expect("the junction");
        assert!(link.join("assets0.pk3").is_file(), "the link works");

        remove_client_dir(&dir).expect("the client is deleted");

        assert!(!dir.exists(), "the client folder is gone");
        assert!(
            game_base.join("assets0.pk3").is_file(),
            "the game folder must survive its client"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_recursive_removal_stops_at_a_junction() {
        // The assumption the whole layout rests on, pinned rather than
        // believed: `fs::remove_dir_all` deletes a link and does not walk
        // through it. `remove_client_dir` unlinks first anyway — this is what
        // makes that a second lock rather than the only one.
        let game = tempfile::tempdir().expect("a game root");
        let game_base = game.path().join("base");
        fs::create_dir_all(&game_base).expect("the game base folder");
        fs::write(game_base.join("assets0.pk3"), b"the player's own copy").expect("an archive");

        let client = tempfile::tempdir().expect("a client root");
        let dir = client.path().join("jk2");
        fs::create_dir_all(dir.join(paths::CLIENT_BASEPATH_DIR)).expect("the base root");
        junction::create(
            &game_base,
            dir.join(paths::CLIENT_BASEPATH_DIR).join(paths::BASE_FOLDER),
        )
        .expect("the junction");

        fs::remove_dir_all(&dir).expect("the removal");
        assert!(!dir.exists());
        assert!(game_base.join("assets0.pk3").is_file());
    }

    #[test]
    fn deleting_a_client_takes_the_folders_that_really_are_its_own() {
        // The mirror image of the test above: a real folder where the link
        // usually is belongs to the client and goes with it. That is the
        // fallback copy of `launch::prepare_basepath`, among other things.
        let clients = tempfile::tempdir().expect("a clients root");
        let dir = client_layout(clients.path());
        let copies = dir.join(paths::CLIENT_BASEPATH_DIR).join(paths::BASE_FOLDER);
        fs::create_dir_all(&copies).expect("the copied base folder");
        fs::write(copies.join("assets0.pk3"), b"a copy JKNet made").expect("a copy");

        remove_client_dir(&dir).expect("the client is deleted");
        assert!(!dir.exists());
    }

    // --- slice: client window ---

    #[test]
    fn two_windows_saving_one_client_keep_both_changes() {
        // The record the player edits has two windows over it, and Tauri runs
        // the commands of both on a pool of threads. Each save carries a whole
        // record, so the one that writes second decides what every field holds
        // — unless the read and the write are one step, which is the lock.
        //
        // Measured: with the `lock.enter()` of `edit_record` taken out, this
        // test fails inside the first rounds — either a read lands on a file
        // the other thread is halfway through writing, or a write puts back
        // the field that thread had just changed.
        const ROUNDS: usize = 100;

        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");
        let client = Client {
            id: "duel".to_string(),
            name: "Duel".to_string(),
            engine_id: "openjk".to_string(),
            game: Game::JediAcademy,
            engine_version: None,
            created_at: timestamp::now_rfc3339(),
            engine_installed_at: None,
            engine_published_at: None,
            fs_game: None,
            launch_args: String::new(),
            modes: Vec::new(),
            bundle: None,
        };
        write_record(&paths, &client).expect("the record");

        let lock = StepLock::default();
        std::thread::scope(|scope| {
            // The client window, through the cvar path of `write_launch_cvar`:
            // every round rewrites the line the record carries right now.
            scope.spawn(|| {
                for round in 0..ROUNDS {
                    let value = round.to_string();
                    edit_record(&lock, &paths, &client.id, |record| {
                        let line = crate::launch_tokens::write_cvar(
                            &record.launch_args,
                            "r_mode",
                            Some(&value),
                        );
                        record.launch_args = line;
                    })
                    .expect("the cvar save");
                }
            });
            // The card in the main window, through the `update_client` path.
            scope.spawn(|| {
                for round in 0..ROUNDS {
                    let folder = format!("mod{round}");
                    edit_record(&lock, &paths, &client.id, |record| {
                        record.fs_game = Some(folder);
                    })
                    .expect("the mod folder save");
                }
            });
        });

        let saved = read_record(&paths, &client.id).expect("the record is readable");
        assert_eq!(
            crate::launch_tokens::read_cvar(&saved.launch_args, "r_mode"),
            Some((ROUNDS - 1).to_string()),
            "the last cvar the window wrote is in the record: {:?}",
            saved.launch_args
        );
        assert_eq!(
            saved.fs_game,
            Some(format!("mod{}", ROUNDS - 1)),
            "the last mod folder the card wrote is in the record"
        );
    }

    #[test]
    fn a_mod_folder_cannot_leave_the_client() {
        for value in [
            "..",
            ".",
            "base/../evil",
            "base\\evil",
            "C:\\Windows",
            "my mod",
            "мод",
            "base.pk3",
            "*",
        ] {
            assert!(
                validate_fs_game(value).is_err(),
                "{value} should be refused"
            );
        }
        assert!(validate_fs_game(&"x".repeat(MAX_FS_GAME_LEN + 1)).is_err());
    }

    // --- slice: clients page ---

    #[test]
    fn the_folder_of_a_client_is_read_out_and_never_made() {
        // What **Open folder** hands to the `opener` plugin. Three things are
        // asked of it: the path is the one the layout owns, it stays inside
        // the data folder wherever `dataDirOverride` put that, and an id that
        // names nothing is refused instead of pointing somewhere.
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");
        let client = Client {
            id: "duel".to_string(),
            name: "Duel".to_string(),
            engine_id: "openjk".to_string(),
            game: Game::JediAcademy,
            engine_version: None,
            created_at: timestamp::now_rfc3339(),
            engine_installed_at: None,
            engine_published_at: None,
            fs_game: None,
            launch_args: String::new(),
            modes: Vec::new(),
            bundle: None,
        };
        write_record(&paths, &client).expect("the record");

        let answer = folder_of(&paths, &client.id).expect("the folder of a client");
        assert_eq!(Path::new(&answer), paths.client_dir(&client.id));
        assert!(
            Path::new(&answer).starts_with(&paths.root),
            "the answer stays inside the data folder: {answer}"
        );

        let error = folder_of(&paths, "ghost").expect_err("an unknown client is refused");
        assert!(matches!(error, AppError::NotFound(_)), "{error}");

        // Neither call creates anything: the folder of the one client that
        // was written is all there is under `clients\`.
        let mut made: Vec<String> = fs::read_dir(&paths.clients)
            .expect("the clients folder")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        made.sort();
        assert_eq!(made, vec![client.id.clone()]);
        assert!(
            !paths.client_engine_dir(&client.id).exists(),
            "a path is an answer, not an installed client"
        );
    }
}
