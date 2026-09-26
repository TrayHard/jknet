//! JKNet Online: sign-in, the account, friends, presence and invites.
//!
//! JKNet Online is a small HTTPS service the launcher talks to over JSON; the
//! contract it implements is API v1, written down in the architecture notes
//! kept outside the repository.
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
//! ## Default service
//!
//! [`default_online_url`] selects the local service in a debug build and
//! `https://api.jknet.app` in a release build. The **JKNet Online address** field
//! overrides the default for one machine. A blank effective address remains
//! supported: calls return `AppError::OnlineNotConfigured` without networking.

mod client;
/// `pub(crate)` for its `MockOnline` helper: the live-socket test of
/// `crate::friends` starts the same stand-in.
#[cfg(test)]
pub(crate) mod mock_tests;
mod types;

pub use client::{
    default_online_url, is_http_url, is_local_online, normalize_display_name,
    normalize_online_url, online_configured, path_segment, Auth, OnlineClient, OnlineContext,
    PROVIDERS,
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
/// The answer of `GET /v1/me`, for the test of `account` that pins how the
/// `admin` flag reads out of an older service and a newer one.
#[cfg(test)]
pub use types::Me;
// Only what another module names. `LoginSession`, `Me` and `FriendsList` are
// answers of `client.rs` that the callers destructure rather than name, so
// re-exporting them would be a public surface nothing asks for.
// `Auth` and `path_segment` are the two the bundles module names.
pub use types::{
    Friend, FriendRemoved, FriendRequest, HostingInfo, Invite, LiveFrame, NewInvite, OnlineUser,
    Presence, PresenceUpdate, PresenceUpdated, RelayGrant, SendRequestResult, SignInPoll,
};
// --- slice: chat ---
// The chat API: its wire types, which `crate::chat` keeps and forwards to the
// windows as they are, and the helpers that read its refusals. Only what
// `crate::chat` names; the structures nested inside these travel with them.
pub use client::{is_chat_unavailable, is_retryable, PageAnchor, SearchQuery};
pub use types::{
    AddResult, ChatMessage, ChatPrivacy, ChatPrivacyPatch, ChatQuota, ChatSyncDoc, Conversation,
    FileMeta, FileRef, GroupInvite, GroupResult, MessagePage, NewMessage, ReactionGroup,
    SearchPage,
};
/// The member entry of a conversation, which the tests of `crate::chat` build
/// summaries from.
#[cfg(test)]
pub use types::ChatMember;
