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

    /// Shared state could not be locked because another thread panicked while
    /// holding it.
    #[error("internal state is unavailable: {0}")]
    State(String),

    /// The feature is planned but the skeleton does not implement it yet.
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
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
