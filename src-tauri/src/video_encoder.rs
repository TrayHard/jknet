//! Versioned, verified FFmpeg runtime; no system installation or PATH edits.
use crate::{
    error::{AppError, Result},
    user_files,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const URL: &str = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/";
const HASH: &str = "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00";

pub fn ensure(root: &Path, cancelled: impl Fn() -> bool) -> Result<PathBuf> {
    let dir = root.join("tools/ffmpeg-6.1.1");
    let executable = dir.join("ffmpeg.exe");
    if let Ok(bytes) = fs::read(&executable) {
        if format!("{:x}", Sha256::digest(&bytes)) == HASH {
            return Ok(executable);
        }
    }
    tauri::async_runtime::block_on(async {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|e| AppError::Launch(e.to_string()))?;
        for (asset, target) in [
            ("win32-x64.LICENSE", "LICENSE"),
            ("win32-x64.README", "README"),
            ("ffmpeg-win32-x64", "ffmpeg.exe"),
        ] {
            if cancelled() {
                return Err(AppError::Launch("video export cancelled".into()));
            }
            let mut response = http
                .get(format!("{URL}{asset}"))
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| AppError::Launch(format!("cannot prepare video encoder: {e}")))?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| AppError::Launch(e.to_string()))?
            {
                if cancelled() {
                    return Err(AppError::Launch("video export cancelled".into()));
                }
                if bytes.len() + chunk.len() > 100 * 1024 * 1024 {
                    return Err(AppError::Launch(
                        "video encoder download exceeds limits".into(),
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            if asset == "ffmpeg-win32-x64" && format!("{:x}", Sha256::digest(&bytes)) != HASH {
                return Err(AppError::Launch("video encoder checksum mismatch".into()));
            }
            user_files::write_bytes(&dir.join(target), &bytes)?;
        }
        Ok(executable)
    })
}
