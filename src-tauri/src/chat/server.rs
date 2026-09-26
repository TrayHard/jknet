//! The chat of a private server: it opens with the server, the friends who
//! join the server join it, and it ends when the server stops.
//!
//! | Step    | Who   | When                                                  | Request |
//! | ------- | ----- | ----------------------------------------------------- | ------- |
//! | open    | host  | a heartbeat that carried `hosting` was stored          | `PUT /v1/chat/servers/{sessionId}` |
//! | join    | guest | `hosting::join::join_private` started the game         | `POST /v1/chat/servers/{sessionId}/join` |
//! | history | host  | the switch on the Play with friends screen (D1)        | `PATCH /v1/chat/servers/{sessionId}` |
//! | leave   | anyone| **Leave** in the chat (D9); the host's leave ends it   | `DELETE /v1/chat/conversations/{id}/members/{me}` |
//! | close   | host  | the server stops                                       | `DELETE /v1/chat/servers/{sessionId}` |
//!
//! The open waits for a stored heartbeat because the service opens a chat
//! only for the session the host's presence carries; before that it answers
//! `409 not_hosting`, and the next heartbeat, 30 s later, asks again. A guest
//! may start the game before the host's chat is open, so a `404` is asked
//! again after 5, 20 and 60 s; a `403` means the server is not open to the
//! guest, and the join stops there.
//!
//! The close is best effort. The service also ends the chat when the host's
//! heartbeat stops carrying the session, and when the host's presence
//! expires; every member then hears `chat.conversation.removed` with `ended`.
//!
//! A chat the service ended while the server still runs, say after the
//! host's presence expired during a network cut, opens again as a new
//! conversation at the next heartbeat. One the host closed or left does
//! not: for that session, chat is over.

use std::collections::HashSet;
use std::future::Future;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};
use crate::hosting::join::JoinResult;
use crate::launch::LaunchState;
use crate::online::{is_retryable, Conversation, OnlineClient, OnlineContext, ServerChatRef};
use crate::state::AppState;

use super::{account, drop_conversation, keep, my_id, noted, sync, Book, ChatState};

/// How long the close of a stopped server waits for the service.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

/// The waits between the attempts of a guest's join that found no chat yet.
const JOIN_RETRY: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(20),
    Duration::from_secs(60),
];

/// The code of the service's refusal to a guest who changes the history
/// setting, which a launcher that knows the host answers without asking.
const OWNER_ONLY: &str = "owner_only";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// What the core knows of server chats: the one this launcher hosts, and the
/// joins that are still trying.
#[derive(Debug, Default)]
pub(crate) struct ServerChats {
    host: Option<HostChat>,
    /// Sessions whose join is running, so a second start of the game does
    /// not start a second loop.
    joining: HashSet<String>,
}

/// The chat of the server this launcher hosts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HostChat {
    /// `jknet_session` of the server, in lower case.
    session_id: String,
    /// Set once the service answered the open.
    conversation_id: Option<String>,
    /// A `PUT` is on its way.
    opening: bool,
    /// The server stopped or the host left its chat: it is not opened again.
    over: bool,
}

impl HostChat {
    fn new(session_id: String) -> Self {
        HostChat {
            session_id,
            conversation_id: None,
            opening: false,
            over: false,
        }
    }
}

/// What a stored heartbeat of a hosted session asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenPlan {
    /// The chat is open, on its way, or over.
    Nothing,
    /// Open it. `superseded` is the chat of an earlier session this launcher
    /// still holds; the service ends it when the new one opens.
    Open { superseded: Option<String> },
}

/// What to do with the conversation an open answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Opened {
    Keep,
    /// The server stopped, or another session started, while the request
    /// was out: the chat the service has just opened is ended again.
    Close,
}

impl ServerChats {
    /// A heartbeat that carried `session_id` was stored. `in_book` answers
    /// whether a conversation is still among the summaries: one the service
    /// ended while the server runs is opened again.
    pub fn plan_open(&mut self, session_id: &str, in_book: impl Fn(&str) -> bool) -> OpenPlan {
        let session_id = session_key(session_id);
        match self.host.as_mut() {
            Some(host) if host.session_id == session_id => {
                let open = host.conversation_id.as_deref().is_some_and(&in_book);
                if host.opening || host.over || open {
                    return OpenPlan::Nothing;
                }
                host.conversation_id = None;
                host.opening = true;
                OpenPlan::Open { superseded: None }
            }
            _ => {
                let superseded = self
                    .host
                    .take()
                    .and_then(|old| old.conversation_id)
                    .filter(|id| in_book(id));
                self.host = Some(HostChat {
                    opening: true,
                    ..HostChat::new(session_id)
                });
                OpenPlan::Open { superseded }
            }
        }
    }

    /// The service opened `conversation_id` for `session_id`.
    pub fn opened(&mut self, session_id: &str, conversation_id: &str) -> Opened {
        let session_id = session_key(session_id);
        match self.host.as_mut() {
            Some(host) if host.session_id == session_id && !host.over => {
                host.opening = false;
                host.conversation_id = Some(conversation_id.to_string());
                Opened::Keep
            }
            Some(host) if host.session_id == session_id => {
                host.opening = false;
                Opened::Close
            }
            _ => Opened::Close,
        }
    }

    /// The open of `session_id` failed; the next heartbeat asks again.
    pub fn open_failed(&mut self, session_id: &str) {
        let session_id = session_key(session_id);
        if let Some(host) = self.host.as_mut().filter(|host| host.session_id == session_id) {
            host.opening = false;
        }
    }

    /// The server of `session_id` stopped: its chat is over. Answers the
    /// conversation this launcher knew for it.
    pub fn closing(&mut self, session_id: &str) -> Option<String> {
        let session_id = session_key(session_id);
        match self.host.as_mut() {
            Some(host) if host.session_id == session_id => {
                host.over = true;
                host.conversation_id.clone()
            }
            // A stop of a session whose open never started: an open that
            // starts late still finds it over.
            None => {
                self.host = Some(HostChat {
                    over: true,
                    ..HostChat::new(session_id)
                });
                None
            }
            // One session at a time: a stop never names another one while a
            // newer one runs. Nothing to do if it ever does.
            Some(_) => None,
        }
    }

    /// A conversation went from the book. The host's own chat opens again at
    /// the next heartbeat, unless the host left it: the service ends a server
    /// chat its host leaves, and it stays ended.
    pub fn removed(&mut self, conversation_id: &str, reason: &str) {
        let Some(host) = self
            .host
            .as_mut()
            .filter(|host| host.conversation_id.as_deref() == Some(conversation_id))
        else {
            return;
        };
        host.conversation_id = None;
        if reason == "left" {
            host.over = true;
        }
    }

    /// The session this launcher hosts a chat for, open or on its way.
    #[cfg(test)]
    pub fn hosted_session(&self) -> Option<&str> {
        self.host
            .as_ref()
            .filter(|host| !host.over)
            .map(|host| host.session_id.as_str())
    }

    /// A guest's join of `session_id` starts. `false` when one is running.
    pub fn begin_join(&mut self, session_id: &str) -> bool {
        self.joining.insert(session_key(session_id))
    }

    pub fn end_join(&mut self, session_id: &str) {
        self.joining.remove(&session_key(session_id));
    }
}

/// A session id as the service stores it.
fn session_key(session_id: &str) -> String {
    session_id.trim().to_ascii_lowercase()
}

/// `jknet_session` of a private server: 16 hex characters.
pub(crate) fn is_session_id(session_id: &str) -> bool {
    let session_id = session_id.trim();
    session_id.len() == 16 && session_id.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether `conversation` is the chat of `session_id`, hosted by `host` when
/// one is named.
fn is_chat_of(conversation: &Conversation, session_id: &str, host: Option<&str>) -> bool {
    conversation.kind == "server"
        && conversation.server.as_ref().is_some_and(|server| {
            server.session_id.trim().eq_ignore_ascii_case(session_id.trim())
                && host.is_none_or(|host| server.host_id == host)
        })
}

/// The chats of `session_id` among the summaries, hosted by `host` when one
/// is named.
fn chats_of(book: &Book, session_id: &str, host: Option<&str>) -> Vec<String> {
    book.summaries
        .values()
        .filter(|conversation| is_chat_of(conversation, session_id, host))
        .map(|conversation| conversation.id.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/// Opens the chat of the server this launcher hosts. Called after every
/// stored heartbeat that carried `hosting` (`friends::presence::push`); costs
/// nothing while the chat is open.
pub fn ensure_open(app: &AppHandle, session_id: &str) {
    let Some(chat) = app.try_state::<ChatState>() else {
        return;
    };
    if !chat.available() || !is_session_id(session_id) {
        return;
    }
    let plan = {
        let book = chat.book();
        chat.servers()
            .plan_open(session_id, |id| book.get(id).is_some())
    };
    let OpenPlan::Open { superseded } = plan else {
        return;
    };
    if let Some(old) = superseded {
        drop_conversation(app, &old, "ended");
    }
    let handle = app.clone();
    let session_id = session_key(session_id);
    tauri::async_runtime::spawn(async move {
        open(&handle, &session_id).await;
    });
}

async fn open(app: &AppHandle, session_id: &str) {
    let chat = app.state::<ChatState>();
    let Ok(ctx) = account(app) else {
        chat.servers().open_failed(session_id);
        return;
    };
    let answer = app
        .state::<OnlineClient>()
        .chat_open_server(&ctx, session_id)
        .await;
    let conversation = match noted(app, answer) {
        Ok(conversation) => conversation,
        Err(e) => {
            chat.servers().open_failed(session_id);
            match &e {
                AppError::Online { code, .. } if code == "not_hosting" => log::debug!(
                    "chat: the service does not see the server yet, the next heartbeat opens its chat"
                ),
                _ => log::debug!("chat: cannot open the chat of the private server: {e}"),
            }
            return;
        }
    };
    // Another account took over while the request was out; its own
    // heartbeat opens its own chat.
    if !sync::same_account(app, &ctx) {
        return;
    }
    let outcome = chat.servers().opened(session_id, &conversation.id);
    match outcome {
        Opened::Keep => {
            chat.remember_files(conversation.last_message.iter());
            keep(app, &conversation);
            log::info!("chat: the chat of the private server is open");
        }
        Opened::Close => {
            log::info!("chat: the private server stopped while its chat opened, ending it");
            close_on_service(app.state::<OnlineClient>().inner(), &ctx, session_id).await;
        }
    }
}

/// The server of `session_id` stopped: its chat ends here at once, and on the
/// service within [`CLOSE_WAIT`], best effort. Called by the supervisor of
/// the private server after it closed the relay.
pub async fn close(app: &AppHandle, session_id: &str) {
    let Some(chat) = app.try_state::<ChatState>() else {
        return;
    };
    let me = my_id(app);
    let mut ids = chats_of(&chat.book(), session_id, me.as_deref());
    let known = chat.servers().closing(session_id);
    if let Some(known) = known.filter(|id| !ids.contains(id)) {
        ids.push(known);
    }
    for id in &ids {
        drop_conversation(app, id, "ended");
    }
    if !chat.available() {
        return;
    }
    let Ok(ctx) = account(app) else {
        return;
    };
    close_on_service(app.state::<OnlineClient>().inner(), &ctx, session_id).await;
}

/// `DELETE /v1/chat/servers/{sessionId}` within [`CLOSE_WAIT`]. A failure is
/// a log line: the service ends the chat anyway once the host's heartbeat
/// stops carrying the session.
pub(super) async fn close_on_service(online: &OnlineClient, ctx: &OnlineContext, session_id: &str) {
    match tokio::time::timeout(CLOSE_WAIT, online.chat_close_server(ctx, session_id)).await {
        Ok(Ok(())) => log::info!("chat: the chat of the private server ended"),
        Ok(Err(e)) => log::debug!("chat: cannot end the chat of the private server: {e}"),
        Err(_) => log::debug!(
            "chat: the service did not end the chat of the private server within {} s",
            CLOSE_WAIT.as_secs()
        ),
    }
}

/// Whether members who join from now on see the history (D1), for the chat
/// of the server this player hosts. A guest gets the service's refusal
/// without a request: the host of a server chat never changes.
pub(super) async fn set_history(
    app: &AppHandle,
    online: &OnlineClient,
    ctx: &OnlineContext,
    server: &ServerChatRef,
    on: bool,
) -> Result<Conversation> {
    check_host(my_id(app).as_deref(), server)?;
    let conversation = noted(app, online.chat_patch_server(ctx, &server.session_id, on).await)?;
    keep(app, &conversation);
    Ok(conversation)
}

/// Refuses a player who is not the host of a server chat, as the service
/// does. An unknown player is left to the service.
fn check_host(me: Option<&str>, server: &ServerChatRef) -> Result<()> {
    match me {
        Some(me) if me != server.host_id => Err(AppError::Online {
            code: OWNER_ONLY.to_string(),
            message: "only the host changes the chat of the server".to_string(),
        }),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

/// Joins the chat of the private server `host_user_id` hosts, in the
/// background. Called by `hosting::join::join_private` once the game started.
/// Nothing happens for a chat the player is a member of, or one being joined.
pub fn join(app: &AppHandle, host_user_id: &str, session_id: &str) {
    let Some(chat) = app.try_state::<ChatState>() else {
        return;
    };
    let host = host_user_id.trim();
    if host.is_empty() || !is_session_id(session_id) || !chat.available() {
        return;
    }
    if !chats_of(&chat.book(), session_id, None).is_empty() {
        return;
    }
    if !chat.servers().begin_join(session_id) {
        return;
    }
    let handle = app.clone();
    let host = host.to_string();
    let session_id = session_key(session_id);
    tauri::async_runtime::spawn(async move {
        run_join(&handle, &host, &session_id).await;
        handle.state::<ChatState>().servers().end_join(&session_id);
    });
}

async fn run_join(app: &AppHandle, host: &str, session_id: &str) {
    let Ok(ctx) = account(app) else {
        return;
    };
    let joined = retry_join(&JOIN_RETRY, || {
        let (app, ctx) = (app.clone(), ctx.clone());
        let (host, session_id) = (host.to_string(), session_id.to_string());
        async move {
            if !sync::same_account(&app, &ctx) {
                return Err(AppError::SignedOut);
            }
            let answer = app
                .state::<OnlineClient>()
                .chat_join_server(&ctx, &session_id, &host)
                .await;
            noted(&app, answer)
        }
    })
    .await;
    match joined {
        Ok(conversation) if sync::same_account(app, &ctx) => {
            let chat = app.state::<ChatState>();
            chat.remember_files(conversation.last_message.iter());
            keep(app, &conversation);
            log::info!("chat: joined the chat of a friend's private server");
        }
        Ok(_) => {}
        Err(e) => log::info!("chat: no chat of the private server to join: {e}"),
    }
}

/// Asks once, then again after each of `delays` while the answer is worth
/// waiting out: the host's chat is not open yet (`404`), the network, a rate
/// limit. Answers the last answer.
pub(crate) async fn retry_join<F, Fut>(delays: &[Duration], mut attempt: F) -> Result<Conversation>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Conversation>>,
{
    let mut delays = delays.iter();
    loop {
        let answer = attempt().await;
        match (worth_waiting(&answer), delays.next()) {
            (true, Some(delay)) => tokio::time::sleep(*delay).await,
            _ => return answer,
        }
    }
}

/// Whether an answer of a join may change by waiting. A `403` will not: the
/// player is not the host's friend, or the server is not open to them.
fn worth_waiting(answer: &Result<Conversation>) -> bool {
    match answer {
        Ok(_) => false,
        Err(AppError::Online { code, .. }) if code == "not_found" => true,
        Err(e) => is_retryable(e),
    }
}

/// **Join** on a host invite card: the private server of the card with the
/// default client of its game, and then its chat. A live invite of the host
/// to that session is used first; otherwise the host's presence decides, as
/// **Join** on the Friends screen does, and a server the host did not open
/// to this player refuses with `hostInviteOnly`.
#[tauri::command]
pub async fn chat_join_host_card(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    launch: tauri::State<'_, LaunchState>,
    host_id: String,
    session_id: String,
) -> Result<JoinResult> {
    let host_id = host_id.trim();
    if host_id.is_empty() {
        return Err(AppError::InvalidInput("a host invite names its host".into()));
    }
    if !is_session_id(&session_id) {
        return Err(AppError::InvalidInput(format!(
            "{session_id:?} is not the session of a private server"
        )));
    }
    crate::friends::join_host_card(&app, &state, &online, &launch, host_id, &session_key(&session_id))
        .await
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const SESSION: &str = "5e0b7c1f9a2d4c38";
    const NEXT: &str = "0123456789abcdef";

    fn refusal(code: &str) -> AppError {
        AppError::Online { code: code.into(), message: "x".into() }
    }

    fn server_chat(id: &str, host: &str, session: &str) -> Conversation {
        Conversation {
            kind: "server".into(),
            owner_id: Some(host.into()),
            server: Some(ServerChatRef { host_id: host.into(), session_id: session.into() }),
            ..conversation(id, 1, 1)
        }
    }

    #[test]
    fn the_first_stored_heartbeat_opens_the_chat_and_later_ones_leave_it() {
        let mut chats = ServerChats::default();
        let nothing_known = |_: &str| false;
        assert_eq!(chats.plan_open(SESSION, nothing_known), OpenPlan::Open { superseded: None });
        // The next heartbeat comes while the request is out.
        assert_eq!(chats.plan_open(SESSION, nothing_known), OpenPlan::Nothing);
        assert_eq!(chats.opened(SESSION, "c1"), Opened::Keep);
        assert_eq!(chats.hosted_session(), Some(SESSION));
        let in_book = |id: &str| id == "c1";
        assert_eq!(chats.plan_open(SESSION, in_book), OpenPlan::Nothing);
        // The session reads the same in upper case, as the service stores it.
        assert_eq!(chats.plan_open(&SESSION.to_uppercase(), in_book), OpenPlan::Nothing);
    }

    #[test]
    fn a_refused_open_is_asked_again_at_the_next_heartbeat() {
        let mut chats = ServerChats::default();
        assert!(matches!(chats.plan_open(SESSION, |_| false), OpenPlan::Open { .. }));
        // `409 not_hosting`: the service had not stored the heartbeat yet.
        chats.open_failed(SESSION);
        assert_eq!(chats.plan_open(SESSION, |_| false), OpenPlan::Open { superseded: None });
    }

    #[test]
    fn a_chat_the_service_ended_while_the_server_runs_opens_again() {
        let mut chats = ServerChats::default();
        chats.plan_open(SESSION, |_| false);
        chats.opened(SESSION, "c1");
        // The host's presence expired during a network cut: `ended`.
        chats.removed("c1", "ended");
        assert_eq!(chats.plan_open(SESSION, |_| false), OpenPlan::Open { superseded: None });
        // A resync that no longer carries it does the same.
        chats.opened(SESSION, "c2");
        assert_eq!(chats.plan_open(SESSION, |_| false), OpenPlan::Open { superseded: None });
    }

    #[test]
    fn a_chat_the_host_left_or_closed_stays_over() {
        let mut chats = ServerChats::default();
        chats.plan_open(SESSION, |_| false);
        chats.opened(SESSION, "c1");
        chats.removed("c1", "left");
        assert_eq!(chats.plan_open(SESSION, |_| false), OpenPlan::Nothing);
        assert_eq!(chats.hosted_session(), None);

        let mut chats = ServerChats::default();
        chats.plan_open(SESSION, |_| false);
        chats.opened(SESSION, "c1");
        assert_eq!(chats.closing(SESSION), Some("c1".into()));
        // A heartbeat already on its way when the server stopped.
        assert_eq!(chats.plan_open(SESSION, |_| true), OpenPlan::Nothing);
        // Another conversation going leaves the host's chat alone.
        chats.removed("other", "left");
        assert_eq!(chats.hosted_session(), None);
    }

    #[test]
    fn an_open_that_lands_after_the_stop_is_ended_again() {
        let mut chats = ServerChats::default();
        chats.plan_open(SESSION, |_| false);
        assert_eq!(chats.closing(SESSION), None, "nothing was open yet");
        assert_eq!(chats.opened(SESSION, "c1"), Opened::Close);

        // A stop before any heartbeat reached the service: the open that
        // starts afterwards finds the session over.
        let mut chats = ServerChats::default();
        chats.closing(SESSION);
        assert_eq!(chats.plan_open(SESSION, |_| false), OpenPlan::Nothing);
    }

    #[test]
    fn a_new_session_supersedes_the_chat_of_the_old_one() {
        let mut chats = ServerChats::default();
        chats.plan_open(SESSION, |_| false);
        chats.opened(SESSION, "c1");
        assert_eq!(
            chats.plan_open(NEXT, |id| id == "c1"),
            OpenPlan::Open { superseded: Some("c1".into()) }
        );
        // The answer of the old session's open, late: not kept.
        assert_eq!(chats.opened(SESSION, "c1"), Opened::Close);
        assert_eq!(chats.opened(NEXT, "c2"), Opened::Keep);
        assert_eq!(chats.hosted_session(), Some(NEXT));
        // An old chat the book no longer holds is not dropped twice.
        assert_eq!(chats.plan_open(SESSION, |_| false), OpenPlan::Open { superseded: None });
    }

    #[test]
    fn a_guest_joins_a_session_once_at_a_time() {
        let mut chats = ServerChats::default();
        assert!(chats.begin_join(SESSION));
        assert!(!chats.begin_join(&SESSION.to_uppercase()));
        assert!(chats.begin_join(NEXT), "another server is another join");
        chats.end_join(SESSION);
        assert!(chats.begin_join(SESSION));
    }

    #[test]
    fn the_chats_of_a_session_are_found_by_session_and_host() {
        let mut book = Book::default();
        book.upsert(server_chat("mine", ME, SESSION));
        book.upsert(server_chat("theirs", KYLE, NEXT));
        book.upsert(conversation("dm", 1, 1));
        assert_eq!(chats_of(&book, &SESSION.to_uppercase(), Some(ME)), ["mine"]);
        assert!(chats_of(&book, SESSION, Some(KYLE)).is_empty());
        assert_eq!(chats_of(&book, NEXT, None), ["theirs"]);
        assert!(chats_of(&book, "ffffffffffffffff", None).is_empty());
    }

    #[test]
    fn a_session_id_is_sixteen_hex_characters() {
        assert!(is_session_id(SESSION));
        assert!(is_session_id(" 5E0B7C1F9A2D4C38 "));
        assert!(!is_session_id("5e0b7c1f9a2d4c3"));
        assert!(!is_session_id("5e0b7c1f9a2d4c3g"));
        assert!(!is_session_id("../../v1/friends"));
    }

    #[test]
    fn only_the_host_changes_the_history_of_a_server_chat() {
        let server = ServerChatRef { host_id: ME.into(), session_id: SESSION.into() };
        assert!(check_host(Some(ME), &server).is_ok());
        // An unknown player is left to the service.
        assert!(check_host(None, &server).is_ok());
        let guest = ServerChatRef { host_id: KYLE.into(), ..server };
        let refused = check_host(Some(ME), &guest).expect_err("a guest");
        assert_eq!(refused.details()["code"], OWNER_ONLY);
    }

    #[test]
    fn a_join_waits_out_a_missing_chat_and_the_network_but_not_a_refusal() {
        assert!(worth_waiting(&Err(refusal("not_found"))));
        assert!(worth_waiting(&Err(AppError::Network("reset".into()))));
        assert!(worth_waiting(&Err(refusal("rate_limited"))));
        assert!(!worth_waiting(&Err(refusal("forbidden"))));
        assert!(!worth_waiting(&Err(refusal("chat_unavailable"))));
        assert!(!worth_waiting(&Err(AppError::SignedOut)));
        assert!(!worth_waiting(&Ok(Conversation::default())));
    }

    /// Runs [`retry_join`] over scripted answers; answers the result and how
    /// many times it asked.
    async fn scripted(answers: Vec<Result<Conversation>>) -> (Result<Conversation>, u32) {
        let asked = AtomicU32::new(0);
        let answers = std::sync::Mutex::new(answers.into_iter());
        let delays = [Duration::from_millis(1); 3];
        let result = retry_join(&delays, || {
            asked.fetch_add(1, Ordering::Relaxed);
            let next = answers
                .lock()
                .unwrap()
                .next()
                .unwrap_or_else(|| Err(refusal("not_found")));
            async move { next }
        })
        .await;
        (result, asked.load(Ordering::Relaxed))
    }

    #[tokio::test]
    async fn a_join_is_asked_again_after_each_wait_and_then_given_up() {
        let chat = Conversation { id: "c".into(), ..Conversation::default() };
        let (result, asked) = scripted(vec![
            Err(refusal("not_found")),
            Err(AppError::Network("reset".into())),
            Ok(chat),
        ])
        .await;
        assert_eq!(result.map(|c| c.id).ok().as_deref(), Some("c"));
        assert_eq!(asked, 3);

        // The host never opened a chat: once and after each of the three
        // waits, then the last refusal.
        let (result, asked) = scripted(Vec::new()).await;
        assert_eq!(asked, 4);
        assert!(matches!(result, Err(AppError::Online { code, .. }) if code == "not_found"));

        // A `403` ends it at once.
        let (result, asked) = scripted(vec![Err(refusal("forbidden"))]).await;
        assert_eq!(asked, 1);
        assert!(result.is_err());
    }

    #[test]
    fn the_waits_of_a_join_are_those_of_the_plan() {
        assert_eq!(JOIN_RETRY.map(|d| d.as_secs()), [5, 20, 60]);
        assert_eq!(CLOSE_WAIT.as_secs(), 5);
    }
}
