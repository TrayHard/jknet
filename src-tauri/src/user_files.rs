//! Shared storage helpers for user-authored media and configuration documents.
use crate::error::{AppError, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(crate) fn id() -> String {
    format!(
        "{:x}-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
pub(crate) fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(AppError::InvalidInput("invalid document id".into()));
    }
    Ok(())
}
pub(crate) fn valid_folder(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 100
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(AppError::InvalidInput("invalid game folder".into()));
    }
    Ok(())
}
pub(crate) fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| AppError::json(format!("cannot parse {}", path.display()), e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(AppError::io_path("cannot read", path, e)),
    }
}
pub(crate) fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::json("cannot serialize document", e))?;
    write_bytes(path, &bytes)
}
pub(crate) fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::io_path("cannot create folder", parent, e))?;
    }
    let temp = path.with_extension(format!("{}.tmp", id()));
    fs::write(&temp, bytes).map_err(|e| AppError::io_path("cannot write", &temp, e))?;
    fs::rename(&temp, path).map_err(|e| AppError::io_path("cannot replace", path, e))
}
pub(crate) fn label(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 240 || value.chars().any(char::is_control) {
        return Err(AppError::InvalidInput("invalid name".into()));
    }
    Ok(value.into())
}
