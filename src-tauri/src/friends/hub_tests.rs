//! The friends half of the contract, against a hub that is actually running.
//!
//! Everything else in this module is checked against `scripts/mock-hub.mjs`,
//! which is a stand-in written from the same document as the client — so the
//! two agree by construction, and agreeing with each other proves nothing
//! about the service. This walks the whole scenario against a real hub:
//!
//! 1. two accounts sign in through the `dev` provider, browser step included;
//! 2. A asks B to be friends, B accepts;
//! 3. A opens the live socket;
//! 4. B says it is in a game;
//! 5. A hears `presence.updated` on the socket, with B's server in it;
//! 6. both accounts are deleted, so the hub is as it was.
//!
//! Ignored because it needs a hub on `127.0.0.1:8787` started with the
//! developer provider on (`HUB_DEV_PROVIDER=1`, which `scripts/dev.ps1` of the
//! hub repository sets). Run it by hand:
//!
//! ```text
//! cargo test --lib -- --ignored --nocapture friends::hub_tests
//! ```

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::hub::{
    HubClient, HubContext, HubUser, LiveFrame, Presence, PresenceUpdate, PresenceUpdated,
    DEV_HUB_URL,
};

/// How long the socket is given to deliver the frame the test is waiting for.
const FRAME_TIMEOUT: Duration = Duration::from_secs(15);

/// One signed-in account: who it is and how to call as it.
struct Player {
    name: String,
    user: HubUser,
    ctx: HubContext,
}

#[tokio::test]
#[ignore = "needs the real hub on 127.0.0.1:8787 with HUB_DEV_PROVIDER=1"]
async fn two_players_become_friends_and_one_sees_the_other_start_a_game() {
    let client = HubClient::new();

    // A suffix, so a run that failed half way through does not make the next
    // one collide on a display name the hub still holds.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
        % 100_000;

    let alpha = sign_in(&client, &format!("Test Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Test Beta {stamp}")).await;
    println!("A is {} ({})", alpha.name, alpha.user.id);
    println!("B is {} ({})", beta.name, beta.user.id);

    let outcome = run(&client, &alpha, &beta).await;

    // The hub keeps accounts until they are deleted, and a test that leaves
    // two behind on every run is a test nobody runs twice.
    for player in [&alpha, &beta] {
        match client.delete_me(&player.ctx).await {
            Ok(()) => println!("DELETE /v1/me for {} -> 204", player.name),
            Err(e) => println!("DELETE /v1/me for {} failed: {e}", player.name),
        }
    }

    outcome.expect("the scenario");
}

/// The scenario itself, so a failure still runs the cleanup above.
async fn run(client: &HubClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    // -- A asks B ----------------------------------------------------------
    let sent = client
        .send_friend_request(&alpha.ctx, &beta.name)
        .await
        .map_err(|e| format!("POST /v1/friends/requests: {e}"))?;
    let request = sent
        .request
        .ok_or("the hub answered a friend request without a request")?;
    println!(
        "POST /v1/friends/requests -> {} asked {}",
        request.from.display_name, request.to.display_name
    );

    // -- B sees it and accepts ---------------------------------------------
    let waiting = client
        .get_friends(&beta.ctx)
        .await
        .map_err(|e| format!("GET /v1/friends as B: {e}"))?;
    println!(
        "GET /v1/friends as B -> {} incoming, {} friends",
        waiting.incoming.len(),
        waiting.friends.len()
    );
    let incoming = waiting
        .incoming
        .iter()
        .find(|entry| entry.from.id == alpha.user.id)
        .ok_or("B never saw the request")?;

    let friend = client
        .accept_request(&beta.ctx, &incoming.id)
        .await
        .map_err(|e| format!("POST /v1/friends/requests/{{id}}/accept: {e}"))?;
    println!(
        "POST /v1/friends/requests/{{id}}/accept -> friends with {} since {}",
        friend.user.display_name, friend.friends_since
    );

    // -- A listens ---------------------------------------------------------
    let url = alpha
        .ctx
        .ws_url()
        .ok_or("a signed-in context has a socket address")?;
    let (mut socket, response) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("GET /v1/ws as A: {e}"))?;
    println!(
        "GET /v1/ws as A -> {} {}",
        response.status().as_u16(),
        super::live::hide_token(&url)
    );

    // -- B starts a game ---------------------------------------------------
    let update = PresenceUpdate {
        status: Presence::IN_GAME.into(),
        server_address: Some("127.0.0.1:29070".into()),
        server_name: Some("^1JKNet ^7Test FFA".into()),
        client_name: Some("Everyday".into()),
    };
    let stored = client
        .put_presence(&beta.ctx, &update)
        .await
        .map_err(|e| format!("PUT /v1/presence as B: {e}"))?;
    println!(
        "PUT /v1/presence as B -> {} on {} ({:?})",
        stored.status,
        stored.server_address.as_deref().unwrap_or("-"),
        stored.server_name.as_deref().unwrap_or("-")
    );

    // -- A hears about it --------------------------------------------------
    let moved = wait_for_presence(&mut socket, &beta.user.id).await?;
    println!(
        "presence.updated on A's socket -> {} is {} on {}",
        moved.user_id,
        moved.presence.status,
        moved.presence.server_address.as_deref().unwrap_or("-")
    );
    if !moved.presence.in_game() {
        return Err(format!("expected in_game, got {}", moved.presence.status));
    }
    // The hub strips the colour codes of the engine before it stores a server
    // name, which is why the launcher never has to.
    if moved.presence.server_name.as_deref() != Some("JKNet Test FFA") {
        return Err(format!("unexpected server name {:?}", moved.presence.server_name));
    }

    // -- and the list agrees with the socket -------------------------------
    let list = client
        .get_friends(&alpha.ctx)
        .await
        .map_err(|e| format!("GET /v1/friends as A: {e}"))?;
    let seen = list
        .friends
        .iter()
        .find(|friend| friend.user.id == beta.user.id)
        .ok_or("A does not have B on the list")?;
    println!(
        "GET /v1/friends as A -> {} is {} on {}",
        seen.user.display_name,
        seen.presence.status,
        seen.presence.server_address.as_deref().unwrap_or("-")
    );
    if !seen.presence.in_game() {
        return Err("the list and the socket disagree".into());
    }

    let _ = socket.close(None).await;
    Ok(())
}

/// Reads frames until the socket says that user moved, answering pings on the
/// way as the launcher does.
async fn wait_for_presence<S>(socket: &mut S, user_id: &str) -> Result<PresenceUpdated, String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let deadline = tokio::time::Instant::now() + FRAME_TIMEOUT;
    loop {
        let next = tokio::time::timeout_at(deadline, socket.next())
            .await
            .map_err(|_| format!("no presence.updated for {user_id} within 15 s"))?;
        let message = match next {
            None => return Err("the hub closed the socket".into()),
            Some(Err(e)) => return Err(format!("the socket failed: {e}")),
            Some(Ok(message)) => message,
        };
        let Message::Text(text) = message else {
            continue;
        };

        let frame: LiveFrame =
            serde_json::from_str(&text).map_err(|e| format!("unreadable frame {text}: {e}"))?;
        println!("  frame: {}", frame.kind);
        match frame.kind.as_str() {
            "ping" => {
                socket
                    .send(Message::Text("{\"type\":\"pong\"}".into()))
                    .await
                    .map_err(|e| format!("cannot answer a ping: {e}"))?;
            }
            "presence.updated" => {
                let payload: PresenceUpdated = serde_json::from_value(frame.payload)
                    .map_err(|e| format!("unreadable presence.updated: {e}"))?;
                if payload.user_id == user_id {
                    return Ok(payload);
                }
            }
            _ => {}
        }
    }
}

/// Signs in through the `dev` provider, browser step and all.
///
/// The launcher opens `session.url` in the system browser and lets the player
/// type a name; this does the same two requests with `reqwest`, because that
/// form is the whole of the `dev` provider.
async fn sign_in(client: &HubClient, display_name: &str) -> Player {
    let anonymous = HubContext {
        base_url: DEV_HUB_URL.into(),
        token: None,
    };
    let session = client
        .create_login_session(&anonymous, "dev", Some("cargo test"))
        .await
        .expect("the hub is running with HUB_DEV_PROVIDER=1");
    println!("POST /v1/auth/login-sessions -> {} {}", session.id, session.status);

    let browser = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("a client");
    let form = browser
        .get(&session.url)
        .send()
        .await
        .expect("the dev form answers")
        .text()
        .await
        .expect("the dev form is text");
    let state = hidden_state(&form).expect("the dev form carries a state");

    // The contract puts a `code` here; the `dev` provider has no authorization
    // code to give, so the hub asks for a name instead. Same path, same method.
    let done = browser
        .get(format!(
            "{DEV_HUB_URL}/v1/auth/dev/callback?state={state}&name={}",
            encode(display_name)
        ))
        .send()
        .await
        .expect("the callback answers");
    println!("GET /v1/auth/dev/callback -> {}", done.status().as_u16());

    let polled = client
        .poll_login_session(&anonymous, &session.id)
        .await
        .expect("the session reads back");
    let token = polled.token.expect("the first read after done carries a token");
    let user = polled.user.expect("and the account it belongs to");
    println!(
        "GET /v1/auth/login-sessions/{} -> {} as {}",
        session.id, polled.status, user.display_name
    );

    // The token is handed out exactly once. The account is not: a `done`
    // session keeps answering with it, which is narrower than the deviation
    // list says and is what `poll_sign_in` reads on its second call anyway.
    // Both fields are absent rather than null while the session is pending,
    // which is the shape `LoginSession` is written for.
    let again = client
        .poll_login_session(&anonymous, &session.id)
        .await
        .expect("a second read works");
    assert!(again.token.is_none(), "the token was handed out twice");
    println!(
        "GET /v1/auth/login-sessions/{} again -> {}, token {}, user {}",
        session.id,
        again.status,
        if again.token.is_some() { "present" } else { "absent" },
        if again.user.is_some() { "present" } else { "absent" },
    );

    Player {
        name: user.display_name.clone(),
        user,
        ctx: HubContext {
            base_url: DEV_HUB_URL.into(),
            token: Some(token),
        },
    }
}

/// Pulls `value` out of `<input type="hidden" name="state" value="…">`.
fn hidden_state(form: &str) -> Option<&str> {
    let after = form.split_once("name=\"state\"")?.1;
    let value = after.split_once("value=\"")?.1;
    value.split_once('"').map(|(state, _)| state)
}

/// Percent-encodes the two characters a display name can hold that a query
/// string cannot: a space and an ampersand.
fn encode(name: &str) -> String {
    name.replace('%', "%25").replace(' ', "%20").replace('&', "%26")
}
