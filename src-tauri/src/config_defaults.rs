//! Read-only startup CFG context. Never execute scripts or modify the game's files.
use super::{commands, tokens, ClientConfigFile};
use crate::{
    appearance,
    clients::Client,
    engines,
    error::{AppError, Result},
    game::Game,
    paths::DataPaths,
    settings::Settings,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::Path,
};

const LIMIT: u64 = 1024 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigContext {
    pub sources: Vec<ClientConfigFile>,
    pub unresolved: Vec<String>,
}

pub(super) fn startup_file(client: &Client) -> &'static str {
    match client.engine_id.as_str() {
        "openjk" => "openjk.cfg",
        "eternaljk" => "eternaljk.cfg",
        "taystjk" => "taystjk.cfg",
        "jk2mv" => "jk2mvconfig.cfg",
        _ if client.game == Game::JediOutcast => "jk2mpconfig.cfg",
        _ => "jampconfig.cfg",
    }
}

// These forks keep their user config in their own base-game overlay.
pub(super) fn engine_folder(client: &Client) -> Option<&'static str> {
    match client.engine_id.as_str() {
        "eternaljk" => Some("EternalJK"),
        "taystjk" => Some("taystjk"),
        _ => None,
    }
}

fn insert(
    files: &mut BTreeMap<String, ClientConfigFile>,
    name: String,
    path: String,
    bytes: &[u8],
) {
    files.insert(
        name,
        ClientConfigFile {
            path,
            text: String::from_utf8_lossy(bytes).into_owned(),
        },
    );
}

pub(super) fn context(
    paths: &DataPaths,
    settings: &Settings,
    client: &Client,
) -> Result<ConfigContext> {
    let engine = engines::require(&client.engine_id)?;
    let active = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game)
        .or(engine_folder(client))
        .unwrap_or("base");
    crate::user_files::valid_folder(active)?;
    let mut folders = vec!["base"];
    if let Some(folder) = engine_folder(client) {
        folders.push(folder);
    }
    if !folders.contains(&active) {
        folders.push(active);
    }
    let mut files = BTreeMap::new();
    let mut budget = 16 * LIMIT;
    for folder in folders {
        let mut source_client = client.clone();
        source_client.fs_game = Some(folder.into());
        let archives = appearance::preview_sources(paths, settings, &source_client);
        let mut roots = Vec::new();
        if let Some(game_data) = settings.game_data_path(client.game) {
            roots.push(Path::new(game_data).join(folder));
        }
        roots.push(paths.client_engine_dir(&client.id).join(folder));
        roots.push(paths.client_home_dir(&client.id).join(folder));
        for root in roots {
            // The engine prefers archives to loose files inside the same directory.
            if let Ok(entries) = fs::read_dir(&root) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    if !name.ends_with(".cfg")
                        || name.starts_with("jknet-")
                        || !entry.file_type().is_ok_and(|t| t.is_file())
                    {
                        continue;
                    }
                    let mut bytes = Vec::new();
                    File::open(entry.path())
                        .and_then(|f| f.take(LIMIT + 1).read_to_end(&mut bytes))
                        .map_err(|e| {
                            AppError::io_path("cannot read client config", &entry.path(), e)
                        })?;
                    if bytes.len() as u64 > LIMIT || bytes.len() as u64 > budget {
                        return Err(AppError::InvalidInput(
                            "config context exceeds limits".into(),
                        ));
                    }
                    budget -= bytes.len() as u64;
                    insert(
                        &mut files,
                        name,
                        entry.path().to_string_lossy().into_owned(),
                        &bytes,
                    );
                }
            }
            for path in archives
                .iter()
                .filter(|p| p.parent() == Some(root.as_path()))
            {
                let file = File::open(path)
                    .map_err(|e| AppError::io_path("cannot read config archive", path, e))?;
                let mut archive = zip::ZipArchive::new(file)
                    .map_err(|e| AppError::InvalidInput(e.to_string()))?;
                for i in 0..archive.len() {
                    let mut entry = archive
                        .by_index(i)
                        .map_err(|e| AppError::InvalidInput(e.to_string()))?;
                    let name = entry.name().to_ascii_lowercase();
                    if !name.ends_with(".cfg")
                        || name.contains("..")
                        || name.starts_with('/')
                        || name.contains(['\\', ':'])
                        || name.starts_with("jknet-")
                    {
                        continue;
                    }
                    // User configs and autoexec are deliberately never loaded from a PK3.
                    if name == startup_file(client)
                        || name == "autoexec.cfg"
                        || name == "jk2mvglobal.cfg"
                    {
                        continue;
                    }
                    if entry.size() > LIMIT || entry.size() > budget {
                        return Err(AppError::InvalidInput(
                            "config context exceeds limits".into(),
                        ));
                    }
                    let mut bytes = Vec::new();
                    entry
                        .by_ref()
                        .take(LIMIT + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|e| AppError::io_path("cannot read archived config", path, e))?;
                    if bytes.len() as u64 > LIMIT || bytes.len() as u64 > budget {
                        return Err(AppError::InvalidInput(
                            "config context exceeds limits".into(),
                        ));
                    }
                    budget -= bytes.len() as u64;
                    insert(
                        &mut files,
                        name.clone(),
                        format!(
                            "{} / {name}",
                            path.file_name().unwrap_or_default().to_string_lossy()
                        ),
                        &bytes,
                    );
                }
            }
        }
    }
    let mut result = ConfigContext {
        sources: Vec::new(),
        unresolved: Vec::new(),
    };
    let mut remaining = 4 * LIMIT as usize;
    let mut startup = vec!["mpdefault.cfg", startup_file(client)];
    if client.engine_id == "jk2mv" {
        startup.push("jk2mvglobal.cfg");
    }
    startup.push("autoexec.cfg");
    for name in startup {
        if files.contains_key(name) {
            expand(name, &files, &mut Vec::new(), &mut result, &mut remaining);
        } else if name == "mpdefault.cfg" {
            result.unresolved.push(name.into());
        }
    }
    Ok(result)
}

fn expand(
    name: &str,
    files: &BTreeMap<String, ClientConfigFile>,
    stack: &mut Vec<String>,
    result: &mut ConfigContext,
    remaining: &mut usize,
) {
    if stack.len() >= 16 || stack.iter().any(|s| s == name) || *remaining == 0 {
        result.unresolved.push(name.into());
        return;
    }
    let Some(file) = files.get(name) else {
        result.unresolved.push(name.into());
        return;
    };
    stack.push(name.into());
    let mut text = String::new();
    for command in commands(&file.text) {
        if command.len() + 1 > *remaining {
            result.unresolved.push(name.into());
            *remaining = 0;
            break;
        }
        *remaining -= command.len() + 1;
        let p = tokens(&command);
        if p.first().is_some_and(|op| op.eq_ignore_ascii_case("exec")) && p.len() == 2 {
            if !text.is_empty() {
                result.sources.push(ClientConfigFile {
                    path: file.path.clone(),
                    text: std::mem::take(&mut text),
                });
            }
            let mut target = p[1].to_ascii_lowercase();
            if !target.ends_with(".cfg") {
                target.push_str(".cfg");
            }
            expand(&target, files, stack, result, remaining);
        } else {
            if p.first().is_some_and(|op| op.eq_ignore_ascii_case("vstr")) {
                result.unresolved.push(command.clone());
            }
            text.push_str(&command);
            text.push('\n');
        }
    }
    if !text.is_empty() {
        result.sources.push(ClientConfigFile {
            path: file.path.clone(),
            text,
        });
    }
    stack.pop();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user_files;
    use std::io::Write;
    fn client(engine: &str) -> Client {
        serde_json::from_value(serde_json::json!({"id":"test", "name":"Test", "engineId":engine,"engineVersion":null,"createdAt":"2026-09-13"})).unwrap()
    }
    fn pack(path: &Path, entries: &[(&str, &str)]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, text) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    #[test]
    fn startup_reads_archives_saved_engine_settings_and_nested_exec_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = DataPaths::new(tmp.path().join("data"));
        let mut settings = Settings::default();
        settings.game_data_paths.insert(
            Game::JediAcademy,
            tmp.path().join("game").to_string_lossy().into(),
        );
        pack(
            &tmp.path().join("game/base/assets0.pk3"),
            &[("mpdefault.cfg", "bind w +forward; bind x old")],
        );
        pack(
            &paths.client_home_dir("test").join("base/z_controls.pk3"),
            &[
                ("mpdefault.cfg", "bind w +forward; exec keys; bind x after"),
                ("keys.cfg", "bind x inside; bind SPACE +moveup"),
                ("eternaljk.cfg", "unbindall"),
            ],
        );
        user_files::write_bytes(
            &paths
                .client_home_dir("test")
                .join("EternalJK/eternaljk.cfg"),
            b"bind x saved; bind MOUSE1 +attack",
        )
        .unwrap();
        user_files::write_bytes(
            &paths.client_home_dir("test").join("EternalJK/autoexec.cfg"),
            b"bind x auto; exec cycle",
        )
        .unwrap();
        user_files::write_bytes(
            &paths.client_home_dir("test").join("EternalJK/cycle.cfg"),
            b"exec cycle; bind y +use",
        )
        .unwrap();
        let result = context(&paths, &settings, &client("eternaljk")).unwrap();
        let text = result
            .sources
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.find("bind x inside").unwrap() < text.find("bind x after").unwrap());
        assert!(text.find("bind x saved").unwrap() < text.find("bind x auto").unwrap());
        assert!(text.contains("bind w +forward"));
        assert!(!text.contains("unbindall"));
        assert!(result.sources.iter().any(|s| s.path.contains("EternalJK")));
        assert_eq!(result.unresolved, ["cycle.cfg"]);
        // A different client cannot inherit the first client's saved keys.
        let mut other = client("openjk");
        other.id = "other".into();
        let text = context(&paths, &settings, &other)
            .unwrap()
            .sources
            .into_iter()
            .map(|s| s.text)
            .collect::<String>();
        assert!(!text.contains("saved"));
    }
    #[test]
    fn missing_factory_config_and_expansion_limits_are_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let result = context(
            &DataPaths::new(tmp.path().into()),
            &Settings::default(),
            &client("openjk"),
        )
        .unwrap();
        assert_eq!(result.unresolved, ["mpdefault.cfg"]);
        let files = BTreeMap::from([(
            "a.cfg".into(),
            ClientConfigFile {
                path: "a.cfg".into(),
                text: "bind w +forward".into(),
            },
        )]);
        let mut result = ConfigContext {
            sources: vec![],
            unresolved: vec![],
        };
        expand("a.cfg", &files, &mut vec![], &mut result, &mut 2);
        assert!(result.sources.is_empty());
        assert_eq!(result.unresolved, ["a.cfg"]);
    }
    #[test]
    #[ignore = "reads installed game and client configs, set JKNET_CONFIG_CONTEXT_ROOT"]
    fn installed_client_context() {
        let root = std::env::var("JKNET_CONFIG_CONTEXT_ROOT").unwrap();
        let state = crate::state::AppState::bootstrap(root.into());
        let paths = state.paths().unwrap();
        let settings = state.settings().unwrap();
        for id in ["demos", "et", "everyday"] {
            let client = crate::clients::read_record(&paths, id).unwrap();
            let result = context(&paths, &settings, &client).unwrap();
            assert!(
                result.unresolved.is_empty(),
                "{id}: {:?}",
                result.unresolved
            );
            assert!(result
                .sources
                .iter()
                .any(|s| s.text.to_ascii_lowercase().contains("bind ")));
            println!("{id}: {} startup config segments", result.sources.len());
            if id == "et" {
                assert!(result
                    .sources
                    .iter()
                    .any(|s| s.path.ends_with("eternaljk.cfg")));
            }
        }
    }
}
