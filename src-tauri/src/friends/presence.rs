//! Telling the hub where the player is.
//!
//! ## The state machine
//!
//! The launcher owns two of the three statuses of the contract. `Offline` is
//! never sent: the hub derives it from a missing heartbeat, which is also what
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
//! ## Rules the shape follows
//!
//! - Nothing here blocks startup. The first push waits for
//!   [`FIRST_PUSH_DELAY`], which also lets a launcher that opens and closes in
//!   two seconds skip the round trip entirely.
//! - A failure is a debug line, never a dialog. The player did not ask for
//!   this request and cannot act on its failure; the next tick tries again.
//! - Signed out means silent. The task keeps running and starts reporting on
//!   its own once a token appears, so signing in does not need to reach in
//!   here.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::clients;
use crate::launch::{GameExited, GameStarted};
use crate::servers;
use crate::state::AppState;

use super::hub_client::{connect, HubApi};
use super::types::{Presence, PresenceStatus, PresenceUpdate};
use super::{FriendsState, EVENT_CHANGED};

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
        tokio::time::sleep(FIRST_PUSH_DELAY).await;
        loop {
            push(&handle).await;
            tokio::time::sleep(HEARTBEAT).await;
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
        status: PresenceStatus::Online,
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
        status: PresenceStatus::InGame,
        server_address: started.connect.clone(),
        server_name,
        client_name,
        ..Presence::default()
    }
}

/// Writes the presence into the state and sends it at once.
pub async fn set_and_push(app: &AppHandle, presence: Presence) {
    app.state::<FriendsState>().set_presence(presence);
    // The screen shows the player's own presence — the Invite button only
    // appears while in a game — so the window is told whether or not the hub
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
async fn push(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(settings) = state.settings() else {
        return;
    };
    let Some(hub) = connect(&settings) else {
        return;
    };

    let presence = app.state::<FriendsState>().presence();
    if !presence.status.is_reportable() {
        return;
    }
    let update = PresenceUpdate::from(&presence);
    match hub.put_presence(&update).await {
        Ok(_) => log::debug!("presence: {:?}", update.status),
        Err(e) => log::debug!("cannot report presence: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launcher_with_no_game_reports_itself_online_and_nothing_else() {
        let presence = online();
        assert_eq!(presence.status, PresenceStatus::Online);
        assert_eq!(presence.server_address, None);
        assert_eq!(presence.server_name, None);

        // The body of the request carries the status and drops the rest, so a
        // player who leaves a server stops advertising it.
        let body = serde_json::to_string(&PresenceUpdate::from(&presence)).expect("serializes");
        assert_eq!(body, r#"{"status":"online"}"#);
    }

    #[test]
    fn only_the_two_reportable_statuses_reach_the_hub() {
        let mut presence = online();
        assert!(presence.status.is_reportable());
        presence.status = PresenceStatus::Offline;
        assert!(!presence.status.is_reportable());
    }

    #[test]
    fn a_game_joined_from_jknet_advertises_its_server() {
        // The shape `in_game` builds, without the `AppHandle` the lookups need.
        let presence = Presence {
            status: PresenceStatus::InGame,
            server_address: Some("203.0.113.10:29070".into()),
            server_name: Some("EU FFA".into()),
            client_name: Some("Everyday".into()),
            ..Presence::default()
        };
        let body = serde_json::to_string(&PresenceUpdate::from(&presence)).expect("serializes");
        assert_eq!(
            body,
            r#"{"status":"in_game","serverAddress":"203.0.113.10:29070","serverName":"EU FFA","clientName":"Everyday"}"#
        );
    }

    #[test]
    fn a_game_started_from_the_play_button_claims_no_server() {
        // Play starts the game in its main menu. Sending an address there
        // would send every friend who presses Join to nowhere.
        let presence = Presence {
            status: PresenceStatus::InGame,
            client_name: Some("Everyday".into()),
            ..Presence::default()
        };
        let body = serde_json::to_string(&PresenceUpdate::from(&presence)).expect("serializes");
        assert_eq!(body, r#"{"status":"in_game","clientName":"Everyday"}"#);
    }

    #[test]
    fn the_heartbeat_fits_three_times_into_the_timeout_of_the_hub() {
        // The contract marks a player offline 90 s after the last heartbeat.
        // A tick that no longer divides that is a player who blinks out while
        // still playing.
        assert!(HEARTBEAT.as_secs() * 3 <= 90);
    }
}
