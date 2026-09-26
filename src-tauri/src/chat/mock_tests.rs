//! Chat against `scripts/mock-online.mjs`, over real HTTP and a real socket.
//!
//! The unit tests of this module check the rules; these check that the
//! paths, bodies, status codes, refusal reasons and frames line up with an
//! implementation of the contract. The mock is a stand-in written from the
//! same specification, so agreeing with it proves the shapes, not the
//! service: `online_tests.rs` walks the real one.
//!
//! Ignored because they need Node on `PATH` and free ports. Run them by hand:
//!
//! ```text
//! cargo test --lib -- --ignored --nocapture chat::mock_tests
//! ```

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::error::AppError;
use crate::friends::live::upgrade_request;
use crate::online::mock_tests::MockOnline;
use crate::online::{
    Conversation, LiveFrame, NewMessage, OnlineClient, OnlineContext, OnlineUser, PageAnchor,
    SearchQuery,
};

use super::frames::{self, Frame};
use super::outbox::OutboxEntry;
use super::{new_client_id, typing_frame, ChatState, SendDraft};

/// Past the ports of `online::mock_tests`, `friends::live` and `bundles`.
const PORT_FRAMES: u16 = 8801;
const PORT_OPT_IN: u16 = 8802;
const PORT_ROUTES: u16 = 8803;

/// How long a frame the test waits for may take.
const FRAME_TIMEOUT: Duration = Duration::from_secs(10);

type Socket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// A token and the account it belongs to, without the browser round trip.
async fn sign_in(mock: &MockOnline) -> (OnlineContext, OnlineUser) {
    let text = reqwest::Client::new()
        .post(format!("{}/v1/dev/token", mock.base_url()))
        .send()
        .await
        .expect("the mock answers")
        .text()
        .await
        .expect("a body");
    let answer: serde_json::Value = serde_json::from_str(&text).expect("JSON");
    let token = answer["token"].as_str().expect("a token").to_string();
    let user: OnlineUser = serde_json::from_value(answer["user"].clone()).expect("a user");
    (
        OnlineContext {
            base_url: mock.base_url(),
            token: Some(token),
        },
        user,
    )
}

async fn open_socket(ctx: &OnlineContext, chat: bool) -> Socket {
    let mut request = upgrade_request(ctx).expect("a signed-in context has a socket");
    if !chat {
        // What a launcher up to 0.6.0 sends.
        request.headers_mut().remove("x-jknet-features");
    }
    tokio_tungstenite::connect_async(request)
        .await
        .expect("the mock accepts the socket")
        .0
}

/// Reads frames, answering pings, until `wanted` accepts one or the time is
/// up. Answers the frames seen on the way, the accepted one last.
async fn read_until(
    socket: &mut Socket,
    within: Duration,
    mut wanted: impl FnMut(&LiveFrame) -> bool,
) -> (Vec<LiveFrame>, bool) {
    let deadline = tokio::time::Instant::now() + within;
    let mut seen = Vec::new();
    loop {
        let next = match tokio::time::timeout_at(deadline, socket.next()).await {
            Err(_) => return (seen, false),
            Ok(next) => next,
        };
        let Some(Ok(Message::Text(text))) = next else {
            continue;
        };
        let frame: LiveFrame = serde_json::from_str(&text).expect("a frame of the contract");
        if frame.kind == "ping" {
            socket
                .send(Message::Text("{\"type\":\"pong\"}".into()))
                .await
                .expect("the pong goes out");
            continue;
        }
        let done = wanted(&frame);
        seen.push(frame);
        if done {
            return (seen, true);
        }
    }
}

fn direct_with(conversations: &[Conversation], user_id: &str) -> Conversation {
    conversations
        .iter()
        .find(|c| c.kind == "direct" && c.members.iter().any(|m| m.user.id == user_id))
        .cloned()
        .expect("the seeded conversation")
}

fn code_of<T: std::fmt::Debug>(result: Result<T, AppError>) -> String {
    match result {
        Err(AppError::Online { code, .. }) => code,
        other => panic!("expected a refusal of the service, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn a_sent_message_comes_back_on_the_socket_and_settles_the_outbox() {
    let mock = MockOnline::start_with(PORT_FRAMES, &[("MOCK_ONLINE_CHAT_REPLY_MS", "400")]);
    let (ctx, me) = sign_in(&mock).await;
    let client = OnlineClient::new();
    let mut socket = open_socket(&ctx, true).await;

    let doc = client.chat_sync(&ctx).await.expect("the sync document");
    let friends = client.get_friends(&ctx).await.expect("the friends");
    let kyle = &friends.friends[0].user;
    let dm = direct_with(&doc.conversations, &kyle.id);

    // The core queues first and sends second; the frame of the message is
    // what settles the entry even when the answer is lost.
    let chat = ChatState::default();
    chat.book().replace(doc);
    let client_id = new_client_id();
    chat.outbox().push(OutboxEntry::new(
        &client_id,
        &dm.id,
        SendDraft { body: "gg".into(), ..SendDraft::default() },
    ));
    let sent = client
        .chat_send(
            &ctx,
            &dm.id,
            &NewMessage { client_id: client_id.clone(), body: "gg".into(), ..NewMessage::default() },
        )
        .await
        .expect("the message is stored");
    assert_eq!(sent.seq, dm.last_seq + 1);
    assert_eq!(sent.client_id.as_deref(), Some(client_id.as_str()));

    let (frames_seen, found) = read_until(&mut socket, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["clientId"] == client_id.as_str()
    })
    .await;
    assert!(found, "no chat.message for the send: {:?}", frames_seen.iter().map(|f| &f.kind).collect::<Vec<_>>());
    let frame = frames_seen.last().expect("the frame").clone();
    let parsed = frames::parse(&frame.kind, frame.payload).expect("the frame parses");
    let Frame::Message(message) = parsed.clone() else {
        panic!("expected a message, got {parsed:?}");
    };
    assert_eq!(message.seq, sent.seq);
    frames::apply(&chat, Some(&me.id), parsed, Instant::now());
    assert!(chat.outbox().all().is_empty(), "the frame settled the entry");
    assert_eq!(chat.book().get(&dm.id).map(|c| (c.last_seq, c.unread)), Some((sent.seq, 0)));

    // Kyle reads it, types and answers: three frames of the contract from a
    // real socket, and the answer counts as unread.
    let (seen, answered) = read_until(&mut socket, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.message" && frame.payload["message"]["senderId"] == kyle.id.as_str()
    })
    .await;
    assert!(answered, "Kyle never answered");
    let kinds: Vec<&str> = seen.iter().map(|frame| frame.kind.as_str()).collect();
    assert!(kinds.contains(&"chat.read") && kinds.contains(&"chat.typing"), "{kinds:?}");
    for frame in seen {
        let parsed = frames::parse(&frame.kind, frame.payload).expect("every frame parses");
        frames::apply(&chat, Some(&me.id), parsed, Instant::now());
    }
    let summary = chat.book().get(&dm.id).cloned().expect("known");
    assert_eq!(summary.unread, 1);
    let kyle_marker = summary.members.iter().find(|m| m.user.id == kyle.id).and_then(|m| m.read_seq);
    assert!(kyle_marker >= Some(sent.seq), "Kyle's read marker {kyle_marker:?}");

    // The typing hint of the core reaches the service over the same socket.
    socket
        .send(Message::Text(typing_frame(&dm.id).into()))
        .await
        .expect("the hint goes out");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let text = reqwest::Client::new()
        .get(format!("{}/v1/dev/chat/typing", mock.base_url()))
        .bearer_auth(ctx.token.as_deref().unwrap_or_default())
        .send()
        .await
        .expect("the mock answers")
        .text()
        .await
        .expect("a body");
    assert!(text.contains(&dm.id), "{text}");
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn only_a_socket_that_asks_for_chat_hears_chat() {
    let mock = MockOnline::start_with(PORT_OPT_IN, &[("MOCK_ONLINE_CHAT_REPLY_MS", "0")]);
    let (ctx, _) = sign_in(&mock).await;
    let client = OnlineClient::new();
    let mut modern = open_socket(&ctx, true).await;
    let mut older = open_socket(&ctx, false).await;

    let doc = client.chat_sync(&ctx).await.expect("the sync document");
    let dm = doc
        .conversations
        .iter()
        .find(|c| c.kind == "direct" && c.can_send)
        .expect("a conversation to write in");
    client
        .chat_send(
            &ctx,
            &dm.id,
            &NewMessage { client_id: new_client_id(), body: "hi".into(), ..NewMessage::default() },
        )
        .await
        .expect("sent");

    let (_, heard) = read_until(&mut modern, FRAME_TIMEOUT, |f| f.kind == "chat.message").await;
    assert!(heard, "the socket that asked for chat heard nothing");
    let (seen, _) = read_until(&mut older, Duration::from_secs(2), |_| false).await;
    assert!(
        seen.iter().all(|frame| !frame.kind.starts_with("chat.")),
        "a socket without the header got {:?}",
        seen.iter().map(|f| &f.kind).collect::<Vec<_>>()
    );
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn the_chat_routes_answer_in_the_shapes_of_the_contract() {
    let mock = MockOnline::start_with(PORT_ROUTES, &[("MOCK_ONLINE_CHAT_REPLY_MS", "0")]);
    let (ctx, me) = sign_in(&mock).await;
    let client = OnlineClient::new();
    let friends = client.get_friends(&ctx).await.expect("the friends").friends;
    let named = |name: &str| {
        friends
            .iter()
            .find(|friend| friend.user.display_name.starts_with(name))
            .map(|friend| friend.user.id.clone())
            .expect("a seeded friend")
    };
    let (kyle, jan, mara) = (named("Kyle"), named("Jan"), named("Mara"));

    // -- The sync document --------------------------------------------------
    let doc = client.chat_sync(&ctx).await.expect("the sync document");
    assert_eq!(doc.conversations.len(), 4);
    assert_eq!(doc.group_invites.len(), 1);
    let school = doc
        .conversations
        .iter()
        .find(|c| c.kind == "group")
        .cloned()
        .expect("Saber school");
    assert_eq!((school.unread, school.unread_mentions), (3, 1));
    let gone = doc
        .conversations
        .iter()
        .find(|c| c.kind == "direct" && c.members.len() == 1)
        .cloned()
        .expect("the conversation with a deleted account");
    assert!(!gone.can_send);

    // D3: read-only, and the reason says why.
    let refused = client
        .chat_send(
            &ctx,
            &gone.id,
            &NewMessage { client_id: new_client_id(), body: "hello?".into(), ..NewMessage::default() },
        )
        .await;
    assert_eq!(code_of(refused), "not_friends");

    // -- Direct ---------------------------------------------------------------
    let dm = client.chat_open_direct(&ctx, &kyle).await.expect("the direct conversation");
    assert_eq!(dm.id, direct_with(&doc.conversations, &kyle).id, "the same one again");
    assert_eq!(code_of(client.chat_open_direct(&ctx, "01HNOBODY0000000000000000").await), "not_found");

    // -- History --------------------------------------------------------------
    let latest = client
        .chat_messages(&ctx, &school.id, PageAnchor::Latest, Some(3))
        .await
        .expect("a page");
    assert_eq!(latest.messages.iter().map(|m| m.seq).collect::<Vec<_>>(), [5, 6, 7]);
    assert!(latest.has_before && !latest.has_after);
    let older = client
        .chat_messages(&ctx, &school.id, PageAnchor::Before(5), Some(2))
        .await
        .expect("a page");
    assert_eq!(older.messages.iter().map(|m| m.seq).collect::<Vec<_>>(), [3, 4]);
    // The message of the deleted account, the system message of its leaving,
    // the reply to it and the token that named it.
    assert_eq!(older.messages[0].sender_id, None);
    assert!(older.messages[0].is_user());
    assert_eq!(older.messages[1].system.as_ref().map(|s| s.user_id.clone()), Some(None));
    let around = client
        .chat_messages(&ctx, &school.id, PageAnchor::Around(5), Some(3))
        .await
        .expect("a page");
    assert_eq!(around.messages.iter().map(|m| m.seq).collect::<Vec<_>>(), [4, 5, 6]);
    let reply = around.messages[1].reply_to.as_ref().expect("a reply");
    assert_eq!((reply.seq, reply.sender_id.clone(), reply.missing), (3, None, false));
    assert!(around.messages[2].body.contains("<@deleted>"), "{}", around.messages[2].body);
    let newer = client
        .chat_messages(&ctx, &school.id, PageAnchor::After(6), None)
        .await
        .expect("a page");
    assert_eq!(newer.messages.iter().map(|m| m.seq).collect::<Vec<_>>(), [7]);
    assert!(newer.messages[0].mentions.contains(&me.id));

    // -- Send, replay, read, react, notify -------------------------------------
    let client_id = new_client_id();
    let message = NewMessage {
        client_id: client_id.clone(),
        body: "gg <@01HNOBODY0000000000000000>".into(),
        reply_seq: Some(7),
        ..NewMessage::default()
    };
    let sent = client.chat_send(&ctx, &school.id, &message).await.expect("stored");
    assert_eq!(sent.seq, 8);
    assert!(sent.mentions.contains(&kyle), "a reply mentions its author");
    assert!(!sent.body.contains("<@"), "a token of a stranger is rewritten: {}", sent.body);
    let replayed = client.chat_send(&ctx, &school.id, &message).await.expect("replayed");
    assert_eq!(replayed.seq, sent.seq, "a replay is the stored message");
    assert_eq!(client.chat_read(&ctx, &school.id, 999).await.expect("read"), 8);

    let reactions = client
        .chat_react(&ctx, &school.id, 6, "🔥", true)
        .await
        .expect("reacted");
    assert!(reactions.iter().any(|r| r.emoji == "🔥" && r.user_ids.contains(&me.id)));
    assert_eq!(code_of(client.chat_react(&ctx, &school.id, 6, "no", true).await), "invalid");
    let muted = client.chat_set_notify(&ctx, &school.id, "mute").await.expect("muted");
    assert_eq!(muted.notify, "mute");

    // -- Groups: owner-only rename and history setting (D1, D5) ----------------
    assert_eq!(
        code_of(client.chat_patch_group(&ctx, &school.id, Some("Mine now"), None).await),
        "owner_only"
    );
    let group_client_id = new_client_id();
    let created = client
        .chat_create_group(
            &ctx,
            &group_client_id,
            Some("Duel night"),
            &[kyle.clone(), mara.clone(), "01HSTRANGER000000000000000".into()],
        )
        .await
        .expect("a group");
    assert_eq!(created.added, std::slice::from_ref(&kyle));
    assert_eq!(created.invited, std::slice::from_ref(&mara), "Mara asks before she is added");
    assert_eq!(created.refused[0].reason, "not_friend");
    let again = client
        .chat_create_group(&ctx, &group_client_id, Some("Duel night"), &[])
        .await
        .expect("a replay");
    assert_eq!(again.conversation.id, created.conversation.id);
    let renamed = client
        .chat_patch_group(&ctx, &created.conversation.id, Some("Duel night 2"), Some(true))
        .await
        .expect("the owner renames");
    assert_eq!(renamed.title.as_deref(), Some("Duel night 2"));
    assert!(renamed.history_for_new_members);
    let added = client
        .chat_add_members(&ctx, &created.conversation.id, &[jan.clone(), kyle.clone()])
        .await
        .expect("added");
    assert_eq!(added.added, std::slice::from_ref(&jan));
    assert_eq!(added.refused[0].reason, "member");

    // Joining by invite: history is off there, so only the join and after.
    let raid = client
        .chat_join_group(&ctx, &doc.group_invites[0].conversation_id)
        .await
        .expect("joined");
    assert!(raid.visible_from_seq > 0 && raid.visible_from_seq == raid.last_seq - 1);

    // -- Server chats ------------------------------------------------------------
    let session = "5e0b7c1f9a2d4c38";
    let guest = client.chat_join_server(&ctx, session, &jan).await.expect("joined Jan's server chat");
    assert_eq!(guest.kind, "server");
    assert_eq!(guest.server.as_ref().map(|s| s.host_id.clone()), Some(jan.clone()));
    assert_eq!(guest.visible_from_seq, guest.last_seq - 1, "a guest sees from the join");
    assert_eq!(code_of(client.chat_patch_server(&ctx, session, true).await), "owner_only");
    assert_eq!(code_of(client.chat_open_server(&ctx, "0000000000000000").await), "not_hosting");

    // -- Search ------------------------------------------------------------------
    let search = |q: &str, conversation_id: Option<&str>| SearchQuery {
        q: q.into(),
        conversation_id: conversation_id.map(str::to_string),
        ..SearchQuery::default()
    };
    let found = client.chat_search(&ctx, &search("KATA", None)).await.expect("results");
    assert_eq!(found.results.len(), 1);
    assert!(found.results[0].message.body.contains("<@deleted>"));
    assert_eq!(code_of(client.chat_search(&ctx, &search("gg", None)).await), "invalid");
    client
        .chat_search(&ctx, &search("gg", Some(&school.id)))
        .await
        .expect("two letters within one conversation");

    // -- Files -------------------------------------------------------------------
    let png: Vec<u8> = [&b"\x89PNG\r\n\x1a\n"[..], &[0u8; 56][..]].concat();
    let sha256 = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&png)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let registered = client
        .chat_register_file(&ctx, &dm.id, "shot.png", png.len() as u64, &sha256, None)
        .await
        .expect("registered");
    assert!(registered.needs_upload);
    let uploaded = client
        .chat_upload_file(&ctx, &registered.file.id, png.len() as u64, png.clone().into())
        .await
        .expect("uploaded");
    assert_eq!((uploaded.file.class.as_str(), uploaded.file.media_type.as_str()), ("image", "image/png"));
    let again = client
        .chat_register_file(&ctx, &dm.id, "copy.png", png.len() as u64, &sha256, None)
        .await
        .expect("registered again");
    assert!(!again.needs_upload, "the account already stored these bytes");
    let with_file = client
        .chat_send(
            &ctx,
            &dm.id,
            &NewMessage {
                client_id: new_client_id(),
                body: String::new(),
                file_ids: vec![registered.file.id.clone()],
                ..NewMessage::default()
            },
        )
        .await
        .expect("a message with a file");
    assert_eq!(with_file.files[0].name, "shot.png");
    let whole = client
        .chat_file_content(&ctx, &registered.file.id, 0)
        .await
        .expect("the download")
        .bytes()
        .await
        .expect("the bytes");
    assert_eq!(whole.as_ref(), png.as_slice());
    let tail = client
        .chat_file_content(&ctx, &registered.file.id, 8)
        .await
        .expect("the tail");
    assert_eq!(tail.status().as_u16(), 206);
    // Sent once, the file is spent: a second message may not carry it.
    let spent = client
        .chat_send(
            &ctx,
            &dm.id,
            &NewMessage {
                client_id: new_client_id(),
                body: "again".into(),
                file_ids: vec![registered.file.id.clone()],
                ..NewMessage::default()
            },
        )
        .await;
    assert_eq!(code_of(spent), "file_not_ready");

    // -- Privacy (D8) ------------------------------------------------------------
    let hidden = client
        .chat_update_settings(
            &ctx,
            &crate::online::ChatPrivacyPatch {
                share_read_receipts: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("saved");
    assert!(!hidden.share_read_receipts && hidden.share_typing);
    let doc = client.chat_sync(&ctx).await.expect("the sync document");
    let school = doc.conversations.iter().find(|c| c.id == school.id).expect("Saber school");
    for member in &school.members {
        if member.user.id == me.id {
            assert!(member.read_seq.is_some(), "the player's own marker stays");
        } else {
            assert_eq!(member.read_seq, None, "{} is hidden both ways", member.user.display_name);
        }
    }
    assert_eq!(client.chat_settings(&ctx).await.expect("read back"), hidden);

    // -- Leaving -----------------------------------------------------------------
    client
        .chat_remove_member(&ctx, &created.conversation.id, &me.id)
        .await
        .expect("left");
    assert_eq!(
        code_of(client.chat_conversation(&ctx, &created.conversation.id).await),
        "not_found"
    );
}
