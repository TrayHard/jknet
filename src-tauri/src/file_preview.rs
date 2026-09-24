//! Read-only package previews. The selected archive overrides its dependencies.
use crate::{
    appearance, clients,
    error::{AppError, Result},
    game::Game,
    library, model_preview,
    paths::DataPaths,
    settings::Settings,
    state::AppState,
    user_files,
};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

/// The limit of one archive: the walk of `crate::archive` shares it with the
/// report of a library file and the listing of a bundle.
const MAX_ENTRIES: usize = crate::archive::MAX_ENTRIES;
const MAX_GAME_ENTRIES: usize = 200_000;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone)]
struct Context {
    sources: Vec<PathBuf>,
    dependencies: Vec<PathBuf>,
    cache: PathBuf,
    prefer_selected: bool,
}
static CONTEXTS: LazyLock<Mutex<BTreeMap<String, Context>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    pub id: String,
    pub archive: usize,
    pub name: String,
    pub size: u64,
    pub kind: String,
    pub model: Option<String>,
    pub skins: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub id: String,
    pub archives: Vec<String>,
    pub entries: Vec<crate::file_preview_products::PreviewProduct>,
}

/// ZIP names are never filesystem destinations. Wrapper folders are removed only
/// from the logical game path used to match dependencies.
pub(crate) fn logical_name(name: &str) -> Option<String> {
    let name = name.replace('\\', "/").to_ascii_lowercase();
    if name.len() > 1024
        || name.starts_with('/')
        || name.contains(':')
        || name.chars().any(char::is_control)
        || name.split('/').any(|part| part == ".." || part.is_empty())
    {
        return None;
    }
    let parts: Vec<_> = name.split('/').collect();
    let root = parts.iter().position(|part| {
        matches!(
            *part,
            "models"
                | "sound"
                | "music"
                | "textures"
                | "shaders"
                | "ext_data"
                | "ui"
                | "gfx"
                | "effects"
                | "scripts"
                | "maps"
                | "levelshots"
                | "strings"
                | "menu"
                | "fonts"
                | "botfiles"
                | "botroutes"
                | "forcecfg"
                | "video"
                | "strip"
                | "vm"
                | "configs"
                | "eagle"
        )
    });
    Some(root.map(|at| parts[at..].join("/")).unwrap_or(name))
}

fn kind(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "glm" | "md3" => "model",
        "wav" | "mp3" | "ogg" | "flac" | "m4a" => "audio",
        "jpg" | "jpeg" | "png" | "tga" | "webp" | "gif" | "bmp" => "image",
        "bsp" => "map",
        _ if model_preview::is_text(name) => "text",
        _ => "other",
    }
}

fn inspect(sources: &[PathBuf], dependencies: &[PathBuf]) -> Result<Vec<PreviewEntry>> {
    inspect_packages(sources, dependencies, false)
}

pub(crate) fn inspect_packages(
    sources: &[PathBuf],
    dependencies: &[PathBuf],
    combined: bool,
) -> Result<Vec<PreviewEntry>> {
    let limit = if combined {
        MAX_GAME_ENTRIES
    } else {
        MAX_ENTRIES
    };
    let mut packages = Vec::new();
    let mut total_entries = 0;
    for path in sources {
        let file = File::open(path)
            .map_err(|e| AppError::io_path("cannot open preview archive", path, e))?;
        let mut archive = ZipArchive::new(file)?;
        total_entries += archive.len();
        if archive.len() > limit || total_entries > limit {
            return Err(AppError::InvalidInput(
                "package has too many preview entries".into(),
            ));
        }
        let mut names = HashMap::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index)?;
            if entry.is_dir() {
                continue;
            }
            let Some(name) = logical_name(entry.name()) else {
                continue;
            };
            if name.ends_with(".pk3") {
                continue;
            }
            names.entry(name).or_insert(entry.size());
        }
        packages.push(names);
    }
    if combined {
        let mut names = HashMap::new();
        for package in packages {
            names.extend(package);
        }
        packages = vec![names];
    }
    let mut entries = Vec::new();
    for (archive_id, names) in packages.iter().enumerate() {
        for (name, size) in names {
            let mut entry_kind = kind(name);
            let mut model = (entry_kind == "model").then(|| name.clone());
            let mut skins = Vec::new();
            if name.ends_with(".skin") && name.starts_with("models/") {
                let directory = name.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
                let siblings: Vec<_> = names
                    .keys()
                    .filter(|n| {
                        n.starts_with(&format!("{directory}/"))
                            && n.rsplit_once('/').map(|(dir, _)| dir) == Some(directory)
                            && matches!(kind(n), "model")
                    })
                    .collect();
                let conventional = format!("{directory}/model.glm");
                model = Some(if siblings.len() == 1 {
                    siblings[0].clone()
                } else {
                    conventional
                });
                skins.push(name.clone());
                entry_kind = "model";
            } else if entry_kind == "model" {
                let directory = name.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
                for candidate in [
                    format!("{directory}/model_default.skin"),
                    name.replace(".glm", ".skin").replace(".md3", ".skin"),
                ] {
                    if names.contains_key(&candidate) {
                        skins.push(candidate);
                        break;
                    }
                }
            }
            entries.push(PreviewEntry {
                id: format!("{archive_id}:{name}"),
                archive: archive_id,
                name: name.clone(),
                size: *size,
                kind: entry_kind.into(),
                model,
                skins,
            });
        }
    }
    // A texture-only reskin still has a model: find it in the dependency archives.
    let mut by_prefix: HashMap<String, Vec<usize>> = HashMap::new();
    for entry in &entries {
        if !matches!(entry.kind.as_str(), "image" | "model") {
            continue;
        }
        let parts: Vec<_> = entry.name.split('/').collect();
        if parts.len() < 4 || parts[0] != "models" {
            continue;
        }
        let prefix = format!("{}/{}/{}/", parts[0], parts[1], parts[2]);
        let archives = by_prefix.entry(prefix).or_default();
        if !archives.contains(&entry.archive) {
            archives.push(entry.archive);
        }
    }
    let mut known: std::collections::HashSet<_> = entries
        .iter()
        .filter_map(|entry| {
            entry
                .model
                .as_ref()
                .map(|model| (entry.archive, model.clone()))
        })
        .collect();
    let mut skin_choices: HashMap<String, std::collections::BTreeSet<String>> = HashMap::new();
    for path in dependencies.iter().chain(sources) {
        let Ok(file) = File::open(path) else {
            continue;
        };
        let Ok(mut archive) = ZipArchive::new(file) else {
            continue;
        };
        for index in 0..archive.len().min(limit) {
            let entry = archive.by_index(index)?;
            let Some(name) = logical_name(entry.name()) else {
                continue;
            };
            let parts: Vec<_> = name.split('/').collect();
            if parts.len() < 4 {
                continue;
            }
            let prefix = format!("{}/{}/{}/", parts[0], parts[1], parts[2]);
            if name.ends_with(".skin") && by_prefix.contains_key(&prefix) {
                skin_choices.entry(prefix).or_default().insert(name);
                continue;
            }
            if kind(&name) != "model" {
                continue;
            }
            if let Some(archives) = by_prefix.get(&prefix) {
                for selected in archives {
                    if !known.insert((*selected, name.clone())) {
                        continue;
                    }
                    let skins =
                        if name.ends_with("/model.glm") && name.starts_with("models/players/") {
                            vec![format!(
                                "{}model_default.skin",
                                name.trim_end_matches("model.glm")
                            )]
                        } else {
                            Vec::new()
                        };
                    entries.push(PreviewEntry {
                        id: format!("{selected}:dependency:{name}"),
                        archive: *selected,
                        name: name.clone(),
                        size: entry.size(),
                        kind: "model".into(),
                        model: Some(name.clone()),
                        skins,
                    });
                }
            }
        }
    }
    // Customizable characters use three sections, even when a fixed default skin exists.
    // Assemble a complete character, preferring sections supplied by this package.
    let supplied: std::collections::HashSet<_> = entries
        .iter()
        .filter(|entry| entry.name.ends_with(".skin"))
        .map(|entry| (entry.archive, entry.name.clone()))
        .collect();
    let customizable: std::collections::HashSet<_> = entries
        .iter()
        .filter_map(|entry| {
            entry
                .name
                .strip_suffix("playerchoice.txt")
                .map(str::to_owned)
        })
        .collect();
    for entry in &mut entries {
        let Some(model) = entry
            .model
            .as_ref()
            .filter(|model| model.starts_with("models/players/") && model.ends_with("/model.glm"))
        else {
            continue;
        };
        let prefix = model.trim_end_matches("model.glm");
        let Some(choices) = skin_choices.get(prefix) else {
            continue;
        };
        let default = format!("{prefix}model_default.skin");
        let assemble_default = customizable.contains(prefix)
            && (entry.skins.is_empty() || entry.skins == [default.clone()]);
        if choices.contains(&default) && !assemble_default {
            if entry.skins.is_empty() {
                entry.skins.push(default);
            }
            continue;
        }
        let complete: Vec<_> = ["head_", "torso_", "lower_"]
            .iter()
            .filter_map(|part| {
                let start = format!("{prefix}{part}");
                choices
                    .iter()
                    .filter(|name| name.starts_with(&start))
                    .min_by_key(|name| {
                        (!supplied.contains(&(entry.archive, (*name).clone())), *name)
                    })
                    .cloned()
            })
            .collect();
        if complete.len() == 3 {
            entry.skins = complete;
        }
    }
    if entries.len() > limit {
        return Err(AppError::InvalidInput(
            "package has too many preview entries".into(),
        ));
    }
    let priority = |kind: &str| match kind {
        "model" => 0,
        "audio" => 1,
        "image" => 2,
        "text" => 3,
        "map" => 4,
        _ => 5,
    };
    entries.sort_by(|a, b| {
        priority(&a.kind)
            .cmp(&priority(&b.kind))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.archive.cmp(&b.archive))
    });
    Ok(entries)
}

pub(crate) fn dependencies(
    data: &DataPaths,
    settings: &Settings,
    client_id: Option<&str>,
    game: Game,
) -> Result<Vec<PathBuf>> {
    if let Some(id) = client_id {
        let client = clients::read_record(data, id)?;
        if client.game != game {
            return Err(AppError::InvalidInput(
                "preview client belongs to another game".into(),
            ));
        }
        return Ok(appearance::preview_sources(data, settings, &client));
    }
    let mut sources: Vec<_> = settings
        .game_data_path(game)
        .and_then(|path| fs::read_dir(Path::new(path).join("base")).ok())
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pk3"))
        })
        .collect();
    sources.sort_by_key(|path| {
        library::pak_order(&path.file_name().unwrap_or_default().to_string_lossy())
    });
    Ok(sources)
}

pub(crate) fn prepare(
    data: &DataPaths,
    sources: Vec<PathBuf>,
    dependencies: Vec<PathBuf>,
) -> Result<FilePreview> {
    let entries = inspect(&sources, &dependencies)?;
    let mut entries = crate::file_preview_products::products(&sources, &entries)?;
    enrich_products(
        &sources,
        &mut entries,
        &data.cache.join("file-previews/icons"),
    )?;
    register_context(data, sources, dependencies, entries, true)
}

pub(crate) fn register_context(
    data: &DataPaths,
    sources: Vec<PathBuf>,
    dependencies: Vec<PathBuf>,
    entries: Vec<crate::file_preview_products::PreviewProduct>,
    prefer_selected: bool,
) -> Result<FilePreview> {
    let archives = sources
        .iter()
        .map(|path| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    let id = user_files::id();
    let mut contexts = CONTEXTS
        .lock()
        .map_err(|e| AppError::State(e.to_string()))?;
    if contexts.len() >= 64 {
        contexts.pop_first();
    }
    contexts.insert(
        id.clone(),
        Context {
            sources,
            dependencies,
            cache: data.cache.join("file-previews").join("assets"),
            prefer_selected,
        },
    );
    Ok(FilePreview {
        id,
        archives,
        entries,
    })
}

fn enrich_products(
    sources: &[PathBuf],
    entries: &mut [crate::file_preview_products::PreviewProduct],
    cache: &Path,
) -> Result<()> {
    for (archive, path) in sources.iter().enumerate() {
        if !entries
            .iter()
            .any(|entry| entry.archive == archive && matches!(entry.kind.as_str(), "skin" | "npc"))
        {
            continue;
        }
        let meta =
            fs::metadata(path).map_err(|error| AppError::io_path("cannot inspect", path, error))?;
        let signature = format!(
            "{}:{}:{:?}",
            path.display(),
            meta.len(),
            meta.modified().ok()
        );
        let key: String = Sha1::digest(signature.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let directory = cache.join(key);
        let models = crate::appearance::preview_models(path, &directory)?;
        for entry in entries.iter_mut().filter(|entry| entry.archive == archive) {
            attach_appearance(entry, &models);
        }
    }
    Ok(())
}

pub(crate) fn attach_appearance(
    entry: &mut crate::file_preview_products::PreviewProduct,
    models: &[crate::appearance::PlayerModel],
) {
    let Some(model) = entry
        .model
        .as_deref()
        .and_then(|name| name.strip_prefix("models/players/"))
        .and_then(|name| name.split('/').next())
    else {
        return;
    };
    entry.appearance = models
        .iter()
        .find(|candidate| {
            candidate.model == model
                && if entry.skins.len() == 3 {
                    candidate.parts.is_some()
                } else {
                    entry
                        .skins
                        .iter()
                        .any(|skin| skin.ends_with(&format!("/model_{}.skin", candidate.variant)))
                }
        })
        .cloned();
}

pub(crate) fn allow_icons(app: &tauri::AppHandle, preview: &FilePreview) {
    let models: Vec<_> = preview
        .entries
        .iter()
        .filter_map(|entry| entry.appearance.clone())
        .collect();
    crate::appearance::allow_icons(app, &models);
}

#[tauri::command]
pub async fn preview_library_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    item_id: String,
) -> Result<FilePreview> {
    let data = state.paths()?;
    let client = clients::read_record(&data, &client_id)?;
    let archive = library::preview_path(&data, &client_id, &item_id)?;
    let deps = dependencies(&data, &state.settings()?, Some(&client_id), client.game)?;
    let preview = tauri::async_runtime::spawn_blocking(move || prepare(&data, vec![archive], deps))
        .await
        .map_err(|e| AppError::State(e.to_string()))??;
    allow_icons(&app, &preview);
    Ok(preview)
}

#[tauri::command]
pub async fn get_file_preview_assets(
    app: tauri::AppHandle,
    preview_id: String,
    archive: usize,
    names: Vec<String>,
) -> Result<Vec<model_preview::PreviewAsset>> {
    tauri::async_runtime::spawn_blocking(move || {
        read_context_assets(Some(&app), &preview_id, archive, &names)
    })
    .await
    .map_err(|e| AppError::State(e.to_string()))?
}

pub(crate) fn read_context_assets(
    app: Option<&tauri::AppHandle>,
    preview_id: &str,
    archive: usize,
    names: &[String],
) -> Result<Vec<model_preview::PreviewAsset>> {
    let context = CONTEXTS
        .lock()
        .map_err(|e| AppError::State(e.to_string()))?
        .get(preview_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound("preview session; reopen the file".into()))?;
    let selected = context
        .sources
        .get(archive)
        .ok_or_else(|| AppError::InvalidInput("unknown preview archive".into()))?
        .clone();
    let mut sources = context.dependencies;
    sources.extend(context.sources);
    if context.prefer_selected {
        sources.retain(|path| path != &selected);
        sources.push(selected);
    }
    model_preview::read_assets(app, &context.cache, &sources, names, true)
}

/// The archive of an open session a product came from: the one at index
/// `archive` of its sources, which is what the `archive` field of a product
/// names. `get_file_preview_image` and `get_file_preview_text` read one
/// entry out of it.
pub(crate) fn session_archive(preview_id: &str, archive: usize) -> Result<PathBuf> {
    CONTEXTS
        .lock()
        .map_err(|e| AppError::State(e.to_string()))?
        .get(preview_id)
        .ok_or_else(|| AppError::NotFound("preview session; reopen the file".into()))?
        .sources
        .get(archive)
        .cloned()
        .ok_or_else(|| AppError::InvalidInput("unknown preview archive".into()))
}

#[tauri::command]
pub fn release_file_preview(preview_id: String) -> Result<()> {
    CONTEXTS
        .lock()
        .map_err(|e| AppError::State(e.to_string()))?
        .remove(&preview_id);
    crate::file_preview_contents::forget_session(&preview_id);
    Ok(())
}

/// Keep archive extraction in the preview cache, with generated filenames and
/// limits on both declared and actual decoded bytes. No client is modified.
pub(crate) fn unpack(path: &Path, cache: &Path) -> Result<Vec<PathBuf>> {
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if extension == "pk3" {
        return Ok(vec![path.to_path_buf()]);
    }
    let metadata = fs::metadata(path)
        .map_err(|e| AppError::io_path("cannot read preview archive", path, e))?;
    let stamp = format!(
        "{}:{}:{:?}",
        path.display(),
        metadata.len(),
        metadata.modified().ok()
    );
    let key: String = Sha1::digest(stamp.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let directory = cache.join(key);
    fs::create_dir_all(&directory)
        .map_err(|e| AppError::io_path("cannot create preview cache", &directory, e))?;
    let cache = directory.as_path();
    let owned_zip;
    let zip_path = if extension == "7z" {
        owned_zip = cache.join("contents.zip");
        if !owned_zip.exists() {
            let partial = cache.join(format!("{}.part", user_files::id()));
            convert_7z(path, &partial)?;
            fs::rename(&partial, &owned_zip)
                .map_err(|e| AppError::io_path("cannot save preview archive", &owned_zip, e))?;
        }
        &owned_zip
    } else if extension == "zip" {
        path
    } else {
        return Err(AppError::ArchiveUnsupported { format: extension });
    };
    let mut sources = vec![zip_path.to_path_buf()];
    let file = File::open(zip_path)
        .map_err(|e| AppError::io_path("cannot open preview archive", zip_path, e))?;
    let mut archive = ZipArchive::new(file)?;
    if archive.len() > MAX_ENTRIES {
        return Err(AppError::InvalidInput("package has too many files".into()));
    }
    let mut remaining = MAX_PACKAGE_BYTES;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir()
            || !entry.name().to_ascii_lowercase().ends_with(".pk3")
            || logical_name(entry.name()).is_none()
        {
            continue;
        }
        if sources.len() >= 64 || entry.size() > MAX_ARCHIVE_BYTES || entry.size() > remaining {
            return Err(AppError::InvalidInput(
                "package exceeds the preview extraction limit".into(),
            ));
        }
        let original = entry
            .name()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("file.pk3");
        let name = format!("{index}-{}", crate::jkhub::download::sanitize(original));
        let target = cache.join(name);
        if fs::metadata(&target).is_ok_and(|metadata| metadata.len() == entry.size()) {
            remaining -= entry.size();
            sources.push(target);
            continue;
        }
        let partial = cache.join(format!("{}.part", user_files::id()));
        let mut sink = File::create(&partial)
            .map_err(|e| AppError::io_path("cannot create preview archive", &partial, e))?;
        let written = std::io::copy(
            &mut entry.by_ref().take(MAX_ARCHIVE_BYTES.min(remaining) + 1),
            &mut sink,
        )
        .map_err(|e| AppError::io_path("cannot extract preview archive", &target, e))?;
        if written > MAX_ARCHIVE_BYTES || written > remaining {
            return Err(AppError::InvalidInput(
                "preview archive expands beyond its limit".into(),
            ));
        }
        remaining -= written;
        drop(sink);
        fs::rename(&partial, &target)
            .map_err(|e| AppError::io_path("cannot save preview archive", &target, e))?;
        sources.push(target);
    }
    Ok(sources)
}

fn convert_7z(path: &Path, target: &Path) -> Result<()> {
    let mut reader = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
        .map_err(|e| AppError::Archive(e.to_string()))?;
    if reader.archive().files.len() > MAX_ENTRIES {
        return Err(AppError::InvalidInput("package has too many files".into()));
    }
    let file = File::create(target)
        .map_err(|e| AppError::io_path("cannot create preview archive", target, e))?;
    let mut writer = ZipWriter::new(file);
    let mut remaining = MAX_PACKAGE_BYTES;
    let mut failure = None;
    reader
        .for_each_entries(|entry, source| {
            if entry.is_directory || logical_name(&entry.name).is_none() {
                return Ok(true);
            }
            let result = (|| -> Result<()> {
                if entry.size > remaining || entry.size > MAX_ARCHIVE_BYTES {
                    return Err(AppError::InvalidInput(
                        "7z exceeds the preview extraction limit".into(),
                    ));
                }
                writer.start_file(
                    &entry.name,
                    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
                )?;
                let written = std::io::copy(
                    &mut source.take(remaining.min(MAX_ARCHIVE_BYTES) + 1),
                    &mut writer,
                )
                .map_err(|e| AppError::io_path("cannot decode preview archive", path, e))?;
                if written > remaining || written > MAX_ARCHIVE_BYTES {
                    return Err(AppError::InvalidInput(
                        "7z expands beyond its preview limit".into(),
                    ));
                }
                remaining -= written;
                Ok(())
            })();
            if let Err(e) = result {
                failure = Some(e);
                return Ok(false);
            }
            Ok(true)
        })
        .map_err(|e| AppError::Archive(e.to_string()))?;
    if let Some(e) = failure {
        return Err(e);
    }
    writer
        .flush()
        .map_err(|e| AppError::io_path("cannot write preview archive", target, e))?;
    writer.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("jknet-preview-{}", user_files::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    /// The finished objects among the products: what the tests of this
    /// module are about. The files of the archive the taxonomy lists next
    /// to them are checked by `file_preview_contents`.
    fn objects(
        products: &[crate::file_preview_products::PreviewProduct],
    ) -> Vec<crate::file_preview_products::PreviewProduct> {
        products
            .iter()
            .filter(|p| {
                matches!(
                    p.kind.as_str(),
                    "map" | "skin" | "hilt" | "weapon" | "npc" | "vehicle" | "music" | "sound"
                )
            })
            .cloned()
            .collect()
    }

    #[test]
    fn assembled_products_reuse_picker_parts_and_keep_package_icons_separate() {
        let temp = Temp::new();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 4)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let entries: Vec<(&str, &[u8])> = vec![
            ("models/players/custom/model.glm", b"geometry"),
            ("models/players/custom/model_default.skin", b"body,default"),
            ("models/players/custom/playerchoice.txt", b""),
            ("models/players/custom/head_1.skin", b"head,head1"),
            ("models/players/custom/head_2.skin", b"head,head2"),
            ("models/players/custom/torso_1.skin", b"torso,body"),
            ("models/players/custom/lower_1.skin", b"legs,legs"),
            ("models/players/custom/icon_head_1.png", bytes.get_ref()),
            ("models/players/custom/icon_head_2.png", bytes.get_ref()),
            ("models/players/custom/icon_torso_1.png", bytes.get_ref()),
            ("models/players/custom/icon_lower_1.png", bytes.get_ref()),
        ];
        let sources = vec![temp.0.join("a.pk3.disabled"), temp.0.join("b.pk3")];
        for path in &sources {
            archive(path, &entries);
        }
        let raw = inspect(&sources, &[]).unwrap();
        let mut products = crate::file_preview_products::products(&sources, &raw).unwrap();
        enrich_products(&sources, &mut products, &temp.0.join("icons")).unwrap();
        assert_eq!(
            products.iter().filter(|p| p.kind == "icon").count(),
            8,
            "the icons of the parts are listed as pictures, four per package"
        );
        let products = objects(&products);
        assert_eq!(
            products.len(),
            2,
            "one assembled object per package, not one per part"
        );
        let models: Vec<_> = products
            .iter()
            .map(|entry| entry.appearance.as_ref().unwrap())
            .collect();
        for model in &models {
            let parts = model.parts.as_ref().unwrap();
            assert_eq!(parts.heads.len(), 2);
            assert_eq!(parts.torsos.len(), 1);
            assert_eq!(parts.legs.len(), 1);
            assert_eq!(model.value, "custom/head_1|torso_1|lower_1");
            assert!(Path::new(model.icon.as_ref().unwrap()).is_file());
        }
        assert_ne!(
            models[0].icon, models[1].icon,
            "a cached icon from another package cannot replace this one"
        );
    }

    #[test]
    fn contents_cover_models_skins_audio_images_text_and_maps() {
        let temp = Temp::new();
        let path = temp.0.join("mixed.pk3.disabled");
        archive(
            &path,
            &[
                ("models/players/test/model.glm", b"model"),
                (
                    "models/players/test/model_red.skin",
                    b"body,models/players/test/body",
                ),
                ("sound/test.wav", b"audio"),
                ("textures/test.png", b"image"),
                ("readme.txt", b"readme"),
                ("shaders/test.shader", b"material definition"),
                ("maps/test.bsp", b"map"),
                ("vm/jampgame.qvm", b"code"),
                ("../secrets.txt", b"unsafe"),
                ("C:/leak.txt", b"unsafe"),
            ],
        );
        let entries = inspect(&[path], &[]).unwrap();
        for kind in ["model", "audio", "image", "text", "map", "other"] {
            assert!(entries.iter().any(|entry| entry.kind == kind), "{kind}");
        }
        assert!(entries.iter().all(|entry| !entry.name.contains("unsafe")
            && !entry.name.contains("secrets")
            && !entry.name.contains("leak")));
        let skin = entries
            .iter()
            .find(|entry| entry.name.ends_with("model_red.skin"))
            .unwrap();
        assert_eq!(skin.model.as_deref(), Some("models/players/test/model.glm"));
        assert_eq!(skin.skins, vec!["models/players/test/model_red.skin"]);
    }

    #[test]
    fn reskins_and_definition_only_packages_find_stock_geometry() {
        let temp = Temp::new();
        let stock = temp.0.join("stock.pk3");
        let selected = temp.0.join("selected.pk3");
        archive(
            &stock,
            &[
                ("models/players/kyle/model.glm", b"model"),
                (
                    "models/players/kyle/model_default.skin",
                    b"body,models/players/kyle/body",
                ),
            ],
        );
        archive(&selected,&[("models/players/kyle/body.jpg",b"skin"),("ext_data/sabers/example.sab",b"custom { saberModel models/weapons2/saber/saber_w.glm customSkin models/weapons2/saber/custom.skin }")]);
        let entries = inspect(std::slice::from_ref(&selected), &[stock]).unwrap();
        assert!(entries
            .iter()
            .any(|entry| entry.model.as_deref() == Some("models/players/kyle/model.glm")));
        let products = crate::file_preview_products::products(&[selected], &entries).unwrap();
        let hilt = products
            .iter()
            .find(|entry| entry.model.as_deref() == Some("models/weapons2/saber/saber_w.glm"))
            .unwrap();
        assert_eq!(hilt.skins, vec!["models/weapons2/saber/custom.skin"]);
    }

    #[test]
    fn a_replacement_body_section_previews_a_complete_character() {
        let temp = Temp::new();
        let stock = temp.0.join("stock.pk3");
        let selected = temp.0.join("torso.pk3");
        archive(
            &stock,
            &[
                ("models/players/jedi_hm/model.glm", b"model"),
                ("models/players/jedi_hm/head_a1.skin", b"head,head"),
                ("models/players/jedi_hm/torso_a1.skin", b"torso,torso"),
                ("models/players/jedi_hm/lower_a1.skin", b"legs,legs"),
            ],
        );
        archive(
            &selected,
            &[("models/players/jedi_hm/torso_custom.skin", b"torso,custom")],
        );
        let entries = inspect(std::slice::from_ref(&selected), &[stock]).unwrap();
        let products = crate::file_preview_products::products(&[selected], &entries).unwrap();
        assert_eq!(products.len(), 1);
        assert_eq!(
            products[0].skins,
            vec![
                "models/players/jedi_hm/head_a1.skin",
                "models/players/jedi_hm/torso_custom.skin",
                "models/players/jedi_hm/lower_a1.skin"
            ]
        );
        assert_eq!(products[0].kind, "skin");
    }

    #[test]
    fn map_choices_use_arena_titles_and_keep_resources_out_of_the_list() {
        let temp = Temp::new();
        let path = temp.0.join("maps.pk3.disabled");
        archive(&path, &[
            ("scripts/maps.arena", b"{ map mp/first longname \"^3First arena\" } { map second longname \"Second arena\" } { map absent longname \"No BSP\" }"),
            ("maps/mp/first.bsp", b"first"),
            ("maps/second.bsp", b"second"),
            ("levelshots/first.jpg", b"image"),
            ("textures/first.jpg", b"texture"),
        ]);
        let sources = [path];
        let entries = inspect(&sources, &[]).unwrap();
        let all = crate::file_preview_products::products(&sources, &entries).unwrap();
        let products = objects(&all);
        assert_eq!(products.len(), 2);
        assert_eq!(products[0].label, "First arena");
        assert_eq!(products[1].label, "Second arena");
        assert!(products
            .iter()
            .all(|p| p.kind == "map" && p.model.is_none()));
        // The picture and the texture are listed as files, the `.arena` as data.
        let kinds: Vec<_> = all.iter().map(|p| p.kind.as_str()).collect();
        assert!(kinds.contains(&"levelshot") && kinds.contains(&"texture") && kinds.contains(&"data"), "{kinds:?}");
        let assets = model_preview::read_assets(
            None,
            &temp.0.join("cache"),
            &sources,
            &[products[0].name.clone()],
            true,
        )
        .unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(
            fs::read(assets[0].path.as_ref().unwrap()).unwrap(),
            b"first"
        );
    }

    #[test]
    fn preview_choices_are_finished_objects_and_voice_stays_with_its_character() {
        let temp = Temp::new();
        let path = temp.0.join("products.pk3");
        archive(
            &path,
            &[
                ("scripts/duel.arena", b"{ map duel }"),
                ("shaders/body.shader", b"material"),
                ("textures/duel/floor.jpg", b"image"),
                ("maps/duel.bsp", b"map"),
                ("models/map_objects/duel/wall.md3", b"map part"),
                ("models/players/hero/model.glm", b"model"),
                (
                    "models/players/hero/model_default.skin",
                    b"body,models/players/hero/body",
                ),
                ("sound/chars/hero/misc/taunt1.mp3", b"voice"),
                ("sound/chars/hero/misc/taunt2.mp3", b"voice"),
                ("music/Theme.ogg", b"music"),
                ("models/weapons2/blaster/blaster_w.md3", b"world model"),
                ("models/weapons2/blaster/blaster_hand.md3", b"part"),
                ("models/weapons2/blaster/blaster_flash.md3", b"part"),
                (
                    "ext_data/sabers/gold.sab",
                    b"gold { name \"^3Golden Hilt\" saberModel models/weapons2/gold/hilt.glm }",
                ),
                ("models/weapons2/gold/hilt.glm", b"hilt"),
            ],
        );
        let sources = [path];
        let entries = inspect(&sources, &[]).unwrap();
        let products =
            objects(&crate::file_preview_products::products(&sources, &entries).unwrap());
        assert_eq!(products.len(), 5, "{products:?}");
        let map = products.iter().find(|p| p.kind == "map").unwrap();
        assert_eq!(map.name, "maps/duel.bsp");
        assert_eq!(map.label, "Duel");
        let hero = products.iter().find(|p| p.kind == "skin").unwrap();
        assert_eq!(hero.label, "Hero");
        assert_eq!(hero.audio.len(), 2);
        assert_eq!(hero.skins, vec!["models/players/hero/model_default.skin"]);
        let hilt = products.iter().find(|p| p.kind == "hilt").unwrap();
        assert_eq!(hilt.label, "Golden Hilt");
        let weapon = products.iter().find(|p| p.kind == "weapon").unwrap();
        assert_eq!(
            weapon.model.as_deref(),
            Some("models/weapons2/blaster/blaster_w.md3")
        );
        assert!(products
            .iter()
            .all(|p| !p.label.contains('/') && !p.label.contains('.')));
    }

    #[test]
    fn selected_archive_wins_dependencies_even_when_disabled_and_wrapped() {
        let temp = Temp::new();
        let stock = temp.0.join("stock.pk3");
        let selected = temp.0.join("selected.pk3.disabled");
        archive(
            &stock,
            &[
                ("models/players/kyle/model_default.skin", b"stock"),
                ("shaders/stock.shader", b"dependency"),
            ],
        );
        archive(
            &selected,
            &[(
                "wrapper/base/models/players/kyle/model_default.skin",
                b"selected",
            )],
        );
        let result = model_preview::read_assets(
            None,
            &temp.0.join("cache"),
            &[stock, selected.clone()],
            &[
                "models/players/kyle/model_default.skin".into(),
                "@shaders".into(),
            ],
            true,
        )
        .unwrap();
        assert_eq!(
            result
                .iter()
                .find(|entry| entry.name.ends_with(".skin"))
                .unwrap()
                .text
                .as_deref(),
            Some("selected")
        );
        assert_eq!(
            result
                .iter()
                .find(|entry| entry.name.ends_with(".shader"))
                .unwrap()
                .text
                .as_deref(),
            Some("dependency")
        );
        assert!(
            selected.exists(),
            "preview never enables or renames the file"
        );
        assert!(model_preview::read_assets(
            None,
            &temp.0.join("cache"),
            &[],
            &["../settings.json".into()],
            true
        )
        .is_err());
    }

    #[test]
    fn wrappers_with_duplicate_pk3_names_extract_separately_and_reuse_cache() {
        let temp = Temp::new();
        let one = temp.0.join("one.pk3");
        let two = temp.0.join("two.pk3");
        let zip = temp.0.join("package.zip");
        archive(&one, &[("sound/one.wav", b"one")]);
        archive(&two, &[("sound/two.wav", b"two")]);
        archive(
            &zip,
            &[
                ("a/same.pk3", &fs::read(one).unwrap()),
                ("b/same.pk3", &fs::read(two).unwrap()),
                ("../../escape.pk3", b"unsafe"),
                ("readme.txt", b"readme"),
            ],
        );
        let first = unpack(&zip, &temp.0.join("cache")).unwrap();
        let again = unpack(&zip, &temp.0.join("cache")).unwrap();
        assert_eq!(first, again);
        assert_eq!(first.len(), 3);
        let entries = inspect(&first, &[]).unwrap();
        assert!(entries.iter().any(|entry| entry.name == "sound/one.wav"));
        assert!(entries.iter().any(|entry| entry.name == "sound/two.wav"));
        assert!(entries.iter().any(|entry| entry.name == "readme.txt"));
        assert!(!temp.0.join("escape.pk3").exists());
    }

    #[test]
    fn tga_images_are_cached_as_png_and_source_bytes_are_preserved() {
        let temp = Temp::new();
        let path = temp.0.join("picture.pk3");
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            2,
            2,
            image::Rgba([255, 0, 0, 128]),
        ))
        .write_to(&mut bytes, image::ImageFormat::Tga)
        .unwrap();
        archive(&path, &[("textures/preview.tga", bytes.get_ref())]);
        let original = fs::read(&path).unwrap();
        let result = model_preview::read_assets(
            None,
            &temp.0.join("cache"),
            std::slice::from_ref(&path),
            &["textures/preview.tga".into()],
            true,
        )
        .unwrap();
        let png = fs::read(result[0].path.as_ref().unwrap()).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(fs::read(path).unwrap(), original);
    }

    /// `JKNET_PK3_SAMPLE=<path to a pk3> cargo test sample_pk3 -- --ignored --nocapture`
    /// prints what the preview of that archive lists, by kind, and the
    /// badges its card gets.
    #[test]
    #[ignore = "reads the archive JKNET_PK3_SAMPLE names and prints its products"]
    fn sample_pk3_lists_every_kind_of_content() {
        let sample = PathBuf::from(std::env::var("JKNET_PK3_SAMPLE").expect("JKNET_PK3_SAMPLE"));
        let temp = Temp::new();
        let data = DataPaths::new(temp.0.join("data"));
        let started = std::time::Instant::now();
        let preview = prepare(&data, vec![sample.clone()], Vec::new()).unwrap();
        let elapsed = started.elapsed();
        let mut by_kind: BTreeMap<&str, usize> = BTreeMap::new();
        for entry in &preview.entries {
            *by_kind.entry(entry.kind.as_str()).or_default() += 1;
        }
        eprintln!(
            "{}: {} products in {} ms",
            sample.display(),
            preview.entries.len(),
            elapsed.as_millis()
        );
        for (kind, count) in &by_kind {
            eprintln!("  {kind}: {count}");
        }
        let report = library::inspect(&sample).unwrap();
        eprintln!("  category {:?}, features {:?}", report.category, report.features);
        assert!(
            report.features.iter().all(|code| crate::bundles::manifest::is_library_feature(code)),
            "every badge is a code a bundle manifest accepts: {:?}",
            report.features
        );
        for entry in &preview.entries {
            let details = match (&entry.image, &entry.strings, &entry.font, &entry.text) {
                (Some(image), ..) => format!(
                    "{}x{} {}{}",
                    image.width,
                    image.height,
                    image.format,
                    entry
                        .map
                        .as_ref()
                        .map(|map| format!(" map={map}"))
                        .unwrap_or_default()
                ),
                (_, Some(strings), _, text) => format!(
                    "{} keys, {} lines, {}",
                    strings.keys,
                    text.as_ref().map(|t| t.lines).unwrap_or(0),
                    text.as_ref().map(|t| t.encoding.as_str()).unwrap_or("?")
                ),
                (_, _, Some(font), _) => format!(
                    "point size {}, height {}, atlas {:?}",
                    font.point_size, font.height, font.atlas
                ),
                (_, _, _, Some(text)) => format!("{} lines, {}", text.lines, text.encoding),
                _ => String::new(),
            };
            eprintln!(
                "  [{}] {} <- {} ({} bytes) {details}",
                entry.kind,
                entry.label,
                entry.name,
                entry.size.unwrap_or(0)
            );
        }
        let strings = preview.entries.iter().find(|entry| entry.kind == "strings");
        if let Some(strings) = strings {
            let text =
                crate::file_preview_contents::text(&sample, &strings.name).unwrap();
            let sample_lines: Vec<_> = text
                .text
                .lines()
                .filter(|line| line.contains("LANG_") && !line.contains("LANG_ENGLISH"))
                .take(3)
                .collect();
            eprintln!("  {} decoded as {}: {sample_lines:?}", strings.name, text.encoding);
        }
        if let Some(picture) = preview.entries.iter().find(|entry| entry.kind == "levelshot") {
            let thumbnail =
                crate::file_preview_contents::picture(&sample, &picture.name, Some(192)).unwrap();
            eprintln!(
                "  thumbnail of {}: {}x{}, {} bytes of data URL",
                picture.name,
                thumbnail.width,
                thumbnail.height,
                thumbnail.data_url.len()
            );
        }
        release_file_preview(preview.id).unwrap();
        assert!(!by_kind.is_empty());
    }

    #[test]
    #[ignore = "exports locally installed content for hidden UI verification"]
    fn export_local_preview_fixtures() {
        let output = PathBuf::from(
            std::env::var("JKNET_PREVIEW_QA_OUTPUT").expect("explicit QA output folder"),
        );
        let game = Path::new("D:/SteamLibrary/steamapps/common/Jedi Academy/GameData/base");
        let mut deps: Vec<_> = (0..=3)
            .map(|i| game.join(format!("assets{i}.pk3")))
            .collect();
        let home = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap())
            .join("org.jknet.launcher/clients/et/home/base");
        let mut selected: Vec<_> = [
            "zzzZ_DrDisRespect.pk3",
            "Invisible Lightsaber.pk3",
            "szico_vehiclemodels_v1.0.pk3",
            "zzzzzzzzzStarWarsVisionsMusicOpeningCrawlSWV1GalacticDreamer.pk3",
        ]
        .iter()
        .map(|name| home.join(name))
        .filter(|path| path.exists())
        .collect();
        if let Ok(path) = std::env::var("JKNET_PREVIEW_QA_PACKAGE") {
            selected.push(PathBuf::from(path));
        }
        let entries = inspect(&selected, &deps).unwrap();
        let mut products = crate::file_preview_products::products(&selected, &entries).unwrap();
        enrich_products(&selected, &mut products, &output.join("icons")).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(
            output.join("products.json"),
            serde_json::to_vec(&products).unwrap(),
        )
        .unwrap();
        fs::write(
            output.join("entries.json"),
            serde_json::to_vec(&entries).unwrap(),
        )
        .unwrap();
        deps.extend(selected);
        let mut names =
            std::collections::BTreeSet::from(["@shaders".to_string(), "@sabers".to_string()]);
        names.extend(
            products
                .iter()
                .flat_map(|product| product.audio.iter().map(|audio| audio.name.clone())),
        );
        for path in &deps {
            let mut zip = ZipArchive::new(File::open(path).unwrap()).unwrap();
            for i in 0..zip.len() {
                let entry = zip.by_index(i).unwrap();
                let Some(name) = logical_name(entry.name()) else {
                    continue;
                };
                if model_preview::allowed(&name)
                    && (name.starts_with("models/players/jedi_drdisrespect/")
                        || name.starts_with("sound/chars/drdisrespect/")
                        || name.starts_with("models/map_objects/szico_vehicles/")
                        || name.starts_with("models/weapons2/noweap/")
                        || name.starts_with("models/players/kyle/")
                        || name.starts_with("models/players/jedi_")
                            && name
                                .split('/')
                                .nth(2)
                                .is_some_and(|model| model.ends_with("pra"))
                        || name.starts_with("models/players/_humanoid/")
                        || name.starts_with("models/weapons2/blaster_r/")
                        || name.starts_with("models/weapons2/saber/")
                        || name.starts_with("models/weapons2/bowcaster/")
                        || name.starts_with("models/weapons2/stcomprifle/")
                        || name.starts_with("sound/weapons/bowcaster/")
                        || name.ends_with(".wav") && entry.size() < 20_000
                        || name.starts_with("music/") && entry.size() < 2_000_000)
                {
                    names.insert(name);
                }
            }
        }
        let names: Vec<_> = names.into_iter().collect();
        let mut assets = Vec::new();
        for chunk in names.chunks(128) {
            assets.extend(
                model_preview::read_assets(None, &output.join("assets"), &deps, chunk, true)
                    .unwrap(),
            );
        }
        fs::write(
            output.join("assets.json"),
            serde_json::to_vec(&assets).unwrap(),
        )
        .unwrap();
        eprintln!(
            "Exported {} entries and {} assets to {}",
            entries.len(),
            assets.len(),
            output.display()
        );
    }

    #[test]
    #[ignore = "exports local maps and explicitly requested dependencies for hidden UI verification"]
    fn export_map_preview_fixtures() {
        let output =
            PathBuf::from(std::env::var("JKNET_MAP_QA_OUTPUT").expect("explicit QA output folder"));
        let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap());
        for (key, game, extra, maps) in [
            (
                "ja",
                "Jedi Academy",
                None,
                vec!["maps/mp/ffa3.bsp", "maps/mp/duel1.bsp"],
            ),
            ("jo", "Jedi Outcast", None, vec!["maps/duel_bespin.bsp"]),
            (
                "atlantica",
                "Jedi Academy",
                Some(local.join("org.jknet.launcher/clients/et/home/base/Atlantica_v1.02.pk3")),
                vec!["maps/atlantica.bsp", "maps/atlantica_rpg.bsp"],
            ),
        ] {
            let base = PathBuf::from(format!(
                "D:/SteamLibrary/steamapps/common/{game}/GameData/base"
            ));
            let mut sources: Vec<_> = (0..=5)
                .map(|i| base.join(format!("assets{i}.pk3")))
                .filter(|path| path.exists())
                .collect();
            if let Some(extra) = extra {
                sources.push(extra);
            }
            let dir = output.join(key);
            fs::create_dir_all(&dir).unwrap();
            let mut assets = Vec::new();
            for name in maps {
                assets.extend(
                    model_preview::read_assets(
                        None,
                        &dir.join("assets"),
                        &sources,
                        &[name.into()],
                        true,
                    )
                    .unwrap(),
                );
            }
            let mut names = vec!["@shaders".to_string()];
            if let Ok(bytes) = fs::read(dir.join("requested.json")) {
                names.extend(serde_json::from_slice::<Vec<String>>(&bytes).unwrap());
            }
            names.sort();
            names.dedup();
            for names in names.chunks(32) {
                assets.extend(
                    model_preview::read_assets(None, &dir.join("assets"), &sources, names, true)
                        .unwrap(),
                );
            }
            fs::write(
                dir.join("assets.json"),
                serde_json::to_vec(&assets).unwrap(),
            )
            .unwrap();
            if key == "atlantica" {
                let selected = vec![sources.last().unwrap().clone()];
                let entries = inspect(&selected, &sources).unwrap();
                let products = crate::file_preview_products::products(&selected, &entries).unwrap();
                fs::write(
                    dir.join("products.json"),
                    serde_json::to_vec(&products).unwrap(),
                )
                .unwrap();
            }
            eprintln!("Exported {key}: {} assets", assets.len());
        }
    }
}
