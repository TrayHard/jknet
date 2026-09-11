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

use crate::engines;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::paths::{self, DataPaths};
use crate::settings::Settings;
use crate::state::AppState;
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
    let name = validate_name(&name)?;
    engines::require_for_game(&engine_id, game)?;

    let paths = state.paths()?;
    paths.ensure()?;
    let taken = read_all(&paths)?
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
        engine_id,
        game,
        engine_version: None,
        created_at: timestamp::now_rfc3339(),
        engine_installed_at: None,
        engine_published_at: None,
        fs_game: None,
        launch_args: String::new(),
    };
    write_record(&paths, &client)?;
    log::info!(
        "created client {} on engine {} for {}",
        client.id,
        client.engine_id,
        client.game.display_name()
    );
    emit_changed(&app, &client.id);
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
    let paths = state.paths()?;
    let mut client = read_record(&paths, &client_id)?;
    if let Some(name) = name {
        client.name = validate_name(&name)?;
    }
    if let Some(fs_game) = fs_game {
        client.fs_game = validate_fs_game(&fs_game)?;
    }
    if let Some(launch_args) = launch_args {
        client.launch_args = launch_args.trim().to_string();
    }
    write_record(&paths, &client)?;
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

/// Replaces the launch arguments of a client and saves the record.
///
/// The `launch_args` half of [`update_client`], reachable from
/// [`crate::launch_tokens`]: a control in the client window edits one cvar
/// inside the line and the whole line comes back here, so there is one writer
/// of `client.json` and one place that announces the change.
pub(crate) fn set_launch_args(
    app: &AppHandle,
    state: &AppState,
    client_id: &str,
    launch_args: &str,
) -> Result<Client> {
    let paths = state.paths()?;
    let mut client = read_record(&paths, client_id)?;
    client.launch_args = launch_args.trim().to_string();
    write_record(&paths, &client)?;
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
#[tauri::command]
pub fn delete_client(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<()> {
    let paths = state.paths()?;
    let dir = paths.client_dir(&id);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("client {id}")));
    }
    remove_client_dir(&dir)?;
    log::info!("deleted client {id}");
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
        state.set_settings(settings)?;
    }
    Ok(())
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
fn read_all(paths: &DataPaths) -> Result<Vec<Client>> {
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
fn validate_fs_game(value: &str) -> Result<Option<String>> {
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
}
