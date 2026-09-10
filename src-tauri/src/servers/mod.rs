//! The server browser.
//!
//! One refresh is three stages. First both master servers are asked for their
//! address lists over UDP; the lists are merged and deduplicated. Then every
//! address is sent a `getinfo` with a bounded number of requests in flight,
//! and the round trip time of that request is the ping the browser shows.
//! Last, the servers that did not publish `g_humanplayers` get a `getstatus`,
//! because their player list is the only place a bot can be told from a
//! person — see [`ServerInfo::apply_status`].
//!
//! Everything the launcher calls a player count is a count of people. Bots are
//! carried alongside in [`ServerInfo::bots`] and shown as a suffix, never
//! added in. [`PlayersSource`] says how sure a given row is.
//!
//! Results do not wait for the slowest server: they are pushed to the window
//! in batches through the `servers:batch` event while the refresh runs, and
//! `servers:done` closes it. The command returns the full list as well, so a
//! caller that does not listen still gets everything.
//!
//! The last successful list is written to `cache\servers.json`, which is what
//! `get_cached_servers` returns. A player who opens the launcher sees the
//! previous list immediately and watches it get replaced row by row.
//!
//! The wire formats live in [`protocol`] and the sockets in [`net`]; this
//! module only decides what to ask and what to keep.

mod net;
mod protocol;

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::net::SocketAddrV4;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::{AppError, Result};
use crate::game::Game;
use crate::settings::{ServerHistoryEntry, Settings};
use crate::state::AppState;
use crate::timestamp;

use protocol::{parse_infostring, strip_colors, PROTOCOL_VERSION};

/// How long one master server has to deliver its whole address list.
const MASTER_TIMEOUT: Duration = Duration::from_millis(1_500);

/// How long one server has to answer a single `getinfo`.
const INFO_TIMEOUT: Duration = Duration::from_millis(1_000);

/// Requests per server: the first one and one retry. A single lost datagram
/// is the common failure on a UDP scan of a thousand hosts.
const INFO_ATTEMPTS: u32 = 2;

/// Requests allowed in flight at once. Each one holds a socket, and a home
/// router with a small NAT table drops the overflow instead of forwarding it.
const MAX_IN_FLIGHT: usize = 64;

/// How long one server has to answer a `getstatus`.
const STATUS_TIMEOUT: Duration = Duration::from_millis(1_500);

/// How many servers one refresh may ask for a player list.
///
/// The second pass exists only for servers that hide `g_humanplayers`, and the
/// busiest of them go first. A cap keeps a refresh bounded even on the day
/// every server on the master list turns out to be a vanilla 1.01 build.
const MAX_STATUS_QUERIES: usize = 150;

/// How often the collected rows are pushed to the window during a refresh.
const BATCH_INTERVAL: Duration = Duration::from_millis(100);

/// How many addresses `server_history` keeps.
const HISTORY_LIMIT: usize = 50;

// --- slice: game core ---
/// The cache document of the one-game era, migrated to `servers-ja.json` the
/// first time the Jedi Academy list is read or written.
const LEGACY_CACHE_FILE: &str = "servers.json";

/// Where the human and bot counts of a row came from.
///
/// The browser shows real players, so it has to say how sure it is. A row that
/// never got past [`PlayersSource::Unknown`] is a server that hides
/// `g_humanplayers` and did not answer `getstatus` either; its `clients` still
/// includes bots and the screen keeps that number rather than inventing one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayersSource {
    /// The `infoResponse`: either `g_humanplayers` was there, or the server
    /// reported nobody at all, which needs no second question.
    Info,
    /// The extra `getstatus` of a refresh: a player with ping 0 is a bot.
    Status,
    /// Neither answered the question.
    #[default]
    Unknown,
}

/// One row of the browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    // --- slice: game core ---
    /// Which game this server runs. A row comes from the master list of one
    /// game, so it is never in doubt — and it decides which gametype table
    /// named [`ServerInfo::gametype_label`] and which map picture the row gets.
    /// A cached row written before the field existed reads as Jedi Academy.
    #[serde(default, deserialize_with = "game_of_cached_row")]
    pub game: Game,
    /// `ip:port`, the key of the row everywhere in the launcher.
    pub address: String,
    /// Host name exactly as the server sent it, colour codes included.
    pub hostname_raw: String,
    /// The same name with `^1`-style colour codes removed.
    pub hostname_clean: String,
    /// Map the server is running, lowercased: `mp/ffa3`. Operators type
    /// `mapname` in any case they like and the game does not care, so the row
    /// carries the canonical spelling — it is also the key of the map picture.
    pub map: String,
    /// `gametype` key of the info string.
    pub gametype: u8,
    /// Label of `gametype`, or `Mode <n>` for a number a mod invented.
    pub gametype_label: String,
    /// Players the server counts, bots included. This is the only number a
    /// vanilla 1.01 server publishes, and it is not what the browser shows.
    pub clients: u16,
    /// Real players: what every count, filter and sort in the launcher means
    /// by "players". `None` while [`ServerInfo::players_source`] is
    /// [`PlayersSource::Unknown`].
    pub humans: Option<u16>,
    /// Bots among the `clients`. `None` alongside an unknown `humans`.
    #[serde(default)]
    pub bots: Option<u16>,
    /// How `humans` and `bots` were established.
    #[serde(default)]
    pub players_source: PlayersSource,
    /// Slots offered to the public, private slots already subtracted.
    pub max_clients: u16,
    pub needpass: bool,
    // --- slice: game core ---
    /// `fs_game` of the server, `base` when the key is absent or empty.
    ///
    /// Called `game` on the wire until 0.3, when [`ServerInfo::game`] took the
    /// name for the thing it actually describes. This one is the mod folder.
    /// A row from a 0.2 cache has no `modName` and reads as `base` until the
    /// next refresh answers with the real one.
    #[serde(default = "base_mod")]
    pub mod_name: String,
    /// Network protocol: 26 is Jedi Academy 1.01, 15 is Jedi Outcast 1.02 and
    /// 1.03, 16 is Jedi Outcast 1.04.
    pub protocol: u16,
    /// Round trip time of the `getinfo` that was answered.
    pub ping_ms: u32,
    /// Listed in the bundled `trusted_servers.json`.
    pub trusted: bool,
    /// Starred by the player, from `favorite_servers` in the settings.
    pub favorite: bool,
    /// When this row was last confirmed, RFC 3339 in UTC.
    pub last_seen: String,
}

impl ServerInfo {
    /// Builds a row out of one `infoResponse`.
    ///
    /// Every key is optional: a mod may drop any of them, and a missing key
    /// must cost that one field rather than the whole row. `trusted` and
    /// `favorite` are left off here and set by [`ServerInfo::decorate`], which
    /// is what lets a cached row pick up a star the player added since.
    pub fn from_infostring(
        game: Game,
        address: SocketAddrV4,
        infostring: &str,
        ping_ms: u32,
        last_seen: &str,
    ) -> ServerInfo {
        let info = parse_infostring(infostring);
        let clients = number(&info, "clients").unwrap_or(0);
        let (humans, bots, players_source) =
            derive_players(clients, number(&info, "g_humanplayers"));
        let hostname_raw = info.get("hostname").cloned().unwrap_or_default();
        let clean = strip_colors(&hostname_raw).trim().to_string();
        let gametype = number(&info, "gametype").unwrap_or(0);
        let mod_name = info
            .get("game")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("base")
            .to_string();

        ServerInfo {
            game,
            address: address.to_string(),
            hostname_clean: if clean.is_empty() {
                address.to_string()
            } else {
                clean
            },
            hostname_raw,
            // --- slice: maps ---
            // `MP/FFA1` and `mp/ffa1` are one map; the launcher keys the
            // filter, the cache and the levelshot on the lowercase spelling.
            map: crate::levelshots::map_key(info.get("mapname").map_or("", String::as_str)),
            gametype,
            // --- slice: game core ---
            // From the table of this game: number 7 is Siege in Jedi Academy
            // and CTF in Jedi Outcast.
            gametype_label: game.spec().gametype_label(gametype),
            clients,
            humans,
            bots,
            players_source,
            max_clients: number(&info, "sv_maxclients").unwrap_or(0),
            needpass: number::<i32>(&info, "needpass").unwrap_or(0) != 0,
            mod_name,
            protocol: number(&info, "protocol")
                .unwrap_or_else(|| default_protocol(game)),
            ping_ms,
            trusted: false,
            favorite: false,
            last_seen: last_seen.to_string(),
        }
    }

    /// Applies the two flags that come from the launcher, not from the server.
    pub fn decorate(&mut self, trusted: &HashSet<String>, favorites: &HashSet<String>) {
        self.trusted = trusted.contains(&self.address);
        self.favorite = favorites.contains(&self.address);
    }

    /// Records what a `getstatus` answer says about this server.
    ///
    /// `clients` is left as the `getinfo` reported it. The two numbers are
    /// counted on different lists and may disagree: `SVC_Info` skips the
    /// `sv_privateClients` slots and `SVC_Status` prints them, and a very long
    /// player list is cut where the engine's 1 kB buffer ends
    /// (`codemp/server/sv_main.cpp:432`). The status count is the better one
    /// for both halves of the question, so it wins for `humans` and `bots`.
    pub fn apply_status(&mut self, players: &[protocol::StatusPlayer]) {
        let (humans, bots) = protocol::count_humans_and_bots(players);
        self.humans = Some(humans);
        self.bots = Some(bots);
        self.players_source = PlayersSource::Status;
    }

    /// Players the browser counts on this row.
    ///
    /// Falls back to `clients` while the split is unknown: on a server that
    /// answers neither question, "someone is playing" is still truer than a
    /// zero, and the row shows the number without a bot suffix.
    pub fn real_players(&self) -> u16 {
        self.humans.unwrap_or(self.clients)
    }

    /// True when everybody on the server is a bot.
    ///
    /// Only a known split counts: a server that hides both numbers is not
    /// accused of being empty.
    pub fn is_bots_only(&self) -> bool {
        self.clients > 0 && self.humans == Some(0)
    }

    /// True when this row is worth a `getstatus` during a refresh.
    fn needs_status(&self) -> bool {
        self.players_source == PlayersSource::Unknown && self.clients > 0
    }

    /// Recomputes the split of a row that came off disk.
    ///
    /// A cache written before this module knew about bots has `humans` and
    /// nothing else, and serde fills the two new fields with their defaults.
    /// Deriving them again turns such a row into a complete one instead of
    /// showing an old list as if every server hid its numbers. A row whose
    /// split came from a player list is left alone: `clients` cannot
    /// reproduce it.
    fn heal_derived(&mut self) {
        if self.players_source == PlayersSource::Status {
            return;
        }
        let (humans, bots, source) = derive_players(self.clients, self.humans);
        self.humans = humans;
        self.bots = bots;
        self.players_source = source;
    }
}

/// Splits `clients` into humans and bots using what the `getinfo` said.
///
/// `g_humanplayers` is written by `SVC_Info` (`codemp/server/sv_main.cpp:503`)
/// and counts the connected clients whose address type is not `NA_BOT`. A
/// server that does not send the key leaves the split open unless it also
/// reports nobody, because zero players cannot hide a bot.
///
/// A mod that reports more humans than clients is clamped rather than trusted:
/// the two keys come from one loop in the engine, so a disagreement means the
/// mod rewrote one of them.
fn derive_players(
    clients: u16,
    humans: Option<u16>,
) -> (Option<u16>, Option<u16>, PlayersSource) {
    match humans {
        Some(humans) => {
            let humans = humans.min(clients);
            (Some(humans), Some(clients - humans), PlayersSource::Info)
        }
        None if clients == 0 => (Some(0), Some(0), PlayersSource::Info),
        None => (None, None, PlayersSource::Unknown),
    }
}

// --- slice: game core ---
/// The mod folder a row falls back to, here and in `from_infostring`.
fn base_mod() -> String {
    "base".to_string()
}

/// Reads the game of a cached row, tolerating what 0.2 put in that key.
///
/// Until 0.3 the key `game` held the mod folder — `base`, `japlus`, `mb2` — so
/// a strict read of a 0.2 cache would fail on the first row and throw away a
/// list of two hundred servers the player is about to look at. Anything that is
/// not a game id reads as Jedi Academy, which is the only game a 0.2 cache can
/// hold; `get_cached_servers` then overwrites the field with the game of the
/// document it came out of.
fn game_of_cached_row<'de, D>(deserializer: D) -> std::result::Result<Game, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Through `Value` rather than through `String`: any JSON value lands here
    // without failing, and a failed read would leave the parser mid-row.
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_str().and_then(Game::from_id).unwrap_or_default())
}

/// What a row's protocol reads as when the server did not send the key.
///
/// The newest protocol of the game, because that is what the servers on the
/// list run: 26 for Jedi Academy 1.01, 16 for Jedi Outcast 1.04.
fn default_protocol(game: Game) -> u16 {
    game.spec()
        .master_protocols
        .iter()
        .copied()
        .max()
        .unwrap_or(PROTOCOL_VERSION)
}

/// Reads one key of an info string as a number, or `None` when it is missing
/// or is not a number at all.
fn number<T: std::str::FromStr>(info: &BTreeMap<String, String>, key: &str) -> Option<T> {
    info.get(key)?.trim().parse().ok()
}

/// A community server the launcher vouches for.
///
/// The list is bundled in `resources/trusted_servers.json` and ships empty:
/// JSON has no comments, so the shape is documented here and in
/// `docs/architecture.md` instead of in the file. One entry looks like
/// `{"address": "1.2.3.4:29070", "name": "EU FFA", "community": "JKHub",
/// "url": "https://jkhub.org"}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrustedServer {
    /// `ip:port`, matched against [`ServerInfo::address`] exactly.
    pub address: String,
    pub name: String,
    /// Who runs it: `JKHub`, `JACoders`, a clan tag.
    pub community: String,
    /// Page a player can read before connecting. Empty when there is none.
    pub url: String,
}

/// The bundled list, read once per run.
static TRUSTED: OnceLock<Vec<TrustedServer>> = OnceLock::new();

/// Returns the bundled trusted servers.
///
/// A missing or broken resource yields an empty list and a warning in the log.
/// The browser must open even when the launcher's own resource folder is
/// damaged, because every other tab still works without this file.
fn trusted_servers(app: &tauri::AppHandle) -> &'static [TrustedServer] {
    TRUSTED
        .get_or_init(|| match read_trusted(app) {
            Ok(list) => list,
            Err(e) => {
                log::warn!("trusted server list is unavailable: {e}");
                Vec::new()
            }
        })
        .as_slice()
}

/// Reads `resources/trusted_servers.json` out of the bundle.
fn read_trusted(app: &tauri::AppHandle) -> Result<Vec<TrustedServer>> {
    let file = app
        .path()
        .resolve(
            "resources/trusted_servers.json",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| AppError::Path(format!("trusted server list: {e}")))?;
    let text = fs::read_to_string(&file).map_err(|e| AppError::io_path("cannot read", &file, e))?;
    serde_json::from_str(&text).map_err(|e| AppError::json("cannot parse trusted_servers.json", e))
}

/// Addresses of the trusted servers, ready for a lookup.
fn trusted_index(app: &tauri::AppHandle) -> HashSet<String> {
    trusted_servers(app)
        .iter()
        .map(|server| server.address.clone())
        .collect()
}

/// What `cache\servers.json` holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ServerCache {
    /// When the list was written, RFC 3339 in UTC.
    updated_at: String,
    servers: Vec<ServerInfo>,
}

/// Payload of `servers:batch`: the rows that answered since the last batch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchEvent {
    // --- slice: game core ---
    /// The game being refreshed. The event names keep their names, so a screen
    /// showing one game reads this to know whether the batch is for it.
    game: Game,
    servers: Vec<ServerInfo>,
}

/// Payload of `servers:done`, emitted once when a refresh ends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    // --- slice: game core ---
    game: Game,
    /// Addresses the masters returned.
    total: usize,
    /// How many of them answered `getinfo`.
    responded: usize,
    elapsed_ms: u64,
}

/// The answer of `get_server_status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub address: String,
    /// The server's whole `serverinfo`, keys lowercased.
    pub info: BTreeMap<String, String>,
    pub players: Vec<PlayerInfo>,
}

/// One player of a `statusResponse`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerInfo {
    pub name_raw: String,
    pub name_clean: String,
    pub score: i32,
    /// Ping the server measures, which is the player's, not the launcher's.
    pub ping: i32,
    /// Zero ping, which `SV_CalcPings` writes for `SVF_BOT` and for nothing
    /// else. See [`protocol::StatusPlayer::is_bot`].
    pub is_bot: bool,
}

/// Reads `ip:port`, or `ip` with the stock server port of this game.
///
/// --- slice: game core ---
/// The two games listen on different ports — 29070 and 28070 — so an address a
/// player typed without one cannot be completed without knowing the game.
fn parse_address(game: Game, address: &str) -> Result<SocketAddrV4> {
    let address = address.trim();
    let with_port = if address.contains(':') {
        address.to_string()
    } else {
        format!("{address}:{}", game.spec().server_port)
    };
    with_port
        .parse()
        .map_err(|_| AppError::InvalidInput(format!("`{address}` is not an IPv4 address and port")))
}

/// Path of the cache document of one game, for the settings in force right now.
///
/// --- slice: game core ---
/// A Jedi Academy path also carries the one-game document over: `servers.json`
/// is renamed to `servers-ja.json` the first time it is wanted, so the player
/// opens 0.3 on the list 0.2 left rather than on an empty screen.
fn cache_file(state: &AppState, game: Game) -> Result<PathBuf> {
    let cache = state.paths()?.cache;
    let file = cache.join(game.spec().server_cache_file);
    if game == Game::JediAcademy && !file.exists() {
        let legacy = cache.join(LEGACY_CACHE_FILE);
        if legacy.is_file() {
            match fs::rename(&legacy, &file) {
                Ok(()) => log::info!("moved {} to {}", legacy.display(), file.display()),
                Err(e) => log::warn!("cannot move {}: {e}", legacy.display()),
            }
        }
    }
    Ok(file)
}

/// Reads the cached list, or an empty one when there is no cache yet.
///
/// A cache that fails to parse is treated as absent: the next refresh
/// overwrites it, and a stale format must never keep the screen from opening.
fn read_cache(file: &PathBuf) -> Vec<ServerInfo> {
    match fs::read_to_string(file) {
        Ok(text) => match serde_json::from_str::<ServerCache>(&text) {
            Ok(cache) => {
                let mut servers = cache.servers;
                for server in &mut servers {
                    server.heal_derived();
                }
                servers
            }
            Err(e) => {
                log::warn!("cannot parse {}: {e}", file.display());
                Vec::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            log::warn!("cannot read {}: {e}", file.display());
            Vec::new()
        }
    }
}

// --- slice: friends ---
/// The host name the last refresh saw at `address`, colour codes removed.
///
/// Best effort by design: the answer decorates a presence report, so a missing
/// cache or an address nobody has scanned yet costs a friend the server name
/// in their status line and nothing more.
pub(crate) fn cached_name_for(state: &AppState, address: &str) -> Option<String> {
    // --- slice: game core ---
    // Both lists are searched: presence says where a friend is, and a friend
    // playing the other game is still a friend on a server with a name.
    Game::ALL.into_iter().find_map(|game| {
        let file = cache_file(state, game).ok()?;
        read_cache(&file)
            .into_iter()
            .find(|server| server.address == address)
            .map(|server| server.hostname_clean)
            .filter(|name| !name.trim().is_empty())
    })
}

/// Writes the cache. A failure is logged, not returned: the player already has
/// the list on screen and cannot act on a disk error here.
fn write_cache(file: &PathBuf, servers: &[ServerInfo]) {
    let document = ServerCache {
        updated_at: timestamp::now_rfc3339(),
        servers: servers.to_vec(),
    };
    // Compact, not pretty: a full list is around a thousand rows and this file
    // is read by the launcher, never by a person.
    let written = serde_json::to_string(&document)
        .map_err(|e| e.to_string())
        .and_then(|text| {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(file, text).map_err(|e| e.to_string())
        });
    if let Err(e) = written {
        log::warn!("cannot write {}: {e}", file.display());
    }
}

/// Orders the list the way the screen shows it by default: busiest first, then
/// by name so two equally busy servers keep a stable place between refreshes.
///
/// Busiest means real players. A server running twelve bots sorts below one
/// with a single human on it, which is the whole point of the ranking.
fn sort_rows(servers: &mut [ServerInfo]) {
    servers.sort_by(|a, b| {
        b.real_players()
            .cmp(&a.real_players())
            .then_with(|| a.hostname_clean.to_lowercase().cmp(&b.hostname_clean.to_lowercase()))
            .then_with(|| a.address.cmp(&b.address))
    });
}

/// Emits an event and swallows the failure.
///
/// The only way `emit` fails is a window that is already gone, and a refresh
/// that outlives its window has nothing left to report.
fn emit<T: Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: T) {
    if let Err(e) = app.emit(event, payload) {
        log::warn!("cannot emit {event}: {e}");
    }
}

/// Returns the last list written by a refresh, with the stars and shields of
/// the current settings applied.
///
/// This is what the Servers screen renders on its first frame, before the
/// network answers anything. Declared `async` so the read of a list a thousand
/// rows long happens off the main thread, where it would stall the window.
/// --- slice: game core ---
/// `game` picks the list; leaving it out means the active game. Each game has
/// its own cache document, so the two never overwrite each other.
#[tauri::command(async)]
pub fn get_cached_servers(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    game: Option<Game>,
) -> Result<Vec<ServerInfo>> {
    let settings = state.settings()?;
    let game = settings.game_or_active(game);
    let file = cache_file(&state, game)?;
    let trusted = trusted_index(&app);
    let favorites: HashSet<String> = settings.favorite_servers.into_iter().collect();

    let mut servers = read_cache(&file);
    for server in &mut servers {
        // A document written by 0.2 has no game on its rows, and serde fills
        // the field with the default. Since it is the Jedi Academy document,
        // the default is also the truth — but a row of the wrong game in the
        // wrong file would label its gametypes from the wrong table, so the
        // file decides rather than the row.
        server.game = game;
        // And the label is read from that game's table, so a 0.2 row keeps
        // saying Siege rather than being relabelled by whatever it decoded to.
        server.gametype_label = game.spec().gametype_label(server.gametype);
        server.decorate(&trusted, &favorites);
    }
    sort_rows(&mut servers);
    Ok(servers)
}

/// Queries the master servers, pings every address and refreshes the cache.
///
/// `masters` overrides the stock master servers of the game, which is what a
/// test or a player behind a blocked DNS needs. An empty list falls back to the
/// stock ones.
///
/// Fails only when no master answered at all: one dead master out of two is a
/// normal day, and the list from the other one is worth showing.
///
/// --- slice: game core ---
/// `game` picks whose masters are asked, whose protocols they are asked for and
/// which cache document the answer lands in. Leaving it out means the active
/// game.
#[tauri::command]
pub async fn refresh_servers(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    game: Option<Game>,
    masters: Option<Vec<String>>,
) -> Result<Vec<ServerInfo>> {
    let started = Instant::now();
    // Everything the shared state owns is copied out before the first await,
    // so a long refresh never holds a lock a settings write may be waiting on.
    let settings = state.settings()?;
    let game = settings.game_or_active(game);
    let spec = game.spec();
    let file = cache_file(&state, game)?;
    let trusted = trusted_index(&app);
    let favorites: HashSet<String> = settings.favorite_servers.into_iter().collect();

    let masters: Vec<String> = masters
        .map(|list| {
            list.into_iter()
                .map(|master| master.trim().to_string())
                .filter(|master| !master.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|list| !list.is_empty())
        .unwrap_or_else(|| spec.masters.iter().map(|master| (*master).to_string()).collect());

    let addresses = collect_addresses(&masters, spec.master_protocols).await?;
    let total = addresses.len();
    log::info!(
        "{total} addresses from {} {} master(s)",
        masters.len(),
        game.display_name()
    );

    let last_seen = timestamp::now_rfc3339();
    let semaphore = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
    let mut probes = JoinSet::new();
    for address in addresses {
        let gate = Arc::clone(&semaphore);
        probes.spawn(async move {
            // The permit is held for the whole exchange, so `MAX_IN_FLIGHT`
            // counts open sockets and not merely started tasks.
            let _permit = gate.acquire_owned().await.ok()?;
            net::query_info(address, INFO_TIMEOUT, INFO_ATTEMPTS)
                .await
                .map(|reply| (address, reply))
        });
    }

    let mut collected: Vec<ServerInfo> = Vec::with_capacity(total);
    let mut batch: Vec<ServerInfo> = Vec::new();
    let mut flushed_at = Instant::now();
    while let Some(joined) = probes.join_next().await {
        let Ok(Some((address, reply))) = joined else {
            continue;
        };
        let mut server = ServerInfo::from_infostring(
            game,
            address,
            &reply.infostring,
            reply.ping_ms,
            &last_seen,
        );
        server.decorate(&trusted, &favorites);
        batch.push(server.clone());
        collected.push(server);

        if flushed_at.elapsed() >= BATCH_INTERVAL {
            emit(
                &app,
                "servers:batch",
                BatchEvent {
                    game,
                    servers: std::mem::take(&mut batch),
                },
            );
            flushed_at = Instant::now();
        }
    }
    if !batch.is_empty() {
        emit(&app, "servers:batch", BatchEvent { game, servers: batch });
    }

    resolve_bots_by_status(&app, game, &mut collected).await;

    sort_rows(&mut collected);
    write_cache(&file, &collected);

    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let real_players: u32 = collected
        .iter()
        .map(|server| u32::from(server.real_players()))
        .sum();
    log::info!(
        "refresh ({}): {} of {total} servers answered in {elapsed_ms} ms, \
         {real_players} real players, {} servers running bots only",
        game.display_name(),
        collected.len(),
        collected
            .iter()
            .filter(|server| server.is_bots_only())
            .count()
    );
    emit(
        &app,
        "servers:done",
        DoneEvent {
            game,
            total,
            responded: collected.len(),
            elapsed_ms,
        },
    );
    Ok(collected)
}

/// Picks the rows a refresh asks for a player list, busiest first.
///
/// Only servers that hide `g_humanplayers` and claim at least one client take
/// part; everything else already knows its split. The order matters because of
/// the cap: if a refresh can only resolve part of the list, it must resolve the
/// servers a player would actually join.
fn status_candidates(servers: &[ServerInfo], cap: usize) -> Vec<usize> {
    let mut candidates: Vec<usize> = servers
        .iter()
        .enumerate()
        .filter(|(_, server)| server.needs_status())
        .map(|(index, _)| index)
        .collect();
    // The address breaks the tie so the same cap keeps the same servers
    // between two refreshes instead of rotating through them.
    candidates.sort_by(|a, b| {
        servers[*b]
            .clients
            .cmp(&servers[*a].clients)
            .then_with(|| servers[*a].address.cmp(&servers[*b].address))
    });
    candidates.truncate(cap);
    candidates
}

/// Second pass of a refresh: `getstatus` for the servers that hide their
/// human count.
///
/// Vanilla 1.01 predates `g_humanplayers`, so on those servers the only way to
/// tell a player from a bot is the player list, where a bot has ping 0. The
/// pass reuses the concurrency limit of the first one and updates the rows in
/// place; the answers also go out as one more `servers:batch`, which is what
/// repaints the counts on a screen that is already showing the list.
///
/// Returns how many servers answered.
/// --- slice: game core ---
/// Jedi Outcast needs this pass more than Jedi Academy does: its `SVC_Info`
/// has no `g_humanplayers` key at all, so every populated Jedi Outcast server
/// arrives here.
async fn resolve_bots_by_status(
    app: &tauri::AppHandle,
    game: Game,
    servers: &mut [ServerInfo],
) -> usize {
    let candidates = status_candidates(servers, MAX_STATUS_QUERIES);
    if candidates.is_empty() {
        return 0;
    }

    let semaphore = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
    let mut probes = JoinSet::new();
    for index in candidates.iter().copied() {
        let Ok(peer) = parse_address(game, &servers[index].address) else {
            continue;
        };
        let gate = Arc::clone(&semaphore);
        probes.spawn(async move {
            let _permit = gate.acquire_owned().await.ok()?;
            let reply = net::query_status(peer, STATUS_TIMEOUT).await.ok()?;
            Some((index, protocol::parse_status_players(&reply.players)))
        });
    }

    let mut updated: Vec<ServerInfo> = Vec::new();
    while let Some(joined) = probes.join_next().await {
        let Ok(Some((index, players))) = joined else {
            continue;
        };
        servers[index].apply_status(&players);
        updated.push(servers[index].clone());
    }

    log::info!(
        "bot scan: {} of {} servers without g_humanplayers answered getstatus",
        updated.len(),
        candidates.len()
    );
    let answered = updated.len();
    if answered > 0 {
        emit(
            app,
            "servers:batch",
            BatchEvent {
                game,
                servers: updated,
            },
        );
    }
    answered
}

/// Asks every master for every protocol at once and merges the answers.
///
/// The set deduplicates: the masters of one game share most of their entries, a
/// single master may repeat an address across datagrams, and — this is what the
/// second protocol adds — a Jedi Outcast master answers `getservers 15` and
/// `getservers 16` with two lists that overlap wherever a server runs a build
/// both numbers describe.
///
/// --- slice: game core ---
/// Jedi Academy asks for protocol 26 alone; Jedi Outcast asks for 15 (1.02 and
/// 1.03) and 16 (1.04), because a master answers with the servers of the
/// protocol it was asked about and neither list is the whole picture.
///
/// One protocol that fails on a master the other protocol answered is not a
/// failure: the master is alive and the query counts.
async fn collect_addresses(
    masters: &[String],
    protocols: &[u16],
) -> Result<Vec<SocketAddrV4>> {
    let mut queries = JoinSet::new();
    for master in masters {
        for protocol in protocols.iter().copied() {
            let master = master.clone();
            queries.spawn(async move {
                let found = net::query_master(&master, protocol, MASTER_TIMEOUT).await;
                (master, protocol, found)
            });
        }
    }

    let mut merged: BTreeSet<SocketAddrV4> = BTreeSet::new();
    let mut answered = 0usize;
    let mut failures: Vec<String> = Vec::new();
    while let Some(joined) = queries.join_next().await {
        match joined {
            Ok((master, protocol, Ok(found))) => {
                log::info!(
                    "master {master} returned {} addresses for protocol {protocol}",
                    found.len()
                );
                answered += 1;
                merged.extend(found);
            }
            Ok((master, protocol, Err(e))) => {
                failures.push(format!("{master} protocol {protocol} ({e})"))
            }
            Err(e) => failures.push(e.to_string()),
        }
    }

    if answered == 0 {
        return Err(AppError::Network(format!(
            "no master server answered: {}",
            failures.join(", ")
        )));
    }
    Ok(merged.into_iter().collect())
}

/// Asks one server for its player list and full `serverinfo`.
///
/// The Servers screen calls this when a row is selected, so it must stay a
/// single short exchange: one datagram out, one back, no retry.
///
/// --- slice: game core ---
/// `game` only completes an address the caller sent without a port; the
/// exchange itself is the same on both games.
#[tauri::command]
pub async fn get_server_status(
    state: tauri::State<'_, AppState>,
    address: String,
    game: Option<Game>,
) -> Result<ServerStatus> {
    let game = state.settings()?.game_or_active(game);
    let peer = parse_address(game, &address)?;
    let reply = net::query_status(peer, STATUS_TIMEOUT).await?;
    let players = protocol::parse_status_players(&reply.players)
        .into_iter()
        .map(|player| PlayerInfo {
            name_clean: strip_colors(&player.name_raw).trim().to_string(),
            is_bot: player.is_bot(),
            name_raw: player.name_raw,
            score: player.score,
            ping: player.ping,
        })
        .collect();

    Ok(ServerStatus {
        address: peer.to_string(),
        info: parse_infostring(&reply.infostring),
        players,
    })
}

/// Returns the bundled list of trusted community servers.
#[tauri::command]
pub fn list_trusted_servers(app: tauri::AppHandle) -> Result<Vec<TrustedServer>> {
    Ok(trusted_servers(&app).to_vec())
}

/// Applies a change to the settings and writes them.
///
/// The change lands on the document as it is on disk, not on the copy the
/// launcher started with: a star must not undo a field edited elsewhere.
fn edit_settings(
    state: &tauri::State<'_, AppState>,
    edit: impl FnOnce(&mut Settings),
) -> Result<Settings> {
    let mut settings = Settings::current(state)?;
    edit(&mut settings);
    settings.save(state)?;
    state.set_settings(settings.clone())?;
    // --- slice: account --- the hub token never crosses the IPC boundary.
    Ok(settings.redacted())
}

/// Stars or unstars a server. Returns the settings so the frontend can update
/// its cache without a second round trip.
///
/// --- slice: game core ---
/// The starred list is one list for both games: an address carries its port,
/// and the two games listen on different ones, so `1.2.3.4:28070` and
/// `1.2.3.4:29070` are already two entries. `game` is here to complete an
/// address typed without a port. Scoping the list itself is a question for the
/// switcher slice, which is where a per-game History tab would be decided.
#[tauri::command]
pub fn set_server_favorite(
    state: tauri::State<'_, AppState>,
    address: String,
    favorite: bool,
    game: Option<Game>,
) -> Result<Settings> {
    let game = state.settings()?.game_or_active(game);
    let address = parse_address(game, &address)?.to_string();
    edit_settings(&state, |settings| {
        settings.favorite_servers.retain(|kept| kept != &address);
        if favorite {
            settings.favorite_servers.push(address.clone());
        }
    })
}

/// Records a connection in `server_history`, newest first.
///
/// The same address moves back to the front instead of appearing twice, and
/// the tail beyond [`HISTORY_LIMIT`] is dropped.
#[tauri::command]
pub fn add_server_history(
    state: tauri::State<'_, AppState>,
    address: String,
    // --- slice: game core --- completes an address typed without a port.
    game: Option<Game>,
) -> Result<Settings> {
    let game = state.settings()?.game_or_active(game);
    let address = parse_address(game, &address)?.to_string();
    let now = timestamp::now_rfc3339();
    edit_settings(&state, |settings| {
        settings
            .server_history
            .retain(|entry| entry.address != address);
        settings.server_history.insert(
            0,
            ServerHistoryEntry {
                address: address.clone(),
                last_connected: now,
            },
        );
        settings.server_history.truncate(HISTORY_LIMIT);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_INFO: &str = "\\challenge\\abc\\protocol\\26\\hostname\\^1JK^7Net ^2Test\
        \\mapname\\mp/ffa3\\clients\\7\\g_humanplayers\\5\\sv_maxclients\\24\\gametype\\3\
        \\needpass\\1\\truejedi\\0\\wdisable\\0\\fdisable\\0\\game\\japlus";

    fn row(infostring: &str) -> ServerInfo {
        game_row(Game::JediAcademy, "81.19.210.136:29070", infostring)
    }

    /// --- slice: game core --- one row of a named game and address.
    fn game_row(game: Game, address: &str, infostring: &str) -> ServerInfo {
        ServerInfo::from_infostring(
            game,
            address.parse().unwrap(),
            infostring,
            42,
            "2026-09-10T00:00:00Z",
        )
    }

    #[test]
    fn reads_every_key_of_a_full_info_response() {
        let server = row(FULL_INFO);
        assert_eq!(server.address, "81.19.210.136:29070");
        assert_eq!(server.hostname_raw, "^1JK^7Net ^2Test");
        assert_eq!(server.hostname_clean, "JKNet Test");
        assert_eq!(server.map, "mp/ffa3");
        assert_eq!(server.gametype, 3);
        assert_eq!(server.gametype_label, "Duel");
        assert_eq!(server.clients, 7);
        assert_eq!(server.humans, Some(5));
        assert_eq!(server.max_clients, 24);
        assert!(server.needpass);
        assert_eq!(server.mod_name, "japlus");
        assert_eq!(server.game, Game::JediAcademy);
        assert_eq!(server.protocol, 26);
        assert_eq!(server.ping_ms, 42);
        assert!(!server.trusted);
        assert!(!server.favorite);
    }

    #[test]
    fn falls_back_when_keys_are_missing() {
        let server = row("\\clients\\0");
        assert_eq!(server.hostname_raw, "");
        // A nameless server is still identifiable by its address.
        assert_eq!(server.hostname_clean, "81.19.210.136:29070");
        assert_eq!(server.mod_name, "base");
        assert_eq!(server.gametype_label, "FFA");
        // An empty server has no bots either, so the split is known even
        // without `g_humanplayers`.
        assert_eq!(server.humans, Some(0));
        assert_eq!(server.protocol, 26);
        assert_eq!(server.max_clients, 0);
        assert!(!server.needpass);
    }

    // --- slice: maps ---
    #[test]
    fn a_map_name_arrives_lowercase_whatever_the_server_typed() {
        assert_eq!(row("\\mapname\\MP/FFA1").map, "mp/ffa1");
        assert_eq!(row("\\mapname\\ MP/FFA1 ").map, "mp/ffa1");
        assert_eq!(row("\\mapname\\MB2_Smuggler").map, "mb2_smuggler");
        assert_eq!(row("\\clients\\0").map, "");
    }

    #[test]
    fn survives_values_that_are_not_numbers() {
        let server = row("\\clients\\lots\\sv_maxclients\\\\gametype\\ 6 \\needpass\\yes\\game\\  ");
        assert_eq!(server.clients, 0);
        assert_eq!(server.max_clients, 0);
        assert_eq!(server.gametype, 6);
        assert_eq!(server.gametype_label, "Team FFA");
        // `needpass` is a number in the protocol, so a word means "not set".
        assert!(!server.needpass);
        assert_eq!(server.mod_name, "base");
    }

    #[test]
    fn a_name_made_only_of_color_codes_shows_the_address() {
        let server = row("\\hostname\\^1^2^3   ");
        assert_eq!(server.hostname_clean, "81.19.210.136:29070");
    }

    #[test]
    fn decorating_applies_both_flags() {
        let mut server = row(FULL_INFO);
        let trusted: HashSet<String> = ["81.19.210.136:29070".to_string()].into_iter().collect();
        let favorites: HashSet<String> = ["1.2.3.4:29070".to_string()].into_iter().collect();
        server.decorate(&trusted, &favorites);
        assert!(server.trusted);
        assert!(!server.favorite);
    }

    #[test]
    fn sorts_by_players_then_name() {
        let mut rows = vec![row(FULL_INFO), row(FULL_INFO), row(FULL_INFO)];
        rows[0].humans = Some(2);
        rows[0].hostname_clean = "Zulu".into();
        rows[1].humans = Some(9);
        rows[1].hostname_clean = "Bravo".into();
        rows[2].humans = Some(2);
        rows[2].hostname_clean = "alpha".into();
        sort_rows(&mut rows);
        let names: Vec<&str> = rows.iter().map(|r| r.hostname_clean.as_str()).collect();
        assert_eq!(names, vec!["Bravo", "alpha", "Zulu"]);
    }

    #[test]
    fn sorts_a_full_house_of_bots_below_one_real_player() {
        let mut rows = vec![
            row("\\hostname\\Bots\\clients\\16\\g_humanplayers\\0"),
            row("\\hostname\\One human\\clients\\1\\g_humanplayers\\1"),
        ];
        sort_rows(&mut rows);
        assert_eq!(rows[0].hostname_clean, "One human");
    }

    #[test]
    fn an_unresolved_row_sorts_on_the_number_it_has() {
        // No `g_humanplayers` and no answer to `getstatus`: `clients` is all
        // there is, and the row must not sink to the bottom as a zero.
        let mut rows = vec![
            row("\\hostname\\Known\\clients\\3\\g_humanplayers\\3"),
            row("\\hostname\\Silent\\clients\\8"),
        ];
        assert_eq!(rows[1].players_source, PlayersSource::Unknown);
        sort_rows(&mut rows);
        assert_eq!(rows[0].hostname_clean, "Silent");
        assert_eq!(rows[0].real_players(), 8);
    }

    #[test]
    fn splits_players_when_the_server_publishes_the_count() {
        let server = row(FULL_INFO);
        assert_eq!(server.clients, 7);
        assert_eq!(server.humans, Some(5));
        assert_eq!(server.bots, Some(2));
        assert_eq!(server.players_source, PlayersSource::Info);
        assert_eq!(server.real_players(), 5);
        assert!(!server.is_bots_only());
        assert!(!server.needs_status());
    }

    #[test]
    fn an_empty_server_needs_no_second_question() {
        // No `g_humanplayers`, but nobody to hide: the split is certain.
        let server = row("\\hostname\\Quiet\\clients\\0");
        assert_eq!(server.humans, Some(0));
        assert_eq!(server.bots, Some(0));
        assert_eq!(server.players_source, PlayersSource::Info);
        assert!(!server.is_bots_only());
        assert!(!server.needs_status());
    }

    #[test]
    fn a_populated_server_without_the_key_stays_unknown() {
        let server = row("\\hostname\\Vanilla\\clients\\4");
        assert_eq!(server.humans, None);
        assert_eq!(server.bots, None);
        assert_eq!(server.players_source, PlayersSource::Unknown);
        assert!(!server.is_bots_only());
        assert!(server.needs_status());
    }

    #[test]
    fn a_server_of_bots_only_is_recognised() {
        let server = row("\\hostname\\Bot farm\\clients\\12\\g_humanplayers\\0");
        assert!(server.is_bots_only());
        assert_eq!(server.bots, Some(12));
        assert_eq!(server.real_players(), 0);
    }

    #[test]
    fn more_humans_than_clients_is_clamped_instead_of_underflowing() {
        let server = row("\\clients\\2\\g_humanplayers\\9");
        assert_eq!(server.humans, Some(2));
        assert_eq!(server.bots, Some(0));
    }

    #[test]
    fn a_player_list_settles_an_unknown_split() {
        let mut server = row("\\hostname\\Vanilla\\clients\\4");
        let players =
            protocol::parse_status_players("3 60 \"Kyle\"\n1 0 \"Reborn\"\n0 0 \"Jedi\"\n");
        server.apply_status(&players);
        assert_eq!(server.humans, Some(1));
        assert_eq!(server.bots, Some(2));
        assert_eq!(server.players_source, PlayersSource::Status);
        assert_eq!(server.real_players(), 1);
        assert!(!server.needs_status());
    }

    #[test]
    fn a_player_list_of_bots_only_settles_it_too() {
        let mut server = row("\\hostname\\Vanilla\\clients\\3");
        server.apply_status(&protocol::parse_status_players(
            "0 0 \"b1\"\n0 0 \"b2\"\n0 0 \"b3\"\n",
        ));
        assert_eq!(server.humans, Some(0));
        assert_eq!(server.bots, Some(3));
        assert!(server.is_bots_only());
    }

    #[test]
    fn an_empty_player_list_means_nobody_is_there() {
        // The server said four clients and then listed none. The list is the
        // one that can be counted, so the row shows nobody rather than four.
        let mut server = row("\\hostname\\Vanilla\\clients\\4");
        server.apply_status(&[]);
        assert_eq!(server.humans, Some(0));
        assert_eq!(server.bots, Some(0));
        assert_eq!(server.real_players(), 0);
    }

    #[test]
    fn asks_the_busiest_unresolved_servers_first() {
        let mut rows = vec![
            row("\\hostname\\A\\clients\\2"),                     // unknown, 2
            row("\\hostname\\B\\clients\\9\\g_humanplayers\\9"),  // resolved
            row("\\hostname\\C\\clients\\11"),                    // unknown, 11
            row("\\hostname\\D\\clients\\0"),                     // empty
            row("\\hostname\\E\\clients\\5"),                     // unknown, 5
        ];
        for (index, server) in rows.iter_mut().enumerate() {
            server.address = format!("10.0.0.{index}:29070");
        }
        assert_eq!(status_candidates(&rows, 10), vec![2, 4, 0]);
        assert_eq!(status_candidates(&rows, 2), vec![2, 4]);
        assert!(status_candidates(&rows, 0).is_empty());
    }

    #[test]
    fn a_list_that_hides_nothing_asks_nobody() {
        let rows = vec![
            row(FULL_INFO),
            row("\\clients\\0"),
            row("\\clients\\3\\g_humanplayers\\0"),
        ];
        assert!(status_candidates(&rows, MAX_STATUS_QUERIES).is_empty());
    }

    #[test]
    fn an_older_cache_row_gets_its_split_back() {
        // What version 0.1.1 wrote: `humans`, no `bots`, no `playersSource`.
        let old = "{\"updatedAt\":\"2026-09-10T00:00:00Z\",\"servers\":[{\
            \"address\":\"81.19.210.136:29070\",\"hostnameRaw\":\"Blue\",\
            \"hostnameClean\":\"Blue\",\"map\":\"mp/ffa3\",\"gametype\":0,\
            \"gametypeLabel\":\"FFA\",\"clients\":6,\"humans\":4,\
            \"maxClients\":32,\"needpass\":false,\"game\":\"base\",\
            \"protocol\":26,\"pingMs\":40,\"trusted\":false,\"favorite\":false,\
            \"lastSeen\":\"2026-09-10T00:00:00Z\"}]}";
        let file = std::env::temp_dir().join("jknet-test-old-cache.json");
        fs::write(&file, old).unwrap();
        let read = read_cache(&file);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].humans, Some(4));
        assert_eq!(read[0].bots, Some(2));
        assert_eq!(read[0].players_source, PlayersSource::Info);
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn a_split_from_a_player_list_survives_the_cache() {
        let file = std::env::temp_dir()
            .join("jknet-test-cache-status")
            .join("servers.json");
        let _ = fs::remove_file(&file);
        let mut server = row("\\hostname\\Vanilla\\clients\\5");
        server.apply_status(&protocol::parse_status_players("1 70 \"Kyle\"\n0 0 \"Bot\"\n"));
        write_cache(&file, &[server]);
        let read = read_cache(&file);
        assert_eq!(read[0].players_source, PlayersSource::Status);
        assert_eq!(read[0].humans, Some(1));
        assert_eq!(read[0].bots, Some(1));
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn reads_an_address_with_and_without_a_port() {
        assert_eq!(
            parse_address(Game::JediAcademy, "81.19.210.136").unwrap().to_string(),
            "81.19.210.136:29070"
        );
        assert_eq!(
            parse_address(Game::JediAcademy, "  81.19.210.136:29071 ").unwrap().to_string(),
            "81.19.210.136:29071"
        );
        assert!(parse_address(Game::JediAcademy, "not-an-address").is_err());
        assert!(parse_address(Game::JediAcademy, "").is_err());
        // IPv6 is out of scope: the master's record format cannot carry it.
        assert!(parse_address(Game::JediAcademy, "[::1]:29070").is_err());
    }

    // --- slice: game core ---

    #[test]
    fn a_jedi_outcast_row_is_labelled_from_its_own_table() {
        // Number 7 is Siege in Jedi Academy and CTF in Jedi Outcast, and the
        // same row would be wrong in one of the two games either way.
        let jo = game_row(
            Game::JediOutcast,
            "81.19.210.136:28070",
            "\\hostname\\JK2 CTF\\mapname\\ctf_yavin\\gametype\\7\\clients\\4\\game\\base",
        );
        assert_eq!(jo.game, Game::JediOutcast);
        assert_eq!(jo.gametype_label, "CTF");
        // Jedi Outcast map names carry no `mp/` prefix.
        assert_eq!(jo.map, "ctf_yavin");
        assert_eq!(jo.mod_name, "base");
        // No `protocol` key means 1.04, the build the servers run.
        assert_eq!(jo.protocol, 16);

        let ja = row("\\hostname\\Siege\\gametype\\7\\clients\\4");
        assert_eq!(ja.gametype_label, "Siege");
        assert_eq!(ja.protocol, 26);

        // Saga is Jedi Outcast's own, and Jedi Academy has nothing at 6.
        assert_eq!(
            game_row(Game::JediOutcast, "1.2.3.4:28070", "\\gametype\\6").gametype_label,
            "Saga"
        );
        assert_eq!(row("\\gametype\\6").gametype_label, "Team FFA");
    }

    #[test]
    fn a_populated_jedi_outcast_server_always_needs_a_player_list() {
        // Jedi Outcast's `SVC_Info` has no `g_humanplayers` key at all, so
        // every Jedi Outcast server with somebody on it goes through the
        // second pass. The rule is the one Jedi Academy already uses; this
        // pins that it still holds for a game that can never send the key.
        let busy = game_row(Game::JediOutcast, "1.2.3.4:28070", "\\clients\\6");
        assert!(busy.needs_status());
        assert_eq!(busy.players_source, PlayersSource::Unknown);

        // An empty one still needs nothing: no clients, no bots.
        let quiet = game_row(Game::JediOutcast, "1.2.3.4:28070", "\\clients\\0");
        assert!(!quiet.needs_status());
        assert_eq!(quiet.humans, Some(0));
    }

    #[test]
    fn each_game_has_its_own_cache_document() {
        assert_eq!(Game::JediAcademy.spec().server_cache_file, "servers-ja.json");
        assert_eq!(Game::JediOutcast.spec().server_cache_file, "servers-jo.json");

        // And a round trip through one of them keeps the game of its rows.
        let file = std::env::temp_dir()
            .join("jknet-test-cache-jo")
            .join("servers-jo.json");
        let _ = fs::remove_file(&file);
        write_cache(
            &file,
            &[game_row(Game::JediOutcast, "1.2.3.4:28070", "\\clients\\0")],
        );
        let read = read_cache(&file);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].game, Game::JediOutcast);
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn a_row_written_by_0_2_survives_the_key_that_changed_meaning() {
        // Until 0.3 the key `game` held the mod folder. A strict read would
        // fail on the first row and throw a list of two hundred servers away,
        // so anything that is not a game id has to read as Jedi Academy.
        let old = "{\"updatedAt\":\"2026-09-10T00:00:00Z\",\"servers\":[{\
            \"address\":\"81.19.210.136:29070\",\"hostnameRaw\":\"Blue\",\
            \"hostnameClean\":\"Blue\",\"map\":\"mp/ffa3\",\"gametype\":0,\
            \"gametypeLabel\":\"FFA\",\"clients\":6,\"humans\":4,\
            \"maxClients\":32,\"needpass\":false,\"game\":\"japlus\",\
            \"protocol\":26,\"pingMs\":40,\"trusted\":false,\"favorite\":false,\
            \"lastSeen\":\"2026-09-10T00:00:00Z\"}]}";
        let file = std::env::temp_dir().join("jknet-test-0-2-cache.json");
        fs::write(&file, old).unwrap();

        let read = read_cache(&file);
        assert_eq!(read.len(), 1, "the whole list must survive");
        assert_eq!(read[0].game, Game::JediAcademy);
        // The mod folder is lost until the next refresh, which is a second of
        // a wrong badge rather than an empty screen.
        assert_eq!(read[0].mod_name, "base");
        assert_eq!(read[0].hostname_clean, "Blue");
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn an_address_without_a_port_gets_the_port_of_its_game() {
        assert_eq!(
            parse_address(Game::JediAcademy, "81.19.210.136").unwrap().to_string(),
            "81.19.210.136:29070"
        );
        assert_eq!(
            parse_address(Game::JediOutcast, "81.19.210.136").unwrap().to_string(),
            "81.19.210.136:28070"
        );
        // A port the player typed always wins over the default of the game.
        assert_eq!(
            parse_address(Game::JediOutcast, "81.19.210.136:29070").unwrap().to_string(),
            "81.19.210.136:29070"
        );
    }

    /// Builds a `getserversResponse` datagram the way a master server does.
    fn master_datagram(servers: &[&str]) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        packet.extend_from_slice(b"getserversResponse");
        for entry in servers {
            let peer: SocketAddrV4 = entry.parse().expect("an address");
            packet.push(b'\\');
            packet.extend_from_slice(&peer.ip().octets());
            packet.extend_from_slice(&peer.port().to_be_bytes());
        }
        packet.extend_from_slice(b"\\EOT\0\0\0");
        packet
    }

    /// A master server on localhost that answers one address list per protocol.
    ///
    /// Local only, so this runs without the internet. It exists because the
    /// two-protocol fan-out is the one thing about the Jedi Outcast list that
    /// cannot be checked by reading a struct: the merge happens across two
    /// answers to two different questions.
    async fn stub_master(answers: &'static [(u16, &'static [&'static str])]) -> String {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("a socket");
        let address = socket.local_addr().expect("an address").to_string();
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 2048];
            // Answers requests until the caller's budget runs out and the test
            // that owns the runtime goes away with it.
            while let Ok(Ok((read, from))) = tokio::time::timeout(
                Duration::from_millis(1_200),
                socket.recv_from(&mut buffer),
            )
            .await
            {
                let request = String::from_utf8_lossy(&buffer[4..read]).to_string();
                let Some(protocol) = request
                    .strip_prefix("getservers ")
                    .and_then(|number| number.trim().parse::<u16>().ok())
                else {
                    continue;
                };
                let Some((_, servers)) =
                    answers.iter().find(|(number, _)| *number == protocol)
                else {
                    continue;
                };
                let _ = socket.send_to(&master_datagram(servers), from).await;
            }
        });
        address
    }

    #[tokio::test]
    async fn a_jedi_outcast_refresh_merges_the_lists_of_both_protocols() {
        // 15 is 1.02 and 1.03, 16 is 1.04. A master answers with the servers
        // of the protocol it was asked about, so neither list is the whole
        // picture — and the server that runs a build both numbers describe
        // appears in both and must be listed once.
        static ANSWERS: &[(u16, &[&str])] = &[
            (15, &["10.0.0.1:28070", "10.0.0.2:28070"]),
            (16, &["10.0.0.2:28070", "10.0.0.3:28070"]),
        ];
        let master = stub_master(ANSWERS).await;

        let found = collect_addresses(std::slice::from_ref(&master), &[15, 16])
            .await
            .expect("the stub answers");
        let listed: Vec<String> = found.iter().map(|peer| peer.to_string()).collect();
        assert_eq!(
            listed,
            vec!["10.0.0.1:28070", "10.0.0.2:28070", "10.0.0.3:28070"],
            "the union, sorted and without the duplicate"
        );

        // Asking for one protocol gets one list, which is what proves the
        // merge above came from the second question and not from the stub.
        let only_15 = collect_addresses(&[master], &[15])
            .await
            .expect("the stub answers");
        assert_eq!(only_15.len(), 2);
    }

    #[tokio::test]
    async fn a_master_that_answers_one_protocol_is_not_a_failed_refresh() {
        // A master that knows nothing about protocol 15 simply says nothing
        // about it. The refresh has an answer and must not report an outage.
        static ANSWERS: &[(u16, &[&str])] = &[(16, &["10.0.0.9:28070"])];
        let master = stub_master(ANSWERS).await;

        let found = collect_addresses(&[master], &[15, 16])
            .await
            .expect("one protocol answering is enough");
        assert_eq!(found.len(), 1);
    }

    #[tokio::test]
    async fn a_refresh_with_nothing_to_ask_fails_rather_than_reporting_an_empty_world() {
        // Port 1 on localhost answers nothing, and "no server is online" is a
        // different sentence from "the masters are unreachable".
        let failure = collect_addresses(&["127.0.0.1:1".to_string()], &[15, 16])
            .await
            .expect_err("nothing answered");
        let text = failure.to_string();
        assert!(text.contains("no master server answered"), "{text}");
        // Both questions are named, so a log line says which one went where.
        assert!(text.contains("protocol 15"), "{text}");
        assert!(text.contains("protocol 16"), "{text}");
    }

    #[test]
    fn a_missing_cache_reads_as_an_empty_list() {
        let missing = std::env::temp_dir().join("jknet-no-such-cache-92834.json");
        assert!(read_cache(&missing).is_empty());
    }

    #[test]
    fn writes_and_reads_the_cache_back() {
        let file = std::env::temp_dir()
            .join("jknet-test-cache")
            .join("servers.json");
        let _ = fs::remove_file(&file);
        write_cache(&file, &[row(FULL_INFO)]);
        let read = read_cache(&file);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].hostname_clean, "JKNet Test");
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn a_corrupted_cache_reads_as_an_empty_list() {
        let file = std::env::temp_dir().join("jknet-test-broken-cache.json");
        fs::write(&file, "{ not json").unwrap();
        assert!(read_cache(&file).is_empty());
        let _ = fs::remove_file(&file);
    }

    /// Asks each master on its own, so a run that returns few addresses can be
    /// blamed on the right host. Ignored for the same reasons as the check
    /// below.
    ///
    /// `cargo test --lib -- --ignored --nocapture each_master_answers`
    #[tokio::test]
    #[ignore = "queries the live master servers"]
    async fn each_master_answers_on_its_own() {
        for game in Game::ALL {
            let spec = game.spec();
            for master in spec.masters {
                for protocol in spec.master_protocols.iter().copied() {
                    let started = Instant::now();
                    let found = net::query_master(master, protocol, MASTER_TIMEOUT).await;
                    match found {
                        Ok(addresses) => println!(
                            "{master} protocol {protocol}: {} addresses in {} ms",
                            addresses.len(),
                            started.elapsed().as_millis()
                        ),
                        Err(e) => println!("{master} protocol {protocol}: {e}"),
                    }
                }
            }
        }
    }

    /// The real thing: both masters, then a `getinfo` to everything they
    /// return. Ignored by default because it needs the internet and takes a
    /// few seconds, and because a master being down is not a broken launcher.
    ///
    /// Run it on purpose:
    /// `cargo test --lib -- --ignored --nocapture talks_to_the_real_masters`
    #[tokio::test]
    #[ignore = "queries the live master servers"]
    async fn talks_to_the_real_masters() {
        let started = Instant::now();
        let spec = Game::JediAcademy.spec();
        let masters: Vec<String> = spec.masters.iter().map(|m| (*m).to_string()).collect();
        let addresses = collect_addresses(&masters, spec.master_protocols)
            .await
            .expect("at least one master must answer");
        println!("masters returned {} unique addresses", addresses.len());

        let last_seen = timestamp::now_rfc3339();
        let gate = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
        let mut probes = JoinSet::new();
        for address in addresses.iter().copied() {
            let permit_source = Arc::clone(&gate);
            probes.spawn(async move {
                let _permit = permit_source.acquire_owned().await.ok()?;
                net::query_info(address, INFO_TIMEOUT, INFO_ATTEMPTS)
                    .await
                    .map(|reply| (address, reply))
            });
        }

        let mut answered = Vec::new();
        while let Some(joined) = probes.join_next().await {
            if let Ok(Some((address, reply))) = joined {
                answered.push(ServerInfo::from_infostring(
                    Game::JediAcademy,
                    address,
                    &reply.infostring,
                    reply.ping_ms,
                    &last_seen,
                ));
            }
        }
        sort_rows(&mut answered);

        println!(
            "{} of {} answered in {} ms",
            answered.len(),
            addresses.len(),
            started.elapsed().as_millis()
        );
        for server in answered.iter().take(5) {
            println!(
                "  {} | {} | {} | {}/{} | {} ms | {}",
                server.address,
                server.hostname_clean,
                server.map,
                server.clients,
                server.max_clients,
                server.ping_ms,
                server.game
            );
        }
        assert!(!answered.is_empty(), "no server on the internet answered");

        // The busiest server also has to produce a player list, which is the
        // second half of the protocol the details panel depends on.
        let busiest = answered
            .iter()
            .find(|server| server.clients > 0)
            .expect("at least one server must have a player on it");
        let status = net::query_status(
            parse_address(Game::JediAcademy, &busiest.address).unwrap(),
            MASTER_TIMEOUT,
        )
        .await
        .expect("the busiest server must answer getstatus");
        let players = protocol::parse_status_players(&status.players);
        println!(
            "{} reports {} of its {} players",
            busiest.address,
            players.len(),
            busiest.clients
        );
        for player in players.iter().take(5) {
            println!(
                "  {:>4} {:>4} {}",
                player.score,
                player.ping,
                strip_colors(&player.name_raw)
            );
        }
        assert!(!players.is_empty());
    }

    /// Measures the cost and the yield of the bot scan on the live network.
    ///
    /// Prints how many servers hide `g_humanplayers`, how many of those the
    /// second pass resolves, how many turn out to be bots only, and what each
    /// pass costs. Ignored for the same reason as the two checks above.
    ///
    /// `cargo test --lib -- --ignored --nocapture measures_the_bot_scan`
    #[tokio::test]
    #[ignore = "queries the live master servers"]
    async fn measures_the_bot_scan() {
        let spec = Game::JediAcademy.spec();
        let masters: Vec<String> = spec.masters.iter().map(|m| (*m).to_string()).collect();
        let addresses = collect_addresses(&masters, spec.master_protocols)
            .await
            .expect("at least one master must answer");

        let info_started = Instant::now();
        let last_seen = timestamp::now_rfc3339();
        let gate = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
        let mut probes = JoinSet::new();
        for address in addresses.iter().copied() {
            let permit_source = Arc::clone(&gate);
            probes.spawn(async move {
                let _permit = permit_source.acquire_owned().await.ok()?;
                net::query_info(address, INFO_TIMEOUT, INFO_ATTEMPTS)
                    .await
                    .map(|reply| (address, reply))
            });
        }
        let mut answered = Vec::new();
        let mut no_key = 0usize;
        while let Some(joined) = probes.join_next().await {
            if let Ok(Some((address, reply))) = joined {
                if !parse_infostring(&reply.infostring).contains_key("g_humanplayers") {
                    no_key += 1;
                }
                answered.push(ServerInfo::from_infostring(
                    Game::JediAcademy,
                    address,
                    &reply.infostring,
                    reply.ping_ms,
                    &last_seen,
                ));
            }
        }
        let info_ms = info_started.elapsed().as_millis();

        let populated = answered.iter().filter(|server| server.clients > 0).count();
        let unresolved = status_candidates(&answered, usize::MAX).len();
        let capped = status_candidates(&answered, MAX_STATUS_QUERIES).len();

        println!("--- pass 1: getinfo ---");
        println!("{} of {} answered in {info_ms} ms", answered.len(), addresses.len());
        println!("{populated} of them have at least one client");
        println!("{no_key} sent no g_humanplayers at all");
        println!("{unresolved} need getstatus, {capped} fit under the cap of {MAX_STATUS_QUERIES}");

        // The real second pass, through the function a refresh calls, minus
        // the event: an `AppHandle` needs a running window.
        let status_started = Instant::now();
        let mut resolved = 0usize;
        let candidates = status_candidates(&answered, MAX_STATUS_QUERIES);
        let gate = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
        let mut probes = JoinSet::new();
        for index in candidates {
            let peer = parse_address(Game::JediAcademy, &answered[index].address).unwrap();
            let permit_source = Arc::clone(&gate);
            probes.spawn(async move {
                let _permit = permit_source.acquire_owned().await.ok()?;
                let reply = net::query_status(peer, STATUS_TIMEOUT).await.ok()?;
                Some((index, protocol::parse_status_players(&reply.players)))
            });
        }
        while let Some(joined) = probes.join_next().await {
            if let Ok(Some((index, players))) = joined {
                answered[index].apply_status(&players);
                resolved += 1;
            }
        }
        let status_ms = status_started.elapsed().as_millis();

        let still_unknown = answered
            .iter()
            .filter(|server| server.players_source == PlayersSource::Unknown)
            .count();
        let bots_only = answered.iter().filter(|server| server.is_bots_only()).count();
        let with_bots = answered
            .iter()
            .filter(|server| server.bots.unwrap_or(0) > 0)
            .count();
        let humans: u32 = answered.iter().map(|s| u32::from(s.real_players())).sum();
        let clients: u32 = answered.iter().map(|s| u32::from(s.clients)).sum();
        let bots: u32 = answered.iter().map(|s| u32::from(s.bots.unwrap_or(0))).sum();

        println!("--- pass 2: getstatus ---");
        println!("{resolved} answered in {status_ms} ms, {still_unknown} still unknown");
        println!("{bots_only} servers are bots only, {with_bots} have at least one bot");
        println!("players: {clients} clients = {humans} humans + {bots} bots");
        println!("--- total: {} ms ---", info_ms + status_ms);
    }
}
