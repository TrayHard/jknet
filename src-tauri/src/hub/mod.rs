//! The JKNet hub: sign-in, the account, friends, presence and invites.
//!
//! The hub is a small HTTPS service the launcher talks to over JSON; the
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

mod client;
/// `pub(crate)` for its `MockHub` helper: the live-socket test of
/// `crate::friends` starts the same stand-in.
#[cfg(test)]
pub(crate) mod mock_tests;
mod types;

pub use client::{
    is_http_url, is_local_hub, normalize_display_name, normalize_hub_url, HubClient, HubContext,
    DEFAULT_HUB_URL, PROVIDERS,
};
// Only what another module names. `LoginSession`, `Me` and `FriendsList` are
// answers of `client.rs` that the callers destructure rather than name, so
// re-exporting them would be a public surface nothing asks for.
pub use types::{
    Friend, FriendRemoved, FriendRequest, HubUser, Invite, LiveFrame, NewInvite, Presence,
    PresenceUpdate, PresenceUpdated, SendRequestResult, SignInPoll,
};
