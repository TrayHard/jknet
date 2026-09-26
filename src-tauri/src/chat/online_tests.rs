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
//! A third walks the chat of a private server: A hosts one and opens its
//! chat once a heartbeat carried it; B, a friend, joins it only when the
//! server is open to B, and sees it from the join until A turns history on
//! (D1); a stranger is refused; the switch is A's; B leaves and joins again
//! (D9); the stop ends the chat for B, and a heartbeat without the server
//! ends the chat of the next one.
//!
//! The rest walk the user's decisions one flow each: a direct conversation
//! with a reply, a mention, reactions, read marks and typing, both privacy
//! switches reciprocal (D8); a group that asks before it adds, renamed and
//! switched by its owner only, a removal and the handover when the owner
//! leaves (D1, D4, D5); a file of exactly 25 MiB and one byte more; search;
//! unfriending, which leaves the direct conversation read-only (D2); a
//! deleted account, whose messages stay as "Deleted account" (D3); a host
//! invite card, the guest it lets in and the end of the chat with the
//! hosting (D9); every card kind the launcher builds; and the
//! `X-JKNet-Features` opt-in.
//!
//! Every chat frame the scenarios read is parsed the way the core parses it,
//! and a frame or an answer that loses a field on its way through the
//! core's types fails the scenario: the windows get the core's copy.
//!
//! Ignored because they need a service on `127.0.0.1:8787` started with the
//! developer provider on (`JKNET_ONLINE_DEV_PROVIDER=1`) and the chat API.
//! The service lets ten sign-ins a minute through from one address, so the
//! scenarios wait for room when they need it. Run them by hand, one at a
//! time:
//!
//! ```text
//! cargo test --lib -- --ignored --nocapture --test-threads=1 chat::online_tests
//! ```

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use crate::error::AppError;
use crate::friends::live::upgrade_request;
use crate::friends::online_tests::{sign_in, Player};
use crate::online::{
    Auth, ChatPrivacyPatch, ChatSyncDoc, Conversation, HostingInfo, LiveFrame, MessagePage,
    NewMessage, OnlineClient, PageAnchor, PresenceUpdate, SearchQuery,
};

use super::files::{self, test_support::jpeg_with_gps, LocalStatus};
use super::frames::{self, Frame};
use super::server;
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

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn a_friend_joins_the_chat_of_a_private_server_until_it_stops() {
    let client = OnlineClient::new();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
        % 100_000;
    let alpha = sign_in(&client, &format!("Host Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Host Beta {stamp}")).await;
    let stranger = sign_in(&client, &format!("Host Gamma {stamp}")).await;

    let outcome = host_a_server(&client, &alpha, &beta, &stranger).await;

    for player in [&alpha, &beta, &stranger] {
        match client.delete_me(&player.ctx).await {
            Ok(()) => println!("DELETE /v1/me for {} -> 204", player.name),
            Err(e) => println!("DELETE /v1/me for {} failed: {e}", player.name),
        }
    }
    outcome.expect("the scenario");
}

/// The code of a refusal, or what came instead of one.
fn code_of<T: std::fmt::Debug>(result: crate::error::Result<T>) -> String {
    match result {
        Err(AppError::Online { code, .. }) => code,
        other => format!("{other:?}"),
    }
}

/// The hosting a launcher reports for a server open to `policy`.
fn hosting_of(session: &str, policy: &str) -> HostingInfo {
    HostingInfo {
        session_id: session.into(),
        game: "ja".into(),
        map: Some("mp/ffa3".into()),
        max_players: 8,
        lan_addresses: vec!["192.168.1.23:29070".into()],
        password: Some("k7m2q9xa".into()),
        join_policy: policy.into(),
        join_user_ids: Some(Vec::new()),
        ..HostingInfo::default()
    }
}

async fn heartbeat(
    client: &OnlineClient,
    player: &Player,
    hosting: Option<HostingInfo>,
) -> Result<(), String> {
    let update = PresenceUpdate {
        status: "online".into(),
        hosting,
        ..PresenceUpdate::default()
    };
    client
        .put_presence(&player.ctx, &update)
        .await
        .map(|_| ())
        .map_err(|e| format!("PUT /v1/presence as {}: {e}", player.name))
}

async fn host_a_server(
    client: &OnlineClient,
    alpha: &Player,
    beta: &Player,
    stranger: &Player,
) -> Result<(), String> {
    befriend(client, alpha, beta).await?;
    let mut socket_a = open(alpha).await?;
    let mut socket_b = open(beta).await?;
    let session = crate::hosting::server::new_session_id();
    let quick = [Duration::from_millis(200); 3];
    let join_as = |player: &Player| {
        let ctx = player.ctx.clone();
        let (session, host) = (session.clone(), alpha.user.id.clone());
        server::retry_join(&quick, move || {
            let (ctx, session, host) = (ctx.clone(), session.clone(), host.clone());
            async move { client.chat_join_server(&ctx, &session, &host).await }
        })
    };

    // -- A: the chat opens once a heartbeat carried the server ---------------
    let early = code_of(client.chat_open_server(&alpha.ctx, &session).await);
    if early != "not_hosting" {
        return Err(format!("an open before any heartbeat answered {early}"));
    }
    heartbeat(client, alpha, Some(hosting_of(&session, "invite"))).await?;
    let chat = client
        .chat_open_server(&alpha.ctx, &session)
        .await
        .map_err(|e| format!("PUT /v1/chat/servers as A: {e}"))?;
    println!("PUT /v1/chat/servers/{{session}} -> {} ({})", chat.id, chat.kind);
    let host = chat.server.as_ref().map(|server| server.host_id.as_str());
    if chat.kind != "server" || host != Some(alpha.user.id.as_str()) || chat.history_for_new_members {
        return Err(format!("the chat of the server came back as {chat:?}"));
    }
    let again = client
        .chat_open_server(&alpha.ctx, &session)
        .await
        .map_err(|e| format!("PUT /v1/chat/servers again as A: {e}"))?;
    if again.id != chat.id {
        return Err("a second open made a second chat".into());
    }
    client
        .chat_send(
            &alpha.ctx,
            &chat.id,
            &NewMessage { client_id: new_client_id(), body: "warming up".into(), ..NewMessage::default() },
        )
        .await
        .map_err(|e| format!("POST messages as A: {e}"))?;

    // -- B: refused while the server is invite-only, then in -----------------
    let refused = code_of(join_as(beta).await);
    if refused != "forbidden" {
        return Err(format!("B joined an invite-only server's chat without an invite: {refused}"));
    }
    println!("POST /v1/chat/servers/{{session}}/join as B, invite only -> {refused}");
    heartbeat(client, alpha, Some(hosting_of(&session, "friends"))).await?;
    let joined = join_as(beta)
        .await
        .map_err(|e| format!("POST /v1/chat/servers/{{session}}/join as B: {e}"))?;
    if joined.id != chat.id || joined.visible_from_seq + 1 != joined.last_seq {
        return Err(format!(
            "B joined {} and sees from {} of {}",
            joined.id, joined.visible_from_seq, joined.last_seq
        ));
    }
    let page = client
        .chat_messages(&beta.ctx, &chat.id, PageAnchor::Latest, None)
        .await
        .map_err(|e| format!("GET messages as B: {e}"))?;
    let events: Vec<String> = page
        .messages
        .iter()
        .map(|message| match message.system.as_ref() {
            Some(system) => system.event.clone(),
            None => message.body.clone(),
        })
        .collect();
    if events != ["memberJoined"] {
        return Err(format!("B sees history from before the join: {events:?}"));
    }
    println!("B sees {events:?}");
    wait_for(&mut socket_a, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["system"]["event"] == "memberJoined"
    })
    .await?
    .ok_or("A never heard B join")?;

    // -- A stranger is refused -----------------------------------------------
    let stranger_join = code_of(
        client
            .chat_join_server(&stranger.ctx, &session, &alpha.user.id)
            .await,
    );
    if stranger_join != "forbidden" {
        return Err(format!("a stranger's join answered {stranger_join}"));
    }

    // -- The history switch is A's (D1) --------------------------------------
    let by_guest = code_of(client.chat_patch_server(&beta.ctx, &session, true).await);
    let by_stranger = code_of(client.chat_patch_server(&stranger.ctx, &session, true).await);
    if (by_guest.as_str(), by_stranger.as_str()) != ("owner_only", "not_found") {
        return Err(format!("the switch by a guest: {by_guest}, by a stranger: {by_stranger}"));
    }
    let on = client
        .chat_patch_server(&alpha.ctx, &session, true)
        .await
        .map_err(|e| format!("PATCH /v1/chat/servers as A: {e}"))?;
    if !on.history_for_new_members {
        return Err("the switch did not stay on".into());
    }
    let kept = client
        .chat_conversation(&beta.ctx, &chat.id)
        .await
        .map_err(|e| format!("GET the chat as B: {e}"))?;
    if kept.visible_from_seq != joined.visible_from_seq {
        return Err("B's view moved with the switch".into());
    }

    // -- B leaves and joins again (D9), now with the history -----------------
    client
        .chat_remove_member(&beta.ctx, &chat.id, &beta.user.id)
        .await
        .map_err(|e| format!("DELETE members/{{B}} as B: {e}"))?;
    let gone = code_of(client.chat_conversation(&beta.ctx, &chat.id).await);
    if gone != "not_found" {
        return Err(format!("B still reads the chat after leaving: {gone}"));
    }
    let left = wait_for(&mut socket_b, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == chat.id.as_str()
    })
    .await?
    .ok_or("B's devices never heard B leave")?;
    if left.payload["reason"] != "left" {
        return Err(format!("B's leave reached B as {}", left.payload["reason"]));
    }
    let rejoined = join_as(beta)
        .await
        .map_err(|e| format!("the second join as B: {e}"))?;
    if rejoined.visible_from_seq != 0 {
        return Err(format!("B joined again and sees from {}", rejoined.visible_from_seq));
    }

    // -- The stop ends it for B ----------------------------------------------
    server::close_on_service(client, &alpha.ctx, &session).await;
    let ended = wait_for(&mut socket_b, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == chat.id.as_str()
    })
    .await?
    .ok_or("B never heard the chat end")?;
    println!("chat.conversation.removed on B's socket -> {}", ended.payload["reason"]);
    if ended.payload["reason"] != "ended" {
        return Err(format!("the stop ended the chat with {}", ended.payload["reason"]));
    }
    let after = code_of(client.chat_conversation(&beta.ctx, &chat.id).await);
    if after != "not_found" {
        return Err(format!("the chat outlived its server: {after}"));
    }
    client
        .chat_close_server(&alpha.ctx, &session)
        .await
        .map_err(|e| format!("a second DELETE /v1/chat/servers: {e}"))?;

    // -- The next server: a heartbeat without it ends its chat ---------------
    let next = crate::hosting::server::new_session_id();
    heartbeat(client, alpha, Some(hosting_of(&next, "friends"))).await?;
    let second = client
        .chat_open_server(&alpha.ctx, &next)
        .await
        .map_err(|e| format!("PUT /v1/chat/servers for the next server: {e}"))?;
    heartbeat(client, alpha, None).await?;
    wait_for(&mut socket_a, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.conversation.removed"
            && frame.payload["conversationId"] == second.id.as_str()
            && frame.payload["reason"] == "ended"
    })
    .await?
    .ok_or("a heartbeat without the server left its chat open")?;
    println!("a heartbeat without the server ended its chat");

    let _ = socket_a.close(None).await;
    let _ = socket_b.close(None).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// The flows of the user's decisions, one scenario each
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn a_direct_conversation_carries_replies_mentions_reactions_and_reciprocal_privacy() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let alpha = sign_in(&client, &format!("Dm Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Dm Beta {stamp}")).await;
    let outcome = direct_flow(&client, &alpha, &beta).await;
    delete_all(&client, &[&alpha, &beta]).await;
    outcome.expect("the scenario");
}

async fn direct_flow(client: &OnlineClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    befriend(client, alpha, beta).await?;
    let mut socket_a = open(alpha).await?;
    let mut socket_b = open(beta).await?;

    // -- Opening: made once, the same conversation for both ------------------
    let dm = client
        .chat_open_direct(&alpha.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as A: {e}"))?;
    let same = client
        .chat_open_direct(&beta.ctx, &alpha.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as B: {e}"))?;
    if same.id != dm.id || dm.kind != "direct" || !dm.can_send || dm.history_for_new_members {
        return Err(format!("the direct conversation came back as {dm:?} and {same:?}"));
    }
    lossless::<Conversation>(
        "GET /v1/chat/conversations/{id}",
        &raw(client, alpha, &format!("/v1/chat/conversations/{}", dm.id)).await?,
    )?;

    // -- A mention: B names A ------------------------------------------------
    let hello = send(client, beta, &dm.id, &format!("ready for a duel, <@{}>?", alpha.user.id)).await?;
    if hello.mentions != [alpha.user.id.clone()] {
        return Err(format!("the mention of A came back as {:?}", hello.mentions));
    }
    expect_frame(&mut socket_a, "A hears the mention", |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["seq"] == hello.seq
    })
    .await?;
    let doc: ChatSyncDoc = lossless("A's sync document", &raw(client, alpha, "/v1/chat/conversations").await?)?;
    let summary = find(&doc.conversations, &dm.id)?;
    if (summary.unread, summary.unread_mentions) != (1, 1) {
        return Err(format!(
            "A counts {} unread and {} mentions",
            summary.unread, summary.unread_mentions
        ));
    }

    // -- A reply: it quotes B and counts as a mention of B -------------------
    let reply = client
        .chat_send(
            &alpha.ctx,
            &dm.id,
            &NewMessage {
                client_id: new_client_id(),
                body: "always".into(),
                reply_seq: Some(hello.seq),
                ..NewMessage::default()
            },
        )
        .await
        .map_err(|e| format!("the reply of A: {e}"))?;
    let quoted = reply.reply_to.as_ref().ok_or("the reply quotes nothing")?;
    if quoted.seq != hello.seq
        || quoted.missing
        || quoted.sender_id.as_deref() != Some(beta.user.id.as_str())
        || !quoted.excerpt.starts_with("ready for a duel")
    {
        return Err(format!("the reply quotes {quoted:?}"));
    }
    if !reply.mentions.contains(&beta.user.id) {
        return Err(format!("a reply to B does not mention B: {:?}", reply.mentions));
    }
    expect_frame(&mut socket_b, "B hears the reply", |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["seq"] == reply.seq
    })
    .await?;

    // -- A replay of the same clientId is the stored message ------------------
    let again = client
        .chat_send(
            &beta.ctx,
            &dm.id,
            &NewMessage {
                client_id: hello.client_id.clone().unwrap_or_default(),
                body: "a second copy".into(),
                ..NewMessage::default()
            },
        )
        .await
        .map_err(|e| format!("the replay of B: {e}"))?;
    if again.seq != hello.seq || again.body != hello.body {
        return Err(format!("a replay answered seq {} ({:?})", again.seq, again.body));
    }

    // -- Reactions -------------------------------------------------------------
    let reactions = client
        .chat_react(&beta.ctx, &dm.id, reply.seq, "👍", true)
        .await
        .map_err(|e| format!("the reaction of B: {e}"))?;
    if reactions.len() != 1 || reactions[0].emoji != "👍" || reactions[0].user_ids != [beta.user.id.clone()] {
        return Err(format!("the reactions after B's came back as {reactions:?}"));
    }
    expect_frame(&mut socket_a, "A hears the reaction", |frame| {
        frame.kind == "chat.reaction" && frame.payload["seq"] == reply.seq && frame.payload["on"] == true
    })
    .await?;
    client
        .chat_react(&beta.ctx, &dm.id, reply.seq, "👍", true)
        .await
        .map_err(|e| format!("the same reaction twice: {e}"))?;
    let not_emoji = code_of(client.chat_react(&beta.ctx, &dm.id, reply.seq, "no", true).await);
    if not_emoji != "emoji" {
        return Err(format!("a reaction that is not an emoji answered {not_emoji}"));
    }
    let off = client
        .chat_react(&beta.ctx, &dm.id, reply.seq, "👍", false)
        .await
        .map_err(|e| format!("taking the reaction off: {e}"))?;
    if !off.is_empty() {
        return Err(format!("the reaction stayed: {off:?}"));
    }

    // -- History pages ---------------------------------------------------------
    let page: MessagePage = lossless(
        "a page of history",
        &raw(client, beta, &format!("/v1/chat/conversations/{}/messages", dm.id)).await?,
    )?;
    if page.messages.iter().map(|m| m.seq).collect::<Vec<_>>() != [hello.seq, reply.seq] {
        return Err(format!("the history holds {:?}", page.messages.iter().map(|m| m.seq).collect::<Vec<_>>()));
    }
    let before = client
        .chat_messages(&beta.ctx, &dm.id, PageAnchor::Before(reply.seq), Some(1))
        .await
        .map_err(|e| format!("a page before: {e}"))?;
    let after = client
        .chat_messages(&beta.ctx, &dm.id, PageAnchor::After(hello.seq), None)
        .await
        .map_err(|e| format!("a page after: {e}"))?;
    let around = client
        .chat_messages(&beta.ctx, &dm.id, PageAnchor::Around(hello.seq), Some(3))
        .await
        .map_err(|e| format!("a page around: {e}"))?;
    let seqs = |page: &MessagePage| page.messages.iter().map(|m| m.seq).collect::<Vec<_>>();
    if seqs(&before) != [hello.seq] || seqs(&after) != [reply.seq] || seqs(&around) != [hello.seq, reply.seq] {
        return Err(format!(
            "pages before {:?}, after {:?}, around {:?}",
            seqs(&before),
            seqs(&after),
            seqs(&around)
        ));
    }

    // -- Read marks --------------------------------------------------------------
    client
        .chat_read(&beta.ctx, &dm.id, reply.seq)
        .await
        .map_err(|e| format!("B reads: {e}"))?;
    expect_frame(&mut socket_a, "A hears B read", |frame| {
        frame.kind == "chat.read" && frame.payload["userId"] == beta.user.id.as_str() && frame.payload["seq"] == reply.seq
    })
    .await?;

    // -- Typing, and its reciprocity (D8) -----------------------------------------
    type_in(&mut socket_b, &dm.id).await?;
    let typing = expect_frame(&mut socket_a, "A sees B typing", |frame| {
        frame.kind == "chat.typing" && frame.payload["userId"] == beta.user.id.as_str()
    })
    .await?;
    match frames::parse(&typing.kind, typing.payload.clone()) {
        Ok(Frame::Typing(hint)) if hint.conversation_id == dm.id && hint.ttl_ms == Some(6000) => {}
        other => return Err(format!("the typing hint reads as {other:?}")),
    }
    let hidden = client
        .chat_update_settings(
            &alpha.ctx,
            &ChatPrivacyPatch { share_typing: Some(false), ..ChatPrivacyPatch::default() },
        )
        .await
        .map_err(|e| format!("A hides typing: {e}"))?;
    if hidden.share_typing || !hidden.share_read_receipts {
        return Err(format!("the settings came back as {hidden:?}"));
    }
    expect_frame(&mut socket_a, "A's devices hear the settings", |frame| {
        frame.kind == "chat.settings" && frame.payload["settings"]["shareTyping"] == false
    })
    .await?;
    // The service lets one hint per conversation through every 3 s.
    tokio::time::sleep(TYPING_GAP).await;
    type_in(&mut socket_b, &dm.id).await?;
    type_in(&mut socket_a, &dm.id).await?;
    if quiet(&mut socket_a, |frame| frame.kind == "chat.typing").await? {
        return Err("A, who hides typing, still sees B typing".into());
    }
    if quiet(&mut socket_b, |frame| frame.kind == "chat.typing").await? {
        return Err("B sees A typing although A hides it".into());
    }
    client
        .chat_update_settings(
            &alpha.ctx,
            &ChatPrivacyPatch { share_typing: Some(true), ..ChatPrivacyPatch::default() },
        )
        .await
        .map_err(|e| format!("A shows typing again: {e}"))?;
    tokio::time::sleep(TYPING_GAP).await;
    type_in(&mut socket_b, &dm.id).await?;
    expect_frame(&mut socket_a, "A sees B typing again", |frame| {
        frame.kind == "chat.typing" && frame.payload["userId"] == beta.user.id.as_str()
    })
    .await?;
    println!("typing: hidden both ways while A hid it, shown again after");

    // -- Read receipts, the other way round (D8) -----------------------------------
    client
        .chat_update_settings(
            &alpha.ctx,
            &ChatPrivacyPatch { share_read_receipts: Some(false), ..ChatPrivacyPatch::default() },
        )
        .await
        .map_err(|e| format!("A hides read receipts: {e}"))?;
    let late = send(client, alpha, &dm.id, "gg").await?;
    client
        .chat_read(&beta.ctx, &dm.id, late.seq)
        .await
        .map_err(|e| format!("B reads again: {e}"))?;
    expect_frame(&mut socket_b, "B's own devices hear B read", |frame| {
        frame.kind == "chat.read" && frame.payload["userId"] == beta.user.id.as_str() && frame.payload["seq"] == late.seq
    })
    .await?;
    if quiet(&mut socket_a, |frame| frame.kind == "chat.read" && frame.payload["userId"] == beta.user.id.as_str()).await? {
        return Err("A, who hides read receipts, still hears B read".into());
    }
    let seen_by_a = client
        .chat_conversation(&alpha.ctx, &dm.id)
        .await
        .map_err(|e| format!("GET the conversation as A: {e}"))?;
    let marker = |conversation: &Conversation, user_id: &str| {
        conversation
            .members
            .iter()
            .find(|member| member.user.id == user_id)
            .map(|member| member.read_seq)
    };
    if marker(&seen_by_a, &beta.user.id) != Some(None) || marker(&seen_by_a, &alpha.user.id).flatten().is_none() {
        return Err(format!("with receipts hidden A sees the markers {:?}", seen_by_a.members));
    }

    // -- The notification level is A's own ------------------------------------------
    let muted = client
        .chat_set_notify(&alpha.ctx, &dm.id, "mute")
        .await
        .map_err(|e| format!("A mutes: {e}"))?;
    if muted.notify != "mute" {
        return Err(format!("the level came back as {}", muted.notify));
    }
    expect_frame(&mut socket_a, "A's devices hear the level", |frame| {
        frame.kind == "chat.conversation" && frame.payload["conversation"]["notify"] == "mute"
    })
    .await?;
    let for_b = client
        .chat_conversation(&beta.ctx, &dm.id)
        .await
        .map_err(|e| format!("GET the conversation as B: {e}"))?;
    if for_b.notify != "all" {
        return Err(format!("A's mute reached B: {}", for_b.notify));
    }

    let _ = socket_a.close(None).await;
    let _ = socket_b.close(None).await;
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn a_group_asks_first_keeps_its_owner_s_rules_and_hands_itself_over() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let owner = sign_in(&client, &format!("Grp Owner {stamp}")).await;
    let member = sign_in(&client, &format!("Grp Member {stamp}")).await;
    let asker = sign_in(&client, &format!("Grp Asker {stamp}")).await;
    let outcome = group_flow(&client, &owner, &member, &asker).await;
    delete_all(&client, &[&owner, &member, &asker]).await;
    outcome.expect("the scenario");
}

async fn group_flow(
    client: &OnlineClient,
    owner: &Player,
    member: &Player,
    asker: &Player,
) -> Result<(), String> {
    befriend(client, owner, member).await?;
    befriend(client, owner, asker).await?;
    let mut socket_o = open(owner).await?;
    let mut socket_m = open(member).await?;
    let mut socket_c = open(asker).await?;

    // -- The asker wants to be asked first ---------------------------------------
    let asks = client
        .chat_update_settings(
            &asker.ctx,
            &ChatPrivacyPatch { group_add: Some("ask".into()), ..ChatPrivacyPatch::default() },
        )
        .await
        .map_err(|e| format!("PATCH /v1/chat/settings as C: {e}"))?;
    if asks.group_add != "ask" {
        return Err(format!("groupAdd came back as {}", asks.group_add));
    }

    // -- Created: M added, C invited, a stranger refused ----------------------------
    let stranger = new_client_id();
    let client_id = new_client_id();
    let ids = [member.user.id.clone(), asker.user.id.clone(), stranger.clone()];
    let created = client
        .chat_create_group(&owner.ctx, &client_id, Some("Duel night"), &ids)
        .await
        .map_err(|e| format!("POST /v1/chat/groups: {e}"))?;
    let group = created.conversation.clone();
    println!("POST /v1/chat/groups -> {} added {:?} invited {:?} refused {:?}", group.id, created.added, created.invited, created.refused);
    if created.added != [member.user.id.clone()]
        || created.invited != [asker.user.id.clone()]
        || created.refused.len() != 1
        || created.refused[0].user_id != stranger
        || created.refused[0].reason != "not_friend"
    {
        return Err(format!("the group was created as {created:?}"));
    }
    if group.kind != "group"
        || group.title.as_deref() != Some("Duel night")
        || group.owner_id.as_deref() != Some(owner.user.id.as_str())
        || group.members.len() != 2
        || group.history_for_new_members
    {
        return Err(format!("the new group reads {group:?}"));
    }
    match group.last_message.as_ref().and_then(|m| m.system.as_ref()) {
        Some(system) if system.event == "created" && system.by.as_deref() == Some(owner.user.id.as_str()) => {}
        other => return Err(format!("the group starts with {other:?}")),
    }
    let replayed = client
        .chat_create_group(&owner.ctx, &client_id, Some("Duel night"), &ids)
        .await
        .map_err(|e| format!("the replay of the creation: {e}"))?;
    if replayed.conversation.id != group.id || !replayed.added.is_empty() || !replayed.invited.is_empty() {
        return Err(format!("the replay answered {replayed:?}"));
    }
    expect_frame(&mut socket_m, "M hears the group", |frame| {
        frame.kind == "chat.conversation" && frame.payload["conversation"]["id"] == group.id.as_str()
    })
    .await?;
    let invite = expect_frame(&mut socket_c, "C hears the invite", |frame| frame.kind == "chat.groupInvite").await?;
    if invite.payload["invite"]["conversationId"] != group.id.as_str()
        || invite.payload["invite"]["invitedBy"]["id"] != owner.user.id.as_str()
    {
        return Err(format!("the invite reads {}", invite.payload));
    }
    let doc: ChatSyncDoc = lossless("C's sync document", &raw(client, asker, "/v1/chat/conversations").await?)?;
    if doc.group_invites.iter().all(|invite| invite.conversation_id != group.id) || doc.settings.group_add != "ask" {
        return Err(format!("C's sync document lists the invites {:?}", doc.group_invites));
    }

    // -- C joins after the group spoke: only from the join on (D1) ---------------------
    send(client, owner, &group.id, "before C came").await?;
    let joined = client
        .chat_join_group(&asker.ctx, &group.id)
        .await
        .map_err(|e| format!("POST /v1/chat/groups/{{id}}/join as C: {e}"))?;
    if joined.visible_from_seq + 1 != joined.last_seq {
        return Err(format!("C sees from {} of {}", joined.visible_from_seq, joined.last_seq));
    }
    let seen = events_of(client, asker, &group.id).await?;
    if seen != ["memberJoined"] {
        return Err(format!("C sees {seen:?}"));
    }
    expect_frame(&mut socket_c, "C hears the invite go", |frame| {
        frame.kind == "chat.groupInvite.removed" && frame.payload["conversationId"] == group.id.as_str()
    })
    .await?;
    let join = expect_frame(&mut socket_o, "O hears C join", |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["system"]["event"] == "memberJoined"
    })
    .await?;
    if join.payload["message"]["system"]["userId"] != asker.user.id.as_str() {
        return Err(format!("the join names {}", join.payload["message"]["system"]));
    }

    // -- The owner renames and switches history; nobody else does (D5, D1) --------------
    let by_member = code_of(client.chat_patch_group(&member.ctx, &group.id, Some("Mine now"), None).await);
    let history_by_member = code_of(client.chat_patch_group(&member.ctx, &group.id, None, Some(true)).await);
    if (by_member.as_str(), history_by_member.as_str()) != ("owner_only", "owner_only") {
        return Err(format!("a member's rename answered {by_member}, the switch {history_by_member}"));
    }
    let renamed = client
        .chat_patch_group(&owner.ctx, &group.id, Some("Duel night 2"), None)
        .await
        .map_err(|e| format!("the owner renames: {e}"))?;
    if renamed.title.as_deref() != Some("Duel night 2") {
        return Err(format!("the title came back as {:?}", renamed.title));
    }
    let rename = expect_frame(&mut socket_m, "M hears the rename", |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["system"]["event"] == "renamed"
    })
    .await?;
    if rename.payload["message"]["system"]["title"] != "Duel night 2" {
        return Err(format!("the rename reads {}", rename.payload["message"]["system"]));
    }
    let history = client
        .chat_patch_group(&owner.ctx, &group.id, None, Some(true))
        .await
        .map_err(|e| format!("the owner turns history on: {e}"))?;
    if !history.history_for_new_members {
        return Err("history did not stay on".into());
    }
    expect_frame(&mut socket_c, "C hears the switch", |frame| {
        frame.kind == "chat.message"
            && frame.payload["message"]["system"]["event"] == "historyForNewMembers"
            && frame.payload["message"]["system"]["on"] == true
    })
    .await?;
    let kept = client
        .chat_conversation(&asker.ctx, &group.id)
        .await
        .map_err(|e| format!("GET the group as C: {e}"))?;
    if kept.visible_from_seq != joined.visible_from_seq || !kept.history_for_new_members {
        return Err(format!("C's view moved with the switch: {}", kept.visible_from_seq));
    }

    // -- Only the owner removes; C goes, and comes back with the history ---------------
    let by_member = code_of(client.chat_remove_member(&member.ctx, &group.id, &asker.user.id).await);
    if by_member != "owner_only" {
        return Err(format!("a member removing C answered {by_member}"));
    }
    client
        .chat_remove_member(&owner.ctx, &group.id, &asker.user.id)
        .await
        .map_err(|e| format!("the owner removes C: {e}"))?;
    let removed = expect_frame(&mut socket_c, "C hears the removal", |frame| {
        frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == group.id.as_str()
    })
    .await?;
    if removed.payload["reason"] != "removed" {
        return Err(format!("the removal reached C as {}", removed.payload["reason"]));
    }
    let removal = expect_frame(&mut socket_m, "M hears C removed", |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["system"]["event"] == "memberRemoved"
    })
    .await?;
    if removal.payload["message"]["system"]["by"] != owner.user.id.as_str() {
        return Err(format!("the removal reads {}", removal.payload["message"]["system"]));
    }
    let gone = code_of(client.chat_conversation(&asker.ctx, &group.id).await);
    if gone != "not_found" {
        return Err(format!("C still reads the group: {gone}"));
    }
    let again = client
        .chat_add_members(&owner.ctx, &group.id, &[asker.user.id.clone(), member.user.id.clone()])
        .await
        .map_err(|e| format!("the owner adds C again: {e}"))?;
    if again.invited != [asker.user.id.clone()]
        || !again.added.is_empty()
        || again.refused.len() != 1
        || again.refused[0].reason != "member"
    {
        return Err(format!("adding C again answered {again:?}"));
    }
    expect_frame(&mut socket_c, "C hears the second invite", |frame| frame.kind == "chat.groupInvite").await?;
    let back = client
        .chat_join_group(&asker.ctx, &group.id)
        .await
        .map_err(|e| format!("C joins again: {e}"))?;
    let seen = events_of(client, asker, &group.id).await?;
    if back.visible_from_seq != 0 || seen.first().map(String::as_str) != Some("created") {
        return Err(format!("with history on C joined at {} and sees {seen:?}", back.visible_from_seq));
    }

    // -- A declined invite keeps the group from asking again for a day ------------------
    let scrims = client
        .chat_create_group(&owner.ctx, &new_client_id(), Some("Scrims"), std::slice::from_ref(&asker.user.id))
        .await
        .map_err(|e| format!("the second group: {e}"))?;
    let scrims_id = scrims.conversation.id.clone();
    for attempt in ["declines", "declines again"] {
        client
            .chat_remove_group_invite(&asker.ctx, &scrims_id, &asker.user.id)
            .await
            .map_err(|e| format!("C {attempt}: {e}"))?;
    }
    let cooling = client
        .chat_add_members(&owner.ctx, &scrims_id, std::slice::from_ref(&asker.user.id))
        .await
        .map_err(|e| format!("asking C again: {e}"))?;
    if cooling.refused.len() != 1 || cooling.refused[0].reason != "cooldown" {
        return Err(format!("asking C again answered {cooling:?}"));
    }
    let doc = client
        .chat_sync(&asker.ctx)
        .await
        .map_err(|e| format!("C's sync document: {e}"))?;
    if doc.group_invites.iter().any(|invite| invite.conversation_id == scrims_id) {
        return Err("a declined invite is still listed".into());
    }
    client
        .chat_remove_member(&owner.ctx, &scrims_id, &owner.user.id)
        .await
        .map_err(|e| format!("the owner leaves the empty group: {e}"))?;
    if code_of(client.chat_conversation(&owner.ctx, &scrims_id).await) != "not_found" {
        return Err("a group nobody is in outlived its last member".into());
    }

    // -- The owner leaves: the earliest member takes over (D4) --------------------------
    client
        .chat_remove_member(&owner.ctx, &group.id, &owner.user.id)
        .await
        .map_err(|e| format!("the owner leaves: {e}"))?;
    let left = expect_frame(&mut socket_o, "O hears O leave", |frame| {
        frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == group.id.as_str()
    })
    .await?;
    if left.payload["reason"] != "left" {
        return Err(format!("the owner's leave reached the owner as {}", left.payload["reason"]));
    }
    let (seen, found) = frames_until(&mut socket_m, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["system"]["event"] == "ownerChanged"
    })
    .await?;
    if !found {
        return Err("M never heard the owner change".into());
    }
    // Earlier frames of the group may still wait on M's socket; the two of
    // the handover come in this order.
    let order: Vec<String> = seen
        .iter()
        .filter(|frame| frame.kind == "chat.message")
        .filter_map(|frame| frame.payload["message"]["system"]["event"].as_str().map(str::to_string))
        .filter(|event| event == "memberLeft" || event == "ownerChanged")
        .collect();
    if order != ["memberLeft", "ownerChanged"] {
        return Err(format!("the handover reads {order:?}"));
    }
    let handover = &seen.last().expect("the frame found").payload["message"]["system"];
    if handover["userId"] != member.user.id.as_str() || handover["by"] != owner.user.id.as_str() {
        return Err(format!("the handover names {handover}"));
    }
    let now = client
        .chat_conversation(&member.ctx, &group.id)
        .await
        .map_err(|e| format!("GET the group as M: {e}"))?;
    let role = now.members.iter().find(|m| m.user.id == member.user.id).map(|m| m.role.as_str());
    if now.owner_id.as_deref() != Some(member.user.id.as_str()) || role != Some("owner") {
        return Err(format!("after the handover the group reads owner {:?}, role {role:?}", now.owner_id));
    }
    client
        .chat_patch_group(&member.ctx, &group.id, Some("M's night"), None)
        .await
        .map_err(|e| format!("the new owner renames: {e}"))?;
    let by_asker = code_of(client.chat_patch_group(&asker.ctx, &group.id, Some("C's night"), None).await);
    if by_asker != "owner_only" {
        return Err(format!("C's rename after the handover answered {by_asker}"));
    }

    // -- The last one out deletes the group ------------------------------------------------
    for player in [member, asker] {
        client
            .chat_remove_member(&player.ctx, &group.id, &player.user.id)
            .await
            .map_err(|e| format!("{} leaves: {e}", player.name))?;
    }
    let after = code_of(client.chat_conversation(&owner.ctx, &group.id).await);
    if after != "not_found" {
        return Err(format!("the emptied group answered {after}"));
    }

    for socket in [&mut socket_o, &mut socket_m, &mut socket_c] {
        let _ = socket.close(None).await;
    }
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn a_file_of_25_mib_goes_through_and_one_byte_more_does_not() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let alpha = sign_in(&client, &format!("Big Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Big Beta {stamp}")).await;
    let temp = tempfile::tempdir().expect("a temp dir");
    let outcome = file_limits(&client, &alpha, &beta, temp.path()).await;
    delete_all(&client, &[&alpha, &beta]).await;
    outcome.expect("the scenario");
}

async fn file_limits(
    client: &OnlineClient,
    alpha: &Player,
    beta: &Player,
    temp: &std::path::Path,
) -> Result<(), String> {
    befriend(client, alpha, beta).await?;
    let dm = client
        .chat_open_direct(&alpha.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as A: {e}"))?;
    let staging = temp.join("staging");

    // -- Exactly 25 MiB: staged, registered, uploaded, sent and fetched ----------------
    let limit = files::MAX_FILE_BYTES as usize;
    let bytes: Vec<u8> = (0..limit).map(|at| (at % 251) as u8).collect();
    let (staged, _) = files::stage_bytes(&staging, "duel.dm_26", bytes, "file", None)
        .map_err(|e| format!("staging 25 MiB: {e}"))?;
    let file_id = files::put_staged(client, &alpha.ctx, &dm.id, &staged, |_| {})
        .await
        .map_err(|e| format!("uploading 25 MiB: {e}"))?;
    let message = client
        .chat_send(
            &alpha.ctx,
            &dm.id,
            &NewMessage { client_id: new_client_id(), file_ids: vec![file_id.clone()], ..NewMessage::default() },
        )
        .await
        .map_err(|e| format!("sending 25 MiB: {e}"))?;
    let file = message.files.first().ok_or("the message carries no file")?;
    if (file.size, file.class.as_str(), file.danger) != (staged.size, "demo", false) {
        return Err(format!("the demo came back as {file:?}"));
    }
    let mut quiet = |_: u64, _: u64| {};
    let cached = files::fetch(client, &beta.ctx, &temp.join("beta"), &file_id, &mut quiet)
        .await
        .map_err(|e| format!("B downloads 25 MiB: {e}"))?;
    if crate::bundles::sha256_of(&cached).map_err(|e| e.to_string())? != staged.sha256 {
        return Err("B's copy of 25 MiB differs".into());
    }
    println!("25 MiB went up and came down whole");

    // -- Resumed from a partial download -------------------------------------------------
    let resumed = temp.join("resumed");
    std::fs::create_dir_all(&resumed).map_err(|e| e.to_string())?;
    let head = std::fs::read(&staged.path).map_err(|e| e.to_string())?;
    std::fs::write(resumed.join(format!("{file_id}.part")), &head[..1024 * 1024]).map_err(|e| e.to_string())?;
    let mut first = None;
    let mut record = |received: u64, _: u64| {
        first.get_or_insert(received);
    };
    let whole = files::fetch(client, &beta.ctx, &resumed, &file_id, &mut record)
        .await
        .map_err(|e| format!("the resumed download: {e}"))?;
    if first != Some(1024 * 1024) || crate::bundles::sha256_of(&whole).map_err(|e| e.to_string())? != staged.sha256 {
        return Err(format!("the resumed download started at {first:?}"));
    }

    // -- The same bytes again cost no upload; B may not send A's file ------------------------
    let again = client
        .chat_register_file(&alpha.ctx, &dm.id, "again.dm_26", staged.size, &staged.sha256, None)
        .await
        .map_err(|e| format!("registering the same bytes: {e}"))?;
    if again.needs_upload {
        return Err("the account's own copy did not spare the upload".into());
    }
    let borrowed = code_of(
        client
            .chat_send(
                &beta.ctx,
                &dm.id,
                &NewMessage { client_id: new_client_id(), file_ids: vec![again.file.id.clone()], ..NewMessage::default() },
            )
            .await,
    );
    if borrowed != "file_not_ready" {
        return Err(format!("B sending A's file answered {borrowed}"));
    }

    // -- One byte more is refused by the launcher and by the service ---------------------------
    let over: Vec<u8> = vec![7; limit + 1];
    match files::stage_bytes(&staging, "over.dm_26", over, "file", None) {
        Err(AppError::InvalidInput(reason)) => println!("staging 25 MiB + 1 -> {reason}"),
        other => return Err(format!("the launcher staged 25 MiB + 1: {other:?}")),
    }
    let refused = code_of(
        client
            .chat_register_file(&alpha.ctx, &dm.id, "over.dm_26", files::MAX_FILE_BYTES + 1, &"ab".repeat(32), None)
            .await,
    );
    if refused != "file_too_large" {
        return Err(format!("registering 25 MiB + 1 answered {refused}"));
    }

    // -- Bytes that are not the registered ones -----------------------------------------------
    let small = b"not the bytes of the registration".to_vec();
    let registered = client
        .chat_register_file(&alpha.ctx, &dm.id, "note.txt", small.len() as u64, &"cd".repeat(32), None)
        .await
        .map_err(|e| format!("registering a note: {e}"))?;
    let mismatch = code_of(
        client
            .chat_upload_file(&alpha.ctx, &registered.file.id, small.len() as u64, small.clone().into())
            .await,
    );
    if mismatch != "hash_mismatch" {
        return Err(format!("bytes of another hash answered {mismatch}"));
    }

    // -- A picture keeps what the launcher said about it ------------------------------------------
    let (picture, _) = files::stage_bytes(&staging, "clip.jpg", jpeg_with_gps(), "clipboard", None)
        .map_err(|e| format!("staging a picture: {e}"))?;
    let registration: Value = client
        .request(
            &alpha.ctx,
            Method::POST,
            "/v1/chat/files",
            Some(json!({
                "conversationId": dm.id,
                "name": picture.name,
                "size": picture.size,
                "sha256": picture.sha256,
                "meta": picture.meta,
            })),
            Auth::Required,
        )
        .await
        .map_err(|e| format!("registering a picture: {e}"))?;
    let file: crate::online::FileRef = lossless("POST /v1/chat/files", &registration["file"])?;
    if registration["needsUpload"] != true {
        return Err(format!("a new picture needs no upload: {registration}"));
    }
    let meta = file.meta.clone().unwrap_or_default();
    if (meta.width, meta.height, meta.origin.as_deref()) != (Some(16), Some(8), Some("clipboard")) {
        return Err(format!("the picture's meta came back as {meta:?}"));
    }

    // -- The quota counts the demo ------------------------------------------------------------------
    let doc: ChatSyncDoc = lossless("A's sync document", &raw(client, alpha, "/v1/chat/conversations").await?)?;
    if doc.quota.used_bytes < files::MAX_FILE_BYTES || doc.quota.quota_bytes == 0 || doc.quota.next_free_at.is_none() {
        return Err(format!("the quota reads {:?}", doc.quota));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn search_finds_what_each_member_may_see() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let alpha = sign_in(&client, &format!("Find Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Find Beta {stamp}")).await;
    let outsider = sign_in(&client, &format!("Find Gamma {stamp}")).await;
    let outcome = search_flow(&client, &alpha, &beta, &outsider).await;
    delete_all(&client, &[&alpha, &beta, &outsider]).await;
    outcome.expect("the scenario");
}

async fn search_flow(
    client: &OnlineClient,
    alpha: &Player,
    beta: &Player,
    outsider: &Player,
) -> Result<(), String> {
    befriend(client, alpha, beta).await?;
    let dm = client
        .chat_open_direct(&alpha.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as A: {e}"))?;
    let word = format!("lightsaber{}", &new_client_id()[20..]).to_lowercase();
    let hit = send(client, beta, &dm.id, &format!("my {word} is blue")).await?;
    send(client, beta, &dm.id, "read https://jknet.app/faq first").await?;
    send(client, alpha, &dm.id, "Бой на мечах в субботу").await?;
    for n in 1..=3 {
        send(client, alpha, &dm.id, &format!("duel{word} round {n}")).await?;
    }

    let query = |q: &str| SearchQuery { q: q.into(), ..SearchQuery::default() };
    let path = format!("/v1/chat/search?q={}", word.to_uppercase());
    let page: crate::online::SearchPage = lossless("GET /v1/chat/search", &raw(client, alpha, &path).await?)?;
    // The word is a substring of the three rounds too, and the newest comes
    // first.
    let found: Vec<u64> = page.results.iter().map(|hit| hit.message.seq).collect();
    let oldest = page.results.last().map(|hit| hit.message.sender_id.as_deref());
    if found.len() != 4 || found.last() != Some(&hit.seq) || oldest != Some(Some(beta.user.id.as_str())) {
        return Err(format!("A's search for {word} found {found:?}"));
    }
    let by_sender = |sender: &Player| SearchQuery { sender_id: Some(sender.user.id.clone()), ..query(&word) };
    let from_b = client.chat_search(&alpha.ctx, &by_sender(beta)).await.map_err(|e| e.to_string())?;
    let from_a = client.chat_search(&alpha.ctx, &by_sender(alpha)).await.map_err(|e| e.to_string())?;
    if from_b.results.len() != 1 || from_a.results.len() != 3 {
        return Err(format!("by sender: B {}, A {}", from_b.results.len(), from_a.results.len()));
    }
    let cyrillic = client.chat_search(&beta.ctx, &query("БОЙ НА")).await.map_err(|e| e.to_string())?;
    if cyrillic.results.len() != 1 {
        return Err(format!("a Cyrillic search found {}", cyrillic.results.len()));
    }
    let links = client
        .chat_search(&beta.ctx, &SearchQuery { has: Some("link".into()), ..query("jknet") })
        .await
        .map_err(|e| e.to_string())?;
    if links.results.len() != 1 || !links.results[0].message.body.contains("https://") {
        return Err(format!("the link search found {:?}", links.results.len()));
    }

    // -- Pages, newest first -----------------------------------------------------------
    let first = client
        .chat_search(&alpha.ctx, &SearchQuery { limit: Some(2), ..query(&format!("duel{word}")) })
        .await
        .map_err(|e| e.to_string())?;
    let cursor = first.next_cursor.clone().ok_or("a first page of two of three has no next cursor")?;
    let second = client
        .chat_search(&alpha.ctx, &SearchQuery { limit: Some(2), before: Some(cursor), ..query(&format!("duel{word}")) })
        .await
        .map_err(|e| e.to_string())?;
    let seqs: Vec<u64> = first.results.iter().chain(&second.results).map(|hit| hit.message.seq).collect();
    if seqs.len() != 3 || !seqs.windows(2).all(|pair| pair[0] > pair[1]) || second.next_cursor.is_some() {
        return Err(format!("the pages hold {seqs:?}, then {:?}", second.next_cursor));
    }

    // -- Short queries need a conversation; strangers find nothing ------------------------
    let short = code_of(client.chat_search(&alpha.ctx, &query("my")).await);
    if short != "invalid" {
        return Err(format!("a two-letter search everywhere answered {short}"));
    }
    let scoped = client
        .chat_search(&alpha.ctx, &SearchQuery { conversation_id: Some(dm.id.clone()), ..query("my") })
        .await
        .map_err(|e| format!("a two-letter search in one conversation: {e}"))?;
    if scoped.results.is_empty() {
        return Err("a two-letter search in one conversation found nothing".into());
    }
    let foreign = code_of(
        client
            .chat_search(&outsider.ctx, &SearchQuery { conversation_id: Some(dm.id.clone()), ..query(&word) })
            .await,
    );
    if foreign != "not_found" {
        return Err(format!("a stranger's search in the conversation answered {foreign}"));
    }
    let nothing = client.chat_search(&outsider.ctx, &query(&word)).await.map_err(|e| e.to_string())?;
    if !nothing.results.is_empty() {
        return Err("a stranger found the conversation's messages".into());
    }
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn unfriending_leaves_the_direct_conversation_read_only_until_they_are_friends_again() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let alpha = sign_in(&client, &format!("Ex Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Ex Beta {stamp}")).await;
    let outcome = unfriend_flow(&client, &alpha, &beta).await;
    delete_all(&client, &[&alpha, &beta]).await;
    outcome.expect("the scenario");
}

async fn unfriend_flow(client: &OnlineClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    befriend(client, alpha, beta).await?;
    let mut socket_a = open(alpha).await?;
    let mut socket_b = open(beta).await?;
    let dm = client
        .chat_open_direct(&alpha.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as A: {e}"))?;
    let hello = send(client, beta, &dm.id, "see you").await?;

    client
        .remove_friend(&alpha.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("DELETE /v1/friends/{{B}} as A: {e}"))?;
    for (socket, who) in [(&mut socket_a, "A"), (&mut socket_b, "B")] {
        expect_frame(socket, &format!("{who} hears the conversation go read-only"), |frame| {
            frame.kind == "chat.conversation"
                && frame.payload["conversation"]["id"] == dm.id.as_str()
                && frame.payload["conversation"]["canSend"] == false
        })
        .await?;
    }
    let refused = code_of(client.chat_send(&beta.ctx, &dm.id, &text_message("still there?")).await);
    let reaction = code_of(client.chat_react(&beta.ctx, &dm.id, hello.seq, "👍", true).await);
    let file = code_of(
        client
            .chat_register_file(&beta.ctx, &dm.id, "shot.png", 10, &"ef".repeat(32), None)
            .await,
    );
    if [refused.as_str(), reaction.as_str(), file.as_str()] != ["not_friends"; 3] {
        return Err(format!("a read-only conversation answered {refused}, {reaction}, {file}"));
    }
    let kept = client
        .chat_open_direct(&beta.ctx, &alpha.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct after unfriending: {e}"))?;
    let history = client
        .chat_messages(&beta.ctx, &dm.id, PageAnchor::Latest, None)
        .await
        .map_err(|e| format!("the history after unfriending: {e}"))?;
    if kept.id != dm.id || kept.can_send || history.messages.len() != 1 {
        return Err(format!("after unfriending: {kept:?}, {} messages", history.messages.len()));
    }

    befriend(client, beta, alpha).await?;
    expect_frame(&mut socket_a, "A hears the conversation open again", |frame| {
        frame.kind == "chat.conversation"
            && frame.payload["conversation"]["id"] == dm.id.as_str()
            && frame.payload["conversation"]["canSend"] == true
    })
    .await?;
    send(client, beta, &dm.id, "friends again").await?;
    let _ = socket_a.close(None).await;
    let _ = socket_b.close(None).await;
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn a_deleted_account_leaves_its_messages_behind_as_a_deleted_account() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let leaver = sign_in(&client, &format!("Gone Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Gone Beta {stamp}")).await;
    let gamma = sign_in(&client, &format!("Gone Gamma {stamp}")).await;
    let temp = tempfile::tempdir().expect("a temp dir");
    let outcome = deletion_flow(&client, &leaver, &beta, &gamma, temp.path()).await;
    delete_all(&client, &[&beta, &gamma]).await;
    outcome.expect("the scenario");
}

async fn deletion_flow(
    client: &OnlineClient,
    leaver: &Player,
    beta: &Player,
    gamma: &Player,
    temp: &std::path::Path,
) -> Result<(), String> {
    befriend(client, leaver, beta).await?;
    befriend(client, leaver, gamma).await?;
    let mut socket_b = open(beta).await?;
    let mut socket_c = open(gamma).await?;

    // What the account leaves behind: a direct conversation with a message, a
    // file and a reply; an empty one; a group it owns.
    let dm = client
        .chat_open_direct(&leaver.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as A: {e}"))?;
    let original = send(client, leaver, &dm.id, "remember me").await?;
    let (picture, _) = files::stage_bytes(&temp.join("staging"), "last.jpg", jpeg_with_gps(), "file", None)
        .map_err(|e| format!("staging: {e}"))?;
    let file_id = files::put_staged(client, &leaver.ctx, &dm.id, &picture, |_| {})
        .await
        .map_err(|e| format!("A uploads: {e}"))?;
    client
        .chat_send(
            &leaver.ctx,
            &dm.id,
            &NewMessage { client_id: new_client_id(), file_ids: vec![file_id.clone()], ..NewMessage::default() },
        )
        .await
        .map_err(|e| format!("A sends the picture: {e}"))?;
    let reply = client
        .chat_send(
            &beta.ctx,
            &dm.id,
            &NewMessage {
                client_id: new_client_id(),
                body: format!("I will, <@{}>", leaver.user.id),
                reply_seq: Some(original.seq),
                ..NewMessage::default()
            },
        )
        .await
        .map_err(|e| format!("B replies: {e}"))?;
    let empty = client
        .chat_open_direct(&leaver.ctx, &gamma.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct with C: {e}"))?;
    let group = client
        .chat_create_group(
            &leaver.ctx,
            &new_client_id(),
            Some("Old guard"),
            &[beta.user.id.clone(), gamma.user.id.clone()],
        )
        .await
        .map_err(|e| format!("A's group: {e}"))?
        .conversation;
    send(client, leaver, &group.id, "gl hf").await?;

    client
        .delete_me(&leaver.ctx)
        .await
        .map_err(|e| format!("DELETE /v1/me as A: {e}"))?;
    println!("DELETE /v1/me for {} -> 204", leaver.name);

    // -- The direct conversation stays, read-only, for B (D3) ----------------------
    let kept = expect_frame(&mut socket_b, "B hears the conversation go read-only", |frame| {
        frame.kind == "chat.conversation"
            && frame.payload["conversation"]["id"] == dm.id.as_str()
            && frame.payload["conversation"]["canSend"] == false
    })
    .await?;
    let kept: Conversation = lossless("chat.conversation", &kept.payload["conversation"])?;
    if kept.can_send || kept.members.len() != 1 || kept.members[0].user.id != beta.user.id {
        return Err(format!("after the deletion B's conversation reads {kept:?}"));
    }
    let page = client
        .chat_messages(&beta.ctx, &dm.id, PageAnchor::Latest, None)
        .await
        .map_err(|e| format!("B's history: {e}"))?;
    let by_seq = |seq: u64| page.messages.iter().find(|m| m.seq == seq);
    let left = by_seq(original.seq).ok_or("the message of the deleted account went")?;
    if left.sender_id.is_some() || !left.is_user() || left.is_from(Some(&beta.user.id)) {
        return Err(format!("the deleted account's message reads {left:?}"));
    }
    let answered = by_seq(reply.seq).ok_or("B's reply went")?;
    let quote = answered.reply_to.as_ref().ok_or("the reply lost its quote")?;
    if quote.sender_id.is_some() || quote.missing || !answered.body.contains("<@deleted>") {
        return Err(format!("B's reply reads {:?} quoting {quote:?}", answered.body));
    }
    let mut quiet_progress = |_: u64, _: u64| {};
    files::fetch(client, &beta.ctx, &temp.join("beta"), &file_id, &mut quiet_progress)
        .await
        .map_err(|e| format!("B downloads the deleted account's picture: {e}"))?;
    let refused = code_of(client.chat_send(&beta.ctx, &dm.id, &text_message("hello?")).await);
    let reopened = code_of(client.chat_open_direct(&beta.ctx, &leaver.user.id).await);
    if (refused.as_str(), reopened.as_str()) != ("not_friends", "not_found") {
        return Err(format!("writing to a deleted account answered {refused}, reopening {reopened}"));
    }
    let found = client
        .chat_search(&beta.ctx, &SearchQuery { q: "remember me".into(), ..SearchQuery::default() })
        .await
        .map_err(|e| format!("B's search: {e}"))?;
    if found.results.first().map(|hit| hit.message.sender_id.is_none()) != Some(true) {
        return Err("the search lost the deleted account's message".into());
    }

    // -- The empty conversation with C goes -------------------------------------------
    let removed = expect_frame(&mut socket_c, "C hears the empty conversation go", |frame| {
        frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == empty.id.as_str()
    })
    .await?;
    if removed.payload["reason"] != "account_deleted" {
        return Err(format!("the empty conversation went with {}", removed.payload["reason"]));
    }

    // -- The group passes to B (D4) ---------------------------------------------------
    let (seen, found) = frames_until(&mut socket_c, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.message"
            && frame.payload["message"]["conversationId"] == group.id.as_str()
            && frame.payload["message"]["system"]["event"] == "ownerChanged"
    })
    .await?;
    if !found {
        return Err("C never heard the group change hands".into());
    }
    let systems: Vec<&Value> = seen
        .iter()
        .filter(|frame| {
            frame.kind == "chat.message" && frame.payload["message"]["conversationId"] == group.id.as_str()
        })
        .map(|frame| &frame.payload["message"]["system"])
        .filter(|system| !system.is_null())
        .collect();
    let events: Vec<&str> = systems.iter().filter_map(|system| system["event"].as_str()).collect();
    if events != ["memberLeft", "ownerChanged"]
        || !systems[0]["userId"].is_null()
        || systems[1]["userId"] != beta.user.id.as_str()
        || !systems[1]["by"].is_null()
    {
        return Err(format!("the group recorded {systems:?}"));
    }
    let now = client
        .chat_conversation(&gamma.ctx, &group.id)
        .await
        .map_err(|e| format!("GET the group as C: {e}"))?;
    if now.owner_id.as_deref() != Some(beta.user.id.as_str()) || now.members.len() != 2 {
        return Err(format!("the group after the deletion reads {now:?}"));
    }
    let _ = socket_b.close(None).await;
    let _ = socket_c.close(None).await;
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn a_host_invite_card_lets_a_guest_in_and_the_chat_ends_with_the_hosting() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let host = sign_in(&client, &format!("Card Host {stamp}")).await;
    let guest = sign_in(&client, &format!("Card Guest {stamp}")).await;
    let outcome = host_invite_flow(&client, &host, &guest).await;
    delete_all(&client, &[&host, &guest]).await;
    outcome.expect("the scenario");
}

async fn host_invite_flow(client: &OnlineClient, host: &Player, guest: &Player) -> Result<(), String> {
    use super::cards::{self, Card};

    befriend(client, host, guest).await?;
    let mut socket_h = open(host).await?;
    let mut socket_g = open(guest).await?;
    let session = crate::hosting::server::new_session_id();
    heartbeat(client, host, Some(hosting_of(&session, "invite"))).await?;
    let chat = client
        .chat_open_server(&host.ctx, &session)
        .await
        .map_err(|e| format!("PUT /v1/chat/servers as H: {e}"))?;

    // -- The card as the launcher builds it; the service fills in the rest -----------
    let dm = client
        .chat_open_direct(&host.ctx, &guest.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as H: {e}"))?;
    let built = cards::prepare(&[json!({ "type": "hostInvite", "sessionId": session, "name": "Duel night" })])
        .map_err(|e| format!("the launcher builds a host invite: {e}"))?;
    let sent = client
        .chat_send(
            &host.ctx,
            &dm.id,
            &NewMessage { client_id: new_client_id(), cards: built, ..NewMessage::default() },
        )
        .await
        .map_err(|e| format!("H sends the card: {e}"))?;
    let stored = sent.cards.first().ok_or("the card went missing")?;
    let text = stored.to_string();
    for secret in ["password", "lanAddresses", "relayAddress", "k7m2q9xa", "192.168.1.23"] {
        if text.contains(secret) {
            return Err(format!("the stored card carries {secret}: {text}"));
        }
    }
    match cards::check(stored) {
        Ok(Card::HostInvite(card))
            if card.host_id.as_deref() == Some(host.user.id.as_str())
                && card.game.as_deref() == Some("ja")
                && card.map.as_deref() == Some("mp/ffa3")
                && card.session_id == session => {}
        other => return Err(format!("the stored card reads {other:?} in the launcher: {text}")),
    }
    expect_frame(&mut socket_g, "G hears the invite of the card", |frame| {
        frame.kind == "invite"
    })
    .await?;
    let invites = client
        .list_invites(&guest.ctx)
        .await
        .map_err(|e| format!("GET /v1/invites as G: {e}"))?;
    let invite = invites
        .iter()
        .find(|invite| invite.from.id == host.user.id)
        .ok_or("the card sent G no invite")?;
    if invite.hosting.as_ref().map(|hosting| hosting.session_id.as_str()) != Some(session.as_str()) {
        return Err(format!("the invite leads to {:?}", invite.hosting));
    }

    // -- The invite opens the chat of an invite-only server ---------------------------
    let joined = client
        .chat_join_server(&guest.ctx, &session, &host.user.id)
        .await
        .map_err(|e| format!("G joins through the invite: {e}"))?;
    if joined.id != chat.id || joined.kind != "server" {
        return Err(format!("G joined {joined:?}"));
    }
    lossless::<Conversation>(
        "a server chat",
        &raw(client, guest, &format!("/v1/chat/conversations/{}", chat.id)).await?,
    )?;

    // -- Hosting ends: the chat ends for both ---------------------------------------------
    heartbeat(client, host, None).await?;
    for (socket, who) in [(&mut socket_h, "H"), (&mut socket_g, "G")] {
        let ended = expect_frame(socket, &format!("{who} hears the chat end"), |frame| {
            frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == chat.id.as_str()
        })
        .await?;
        if ended.payload["reason"] != "ended" {
            return Err(format!("the chat ended for {who} with {}", ended.payload["reason"]));
        }
    }
    let after = code_of(client.chat_join_server(&guest.ctx, &session, &host.user.id).await);
    if after != "not_found" {
        return Err(format!("a join after the hosting ended answered {after}"));
    }

    // -- The host leaving its own chat ends it too -----------------------------------------
    let next = crate::hosting::server::new_session_id();
    heartbeat(client, host, Some(hosting_of(&next, "friends"))).await?;
    let second = client
        .chat_open_server(&host.ctx, &next)
        .await
        .map_err(|e| format!("the next server's chat: {e}"))?;
    client
        .chat_join_server(&guest.ctx, &next, &host.user.id)
        .await
        .map_err(|e| format!("G joins the next server's chat: {e}"))?;
    client
        .chat_remove_member(&host.ctx, &second.id, &host.user.id)
        .await
        .map_err(|e| format!("H leaves its own chat: {e}"))?;
    for (socket, who, reason) in [(&mut socket_h, "H", "left"), (&mut socket_g, "G", "ended")] {
        let ended = expect_frame(socket, &format!("{who} hears the host leave"), |frame| {
            frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == second.id.as_str()
        })
        .await?;
        if ended.payload["reason"] != reason {
            return Err(format!("the host's leave reached {who} as {}", ended.payload["reason"]));
        }
    }
    heartbeat(client, host, None).await?;
    let _ = socket_h.close(None).await;
    let _ = socket_g.close(None).await;
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn the_cards_the_launcher_builds_are_the_cards_the_service_keeps() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let alpha = sign_in(&client, &format!("Cards Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Cards Beta {stamp}")).await;
    let outcome = card_flow(&client, &alpha, &beta).await;
    delete_all(&client, &[&alpha, &beta]).await;
    outcome.expect("the scenario");
}

async fn card_flow(client: &OnlineClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    use super::cards;

    befriend(client, alpha, beta).await?;
    let dm = client
        .chat_open_direct(&alpha.ctx, &beta.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as A: {e}"))?;

    // Drafts as the windows send them: no `v`, no `fallbackText`.
    let drafts = [
        json!({ "type": "server", "address": "203.0.113.10:29070", "name": "Duel Arena", "game": "ja", "map": "mp/duel6", "gametype": 3 }),
        json!({ "type": "bundle", "bundleId": new_client_id(), "slug": "duel-pack", "name": "Duel pack", "game": "ja" }),
        json!({ "type": "jkhubMod", "fileId": 4391, "slug": "trilogy-sabers-episode-3", "title": "Trilogy Sabers : Episode 3", "game": "ja" }),
        json!({ "type": "map", "game": "ja", "name": "mp/ffa3", "title": "Bespin Streets" }),
        json!({ "type": "profile", "nickname": "^4Kyle", "model": "kyle/default", "saber1": "Kyle", "color1": "4", "color2": "1", "charColor": "255 255 255" }),
        json!({ "type": "bind", "binds": [{ "key": "F1", "command": "say gg" }, { "key": "F3", "command": "quit" }] }),
        json!({ "type": "config", "name": "duel.cfg", "text": "seta cg_fov 110\nbind MOUSE3 vstr duel\n" }),
    ];
    for draft in &drafts {
        let built = cards::prepare(std::slice::from_ref(draft))
            .map_err(|e| format!("the launcher builds {draft}: {e}"))?;
        let sent = client
            .chat_send(
                &alpha.ctx,
                &dm.id,
                &NewMessage { client_id: new_client_id(), cards: built.clone(), ..NewMessage::default() },
            )
            .await
            .map_err(|e| format!("the service refuses the card {}: {e}", built[0]))?;
        if sent.cards != built {
            return Err(format!("the card went out as {}\nand came back as {}", built[0], sent.cards[0]));
        }
        cards::check(&sent.cards[0]).map_err(|e| format!("the launcher refuses the stored card {}: {e}", sent.cards[0]))?;
    }

    // Cards the launcher refuses are refused by the service as well, with the
    // same reason.
    let refused = [
        json!({ "type": "server", "v": 1, "fallbackText": "x", "address": "127.0.0.1:29070", "name": "Loop", "game": "ja" }),
        json!({ "type": "map", "v": 1, "fallbackText": "x", "game": "ja", "name": "../maps/ffa3" }),
        json!({ "type": "profile", "v": 1, "fallbackText": "x", "nickname": "Kyle;quit", "model": "kyle", "saber1": "Kyle", "color1": "4" }),
        json!({ "type": "map", "v": 2, "fallbackText": "x", "game": "ja", "name": "mp/ffa3" }),
        json!({ "type": "poll", "v": 1, "fallbackText": "x" }),
    ];
    for card in &refused {
        let launcher = code_of(cards::prepare(std::slice::from_ref(card)));
        let service = code_of(
            client
                .chat_send(
                    &alpha.ctx,
                    &dm.id,
                    &NewMessage { client_id: new_client_id(), cards: vec![card.clone()], ..NewMessage::default() },
                )
                .await,
        );
        if (launcher.as_str(), service.as_str()) != ("card", "card") {
            return Err(format!("{card}: the launcher answered {launcher}, the service {service}"));
        }
    }
    // Whether the sender hosts the server is the service's to say.
    let not_hosting = code_of(
        client
            .chat_send(
                &alpha.ctx,
                &dm.id,
                &NewMessage {
                    client_id: new_client_id(),
                    cards: cards::prepare(&[json!({ "type": "hostInvite", "sessionId": "0123456789abcdef" })])
                        .map_err(|e| format!("the launcher builds a host invite: {e}"))?,
                    ..NewMessage::default()
                },
            )
            .await,
    );
    if not_hosting != "card" {
        return Err(format!("a host invite of a server nobody hosts answered {not_hosting}"));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "needs the real service on 127.0.0.1:8787 with JKNET_ONLINE_DEV_PROVIDER=1 and chat"]
async fn only_a_socket_that_asks_for_chat_hears_chat_or_may_type() {
    let client = OnlineClient::new();
    let stamp = stamp();
    let alpha = sign_in(&client, &format!("Old Alpha {stamp}")).await;
    let beta = sign_in(&client, &format!("Old Beta {stamp}")).await;
    let outcome = opt_in_flow(&client, &alpha, &beta).await;
    delete_all(&client, &[&alpha, &beta]).await;
    outcome.expect("the scenario");
}

async fn opt_in_flow(client: &OnlineClient, alpha: &Player, beta: &Player) -> Result<(), String> {
    befriend(client, alpha, beta).await?;
    let mut modern = open(alpha).await?;
    let mut older = open_without_chat(alpha).await?;
    let mut older_b = open_without_chat(beta).await?;
    let dm = client
        .chat_open_direct(&beta.ctx, &alpha.user.id)
        .await
        .map_err(|e| format!("PUT /v1/chat/direct as B: {e}"))?;
    send(client, beta, &dm.id, "hi").await?;
    expect_frame(&mut modern, "the chat socket hears the message", |frame| frame.kind == "chat.message").await?;
    if quiet(&mut older, |frame| frame.kind.starts_with("chat.")).await? {
        return Err("a socket without X-JKNet-Features: chat heard chat".into());
    }
    // A typing hint on a socket that did not ask for chat goes nowhere.
    type_in(&mut older_b, &dm.id).await?;
    if quiet(&mut modern, |frame| frame.kind == "chat.typing").await? {
        return Err("a socket without chat passed a typing hint on".into());
    }
    // A friend event still reaches the old socket after the chat traffic.
    client
        .put_presence(&beta.ctx, &PresenceUpdate { status: "online".into(), ..PresenceUpdate::default() })
        .await
        .map_err(|e| format!("PUT /v1/presence as B: {e}"))?;
    expect_frame(&mut older, "the old socket hears the friend", |frame| frame.kind == "presence.updated").await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A suffix for display names, so a run that failed half way through does
/// not collide with the next one on a name the service still holds.
fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
        % 100_000
}

/// Deletes the accounts, so the service is as it was.
async fn delete_all(client: &OnlineClient, players: &[&Player]) {
    for player in players {
        match client.delete_me(&player.ctx).await {
            Ok(()) => println!("DELETE /v1/me for {} -> 204", player.name),
            Err(e) => println!("DELETE /v1/me for {} failed: {e}", player.name),
        }
    }
}

fn text_message(body: &str) -> NewMessage {
    NewMessage { client_id: new_client_id(), body: body.into(), ..NewMessage::default() }
}

async fn send(
    client: &OnlineClient,
    player: &Player,
    conversation_id: &str,
    body: &str,
) -> Result<crate::online::ChatMessage, String> {
    client
        .chat_send(&player.ctx, conversation_id, &text_message(body))
        .await
        .map_err(|e| format!("{} sends {body:?}: {e}", player.name))
}

fn find<'a>(conversations: &'a [Conversation], id: &str) -> Result<&'a Conversation, String> {
    conversations
        .iter()
        .find(|conversation| conversation.id == id)
        .ok_or_else(|| format!("the conversation {id} is missing from the sync document"))
}

/// The system events and bodies of the newest page the player sees.
async fn events_of(client: &OnlineClient, player: &Player, conversation_id: &str) -> Result<Vec<String>, String> {
    let page = client
        .chat_messages(&player.ctx, conversation_id, PageAnchor::Latest, None)
        .await
        .map_err(|e| format!("GET messages as {}: {e}", player.name))?;
    Ok(page
        .messages
        .iter()
        .map(|message| match message.system.as_ref() {
            Some(system) => system.event.clone(),
            None => message.body.clone(),
        })
        .collect())
}

/// `GET` as the player: the JSON exactly as the service wrote it.
async fn raw(client: &OnlineClient, player: &Player, path: &str) -> Result<Value, String> {
    client
        .request::<Value>(&player.ctx, Method::GET, path, None, Auth::Required)
        .await
        .map_err(|e| format!("GET {path} as {}: {e}", player.name))
}

/// Parses what the service sent into the core's type and checks that nothing
/// is lost or changed on the way: the core forwards its own serialization to
/// the windows, so a field it does not know, or reads under another name,
/// never reaches them. `null` and an absent field count as the same.
fn lossless<T: DeserializeOwned + Serialize>(what: &str, sent: &Value) -> Result<T, String> {
    let parsed: T =
        serde_json::from_value(sent.clone()).map_err(|e| format!("{what} does not parse in the launcher: {e}\n{sent}"))?;
    let mut forwarded = serde_json::to_value(&parsed).map_err(|e| format!("{what} does not serialize: {e}"))?;
    let mut sent = sent.clone();
    drop_nulls(&mut sent);
    drop_nulls(&mut forwarded);
    drop_admin_false(&mut forwarded);
    match first_difference(&sent, &forwarded, "") {
        None => Ok(parsed),
        Some(path) => Err(format!(
            "{what} changes on its way through the launcher at {path}:\n  service:  {sent}\n  launcher: {forwarded}"
        )),
    }
}

fn drop_nulls(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, field| !field.is_null());
            map.values_mut().for_each(drop_nulls);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_nulls),
        _ => {}
    }
}

/// `OnlineUser` is also the answer of `GET /v1/me`, the one place the
/// service says `admin`; a user of a chat document goes without it and reads
/// as `admin: false`, which is what the launcher then forwards.
fn drop_admin_false(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.contains_key("displayName") && map.get("admin") == Some(&Value::Bool(false)) {
                map.remove("admin");
            }
            map.values_mut().for_each(drop_admin_false);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_admin_false),
        _ => {}
    }
}

/// Where two documents first differ, as a JSON path.
fn first_difference(a: &Value, b: &Value, at: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(left), Value::Object(right)) => left
            .keys()
            .chain(right.keys())
            .find_map(|key| match (left.get(key), right.get(key)) {
                (Some(x), Some(y)) => first_difference(x, y, &format!("{at}.{key}")),
                (Some(_), None) => Some(format!("{at}.{key} (only the service sends it)")),
                _ => Some(format!("{at}.{key} (only the launcher has it)")),
            }),
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => left
            .iter()
            .zip(right)
            .enumerate()
            .find_map(|(index, (x, y))| first_difference(x, y, &format!("{at}[{index}]"))),
        _ if a == b => None,
        _ => Some(format!("{at} ({a} against {b})")),
    }
}

/// Checks a frame of the live socket the way the core reads it: `chat.*`
/// frames parse into the core's frames and lose nothing on the way.
fn check_frame(frame: &LiveFrame) -> Result<(), String> {
    use super::frames::{ReactionChange, ReadMark, Removal};
    use crate::online::{ChatMessage, ChatPrivacy, GroupInvite};

    if !frame.kind.starts_with("chat.") {
        return Ok(());
    }
    let what = format!("the frame {}", frame.kind);
    let parsed =
        frames::parse(&frame.kind, frame.payload.clone()).map_err(|e| format!("{what} does not parse: {e}\n{}", frame.payload))?;
    let payload = &frame.payload;
    let only = |keys: &[&str]| -> Result<(), String> {
        let mut sent: Vec<&str> = payload.as_object().map(|map| map.keys().map(String::as_str).collect()).unwrap_or_default();
        sent.sort_unstable();
        let mut wanted = keys.to_vec();
        wanted.sort_unstable();
        if sent == wanted {
            Ok(())
        } else {
            Err(format!("{what} carries {sent:?}, the launcher reads {wanted:?}"))
        }
    };
    match frame.kind.as_str() {
        "chat.message" => {
            only(&["message"])?;
            lossless::<ChatMessage>(&what, &payload["message"])?;
        }
        "chat.read" => {
            lossless::<ReadMark>(&what, payload)?;
        }
        "chat.typing" => only(&["conversationId", "userId", "ttlMs"])?,
        "chat.reaction" => {
            lossless::<ReactionChange>(&what, payload)?;
        }
        "chat.conversation" => {
            only(&["conversation"])?;
            lossless::<Conversation>(&what, &payload["conversation"])?;
        }
        "chat.conversation.removed" => {
            let removal: Removal = lossless(&what, payload)?;
            if !matches!(removal.reason.as_str(), "left" | "removed" | "ended" | "account_deleted") {
                return Err(format!("{what} names the reason {:?}", removal.reason));
            }
        }
        "chat.groupInvite" => {
            only(&["invite"])?;
            lossless::<GroupInvite>(&what, &payload["invite"])?;
        }
        "chat.groupInvite.removed" => only(&["conversationId"])?,
        "chat.settings" => {
            only(&["settings"])?;
            lossless::<ChatPrivacy>(&what, &payload["settings"])?;
        }
        "chat.resync" => {}
        _ => {}
    }
    if matches!(parsed, Frame::Unknown(_)) {
        return Err(format!("{what} is a chat frame the launcher does not know"));
    }
    Ok(())
}

async fn open(player: &Player) -> Result<Socket, String> {
    let request = upgrade_request(&player.ctx)?;
    let (socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("GET /v1/ws as {}: {e}", player.name))?;
    println!("GET /v1/ws as {} -> {}", player.name, response.status().as_u16());
    Ok(socket)
}

/// The socket of a launcher up to 0.6.0, which does not ask for chat.
async fn open_without_chat(player: &Player) -> Result<Socket, String> {
    let mut request = upgrade_request(&player.ctx)?;
    request.headers_mut().remove("x-jknet-features");
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("GET /v1/ws without chat as {}: {e}", player.name))?;
    Ok(socket)
}

/// Sends the typing hint the core sends.
async fn type_in(socket: &mut Socket, conversation_id: &str) -> Result<(), String> {
    socket
        .send(Message::Text(typing_frame(conversation_id).into()))
        .await
        .map_err(|e| format!("cannot send the typing hint: {e}"))
}

/// The gap the service keeps between two typing hints of one socket for one
/// conversation, and a little more.
const TYPING_GAP: Duration = Duration::from_millis(3200);

/// Reads frames, answering pings, until one is `wanted` or `within` runs
/// out; `None` when it runs out. Every chat frame on the way is checked.
async fn wait_for(
    socket: &mut Socket,
    within: Duration,
    wanted: impl Fn(&LiveFrame) -> bool,
) -> Result<Option<LiveFrame>, String> {
    let (mut seen, found) = frames_until(socket, within, wanted).await?;
    Ok(if found { seen.pop() } else { None })
}

/// A frame that must come.
async fn expect_frame(
    socket: &mut Socket,
    what: &str,
    wanted: impl Fn(&LiveFrame) -> bool,
) -> Result<LiveFrame, String> {
    wait_for(socket, FRAME_TIMEOUT, wanted)
        .await?
        .ok_or_else(|| format!("never came: {what}"))
}

/// Whether a frame that must not come came within [`QUIET`].
async fn quiet(socket: &mut Socket, unwanted: impl Fn(&LiveFrame) -> bool) -> Result<bool, String> {
    Ok(wait_for(socket, QUIET, unwanted).await?.is_some())
}

/// The frames read until `wanted` accepted one, that one last, and whether
/// it came before `within` ran out.
async fn frames_until(
    socket: &mut Socket,
    within: Duration,
    wanted: impl Fn(&LiveFrame) -> bool,
) -> Result<(Vec<LiveFrame>, bool), String> {
    let deadline = tokio::time::Instant::now() + within;
    let mut seen = Vec::new();
    loop {
        let next = match tokio::time::timeout_at(deadline, socket.next()).await {
            Err(_) => return Ok((seen, false)),
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
        check_frame(&frame)?;
        let done = wanted(&frame);
        seen.push(frame);
        if done {
            return Ok((seen, true));
        }
    }
}
