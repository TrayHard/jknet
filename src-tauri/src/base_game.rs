//! A merged, read-only catalogue of the game's official asset archives.
use crate::{
    appearance,
    error::{AppError, Result},
    file_preview::{self, FilePreview},
    file_preview_products::{self, PreviewProduct},
    game::Game,
    paths::DataPaths,
    settings::Settings,
    state::AppState,
};
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{LazyLock, Mutex},
};
use zip::ZipArchive;

type IndexCache = BTreeMap<String, (String, Vec<PreviewProduct>)>;
static INDEX: LazyLock<Mutex<IndexCache>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn sources(settings: &Settings, game: Game) -> Vec<PathBuf> {
    let Some(directory) = settings.game_data_path(game) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = fs::read_dir(PathBuf::from(directory).join("base"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.file_name().is_some_and(|name| {
                    game.spec()
                        .assets
                        .iter()
                        .any(|asset| name.eq_ignore_ascii_case(asset.name))
                })
        })
        .collect();
    paths.sort_by_key(|path| {
        crate::library::pak_order(&path.file_name().unwrap_or_default().to_string_lossy())
    });
    paths
}

fn signature(data: &DataPaths, sources: &[PathBuf]) -> Result<String> {
    let mut hash = Sha1::new();
    hash.update(data.cache.to_string_lossy().as_bytes());
    for path in sources {
        let meta = fs::metadata(path).map_err(|e| AppError::io_path("cannot inspect", path, e))?;
        hash.update(
            format!(
                "{}:{}:{:?}\n",
                path.display(),
                meta.len(),
                meta.modified().ok()
            )
            .as_bytes(),
        );
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn build_index(
    data: &DataPaths,
    sources: &[PathBuf],
    signature: &str,
) -> Result<Vec<PreviewProduct>> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    // Resources are split between assets files. Treat them as one virtual package
    // while identifying products, then keep the physical origin only for display.
    let raw = file_preview::inspect_packages(sources, &[], true)?;
    let mut entries = file_preview_products::combined_products(sources, &raw)?;
    let models = appearance::preview_models_from_sources(
        sources,
        &data
            .cache
            .join("file-previews/base-game-icons")
            .join(signature),
    )?;
    let hilts = appearance::preview_hilts(sources)?;
    let mut origins = BTreeMap::new();
    for (archive_id, path) in sources.iter().enumerate() {
        let file = fs::File::open(path)
            .map_err(|e| AppError::io_path("cannot open preview archive", path, e))?;
        let mut archive = ZipArchive::new(file)?;
        for index in 0..archive.len() {
            let file = archive.by_index(index)?;
            if let Some(name) = file_preview::logical_name(file.name()) {
                origins.insert(name, archive_id);
            }
        }
    }
    for entry in &mut entries {
        file_preview::attach_appearance(entry, &models);
        if let Some(hilt) = entry
            .hilt_id
            .as_ref()
            .and_then(|id| hilts.iter().find(|hilt| hilt.id.eq_ignore_ascii_case(id)))
        {
            entry.label = hilt.name.clone();
        }
        entry.archive = *origins.get(&entry.name).unwrap_or(&0);
    }
    Ok(entries)
}

fn prepare(data: &DataPaths, settings: &Settings, game: Game) -> Result<FilePreview> {
    let sources = sources(settings, game);
    let signature = signature(data, &sources)?;
    let key = game.spec().id.to_string();
    let cached = INDEX
        .lock()
        .map_err(|e| AppError::State(e.to_string()))?
        .get(&key)
        .filter(|(old, _)| old == &signature)
        .map(|(_, entries)| entries.clone());
    let entries = if let Some(entries) = cached {
        entries
    } else {
        let entries = build_index(data, &sources, &signature)?;
        INDEX
            .lock()
            .map_err(|e| AppError::State(e.to_string()))?
            .insert(key, (signature, entries.clone()));
        entries
    };
    // Official patches always win; selecting an object does not move its archive
    // to the end, and client/engine/mod archives never enter this session.
    file_preview::register_context(data, sources, Vec::new(), entries, false)
}

#[tauri::command]
pub async fn preview_base_game(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    game: Game,
) -> Result<FilePreview> {
    let data = state.paths()?;
    let settings = state.settings()?;
    let preview = tauri::async_runtime::spawn_blocking(move || prepare(&data, &settings, game))
        .await
        .map_err(|e| AppError::State(e.to_string()))??;
    file_preview::allow_icons(&app, &preview);
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn archive(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn stock_catalogue_merges_resources_and_ignores_non_retail_packages() {
        let temp = tempfile::tempdir().unwrap();
        let game_dir = temp.path().join("game");
        let base = game_dir.join("base");
        archive(
            &base.join("assets0.pk3"),
            &[
                ("maps/mp/duel.bsp", b"original map"),
                ("models/players/hero/model.glm", b"model"),
                ("models/players/hero/model_default.skin", b"body,stock"),
                ("sound/chars/hero/misc/taunt.mp3", b"original voice"),
                ("models/players/droids/probe_head.md3", b"part"),
                ("models/weapons2/noweap/noweap.md3", b"invisible"),
                ("models/players/speeder/model.glm", b"vehicle"),
                ("models/players/speeder/model_default.skin", b"body,default"),
                ("models/players/speeder/model_blue.skin", b"body,blue"),
            ],
        );
        archive(
            &base.join("assets1.pk3"),
            &[
                (
                    "scripts/maps.arena",
                    b"{ map mp/duel longname \"Stock arena\" }",
                ),
                ("models/players/hero/model_red.skin", b"body,red"),
                ("sound/chars/hero/misc/taunt.mp3", b"patched voice"),
                ("ext_data/hero.npc", b"hero_npc { playerModel hero }"),
                (
                    "ext_data/vehicles/speeder.veh",
                    b"speeder { model speeder modelSkin blue|default }",
                ),
            ],
        );
        archive(&base.join("zzz_mod.pk3"), &[("maps/mod.bsp", b"mod")]);
        archive(
            &base.join("assets_custom.pk3"),
            &[("maps/custom.bsp", b"custom")],
        );
        let mut settings = Settings::default();
        settings
            .game_data_paths
            .insert(Game::JediAcademy, game_dir.to_string_lossy().into_owned());
        let data = DataPaths::new(temp.path().join("launcher"));
        let preview = prepare(&data, &settings, Game::JediAcademy).unwrap();
        assert_eq!(preview.archives, ["assets0.pk3", "assets1.pk3"]);
        assert!(!preview
            .entries
            .iter()
            .any(|p| p.name.contains("mod.bsp") || p.name.contains("custom.bsp")));
        let map = preview.entries.iter().find(|p| p.kind == "map").unwrap();
        assert_eq!(map.label, "Stock arena");
        assert_eq!(map.archive, 0);
        let speeder = preview
            .entries
            .iter()
            .find(|p| p.label == "Speeder" && p.kind == "vehicle")
            .unwrap();
        assert_eq!(speeder.skins, ["models/players/speeder/model_default.skin"]);
        assert!(preview
            .entries
            .iter()
            .filter(|p| p.model.as_deref() == Some("models/players/speeder/model.glm"))
            .all(|p| p.kind == "vehicle"));
        let hero = preview
            .entries
            .iter()
            .find(|p| p.kind == "skin" && p.skins[0].ends_with("model_default.skin"))
            .unwrap();
        assert_eq!(hero.audio.len(), 1, "patched voices are not duplicated");
        assert!(!preview.entries.iter().any(|p| p
            .model
            .as_ref()
            .is_some_and(|model| model.contains("probe_head") || model.contains("noweap"))));
        let assets = file_preview::read_context_assets(
            None,
            &preview.id,
            hero.archive,
            &[hero.audio[0].name.clone()],
        )
        .unwrap();
        assert_eq!(
            fs::read(assets[0].path.as_ref().unwrap()).unwrap(),
            b"patched voice",
            "the original archive cannot override an official patch"
        );
        assert!(file_preview::read_context_assets(None, &preview.id, 5, &[]).is_err());
        assert!(preview
            .entries
            .iter()
            .any(|p| p.kind == "skin" && p.skins[0].ends_with("model_red.skin")));
        let cached = prepare(&data, &settings, Game::JediAcademy).unwrap();
        assert_ne!(
            preview.id, cached.id,
            "a cached index still opens a fresh session"
        );
        assert_eq!(preview.entries.len(), cached.entries.len());
        archive(
            &base.join("assets1.pk3"),
            &[("maps/extra.bsp", b"added by an official update")],
        );
        let refreshed = prepare(&data, &settings, Game::JediAcademy).unwrap();
        assert!(
            refreshed.entries.iter().any(|p| p.name == "maps/extra.bsp"),
            "archive changes invalidate the index"
        );
        let empty = prepare(&data, &settings, Game::JediOutcast).unwrap();
        assert!(empty.archives.is_empty() && empty.entries.is_empty());
        for id in [preview.id, cached.id, refreshed.id, empty.id] {
            file_preview::release_file_preview(id).unwrap();
        }
    }

    #[test]
    fn official_patch_set_depends_on_the_game() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "assets0.pk3",
            "assets1.pk3",
            "assets2.pk3",
            "assets3.pk3",
            "assets5.pk3",
            "assetsmv.pk3",
        ] {
            archive(&temp.path().join("base").join(name), &[]);
        }
        let mut settings = Settings::default();
        for game in [Game::JediAcademy, Game::JediOutcast] {
            settings
                .game_data_paths
                .insert(game, temp.path().to_string_lossy().into_owned());
        }
        let names = |game| {
            sources(&settings, game)
                .iter()
                .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(Game::JediAcademy),
            ["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3"]
        );
        assert_eq!(
            names(Game::JediOutcast),
            ["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets5.pk3"]
        );
    }

    #[test]
    #[ignore = "reads installed retail assets and exports catalogue data for hidden UI checks"]
    fn export_retail_catalogues() {
        let output =
            PathBuf::from(std::env::var("JKNET_BASE_QA_OUTPUT").expect("JKNET_BASE_QA_OUTPUT"));
        let data = DataPaths::new(output.clone());
        let mut settings = Settings::default();
        for (game, name) in [
            (Game::JediAcademy, "Jedi Academy"),
            (Game::JediOutcast, "Jedi Outcast"),
        ] {
            settings.game_data_paths.insert(
                game,
                format!("D:/SteamLibrary/steamapps/common/{name}/GameData"),
            );
            let started = std::time::Instant::now();
            let preview = prepare(&data, &settings, game).unwrap();
            let mut counts = BTreeMap::new();
            for product in &preview.entries {
                *counts.entry(product.kind.clone()).or_insert(0) += 1;
            }
            assert!(preview.entries.iter().any(|p| p.kind == "map"));
            assert!(preview.entries.iter().any(|p| p.kind == "skin"));
            assert!(preview.entries.iter().any(|p| p.kind == "weapon"));
            fs::create_dir_all(&output).unwrap();
            fs::write(
                output.join(format!("{}.json", game.spec().id)),
                serde_json::to_vec(&preview).unwrap(),
            )
            .unwrap();
            if let Ok(bytes) = fs::read(output.join(format!("{}-requested.json", game.spec().id))) {
                let mut names: Vec<String> = serde_json::from_slice(&bytes).unwrap();
                let prefixes: Vec<_> = names
                    .iter()
                    .filter(|name| name.starts_with("models/"))
                    .map(|name| name.split('/').take(3).collect::<Vec<_>>().join("/") + "/")
                    .collect();
                for source in sources(&settings, game) {
                    let archive = ZipArchive::new(fs::File::open(source).unwrap()).unwrap();
                    names.extend(
                        archive
                            .file_names()
                            .filter_map(file_preview::logical_name)
                            .filter(|name| prefixes.iter().any(|prefix| name.starts_with(prefix)))
                            .filter(|name| {
                                [
                                    ".glm", ".gla", ".md3", ".skin", ".cfg", ".jpg", ".png", ".tga",
                                ]
                                .iter()
                                .any(|extension| name.ends_with(extension))
                            }),
                    );
                }
                names.sort();
                names.dedup();
                let mut assets = Vec::new();
                for batch in names.chunks(32) {
                    assets.extend(
                        file_preview::read_context_assets(None, &preview.id, 0, batch).unwrap(),
                    );
                }
                fs::write(
                    output.join(format!("{}-assets.json", game.spec().id)),
                    serde_json::to_vec(&assets).unwrap(),
                )
                .unwrap();
            }
            eprintln!(
                "{}: {:?}, {} entries in {:?}",
                game.spec().id,
                counts,
                preview.entries.len(),
                started.elapsed()
            );
            file_preview::release_file_preview(preview.id).unwrap();
        }
    }
}
