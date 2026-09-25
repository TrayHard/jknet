//! The whole chain of a private server without a window, for
//! `examples/host_smoke.rs`.
//!
//! Not an API of the launcher: the crate root re-exports this module hidden,
//! so the example drives the same code the commands run — the command line,
//! `jknet-host.cfg`, the pseudo console and its Job Object, the wait for the
//! label, the polls, the tunnel and the relay API — against a real dedicated
//! server. Everything listens on loopback: the server gets `net_ip 127.0.0.1`
//! and the fake guests are sockets of this process.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use crate::game::Game;
use crate::launch::{root_args, LaunchPlan};
use crate::online::{HostingInfo, NewInvite, OnlineClient, OnlineContext, PresenceUpdate};
use crate::servers::protocol::{oob_packet, oob_payload, parse_infostring, split_command};

use super::console::{ConsoleOutput, Marker, ServerProcess};
use super::server::{self, Network, NotReady, ServerConfig, StartWatch};
use super::tunnel::{self, TunnelEvent};

/// What the smoke run starts.
#[derive(Debug, Clone)]
pub struct SmokeConfig {
    /// A copy of the `engine\` folder of a Jedi Academy client.
    pub engine_dir: PathBuf,
    /// The dedicated server inside it.
    pub executable: PathBuf,
    /// The `GameData` folder of the game, read only.
    pub game_data: PathBuf,
    /// A throwaway `fs_homepath`.
    pub home_dir: PathBuf,
    /// The first port the engine tries.
    pub first_port: u16,
    pub map: String,
    /// Where the console of the server goes.
    pub log_file: PathBuf,
    /// A local JKNet Online with its relay on.
    pub online: Option<SmokeOnline>,
}

/// A local JKNet Online and two accounts of its `dev` provider.
#[derive(Clone)]
pub struct SmokeOnline {
    pub url: String,
    /// The account that hosts.
    pub host_token: String,
    /// A friend of the host: sees the server and gets the invite.
    pub guest_token: String,
}

impl std::fmt::Debug for SmokeOnline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmokeOnline").field("url", &self.url).finish_non_exhaustive()
    }
}

/// Runs the chain and answers one line per step, or the step that failed.
pub fn run(config: SmokeConfig) -> Result<Vec<String>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("no runtime: {e}"))?;
    runtime.block_on(chain(config))
}

struct Watch(Arc<ServerProcess>);

impl StartWatch for Watch {
    fn exited(&self) -> Option<u32> {
        self.0.exit_code()
    }
    fn console_says(&self) -> Option<NotReady> {
        if self.0.output().saw(Marker::BindFailed) {
            Some(NotReady::PortsBusy)
        } else if self.0.output().saw(Marker::MapMissing) {
            Some(NotReady::MapMissing)
        } else {
            None
        }
    }
    fn cancelled(&self) -> bool {
        false
    }
}

async fn chain(config: SmokeConfig) -> Result<Vec<String>, String> {
    let mut report = Vec::new();
    let game = Game::JediAcademy;
    let base_dir = config.home_dir.join("unused-basepath");
    let roots = root_args(&LaunchPlan {
        game,
        game_data: &config.game_data,
        engine_dir: &config.engine_dir,
        base_dir: &base_dir,
        home_dir: &config.home_dir,
        fs_game: None,
        settings_args: &[],
        client_args: &[],
        profile_args: &[],
        extra_args: &[],
        connect: None,
    });
    let session_id = server::new_session_id();
    let rcon_password = server::random_password(server::RCON_PASSWORD_LEN);
    let server_config = ServerConfig {
        game,
        roots,
        // Loopback only: `net_ip 127.0.0.1`.
        network: Network::Internet,
        port: config.first_port,
        session_id: session_id.clone(),
        map: config.map.clone(),
        gametype: 0,
        max_players: 8,
        time_limit: 0,
        score_limit: 20,
        bots: 0,
        server_name: "JKNet smoke".into(),
        password: Some(server::random_password(server::PASSWORD_LEN)),
        rcon_password: rcon_password.clone(),
    };
    let cfg_dir = config.home_dir.join("base");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("cannot create {}: {e}", cfg_dir.display()))?;
    let cfg_path = cfg_dir.join(server::CONFIG_FILE);
    std::fs::write(&cfg_path, server::host_config(&server_config))
        .map_err(|e| format!("cannot write {}: {e}", cfg_path.display()))?;
    let args = server::server_args(&server_config);
    report.push(format!("command line: {} tokens, ends in {:?}", args.len(), &args[args.len() - 10..]));

    let output = Arc::new(ConsoleOutput::with_log(&config.log_file));
    let started = Instant::now();
    let process = Arc::new(
        ServerProcess::spawn(&config.executable, &config.engine_dir, &args, output.clone())
            .map_err(|e| format!("spawn: {e}"))?,
    );
    report.push(format!("spawned pid {} with {:?}", process.pid(), process.method()));

    let port = match server::wait_ready(
        config.first_port,
        &session_id,
        Duration::from_secs(30),
        &Watch(process.clone()),
    )
    .await
    {
        Ok(port) => port,
        Err(reason) => {
            process.close();
            return Err(format!("not ready: {reason:?}; console tail: {:?}", output.tail(20)));
        }
    };
    report.push(format!(
        "ready on 127.0.0.1:{port} after {} ms; console saw the game module: {}",
        started.elapsed().as_millis(),
        output.saw(Marker::GameInitialization)
    ));

    let status = server::status(port).await.map_err(|e| format!("getstatus: {e}"))?;
    report.push(format!(
        "getstatus: map {:?}, label {}, {} players",
        status.map(),
        status.session() == Some(session_id.as_str()),
        status.players.len()
    ));

    // A guest the way the tunnel binds one: its own loopback address.
    let direct = probe(SocketAddrV4::new(Ipv4Addr::new(127, 77, 0, 5), 0), SocketAddrV4::new(Ipv4Addr::LOCALHOST, port), "getinfo smoke")
        .await
        .map_err(|e| format!("getinfo from 127.77.0.5: {e}"))?;
    report.push(format!("getinfo from 127.77.0.5: {direct}"));

    if let Some(online) = config.online.as_ref() {
        let password = server_config.password.clone().unwrap_or_default();
        let relayed = through_the_relay(online, port, &session_id, &password).await;
        match relayed {
            Ok(lines) => report.extend(lines),
            Err(e) => {
                stop(&process, port, &rcon_password).await;
                let _ = std::fs::remove_file(&cfg_path);
                return Err(format!("relay: {e}"));
            }
        }
    } else {
        report.push("relay: skipped, no local JKNet Online was given".into());
    }

    let (stopped, how) = stop(&process, port, &rcon_password).await;
    report.push(format!("stopped with {how}, exit code {stopped:?}"));
    let _ = std::fs::remove_file(&cfg_path);
    report.push(format!("console lines kept: {}, last: {:?}", output.tail(1000).len(), output.tail(1)));
    Ok(report)
}

/// `rcon quit`, then the console, then the job; answers the exit code and
/// which of the three did it.
async fn stop(process: &Arc<ServerProcess>, port: u16, rcon_password: &str) -> (Option<u32>, &'static str) {
    let sent = Instant::now();
    let _ = server::rcon(port, rcon_password, "quit").await;
    let waiting = process.clone();
    let quit = tokio::task::spawn_blocking(move || waiting.wait(Duration::from_secs(3)))
        .await
        .ok()
        .flatten();
    let result = if quit.is_some() {
        (quit, "rcon quit")
    } else if process.type_line("quit") && process.wait(Duration::from_secs(1)).is_some() {
        (process.exit_code(), "quit in the console")
    } else {
        process.terminate();
        (process.wait(Duration::from_secs(2)), "the Job Object")
    };
    log::info!("smoke: stopped in {} ms", sent.elapsed().as_millis());
    process.close();
    result
}

/// One out-of-band request from `from`, the first answer as text.
async fn probe(from: SocketAddrV4, to: SocketAddrV4, request: &str) -> Result<String, String> {
    let socket = UdpSocket::bind(from).await.map_err(|e| format!("bind {from}: {e}"))?;
    socket.connect(to).await.map_err(|e| format!("connect {to}: {e}"))?;
    let mut buffer = vec![0u8; 65_535];
    for _ in 0..3 {
        socket.send(&oob_packet(request)).await.map_err(|e| format!("send: {e}"))?;
        if let Ok(Ok(read)) = tokio::time::timeout(Duration::from_millis(1500), socket.recv(&mut buffer)).await {
            let Some(payload) = oob_payload(&buffer[..read]) else { continue };
            let (command, body) = split_command(payload);
            let info = parse_infostring(&String::from_utf8_lossy(body));
            return Ok(format!(
                "{} with {} keys, hostname {:?}, challenge {:?}, label {:?}",
                String::from_utf8_lossy(command),
                info.len(),
                info.get("hostname").or_else(|| info.get("sv_hostname")),
                info.get("challenge"),
                info.get("jknet_session")
            ));
        }
    }
    Err(format!("no answer from {to}"))
}

async fn through_the_relay(
    service: &SmokeOnline,
    port: u16,
    session_id: &str,
    password: &str,
) -> Result<Vec<String>, String> {
    let mut report = Vec::new();
    let online = OnlineClient::new();
    let base_url = service.url.trim_end_matches('/').to_string();
    let ctx = OnlineContext { base_url: base_url.clone(), token: Some(service.host_token.clone()) };
    let guest = OnlineContext { base_url, token: Some(service.guest_token.clone()) };
    let grant = online
        .create_relay_session(&ctx, Game::JediAcademy.id(), &[])
        .await
        .map_err(|e| format!("POST /v1/relay/sessions: {e}"))?;
    report.push(format!(
        "relay grant: session {} on node {} ({}), control {}, expires {}",
        grant.session_id, grant.node.id, grant.node.region, grant.node.control_address, grant.expires_at
    ));
    let config = super::tunnel_config(&grant, Some(port)).await?;
    let (events_tx, mut events) = mpsc::unbounded_channel();
    let handle = tunnel::spawn(config, events_tx);
    let public = loop {
        match tokio::time::timeout(Duration::from_secs(12), events.recv()).await {
            Ok(Some(TunnelEvent::Active { public, expires_at, max_guests })) => {
                report.push(format!("tunnel active: guests reach {public}, expires at {expires_at}, max {max_guests} guests"));
                break public;
            }
            Ok(Some(other)) => report.push(format!("tunnel event: {other:?}")),
            Ok(None) | Err(_) => {
                handle.close().await;
                let _ = online.close_relay_session(&ctx, &grant.session_id).await;
                return Err("the tunnel did not become active".into());
            }
        }
    };

    let mut checked = relay_checks(&online, &ctx, &grant, &handle, &mut events, public, session_id, &mut report).await;
    if checked.is_ok() {
        checked = hosting_checks(&online, &ctx, &guest, public, port, session_id, password, &mut report).await;
    }
    handle.close().await;
    let closed = online
        .close_relay_session(&ctx, &grant.session_id)
        .await
        .map_err(|e| format!("DELETE /v1/relay/sessions: {e}"));
    checked.map_err(|e| format!("{e}; so far: {report:?}"))?;
    closed?;
    report.push("relay session closed".into());
    Ok(report)
}

/// What the relay has to do while its tunnel runs: carry the queries, take a
/// renewed ticket, refuse a second session of the account.
#[allow(clippy::too_many_arguments)]
async fn relay_checks(
    online: &OnlineClient,
    ctx: &OnlineContext,
    grant: &crate::online::RelayGrant,
    handle: &tunnel::TunnelHandle,
    events: &mut mpsc::UnboundedReceiver<TunnelEvent>,
    public: SocketAddrV4,
    session_id: &str,
    report: &mut Vec<String>,
) -> Result<(), String> {
    use base64::Engine as _;

    // A guest from «the internet»: here, a socket of this process sending to
    // the public port of the node, which is on loopback in a local run.
    let info = probe(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0), public, "getinfo relayed").await;
    let status = probe(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0), public, "getstatus relayed").await;
    let label_ok = status.as_ref().is_ok_and(|text| text.contains(session_id));
    report.push(format!("getinfo through the relay: {}", info.clone().unwrap_or_else(|e| e)));
    report.push(format!("getstatus through the relay carries the label: {label_ok}"));
    if info.is_err() || !label_ok {
        return Err("the relay did not carry the queries".into());
    }

    // A later ticket of the same session: the key stays, and the node takes
    // it in a HELLO and moves the end of the session. A second later is
    // enough for the new end to differ from the old one.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let renewed = online
        .renew_relay_session(ctx, &grant.session_id)
        .await
        .map_err(|e| format!("POST /v1/relay/sessions/{{id}}/renew: {e}"))?;
    if renewed.host_key != grant.host_key || renewed.session_id != grant.session_id {
        return Err("the renewal changed the key or the session".into());
    }
    let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(renewed.ticket.trim_end_matches('='))
        .map_err(|e| format!("the renewed ticket is not base64url: {e}"))?;
    handle.renew(ticket);
    let wanted = crate::timestamp::parse_rfc3339(&renewed.expires_at);
    let moved = loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Some(TunnelEvent::Expires(at))) => break Some(at),
            Ok(Some(other)) => report.push(format!("tunnel event: {other:?}")),
            Ok(None) | Err(_) => break None,
        }
    };
    report.push(format!(
        "renewed ticket: the node moved the end to {moved:?}, the service said {wanted:?} ({})",
        renewed.expires_at
    ));
    if moved.is_none() || moved != wanted {
        return Err("the node did not take the renewed ticket".into());
    }

    // The first KEEPALIVE after that, at the node's interval: its answer
    // counts only with the nonce it echoes, and the guest count is the sign.
    let counted = loop {
        match tokio::time::timeout(Duration::from_secs(20), events.recv()).await {
            Ok(Some(TunnelEvent::Guests(guests))) => break Some(guests),
            Ok(Some(TunnelEvent::Lost)) | Ok(None) | Err(_) => break None,
            Ok(Some(other)) => report.push(format!("tunnel event: {other:?}")),
        }
    };
    report.push(format!("keepalive answered and counted: the node reports {counted:?} guests"));
    if counted.is_none() {
        return Err("no KEEPALIVE_ACK of the node counted".into());
    }

    // One session per account: a second one while the first is open is the
    // quota refusal, with its details.
    match online.create_relay_session(ctx, Game::JediAcademy.id(), &[]).await {
        Ok(extra) => {
            let _ = online.close_relay_session(ctx, &extra.session_id).await;
            Err("the service granted a second relay session to the same account".into())
        }
        Err(e) => {
            let (code, message) = super::relay_error_of(&e);
            report.push(format!("second session refused: {code:?} ({message}); {e:?}"));
            if code == super::RelayErrorCode::QuotaActive {
                Ok(())
            } else {
                Err("the second session was refused for another reason".into())
            }
        }
    }
}

/// The presence and the invite of the server as the friend sees them: the
/// service keeps the relay address of the host's own session, lets the
/// friend join under `friends` and hands the password over.
#[allow(clippy::too_many_arguments)]
async fn hosting_checks(
    online: &OnlineClient,
    host: &OnlineContext,
    guest: &OnlineContext,
    public: SocketAddrV4,
    port: u16,
    session_id: &str,
    password: &str,
    report: &mut Vec<String>,
) -> Result<(), String> {
    let host_id = online.get_me(host).await.map_err(|e| format!("GET /v1/me: {e}"))?.user.id;
    let guest_id = online.get_me(guest).await.map_err(|e| format!("GET /v1/me: {e}"))?.user.id;

    // Friends first, or friends already from an earlier run on the same data.
    let friends = online.get_friends(host).await.map_err(|e| format!("GET /v1/friends: {e}"))?;
    if !friends.friends.iter().any(|friend| friend.user.id == guest_id) {
        let sent = online
            .send_friend_request(guest, &host_id)
            .await
            .map_err(|e| format!("POST /v1/friends/requests: {e}"))?;
        if let Some(request) = sent.request {
            online
                .accept_request(host, &request.id)
                .await
                .map_err(|e| format!("accept the friend request: {e}"))?;
        }
    }

    // What the running server publishes: the relay and one address of the
    // local network, which the service only checks for its range.
    let public = public.to_string();
    let info = HostingInfo {
        session_id: session_id.to_string(),
        game: Game::JediAcademy.id().to_string(),
        mod_name: None,
        map: Some("mp/ffa3".into()),
        gametype: 0,
        players: 0,
        max_players: 8,
        lan_addresses: vec![format!("10.0.0.5:{port}")],
        relay_address: Some(public.clone()),
        password: Some(password.to_string()),
        join_policy: "friends".into(),
        join_user_ids: Some(Vec::new()),
        can_join: None,
    };
    let update = PresenceUpdate {
        status: "online".into(),
        server_address: None,
        server_name: None,
        client_name: None,
        hosting: Some(info.clone()),
    };
    let own = online.put_presence(host, &update).await.map_err(|e| format!("PUT /v1/presence: {e}"))?;
    let kept = own.hosting.as_ref().and_then(|hosting| hosting.relay_address.clone());
    report.push(format!("presence with hosting accepted; the service kept the relay address: {kept:?}"));
    if kept.as_deref() != Some(public.as_str()) {
        return Err("the service dropped the relay address of the host's own session".into());
    }

    let friends = online.get_friends(guest).await.map_err(|e| format!("GET /v1/friends: {e}"))?;
    let seen = friends
        .friends
        .iter()
        .find(|friend| friend.user.id == host_id)
        .and_then(|friend| friend.presence.hosting.clone())
        .ok_or("the friend does not see the server")?;
    report.push(format!(
        "the friend sees: relay {:?}, lan {:?}, canJoin {:?}, password given {}, joinUserIds {:?}",
        seen.relay_address,
        seen.lan_addresses,
        seen.can_join,
        seen.password.as_deref() == Some(password),
        seen.join_user_ids
    ));
    if seen.relay_address.as_deref() != Some(public.as_str())
        || seen.can_join != Some(true)
        || seen.password.as_deref() != Some(password)
        || seen.join_user_ids.is_some()
    {
        return Err("the friend's view of the server is not the one the contract gives".into());
    }

    let invite = NewInvite {
        to_user_id: guest_id.clone(),
        server_address: public.clone(),
        server_name: Some("JKNet smoke".into()),
        message: None,
        hosting: Some(info),
    };
    let sent = online.create_invite(host, &invite).await.map_err(|e| format!("POST /v1/invites: {e}"))?;
    let received = online
        .list_invites(guest)
        .await
        .map_err(|e| format!("GET /v1/invites: {e}"))?
        .into_iter()
        .find(|invite| invite.id == sent.id)
        .ok_or("the friend did not get the invite")?;
    let _ = online.dismiss_invite(guest, &received.id).await;
    let carried = received.hosting.as_ref();
    report.push(format!(
        "invite to {}: hosting with relay {:?}, password given {}",
        received.server_address,
        carried.and_then(|hosting| hosting.relay_address.clone()),
        carried.and_then(|hosting| hosting.password.as_deref()) == Some(password)
    ));
    if carried.and_then(|hosting| hosting.password.as_deref()) != Some(password) {
        return Err("the invite lost the private server".into());
    }

    // The server is going: friends stop seeing it.
    let quiet = PresenceUpdate { hosting: None, ..update };
    online.put_presence(host, &quiet).await.map_err(|e| format!("PUT /v1/presence: {e}"))?;
    Ok(())
}
