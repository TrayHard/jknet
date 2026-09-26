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
    ChatMessage, Conversation, HostingInfo, LiveFrame, NewMessage, OnlineClient, OnlineContext,
    OnlineUser, PageAnchor, PresenceUpdate, SearchQuery, ServerChatRef,
};

use super::files::{self, test_support::jpeg_with_gps, LocalStatus};
use super::frames::{self, Frame};
use super::outbox::OutboxEntry;
use super::{new_client_id, typing_frame, ChatState, SendDraft};

/// Past the ports of `online::mock_tests`, `friends::live` and `bundles`.
const PORT_FRAMES: u16 = 8801;
const PORT_OPT_IN: u16 = 8802;
const PORT_ROUTES: u16 = 8803;
const PORT_FILES: u16 = 8804;
const PORT_CARDS: u16 = 8805;
const PORT_SERVER: u16 = 8806;

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
    // The service names the cause: not one emoji.
    assert_eq!(code_of(client.chat_react(&ctx, &school.id, 6, "no", true).await), "emoji");
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

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn a_file_goes_up_stripped_and_comes_back_resumed_and_checked() {
    let mock = MockOnline::start_with(PORT_FILES, &[("MOCK_ONLINE_CHAT_REPLY_MS", "0")]);
    let (ctx, _) = sign_in(&mock).await;
    let client = OnlineClient::new();
    let doc = client.chat_sync(&ctx).await.expect("the sync document");
    let dm = doc
        .conversations
        .iter()
        .find(|c| c.kind == "direct" && c.can_send)
        .cloned()
        .expect("a conversation to write in");
    let temp = tempfile::tempdir().expect("a temp dir");

    // Staged: the position is gone before a byte leaves.
    let (staged, file) = files::stage_bytes(
        &temp.path().join("staging"),
        "IMG_0001.JPG",
        jpeg_with_gps(),
        "file",
        None,
    )
    .expect("staged");
    let sent_bytes = std::fs::read(&staged.path).expect("the staged copy");
    let file_id = files::put_staged(&client, &ctx, &dm.id, &staged, |_| {})
        .await
        .expect("registered and uploaded");
    let message = client
        .chat_send(
            &ctx,
            &dm.id,
            &NewMessage {
                client_id: new_client_id(),
                file_ids: vec![file_id.clone()],
                ..NewMessage::default()
            },
        )
        .await
        .expect("a message with the file");
    let sent = &message.files[0];
    assert_eq!((sent.name.as_str(), sent.size, sent.class.as_str()), (file.name.as_str(), staged.size, "image"));

    // Down, whole, checked against the ETag.
    let mut quiet = |_: u64, _: u64| {};
    let whole = files::fetch(&client, &ctx, &temp.path().join("whole"), &file_id, &mut quiet)
        .await
        .expect("downloaded");
    assert_eq!(std::fs::read(&whole).expect("the cached copy"), sent_bytes);

    // Resumed from a partial download.
    let resumed_dir = temp.path().join("resumed");
    std::fs::create_dir_all(&resumed_dir).expect("the folder");
    std::fs::write(resumed_dir.join(format!("{file_id}.part")), &sent_bytes[..100]).expect("a partial file");
    let mut seen: Vec<u64> = Vec::new();
    let mut record = |received: u64, _: u64| seen.push(received);
    let resumed = files::fetch(&client, &ctx, &resumed_dir, &file_id, &mut record)
        .await
        .expect("resumed");
    assert_eq!(std::fs::read(&resumed).expect("the cached copy"), sent_bytes);
    assert_eq!(seen.first(), Some(&100), "it went on from the partial file");

    // A partial file that does not belong: the hash catches the splice, the
    // partial file goes, and the next attempt starts over.
    let spoiled_dir = temp.path().join("spoiled");
    std::fs::create_dir_all(&spoiled_dir).expect("the folder");
    let spoiled = spoiled_dir.join(format!("{file_id}.part"));
    std::fs::write(&spoiled, vec![b'x'; 100]).expect("a partial file");
    let refused = files::fetch(&client, &ctx, &spoiled_dir, &file_id, &mut quiet).await;
    assert!(matches!(refused, Err(AppError::Network(ref reason)) if reason.contains("hash")), "{refused:?}");
    assert!(!spoiled.exists());
    let again = files::fetch(&client, &ctx, &spoiled_dir, &file_id, &mut quiet)
        .await
        .expect("started over");
    assert_eq!(std::fs::read(&again).expect("the cached copy"), sent_bytes);

    // The service lost the bytes: the file is gone, not merely remote.
    let status = reqwest::Client::new()
        .post(format!("{}/v1/dev/chat/files/{file_id}/lose", mock.base_url()))
        .bearer_auth(ctx.token.as_deref().unwrap_or_default())
        .send()
        .await
        .expect("the mock answers")
        .status();
    assert_eq!(status.as_u16(), 200);
    let lost = files::fetch(&client, &ctx, &temp.path().join("lost"), &file_id, &mut quiet).await;
    let error = lost.expect_err("the bytes are gone");
    assert_eq!(files::status_after(&error), LocalStatus::Gone);
    assert_eq!(code_of(Err::<(), _>(error)), "file_gone");
    // And registering the same bytes again asks for them, since the lost
    // copy cannot spare the upload.
    let registered = client
        .chat_register_file(&ctx, &dm.id, &staged.name, staged.size, &staged.sha256, staged.meta.as_ref())
        .await
        .expect("registered again");
    assert!(registered.needs_upload);
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn every_card_kind_passes_the_checks_and_opens_in_its_editor() {
    use super::cards::{self, Card};
    use crate::game::Game;

    let mock = MockOnline::start_with(PORT_CARDS, &[("MOCK_ONLINE_CHAT_REPLY_MS", "0")]);
    let (ctx, _me) = sign_in(&mock).await;
    let client = OnlineClient::new();

    // Kyle posts one message per card kind, as his launcher builds them.
    let text = reqwest::Client::new()
        .post(format!("{}/v1/dev/chat", mock.base_url()))
        .bearer_auth(ctx.token.as_deref().unwrap_or_default())
        .header("content-type", "application/json")
        .body(r#"{"cards":"all"}"#)
        .send()
        .await
        .expect("the mock answers")
        .text()
        .await
        .expect("a body");
    let posted: Vec<ChatMessage> = serde_json::from_str(&text).expect("the posted messages");
    let mut kinds = Vec::new();
    for message in &posted {
        for raw in &message.cards {
            let card = cards::check(raw).unwrap_or_else(|e| panic!("{raw} passes: {e}"));
            kinds.push(raw["type"].as_str().unwrap_or_default().to_string());
            match &card {
                Card::Profile(profile) => {
                    let form = cards::profile_from_card(profile);
                    assert!(form.skipped.is_empty(), "{:?}", form.skipped);
                    assert_eq!(form.profile.nickname.as_deref(), Some("^4Kyle"));
                }
                Card::Bind(_) | Card::Config(_) => {
                    let opened = cards::config_from_card(&card, Game::JediAcademy).expect("opens");
                    assert!(!opened.document.text.is_empty());
                    assert!(!opened.dangers.is_empty(), "the showcase holds a dangerous line");
                }
                _ => {}
            }
        }
    }
    assert_eq!(
        kinds,
        ["server", "bundle", "jkhubMod", "map", "profile", "bind", "config"]
    );

    // The host invite of Jan's seeded conversation reads as a card too, with
    // its host and no way into the server.
    let doc = client.chat_sync(&ctx).await.expect("the sync document");
    let friends = client.get_friends(&ctx).await.expect("the friends").friends;
    let jan = friends
        .iter()
        .find(|friend| friend.user.display_name.starts_with("Jan"))
        .map(|friend| friend.user.id.clone())
        .expect("Jan");
    let with_jan = direct_with(&doc.conversations, &jan);
    let invite = with_jan
        .last_message
        .as_ref()
        .and_then(|message| message.cards.first())
        .expect("Jan's card");
    match cards::check(invite).expect("passes") {
        Card::HostInvite(card) => assert_eq!(card.host_id.as_deref(), Some(jan.as_str())),
        other => panic!("a host invite, not {other:?}"),
    }

    // A card built here goes out and comes back as it was built.
    let built = cards::prepare(&[serde_json::json!({ "type": "map", "game": "ja", "name": "mp/ffa3" })])
        .expect("a map card");
    let sent = client
        .chat_send(
            &ctx,
            &with_jan.id,
            &NewMessage { client_id: new_client_id(), cards: built.clone(), ..NewMessage::default() },
        )
        .await
        .expect("stored");
    assert_eq!(sent.cards, built);
}

/// What a guest of the cast sees after `POST /v1/dev/chat/servers/:id/join`.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuestView {
    visible_from_seq: u64,
    seqs: Vec<u64>,
}

/// A friend of the cast joins the chat of the server the account hosts.
async fn guest_joins(mock: &MockOnline, ctx: &OnlineContext, session: &str, user_id: &str) -> GuestView {
    let text = reqwest::Client::new()
        .post(format!("{}/v1/dev/chat/servers/{session}/join", mock.base_url()))
        .bearer_auth(ctx.token.as_deref().unwrap_or_default())
        .header("content-type", "application/json")
        .body(serde_json::json!({ "userId": user_id }).to_string())
        .send()
        .await
        .expect("the mock answers")
        .text()
        .await
        .expect("a body");
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{text}: {e}"))
}

/// The heartbeat of a launcher that hosts `hosting`, or nothing.
async fn heartbeat(client: &OnlineClient, ctx: &OnlineContext, hosting: Option<HostingInfo>) {
    let update = PresenceUpdate {
        status: "online".into(),
        hosting,
        ..PresenceUpdate::default()
    };
    client.put_presence(ctx, &update).await.expect("the heartbeat is stored");
}

fn hosting_of(session: &str) -> HostingInfo {
    HostingInfo {
        session_id: session.into(),
        game: "ja".into(),
        map: Some("mp/ffa3".into()),
        max_players: 8,
        lan_addresses: vec!["192.168.1.23:29070".into()],
        password: Some("k7m2q9xa".into()),
        join_policy: "friends".into(),
        join_user_ids: Some(Vec::new()),
        ..HostingInfo::default()
    }
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn a_server_chat_opens_with_the_server_takes_its_guests_and_ends_with_it() {
    use super::server::{self, OpenPlan, Opened, ServerChats};

    let mock = MockOnline::start_with(PORT_SERVER, &[("MOCK_ONLINE_CHAT_REPLY_MS", "0")]);
    let (ctx, me) = sign_in(&mock).await;
    let client = OnlineClient::new();
    let mut socket = open_socket(&ctx, true).await;
    let friends = client.get_friends(&ctx).await.expect("the friends").friends;
    let named = |name: &str| {
        friends
            .iter()
            .find(|friend| friend.user.display_name.starts_with(name))
            .map(|friend| friend.user.id.clone())
            .expect("a seeded friend")
    };
    let (kyle, jan, mara) = (named("Kyle"), named("Jan"), named("Mara"));
    let session = "0123456789abcdef";
    let mut chats = ServerChats::default();

    // -- The host: the chat opens once a heartbeat carried the server ---------
    assert_eq!(code_of(client.chat_open_server(&ctx, session).await), "not_hosting");
    heartbeat(&client, &ctx, Some(hosting_of(session))).await;
    assert_eq!(chats.plan_open(session, |_| false), OpenPlan::Open { superseded: None });
    let opened = client.chat_open_server(&ctx, session).await.expect("the chat opens");
    assert_eq!(chats.opened(session, &opened.id), Opened::Keep);
    assert_eq!(opened.kind, "server");
    assert_eq!(
        opened.server,
        Some(ServerChatRef { host_id: me.id.clone(), session_id: session.into() })
    );
    assert!(!opened.history_for_new_members, "a new server chat starts with history off (D1)");
    let again = client.chat_open_server(&ctx, session).await.expect("opened again");
    assert_eq!(again.id, opened.id, "the open of an open chat answers it");
    assert_eq!(chats.plan_open(session, |id| id == opened.id), OpenPlan::Nothing);

    // -- Guests: history only from the join, until the host turns it on (D1) --
    client
        .chat_send(
            &ctx,
            &opened.id,
            &NewMessage { client_id: new_client_id(), body: "warming up".into(), ..NewMessage::default() },
        )
        .await
        .expect("the host writes");
    let kyle_sees = guest_joins(&mock, &ctx, session, &kyle).await;
    assert_eq!(kyle_sees.seqs.len(), 1, "Kyle sees his join message only: {kyle_sees:?}");
    assert_eq!(kyle_sees.visible_from_seq, kyle_sees.seqs[0] - 1);
    let on = client.chat_patch_server(&ctx, session, true).await.expect("the host switches");
    assert!(on.history_for_new_members);
    let mara_sees = guest_joins(&mock, &ctx, session, &mara).await;
    assert_eq!(mara_sees.visible_from_seq, 0);
    assert_eq!(mara_sees.seqs.first(), Some(&1), "Mara sees the chat from its start");
    let kyle_again = guest_joins(&mock, &ctx, session, &kyle).await;
    assert_eq!(kyle_again.visible_from_seq, kyle_sees.visible_from_seq, "Kyle keeps what he saw");

    // -- A guest of a friend's server: joined, and the switch is not theirs ---
    let jan_session = "5e0b7c1f9a2d4c38";
    let guest = server::retry_join(&[Duration::from_millis(10); 3], || {
        client.chat_join_server(&ctx, jan_session, &jan)
    })
    .await
    .expect("joined Jan's server chat");
    assert_eq!(guest.server.as_ref().map(|s| s.host_id.as_str()), Some(jan.as_str()));
    assert_eq!(guest.visible_from_seq, guest.last_seq - 1, "a guest sees from the join");
    assert_eq!(code_of(client.chat_patch_server(&ctx, jan_session, true).await), "owner_only");
    // A host with no chat for that session: asked four times, then given up.
    let mut asked = 0;
    let missing = server::retry_join(&[Duration::from_millis(10); 3], || {
        asked += 1;
        client.chat_join_server(&ctx, "ffffffffffffffff", &jan)
    })
    .await;
    assert_eq!((code_of(missing), asked), ("not_found".to_string(), 4));

    // -- The guest leaves (D9) ------------------------------------------------
    client
        .chat_remove_member(&ctx, &guest.id, &me.id)
        .await
        .expect("left Jan's server chat");
    assert_eq!(code_of(client.chat_conversation(&ctx, &guest.id).await), "not_found");

    // -- The server stops: the chat ends for everybody --------------------------
    assert_eq!(chats.closing(session), Some(opened.id.clone()));
    server::close_on_service(&client, &ctx, session).await;
    let (seen, ended) = read_until(&mut socket, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.conversation.removed" && frame.payload["conversationId"] == opened.id.as_str()
    })
    .await;
    assert!(ended, "no chat.conversation.removed for the stopped server");
    assert_eq!(seen.last().map(|frame| frame.payload["reason"].clone()), Some("ended".into()));
    assert_eq!(code_of(client.chat_conversation(&ctx, &opened.id).await), "not_found");
    client
        .chat_close_server(&ctx, session)
        .await
        .expect("a second close is not an error");
    // The answer of an open that was still out is ended again.
    assert_eq!(chats.opened(session, &opened.id), Opened::Close);

    // -- A heartbeat without the server ends a chat the stop did not ------------
    let next = "fedcba9876543210";
    heartbeat(&client, &ctx, Some(hosting_of(next))).await;
    let reopened = client.chat_open_server(&ctx, next).await.expect("the next server's chat");
    assert_ne!(reopened.id, opened.id);
    heartbeat(&client, &ctx, None).await;
    let (_, ended) = read_until(&mut socket, FRAME_TIMEOUT, |frame| {
        frame.kind == "chat.conversation.removed"
            && frame.payload["conversationId"] == reopened.id.as_str()
            && frame.payload["reason"] == "ended"
    })
    .await;
    assert!(ended, "a heartbeat without the server did not end its chat");
}
