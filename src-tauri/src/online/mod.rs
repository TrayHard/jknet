//! JKNet Online: sign-in, the account, friends, presence and invites.
//!
//! JKNet Online is a small HTTPS service the launcher talks to over JSON; the
//! contract it implements is API v1, written down in `docs/architecture.md`.
//! This module is the launcher's whole side of it, so a screen never builds a
//! URL or reads a status code.
//!
//! | File       | What it holds                                          |
//! | ---------- | ------------------------------------------------------ |
//! | `types.rs` | the wire structures, unchanged on the way to the frontend |
//! | `client.rs`| the HTTP client, the error mapping and the pure checks |
//!
//! Two modules call it and neither owns it: `crate::account` signs in and
//! keeps the account, `crate::friends` does everything else. One connection
//! pool, one place where a token is attached to a request.
//!
//! ## Switched off in a release build
//!
//! The service is not deployed yet, so [`default_online_url`] answers with the
//! local service in a debug build and with nothing in a release build. A blank
//! address is not a failure: [`online_configured`] is false, every call refuses
//! with `AppError::OnlineNotConfigured` without touching the network, and the
//! screens draw a sentence saying the feature is not open yet. Naming the
//! public origin in `client::RELEASE_ONLINE_URL` switches it on for everybody,
//! and the **JKNet Online address** field on the Settings screen switches it on
//! for one machine without a new build.

mod client;
/// `pub(crate)` for its `MockOnline` helper: the live-socket test of
/// `crate::friends` starts the same stand-in.
#[cfg(test)]
pub(crate) mod mock_tests;
mod types;

pub use client::{
    default_online_url, is_http_url, is_local_online, normalize_display_name,
    normalize_online_url, online_configured, OnlineClient, OnlineContext, PROVIDERS,
};
/// The development service by name, for the tests of `account`, `settings` and
/// `friends`: they are about the account and not about which service a build
/// profile ships with, so they must not read `default_online_url()`.
///
/// `RELEASE_ONLINE_URL` and `default_online_url_for` stay inside `client.rs`
/// with its own tests: they are the two halves of the switch that turns the
/// service on, and the rest of the core asks `default_online_url()` and
/// `online_configured()`.
#[cfg(test)]
pub use client::DEV_ONLINE_URL;
// Only what another module names. `LoginSession`, `Me` and `FriendsList` are
// answers of `client.rs` that the callers destructure rather than name, so
// re-exporting them would be a public surface nothing asks for.
pub use types::{
    Friend, FriendRemoved, FriendRequest, Invite, LiveFrame, NewInvite, OnlineUser, Presence,
    PresenceUpdate, PresenceUpdated, SendRequestResult, SignInPoll,
};
