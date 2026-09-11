//! The server browser.
//!
//! Three operations fill the browser, and every one of them ends in the same
//! probe of a list of addresses — [`probe_addresses`]:
//!
//! - [`refresh_servers`] asks the master servers for their address lists,
//!   adds the addresses already in the cache and probes all of them. This is
//!   **Get new list**. A server that answers neither of two whole scans in a
//!   row leaves the cache; until then its row stays, marked offline.
//! - [`refresh_addresses`] probes the addresses the caller already has, with no
//!   master server in it at all. This is **Refresh**, and it is also how the
//!   Favorites and History tabs ask about the addresses the player saved.
//! - [`refresh_lan`] broadcasts one `getinfo` across the local network and
//!   builds rows out of whoever answers.
//!
//! Nothing starts by itself. The engine's own browser has no timer either —
//! `UI_DoServerRefresh` returns at once unless a player pressed something
//! (`codemp/ui/ui_main.c:10457`, OpenJK `1a6a6434`) — and a scan of two hundred
//! hosts is not something to do behind the player's back.
//!
//! The probe is two stages. Every address is sent a `getinfo` with a bounded
//! number of requests in flight, and the round trip time of that request is the
//! ping the browser shows. Then the servers that did not publish
//! `g_humanplayers` get a `getstatus`, because their player list is the only
//! place a bot can be told from a person — see [`ServerInfo::apply_status`].
//!
//! Each operation runs under a [`RefreshScope`], which every event carries: the
//! screen keeps a loader per tab, and a scan of the Favorites tab must not
//! freeze the All tab. Two scopes may run at once; the same scope may not.
//! Two scopes of one game do end at the same cache document, though, so the
//! file work of both goes under [`RefreshState::cache_lock`] — the probes stay
//! side by side, the writes do not.
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
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
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

// --- slice: servers robustness ---
/// How many whole refreshes in a row a server may miss before its row is
/// dropped from the cache.
///
/// One miss is a lost datagram or a map change; the row stays and the screen
/// marks it offline. Two in a row is a server that has gone, and the master
/// servers no longer list it either.
const MISSED_REFRESH_LIMIT: u32 = 2;

/// How many servers one refresh may ask for a player list.
///
/// The second pass exists only for servers that hide `g_humanplayers`, and the
/// busiest of them go first. A cap keeps a refresh bounded even on the day
/// every server on the master list turns out to be a vanilla 1.01 build.
const MAX_STATUS_QUERIES: usize = 150;

/// How often the collected rows are pushed to the window during a refresh.
const BATCH_INTERVAL: Duration = Duration::from_millis(100);

// --- slice: servers browser ---
/// How long a LAN sweep listens after its broadcasts have gone out.
///
/// The same budget a `getstatus` gets. A server on the same switch answers in
/// single-digit milliseconds; the rest of the budget is there for a wireless
/// hop and for a machine that was busy loading a map.
const LAN_TIMEOUT: Duration = Duration::from_millis(1_500);

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

// --- slice: servers browser ---
/// Which list of the browser one operation is filling.
///
/// The Servers screen keeps a loader, a counter and a "refreshed N s ago" line
/// per tab, so every event of an operation says whose tab it belongs to: a
/// scan of the Favorites tab must leave the All tab alone, and the two may be
/// in flight at the same time.
///
/// The scope is also the key of [`RefreshState`], which is what stops a second
/// press of the same button from starting a second scan of the same list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefreshScope {
    /// The whole list: the master servers, or every address already on it.
    #[default]
    All,
    /// The addresses in `favorite_servers`.
    Favorites,
    /// The addresses in `server_history`.
    History,
    /// The broadcast sweep of the local network.
    Lan,
}

// --- slice: servers browser ---
/// The scopes an operation is running for right now, and the write lock of
/// each game's cache document.
///
/// Long work is guarded in the core and not merely by a disabled button, the
/// way `InstallState` guards an engine install: a second `invoke` from a
/// reloaded window would otherwise put two scans of the same list on the wire.
/// The key carries the game as well, because the two lists come from different
/// master servers and have nothing to do with each other.
#[derive(Debug, Default)]
pub struct RefreshState {
    busy: Mutex<HashSet<(Game, RefreshScope)>>,
    /// One lock per game, held only for the file work on
    /// `cache\servers-<game>.json`. See [`RefreshState::cache_lock`].
    cache_writes: [tokio::sync::Mutex<()>; Game::ALL.len()],
}

impl RefreshState {
    /// The write lock of one game's cache document.
    ///
    /// Deliberately not the same lock as [`RefreshState::claim`], and taken
    /// separately from it. The claim lets two tabs of one game scan at the same
    /// time, which is the point of the scopes — but both scans end at the same
    /// file, and [`refresh_servers`] replaces that file whole while
    /// [`refresh_addresses`] reads it, merges into it and writes it back. This
    /// lock makes each of those one step, so a merge can never read the
    /// document before another operation's write and put its own copy back
    /// after it: a stale snapshot laid over a fresh one is how a server the
    /// masters have dropped comes back to life and survives a restart.
    ///
    /// It is a [`tokio::sync::Mutex`] because it is held across the file work
    /// of an `async` command, and it is held for that alone: the master query
    /// and the probe of a thousand addresses stay outside it, so the two scans
    /// still run side by side on the wire.
    fn cache_lock(&self, game: Game) -> &tokio::sync::Mutex<()> {
        let at = Game::ALL
            .iter()
            .position(|known| *known == game)
            .unwrap_or_default();
        &self.cache_writes[at]
    }

    /// Claims one scope of one game, or refuses because it is already running.
    fn claim(&self, game: Game, scope: RefreshScope) -> Result<RefreshGuard<'_>> {
        let mut busy = self
            .busy
            .lock()
            .map_err(|_| AppError::State("the server refresh lock is poisoned".into()))?;
        if !busy.insert((game, scope)) {
            return Err(AppError::Busy(format!(
                "a {scope:?} refresh of {} is already running. Wait for it to finish.",
                game.display_name()
            )));
        }
        Ok(RefreshGuard {
            state: self,
            key: (game, scope),
        })
    }
}

/// Releases the claim when the operation ends, however it ends.
#[derive(Debug)]
struct RefreshGuard<'a> {
    state: &'a RefreshState,
    key: (Game, RefreshScope),
}

impl Drop for RefreshGuard<'_> {
    fn drop(&mut self) {
        match self.state.busy.lock() {
            Ok(mut busy) => {
                busy.remove(&self.key);
            }
            // A poisoned lock would leave the tab's button dead until the
            // launcher restarts, which is worse than the panic behind it.
            Err(e) => log::error!("cannot release the refresh claim of {:?}: {e}", self.key),
        }
    }
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
    /// Starred by the player, from `favorite_servers` in the settings.
    pub favorite: bool,
    // --- slice: servers browser ---
    /// False when the last direct probe of this address got nothing back.
    ///
    /// The Favorites and History tabs are lists of addresses the player saved,
    /// so a server that is switched off still has to be a row: one that
    /// silently disappears reads as a launcher that lost it. Such a row carries
    /// whatever the last successful scan knew and the screen draws it muted,
    /// with a mark where the ping goes.
    ///
    /// True everywhere else, including on every row read off the cache: the
    /// cache only ever holds servers that answered, and a document written
    /// before the field existed has to read as answered rather than as a list
    /// of ghosts.
    #[serde(default = "answered")]
    pub responded: bool,
    // --- slice: servers robustness ---
    /// Whole refreshes this address has missed in a row.
    ///
    /// Zero on every row that answered. A full scan raises it by one for an
    /// address that stayed silent and drops the row at
    /// [`MISSED_REFRESH_LIMIT`], so one bad second costs a muted row and not
    /// a server the player was looking at.
    #[serde(default)]
    pub missed_refreshes: u32,
    /// When this row was last confirmed, RFC 3339 in UTC.
    pub last_seen: String,
}

impl ServerInfo {
    /// Builds a row out of one `infoResponse`.
    ///
    /// Every key is optional: a mod may drop any of them, and a missing key
    /// must cost that one field rather than the whole row. `favorite` is left
    /// off here and set by [`ServerInfo::decorate`], which is what lets a
    /// cached row pick up a star the player added since.
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
            favorite: false,
            responded: true,
            // --- slice: servers robustness --- a fresh answer has missed
            // nothing; the counter is raised by a scan this address ignored.
            missed_refreshes: 0,
            last_seen: last_seen.to_string(),
        }
    }

    // --- slice: servers browser ---
    /// A row for an address that has never answered anything.
    ///
    /// The empty info string put through the ordinary constructor, so the
    /// fallbacks are the ones a very terse server would get: the address as the
    /// name, no map, no players, the newest protocol of the game. The row
    /// exists so a favourite the player saved before the launcher ever saw it
    /// online is still on the tab.
    fn unseen(game: Game, address: SocketAddrV4) -> ServerInfo {
        let mut row = ServerInfo::from_infostring(game, address, "", 0, "");
        row.responded = false;
        row
    }

    /// Applies the flag that comes from the launcher, not from the server.
    pub fn decorate(&mut self, favorites: &HashSet<String>) {
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
/// A mod that reports more humans than clients is clamped rather than taken at
/// its word: the two keys come from one loop in the engine, so a disagreement
/// means the mod rewrote one of them.
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

// --- slice: servers browser ---
/// What [`ServerInfo::responded`] reads as when a document does not say.
fn answered() -> bool {
    true
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

/// Whether the browser keeps a server running this mod folder out of sight.
///
/// Movie Battles II is a global mod with a launcher and a content pipeline of
/// its own: its servers demand files the launcher does not manage and refuse a
/// client that joins without them, so a row the player cannot connect to is
/// worse than no row. Until JKNet supports the mod, those servers are dropped
/// where they are read — on a refresh and on the cache written before this
/// rule existed — so no tab, count or subtitle sees them.
///
/// The whole folder name is compared, not a prefix: `mbii2` is somebody else's
/// mod and stays on the list. To bring the servers back, delete this function
/// and its two call sites; to hide another mod, add it here.
fn is_hidden_mod(mod_name: &str) -> bool {
    mod_name.eq_ignore_ascii_case("mbii")
}

/// Drops the rows of [`is_hidden_mod`] from a list read off the disk.
fn drop_hidden_mods(servers: &mut Vec<ServerInfo>) {
    servers.retain(|server| !is_hidden_mod(&server.mod_name));
}

/// Reads one key of an info string as a number, or `None` when it is missing
/// or is not a number at all.
fn number<T: std::str::FromStr>(info: &BTreeMap<String, String>, key: &str) -> Option<T> {
    info.get(key)?.trim().parse().ok()
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
    // --- slice: servers browser ---
    /// Which tab asked. A `lan` batch holds rows that never enter the master
    /// list; every other scope holds rows of it.
    scope: RefreshScope,
    servers: Vec<ServerInfo>,
}

/// Payload of `servers:done`, emitted once when a refresh ends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    // --- slice: game core ---
    game: Game,
    // --- slice: servers browser ---
    /// Which tab asked, so one tab's indicator is not closed by another's.
    scope: RefreshScope,
    /// Addresses that were asked: what the masters returned, what the caller
    /// sent, or — on a LAN sweep, where nobody knows who is out there — the
    /// number that answered.
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
///
/// --- slice: servers browser ---
/// `None` means there is no window at all, which is how a test drives the probe
/// without a running application.
fn emit<T: Serialize + Clone>(app: Option<&tauri::AppHandle>, event: &str, payload: T) {
    let Some(app) = app else {
        return;
    };
    if let Err(e) = app.emit(event, payload) {
        log::warn!("cannot emit {event}: {e}");
    }
}

/// Returns the last list written by a refresh, with the stars of the current
/// settings applied.
///
/// This is what the Servers screen renders on its first frame, before the
/// network answers anything. Declared `async` so the read of a list a thousand
/// rows long happens off the main thread, where it would stall the window.
/// --- slice: game core ---
/// `game` picks the list; leaving it out means the active game. Each game has
/// its own cache document, so the two never overwrite each other.
#[tauri::command(async)]
pub fn get_cached_servers(
    state: tauri::State<'_, AppState>,
    game: Option<Game>,
) -> Result<Vec<ServerInfo>> {
    let settings = state.settings()?;
    let game = settings.game_or_active(game);
    let file = cache_file(&state, game)?;
    let favorites: HashSet<String> = settings.favorite_servers.into_iter().collect();

    let mut servers = read_cache(&file);
    // A cache written before the rule existed still holds the hidden mods.
    drop_hidden_mods(&mut servers);
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
        server.decorate(&favorites);
    }
    sort_rows(&mut servers);
    Ok(servers)
}

/// Queries the master servers, pings every address and rewrites the cache.
///
/// This is the **Get new list** button: the only operation that asks a master
/// server, and the only one that writes the whole cache document rather than
/// merging into it.
///
/// --- slice: servers robustness ---
/// What it writes is not the masters' answer alone. The addresses asked are
/// the masters' list **and** the addresses already in the cache, and an
/// address that stays silent keeps its row — muted, with
/// [`ServerInfo::responded`] false — until it has missed
/// [`MISSED_REFRESH_LIMIT`] whole refreshes in a row. A master rotates its own
/// list between two presses of the button (13 of 238 addresses came and went
/// inside one 45-second window on 11 September 2026), and writing its answer
/// alone turned that rotation into servers disappearing off the screen.
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
    refreshes: tauri::State<'_, RefreshState>,
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
    let favorites: HashSet<String> = settings.favorite_servers.into_iter().collect();
    // --- slice: servers browser ---
    // Held for the whole refresh, so the second press of a button the window
    // failed to disable is refused here instead of on the wire.
    let _claim = refreshes.claim(game, RefreshScope::All)?;

    let masters: Vec<String> = masters
        .map(|list| {
            list.into_iter()
                .map(|master| master.trim().to_string())
                .filter(|master| !master.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|list| !list.is_empty())
        .unwrap_or_else(|| spec.masters.iter().map(|master| (*master).to_string()).collect());

    let from_masters = collect_addresses(&masters, spec.master_protocols).await?;
    // --- slice: servers robustness ---
    // The cache is read before the probe, not under the write lock: these rows
    // are the addresses to ask and the last thing known about the ones that
    // will not answer.
    let cached = read_cache(&file);
    let addresses = merge_addresses(game, &from_masters, &cached);
    let total = addresses.len();
    log::info!(
        "{} addresses from {} {} master(s), {total} to ask with the cache",
        from_masters.len(),
        masters.len(),
        game.display_name()
    );

    let probe = probe_addresses(
        Some(&app),
        game,
        RefreshScope::All,
        addresses.clone(),
        &favorites,
        &timestamp::now_rfc3339(),
    )
    .await;
    // --- slice: servers robustness ---
    // The document is the answers plus the rows of the addresses that stayed
    // silent and have not yet used up their grace.
    let mut collected = probe.servers;
    let kept = keep_silent_rows(game, &cached, &addresses, &mut collected, &favorites);
    sort_rows(&mut collected);
    // The probe is over before the lock is taken: a scan of the Favorites tab
    // that is still on the wire is none of this command's business, and only
    // the file the two of them share is.
    write_cache_locked(refreshes.cache_lock(game), &file, &collected).await;

    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let answered = collected.iter().filter(|server| server.responded).count();
    let real_players: u32 = collected
        .iter()
        .map(|server| u32::from(server.real_players()))
        .sum();
    log::info!(
        "refresh ({}): {answered} of {total} servers answered in {elapsed_ms} ms, \
         {real_players} real players, {} servers running bots only",
        game.display_name(),
        collected
            .iter()
            .filter(|server| server.is_bots_only())
            .count()
    );
    // --- slice: servers robustness ---
    // The one line a report about a missing server is answered from: how many
    // addresses each source named, how many of them are gone for good, and how
    // many answers the mod filter took off the screen before anything counted
    // them.
    log::info!(
        "refresh ({}): {} from the masters, {} from the cache, {answered} answered, \
         {} silent and kept, {} dropped after {MISSED_REFRESH_LIMIT} misses, \
         {} hidden by the mod filter",
        game.display_name(),
        from_masters.len(),
        cached.len(),
        kept.silent,
        kept.dropped,
        probe.hidden
    );
    let strangers = answered_off_the_master_list(&from_masters, &collected);
    if !strangers.is_empty() {
        log::info!(
            "refresh ({}): {} answered without being on the master list: {}",
            game.display_name(),
            strangers.len(),
            strangers.join(", ")
        );
    }
    emit(
        Some(&app),
        "servers:done",
        DoneEvent {
            game,
            scope: RefreshScope::All,
            total,
            responded: answered,
            elapsed_ms,
        },
    );
    Ok(collected)
}

// --- slice: servers robustness ---
/// The addresses a full scan asks: the masters' list and the cache's own.
///
/// A cached row whose address no longer parses is dropped with a line in the
/// log rather than failing the press, the same way a typed address is.
fn merge_addresses(
    game: Game,
    from_masters: &[SocketAddrV4],
    cached: &[ServerInfo],
) -> Vec<SocketAddrV4> {
    let mut merged: BTreeSet<SocketAddrV4> = from_masters.iter().copied().collect();
    for row in cached {
        match parse_address(game, &row.address) {
            Ok(peer) => {
                merged.insert(peer);
            }
            Err(e) => log::warn!("skipping the cached row {}: {e}", row.address),
        }
    }
    merged.into_iter().collect()
}

// --- slice: servers robustness ---
/// What the grace rule did to the addresses that did not answer.
struct SilentRows {
    /// Rows kept in the document, muted, with one more miss on the counter.
    silent: usize,
    /// Rows that used up [`MISSED_REFRESH_LIMIT`] and left the cache.
    dropped: usize,
}

// --- slice: servers robustness ---
/// Appends the rows of the asked addresses that said nothing, and counts them.
///
/// A row that answered has its miss counter cleared and keeps the player list
/// the cache remembered for it. A row that did not answer carries everything
/// the last successful scan knew, is marked with `responded: false` and spends
/// one of its misses; at [`MISSED_REFRESH_LIMIT`] it is left out, which is what
/// finally takes a switched-off server off the screen.
///
/// An address nobody has ever seen does not become a row here: a full scan asks
/// the masters' list, and an address on it that never answered is not a server
/// the cache has anything to say about.
fn keep_silent_rows(
    game: Game,
    cached: &[ServerInfo],
    asked: &[SocketAddrV4],
    answered: &mut Vec<ServerInfo>,
    favorites: &HashSet<String>,
) -> SilentRows {
    let known: BTreeMap<&str, &ServerInfo> = cached
        .iter()
        .map(|row| (row.address.as_str(), row))
        .collect();
    let replied: HashSet<String> = answered.iter().map(|row| row.address.clone()).collect();
    let mut counts = SilentRows {
        silent: 0,
        dropped: 0,
    };
    for address in asked {
        let key = address.to_string();
        if replied.contains(key.as_str()) {
            continue;
        }
        let Some(row) = known.get(key.as_str()) else {
            continue;
        };
        if is_hidden_mod(&row.mod_name) {
            continue;
        }
        let mut row = (*row).clone();
        row.game = game;
        row.responded = false;
        row.missed_refreshes = row.missed_refreshes.saturating_add(1);
        if row.missed_refreshes >= MISSED_REFRESH_LIMIT {
            counts.dropped += 1;
            continue;
        }
        row.decorate(favorites);
        counts.silent += 1;
        answered.push(row);
    }
    counts
}

// --- slice: servers robustness ---
/// Addresses that answered although no master named them.
///
/// Worth a line in the log rather than a warning: a favourite on a private
/// server is exactly this, and so is a server the master dropped a minute ago
/// and is still running. It is also the shortest proof that the merge with the
/// cache is doing something.
fn answered_off_the_master_list(
    from_masters: &[SocketAddrV4],
    collected: &[ServerInfo],
) -> Vec<String> {
    let listed: HashSet<String> = from_masters.iter().map(|peer| peer.to_string()).collect();
    collected
        .iter()
        .filter(|row| row.responded && !listed.contains(&row.address))
        .map(|row| row.address.clone())
        .collect()
}

// --- slice: servers browser ---
/// Probes the addresses the caller already knows, without a master server.
///
/// This is the **Refresh** button and the two tabs built out of the player's
/// own lists. The engine draws the same line: `RefreshServers` asks the master
/// for a new list, `RefreshFilter` only pings the addresses already on screen
/// (`UI_StartServerRefresh`, `codemp/ui/ui_main.c:10500`, OpenJK `1a6a6434`).
///
/// The answers are merged into the cache by address — the rest of the document
/// is untouched, because this operation knows nothing about it. An address that
/// stays silent is returned all the same, carrying whatever the last successful
/// scan knew and with [`ServerInfo::responded`] false, so a favourite that is
/// switched off is a muted row rather than a row that vanished.
///
/// `scope` says which tab asked; it travels on both events and is what keeps
/// that tab's loader separate from the others.
#[tauri::command]
pub async fn refresh_addresses(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    refreshes: tauri::State<'_, RefreshState>,
    game: Option<Game>,
    addresses: Vec<String>,
    scope: RefreshScope,
) -> Result<Vec<ServerInfo>> {
    let started = Instant::now();
    let settings = state.settings()?;
    let game = settings.game_or_active(game);
    let file = cache_file(&state, game)?;
    let favorites: HashSet<String> = settings.favorite_servers.into_iter().collect();
    let _claim = refreshes.claim(game, scope)?;

    // Deduplicated but kept in the caller's order, and an address that does not
    // parse is dropped with a line in the log rather than failing the press:
    // the list comes off the screen, and one bad entry must not cost the rest.
    let mut seen: HashSet<SocketAddrV4> = HashSet::new();
    let mut wanted: Vec<SocketAddrV4> = Vec::with_capacity(addresses.len());
    for address in &addresses {
        match parse_address(game, address) {
            Ok(peer) if seen.insert(peer) => wanted.push(peer),
            Ok(_) => {}
            Err(e) => log::warn!("skipping {address} in a {scope:?} refresh: {e}"),
        }
    }
    let total = wanted.len();

    let answered = probe_addresses(
        Some(&app),
        game,
        scope,
        wanted.clone(),
        &favorites,
        &timestamp::now_rfc3339(),
    )
    .await
    .servers;
    // Read, merge and write as one step: a **Get new list** of the same game
    // runs under its own claim and ends at this same file.
    let document = merge_into_cache_locked(refreshes.cache_lock(game), &file, &answered).await;

    let mut rows = answered;
    rows.extend(silent_rows(game, &document, &wanted, &rows, &favorites));
    sort_rows(&mut rows);

    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let responded = rows.iter().filter(|row| row.responded).count();
    log::info!(
        "{scope:?} refresh ({}): {responded} of {total} servers answered in {elapsed_ms} ms",
        game.display_name()
    );
    emit(
        Some(&app),
        "servers:done",
        DoneEvent {
            game,
            scope,
            total,
            responded,
            elapsed_ms,
        },
    );
    Ok(rows)
}

// --- slice: servers browser ---
/// Broadcasts one `getinfo` across the local network and lists who answers.
///
/// The **LAN** tab. `CL_LocalServers_f` does exactly this
/// (`codemp/client/cl_main.cpp:3337`, OpenJK `1a6a6434`): the same request goes
/// to [`crate::game::LAN_PORT_COUNT`] consecutive ports of the broadcast
/// address, twice, and every server on the segment answers from its own
/// address.
///
/// The rows never reach `cache\servers-<game>.json`. A machine on this network
/// is not a server the master list knows about, and a cached LAN row would come
/// back on the All tab of a player sitting somewhere else entirely.
#[tauri::command]
pub async fn refresh_lan(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    refreshes: tauri::State<'_, RefreshState>,
    game: Option<Game>,
) -> Result<Vec<ServerInfo>> {
    let settings = state.settings()?;
    let game = settings.game_or_active(game);
    let favorites: HashSet<String> = settings.favorite_servers.into_iter().collect();
    let _claim = refreshes.claim(game, RefreshScope::Lan)?;
    scan_lan(Some(&app), game, &broadcast_targets(game), &favorites).await
}

// --- slice: servers browser ---
/// The addresses a LAN sweep sends to: the broadcast address on the game's
/// server port and the three above it.
fn broadcast_targets(game: Game) -> Vec<SocketAddrV4> {
    let port = game.spec().server_port;
    (0..crate::game::LAN_PORT_COUNT)
        .map(|offset| SocketAddrV4::new(Ipv4Addr::BROADCAST, port + offset))
        .collect()
}

// --- slice: servers browser ---
/// The sweep itself, with the targets as an argument.
///
/// Split from the command so a test can aim it at four localhost ports and stay
/// off the network entirely.
async fn scan_lan(
    app: Option<&tauri::AppHandle>,
    game: Game,
    targets: &[SocketAddrV4],
    favorites: &HashSet<String>,
) -> Result<Vec<ServerInfo>> {
    let started = Instant::now();
    let last_seen = timestamp::now_rfc3339();
    let answers = net::scan_lan(targets, LAN_TIMEOUT).await?;

    let mut rows: Vec<ServerInfo> = answers
        .into_iter()
        .map(|(address, reply)| {
            let mut row = ServerInfo::from_infostring(
                game,
                address,
                &reply.infostring,
                reply.ping_ms,
                &last_seen,
            );
            row.decorate(favorites);
            row
        })
        .filter(|row| !is_hidden_mod(&row.mod_name))
        .collect();

    // The same second pass as a refresh: a server on the desk next to the
    // player hides `g_humanplayers` as readily as one on the internet.
    resolve_bots_by_status(app, game, RefreshScope::Lan, &mut rows).await;
    sort_rows(&mut rows);

    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    log::info!(
        "LAN sweep ({}): {} servers answered on {} ports in {elapsed_ms} ms",
        game.display_name(),
        rows.len(),
        targets.len()
    );
    if !rows.is_empty() {
        emit(
            app,
            "servers:batch",
            BatchEvent {
                game,
                scope: RefreshScope::Lan,
                servers: rows.clone(),
            },
        );
    }
    // Nobody knows how many servers are out there, so the two counts are the
    // same number: a sweep cannot report anybody as silent.
    emit(
        app,
        "servers:done",
        DoneEvent {
            game,
            scope: RefreshScope::Lan,
            total: rows.len(),
            responded: rows.len(),
            elapsed_ms,
        },
    );
    Ok(rows)
}

// --- slice: servers browser ---
/// Sends `getinfo` to every address and streams the answers to the window.
///
/// The loop that used to live inside `refresh_servers`, now the one place that
/// talks to a list of servers: at most [`MAX_IN_FLIGHT`] sockets open, one
/// `servers:batch` every [`BATCH_INTERVAL`], then the `getstatus` pass for the
/// rows that hide their human count. Where the addresses came from — a master
/// server or the player's own favourites — makes no difference to any of it.
///
/// `app` is `None` in tests, where there is no window to emit to.
async fn probe_addresses(
    app: Option<&tauri::AppHandle>,
    game: Game,
    scope: RefreshScope,
    addresses: Vec<SocketAddrV4>,
    favorites: &HashSet<String>,
    last_seen: &str,
) -> ProbeOutcome {
    let total = addresses.len();
    let mut hidden = 0usize;
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
        let mut server =
            ServerInfo::from_infostring(game, address, &reply.infostring, reply.ping_ms, last_seen);
        // Dropped before the batch and before `collected`, so a hidden mod
        // reaches neither the window nor the cache this refresh writes.
        if is_hidden_mod(&server.mod_name) {
            hidden += 1;
            continue;
        }
        server.decorate(favorites);
        batch.push(server.clone());
        collected.push(server);

        if flushed_at.elapsed() >= BATCH_INTERVAL {
            emit(
                app,
                "servers:batch",
                BatchEvent {
                    game,
                    scope,
                    servers: std::mem::take(&mut batch),
                },
            );
            flushed_at = Instant::now();
        }
    }
    if !batch.is_empty() {
        emit(
            app,
            "servers:batch",
            BatchEvent {
                game,
                scope,
                servers: batch,
            },
        );
    }

    resolve_bots_by_status(app, game, scope, &mut collected).await;
    sort_rows(&mut collected);
    ProbeOutcome {
        servers: collected,
        hidden,
    }
}

// --- slice: servers robustness ---
/// What one probe of a list of addresses produced.
///
/// The hidden count is carried out rather than only logged inside, because the
/// summary of a refresh has to answer «where did the rest of the addresses go»
/// in one line: the mod filter and a silent server are different fates and the
/// player asking why a server is missing needs to tell them apart.
struct ProbeOutcome {
    /// Rows of the addresses that answered, minus the hidden mods.
    servers: Vec<ServerInfo>,
    /// Answers dropped by [`is_hidden_mod`].
    hidden: usize,
}

// --- slice: servers browser ---
/// Replaces the rows of `incoming` by address and appends the ones that are new.
fn merge_rows(document: &mut Vec<ServerInfo>, incoming: &[ServerInfo]) {
    let mut index: BTreeMap<String, usize> = document
        .iter()
        .enumerate()
        .map(|(at, row)| (row.address.clone(), at))
        .collect();
    for row in incoming {
        match index.get(&row.address) {
            Some(&at) => document[at] = row.clone(),
            None => {
                index.insert(row.address.clone(), document.len());
                document.push(row.clone());
            }
        }
    }
}

// --- slice: servers browser ---
/// Folds the answers of a direct probe into the cache and returns the result.
///
/// A direct probe knows about the addresses it was given and nothing else, so
/// the document is read, the rows of those addresses replaced or appended, and
/// every other row left exactly as it was. Writing the probe's own list instead
/// would leave a Favorites refresh with a cache of three servers.
///
/// Only rows that answered are folded in. A silent address keeps the row it
/// already had, and an address nobody has ever seen does not become one: the
/// cache is the record of servers that were there, not of addresses that were
/// asked.
///
/// The read, the merge and the write are one step, and the caller runs them
/// under the game's cache lock — see [`merge_into_cache_locked`].
fn merge_into_cache(file: &PathBuf, answered: &[ServerInfo]) -> Vec<ServerInfo> {
    let mut document = read_cache(file);
    merge_rows(&mut document, answered);
    sort_rows(&mut document);
    write_cache(file, &document);
    document
}

// --- slice: servers browser ---
/// [`merge_into_cache`] with the game's cache lock held around all of it.
///
/// The lock is what makes the read part of the step: without it a merge that
/// read the document before a **Get new list** rewrote it would write its own
/// copy back afterwards, and every server the masters had just dropped would
/// return to the cache and outlive the launcher.
///
/// The merge still adds any address that answered, including one the masters
/// never listed — a favourite on a private server is exactly that. That row is
/// a fresh answer from the server itself, not a resurrection; a resurrection is
/// an old snapshot written over a newer one, which is what the lock rules out.
async fn merge_into_cache_locked(
    lock: &tokio::sync::Mutex<()>,
    file: &PathBuf,
    answered: &[ServerInfo],
) -> Vec<ServerInfo> {
    let _writing = lock.lock().await;
    merge_into_cache(file, answered)
}

// --- slice: servers browser ---
/// [`write_cache`] with the game's cache lock held.
///
/// The other half of the rule: a whole-document write waits for a merge that is
/// already under way instead of landing between its read and its write.
async fn write_cache_locked(
    lock: &tokio::sync::Mutex<()>,
    file: &PathBuf,
    servers: &[ServerInfo],
) {
    let _writing = lock.lock().await;
    write_cache(file, servers);
}

// --- slice: servers browser ---
/// One row per asked address that did not answer.
///
/// The row carries the name, map and counts of the last successful scan and
/// says so through [`ServerInfo::responded`]; an address nobody has ever
/// scanned gets a row of its address alone. A row of a hidden mod is left out,
/// the same way the cache reader leaves it out.
fn silent_rows(
    game: Game,
    document: &[ServerInfo],
    wanted: &[SocketAddrV4],
    answered: &[ServerInfo],
    favorites: &HashSet<String>,
) -> Vec<ServerInfo> {
    let replied: HashSet<&str> = answered.iter().map(|row| row.address.as_str()).collect();
    let mut silent = Vec::new();
    for address in wanted {
        let key = address.to_string();
        if replied.contains(key.as_str()) {
            continue;
        }
        let mut row = document
            .iter()
            .find(|kept| kept.address == key)
            .cloned()
            .unwrap_or_else(|| ServerInfo::unseen(game, *address));
        if is_hidden_mod(&row.mod_name) {
            continue;
        }
        row.responded = false;
        row.decorate(favorites);
        silent.push(row);
    }
    silent
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
    app: Option<&tauri::AppHandle>,
    game: Game,
    // --- slice: servers browser --- travels on the batch this pass emits.
    scope: RefreshScope,
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
                scope,
                servers: updated,
            },
        );
    }
    answered
}

// --- slice: servers robustness ---
/// Asks one master one question, and asks again when the answer is in doubt.
///
/// Two things are in doubt: a master that said nothing at all, and a master
/// whose datagrams stopped without the `\EOT` marker — the budget ended that
/// list, so what arrived is a prefix of it and looks exactly like a short one.
/// The second question is asked once, and both answers are merged: a master
/// that is rotating its own list gives two overlapping halves rather than one
/// of them.
async fn ask_master(master: &str, protocol: u16) -> Result<Vec<SocketAddrV4>> {
    let first = net::query_master(master, protocol, MASTER_TIMEOUT).await;
    if matches!(&first, Ok(reply) if reply.complete) {
        return first.map(|reply| reply.addresses);
    }

    log::info!("master {master} protocol {protocol}: asking again");
    let second = net::query_master(master, protocol, MASTER_TIMEOUT).await;
    match (first, second) {
        (Ok(first), Ok(second)) => {
            let mut merged: BTreeSet<SocketAddrV4> = first.addresses.into_iter().collect();
            merged.extend(second.addresses);
            Ok(merged.into_iter().collect())
        }
        (Ok(only), Err(_)) | (Err(_), Ok(only)) => Ok(only.addresses),
        (Err(first), Err(_)) => Err(first),
    }
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
                let found = ask_master(&master, protocol).await;
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
    // --- slice: account --- the service token never crosses the IPC boundary.
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
    fn a_refresh_drops_the_mod_folder_the_browser_hides() {
        // What the loop in `refresh_servers` asks of every answer, in the
        // three spellings an operator may have typed into `fs_game`.
        for spelling in ["mbii", "MBII", "MbII"] {
            let server = row(&format!("\\clients\\4\\game\\{spelling}"));
            assert_eq!(server.mod_name, spelling);
            assert!(is_hidden_mod(&server.mod_name), "{spelling} must be hidden");
        }
    }

    #[test]
    fn a_mod_that_merely_looks_alike_stays_on_the_list() {
        // The whole folder name is compared: a prefix match would take
        // somebody else's mod down with it.
        for spelling in ["mbii2", "japlus", "base", "mb2", ""] {
            assert!(!is_hidden_mod(spelling), "{spelling} must stay");
        }
    }

    #[test]
    fn a_cached_row_of_a_hidden_mod_never_reaches_the_screen() {
        // The rule runs on the way out of the cache as well, because a file
        // written before it existed still holds those rows.
        let file = std::env::temp_dir().join("jknet-test-hidden-mod-cache.json");
        write_cache(
            &file,
            &[
                row("\\clients\\4\\game\\MBII"),
                row("\\clients\\4\\game\\japlus"),
            ],
        );

        let mut read = read_cache(&file);
        assert_eq!(read.len(), 2, "the cache holds both rows");
        drop_hidden_mods(&mut read);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].mod_name, "japlus");
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn a_name_made_only_of_color_codes_shows_the_address() {
        let server = row("\\hostname\\^1^2^3   ");
        assert_eq!(server.hostname_clean, "81.19.210.136:29070");
    }

    #[test]
    fn decorating_stars_the_addresses_the_player_saved() {
        let mut starred = row(FULL_INFO);
        let mut plain = row(FULL_INFO);
        let favorites: HashSet<String> = ["81.19.210.136:29070".to_string()]
            .into_iter()
            .collect();
        starred.decorate(&favorites);
        plain.address = "1.2.3.4:29070".to_string();
        plain.decorate(&favorites);
        assert!(starred.favorite);
        assert!(!plain.favorite);
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
            \"protocol\":26,\"pingMs\":40,\"favorite\":false,\
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
            \"protocol\":26,\"pingMs\":40,\"favorite\":false,\
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
    fn a_row_written_before_0_4_survives_the_field_that_was_dropped() {
        // Until 0.4 every row carried a flag for the bundled list of
        // vouched-for servers. The status is gone and the field with it, but
        // the documents on disk still hold the key. `ServerInfo` declares no
        // `deny_unknown_fields`, so serde walks past a key nothing reads any
        // more instead of failing the row — and with it the whole list.
        let old = "{\"updatedAt\":\"2026-09-10T00:00:00Z\",\"servers\":[{\
            \"game\":\"ja\",\"address\":\"81.19.210.136:29070\",\
            \"hostnameRaw\":\"Blue\",\"hostnameClean\":\"Blue\",\
            \"map\":\"mp/ffa3\",\"gametype\":0,\"gametypeLabel\":\"FFA\",\
            \"clients\":6,\"humans\":4,\"bots\":2,\"playersSource\":\"info\",\
            \"maxClients\":32,\"needpass\":false,\"modName\":\"japlus\",\
            \"protocol\":26,\"pingMs\":40,\"trusted\":true,\"favorite\":true,\
            \"lastSeen\":\"2026-09-10T00:00:00Z\"}]}";
        let file = std::env::temp_dir().join("jknet-test-0-3-cache.json");
        fs::write(&file, old).unwrap();

        let read = read_cache(&file);
        assert_eq!(read.len(), 1, "the whole list must survive");
        assert_eq!(read[0].game, Game::JediAcademy);
        assert_eq!(read[0].hostname_clean, "Blue");
        assert_eq!(read[0].mod_name, "japlus");
        assert_eq!(read[0].humans, Some(4));
        // --- slice: servers browser ---
        // And it reads as a server that answered: the cache only ever holds
        // rows that were seen, so a document without the field is not a list
        // of ghosts.
        assert!(read[0].responded);
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

    // --- slice: servers robustness ---
    /// A master that cuts its first answer short and sends the whole list on
    /// the second question.
    ///
    /// The first reply carries half the addresses and no `\EOT`, which is what
    /// a master whose datagrams the budget cut off looks like from here. The
    /// counter says how many questions were asked, so the test can prove there
    /// was a second one rather than infer it from the addresses.
    async fn stub_flaky_master(
        first: &'static [&'static str],
        then: &'static [&'static str],
        cut_off_the_first: bool,
    ) -> (String, Arc<Mutex<usize>>) {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("a socket");
        let address = socket.local_addr().expect("an address").to_string();
        let asked = Arc::new(Mutex::new(0usize));
        let counter = Arc::clone(&asked);
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 2048];
            while let Ok(Ok((read, from))) = tokio::time::timeout(
                Duration::from_millis(4_000),
                socket.recv_from(&mut buffer),
            )
            .await
            {
                if !String::from_utf8_lossy(&buffer[4..read]).starts_with("getservers ") {
                    continue;
                }
                let seen = {
                    let mut asked = counter.lock().expect("the counter");
                    *asked += 1;
                    *asked
                };
                let datagram = if seen == 1 {
                    let mut packet = master_datagram(first);
                    if cut_off_the_first {
                        // The addresses of a half-sent list, with the
                        // end-of-transmission marker cut off with the rest.
                        packet.truncate(packet.len() - 7);
                    }
                    packet
                } else {
                    master_datagram(then)
                };
                let _ = socket.send_to(&datagram, from).await;
            }
        });
        (address, asked)
    }

    #[tokio::test]
    async fn a_master_answer_without_its_end_marker_is_asked_again() {
        static FIRST: &[&str] = &["10.0.0.1:29070", "10.0.0.2:29070"];
        static THEN: &[&str] = &["10.0.0.2:29070", "10.0.0.3:29070", "10.0.0.4:29070"];
        let (master, asked) = stub_flaky_master(FIRST, THEN, true).await;

        let found = collect_addresses(&[master], &[26])
            .await
            .expect("the stub answers");
        let listed: Vec<String> = found.iter().map(|peer| peer.to_string()).collect();
        assert_eq!(*asked.lock().expect("the counter"), 2, "asked twice");
        // Both answers, merged and deduplicated: a short first answer costs
        // nothing, and neither list alone is the whole one.
        assert_eq!(
            listed,
            vec![
                "10.0.0.1:29070".to_string(),
                "10.0.0.2:29070".to_string(),
                "10.0.0.3:29070".to_string(),
                "10.0.0.4:29070".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn a_master_that_closed_its_list_is_asked_once() {
        // The ordinary day: one question, one answer closed by `\EOT`, and no
        // second round trip spent on a master that already said everything.
        // The second list is there only so a second question would be visible
        // in the result as well as in the counter.
        static FIRST: &[&str] = &["10.0.0.7:29070"];
        static THEN: &[&str] = &["10.0.0.8:29070"];
        let (master, asked) = stub_flaky_master(FIRST, THEN, false).await;

        let found = collect_addresses(&[master], &[26])
            .await
            .expect("the stub answers");
        assert_eq!(*asked.lock().expect("the counter"), 1, "asked once");
        assert_eq!(found.len(), 1);
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

    // --- slice: servers browser ---

    /// A server on localhost that answers `getinfo` with one info string.
    ///
    /// Local only, so every check below runs without a network. The stub echoes
    /// the challenge it was sent, which is what `query_info` matches its answer
    /// on, and keeps answering until the test that owns the runtime goes away.
    async fn stub_server(infostring: &'static str) -> SocketAddrV4 {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("a socket");
        let address = match socket.local_addr().expect("an address") {
            std::net::SocketAddr::V4(v4) => v4,
            other => panic!("expected IPv4, got {other}"),
        };
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 2048];
            while let Ok(Ok((read, from))) = tokio::time::timeout(
                Duration::from_millis(2_500),
                socket.recv_from(&mut buffer),
            )
            .await
            {
                let Some(payload) = protocol::oob_payload(&buffer[..read]) else {
                    continue;
                };
                let (command, argument) = protocol::split_command(payload);
                if command != b"getinfo" {
                    continue;
                }
                let challenge = String::from_utf8_lossy(argument).trim().to_string();
                let reply = protocol::oob_packet(&format!(
                    "infoResponse\n\\challenge\\{challenge}{infostring}"
                ));
                let _ = socket.send_to(&reply, from).await;
            }
        });
        address
    }

    /// An address with nothing behind it, for the silent half of a probe.
    fn nowhere() -> SocketAddrV4 {
        "127.0.0.1:1".parse().expect("an address")
    }

    #[tokio::test]
    async fn a_direct_probe_asks_the_addresses_it_is_given_and_nothing_else() {
        // The Favorites tab: two saved addresses, one of them switched off. No
        // master server takes part, which is the whole point of the operation.
        let live = stub_server(
            "\\hostname\\^4Nearby\\mapname\\MP/FFA3\\clients\\2\\g_humanplayers\\2\\sv_maxclients\\16",
        )
        .await;
        let silent = nowhere();
        let favorites: HashSet<String> = [live.to_string(), silent.to_string()]
            .into_iter()
            .collect();

        let answered = probe_addresses(
            None,
            Game::JediAcademy,
            RefreshScope::Favorites,
            vec![live, silent],
            &favorites,
            "2026-09-11T00:00:00Z",
        )
        .await
        .servers;

        assert_eq!(answered.len(), 1, "only the server that answered");
        assert_eq!(answered[0].hostname_clean, "Nearby");
        assert_eq!(answered[0].map, "mp/ffa3");
        assert_eq!(answered[0].humans, Some(2));
        assert!(answered[0].responded);
        // The star comes from the settings, not from the wire, exactly as it
        // does on a master-driven refresh.
        assert!(answered[0].favorite);
    }

    #[tokio::test]
    async fn an_address_that_said_nothing_keeps_what_was_last_known_about_it() {
        let silent = nowhere();
        let favorites: HashSet<String> = [silent.to_string()].into_iter().collect();
        let known = vec![game_row(
            Game::JediAcademy,
            &silent.to_string(),
            "\\hostname\\Was here\\mapname\\mp/ffa3\\clients\\4\\g_humanplayers\\4",
        )];

        let missing = silent_rows(Game::JediAcademy, &known, &[silent], &[], &favorites);
        assert_eq!(missing.len(), 1, "a favourite that vanishes looks like a bug");
        assert_eq!(missing[0].address, silent.to_string());
        assert!(!missing[0].responded, "the screen mutes it and drops the ping");
        assert_eq!(missing[0].hostname_clean, "Was here");
        assert_eq!(missing[0].map, "mp/ffa3");
        assert!(missing[0].favorite);

        // An address nobody has ever scanned has nothing to carry, so it names
        // itself and claims nothing else.
        let unseen = silent_rows(Game::JediAcademy, &[], &[silent], &[], &favorites);
        assert_eq!(unseen[0].hostname_clean, silent.to_string());
        assert_eq!(unseen[0].clients, 0);
        assert_eq!(unseen[0].last_seen, "");
        assert!(!unseen[0].responded);

        // A row that answered is not reported silent as well.
        let answered = vec![game_row(
            Game::JediAcademy,
            &silent.to_string(),
            "\\hostname\\Back up\\clients\\1\\g_humanplayers\\1",
        )];
        assert!(silent_rows(Game::JediAcademy, &known, &[silent], &answered, &favorites).is_empty());
    }

    // --- slice: servers robustness ---

    #[test]
    fn a_full_scan_asks_the_cache_as_well_as_the_masters() {
        // The master rotates its own list between two presses of the button.
        // The addresses it stopped naming are still asked, so a server that is
        // simply not registered this minute keeps its row.
        let game = Game::JediAcademy;
        let from_masters: Vec<SocketAddrV4> = ["10.0.0.1:29070", "10.0.0.2:29070"]
            .iter()
            .map(|address| address.parse().expect("an address"))
            .collect();
        let cached = vec![
            game_row(game, "10.0.0.2:29070", "\\hostname\\Bravo\\clients\\0"),
            game_row(game, "10.0.0.9:29070", "\\hostname\\Private\\clients\\2\\g_humanplayers\\2"),
        ];

        let asked: Vec<String> = merge_addresses(game, &from_masters, &cached)
            .iter()
            .map(|peer| peer.to_string())
            .collect();
        assert_eq!(
            asked,
            vec![
                "10.0.0.1:29070".to_string(),
                "10.0.0.2:29070".to_string(),
                "10.0.0.9:29070".to_string(),
            ],
            "the union of both sources, deduplicated"
        );

        // A cached row with an address that stopped parsing costs itself and
        // nothing else: the press still asks everybody else.
        let broken = vec![game_row(game, "10.0.0.9:29070", "").clone()];
        let mut broken = broken;
        broken[0].address = "not an address".to_string();
        assert_eq!(merge_addresses(game, &from_masters, &broken).len(), 2);
    }

    #[test]
    fn a_silent_server_is_dropped_on_the_second_miss_and_not_the_first() {
        let game = Game::JediAcademy;
        let live: SocketAddrV4 = "10.0.0.1:29070".parse().expect("an address");
        let gone: SocketAddrV4 = "10.0.0.2:29070".parse().expect("an address");
        let favorites: HashSet<String> = [gone.to_string()].into_iter().collect();
        let cached = vec![
            game_row(game, &live.to_string(), "\\hostname\\Alpha\\clients\\1\\g_humanplayers\\1"),
            game_row(game, &gone.to_string(), "\\hostname\\Bravo\\clients\\4\\g_humanplayers\\4"),
        ];

        // First scan: Alpha answers, Bravo does not. Both rows stay.
        let mut rows = vec![game_row(
            game,
            &live.to_string(),
            "\\hostname\\Alpha\\clients\\2\\g_humanplayers\\2",
        )];
        let first = keep_silent_rows(game, &cached, &[live, gone], &mut rows, &favorites);
        assert_eq!((first.silent, first.dropped), (1, 0));
        assert_eq!(rows.len(), 2, "the server that went quiet keeps its row");
        let muted = rows.iter().find(|row| row.address == gone.to_string()).unwrap();
        assert!(!muted.responded, "the screen mutes it and drops the ping");
        assert_eq!(muted.hostname_clean, "Bravo", "with what was last known");
        assert_eq!(muted.missed_refreshes, 1);
        assert!(muted.favorite, "the star comes from the settings");
        // And the row that answered starts over from zero.
        let alive = rows.iter().find(|row| row.address == live.to_string()).unwrap();
        assert_eq!(alive.missed_refreshes, 0);

        // Second scan, over the document the first one wrote: Bravo is gone.
        let mut rows = vec![game_row(
            game,
            &live.to_string(),
            "\\hostname\\Alpha\\clients\\2\\g_humanplayers\\2",
        )];
        let second = keep_silent_rows(game, &rows_of(&muted.clone(), &cached), &[live, gone], &mut rows, &favorites);
        assert_eq!((second.silent, second.dropped), (0, 1));
        assert_eq!(rows.len(), 1, "two misses in a row take the row off the list");

        // An address the masters named that nobody has ever seen does not
        // become a row: the cache records servers, not addresses.
        let stranger: SocketAddrV4 = "10.0.0.9:29070".parse().expect("an address");
        let mut rows: Vec<ServerInfo> = Vec::new();
        let counts = keep_silent_rows(game, &cached, &[stranger], &mut rows, &favorites);
        assert_eq!((counts.silent, counts.dropped), (0, 0));
        assert!(rows.is_empty());
    }

    /// The cached document of the second scan: the muted row over the first one.
    fn rows_of(muted: &ServerInfo, cached: &[ServerInfo]) -> Vec<ServerInfo> {
        let mut document = cached.to_vec();
        merge_rows(&mut document, std::slice::from_ref(muted));
        document
    }

    #[test]
    fn a_row_written_before_the_miss_counter_existed_still_reads() {
        // A 0.3 document has no counter on its rows, and serde has to fill it
        // rather than throw the list away.
        let file = std::env::temp_dir()
            .join("jknet-test-cache-without-the-counter")
            .join("servers-ja.json");
        let _ = fs::remove_file(&file);
        fs::create_dir_all(file.parent().unwrap()).expect("the folder");
        fs::write(
            &file,
            r#"{"updatedAt":"2026-09-10T00:00:00Z","servers":[{"game":"ja",
               "address":"10.0.0.1:29070","hostnameRaw":"Alpha","hostnameClean":"Alpha",
               "map":"mp/ffa3","gametype":0,"gametypeLabel":"FFA","clients":2,"humans":2,
               "maxClients":16,"needpass":false,"protocol":26,"pingMs":40,"favorite":false,
               "lastSeen":"2026-09-10T00:00:00Z"}]}"#,
        )
        .expect("the document");

        let read = read_cache(&file);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].missed_refreshes, 0, "an old row has missed nothing");
        assert!(read[0].responded, "and is not a ghost");
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn the_log_names_the_servers_the_masters_did_not() {
        let game = Game::JediAcademy;
        let from_masters: Vec<SocketAddrV4> =
            vec!["10.0.0.1:29070".parse().expect("an address")];
        let mut listed = game_row(game, "10.0.0.1:29070", "\\hostname\\Listed\\clients\\0");
        let mut stranger = game_row(game, "10.0.0.9:29070", "\\hostname\\Private\\clients\\1");
        let mut silent = game_row(game, "10.0.0.8:29070", "\\hostname\\Gone\\clients\\0");
        listed.responded = true;
        stranger.responded = true;
        silent.responded = false;

        let named = answered_off_the_master_list(&from_masters, &[listed, stranger, silent]);
        assert_eq!(
            named,
            vec!["10.0.0.9:29070".to_string()],
            "only the address that answered without being on the list"
        );
    }

    #[test]
    fn a_direct_probe_merges_into_the_cache_instead_of_rewriting_it() {
        // What a Favorites refresh must not do: leave the player with a cache
        // of three servers because that is all it asked about.
        let file = std::env::temp_dir()
            .join("jknet-test-merge-cache")
            .join("servers-ja.json");
        let _ = fs::remove_file(&file);
        write_cache(
            &file,
            &[
                game_row(Game::JediAcademy, "10.0.0.1:29070", "\\hostname\\Alpha\\clients\\1\\g_humanplayers\\1"),
                game_row(Game::JediAcademy, "10.0.0.2:29070", "\\hostname\\Bravo\\clients\\0"),
            ],
        );

        let merged = merge_into_cache(
            &file,
            &[
                game_row(Game::JediAcademy, "10.0.0.2:29070", "\\hostname\\Bravo renamed\\clients\\5\\g_humanplayers\\5"),
                game_row(Game::JediAcademy, "10.0.0.9:29070", "\\hostname\\Charlie\\clients\\2\\g_humanplayers\\2"),
            ],
        );

        let names: BTreeMap<String, String> = merged
            .iter()
            .map(|row| (row.address.clone(), row.hostname_clean.clone()))
            .collect();
        assert_eq!(names.len(), 3, "the row nobody asked about is still there");
        assert_eq!(names["10.0.0.1:29070"], "Alpha", "untouched");
        assert_eq!(names["10.0.0.2:29070"], "Bravo renamed", "replaced by address");
        assert_eq!(names["10.0.0.9:29070"], "Charlie", "appended");
        // And the document on disk says the same, not only the value returned.
        assert_eq!(read_cache(&file).len(), 3);
        let _ = fs::remove_file(&file);
    }

    /// Host name of every row of a document, keyed by address.
    fn cached_names(document: &[ServerInfo]) -> BTreeMap<String, String> {
        document
            .iter()
            .map(|row| (row.address.clone(), row.hostname_clean.clone()))
            .collect()
    }

    #[tokio::test]
    async fn a_direct_probe_that_lands_last_does_not_bring_back_a_dropped_row() {
        // **Get new list** and a **Refresh** of the Favorites tab are different
        // scopes, so `claim` lets them run at the same time — and both of them
        // end at `cache\servers-ja.json`. Here the merge lands last.
        let game = Game::JediAcademy;
        let file = std::env::temp_dir()
            .join("jknet-test-cache-race-merge-last")
            .join("servers-ja.json");
        let _ = fs::remove_file(&file);
        write_cache(
            &file,
            &[
                game_row(game, "10.0.0.1:29070", "\\hostname\\Alpha\\clients\\1\\g_humanplayers\\1"),
                game_row(game, "10.0.0.2:29070", "\\hostname\\Bravo\\clients\\0"),
            ],
        );

        let state = Arc::new(RefreshState::default());
        // The full scan holds the lock: it has the answer of the masters and is
        // about to write it, and Bravo is not on that answer any more.
        let full_scan = state.cache_lock(game).lock().await;

        let merging = tokio::spawn({
            let state = Arc::clone(&state);
            let file = file.clone();
            let answered = vec![
                game_row(game, "10.0.0.1:29070", "\\hostname\\Alpha\\clients\\3\\g_humanplayers\\3"),
                game_row(game, "10.0.0.9:29070", "\\hostname\\Charlie\\clients\\2\\g_humanplayers\\2"),
            ];
            async move { merge_into_cache_locked(state.cache_lock(game), &file, &answered).await }
        });

        // The Favorites refresh has its answers in hand and still cannot read
        // the file. Without the lock it would have read it here — the two rows
        // of the old document, Bravo included.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(read_cache(&file).len(), 2, "the merge is waiting, not writing");

        write_cache(
            &file,
            &[game_row(game, "10.0.0.1:29070", "\\hostname\\Alpha\\clients\\4\\g_humanplayers\\4")],
        );
        drop(full_scan);

        let names = cached_names(&merging.await.expect("the merge finishes"));
        assert!(
            !names.contains_key("10.0.0.2:29070"),
            "the merge read the fresh document, so the row the masters dropped stays dropped"
        );
        // A favourite the masters never listed is not a resurrection: that
        // server answered this very probe, and the row is its own answer.
        assert_eq!(names["10.0.0.9:29070"], "Charlie");
        assert_eq!(names.len(), 2, "the fresh row and the one that answered");
        assert_eq!(cached_names(&read_cache(&file)).len(), 2, "and so does the disk");
        let _ = fs::remove_file(&file);
    }

    #[tokio::test]
    async fn a_full_scan_that_lands_last_writes_the_masters_list_whole() {
        // The mirror case: the Favorites refresh is in the middle of its
        // read-merge-write and **Get new list** finishes second.
        let game = Game::JediAcademy;
        let file = std::env::temp_dir()
            .join("jknet-test-cache-race-full-last")
            .join("servers-ja.json");
        let _ = fs::remove_file(&file);
        write_cache(
            &file,
            &[
                game_row(game, "10.0.0.1:29070", "\\hostname\\Alpha\\clients\\1\\g_humanplayers\\1"),
                game_row(game, "10.0.0.2:29070", "\\hostname\\Bravo\\clients\\0"),
            ],
        );

        let state = Arc::new(RefreshState::default());
        let merge = state.cache_lock(game).lock().await;

        let writing = tokio::spawn({
            let state = Arc::clone(&state);
            let file = file.clone();
            let collected = vec![game_row(
                game,
                "10.0.0.1:29070",
                "\\hostname\\Alpha\\clients\\4\\g_humanplayers\\4",
            )];
            async move { write_cache_locked(state.cache_lock(game), &file, &collected).await }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(read_cache(&file).len(), 2, "the full scan is waiting, not writing");

        // The merge runs to its end untorn: nothing landed between its read and
        // its write, so it loses nothing it had just learned.
        let merged = merge_into_cache(
            &file,
            &[game_row(game, "10.0.0.9:29070", "\\hostname\\Charlie\\clients\\2\\g_humanplayers\\2")],
        );
        assert_eq!(merged.len(), 3);
        drop(merge);

        writing.await.expect("the full scan finishes");
        let addresses: Vec<String> = read_cache(&file)
            .iter()
            .map(|row| row.address.clone())
            .collect();
        // The masters' list, whole and alone: Bravo is gone for good, and the
        // favourite it did not list goes with it until the next Refresh of the
        // Favorites tab asks that address again.
        assert_eq!(addresses, vec!["10.0.0.1:29070".to_string()]);
        let _ = fs::remove_file(&file);
    }

    #[tokio::test]
    async fn a_lan_sweep_lists_the_servers_of_the_ports_it_is_given() {
        // Four ports of the broadcast address in the launcher; four stubs on
        // localhost here, because a test must not put a datagram on the real
        // network. Everything between the send and the row is the same code.
        let busy = stub_server(
            "\\hostname\\Desk\\mapname\\mp/ffa1\\clients\\1\\g_humanplayers\\1\\sv_maxclients\\8",
        )
        .await;
        let quiet = stub_server("\\hostname\\Laptop\\mapname\\mp/duel1\\clients\\0\\game\\japlus")
            .await;

        let rows = scan_lan(
            None,
            Game::JediAcademy,
            &[busy, quiet, nowhere()],
            &HashSet::new(),
        )
        .await
        .expect("the sweep runs");

        let names: Vec<&str> = rows.iter().map(|row| row.hostname_clean.as_str()).collect();
        assert_eq!(names, vec!["Desk", "Laptop"], "busiest first, nobody invented");
        assert!(rows.iter().all(|row| row.responded));
        assert_eq!(rows[1].mod_name, "japlus");
        // A sweep answers with rows and never with the cache, so nothing here
        // can reach `cache\servers-ja.json`.
        assert_eq!(rows[0].game, Game::JediAcademy);
    }

    #[test]
    fn a_lan_sweep_asks_four_ports_of_the_game_it_is_for() {
        let ja: Vec<String> = broadcast_targets(Game::JediAcademy)
            .iter()
            .map(SocketAddrV4::to_string)
            .collect();
        assert_eq!(
            ja,
            vec![
                "255.255.255.255:29070",
                "255.255.255.255:29071",
                "255.255.255.255:29072",
                "255.255.255.255:29073",
            ]
        );
        let jo = broadcast_targets(Game::JediOutcast);
        assert_eq!(jo.len(), usize::from(crate::game::LAN_PORT_COUNT));
        assert_eq!(jo[0].port(), 28070);
        assert_eq!(jo[3].port(), 28073);
    }

    #[test]
    fn one_tab_of_one_game_scans_once_at_a_time() {
        let state = RefreshState::default();
        let claim = state
            .claim(Game::JediAcademy, RefreshScope::Favorites)
            .expect("the first claim");
        // The same tab twice is the second press the window failed to swallow.
        let refused = state
            .claim(Game::JediAcademy, RefreshScope::Favorites)
            .expect_err("the same scope is busy");
        assert!(refused.to_string().contains("already running"));

        // Another tab, and the other game, are separate jobs: both start.
        let _all = state
            .claim(Game::JediAcademy, RefreshScope::All)
            .expect("another tab of the same game");
        let _other = state
            .claim(Game::JediOutcast, RefreshScope::Favorites)
            .expect("the same tab of the other game");

        drop(claim);
        assert!(
            state.claim(Game::JediAcademy, RefreshScope::Favorites).is_ok(),
            "the guard releases the tab however the refresh ended"
        );
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
                        Ok(reply) => println!(
                            "{master} protocol {protocol}: {} addresses in {} ms, {}",
                            reply.addresses.len(),
                            started.elapsed().as_millis(),
                            if reply.complete {
                                "closed by \\EOT"
                            } else {
                                "cut off by the budget"
                            }
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
