//! The pk3 library.
//!
//! Planned shape: one shared store in `library\` with the downloaded archives,
//! and per-client installation that puts a file into
//! `clients\<slug>\home\base\`. The same file can be installed into several
//! clients, and the toggle on a library card enables or disables it for the
//! selected client only.
//!
//! Sources are JKHub downloads and files the player drops in by hand.
//!
//! The skeleton returns an empty library so the Library screen can render its
//! empty state.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// What kind of content a pk3 holds. The player filters by this on the
/// Library screen.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryCategory {
    Skin,
    Saber,
    Map,
    Mod,
    Other,
}

/// One file in the library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    /// Stable id: the hash of the archive.
    pub id: String,
    /// Name shown on the card.
    pub title: String,
    /// File name inside `library\`.
    pub file_name: String,
    pub category: LibraryCategory,
    pub size: u64,
    /// Author as JKHub reports it, `None` for a file added by hand.
    pub author: Option<String>,
    /// Ids of the clients this file is installed into.
    pub installed_in: Vec<String>,
}

/// Lists the library, marking which clients each file is installed into.
///
/// Not implemented: the skeleton always answers with an empty list.
#[tauri::command]
pub fn list_library_files() -> Result<Vec<LibraryFile>> {
    Ok(Vec::new())
}

/// Installs a library file into a client.
#[tauri::command]
pub fn install_library_file(file_id: String, client_id: String) -> Result<()> {
    log::info!("install requested: file {file_id} into client {client_id}");
    Err(AppError::NotImplemented("library installs"))
}

/// Removes a library file from a client, keeping it in the shared store.
#[tauri::command]
pub fn remove_library_file(file_id: String, client_id: String) -> Result<()> {
    log::info!("removal requested: file {file_id} from client {client_id}");
    Err(AppError::NotImplemented("library installs"))
}
