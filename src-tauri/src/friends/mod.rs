//! Friends, presence and invites.
//!
//! The launcher is one client of the JKNet hub, a small HTTPS service that
//! knows who is signed in, who is friends with whom and where everybody is
//! playing. `crate::hub` owns the wire; this module holds everything built on
//! top of it that is not the sign-in: the commands the Friends screen calls,
//! the background reporter that says where the player is, and the socket that
//! hears about everybody else.
//!
//! | File          | What it holds                                        |
//! | ------------- | ---------------------------------------------------- |
//! | `presence.rs` | the online/in_game state machine and the heartbeat    |
//! | `live.rs`     | the WebSocket, its backoff and the fallback refresh   |
//!
//! ## Signed in, signed out
//!
//! One field decides: `settings.hub_token`. `crate::account` writes it; this
//! module only ever reads it, through [`crate::hub::HubContext`]. Nothing here
//! fails because nobody is signed in — [`get_friends_state`] answers
//! `signedIn: false` and the two background tasks stay quiet — so the Friends
//! screen can render its sign-in prompt without a special case in the
//! frontend.
//!
//! A build whose hub address is blank reads the same way. `HubContext` calls
//! such a launcher signed out whatever `hub_token` holds, so the background
//! tasks never start and no command reaches the network; the commands that
//! need an account answer `AppError::HubNotConfigured` instead of
//! `AppError::SignedOut`, because signing in is not the cure.
//!
//! Signing in and out is an event, not a poll. `account:changed` bumps
//! [`FriendsState::note_account_change`], and both background tasks wake on
//! it: the heartbeat sends the first push of a fresh sign-in at once, and the
//! live socket closes the one holding a token the hub has just revoked.
//!
//! ## Events
//!
//! | Event               | Payload                    | When                     |
//! | ------------------- | -------------------------- | ------------------------ |
//! | `friends:changed`   | none                       | any list may have moved  |
//! | `friends:presence`  | `{ userId, presence }`     | one friend moved         |
//! | `friends:invite`    | `Invite`                   | somebody invited me      |
//!
//! `friends:changed` is a nudge, not a payload: the window answers it by
//! calling [`get_friends_state`], which keeps one writer for the three lists.

#[cfg(test)]
mod hub_tests;
pub mod live;
pub mod presence;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::watch;

use crate::account::{AccountChanged, ACCOUNT_CHANGED_EVENT};
use crate::error::{AppError, Result};
use crate::hub::{
    Friend, FriendRequest, HubClient, HubContext, Invite, NewInvite, Presence, SendRequestResult,
};
use crate::launch::{self, LaunchState, RunningGame};
use crate::state::AppState;

/// Emitted when any of the three lists may have changed.
pub const EVENT_CHANGED: &str = "friends:changed";
/// Emitted with `{ userId, presence }` when one friend moves.
pub const EVENT_PRESENCE: &str = "friends:presence";
/// Emitted with the whole `Invite` when one arrives.
pub const EVENT_INVITE: &str = "friends:invite";

/// Longest query the launcher will send to `POST /v1/friends/requests`.
///
/// A display name is 3–24 characters, `provider:name` adds a prefix and a user
/// id is a ULID. Anything longer is a paste accident, and refusing it here
/// spares the rate limit of ten requests a minute.
const MAX_QUERY_LEN: usize = 96;

/// What this module keeps between calls.
///
/// Nothing here is a copy of the hub's data: the friends lists are fetched on
/// demand, because a stale list on screen is worse than a spinner and the
/// document is small.
pub struct FriendsState {
    /// The presence the launcher reports about the player.
    presence: Mutex<Presence>,
    /// Whether the live socket is up right now.
    live: AtomicBool,
    /// A fingerprint of the hub and the token the launcher is working as.
    ///
    /// The two background tasks wait on it, so a sign-in or a sign-out reaches
    /// them without a poll. It is a fingerprint rather than a counter because
    /// a rename announces the same event as a sign-in, and dropping a working
    /// socket over a new display name would be a reconnect for nothing.
    account: watch::Sender<u64>,
}

impl Default for FriendsState {
    /// A launcher that has just opened is online. Starting at `offline` would
    /// make the first heartbeat skip itself: only two of the three statuses
    /// are reportable.
    fn default() -> Self {
        FriendsState {
            presence: Mutex::new(presence::online()),
            live: AtomicBool::new(false),
            account: watch::channel(0).0,
        }
    }
}

impl FriendsState {
    /// The presence as the launcher currently sees it.
    ///
    /// A poisoned lock answers with the value that was in it. This state is
    /// one status and three strings, so there is no half-written presence to
    /// protect anyone from, and a launcher that stops reporting because an
    /// unrelated thread panicked would be the worse failure.
    pub fn presence(&self) -> Presence {
        self.presence
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_presence(&self, presence: Presence) {
        *self.presence.lock().unwrap_or_else(|e| e.into_inner()) = presence;
    }

    pub fn live(&self) -> bool {
        self.live.load(Ordering::Relaxed)
    }

    pub fn set_live(&self, live: bool) {
        self.live.store(live, Ordering::Relaxed);
    }

    /// Records the account in force and wakes the background tasks if it is a
    /// different one.
    ///
    /// `send_if_modified` does both halves: it never wakes a receiver for a
    /// value that did not change, and unlike `send` it does not fail when
    /// nobody is listening yet, which is the normal state at startup.
    pub fn note_account(&self, fingerprint: u64) -> bool {
        self.account.send_if_modified(|current| {
            let changed = *current != fingerprint;
            *current = fingerprint;
            changed
        })
    }

    /// A receiver that resolves whenever the account changes.
    pub fn account_changes(&self) -> watch::Receiver<u64> {
        self.account.subscribe()
    }
}

/// A cheap fingerprint of "which account, on which hub".
///
/// Not reversible and never logged: it exists to tell one token from another,
/// not to stand in for one.
fn account_fingerprint(ctx: &HubContext) -> u64 {
    let mut hasher = DefaultHasher::new();
    ctx.base_url.hash(&mut hasher);
    ctx.token.hash(&mut hasher);
    hasher.finish()
}

/// Starts the background tasks. Called once from `setup`.
pub fn start(app: &AppHandle) {
    // Seed the fingerprint from the settings on disk, so the first
    // `account:changed` that carries nothing but a rename is recognised as
    // one. Nothing is listening yet, which is why this wakes nobody.
    if let Ok(settings) = app.state::<AppState>().settings() {
        let ctx = HubContext::from_settings(&settings);
        app.state::<FriendsState>()
            .note_account(account_fingerprint(&ctx));
    }
    watch_the_account(app);
    presence::start(app);
    live::start(app);
}

/// Turns `account:changed` into the wake-up both tasks wait on.
///
/// Signing out has to stop the heartbeat and close the socket now rather than
/// when the hub gets round to revoking them; signing in has to start both
/// without the player waiting out a 30 s tick.
fn watch_the_account(app: &AppHandle) {
    let handle = app.clone();
    app.listen(ACCOUNT_CHANGED_EVENT, move |event| {
        let signed_in = serde_json::from_str::<AccountChanged>(event.payload())
            .map(|payload| payload.signed_in)
            .unwrap_or(false);
        let state = handle.state::<FriendsState>();
        if !signed_in {
            // Nothing is live any more, and the badge on the screen must not
            // claim otherwise while the socket unwinds.
            state.set_live(false);
        }

        // The event is also emitted by a rename, which changes nothing here.
        let Ok(settings) = handle.state::<AppState>().settings() else {
            return;
        };
        let fingerprint = account_fingerprint(&HubContext::from_settings(&settings));
        if state.note_account(fingerprint) {
            log::info!("friends: the account changed, signed in: {signed_in}");
        }
    });
}

// ---------------------------------------------------------------------------
// What the Friends screen renders
// ---------------------------------------------------------------------------

/// Everything the screen needs, in one answer.
///
/// One document rather than five queries: the four lists are drawn together,
/// they change together, and a screen assembled from four separately-timed
/// answers shows a friend in two groups at once while they settle.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsView {
    /// False when `settings.hub_token` is empty. The rest is then empty too.
    pub signed_in: bool,
    /// Whether the live socket is up. False means the lists refresh on a
    /// timer instead of the moment something changes.
    pub live: bool,
    pub friends: Vec<Friend>,
    /// Requests waiting for this player to accept.
    pub incoming: Vec<FriendRequest>,
    /// Requests this player sent and can still cancel.
    pub outgoing: Vec<FriendRequest>,
    /// Invites addressed to this player, newest first.
    pub invites: Vec<Invite>,
    /// The presence the launcher reports about this player.
    pub presence: Presence,
}

/// The answer of [`send_friend_request`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSent {
    /// `requested` when the other side has to accept, `accepted` when they had
    /// already asked and the hub joined the two halves.
    pub outcome: &'static str,
    /// Who the request reached, for the line the screen prints.
    pub display_name: String,
    /// The lists as they are now, so the screen needs no second call.
    pub state: FriendsView,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The lists, the invites and the player's own presence.
#[tauri::command]
pub async fn get_friends_state(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
) -> Result<FriendsView> {
    let ctx = HubContext::from_settings(&state.settings()?);
    if !ctx.signed_in() {
        return Ok(signed_out(&app));
    }
    collect(&app, &hub, &ctx).await
}

/// Asks somebody to be friends.
///
/// `query` is a display name, `provider:providerName` such as `jkhub:kyle_k`,
/// or a user id — the contract lets the hub decide which, so the launcher only
/// checks that there is something to send.
#[tauri::command]
pub async fn send_friend_request(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    query: String,
) -> Result<RequestSent> {
    let ctx = require_account(&state)?;
    let query = clean_query(&query)?;
    let sent = hub.send_friend_request(&ctx, &query).await?;
    let state = collect(&app, &hub, &ctx).await?;
    outcome_of(sent, state)
}

/// Accepts an incoming request and answers with the refreshed lists.
#[tauri::command]
pub async fn accept_friend_request(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    id: String,
) -> Result<FriendsView> {
    let ctx = require_account(&state)?;
    hub.accept_request(&ctx, &id).await?;
    collect(&app, &hub, &ctx).await
}

/// Declines an incoming request, or cancels one this player sent: the contract
/// puts both behind the same call, because both mean "forget this request".
#[tauri::command]
pub async fn decline_friend_request(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    id: String,
) -> Result<FriendsView> {
    let ctx = require_account(&state)?;
    hub.decline_request(&ctx, &id).await?;
    collect(&app, &hub, &ctx).await
}

/// Ends a friendship.
#[tauri::command]
pub async fn remove_friend(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    user_id: String,
) -> Result<FriendsView> {
    let ctx = require_account(&state)?;
    hub.remove_friend(&ctx, &user_id).await?;
    collect(&app, &hub, &ctx).await
}

/// Invites one friend to the server this player is on.
///
/// The address comes from the caller rather than from the stored presence, so
/// the Servers screen can invite somebody to a server before joining it.
#[tauri::command]
pub async fn send_invite(
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    to_user_id: String,
    server_address: String,
    server_name: Option<String>,
    message: Option<String>,
) -> Result<Invite> {
    let ctx = require_account(&state)?;
    let server_address = server_address.trim();
    if server_address.is_empty() {
        return Err(AppError::InvalidInput(
            "an invite needs a server address".into(),
        ));
    }
    hub.create_invite(
        &ctx,
        &NewInvite {
            to_user_id,
            server_address: server_address.to_string(),
            server_name: blank_to_none(server_name),
            message: blank_to_none(message),
        },
    )
    .await
}

/// Drops an invite this player was sent.
#[tauri::command]
pub async fn dismiss_invite(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    id: String,
) -> Result<FriendsView> {
    let ctx = require_account(&state)?;
    hub.dismiss_invite(&ctx, &id).await?;
    collect(&app, &hub, &ctx).await
}

/// Starts the default client on the server a friend is playing on.
///
/// The friend list is fetched again rather than taken from what the screen
/// last drew: a friend who changed servers a second ago would otherwise send
/// the player to the address they left.
#[tauri::command]
pub async fn join_friend(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, HubClient>,
    launch: tauri::State<'_, LaunchState>,
    user_id: String,
) -> Result<RunningGame> {
    let ctx = require_account(&state)?;
    let list = hub.get_friends(&ctx).await?;
    let address = joinable_address(&list.friends, &user_id)?;
    let client_id = default_client(&state)?;

    // The whole launch path, arguments included, belongs to `launch.rs`. A
    // second copy of it here is how `+connect` ends up in the wrong place on
    // one of the two screens that can start a game.
    launch::start_client(&app, &state, &launch, &client_id, Some(&address), &[])
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/// Where to call and who to call as, or the error that sends the player to the
/// Account card on the Settings screen.
///
/// Refusing here rather than letting the hub answer `401` costs no round trip
/// and gives the player the sentence that names the cure. The two refusals are
/// different cures, so they are different errors: a build with no hub cannot
/// be signed in to at all, while a signed-out one is one button away.
fn require_account(state: &AppState) -> Result<HubContext> {
    let ctx = HubContext::from_settings(&state.settings()?);
    // --- slice: hub gate ---
    if !ctx.configured() {
        return Err(AppError::HubNotConfigured);
    }
    if !ctx.signed_in() {
        return Err(AppError::SignedOut);
    }
    Ok(ctx)
}

/// The view a signed-out launcher shows: empty lists and the local presence.
fn signed_out(app: &AppHandle) -> FriendsView {
    FriendsView {
        signed_in: false,
        presence: app.state::<FriendsState>().presence(),
        ..FriendsView::default()
    }
}

/// Fetches both documents the screen needs and puts them in one answer.
async fn collect(app: &AppHandle, hub: &HubClient, ctx: &HubContext) -> Result<FriendsView> {
    // Two independent requests: waiting for them in turn would double the
    // time the screen spends on its spinner for no reason.
    let (list, mut invites) = tokio::try_join!(hub.get_friends(ctx), hub.list_invites(ctx))?;

    sort_invites(&mut invites);
    let state = app.state::<FriendsState>();
    Ok(FriendsView {
        signed_in: true,
        live: state.live(),
        friends: list.friends,
        incoming: list.incoming,
        outgoing: list.outgoing,
        invites,
        presence: state.presence(),
    })
}

/// Reads the fork of `POST /v1/friends/requests` into the answer of the
/// command.
///
/// The contract has two happy endings and tells them apart by status code:
/// `201` with the new request, and `200` with a friendship, which is what
/// happens when the other side had already asked. `SendRequestResult` carries
/// exactly one of the two, so a document with neither is a hub that broke its
/// own contract rather than a case the screen has to draw.
fn outcome_of(sent: SendRequestResult, state: FriendsView) -> Result<RequestSent> {
    if let Some(request) = sent.request {
        return Ok(RequestSent {
            outcome: "requested",
            display_name: request.to.display_name,
            state,
        });
    }
    if let Some(friend) = sent.friend {
        return Ok(RequestSent {
            outcome: "accepted",
            display_name: friend.user.display_name,
            state,
        });
    }
    Err(AppError::Hub {
        code: "internal".into(),
        message: "the hub accepted the request without saying what happened".into(),
    })
}

/// Newest invite first: the toast that matters is the one that just arrived.
fn sort_invites(invites: &mut [Invite]) {
    invites.sort_by(|a, b| b.created_at.cmp(&a.created_at));
}

/// Trims a friend query and refuses the two shapes the hub cannot use.
fn clean_query(query: &str) -> Result<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "type a display name, a jkhub: name or a user id".into(),
        ));
    }
    if trimmed.chars().count() > MAX_QUERY_LEN {
        return Err(AppError::InvalidInput(format!(
            "that name is longer than {MAX_QUERY_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// The address a friend can be joined at, or the reason there is none.
///
/// Split out of [`join_friend`] because the three refusals are the whole
/// behaviour worth testing, and the command around them needs a live hub.
fn joinable_address(friends: &[Friend], user_id: &str) -> Result<String> {
    let friend = friends
        .iter()
        .find(|friend| friend.user.id == user_id)
        .ok_or_else(|| AppError::NotFound(format!("friend {user_id}")))?;
    let name = friend.user.display_name.as_str();

    if !friend.presence.in_game() {
        return Err(AppError::Launch(format!("{name} is not in a game")));
    }
    friend
        .presence
        .server_address
        .as_deref()
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::Launch(format!("{name} is playing, but not on a server you can join"))
        })
}

/// The client the Play button starts, which is the one a join uses.
fn default_client(state: &AppState) -> Result<String> {
    state.settings()?.default_client_id.ok_or_else(|| {
        AppError::Launch("pick a default client on the Clients screen first".into())
    })
}

/// Turns a blank optional string into no string at all.
fn blank_to_none(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::HubUser;

    fn friend(id: &str, name: &str, presence: Presence) -> Friend {
        Friend {
            user: HubUser {
                id: id.into(),
                display_name: name.into(),
                provider: "jkhub".into(),
                provider_name: name.to_lowercase(),
                ..HubUser::default()
            },
            presence,
            friends_since: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn friends() -> Vec<Friend> {
        vec![
            friend(
                "in-game",
                "Kyle",
                Presence {
                    status: Presence::IN_GAME.into(),
                    server_address: Some(" 203.0.113.10:29070 ".into()),
                    server_name: Some("EU FFA".into()),
                    ..Presence::default()
                },
            ),
            friend(
                "menu",
                "Jan",
                Presence {
                    status: Presence::IN_GAME.into(),
                    ..Presence::default()
                },
            ),
            friend(
                "idle",
                "Luke",
                Presence {
                    status: Presence::ONLINE.into(),
                    ..Presence::default()
                },
            ),
        ]
    }

    #[test]
    fn joining_takes_the_address_of_a_friend_who_is_on_a_server() {
        assert_eq!(
            joinable_address(&friends(), "in-game").expect("an address"),
            "203.0.113.10:29070"
        );
    }

    #[test]
    fn joining_a_friend_in_the_main_menu_says_so_instead_of_launching() {
        // `in_game` without an address is the Play button: the game is open on
        // its menu. Launching with an empty `+connect` would drop the player
        // into their own menu and look like a bug in the join.
        let e = joinable_address(&friends(), "menu").expect_err("no address");
        assert!(e.to_string().contains("Jan"), "{e}");
        assert!(e.to_string().contains("not on a server"), "{e}");
    }

    #[test]
    fn joining_a_friend_who_is_only_online_says_so() {
        let e = joinable_address(&friends(), "idle").expect_err("not in a game");
        assert!(e.to_string().contains("Luke"), "{e}");
        assert!(e.to_string().contains("not in a game"), "{e}");
    }

    #[test]
    fn joining_somebody_who_is_not_a_friend_is_a_not_found() {
        let e = joinable_address(&friends(), "stranger").expect_err("not a friend");
        assert!(matches!(e, AppError::NotFound(_)), "{e}");
    }

    #[test]
    fn a_friend_query_is_trimmed_and_a_blank_one_is_refused() {
        assert_eq!(clean_query("  kyle_k  ").expect("a query"), "kyle_k");
        assert_eq!(
            clean_query("jkhub:kyle_k").expect("a provider query"),
            "jkhub:kyle_k"
        );
        assert!(clean_query("").is_err());
        assert!(clean_query("   \n ").is_err());
        // A paste of a whole profile page must not spend one of the ten
        // friend requests the hub allows per minute.
        assert!(clean_query(&"n".repeat(MAX_QUERY_LEN + 1)).is_err());
        assert!(clean_query(&"n".repeat(MAX_QUERY_LEN)).is_ok());
    }

    #[test]
    fn invites_are_newest_first() {
        let mut invites = vec![
            Invite {
                id: "old".into(),
                created_at: "2026-09-10T10:00:00Z".into(),
                ..Invite::default()
            },
            Invite {
                id: "new".into(),
                created_at: "2026-09-10T12:00:00Z".into(),
                ..Invite::default()
            },
        ];
        sort_invites(&mut invites);
        assert_eq!(invites[0].id, "new");
    }

    #[test]
    fn a_blank_server_name_is_no_server_name() {
        assert_eq!(blank_to_none(Some("  ".into())), None);
        assert_eq!(blank_to_none(None), None);
        assert_eq!(blank_to_none(Some("EU FFA".into())).as_deref(), Some("EU FFA"));
    }

    #[test]
    fn the_two_endings_of_a_friend_request_are_told_apart_by_which_field_is_set() {
        let asked = SendRequestResult {
            request: Some(FriendRequest {
                to: HubUser {
                    display_name: "Dash Rendar".into(),
                    ..HubUser::default()
                },
                ..FriendRequest::default()
            }),
            friend: None,
        };
        let sent = outcome_of(asked, FriendsView::default()).expect("a request went out");
        assert_eq!(sent.outcome, "requested");
        assert_eq!(sent.display_name, "Dash Rendar");

        // `200`: they had already asked, so the hub joined the two halves and
        // answered with the friendship instead of a request.
        let joined = SendRequestResult {
            request: None,
            friend: Some(friend("u", "Kyle", Presence::default())),
        };
        let sent = outcome_of(joined, FriendsView::default()).expect("a friendship");
        assert_eq!(sent.outcome, "accepted");
        assert_eq!(sent.display_name, "Kyle");

        // Neither field is a hub that broke its own contract, not a state the
        // screen has to draw.
        let nothing = SendRequestResult::default();
        assert!(outcome_of(nothing, FriendsView::default()).is_err());
    }

    #[test]
    fn a_signed_out_view_is_empty_and_says_so() {
        // The frontend switches on one boolean, so the lists have to be empty
        // rather than absent: a screen that reads `friends.length` on a signed
        // out launcher must see zero, not a crash.
        let view = FriendsView::default();
        assert!(!view.signed_in);
        assert!(!view.live);
        assert!(view.friends.is_empty());
        assert!(view.invites.is_empty());
        assert_eq!(view.presence.status, Presence::OFFLINE);
    }

    #[tokio::test]
    async fn only_a_different_account_wakes_the_background_tasks() {
        // The wake-up is what makes a sign-out stop the heartbeat and close
        // the socket, and a rename leave both alone. Both halves are one line
        // apart in `watch_the_account`, so both are worth pinning.
        let state = FriendsState::default();
        let mut tasks = state.account_changes();

        let signed_out = HubContext::default();
        let signed_in = HubContext {
            base_url: "http://127.0.0.1:8787".into(),
            token: Some("0123456789abcdef".into()),
        };

        assert!(state.note_account(account_fingerprint(&signed_in)));
        assert!(tasks.changed().await.is_ok(), "signing in wakes the tasks");

        // The same account again: `update_display_name` announces the same
        // event, and a rename must not drop a working socket.
        assert!(!state.note_account(account_fingerprint(&signed_in)));

        assert!(state.note_account(account_fingerprint(&signed_out)));
        assert!(tasks.changed().await.is_ok(), "signing out wakes the tasks");

        // Nothing else is pending, so a task that goes back to waiting waits.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), tasks.changed())
                .await
                .is_err(),
            "the tasks were woken by something that did not change"
        );
    }

    // --- slice: hub gate ---

    #[test]
    fn a_build_without_a_hub_keeps_both_background_tasks_quiet() {
        // The two gates are one question asked in two places: the heartbeat
        // stops at `HubContext::signed_in` in `presence::push`, and the live
        // socket at `HubContext::ws_url` in `live::socket_url`. A stale token
        // in `settings.json` must not get past either.
        let ctx = HubContext {
            base_url: String::new(),
            token: Some("0123456789abcdef".into()),
        };
        assert!(!ctx.configured());
        assert!(!ctx.signed_in(), "the heartbeat would push to nowhere");
        assert_eq!(ctx.ws_url(), None, "the socket would dial nowhere");
    }

    #[test]
    fn the_view_reaches_the_frontend_in_camel_case() {
        let json = serde_json::to_string(&FriendsView::default()).expect("serializes");
        assert!(json.contains("\"signedIn\":false"), "{json}");
        assert!(json.contains("\"incoming\":[]"), "{json}");
    }
}
