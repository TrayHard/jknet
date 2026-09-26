//! Chat against a service that is actually running.
//!
//! `mock_tests.rs` checks the launcher against a stand-in written from the
//! same specification as the client; this walks the real service:
//!
//! 1. two accounts sign in through the `dev` provider and become friends;
//! 2. both open the live socket with `X-JKNet-Features: chat`;
//! 3. B opens the direct conversation with A and writes; A hears
//!    `chat.message` with the `seq` B was answered;
//! 4. A reads it; B hears `chat.read` of A, because both share receipts;
//! 5. A types; B hears `chat.typing` of A;
//! 6. A hides read receipts (D8): the sync document of each side stops
//!    carrying the other's marker, and B no longer hears A read, while A's
//!    own socket still does;
//! 7. both accounts are deleted, so the service is as it was.
//!
//! A second scenario sends a file: A stages a photo with a GPS position,
//! uploads it and sends it to B; B downloads it into a cache folder, checked
//! against the hash the service answers, and gets exactly the stripped copy;
//! a stranger gets `404`.
//!
//! Ignored because they need a service on `127.0.0.1:8787` started with the
//! developer provider on (`JKNET_ONLINE_DEV_PROVIDER=1`) and the chat API.
//! Run them by hand:
//!
//! ```text
//! cargo test --lib -- --ignored --nocapture chat::online_tests
//! ```

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::friends::live::upgrade_request;
use crate::friends::online_tests::{sign_in, Player};
use crate::online::{ChatPrivacyPatch, LiveFrame, NewMessage, OnlineClient};

use super::files::{self, test_support::jpeg_with_gps, LocalStatus};
use super::{new_client_id, typing_frame};

/// How long a frame the scenario waits for may take.
const FRAME_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the scenario listens for a frame that must not come.
const QUIET: Duration = Duration::from_secs(3);

type Socket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn two_friends_write_read_and_type_in_a_direct_conversation() {
    let client = OnlineClient::new();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
        % 100_000;
    let alpha = sign_in(&client, &format!("Chat Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Chat Beta {stamp}")).await;
    println!("A is {} ({})", alpha.name, alpha.user.id);
    println!("B is {} ({})", beta.name, beta.user.id);

    let outcome = run(&client, &alpha, &beta).await;

    for player in [&alpha, &beta] {
        match client.delete_me(&player.ctx).await {
            Ok(()) => println!("DELETE /v1/me for {} -> 204", player.name),
            Err(e) => println!("DELETE /v1/me for {} failed: {e}", player.name),
        }
    }
    outcome.expect("the scenario");
}

/// A asks, B accepts.
async fn befriend(client: &OnlineClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    client
        .send_friend_request(&alpha.ctx, &beta.name)
        .await
        .map_err(|e| format!("POST /v1/friends/requests: {e}"))?;
    let waiting = client
        .get_friends(&beta.ctx)
        .await
        .map_err(|e| format!("GET /v1/friends as B: {e}"))?;
    let request = waiting
        .incoming
        .iter()
        .find(|entry| entry.from.id == alpha.user.id)
        .ok_or("B never saw the request")?;
    client
        .accept_request(&beta.ctx, &request.id)
        .await
        .map_err(|e| format!("accept as B: {e}"))?;
    Ok(())
}

async fn run(client: &OnlineClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    // -- Friends -------------------------------------------------------------
    befriend(client, alpha, beta).await?;

    // -- Sockets -------------------------------------------------------------
    let mut socket_a = open(alpha).await?;
    let mut socket_b = open(beta).await?;

    // -- B writes ------------------------------------------------------------
    let dm = client
        .chat_open_direct(&beta.ctx, &alpha.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as B: {e}"))?;
    println!("PUT /v1/chat/direct/{{A}} -> {} ({})", dm.id, dm.kind);
    let sent = client
        .chat_send(
            &beta.ctx,
            &dm.id,
            &NewMessage { client_id: new_client_id(), body: "hello there".into(), ..NewMessage::default() },
        )
        .await
        .map_err(|e| format!("POST messages as B: {e}"))?;
    println!("POST /v1/chat/conversations/{{id}}/messages -> seq {}", sent.seq);

    let heard = wait_for(&mut socket_a, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["seq"] == sent.seq
    })
    .await?
    .ok_or("A never heard the message")?;
    println!("chat.message on A's socket -> {}", heard.payload["message"]["body"]);
    if heard.payload["message"]["senderId"] != beta.user.id.as_str() {
        return Err("the message came from somebody else".into());
    }

    // -- A reads, B hears it -------------------------------------------------
    let read = client
        .chat_read(&alpha.ctx, &dm.id, sent.seq)
        .await
        .map_err(|e| format!("POST read as A: {e}"))?;
    println!("POST /v1/chat/conversations/{{id}}/read -> {read}");
    wait_for(&mut socket_b, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.read" && frame.payload["userId"] == alpha.user.id.as_str()
    })
    .await?
    .ok_or("B never heard A read")?;
    println!("chat.read of A on B's socket");

    // -- A types, B hears it -------------------------------------------------
    socket_a
        .send(Message::Text(typing_frame(&dm.id).into()))
        .await
        .map_err(|e| format!("cannot send the typing hint: {e}"))?;
    wait_for(&mut socket_b, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.typing" && frame.payload["userId"] == alpha.user.id.as_str()
    })
    .await?
    .ok_or("B never saw A typing")?;
    println!("chat.typing of A on B's socket");

    // -- A hides read receipts (D8) ------------------------------------------
    client
        .chat_update_settings(
            &alpha.ctx,
            &ChatPrivacyPatch { share_read_receipts: Some(false), ..ChatPrivacyPatch::default() },
        )
        .await
        .map_err(|e| format!("PATCH /v1/chat/settings as A: {e}"))?;
    for (viewer, other) in [(alpha, beta), (beta, alpha)] {
        let doc = client
            .chat_sync(&viewer.ctx)
            .await
            .map_err(|e| format!("GET /v1/chat/conversations as {}: {e}", viewer.name))?;
        let conversation = doc
            .conversations
            .iter()
            .find(|c| c.id == dm.id)
            .ok_or("the conversation is missing from the sync document")?;
        let marker = conversation
            .members
            .iter()
            .find(|member| member.user.id == other.user.id)
            .map(|member| member.read_seq);
        if marker != Some(None) {
            return Err(format!("{} still sees the marker of {}: {marker:?}", viewer.name, other.name));
        }
    }
    let second = client
        .chat_send(
            &beta.ctx,
            &dm.id,
            &NewMessage { client_id: new_client_id(), body: "still there?".into(), ..NewMessage::default() },
        )
        .await
        .map_err(|e| format!("POST messages as B: {e}"))?;
    client
        .chat_read(&alpha.ctx, &dm.id, second.seq)
        .await
        .map_err(|e| format!("POST read as A: {e}"))?;
    wait_for(&mut socket_a, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.read"
            && frame.payload["userId"] == alpha.user.id.as_str()
            && frame.payload["seq"] == second.seq
    })
    .await?
    .ok_or("A's own devices no longer hear A read")?;
    let leaked = wait_for(&mut socket_b, QUIET, |frame| {
        frame.kind == "chat.read" && frame.payload["userId"] == alpha.user.id.as_str()
    })
    .await?;
    if leaked.is_some() {
        return Err("B heard A read after A hid read receipts".into());
    }
    println!("with receipts hidden, only A's own socket heard A read");

    let _ = socket_a.close(None).await;
    let _ = socket_b.close(None).await;
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn a_file_goes_from_one_friend_to_the_other_without_its_gps() {
    let client = OnlineClient::new();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
        % 100_000;
    let alpha = sign_in(&client, &format!("File Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("File Beta {stamp}")).await;
    let stranger = sign_in(&client, &format!("File Gamma {stamp}")).await;
    let temp = tempfile::tempdir().expect("a temp dir");

    let outcome = send_a_file(&client, &alpha, &beta, &stranger, temp.path()).await;

    for player in [&alpha, &beta, &stranger] {
        match client.delete_me(&player.ctx).await {
            Ok(()) => println!("DELETE /v1/me for {} -> 204", player.name),
            Err(e) => println!("DELETE /v1/me for {} failed: {e}", player.name),
        }
    }
    outcome.expect("the scenario");
}

async fn send_a_file(
    client: &OnlineClient,
    alpha: &Player,
    beta: &Player,
    stranger: &Player,
    temp: &std::path::Path,
) -> Result<(), String> {
    befriend(client, alpha, beta).await?;
    let dm = client
        .chat_open_direct(&alpha.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as A: {e}"))?;

    let original = jpeg_with_gps();
    let (staged, _) = files::stage_bytes(&temp.join("staging"), "IMG_0001.JPG", original, "file", None)
        .map_err(|e| format!("staging: {e}"))?;
    let stripped = std::fs::read(&staged.path).map_err(|e| format!("the staged copy: {e}"))?;
    let file_id = files::put_staged(client, &alpha.ctx, &dm.id, &staged, |_| {})
        .await
        .map_err(|e| format!("POST /v1/chat/files and PUT its content as A: {e}"))?;
    println!("POST /v1/chat/files -> {file_id}, {} bytes", staged.size);
    let message = client
        .chat_send(
            &alpha.ctx,
            &dm.id,
            &NewMessage {
                client_id: new_client_id(),
                file_ids: vec![file_id.clone()],
                ..NewMessage::default()
            },
        )
        .await
        .map_err(|e| format!("POST messages as A: {e}"))?;
    let file = message.files.first().ok_or("the message carries no file")?;
    println!("the service classified {} as {} ({})", file.name, file.class, file.media_type);
    if file.class != "image" || file.danger {
        return Err(format!("a photo came back as {} with danger {}", file.class, file.danger));
    }

    let mut quiet = |_: u64, _: u64| {};
    let cached = files::fetch(client, &beta.ctx, &temp.join("beta"), &file_id, &mut quiet)
        .await
        .map_err(|e| format!("GET /v1/chat/files/{{id}}/content as B: {e}"))?;
    let received = std::fs::read(&cached).map_err(|e| format!("B's copy: {e}"))?;
    if received != stripped {
        return Err("B's copy differs from the staged one".into());
    }
    if received.windows(files::test_support::GPS_RATIONALS.len()).any(|w| w == files::test_support::GPS_RATIONALS) {
        return Err("the GPS position reached B".into());
    }
    println!("B downloaded {} bytes, the stripped copy, without the GPS position", received.len());

    let refused = files::fetch(client, &stranger.ctx, &temp.join("stranger"), &file_id, &mut quiet).await;
    match refused {
        Err(e) if files::status_after(&e) == LocalStatus::Gone => {
            println!("a stranger's download -> {e}");
            Ok(())
        }
        other => Err(format!("a stranger downloaded the file: {other:?}")),
    }
}

async fn open(player: &Player) -> Result<Socket, String> {
    let request = upgrade_request(&player.ctx)?;
    let (socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("GET /v1/ws as {}: {e}", player.name))?;
    println!("GET /v1/ws as {} -> {}", player.name, response.status().as_u16());
    Ok(socket)
}

/// Reads frames, answering pings, until one is `wanted` or `within` runs
/// out; `None` when it runs out.
async fn wait_for(
    socket: &mut Socket,
    within: Duration,
    wanted: impl Fn(&LiveFrame) -> bool,
) -> Result<Option<LiveFrame>, String> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        let next = match tokio::time::timeout_at(deadline, socket.next()).await {
            Err(_) => return Ok(None),
            Ok(None) => return Err("the service closed the socket".into()),
            Ok(Some(Err(e))) => return Err(format!("the socket failed: {e}")),
            Ok(Some(Ok(message))) => message,
        };
        let Message::Text(text) = next else {
            continue;
        };
        let frame: LiveFrame =
            serde_json::from_str(&text).map_err(|e| format!("unreadable frame {text}: {e}"))?;
        if frame.kind == "ping" {
            socket
                .send(Message::Text("{\"type\":\"pong\"}".into()))
                .await
                .map_err(|e| format!("cannot answer a ping: {e}"))?;
            continue;
        }
        if wanted(&frame) {
            return Ok(Some(frame));
        }
    }
}
