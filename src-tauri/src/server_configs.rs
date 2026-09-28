//! Reusable server-only cfg documents. Authored text is never executed directly.
//!
//! Hosting accepts assignments, a starting map and a small mod-specific command
//! set, not general console scripts. It compiles checked commands into private
//! session cfg files, leaving the host form and the launcher's network and
//! credentials policy in control.

use crate::{
    error::{AppError, Result},
    game::Game,
    hosting::server,
    state::AppState,
    user_files,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};

const MAX_TEXT_BYTES: usize = 64 * 1024;
// An exported cfg may include the launcher's metadata header before its text.
const MAX_IMPORT_BYTES: usize = MAX_TEXT_BYTES + 1024;
const MAX_COMMAND_BYTES: usize = 1000;

#[derive(Debug, Serialize)]
pub struct ServerConfigFile {
    pub name: String,
    pub text: String,
}

fn windows_1251_cyrillic(byte: u8) -> bool {
    matches!(
        byte,
        0x80 | 0x81 | 0x83 | 0x8a | 0x8c..=0x90 | 0x9a | 0x9c..=0x9f
            | 0xa1..=0xa3 | 0xa5 | 0xa8 | 0xaa | 0xaf | 0xb2..=0xb4 | 0xb8
            | 0xba | 0xbc..=0xff
    )
}

/// A legacy code page needs a positive signal. One accented Western letter is
/// common in Windows-1252, while a Cyrillic word has several adjacent bytes.
fn looks_like_windows_1251(bytes: &[u8]) -> bool {
    let mut run = 0;
    let mut longest = 0;
    for byte in bytes {
        if windows_1251_cyrillic(*byte) {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    longest >= 3
}

fn decode_with(encoding: &'static encoding_rs::Encoding, bytes: &[u8]) -> Option<String> {
    let (text, _, had_errors) = encoding.decode(bytes);
    (!had_errors).then(|| text.into_owned())
}

/// Decode files authored by modern editors and the legacy Windows tools used
/// with Jedi Academy. UTF-8 wins whenever it is valid; a BOM names UTF-16;
/// otherwise a Cyrillic word distinguishes Windows-1251 from Windows-1252.
fn decode_import_text(bytes: &[u8]) -> Result<String> {
    let decoded = if let Ok(text) = std::str::from_utf8(bytes) {
        Some(text.to_owned())
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        decode_with(encoding_rs::UTF_16LE, bytes)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        decode_with(encoding_rs::UTF_16BE, bytes)
    } else {
        let pages = if looks_like_windows_1251(bytes) {
            [encoding_rs::WINDOWS_1251, encoding_rs::WINDOWS_1252]
        } else {
            [encoding_rs::WINDOWS_1252, encoding_rs::WINDOWS_1251]
        };
        pages
            .into_iter()
            .find_map(|encoding| decode_with(encoding, bytes))
    };
    let text = decoded.ok_or_else(|| {
        AppError::InvalidInput("server config import requires a supported text encoding".into())
    })?;
    if text.contains('\0') {
        return Err(AppError::InvalidInput(
            "server config import requires a text file".into(),
        ));
    }
    Ok(text)
}

fn is_cfg_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cfg"))
}

/// The server editor owns its drops, including files it will refuse to import.
pub(crate) fn handles_file_drop(label: &str, fragment: Option<&str>) -> bool {
    if label != "main" {
        return false;
    }
    let Some(query) = fragment.and_then(|fragment| fragment.strip_prefix("/configs?")) else {
        return false;
    };
    let mut route = tauri::Url::parse("tauri://localhost/configs").expect("static editor URL");
    route.set_query(Some(query));
    // Match URLSearchParams.get: the first occurrence owns a repeated key.
    route
        .query_pairs()
        .find(|(key, _)| key == "scope")
        .is_some_and(|(_, value)| value == "server")
}

/// Read one authored file for the import preview; this neither saves nor runs it.
#[tauri::command]
pub fn server_config_read_file(path: PathBuf) -> Result<ServerConfigFile> {
    if !is_cfg_file(&path) {
        return Err(AppError::InvalidInput(
            "server config import requires a .cfg file".into(),
        ));
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| AppError::io_path("cannot inspect server config file", &path, error))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidInput(
            "server config import requires a regular file".into(),
        ));
    }
    if metadata.len() > MAX_IMPORT_BYTES as u64 {
        return Err(AppError::InvalidInput(
            "server config import exceeds limits".into(),
        ));
    }
    let file = fs::File::open(&path)
        .map_err(|error| AppError::io_path("cannot open server config file", &path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io_path("cannot inspect server config file", &path, error))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidInput(
            "server config import requires a regular file".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take((MAX_IMPORT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::io_path("cannot read server config file", &path, error))?;
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(AppError::InvalidInput(
            "server config import exceeds limits".into(),
        ));
    }
    let text = decode_import_text(&bytes)?;
    let name = path
        .file_name()
        .expect("cfg path has a filename")
        .to_string_lossy()
        .into_owned();
    Ok(ServerConfigFile { name, text })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigDocument {
    pub id: String,
    pub name: String,
    pub game: Game,
    pub mod_id: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gametype: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_players: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bots: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ServerConfigIssue {
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerConfigNoticeKind {
    ManagedSetting,
    MapRotation,
    UnsupportedCommand,
}

#[derive(Debug, Serialize)]
pub struct ServerConfigNotice {
    pub line: usize,
    pub kind: ServerConfigNoticeKind,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigCheck {
    pub settings: ServerConfigSettings,
    pub issues: Vec<ServerConfigIssue>,
    pub notices: Vec<ServerConfigNotice>,
    pub compatible_mod_folders: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct ConfigBook {
    documents: Vec<ServerConfigDocument>,
}

fn root(state: &AppState) -> Result<PathBuf> {
    Ok(state.paths()?.root.join("server-configs"))
}

fn book(state: &AppState) -> Result<ConfigBook> {
    let root = root(state)?;
    let mut book: ConfigBook = user_files::read(&root.join("index.json"))?;
    for document in &mut book.documents {
        user_files::valid_id(&document.id)?;
        let path = root.join(format!("{}.cfg", document.id));
        document.text = fs::read_to_string(&path)
            .map_err(|e| AppError::io_path("cannot read server config", &path, e))?;
    }
    Ok(book)
}

fn save_book(state: &AppState, book: &ConfigBook) -> Result<()> {
    // Keep a single authoritative copy of authored text in the cfg file.
    let index = ConfigBook {
        documents: book
            .documents
            .iter()
            .cloned()
            .map(|mut document| {
                document.text.clear();
                document
            })
            .collect(),
    };
    user_files::write(&root(state)?.join("index.json"), &index)
}

fn compatible_folders(document: &ServerConfigDocument) -> Result<&'static [&'static str]> {
    let folders: &[&str] = match document.mod_id.as_str() {
        "base" => &["", "base"],
        "japlus" => &["japlus"],
        "japro" => &["japro"],
        "mbii" => &["MBII"],
        "lugormod" => &["lugormod"],
        "makermod" => &["makermod"],
        _ => return Err(AppError::InvalidInput("unknown server config mod".into())),
    };
    if document.game != Game::JediAcademy && document.mod_id != "base" {
        return Err(AppError::InvalidInput(
            "server config mod does not support this game".into(),
        ));
    }
    Ok(folders)
}

fn validate_document(document: &ServerConfigDocument) -> Result<()> {
    user_files::label(&document.name)?;
    if !document.id.is_empty() {
        user_files::valid_id(&document.id)?;
    }
    compatible_folders(document)?;
    if document.text.len() > MAX_TEXT_BYTES || document.text.contains('\0') {
        return Err(AppError::InvalidInput(
            "server config exceeds limits".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn server_configs_list(state: tauri::State<'_, AppState>) -> Result<Vec<ServerConfigDocument>> {
    let _guard = state.client_records().enter();
    Ok(book(&state)?.documents)
}

fn save(state: &AppState, mut document: ServerConfigDocument) -> Result<ServerConfigDocument> {
    validate_document(&document)?;
    document.name = user_files::label(&document.name)?;
    let mut book = book(state)?;
    if document.id.is_empty() {
        document.id = user_files::id();
    } else if !book.documents.iter().any(|saved| saved.id == document.id) {
        return Err(AppError::NotFound("server config".into()));
    }
    user_files::write_bytes(
        &root(state)?.join(format!("{}.cfg", document.id)),
        document.text.as_bytes(),
    )?;
    book.documents.retain(|saved| saved.id != document.id);
    book.documents.push(document.clone());
    save_book(state, &book)?;
    Ok(document)
}

#[tauri::command]
pub fn server_config_save(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    document: ServerConfigDocument,
) -> Result<ServerConfigDocument> {
    let _guard = state.client_records().enter();
    let saved = save(&state, document)?;
    let _ = app.emit("server-configs:changed", ());
    Ok(saved)
}

fn delete(state: &AppState, id: &str) -> Result<()> {
    user_files::valid_id(id)?;
    let mut book = book(state)?;
    book.documents.retain(|document| document.id != id);
    save_book(state, &book)?;
    let path = root(state)?.join(format!("{id}.cfg"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::io_path("cannot delete server config", &path, e)),
    }
}

#[tauri::command]
pub fn server_config_delete(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<()> {
    let _guard = state.client_records().enter();
    delete(&state, &id)?;
    let _ = app.emit("server-configs:changed", ());
    Ok(())
}

#[derive(Debug)]
struct Assignment {
    line: usize,
    name: String,
    value: String,
}

#[derive(Default)]
struct Parsed {
    assignments: Vec<Assignment>,
    post_map_commands: Vec<String>,
    map: Option<String>,
    issues: Vec<ServerConfigIssue>,
    notices: Vec<ServerConfigNotice>,
}

impl Parsed {
    fn issue(&mut self, line: usize, message: impl Into<String>) {
        self.issues.push(ServerConfigIssue {
            line,
            message: message.into(),
        });
    }

    fn notice(&mut self, line: usize, kind: ServerConfigNoticeKind, name: impl Into<String>) {
        self.notices.push(ServerConfigNotice {
            line,
            kind,
            name: name.into(),
        });
    }
}

/// This lexer deliberately does not implement shell escaping: Quake does not
/// escape quotes with backslashes. A physical newline always ends a command,
/// including inside quotes. Normalizing tokens avoids comment and delimiter
/// differences between engine versions.
fn commands(text: &str, parsed: &mut Parsed) -> Vec<(usize, Vec<String>)> {
    let mut commands = Vec::new();
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut token_started = false;
    let mut quoted = false;
    let mut block_comment = false;
    let mut block_line = 1;
    let mut line = 1;
    let mut command_line = 1;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() == Some(&'\n') {
            continue;
        }
        let newline = matches!(c, '\n' | '\r');
        if block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                block_comment = false;
            }
            if newline {
                line += 1;
            }
            continue;
        }
        if newline || (!quoted && c == ';') {
            if quoted {
                parsed.issue(command_line, "unterminated quoted value");
                quoted = false;
            }
            if token_started {
                tokens.push(std::mem::take(&mut token));
                token_started = false;
            }
            if !tokens.is_empty() {
                commands.push((command_line, std::mem::take(&mut tokens)));
            }
            if newline {
                line += 1;
            }
            command_line = line;
            continue;
        }
        if !quoted && c == '/' && matches!(chars.peek(), Some('/' | '*')) {
            if token_started {
                tokens.push(std::mem::take(&mut token));
                token_started = false;
            }
            if chars.next() == Some('*') {
                block_comment = true;
                block_line = line;
            } else {
                while chars.peek().is_some_and(|c| !matches!(c, '\n' | '\r')) {
                    chars.next();
                }
            }
            continue;
        }
        if c == '"' {
            // A quote ends an unquoted token or a quoted token in the engine.
            if quoted || token_started {
                tokens.push(std::mem::take(&mut token));
            }
            if tokens.is_empty() && !token_started {
                command_line = line;
            }
            quoted = !quoted;
            token_started = quoted;
        } else if !quoted && matches!(c, ' ' | '\t') {
            if token_started {
                tokens.push(std::mem::take(&mut token));
                token_started = false;
            }
        } else {
            if c.is_control() {
                parsed.issue(line, "unsupported control character");
            }
            if tokens.is_empty() && !token_started {
                command_line = line;
            }
            token_started = true;
            token.push(c);
        }
    }
    if block_comment {
        parsed.issue(block_line, "unterminated block comment");
    }
    if quoted {
        parsed.issue(command_line, "unterminated quoted value");
    }
    if token_started {
        tokens.push(token);
    }
    if !tokens.is_empty() {
        commands.push((command_line, tokens));
    }
    commands
}

fn valid_cvar(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && name.as_bytes()[0].is_ascii_alphabetic()
}

fn protected_cvar(name: &str) -> bool {
    ["password", "passwd", "secret", "token", "rcon"]
        .iter()
        .any(|part| name.contains(part))
        || ["fs_", "net_", "sv_master", "com_", "vm_", "jknet_", "g_log"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        || matches!(
            name,
            "dedicated"
                | "nextmap"
                | "nextdemo"
                | "logfile"
                | "developer"
                | "sv_pure"
                | "sv_allowdownload"
                | "sv_lanforcerate"
                | "sv_privateclients"
                | "sv_banfile"
                | "sv_mappoolfile"
                | "g_statlogfile"
                | "g_mapconfigs"
                | "g_mapconfig"
                | "g_filterban"
                | "g_banips"
                | "sv_autoexec"
                | "cl_autoexec"
        )
}

fn map_rotation_cvar(name: &str, value: &str) -> bool {
    let Some(suffix) = name.strip_prefix("map") else {
        return false;
    };
    !suffix.is_empty()
        && suffix.bytes().all(|byte| byte.is_ascii_digit())
        && value.to_ascii_lowercase().contains("nextmap")
}

/// Read only the starting map from the conventional `mapN` rotation shape.
/// The authored script remains untrusted and is never executed by hosting.
fn rotation_starting_map(value: &str) -> Option<String> {
    let mut nested = Parsed::default();
    let commands = commands(value, &mut nested);
    if !nested.issues.is_empty() || commands.len() != 2 {
        return None;
    }
    let first = &commands[0].1;
    if first.len() != 2
        || !matches!(first[0].to_ascii_lowercase().as_str(), "map" | "devmap")
        || !server::is_safe_map_name(&first[1])
    {
        return None;
    }
    let next = &commands[1].1;
    if next.len() != 4
        || !matches!(next[0].to_ascii_lowercase().as_str(), "set" | "seta")
        || !next[1].eq_ignore_ascii_case("nextmap")
        || !next[2].eq_ignore_ascii_case("vstr")
        || !valid_cvar(&next[3])
    {
        return None;
    }
    Some(first[1].clone())
}

fn form_cvar(name: &str) -> bool {
    matches!(
        name,
        "map"
            | "mapname"
            | "sv_hostname"
            | "g_gametype"
            | "sv_maxclients"
            | "timelimit"
            | "fraglimit"
            | "duel_fraglimit"
            | "capturelimit"
            | "bot_minplayers"
    )
}

/// MBII reuses base game type numbers but counts rounds with fraglimit.
pub(crate) fn score_cvar(
    game: Game,
    mod_folder: Option<&str>,
    gametype: u8,
) -> Option<&'static str> {
    if mod_folder.is_some_and(|folder| folder.eq_ignore_ascii_case("mbii"))
        && matches!(gametype, 3 | 4 | 7)
    {
        Some("fraglimit")
    } else {
        game.spec()
            .hosting
            .gametype(gametype)
            .and_then(|mode| mode.score_cvar)
    }
}

fn unsupported_command(name: &str) -> bool {
    matches!(
        name,
        "exec"
            | "execq"
            | "vstr"
            | "echo"
            | "wait"
            | "quit"
            | "exit"
            | "disconnect"
            | "connect"
            | "reconnect"
            | "map_restart"
            | "devmap"
            | "devmapall"
            | "spmap"
            | "spdevmap"
            | "killserver"
            | "heartbeat"
            | "writeconfig"
            | "write"
            | "condump"
            | "bind"
            | "unbind"
            | "unbindall"
            | "alias"
            | "setop"
            | "setrandom"
            | "setfromcvar"
            | "reset"
            | "unset"
            | "toggle"
            | "cvar_restart"
            | "vid_restart"
            | "snd_restart"
            | "net_restart"
            | "addbot"
            | "kick"
            | "clientkick"
            | "rcon"
            | "tell"
            | "say"
            | "svsay"
            | "status"
            | "serverinfo"
            | "systeminfo"
    )
}

fn safe_makermod_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 64
        && !value.starts_with('/')
        && !value.split('/').any(|segment| segment == "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/'))
}

fn safe_makermod_weather_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-' | b'.' | b'/' | b'(' | b')' | b'+')
        })
}

fn makermod_command(
    parsed: &mut Parsed,
    mod_id: &str,
    line: usize,
    command: &str,
    tokens: &[String],
) -> bool {
    if !matches!(command, "mremap" | "mweather") {
        return false;
    }
    if mod_id != "makermod" {
        parsed.notice(line, ServerConfigNoticeKind::UnsupportedCommand, command);
        return true;
    }
    match command {
        "mremap" => {
            if tokens.len() == 2 && tokens[1].eq_ignore_ascii_case("clear") {
                if !parsed
                    .post_map_commands
                    .iter()
                    .any(|value| value == "mremap clear")
                {
                    parsed.post_map_commands.push("mremap clear".into());
                }
                return true;
            }
            if tokens.len() != 3
                || !safe_makermod_path(&tokens[1])
                || !safe_makermod_path(&tokens[2])
                || matches!(
                    tokens[1].to_ascii_lowercase().as_str(),
                    "clear" | "list" | "remove"
                )
            {
                parsed.issue(line, "mremap requires two safe shader paths");
                return true;
            }
            if !parsed
                .post_map_commands
                .iter()
                .any(|value| value == "mremap clear")
            {
                parsed.post_map_commands.push("mremap clear".into());
            }
        }
        "mweather" => {
            const WEATHER: &[&str] = &[
                "clear",
                "freeze",
                "zone",
                "wind",
                "constantwind",
                "gustingwind",
                "windzone",
                "lightrain",
                "rain",
                "acidrain",
                "heavyrain",
                "snow",
                "spacedust",
                "sand",
                "fog",
                "heavyrainfog",
                "light_fog",
                "outsideshake",
                "outsidepain",
                "die",
            ];
            if tokens.len() < 2
                || !WEATHER.contains(&tokens[1].to_ascii_lowercase().as_str())
                || tokens[1..]
                    .iter()
                    .any(|token| !safe_makermod_weather_token(token))
            {
                parsed.issue(line, "mweather contains an unsupported weather value");
                return true;
            }
            if !parsed
                .post_map_commands
                .iter()
                .any(|value| value == "mweather clear")
            {
                parsed.post_map_commands.push("mweather clear".into());
            }
        }
        _ => unreachable!(),
    }
    let value = format!("{command} {}", tokens[1..].join(" "));
    if value.len() >= MAX_COMMAND_BYTES {
        parsed.issue(line, "MakerMod command exceeds limits");
    } else if !matches!(value.as_str(), "mremap clear" | "mweather clear") {
        parsed.post_map_commands.push(value);
    }
    true
}

fn parse(text: &str, mod_id: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let source_commands = commands(text, &mut parsed);
    let mut rotation_scripts = BTreeMap::new();
    let mut invoked_scripts = Vec::new();
    for (line, tokens) in source_commands {
        let command = tokens[0].to_ascii_lowercase();
        if command == "map" {
            if tokens.len() == 2 && server::is_safe_map_name(&tokens[1]) {
                parsed.map = Some(tokens[1].clone());
            } else {
                parsed.issue(line, "invalid starting map");
            }
            continue;
        }
        if makermod_command(&mut parsed, mod_id, line, &command, &tokens) {
            continue;
        }
        let explicit = matches!(command.as_str(), "set" | "seta" | "sets" | "setu");
        let index = usize::from(explicit);
        if unsupported_command(&command)
            || (!explicit
                && !command.contains('_')
                && !matches!(
                    command.as_str(),
                    "timelimit" | "fraglimit" | "capturelimit" | "dmflags"
                ))
        {
            if command == "vstr" && tokens.len() == 2 && valid_cvar(&tokens[1]) {
                invoked_scripts.push(tokens[1].to_ascii_lowercase());
            }
            parsed.notice(
                line,
                if command == "vstr" {
                    ServerConfigNoticeKind::MapRotation
                } else {
                    ServerConfigNoticeKind::UnsupportedCommand
                },
                &tokens[0],
            );
            continue;
        }
        if tokens.len() <= index + 1 || !valid_cvar(&tokens[index]) {
            parsed.issue(line, "expected a cvar assignment and a value");
            continue;
        }
        let name = tokens[index].to_ascii_lowercase();
        let value = tokens[index + 1..].join(" ");
        if map_rotation_cvar(&name, &value) {
            rotation_scripts.insert(name.clone(), value.clone());
            parsed.notice(line, ServerConfigNoticeKind::MapRotation, &tokens[index]);
            continue;
        }
        if protected_cvar(&name) {
            parsed.notice(
                line,
                if name == "nextmap" {
                    ServerConfigNoticeKind::MapRotation
                } else {
                    ServerConfigNoticeKind::ManagedSetting
                },
                &tokens[index],
            );
            continue;
        }
        // Quoting the entire value is safe only when it cannot terminate a
        // physical command or the quoted value in any supported engine.
        if value.chars().any(|c| c.is_control() || c == '"')
            || name.len() + value.len() + 10 >= MAX_COMMAND_BYTES
        {
            parsed.issue(
                line,
                "cvar assignment exceeds limits or contains invalid characters",
            );
            continue;
        }
        parsed.assignments.push(Assignment { line, name, value });
    }
    if parsed.map.is_none() {
        parsed.map = invoked_scripts.iter().rev().find_map(|name| {
            rotation_scripts
                .get(name)
                .and_then(|value| rotation_starting_map(value))
        });
    }
    if parsed
        .assignments
        .iter()
        .map(|assignment| assignment.name.len() + assignment.value.len() + 8)
        .sum::<usize>()
        + parsed
            .post_map_commands
            .iter()
            .map(String::len)
            .sum::<usize>()
        > MAX_TEXT_BYTES
    {
        parsed.issue(1, "compiled server config exceeds limits");
    }
    parsed
}

fn check_parsed(document: &ServerConfigDocument, parsed: &mut Parsed) -> ServerConfigSettings {
    let values: BTreeMap<&str, &Assignment> = parsed
        .assignments
        .iter()
        .map(|assignment| (assignment.name.as_str(), assignment))
        .collect();
    let mut settings = ServerConfigSettings {
        map: parsed.map.clone(),
        ..Default::default()
    };
    let mut issues = Vec::new();
    let mut number = |name: &str, min: u32, max: u32| {
        let assignment = values.get(name)?;
        match assignment.value.parse::<u32>() {
            Ok(value) if (min..=max).contains(&value) => Some(value),
            _ => {
                issues.push(ServerConfigIssue {
                    line: assignment.line,
                    message: format!("{name} must be between {min} and {max}"),
                });
                None
            }
        }
    };
    settings.gametype = number("g_gametype", 0, 255);
    settings.max_players = number("sv_maxclients", 2, 16);
    settings.time_limit = number("timelimit", 0, 999);
    settings.bots = number("bot_minplayers", 0, 16);
    let scores =
        ["fraglimit", "duel_fraglimit", "capturelimit"].map(|name| (name, number(name, 0, 999)));
    let default_gametype = if document.mod_id == "mbii" {
        7
    } else {
        document.game.spec().hosting.gametypes[0].index
    };
    let gametype = settings.gametype.unwrap_or(u32::from(default_gametype)) as u8;
    if document.mod_id == "mbii" && settings.gametype.is_some() && !matches!(gametype, 3 | 4 | 7) {
        issues.push(ServerConfigIssue {
            line: values
                .get("g_gametype")
                .map_or(1, |assignment| assignment.line),
            message: "Movie Battles II supports game types 3, 4 and 7".into(),
        });
    }
    match document.game.spec().hosting.gametype(gametype) {
        Some(mode) => {
            let score_cvar = score_cvar(document.game, Some(&document.mod_id), gametype);
            settings.score_limit = scores
                .iter()
                .find(|(name, _)| Some(*name) == score_cvar)
                .and_then(|(_, value)| *value)
                .or_else(|| {
                    let default = if document.mod_id == "mbii" {
                        // The existing host frag limit is a launcher default,
                        // not a claim about a particular MBII release's default.
                        crate::game::SCORE_CVARS
                            .iter()
                            .find(|(name, _)| Some(*name) == score_cvar)
                            .map_or(0, |(_, limit)| *limit)
                    } else {
                        mode.default_score
                    };
                    Some(u32::from(default))
                });
        }
        None => {
            if let Some(assignment) = values.get("g_gametype") {
                issues.push(ServerConfigIssue {
                    line: assignment.line,
                    message: "unsupported game type".into(),
                });
            }
        }
    }
    if let Some(assignment) = values.get("sv_hostname") {
        settings.server_name = Some(assignment.value.clone());
    }
    if let Some(assignment) = values.get("mapname") {
        issues.push(ServerConfigIssue {
            line: assignment.line,
            message: "use map to select a starting map".into(),
        });
    }
    if let Some(assignment) = values.get("map") {
        issues.push(ServerConfigIssue {
            line: assignment.line,
            message: "use map to select a starting map".into(),
        });
    }
    // Selecting a sparse document must reset numeric host fields rather than
    // accidentally carrying values from the previously selected document.
    settings.gametype.get_or_insert(u32::from(default_gametype));
    settings.max_players.get_or_insert(8);
    settings.time_limit.get_or_insert(0);
    settings.bots.get_or_insert(0);
    if document.mod_id == "mbii" && settings.bots.is_some_and(|bots| bots > 0) {
        issues.push(ServerConfigIssue {
            line: values
                .get("bot_minplayers")
                .map_or(1, |assignment| assignment.line),
            message: "bots are not supported for Movie Battles II hosting".into(),
        });
    }
    if settings.bots > settings.max_players {
        issues.push(ServerConfigIssue {
            line: values
                .get("bot_minplayers")
                .map_or(1, |assignment| assignment.line),
            message: "more bots than places on the server".into(),
        });
    }
    parsed.issues.extend(issues);
    settings
}

#[tauri::command]
pub fn server_config_check(document: ServerConfigDocument) -> Result<ServerConfigCheck> {
    validate_document(&document)?;
    let mut parsed = parse(&document.text, &document.mod_id);
    let settings = check_parsed(&document, &mut parsed);
    Ok(ServerConfigCheck {
        settings,
        issues: parsed.issues,
        notices: parsed.notices,
        compatible_mod_folders: compatible_folders(&document)?
            .iter()
            .map(|name| (*name).into())
            .collect(),
    })
}

/// Re-read the selected cfg for every start. Holding the document lock prevents
/// an edit from changing the file midway through selection and validation.
pub(crate) fn for_host(
    state: &AppState,
    id: Option<&str>,
    game: Game,
    fs_game: Option<&str>,
) -> Result<Vec<String>> {
    let Some(id) = id else { return Ok(Vec::new()) };
    let _guard = state.client_records().enter();
    user_files::valid_id(id)?;
    let document = book(state)?
        .documents
        .into_iter()
        .find(|document| document.id == id)
        .ok_or_else(|| AppError::NotFound("server config".into()))?;
    compile_for_host(&document, game, fs_game)
}

pub(crate) fn compile_for_host(
    document: &ServerConfigDocument,
    game: Game,
    fs_game: Option<&str>,
) -> Result<Vec<String>> {
    validate_document(document)?;
    if document.game != game
        || !compatible_folders(document)?
            .iter()
            .any(|folder| folder.eq_ignore_ascii_case(fs_game.unwrap_or("")))
    {
        return Err(AppError::InvalidInput(
            "server config is incompatible with the selected client".into(),
        ));
    }
    let mut parsed = parse(&document.text, &document.mod_id);
    check_parsed(document, &mut parsed);
    if let Some(issue) = parsed.issues.first() {
        return Err(AppError::InvalidInput(format!(
            "server config line {}: {}",
            issue.line, issue.message
        )));
    }
    let mut commands: Vec<String> = parsed
        .assignments
        .into_iter()
        .filter(|assignment| !form_cvar(&assignment.name))
        .map(|assignment| format!("set {} \"{}\"", assignment.name, assignment.value))
        .collect();
    commands.extend(parsed.post_map_commands);
    Ok(commands)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_import_keeps_utf8_text_and_original_filename() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("Duel night.CfG");
        let text = "\u{feff}// \u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}\r\nset g_gravity 650\r\n";
        fs::write(&path, text).unwrap();
        let imported = server_config_read_file(path).unwrap();
        assert_eq!(imported.name, "Duel night.CfG");
        assert_eq!(imported.text, text);
    }

    #[test]
    fn file_import_rejects_other_extensions_directories_and_binary_text() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["settings.json", "server.cfg.exe", "server"] {
            let path = temp.path().join(name);
            fs::write(&path, "set g_gravity 650").unwrap();
            assert!(matches!(
                server_config_read_file(path),
                Err(AppError::InvalidInput(_))
            ));
        }
        let directory = temp.path().join("directory.cfg");
        fs::create_dir(&directory).unwrap();
        assert!(matches!(
            server_config_read_file(directory),
            Err(AppError::InvalidInput(_))
        ));
        let invalid = temp.path().join("invalid.cfg");
        fs::write(&invalid, [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(
            server_config_read_file(invalid),
            Err(AppError::InvalidInput(_))
        ));
        assert!(server_config_read_file(temp.path().join("missing.cfg")).is_err());
    }

    #[test]
    fn file_import_decodes_legacy_windows_text() {
        let temp = tempfile::tempdir().unwrap();
        let cyrillic = temp.path().join("windows-1251.cfg");
        let source = "// Настройки сервера\r\nseta sv_hostname \"Academy\"\r\n";
        fs::write(&cyrillic, &encoding_rs::WINDOWS_1251.encode(source).0).unwrap();
        assert_eq!(server_config_read_file(cyrillic).unwrap().text, source);

        let western = temp.path().join("windows-1252.cfg");
        let source = "// Schöne Grüße aus der Akademie\r\nset g_gravity 650\r\n";
        fs::write(&western, &encoding_rs::WINDOWS_1252.encode(source).0).unwrap();
        assert_eq!(server_config_read_file(western).unwrap().text, source);

        let utf16 = temp.path().join("utf-16.cfg");
        let mut bytes = vec![0xff, 0xfe];
        for unit in "// UTF-16\r\nset g_speed 250\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&utf16, bytes).unwrap();
        assert_eq!(
            server_config_read_file(utf16).unwrap().text,
            "// UTF-16\r\nset g_speed 250\r\n"
        );
    }

    #[test]
    fn file_import_allows_metadata_overhead_but_rejects_one_byte_over_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("limit.cfg");
        fs::write(&path, vec![b'x'; MAX_IMPORT_BYTES]).unwrap();
        assert_eq!(
            server_config_read_file(path.clone()).unwrap().text.len(),
            MAX_IMPORT_BYTES
        );
        fs::write(&path, vec![b'x'; MAX_IMPORT_BYTES + 1]).unwrap();
        assert!(matches!(
            server_config_read_file(path),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn file_drop_is_reserved_only_for_the_main_server_editor() {
        for fragment in [
            "/configs?scope=server",
            "/configs?selected=duel&scope=server",
            "/configs?scope=server&selected=duel",
            "/configs?scope=%73erver",
            "/configs?scope=server&scope=client",
        ] {
            assert!(handles_file_drop("main", Some(fragment)), "{fragment}");
        }
        for fragment in [
            None,
            Some("/configs"),
            Some("/configs?scope=client"),
            Some("/configs?scope=client&scope=server"),
            Some("/configs?scope=servers"),
            Some("/configs?other=scope=server"),
            Some("/configs/other?scope=server"),
            Some("/library?scope=server"),
        ] {
            assert!(!handles_file_drop("main", fragment), "{fragment:?}");
        }
        let fragment = Some("/configs?scope=server");
        for label in ["chat", "client-duel"] {
            assert!(!handles_file_drop(label, fragment));
        }
    }

    fn document(text: &str) -> ServerConfigDocument {
        ServerConfigDocument {
            id: String::new(),
            name: "Duel night".into(),
            game: Game::JediAcademy,
            mod_id: "base".into(),
            text: text.into(),
        }
    }

    #[test]
    fn cfg_round_trip_is_separate_from_client_documents_and_reads_external_edits() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(temp.path().into());
        let original = "// Keep comments\r\nset g_gravity 600; exec future.cfg\r\n";
        let saved = save(&state, document(original)).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(
            book(&state).unwrap().documents.as_slice(),
            std::slice::from_ref(&saved)
        );
        assert!(!state
            .paths()
            .unwrap()
            .root
            .join("configs/index.json")
            .exists());
        assert_eq!(
            for_host(&state, Some(&saved.id), saved.game, None).unwrap(),
            ["set g_gravity \"600\""]
        );
        let path = root(&state).unwrap().join(format!("{}.cfg", saved.id));
        fs::write(&path, "set g_gravity 400").unwrap();
        assert_eq!(
            for_host(&state, Some(&saved.id), saved.game, None).unwrap(),
            ["set g_gravity \"400\""]
        );
        delete(&state, &saved.id).unwrap();
        assert!(!path.exists());
        assert!(book(&state).unwrap().documents.is_empty());
        assert!(for_host(&state, Some(&saved.id), saved.game, None).is_err());
        assert!(for_host(&state, None, saved.game, None).unwrap().is_empty());
    }

    #[test]
    fn document_limits_and_path_traversal_are_rejected() {
        for id in ["../outside", "a/b", "a\\b", "a.cfg", " "] {
            let mut doc = document("");
            doc.id = id.into();
            assert!(validate_document(&doc).is_err());
        }
        assert!(validate_document(&document(&"x".repeat(MAX_TEXT_BYTES + 1))).is_err());
        assert!(validate_document(&document("set x \0")).is_err());
        let mut doc = document("");
        doc.name = "  ".into();
        assert!(validate_document(&doc).is_err());
    }

    #[test]
    fn quotes_comments_semicolons_and_last_assignments_are_understood() {
        let doc = document("\u{feff}// greeting\nset sv_hostname \"A; // B\"; set g_gametype 3\n/* details\n ignored */\nset sv_maxclients 4\nset duel_fraglimit 5; set duel_fraglimit 8\nmap mp/duel1\nseta g_gravity 600");
        let checked = server_config_check(doc.clone()).unwrap();
        assert!(checked.issues.is_empty(), "{:?}", checked.issues);
        assert_eq!(checked.settings.server_name.as_deref(), Some("A; // B"));
        assert_eq!(checked.settings.score_limit, Some(8));
        assert_eq!(checked.settings.map.as_deref(), Some("mp/duel1"));
        assert_eq!(
            compile_for_host(&doc, doc.game, None).unwrap(),
            ["set g_gravity \"600\""]
        );
    }

    #[test]
    fn unsupported_commands_and_managed_settings_are_skipped_without_execution() {
        for text in [
            "exec other.cfg",
            "vstr later",
            "quit",
            "writeconfig outside.cfg",
            "map_restart 0",
            "set dedicated 2",
            "SET \"rConPassWord\" leak",
            "sets g_password hidden",
            "set sv_master2 example.com",
            "set fs_homepath elsewhere",
            "set net_ip 0.0.0.0",
            "set jknet_session other",
            "set nextmap \"quit\"",
            "set sv_allowDownload 1",
            "set g_log path",
            "set mod_adminPassword password",
            "set mod_apiToken value",
            "set g_gravity 600; SeT dedicated 2",
            "set g_gravity 600\nexec evil.cfg",
            "unknowncommand data",
        ] {
            let doc = document(text);
            let checked = server_config_check(doc.clone()).unwrap();
            assert!(
                checked.issues.is_empty() && !checked.notices.is_empty(),
                "{text}"
            );
            let compiled = compile_for_host(&doc, doc.game, None).unwrap();
            if text.starts_with("set g_gravity 600;") || text.starts_with("set g_gravity 600\n") {
                assert_eq!(compiled, ["set g_gravity \"600\""]);
            } else {
                assert!(compiled.is_empty(), "{text}: {compiled:?}");
            }
        }
        let checked =
            server_config_check(document("// first\nset g_gravity 600\nexec other.cfg")).unwrap();
        assert_eq!(checked.notices[0].line, 3);
    }

    #[test]
    fn malformed_or_out_of_range_assignments_still_block_hosting() {
        for text in [
            "set g_gravity \"600\nquit\"",
            "set g_gravity 600 /*",
            "set g_gravity \"600",
            "set g_gravity 600\u{000b}quit",
            "set sv_maxclients 100",
        ] {
            let doc = document(text);
            assert!(
                !server_config_check(doc.clone()).unwrap().issues.is_empty(),
                "{text}"
            );
            assert!(compile_for_host(&doc, doc.game, None).is_err(), "{text}");
        }
    }

    #[test]
    fn quoted_payload_stays_data_and_unknown_mod_cvars_survive() {
        let doc = document("set custom_unknown \"600; quit; // data\"; g_gravity 700");
        assert_eq!(
            compile_for_host(&doc, doc.game, None).unwrap(),
            [
                "set custom_unknown \"600; quit; // data\"",
                "set g_gravity \"700\""
            ]
        );
    }

    #[test]
    fn makermod_import_keeps_checked_map_commands_and_compacts_skipped_lines() {
        let mut doc = document(
            "set sv_master1 master.example.com\n\
             set rconpassword placeholder\n\
             different npc models are used.\n\
             set map1 \"devmap t2_trip;set nextmap vstr map1\"\n\
             set nextmap \"vstr map1\"\n\
             vstr map1\n\
             set g_forcepowerdisable 0\n\
             mremap textures/quicktrip/desert_0 textures/h_Evil/evil_rock13;\
             mweather fog;mweather wind;mremap console clear\n\
             mremap models/players/jawa/jawa textures/rift/env_crystal",
        );
        doc.mod_id = "makermod".into();
        let checked = server_config_check(doc.clone()).unwrap();
        assert!(checked.issues.is_empty(), "{:?}", checked.issues);
        assert_eq!(checked.settings.map.as_deref(), Some("t2_trip"));
        assert_eq!(
            checked
                .notices
                .iter()
                .filter(|notice| notice.kind == ServerConfigNoticeKind::ManagedSetting)
                .count(),
            2
        );
        assert_eq!(
            checked
                .notices
                .iter()
                .filter(|notice| notice.kind == ServerConfigNoticeKind::MapRotation)
                .count(),
            3
        );
        assert_eq!(
            checked
                .notices
                .iter()
                .filter(|notice| notice.kind == ServerConfigNoticeKind::UnsupportedCommand)
                .count(),
            1
        );
        assert_eq!(
            compile_for_host(&doc, doc.game, Some("makermod")).unwrap(),
            [
                "set g_forcepowerdisable \"0\"",
                "mremap clear",
                "mremap textures/quicktrip/desert_0 textures/h_Evil/evil_rock13",
                "mweather clear",
                "mweather fog",
                "mweather wind",
                "mremap console clear",
                "mremap models/players/jawa/jawa textures/rift/env_crystal",
            ]
        );
    }

    #[test]
    fn rotation_map_is_inferred_only_from_an_invoked_safe_two_command_step() {
        for text in [
            "set map1 \"devmap t2_trip;set nextmap vstr map1\"",
            "set map1 \"quit;devmap t2_trip;set nextmap vstr map1\"\nvstr map1",
            "set map1 \"devmap ../escape;set nextmap vstr map1\"\nvstr map1",
            "set map1 \"devmap t2_trip;exec hidden.cfg;set nextmap vstr map1\"\nvstr map1",
            "set map1 \"devmap t2_trip;set nextmap quit\"\nvstr map1",
            "set map1 \"devmap t2_trip;set nextmap vstr map1\"\nvstr another",
        ] {
            let checked = server_config_check(document(text)).unwrap();
            assert_eq!(checked.settings.map, None, "{text}");
            assert!(
                compile_for_host(&document(text), Game::JediAcademy, None)
                    .unwrap()
                    .iter()
                    .all(|command| !command.contains("t2_trip")),
                "{text}"
            );
        }

        let text = "set map1 \"map mp/ffa3;set nextmap vstr map1\"\nvstr map1";
        let checked = server_config_check(document(text)).unwrap();
        assert_eq!(checked.settings.map.as_deref(), Some("mp/ffa3"));
        assert!(compile_for_host(&document(text), Game::JediAcademy, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn makermod_map_commands_are_mod_specific_and_reject_command_injection() {
        let base = document("mremap source target;mweather fog");
        let checked = server_config_check(base.clone()).unwrap();
        assert!(checked.issues.is_empty());
        assert_eq!(checked.notices.len(), 2);
        assert!(compile_for_host(&base, base.game, None).unwrap().is_empty());

        for text in [
            "mremap source",
            "mremap ../source target",
            "mremap list",
            "mweather unknown",
            "mweather fog bad*value",
        ] {
            let mut doc = document(text);
            doc.mod_id = "makermod".into();
            assert!(
                !server_config_check(doc.clone()).unwrap().issues.is_empty(),
                "{text}"
            );
            assert!(
                compile_for_host(&doc, doc.game, Some("makermod")).is_err(),
                "{text}"
            );
        }

        let mut clear = document("mremap clear;mweather clear");
        clear.mod_id = "makermod".into();
        assert_eq!(
            compile_for_host(&clear, clear.game, Some("makermod")).unwrap(),
            ["mremap clear", "mweather clear"]
        );
    }

    #[test]
    fn mod_and_game_must_match_the_actual_client_folder() {
        for (id, folder) in [
            ("base", "base"),
            ("japlus", "japlus"),
            ("japro", "japro"),
            ("mbii", "MBII"),
            ("lugormod", "lugormod"),
            ("makermod", "makermod"),
        ] {
            let mut doc = document("set g_gravity 600");
            doc.mod_id = id.into();
            assert!(compile_for_host(&doc, doc.game, Some(&folder.to_ascii_uppercase())).is_ok());
            assert!(compile_for_host(&doc, doc.game, Some("unrelated")).is_err());
            assert!(compile_for_host(&doc, Game::JediOutcast, Some(folder)).is_err());
            doc.game = Game::JediOutcast;
            assert_eq!(validate_document(&doc).is_ok(), id == "base");
        }
    }

    #[test]
    fn mbii_rounds_use_fraglimit_and_do_not_accept_base_game_modes() {
        for mode in [3, 4, 7] {
            let mut doc = document(&format!(
                "set g_gametype {mode}\nset fraglimit 12\nset duel_fraglimit 5"
            ));
            doc.mod_id = "mbii".into();
            let checked = server_config_check(doc).unwrap();
            assert!(checked.issues.is_empty());
            assert_eq!(checked.settings.score_limit, Some(12));
        }
        let mut doc = document("set g_gametype 0");
        doc.mod_id = "mbii".into();
        assert!(!server_config_check(doc.clone()).unwrap().issues.is_empty());
        doc.text = "set g_gametype 7; set bot_minplayers 1".into();
        assert!(!server_config_check(doc).unwrap().issues.is_empty());
    }

    #[test]
    fn quote_and_comment_tricks_cannot_execute_managed_cvars() {
        for text in [
            "set/*comment*/dedicated 2",
            "\"set\" \"dedicated\" 2",
            "SET\tDeDiCaTeD\t2",
            "set g_gravity 600\rset dedicated 2",
            "set g_gravity 600 /*\n*/;set dedicated 2",
        ] {
            let doc = document(text);
            let checked = server_config_check(doc.clone()).unwrap();
            assert!(checked.issues.is_empty(), "{text}: {:?}", checked.issues);
            assert!(
                checked
                    .notices
                    .iter()
                    .any(|notice| notice.name.eq_ignore_ascii_case("dedicated")),
                "{text}: {:?}",
                checked.notices
            );
            assert!(
                compile_for_host(&doc, doc.game, None)
                    .unwrap()
                    .iter()
                    .all(|command| !command.to_ascii_lowercase().contains("dedicated")),
                "{text}"
            );
        }
        let quoted = document("set g_gravity \"600\\\"; quit");
        let checked = server_config_check(quoted.clone()).unwrap();
        assert!(checked.issues.is_empty());
        assert!(checked
            .notices
            .iter()
            .any(|notice| notice.name.eq_ignore_ascii_case("quit")));
        assert!(compile_for_host(&quoted, quoted.game, None)
            .unwrap()
            .iter()
            .all(|command| !command.to_ascii_lowercase().contains("quit")));
        assert!(
            compile_for_host(&document(&"g_x 1;".repeat(10000)), Game::JediAcademy, None).is_err()
        );
    }

    #[test]
    fn sparse_documents_use_host_defaults_instead_of_previous_selection_values() {
        let a = server_config_check(document(
            "g_gametype 3; sv_maxclients 4; bot_minplayers 3; duel_fraglimit 5; timelimit 12",
        ))
        .unwrap();
        assert_eq!(a.settings.max_players, Some(4));
        let b = server_config_check(document("set g_gravity 400")).unwrap();
        assert_eq!(b.settings.gametype, Some(0));
        assert_eq!(b.settings.max_players, Some(8));
        assert_eq!(b.settings.bots, Some(0));
        assert_eq!(b.settings.time_limit, Some(0));
        assert_eq!(b.settings.score_limit, Some(20));
        let mut mbii = document("");
        mbii.mod_id = "mbii".into();
        let checked = server_config_check(mbii).unwrap();
        assert_eq!(checked.settings.gametype, Some(7));
        assert_eq!(checked.settings.score_limit, Some(20));
        assert!(
            !server_config_check(document("sv_maxclients 2; bot_minplayers 3"))
                .unwrap()
                .issues
                .is_empty()
        );
    }

    #[test]
    fn imported_archive_and_info_flags_do_not_modify_session_persistence() {
        let doc = document("seta g_gravity 400; sets custom_value data; setu custom_other value");
        let commands = compile_for_host(&doc, doc.game, None).unwrap();
        assert_eq!(
            commands,
            [
                "set g_gravity \"400\"",
                "set custom_value \"data\"",
                "set custom_other \"value\""
            ]
        );
        assert!(doc.text.starts_with("seta"));
    }
}
