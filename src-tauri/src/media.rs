//! A persistent, content-addressed bank. Originals in client homes are never moved.
use crate::{
    clients, engines,
    error::{AppError, Result},
    game::Game,
    launch::{self, LaunchState, RunningGame},
    profiles,
    state::AppState,
    user_files,
};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaOrigin {
    pub client_id: String,
    pub client_name: String,
    pub source: String,
    pub created_at: u64,
    pub modified_at: u64,
    pub size: u64,
    pub date_is_modified: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub game: Game,
    pub extension: String,
    pub tags: Vec<String>,
    pub origins: Vec<MediaOrigin>,
    pub size: u64,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub source_demo: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct MediaBook {
    pub items: Vec<MediaItem>,
    #[serde(default)]
    pub deleted_ids: BTreeSet<String>,
}
fn book_path(state: &AppState) -> Result<PathBuf> {
    Ok(state.paths()?.root.join("media/index.json"))
}
pub(crate) fn media_file(state: &AppState, item: &MediaItem) -> Result<PathBuf> {
    user_files::valid_id(&item.id)?;
    if !item
        .extension
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(AppError::InvalidInput("invalid media extension".into()));
    }
    if !["demos", "screenshots", "videos"].contains(&item.kind.as_str()) {
        return Err(AppError::InvalidInput("invalid media kind".into()));
    }
    let name = item
        .file_name
        .clone()
        .unwrap_or_else(|| format!("{}.{}", item.id, item.extension));
    if name.is_empty()
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name == "."
        || name == ".."
    {
        return Err(AppError::InvalidInput("invalid media filename".into()));
    }
    Ok(state
        .paths()?
        .root
        .join("media")
        .join(&item.kind)
        .join(name))
}
fn seconds(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |t| t.as_secs())
}
fn import_id(path: &Path, game: Game, deleted: &BTreeSet<String>) -> Result<Option<String>> {
    let mut reader = BufReader::new(
        File::open(path).map_err(|e| AppError::io_path("cannot read media", path, e))?,
    );
    let mut hash = Sha1::new();
    hash.update(game.id());
    let mut buffer = [0u8; 65536];
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| AppError::io_path("cannot hash media", path, e))?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    let id: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((!deleted.contains(&id)).then_some(id))
}
fn files_under(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() >= 50000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files_under(&entry.path(), depth - 1, out);
        } else if kind.is_file() {
            out.push(entry.path());
        }
    }
}
fn image_at(path: &Path) -> Result<image::DynamicImage> {
    let mut reader = image::ImageReader::open(path)
        .map_err(|e| AppError::io_path("cannot read screenshot", path, e))?
        .with_guessed_format()
        .map_err(|e| AppError::io_path("cannot inspect screenshot", path, e))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| AppError::InvalidInput(format!("cannot decode screenshot: {e}")))
}
fn expose(app: &tauri::AppHandle, state: &AppState, item: &mut MediaItem) -> Result<()> {
    let source = media_file(state, item)?;
    let file = if item.kind == "screenshots" {
        let cache = state
            .paths()?
            .cache
            .join("screenshots")
            .join(format!("{}.png", item.id));
        if !cache.is_file() {
            let image = image_at(&source)?;
            if let Some(dir) = cache.parent() {
                fs::create_dir_all(dir)
                    .map_err(|e| AppError::io_path("cannot create screenshot cache", dir, e))?;
            }
            image
                .thumbnail(1600, 1600)
                .save(&cache)
                .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        }
        cache
    } else if item.kind == "videos" {
        let preview = state
            .paths()?
            .cache
            .join("videos")
            .join(format!("{}.mp4", item.id));
        if preview.is_file() {
            preview
        } else if item.extension == "avi" {
            item.preview = None;
            return Ok(());
        } else {
            source
        }
    } else {
        return Ok(());
    };
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(|e| AppError::State(e.to_string()))?;
    item.preview = Some(file.to_string_lossy().into_owned());
    Ok(())
}

#[tauri::command]
pub async fn list_media(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    refresh: bool,
) -> Result<Vec<MediaItem>> {
    let app_for_work = app.clone();
    let _ = state.paths()?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_work.state::<AppState>();
        let paths = state.paths()?;
        let _guard = state.client_records().enter();
        let mut book: MediaBook = user_files::read(&book_path(&state)?)?;
        if refresh {
            for client in clients::read_all(&paths)? {
                let home = paths.client_home_dir(&client.id);
                let mut files = Vec::new();
                files_under(&home, 8, &mut files);
                for path in files {
                    let ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let relative = path
                        .strip_prefix(&home)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let lower = relative.to_ascii_lowercase();
                    let kind = if client.game.demo_extensions().contains(&ext.as_str())
                        && lower.contains("/demos/")
                    {
                        "demos"
                    } else if ["png", "jpg", "jpeg", "tga", "bmp"].contains(&ext.as_str())
                        && lower.contains("/screenshots/")
                    {
                        "screenshots"
                    } else {
                        continue;
                    };
                    if path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.starts_with("jknet-"))
                    {
                        continue;
                    }
                    let Ok(meta) = fs::metadata(&path) else {
                        continue;
                    };
                    let modified = seconds(meta.modified());
                    if meta.len() == 0
                        || seconds(Ok(std::time::SystemTime::now())).saturating_sub(modified) < 3
                    {
                        continue;
                    }
                    if book.items.iter().any(|i| {
                        i.origins.iter().any(|o| {
                            o.client_id == client.id
                                && o.source == relative
                                && o.modified_at == modified
                                && o.size == meta.len()
                        })
                    }) {
                        continue;
                    }
                    let import = (|| -> Result<()> {
                        let Some(id) = import_id(&path, client.game, &book.deleted_ids)? else {
                            return Ok(());
                        };
                        let origin = MediaOrigin {
                            client_id: client.id.clone(),
                            client_name: client.name.clone(),
                            source: relative,
                            created_at: seconds(meta.created()).max(1),
                            modified_at: modified,
                            size: meta.len(),
                            date_is_modified: meta.created().is_err(),
                        };
                        let mut origin = origin;
                        if origin.date_is_modified {
                            origin.created_at = modified;
                        }
                        if let Some(item) = book.items.iter_mut().find(|i| i.id == id) {
                            if !item.origins.iter().any(|o| {
                                o.client_id == origin.client_id
                                    && o.source == origin.source
                                    && o.modified_at == origin.modified_at
                            }) {
                                item.origins.push(origin);
                            }
                            return Ok(());
                        }
                        let item = MediaItem {
                            id,
                            name: path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned(),
                            kind: kind.into(),
                            game: client.game,
                            extension: ext,
                            tags: Vec::new(),
                            origins: vec![origin],
                            size: meta.len(),
                            preview: None,
                            source_demo: None,
                            file_name: None,
                        };
                        let dest = media_file(&state, &item)?;
                        fs::create_dir_all(dest.parent().unwrap())
                            .map_err(|e| AppError::io_path("cannot create media bank", &dest, e))?;
                        let temp = dest.with_extension("importing");
                        fs::copy(&path, &temp)
                            .map_err(|e| AppError::io_path("cannot import media", &path, e))?;
                        let after = fs::metadata(&path)
                            .map_err(|e| AppError::io_path("cannot inspect media", &path, e))?;
                        if after.len() != meta.len() || seconds(after.modified()) != modified {
                            let _ = fs::remove_file(&temp);
                            return Ok(());
                        }
                        fs::rename(&temp, &dest).map_err(|e| {
                            AppError::io_path("cannot finish media import", &dest, e)
                        })?;
                        book.items.push(item);
                        Ok(())
                    })();
                    if let Err(error) = import {
                        log::warn!("media import skipped {}: {error}", path.display());
                    }
                }
            }
            user_files::write(&book_path(&state)?, &book)?;
        }
        for item in &mut book.items {
            if let Err(error) = expose(&app_for_work, &state, item) {
                log::warn!("media preview {}: {error}", item.id);
                item.preview = None;
            }
        }
        book.items
            .sort_by_key(|i| std::cmp::Reverse(i.origins.first().map_or(0, |o| o.created_at)));
        Ok(book.items)
    })
    .await
    .map_err(|e| AppError::State(e.to_string()))?
}

#[tauri::command]
pub fn update_media(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
    tags: Vec<String>,
) -> Result<()> {
    update_record(&state, id, name, tags)
}
fn update_record(state: &AppState, id: String, name: String, tags: Vec<String>) -> Result<()> {
    let _guard = state.client_records().enter();
    let path = book_path(state)?;
    let mut book: MediaBook = user_files::read(&path)?;
    let item = book
        .items
        .iter_mut()
        .find(|i| i.id == id)
        .ok_or_else(|| AppError::NotFound("media".into()))?;
    let old = media_file(state, item)?;
    item.name = user_files::label(&name)?;
    item.tags = tags
        .iter()
        .map(|t| user_files::label(t))
        .collect::<Result<Vec<_>>>()?;
    item.tags.sort();
    item.tags.dedup();
    let safe: String = item
        .name
        .chars()
        .take(100)
        .map(|c| {
            if c.is_alphanumeric() || [' ', '-', '_', '.'].contains(&c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    item.file_name = Some(format!(
        "{}-{}.{}",
        safe.trim_end_matches([' ', '.']),
        &item.id[..item.id.len().min(8)],
        item.extension
    ));
    let new = media_file(state, item)?;
    if old != new {
        fs::rename(&old, &new).map_err(|e| AppError::io_path("cannot rename media", &old, e))?;
    }
    if let Err(error) = user_files::write(&path, &book) {
        if old != new {
            let _ = fs::rename(&new, &old);
        }
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub fn delete_media(
    state: tauri::State<'_, AppState>,
    videos: tauri::State<'_, crate::video::VideoState>,
    id: String,
) -> Result<()> {
    let ids = BTreeSet::from([id]);
    videos.with_idle_media(&ids, || delete_records(&state, &ids))
}

#[tauri::command]
pub async fn delete_media_batch(app: tauri::AppHandle, ids: Vec<String>) -> Result<()> {
    let ids: BTreeSet<String> = ids.into_iter().collect();
    if ids.is_empty() {
        return Err(AppError::InvalidInput("select media to delete".into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let videos = app.state::<crate::video::VideoState>();
        videos.with_idle_media(&ids, || delete_records(&state, &ids))
    })
    .await
    .map_err(|error| AppError::State(error.to_string()))?
}

#[cfg(test)]
fn delete_record(state: &AppState, id: &str) -> Result<()> {
    delete_records(state, &BTreeSet::from([id.into()]))
}

fn delete_records(state: &AppState, ids: &BTreeSet<String>) -> Result<()> {
    let _guard = state.client_records().enter();
    let index = book_path(state)?;
    let mut book: MediaBook = user_files::read(&index)?;
    let selected: Vec<_> = book
        .items
        .iter()
        .filter(|item| ids.contains(&item.id))
        .collect();
    // Resolve the entire selection before touching any file. A missing item
    // or active render must not leave a partially deleted group.
    if selected.len() != ids.len() {
        return Err(AppError::NotFound(
            "one or more selected media items".into(),
        ));
    }
    let paths = state.paths()?;
    let mut files = BTreeSet::new();
    for item in selected {
        files.insert(media_file(state, item)?);
        let id = &item.id;
        match item.kind.as_str() {
            "screenshots" => {
                files.insert(paths.cache.join("screenshots").join(format!("{id}.png")));
            }
            "videos" => {
                files.insert(paths.cache.join("videos").join(format!("{id}.mp4")));
            }
            _ => (),
        }
    }
    // Move only the bank file and its known preview. Origins and rendered
    // derivatives are independent objects, never deletion targets.
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| {
        for file in files {
            match fs::symlink_metadata(&file) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(AppError::io_path("cannot inspect media", &file, error)),
                Ok(meta) if !meta.file_type().is_file() => {
                    return Err(AppError::InvalidInput(
                        "media deletion requires a regular file".into(),
                    ))
                }
                Ok(_) => (),
            }
            let temp = file.with_extension(format!("delete-{}", user_files::id()));
            fs::rename(&file, &temp)
                .map_err(|error| AppError::io_path("cannot delete media", &file, error))?;
            staged.push((file, temp));
        }
        book.items.retain(|item| !ids.contains(&item.id));
        book.deleted_ids.extend(ids.iter().cloned());
        user_files::write(&index, &book)
    })();
    if let Err(error) = result {
        for (file, temp) in staged.into_iter().rev() {
            if let Err(restore) = fs::rename(&temp, &file) {
                log::error!(
                    "cannot restore deleted media {} from {}: {restore}",
                    file.display(),
                    temp.display()
                );
            }
        }
        return Err(error);
    }
    for (_, temp) in staged {
        if let Err(error) = fs::remove_file(&temp) {
            log::warn!("cannot clean deleted media {}: {error}", temp.display());
        }
    }
    Ok(())
}

pub(crate) fn find_item(state: &AppState, id: &str) -> Result<MediaItem> {
    let book: MediaBook = user_files::read(&book_path(state)?)?;
    book.items
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| AppError::NotFound("media".into()))
}
#[tauri::command]
pub fn open_media_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<()> {
    let file = media_file(&state, &find_item(&state, &id)?)?;
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|e| AppError::State(e.to_string()))
}
#[tauri::command]
pub fn copy_screenshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<()> {
    let item = find_item(&state, &id)?;
    if item.kind != "screenshots" {
        return Err(AppError::InvalidInput("not a screenshot".into()));
    }
    let image = image_at(&media_file(&state, &item)?)?.to_rgba8();
    app.clipboard()
        .write_image(&tauri::image::Image::new_owned(
            image.as_raw().clone(),
            image.width(),
            image.height(),
        ))
        .map_err(|e| AppError::State(e.to_string()))
}
#[tauri::command]
pub fn play_media_demo(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    launch: tauri::State<'_, LaunchState>,
    id: String,
    client_id: String,
) -> Result<RunningGame> {
    let item = find_item(&state, &id)?;
    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    if item.kind != "demos"
        || item.game != client.game
        || !client
            .game
            .demo_extensions()
            .contains(&item.extension.as_str())
    {
        return Err(AppError::InvalidInput(
            "demo is incompatible with this client".into(),
        ));
    }
    let engine = engines::require(&client.engine_id)?;
    let folder = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game)
        .unwrap_or("base");
    user_files::valid_folder(folder)?;
    let name = format!("jknet-{}.{}", item.id, item.extension);
    let dest = paths
        .client_home_dir(&client_id)
        .join(folder)
        .join("demos")
        .join(&name);
    fs::create_dir_all(dest.parent().unwrap())
        .map_err(|e| AppError::io_path("cannot create demo folder", &dest, e))?;
    fs::copy(media_file(&state, &item)?, &dest)
        .map_err(|e| AppError::io_path("cannot stage demo", &dest, e))?;
    launch::start_client(
        &app,
        &state,
        &launch,
        &client_id,
        None,
        &["+demo".into(), name],
        profiles::ProfileChoice::default(),
        crate::engines::LaunchMode::Multiplayer,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_delete_rolls_back_every_staged_item_and_preserves_unselected_files() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let mut items = Vec::new();
        let mut files = Vec::new();
        for (id, kind, extension) in [
            ("bulk-demo", "demos", "dm_26"),
            ("bulk-shot", "screenshots", "tga"),
            ("bulk-video", "videos", "mp4"),
            ("keep", "screenshots", "tga"),
        ] {
            let mut item = screenshot();
            item.id = id.into();
            item.kind = kind.into();
            item.extension = extension.into();
            let file = media_file(&state, &item).unwrap();
            if id == "bulk-video" {
                // Sorted after the demo and screenshot, so the failure must
                // roll back files that have already been staged.
                fs::create_dir_all(&file).unwrap();
            } else {
                user_files::write_bytes(&file, id.as_bytes()).unwrap();
            }
            files.push(file);
            items.push(item);
        }
        user_files::write(
            &book_path(&state).unwrap(),
            &MediaBook {
                items,
                ..Default::default()
            },
        )
        .unwrap();
        let selection =
            BTreeSet::from(["bulk-demo".into(), "bulk-shot".into(), "bulk-video".into()]);
        assert!(delete_records(&state, &selection).is_err());
        assert_eq!(fs::read(&files[0]).unwrap(), b"bulk-demo");
        assert_eq!(fs::read(&files[1]).unwrap(), b"bulk-shot");
        assert_eq!(fs::read(&files[3]).unwrap(), b"keep");
        let unchanged: MediaBook = user_files::read(&book_path(&state).unwrap()).unwrap();
        assert_eq!(unchanged.items.len(), 4);
        assert!(unchanged.deleted_ids.is_empty());
        fs::remove_dir(&files[2]).unwrap();
        fs::write(&files[2], b"video").unwrap();
        let missing = BTreeSet::from(["bulk-demo".into(), "missing".into()]);
        assert!(delete_records(&state, &missing).is_err());
        assert!(files[0].is_file());
        delete_records(&state, &selection).unwrap();
        assert!(files[..3].iter().all(|file| !file.exists()));
        assert_eq!(fs::read(&files[3]).unwrap(), b"keep");
        let reopened = AppState::bootstrap(temp.path().into());
        let book: MediaBook = user_files::read(&book_path(&reopened).unwrap()).unwrap();
        assert_eq!(book.items.len(), 1);
        assert_eq!(book.items[0].id, "keep");
        assert_eq!(book.deleted_ids, selection);
    }
    #[test]
    fn deletion_removes_each_media_kind_and_preview_without_reimport_or_cascades() {
        for (kind, extension) in [
            ("demos", "dm_26"),
            ("screenshots", "tga"),
            ("videos", "mp4"),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let state = AppState::bootstrap(temp.path().into());
            let original = temp.path().join(format!("client-original.{extension}"));
            fs::write(&original, b"original bytes").unwrap();
            let mut item = screenshot();
            item.id = import_id(&original, item.game, &BTreeSet::new())
                .unwrap()
                .unwrap();
            item.kind = kind.into();
            item.extension = extension.into();
            item.file_name = Some(format!("Renamed media.{extension}"));
            let file = media_file(&state, &item).unwrap();
            user_files::write_bytes(&file, b"original bytes").unwrap();
            let preview = state
                .paths()
                .unwrap()
                .cache
                .join(if kind == "screenshots" {
                    "screenshots"
                } else {
                    "videos"
                })
                .join(format!(
                    "{}.{}",
                    item.id,
                    if kind == "screenshots" { "png" } else { "mp4" }
                ));
            if kind != "demos" {
                user_files::write_bytes(&preview, b"preview").unwrap();
            }
            let mut other = screenshot();
            other.id = "unrelated-video".into();
            other.kind = "videos".into();
            other.extension = "mp4".into();
            other.source_demo = Some(item.id.clone());
            let other_file = media_file(&state, &other).unwrap();
            user_files::write_bytes(&other_file, b"other video").unwrap();
            user_files::write(
                &book_path(&state).unwrap(),
                &MediaBook {
                    items: vec![item.clone(), other],
                    ..Default::default()
                },
            )
            .unwrap();
            delete_record(&state, &item.id).unwrap();
            assert!(!file.exists());
            assert!(!preview.exists());
            assert_eq!(fs::read(&original).unwrap(), b"original bytes");
            assert_eq!(fs::read(other_file).unwrap(), b"other video");
            let reopened = AppState::bootstrap(temp.path().into());
            let book: MediaBook = user_files::read(&book_path(&reopened).unwrap()).unwrap();
            assert_eq!(book.items.len(), 1);
            assert!(import_id(&original, item.game, &book.deleted_ids)
                .unwrap()
                .is_none());
            fs::write(&original, b"different recording").unwrap();
            assert!(import_id(&original, item.game, &book.deleted_ids)
                .unwrap()
                .is_some());
        }
    }
    #[test]
    fn failed_preview_deletion_restores_bank_file_and_keeps_index() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let item = screenshot();
        let file = media_file(&state, &item).unwrap();
        user_files::write_bytes(&file, b"keep").unwrap();
        let preview = state
            .paths()
            .unwrap()
            .cache
            .join("screenshots")
            .join(format!("{}.png", item.id));
        fs::create_dir_all(&preview).unwrap();
        user_files::write(
            &book_path(&state).unwrap(),
            &MediaBook {
                items: vec![item.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(delete_record(&state, &item.id).is_err());
        assert_eq!(fs::read(file).unwrap(), b"keep");
        assert!(find_item(&state, &item.id).is_ok());
        assert!(preview.is_dir());
    }
    #[test]
    fn missing_file_can_be_removed_from_a_legacy_index() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let item = screenshot();
        let legacy = serde_json::json!({"items": [item.clone()]});
        user_files::write(&book_path(&state).unwrap(), &legacy).unwrap();
        delete_record(&state, &item.id).unwrap();
        assert!(find_item(&state, &item.id).is_err());
    }
    fn screenshot() -> MediaItem {
        MediaItem {
            id: "abcdef0123456789".into(),
            name: "shot".into(),
            kind: "screenshots".into(),
            game: Game::default(),
            extension: "tga".into(),
            tags: Vec::new(),
            origins: Vec::new(),
            size: 4,
            preview: None,
            source_demo: None,
            file_name: None,
        }
    }
    #[test]
    fn rename_preserves_bytes_original_and_metadata_after_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let item = screenshot();
        let old = media_file(&state, &item).unwrap();
        let original = temp.path().join("client-original.tga");
        fs::write(&original, b"original").unwrap();
        user_files::write_bytes(&old, b"image bytes").unwrap();
        user_files::write(
            &book_path(&state).unwrap(),
            &MediaBook {
                items: vec![item.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        update_record(
            &state,
            item.id.clone(),
            "My screenshot".into(),
            vec!["duel".into(), "duel".into(), "friends".into()],
        )
        .unwrap();
        let restored = find_item(&state, &item.id).unwrap();
        assert_eq!(restored.name, "My screenshot");
        assert_eq!(restored.tags, ["duel", "friends"]);
        assert_eq!(
            fs::read(media_file(&state, &restored).unwrap()).unwrap(),
            b"image bytes"
        );
        assert_eq!(fs::read(original).unwrap(), b"original");
        assert!(!old.exists());
    }
    #[test]
    fn corrupted_bank_cannot_reveal_outside_files() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let mut item = screenshot();
        item.kind = "../../outside".into();
        assert!(media_file(&state, &item).is_err());
        item.kind = "screenshots".into();
        item.file_name = Some("../outside.tga".into());
        assert!(media_file(&state, &item).is_err());
    }
    #[test]
    fn tga_is_decoded_to_the_original_rgba_pixels() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("shot.tga");
        let pixels = image::RgbaImage::from_pixel(3, 2, image::Rgba([35, 75, 190, 255]));
        pixels.save(&path).unwrap();
        assert_eq!(image_at(&path).unwrap().to_rgba8(), pixels);
    }
}
