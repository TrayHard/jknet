//! The friends half of the contract, against a service that is actually running.
//!
//! Everything else in this module is checked against `scripts/mock-online.mjs`,
//! which is a stand-in written from the same document as the client — so the
//! two agree by construction, and agreeing with each other proves nothing
//! about the service. This walks the whole scenario against the real service:
//!
//! 1. two accounts sign in through the `dev` provider, browser step included;
//! 2. A asks B to be friends, B accepts;
//! 3. A opens the live socket;
//! 4. B says it is in a game;
//! 5. A hears `presence.updated` on the socket, with B's server in it;
//! 6. both accounts are deleted, so the service is as it was.
//!
//! Ignored because it needs a service on `127.0.0.1:8787` started with the
//! developer provider on (`JKNET_ONLINE_DEV_PROVIDER=1`, which `scripts/dev.ps1` of the
//! service repository sets). Run it by hand:
//!
//! ```text
//! cargo test --lib -- --ignored --nocapture friends::online_tests
//! ```

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::account::LoopbackSignIn;
use crate::online::loopback::Served;
use crate::online::{
    LiveFrame, OnlineClient, OnlineContext, OnlineUser, Presence, PresenceUpdate, PresenceUpdated,
    DEV_ONLINE_URL,
};

/// How long the socket is given to deliver the frame the test is waiting for.
const FRAME_TIMEOUT: Duration = Duration::from_secs(15);

/// One signed-in account: who it is and how to call as it.
pub(crate) struct Player {
    pub(crate) name: String,
    pub(crate) user: OnlineUser,
    pub(crate) ctx: OnlineContext,
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1"]
async fn two_players_become_friends_and_one_sees_the_other_start_a_game() {
    let client = OnlineClient::new();

    // A suffix, so a run that failed half way through does not make the next
    // one collide on a display name the service still holds.
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

    // The service keeps accounts until they are deleted, and a test that leaves
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
async fn run(client: &OnlineClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    // -- A asks B ----------------------------------------------------------
    let sent = client
        .send_friend_request(&alpha.ctx, &beta.name)
        .await
        .map_err(|e| format!("POST /v1/friends/requests: {e}"))?;
    let request = sent
        .request
        .ok_or("the service answered a friend request without a request")?;
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
    // The token goes in the `Authorization` header, as the launcher sends it,
    // so the address printed here carries none.
    let request = super::live::upgrade_request(&alpha.ctx)?;
    let url = request.uri().to_string();
    let (mut socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("GET /v1/ws as A: {e}"))?;
    println!("GET /v1/ws as A -> {} {url}", response.status().as_u16());

    // -- B starts a game ---------------------------------------------------
    let update = PresenceUpdate {
        status: Presence::IN_GAME.into(),
        server_address: Some("127.0.0.1:29070".into()),
        server_name: Some("^1JKNet ^7Test FFA".into()),
        client_name: Some("Everyday".into()),
        hosting: None,
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
    // The service strips the colour codes of the engine before it stores a server
    // name, which is why the launcher never has to.
    if moved.presence.server_name.as_deref() != Some("JKNet Test FFA") {
        return Err(format!(
            "unexpected server name {:?}",
            moved.presence.server_name
        ));
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
            None => return Err("the service closed the socket".into()),
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

/// How long a sign-in waits before it tries again after the service said it
/// signed in too many players from this address (30 requests a minute, three
/// per sign-in), and how many times it tries.
const SIGN_IN_RETRY: Duration = Duration::from_secs(10);
const SIGN_IN_ATTEMPTS: u32 = 9;

/// Signs in through the `dev` provider, browser step and all.
///
/// --- slice: sign-in binding ---
/// The way the launcher does it: `crate::account::LoopbackSignIn` listens on
/// loopback and opens the session, and the browser's part is done with
/// `reqwest`, because that form is the whole of the `dev` provider. The
/// callback's redirect takes the one-time code to the listener, which trades
/// it for the token. Every online test that signs players in walks the
/// launcher's own sign-in this way.
///
/// The service lets ten sign-ins a minute through from one address, and the
/// chat scenarios sign in more players than that, so a sign-in the service
/// refused as too many is tried again a little later.
pub(crate) async fn sign_in(client: &OnlineClient, display_name: &str) -> Player {
    let anonymous = OnlineContext {
        base_url: DEV_ONLINE_URL.into(),
        token: None,
    };
    // Longer than a request of the launcher: the last page is the listener's,
    // written after the exchange, which waits out a refusal as too many.
    let browser = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .expect("a client");
    for attempt in 1..=SIGN_IN_ATTEMPTS {
        if let Some(player) = try_sign_in(client, &browser, &anonymous, display_name).await {
            return player;
        }
        println!("sign-in of {display_name} refused as too many, attempt {attempt}; waiting");
        tokio::time::sleep(SIGN_IN_RETRY).await;
    }
    panic!("the service kept refusing the sign-in of {display_name} as too many");
}

/// How long the listener of a test sign-in waits for the browser.
const LISTEN_FOR: Duration = Duration::from_secs(120);

/// One sign-in; `None` when the service refused a step as too many.
async fn try_sign_in(
    client: &OnlineClient,
    browser: &reqwest::Client,
    anonymous: &OnlineContext,
    display_name: &str,
) -> Option<Player> {
    let signin = match LoopbackSignIn::open(client, anonymous, "dev", Some("cargo test")).await {
        Err(crate::error::AppError::Online { code, .. }) if code == "rate_limited" => return None,
        other => other.expect("the service is running with JKNET_ONLINE_DEV_PROVIDER=1"),
    };
    let session = signin.session().clone();
    println!(
        "POST /v1/auth/login-sessions -> {} {}",
        session.id, session.status
    );

    // The listener and the browser run side by side; a browser leg that ends
    // early stops the listener through `stop`.
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut stop = Some(stop);
    let listening = signin.wait(
        client,
        anonymous,
        LISTEN_FOR,
        async move {
            let _ = stopped.await;
        },
        |token, user| async move { Ok((token, user)) },
    );
    let browsing = async {
        let landed = browse(browser, &session, display_name).await;
        if !matches!(landed, Some(true)) {
            drop(stop.take());
        }
        landed
    };
    let (served, landed) = tokio::join!(listening, browsing);
    if !landed? {
        panic!("the browser did not end on the launcher's sign-in page");
    }
    let (token, user) = match served {
        Served::Finished(Ok(pair)) => pair,
        Served::Finished(Err(e)) => panic!("the code exchange failed: {e}"),
        Served::Cancelled => panic!("the listener was stopped"),
        Served::TimedOut => panic!("the code never reached the listener"),
    };
    println!(
        "POST /v1/auth/login-sessions/{}/token -> signed in as {}",
        session.id, user.display_name
    );

    // Whoever polls the session learns it is done, and never gets the token.
    let polled = client
        .poll_login_session(anonymous, &session.id)
        .await
        .expect("the session reads back");
    assert_eq!(polled.status, "done");
    assert!(polled.token.is_none(), "the poll handed out the token");
    println!(
        "GET /v1/auth/login-sessions/{} -> {}, token absent, user {}",
        session.id,
        polled.status,
        if polled.user.is_some() {
            "present"
        } else {
            "absent"
        },
    );

    Some(Player {
        name: user.display_name.clone(),
        user,
        ctx: OnlineContext {
            base_url: DEV_ONLINE_URL.into(),
            token: Some(token),
        },
    })
}

/// The browser's part: the form, then the callback, whose redirect the
/// client follows to the listener. `Some(true)` when it ended on the
/// listener's "Signed in" page, `None` when the service refused a step as
/// too many.
async fn browse(
    browser: &reqwest::Client,
    session: &crate::online::LoginSession,
    display_name: &str,
) -> Option<bool> {
    let form = browser
        .get(&session.url)
        .send()
        .await
        .expect("the dev form answers");
    if form.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let form = form.text().await.expect("the dev form is text");
    let state = hidden_state(&form).expect("the dev form carries a state");

    // The contract puts a `code` here; the `dev` provider has no authorization
    // code to give, so the service asks for a name instead. Same path, same method.
    let done = browser
        .get(format!(
            "{DEV_ONLINE_URL}/v1/auth/dev/callback?state={state}&name={}",
            encode(display_name)
        ))
        .send()
        .await
        .expect("the callback answers");
    // Where the redirect landed, without the code.
    let landed = format!(
        "{}:{}{}",
        done.url().host_str().unwrap_or_default(),
        done.url().port().unwrap_or_default(),
        done.url().path()
    );
    println!(
        "GET /v1/auth/dev/callback -> {} at {landed}",
        done.status().as_u16()
    );
    if done.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let on_loopback = done.url().host_str() == Some("127.0.0.1")
        && done.url().path() == crate::online::loopback::SIGN_IN_PATH;
    let page = done.text().await.unwrap_or_default();
    Some(on_loopback && page.contains("You can close this tab and return to JKNet"))
}

/// Pulls `value` out of `<input type="hidden" name="state" value="…">`.
pub(crate) fn hidden_state(form: &str) -> Option<&str> {
    let after = form.split_once("name=\"state\"")?.1;
    let value = after.split_once("value=\"")?.1;
    value.split_once('"').map(|(state, _)| state)
}

/// Percent-encodes the two characters a display name can hold that a query
/// string cannot: a space and an ampersand.
fn encode(name: &str) -> String {
    name.replace('%', "%25")
        .replace(' ', "%20")
        .replace('&', "%26")
}
