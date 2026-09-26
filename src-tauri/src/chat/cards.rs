//! Cards of messages: a server, a private server to join, a bundle, a JKHub
//! mod, a map, a player profile, key binds and a config.
//!
//! Every card names its `type` and its version `v`, which is 1, and carries a
//! `fallbackText`: what a launcher that cannot draw the card shows, and what
//! the search of the service reads. The service checks every card of a
//! message and is the one that refuses (`400 card`); this module holds the
//! same rules on this side, for three jobs.
//!
//! - **Building.** [`chat_build_card`] and `chat_send` clean a card the way
//!   the service will, fill in `v` and an English `fallbackText` when the
//!   window left them out, and refuse what the service would refuse before
//!   the message is queued. [`chat_card_from_profile`] turns a stored player
//!   profile into a profile card.
//! - **Applying.** A card never saves anything by itself. A profile card
//!   becomes a filled-in form of a new player profile
//!   ([`chat_card_to_profile`]), a bind or a config card a new config
//!   document with the lines to read first ([`chat_card_to_config`]); the
//!   player saves them with the existing editors. A server, a bundle, a JKHub
//!   mod and a map go to the existing commands (`get_server_status`,
//!   `launch_client`, `get_bundle`, `jkhub_file`, `jkhub_install`,
//!   `get_levelshot`, `host_start`) with the fields [`chat_check_card`]
//!   answers.
//! - **The danger scan.** Binds and configs are commands the game runs.
//!   [`chat_scan_commands`] names every line that quits the game, runs
//!   another file, writes the configuration, talks to a server's remote
//!   console, connects somewhere, wipes the binds, turns on downloads,
//!   changes the file system or a server setting, rebinds a key from inside
//!   another bind, or reaches any of that through a `vstr` chain.
//!
//! Strings are trimmed and lose their control and bidi characters; a config
//! keeps its line breaks and tabs. Texts a launcher only shows are cut to
//! their limits. Values a launcher acts on (addresses, ids, map names, binds,
//! configs, the fields of a profile) are refused instead of cut, so a card
//! never applies half of what its sender wrote.
//!
//! A card that breaks a rule is refused as `online` with `details.code`
//! [`CARD`], the reason the service gives the same refusal, so the windows
//! word both alike.

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::configs::ConfigDocument;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::profiles::{self, CharColor, InlineProfile, PlayerProfile};
use crate::servers::protocol::strip_colors;
use crate::state::AppState;

/// The code of a card refusal: `details.code` of an `online` error, the
/// reason the service answers `400` with.
pub const CARD: &str = "card";

/// The only card version this launcher knows.
const VERSION: u8 = 1;

/// The most cards one message carries.
pub const CARDS_MAX: usize = 5;
/// The largest card, serialized, except a config.
const CARD_BYTES_MAX: usize = 8 * 1024;
/// The longest config text, in bytes.
const CONFIG_TEXT_MAX: usize = 32 * 1024;
/// The largest config card, serialized: its text and 8 KiB for the rest.
const CONFIG_CARD_BYTES_MAX: usize = CONFIG_TEXT_MAX + 8 * 1024;
/// The largest sum of the cards of one message, serialized.
const CARDS_BYTES_MAX: usize = 48 * 1024;

const FALLBACK_MAX: usize = 200;
const NAME_MAX: usize = 64;
const ADDRESS_MAX: usize = 64;
const TITLE_MAX: usize = 128;
const SLUG_MAX: usize = 64;
const JKHUB_SLUG_MAX: usize = 128;
const MAP_NAME_MAX: usize = 64;
const NICKNAME_MAX: usize = 36;
const PROFILE_VALUE_MAX: usize = 64;
const COLOR_MAX: usize = 32;
const BINDS_MAX: usize = 50;
const BIND_KEY_MAX: usize = 32;
const BIND_COMMAND_MAX: usize = 1024;
const CONFIG_NAME_MAX: usize = 120;
const HOST_ID_MAX: usize = 64;

/// What a profile card says when the profile leaves the hilt or the blade
/// colour to the engine: the defaults a fresh configuration gets,
/// `DEFAULT_SABER` of `codemp/game/bg_public.h:42` and the `color1` of
/// `codemp/client/cl_main.cpp:2846` (OpenJK `1a6a6434`). The card has to name
/// both; the service refuses one without them.
const DEFAULT_SABER1: &str = "Kyle";
const DEFAULT_COLOR1: &str = "4";

/// The name of a new config document made from a bind card that carries no
/// text of its own. The editor opens with it and the player renames it.
const BINDS_DOCUMENT_NAME: &str = "Key binds";

/// Longest name of a config document, in bytes: `user_files::label`.
const DOCUMENT_NAME_BYTES: usize = 240;

// ---------------------------------------------------------------------------
// Card shapes
// ---------------------------------------------------------------------------

fn version() -> u8 {
    VERSION
}

/// One card of a message, as the service stores it.
///
/// `v` and `fallbackText` may be left out by a window that builds a card:
/// [`prepare`] fills them in. The service always writes both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Card {
    Server(ServerCard),
    HostInvite(HostInviteCard),
    Bundle(BundleCard),
    JkhubMod(JkhubModCard),
    Map(MapCard),
    Profile(ProfileCard),
    Bind(BindCard),
    Config(ConfigCard),
}

/// A game server anyone can join by its address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    /// `host:port`, an IPv4 address or a host name.
    pub address: String,
    pub name: String,
    /// `ja` or `jo`.
    pub game: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gametype: Option<u32>,
    #[serde(rename = "mod", default, skip_serializing_if = "Option::is_none")]
    pub mod_name: Option<String>,
}

/// The private server its sender hosts now.
///
/// The sender names the session and, optionally, the name its launcher
/// shows; the service fills in the host, the game, the mod, the map and the
/// game type from the live hosting. A card on its way out carries only the
/// first two, since the service overwrites the rest anyway. It never holds a
/// password or an address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInviteCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    /// The `jknet_session` of the private server, 16 hex characters.
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game: Option<String>,
    #[serde(rename = "mod", default, skip_serializing_if = "Option::is_none")]
    pub mod_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gametype: Option<u32>,
}

/// A bundle of the catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    pub bundle_id: String,
    pub slug: String,
    pub name: String,
    pub game: String,
}

/// A file of JKHub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubModCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    pub file_id: u64,
    pub slug: String,
    pub title: String,
    pub game: String,
}

/// A map by its name inside the game, such as `mp/ffa3`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    pub game: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A player profile: nickname, model, sabers and colours.
///
/// Every value is the text of the cvar it stands for: `color1` and `color2`
/// are the digits `0` to `5`, `charColor` is `"R G B"`, three numbers of 0
/// to 255 apart by a space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    pub nickname: String,
    pub model: String,
    pub saber1: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saber2: Option<String>,
    pub color1: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_color: Option<String>,
}

/// Key binds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    pub binds: Vec<Bind>,
}

/// One key and the command it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bind {
    pub key: String,
    pub command: String,
}

/// A config file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCard {
    #[serde(default = "version")]
    pub v: u8,
    #[serde(default)]
    pub fallback_text: String,
    pub name: String,
    pub text: String,
}

/// The fields each type has, `type` included. A card on its way out may carry
/// nothing else, as on the service; a card that came in is read with the
/// fields it knows and the rest ignored.
fn known_fields(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "server" => &[
            "type", "v", "fallbackText", "address", "name", "game", "map", "gametype", "mod",
        ],
        "hostInvite" => &[
            "type", "v", "fallbackText", "sessionId", "name", "hostId", "game", "mod", "map",
            "gametype",
        ],
        "bundle" => &["type", "v", "fallbackText", "bundleId", "slug", "name", "game"],
        "jkhubMod" => &["type", "v", "fallbackText", "fileId", "slug", "title", "game"],
        "map" => &["type", "v", "fallbackText", "game", "name", "title"],
        "profile" => &[
            "type", "v", "fallbackText", "nickname", "model", "saber1", "saber2", "color1",
            "color2", "charColor",
        ],
        "bind" => &["type", "v", "fallbackText", "binds"],
        "config" => &["type", "v", "fallbackText", "name", "text"],
        _ => return None,
    })
}

const BIND_FIELDS: [&str; 2] = ["key", "command"];

/// Which way a card goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    /// Built here and about to be sent: unknown fields are refused, `v` and
    /// `fallbackText` are filled in, a `hostInvite` keeps only what its
    /// sender says.
    Out,
    /// Came with a message: read leniently, checked as strictly.
    In,
}

// ---------------------------------------------------------------------------
// Reading and cleaning
// ---------------------------------------------------------------------------

/// Reads one card. Answers the reason of a refusal.
fn parse(value: &Value, direction: Direction) -> std::result::Result<Card, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "A card is not an object".to_string())?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "A card has no type".to_string())?;
    let fields = known_fields(kind)
        .ok_or_else(|| format!("This launcher does not know cards of type {kind:?}"))?;
    let mut known = Map::new();
    for (key, field) in object {
        // `null` is the same as leaving the field out: a window writes
        // `map: null` for a server that did not say its map.
        if field.is_null() {
            continue;
        }
        if fields.contains(&key.as_str()) {
            known.insert(key.clone(), field.clone());
        } else if direction == Direction::Out {
            return Err(format!("A {kind} card has no field {key:?}"));
        }
    }
    if kind == "bind" {
        if let Some(Value::Array(binds)) = known.get_mut("binds") {
            for bind in binds.iter_mut() {
                if let Value::Object(bind) = bind {
                    if direction == Direction::Out {
                        if let Some(key) = bind.keys().find(|key| !BIND_FIELDS.contains(&key.as_str())) {
                            return Err(format!("A bind has no field {key:?}"));
                        }
                    }
                    bind.retain(|key, _| BIND_FIELDS.contains(&key.as_str()));
                }
            }
        }
    }
    serde_json::from_value(Value::Object(known)).map_err(|e| format!("A {kind} card is not valid: {e}"))
}

impl Card {
    fn version(&self) -> u8 {
        match self {
            Card::Server(card) => card.v,
            Card::HostInvite(card) => card.v,
            Card::Bundle(card) => card.v,
            Card::JkhubMod(card) => card.v,
            Card::Map(card) => card.v,
            Card::Profile(card) => card.v,
            Card::Bind(card) => card.v,
            Card::Config(card) => card.v,
        }
    }

    fn fallback_mut(&mut self) -> &mut String {
        match self {
            Card::Server(card) => &mut card.fallback_text,
            Card::HostInvite(card) => &mut card.fallback_text,
            Card::Bundle(card) => &mut card.fallback_text,
            Card::JkhubMod(card) => &mut card.fallback_text,
            Card::Map(card) => &mut card.fallback_text,
            Card::Profile(card) => &mut card.fallback_text,
            Card::Bind(card) => &mut card.fallback_text,
            Card::Config(card) => &mut card.fallback_text,
        }
    }

    /// The text a launcher shows when it cannot draw the card.
    pub fn fallback_text(&self) -> &str {
        match self {
            Card::Server(card) => &card.fallback_text,
            Card::HostInvite(card) => &card.fallback_text,
            Card::Bundle(card) => &card.fallback_text,
            Card::JkhubMod(card) => &card.fallback_text,
            Card::Map(card) => &card.fallback_text,
            Card::Profile(card) => &card.fallback_text,
            Card::Bind(card) => &card.fallback_text,
            Card::Config(card) => &card.fallback_text,
        }
    }

    /// Checks the card and cleans its strings, by the rules of the service.
    fn normalize(self, direction: Direction) -> std::result::Result<Card, String> {
        if self.version() != VERSION {
            return Err(format!("This launcher knows card version {VERSION} only"));
        }
        let mut card = match self {
            Card::Server(card) => Card::Server(ServerCard {
                v: VERSION,
                fallback_text: shown(&card.fallback_text, FALLBACK_MAX),
                address: server_address(&card.address)?,
                name: required(shown(&card.name, NAME_MAX), "name")?,
                game: game(&card.game)?,
                map: shown_opt(card.map, NAME_MAX),
                gametype: card.gametype,
                mod_name: shown_opt(card.mod_name, NAME_MAX),
            }),
            Card::HostInvite(card) => {
                let session_id = card.session_id.trim().to_ascii_lowercase();
                if session_id.len() != 16 || !session_id.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("sessionId must be 16 hex characters".to_string());
                }
                let name = shown_opt(card.name, NAME_MAX);
                let fallback_text = shown(&card.fallback_text, FALLBACK_MAX);
                match direction {
                    Direction::Out => Card::HostInvite(HostInviteCard {
                        v: VERSION,
                        fallback_text,
                        session_id,
                        name,
                        host_id: None,
                        game: None,
                        mod_name: None,
                        map: None,
                        gametype: None,
                    }),
                    Direction::In => Card::HostInvite(HostInviteCard {
                        v: VERSION,
                        fallback_text,
                        session_id,
                        name,
                        host_id: Some(host_id(card.host_id.as_deref().unwrap_or_default())?),
                        game: Some(game(card.game.as_deref().unwrap_or_default())?),
                        mod_name: shown_opt(card.mod_name, NAME_MAX),
                        map: shown_opt(card.map, NAME_MAX),
                        gametype: card.gametype,
                    }),
                }
            }
            Card::Bundle(card) => Card::Bundle(BundleCard {
                v: VERSION,
                fallback_text: shown(&card.fallback_text, FALLBACK_MAX),
                bundle_id: ulid(&card.bundle_id)?,
                slug: bundle_slug(&card.slug)?,
                name: required(shown(&card.name, NAME_MAX), "name")?,
                game: game(&card.game)?,
            }),
            Card::JkhubMod(card) => {
                // JKHub numbers its files well inside 32 bits, and the install
                // commands take one; a larger number names no file.
                if card.file_id == 0 || card.file_id > u64::from(u32::MAX) {
                    return Err("fileId must be the number of a JKHub file".to_string());
                }
                Card::JkhubMod(JkhubModCard {
                    v: VERSION,
                    fallback_text: shown(&card.fallback_text, FALLBACK_MAX),
                    file_id: card.file_id,
                    slug: jkhub_slug(&card.slug)?,
                    title: required(shown(&card.title, TITLE_MAX), "title")?,
                    game: game(&card.game)?,
                })
            }
            Card::Map(card) => Card::Map(MapCard {
                v: VERSION,
                fallback_text: shown(&card.fallback_text, FALLBACK_MAX),
                game: game(&card.game)?,
                name: map_name(&card.name)?,
                title: shown_opt(card.title, NAME_MAX),
            }),
            Card::Profile(card) => Card::Profile(ProfileCard {
                v: VERSION,
                fallback_text: shown(&card.fallback_text, FALLBACK_MAX),
                nickname: profile_value(&card.nickname, "nickname", NICKNAME_MAX)?,
                model: profile_value(&card.model, "model", PROFILE_VALUE_MAX)?,
                saber1: profile_value(&card.saber1, "saber1", PROFILE_VALUE_MAX)?,
                saber2: profile_opt(card.saber2, "saber2", PROFILE_VALUE_MAX)?,
                color1: profile_value(&card.color1, "color1", COLOR_MAX)?,
                color2: profile_opt(card.color2, "color2", COLOR_MAX)?,
                char_color: profile_opt(card.char_color, "charColor", COLOR_MAX)?,
            }),
            Card::Bind(card) => {
                if card.binds.is_empty() || card.binds.len() > BINDS_MAX {
                    return Err(format!("A bind card holds 1 to {BINDS_MAX} binds"));
                }
                let binds = card
                    .binds
                    .into_iter()
                    .map(|bind| {
                        Ok(Bind {
                            key: required(applied(&bind.key, "key", BIND_KEY_MAX)?, "key")?,
                            command: applied(&bind.command, "command", BIND_COMMAND_MAX)?,
                        })
                    })
                    .collect::<std::result::Result<Vec<_>, String>>()?;
                Card::Bind(BindCard {
                    v: VERSION,
                    fallback_text: shown(&card.fallback_text, FALLBACK_MAX),
                    binds,
                })
            }
            Card::Config(card) => Card::Config(ConfigCard {
                v: VERSION,
                fallback_text: shown(&card.fallback_text, FALLBACK_MAX),
                name: required(applied(&card.name, "name", CONFIG_NAME_MAX)?, "name")?,
                text: config_text(&card.text)?,
            }),
        };
        if direction == Direction::Out && card.fallback_text().is_empty() {
            let text = shown(&fallback_for(&card), FALLBACK_MAX);
            *card.fallback_mut() = text;
        }
        Ok(card)
    }
}

/// The English line a card of this launcher carries when the window gave
/// none: what an older launcher prints instead of the card, and what the
/// search finds it by.
fn fallback_for(card: &Card) -> String {
    match card {
        Card::Server(card) => format!("Server: {} ({})", card.name, card.address),
        Card::HostInvite(card) => match &card.name {
            Some(name) => format!("Join my server: {name}"),
            None => "Join my private server".to_string(),
        },
        Card::Bundle(card) => format!("Bundle: {}", card.name),
        Card::JkhubMod(card) => format!("JKHub: {}", card.title),
        Card::Map(card) => match &card.title {
            Some(title) => format!("Map: {title} ({})", card.name),
            None => format!("Map: {}", card.name),
        },
        Card::Profile(card) => {
            let plain = strip_colors(&card.nickname);
            format!("Player profile: {}", plain.trim())
        }
        Card::Bind(card) => match card.binds.as_slice() {
            [bind] if bind.command.is_empty() => format!("Unbind {}", bind.key),
            [bind] => format!("Bind {}: {}", bind.key, bind.command),
            binds => {
                let keys: Vec<&str> = binds.iter().map(|bind| bind.key.as_str()).collect();
                format!("{} key binds: {}", binds.len(), keys.join(", "))
            }
        },
        Card::Config(card) => format!("Config: {}", card.name),
    }
}

/// `raw` without control and bidi characters, trimmed.
fn stripped(raw: &str) -> String {
    raw.chars()
        .filter(|&ch| !(ch.is_control() || is_bidi_control(ch)))
        .collect::<String>()
        .trim()
        .to_string()
}

/// The bidirectional overrides and isolates a text must not carry: they can
/// make it read differently from what it says. The service's rule.
pub(crate) fn is_bidi_control(ch: char) -> bool {
    matches!(ch, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// A text of at most `max` characters, trimmed again after the cut.
fn clamp(raw: &str, max: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect::<String>().trim_end().to_string()
}

/// A text a launcher only shows: cleaned and cut to `max` characters.
fn shown(raw: &str, max: usize) -> String {
    clamp(&stripped(raw), max)
}

/// An optional shown text; empty counts as absent.
fn shown_opt(raw: Option<String>, max: usize) -> Option<String> {
    raw.map(|value| shown(&value, max))
        .filter(|value| !value.is_empty())
}

/// A value a launcher acts on: cleaned, refused when it holds NUL or is
/// longer than `max` characters.
fn applied(raw: &str, field: &str, max: usize) -> std::result::Result<String, String> {
    if raw.contains('\0') {
        return Err(format!("{field} must not contain NUL"));
    }
    let value = stripped(raw);
    if value.chars().count() > max {
        return Err(format!("{field} is longer than {max} characters"));
    }
    Ok(value)
}

fn required(value: String, field: &str) -> std::result::Result<String, String> {
    if value.is_empty() {
        Err(format!("{field} is empty"))
    } else {
        Ok(value)
    }
}

fn game(raw: &str) -> std::result::Result<String, String> {
    match raw.trim() {
        game @ ("ja" | "jo") => Ok(game.to_string()),
        _ => Err("game must be 'ja' or 'jo'".to_string()),
    }
}

/// The account of a host: what the service wrote, printable and short.
fn host_id(raw: &str) -> std::result::Result<String, String> {
    let id = raw.trim();
    if id.is_empty()
        || id.len() > HOST_ID_MAX
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("hostId is not an account id".to_string());
    }
    Ok(id.to_string())
}

/// A server address a player may be sent to: `host:port` with an IPv4
/// address or a host name, and never this machine, a link-local or multicast
/// address or `0.0.0.0`.
fn server_address(raw: &str) -> std::result::Result<String, String> {
    let address = stripped(raw);
    let refused = || Err(format!("'{address}' is not a server address"));
    if address.is_empty() || address.len() > ADDRESS_MAX {
        return refused();
    }
    let Some((host, port)) = address.rsplit_once(':') else {
        return refused();
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return refused();
    }
    match port.parse::<u16>() {
        Ok(port) if port > 0 => {}
        _ => return refused(),
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        if ip.is_loopback()
            || ip.is_link_local()
            || ip.is_multicast()
            || ip.is_unspecified()
            || ip.is_broadcast()
        {
            return refused();
        }
        return Ok(address);
    }
    if !valid_host_name(host) {
        return refused();
    }
    Ok(address)
}

/// A DNS host name: dot-separated labels of letters, digits and inner
/// hyphens, not an address with a wrong number in it, and not `localhost`.
fn valid_host_name(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower.is_empty()
        || lower.len() > 253
        || lower == "localhost"
        || lower.ends_with(".localhost")
    {
        return false;
    }
    let labels: Vec<&str> = lower.split('.').collect();
    let well_formed = labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    // A last label of digits only is a mistyped IPv4 address, not a name.
    let numeric_tail = labels
        .last()
        .is_some_and(|label| label.bytes().all(|b| b.is_ascii_digit()));
    well_formed && !numeric_tail
}

/// A ULID in its canonical upper-case form: 26 characters of Crockford's
/// base 32, the first of them 0 to 7 so the value fits 128 bits.
fn ulid(raw: &str) -> std::result::Result<String, String> {
    const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let id = raw.trim().to_ascii_uppercase();
    if id.len() != 26 || !id.chars().all(|c| ALPHABET.contains(c)) || id.as_bytes()[0] > b'7' {
        return Err("bundleId must be a ULID".to_string());
    }
    Ok(id)
}

/// A bundle slug: lower-case letters, digits and hyphens.
fn bundle_slug(raw: &str) -> std::result::Result<String, String> {
    let slug = raw.trim();
    if slug.is_empty()
        || slug.len() > SLUG_MAX
        || !slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("slug must be lower-case letters, digits and hyphens".to_string());
    }
    Ok(slug.to_string())
}

/// A JKHub slug: printable, no spaces and no slashes.
fn jkhub_slug(raw: &str) -> std::result::Result<String, String> {
    let slug = raw.trim();
    let count = slug.chars().count();
    if count == 0
        || count > JKHUB_SLUG_MAX
        || slug.chars().any(|ch| {
            ch.is_whitespace() || ch.is_control() || is_bidi_control(ch) || matches!(ch, '/' | '\\')
        })
    {
        return Err("slug is not a JKHub slug".to_string());
    }
    Ok(slug.to_string())
}

/// A map name inside the game: letters, digits, `_`, `/` and `-`.
fn map_name(raw: &str) -> std::result::Result<String, String> {
    let name = raw.trim();
    if name.is_empty()
        || name.len() > MAP_NAME_MAX
        || name.contains("..")
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'/' | b'-'))
    {
        return Err("name must be a map name such as mp/ffa3".to_string());
    }
    Ok(name.to_string())
}

/// A value of a profile, which a launcher writes into a game config:
/// printable, without `"`, `;`, `\` and line breaks.
fn profile_value(raw: &str, field: &str, max: usize) -> std::result::Result<String, String> {
    let value = raw.trim();
    if value
        .chars()
        .any(|ch| ch.is_control() || is_bidi_control(ch) || matches!(ch, '"' | ';' | '\\'))
    {
        return Err(format!(
            "{field} must be printable, without quotes, semicolons and backslashes"
        ));
    }
    if value.chars().count() > max {
        return Err(format!("{field} is longer than {max} characters"));
    }
    required(value.to_string(), field)
}

fn profile_opt(
    raw: Option<String>,
    field: &str,
    max: usize,
) -> std::result::Result<Option<String>, String> {
    match raw {
        Some(value) if !value.trim().is_empty() => profile_value(&value, field, max).map(Some),
        _ => Ok(None),
    }
}

/// The text of a config: no NUL, line breaks and tabs kept, other controls
/// dropped, at most 32 KiB.
fn config_text(raw: &str) -> std::result::Result<String, String> {
    if raw.contains('\0') {
        return Err("A config must not contain NUL".to_string());
    }
    let text: String = raw
        .chars()
        .filter(|&ch| matches!(ch, '\n' | '\r' | '\t') || !(ch.is_control() || is_bidi_control(ch)))
        .collect();
    let text = text.trim().to_string();
    if text.len() > CONFIG_TEXT_MAX {
        return Err(format!("A config holds at most {CONFIG_TEXT_MAX} bytes"));
    }
    Ok(text)
}

/// The refusal of a card, as the windows read the service's.
fn refusal(reason: String) -> AppError {
    AppError::Online {
        code: CARD.to_string(),
        message: reason,
    }
}

/// Cleans the cards of a message about to be sent, fills in what the window
/// left out, and refuses what the service would refuse: the rules of each
/// type, five cards at most, 8 KiB a card (40 KiB a config), 48 KiB in all.
pub(crate) fn prepare(raw: &[Value]) -> Result<Vec<Value>> {
    if raw.len() > CARDS_MAX {
        return Err(refusal(format!("A message carries at most {CARDS_MAX} cards")));
    }
    let mut total = 0usize;
    let mut cards = Vec::with_capacity(raw.len());
    for value in raw {
        let card = parse(value, Direction::Out)
            .and_then(|card| card.normalize(Direction::Out))
            .map_err(refusal)?;
        let bytes = serde_json::to_vec(&card)
            .map_err(|e| refusal(format!("A card does not serialize: {e}")))?
            .len();
        let max = match card {
            Card::Config(_) => CONFIG_CARD_BYTES_MAX,
            _ => CARD_BYTES_MAX,
        };
        if bytes > max {
            return Err(refusal(format!("A card is larger than {max} bytes")));
        }
        total += bytes;
        if total > CARDS_BYTES_MAX {
            return Err(refusal(format!(
                "The cards of a message are larger than {CARDS_BYTES_MAX} bytes"
            )));
        }
        cards.push(serde_json::to_value(&card).map_err(|e| refusal(e.to_string()))?);
    }
    Ok(cards)
}

/// Reads a card that came with a message and checks it by the same rules,
/// before anything acts on it.
pub(crate) fn check(raw: &Value) -> Result<Card> {
    parse(raw, Direction::In)
        .and_then(|card| card.normalize(Direction::In))
        .map_err(refusal)
}

// ---------------------------------------------------------------------------
// Player profiles
// ---------------------------------------------------------------------------

/// A profile card, ready for the profile form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardProfile {
    /// A new profile, `id` empty: the form shows it and the player saves it
    /// with `save_profile` into the client they pick.
    pub profile: PlayerProfile,
    /// Fields of the card the profile rules refused, by the name the card
    /// gives them (`nickname`, `color2`, `charColor`…). The form leaves them
    /// blank.
    pub skipped: Vec<String>,
}

/// The values of a profile as the cvars see them.
#[derive(Debug)]
struct ProfileValues {
    nickname: Option<String>,
    model: Option<String>,
    saber1: Option<String>,
    saber2: Option<String>,
    color1: Option<String>,
    color2: Option<String>,
    char_color: Option<String>,
}

/// An inline profile with nothing in it, for checking one field at a time.
fn blank_profile() -> InlineProfile {
    InlineProfile {
        nickname: None,
        model: None,
        saber1: None,
        saber2: None,
        color1: None,
        color2: None,
        char_color: None,
    }
}

/// Turns a profile card into a new player profile. Each value passes the
/// rules of a saved profile on its own; one that does not is left out and
/// named in `skipped`, so the form still opens with the rest.
pub(crate) fn profile_from_card(card: &ProfileCard) -> CardProfile {
    let mut skipped = Vec::new();
    let nickname = fitting(
        &mut skipped,
        "nickname",
        InlineProfile {
            nickname: Some(card.nickname.clone()),
            ..blank_profile()
        },
    )
    .and_then(|profile| profile.nickname);
    let model = fitting(
        &mut skipped,
        "model",
        InlineProfile {
            model: Some(card.model.clone()),
            ..blank_profile()
        },
    )
    .and_then(|profile| profile.model);
    let saber1 = fitting(
        &mut skipped,
        "saber1",
        InlineProfile {
            saber1: Some(card.saber1.clone()),
            ..blank_profile()
        },
    )
    .and_then(|profile| profile.saber1);
    let saber2 = card
        .saber2
        .as_ref()
        .and_then(|value| {
            fitting(
                &mut skipped,
                "saber2",
                InlineProfile {
                    saber2: Some(value.clone()),
                    ..blank_profile()
                },
            )
        })
        .and_then(|profile| profile.saber2);
    let color1 = blade_color(&mut skipped, "color1", Some(&card.color1));
    let color2 = blade_color(&mut skipped, "color2", card.color2.as_deref());
    let char_color = card.char_color.as_deref().and_then(|value| {
        let parsed = parse_char_color(value);
        if parsed.is_none() {
            skipped.push("charColor".to_string());
        }
        parsed
    });

    let profile = PlayerProfile {
        id: String::new(),
        name: profile_name(nickname.as_deref(), model.as_deref()),
        nickname,
        model,
        saber1,
        saber2,
        color1,
        color2,
        char_color,
        tokens_override: None,
    };
    CardProfile { profile, skipped }
}

/// One value of a card through the rules of a saved profile: the checked
/// profile, or `None` with the field noted in `skipped`.
fn fitting(skipped: &mut Vec<String>, field: &str, inline: InlineProfile) -> Option<PlayerProfile> {
    match inline.into_profile() {
        Ok(profile) => Some(profile),
        Err(e) => {
            log::debug!("chat: the {field} of a profile card does not fit a profile: {e}");
            skipped.push(field.to_string());
            None
        }
    }
}

/// A blade colour of a card, `0` to `5`, or `None` with the field noted in
/// `skipped`.
fn blade_color(skipped: &mut Vec<String>, field: &str, value: Option<&str>) -> Option<u8> {
    let value = value?;
    let color = value
        .trim()
        .parse::<u8>()
        .ok()
        .filter(|color| *color <= profiles::MAX_SABER_COLOR);
    if color.is_none() {
        skipped.push(field.to_string());
    }
    color
}

/// `"R G B"` (a comma works too) as the tint of a character.
fn parse_char_color(value: &str) -> Option<CharColor> {
    let parts: Vec<u8> = value
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u8>().ok())
        .collect::<Option<Vec<u8>>>()?;
    match parts.as_slice() {
        [red, green, blue] => Some(CharColor {
            red: *red,
            green: *green,
            blue: *blue,
        }),
        _ => None,
    }
}

/// The launcher's name of a profile made from a card: the nickname without
/// its colour codes, else the model, else `Profile`. The player renames it in
/// the form.
fn profile_name(nickname: Option<&str>, model: Option<&str>) -> String {
    let plain = nickname
        .map(|nickname| stripped(&strip_colors(nickname)))
        .filter(|name| !name.is_empty())
        .or_else(|| {
            model
                .and_then(|model| model.split('/').next())
                .map(str::to_string)
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "Profile".to_string());
    clamp(&plain, profiles::MAX_NAME_LEN)
}

/// The values a profile puts on the command line: its fields, or the `+set`
/// of its hand-written token line when it has one.
fn profile_values(profile: &PlayerProfile) -> ProfileValues {
    let Some(line) = profile.tokens_override.as_deref() else {
        return ProfileValues {
            nickname: profile.nickname.clone(),
            model: profile.model.clone(),
            saber1: profile.saber1.clone(),
            saber2: profile.saber2.clone(),
            color1: profile.color1.map(|color| color.to_string()),
            color2: profile.color2.map(|color| color.to_string()),
            char_color: profile
                .char_color
                .map(|tint| format!("{} {} {}", tint.red, tint.green, tint.blue)),
        };
    };
    // The engine joins a `+set` with every argument up to the next `+`
    // (`Com_StartupVariable`), and the last `+set` of a cvar wins.
    let tokens = crate::launch::split_args(line);
    let mut cvars: HashMap<String, String> = HashMap::new();
    let mut index = 0;
    while index < tokens.len() {
        let verb = tokens[index].to_ascii_lowercase();
        if (verb == "+set" || verb == "+seta") && index + 2 < tokens.len() {
            let name = tokens[index + 1].to_ascii_lowercase();
            let mut end = index + 2;
            while end < tokens.len() && !tokens[end].starts_with('+') {
                end += 1;
            }
            cvars.insert(name, tokens[index + 2..end].join(" "));
            index = end;
        } else {
            index += 1;
        }
    }
    let tint = match (
        cvars.get("char_color_red"),
        cvars.get("char_color_green"),
        cvars.get("char_color_blue"),
    ) {
        (Some(red), Some(green), Some(blue)) => Some(format!("{red} {green} {blue}")),
        _ => None,
    };
    ProfileValues {
        nickname: cvars.remove("name"),
        model: cvars.remove("model"),
        saber1: cvars.remove("saber1"),
        saber2: cvars.remove("saber2"),
        color1: cvars.remove("color1"),
        color2: cvars.remove("color2"),
        char_color: tint,
    }
}

/// A profile card of a stored player profile.
///
/// The nickname and the model are what a profile card is about, so a profile
/// without them is refused. The hilt and the blade colour the card has to
/// name fall back to the engine's defaults when the profile leaves them to
/// the engine. What the card carries is what the profile puts on the command
/// line: the hand-written token line when there is one.
pub(crate) fn card_from_profile(profile: &PlayerProfile) -> Result<Value> {
    let values = profile_values(profile);
    let nickname = values
        .nickname
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| refusal("The player profile has no nickname to share".to_string()))?;
    let model = values
        .model
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| refusal("The player profile has no model to share".to_string()))?;
    let card = ProfileCard {
        v: VERSION,
        fallback_text: String::new(),
        nickname,
        model,
        saber1: values.saber1.unwrap_or_else(|| DEFAULT_SABER1.to_string()),
        saber2: values.saber2,
        color1: values.color1.unwrap_or_else(|| DEFAULT_COLOR1.to_string()),
        color2: values.color2,
        char_color: values.char_color,
    };
    let value = serde_json::to_value(Card::Profile(card)).map_err(|e| refusal(e.to_string()))?;
    let mut cards = prepare(std::slice::from_ref(&value))?;
    Ok(cards.remove(0))
}

// ---------------------------------------------------------------------------
// Binds and configs
// ---------------------------------------------------------------------------

/// A bind or a config card, ready for the config editor.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardConfig {
    /// A new config document, `id` empty: the editor opens it and the player
    /// saves it with `save_config`.
    pub document: ConfigDocument,
    /// The lines of its text the player should read before saving it.
    pub dangers: Vec<Danger>,
    /// Keys of a bind card no config line can hold; they are not in the text.
    pub skipped: Vec<String>,
}

/// Key names as `bind` takes them; the rule of `appendBind` of the bind
/// editor.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'_' | b'+' | b'-' | b'[' | b']' | b'\\' | b'/' | b'.' | b',' | b'=' | b'\'')
        })
}

/// The config lines of a bind card, one per bind in its order, and the keys
/// that cannot be written.
///
/// A key is written in quotes, the way the engine writes its own
/// (`Key_WriteBindings`, `codemp/client/cl_keys.cpp:1105`), so `/` and `\`
/// stay keys. A binding cannot hold a double quote: `bind` takes its words
/// with the quotes stripped (`Cmd_ArgsFrom`, `cl_keys.cpp:1095`), so no key
/// of the game is ever bound to one, and the quotes of a card's command are
/// dropped. An empty command is `unbind`.
fn binds_text(binds: &[Bind]) -> (String, Vec<String>) {
    let mut lines = Vec::with_capacity(binds.len());
    let mut skipped = Vec::new();
    for bind in binds {
        if !valid_key(&bind.key) {
            skipped.push(bind.key.clone());
            continue;
        }
        let key = bind.key.to_ascii_uppercase();
        let command: String = bind
            .command
            .chars()
            .filter(|&c| c != '"' && c != '\n' && c != '\r')
            .collect();
        let command = command.trim();
        if command.is_empty() {
            lines.push(format!("unbind \"{key}\""));
        } else {
            lines.push(format!("bind \"{key}\" \"{command}\""));
        }
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    (text, skipped)
}

/// A name a config document can have: no control characters, at most 240
/// bytes, cut at a character.
fn document_name(raw: &str, fallback: &str) -> String {
    let name = stripped(raw);
    let name = if name.is_empty() { fallback.to_string() } else { name };
    let mut end = name.len().min(DOCUMENT_NAME_BYTES);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name[..end].trim_end().to_string()
}

/// A new config document for a bind or a config card, with its dangers.
pub(crate) fn config_from_card(card: &Card, game: Game) -> Result<CardConfig> {
    let (name, text, skipped) = match card {
        Card::Bind(card) => {
            let (text, skipped) = binds_text(&card.binds);
            (document_name(&card.fallback_text, BINDS_DOCUMENT_NAME), text, skipped)
        }
        Card::Config(card) => {
            let mut text = card.text.clone();
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            (document_name(&card.name, "config"), text, Vec::new())
        }
        _ => {
            return Err(AppError::InvalidInput(
                "only a bind or a config card opens in the config editor".into(),
            ))
        }
    };
    let dangers = scan_commands(&text);
    Ok(CardConfig {
        document: ConfigDocument {
            id: String::new(),
            name,
            game,
            text,
            source_client: None,
            source_file: None,
        },
        dangers,
        skipped,
    })
}

// ---------------------------------------------------------------------------
// The danger scan
// ---------------------------------------------------------------------------
//
// The command buffer of the engine, as far as the scan needs it; the same
// rules `src/lib/vstrChain.ts` follows for the bind editor, OpenJK
// `1a6a6434`:
//
// - `Cbuf_Execute` (codemp/qcommon/cmd.cpp:176) cuts the buffer at `;` and at
//   line breaks outside quotes. A `//` comment runs to the end of its line, a
//   block comment keeps its line together.
// - `vstr` (cmd.cpp:308) runs the value of a variable in place.
// - `set`, `seta`, `sets` and `setu` (cvar.cpp:1047) join every argument
//   after the name; `name value` sets a variable that exists (cvar.cpp:939).
// - `bind` (cl_keys.cpp:1073) stores the arguments after the key, and a press
//   (cl_keys.cpp:1224) cuts the binding at every `;`, quotes or not.

/// What a dangerous command does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DangerReason {
    /// `quit`: closes the game.
    Quit,
    /// `exec`, `execq`: runs another config file, which the scan cannot see.
    Exec,
    /// `writeconfig`: writes the configuration of the player to a file.
    WriteConfig,
    /// `rcon…`: the remote console of a server, its password or its address.
    Rcon,
    /// `connect`: joins a server.
    Connect,
    /// `reconnect`: joins the last server again.
    Reconnect,
    /// `unbindall`: wipes every bind of the player.
    UnbindAll,
    /// `cl_allowDownload`: lets servers push files into the game folder.
    AllowDownload,
    /// `fs_…`: where the game reads and writes its files.
    Filesystem,
    /// `sv_…`: a setting of a server.
    ServerCvar,
    /// `bind` inside a binding or a variable: a key press rebinds keys.
    NestedBind,
    /// The text is too large or its chains too deep to follow to the end;
    /// read it all before saving.
    TooComplex,
}

/// One command of a config or a bind that does something the player should
/// see before it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Danger {
    /// The line of the text, from 1, of the command that leads to it.
    pub line: u32,
    /// The command that does it, as written (at most 256 characters).
    pub command: String,
    pub reason: DangerReason,
    /// How that line reaches the command, outermost first: `bind KEY` for a
    /// key press and `vstr NAME` for a variable it runs. Empty when the line
    /// does it itself.
    pub via: Vec<String>,
}

/// Longest text the scan reads; the limit of a config document.
const SCAN_BYTES_MAX: usize = 1024 * 1024;
/// How deep bindings and `vstr` chains are followed.
const SCAN_DEPTH_MAX: usize = 12;
/// How many commands one scan looks at, nested ones included.
const SCAN_BUDGET: usize = 200_000;
/// How many values of one variable the scan remembers.
const VALUES_MAX: usize = 32;
/// How many variables the scan remembers.
const VARIABLES_MAX: usize = 4096;
/// How many dangers one scan names.
const DANGERS_MAX: usize = 500;
/// How much of a command a danger quotes.
const QUOTE_MAX: usize = 256;

const SET_VERBS: [&str; 4] = ["set", "seta", "sets", "setu"];
const WRITE_VERBS: [&str; 8] = [
    "toggle", "reset", "unset", "cvaradd", "cvarsub", "cvarmult", "cvardiv", "cvarmod",
];
/// Commands the engine and the game register: `name value` sets a variable
/// only when `name` is none of these (`Cmd_ExecuteString`, cmd.cpp:822). The
/// list of `vstrChain.ts`.
const COMMANDS: &[&str] = &[
    "set", "seta", "sets", "setu", "cvaradd", "cvarsub", "cvarmult", "cvardiv", "cvarmod",
    "exec", "execq", "alias", "cvar_restart", "unset_usercreated", "vstr", "wait", "echo",
    "bind", "unbind", "unbindall", "bindlist", "toggle", "reset", "unset", "print", "cvarlist",
    "cmdlist", "help", "writeconfig", "say", "say_team", "tell", "team", "kill", "follow", "quit",
    "disconnect", "connect", "reconnect", "record", "stoprecord", "demo", "screenshot",
    "screenshotjpeg", "vid_restart", "snd_restart", "cmd", "rcon", "toggleconsole", "togglemenu",
    "messagemode", "messagemode2", "messagemode3", "messagemode4", "clear",
];

/// A byte range of a text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    start: usize,
    end: usize,
}

fn blank(byte: u8) -> bool {
    byte <= b' '
}

fn push_span(out: &mut Vec<Span>, bytes: &[u8], mut start: usize, mut end: usize) {
    while start < end && blank(bytes[start]) {
        start += 1;
    }
    while end > start && blank(bytes[end - 1]) {
        end -= 1;
    }
    if start < end {
        out.push(Span { start, end });
    }
}

/// Splits config text or a variable's value into commands the way
/// `Cbuf_Execute` does. Blank lines and comments yield no command.
///
/// Every delimiter is ASCII, so the byte offsets always fall between
/// characters of the UTF-8 text.
fn split_commands(text: &str) -> Vec<Span> {
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut out = Vec::new();
    let mut pos = 0;
    let mut in_star = false;
    let mut in_slash = false;
    while pos < n {
        let mut quotes = 0u32;
        let mut comment: Option<usize> = None;
        let mut i = pos;
        while i < n {
            let c = bytes[i];
            if c == b'"' {
                quotes += 1;
            }
            if quotes & 1 == 0 {
                if i + 1 < n {
                    let next = bytes[i + 1];
                    if !in_star && c == b'/' && next == b'/' {
                        if !in_slash && comment.is_none() {
                            comment = Some(i);
                        }
                        in_slash = true;
                    } else if !in_slash && c == b'/' && next == b'*' {
                        if comment.is_none() {
                            comment = Some(i);
                        }
                        in_star = true;
                    } else if in_star && c == b'*' && next == b'/' {
                        in_star = false;
                        i += 1;
                        break;
                    }
                }
                if !in_slash && !in_star && c == b';' {
                    break;
                }
            }
            if !in_star && (c == b'\n' || c == b'\r') {
                in_slash = false;
                break;
            }
            i += 1;
        }
        push_span(&mut out, bytes, pos, comment.unwrap_or(i.min(n)));
        pos = i + 1;
    }
    out
}

/// Splits a key binding the way a key press does: at every `;`, quotes or
/// not, each part a line of its own for `Cbuf_Execute`.
fn split_binding(binding: &str) -> Vec<String> {
    let lines = binding.replace(';', "\n");
    split_commands(&lines)
        .into_iter()
        .map(|span| lines[span.start..span.end].to_string())
        .collect()
}

/// Splits one command into arguments the way `Cmd_TokenizeString` does.
fn tokenize(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let n = bytes.len();
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        loop {
            while i < n && blank(bytes[i]) {
                i += 1;
            }
            if i >= n {
                return out;
            }
            if bytes[i] == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
                return out;
            }
            if bytes[i] == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
                while i < n && !(bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/') {
                    i += 1;
                }
                if i >= n {
                    return out;
                }
                i += 2;
            } else {
                break;
            }
        }
        if bytes[i] == b'"' {
            let close = line[i + 1..].find('"').map(|at| at + i + 1);
            out.push(line[i + 1..close.unwrap_or(n)].to_string());
            match close {
                Some(close) => i = close + 1,
                None => return out,
            }
            continue;
        }
        let start = i;
        while i < n
            && !blank(bytes[i])
            && bytes[i] != b'"'
            && !(bytes[i] == b'/' && i + 1 < n && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*'))
        {
            i += 1;
        }
        out.push(line[start..i].to_string());
        if i >= n {
            return out;
        }
    }
}

/// Where each line of a text starts, for the line of an offset. A line ends
/// at `\n`, at `\r\n` and at a lone `\r`, as in the config editor.
struct Lines {
    starts: Vec<usize>,
}

impl Lines {
    fn new(text: &str) -> Self {
        let bytes = text.as_bytes();
        let mut starts = vec![0];
        for (index, &byte) in bytes.iter().enumerate() {
            let breaks = byte == b'\n' || (byte == b'\r' && bytes.get(index + 1) != Some(&b'\n'));
            if breaks {
                starts.push(index + 1);
            }
        }
        Lines { starts }
    }

    fn line_of(&self, offset: usize) -> u32 {
        let line = self.starts.partition_point(|&start| start <= offset);
        u32::try_from(line).unwrap_or(u32::MAX)
    }
}

/// How a text is cut into commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Config text or the value of a variable.
    Text,
    /// A key binding.
    Binding,
}

/// The commands of a nested text: a binding or a value of a variable.
fn split(text: &str, mode: Mode) -> Vec<String> {
    match mode {
        Mode::Text => split_commands(text)
            .into_iter()
            .map(|span| text[span.start..span.end].to_string())
            .collect(),
        Mode::Binding => split_binding(text),
    }
}

/// The variable a command writes when it is one the scan watches.
fn watched_cvar(name: &str) -> Option<DangerReason> {
    let name = name.to_ascii_lowercase();
    if name == "cl_allowdownload" {
        Some(DangerReason::AllowDownload)
    } else if name.starts_with("fs_") {
        Some(DangerReason::Filesystem)
    } else if name.starts_with("sv_") {
        Some(DangerReason::ServerCvar)
    } else if name.starts_with("rcon") {
        Some(DangerReason::Rcon)
    } else {
        None
    }
}

/// One command of the top level of the text, and what its chains reached.
struct Entry {
    line: u32,
    /// Variables this command already ran, so a chain that runs itself, or
    /// two chains that meet, are followed once.
    expanded: HashSet<String>,
}

impl Entry {
    fn at(line: u32) -> Self {
        Entry {
            line,
            expanded: HashSet::new(),
        }
    }
}

/// One scan of one text.
struct Scan {
    /// Every value each variable is given anywhere in the text, nested
    /// values included: a toggle hands a key its steps one press at a time,
    /// so any of them may be the one that runs.
    variables: HashMap<String, Vec<String>>,
    dangers: Vec<Danger>,
    seen: HashSet<(u32, DangerReason, String)>,
    budget: usize,
    /// The budget ran out or a chain went too deep: the answer is not whole.
    cut: bool,
}

impl Scan {
    fn new() -> Self {
        Scan {
            variables: HashMap::new(),
            dangers: Vec::new(),
            seen: HashSet::new(),
            budget: SCAN_BUDGET,
            cut: false,
        }
    }

    fn spend(&mut self) -> bool {
        if self.budget == 0 {
            self.cut = true;
            return false;
        }
        self.budget -= 1;
        true
    }

    fn remember(&mut self, name: &str, value: &str) {
        let name = name.to_ascii_lowercase();
        if self.variables.len() >= VARIABLES_MAX && !self.variables.contains_key(&name) {
            self.cut = true;
            return;
        }
        let values = self.variables.entry(name).or_default();
        if values.iter().any(|known| known == value) {
            return;
        }
        if values.len() >= VALUES_MAX {
            self.cut = true;
            return;
        }
        values.push(value.to_string());
    }

    /// Learns every value every variable is given.
    fn collect(&mut self, text: &str, mode: Mode, depth: usize) {
        for command in split(text, mode) {
            if !self.spend() {
                return;
            }
            let words = tokenize(&command);
            let Some(first) = words.first() else {
                continue;
            };
            let verb = first.to_ascii_lowercase();
            let nested = if SET_VERBS.contains(&verb.as_str()) && words.len() >= 3 {
                let value = words[2..].join(" ");
                self.remember(&words[1], &value);
                Some((value, Mode::Text))
            } else if verb == "bind" && words.len() >= 3 {
                Some((words[2..].join(" "), Mode::Binding))
            } else if !COMMANDS.contains(&verb.as_str())
                && !verb.starts_with(['+', '-'])
                && words.len() >= 2
            {
                let value = words[1..].join(" ");
                self.remember(&verb, &value);
                Some((value, Mode::Text))
            } else {
                None
            };
            if let Some((value, mode)) = nested {
                if depth < SCAN_DEPTH_MAX {
                    self.collect(&value, mode, depth + 1);
                } else {
                    self.cut = true;
                }
            }
        }
    }

    fn flag(&mut self, entry: &Entry, command: &str, reason: DangerReason, via: &[String]) {
        let command = clamp(command, QUOTE_MAX);
        if self.dangers.len() >= DANGERS_MAX
            || !self.seen.insert((entry.line, reason, command.clone()))
        {
            return;
        }
        self.dangers.push(Danger {
            line: entry.line,
            command,
            reason,
            via: via.to_vec(),
        });
    }

    fn check(
        &mut self,
        text: &str,
        mode: Mode,
        entry: &mut Entry,
        via: &mut Vec<String>,
        depth: usize,
    ) {
        for command in split(text, mode) {
            if self.budget == 0 {
                self.cut = true;
                return;
            }
            self.check_command(&command, entry, via, depth);
        }
    }

    fn check_command(&mut self, command: &str, entry: &mut Entry, via: &mut Vec<String>, depth: usize) {
        if !self.spend() {
            return;
        }
        let words = tokenize(command);
        let Some(first) = words.first() else {
            return;
        };
        let verb = first.to_ascii_lowercase();
        // A leading slash is how a player types a command at the console;
        // the scan reads `/quit` as `quit` rather than miss it.
        let name = verb.trim_start_matches(['/', '\\']);
        let direct = match name {
            "quit" => Some(DangerReason::Quit),
            "exec" | "execq" => Some(DangerReason::Exec),
            "writeconfig" => Some(DangerReason::WriteConfig),
            "connect" => Some(DangerReason::Connect),
            "reconnect" => Some(DangerReason::Reconnect),
            "unbindall" => Some(DangerReason::UnbindAll),
            _ if name.starts_with("rcon") => Some(DangerReason::Rcon),
            _ => None,
        };
        if let Some(reason) = direct {
            self.flag(entry, command, reason, via);
        }
        match name {
            "bind" if words.len() >= 3 => {
                if !via.is_empty() {
                    self.flag(entry, command, DangerReason::NestedBind, via);
                }
                if depth >= SCAN_DEPTH_MAX {
                    self.cut = true;
                    return;
                }
                via.push(format!("bind {}", words[1].to_ascii_uppercase()));
                let binding = words[2..].join(" ");
                self.check(&binding, Mode::Binding, entry, via, depth + 1);
                via.pop();
            }
            "vstr" if words.len() == 2 => {
                let variable = words[1].to_ascii_lowercase();
                if !entry.expanded.insert(variable.clone()) {
                    return;
                }
                let Some(values) = self.variables.get(&variable).cloned() else {
                    return;
                };
                if depth >= SCAN_DEPTH_MAX {
                    self.cut = true;
                    return;
                }
                via.push(format!("vstr {}", words[1]));
                for value in values {
                    self.check(&value, Mode::Text, entry, via, depth + 1);
                }
                via.pop();
            }
            _ => {
                let written = if SET_VERBS.contains(&name) {
                    (words.len() >= 3).then(|| words[1].as_str())
                } else if WRITE_VERBS.contains(&name) {
                    (words.len() >= 2).then(|| words[1].as_str())
                } else if !COMMANDS.contains(&name) && !name.starts_with(['+', '-']) {
                    (words.len() >= 2).then_some(name)
                } else {
                    None
                };
                if let Some(reason) = written.and_then(watched_cvar) {
                    self.flag(entry, command, reason, via);
                }
            }
        }
    }
}

/// Names every command of a config text, or of a bind as a config line, that
/// the player should read before it runs: the text itself, what its keys run
/// when pressed, and what its `vstr` chains reach.
///
/// A variable counts with every value the text gives it anywhere, so a toggle
/// that turns dangerous on its third press is named on the line that binds
/// it. A chain is followed once per line and at most 12 levels deep; a text
/// the scan cannot follow to the end ends with a [`DangerReason::TooComplex`]
/// on its first line.
pub(crate) fn scan_commands(text: &str) -> Vec<Danger> {
    let mut scan = Scan::new();
    scan.collect(text, Mode::Text, 0);
    // Learning the variables and checking the lines each get the whole
    // budget: a text whose variables took it all is still checked.
    scan.budget = SCAN_BUDGET;
    let lines = Lines::new(text);
    let spans = split_commands(text);
    for span in &spans {
        let command = &text[span.start..span.end];
        let mut entry = Entry::at(lines.line_of(span.start));
        scan.check_command(command, &mut entry, &mut Vec::new(), 0);
        if scan.budget == 0 {
            scan.cut = true;
            break;
        }
    }
    if scan.cut {
        let (line, command) = spans
            .first()
            .map(|span| (lines.line_of(span.start), &text[span.start..span.end]))
            .unwrap_or((1, ""));
        // Past the cap of dangers the note still has to be there.
        scan.dangers.truncate(DANGERS_MAX - 1);
        scan.flag(&Entry::at(line), command, DangerReason::TooComplex, &[]);
    }
    scan.dangers
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Cleans a card a window built, fills in `v` and an English `fallbackText`
/// when it left them out, and answers it as `chat_send` would send it. A
/// card the service would refuse is refused here, as `online` with
/// `details.code` `card`.
#[tauri::command]
pub async fn chat_build_card(card: Value) -> Result<Value> {
    let mut cards = prepare(std::slice::from_ref(&card))?;
    Ok(cards.remove(0))
}

/// Checks a card of a message before a window acts on it: the same rules as
/// on the service, fields this launcher does not know left out. The answer
/// is the card as the existing commands take it.
#[tauri::command]
pub async fn chat_check_card(card: Value) -> Result<Value> {
    let card = check(&card)?;
    serde_json::to_value(card).map_err(|e| refusal(e.to_string()))
}

/// A profile card of a player profile, ready for `chat_send`.
#[tauri::command]
pub async fn chat_card_from_profile(profile: PlayerProfile) -> Result<Value> {
    card_from_profile(&profile)
}

/// A profile card as a new player profile for the profile form. Nothing is
/// saved: the player saves the form into a client.
#[tauri::command]
pub async fn chat_card_to_profile(card: Value) -> Result<CardProfile> {
    match check(&card)? {
        Card::Profile(card) => Ok(profile_from_card(&card)),
        _ => Err(AppError::InvalidInput("not a profile card".into())),
    }
}

/// A bind or a config card as a new config document for the config editor,
/// with the lines to read first. Nothing is saved: the player saves the
/// editor. `game` is the game the document is for, the active one when left
/// out.
#[tauri::command]
pub async fn chat_card_to_config(
    state: tauri::State<'_, AppState>,
    card: Value,
    game: Option<Game>,
) -> Result<CardConfig> {
    let game = state.settings()?.game_or_active(game);
    config_from_card(&check(&card)?, game)
}

/// The dangerous commands of a config text or of a bind line, for the
/// editor to mark before the player saves.
#[tauri::command]
pub async fn chat_scan_commands(text: String) -> Result<Vec<Danger>> {
    if text.len() > SCAN_BYTES_MAX {
        return Err(AppError::InvalidInput(format!(
            "a config to check is at most {SCAN_BYTES_MAX} bytes"
        )));
    }
    Ok(scan_commands(&text))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn one(card: Value) -> std::result::Result<Value, String> {
        prepare(&[card])
            .map(|mut cards| cards.remove(0))
            .map_err(|e| e.to_string())
    }

    fn server(address: &str) -> Value {
        json!({ "type": "server", "v": 1, "fallbackText": "Server", "address": address,
                "name": "FFA", "game": "ja" })
    }

    fn reasons(text: &str) -> Vec<(u32, DangerReason)> {
        scan_commands(text)
            .into_iter()
            .map(|danger| (danger.line, danger.reason))
            .collect()
    }

    // --- building -----------------------------------------------------------

    #[test]
    fn a_card_is_cleaned_and_gets_its_version_and_fallback() {
        let card = one(json!({
            "type": "server", "address": " 203.0.113.10:29070 ", "name": "FFA \u{202E}duel\u{0007}",
            "game": "ja", "map": "mp/ffa3", "gametype": 0, "mod": ""
        }))
        .unwrap();
        assert_eq!(
            card,
            json!({ "type": "server", "v": 1, "fallbackText": "Server: FFA duel (203.0.113.10:29070)",
                    "address": "203.0.113.10:29070", "name": "FFA duel", "game": "ja",
                    "map": "mp/ffa3", "gametype": 0 })
        );
        // A fallback the window wrote is kept, cleaned and cut.
        let mut localized = server("203.0.113.10:29070");
        localized["fallbackText"] = json!(format!(" Сервер {}", "я".repeat(300)));
        let card = one(localized).unwrap();
        let fallback = card["fallbackText"].as_str().unwrap();
        assert!(fallback.starts_with("Сервер "));
        assert_eq!(fallback.chars().count(), FALLBACK_MAX);
    }

    #[test]
    fn a_server_address_is_public_or_private_but_never_local() {
        for good in [
            "203.0.113.10:29070",
            "192.168.1.23:29070",
            "server.example.com:29070",
            "jka-1.example.com:65535",
        ] {
            assert!(one(server(good)).is_ok(), "{good} is an address");
        }
        for bad in [
            "127.0.0.1:29070",
            "0.0.0.0:29070",
            "169.254.1.1:29070",
            "224.0.0.1:29070",
            "255.255.255.255:29070",
            "localhost:29070",
            "game.localhost:29070",
            "203.0.113.10",
            "203.0.113.10:0",
            "203.0.113.10:70000",
            "[::1]:29070",
            "999.1.1.1:29070",
            "bad_host:29070",
            "",
        ] {
            assert!(one(server(bad)).is_err(), "{bad:?} is refused");
        }
    }

    #[test]
    fn an_unknown_type_version_or_field_is_refused_on_the_way_out() {
        assert!(one(json!({ "type": "poll", "v": 1, "fallbackText": "?" })).is_err());
        let mut newer = server("203.0.113.10:29070");
        newer["v"] = json!(2);
        assert!(one(newer).unwrap_err().contains("version"));
        let mut extra = server("203.0.113.10:29070");
        extra["password"] = json!("k7m2q9xa");
        assert!(one(extra).unwrap_err().contains("password"));
        assert!(one(json!("server")).is_err());
        let refusal = prepare(&[json!({ "type": "poll" })]).unwrap_err();
        assert_eq!(refusal.code(), "online");
        assert_eq!(refusal.details()["code"], CARD);
    }

    #[test]
    fn a_host_invite_goes_out_with_its_session_and_name_only() {
        let card = one(json!({
            "type": "hostInvite", "sessionId": "5E0B7C1F9A2D4C38", "name": "Kyle's duels",
            "hostId": "somebody", "game": "jo", "map": "mp/evil", "gametype": 7
        }))
        .unwrap();
        assert_eq!(
            card,
            json!({ "type": "hostInvite", "v": 1, "fallbackText": "Join my server: Kyle's duels",
                    "sessionId": "5e0b7c1f9a2d4c38", "name": "Kyle's duels" })
        );
        assert!(one(json!({ "type": "hostInvite", "sessionId": "5e0b" })).is_err());
        let mut with_password = card.clone();
        with_password["password"] = json!("k7m2q9xa");
        assert!(one(with_password).is_err());
        let mut with_address = card;
        with_address["relayAddress"] = json!("203.0.113.7:29070");
        assert!(one(with_address).is_err());
    }

    #[test]
    fn bundle_mod_and_map_cards_check_their_formats() {
        let bundle = one(json!({ "type": "bundle", "bundleId": "01hzx4g6q2kj3m5n7p8r9s0t1v",
            "slug": "duel-pack", "name": "Duel pack", "game": "ja" }))
        .unwrap();
        assert_eq!(bundle["bundleId"], "01HZX4G6Q2KJ3M5N7P8R9S0T1V");
        assert_eq!(bundle["fallbackText"], "Bundle: Duel pack");
        for bad_id in ["not-a-ulid", "81HZX4G6Q2KJ3M5N7P8R9S0T1V", "01HZX4G6Q2KJ3M5N7P8R9S0T1I"] {
            assert!(one(json!({ "type": "bundle", "bundleId": bad_id, "slug": "duel-pack",
                "name": "Duel pack", "game": "ja" }))
            .is_err());
        }

        let jkhub = json!({ "type": "jkhubMod", "fileId": 1234, "slug": "1234-duel-sabers",
            "title": "Duel sabers", "game": "ja" });
        assert_eq!(one(jkhub.clone()).unwrap()["fallbackText"], "JKHub: Duel sabers");
        for (field, value) in [
            ("fileId", json!(0)),
            ("fileId", json!(-3)),
            ("fileId", json!(u64::from(u32::MAX) + 1)),
            ("slug", json!("a b")),
            ("game", json!("jk2")),
            ("title", json!(" ")),
        ] {
            let mut bad = jkhub.clone();
            bad[field] = value.clone();
            assert!(one(bad).is_err(), "{field} = {value}");
        }

        let map = |name: &str| one(json!({ "type": "map", "game": "ja", "name": name }));
        assert_eq!(map("mp/ffa3").unwrap()["fallbackText"], "Map: mp/ffa3");
        assert!(map("t2_trip").is_ok());
        for bad in ["", "../base/mp/ffa3", "mp/ffa3.bsp", "mp ffa3", "mp\\ffa3"] {
            assert!(map(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn binds_and_configs_keep_their_limits() {
        let binds = |binds: Value| one(json!({ "type": "bind", "binds": binds }));
        assert_eq!(
            binds(json!([{ "key": "MOUSE1", "command": "+attack" }])).unwrap()["fallbackText"],
            "Bind MOUSE1: +attack"
        );
        assert!(binds(json!([])).is_err());
        assert!(binds(json!([{ "key": "x", "command": "say\u{0}hi" }])).is_err());
        assert!(binds(json!([{ "key": "", "command": "say hi" }])).is_err());
        assert!(binds(json!([{ "key": "x", "command": "c".repeat(1025) }])).is_err());
        assert!(binds(json!([{ "key": "x", "command": "wait", "note": "?" }])).is_err());
        let fifty: Vec<Value> = (0..51)
            .map(|index| json!({ "key": format!("F{index}"), "command": "wait" }))
            .collect();
        assert!(binds(json!(fifty)).is_err());

        let config = |text: &str| one(json!({ "type": "config", "name": "duel.cfg", "text": text }));
        let kept = config("seta name \"Kyle\"\r\n\tbind x +attack\u{0007}\n").unwrap();
        assert_eq!(kept["text"], "seta name \"Kyle\"\r\n\tbind x +attack");
        assert_eq!(kept["fallbackText"], "Config: duel.cfg");
        assert!(config("seta a\u{0}").is_err());
        assert!(config(&"a".repeat(CONFIG_TEXT_MAX)).is_ok());
        assert!(config(&"a".repeat(CONFIG_TEXT_MAX + 1)).is_err());
    }

    #[test]
    fn a_message_holds_five_cards_of_limited_size() {
        let six = vec![server("203.0.113.10:29070"); 6];
        assert!(prepare(&six).is_err());
        assert_eq!(prepare(&six[..5]).unwrap().len(), 5);
        let big: Vec<Value> = (0..50)
            .map(|index| json!({ "key": format!("F{index}"), "command": "c".repeat(200) }))
            .collect();
        let binds = json!({ "type": "bind", "binds": big });
        assert!(prepare(&[binds]).unwrap_err().to_string().contains("larger"));
        let config = json!({ "type": "config", "name": "big.cfg", "text": "a".repeat(30 * 1024) });
        assert!(prepare(std::slice::from_ref(&config)).is_ok());
        assert!(prepare(&[config.clone(), config]).is_err());
    }

    #[test]
    fn an_incoming_card_ignores_fields_it_does_not_know_and_keeps_the_host() {
        let card = check(&json!({
            "type": "hostInvite", "v": 1, "fallbackText": "Join", "sessionId": "5e0b7c1f9a2d4c38",
            "hostId": "01HZX4G6Q2KJ3M5N7P8R9S0T1V", "game": "ja", "mod": null, "map": "mp/ffa3",
            "gametype": 0, "addedLater": true
        }))
        .unwrap();
        let Card::HostInvite(invite) = card else {
            panic!("a host invite");
        };
        assert_eq!(invite.host_id.as_deref(), Some("01HZX4G6Q2KJ3M5N7P8R9S0T1V"));
        assert_eq!(invite.map.as_deref(), Some("mp/ffa3"));
        // An incoming card still meets the rules of its values.
        assert!(check(&json!({ "type": "server", "v": 1, "fallbackText": "", "address": "127.0.0.1:29070",
            "name": "x", "game": "ja" }))
        .is_err());
        assert!(check(&json!({ "type": "server", "v": 2, "fallbackText": "", "address": "203.0.113.10:29070",
            "name": "x", "game": "ja" }))
        .is_err());
    }

    // --- profiles -----------------------------------------------------------

    fn profile_card(fields: Value) -> ProfileCard {
        let mut card = json!({ "type": "profile", "v": 1, "fallbackText": "Look",
            "nickname": "^1Kyle", "model": "kyle/default", "saber1": "single_1", "color1": "4" });
        for (key, value) in fields.as_object().unwrap() {
            card[key] = value.clone();
        }
        match check(&card).unwrap() {
            Card::Profile(card) => card,
            other => panic!("a profile card, not {other:?}"),
        }
    }

    #[test]
    fn a_profile_card_becomes_a_new_profile() {
        let card = profile_card(json!({ "saber2": "none", "color2": "5", "charColor": "255 128 0" }));
        let CardProfile { profile, skipped } = profile_from_card(&card);
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(profile.id, "");
        assert_eq!(profile.name, "Kyle");
        assert_eq!(profile.nickname.as_deref(), Some("^1Kyle"));
        assert_eq!(profile.model.as_deref(), Some("kyle/default"));
        assert_eq!(profile.saber1.as_deref(), Some("single_1"));
        assert_eq!(profile.saber2.as_deref(), Some("none"));
        assert_eq!((profile.color1, profile.color2), (Some(4), Some(5)));
        assert_eq!(
            profile.char_color,
            Some(CharColor { red: 255, green: 128, blue: 0 })
        );
        assert_eq!(profile.tokens_override, None);
    }

    #[test]
    fn a_profile_value_the_profile_rules_refuse_is_left_blank_and_named() {
        let card = profile_card(json!({
            // 20 Cyrillic letters are 40 bytes, past the 36 the engine keeps.
            "nickname": "Я".repeat(20),
            "model": "../kyle",
            "color1": "9",
            "color2": "blue",
            "charColor": "255 255",
        }));
        let CardProfile { profile, skipped } = profile_from_card(&card);
        assert_eq!(skipped, ["nickname", "model", "color1", "color2", "charColor"]);
        assert_eq!(profile.nickname, None);
        assert_eq!(profile.model, None);
        assert_eq!(profile.saber1.as_deref(), Some("single_1"));
        assert_eq!((profile.color1, profile.color2, profile.char_color), (None, None, None));
        // Nothing left to name it by: the form still opens.
        assert_eq!(profile.name, "Profile");
    }

    #[test]
    fn a_stored_profile_becomes_a_profile_card_and_back() {
        let stored = PlayerProfile {
            id: "duelist".into(),
            name: "Duelist".into(),
            nickname: Some("^4Mara".into()),
            model: Some("jedi_hf/head_a1|torso_a1|lower_a1".into()),
            saber1: Some("single_4".into()),
            saber2: None,
            color1: Some(2),
            color2: Some(3),
            char_color: Some(CharColor { red: 10, green: 20, blue: 30 }),
            tokens_override: None,
        };
        let card = card_from_profile(&stored).unwrap();
        assert_eq!(
            card,
            json!({ "type": "profile", "v": 1, "fallbackText": "Player profile: Mara",
                    "nickname": "^4Mara", "model": "jedi_hf/head_a1|torso_a1|lower_a1",
                    "saber1": "single_4", "color1": "2", "color2": "3", "charColor": "10 20 30" })
        );
        let Card::Profile(card) = check(&card).unwrap() else {
            panic!("a profile card");
        };
        let back = profile_from_card(&card);
        assert!(back.skipped.is_empty());
        assert_eq!(
            PlayerProfile { id: stored.id.clone(), name: stored.name.clone(), ..back.profile },
            stored
        );
    }

    #[test]
    fn a_profile_without_a_hilt_or_a_colour_shares_the_engine_defaults() {
        let bare = PlayerProfile {
            id: String::new(),
            name: "Plain".into(),
            nickname: Some("Kyle".into()),
            model: Some("kyle".into()),
            saber1: None,
            saber2: None,
            color1: None,
            color2: None,
            char_color: None,
            tokens_override: None,
        };
        let card = card_from_profile(&bare).unwrap();
        assert_eq!((card["saber1"].as_str(), card["color1"].as_str()), (Some("Kyle"), Some("4")));
        assert!(card.get("saber2").is_none() && card.get("charColor").is_none());

        let nameless = PlayerProfile { nickname: None, ..bare.clone() };
        let refusal = card_from_profile(&nameless).unwrap_err();
        assert_eq!(refusal.details()["code"], CARD);
        assert!(card_from_profile(&PlayerProfile { model: None, ..bare.clone() }).is_err());
        // A nickname the card cannot carry is refused, not cut.
        assert!(card_from_profile(&PlayerProfile { nickname: Some("a;quit".into()), ..bare }).is_err());
    }

    #[test]
    fn a_hand_written_token_line_is_what_the_card_carries() {
        let profile = PlayerProfile {
            id: String::new(),
            name: "Line".into(),
            nickname: Some("Ignored".into()),
            model: Some("ignored".into()),
            saber1: None,
            saber2: None,
            color1: None,
            color2: None,
            char_color: None,
            tokens_override: Some(
                "+set name \"Kyle Katarn\" +set model kyle/default +seta color1 3 \
                 +set char_color_red 1 +set char_color_green 2 +set char_color_blue 3"
                    .into(),
            ),
        };
        let card = card_from_profile(&profile).unwrap();
        assert_eq!(card["nickname"], "Kyle Katarn");
        assert_eq!(card["model"], "kyle/default");
        assert_eq!(card["color1"], "3");
        assert_eq!(card["charColor"], "1 2 3");
    }

    // --- configs ------------------------------------------------------------

    #[test]
    fn a_bind_card_becomes_config_lines_with_its_dangers() {
        let card = check(&json!({ "type": "bind", "v": 1, "fallbackText": "Duel keys", "binds": [
            { "key": "f1", "command": "say \"gg\"; +attack" },
            { "key": "\\", "command": "toggleconsole" },
            { "key": "bad key", "command": "quit" },
            { "key": "F2", "command": "" },
            { "key": "F3", "command": "quit" },
        ] }))
        .unwrap();
        let config = config_from_card(&card, Game::JediAcademy).unwrap();
        assert_eq!(config.document.name, "Duel keys");
        assert_eq!(config.document.id, "");
        assert_eq!(config.document.game, Game::JediAcademy);
        assert_eq!(
            config.document.text,
            "bind \"F1\" \"say gg; +attack\"\nbind \"\\\" \"toggleconsole\"\nunbind \"F2\"\nbind \"F3\" \"quit\"\n"
        );
        assert_eq!(config.skipped, ["bad key"]);
        assert_eq!(
            config.dangers,
            [Danger {
                line: 4,
                command: "quit".into(),
                reason: DangerReason::Quit,
                via: vec!["bind F3".into()],
            }]
        );
        // The text reads back as the binds it was made of.
        let words: Vec<Vec<String>> = split_commands(&config.document.text)
            .into_iter()
            .map(|span| tokenize(&config.document.text[span.start..span.end]))
            .collect();
        assert_eq!(words[0], ["bind", "F1", "say gg; +attack"]);
        assert_eq!(words[1], ["bind", "\\", "toggleconsole"]);
    }

    #[test]
    fn a_config_card_opens_as_its_text() {
        let card = check(&json!({ "type": "config", "v": 1, "fallbackText": "",
            "name": "duel.cfg", "text": "seta cl_allowDownload 1\nbind x \"exec evil\"" }))
        .unwrap();
        let config = config_from_card(&card, Game::JediOutcast).unwrap();
        assert_eq!(config.document.name, "duel.cfg");
        assert_eq!(config.document.game, Game::JediOutcast);
        assert!(config.document.text.ends_with('\n'));
        let found: Vec<(u32, DangerReason)> =
            config.dangers.iter().map(|d| (d.line, d.reason)).collect();
        assert_eq!(found, [(1, DangerReason::AllowDownload), (2, DangerReason::Exec)]);
        assert!(config_from_card(&check(&server("203.0.113.10:29070")).unwrap(), Game::JediAcademy).is_err());
    }

    #[test]
    fn a_document_name_fits_the_config_book() {
        assert_eq!(document_name("  duel.cfg ", "config"), "duel.cfg");
        assert_eq!(document_name(" \u{0007} ", "config"), "config");
        let long = document_name(&"я".repeat(200), "config");
        assert!(long.len() <= DOCUMENT_NAME_BYTES && long.chars().all(|c| c == 'я'));
    }

    // --- the danger scan ----------------------------------------------------

    #[test]
    fn every_listed_command_is_named() {
        let text = "quit\n\
                    exec autoexec.cfg\n\
                    writeconfig mine\n\
                    rcon status\n\
                    connect 203.0.113.5\n\
                    reconnect\n\
                    unbindall\n\
                    seta cl_allowDownload 1\n\
                    set fs_game evil\n\
                    sv_cheats 1\n\
                    seta rconPassword secret\n\
                    execq other\n\
                    /quit\n";
        assert_eq!(
            reasons(text),
            [
                (1, DangerReason::Quit),
                (2, DangerReason::Exec),
                (3, DangerReason::WriteConfig),
                (4, DangerReason::Rcon),
                (5, DangerReason::Connect),
                (6, DangerReason::Reconnect),
                (7, DangerReason::UnbindAll),
                (8, DangerReason::AllowDownload),
                (9, DangerReason::Filesystem),
                (10, DangerReason::ServerCvar),
                (11, DangerReason::Rcon),
                (12, DangerReason::Exec),
                (13, DangerReason::Quit),
            ]
        );
    }

    #[test]
    fn ordinary_configs_are_quiet() {
        let text = "// my duel config\n\
                    seta name \"^1Kyle\"\n\
                    bind MOUSE1 +attack\n\
                    bind F1 \"say gg; wait; say quit is not a command here\"\n\
                    set duel \"say duel?\"\n\
                    bind F2 vstr duel\n\
                    echo quit\n\
                    fs_game\n\
                    cg_fov 110 // quit in a comment\n\
                    /* exec in a\n block comment */\n";
        assert_eq!(scan_commands(text), []);
    }

    #[test]
    fn what_a_key_runs_is_named_on_its_bind_line() {
        let dangers = scan_commands("bind x \"say bye; quit\"\nbind y \"bind z exec evil\"\n");
        assert_eq!(
            dangers,
            [
                Danger {
                    line: 1,
                    command: "quit".into(),
                    reason: DangerReason::Quit,
                    via: vec!["bind X".into()],
                },
                Danger {
                    line: 2,
                    command: "bind z exec evil".into(),
                    reason: DangerReason::NestedBind,
                    via: vec!["bind Y".into()],
                },
                Danger {
                    line: 2,
                    command: "exec evil".into(),
                    reason: DangerReason::Exec,
                    via: vec!["bind Y".into(), "bind Z".into()],
                },
            ]
        );
    }

    #[test]
    fn a_binding_is_cut_at_every_semicolon_even_in_quotes() {
        // In the config the quotes hold the line together, so this is one
        // command; the key press cuts the binding again, and `quit` runs.
        assert_eq!(
            scan_commands("bind x \"say a;quit\"\n"),
            [Danger {
                line: 1,
                command: "quit".into(),
                reason: DangerReason::Quit,
                via: vec!["bind X".into()],
            }]
        );
    }

    #[test]
    fn vstr_chains_are_followed() {
        let text = "set a \"say hi; vstr b\"\n\
                    set b \"vstr c\"\n\
                    set c \"seta fs_game evil\"\n\
                    bind x vstr a\n";
        let dangers = scan_commands(text);
        assert_eq!(
            dangers,
            [Danger {
                line: 4,
                command: "seta fs_game evil".into(),
                reason: DangerReason::Filesystem,
                via: vec!["bind X".into(), "vstr a".into(), "vstr b".into(), "vstr c".into()],
            }]
        );
        // A value set after the line that runs it counts too: the key is
        // pressed long after the config ran.
        assert_eq!(
            reasons("vstr later\nset later quit\n"),
            [(1, DangerReason::Quit)]
        );
    }

    #[test]
    fn a_toggle_is_dangerous_when_any_of_its_steps_is() {
        let text = "set t1 \"say on; set t vstr t2\"\n\
                    set t2 \"say off; set t vstr t3\"\n\
                    set t3 \"connect 203.0.113.9; set t vstr t1\"\n\
                    set t vstr t1\n\
                    bind v vstr t\n";
        let found = reasons(text);
        assert!(found.contains(&(5, DangerReason::Connect)), "{found:?}");
        // The line of the variable itself runs nothing on its own.
        assert!(found.iter().all(|(line, _)| *line == 4 || *line == 5), "{found:?}");
    }

    #[test]
    fn a_bind_inside_a_variable_is_a_nested_bind() {
        let text = "set menu \"bind 1 say one; bind 2 unbindall\"\nbind m vstr menu\n";
        let found: Vec<(u32, DangerReason, String)> = scan_commands(text)
            .into_iter()
            .map(|danger| (danger.line, danger.reason, danger.command))
            .collect();
        assert_eq!(
            found,
            [
                (2, DangerReason::NestedBind, "bind 1 say one".to_string()),
                (2, DangerReason::NestedBind, "bind 2 unbindall".to_string()),
                (2, DangerReason::UnbindAll, "unbindall".to_string()),
            ]
        );
    }

    #[test]
    fn loops_end_and_deep_chains_say_the_scan_stopped() {
        // A variable that runs itself: followed once.
        assert_eq!(scan_commands("set loop \"say x; vstr loop\"\nvstr loop\n"), []);
        // A chain deeper than the scan follows.
        let mut text = String::new();
        for index in 0..20 {
            text.push_str(&format!("set v{index} \"vstr v{}\"\n", index + 1));
        }
        text.push_str("set v20 quit\nvstr v0\n");
        let found = scan_commands(&text);
        assert!(
            found.iter().any(|danger| danger.reason == DangerReason::TooComplex && danger.line == 1),
            "{found:?}"
        );
    }

    #[test]
    fn a_huge_text_stops_with_a_note() {
        let text = "bind x \"say a; say b; say c; say d\"\n".repeat(60_000);
        let found = scan_commands(&text);
        assert_eq!(found.last().map(|danger| danger.reason), Some(DangerReason::TooComplex));
    }

    #[test]
    fn lines_count_like_the_editor() {
        let text = "say a\r\nsay b\rquit\n\nconnect x";
        assert_eq!(
            reasons(text),
            [(3, DangerReason::Quit), (5, DangerReason::Connect)]
        );
        // Two commands on one line are named on that line.
        assert_eq!(
            reasons("say hi; quit; exec x\n"),
            [(1, DangerReason::Quit), (1, DangerReason::Exec)]
        );
    }

    #[test]
    fn the_tokenizer_follows_the_engine() {
        assert_eq!(tokenize("bind x \"say hi\""), ["bind", "x", "say hi"]);
        assert_eq!(tokenize("  say  hi // quit"), ["say", "hi"]);
        assert_eq!(tokenize("say /* quit */ hi"), ["say", "hi"]);
        assert_eq!(tokenize("say \"open"), ["say", "open"]);
        assert_eq!(tokenize("a\"b\""), ["a", "b"]);
        assert_eq!(tokenize("сказать привет"), ["сказать", "привет"]);
        let text = "a; b // c; d\n\"e; f\"; g /* h\n i */ j";
        let spans: Vec<&str> = split_commands(text)
            .into_iter()
            .map(|span| &text[span.start..span.end])
            .collect();
        assert_eq!(spans, ["a", "b", "\"e; f\"", "g", "j"]);
    }

    #[test]
    fn dangers_reach_the_frontend_in_camel_case_with_snake_case_reasons() {
        let json = serde_json::to_value(scan_commands("bind x writeconfig a\n")).unwrap();
        assert_eq!(
            json,
            json!([{ "line": 1, "command": "writeconfig a", "reason": "write_config", "via": ["bind X"] }])
        );
    }
}
