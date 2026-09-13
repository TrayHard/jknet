//! Bounded access to model dependencies in a client's enabled archives.
use crate::{
    appearance, clients,
    error::{AppError, Result},
    state::AppState,
    user_files,
};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use tauri::Manager;
use zip::ZipArchive;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAsset {
    pub name: String,
    pub path: Option<String>,
    pub text: Option<String>,
}

pub(crate) fn allowed(name: &str) -> bool {
    !name.contains("..")
        && !name.contains(['\\', ':'])
        && !name.starts_with('/')
        && [
            ".glm", ".gla", ".md3", ".skin", ".shader", ".sab", ".cfg", ".jpg", ".jpeg", ".png",
            ".tga", ".wav", ".mp3", ".ogg", ".flac", ".m4a", ".webp", ".gif", ".bmp", ".bsp",
        ]
        .iter()
        .any(|ext| name.ends_with(ext))
}

#[tauri::command]
pub async fn get_preview_assets(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    names: Vec<String>,
) -> Result<Vec<PreviewAsset>> {
    if names.len() > 512
        || names
            .iter()
            .any(|n| n != "@shaders" && n != "@sabers" && !allowed(&n.to_ascii_lowercase()))
    {
        return Err(AppError::InvalidInput(
            "invalid model dependency request".into(),
        ));
    }
    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    let sources = appearance::preview_sources(&paths, &state.settings()?, &client);
    tauri::async_runtime::spawn_blocking(move || {
        read_assets(
            Some(&app),
            &paths.cache.join("models"),
            &sources,
            &names,
            false,
        )
    })
    .await
    .map_err(|e| AppError::State(e.to_string()))?
}

pub(crate) fn is_text(name: &str) -> bool {
    [".skin", ".shader", ".sab", ".cfg"]
        .iter()
        .any(|ext| name.ends_with(ext))
}

pub(crate) fn read_assets(
    app: Option<&tauri::AppHandle>,
    cache: &Path,
    sources: &[PathBuf],
    names: &[String],
    normalize: bool,
) -> Result<Vec<PreviewAsset>> {
    if names.len() > 512
        || names.iter().any(|name| {
            name != "@shaders" && name != "@sabers" && !allowed(&name.to_ascii_lowercase())
        })
    {
        return Err(AppError::InvalidInput(
            "invalid preview dependency request".into(),
        ));
    }
    let names: Vec<_> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
    let mut found = BTreeMap::new();
    let mut budget = 128 * 1024 * 1024u64;
    // Resolve winners first so overridden dependencies do not consume the read budget.
    for source in sources.iter().rev() {
        let Ok(file) = File::open(source) else {
            continue;
        };
        let Ok(mut archive) = ZipArchive::new(file) else {
            continue;
        };
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| AppError::InvalidInput(e.to_string()))?;
            let name = if normalize {
                crate::file_preview::logical_name(entry.name())
            } else {
                Some(entry.name().to_ascii_lowercase())
            };
            let Some(name) = name else { continue };
            if found.contains_key(&name)
                || !allowed(&name)
                || !names.iter().any(|n| {
                    n == &name
                        || n == "@shaders"
                            && name.starts_with("shaders/")
                            && name.ends_with(".shader")
                        || n == "@sabers"
                            && name.starts_with("ext_data/sabers/")
                            && name.ends_with(".sab")
                })
            {
                continue;
            }
            let limit = if name.ends_with(".bsp") { 128 } else { 64 } * 1024 * 1024;
            if entry.size() > limit || entry.size() > budget {
                return Err(AppError::InvalidInput(
                    "model dependencies exceed the preview memory limit".into(),
                ));
            }
            let mut data = Vec::new();
            entry
                .by_ref()
                .take(limit + 1)
                .read_to_end(&mut data)
                .map_err(|e| AppError::io_path("cannot read preview", source, e))?;
            if data.len() as u64 > limit || data.len() as u64 > budget {
                return Err(AppError::InvalidInput(
                    "preview resource exceeds the memory limit".into(),
                ));
            }
            budget = budget.saturating_sub(data.len() as u64);
            found.insert(name, data);
        }
    }
    fs::create_dir_all(cache)
        .map_err(|e| AppError::io_path("cannot create preview cache", cache, e))?;
    let mut answer = Vec::new();
    for (name, data) in found {
        if is_text(&name) {
            answer.push(PreviewAsset {
                name,
                path: None,
                text: Some(String::from_utf8_lossy(&data).into_owned()),
            });
            continue;
        }
        let ext = if name.ends_with(".tga") {
            "png"
        } else {
            Path::new(&name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("bin")
        };
        let hash: String = Sha1::digest(&data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let file = cache.join(format!("{hash}.{ext}"));
        if !file.exists() {
            if name.ends_with(".tga") {
                let mut reader =
                    image::ImageReader::with_format(Cursor::new(&data), image::ImageFormat::Tga);
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(8192);
                limits.max_image_height = Some(8192);
                limits.max_alloc = Some(128 * 1024 * 1024);
                reader.limits(limits);
                let mut encoded = Cursor::new(Vec::new());
                reader
                    .decode()
                    .map_err(|e| AppError::InvalidInput(e.to_string()))?
                    .write_to(&mut encoded, image::ImageFormat::Png)
                    .map_err(|e| AppError::InvalidInput(e.to_string()))?;
                user_files::write_bytes(&file, encoded.get_ref())?;
            } else {
                user_files::write_bytes(&file, &data)?;
            }
        }
        if let Some(app) = app {
            app.asset_protocol_scope()
                .allow_file(&file)
                .map_err(|e| AppError::State(e.to_string()))?;
        }
        answer.push(PreviewAsset {
            name,
            path: Some(file.to_string_lossy().into_owned()),
            text: None,
        });
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dependencies_cannot_escape_or_read_other_file_types() {
        assert!(allowed("models/players/kyle/model.glm"));
        assert!(allowed("maps/mp/ffa3.bsp"));
        for n in [
            "../model.glm",
            "c:/model.glm",
            "/model.glm",
            "models\\model.glm",
            "settings.json",
            "../maps/ffa3.bsp",
            "c:/maps/ffa3.bsp",
        ] {
            assert!(!allowed(n));
        }
    }
}
