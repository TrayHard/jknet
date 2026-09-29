//! --- slice: sign-in binding ---
//! The launcher's end of the loopback sign-in: a one-shot HTTP listener on
//! `127.0.0.1` and the code verifier the one-time code is exchanged with.
//!
//! A login session is tied to the launcher that created it. The launcher
//! listens on an ephemeral port of `127.0.0.1` and opens the session with
//! `redirectUri` (`http://127.0.0.1:<port>/jknet/signin`) and `codeChallenge`,
//! the unpadded base64url SHA-256 of a verifier it keeps (the S256 method of
//! RFC 7636). When the provider sends the browser back, the service answers
//! `302` to that address with the session id and a one-time code, and the
//! token goes only to `POST /v1/auth/login-sessions/{id}/token` with the code
//! and the verifier. Whoever else created or polls the session never gets it.
//!
//! ```text
//! browser                   listener (this module)          service
//!    | GET /jknet/signin?session=..&code=..  |                   |
//!    |-------------------------------------->|                   |
//!    |                                       | POST .../token    |
//!    |                                       | {code, verifier}  |
//!    |                                       |------------------>|
//!    |                                       |<-- token, user ---|
//!    |<-- "Signed in" page ------------------|                   |
//!    |                       (the listener is closed from here on)
//! ```
//!
//! The listener answers one request that names its session and carries a
//! code, then closes. It also closes when the sign-in is cancelled and when
//! the session's time runs out. A request for another path, another session,
//! another host or with another method gets a small error page and leaves
//! the listener open, so a stray request cannot end the sign-in. A loopback
//! address in the browser's own URL bar needs no firewall rule: nothing
//! outside this machine can reach `127.0.0.1`.

use std::future::Future;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use percent_encoding::percent_decode_str;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::error::{AppError, Result};

/// The path the service sends the browser to. The service accepts no other.
pub const SIGN_IN_PATH: &str = "/jknet/signin";

/// Random bytes of the verifier. The wire form is 43 base64url characters,
/// the shortest verifier RFC 7636 allows.
const VERIFIER_BYTES: usize = 32;

/// The longest request head the listener reads. The one it waits for is a
/// request line of about 120 bytes and a browser's usual headers.
const HEAD_LIMIT: usize = 8 * 1024;

/// How long a connection may take to send its request head. A browser may
/// open a spare connection it never uses; it must not hold anything up.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// How long writing a page may take.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// The longest code the listener passes on. The service sends 43 characters.
const CODE_MAX: usize = 256;

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

/// The secret behind a session's `codeChallenge`. It never leaves the core
/// except in the body of the exchange.
pub struct CodeVerifier(String);

/// Prints nothing of the secret.
impl std::fmt::Debug for CodeVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodeVerifier(<redacted>)")
    }
}

impl CodeVerifier {
    /// A fresh verifier: 32 random bytes as unpadded base64url.
    pub fn new() -> Result<CodeVerifier> {
        let mut bytes = [0_u8; VERIFIER_BYTES];
        getrandom::fill(&mut bytes).map_err(|e| {
            AppError::State(format!("no random bytes for the sign-in verifier: {e}"))
        })?;
        Ok(CodeVerifier(URL_SAFE_NO_PAD.encode(bytes)))
    }

    /// The verifier itself, for the body of the exchange.
    pub fn secret(&self) -> &str {
        &self.0
    }

    /// Its S256 challenge, for the new session.
    pub fn challenge(&self) -> String {
        challenge_of(&self.0)
    }
}

/// The S256 challenge of a verifier: `base64url(SHA-256(verifier))` without
/// padding.
pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/// What the browser is shown once the code has been dealt with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// The token is in the launcher.
    SignedIn,
    /// The exchange failed; the text says why.
    Failed(String),
}

/// How [`LoopbackListener::serve`] ended.
#[derive(Debug)]
pub enum Served<T> {
    /// A request brought the code and `finish` ran on it.
    Finished(T),
    /// The sign-in was cancelled before the browser came back.
    Cancelled,
    /// Nobody came back within the time given.
    TimedOut,
}

/// A listener bound to an ephemeral port of `127.0.0.1`, not yet serving.
///
/// Bound before the session exists, because the session has to name the
/// port. Connections that arrive before [`serve`](Self::serve) starts wait
/// in the backlog.
pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
}

impl LoopbackListener {
    /// Binds `127.0.0.1:0` and reads back the port the system chose.
    pub async fn bind() -> Result<LoopbackListener> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| {
                AppError::Network(format!("cannot listen on 127.0.0.1 to sign in: {e}"))
            })?;
        let port = listener
            .local_addr()
            .map_err(|e| AppError::Network(format!("the sign-in listener has no port: {e}")))?
            .port();
        Ok(LoopbackListener { listener, port })
    }

    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The address the session names as `redirectUri`.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{SIGN_IN_PATH}", self.port)
    }

    /// Waits for the browser to bring the code of session `session_id`,
    /// runs `finish` on it and shows the browser the page `finish` chose.
    ///
    /// The listener stops accepting the moment the code arrives, so a second
    /// request finds the port closed; one that was already connected by then
    /// is told the sign-in is over. It also stops when `cancel` completes and
    /// when `ttl` has passed. Each connection is read on its own task, so a
    /// connection that never speaks holds nothing up.
    pub async fn serve<T, F, Fut>(
        self,
        session_id: &str,
        ttl: Duration,
        cancel: impl Future<Output = ()>,
        finish: F,
    ) -> Served<T>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = (Reply, T)>,
    {
        let expected = Arc::new(Expected {
            session_id: session_id.to_string(),
            host: format!("127.0.0.1:{}", self.port),
        });
        let (found_tx, mut found_rx) = mpsc::channel::<(TcpStream, String)>(1);
        let deadline = tokio::time::sleep(ttl);
        tokio::pin!(deadline);
        tokio::pin!(cancel);

        let (mut stream, code) = loop {
            tokio::select! {
                _ = &mut cancel => return Served::Cancelled,
                _ = &mut deadline => return Served::TimedOut,
                Some(found) = found_rx.recv() => break found,
                accepted = self.listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        tokio::spawn(read_request(stream, expected.clone(), found_tx.clone()));
                    }
                    // A connection that failed between the handshake and the
                    // accept; the next one is unaffected.
                    Err(e) => log::warn!("the sign-in listener could not accept a connection: {e}"),
                },
            }
        };

        // One code per session: the port closes, and a request that got in
        // before it did is turned away rather than left hanging.
        drop(self.listener);
        found_rx.close();
        while let Ok((mut late, _)) = found_rx.try_recv() {
            tokio::spawn(async move { respond(&mut late, Status::Conflict, &used_page()).await });
        }
        drop(found_tx);

        let (reply, value) = finish(code).await;
        let page = match &reply {
            Reply::SignedIn => signed_in_page(),
            Reply::Failed(reason) => failed_page(reason),
        };
        respond(&mut stream, Status::Ok, &page).await;
        Served::Finished(value)
    }
}

/// What a request has to name to be the one the listener waits for.
struct Expected {
    session_id: String,
    /// `127.0.0.1:<port>`, as a browser that followed the service's redirect
    /// sends it. Anything else was not sent there by the service, whatever a
    /// DNS answer made the name point at.
    host: String,
}

/// Reads one request and either hands its code over or answers it.
async fn read_request(
    mut stream: TcpStream,
    expected: Arc<Expected>,
    found: mpsc::Sender<(TcpStream, String)>,
) {
    let head = match tokio::time::timeout(READ_TIMEOUT, read_head(&mut stream)).await {
        Ok(Some(head)) => head,
        // Silence, a head that never ended or bytes that are not a request:
        // closed without an answer.
        _ => return,
    };
    match check_request(&head, &expected) {
        Ok(code) => {
            if let Err(mpsc::error::SendError((mut stream, _))) = found.send((stream, code)).await {
                respond(&mut stream, Status::Conflict, &used_page()).await;
            }
        }
        Err(status) => {
            let page = refusal_page(status);
            respond(&mut stream, status, &page).await;
        }
    }
}

/// The request head as text, up to the blank line; `None` for a connection
/// that closed first, one that sent more than [`HEAD_LIMIT`], or bytes that
/// are not UTF-8.
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        head.extend_from_slice(&chunk[..read]);
        if let Some(end) = find(&head, b"\r\n\r\n") {
            head.truncate(end);
            return String::from_utf8(head).ok();
        }
        if head.len() > HEAD_LIMIT {
            return None;
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The statuses the listener answers with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    BadRequest,
    NotFound,
    MethodNotAllowed,
    Conflict,
}

impl Status {
    fn line(self) -> &'static str {
        match self {
            Status::Ok => "200 OK",
            Status::BadRequest => "400 Bad Request",
            Status::NotFound => "404 Not Found",
            Status::MethodNotAllowed => "405 Method Not Allowed",
            Status::Conflict => "409 Conflict",
        }
    }
}

/// The code of the request the listener waits for, or the status of the
/// refusal: another method, host, path or session, or no code.
fn check_request(head: &str, expected: &Expected) -> std::result::Result<String, Status> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (method, target, version) = (parts.next(), parts.next(), parts.next());
    let (Some(method), Some(target), Some(version)) = (method, target, version) else {
        return Err(Status::BadRequest);
    };
    if parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return Err(Status::BadRequest);
    }
    if method != "GET" {
        return Err(Status::MethodNotAllowed);
    }
    let host = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim());
    if host != Some(expected.host.as_str()) {
        return Err(Status::BadRequest);
    }

    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != SIGN_IN_PATH {
        return Err(Status::NotFound);
    }
    let mut session = None;
    let mut code = None;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode_str(value).decode_utf8().ok();
        match name {
            "session" => session = value,
            "code" => code = value,
            _ => {}
        }
    }
    if session.as_deref() != Some(expected.session_id.as_str()) {
        return Err(Status::BadRequest);
    }
    let code = code.ok_or(Status::BadRequest)?;
    let well_formed = !code.is_empty()
        && code.len() <= CODE_MAX
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !well_formed {
        return Err(Status::BadRequest);
    }
    Ok(code.into_owned())
}

/// Writes one response and closes the connection. A browser that went away
/// meanwhile is nobody's problem.
async fn respond(stream: &mut TcpStream, status: Status, page: &str) {
    let response = format!(
        "HTTP/1.1 {}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         Referrer-Policy: no-referrer\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         \r\n{page}",
        status.line(),
        page.len(),
    );
    let write = async {
        stream.write_all(response.as_bytes()).await?;
        stream.flush().await?;
        stream.shutdown().await
    };
    if let Ok(Err(e)) = tokio::time::timeout(WRITE_TIMEOUT, write).await {
        log::debug!("the sign-in page did not reach the browser: {e}");
    }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

fn signed_in_page() -> String {
    page(
        "Signed in",
        "Signed in",
        "You can close this tab and return to JKNet.",
    )
}

fn failed_page(reason: &str) -> String {
    page(
        "Sign-in failed",
        "Sign-in failed",
        &format!(
            "{} Return to JKNet and sign in again.",
            html_escape(reason.trim())
        ),
    )
}

fn used_page() -> String {
    page(
        "Sign-in already finished",
        "This sign-in is already finished",
        "You can close this tab and return to JKNet.",
    )
}

fn refusal_page(status: Status) -> String {
    match status {
        Status::NotFound => page(
            "Not found",
            "Not found",
            "JKNet is waiting for a sign-in here.",
        ),
        _ => page(
            "Not this sign-in",
            "This is not the sign-in JKNet is waiting for",
            "Return to JKNet and sign in again.",
        ),
    }
}

/// A self-contained page in the style of the service's own sign-in pages.
/// `body` is HTML already.
fn page(title: &str, heading: &str, body: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{ font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #14161a; color: #e8eaed; text-align: center; }}
  main {{ padding: 2rem; max-width: 30rem; }}
  h1 {{ font-size: 1.5rem; margin: 0 0 .5rem; }}
  p {{ margin: 0; color: #9aa0a6; }}
</style>
</head>
<body>
<main>
  <h1>{heading}</h1>
  <p>{body}</p>
</main>
</body>
</html>
"#
    )
}

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::sync::oneshot;

    const SESSION: &str = "01JSIGNIN0000000000000000";
    const CODE: &str = "c29tZS1vbmUtdGltZS1jb2RlLW9mLTQzLWNoYXJzLi4";

    /// One raw request to the listener; the status code and the body of the
    /// answer, or the error of a connection the listener refused.
    async fn get(port: u16, head: &str) -> std::io::Result<(u16, String)> {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
        stream.write_all(head.as_bytes()).await?;
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await?;
        let status = answer
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        Ok((status, answer))
    }

    fn request(port: u16, target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: test\r\n\r\n")
    }

    fn callback(port: u16, session: &str, code: &str) -> String {
        request(
            port,
            &format!("{SIGN_IN_PATH}?session={session}&code={code}"),
        )
    }

    /// Starts serving session [`SESSION`] on a fresh listener: its port,
    /// the sender that cancels it, and the task that reports how it ended,
    /// with the code `finish` was given.
    async fn serving(
        ttl: Duration,
        reply: Reply,
    ) -> (
        u16,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<Served<String>>,
    ) {
        let listener = LoopbackListener::bind().await.expect("a loopback port");
        let port = listener.port();
        assert_eq!(
            listener.redirect_uri(),
            format!("http://127.0.0.1:{port}/jknet/signin")
        );
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            listener
                .serve(
                    SESSION,
                    ttl,
                    async move {
                        let _ = cancel_rx.await;
                    },
                    |code| async move { (reply, code) },
                )
                .await
        });
        (port, cancel_tx, task)
    }

    #[test]
    fn the_verifier_is_43_characters_and_its_challenge_is_s256() {
        let verifier = CodeVerifier::new().expect("random bytes");
        assert_eq!(verifier.secret().len(), 43);
        assert!(verifier
            .secret()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(verifier.challenge().len(), 43);
        assert_ne!(
            verifier.secret(),
            CodeVerifier::new().expect("random bytes").secret()
        );
        // RFC 7636, appendix B.
        assert_eq!(
            challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(format!("{verifier:?}"), "CodeVerifier(<redacted>)");
    }

    #[tokio::test]
    async fn the_first_request_with_the_session_and_a_code_finishes_and_closes_the_port() {
        let (port, _cancel, task) = serving(Duration::from_secs(30), Reply::SignedIn).await;

        let (status, answer) = get(port, &callback(port, SESSION, CODE))
            .await
            .expect("the listener answers");
        assert_eq!(status, 200, "{answer}");
        assert!(answer.contains("You can close this tab and return to JKNet"));
        assert!(answer.contains("Cache-Control: no-store"));

        match task.await.expect("the task ends") {
            Served::Finished(code) => assert_eq!(code, CODE),
            other => panic!("expected the code, got {other:?}"),
        }
        // One-shot: nobody listens any more.
        assert!(
            get(port, &callback(port, SESSION, CODE)).await.is_err(),
            "the port still answers after the sign-in"
        );
    }

    #[tokio::test]
    async fn a_failed_exchange_shows_the_reason_escaped() {
        let (port, _cancel, task) = serving(
            Duration::from_secs(30),
            Reply::Failed("The code <b>expired</b>.".into()),
        )
        .await;
        let (status, answer) = get(port, &callback(port, SESSION, CODE))
            .await
            .expect("the listener answers");
        assert_eq!(status, 200);
        assert!(answer.contains("Sign-in failed"), "{answer}");
        assert!(
            answer.contains("The code &lt;b&gt;expired&lt;/b&gt;."),
            "{answer}"
        );
        assert!(matches!(task.await.unwrap(), Served::Finished(_)));
    }

    #[tokio::test]
    async fn a_wrong_path_method_host_or_session_is_refused_and_the_listener_stays_open() {
        let (port, _cancel, task) = serving(Duration::from_secs(30), Reply::SignedIn).await;

        let cases = [
            (request(port, "/"), 404),
            (request(port, "/favicon.ico"), 404),
            (request(port, &format!("/jknet/signin/?session={SESSION}&code={CODE}")), 404),
            (request(port, &format!("/other?session={SESSION}&code={CODE}")), 404),
            (callback(port, "01JSOMEONEELSE00000000000", CODE), 400),
            (request(port, &format!("{SIGN_IN_PATH}?code={CODE}")), 400),
            (request(port, &format!("{SIGN_IN_PATH}?session={SESSION}")), 400),
            (callback(port, SESSION, ""), 400),
            (callback(port, SESSION, "not%20a%20code"), 400),
            (
                format!(
                    "POST {SIGN_IN_PATH}?session={SESSION}&code={CODE} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
                ),
                405,
            ),
            (
                format!(
                    "GET {SIGN_IN_PATH}?session={SESSION}&code={CODE} HTTP/1.1\r\nHost: rebound.example.com:{port}\r\n\r\n"
                ),
                400,
            ),
            (
                format!("GET {SIGN_IN_PATH}?session={SESSION}&code={CODE} HTTP/1.1\r\n\r\n"),
                400,
            ),
        ];
        for (head, expected) in cases {
            let (status, answer) = get(port, &head).await.expect("the listener answers");
            assert_eq!(status, expected, "{head:?} -> {answer}");
            assert!(!task.is_finished(), "{head:?} ended the sign-in");
        }

        // The real one still gets through, percent-encoded or not.
        let (status, _) = get(
            port,
            &request(
                port,
                &format!(
                    "{SIGN_IN_PATH}?code={CODE}&session={}",
                    SESSION.replace('0', "%30")
                ),
            ),
        )
        .await
        .expect("the listener answers");
        assert_eq!(status, 200);
        match task.await.unwrap() {
            Served::Finished(code) => assert_eq!(code, CODE),
            other => panic!("expected the code, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_second_request_already_connected_is_told_the_sign_in_is_over() {
        let (port, _cancel, task) = serving(Duration::from_secs(30), Reply::SignedIn).await;

        // The second browser connects first and speaks last, the way a tab
        // reopened from the history would race the real one.
        let mut second = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .expect("the listener accepts");
        let (status, _) = get(port, &callback(port, SESSION, CODE))
            .await
            .expect("the listener answers");
        assert_eq!(status, 200);
        assert!(matches!(task.await.unwrap(), Served::Finished(_)));

        second
            .write_all(callback(port, SESSION, CODE).as_bytes())
            .await
            .expect("the request goes out");
        let mut answer = String::new();
        second
            .read_to_string(&mut answer)
            .await
            .expect("an answer comes back");
        assert!(answer.starts_with("HTTP/1.1 409"), "{answer}");
        assert!(answer.contains("already finished"), "{answer}");
    }

    #[tokio::test]
    async fn nobody_coming_back_times_out_and_closes_the_port() {
        let (port, _cancel, task) = serving(Duration::from_millis(200), Reply::SignedIn).await;
        assert!(matches!(task.await.unwrap(), Served::TimedOut));
        assert!(get(port, &callback(port, SESSION, CODE)).await.is_err());
    }

    #[tokio::test]
    async fn a_cancel_closes_the_port() {
        let (port, cancel, task) = serving(Duration::from_secs(30), Reply::SignedIn).await;
        cancel.send(()).expect("the listener waits");
        assert!(matches!(task.await.unwrap(), Served::Cancelled));
        assert!(get(port, &callback(port, SESSION, CODE)).await.is_err());
    }

    #[tokio::test]
    async fn a_connection_that_never_speaks_holds_nothing_up() {
        let (port, _cancel, task) = serving(Duration::from_secs(30), Reply::SignedIn).await;
        // A browser's spare connection: open, silent, left there.
        let _idle = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .expect("the listener accepts");
        let started = std::time::Instant::now();
        let (status, _) = get(port, &callback(port, SESSION, CODE))
            .await
            .expect("the listener answers");
        assert_eq!(status, 200);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(matches!(task.await.unwrap(), Served::Finished(_)));
    }
}
