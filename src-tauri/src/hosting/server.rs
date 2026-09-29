//! The dedicated server of a private server: its command line, its
//! `jknet-host.cfg`, the wait for it to come up, the polls while it runs and
//! the out-of-band commands that change its map and stop it.
//!
//! ## Command line
//!
//! ```text
//! <roots of the client>                       fs_cdpath or fs_assetspath, fs_basepath, fs_homepath, fs_game
//! +safe                                      skip archived server settings (and OpenJK autoexec)
//! +set dedicated 1                            no heartbeat to the master servers
//! +set net_ip 127.0.0.1                       only in the `internet` mode: loopback only
//! +set net_port <PORT_SERVER of the game>     the first of the ten ports the engine tries
//! +sets jknet_session <16 hex characters>     serverinfo label the launcher waits for
//! +exec jknet-host.cfg                        everything else
//! +map <map>                                  starts the map after the settings
//! +exec jknet-host-settings.cfg               reapplies authored cvars the map may override
//! ```
//!
//! `dedicated 1` is what keeps the server off the master lists: the engine
//! sends heartbeats only at `2` (`codemp/server/sv_main.cpp:236`), and
//! `openjkded` defaults to `2`. Without `net_ip` the engine listens on every
//! interface (`localhost` is `INADDR_ANY`, `codemp/qcommon/net_ip.cpp:455`).
//!
//! ## Readiness
//!
//! Once a second the launcher asks `getstatus` on the ten ports from
//! `net_port` up and takes the answer whose `jknet_session` is the label of
//! this session: the engine takes the first free port itself
//! (`net_ip.cpp:829-842`), and the label tells this server from a stranger on
//! the same port. The rate stays under the out-of-band limit of the engine,
//! one packet a second per address with a burst of ten
//! (`sv_maxOOBRateIP`). One socket asks all ten ports, and Windows answers a
//! datagram to a closed port on loopback with `WSAECONNRESET` on the next
//! read: that error is skipped rather than taken for an end.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;

use crate::error::{AppError, Result};
use crate::game::{Game, SCORE_CVARS};
use crate::servers::protocol::{self, oob_packet, oob_payload, parse_infostring, split_command};

/// The file `+exec` reads, in `home\<fs_game or base>\`.
pub const CONFIG_FILE: &str = "jknet-host.cfg";
pub const SETTINGS_FILE: &str = "jknet-host-settings.cfg";

/// Reapply checked settings after game-driven restarts, which need not change
/// the map name. Only a successful enqueue consumes an initialization marker.
#[derive(Default)]
pub struct MapSettingsReplay {
    last_initialization: u64,
}

impl MapSettingsReplay {
    pub fn reapply_after(&mut self, initialization: u64, apply: impl FnOnce() -> bool) -> bool {
        if initialization <= self.last_initialization || !apply() {
            return false;
        }
        self.last_initialization = initialization;
        true
    }
}

/// Owns the generated cfg files for exactly one running server. Every exit
/// path, including a failed spawn, removes both files without touching assets.
pub struct ConfigFiles {
    paths: Vec<PathBuf>,
}

impl Drop for ConfigFiles {
    fn drop(&mut self) {
        self.cleanup();
    }
}

impl ConfigFiles {
    /// Clean before publishing a stopped session so another start cannot
    /// race the old session's destructor and lose its generated cfg files.
    pub fn cleanup(&mut self) {
        for path in self.paths.drain(..) {
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("hosting: cannot delete {}: {e}", path.display());
                }
            }
        }
    }
}

pub fn write_configs(directory: &Path, config: &ServerConfig) -> Result<ConfigFiles> {
    let mut files = ConfigFiles { paths: Vec::new() };
    let mut write = |name: &str, text: String| -> Result<()> {
        let path = directory.join(name);
        files.paths.push(path.clone());
        std::fs::write(&path, text).map_err(|e| AppError::io_path("cannot write", &path, e))
    };
    write(CONFIG_FILE, host_config(config))?;
    let map_settings = config.map_settings().collect::<Vec<_>>();
    if !map_settings.is_empty() {
        write(SETTINGS_FILE, format!("{}\n", map_settings.join("\n")))?;
    }
    Ok(files)
}

/// How many ports the engine tries from `net_port` up.
pub const PORT_SPAN: u16 = 10;

/// Characters of a generated password and of the rcon password: no `0`,
/// `o`, `1`, `l` or `i`, which are misread aloud.
pub const PASSWORD_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// Length of a generated password.
pub const PASSWORD_LEN: usize = 8;

/// Length of the rcon password, which never leaves this machine.
pub const RCON_PASSWORD_LEN: usize = 24;

/// Longest server name.
pub const MAX_SERVER_NAME: usize = 32;

/// Longest password of the player's own.
pub const MAX_PASSWORD: usize = 24;

/// Who can connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    /// Friends anywhere through the relay, the local network directly.
    InternetLan,
    /// The local network only; nothing goes through the relay.
    Lan,
    /// Everyone through the relay; the server listens on loopback only.
    Internet,
}

impl Network {
    /// Whether the relay carries this server.
    pub fn uses_relay(self) -> bool {
        !matches!(self, Network::Lan)
    }

    /// Whether players on the local network connect directly.
    pub fn uses_lan(self) -> bool {
        !matches!(self, Network::Internet)
    }

    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Network::InternetLan => "internet_lan",
            Network::Lan => "lan",
            Network::Internet => "internet",
        }
    }

    /// Reads a stored value back, `None` for anything else.
    pub fn parse(text: &str) -> Option<Network> {
        match text {
            "internet_lan" => Some(Network::InternetLan),
            "lan" => Some(Network::Lan),
            "internet" => Some(Network::Internet),
            _ => None,
        }
    }
}

/// Everything the command line and the cfg are made of. `Debug` leaves both
/// passwords out.
#[derive(Clone)]
pub struct ServerConfig {
    pub game: Game,
    pub mod_folder: Option<String>,
    /// [`crate::launch::root_args`] of the client.
    pub roots: Vec<String>,
    pub network: Network,
    /// The first port the engine tries.
    pub port: u16,
    /// `jknet_session`.
    pub session_id: String,
    pub map: String,
    pub gametype: u8,
    pub max_players: u8,
    pub time_limit: u16,
    pub score_limit: u16,
    pub bots: u8,
    /// Already cleaned by [`clean_server_name`].
    pub server_name: String,
    /// `None` for a server without a password.
    pub password: Option<String>,
    pub rcon_password: String,
    /// Checked server-only assignments and map-state commands; never raw
    /// authored cfg text.
    pub extra_commands: Vec<String>,
}

impl ServerConfig {
    /// Worldspawn explicitly resets g_gravity. MakerMod registers its map
    /// state commands only after the game module loads. Other cvars may be
    /// restricted by the mod during map initialization (for example MBII
    /// g_authenticity), so their pre-map values must not be forced back.
    pub fn map_settings(&self) -> impl Iterator<Item = &str> {
        self.extra_commands
            .iter()
            .map(String::as_str)
            .filter(|command| {
                command.starts_with("set g_gravity ")
                    || command.starts_with("mremap ")
                    || command.starts_with("mweather ")
            })
    }
}

impl std::fmt::Debug for ServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Every field named: a new one fails to build until it is listed here.
        let ServerConfig {
            game,
            mod_folder,
            roots,
            network,
            port,
            session_id,
            map,
            gametype,
            max_players,
            time_limit,
            score_limit,
            bots,
            server_name,
            password,
            rcon_password: _,
            extra_commands: _,
        } = self;
        f.debug_struct("ServerConfig")
            .field("game", game)
            .field("mod_folder", mod_folder)
            .field("roots", roots)
            .field("network", network)
            .field("port", port)
            .field("session_id", session_id)
            .field("map", map)
            .field("gametype", gametype)
            .field("max_players", max_players)
            .field("time_limit", time_limit)
            .field("score_limit", score_limit)
            .field("bots", bots)
            .field("server_name", server_name)
            .field("password", &password.as_ref().map(|_| "<redacted>"))
            .field("rcon_password", &"<redacted>")
            .finish()
    }
}

/// The arguments of the server process.
pub fn server_args(config: &ServerConfig) -> Vec<String> {
    let mut args = config.roots.clone();
    // A previous server's archived cvars must not change this session,
    // including when no cfg is selected. OpenJK also skips autoexec here;
    // JK2MV executes autoexec independently of its saved-config switch.
    args.push("+safe".into());
    let mut set = |name: &str, value: String| {
        args.push("+set".to_string());
        args.push(name.to_string());
        args.push(value);
    };
    set("dedicated", "1".into());
    if !config.network.uses_lan() {
        set("net_ip", "127.0.0.1".into());
    }
    set("net_port", config.port.to_string());
    args.push("+sets".into());
    args.push("jknet_session".into());
    args.push(config.session_id.clone());
    args.push("+exec".into());
    args.push(CONFIG_FILE.into());
    args.push("+map".into());
    args.push(config.map.clone());
    if config.map_settings().next().is_some() {
        // Reapply only source-proven worldspawn overrides after map load.
        args.push("+exec".into());
        args.push(SETTINGS_FILE.into());
    }
    args
}

/// The text of `jknet-host.cfg`.
///
/// `g_password` and `rconPassword` are not archived cvars
/// (`codemp/game/g_xcvar.h:126`, `codemp/server/sv_init.cpp:976`), so neither
/// password lands in the config the server writes when it quits. The three
/// score limits are all written because they are archived: a value an earlier
/// session left there would otherwise decide a mode it was never set for.
/// `sv_lanForceRate 0` goes in only when the relay carries the server: the
/// engine takes `127.x` and the private ranges for a LAN and lifts its rate
/// limit for them, and the tunnel hands guests `127.77.x.y` addresses.
pub fn host_config(config: &ServerConfig) -> String {
    let spec = config.game.spec();
    let mut lines = vec![
        "// Written by JKNet for one private server session and deleted when it stops.".to_string(),
        format!("set sv_hostname \"{}\"", config.server_name),
        format!(
            "set g_password \"{}\"",
            config.password.as_deref().unwrap_or("")
        ),
        format!("set rconPassword \"{}\"", config.rcon_password),
        format!("set sv_maxclients {}", config.max_players),
        format!("set g_gametype {}", config.gametype),
        format!("set timelimit {}", config.time_limit),
    ];
    let score_cvar = crate::server_configs::score_cvar(
        config.game,
        config.mod_folder.as_deref(),
        config.gametype,
    );
    for (cvar, default) in SCORE_CVARS {
        let value = if Some(cvar) == score_cvar {
            config.score_limit
        } else {
            default
        };
        lines.push(format!("set {cvar} {value}"));
    }
    lines.push(format!("set bot_minplayers {}", config.bots));
    lines.push("set sv_pure 0".into());
    lines.push("set sv_allowDownload 0".into());
    if config.network.uses_relay() {
        lines.push("set sv_lanForceRate 0".into());
    }
    lines.push("set g_log \"\"".into());
    for master in spec.hosting.master_cvars {
        lines.push(format!("set {master} \"\""));
    }
    let mut text = lines.join("\n");
    text.push('\n');
    let pre_map_commands = config
        .extra_commands
        .iter()
        .filter(|command| command.starts_with("set "))
        .cloned()
        .collect::<Vec<_>>();
    if !pre_map_commands.is_empty() {
        // Checked assignments cannot change managed settings. Keeping the
        // managed policy last also makes the effective cfg clear to readers.
        text = format!("{}\n{text}", pre_map_commands.join("\n"));
    }
    text
}

/// Cuts a server name down to what the cfg and the console can carry:
/// `[A-Za-z0-9 _.'!^-]` and 32 characters. A quote, a semicolon or a backslash
/// would break the file. Blank after the cut means no name.
pub fn clean_server_name(name: &str) -> String {
    let kept: String = name
        .chars()
        .filter(|c| {
            c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '\'' | '!' | '^' | '-')
        })
        .collect();
    let collapsed = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .chars()
        .take(MAX_SERVER_NAME)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Refuses a password the cfg and the console command could not carry.
pub fn validate_password(password: &str) -> Result<()> {
    let length_ok = (1..=MAX_PASSWORD).contains(&password.chars().count());
    let chars_ok = password
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if length_ok && chars_ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "a server password is 1 to {MAX_PASSWORD} letters, digits, '_' or '-'"
        )))
    }
}

/// `count` characters of [`PASSWORD_ALPHABET`] from the system's generator.
pub fn random_password(count: usize) -> String {
    let mut bytes = vec![0u8; count];
    if let Err(e) = getrandom::fill(&mut bytes) {
        // Not expected on any Windows the launcher runs on; the clock is a
        // poor source, but a server without a password is worse.
        log::warn!("the system random generator failed: {e}");
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = (seed >> ((index % 16) * 8)) as u8 ^ (index as u8).wrapping_mul(151);
        }
    }
    bytes
        .iter()
        .map(|byte| PASSWORD_ALPHABET[usize::from(*byte) % PASSWORD_ALPHABET.len()] as char)
        .collect()
}

/// A fresh label for one session: 16 hexadecimal characters.
pub fn new_session_id() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        bytes = (nanos ^ u64::from(std::process::id()).rotate_left(32)).to_be_bytes();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Out-of-band queries
// ---------------------------------------------------------------------------

/// A `statusResponse`, read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    /// The serverinfo keys.
    pub info: BTreeMap<String, String>,
    pub players: Vec<protocol::StatusPlayer>,
}

impl Status {
    fn parse(body: &[u8]) -> Status {
        let text = protocol::decode_bytes(body);
        let (info, players) = match text.split_once('\n') {
            Some((info, rest)) => (info.to_string(), rest.to_string()),
            None => (text, String::new()),
        };
        Status {
            info: parse_infostring(&info),
            players: protocol::parse_status_players(&players),
        }
    }

    /// The label of the session the server carries, if any.
    pub fn session(&self) -> Option<&str> {
        self.info.get("jknet_session").map(String::as_str)
    }

    /// The map the server runs.
    pub fn map(&self) -> Option<&str> {
        self.info.get("mapname").map(String::as_str)
    }

    /// Players who are not bots. A bot's ping is 0 (`SV_CalcPings`), the rule
    /// the server browser uses too; a player still connecting shows 999 and
    /// counts as a human.
    pub fn humans(&self) -> usize {
        self.players
            .iter()
            .filter(|player| !player.is_bot())
            .count()
    }
}

/// Why a server did not come up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotReady {
    /// The process ended; its exit code.
    Exited(u32),
    /// The console said every port is taken.
    PortsBusy,
    /// The console said the map is not there.
    MapMissing,
    /// No answer with the label within the budget.
    Timeout,
    /// The launcher asked to stop in the meantime.
    Cancelled,
}

/// What the wait looks at between two rounds of `getstatus`.
pub trait StartWatch: Sync {
    /// The exit code when the process has ended.
    fn exited(&self) -> Option<u32>;
    /// A reason the console already gave.
    fn console_says(&self) -> Option<NotReady>;
    /// Whether the start was cancelled.
    fn cancelled(&self) -> bool;
}

/// Waits for the server with `session_id` to answer on one of the ports from
/// `first_port` up, and answers the port it took.
pub async fn wait_ready(
    first_port: u16,
    session_id: &str,
    budget: Duration,
    watch: &dyn StartWatch,
) -> std::result::Result<u16, NotReady> {
    let socket = UdpSocket::bind("127.0.0.1:0")
        .await
        .map_err(|_| NotReady::Timeout)?;
    let request = oob_packet("getstatus jknet");
    let started = Instant::now();
    let mut buffer = vec![0u8; 65_535];
    loop {
        if let Some(code) = watch.exited() {
            return Err(NotReady::Exited(code));
        }
        if let Some(reason) = watch.console_says() {
            return Err(reason);
        }
        if watch.cancelled() {
            return Err(NotReady::Cancelled);
        }
        if started.elapsed() >= budget {
            return Err(NotReady::Timeout);
        }
        for offset in 0..PORT_SPAN {
            let port = first_port.saturating_add(offset);
            let _ = socket
                .send_to(&request, SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
                .await;
        }
        let round = Instant::now() + Duration::from_secs(1);
        let mut errors = 0u32;
        while let Some(left) = round.checked_duration_since(Instant::now()) {
            let received = tokio::time::timeout(left, socket.recv_from(&mut buffer)).await;
            let (read, from) = match received {
                Ok(Ok(received)) => received,
                // `WSAECONNRESET` from a port nobody listens on: one per
                // datagram sent, so skip it. More than the round could have
                // caused is a socket that is broken for good: wait the round
                // out instead of spinning on it.
                Ok(Err(_)) => {
                    errors += 1;
                    if errors > u32::from(PORT_SPAN) * 2 {
                        tokio::time::sleep(left).await;
                        break;
                    }
                    continue;
                }
                Err(_) => break,
            };
            let Some(payload) = oob_payload(&buffer[..read]) else {
                continue;
            };
            let (command, body) = split_command(payload);
            if command != b"statusResponse" {
                continue;
            }
            if Status::parse(body).session() == Some(session_id) {
                return Ok(from.port());
            }
        }
    }
}

/// One `getstatus` of a running server on loopback.
pub async fn status(port: u16) -> Result<Status> {
    let reply = crate::servers::net::query_status(
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, port),
        Duration::from_millis(900),
        2,
    )
    .await?;
    let mut status = Status {
        info: parse_infostring(&reply.infostring),
        players: protocol::parse_status_players(&reply.players),
    };
    status.info.remove("challenge");
    Ok(status)
}

/// Sends one rcon command from loopback and does not wait for an answer:
/// `quit` never answers, the server leaves inside the command.
pub async fn rcon(port: u16, rcon_password: &str, command: &str) -> Result<()> {
    let socket = UdpSocket::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Network(format!("cannot open a UDP socket: {e}")))?;
    socket
        .send_to(
            &oob_packet(&format!("rcon {rcon_password} {command}")),
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, port),
        )
        .await
        .map_err(|e| AppError::Network(format!("cannot reach the server on port {port}: {e}")))?;
    Ok(())
}

/// The commands that move a running server to another map and mode.
///
/// One command per rcon packet: the engine runs the remainder of an rcon line
/// as a single command (`Cmd_ExecuteString`), so `a; b` would not split. The
/// score limit of the new mode starts at its default unless the mode keeps
/// the same cvar.
pub fn change_map_commands(
    game: Game,
    mod_folder: Option<&str>,
    old_gametype: u8,
    score_limit: u16,
    map: &str,
    gametype: u8,
    reapply_settings: bool,
) -> Vec<String> {
    let hosting = game.spec().hosting;
    let old_cvar = crate::server_configs::score_cvar(game, mod_folder, old_gametype);
    let mut commands = vec![format!("g_gametype {gametype}")];
    if let Some(new) = hosting.gametype(gametype) {
        if let Some(cvar) = crate::server_configs::score_cvar(game, mod_folder, gametype) {
            let value = if Some(cvar) == old_cvar {
                score_limit
            } else {
                new.default_score
            };
            commands.push(format!("{cvar} {value}"));
        }
    }
    commands.push(format!("map {map}"));
    if reapply_settings {
        commands.push(format!("exec {SETTINGS_FILE}"));
    }
    commands
}

/// Whether a map name can go into a command line and an rcon command:
/// letters, digits and `/_-.+`, no `..`, 1–64 characters.
pub fn is_safe_map_name(map: &str) -> bool {
    !map.is_empty()
        && map.len() <= 64
        && !map.contains("..")
        && !map.starts_with('/')
        && map
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | '+'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(game: Game, network: Network) -> ServerConfig {
        ServerConfig {
            game,
            mod_folder: None,
            roots: vec![
                "+set".into(),
                "fs_cdpath".into(),
                r"D:\Games\Jedi Academy\GameData".into(),
                "+set".into(),
                "fs_basepath".into(),
                r"C:\JKNet\clients\everyday\engine".into(),
                "+set".into(),
                "fs_homepath".into(),
                r"C:\JKNet\clients\everyday\home".into(),
            ],
            network,
            port: game.spec().server_port,
            session_id: "5e0b7c1f9a2d4c38".into(),
            map: game.spec().hosting.default_map.into(),
            gametype: 0,
            max_players: 8,
            time_limit: 0,
            score_limit: 20,
            bots: 0,
            server_name: "Tray's game".into(),
            password: Some("k7m2q9xa".into()),
            rcon_password: "r4n9d0mr4n9d0mr4n9d0mr4".into(),
            extra_commands: Vec::new(),
        }
    }

    #[test]
    fn debug_output_leaves_both_passwords_out() {
        let text = format!("{:?}", config(Game::JediAcademy, Network::InternetLan));
        assert!(!text.contains("k7m2q9xa"), "{text}");
        assert!(!text.contains("r4n9d0m"), "{text}");
        assert!(text.contains("<redacted>"), "{text}");
    }

    #[test]
    fn the_command_line_ends_in_the_label_the_cfg_and_the_map() {
        let args = server_args(&config(Game::JediAcademy, Network::InternetLan));
        let tail: Vec<&str> = args[9..].iter().map(String::as_str).collect();
        assert_eq!(
            tail,
            [
                "+safe",
                "+set",
                "dedicated",
                "1",
                "+set",
                "net_port",
                "29070",
                "+sets",
                "jknet_session",
                "5e0b7c1f9a2d4c38",
                "+exec",
                "jknet-host.cfg",
                "+map",
                "mp/ffa3",
            ]
        );
        // The roots come first, exactly as the client gets them.
        assert_eq!(
            args[..9],
            config(Game::JediAcademy, Network::InternetLan).roots[..]
        );
        // No password on the command line: it lives in the cfg.
        assert!(!args
            .iter()
            .any(|arg| arg.contains("k7m2q9xa") || arg.contains("r4n9d0m")));
    }

    #[test]
    fn only_the_internet_mode_keeps_the_server_on_loopback() {
        for (network, loopback) in [
            (Network::InternetLan, false),
            (Network::Lan, false),
            (Network::Internet, true),
        ] {
            let args = server_args(&config(Game::JediAcademy, network));
            let has = args
                .windows(3)
                .any(|w| w == ["+set", "net_ip", "127.0.0.1"]);
            assert_eq!(has, loopback, "{network:?}");
        }
        let jo = server_args(&config(Game::JediOutcast, Network::Internet));
        assert!(jo.windows(3).any(|w| w == ["+set", "net_port", "28070"]));
        assert!(jo.ends_with(&["+map".to_string(), "ffa_bespin".to_string()]));
    }

    #[test]
    fn the_cfg_of_jedi_academy_in_the_three_modes() {
        let text = host_config(&config(Game::JediAcademy, Network::InternetLan));
        assert_eq!(
            text,
            "// Written by JKNet for one private server session and deleted when it stops.\n\
             set sv_hostname \"Tray's game\"\n\
             set g_password \"k7m2q9xa\"\n\
             set rconPassword \"r4n9d0mr4n9d0mr4n9d0mr4\"\n\
             set sv_maxclients 8\n\
             set g_gametype 0\n\
             set timelimit 0\n\
             set fraglimit 20\n\
             set duel_fraglimit 10\n\
             set capturelimit 8\n\
             set bot_minplayers 0\n\
             set sv_pure 0\n\
             set sv_allowDownload 0\n\
             set sv_lanForceRate 0\n\
             set g_log \"\"\n\
             set sv_master1 \"\"\n\
             set sv_master2 \"\"\n\
             set sv_master3 \"\"\n\
             set sv_master4 \"\"\n\
             set sv_master5 \"\"\n"
        );
        // The relay modes lift the LAN rate exemption; the LAN mode keeps it.
        assert!(host_config(&config(Game::JediAcademy, Network::Internet))
            .contains("sv_lanForceRate 0"));
        assert!(!host_config(&config(Game::JediAcademy, Network::Lan)).contains("sv_lanForceRate"));
    }

    #[test]
    fn the_cfg_of_jedi_outcast_leaves_the_read_only_masters_alone() {
        let mut duel = config(Game::JediOutcast, Network::Lan);
        duel.gametype = 3;
        duel.score_limit = 5;
        duel.password = None;
        let text = host_config(&duel);
        assert!(!text.contains("sv_master"), "{text}");
        assert!(text.contains("set g_password \"\"\n"));
        // Duel sets its own limit; the other two go back to their defaults.
        assert!(text.contains("set duel_fraglimit 5\n"));
        assert!(text.contains("set fraglimit 20\n"));
        assert!(text.contains("set capturelimit 8\n"));
    }

    #[test]
    fn server_document_assignments_run_before_the_private_session_policy() {
        let mut config = config(Game::JediAcademy, Network::Internet);
        config.extra_commands = vec!["set g_gravity \"600\"".into()];
        let text = host_config(&config);
        assert!(text.starts_with("set g_gravity \"600\"\n"));
        assert!(text.contains("set g_password \"k7m2q9xa\"\n"));
        assert!(text.contains("set sv_master1 \"\"\n"));
        assert!(server_args(&config)
            .windows(3)
            .any(|tokens| tokens == ["+set", "dedicated", "1"]));
        assert!(server_args(&config)
            .windows(3)
            .any(|tokens| tokens == ["+set", "net_ip", "127.0.0.1"]));
        assert!(server_args(&config).ends_with(&[
            "+map".into(),
            "mp/ffa3".into(),
            "+exec".into(),
            SETTINGS_FILE.into()
        ]));
    }

    #[test]
    fn staged_configs_reapply_only_checked_cvars_and_are_removed_together() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = config(Game::JediAcademy, Network::Internet);
        config.extra_commands = vec![
            "set g_gravity \"500\"".into(),
            "set g_authenticity \"3\"".into(),
            "set g_maxforcerank \"6\"".into(),
            "set custom_mod_setting \"1\"".into(),
            "set g_gravity \"650\"".into(),
        ];
        let files = write_configs(temp.path(), &config).unwrap();
        assert!(temp.path().join(CONFIG_FILE).is_file());
        assert_eq!(
            std::fs::read_to_string(temp.path().join(SETTINGS_FILE)).unwrap(),
            "set g_gravity \"500\"\nset g_gravity \"650\"\n"
        );
        let initial = std::fs::read_to_string(temp.path().join(CONFIG_FILE)).unwrap();
        assert!(initial.contains("set g_authenticity \"3\""));
        assert!(initial.contains("set g_maxforcerank \"6\""));
        assert!(initial.contains("set custom_mod_setting \"1\""));
        drop(files);
        assert!(!temp.path().join(CONFIG_FILE).exists());
        assert!(!temp.path().join(SETTINGS_FILE).exists());
        config
            .extra_commands
            .retain(|command| !command.starts_with("set g_gravity "));
        let _files = write_configs(temp.path(), &config).unwrap();
        assert!(!temp.path().join(SETTINGS_FILE).exists());
        assert!(!server_args(&config)
            .iter()
            .any(|argument| argument == SETTINGS_FILE));
    }

    #[test]
    fn each_game_initialization_reapplies_once_and_a_closed_console_is_not_consumed() {
        let mut replay = MapSettingsReplay::default();
        assert!(!replay.reapply_after(0, || panic!("no map initialized")));
        assert!(replay.reapply_after(1, || true));
        assert!(!replay.reapply_after(1, || panic!("already applied")));
        assert!(!replay.reapply_after(2, || false));
        assert!(replay.reapply_after(2, || true));
        assert!(!replay.reapply_after(2, || panic!("already applied")));
        assert!(replay.reapply_after(3, || true));
    }

    #[test]
    fn mbii_uses_the_round_limit_on_start_and_after_a_map_change() {
        let mut config = config(Game::JediAcademy, Network::Internet);
        config.mod_folder = Some("MBII".into());
        config.gametype = 7;
        config.score_limit = 12;
        assert!(host_config(&config).contains("set fraglimit 12\n"));
        assert_eq!(
            change_map_commands(config.game, Some("MBII"), 7, 12, "mb2_test", 3, false),
            ["g_gametype 3", "fraglimit 12", "map mb2_test"]
        );
    }

    #[test]
    fn a_server_name_is_cleaned_down_to_what_a_cfg_can_carry() {
        assert_eq!(clean_server_name("Tray's game"), "Tray's game");
        assert_eq!(
            clean_server_name("  ^1Red \"quoted\"; rm\\ -rf  "),
            "^1Red quoted rm -rf"
        );
        assert_eq!(clean_server_name("Кириллица"), "");
        assert_eq!(clean_server_name(&"x".repeat(50)).len(), MAX_SERVER_NAME);
    }

    #[test]
    fn a_password_the_cfg_cannot_carry_is_refused() {
        for good in ["k7m2q9xa", "A", "under_score-dash", &"a".repeat(24)] {
            assert!(validate_password(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "with space",
            "semi;colon",
            "quote\"",
            &"a".repeat(25),
            "пароль",
        ] {
            assert!(validate_password(bad).is_err(), "{bad}");
        }
        let generated = random_password(PASSWORD_LEN);
        assert_eq!(generated.len(), PASSWORD_LEN);
        assert!(generated
            .bytes()
            .all(|byte| PASSWORD_ALPHABET.contains(&byte)));
        assert!(validate_password(&random_password(RCON_PASSWORD_LEN)).is_ok());
        let id = new_session_id();
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, new_session_id());
    }

    #[test]
    fn a_map_change_sends_one_command_per_packet() {
        assert_eq!(
            change_map_commands(Game::JediAcademy, None, 0, 30, "mp/duel1", 3, false),
            ["g_gametype 3", "duel_fraglimit 10", "map mp/duel1"]
        );
        // The same cvar keeps the limit the host chose.
        assert_eq!(
            change_map_commands(Game::JediAcademy, None, 0, 30, "mp/ffa5", 6, false),
            ["g_gametype 6", "fraglimit 30", "map mp/ffa5"]
        );
        // Siege has no score limit.
        assert_eq!(
            change_map_commands(Game::JediAcademy, None, 0, 30, "mp/siege_hoth", 7, false),
            ["g_gametype 7", "map mp/siege_hoth"]
        );
        assert!(is_safe_map_name("mp/ffa3"));
        assert_eq!(
            change_map_commands(Game::JediAcademy, None, 0, 30, "mp/ffa5", 0, true),
            [
                "g_gametype 0",
                "fraglimit 30",
                "map mp/ffa5",
                "exec jknet-host-settings.cfg"
            ]
        );
        assert!(is_safe_map_name("ffa_bespin"));
        for bad in ["", "../etc", "mp ffa3", "mp;quit", "/abs", "mp/\"x"] {
            assert!(!is_safe_map_name(bad), "{bad}");
        }
    }

    struct Never;
    impl StartWatch for Never {
        fn exited(&self) -> Option<u32> {
            None
        }
        fn console_says(&self) -> Option<NotReady> {
            None
        }
        fn cancelled(&self) -> bool {
            false
        }
    }

    /// A stand-in for a dedicated server: answers `getstatus` with a label.
    async fn fake_server(label: &'static str) -> (u16, tokio::task::JoinHandle<()>) {
        let socket = UdpSocket::bind("127.0.0.1:0").await.expect("a socket");
        let port = socket.local_addr().expect("an address").port();
        let task = tokio::spawn(async move {
            let mut buffer = vec![0u8; 2048];
            while let Ok((read, from)) = socket.recv_from(&mut buffer).await {
                let Some(payload) = oob_payload(&buffer[..read]) else {
                    continue;
                };
                if split_command(payload).0 == b"getstatus" {
                    let reply = oob_packet(&format!(
                        "statusResponse\n\\sv_hostname\\Test\\mapname\\mp/ffa3\\jknet_session\\{label}\n0 0 \"^1Bot\"\n3 42 \"Kyle\"\n"
                    ));
                    let _ = socket.send_to(&reply, from).await;
                }
            }
        });
        (port, task)
    }

    #[tokio::test]
    async fn the_wait_takes_the_port_with_our_label_and_skips_a_stranger() {
        let (stranger, stranger_task) = fake_server("0000000000000000").await;
        let (ours, ours_task) = fake_server("5e0b7c1f9a2d4c38").await;
        // Ask from the lower of the two ports so both are in the span.
        let first = stranger.min(ours);
        if ours.abs_diff(stranger) >= PORT_SPAN {
            // The system handed out ports too far apart for one span; the
            // wait on our own port alone still has to find it.
            let port = wait_ready(ours, "5e0b7c1f9a2d4c38", Duration::from_secs(3), &Never).await;
            assert_eq!(port, Ok(ours));
        } else {
            let port = wait_ready(first, "5e0b7c1f9a2d4c38", Duration::from_secs(3), &Never).await;
            assert_eq!(port, Ok(ours));
        }
        let status = status(ours).await.expect("a status");
        assert_eq!(status.session(), Some("5e0b7c1f9a2d4c38"));
        assert_eq!(status.map(), Some("mp/ffa3"));
        assert_eq!(status.players.len(), 2);
        assert_eq!(status.humans(), 1);
        stranger_task.abort();
        ours_task.abort();
    }

    #[tokio::test]
    async fn the_wait_ends_on_its_budget_and_on_an_exit() {
        // Ten closed ports on loopback: every send comes back as a reset,
        // and the wait must neither end early nor spin.
        let started = Instant::now();
        let result = wait_ready(1, "5e0b7c1f9a2d4c38", Duration::from_millis(1200), &Never).await;
        assert_eq!(result, Err(NotReady::Timeout));
        assert!(started.elapsed() < Duration::from_secs(4));

        struct Gone;
        impl StartWatch for Gone {
            fn exited(&self) -> Option<u32> {
                Some(0xC000_0005)
            }
            fn console_says(&self) -> Option<NotReady> {
                None
            }
            fn cancelled(&self) -> bool {
                false
            }
        }
        assert_eq!(
            wait_ready(1, "x", Duration::from_secs(5), &Gone).await,
            Err(NotReady::Exited(0xC000_0005))
        );
    }
}
