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
//! The commands that use it live in `crate::account`, and the Friends screen
//! is meant to call the same [`HubClient`] rather than a second one: one
//! connection pool, one place where a token is attached to a request.

mod client;
#[cfg(test)]
mod mock_tests;
mod types;

pub use client::{
    is_http_url, is_local_hub, normalize_display_name, normalize_hub_url, HubClient, HubContext,
    DEFAULT_HUB_URL, PROVIDERS,
};
pub use types::{
    Friend, FriendRequest, FriendsList, HubUser, Invite, LoginSession, Me, NewInvite, Presence,
    PresenceUpdate, SendRequestResult, SignInPoll,
};
