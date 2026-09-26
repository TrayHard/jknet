//! A guest joins a private server: the local network first, the relay next.
//!
//! 1. The source is an invite (`accept_invite`) or a friend's presence
//!    (`join_friend`) that carries `hosting`.
//! 2. The client is the default client of `hosting.game`. The rule that reads
//!    the game off the port of an address does not work here: relay ports are
//!    outside the windows of both games and would read as Jedi Academy.
//! 3. `getstatus` goes to every address of the host's network at once, two
//!    tries of 300 ms, and the first answer whose `jknet_session` is the
//!    label of the session wins: the label tells the host's server from a
//!    stranger at the same private address in the guest's own network.
//!    `getinfo` would not do, its answer carries a fixed set of keys.
//! 4. An address of the network answered: path `lan`.
//! 5. Otherwise the relay, when there is one: path `relay`, without a probe.
//! 6. Otherwise the server is open to the host's network only: path `lan` to
//!    the first address, with `probeFailed` so the screen can say so.
//! 7. The game starts through `launch::start_client` with `+set password`
//!    when there is a password; nothing is written to the server history,
//!    because the addresses die with the session.
//! 8. The guest joins the chat of the server in the background
//!    (`chat::server::join`): a chat the host has not opened yet is asked for
//!    again a few times, a server not open to the guest ends the attempt.

use std::net::SocketAddrV4;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tokio::task::JoinSet;

use crate::error::{AppError, Result};
use crate::game::Game;
use crate::launch::{self, LaunchState, RunningGame};
use crate::online::HostingInfo;
use crate::servers::protocol::parse_infostring;
use crate::state::AppState;

use super::server::validate_password;

/// How long one probe of an address waits.
const PROBE_WAIT: Duration = Duration::from_millis(300);
/// How many probes each address gets.
const PROBE_ATTEMPTS: u32 = 2;

/// How the game reached its server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JoinPath {
    /// An address of the host's network answered.
    Lan,
    /// Through the relay.
    Relay,
    /// An ordinary server, not a private one.
    Direct,
}

/// The answer of `accept_invite` and `join_friend`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinResult {
    pub game: RunningGame,
    pub path: JoinPath,
    /// The server is open to the host's network only and did not answer from
    /// here; the game tries the first address all the same.
    pub probe_failed: bool,
}

/// Where the game goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub address: String,
    pub path: JoinPath,
    pub probe_failed: bool,
}

/// Picks the path out of what the probe found. `None` when the server has
/// no address at all.
pub fn choose(hosting: &HostingInfo, answered: Option<String>) -> Option<Route> {
    if let Some(address) = answered {
        return Some(Route {
            address,
            path: JoinPath::Lan,
            probe_failed: false,
        });
    }
    if let Some(relay) = hosting.relay_address.as_deref().filter(|a| !a.trim().is_empty()) {
        return Some(Route {
            address: relay.trim().to_string(),
            path: JoinPath::Relay,
            probe_failed: false,
        });
    }
    hosting.lan_addresses.first().map(|first| Route {
        address: first.trim().to_string(),
        path: JoinPath::Lan,
        probe_failed: true,
    })
}

/// Sends `getstatus` to every address at once and answers the first one
/// whose server carries `session_id`.
pub async fn probe(addresses: &[String], session_id: &str) -> Option<String> {
    let mut probes = JoinSet::new();
    for address in addresses {
        let Ok(parsed) = address.trim().parse::<SocketAddrV4>() else {
            continue;
        };
        let address = address.trim().to_string();
        let wanted = session_id.to_string();
        probes.spawn(async move {
            let reply = crate::servers::net::query_status(parsed, PROBE_WAIT, PROBE_ATTEMPTS)
                .await
                .ok()?;
            let info = parse_infostring(&reply.infostring);
            (info.get("jknet_session").map(String::as_str) == Some(wanted.as_str())).then_some(address)
        });
    }
    while let Some(done) = probes.join_next().await {
        if let Ok(Some(address)) = done {
            probes.abort_all();
            return Some(address);
        }
    }
    None
}

/// The probe and the choice together.
pub async fn route(hosting: &HostingInfo) -> Result<Route> {
    let answered = if hosting.lan_addresses.is_empty() {
        None
    } else {
        probe(&hosting.lan_addresses, &hosting.session_id).await
    };
    choose(hosting, answered).ok_or_else(|| {
        AppError::Launch("the private server has no address to join yet".into())
    })
}

/// Joins a private server with the default client of its game, and then its
/// chat. `host_user_id` is the account that hosts it: the chat is found by
/// the host and the session together.
pub async fn join_private(
    app: &AppHandle,
    state: &AppState,
    launch: &LaunchState,
    hosting: &HostingInfo,
    host_user_id: &str,
) -> Result<JoinResult> {
    let game = Game::from_id(&hosting.game).ok_or_else(|| {
        AppError::InvalidInput(format!("the private server plays an unknown game {:?}", hosting.game))
    })?;
    let client_id = crate::friends::default_client(state, game)?;
    let extra_args = password_args(hosting.password.as_deref())?;
    let route = route(hosting).await?;
    route
        .address
        .parse::<SocketAddrV4>()
        .map_err(|_| AppError::InvalidInput(format!("{} is not an address", route.address)))?;
    log::info!(
        "joining a private server over {:?}{}",
        route.path,
        if route.probe_failed { ", the local network did not answer" } else { "" }
    );
    let running = launch::start_client(
        app,
        state,
        launch,
        &client_id,
        Some(&route.address),
        &extra_args,
        crate::profiles::ProfileChoice::default(),
        crate::engines::LaunchMode::Multiplayer,
    )?;
    // --- slice: chat --- in the background: the game is what the player
    // waits for, and the chat may open only after the host's next heartbeat.
    crate::chat::server::join(app, host_user_id, &hosting.session_id);
    Ok(JoinResult {
        game: running,
        path: route.path,
        probe_failed: route.probe_failed,
    })
}

/// Joins an ordinary server: the default client of the game its port names.
pub fn join_direct(
    app: &AppHandle,
    state: &AppState,
    launch: &LaunchState,
    address: &str,
) -> Result<JoinResult> {
    let client_id = crate::friends::default_client(state, Game::from_server_address(address))?;
    let running = launch::start_client(
        app,
        state,
        launch,
        &client_id,
        Some(address),
        &[],
        crate::profiles::ProfileChoice::default(),
        crate::engines::LaunchMode::Multiplayer,
    )?;
    Ok(JoinResult {
        game: running,
        path: JoinPath::Direct,
        probe_failed: false,
    })
}

/// `+set password <pw>`, refused for a value that could carry a second
/// command: JK2MV splits its command line on `+` even inside quotes.
pub fn password_args(password: Option<&str>) -> Result<Vec<String>> {
    match password.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(Vec::new()),
        Some(password) => {
            validate_password(password)?;
            Ok(vec!["+set".into(), "password".into(), password.to_string()])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::protocol::{oob_packet, oob_payload, split_command};
    use tokio::net::UdpSocket;

    fn hosting(lan: &[String], relay: Option<&str>) -> HostingInfo {
        HostingInfo {
            session_id: "5e0b7c1f9a2d4c38".into(),
            game: "ja".into(),
            map: Some("mp/ffa3".into()),
            max_players: 8,
            lan_addresses: lan.to_vec(),
            relay_address: relay.map(str::to_string),
            password: Some("k7m2q9xa".into()),
            join_policy: "friends".into(),
            ..HostingInfo::default()
        }
    }

    /// A server that answers `getstatus` with a label, on loopback.
    async fn server(label: &'static str) -> String {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 2048];
            while let Ok((read, from)) = socket.recv_from(&mut buffer).await {
                let Some(payload) = oob_payload(&buffer[..read]) else { continue };
                let (_, challenge) = split_command(payload);
                let challenge = String::from_utf8_lossy(challenge).to_string();
                let reply = oob_packet(&format!(
                    "statusResponse\n\\challenge\\{challenge}\\jknet_session\\{label}\n"
                ));
                let _ = socket.send_to(&reply, from).await;
            }
        });
        address
    }

    #[tokio::test]
    async fn the_label_decides_the_local_network_path() {
        let ours = server("5e0b7c1f9a2d4c38").await;
        let stranger = server("ffffffffffffffff").await;

        // Our label answered: the local network.
        let found = route(&hosting(&[stranger.clone(), ours.clone()], Some("203.0.113.5:29210")))
            .await
            .expect("a route");
        assert_eq!(found, Route { address: ours, path: JoinPath::Lan, probe_failed: false });

        // A stranger at the same address, or nobody: the relay.
        let found = route(&hosting(&[stranger.clone(), "127.0.0.1:9".into()], Some("203.0.113.5:29210")))
            .await
            .expect("a route");
        assert_eq!(found.path, JoinPath::Relay);
        assert_eq!(found.address, "203.0.113.5:29210");
        assert!(!found.probe_failed);

        // No relay: the first address of the network, flagged.
        let found = route(&hosting(std::slice::from_ref(&stranger), None)).await.expect("a route");
        assert_eq!(found, Route { address: stranger, path: JoinPath::Lan, probe_failed: true });

        // Nothing at all.
        assert!(route(&hosting(&[], None)).await.is_err());
    }

    #[test]
    fn a_password_that_could_carry_a_command_is_refused() {
        assert_eq!(
            password_args(Some("k7m2q9xa")).unwrap(),
            ["+set", "password", "k7m2q9xa"]
        );
        assert!(password_args(None).unwrap().is_empty());
        assert!(password_args(Some("  ")).unwrap().is_empty());
        assert!(password_args(Some("x +quit")).is_err());
        assert!(password_args(Some("x;quit")).is_err());
    }

    #[test]
    fn the_answer_reaches_the_frontend_in_camel_case() {
        let result = JoinResult {
            game: RunningGame {
                client_id: "everyday".into(),
                pid: 1,
                started_at: "2026-09-25T20:00:00Z".into(),
                mode: crate::engines::LaunchMode::Multiplayer,
            },
            path: JoinPath::Relay,
            probe_failed: false,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["path"], "relay");
        assert_eq!(json["probeFailed"], false);
        assert_eq!(json["game"]["clientId"], "everyday");
    }
}
