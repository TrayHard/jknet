//! The `game` dimension: Jedi Academy and Jedi Outcast.
//!
//! JKNet started as a Jedi Academy launcher and now serves two games. The
//! entity model is unchanged — engine, client, library file — and `game` is an
//! attribute of an engine, a client and a server row rather than a fourth
//! entity. Nothing about a game is hardcoded anywhere else: every constant that
//! differs between the two lives in the [`GameSpec`] table below, and the rest
//! of the core reads it from there.
//!
//! ## Where the facts come from
//!
//! Jedi Academy: OpenJK sources at `D:\Dev\Personal\jedi academy\OpenJK`,
//! branch `master` @ `1a6a6434` — the same references the server browser and
//! the launch module already cite.
//!
//! Jedi Outcast, read on 2026-09-10 from the JK2 fact sheets of the research
//! pass (`jk2-facts-protocol.md`, `jk2-facts-files-and-jkhub.md`,
//! `jk2-facts-jk2mv.md`), which in turn quote `mvdevs/jk2mv` and the Raven 1.04
//! SDK:
//!
//! | Fact | Source |
//! | --- | --- |
//! | `PORT_MASTER 28060`, `PORT_SERVER 28070` | `qcommon.h` of JK2MV and of the 1.04 SDK |
//! | Masters `master.jk2mv.org` and `master.jkhub.org` | `sv_init.cpp` of JK2MV, `sv_master2` and `sv_master3` |
//! | Protocol 15 is 1.02 and 1.03, protocol 16 is 1.04 | `PROTOCOL_VERSION` per version tree |
//! | `gametype_t`: FFA, Holocron, Jedi Master, Duel, Single Player, Team FFA, Saga, CTF, CTY | `bg_public.h`, identical in the SDK and in JK2MV |
//! | Steam app 6030, folder `Jedi Outcast`, data in `GameData\base` | Steam store page |
//! | pk3 set: 1.02 ships `assets0` and `assets1`, 1.03 adds `assets2`, 1.04 adds `assets5` | JKHub patch pages |
//! | GOG product `1428935917`, DRM free, ships 1.04 | gogdb.org |
//!
//! Raven's own JK2 master `masterjk2.ravensoft.com` is left out: it has been
//! dead for years, and the Jedi Academy list already pays 1.5 s per refresh for
//! the equivalent `masterjk3.ravensoft.com` that is kept only because a stock
//! client asks it.

use serde::{Deserialize, Serialize};

/// One of the two games JKNet launches.
///
/// `Default` is Jedi Academy: it is the game the launcher shipped with, and
/// every record written before this module existed is one of its own.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Game {
    #[default]
    #[serde(rename = "ja")]
    JediAcademy,
    #[serde(rename = "jo")]
    JediOutcast,
}

impl Game {
    /// Both games, in the order the interface lists them.
    pub const ALL: [Game; 2] = [Game::JediAcademy, Game::JediOutcast];

    /// The wire id: `ja` or `jo`. The same string serde writes.
    pub fn id(self) -> &'static str {
        self.spec().id
    }

    /// Full title, as it appears on a card: «Jedi Academy».
    pub fn display_name(self) -> &'static str {
        self.spec().display_name
    }

    /// Two letters for a badge: `JA`, `JO`.
    pub fn short_name(self) -> &'static str {
        self.spec().short_name
    }

    /// Everything that differs between the two games.
    pub fn spec(self) -> &'static GameSpec {
        match self {
            Game::JediAcademy => &JEDI_ACADEMY,
            Game::JediOutcast => &JEDI_OUTCAST,
        }
    }

    /// Reads a wire id back. Unknown text yields `None` rather than a default:
    /// a typo in an id has to fail where it was made.
    pub fn from_id(id: &str) -> Option<Game> {
        Game::ALL
            .into_iter()
            .find(|game| game.id().eq_ignore_ascii_case(id.trim()))
    }
}

impl std::fmt::Display for Game {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id())
    }
}

/// One asset archive a game install may hold.
#[derive(Debug, Clone, Copy)]
pub struct AssetSpec {
    /// File name inside `<GameData>\base`.
    pub name: &'static str,
    /// False for an archive a patch adds, so its absence is not a broken copy.
    pub required: bool,
}

/// A patch level recognised by the archives it adds.
#[derive(Debug, Clone, Copy)]
pub struct VersionSpec {
    /// Label shown to the player: `1.04`.
    pub label: &'static str,
    /// The archive that proves this patch is installed. The rules are checked
    /// from the last entry backwards, so the newest match wins.
    pub marker: &'static str,
}

/// Every constant that differs between Jedi Academy and Jedi Outcast.
///
/// Read through [`Game::spec`]. Adding a third game means adding a table entry,
/// not a `match` in ten modules.
#[derive(Debug, Clone, Copy)]
pub struct GameSpec {
    pub game: Game,
    pub id: &'static str,
    pub display_name: &'static str,
    pub short_name: &'static str,

    // --- game files ---
    /// The archives of `<GameData>\base`, required ones and patch ones.
    pub assets: &'static [AssetSpec],
    /// Patch levels, oldest first. Empty when the launcher does not tell them
    /// apart, which is the case for Jedi Academy: 1.01 is the only build the
    /// community plays and its four archives are all mandatory.
    pub versions: &'static [VersionSpec],
    /// The patch a player wants. `None` when every install is equally good.
    pub wanted_version: Option<&'static str>,
    /// Steam application id. Recorded for the docs and a support answer; the
    /// scan matches folder names, because a Steam library can be moved but its
    /// folder keeps the name.
    pub steam_app_id: u32,
    /// Lowercase substrings that identify the install folder of this game,
    /// under `steamapps\common\`, under `C:\GOG Games\` and in a GOG
    /// `gameName`. Must not match the other game.
    pub install_dir_hints: &'static [&'static str],
    /// GOG product id, and the uninstall key it registers under. `None` where
    /// JKNet has not read the id off gogdb: the GOG scan matches `gameName`
    /// and the folders under `C:\GOG Games` either way, and a guessed id in a
    /// registry lookup would silently find nothing.
    pub gog_product_id: Option<&'static str>,
    pub gog_uninstall_key: Option<&'static str>,

    // --- server browser ---
    /// Master servers, each `host` or `host:port`.
    pub masters: &'static [&'static str],
    /// Protocol numbers a `getservers` has to ask for. More than one means the
    /// answers are merged and deduplicated by address.
    pub master_protocols: &'static [u16],
    /// Port used when a player types an address without one, `PORT_SERVER`.
    pub server_port: u16,
    /// The cache document inside `cache\`.
    pub server_cache_file: &'static str,
    /// `gametype_t` in the order of the game's own `bg_public.h`.
    pub gametypes: &'static [&'static str],

    // --- launch ---
    /// Cvar naming the read-only root that holds the player's retail install:
    /// the folder that *contains* `base`, the `GameData` equivalent.
    ///
    /// Only the name differs between the games; the role is the same, which is
    /// what lets both of them share one launch layout — see [`crate::launch`].
    /// Jedi Academy engines inherit `fs_cdpath` from Quake 3. JK2MV dropped it
    /// (`files.cpp` mentions a cd path only inside a Quake 3 comment) and put
    /// its own cvar in that place, `mvdevs/jk2mv`, `src/qcommon/files.cpp`:
    ///
    /// ```text
    /// fs_assetspath = Cvar_Get("fs_assetspath", Sys_DefaultAssetsPath() or "", CVAR_INIT | CVAR_VM_NOWRITE)
    /// FS_AddAssetsDirectoryJK2(fs_assetspath->string, BASEGAME)
    /// ```
    ///
    /// `FS_Startup` adds that assets directory first — and only when
    /// `assets5.pk3` was not already found in `base` under basepath or
    /// homepath — then `FS_AddGameDirectory(fs_basepath, game)`, then homepath,
    /// then `fs_basegame`, `fs_game` and `fs_forcegame`. `CVAR_INIT` means the
    /// command line is the only way to set it, which is what JKNet does.
    pub game_data_cvar: &'static str,
}

/// Jedi Academy: the game JKNet was built for.
static JEDI_ACADEMY: GameSpec = GameSpec {
    game: Game::JediAcademy,
    id: "ja",
    display_name: "Jedi Academy",
    short_name: "JA",

    assets: &[
        AssetSpec { name: "assets0.pk3", required: true },
        AssetSpec { name: "assets1.pk3", required: true },
        AssetSpec { name: "assets2.pk3", required: true },
        AssetSpec { name: "assets3.pk3", required: true },
    ],
    versions: &[],
    wanted_version: None,
    steam_app_id: 6020,
    install_dir_hints: &["jedi academy"],
    // Not read off gogdb, so not written down: the GOG scan finds this game by
    // `gameName` and by the folders under `C:\GOG Games`, as it always has.
    gog_product_id: None,
    gog_uninstall_key: None,

    masters: &["masterjk3.ravensoft.com", "master.jkhub.org"],
    master_protocols: &[26],
    server_port: 29070,
    server_cache_file: "servers-ja.json",
    gametypes: &[
        "FFA",
        "Holocron",
        "Jedi Master",
        "Duel",
        "Power Duel",
        "Single Player",
        "Team FFA",
        "Siege",
        "CTF",
        "CTY",
    ],

    game_data_cvar: "fs_cdpath",
};

/// Jedi Outcast, played through JK2MV.
///
/// The retail 1.02 ships two archives; patch 1.03 adds `assets2.pk3` and patch
/// 1.04 adds `assets5.pk3`. Steam and GOG both ship 1.04 already. Only
/// `assets0` and `assets1` are demanded, because JK2MV runs all three versions
/// — but a copy without `assets5.pk3` cannot join the 1.04 servers that make up
/// most of the list, so [`crate::game_files`] says so in the candidate.
static JEDI_OUTCAST: GameSpec = GameSpec {
    game: Game::JediOutcast,
    id: "jo",
    display_name: "Jedi Outcast",
    short_name: "JO",

    assets: &[
        AssetSpec { name: "assets0.pk3", required: true },
        AssetSpec { name: "assets1.pk3", required: true },
        AssetSpec { name: "assets2.pk3", required: false },
        AssetSpec { name: "assets5.pk3", required: false },
    ],
    versions: &[
        VersionSpec { label: "1.03", marker: "assets2.pk3" },
        VersionSpec { label: "1.04", marker: "assets5.pk3" },
    ],
    wanted_version: Some("1.04"),
    steam_app_id: 6030,
    install_dir_hints: &["jedi outcast"],
    gog_product_id: Some("1428935917"),
    gog_uninstall_key: Some(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\1428935917_is1",
    ),

    // Raven's `masterjk2.ravensoft.com` is deliberately absent: it is dead, and
    // a dead master costs a refresh its whole timeout budget.
    masters: &["master.jkhub.org:28060", "master.jk2mv.org:28060"],
    // 15 is 1.02 and 1.03, 16 is 1.04. A server answers the list of one
    // protocol only, so both have to be asked and the answers merged.
    master_protocols: &[15, 16],
    server_port: 28070,
    server_cache_file: "servers-jo.json",
    // `GT_TOURNAMENT` is what Jedi Outcast calls a duel, there is no power duel
    // and no siege, and `GT_SAGA` sits where Jedi Academy has Team FFA + 1.
    // The Jedi Academy table cannot be reused for any index above 2.
    gametypes: &[
        "FFA",
        "Holocron",
        "Jedi Master",
        "Duel",
        "Single Player",
        "Team FFA",
        "Saga",
        "CTF",
        "CTY",
    ],

    game_data_cvar: "fs_assetspath",
};

impl GameSpec {
    /// Names of the archives a copy of this game must have.
    pub fn required_assets(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.assets
            .iter()
            .filter(|asset| asset.required)
            .map(|asset| asset.name)
    }

    /// The patch level a set of present archive names proves.
    ///
    /// The rules run newest first, so an install with both `assets2.pk3` and
    /// `assets5.pk3` reads as 1.04 and not as 1.03. A game with no version
    /// rules answers `None`, which is the honest answer for Jedi Academy: the
    /// launcher cannot tell 1.00 from 1.01 by the file list.
    pub fn detect_version(&self, present: &[&str]) -> Option<&'static str> {
        let newest = self
            .versions
            .iter()
            .rev()
            .find(|version| present.contains(&version.marker));
        match newest {
            Some(version) => Some(version.label),
            // Every rule missed, but the base archives are there: this is the
            // release the patch rules build on, the one that came before the
            // first label — for Jedi Outcast, retail 1.02.
            None if !self.versions.is_empty() => Some(self.base_version()),
            None => None,
        }
    }

    /// Label of the release before the first patch rule, for [`Self::detect_version`].
    fn base_version(&self) -> &'static str {
        match self.game {
            Game::JediOutcast => "1.02",
            Game::JediAcademy => "1.01",
        }
    }

    /// Turns a `gametype` number into the label the browser shows.
    ///
    /// Mods invent numbers above the enum, so an unknown value keeps its digits
    /// instead of pretending to be FFA.
    pub fn gametype_label(&self, gametype: u8) -> String {
        self.gametypes
            .get(gametype as usize)
            .map(|label| (*label).to_string())
            .unwrap_or_else(|| format!("Mode {gametype}"))
    }
}

/// One game as the interface needs to know it.
///
/// The names live here rather than in `src/lib/ipc.ts` so that «Jedi Outcast»
/// is spelled in one place: a badge, a settings row and a log line that
/// disagree about a game's name is the kind of drift a table prevents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub id: Game,
    /// «Jedi Academy», for a heading or a settings row.
    pub display_name: &'static str,
    /// `JA`, for a badge.
    pub short_name: &'static str,
    /// The archives `<GameData>\base` must hold, for the sentence that tells a
    /// player what to look for.
    pub required_assets: Vec<&'static str>,
    /// The patch the servers run, `null` when every install is equally good.
    pub wanted_version: Option<&'static str>,
    /// Steam application id, for a support answer.
    pub steam_app_id: u32,
    /// Port a server of this game listens on by default.
    pub server_port: u16,
}

/// Lists both games with the names and constants the interface prints.
///
/// Static, so the frontend asks once and never again.
#[tauri::command]
pub fn list_games() -> Vec<GameInfo> {
    Game::ALL
        .into_iter()
        .map(|game| {
            let spec = game.spec();
            GameInfo {
                id: game,
                display_name: game.display_name(),
                short_name: game.short_name(),
                required_assets: spec.required_assets().collect(),
                wanted_version: spec.wanted_version,
                steam_app_id: spec.steam_app_id,
                server_port: spec.server_port,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_ids_are_ja_and_jo() {
        assert_eq!(serde_json::to_string(&Game::JediAcademy).unwrap(), "\"ja\"");
        assert_eq!(serde_json::to_string(&Game::JediOutcast).unwrap(), "\"jo\"");
        assert_eq!(
            serde_json::from_str::<Game>("\"jo\"").unwrap(),
            Game::JediOutcast
        );
        assert!(serde_json::from_str::<Game>("\"jk3\"").is_err());
    }

    #[test]
    fn jedi_academy_is_the_default() {
        // Every record written before this module existed is a Jedi Academy
        // one, and `serde(default)` is what turns it into one.
        assert_eq!(Game::default(), Game::JediAcademy);
    }

    #[test]
    fn a_spec_agrees_with_the_game_it_describes() {
        for game in Game::ALL {
            let spec = game.spec();
            assert_eq!(spec.game, game);
            assert_eq!(spec.id, game.id());
            assert_eq!(spec.display_name, game.display_name());
            assert_eq!(spec.short_name, game.short_name());
            assert_eq!(Game::from_id(spec.id), Some(game));
        }
        assert_eq!(Game::from_id("JO"), Some(Game::JediOutcast));
        assert_eq!(Game::from_id("quake"), None);
    }

    #[test]
    fn the_two_games_never_answer_to_the_same_folder_hint() {
        // A scan of `steamapps\common\` matches on these, and a hint that fits
        // both would file one game's install under the other.
        for hint in Game::JediAcademy.spec().install_dir_hints {
            assert!(!Game::JediOutcast.spec().install_dir_hints.contains(hint));
        }
        assert!(!"star wars jedi knight ii - jedi outcast".contains("jedi academy"));
        assert!(!"star wars jedi knight jedi academy".contains("jedi outcast"));
    }

    #[test]
    fn jedi_academy_demands_four_archives_and_jedi_outcast_two() {
        let ja: Vec<&str> = Game::JediAcademy.spec().required_assets().collect();
        assert_eq!(ja, ["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3"]);

        let jo: Vec<&str> = Game::JediOutcast.spec().required_assets().collect();
        assert_eq!(jo, ["assets0.pk3", "assets1.pk3"]);
    }

    #[test]
    fn the_jedi_outcast_version_follows_the_archives_a_patch_adds() {
        let spec = Game::JediOutcast.spec();
        assert_eq!(spec.detect_version(&["assets0.pk3", "assets1.pk3"]), Some("1.02"));
        assert_eq!(
            spec.detect_version(&["assets0.pk3", "assets1.pk3", "assets2.pk3"]),
            Some("1.03")
        );
        // 1.04 ships both patch archives, and the newest rule has to win.
        assert_eq!(
            spec.detect_version(&["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets5.pk3"]),
            Some("1.04")
        );
        // Steam and GOG hand out 1.04 without the 1.03 archive on some copies.
        assert_eq!(
            spec.detect_version(&["assets0.pk3", "assets1.pk3", "assets5.pk3"]),
            Some("1.04")
        );
    }

    #[test]
    fn jedi_academy_does_not_claim_to_know_its_patch_level() {
        // 1.00 and 1.01 carry the same four archives. Naming one would be a
        // guess printed as a fact.
        assert_eq!(Game::JediAcademy.spec().detect_version(&["assets0.pk3"]), None);
        assert_eq!(Game::JediAcademy.spec().wanted_version, None);
    }

    #[test]
    fn the_gametype_tables_differ_where_the_games_do() {
        let ja = Game::JediAcademy.spec();
        let jo = Game::JediOutcast.spec();

        // The first four agree, which is exactly the trap: a table reused
        // across the two games looks right until index 4.
        for index in 0..4u8 {
            assert_eq!(ja.gametype_label(index), jo.gametype_label(index));
        }
        assert_eq!(ja.gametype_label(3), "Duel");
        assert_eq!(jo.gametype_label(3), "Duel");

        assert_eq!(ja.gametype_label(4), "Power Duel");
        assert_eq!(jo.gametype_label(4), "Single Player");
        assert_eq!(ja.gametype_label(6), "Team FFA");
        assert_eq!(jo.gametype_label(6), "Saga");
        assert_eq!(ja.gametype_label(7), "Siege");
        assert_eq!(jo.gametype_label(7), "CTF");
        assert_eq!(jo.gametype_label(8), "CTY");

        // Jedi Outcast has nine gametypes; Jedi Academy has ten.
        assert_eq!(jo.gametype_label(9), "Mode 9");
        assert_eq!(ja.gametype_label(9), "CTY");
        assert_eq!(ja.gametype_label(10), "Mode 10");
    }

    #[test]
    fn the_network_constants_are_the_ones_of_each_game() {
        let jo = Game::JediOutcast.spec();
        assert_eq!(jo.server_port, 28070);
        assert_eq!(jo.master_protocols, [15, 16]);
        assert!(jo.masters.iter().all(|master| master.ends_with(":28060")));

        let ja = Game::JediAcademy.spec();
        assert_eq!(ja.server_port, 29070);
        assert_eq!(ja.master_protocols, [26]);

        // Two games, two cache documents: one file for both would make a
        // refresh of one game erase the other one's list.
        assert_ne!(ja.server_cache_file, jo.server_cache_file);
    }

    #[test]
    fn each_game_names_the_cvar_of_its_own_game_data_root() {
        // Same role, different name: Quake 3's `fs_cdpath` in a Jedi Academy
        // engine, JK2MV's own `fs_assetspath` in Jedi Outcast.
        assert_eq!(Game::JediAcademy.spec().game_data_cvar, "fs_cdpath");
        assert_eq!(Game::JediOutcast.spec().game_data_cvar, "fs_assetspath");
    }

    #[test]
    fn the_interface_gets_both_games_with_their_names() {
        let games = list_games();
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].id, Game::JediAcademy);
        assert_eq!(games[0].display_name, "Jedi Academy");
        assert_eq!(games[0].short_name, "JA");
        assert_eq!(games[0].required_assets.len(), 4);
        assert_eq!(games[0].wanted_version, None);

        assert_eq!(games[1].id, Game::JediOutcast);
        assert_eq!(games[1].display_name, "Jedi Outcast");
        assert_eq!(games[1].short_name, "JO");
        assert_eq!(games[1].required_assets, ["assets0.pk3", "assets1.pk3"]);
        assert_eq!(games[1].wanted_version, Some("1.04"));
        assert_eq!(games[1].steam_app_id, 6030);
        assert_eq!(games[1].server_port, 28070);
    }
}
