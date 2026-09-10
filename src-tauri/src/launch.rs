//! Starting a client.
//!
//! Planned shape: build the command line for the client's engine
//! (`+set fs_homepath <client>\home`, `+set fs_basepath <GameData>`, and
//! `+connect <address>` when the player joins from the server browser), start
//! the process detached from the launcher, and hide the window when
//! `closeOnLaunch` is set.
//!
//! Steam is never in the chain: the launcher starts the engine executable
//! itself and only reads the game's asset archives.
//!
//! The skeleton refuses to launch, so the Play button can be wired up and
//! disabled honestly.

use crate::error::{AppError, Result};

/// Starts the client, optionally connecting straight to a server.
#[tauri::command]
pub fn launch_client(client_id: String, address: Option<String>) -> Result<()> {
    let target = address.unwrap_or_else(|| "the main menu".to_string());
    log::info!("launch requested for client {client_id} to {target}");
    Err(AppError::NotImplemented("launching a client"))
}
