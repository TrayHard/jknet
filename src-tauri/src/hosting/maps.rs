//! The maps a private server of one client can load.
//!
//! The engine learns its maps from `scripts/*.arena` and, in Jedi Outcast,
//! from `scripts/arenas.txt` as well: each entry names a map, its long name
//! and the modes it supports in the `type` key, `type "ffa team"`. A map with
//! no entry is left off the list, and an entry whose `maps/<name>.bsp` is in no
//! archive is left off too: the server would not find it.
//!
//! The archives are read in the order the engine loads them, so a later one
//! overrides an earlier entry of the same map. The roots come from the launch
//! layout of the game, the folders are `base` and then the mod folder:
//!
//! ```text
//! Jedi Academy   <GameData>  engine\  home\      each: base, then <fs_game>
//! Jedi Outcast   <GameData>  home\               (the base root links to <GameData>\base)
//! ```
//!
//! Within a folder the archives go by `pak_order`, the sort of the engine.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use zip::ZipArchive;

use crate::game::{Game, LaunchLayout};
use crate::library::pak_order;

/// The largest arena file read. The retail ones are a few kilobytes.
const MAX_ARENA_BYTES: u64 = 256 * 1024;

/// One entry of an arena file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArenaEntry {
    /// `mp/ffa3`, as the file spells it.
    pub map: String,
    /// `longname`.
    pub title: Option<String>,
    /// The tokens of `type`, lowercase: `ffa`, `team`, `duel`…
    pub types: Vec<String>,
}

/// One map of the list, with where its `.bsp` came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapEntry {
    pub name: String,
    pub title: Option<String>,
    pub gametypes: Vec<String>,
    /// True when a retail archive of the game carries the `.bsp`: friends
    /// have it by definition. False for a map of the player's own files.
    pub retail: bool,
}

/// Where the archives of one client are.
#[derive(Debug, Clone)]
pub struct MapRoots {
    pub game: Game,
    /// `<GameData>`.
    pub game_data: PathBuf,
    /// `clients\<slug>\engine`.
    pub engine_dir: PathBuf,
    /// `clients\<slug>\home`.
    pub home_dir: PathBuf,
    /// The mod folder, `None` for `base`.
    pub fs_game: Option<String>,
}

impl MapRoots {
    /// The folders that hold archives, in load order.
    pub fn folders(&self) -> Vec<PathBuf> {
        let roots: Vec<&Path> = match self.game.spec().launch_layout {
            LaunchLayout::EngineIsBasepath => {
                vec![&self.game_data, &self.engine_dir, &self.home_dir]
            }
            LaunchLayout::OwnBasepath => vec![&self.game_data, &self.home_dir],
        };
        let mut folders: Vec<PathBuf> = roots
            .iter()
            .map(|root| root.join(crate::paths::BASE_FOLDER))
            .collect();
        if let Some(fs_game) = self
            .fs_game
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("base"))
        {
            folders.extend(roots.iter().map(|root| root.join(fs_game)));
        }
        folders
    }
}

/// The map key of a name: lowercase, forward slashes, no `maps/`, no `.bsp`.
pub fn map_key(name: &str) -> String {
    crate::levelshots::map_key(name)
}

/// Reads the maps a server of these roots can load, sorted by name.
pub fn scan(roots: &MapRoots) -> Vec<MapEntry> {
    let retail: HashSet<String> = roots
        .game
        .spec()
        .assets
        .iter()
        .map(|asset| asset.name.to_ascii_lowercase())
        .collect();
    let retail_folder = roots.game_data.join(crate::paths::BASE_FOLDER);

    let mut arenas: BTreeMap<String, ArenaEntry> = BTreeMap::new();
    let mut bsp_anywhere: HashSet<String> = HashSet::new();
    let mut bsp_retail: HashSet<String> = HashSet::new();

    for folder in roots.folders() {
        for archive in archives_in(&folder) {
            let is_retail = folder == retail_folder
                && archive
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| retail.contains(&name.to_ascii_lowercase()));
            if let Err(e) = read_archive(&archive, is_retail, &mut arenas, &mut bsp_anywhere, &mut bsp_retail) {
                log::warn!("cannot read the maps of {}: {e}", archive.display());
            }
        }
    }

    let mut maps: Vec<MapEntry> = arenas
        .into_iter()
        .filter(|(key, _)| bsp_anywhere.contains(key))
        .map(|(key, entry)| MapEntry {
            name: entry.map,
            title: entry.title,
            gametypes: entry.types,
            retail: bsp_retail.contains(&key),
        })
        .collect();
    maps.sort_by_key(|map| map.name.to_ascii_lowercase());
    maps
}

/// The pk3 files of one folder in the order the engine loads them.
fn archives_in(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut found: Vec<((u8, String), PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            name.to_ascii_lowercase()
                .ends_with(".pk3")
                .then(|| (pak_order(&name), entry.path()))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, path)| path).collect()
}

/// Adds the arena entries and the `.bsp` names of one archive.
fn read_archive(
    path: &Path,
    is_retail: bool,
    arenas: &mut BTreeMap<String, ArenaEntry>,
    bsp_anywhere: &mut HashSet<String>,
    bsp_retail: &mut HashSet<String>,
) -> crate::error::Result<()> {
    let file = File::open(path).map_err(|e| crate::error::AppError::io_path("cannot open", path, e))?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;

    let mut arena_files = Vec::new();
    for (index, entry) in crate::archive::walk(&archive, crate::archive::MAX_ENTRIES) {
        let lower = entry.to_ascii_lowercase();
        if let Some(map) = lower.strip_prefix("maps/").and_then(|rest| rest.strip_suffix(".bsp")) {
            bsp_anywhere.insert(map.to_string());
            if is_retail {
                bsp_retail.insert(map.to_string());
            }
        } else if lower.starts_with("scripts/")
            && !lower["scripts/".len()..].contains('/')
            && (lower.ends_with(".arena") || lower == "scripts/arenas.txt")
        {
            arena_files.push((index, entry));
        }
    }
    // The central directory order is not the engine's: arena files of one
    // archive are read in name order, the order `FS_ListFiles` hands out.
    arena_files.sort_by_key(|(_, name)| name.to_ascii_lowercase());

    for (index, name) in arena_files {
        let mut entry = archive.by_index(index)?;
        if entry.size() > MAX_ARENA_BYTES {
            log::warn!("{name} in {} is too large to be an arena file", path.display());
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .by_ref()
            .take(MAX_ARENA_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| crate::error::AppError::io_path("cannot read", path, e))?;
        let text = crate::servers::protocol::decode_bytes(&bytes);
        for arena in parse_arenas(&text) {
            arenas.insert(map_key(&arena.map), arena);
        }
    }
    Ok(())
}

/// Reads the entries of one arena file.
///
/// The format is the engine's script syntax: blocks in braces, each a list
/// of `key value` pairs where the value may be quoted, with `//` and `/* */`
/// comments. A block without a `map` key is skipped.
pub fn parse_arenas(text: &str) -> Vec<ArenaEntry> {
    let tokens = tokenize(text);
    let mut out = Vec::new();
    let mut at = 0;
    while at < tokens.len() {
        if tokens[at] != "{" {
            at += 1;
            continue;
        }
        at += 1;
        let mut fields: BTreeMap<String, String> = BTreeMap::new();
        while at < tokens.len() && tokens[at] != "}" {
            let key = tokens[at].to_ascii_lowercase();
            let value = tokens.get(at + 1).filter(|value| *value != "}").cloned();
            match value {
                Some(value) => {
                    fields.insert(key, value);
                    at += 2;
                }
                None => at += 1,
            }
        }
        at += 1;
        let Some(map) = fields.remove("map").filter(|map| !map.trim().is_empty()) else {
            continue;
        };
        out.push(ArenaEntry {
            map: map.trim().to_string(),
            title: fields
                .remove("longname")
                .map(|title| title.trim().to_string())
                .filter(|title| !title.is_empty()),
            types: fields
                .remove("type")
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_ascii_lowercase)
                .collect(),
        });
    }
    out
}

/// Splits script text into tokens: braces, quoted strings and bare words.
fn tokenize(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        if c.is_whitespace() {
            at += 1;
        } else if c == '/' && chars.get(at + 1) == Some(&'/') {
            while at < chars.len() && chars[at] != '\n' {
                at += 1;
            }
        } else if c == '/' && chars.get(at + 1) == Some(&'*') {
            at += 2;
            while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                at += 1;
            }
            at += 2;
        } else if c == '{' || c == '}' {
            tokens.push(c.to_string());
            at += 1;
        } else if c == '"' {
            at += 1;
            let start = at;
            while at < chars.len() && chars[at] != '"' {
                at += 1;
            }
            tokens.push(chars[start..at.min(chars.len())].iter().collect());
            at += 1;
        } else {
            let start = at;
            while at < chars.len()
                && !chars[at].is_whitespace()
                && chars[at] != '{'
                && chars[at] != '}'
                && chars[at] != '"'
            {
                at += 1;
            }
            tokens.push(chars[start..at].iter().collect());
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    use super::*;

    /// `scripts/arenas.txt` of the Jedi Outcast `assets0.pk3`, shortened.
    const JO_ARENAS: &str = "{\nmap\t\t\t\"ffa_bespin\"\nbots\t\t\t\"Lando\"\nlongname\t\t\"Bespin Streets\"\nfraglimit\t\t10\ntype\t\t\t\"ffa holocron jedimaster team\"\n}\n\n{\nmap\t\t\t\"ctf_bespin\"\nlongname\t\t\"Bespin Exhaust Shafts\"\ntype\t\t\t\"ctf cty team ffa holocron jedimaster\"\n}\n{\nmap\t\t\t\"duel_bay\"\nlongname\t\t\"Imperial Shuttle Bay\"\ntype\t\t\t\"duel\"\n}\n";

    #[test]
    fn an_arena_file_reads_into_maps_titles_and_mode_tokens() {
        let arenas = parse_arenas(JO_ARENAS);
        assert_eq!(arenas.len(), 3);
        assert_eq!(arenas[0].map, "ffa_bespin");
        assert_eq!(arenas[0].title.as_deref(), Some("Bespin Streets"));
        assert_eq!(arenas[0].types, ["ffa", "holocron", "jedimaster", "team"]);
        assert_eq!(arenas[2].types, ["duel"]);
    }

    #[test]
    fn comments_bare_values_and_a_block_without_a_map_are_handled() {
        let text = "// retail list\n{ map \"mp/ffa3\" /* the big one */ longname \"Deathstar\" fraglimit 20 type \"FFA Team\" }\n{ longname \"no map\" }\n{ map mp/duel1 type duel }";
        let arenas = parse_arenas(text);
        assert_eq!(arenas.len(), 2);
        assert_eq!(arenas[0].map, "mp/ffa3");
        assert_eq!(arenas[0].types, ["ffa", "team"]);
        assert_eq!(arenas[1].map, "mp/duel1");
        assert_eq!(arenas[1].title, None);
    }

    fn write_pk3(path: &Path, entries: &[(&str, &str)]) {
        let file = File::create(path).expect("the pk3 is created");
        let mut writer = ZipWriter::new(file);
        for (name, body) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("an entry starts");
            writer.write_all(body.as_bytes()).expect("the entry is written");
        }
        writer.finish().expect("the pk3 is closed");
    }

    #[test]
    fn the_list_follows_the_load_order_and_needs_a_bsp() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let game_data = temp.path().join("GameData");
        let engine = temp.path().join("engine");
        let home = temp.path().join("home");
        for dir in [game_data.join("base"), engine.join("base"), home.join("base"), home.join("japlus")] {
            std::fs::create_dir_all(dir).expect("a folder");
        }
        write_pk3(
            &game_data.join("base").join("assets0.pk3"),
            &[
                ("scripts/ffa.arena", "{ map \"mp/ffa3\" longname \"Deathstar\" type \"ffa team\" }\n{ map \"mp/ghost\" type \"ffa\" }"),
                ("maps/mp/ffa3.bsp", "bsp"),
            ],
        );
        // The player's own map: its arena entry and its bsp in one archive.
        write_pk3(
            &home.join("base").join("zz_custom.pk3"),
            &[
                ("scripts/custom.arena", "{ map \"mp/custom\" longname \"My Map\" type \"ffa duel\" }"),
                ("maps/mp/custom.bsp", "bsp"),
            ],
        );
        // A mod folder overrides the retail entry of the same map.
        write_pk3(
            &home.join("japlus").join("override.pk3"),
            &[("scripts/ffa.arena", "{ map \"MP/FFA3\" longname \"Deathstar (JA+)\" type \"ffa ctf\" }")],
        );

        let roots = MapRoots {
            game: Game::JediAcademy,
            game_data: game_data.clone(),
            engine_dir: engine,
            home_dir: home,
            fs_game: Some("japlus".into()),
        };
        let maps = scan(&roots);
        let names: Vec<&str> = maps.iter().map(|map| map.name.as_str()).collect();
        // `mp/ghost` has no bsp anywhere.
        assert_eq!(names, ["mp/custom", "MP/FFA3"]);
        assert!(!maps[0].retail, "a map of the client's own files");
        assert_eq!(maps[1].title.as_deref(), Some("Deathstar (JA+)"));
        assert_eq!(maps[1].gametypes, ["ffa", "ctf"]);
        assert!(maps[1].retail, "the bsp is in a retail archive");

        // Without the mod folder the retail entry stands.
        let plain = scan(&MapRoots { fs_game: None, ..roots });
        let ffa3 = plain.iter().find(|map| map_key(&map.name) == "mp/ffa3").expect("ffa3");
        assert_eq!(ffa3.title.as_deref(), Some("Deathstar"));
    }

    #[test]
    fn jedi_outcast_reads_arenas_txt_and_skips_the_engine_folder() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let game_data = temp.path().join("GameData");
        let engine = temp.path().join("engine");
        let home = temp.path().join("home");
        for dir in [game_data.join("base"), engine.join("base"), home.join("base")] {
            std::fs::create_dir_all(dir).expect("a folder");
        }
        write_pk3(
            &game_data.join("base").join("assets0.pk3"),
            &[("scripts/arenas.txt", JO_ARENAS), ("maps/ffa_bespin.bsp", "bsp"), ("maps/duel_bay.bsp", "bsp")],
        );
        // Not on the search path of a Jedi Outcast client.
        write_pk3(
            &engine.join("base").join("assetsmv.pk3"),
            &[("scripts/extra.arena", "{ map \"ctf_bespin\" type \"ctf\" }"), ("maps/ctf_bespin.bsp", "bsp")],
        );
        let maps = scan(&MapRoots {
            game: Game::JediOutcast,
            game_data,
            engine_dir: engine,
            home_dir: home,
            fs_game: None,
        });
        let names: Vec<&str> = maps.iter().map(|map| map.name.as_str()).collect();
        assert_eq!(names, ["duel_bay", "ffa_bespin"]);
        assert!(maps.iter().all(|map| map.retail));
    }
}
