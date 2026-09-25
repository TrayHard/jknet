//! A private server on this PC: the launcher starts the dedicated server of a
//! client, keeps it running while friends play and stops it.
//!
//! | File | What it holds |
//! | --- | --- |
//! | `mod.rs` | [`HostState`], the commands, the `host:session` event, the life of a session and its auto-stop |
//! | `server.rs` | the command line and `jknet-host.cfg`, readiness, polls, map changes, rcon |
//! | `console.rs` | the process under a pseudo console, its Job Object, its output |
//! | `maps.rs` | the maps of a client, out of its `.arena` files |
//! | `network.rs` | the addresses of this machine on its local network |
//! | `wire.rs` | the messages of the relay protocol and their signature |
//! | `tunnel.rs` | the tunnel between the relay node and the server |
//! | `join.rs` | a guest joins: the local network first, the relay next |
//!
//! ## A session
//!
//! ```text
//! host_start ──▶ starting ──ready──▶ running ──▶ stopping ──▶ stopped
//!                   │  exit, 30 s, no port      │ exit              │
//!                   └──────────▶ failed ◀───────┘                   │
//!                                                  user, empty, relay_expired, launcher_exit
//! ```
//!
//! One session at a time: `host_start` refuses with `hostBusy` while one is
//! starting, running or stopping. The guard is in [`HostState`], not in a
//! button. A session that stopped or failed stays readable until the next
//! start, so the screen can show how it ended.
//!
//! A supervisor task owns the process and the tunnel. It waits for the
//! server to answer with the label of the session, then polls it every 5 s:
//! players, the auto-stop, the ticket of the relay. Every change goes out as
//! `host:session` with the whole [`HostSession`]. While the session runs,
//! the presence carries `hosting` (see `friends::presence::effective`).
//!
//! ## Auto-stop
//!
//! The server stops by itself 10 minutes after the last player left, or 15
//! minutes after it came up when nobody ever joined. Bots do not count.
//!
//! ## Closing the launcher
//!
//! A close of the main window while a server runs is held and announced as
//! `host:close-requested`; the window asks **Stop your server and quit?**. If
//! the window goes anyway, [`shutdown_on_exit`] stops the server on the way
//! out, and if the launcher dies, the Job Object takes the server with it.

pub mod console;
pub mod join;
pub mod maps;
pub mod network;
pub mod server;
/// The chain without a window, for `examples/host_smoke.rs`; the crate root
/// re-exports it hidden.
pub mod smoke;
pub mod tunnel;
pub mod wire;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};

use crate::error::{AppError, Result};
use crate::friends::HostPresence;
use crate::game::{Game, SCORE_CVARS};
use crate::launch::{LaunchState, RunningGame};
use crate::online::{HostingInfo, Invite, NewInvite, OnlineClient, OnlineContext, RelayGrant};
use crate::settings::{HostDefaults, Settings};
use crate::state::AppState;
use crate::timestamp;

use console::{ConsoleOutput, Marker, ServerProcess};
use server::{Network, NotReady, ServerConfig, StartWatch};
use tunnel::{TunnelEvent, TunnelFailure, TunnelHandle};

/// The whole [`HostSession`], on every change.
pub const EVENT_SESSION: &str = "host:session";
/// No payload: the main window was closed while a server runs.
pub const EVENT_CLOSE_REQUESTED: &str = "host:close-requested";

/// The file the server's console goes to, in `logs\` of the data folder.
pub const LOG_FILE: &str = "host-server.log";

/// Budget of a start: the server answers with its label within this.
const READY_BUDGET: Duration = Duration::from_secs(30);
/// Players are counted this often.
const POLL_EVERY: Duration = Duration::from_secs(5);
/// Nobody on a server somebody played on: stop after this.
const EMPTY_STOP: Duration = Duration::from_secs(10 * 60);
/// Nobody ever joined: stop this long after the server came up.
const UNUSED_STOP: Duration = Duration::from_secs(15 * 60);
/// The ticket of the relay is renewed this long before it runs out.
const RENEW_BEFORE: Duration = Duration::from_secs(10 * 60);
/// The addresses of the local network are read again this often.
const LAN_REFRESH: Duration = Duration::from_secs(30);
/// How long the start waits for the relay once the server is up.
const RELAY_GRACE: Duration = Duration::from_secs(10);
/// `rcon quit`, then this long before the next way out.
const QUIT_WAIT: Duration = Duration::from_secs(3);
/// Lines of the console a failed session carries.
const FAILED_TAIL: usize = 30;
/// Longest wait of `host_stop` for the supervisor to finish.
const STOP_WAIT: Duration = Duration::from_secs(12);

// ---------------------------------------------------------------------------
// What the frontend sends and reads
// ---------------------------------------------------------------------------

/// Which friends join without an invite and get the password.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JoinPolicy {
    /// Every friend.
    Friends,
    /// The friends of `joinUserIds`.
    Selected,
    /// Nobody: invites only.
    Invite,
}

impl JoinPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            JoinPolicy::Friends => "friends",
            JoinPolicy::Selected => "selected",
            JoinPolicy::Invite => "invite",
        }
    }

    fn parse(text: &str) -> Option<JoinPolicy> {
        match text {
            "friends" => Some(JoinPolicy::Friends),
            "selected" => Some(JoinPolicy::Selected),
            "invite" => Some(JoinPolicy::Invite),
            _ => None,
        }
    }
}

/// What `host_start` is given. `Debug` leaves the password out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    pub client_id: String,
    pub map: String,
    pub gametype: u32,
    pub max_players: u32,
    pub time_limit: u32,
    pub score_limit: u32,
    pub bots: u32,
    pub server_name: String,
    pub password: Option<String>,
    pub network: Network,
    pub join_policy: JoinPolicy,
    #[serde(default)]
    pub join_user_ids: Vec<String>,
    #[serde(default)]
    pub invite_user_ids: Vec<String>,
    #[serde(default)]
    pub join_after_start: bool,
}

impl std::fmt::Debug for HostSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Every field named: a new one fails to build until it is listed here.
        let HostSettings {
            client_id,
            map,
            gametype,
            max_players,
            time_limit,
            score_limit,
            bots,
            server_name,
            password,
            network,
            join_policy,
            join_user_ids,
            invite_user_ids,
            join_after_start,
        } = self;
        f.debug_struct("HostSettings")
            .field("client_id", client_id)
            .field("map", map)
            .field("gametype", gametype)
            .field("max_players", max_players)
            .field("time_limit", time_limit)
            .field("score_limit", score_limit)
            .field("bots", bots)
            .field("server_name", server_name)
            .field("password", &password.as_ref().map(|_| "<redacted>"))
            .field("network", network)
            .field("join_policy", join_policy)
            .field("join_user_ids", join_user_ids)
            .field("invite_user_ids", invite_user_ids)
            .field("join_after_start", join_after_start)
            .finish()
    }
}

/// Why a client of the game cannot host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientBlock {
    NoDedicatedServer,
    EngineMissing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostClientOption {
    pub id: String,
    pub name: String,
    pub engine_id: String,
    pub can_host: bool,
    pub reason: Option<ClientBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGametypeOption {
    pub index: u8,
    pub id: &'static str,
    pub label: &'static str,
    pub score_cvar: Option<&'static str>,
    pub default_score: u16,
}

/// Why the relay cannot be asked right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayBlock {
    SignedOut,
    NotConfigured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayAvailability {
    pub available: bool,
    pub reason: Option<RelayBlock>,
}

/// The answer of `host_get_options`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOptions {
    pub game: Game,
    pub clients: Vec<HostClientOption>,
    pub gametypes: Vec<HostGametypeOption>,
    pub defaults: HostSettings,
    pub relay: RelayAvailability,
    pub show_firewall_note: bool,
    pub port_from: u16,
    pub port_to: u16,
}

/// Where the `.bsp` of a map comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MapSource {
    Game,
    Client,
}

/// One map of `host_list_maps`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMap {
    pub name: String,
    pub title: Option<String>,
    pub gametypes: Vec<String>,
    pub source: MapSource,
    pub levelshot: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl SessionStatus {
    /// Starting, running or stopping: the session holds the slot.
    pub fn is_active(self) -> bool {
        matches!(self, SessionStatus::Starting | SessionStatus::Running | SessionStatus::Stopping)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepId {
    Server,
    Map,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Pending,
    Active,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HostStep {
    pub step: StepId,
    pub state: StepState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RelayStatus {
    Off,
    Connecting,
    Active,
    Unavailable,
    Lost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayErrorCode {
    Unavailable,
    NodeSilent,
    QuotaActive,
    QuotaDaily,
    RateLimited,
    SignedOut,
    Network,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRelay {
    pub status: RelayStatus,
    pub address: Option<String>,
    pub region: Option<String>,
    pub expires_at: Option<String>,
    pub error: Option<String>,
    pub error_code: Option<RelayErrorCode>,
}

impl HostRelay {
    fn off() -> HostRelay {
        HostRelay {
            status: RelayStatus::Off,
            address: None,
            region: None,
            expires_at: None,
            error: None,
            error_code: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPlayer {
    pub name: String,
    pub score: i32,
    pub ping: i32,
    pub bot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInvited {
    pub user_id: String,
    pub at: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    User,
    Empty,
    RelayExpired,
    Crashed,
    StartFailed,
    LauncherExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    Spawn,
    Exited,
    Timeout,
    PortsBusy,
    MapMissing,
    Crashed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFailure {
    pub code: FailureCode,
    pub message: String,
    pub port_from: Option<u16>,
    pub port_to: Option<u16>,
}

/// The one private server of the launcher, as the screen draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSession {
    pub id: String,
    pub status: SessionStatus,
    pub steps: Vec<HostStep>,
    pub settings: HostSettings,
    pub game: Game,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub local_address: Option<String>,
    pub lan_addresses: Vec<String>,
    pub relay: HostRelay,
    pub players: Vec<HostPlayer>,
    pub invited: Vec<HostInvited>,
    pub joined_count: u32,
    pub started_at: String,
    pub ready_at: Option<String>,
    pub empty_since: Option<String>,
    pub auto_stop_at: Option<String>,
    pub stopped_at: Option<String>,
    pub stop_reason: Option<StopReason>,
    pub exit_code: Option<u32>,
    pub failure: Option<HostFailure>,
    pub log_tail: Vec<String>,
}

impl HostSession {
    fn step(&mut self, step: StepId, state: StepState) {
        if let Some(entry) = self.steps.iter_mut().find(|entry| entry.step == step) {
            entry.state = state;
        }
    }

    fn step_state(&self, step: StepId) -> StepState {
        self.steps
            .iter()
            .find(|entry| entry.step == step)
            .map(|entry| entry.state)
            .unwrap_or(StepState::Pending)
    }

    /// Players who are not bots.
    pub fn humans(&self) -> usize {
        self.players.iter().filter(|player| !player.bot).count()
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// What the supervisor is told.
#[derive(Debug)]
enum Command {
    Stop(StopReason),
    RetryRelay,
    /// The join policy or the map changed: the presence goes out again.
    Presence,
}

/// One session: what commands read and change while the supervisor runs it.
pub(crate) struct Live {
    view: Mutex<HostSession>,
    commands: mpsc::UnboundedSender<Command>,
    finished: watch::Receiver<bool>,
    rcon_password: String,
    fs_game: Option<String>,
}

impl Live {
    fn snapshot(&self) -> HostSession {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn update<T>(&self, change: impl FnOnce(&mut HostSession) -> T) -> T {
        change(&mut self.view.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn status(&self) -> SessionStatus {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).status
    }
}

#[derive(Default)]
struct Slot {
    /// A start is being prepared and holds the slot.
    claimed: bool,
    live: Option<Arc<Live>>,
}

/// The private server of the launcher, managed by Tauri.
#[derive(Default)]
pub struct HostState {
    slot: Mutex<Slot>,
}

/// The slot a start holds until its session is in place.
struct Claim<'a> {
    state: &'a HostState,
    committed: bool,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.state.lock().claimed = false;
        }
    }
}

impl HostState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Takes the slot for a start, or refuses with `hostBusy`.
    fn claim(&self) -> Result<Claim<'_>> {
        let mut slot = self.lock();
        let active = slot.live.as_ref().is_some_and(|live| live.status().is_active());
        if slot.claimed || active {
            return Err(AppError::HostBusy);
        }
        slot.claimed = true;
        Ok(Claim { state: self, committed: false })
    }

    fn commit(&self, mut claim: Claim<'_>, live: Arc<Live>) {
        let mut slot = self.lock();
        slot.live = Some(live);
        slot.claimed = false;
        claim.committed = true;
    }

    fn live(&self) -> Option<Arc<Live>> {
        self.lock().live.clone()
    }

    /// The session that runs, or `hostNotRunning`.
    fn running(&self) -> Result<Arc<Live>> {
        self.live()
            .filter(|live| live.status() == SessionStatus::Running)
            .ok_or(AppError::HostNotRunning)
    }

    /// Refuses with `AppError::Busy` while a session that runs this client
    /// holds the slot: deleting the client or reinstalling its engine would
    /// pull the files out from under the dedicated server.
    pub fn refuse_if_hosting(&self, client_id: &str) -> Result<()> {
        let busy = self.live().is_some_and(|live| {
            live.status().is_active() && live.snapshot().settings.client_id == client_id
        });
        if busy {
            return Err(AppError::Busy(
                "your private server runs this client: stop the server first".into(),
            ));
        }
        Ok(())
    }

    /// Whether a server is starting, running or stopping.
    pub fn is_active(&self) -> bool {
        let slot = self.lock();
        slot.claimed || slot.live.as_ref().is_some_and(|live| live.status().is_active())
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The clients, modes and defaults of the setup form of one game.
#[tauri::command]
pub fn host_get_options(state: tauri::State<'_, AppState>, game: Option<Game>) -> Result<HostOptions> {
    let settings = state.settings()?;
    let paths = state.paths()?;
    let game = settings.game_or_active(game);
    let clients: Vec<HostClientOption> = crate::clients::read_all(&paths)?
        .into_iter()
        .filter(|client| client.game == game)
        .map(|client| {
            let engine = crate::engines::find(&client.engine_id);
            let reason = match engine {
                Some(engine) if engine.dedicated.is_none() => Some(ClientBlock::NoDedicatedServer),
                Some(engine) => engine
                    .dedicated_executable(&paths.client_engine_dir(&client.id))
                    .is_none()
                    .then_some(ClientBlock::EngineMissing),
                None => Some(ClientBlock::EngineMissing),
            };
            HostClientOption {
                id: client.id,
                name: client.name,
                engine_id: client.engine_id,
                can_host: reason.is_none(),
                reason,
            }
        })
        .collect();
    Ok(options_of(&settings, game, clients))
}

/// The options out of the settings and the clients: split out for the tests.
fn options_of(settings: &Settings, game: Game, clients: Vec<HostClientOption>) -> HostOptions {
    let spec = game.spec();
    let gametypes: Vec<HostGametypeOption> = spec
        .hosting
        .gametypes
        .iter()
        .map(|gametype| HostGametypeOption {
            index: gametype.index,
            id: gametype.arena_type,
            label: spec.gametypes.get(usize::from(gametype.index)).copied().unwrap_or("?"),
            score_cvar: gametype.score_cvar,
            default_score: gametype.default_score,
        })
        .collect();

    let ctx = OnlineContext::from_settings(settings);
    let relay = if !ctx.configured() {
        RelayAvailability { available: false, reason: Some(RelayBlock::NotConfigured) }
    } else if !ctx.signed_in() {
        RelayAvailability { available: false, reason: Some(RelayBlock::SignedOut) }
    } else {
        RelayAvailability { available: true, reason: None }
    };

    let saved = settings.host_defaults.get(&game).cloned().unwrap_or_default();
    let hostable = |id: &str| clients.iter().any(|client| client.id == id && client.can_host);
    let default_client = settings
        .default_client_ids
        .get(&game)
        .cloned()
        .or_else(|| (game == Game::JediAcademy).then(|| settings.default_client_id.clone()).flatten());
    let client_id = saved
        .client_id
        .clone()
        .filter(|id| hostable(id))
        .or_else(|| default_client.filter(|id| hostable(id)))
        .or_else(|| clients.iter().find(|client| client.can_host).map(|client| client.id.clone()))
        .unwrap_or_default();

    let gametype = spec
        .hosting
        .gametype(saved.gametype)
        .filter(|_| saved.max_players > 0)
        .unwrap_or(&spec.hosting.gametypes[0]);
    let map = saved
        .map
        .clone()
        .filter(|map| server::is_safe_map_name(map))
        .unwrap_or_else(|| spec.hosting.default_map.to_string());
    let network = Network::parse(&saved.network)
        .filter(|network| relay.available || !network.uses_relay())
        .unwrap_or(if relay.available { Network::InternetLan } else { Network::Lan });
    let display_name = settings
        .online_user
        .as_ref()
        .filter(|_| ctx.signed_in())
        .map(|user| server::clean_server_name(&format!("{}'s game", user.display_name)))
        .filter(|name| !name.is_empty() && name != "'s game");
    let server_name = saved
        .server_name
        .as_deref()
        .map(server::clean_server_name)
        .filter(|name| !name.is_empty())
        .or(display_name)
        .unwrap_or_else(|| "JKNet game".to_string());
    let use_password = saved.max_players == 0 || saved.use_password;

    let defaults = HostSettings {
        client_id,
        map,
        gametype: u32::from(gametype.index),
        max_players: if (2..=16).contains(&saved.max_players) { u32::from(saved.max_players) } else { 8 },
        time_limit: u32::from(saved.time_limit),
        score_limit: if saved.max_players > 0 && gametype.score_cvar.is_some() {
            u32::from(saved.score_limit)
        } else {
            u32::from(gametype.default_score)
        },
        bots: u32::from(saved.bots),
        server_name,
        password: use_password.then(|| server::random_password(server::PASSWORD_LEN)),
        network,
        join_policy: JoinPolicy::parse(&saved.join_policy).unwrap_or(JoinPolicy::Friends),
        join_user_ids: saved.join_user_ids,
        invite_user_ids: Vec::new(),
        join_after_start: true,
    };
    HostOptions {
        game,
        clients,
        gametypes,
        defaults,
        relay,
        show_firewall_note: !settings.host_firewall_note_seen,
        port_from: spec.server_port,
        port_to: spec.server_port + server::PORT_SPAN - 1,
    }
}

/// The maps a server of this client can load, only those of `gametype` when
/// it is given.
#[tauri::command]
pub async fn host_list_maps(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    gametype: Option<u32>,
) -> Result<Vec<HostMap>> {
    let settings = state.settings()?;
    let paths = state.paths()?;
    let client = crate::clients::read_record(&paths, &client_id)?;
    let engine = crate::engines::find(&client.engine_id);
    let game_data = PathBuf::from(settings.require_game_data_path(client.game)?);
    let fs_game = client
        .fs_game
        .clone()
        .or_else(|| engine.and_then(|engine| engine.default_fs_game).map(str::to_string));
    let roots = maps::MapRoots {
        game: client.game,
        game_data,
        engine_dir: paths.client_engine_dir(&client.id),
        home_dir: paths.client_home_dir(&client.id),
        fs_game,
    };
    let token = gametype
        .and_then(|index| u8::try_from(index).ok())
        .and_then(|index| client.game.spec().hosting.gametype(index))
        .map(|gametype| gametype.arena_type);
    let found = tauri::async_runtime::spawn_blocking(move || maps::scan(&roots))
        .await
        .map_err(|e| AppError::State(format!("the map scan stopped: {e}")))?;
    let names: Vec<String> = found.iter().map(|map| map.name.clone()).collect();
    let pictures = crate::levelshots::cached_pictures(&app, &paths, client.game, &names);
    Ok(found
        .into_iter()
        .filter(|map| token.is_none_or(|token| map.gametypes.iter().any(|t| t == token)))
        .map(|map| HostMap {
            levelshot: pictures.get(&maps::map_key(&map.name)).cloned(),
            source: if map.retail { MapSource::Game } else { MapSource::Client },
            name: map.name,
            title: map.title,
            gametypes: map.gametypes,
        })
        .collect())
}

/// Checks the settings of a start and answers the cleaned ones.
fn validate_settings(game: Game, settings: &HostSettings) -> Result<HostSettings> {
    let mut clean = settings.clone();
    let hosting = game.spec().hosting;
    let gametype = u8::try_from(settings.gametype)
        .ok()
        .and_then(|index| hosting.gametype(index))
        .ok_or_else(|| {
            AppError::InvalidInput(format!("{} does not host game type {}", game.display_name(), settings.gametype))
        })?;
    if !server::is_safe_map_name(settings.map.trim()) {
        return Err(AppError::InvalidInput(format!("{:?} is not a map name", settings.map)));
    }
    clean.map = settings.map.trim().to_string();
    if !(2..=16).contains(&settings.max_players) {
        return Err(AppError::InvalidInput("a server takes 2 to 16 players".into()));
    }
    if settings.time_limit > 999 || settings.score_limit > 999 {
        return Err(AppError::InvalidInput("a limit above 999 is not a limit".into()));
    }
    if gametype.score_cvar.is_none() {
        clean.score_limit = 0;
    }
    if settings.bots > settings.max_players {
        return Err(AppError::InvalidInput("more bots than places on the server".into()));
    }
    clean.server_name = server::clean_server_name(&settings.server_name);
    if clean.server_name.is_empty() {
        clean.server_name = "JKNet game".into();
    }
    clean.password = match settings.password.as_deref().map(str::trim) {
        Some(password) if !password.is_empty() => {
            server::validate_password(password)?;
            Some(password.to_string())
        }
        _ => None,
    };
    let mut seen = BTreeSet::new();
    clean.join_user_ids.retain(|id| !id.trim().is_empty() && seen.insert(id.clone()));
    clean.join_user_ids.truncate(200);
    let mut seen = BTreeSet::new();
    clean.invite_user_ids.retain(|id| !id.trim().is_empty() && seen.insert(id.clone()));
    Ok(clean)
}

/// Starts a private server. Answers at once with the session in `starting`;
/// the rest arrives as `host:session`.
#[tauri::command]
pub async fn host_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    host: tauri::State<'_, HostState>,
    settings: HostSettings,
) -> Result<HostSession> {
    let claim = host.claim()?;
    let launcher_settings = state.settings()?;
    let paths = state.paths()?;
    let client = crate::clients::read_record(&paths, &settings.client_id)?;
    let settings = validate_settings(client.game, &settings)?;
    let ctx = OnlineContext::from_settings(&launcher_settings);
    if settings.network == Network::Internet && !ctx.signed_in() {
        // A server on loopback that no relay carries is a server nobody but
        // the host can reach.
        return Err(if ctx.configured() { AppError::SignedOut } else { AppError::OnlineNotConfigured });
    }

    let prepared = {
        let handle = app.clone();
        let client_id = settings.client_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::launch::prepare_server(&handle.state::<AppState>(), &client_id)
        })
        .await
        .map_err(|e| AppError::State(format!("the server preparation stopped: {e}")))??
    };

    let session_id = server::new_session_id();
    let rcon_password = server::random_password(server::RCON_PASSWORD_LEN);
    let game = prepared.client.game;
    let config = ServerConfig {
        game,
        roots: prepared.roots.clone(),
        network: settings.network,
        port: game.spec().server_port,
        session_id: session_id.clone(),
        map: settings.map.clone(),
        gametype: settings.gametype as u8,
        max_players: settings.max_players as u8,
        time_limit: settings.time_limit as u16,
        score_limit: settings.score_limit as u16,
        bots: settings.bots as u8,
        server_name: settings.server_name.clone(),
        password: settings.password.clone(),
        rcon_password: rcon_password.clone(),
    };
    let cfg_path = prepared.config_dir.join(server::CONFIG_FILE);
    std::fs::write(&cfg_path, server::host_config(&config))
        .map_err(|e| AppError::io_path("cannot write", &cfg_path, e))?;

    let output = Arc::new(ConsoleOutput::with_log(&paths.logs.join(LOG_FILE)));
    output.note(&format!(
        "{} for {} ({}), session {session_id}",
        prepared.executable.display(),
        prepared.client.name,
        prepared.engine.name
    ));
    let args = server::server_args(&config);
    log::info!(
        "hosting: starting {} for {} on port {} in the {} mode",
        prepared.executable.display(),
        prepared.client.id,
        config.port,
        settings.network.as_str()
    );
    let process = match ServerProcess::spawn(&prepared.executable, &prepared.engine_dir, &args, output.clone()) {
        Ok(process) => Arc::new(process),
        Err(e) => {
            let _ = std::fs::remove_file(&cfg_path);
            return Err(e);
        }
    };
    log::info!("hosting: pid {} ({:?})", process.pid(), process.method());

    let relay_wanted = settings.network.uses_relay();
    let mut view = HostSession {
        id: session_id,
        status: SessionStatus::Starting,
        steps: vec![
            HostStep { step: StepId::Server, state: StepState::Active },
            HostStep { step: StepId::Map, state: StepState::Pending },
            HostStep {
                step: StepId::Relay,
                state: if relay_wanted { StepState::Pending } else { StepState::Skipped },
            },
        ],
        settings: settings.clone(),
        game,
        pid: Some(process.pid()),
        port: None,
        local_address: None,
        lan_addresses: Vec::new(),
        relay: HostRelay::off(),
        players: Vec::new(),
        invited: Vec::new(),
        joined_count: 0,
        started_at: timestamp::now_rfc3339(),
        ready_at: None,
        empty_since: None,
        auto_stop_at: None,
        stopped_at: None,
        stop_reason: None,
        exit_code: None,
        failure: None,
        log_tail: Vec::new(),
    };
    if relay_wanted && !ctx.signed_in() {
        view.relay = relay_error(RelayErrorCode::SignedOut, "sign in to JKNet Online to use the relay");
        view.step(StepId::Relay, StepState::Failed);
    }

    let (commands, receiver) = mpsc::unbounded_channel();
    let (finished_tx, finished) = watch::channel(false);
    let live = Arc::new(Live {
        view: Mutex::new(view.clone()),
        commands,
        finished,
        rcon_password,
        fs_game: prepared.fs_game.clone(),
    });
    host.commit(claim, live.clone());
    remember_defaults(&state, game, &settings);

    let supervisor = Supervisor {
        app: app.clone(),
        live,
        process,
        output,
        cfg_path,
        first_port: config.port,
        commands: receiver,
        cancel: Arc::new(AtomicBool::new(false)),
        relay: None,
        tunnel_events: None,
        grants: None,
        renewing: false,
        renew_after_expiry: false,
        humans_ever: false,
        joined: BTreeSet::new(),
        ready_instant: None,
        empty_instant: None,
        last_lan: Instant::now(),
        last_poll: Instant::now(),
        emitted: None,
    };
    emit_session(&app, &view);
    tauri::async_runtime::spawn(async move {
        supervisor.run().await;
        let _ = finished_tx.send(true);
    });
    Ok(view)
}

/// Writes the settings of this start as the defaults of its game, without
/// the password, and notes that the firewall note has been seen.
fn remember_defaults(state: &AppState, game: Game, settings: &HostSettings) {
    let result = (|| -> Result<()> {
        let mut document = Settings::current(state)?;
        document.host_defaults.insert(
            game,
            HostDefaults {
                client_id: Some(settings.client_id.clone()),
                map: Some(settings.map.clone()),
                gametype: settings.gametype as u8,
                max_players: settings.max_players as u8,
                time_limit: settings.time_limit as u16,
                score_limit: settings.score_limit as u16,
                bots: settings.bots as u8,
                server_name: Some(settings.server_name.clone()),
                use_password: settings.password.is_some(),
                network: settings.network.as_str().to_string(),
                join_policy: settings.join_policy.as_str().to_string(),
                join_user_ids: settings.join_user_ids.clone(),
            },
        );
        if settings.network.uses_lan() {
            document.host_firewall_note_seen = true;
        }
        document.save(state)?;
        state.set_settings(document)
    })();
    if let Err(e) = result {
        log::warn!("hosting: cannot remember the settings of this server: {e}");
    }
}

/// Stops the server; a second call, or a call with nothing running, is not
/// an error. Answers once the server is down, or after [`STOP_WAIT`] with the
/// stop still going: the session reads `stopping` then, and `host:session`
/// brings the end.
#[tauri::command]
pub async fn host_stop(host: tauri::State<'_, HostState>) -> Result<()> {
    let Some(live) = host.live() else {
        return Ok(());
    };
    if !live.status().is_active() {
        return Ok(());
    }
    let _ = live.commands.send(Command::Stop(StopReason::User));
    if !wait_finished(&live, STOP_WAIT).await {
        log::warn!(
            "hosting: the server did not stop within {} s; the stop goes on in the background",
            STOP_WAIT.as_secs()
        );
    }
    Ok(())
}

/// Answers whether the supervisor finished within `budget`.
async fn wait_finished(live: &Live, budget: Duration) -> bool {
    let mut finished = live.finished.clone();
    let done = tokio::time::timeout(budget, finished.wait_for(|done| *done)).await;
    matches!(done, Ok(Ok(_)))
}

/// The session, `null` when no server was started in this run.
#[tauri::command]
pub fn host_get_session(host: tauri::State<'_, HostState>) -> Result<Option<HostSession>> {
    Ok(host.live().map(|live| live.snapshot()))
}

/// **Play**: the host's own game on the server, with its password.
#[tauri::command]
pub fn host_join_own(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    launch: tauri::State<'_, LaunchState>,
    host: tauri::State<'_, HostState>,
    profile_id: Option<String>,
) -> Result<RunningGame> {
    let live = host.running()?;
    let view = live.snapshot();
    join_own(&app, &state, &launch, &view, profile_id)
}

fn join_own(
    app: &AppHandle,
    state: &AppState,
    launch: &LaunchState,
    view: &HostSession,
    profile_id: Option<String>,
) -> Result<RunningGame> {
    let address = view.local_address.clone().ok_or(AppError::HostNotRunning)?;
    let extra = join::password_args(view.settings.password.as_deref())?;
    crate::launch::start_client(
        app,
        state,
        launch,
        &view.settings.client_id,
        Some(&address),
        &extra,
        crate::profiles::ProfileChoice { id: profile_id, inline: None },
        crate::engines::LaunchMode::Multiplayer,
    )
}

/// **Change map**: the players stay connected.
#[tauri::command]
pub async fn host_change_map(
    app: AppHandle,
    host: tauri::State<'_, HostState>,
    map: String,
    gametype: u32,
) -> Result<HostSession> {
    let live = host.running()?;
    let view = live.snapshot();
    let map = map.trim().to_string();
    if !server::is_safe_map_name(&map) {
        return Err(AppError::InvalidInput(format!("{map:?} is not a map name")));
    }
    let new_type = u8::try_from(gametype)
        .ok()
        .filter(|index| view.game.spec().hosting.gametype(*index).is_some())
        .ok_or_else(|| AppError::InvalidInput(format!("game type {gametype} is not offered")))?;
    let port = view.port.ok_or(AppError::HostNotRunning)?;
    let commands = server::change_map_commands(
        view.game,
        view.settings.gametype as u8,
        view.settings.score_limit as u16,
        &map,
        new_type,
    );
    for command in &commands {
        server::rcon(port, &live.rcon_password, command).await?;
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    let new_score = commands
        .iter()
        .find_map(|command| {
            let (cvar, value) = command.split_once(' ')?;
            SCORE_CVARS
                .iter()
                .any(|(name, _)| *name == cvar)
                .then(|| value.parse::<u32>().ok())
                .flatten()
        })
        .unwrap_or(0);
    let session = live.update(|view| {
        view.settings.map = map.clone();
        view.settings.gametype = u32::from(new_type);
        view.settings.score_limit = new_score;
        view.clone()
    });
    emit_session(&app, &session);
    let _ = live.commands.send(Command::Presence);
    Ok(session)
}

/// **Who can join without an invite**, while the server starts or runs.
#[tauri::command]
pub fn host_set_join_policy(
    app: AppHandle,
    host: tauri::State<'_, HostState>,
    join_policy: JoinPolicy,
    join_user_ids: Vec<String>,
) -> Result<HostSession> {
    let live = host
        .live()
        .filter(|live| matches!(live.status(), SessionStatus::Starting | SessionStatus::Running))
        .ok_or(AppError::HostNotRunning)?;
    let mut seen = BTreeSet::new();
    let mut ids: Vec<String> = join_user_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect();
    if ids.len() > 200 {
        return Err(AppError::InvalidInput("at most 200 friends join without an invite".into()));
    }
    ids.sort();
    let session = live.update(|view| {
        view.settings.join_policy = join_policy;
        view.settings.join_user_ids = ids;
        view.clone()
    });
    emit_session(&app, &session);
    let _ = live.commands.send(Command::Presence);
    Ok(session)
}

/// **Retry** of the relay line.
#[tauri::command]
pub fn host_retry_relay(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    host: tauri::State<'_, HostState>,
) -> Result<HostSession> {
    let live = host.running()?;
    let ctx = OnlineContext::from_settings(&state.settings()?);
    if !ctx.configured() {
        return Err(AppError::OnlineNotConfigured);
    }
    if !ctx.signed_in() {
        return Err(AppError::SignedOut);
    }
    if !live.snapshot().settings.network.uses_relay() {
        return Err(AppError::InvalidInput("this server is open to the local network only".into()));
    }
    let session = live.update(|view| {
        view.relay = HostRelay { status: RelayStatus::Connecting, ..HostRelay::off() };
        view.clone()
    });
    emit_session(&app, &session);
    let _ = live.commands.send(Command::RetryRelay);
    Ok(session)
}

/// **Invite**: an invite to this server with its addresses and password.
#[tauri::command]
pub async fn host_invite(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    host: tauri::State<'_, HostState>,
    to_user_id: String,
    message: Option<String>,
) -> Result<Invite> {
    let live = host.running()?;
    let ctx = OnlineContext::from_settings(&state.settings()?);
    if !ctx.configured() {
        return Err(AppError::OnlineNotConfigured);
    }
    if !ctx.signed_in() {
        return Err(AppError::SignedOut);
    }
    send_invite(&app, &online, &ctx, &live, to_user_id.trim(), message).await
}

async fn send_invite(
    app: &AppHandle,
    online: &OnlineClient,
    ctx: &OnlineContext,
    live: &Live,
    to_user_id: &str,
    message: Option<String>,
) -> Result<Invite> {
    let view = live.snapshot();
    let info = hosting_info(&view, live.fs_game.as_deref());
    let server_address = info
        .relay_address
        .clone()
        .or_else(|| info.lan_addresses.first().cloned())
        .ok_or_else(|| AppError::InvalidInput("the server has no address friends can use yet".into()))?;
    let invite = NewInvite {
        to_user_id: to_user_id.to_string(),
        server_address,
        server_name: Some(view.settings.server_name.clone()),
        message: message.filter(|text| !text.trim().is_empty()),
        hosting: Some(info),
    };
    let result = online.create_invite(ctx, &invite).await;
    let session = live.update(|view| {
        view.invited.retain(|entry| entry.user_id != to_user_id);
        view.invited.push(HostInvited {
            user_id: to_user_id.to_string(),
            at: timestamp::now_rfc3339(),
            ok: result.is_ok(),
        });
        view.clone()
    });
    emit_session(app, &session);
    result
}

/// **Show log**: `logs\host-server.log` in the system viewer.
#[tauri::command]
pub fn host_open_log(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = state.paths()?.logs.join(LOG_FILE);
    if !path.is_file() {
        return Err(AppError::NotFound(path.display().to_string()));
    }
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| AppError::State(format!("cannot open the server log: {e}")))
}

// ---------------------------------------------------------------------------
// The window and the exit
// ---------------------------------------------------------------------------

/// Called by the window handler when the main window asks to close: holds
/// the close while a server runs and tells the window to ask first.
pub fn hold_close(app: &AppHandle) -> bool {
    if !app.state::<HostState>().is_active() {
        return false;
    }
    if let Err(e) = app.emit(EVENT_CLOSE_REQUESTED, ()) {
        log::warn!("cannot emit {EVENT_CLOSE_REQUESTED}: {e}");
    }
    true
}

/// Stops the server on the way out of the launcher: the main window is gone.
/// Blocks the calling thread for a few seconds at most; the Job Object is the
/// net under it if even that fails.
pub fn shutdown_on_exit(app: &AppHandle) {
    let Some(live) = app.state::<HostState>().live() else {
        return;
    };
    if !live.status().is_active() {
        return;
    }
    log::info!("hosting: the launcher is closing, stopping the server");
    let _ = live.commands.send(Command::Stop(StopReason::LauncherExit));
    if !tauri::async_runtime::block_on(wait_finished(&live, Duration::from_secs(7))) {
        // The Job Object ends the server with the launcher all the same.
        log::warn!("hosting: the server did not stop within 7 s of the launcher closing");
    }
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

/// The relay of a running session. Its events arrive on
/// [`Supervisor::tunnel_events`].
struct RelayRun {
    grant_id: String,
    region: String,
    tunnel: TunnelHandle,
    expires_at: Option<u64>,
}

/// What a request to the relay API came back with.
enum GrantOutcome {
    New(Result<RelayGrant>),
    /// The renewal of the relay session `id`, which may be gone by now.
    Renewed { id: String, result: Result<RelayGrant> },
}

/// What the readiness task watches.
struct ProcessWatch {
    process: Arc<ServerProcess>,
    cancel: Arc<AtomicBool>,
}

impl StartWatch for ProcessWatch {
    fn exited(&self) -> Option<u32> {
        self.process.exit_code()
    }

    fn console_says(&self) -> Option<NotReady> {
        let output = self.process.output();
        if output.saw(Marker::BindFailed) {
            Some(NotReady::PortsBusy)
        } else if output.saw(Marker::MapMissing) {
            Some(NotReady::MapMissing)
        } else {
            None
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

struct Supervisor {
    app: AppHandle,
    live: Arc<Live>,
    process: Arc<ServerProcess>,
    output: Arc<ConsoleOutput>,
    cfg_path: PathBuf,
    first_port: u16,
    commands: mpsc::UnboundedReceiver<Command>,
    cancel: Arc<AtomicBool>,
    relay: Option<RelayRun>,
    /// The events of the tunnel of [`Supervisor::relay`].
    tunnel_events: Option<mpsc::UnboundedReceiver<TunnelEvent>>,
    grants: Option<mpsc::UnboundedSender<GrantOutcome>>,
    renewing: bool,
    /// The node refused the ticket as run out: without a renewal the relay
    /// is over.
    renew_after_expiry: bool,
    humans_ever: bool,
    joined: BTreeSet<String>,
    ready_instant: Option<Instant>,
    empty_instant: Option<Instant>,
    last_lan: Instant,
    last_poll: Instant,
    emitted: Option<HostSession>,
}

/// The next event of an optional receiver, or never.
async fn next_of<T>(receiver: &mut Option<mpsc::UnboundedReceiver<T>>) -> Option<T> {
    match receiver.as_mut() {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}

impl Supervisor {
    async fn run(mut self) {
        let (grant_tx, mut grant_rx) = mpsc::unbounded_channel::<GrantOutcome>();
        self.grants = Some(grant_tx);
        if self.live.snapshot().step_state(StepId::Relay) == StepState::Pending {
            self.request_relay();
        }

        let mut ready_task = {
            let watch = ProcessWatch { process: self.process.clone(), cancel: self.cancel.clone() };
            let session_id = self.live.snapshot().id;
            let first_port = self.first_port;
            tauri::async_runtime::spawn(async move {
                server::wait_ready(first_port, &session_id, READY_BUDGET, &watch).await
            })
        };
        let mut ready_done = false;
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let reason = loop {
            tokio::select! {
                biased;
                command = self.commands.recv() => {
                    match command {
                        Some(Command::Stop(reason)) => break reason,
                        Some(Command::RetryRelay) => self.retry_relay().await,
                        Some(Command::Presence) => self.publish_presence(),
                        None => break StopReason::LauncherExit,
                    }
                }
                ready = &mut ready_task, if !ready_done => {
                    ready_done = true;
                    match ready {
                        Ok(Ok(port)) => self.on_ready(port),
                        Ok(Err(NotReady::Cancelled)) => break StopReason::User,
                        Ok(Err(reason)) => {
                            self.fail_start(reason);
                            break StopReason::StartFailed;
                        }
                        Err(e) => {
                            self.fail_start_with(FailureCode::Spawn, format!("the readiness check stopped: {e}"));
                            break StopReason::StartFailed;
                        }
                    }
                }
                Some(outcome) = grant_rx.recv() => {
                    match outcome {
                        GrantOutcome::New(result) => self.on_grant(result).await,
                        GrantOutcome::Renewed { id, result } => {
                            if let Some(reason) = self.on_renewed(&id, result).await {
                                break reason;
                            }
                        }
                    }
                }
                Some(event) = next_of(&mut self.tunnel_events) => {
                    if let Some(reason) = self.on_tunnel(event).await {
                        break reason;
                    }
                }
                _ = tick.tick() => {
                    if let Some(reason) = self.on_tick(ready_done).await {
                        break reason;
                    }
                }
            }
        };

        self.cancel.store(true, Ordering::Relaxed);
        if !ready_done {
            ready_task.abort();
        }
        self.stop(reason).await;
    }

    fn publish(&mut self) {
        let session = self.live.snapshot();
        if self.emitted.as_ref() != Some(&session) {
            emit_session(&self.app, &session);
            self.emitted = Some(session);
        }
    }

    fn publish_presence(&self) {
        let view = self.live.snapshot();
        let presence = (view.status == SessionStatus::Running)
            .then(|| host_presence(&view, self.live.fs_game.as_deref()))
            .flatten();
        crate::friends::presence::set_hosting(&self.app, presence);
    }

    // -- The relay ----------------------------------------------------------

    fn request_relay(&mut self) {
        let Some(grants) = self.grants.clone() else {
            return;
        };
        self.live.update(|view| {
            view.relay = HostRelay { status: RelayStatus::Connecting, ..HostRelay::off() };
            view.step(StepId::Relay, StepState::Active);
        });
        self.publish();
        let app = self.app.clone();
        let game = self.live.snapshot().game;
        tauri::async_runtime::spawn(async move {
            let result = async {
                let ctx = OnlineContext::from_settings(&app.state::<AppState>().settings()?);
                app.state::<OnlineClient>()
                    .create_relay_session(&ctx, game.id(), &[])
                    .await
            }
            .await;
            let _ = grants.send(GrantOutcome::New(result));
        });
    }

    async fn retry_relay(&mut self) {
        self.close_relay().await;
        self.request_relay();
    }

    async fn on_grant(&mut self, result: Result<RelayGrant>) {
        let grant = match result {
            Ok(grant) => grant,
            Err(e) => {
                let (code, message) = relay_error_of(&e);
                self.relay_failed(code, message);
                return;
            }
        };
        // Two grants in flight — a **Retry** pressed while the first request
        // was still out — leave only the newer tunnel standing.
        self.close_relay().await;
        match self.open_tunnel(&grant).await {
            Ok((relay, events)) => {
                self.relay = Some(relay);
                self.tunnel_events = Some(events);
            }
            Err(message) => {
                self.close_grant(grant.session_id.clone());
                self.relay_failed(RelayErrorCode::Unavailable, message);
            }
        }
    }

    async fn open_tunnel(
        &mut self,
        grant: &RelayGrant,
    ) -> std::result::Result<(RelayRun, mpsc::UnboundedReceiver<TunnelEvent>), String> {
        let config = tunnel_config(grant, self.live.snapshot().port).await?;
        let (events_tx, events) = mpsc::unbounded_channel();
        let handle = tunnel::spawn(config, events_tx);
        log::info!(
            "hosting: relay session {} on {} ({})",
            grant.session_id,
            grant.node.id,
            grant.node.region
        );
        Ok((
            RelayRun {
                grant_id: grant.session_id.clone(),
                region: grant.node.region.clone(),
                tunnel: handle,
                expires_at: timestamp::parse_rfc3339(&grant.expires_at),
            },
            events,
        ))
    }

    /// Answers the reason to stop when the relay was all the server had.
    async fn on_renewed(&mut self, id: &str, result: Result<RelayGrant>) -> Option<StopReason> {
        self.renewing = false;
        // A **Retry** replaced the session while its renewal was out.
        if self.relay.as_ref().is_none_or(|relay| relay.grant_id != id) {
            return None;
        }
        let after_expiry = std::mem::take(&mut self.renew_after_expiry);
        match result {
            Ok(grant) => {
                use base64::Engine as _;
                let relay = self.relay.as_mut()?;
                match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(grant.ticket.trim_end_matches('=')) {
                    Ok(ticket) => relay.tunnel.renew(ticket),
                    Err(_) => log::warn!("hosting: the renewed relay ticket is not base64url"),
                }
                relay.expires_at = timestamp::parse_rfc3339(&grant.expires_at).or(relay.expires_at);
                let expires = relay.expires_at.map(timestamp::from_unix_seconds);
                self.live.update(|view| {
                    view.relay.expires_at = expires;
                    view.relay.error = None;
                    view.relay.error_code = None;
                });
                self.publish();
                None
            }
            Err(e) if after_expiry => {
                // The node refused the old ticket and there is no later one:
                // the relay is over, for the day when the quota says so.
                let (code, message) = relay_error_of(&e);
                let code = if code == RelayErrorCode::QuotaDaily { code } else { RelayErrorCode::Expired };
                self.close_relay().await;
                self.relay_failed(code, format!("the relay ticket ran out and was not renewed: {message}"));
                (!self.live.snapshot().settings.network.uses_lan()).then_some(StopReason::RelayExpired)
            }
            Err(e) => {
                // The relay keeps carrying the server until the ticket runs
                // out; the screen says why it will not be renewed.
                let (code, message) = relay_error_of(&e);
                log::warn!("hosting: cannot renew the relay ticket: {message}");
                self.live.update(|view| {
                    view.relay.error = Some(message);
                    view.relay.error_code = Some(code);
                });
                self.publish();
                None
            }
        }
    }

    fn relay_failed(&mut self, code: RelayErrorCode, message: String) {
        log::warn!("hosting: the relay is not available: {message}");
        self.live.update(|view| {
            view.relay = relay_error(code, &message);
            if view.step_state(StepId::Relay) == StepState::Active {
                view.step(StepId::Relay, StepState::Failed);
            }
        });
        self.publish();
        self.publish_presence();
    }

    async fn on_tunnel(&mut self, event: TunnelEvent) -> Option<StopReason> {
        match event {
            TunnelEvent::Active { public, expires_at, .. } => {
                let region = self.relay.as_ref().map(|relay| relay.region.clone());
                if let Some(relay) = self.relay.as_mut() {
                    relay.expires_at = Some(expires_at).filter(|at| *at > 0).or(relay.expires_at);
                }
                let expires = self.relay.as_ref().and_then(|relay| relay.expires_at);
                self.live.update(|view| {
                    view.relay = HostRelay {
                        status: RelayStatus::Active,
                        address: Some(public.to_string()),
                        region: region.filter(|region| !region.is_empty()),
                        expires_at: expires.map(timestamp::from_unix_seconds),
                        error: None,
                        error_code: None,
                    };
                    view.step(StepId::Relay, StepState::Done);
                });
                self.publish();
                self.publish_presence();
            }
            TunnelEvent::Guests(_) => {}
            TunnelEvent::Expires(at) => {
                if let Some(relay) = self.relay.as_mut() {
                    relay.expires_at = Some(at);
                }
                self.live.update(|view| view.relay.expires_at = Some(timestamp::from_unix_seconds(at)));
                self.publish();
            }
            TunnelEvent::Lost => {
                self.live.update(|view| view.relay.status = RelayStatus::Lost);
                self.publish();
            }
            TunnelEvent::TicketExpired => {
                log::info!("hosting: the relay node says the ticket ran out; renewing it");
                self.renew_after_expiry = true;
                // A renewal already out hands its ticket over all the same.
                if !self.renewing {
                    self.start_renewal();
                }
            }
            TunnelEvent::Failed { failure, message } => {
                let code = match failure {
                    TunnelFailure::NodeSilent => RelayErrorCode::NodeSilent,
                    TunnelFailure::Expired => RelayErrorCode::Expired,
                    TunnelFailure::Refused | TunnelFailure::Socket => RelayErrorCode::Unavailable,
                };
                self.close_relay().await;
                self.relay_failed(code, message);
                if code == RelayErrorCode::Expired && !self.live.snapshot().settings.network.uses_lan() {
                    return Some(StopReason::RelayExpired);
                }
            }
            TunnelEvent::Closed { reason } => {
                if reason == wire::close::EXPIRED || reason == wire::close::ADMIN {
                    self.close_relay().await;
                    let (code, message) = if reason == wire::close::EXPIRED {
                        (RelayErrorCode::Expired, "the relay time ran out".to_string())
                    } else {
                        (RelayErrorCode::Unavailable, "the relay session was closed".to_string())
                    };
                    self.relay_failed(code, message);
                    if reason == wire::close::EXPIRED && !self.live.snapshot().settings.network.uses_lan() {
                        return Some(StopReason::RelayExpired);
                    }
                }
            }
        }
        None
    }

    /// Ends the tunnel and the relay session on the service.
    async fn close_relay(&mut self) {
        self.tunnel_events = None;
        self.renew_after_expiry = false;
        if let Some(relay) = self.relay.take() {
            relay.tunnel.close().await;
            self.close_grant(relay.grant_id);
        }
    }

    /// `DELETE /v1/relay/sessions/{id}`, in the background: a repeat is not
    /// an error, and a failure only costs the account the rest of the ticket.
    fn close_grant(&self, id: String) {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(settings) = app.state::<AppState>().settings() else {
                return;
            };
            let ctx = OnlineContext::from_settings(&settings);
            if let Err(e) = app.state::<OnlineClient>().close_relay_session(&ctx, &id).await {
                log::debug!("hosting: cannot close the relay session {id}: {e}");
            }
        });
    }

    // -- The server ---------------------------------------------------------

    fn on_ready(&mut self, port: u16) {
        let network = self.live.snapshot().settings.network;
        let lan: Vec<String> = if network.uses_lan() {
            network::lan_ipv4().into_iter().map(|ip| format!("{ip}:{port}")).collect()
        } else {
            Vec::new()
        };
        let now = timestamp::now_rfc3339();
        self.ready_instant = Some(Instant::now());
        self.last_lan = Instant::now();
        if let Some(relay) = self.relay.as_ref() {
            relay.tunnel.set_server_port(port);
        }
        self.live.update(|view| {
            view.port = Some(port);
            view.local_address = Some(format!("127.0.0.1:{port}"));
            view.lan_addresses = lan;
            view.ready_at = Some(now);
            view.step(StepId::Server, StepState::Done);
            view.step(StepId::Map, StepState::Done);
        });
        log::info!("hosting: the server answers on port {port}");
        self.publish();
    }

    /// The start is over once the server answers and the relay step is
    /// settled, or the relay had its grace.
    fn maybe_running(&mut self) {
        let view = self.live.snapshot();
        if view.status != SessionStatus::Starting || view.port.is_none() {
            return;
        }
        let relay_settled = !matches!(view.step_state(StepId::Relay), StepState::Active | StepState::Pending);
        let grace_over = self
            .ready_instant
            .is_some_and(|ready| ready.elapsed() >= RELAY_GRACE);
        if !relay_settled && !grace_over {
            return;
        }
        self.live.update(|view| view.status = SessionStatus::Running);
        self.empty_instant = self.ready_instant;
        self.publish();
        self.publish_presence();
        self.after_start(view);
    }

    /// What **Start and play** and the invites of the form ask for.
    fn after_start(&self, view: HostSession) {
        if view.settings.join_after_start {
            let state = self.app.state::<AppState>();
            let launch = self.app.state::<LaunchState>();
            let running = self.live.snapshot();
            if let Err(e) = join_own(&self.app, &state, &launch, &running, None) {
                log::warn!("hosting: cannot start the host's own game: {e}");
            }
        }
        if view.settings.invite_user_ids.is_empty() {
            return;
        }
        let app = self.app.clone();
        let live = self.live.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(settings) = app.state::<AppState>().settings() else {
                return;
            };
            let ctx = OnlineContext::from_settings(&settings);
            if !ctx.signed_in() {
                return;
            }
            let online = app.state::<OnlineClient>();
            for user_id in view.settings.invite_user_ids {
                if let Err(e) = send_invite(&app, &online, &ctx, &live, &user_id, None).await {
                    log::warn!("hosting: cannot invite {user_id}: {e}");
                }
            }
        });
    }

    fn fail_start(&mut self, reason: NotReady) {
        let spec = self.live.snapshot().game.spec();
        let (from, to) = (spec.server_port, spec.server_port + server::PORT_SPAN - 1);
        let map = self.live.snapshot().settings.map;
        let (code, message) = match reason {
            NotReady::Exited(code) => {
                self.live.update(|view| view.exit_code = Some(code));
                (FailureCode::Exited, format!("the server closed during startup (exit code {code:#x})"))
            }
            NotReady::PortsBusy => (FailureCode::PortsBusy, format!("no free port between {from} and {to}")),
            NotReady::MapMissing => (FailureCode::MapMissing, format!("the server did not find {map}")),
            NotReady::Timeout => (FailureCode::Timeout, format!("the server did not load {map} in 30 seconds")),
            NotReady::Cancelled => (FailureCode::Timeout, "the start was cancelled".into()),
        };
        self.fail_start_with(code, message);
        if code == FailureCode::PortsBusy {
            self.live.update(|view| {
                if let Some(failure) = view.failure.as_mut() {
                    failure.port_from = Some(from);
                    failure.port_to = Some(to);
                }
            });
        }
    }

    fn fail_start_with(&mut self, code: FailureCode, message: String) {
        log::warn!("hosting: {message}");
        self.live.update(|view| {
            view.failure = Some(HostFailure { code, message, port_from: None, port_to: None });
            for step in view.steps.iter_mut() {
                if step.state == StepState::Active {
                    step.state = StepState::Failed;
                }
            }
        });
    }

    async fn on_tick(&mut self, ready_done: bool) -> Option<StopReason> {
        let view = self.live.snapshot();
        if view.status == SessionStatus::Starting {
            // The steps follow the console while the server comes up.
            if !ready_done && view.step_state(StepId::Server) == StepState::Active
                && (self.output.saw(Marker::SocketOpened) || self.output.saw(Marker::GameInitialization))
            {
                self.live.update(|view| {
                    view.step(StepId::Server, StepState::Done);
                    view.step(StepId::Map, StepState::Active);
                });
                self.publish();
            }
            self.maybe_running();
        }
        if !ready_done {
            return None;
        }
        if let Some(code) = self.process.exit_code() {
            let was_running = self.live.status() == SessionStatus::Running;
            log::warn!("hosting: the server ended by itself with {code:#x}");
            self.live.update(|view| {
                view.exit_code = Some(code);
                view.failure = Some(HostFailure {
                    code: FailureCode::Crashed,
                    message: format!("the server stopped by itself (exit code {code:#x})"),
                    port_from: None,
                    port_to: None,
                });
            });
            return Some(if was_running { StopReason::Crashed } else { StopReason::StartFailed });
        }
        if self.live.status() != SessionStatus::Running {
            return None;
        }

        if self.last_poll.elapsed() >= POLL_EVERY {
            self.last_poll = Instant::now();
            self.poll().await;
        }
        if self.last_lan.elapsed() >= LAN_REFRESH {
            self.last_lan = Instant::now();
            self.refresh_lan();
        }
        self.renew_if_due();

        let view = self.live.snapshot();
        if view.humans() == 0 {
            let since = self.empty_instant.get_or_insert_with(Instant::now);
            let limit = if self.humans_ever { EMPTY_STOP } else { UNUSED_STOP };
            if since.elapsed() >= limit {
                log::info!("hosting: nobody played for {} min, stopping", limit.as_secs() / 60);
                return Some(StopReason::Empty);
            }
        }
        None
    }

    async fn poll(&mut self) {
        let Some(port) = self.live.snapshot().port else {
            return;
        };
        let status = match server::status(port).await {
            Ok(status) => status,
            Err(e) => {
                log::debug!("hosting: the status poll failed: {e}");
                return;
            }
        };
        let players: Vec<HostPlayer> = status
            .players
            .iter()
            .map(|player| HostPlayer {
                name: player.name_raw.clone(),
                score: player.score,
                ping: player.ping,
                bot: player.is_bot(),
            })
            .collect();
        let humans = status.humans();
        for player in players.iter().filter(|player| !player.bot) {
            self.joined.insert(player.name.clone());
        }
        let now_unix = timestamp::now_unix();
        if humans > 0 {
            self.humans_ever = true;
            self.empty_instant = None;
        } else if self.empty_instant.is_none() {
            self.empty_instant = Some(Instant::now());
        }
        let limit = if self.humans_ever { EMPTY_STOP } else { UNUSED_STOP };
        let (empty_since, auto_stop_at) = match self.empty_instant {
            Some(since) => {
                let since_unix = now_unix.saturating_sub(since.elapsed().as_secs());
                (
                    Some(timestamp::from_unix_seconds(since_unix)),
                    Some(timestamp::from_unix_seconds(since_unix + limit.as_secs())),
                )
            }
            None => (None, None),
        };
        let joined = self.joined.len() as u32;
        let map = status.map().map(str::to_string);
        let before = self.live.snapshot();
        self.live.update(|view| {
            view.players = players;
            view.joined_count = joined;
            // Minutes are what the screen counts in: a second of drift between
            // two polls is not a change worth an event.
            if view.empty_since.is_none() != empty_since.is_none() || empty_since.is_none() {
                view.empty_since = empty_since;
                view.auto_stop_at = auto_stop_at;
            }
            if let Some(map) = map.filter(|map| !map.is_empty()) {
                if crate::levelshots::map_key(&map) != crate::levelshots::map_key(&view.settings.map) {
                    view.settings.map = map;
                }
            }
        });
        let after = self.live.snapshot();
        self.publish();
        if before.humans() != after.humans() || before.settings.map != after.settings.map {
            self.publish_presence();
        }
    }

    fn refresh_lan(&mut self) {
        let view = self.live.snapshot();
        let (Some(port), true) = (view.port, view.settings.network.uses_lan()) else {
            return;
        };
        let lan: Vec<String> = network::lan_ipv4().into_iter().map(|ip| format!("{ip}:{port}")).collect();
        if lan != view.lan_addresses {
            self.live.update(|view| view.lan_addresses = lan);
            self.publish();
            self.publish_presence();
        }
    }

    /// Renews the ticket ten minutes before it runs out, while players are on.
    fn renew_if_due(&mut self) {
        if self.renewing || self.live.snapshot().humans() == 0 {
            return;
        }
        let Some(relay) = self.relay.as_ref() else {
            return;
        };
        let Some(expires_at) = relay.expires_at else {
            return;
        };
        if expires_at.saturating_sub(timestamp::now_unix()) > RENEW_BEFORE.as_secs() {
            return;
        }
        self.start_renewal();
    }

    /// `POST /v1/relay/sessions/{id}/renew` for the session of the relay, in
    /// the background; the answer comes back as [`GrantOutcome::Renewed`].
    fn start_renewal(&mut self) {
        let Some(relay) = self.relay.as_ref() else {
            return;
        };
        let Some(grants) = self.grants.clone() else {
            return;
        };
        self.renewing = true;
        let id = relay.grant_id.clone();
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let ctx = OnlineContext::from_settings(&app.state::<AppState>().settings()?);
                app.state::<OnlineClient>().renew_relay_session(&ctx, &id).await
            }
            .await;
            let _ = grants.send(GrantOutcome::Renewed { id, result });
        });
    }

    // -- The stop -----------------------------------------------------------

    async fn stop(mut self, reason: StopReason) {
        let failed = matches!(reason, StopReason::Crashed | StopReason::StartFailed);
        self.live.update(|view| view.status = SessionStatus::Stopping);
        self.publish();
        // Friends stop seeing the server before it goes.
        crate::friends::presence::set_hosting(&self.app, None);

        let port = self.live.snapshot().port;
        if self.process.exit_code().is_none() {
            // A server that never answered has no port to ask and may not
            // read its console yet: **Cancel** ends it straight away.
            if let Some(port) = port {
                if let Err(e) = server::rcon(port, &self.live.rcon_password, "quit").await {
                    log::debug!("hosting: rcon quit: {e}");
                }
                if !self.wait_exit(QUIT_WAIT).await && self.process.type_line("quit") {
                    self.wait_exit(Duration::from_secs(1)).await;
                }
            }
            if self.process.exit_code().is_none() {
                log::warn!("hosting: the server did not quit, ending it");
                self.process.terminate();
                self.wait_exit(Duration::from_secs(2)).await;
            }
        }
        let exit_code = self.process.exit_code();
        self.close_relay().await;
        if let Err(e) = std::fs::remove_file(&self.cfg_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("hosting: cannot delete {}: {e}", self.cfg_path.display());
            }
        }

        // The process goes last: dropping it closes the pseudo console and
        // joins the reader of the console, which is what makes the tail and
        // the log complete, and it may take a moment.
        let process = self.process.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || process.close()).await;
        let tail = if failed { self.output.tail(FAILED_TAIL) } else { Vec::new() };

        let joined = self.joined.len() as u32;
        self.live.update(|view| {
            view.status = if failed { SessionStatus::Failed } else { SessionStatus::Stopped };
            view.stop_reason = Some(reason);
            view.stopped_at = Some(timestamp::now_rfc3339());
            view.exit_code = view.exit_code.or(exit_code);
            view.joined_count = view.joined_count.max(joined);
            view.log_tail = tail;
            view.auto_stop_at = None;
            if matches!(view.relay.status, RelayStatus::Active | RelayStatus::Connecting | RelayStatus::Lost) {
                view.relay.status = RelayStatus::Off;
                view.relay.address = None;
            }
            for step in view.steps.iter_mut() {
                if matches!(step.state, StepState::Active | StepState::Pending) {
                    step.state = if failed { StepState::Failed } else { StepState::Skipped };
                }
            }
        });
        log::info!("hosting: the server stopped ({reason:?}, exit code {exit_code:?})");
        self.publish();
    }

    async fn wait_exit(&self, budget: Duration) -> bool {
        let process = self.process.clone();
        tauri::async_runtime::spawn_blocking(move || process.wait(budget).is_some())
            .await
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/// The tunnel a grant of the relay API opens: the ticket and the key out of
/// their base64url, the session id, the control address of the node.
pub(crate) async fn tunnel_config(
    grant: &RelayGrant,
    server_port: Option<u16>,
) -> std::result::Result<tunnel::TunnelConfig, String> {
    use base64::Engine as _;
    let decode = |text: &str| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text.trim().trim_end_matches('='))
    };
    let ticket = decode(&grant.ticket).map_err(|_| "the relay ticket is not base64url".to_string())?;
    let key: wire::HostKey = decode(&grant.host_key)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| "the relay key is not 16 bytes of base64url".to_string())?;
    let session_id = u64::from_str_radix(grant.session_id.trim(), 16)
        .ok()
        .or_else(|| ticket.get(2..10).and_then(|raw| raw.try_into().ok()).map(u64::from_be_bytes))
        .ok_or_else(|| "the relay session id is not 16 hex characters".to_string())?;
    let control = tunnel::resolve_control(&grant.node.control_address)
        .await
        .ok_or_else(|| format!("cannot resolve the relay node {}", grant.node.control_address))?;
    Ok(tunnel::TunnelConfig {
        control,
        session_id,
        key,
        ticket,
        server_port,
        max_guests: usize::try_from(grant.limits.max_guests).unwrap_or(16).clamp(1, 64),
        guest_bind: tunnel::GuestBind::PerGuest,
        timing: tunnel::Timing {
            keepalive: Duration::from_secs(u64::from(grant.keepalive_secs.unwrap_or(15).clamp(5, 60))),
            ..tunnel::Timing::default()
        },
    })
}

fn emit_session(app: &AppHandle, session: &HostSession) {
    if let Err(e) = app.emit(EVENT_SESSION, session) {
        log::debug!("cannot emit {EVENT_SESSION}: {e}");
    }
}

fn relay_error(code: RelayErrorCode, message: &str) -> HostRelay {
    HostRelay {
        status: RelayStatus::Unavailable,
        error: Some(message.to_string()),
        error_code: Some(code),
        ..HostRelay::off()
    }
}

/// Reads a refusal of the relay API into the code the screen shows.
fn relay_error_of(error: &AppError) -> (RelayErrorCode, String) {
    match error {
        // One code for both quotas; the details of the service tell them
        // apart, and its words where a service sends no details.
        AppError::RelayQuota { message, quota, .. } => {
            let kind = match quota.as_deref() {
                Some("daily_time") => RelayErrorCode::QuotaDaily,
                Some("active_session") => RelayErrorCode::QuotaActive,
                _ => {
                    let lower = message.to_ascii_lowercase();
                    if lower.contains("daily") || lower.contains("today") || lower.contains("time") {
                        RelayErrorCode::QuotaDaily
                    } else {
                        RelayErrorCode::QuotaActive
                    }
                }
            };
            (kind, message.clone())
        }
        AppError::RelayUnavailable(message) => (RelayErrorCode::Unavailable, message.clone()),
        AppError::Online { code, message } => {
            let kind = match code.as_str() {
                "rate_limited" => RelayErrorCode::RateLimited,
                "unauthorized" => RelayErrorCode::SignedOut,
                _ => RelayErrorCode::Unavailable,
            };
            (kind, message.clone())
        }
        AppError::SignedOut => (RelayErrorCode::SignedOut, error.to_string()),
        AppError::OnlineNotConfigured => (RelayErrorCode::Unavailable, error.to_string()),
        AppError::Network(message) => (RelayErrorCode::Network, message.clone()),
        other => (RelayErrorCode::Unavailable, other.to_string()),
    }
}

/// The `hosting` object of the presence and of an invite, whole.
fn hosting_info(view: &HostSession, fs_game: Option<&str>) -> HostingInfo {
    let relay_address = (view.relay.status == RelayStatus::Active)
        .then(|| view.relay.address.clone())
        .flatten();
    HostingInfo {
        session_id: view.id.clone(),
        game: view.game.id().to_string(),
        mod_name: fs_game.map(str::to_string),
        map: Some(view.settings.map.clone()),
        gametype: view.settings.gametype,
        players: view.humans() as u32,
        max_players: view.settings.max_players,
        lan_addresses: view.lan_addresses.clone(),
        relay_address,
        password: view.settings.password.clone(),
        join_policy: view.settings.join_policy.as_str().to_string(),
        join_user_ids: Some(if view.settings.join_policy == JoinPolicy::Selected {
            view.settings.join_user_ids.clone()
        } else {
            Vec::new()
        }),
        can_join: None,
    }
}

/// What the presence says while the session runs.
fn host_presence(view: &HostSession, fs_game: Option<&str>) -> Option<HostPresence> {
    Some(HostPresence {
        info: hosting_info(view, fs_game),
        local_port: view.port?,
        server_name: view.settings.server_name.clone(),
    })
}

#[cfg(test)]
mod tests;
