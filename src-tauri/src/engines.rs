//! The engine registry.
//!
//! An engine is a community build of the Jedi Academy multiplayer client. A
//! **client** is a named instance of one engine with its own files and
//! settings, so the same engine backs any number of clients.
//!
//! The registry is static on purpose: four builds, each with a GitHub releases
//! page. Downloading and version checks come later; this module only tells the
//! UI what exists.

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// One engine JKNet can install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    /// Stable key stored in `client.json`. Never shown to the player.
    pub id: &'static str,
    /// Name shown on the engine tile.
    pub name: &'static str,
    /// One sentence for the tile, in the interface language (English).
    pub description: &'static str,
    /// Executable inside the client's `engine\` folder.
    pub executable: &'static str,
    /// `owner/name` of the GitHub repository that publishes the releases.
    pub repo: &'static str,
    /// The build offered to a player who has no preference.
    pub recommended: bool,
}

/// Every engine, in the order the Clients screen shows them.
///
/// The `executable` of TaystJK and jaMME is **unverified**: it was written
/// from the naming pattern of the other two builds, not from a downloaded
/// release. Confirm both names against a real release archive before the
/// installer task starts a client by file name.
const ENGINES: &[Engine] = &[
    Engine {
        id: "openjk",
        name: "OpenJK",
        description: "The community reference build. Stable, closest to the original game.",
        executable: "openjk.x86.exe",
        repo: "JACoders/OpenJK",
        recommended: true,
    },
    Engine {
        id: "eternaljk",
        name: "EternalJK",
        description: "OpenJK with the modern multiplayer patches most servers expect.",
        executable: "eternaljk.x86.exe",
        repo: "eternalcodes/EternalJK",
        recommended: false,
    },
    Engine {
        id: "taystjk",
        name: "TaystJK",
        description: "Fork focused on competitive play and quality of life fixes.",
        // unverified
        executable: "taystjk.x86.exe",
        repo: "taysta/TaystJK",
        recommended: false,
    },
    Engine {
        id: "jamme",
        name: "jaMME",
        description: "Movie maker edition: demo playback, camera work and capture.",
        // unverified
        executable: "jamme.x86.exe",
        repo: "entdark/jaMME",
        recommended: false,
    },
];

/// Returns the engine with this id.
pub fn find(id: &str) -> Option<&'static Engine> {
    ENGINES.iter().find(|engine| engine.id == id)
}

/// Lists every engine the launcher knows.
#[tauri::command]
pub fn list_engines() -> Result<Vec<Engine>> {
    Ok(ENGINES.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<&str> = ENGINES.iter().map(|engine| engine.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }

    #[test]
    fn exactly_one_engine_is_recommended() {
        let recommended: Vec<&str> = ENGINES
            .iter()
            .filter(|engine| engine.recommended)
            .map(|engine| engine.id)
            .collect();
        assert_eq!(recommended, vec!["openjk"]);
    }

    #[test]
    fn lookup_finds_a_known_engine_and_rejects_the_rest() {
        assert!(find("eternaljk").is_some());
        assert!(find("quake3").is_none());
    }
}
