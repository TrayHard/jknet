//! Shared Quake configuration documents and deterministic client layers.
#[path = "config_defaults.rs"]
mod defaults;
use crate::{
    clients, engines,
    error::{AppError, Result},
    game::Game,
    profiles,
    state::AppState,
    user_files,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub id: String,
    pub name: String,
    pub game: Game,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub source_client: Option<String>,
    #[serde(default)]
    pub source_file: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigLayer {
    pub config_id: String,
    pub priority: i32,
    pub enabled: bool,
}
#[derive(Default, Serialize, Deserialize)]
pub struct ConfigBook {
    pub documents: Vec<ConfigDocument>,
    pub clients: BTreeMap<String, Vec<ConfigLayer>>,
    #[serde(default)]
    pub defaults: BTreeMap<String, String>,
}
#[derive(Clone, Serialize)]
pub struct ConfigValue {
    pub key: String,
    pub value: String,
    pub command: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigConflict {
    pub key: String,
    pub values: Vec<ConflictValue>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictValue {
    pub config_id: String,
    pub config_name: String,
    pub value: String,
}

fn root(state: &AppState) -> Result<PathBuf> {
    Ok(state.paths()?.root.join("configs"))
}
fn book(state: &AppState) -> Result<ConfigBook> {
    let root = root(state)?;
    let mut book: ConfigBook = user_files::read(&root.join("index.json"))?;
    for doc in &mut book.documents {
        user_files::valid_id(&doc.id)?;
        let path = root.join(format!("{}.cfg", doc.id));
        doc.text = fs::read_to_string(&path)
            .map_err(|e| AppError::io_path("cannot read config", &path, e))?;
    }
    Ok(book)
}
fn save_book(state: &AppState, book: &ConfigBook) -> Result<()> {
    user_files::write(&root(state)?.join("index.json"), book)
}

/// Split only outside quoted strings; a semicolon or // in a bind is data.
pub fn commands(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            quoted = !quoted;
            current.push(c);
        } else if !quoted && c == '/' && chars.peek() == Some(&'/') {
            for next in chars.by_ref() {
                if next == '\n' {
                    break;
                }
            }
            if !current.trim().is_empty() {
                result.push(current.trim().into());
            }
            current.clear();
        } else if !quoted && (c == ';' || c == '\n' || c == '\r') {
            if !current.trim().is_empty() {
                result.push(current.trim().into());
            }
            current.clear();
        } else {
            current.push(c);
        }
    }
    if !current.trim().is_empty() {
        result.push(current.trim().into());
    }
    result
}
fn tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut value = String::new();
    let mut quoted = false;
    let mut started = false;
    for c in line.chars() {
        if c == '"' {
            quoted = !quoted;
            started = true;
        } else if c.is_whitespace() && !quoted {
            if started {
                out.push(std::mem::take(&mut value));
                started = false;
            }
        } else {
            value.push(c);
            started = true;
        }
    }
    if started {
        out.push(value);
    }
    out
}
pub fn values(text: &str) -> Vec<ConfigValue> {
    commands(text)
        .into_iter()
        .filter_map(|command| {
            let p = tokens(&command);
            let op = p.first()?.to_ascii_lowercase();
            let (key, value) = match op.as_str() {
                "set" | "seta" | "setu" | "sets" if p.len() >= 3 => (
                    format!("cvar:{}", p[1].to_ascii_lowercase()),
                    p[2..].join(" "),
                ),
                "bind" if p.len() >= 3 => (
                    format!("bind:{}", p[1].to_ascii_lowercase()),
                    p[2..].join(" "),
                ),
                "unbind" if p.len() == 2 => {
                    (format!("bind:{}", p[1].to_ascii_lowercase()), String::new())
                }
                "exec" | "vstr" | "echo" | "wait" | "unbindall" | "bindlist" | "writeconfig" => {
                    return None
                }
                _ if p.len() == 2 => (format!("cvar:{op}"), p[1].clone()),
                _ => return None,
            };
            Some(ConfigValue {
                key,
                value,
                command,
            })
        })
        .collect()
}
fn checked_text(text: &str) -> Result<()> {
    if text.len() > 1024 * 1024 || text.contains('\0') {
        return Err(AppError::InvalidInput("config exceeds limits".into()));
    }
    Ok(())
}

fn bind_keys(docs: &[&ConfigDocument]) -> BTreeSet<String> {
    docs.iter()
        .flat_map(|d| values(&d.text))
        .filter(|v| v.key.starts_with("bind:"))
        .map(|v| v.key)
        .collect()
}
fn effective_values(text: &str, keys: &BTreeSet<String>) -> BTreeMap<String, ConfigValue> {
    let mut result = BTreeMap::new();
    for command in commands(text) {
        if command.eq_ignore_ascii_case("unbindall") {
            for key in keys {
                result.insert(
                    key.clone(),
                    ConfigValue {
                        key: key.clone(),
                        value: String::new(),
                        command: format!("unbind {}", &key[5..]),
                    },
                );
            }
        } else {
            for value in values(&command) {
                result.insert(value.key.clone(), value);
            }
        }
    }
    result
}

#[tauri::command]
pub fn list_configs(state: tauri::State<'_, AppState>) -> Result<ConfigBook> {
    let _guard = state.client_records().enter();
    book(&state)
}
#[tauri::command]
pub fn save_config(
    state: tauri::State<'_, AppState>,
    mut document: ConfigDocument,
) -> Result<ConfigDocument> {
    let _guard = state.client_records().enter();
    document.name = user_files::label(&document.name)?;
    checked_text(&document.text)?;
    let mut book = book(&state)?;
    if document.id.is_empty() {
        document.id = user_files::id();
    } else {
        user_files::valid_id(&document.id)?;
        if !book.documents.iter().any(|d| d.id == document.id) {
            return Err(AppError::NotFound("config".into()));
        }
    }
    user_files::write_bytes(
        &root(&state)?.join(format!("{}.cfg", document.id)),
        document.text.as_bytes(),
    )?;
    book.documents.retain(|d| d.id != document.id);
    book.documents.push(document.clone());
    save_book(&state, &book)?;
    Ok(document)
}
#[tauri::command]
pub fn delete_config(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    let _guard = state.client_records().enter();
    user_files::valid_id(&id)?;
    let mut book = book(&state)?;
    book.documents.retain(|d| d.id != id);
    for layers in book.clients.values_mut() {
        layers.retain(|l| l.config_id != id);
    }
    book.defaults
        .retain(|_, source| source != &format!("document:{id}"));
    // Keep the authored file on disk as recovery material; remove its index entry.
    save_book(&state, &book)
}
#[tauri::command]
pub fn set_default_config(
    state: tauri::State<'_, AppState>,
    client_id: String,
    source: Option<String>,
) -> Result<()> {
    let _guard = state.client_records().enter();
    let client = clients::read_record(&state.paths()?, &client_id)?;
    let mut book = book(&state)?;
    if let Some(source) = source {
        default_text(&state, &book, &client, &source)?;
        book.defaults.insert(client_id, source);
    } else {
        book.defaults.remove(&client_id);
    }
    save_book(&state, &book)
}
#[tauri::command]
pub async fn client_config_context(
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<defaults::ConfigContext> {
    let paths = state.paths()?;
    let settings = state.settings()?;
    let client = clients::read_record(&paths, &client_id)?;
    tauri::async_runtime::spawn_blocking(move || defaults::context(&paths, &settings, &client))
        .await
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
}

fn default_text(
    state: &AppState,
    book: &ConfigBook,
    client: &clients::Client,
    source: &str,
) -> Result<String> {
    if let Some(id) = source.strip_prefix("document:") {
        return book
            .documents
            .iter()
            .find(|doc| doc.id == id && doc.game == client.game)
            .map(|doc| doc.text.clone())
            .ok_or_else(|| AppError::NotFound("default config".into()));
    }
    if let Some(path) = source.strip_prefix("file:") {
        return config_files(state, &client.id)?
            .into_iter()
            .find(|file| file.path == path)
            .map(|file| file.text)
            .ok_or_else(|| AppError::NotFound("default config file".into()));
    }
    Err(AppError::InvalidInput("invalid default config".into()))
}
#[tauri::command]
pub fn set_config_layers(
    state: tauri::State<'_, AppState>,
    client_id: String,
    layers: Vec<ConfigLayer>,
) -> Result<()> {
    let _guard = state.client_records().enter();
    let client = clients::read_record(&state.paths()?, &client_id)?;
    let mut book = book(&state)?;
    let mut ids = BTreeSet::new();
    for layer in &layers {
        if !ids.insert(&layer.config_id)
            || !book
                .documents
                .iter()
                .any(|d| d.id == layer.config_id && d.game == client.game)
        {
            return Err(AppError::InvalidInput("invalid config layer".into()));
        }
    }
    book.clients.insert(client_id, layers);
    save_book(&state, &book)
}
#[tauri::command]
pub fn config_conflicts(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Vec<ConfigConflict>> {
    let _guard = state.client_records().enter();
    let book = book(&state)?;
    let mut by_key: BTreeMap<String, Vec<ConflictValue>> = BTreeMap::new();
    let keys = bind_keys(
        &book
            .documents
            .iter()
            .filter(|d| ids.contains(&d.id))
            .collect::<Vec<_>>(),
    );
    for id in ids {
        let doc = book
            .documents
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| AppError::NotFound("config".into()))?;
        for (key, value) in effective_values(&doc.text, &keys) {
            by_key.entry(key).or_default().push(ConflictValue {
                config_id: id.clone(),
                config_name: doc.name.clone(),
                value: value.value,
            });
        }
    }
    Ok(by_key
        .into_iter()
        .filter(|(_, v)| v.iter().map(|v| &v.value).collect::<BTreeSet<_>>().len() > 1)
        .map(|(key, values)| ConfigConflict { key, values })
        .collect())
}
#[tauri::command]
pub fn merge_configs(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    choices: BTreeMap<String, String>,
    name: String,
) -> Result<ConfigDocument> {
    let _guard = state.client_records().enter();
    let mut book = book(&state)?;
    let docs: Vec<_> = ids
        .iter()
        .map(|id| {
            book.documents
                .iter()
                .find(|d| &d.id == id)
                .ok_or_else(|| AppError::NotFound("config".into()))
        })
        .collect::<Result<_>>()?;
    let game = docs
        .first()
        .ok_or_else(|| AppError::InvalidInput("select configs to merge".into()))?
        .game;
    if docs.iter().any(|d| d.game != game) {
        return Err(AppError::InvalidInput(
            "configs belong to different games".into(),
        ));
    }
    // Retain every original command (including exec and vstr). Explicit conflict
    // resolutions run last instead of deleting commands whose effects are unknown.
    let mut text = docs
        .iter()
        .map(|d| d.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let keys = bind_keys(&docs);
    let effective: Vec<_> = docs
        .iter()
        .map(|d| effective_values(&d.text, &keys))
        .collect();
    let all_keys: BTreeSet<_> = effective.iter().flat_map(|v| v.keys()).collect();
    for key in all_keys {
        let variants: BTreeSet<_> = effective
            .iter()
            .filter_map(|v| v.get(key).map(|v| &v.value))
            .collect();
        if variants.len() > 1 && !choices.contains_key(key) {
            return Err(AppError::InvalidInput(
                "choose a value for every config conflict".into(),
            ));
        }
    }
    for (key, chosen) in choices {
        let doc = docs
            .iter()
            .find(|d| d.id == chosen)
            .ok_or_else(|| AppError::InvalidInput("invalid conflict choice".into()))?;
        let value = effective_values(&doc.text, &keys)
            .remove(&key)
            .ok_or_else(|| AppError::InvalidInput("unknown config conflict".into()))?;
        text.push('\n');
        text.push_str(&value.command);
    }
    let doc = ConfigDocument {
        id: user_files::id(),
        name: user_files::label(&name)?,
        game,
        text,
        source_client: None,
        source_file: None,
    };
    checked_text(&doc.text)?;
    user_files::write_bytes(
        &root(&state)?.join(format!("{}.cfg", doc.id)),
        doc.text.as_bytes(),
    )?;
    book.documents.push(doc.clone());
    save_book(&state, &book)?;
    Ok(doc)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfigFile {
    pub path: String,
    pub text: String,
}
#[tauri::command]
pub fn client_config_files(
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<Vec<ClientConfigFile>> {
    config_files(&state, &client_id)
}
fn config_files(state: &AppState, client_id: &str) -> Result<Vec<ClientConfigFile>> {
    let paths = state.paths()?;
    clients::read_record(&paths, client_id)?;
    let home = paths.client_home_dir(client_id);
    let mut out = Vec::new();
    if let Ok(folders) = fs::read_dir(&home) {
        for folder in folders.flatten() {
            if !folder
                .file_type()
                .is_ok_and(|k| k.is_dir() && !k.is_symlink())
            {
                continue;
            }
            if let Ok(files) = fs::read_dir(folder.path()) {
                for file in files.flatten() {
                    if !file.file_type().is_ok_and(|k| k.is_file())
                        || file
                            .file_name()
                            .to_string_lossy()
                            .to_ascii_lowercase()
                            .starts_with("jknet-")
                        || file
                            .path()
                            .extension()
                            .is_none_or(|s| !s.eq_ignore_ascii_case("cfg"))
                        || file.metadata().is_ok_and(|m| m.len() > 1024 * 1024)
                    {
                        continue;
                    }
                    let path = file.path();
                    if let Ok(text) = fs::read_to_string(&path) {
                        out.push(ClientConfigFile {
                            path: path
                                .strip_prefix(&home)
                                .unwrap()
                                .to_string_lossy()
                                .replace('\\', "/"),
                            text,
                        });
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub(crate) fn launch_layers(state: &AppState, client: &clients::Client) -> Result<Vec<String>> {
    let _guard = state.client_records().enter();
    let book = book(state)?;
    let mut layers = book.clients.get(&client.id).cloned().unwrap_or_default();
    layers.sort_by_key(|l| l.priority);
    let engine = engines::require(&client.engine_id)?;
    let folder = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game)
        .or(defaults::engine_folder(client))
        .unwrap_or("base");
    user_files::valid_folder(folder)?;
    let snapshots = root(state)?.join("binds").join(client.game.id());
    if let Ok(entries) = fs::read_dir(snapshots) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_file())
                && entry.path().extension().is_some_and(|s| s == "cfg")
            {
                let bytes = fs::read(entry.path())
                    .map_err(|e| AppError::io_path("cannot read profile bind", &entry.path(), e))?;
                user_files::write_bytes(
                    &state
                        .paths()?
                        .client_home_dir(&client.id)
                        .join(folder)
                        .join(entry.file_name()),
                    &bytes,
                )?;
            }
        }
    }
    let mut text = match book.defaults.get(&client.id) {
        Some(source) => format!("{}\n", default_text(state, &book, client, source)?),
        None => String::new(),
    };
    for layer in layers.iter().filter(|l| l.enabled) {
        if book.defaults.get(&client.id) == Some(&format!("document:{}", layer.config_id)) {
            continue;
        }
        let doc = book
            .documents
            .iter()
            .find(|d| d.id == layer.config_id && d.game == client.game)
            .ok_or_else(|| AppError::NotFound("assigned config".into()))?;
        text.push_str(&doc.text);
        text.push('\n');
    }
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let file = state
        .paths()?
        .client_home_dir(&client.id)
        .join(folder)
        .join("jknet-active.cfg");
    user_files::write_bytes(&file, text.as_bytes())?;
    Ok(vec!["+exec".into(), "jknet-active.cfg".into()])
}

pub(crate) fn preview_layers(state: &AppState, client_id: &str) -> Result<Vec<String>> {
    let book = book(state)?;
    Ok(
        if book
            .clients
            .get(client_id)
            .is_some_and(|layers| layers.iter().any(|l| l.enabled))
            || book.defaults.contains_key(client_id)
        {
            vec!["+exec".into(), "jknet-active.cfg".into()]
        } else {
            Vec::new()
        },
    )
}

#[tauri::command]
pub fn profile_bind_command(
    state: tauri::State<'_, AppState>,
    client_id: String,
    profile_id: String,
    config_id: Option<String>,
) -> Result<String> {
    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    let profiles = profiles::read_book(&paths, &client_id);
    let profile = profiles
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| AppError::NotFound("player profile".into()))?;
    let tokens = profiles::launch_tokens(profile, client.game);
    let mut commands = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i] != "+set" || i + 2 >= tokens.len() {
            return Err(AppError::InvalidInput(
                "profile has custom commands; use the raw bind editor".into(),
            ));
        }
        if tokens[i + 2].contains(['"', '\n', '\r', ';']) {
            return Err(AppError::InvalidInput(
                "profile cannot be represented as a quoted bind".into(),
            ));
        }
        // A generated cfg avoids nesting quotes inside a bind string.
        commands.push(format!("set {} \"{}\"", tokens[i + 1], tokens[i + 2]));
        i += 3;
    }
    if let Some(id) = config_id {
        let book = book(&state)?;
        let config = book
            .documents
            .iter()
            .find(|d| d.id == id && d.game == client.game)
            .ok_or_else(|| AppError::NotFound("bind config".into()))?;
        commands.push(config.text.clone());
    }
    let body = commands.join("\n");
    let engine = engines::require(&client.engine_id)?;
    let folder = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game)
        .unwrap_or("base");
    user_files::valid_folder(folder)?;
    let file_name = format!("jknet-player-{}.cfg", user_files::id());
    user_files::write_bytes(
        &root(&state)?
            .join("binds")
            .join(client.game.id())
            .join(&file_name),
        body.as_bytes(),
    )?;
    // Stage in every same-game client so the shared config's bind is portable.
    for target in clients::read_all(&paths)?
        .into_iter()
        .filter(|c| c.game == client.game)
    {
        let target_engine = engines::require(&target.engine_id)?;
        let target_folder = target
            .fs_game
            .as_deref()
            .or(target_engine.default_fs_game)
            .unwrap_or("base");
        user_files::valid_folder(target_folder)?;
        user_files::write_bytes(
            &paths
                .client_home_dir(&target.id)
                .join(target_folder)
                .join(&file_name),
            body.as_bytes(),
        )?;
    }
    Ok(format!("exec {file_name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoted_bind_is_one_command() {
        assert_eq!(commands("bind x \"say ^1hello; say https://jknet.test\"; seta rate 25000 // note\nseta name \"A B\"").len(), 3);
    }
    #[test]
    fn conflicting_assignments_share_case_insensitive_key() {
        let v = values("seta RATE 100; rate 200; bind X \"say hi\"; unbind x");
        assert_eq!(v[0].key, v[1].key);
        assert_eq!(v[2].key, v[3].key);
        assert_eq!(v[3].value, "");
    }
    #[test]
    fn empty_assignment_is_preserved() {
        assert_eq!(values("seta name \"\"")[0].value, "");
    }
    #[test]
    fn scripts_are_not_silently_discarded() {
        assert_eq!(commands("vstr tree; exec another.cfg; unbindall").len(), 3);
        assert!(values("vstr tree; exec another.cfg; unbindall").is_empty());
    }
    #[test]
    fn unbindall_conflicts_with_other_documents_and_later_binds_win() {
        let keys = BTreeSet::from(["bind:x".into(), "bind:y".into()]);
        let result = effective_values("bind x old; unbindall; bind y new", &keys);
        assert_eq!(result["bind:x"].value, "");
        assert_eq!(result["bind:x"].command, "unbind x");
        assert_eq!(result["bind:y"].value, "new");
    }
    #[test]
    fn layers_reapply_in_priority_order_and_read_external_edits() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let client: clients::Client = serde_json::from_value(serde_json::json!({"id":"test-client","name":"Test","engineId":"openjk","engineVersion":null,"createdAt":"2026-09-12","fsGame":"custom_mod"})).unwrap();
        let low = ConfigDocument {
            id: "low".into(),
            name: "Low".into(),
            game: client.game,
            text: "seta rate 100".into(),
            source_client: None,
            source_file: None,
        };
        let mut high = low.clone();
        high.id = "high".into();
        high.text = "seta rate 200".into();
        let mut configs = ConfigBook {
            documents: vec![low.clone(), high.clone()],
            ..Default::default()
        };
        configs.clients.insert(
            client.id.clone(),
            vec![
                ConfigLayer {
                    config_id: "high".into(),
                    priority: 10,
                    enabled: true,
                },
                ConfigLayer {
                    config_id: "low".into(),
                    priority: -1,
                    enabled: true,
                },
            ],
        );
        for doc in &configs.documents {
            user_files::write_bytes(
                &root(&state).unwrap().join(format!("{}.cfg", doc.id)),
                doc.text.as_bytes(),
            )
            .unwrap();
        }
        save_book(&state, &configs).unwrap();
        assert_eq!(
            launch_layers(&state, &client).unwrap(),
            ["+exec", "jknet-active.cfg"]
        );
        let generated = state
            .paths()
            .unwrap()
            .client_home_dir(&client.id)
            .join("custom_mod/jknet-active.cfg");
        assert_eq!(
            fs::read_to_string(&generated).unwrap(),
            "seta rate 100\nseta rate 200\n"
        );
        user_files::write_bytes(&root(&state).unwrap().join("high.cfg"), b"seta rate 300").unwrap();
        launch_layers(&state, &client).unwrap();
        assert!(fs::read_to_string(generated)
            .unwrap()
            .ends_with("seta rate 300\n"));
    }

    #[test]
    fn per_client_defaults_persist_precede_layers_and_validate_sources() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let paths = state.paths().unwrap();
        let client: clients::Client = serde_json::from_value(serde_json::json!({"id":"first","name":"First","engineId":"eternaljk","engineVersion":null,"createdAt":"2026-09-13"})).unwrap();
        let mut other = client.clone();
        other.id = "other".into();
        clients::write_record(&paths, &client).unwrap();
        clients::write_record(&paths, &other).unwrap();
        let mut book: ConfigBook =
            serde_json::from_str(r#"{"documents":[],"clients":{}}"#).unwrap();
        assert!(book.defaults.is_empty());
        for (id, text) in [("base", "bind W +forward"), ("extra", "bind W +back")] {
            book.documents.push(ConfigDocument {
                id: id.into(),
                name: id.into(),
                game: Game::JediAcademy,
                text: text.into(),
                source_client: None,
                source_file: None,
            });
            user_files::write_bytes(
                &root(&state).unwrap().join(format!("{id}.cfg")),
                text.as_bytes(),
            )
            .unwrap();
        }
        book.defaults.insert("first".into(), "document:base".into());
        book.defaults
            .insert("other".into(), "file:base/custom.cfg".into());
        let file = paths.client_home_dir("other").join("base/custom.cfg");
        user_files::write_bytes(&file, b"bind W +moveup").unwrap();
        book.clients.insert(
            "first".into(),
            vec![
                ConfigLayer {
                    config_id: "extra".into(),
                    priority: 0,
                    enabled: true,
                },
                ConfigLayer {
                    config_id: "base".into(),
                    priority: 100,
                    enabled: true,
                },
            ],
        );
        save_book(&state, &book).unwrap();
        let restored = super::book(&state).unwrap();
        assert_eq!(restored.defaults.len(), 2);
        assert_eq!(
            preview_layers(&state, "other").unwrap(),
            ["+exec", "jknet-active.cfg"]
        );
        launch_layers(&state, &client).unwrap();
        assert_eq!(
            fs::read_to_string(
                paths
                    .client_home_dir("first")
                    .join("EternalJK/jknet-active.cfg")
            )
            .unwrap(),
            "bind W +forward\nbind W +back\n"
        );
        launch_layers(&state, &other).unwrap();
        assert_eq!(
            fs::read_to_string(
                paths
                    .client_home_dir("other")
                    .join("EternalJK/jknet-active.cfg")
            )
            .unwrap(),
            "bind W +moveup\n"
        );
        assert!(default_text(&state, &restored, &client, "file:base/custom.cfg").is_err());
        assert!(default_text(&state, &restored, &other, "file:../first/client.json").is_err());
        other.game = Game::JediOutcast;
        assert!(default_text(&state, &restored, &other, "document:base").is_err());
        other.game = Game::JediAcademy;
        user_files::write_bytes(&file, b"bind W +movedown").unwrap();
        assert_eq!(
            default_text(&state, &restored, &other, "file:base/custom.cfg").unwrap(),
            "bind W +movedown"
        );
        fs::remove_file(&file).unwrap();
        assert!(launch_layers(&state, &other).is_err());
    }
}
