//! The server browser.
//!
//! One refresh is two stages. First both master servers are asked for their
//! address lists over UDP; the lists are merged and deduplicated. Then every
//! address is sent a `getinfo` with a bounded number of requests in flight,
//! and the round trip time of that request is the ping the browser shows.
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
use crate::settings::{ServerHistoryEntry, Settings};
use crate::state::AppState;
use crate::timestamp;

use protocol::{gametype_label, parse_infostring, strip_colors, PROTOCOL_VERSION};

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

/// How often the collected rows are pushed to the window during a refresh.
const BATCH_INTERVAL: Duration = Duration::from_millis(100);

/// Port a Jedi Academy server listens on when the address gives no port,
/// `PORT_SERVER` in `codemp/qcommon/qcommon.h:224`.
const DEFAULT_SERVER_PORT: u16 = 29070;

/// Name of the cache document inside `cache\`.
const CACHE_FILE: &str = "servers.json";

/// How many addresses `server_history` keeps.
const HISTORY_LIMIT: usize = 50;

/// One row of the browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// `ip:port`, the key of the row everywhere in the launcher.
    pub address: String,
    /// Host name exactly as the server sent it, colour codes included.
    pub hostname_raw: String,
    /// The same name with `^1`-style colour codes removed.
    pub hostname_clean: String,
    /// Map file without a path, for example `mp/ffa3`.
    pub map: String,
    /// `gametype` key of the info string.
    pub gametype: u8,
    /// Label of `gametype`, or `Mode <n>` for a number a mod invented.
    pub gametype_label: String,
    /// Players the server counts, bots included.
    pub clients: u16,
    /// `g_humanplayers`: the same count without bots. `None` on a server that
    /// does not publish the key, which is every non-OpenJK build before 1.01.
    pub humans: Option<u16>,
    /// Slots offered to the public, private slots already subtracted.
    pub max_clients: u16,
    pub needpass: bool,
    /// `fs_game` of the server, `base` when the key is absent or empty.
    pub game: String,
    /// Network protocol; 26 is Jedi Academy 1.01.
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
        address: SocketAddrV4,
        infostring: &str,
        ping_ms: u32,
        last_seen: &str,
    ) -> ServerInfo {
        let info = parse_infostring(infostring);
        let hostname_raw = info.get("hostname").cloned().unwrap_or_default();
        let clean = strip_colors(&hostname_raw).trim().to_string();
        let gametype = number(&info, "gametype").unwrap_or(0);
        let game = info
            .get("game")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("base")
            .to_string();

        ServerInfo {
            address: address.to_string(),
            hostname_clean: if clean.is_empty() {
                address.to_string()
            } else {
                clean
            },
            hostname_raw,
            map: info.get("mapname").cloned().unwrap_or_default(),
            gametype,
            gametype_label: gametype_label(gametype),
            clients: number(&info, "clients").unwrap_or(0),
            humans: number(&info, "g_humanplayers"),
            max_clients: number(&info, "sv_maxclients").unwrap_or(0),
            needpass: number::<i32>(&info, "needpass").unwrap_or(0) != 0,
            game,
            protocol: number(&info, "protocol").unwrap_or(PROTOCOL_VERSION),
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
    servers: Vec<ServerInfo>,
}

/// Payload of `servers:done`, emitted once when a refresh ends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
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
}

/// Reads `ip:port`, or `ip` with the stock server port.
fn parse_address(address: &str) -> Result<SocketAddrV4> {
    let address = address.trim();
    let with_port = if address.contains(':') {
        address.to_string()
    } else {
        format!("{address}:{DEFAULT_SERVER_PORT}")
    };
    with_port
        .parse()
        .map_err(|_| AppError::InvalidInput(format!("`{address}` is not an IPv4 address and port")))
}

/// Path of the cache document for the settings in force right now.
fn cache_file(state: &AppState) -> Result<PathBuf> {
    Ok(state.paths()?.cache.join(CACHE_FILE))
}

/// Reads the cached list, or an empty one when there is no cache yet.
///
/// A cache that fails to parse is treated as absent: the next refresh
/// overwrites it, and a stale format must never keep the screen from opening.
fn read_cache(file: &PathBuf) -> Vec<ServerInfo> {
    match fs::read_to_string(file) {
        Ok(text) => match serde_json::from_str::<ServerCache>(&text) {
            Ok(cache) => cache.servers,
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
fn sort_rows(servers: &mut [ServerInfo]) {
    servers.sort_by(|a, b| {
        b.clients
            .cmp(&a.clients)
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
/// network answers anything.
#[tauri::command]
pub fn get_cached_servers(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ServerInfo>> {
    let file = cache_file(&state)?;
    let trusted = trusted_index(&app);
    let favorites: HashSet<String> = state.settings()?.favorite_servers.into_iter().collect();

    let mut servers = read_cache(&file);
    for server in &mut servers {
        server.decorate(&trusted, &favorites);
    }
    sort_rows(&mut servers);
    Ok(servers)
}

/// Queries the master servers, pings every address and refreshes the cache.
///
/// `masters` overrides the two stock master servers, which is what a test or a
/// player behind a blocked DNS needs. An empty list falls back to the stock
/// pair.
///
/// Fails only when no master answered at all: one dead master out of two is a
/// normal day, and the list from the other one is worth showing.
#[tauri::command]
pub async fn refresh_servers(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    masters: Option<Vec<String>>,
) -> Result<Vec<ServerInfo>> {
    let started = Instant::now();
    // Everything the shared state owns is copied out before the first await,
    // so a long refresh never holds a lock a settings write may be waiting on.
    let file = cache_file(&state)?;
    let trusted = trusted_index(&app);
    let favorites: HashSet<String> = state.settings()?.favorite_servers.into_iter().collect();

    let masters: Vec<String> = masters
        .map(|list| {
            list.into_iter()
                .map(|master| master.trim().to_string())
                .filter(|master| !master.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|list| !list.is_empty())
        .unwrap_or_else(|| {
            protocol::DEFAULT_MASTERS
                .iter()
                .map(|master| (*master).to_string())
                .collect()
        });

    let addresses = collect_addresses(&masters).await?;
    let total = addresses.len();
    log::info!("{total} addresses from {} master(s)", masters.len());

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
        let mut server =
            ServerInfo::from_infostring(address, &reply.infostring, reply.ping_ms, &last_seen);
        server.decorate(&trusted, &favorites);
        batch.push(server.clone());
        collected.push(server);

        if flushed_at.elapsed() >= BATCH_INTERVAL {
            emit(
                &app,
                "servers:batch",
                BatchEvent {
                    servers: std::mem::take(&mut batch),
                },
            );
            flushed_at = Instant::now();
        }
    }
    if !batch.is_empty() {
        emit(&app, "servers:batch", BatchEvent { servers: batch });
    }

    sort_rows(&mut collected);
    write_cache(&file, &collected);

    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    log::info!(
        "refresh: {} of {total} servers answered in {elapsed_ms} ms",
        collected.len()
    );
    emit(
        &app,
        "servers:done",
        DoneEvent {
            total,
            responded: collected.len(),
            elapsed_ms,
        },
    );
    Ok(collected)
}

/// Asks every master at once and merges the answers.
///
/// The set deduplicates: the two masters share most of their entries, and a
/// single master may repeat an address across datagrams.
async fn collect_addresses(masters: &[String]) -> Result<Vec<SocketAddrV4>> {
    let mut queries = JoinSet::new();
    for master in masters {
        let master = master.clone();
        queries.spawn(async move {
            let found = net::query_master(&master, PROTOCOL_VERSION, MASTER_TIMEOUT).await;
            (master, found)
        });
    }

    let mut merged: BTreeSet<SocketAddrV4> = BTreeSet::new();
    let mut answered = 0usize;
    let mut failures: Vec<String> = Vec::new();
    while let Some(joined) = queries.join_next().await {
        match joined {
            Ok((master, Ok(found))) => {
                log::info!("master {master} returned {} addresses", found.len());
                answered += 1;
                merged.extend(found);
            }
            Ok((master, Err(e))) => failures.push(format!("{master} ({e})")),
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
#[tauri::command]
pub async fn get_server_status(address: String) -> Result<ServerStatus> {
    let peer = parse_address(&address)?;
    let reply = net::query_status(peer, MASTER_TIMEOUT).await?;
    let players = protocol::parse_status_players(&reply.players)
        .into_iter()
        .map(|player| PlayerInfo {
            name_clean: strip_colors(&player.name_raw).trim().to_string(),
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
fn edit_settings(
    state: &tauri::State<'_, AppState>,
    edit: impl FnOnce(&mut Settings),
) -> Result<Settings> {
    let mut settings = state.settings()?;
    edit(&mut settings);
    settings.save(state)?;
    state.set_settings(settings.clone())?;
    Ok(settings)
}

/// Stars or unstars a server. Returns the settings so the frontend can update
/// its cache without a second round trip.
#[tauri::command]
pub fn set_server_favorite(
    state: tauri::State<'_, AppState>,
    address: String,
    favorite: bool,
) -> Result<Settings> {
    let address = parse_address(&address)?.to_string();
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
) -> Result<Settings> {
    let address = parse_address(&address)?.to_string();
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
        ServerInfo::from_infostring(
            "81.19.210.136:29070".parse().unwrap(),
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
        assert_eq!(server.game, "japlus");
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
        assert_eq!(server.game, "base");
        assert_eq!(server.gametype_label, "FFA");
        assert_eq!(server.humans, None);
        assert_eq!(server.protocol, 26);
        assert_eq!(server.max_clients, 0);
        assert!(!server.needpass);
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
        assert_eq!(server.game, "base");
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
        rows[0].clients = 2;
        rows[0].hostname_clean = "Zulu".into();
        rows[1].clients = 9;
        rows[1].hostname_clean = "Bravo".into();
        rows[2].clients = 2;
        rows[2].hostname_clean = "alpha".into();
        sort_rows(&mut rows);
        let names: Vec<&str> = rows.iter().map(|r| r.hostname_clean.as_str()).collect();
        assert_eq!(names, vec!["Bravo", "alpha", "Zulu"]);
    }

    #[test]
    fn reads_an_address_with_and_without_a_port() {
        assert_eq!(
            parse_address("81.19.210.136").unwrap().to_string(),
            "81.19.210.136:29070"
        );
        assert_eq!(
            parse_address("  81.19.210.136:29071 ").unwrap().to_string(),
            "81.19.210.136:29071"
        );
        assert!(parse_address("not-an-address").is_err());
        assert!(parse_address("").is_err());
        // IPv6 is out of scope: the master's record format cannot carry it.
        assert!(parse_address("[::1]:29070").is_err());
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
        for master in protocol::DEFAULT_MASTERS {
            let started = Instant::now();
            let found = net::query_master(master, PROTOCOL_VERSION, MASTER_TIMEOUT).await;
            match found {
                Ok(addresses) => println!(
                    "{master}: {} addresses in {} ms",
                    addresses.len(),
                    started.elapsed().as_millis()
                ),
                Err(e) => println!("{master}: {e}"),
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
        let masters: Vec<String> = protocol::DEFAULT_MASTERS
            .iter()
            .map(|master| (*master).to_string())
            .collect();
        let addresses = collect_addresses(&masters)
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
            parse_address(&busiest.address).unwrap(),
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
}
