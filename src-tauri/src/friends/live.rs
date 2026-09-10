//! The live socket: what the hub pushes, turned into Tauri events.
//!
//! One task holds one WebSocket to `/v1/ws?token=…` and forwards every frame
//! to the window. When the socket is unreachable the same task keeps the
//! screen honest by asking it to refetch on a timer, so the Friends screen
//! behaves the same either way — slower, and without an invite arriving
//! within the second.
//!
//! ## Frames and events
//!
//! | Hub frame          | Tauri event         | What the screen does        |
//! | ------------------ | ------------------- | --------------------------- |
//! | `friend.request`   | `friends:changed`   | refetch `get_friends_state` |
//! | `friend.accepted`  | `friends:changed`   | refetch                     |
//! | `friend.removed`   | `friends:changed`   | refetch                     |
//! | `me.updated`       | `friends:changed`   | refetch                     |
//! | `presence.updated` | `friends:presence`  | patch one row               |
//! | `invite`           | `friends:invite`    | toast, and refetch          |
//! | `ping`             | —                   | answered with `pong`        |
//!
//! A `friend.*` frame carries the whole entity, and forwarding it would mean
//! merging three lists in the window. Refetching one small document instead
//! keeps a single writer for that state and costs one request on an event that
//! happens a handful of times a day. `presence.updated` is the opposite case:
//! it arrives for every friend who moves between servers, so it patches a
//! single row.
//!
//! ## Reconnecting
//!
//! Backoff doubles from [`MIN_BACKOFF`] to [`MAX_BACKOFF`] and resets after a
//! socket that stayed up. The ceiling is also the fallback period: while the
//! socket is down the loop asks the window to refetch on every attempt, so a
//! hub that is off gives the screen a 30 s refresh instead of nothing.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::tungstenite::Message;

use crate::state::AppState;

use super::hub_client::{connect, HubApi};
use super::types::{Invite, LiveFrame, PresenceUpdated};
use super::{FriendsState, EVENT_CHANGED, EVENT_INVITE, EVENT_PRESENCE};

/// First wait after a socket drops.
const MIN_BACKOFF: Duration = Duration::from_secs(1);

/// Longest wait between attempts, and the period of the fallback refresh.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// How long a silent socket is given before it counts as dead.
///
/// The hub pings on its own schedule and closes a client that misses three
/// pongs. Three ping periods of silence in the other direction means the same
/// thing has happened to us — usually a laptop that slept — and a fresh
/// connection is faster than waiting for a TCP timeout.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(90);

/// How long the loop waits before looking for a token again.
const SIGNED_OUT_POLL: Duration = Duration::from_secs(5);

/// Starts the live task. Called once from `setup`; runs for the process.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut backoff = MIN_BACKOFF;
        loop {
            let Some(url) = socket_url(&handle) else {
                // Signed out. Nothing to listen to and nothing to refresh.
                set_connected(&handle, false);
                tokio::time::sleep(SIGNED_OUT_POLL).await;
                continue;
            };

            match pump(&handle, &url).await {
                Ok(true) => {
                    // The socket carried at least one frame, so the address
                    // and the token are good and the next drop is not the
                    // start of an outage.
                    backoff = MIN_BACKOFF;
                }
                Ok(false) => backoff = next_backoff(backoff),
                Err(e) => {
                    log::debug!("live socket: {e}");
                    backoff = next_backoff(backoff);
                }
            }
            set_connected(&handle, false);

            // The fallback. While the socket is down the window is asked to
            // refetch on every attempt, which at the ceiling is once every
            // 30 s — the period the contract asks for.
            emit(&handle, EVENT_CHANGED, ());
            tokio::time::sleep(backoff).await;
        }
    });
}

/// Doubles the wait up to the ceiling.
fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(MAX_BACKOFF)
}

/// The socket address for the token in the settings right now, or `None` when
/// nobody is signed in.
fn socket_url(app: &AppHandle) -> Option<String> {
    let settings = app.state::<AppState>().settings().ok()?;
    connect(&settings).map(|hub| hub.ws_url())
}

/// Holds one connection open and forwards its frames.
///
/// Answers `true` when the socket delivered at least one frame, which is what
/// separates "the hub dropped us" from "the address never worked".
async fn pump(app: &AppHandle, url: &str) -> Result<bool, String> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| format!("cannot open {}: {e}", hide_token(url)))?;
    log::info!("live socket open");
    set_connected(app, true);
    // A fresh socket may have missed anything, so the screen refetches once.
    emit(app, EVENT_CHANGED, ());

    let mut delivered = false;
    loop {
        let next = tokio::time::timeout(SILENCE_TIMEOUT, socket.next()).await;
        let message = match next {
            Err(_) => return Err("no frame for 90 s, reconnecting".into()),
            Ok(None) => return Ok(delivered),
            Ok(Some(Err(e))) => return Err(format!("live socket failed: {e}")),
            Ok(Some(Ok(message))) => message,
        };

        match message {
            Message::Text(text) => {
                delivered = true;
                if handle_frame(app, &text) {
                    // A ping is answered on the same socket. A failure here
                    // means the socket is gone, which the next read would
                    // report anyway; saying so now saves 90 s of silence.
                    socket
                        .send(Message::Text("{\"type\":\"pong\"}".into()))
                        .await
                        .map_err(|e| format!("cannot answer a ping: {e}"))?;
                }
            }
            Message::Ping(payload) => {
                // A protocol-level ping, not the `ping` frame of the contract.
                // `tungstenite` would answer it on the next read; answering
                // here keeps both kinds in one place.
                socket
                    .send(Message::Pong(payload))
                    .await
                    .map_err(|e| format!("cannot answer a protocol ping: {e}"))?;
            }
            Message::Close(frame) => {
                log::debug!("the hub closed the live socket: {frame:?}");
                return Ok(delivered);
            }
            _ => {}
        }
    }
}

/// Reads one frame and emits what it means. Answers `true` for a `ping`.
fn handle_frame(app: &AppHandle, text: &str) -> bool {
    let frame = match serde_json::from_str::<LiveFrame>(text) {
        Ok(frame) => frame,
        Err(e) => {
            log::debug!("unreadable live frame: {e}");
            return false;
        }
    };

    match frame.kind.as_str() {
        "ping" => return true,
        "presence.updated" => match serde_json::from_value::<PresenceUpdated>(frame.payload) {
            Ok(payload) => emit(app, EVENT_PRESENCE, payload),
            Err(e) => log::debug!("unreadable presence.updated: {e}"),
        },
        "invite" => {
            #[derive(serde::Deserialize)]
            struct Wrapper {
                invite: Invite,
            }
            match serde_json::from_value::<Wrapper>(frame.payload) {
                Ok(payload) => {
                    emit(app, EVENT_INVITE, payload.invite);
                    // The invite list of `get_friends_state` has to catch up
                    // as well, or a dismissed toast would come back on the
                    // next refetch.
                    emit(app, EVENT_CHANGED, ());
                }
                Err(e) => log::debug!("unreadable invite: {e}"),
            }
        }
        // Everything else in the contract changes one of the three lists the
        // screen keeps, and the screen reads them from one command.
        "friend.request" | "friend.accepted" | "friend.removed" | "me.updated" => {
            emit(app, EVENT_CHANGED, ());
        }
        other => log::debug!("live frame {other} ignored"),
    }
    false
}

/// Records whether the socket is up, for the badge on the Friends screen.
fn set_connected(app: &AppHandle, connected: bool) {
    app.state::<FriendsState>().set_live(connected);
}

/// Emits and swallows the failure: the only way `emit` fails is a window that
/// has already closed, and a socket that outlives its window has nobody to
/// tell.
fn emit<T: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    if let Err(e) = app.emit(event, payload) {
        log::debug!("cannot emit {event}: {e}");
    }
}

/// Cuts the token out of an address before it reaches a log file.
///
/// The token is the whole credential and a log file is the first thing a
/// player attaches to a bug report.
pub fn hide_token(url: &str) -> String {
    match url.split_once("token=") {
        Some((head, _)) => format!("{head}token=…"),
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backoff_doubles_and_stops_at_the_ceiling() {
        let mut wait = MIN_BACKOFF;
        let mut seen = vec![wait];
        for _ in 0..8 {
            wait = next_backoff(wait);
            seen.push(wait);
        }
        assert_eq!(
            seen.iter().map(Duration::as_secs).collect::<Vec<_>>(),
            vec![1, 2, 4, 8, 16, 30, 30, 30, 30]
        );
    }

    #[test]
    fn the_ceiling_is_the_fallback_period_the_contract_asks_for() {
        assert_eq!(MAX_BACKOFF, Duration::from_secs(30));
    }

    #[test]
    fn a_log_line_never_carries_the_token() {
        assert_eq!(
            hide_token("ws://127.0.0.1:8787/v1/ws?token=deadbeef"),
            "ws://127.0.0.1:8787/v1/ws?token=…"
        );
        assert_eq!(hide_token("ws://host/v1/ws"), "ws://host/v1/ws");
    }
}

// ---------------------------------------------------------------------------
// Against the mock hub
// ---------------------------------------------------------------------------

/// Talks to `scripts/mock-hub.mjs`, which has to be running:
///
/// ```text
/// node scripts/mock-hub.mjs
/// cargo test --lib -- --ignored --nocapture answers_the_ping_of_the_mock_hub
/// ```
///
/// Ignored because it needs that process. It is the only check that the frame
/// shapes of the contract survive a real socket rather than a `serde_json`
/// round trip.
#[cfg(test)]
mod live_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "needs `node scripts/mock-hub.mjs` on 127.0.0.1:8787"]
    async fn answers_the_ping_of_the_mock_hub() {
        let url = super::super::hub_client::ws_url("http://127.0.0.1:8787", &"a".repeat(64));
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("the mock hub is running");

        // The mock pings on connect, then sends an invite. Read until the
        // first `ping`, answer it, and make sure the socket survives.
        let mut answered = false;
        for _ in 0..4 {
            let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("the mock answers within 5 s")
                .expect("the socket is open")
                .expect("the frame is readable");
            let Message::Text(text) = message else {
                continue;
            };
            let frame: LiveFrame = serde_json::from_str(&text).expect("a frame of the contract");
            if frame.kind == "ping" {
                socket
                    .send(Message::Text("{\"type\":\"pong\"}".into()))
                    .await
                    .expect("the pong goes out");
                answered = true;
                break;
            }
        }
        assert!(answered, "the mock hub never pinged");

        // Still alive after the pong: the mock closes a client that misses it.
        let after = tokio::time::timeout(Duration::from_secs(25), socket.next()).await;
        assert!(
            matches!(after, Ok(Some(Ok(_))) | Err(_)),
            "the socket was closed after a correct pong"
        );
    }
}
