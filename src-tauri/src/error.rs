//! The single error type of the JKNet core.
//!
//! Every command returns `Result<T, AppError>`. The error reaches the frontend
//! as a plain string, so `ipc.ts` can surface `error.message` without knowing
//! the variants. Add a variant instead of returning a bare `String`: the
//! variant names are what makes a log line searchable.

use std::path::Path;

use serde::{Serialize, Serializer};
use thiserror::Error;

/// Result alias used by every module of the core.
pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    /// A file or directory operation failed. The path is part of the message
    /// because a bare `io::Error` says nothing useful in a log.
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },

    /// A JSON document on disk is unreadable or has the wrong shape.
    #[error("{context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },

    /// The data directory, `%LOCALAPPDATA%` or another required path is
    /// missing and cannot be created.
    #[error("path is not available: {0}")]
    Path(String),

    /// The caller asked for an entity that does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// The caller sent an argument the core refuses, such as an empty client
    /// name or an unknown engine id.
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// A conflicting entity already exists.
    #[error("already exists: {0}")]
    AlreadyExists(String),

    /// The same job is already running for the same target, so the second
    /// caller is refused instead of queued. The message is a whole sentence:
    /// it goes straight onto a card the player is looking at.
    #[error("{0}")]
    Busy(String),

    /// Shared state could not be locked because another thread panicked while
    /// holding it.
    #[error("internal state is unavailable: {0}")]
    State(String),

    /// A socket, a name lookup, an HTTP request or a remote peer failed. The
    /// message names the address, because "connection refused" alone is
    /// unusable in a log of a scan across a thousand servers. Covers both the
    /// UDP scan of the server browser and the GitHub API of the installer.
    #[error("network: {0}")]
    Network(String),

    /// The feature is planned but the skeleton does not implement it yet.
    /// Nothing returns it now that the last stub is gone; kept because the
    /// next stub needs it and `clippy` only complains about the dead variant.
    #[allow(dead_code)]
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),

    // --- slice: launch ---
    // The HTTP failures of the GitHub client share `Network` above with the
    // UDP failures of the server browser: one variant, one log prefix.
    /// GitHub refused an anonymous request because the hourly quota is spent.
    /// Separate from `Network` because the cure is waiting, not retrying.
    #[error("{0}")]
    RateLimited(String),

    /// A downloaded archive is unreadable, or an entry inside it points
    /// outside the folder it is being extracted into.
    #[error("archive error: {0}")]
    Archive(String),

    /// The game cannot be started: files missing, engine missing, or another
    /// game already running.
    #[error("cannot launch: {0}")]
    Launch(String),

    // --- slice: maps ---
    /// A map picture could not be read, converted or written. Separate from
    /// `Archive`, because the pk3 around a broken levelshot is usually fine.
    #[error("image error: {0}")]
    Image(String),

    // --- slice: friends ---
    /// Nobody is signed in, so there is no token to talk to the service with. Its
    /// own variant because the cure is the Account card on the Settings
    /// screen, not a retry.
    #[error("sign in to JKNet to see your friends")]
    SignedOut,

    // --- slice: account ---
    /// JKNet Online refused a request and said why in the code of its error
    /// document: `not_found`, `unauthorized`, `forbidden`, `invalid`,
    /// `conflict`, `rate_limited`, `provider_error` or `internal`.
    ///
    /// The code is part of the rendered message on purpose. An `AppError`
    /// reaches the frontend as a plain string, and the screens have to tell
    /// the codes apart: `provider_error` means "JKHub has not issued an OAuth
    /// client yet, keep the guest button", while `conflict` on the same screen
    /// means "that display name is taken, type another one". `onlineErrorCode`
    /// in `src/lib/ipc.ts` reads the prefix back out.
    #[error("online {code}: {message}")]
    Online { code: String, message: String },

    // --- slice: game core ---
    /// Two entities of different games were put together: a Jedi Outcast
    /// engine asked for a Jedi Academy client, a Jedi Academy server handed to
    /// a Jedi Outcast client. Its own variant because the cure is picking the
    /// other one, not fixing a path or a setting.
    #[error("{0}")]
    GameMismatch(String),

    /// The folder of one game is not configured, or the archives it needs are
    /// not in it. The message names the game, because a launcher that serves
    /// two of them has two folders to be wrong about.
    #[error("{game} game files: {reason}")]
    GameDataMissing {
        game: &'static str,
        reason: String,
    },

    /// A library command addressed a pk3 that belongs to the engine build,
    /// such as JK2MV's `assetsmv.pk3` mirrored into `home\base\`. Its own
    /// variant because there is nothing for the player to fix: the file is not
    /// theirs, and disabling it would stop the client from starting.
    #[error("{0} belongs to the engine build, not to the library")]
    EngineFile(String),

    /// Something real sits where the launcher keeps the link to the game's
    /// `base` folder, so [`crate::launch::prepare_basepath`] stops instead of
    /// deleting it.
    ///
    /// The rule behind the variant: JKNet removes a *link* it made, never a
    /// folder someone filled. A player who copied their archives in there by
    /// hand, or who replaced the link with a real folder, keeps every byte and
    /// gets a sentence naming the path.
    #[error(
        "{0} is a real folder, not the link JKNet keeps there. \
         Move it away or delete it, then start the game again."
    )]
    BasepathOccupied(String),

    // --- slice: online gate ---
    /// This build has no service address, so there is nothing to call.
    ///
    /// Not a network failure and not a sign-out: the service is not open yet,
    /// and the screens answer it with a sentence rather than an error box. It
    /// travels in the same `online <code>: <message>` envelope as [`AppError::Online`]
    /// so that `onlineErrorCode` in `src/lib/ipc.ts` reads it back like any other
    /// code — hence the doubled word: `online` is the envelope and
    /// [`ONLINE_NOT_CONFIGURED_CODE`] is the code inside it.
    #[error("online {}: JKNet Online is not configured in this build", ONLINE_NOT_CONFIGURED_CODE)]
    OnlineNotConfigured,

    // --- slice: jkhub ---
    /// jkhub.org could not be reached, answered with a status the reader does
    /// not expect, or has no cached copy of what was asked for. Separate from
    /// [`AppError::Network`] because the cure is different: the screens fall
    /// back to a stale cache and say so, rather than retrying.
    #[error("JKHub is unreachable: {0}")]
    JkhubUnavailable(String),

    /// A page of jkhub.org did not hold what the parser needs. Its own
    /// variant because it means the site changed, not that the network did,
    /// and the log line is what points at the parser to fix.
    #[error("JKHub page not understood: {what}")]
    JkhubParse { what: String },

    /// Fetching an archive failed: a refused key, a redirect that went
    /// nowhere, or a stream that stopped short of the announced size.
    #[error("JKHub download failed: {0}")]
    JkhubDownload(String),

    /// The archive is in a format this build cannot open. `rar` is the only
    /// one so far; the screens answer it with **Open on JKHub**.
    #[error("archives of type {format} cannot be opened by JKNet")]
    ArchiveUnsupported { format: String },

    /// The archive opened and holds no pk3 at all, which is what a config or
    /// a script package looks like. The names are in the message because the
    /// question the player asks next is "then what is inside".
    #[error("the archive holds no pk3 file: {entries}")]
    NoPk3Files { entries: String },
}

// --- slice: online gate ---
/// The code the frontend matches on for [`AppError::OnlineNotConfigured`].
///
/// Declared once so the rendered message and the frontend helper cannot drift
/// apart; the test below pins them together.
pub const ONLINE_NOT_CONFIGURED_CODE: &str = "online_not_configured";

impl From<reqwest::Error> for AppError {
    fn from(source: reqwest::Error) -> Self {
        AppError::Network(source.to_string())
    }
}

impl From<zip::result::ZipError> for AppError {
    fn from(source: zip::result::ZipError) -> Self {
        AppError::Archive(source.to_string())
    }
}

// --- slice: maps ---
impl From<image::ImageError> for AppError {
    fn from(source: image::ImageError) -> Self {
        AppError::Image(source.to_string())
    }
}

impl AppError {
    /// Wraps an IO error that happened while touching `path`.
    pub fn io_path(action: &str, path: &Path, source: std::io::Error) -> Self {
        AppError::Io {
            context: format!("{action} {}", path.display()),
            source,
        }
    }

    /// Wraps a serde error and remembers which document caused it.
    pub fn json(context: impl Into<String>, source: serde_json::Error) -> Self {
        AppError::Json {
            context: context.into(),
            source,
        }
    }
}

/// The frontend receives the rendered message, not the variant, so a command
/// rejection reads the same in the console and in the log file.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- slice: online gate ---
    #[test]
    fn a_missing_service_reaches_the_frontend_as_a_code_it_can_match_on() {
        // `onlineErrorCode` in `src/lib/ipc.ts` reads `^online ([a-z_]+): `, so the
        // envelope has to survive both the rendering and the serialization.
        let rendered = AppError::OnlineNotConfigured.to_string();
        assert_eq!(
            rendered,
            "online online_not_configured: JKNet Online is not configured in this build"
        );
        assert!(rendered.starts_with(&format!("online {ONLINE_NOT_CONFIGURED_CODE}: ")));

        let json = serde_json::to_string(&AppError::OnlineNotConfigured)
            .expect("an error serializes as a string");
        assert_eq!(json, format!("{rendered:?}"));
    }
}
