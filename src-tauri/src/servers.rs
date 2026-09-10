//! Server browser.
//!
//! Planned shape: ask the Quake 3 master servers used by the Jedi Academy
//! community for the address list (`getservers`), then send `getinfo` to every
//! address over UDP and collect the replies. Trusted community servers get a
//! mark of their own, and the results are cached in `cache\`.
//!
//! The skeleton returns an empty list so the Servers screen can render its
//! empty state. Nothing here touches the network yet.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// One server row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    /// `address:port`, the key of the row.
    pub address: String,
    /// Host name with the game's color codes already stripped.
    pub name: String,
    pub map: String,
    /// Game type as the mod reports it, for example `FFA` or `Duel`.
    pub mode: String,
    /// Mod folder the server runs, for example `base` or `japlus`.
    pub game_mod: String,
    pub players: u32,
    pub max_players: u32,
    /// Round trip time in milliseconds, `None` while the server has not
    /// answered yet.
    pub ping: Option<u32>,
    pub password_protected: bool,
    /// Marked as a trusted community server by the launcher.
    pub trusted: bool,
}

/// Returns the cached server list.
///
/// Not implemented: the skeleton always answers with an empty list.
#[tauri::command]
pub fn list_servers() -> Result<Vec<Server>> {
    Ok(Vec::new())
}

/// Queries the master servers and refreshes the cache.
#[tauri::command]
pub fn refresh_servers() -> Result<Vec<Server>> {
    Err(AppError::NotImplemented("server browser"))
}
