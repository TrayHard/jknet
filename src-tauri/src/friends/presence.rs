//! Telling the service where the player is.
//!
//! ## The state machine
//!
//! The launcher owns two of the three statuses of the contract. `offline` is
//! never sent: the service derives it from a missing heartbeat, which is also what
//! covers a launcher killed from the task manager.
//!
//! ```text
//!                 startup
//!                    │
//!                    ▼
//!               ┌─────────┐   launch:game-started    ┌──────────┐
//!               │ online  │ ───────────────────────► │ in_game  │
//!               │         │ ◄─────────────────────── │          │
//!               └─────────┘   launch:game-exited     └──────────┘
//!                    │                                    │
//!                    └──────── every 30 s: PUT /v1/presence ┘
//! ```
//!
//! A transition writes the new presence into [`FriendsState`] and pushes it at
//! once; the heartbeat pushes whatever is written there. Both go through the
//! same function, so a push that failed on the transition is repaired by the
//! next tick rather than by a retry loop of its own.
//!
//! The service answers a heartbeat that repeats itself by storing it and telling
//! nobody: friends get `presence.updated` only when a field actually changes.
//! That is why the launcher may push the same document every 30 s without
//! filling anybody's socket with noise.
//!
//! ## Rules the shape follows
//!
//! - Nothing here blocks startup. The first push waits for
//!   [`FIRST_PUSH_DELAY`], which also lets a launcher that opens and closes in
//!   two seconds skip the round trip entirely.
//! - A failure is a debug line, never a dialog. The player did not ask for
//!   this request and cannot act on its failure; the next tick tries again.
//! - Signed out means silent. The task keeps running and starts reporting the
//!   moment a token appears, because `account:changed` wakes it.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::clients;
use crate::online::{OnlineClient, OnlineContext, Presence, PresenceUpdate};
use crate::launch::{GameExited, GameStarted};
use crate::servers;
use crate::state::AppState;

use super::{FriendsState, HostPresence, EVENT_CHANGED};

/// How often the launcher repeats itself. The contract times a player out
/// after 90 s, so three ticks may be lost before a friend sees them go dark.
const HEARTBEAT: Duration = Duration::from_secs(30);

/// How long the first push waits for the window to finish opening.
const FIRST_PUSH_DELAY: Duration = Duration::from_secs(2);

/// Starts the reporter: the two event hooks and the heartbeat.
///
/// Called once from `setup`. Both tasks live as long as the process and cost
/// nothing while signed out.
pub fn start(app: &AppHandle) {
    watch_the_game(app);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut account = handle.state::<FriendsState>().account_changes();
        tokio::time::sleep(FIRST_PUSH_DELAY).await;
        loop {
            push(&handle).await;
            // Signing in must not wait out a tick before the player shows up
            // online, and signing out must stop the reporting on the spot
            // rather than 30 s later. Either way the wait ends early.
            let _ = tokio::time::timeout(HEARTBEAT, account.changed()).await;
        }
    });
}

/// Follows the game in and out and moves the state machine.
fn watch_the_game(app: &AppHandle) {
    let started = app.clone();
    app.listen("launch:game-started", move |event| {
        let payload = match serde_json::from_str::<GameStarted>(event.payload()) {
            Ok(payload) => payload,
            Err(e) => {
                log::debug!("cannot read launch:game-started for presence: {e}");
                return;
            }
        };
        let handle = started.clone();
        tauri::async_runtime::spawn(async move {
            let presence = in_game(&handle, &payload);
            set_and_push(&handle, presence).await;
        });
    });

    let exited = app.clone();
    app.listen("launch:game-exited", move |event| {
        // The payload is read for the log line only: whichever client left,
        // the launcher is back to being merely online. `LaunchState` allows
        // one game at a time, so there is no second session to fall back to.
        if let Ok(payload) = serde_json::from_str::<GameExited>(event.payload()) {
            log::debug!("{} exited, presence goes back to online", payload.client_id);
        }
        let handle = exited.clone();
        tauri::async_runtime::spawn(async move {
            set_and_push(&handle, online()).await;
        });
    });
}

/// The presence of a launcher with no game running.
pub fn online() -> Presence {
    Presence {
        status: Presence::ONLINE.into(),
        ..Presence::default()
    }
}

/// The presence of a launcher that just started a game.
///
/// The address is only known when the player joined a server from JKNet: a
/// game started from the Play button goes to the main menu, and claiming a
/// server there would send friends to an empty address.
fn in_game(app: &AppHandle, started: &GameStarted) -> Presence {
    let state = app.state::<AppState>();
    // Neither lookup is worth failing over: a presence without a client name
    // or a server name is a poorer status line, not a broken one.
    let client_name = state
        .paths()
        .ok()
        .and_then(|paths| clients::read_record(&paths, &started.client_id).ok())
        .map(|client| client.name);
    let server_name = started
        .connect
        .as_deref()
        .and_then(|address| servers::cached_name_for(&state, address));

    Presence {
        status: Presence::IN_GAME.into(),
        server_address: started.connect.clone(),
        server_name,
        client_name,
        ..Presence::default()
    }
}

// --- slice: play with friends ---
/// The presence the launcher reports: `raw` as the game events left it, with
/// the private server added and the loopback addresses taken out.
///
/// Two rules, one function, because both are about what friends may read:
///
/// - A game that joined `127.0.0.1:<port>` of this launcher's own private
///   server advertises the address friends use instead — the relay, or the
///   first address of the local network — and the name of that server.
/// - Any other loopback address (`127.0.0.0/8`, `localhost`, `0.0.0.0`) is
///   dropped with its server name. It means «this machine» to whoever reads
///   it, which is never the machine of the player who pressed **Join**: the
///   **Connect…** window used to send `127.0.0.1:29070` of a local test server
///   to every friend.
pub fn effective(raw: &Presence, hosting: Option<&HostPresence>) -> Presence {
    let mut presence = raw.clone();
    presence.hosting = hosting.map(|hosting| hosting.info.clone());
    let Some(address) = raw.server_address.as_deref() else {
        return presence;
    };
    if !is_loopback(address) {
        return presence;
    }
    let own_server = |hosting: &&HostPresence| {
        let host = address.trim().rsplit_once(':').map(|(host, _)| host).unwrap_or("");
        (host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"))
            && port_of(address) == Some(hosting.local_port)
    };
    match hosting.filter(own_server) {
        Some(hosting) => {
            presence.server_address = hosting
                .info
                .relay_address
                .clone()
                .or_else(|| hosting.info.lan_addresses.first().cloned());
            presence.server_name = Some(hosting.server_name.clone());
        }
        None => {
            presence.server_address = None;
            presence.server_name = None;
        }
    }
    presence
}

/// Whether an `ip:port` names this machine.
pub fn is_loopback(address: &str) -> bool {
    let address = address.trim();
    let host = match address.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => address,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host == "::1" {
        return true;
    }
    host.parse::<std::net::Ipv4Addr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

/// The port of an `ip:port`.
fn port_of(address: &str) -> Option<u16> {
    address.trim().rsplit_once(':')?.1.parse().ok()
}

/// Records the private server of this launcher, or its end, and sends the
/// presence at once when that changed anything.
pub fn set_hosting(app: &AppHandle, hosting: Option<HostPresence>) {
    if !app.state::<FriendsState>().set_hosting(hosting) {
        return;
    }
    if let Err(e) = app.emit(EVENT_CHANGED, ()) {
        log::debug!("cannot emit {EVENT_CHANGED}: {e}");
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        push(&handle).await;
    });
}

/// Writes the presence into the state and sends it at once.
pub async fn set_and_push(app: &AppHandle, presence: Presence) {
    app.state::<FriendsState>().set_presence(presence);
    // The screen shows the player's own presence — the Invite button only
    // appears while in a game — so the window is told whether or not the service
    // was reachable. A nudge rather than a payload: the window reads the
    // presence back from `get_friends_state` along with everything else.
    if let Err(e) = app.emit(EVENT_CHANGED, ()) {
        log::debug!("cannot emit {EVENT_CHANGED}: {e}");
    }
    push(app).await;
}

/// Sends whatever the state currently holds.
///
/// Silent while signed out, and silent on failure: this is a background
/// request nobody asked for, and the next heartbeat is the retry.
pub(crate) async fn push(app: &AppHandle) {
    let Ok(settings) = app.state::<AppState>().settings() else {
        return;
    };
    let ctx = OnlineContext::from_settings(&settings);
    if !ctx.signed_in() {
        return;
    }

    let presence = app.state::<FriendsState>().presence();
    if !presence.is_reportable() {
        return;
    }
    let update = PresenceUpdate::from(&presence);
    match app.state::<OnlineClient>().put_presence(&ctx, &update).await {
        Ok(_) => log::debug!("presence: {}", update.status),
        Err(e) => log::debug!("cannot report presence: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The body `push` builds out of a presence, without the `AppHandle` its
    /// two lookups need.
    fn body(presence: &Presence) -> String {
        serde_json::to_string(&PresenceUpdate::from(presence)).expect("serializes")
    }

    #[test]
    fn a_launcher_with_no_game_reports_itself_online_and_nothing_else() {
        let presence = online();
        assert_eq!(presence.status, Presence::ONLINE);
        assert_eq!(presence.server_address, None);
        assert_eq!(presence.server_name, None);

        // The body of the request carries the status and drops the rest, so a
        // player who leaves a server stops advertising it.
        assert_eq!(body(&presence), r#"{"status":"online"}"#);
    }

    #[test]
    fn only_the_two_reportable_statuses_reach_the_service() {
        let mut presence = online();
        assert!(presence.is_reportable());
        presence.status = Presence::OFFLINE.into();
        assert!(!presence.is_reportable());
        // A status the service grew after this launcher was built is not something
        // to report either: the launcher only ever says these two.
        presence.status = "away".into();
        assert!(!presence.is_reportable());
    }

    #[test]
    fn a_game_joined_from_jknet_advertises_its_server() {
        // The shape `in_game` builds, without the `AppHandle` the lookups need.
        let presence = Presence {
            status: Presence::IN_GAME.into(),
            server_address: Some("203.0.113.10:29070".into()),
            server_name: Some("EU FFA".into()),
            client_name: Some("Everyday".into()),
            ..Presence::default()
        };
        assert!(presence.in_game());
        assert_eq!(
            body(&presence),
            r#"{"status":"in_game","serverAddress":"203.0.113.10:29070","serverName":"EU FFA","clientName":"Everyday"}"#
        );
    }

    #[test]
    fn a_game_started_from_the_play_button_claims_no_server() {
        // Play starts the game in its main menu. Sending an address there
        // would send every friend who presses Join to nowhere.
        let presence = Presence {
            status: Presence::IN_GAME.into(),
            client_name: Some("Everyday".into()),
            ..Presence::default()
        };
        assert_eq!(body(&presence), r#"{"status":"in_game","clientName":"Everyday"}"#);
    }

    // --- slice: play with friends ---

    fn hosting(relay: Option<&str>) -> HostPresence {
        HostPresence {
            info: crate::online::HostingInfo {
                session_id: "5e0b7c1f9a2d4c38".into(),
                game: "ja".into(),
                map: Some("mp/ffa3".into()),
                max_players: 8,
                lan_addresses: vec!["192.168.1.23:29070".into()],
                relay_address: relay.map(str::to_string),
                password: Some("k7m2q9xa".into()),
                join_policy: "friends".into(),
                join_user_ids: Some(Vec::new()),
                ..crate::online::HostingInfo::default()
            },
            local_port: 29070,
            server_name: "Tray's game".into(),
        }
    }

    fn joined(address: &str) -> Presence {
        Presence {
            status: Presence::IN_GAME.into(),
            server_address: Some(address.into()),
            server_name: Some("whatever the cache said".into()),
            client_name: Some("Everyday".into()),
            ..Presence::default()
        }
    }

    #[test]
    fn the_host_on_its_own_server_advertises_the_address_friends_use() {
        let relayed = effective(&joined("127.0.0.1:29070"), Some(&hosting(Some("203.0.113.5:29210"))));
        assert_eq!(relayed.server_address.as_deref(), Some("203.0.113.5:29210"));
        assert_eq!(relayed.server_name.as_deref(), Some("Tray's game"));
        assert_eq!(relayed.hosting.as_ref().map(|h| h.session_id.as_str()), Some("5e0b7c1f9a2d4c38"));

        // No relay: the first address of the network.
        let local = effective(&joined("127.0.0.1:29070"), Some(&hosting(None)));
        assert_eq!(local.server_address.as_deref(), Some("192.168.1.23:29070"));

        // The body the service gets carries the whole object.
        let body = serde_json::to_value(PresenceUpdate::from(&relayed)).unwrap();
        assert_eq!(body["serverAddress"], "203.0.113.5:29210");
        assert_eq!(body["hosting"]["password"], "k7m2q9xa");
        assert_eq!(body["hosting"]["relayAddress"], "203.0.113.5:29210");
    }

    #[test]
    fn a_loopback_address_is_never_published() {
        // The Connect… window on a local test server, with or without a
        // private server of its own running on another port.
        for address in ["127.0.0.1:29070", "127.0.0.1:29071", "127.77.0.5:29070", "localhost:29070", "LOCALHOST", "0.0.0.0:29070", "[::1]:29070"] {
            for host in [None, Some(hosting(Some("203.0.113.5:29210")))] {
                let presence = effective(&joined(address), host.as_ref());
                let expected = match (&host, address) {
                    (Some(_), "127.0.0.1:29070") | (Some(_), "localhost:29070") => {
                        Some("203.0.113.5:29210")
                    }
                    _ => None,
                };
                assert_eq!(presence.server_address.as_deref(), expected, "{address}");
                assert_eq!(presence.status, Presence::IN_GAME, "still in a game");
                if expected.is_none() {
                    assert_eq!(presence.server_name, None, "{address}");
                }
                let body = serde_json::to_string(&PresenceUpdate::from(&presence)).unwrap();
                assert!(!body.contains("127.") && !body.contains("localhost"), "{body}");
            }
        }
        // An ordinary server passes as it is.
        let public = effective(&joined("203.0.113.10:29070"), None);
        assert_eq!(public.server_address.as_deref(), Some("203.0.113.10:29070"));
        assert!(!is_loopback("192.168.1.23:29070"));
        assert!(!is_loopback("203.0.113.10"));
    }

    #[test]
    fn the_heartbeat_fits_three_times_into_the_timeout_of_the_service() {
        // The contract marks a player offline 90 s after the last heartbeat.
        // A tick that no longer divides that is a player who blinks out while
        // still playing.
        assert!(HEARTBEAT.as_secs() * 3 <= 90);
    }
}
