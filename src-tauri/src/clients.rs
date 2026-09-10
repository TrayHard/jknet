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
//! ```
//!
//! The slug is derived from the first name and never changes afterwards, so a
//! rename cannot break a path that something else already stored.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::engines;
use crate::error::{AppError, Result};
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
#[tauri::command]
pub fn create_client(
    state: tauri::State<'_, AppState>,
    name: String,
    engine_id: String,
) -> Result<Client> {
    let name = validate_name(&name)?;
    if engines::find(&engine_id).is_none() {
        return Err(AppError::InvalidInput(format!("unknown engine {engine_id}")));
    }

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
        engine_version: None,
        created_at: timestamp::now_rfc3339(),
        engine_installed_at: None,
        engine_published_at: None,
        fs_game: None,
    };
    write_record(&paths, &client)?;
    log::info!("created client {} on engine {}", client.id, client.engine_id);
    Ok(client)
}

/// Changes the parts of a client the player may edit: its name and its mod
/// folder.
///
/// A field left out of the call keeps its value. The folder on disk keeps its
/// slug even when the name changes: a path that another part of the launcher
/// stored must stay valid. An `fs_game` that is blank clears the field, which
/// puts the client back on the default folder of its engine.
#[tauri::command]
pub fn update_client(
    state: tauri::State<'_, AppState>,
    client_id: String,
    name: Option<String>,
    fs_game: Option<String>,
) -> Result<Client> {
    let paths = state.paths()?;
    let mut client = read_record(&paths, &client_id)?;
    if let Some(name) = name {
        client.name = validate_name(&name)?;
    }
    if let Some(fs_game) = fs_game {
        client.fs_game = validate_fs_game(&fs_game)?;
    }
    write_record(&paths, &client)?;
    log::info!(
        "updated client {}: name {:?}, fs_game {:?}",
        client.id,
        client.name,
        client.fs_game
    );
    Ok(client)
}

/// Deletes a client with its engine files and its home folder.
///
/// The folder is removed, not moved to the recycle bin: an engine install is
/// tens of megabytes of files the launcher can download again.
#[tauri::command]
pub fn delete_client(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    let paths = state.paths()?;
    let dir = paths.client_dir(&id);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("client {id}")));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io_path("cannot delete", &dir, e))?;
    log::info!("deleted client {id}");

    // A deleted client must not stay the default one. The document comes from
    // disk, so this write carries over whatever else changed there.
    let mut settings = Settings::current(&state)?;
    if settings.default_client_id.as_deref() == Some(id.as_str()) {
        settings.default_client_id = None;
        settings.save(&state)?;
        state.set_settings(settings)?;
    }
    Ok(())
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
