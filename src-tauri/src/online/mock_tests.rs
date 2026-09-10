//! The service client against a service, rather than against its own idea of one.
//!
//! The tests start `scripts/mock-online.mjs` as a child process and walk the
//! whole sign-in: open a session, poll it, read the account, rename it, list
//! friends, sign out. What they prove is the half that unit tests cannot —
//! that the paths, the bearer header, the status codes and the shapes of the
//! contract line up with an implementation of it.
//!
//! They are `#[ignore]`d because they need Node on `PATH` and a free TCP port,
//! and CI runs `cargo test` on a machine that has no service. Run them by hand:
//!
//! ```text
//! cargo test --lib -- --ignored --nocapture online::mock_tests
//! ```

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::client::{OnlineClient, OnlineContext};

/// Not 8787: a developer running these tests may well have the real service, or
/// another mock, on the stock port already. One port per test, because
/// `cargo test` runs them at the same time and a shared port leaves the second
/// mock dead of `EADDRINUSE`.
const PORT_SIGN_IN: u16 = 8791;
const PORT_PROVIDER: u16 = 8792;
const PORT_CONFLICT: u16 = 8793;
/// Nothing listens here, on purpose.
const PORT_UNUSED: u16 = 8794;

/// A running `mock-online.mjs` that stops when the test does, however it ends.
pub(crate) struct MockOnline {
    child: Child,
    port: u16,
}

impl Drop for MockOnline {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl MockOnline {
    /// Starts the mock and waits until it accepts a connection.
    pub(crate) fn start(port: u16) -> MockOnline {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .join("scripts")
            .join("mock-online.mjs");
        assert!(script.is_file(), "{} is missing", script.display());

        let child = Command::new("node")
            .arg(&script)
            .arg("--port")
            .arg(port.to_string())
            // The sign-in completes at once: the three-second wait of the
            // default exists to show a real player a real "waiting" state.
            .env("MOCK_ONLINE_DEV_DELAY_MS", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("node is on PATH and scripts/mock-online.mjs starts");

        let mock = MockOnline { child, port };
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return mock;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the mock service did not listen on {port} within 10 s");
    }

    pub(crate) fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn context(&self) -> OnlineContext {
        OnlineContext {
            base_url: self.base_url(),
            token: None,
        }
    }
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn signs_in_reads_the_account_renames_it_and_signs_out() {
    let mock = MockOnline::start(PORT_SIGN_IN);
    let client = OnlineClient::new();
    let mut ctx = mock.context();

    let session = client
        .create_login_session(&ctx, "dev", Some("TESTBOX"))
        .await
        .expect("the dev provider opens a session");
    assert_eq!(session.status, "pending");
    assert!(
        session
            .url
            .starts_with(&format!("http://127.0.0.1:{PORT_SIGN_IN}/v1/auth/dev/start")),
        "{}",
        session.url
    );

    // The launcher polls every 2 s; the mock is set to finish at once, so a
    // handful of fast reads is the same walk in less time.
    let mut done = None;
    for _ in 0..40 {
        let polled = client
            .poll_login_session(&ctx, &session.id)
            .await
            .expect("the session can be read");
        if polled.status == "done" {
            done = Some(polled);
            break;
        }
        assert_eq!(polled.status, "pending", "unexpected status");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let done = done.expect("the dev session completes");
    let token = done.token.expect("the first read carries the token");
    assert_eq!(token.len(), 64, "the contract says 64 hex characters");
    let user = done.user.expect("the first read carries the user");
    assert_eq!(user.provider, "dev");

    // The token arrives exactly once: a second poll finds the session done and
    // carries nothing, which is the case `poll_sign_in` has to survive.
    let again = client
        .poll_login_session(&ctx, &session.id)
        .await
        .expect("a second read works");
    assert_eq!(again.status, "done");
    assert!(again.token.is_none(), "the token was handed out twice");

    ctx.token = Some(token);

    let me = client.get_me(&ctx).await.expect("the account reads back");
    assert_eq!(me.user.id, user.id);
    assert_eq!(me.presence.status, "online");

    let renamed = client
        .patch_me(&ctx, "Kyle Katarn")
        .await
        .expect("the rename lands");
    assert_eq!(renamed.display_name, "Kyle Katarn");

    // The mock seeds one world at the first sign-in: three friends in the
    // three states the screen groups by, and a request in each direction.
    let friends = client.get_friends(&ctx).await.expect("the list reads back");
    assert_eq!(friends.friends.len(), 3);
    assert_eq!(friends.friends[0].presence.status, "in_game");
    assert_eq!(friends.incoming.len(), 1);
    assert_eq!(friends.outgoing.len(), 1);

    // Accepting moves the one incoming request into the friends list, and the
    // answer is the friendship it became.
    let request = friends.incoming[0].id.clone();
    let accepted = client
        .accept_request(&ctx, &request)
        .await
        .expect("the request is accepted");
    assert_eq!(accepted.user.id, friends.incoming[0].from.id);

    let after = client.get_friends(&ctx).await.expect("the list reads back");
    assert_eq!(after.friends.len(), 4);
    assert!(after.incoming.is_empty());

    // Presence goes out as the heartbeat sends it, and comes back stored.
    let put = client
        .put_presence(
            &ctx,
            &crate::online::PresenceUpdate {
                status: crate::online::Presence::IN_GAME.into(),
                server_address: Some("203.0.113.10:29070".into()),
                server_name: Some("EU FFA".into()),
                client_name: Some("Everyday".into()),
            },
        )
        .await
        .expect("the presence lands");
    assert_eq!(put.status, crate::online::Presence::IN_GAME);
    assert!(put.in_game());

    // Invites: one goes out, and the list of the ones addressed to me is
    // empty, because the service does not hand back what I sent.
    let invite = client
        .create_invite(
            &ctx,
            &crate::online::NewInvite {
                to_user_id: after.friends[0].user.id.clone(),
                server_address: "203.0.113.10:29070".into(),
                server_name: Some("EU FFA".into()),
                message: Some("Duel?".into()),
            },
        )
        .await
        .expect("the invite is created");
    assert_eq!(invite.server_address, "203.0.113.10:29070");
    assert!(client
        .list_invites(&ctx)
        .await
        .expect("the invites read back")
        .is_empty());

    client.logout(&ctx).await.expect("the sign-out lands");

    // The token is dead, and the service says so with the code the frontend reads.
    match client.get_me(&ctx).await {
        Err(crate::error::AppError::Online { code, .. }) => assert_eq!(code, "unauthorized"),
        other => panic!("expected an unauthorized refusal, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn a_provider_without_an_oauth_client_refuses_with_its_code() {
    // This is the answer JKHub gives until its administrators issue a client,
    // and the onboarding step keeps the guest button because of it.
    let mock = MockOnline::start(PORT_PROVIDER);
    let client = OnlineClient::new();
    let ctx = mock.context();

    match client.create_login_session(&ctx, "jkhub", None).await {
        Err(crate::error::AppError::Online { code, message }) => {
            assert_eq!(code, "provider_error");
            assert!(message.contains("JKHub"), "{message}");
        }
        other => panic!("expected a provider error, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn a_taken_display_name_comes_back_as_a_conflict() {
    let mock = MockOnline::start(PORT_CONFLICT);
    let client = OnlineClient::new();
    let mut ctx = mock.context();

    let session = client
        .create_login_session(&ctx, "dev", None)
        .await
        .expect("the dev provider opens a session");
    let mut token = None;
    for _ in 0..40 {
        let polled = client
            .poll_login_session(&ctx, &session.id)
            .await
            .expect("the session can be read");
        if let Some(found) = polled.token {
            token = Some(found);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ctx.token = Some(token.expect("the dev session completes"));

    match client.patch_me(&ctx, "Taken").await {
        Err(crate::error::AppError::Online { code, .. }) => assert_eq!(code, "conflict"),
        other => panic!("expected a conflict, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
async fn a_service_that_is_not_there_fails_without_hanging() {
    // Nothing listens on this port, which is what a launcher started before
    // the service sees. It has to fail fast rather than sit on the 10 s timeout.
    let ctx = OnlineContext {
        base_url: format!("http://127.0.0.1:{PORT_UNUSED}"),
        token: None,
    };
    let client = OnlineClient::new();
    let started = Instant::now();

    match client.create_login_session(&ctx, "dev", None).await {
        Err(crate::error::AppError::Network(message)) => assert!(message.contains("online POST")),
        other => panic!("expected a network error, got {other:?}"),
    }
    // One connect, one retry, both refused: still nowhere near the timeout.
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}
