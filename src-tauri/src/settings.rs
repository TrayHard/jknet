//! Launcher settings: one JSON document in the config root.
//!
//! `update_settings` takes a patch, not a whole document. The frontend keeps
//! the settings in a React Query cache, and sending that copy back would
//! overwrite every field another writer changed in the meantime — including
//! the player editing `settings.json` in a text editor while the launcher is
//! open. Only the fields a patch carries are touched.

use std::collections::BTreeMap;
use std::fs;

use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};
use crate::game::Game;
use crate::online::{self, OnlineUser};
use crate::paths;
use crate::state::AppState;

// --- slice: jkhub index startup ---
/// Emitted when a patch moved `activeGame`, and only then.
///
/// The switch in the sidebar is the one setting other modules have background
/// work hanging off: `jkhub::prewarm` uses it to build the catalogue index of
/// the game the player just moved to. Emitted rather than called so this
/// module keeps knowing nothing about the ones that care, the way
/// `account:changed` already works for `friends`.
pub const ACTIVE_GAME_EVENT: &str = "settings:active-game";

/// Payload of [`ACTIVE_GAME_EVENT`]: the game the launcher is now set to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveGameChanged {
    pub game: Game,
}

// --- slice: clients page ---
/// Emitted when the default client of a game changed, and only then.
///
/// Two windows show the same fact: the **DEFAULT** badge on a card of the
/// Clients screen, and the **Make default client** switch in the window of
/// that client. Each window has its own React Query cache and neither refetches
/// on focus, so without this the badge would keep saying what it said before
/// the switch was pressed in the other window. `clients:changed` already does
/// the same job for the record itself; the default lives in the settings
/// document, which that event says nothing about.
pub const DEFAULT_CLIENTS_EVENT: &str = "settings:default-clients";

/// Payload of [`DEFAULT_CLIENTS_EVENT`]: the map as it now stands.
///
/// The whole map rather than the one game that moved: a listener invalidates
/// the settings either way, and a payload that can answer «which client is the
/// default one of Jedi Outcast» without a round trip costs two strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultClientsChanged {
    pub default_client_ids: BTreeMap<Game, String>,
}

/// Announces the default clients of the document as it landed on disk.
///
/// Called by [`update_settings`] and by `clients::delete_client`, which takes
/// a deleted client off the position without going through a patch.
pub fn emit_default_clients(app: &AppHandle, settings: &Settings) {
    let payload = DefaultClientsChanged {
        default_client_ids: settings.default_client_ids.clone(),
    };
    if let Err(e) = app.emit(DEFAULT_CLIENTS_EVENT, payload) {
        log::warn!("cannot emit {DEFAULT_CLIENTS_EVENT}: {e}");
    }
}

// --- slice: i18n ---
/// The value of `language` that means «follow the operating system».
pub const SYSTEM_LANGUAGE: &str = "system";

// --- slice: i18n ---
/// The languages the launcher ships a catalog for.
///
/// The same list as `LANGUAGES` in `src/i18n/languages.ts` and the same list as
/// the folders under `src/locales/`. It lives here only to refuse a value the
/// frontend could not load; the catalogs themselves are the frontend's.
pub const LANGUAGES: &[&str] = &["en", "ru", "uk", "de", "fr", "es", "pl", "hu"];

/// Whether a string may be stored in `language`.
pub fn is_language_setting(value: &str) -> bool {
    value == SYSTEM_LANGUAGE || LANGUAGES.contains(&value)
}

// --- slice: pk3 editor ---
/// The two modes of the Library preview: `simple` shows the finished objects
/// of an archive, `advanced` adds every other file of it by kind.
pub const PREVIEW_MODES: &[&str] = &["simple", "advanced"];

/// The mode a fresh launcher, and a `settings.json` written before the
/// modes existed, opens the preview in.
pub const DEFAULT_PREVIEW_MODE: &str = "simple";

/// Whether a string may be stored in `preview_mode`.
pub fn is_preview_mode(value: &str) -> bool {
    PREVIEW_MODES.contains(&value)
}

fn default_preview_mode() -> String {
    DEFAULT_PREVIEW_MODE.to_string()
}

/// Everything the launcher remembers between runs, except window geometry
/// (that belongs to `tauri-plugin-window-state`).
///
/// `Default` is written out rather than derived, because one field has a value
/// that is not the zero of its type in a debug build: `online_url` names the service
/// of the build profile, and the container-level `#[serde(default)]` fills a
/// missing field from this implementation. Older settings therefore select the
/// local development service or the public production service by build profile;
/// see `online::default_online_url`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    // --- slice: game core ---
    /// The `GameData` folder of each game, confirmed by the user. A game with
    /// no entry has not been set up; an empty map means the first run has not
    /// finished yet.
    ///
    /// Replaces the single `gameDataPath` of the versions before 0.3, which is
    /// still read once and filed under `ja` — see [`Settings::migrate`].
    pub game_data_paths: BTreeMap<Game, String>,
    /// The game every screen works in until the player switches. The switcher
    /// itself arrives in the next slice; this field is what it will write.
    pub active_game: Game,

    // --- slice: i18n ---
    /// The language of the interface: `system`, or one of [`LANGUAGES`].
    ///
    /// A plain string rather than an enum on purpose. The catalogs live on the
    /// frontend, and a build that grows a ninth language should not need a
    /// migration of `settings.json` to store it. The value is validated where
    /// it is written — see [`SettingsPatch::validate`] — so the document can
    /// only ever hold a name the launcher knows.
    ///
    /// `system` means «ask the operating system», which is what a fresh
    /// install does: `src/i18n/index.ts` reads the locale and maps its primary
    /// subtag onto a catalog, falling back to English.
    pub language: String,
    /// Read out of a `settings.json` written before 0.3 and then dropped. The
    /// value lands in `game_data_paths` under `ja`; nothing else reads it, and
    /// `skip_serializing` is what takes the key out of the file on the first
    /// write.
    ///
    /// `pub(crate)` and not private only so that a `..Settings::default()` in
    /// another module's tests still compiles; nothing outside this file reads
    /// it.
    #[serde(rename = "gameDataPath", skip_serializing)]
    pub(crate) legacy_game_data_path: Option<String>,

    /// Client started by the Play button. `None` disables the button.
    ///
    /// Still one client rather than one per game: the Play button is not
    /// scoped yet. The switcher slice makes `default_client_ids` the source of
    /// truth and leaves this field as the value for the active game.
    pub default_client_id: Option<String>,
    // --- slice: game core ---
    /// The default client of each game. Written now so the switcher slice
    /// needs no second migration; seeded from `default_client_id` under `ja`.
    pub default_client_ids: BTreeMap<Game, String>,
    /// Hide the launcher window while the game is running.
    pub close_on_launch: bool,
    /// Once dismissed, the library conflict notice only opens on explicit request.
    pub library_conflict_notice_dismissed: bool,
    // --- slice: pk3 editor ---
    /// The mode the Library preview opens in: one of [`PREVIEW_MODES`]. A
    /// plain string for the same reason `language` is one, validated where
    /// it is written by [`SettingsPatch::validate`]. The field-level default
    /// reads a document from before the modes existed as `simple`.
    #[serde(default = "default_preview_mode")]
    pub preview_mode: String,
    /// Absolute path that replaces the config root for `clients`, `library`,
    /// `cache` and `logs`. Ignored when it is relative or blank.
    pub data_dir_override: Option<String>,

    // --- slice: launch ---
    /// Extra tokens appended to every command line, exactly as a player would
    /// type them in a shortcut: `+set r_mode -1 +set cl_renderer rd-rend2`.
    /// Split on whitespace with double-quoted groups kept whole.
    pub extra_launch_args: String,

    // --- slice: servers ---
    /// Servers starred in the browser, as `ip:port`. The star belongs to the
    /// player and not to the server list, so it survives every refresh and
    /// every cache wipe.
    pub favorite_servers: Vec<String>,
    /// Servers the player connected to, newest first, capped at 50 entries by
    /// `add_server_history`.
    pub server_history: Vec<ServerHistoryEntry>,
    // --- slice: server actions ---
    /// Servers the player took off the browser, as `ip:port`.
    ///
    /// The opposite end of `favorite_servers` and stored the same way: a list
    /// of addresses that belongs to the player, not to the server list, so it
    /// survives every refresh and every cache wipe. A hidden row is still
    /// scanned and still written to the cache — the launcher has no way to ask
    /// a master server for «everything but these» — and it is the screen that
    /// leaves it out of every tab but **Hidden**.
    ///
    /// A `settings.json` written before this field existed reads as an empty
    /// list through the container's own `#[serde(default)]`.
    pub hidden_servers: Vec<String>,
    // --- slice: servers browser ---
    /// The filter row of the Servers screen, as the player left it.
    pub server_filters: ServerFilters,

    // --- slice: player profiles ---
    /// Nicknames the player saved, newest first.
    ///
    /// One list for the whole launcher rather than one per client: a nickname
    /// is who the player is, and a player who made it up once should find it in
    /// every profile of every client. The profiles themselves belong to a
    /// client and live in `clients\<slug>\profiles.json`.
    ///
    /// Written whole by a patch, like `favorite_servers` above: the field is
    /// small, the writer is one form, and merging two lists of free text has no
    /// rule worth inventing.
    pub saved_nicknames: Vec<String>,

    // --- slice: onboarding ---
    /// Whether the player has been through the three first-run steps. False by
    /// default, which is also what a settings file written before this field
    /// existed deserializes to: a launcher that cannot prove the player has
    /// seen the guided setup shows it, and the steps are derived from what is
    /// already configured, so nobody repeats work they have done.
    pub onboarding_completed: bool,

    // --- slice: account ---
    /// JKNet Online, without a trailing slash.
    ///
    /// An empty saved value resolves to the build's default service. The field
    /// is editable on the Settings screen for testing or self-hosting.
    ///
    /// The alias reads a `settings.json` from 0.2.0, where the service was
    /// called JKNet Hub and the three keys below it were `hubUrl`, `hubToken`
    /// and `hubUser`. Reading only: the first write puts the file on the new
    /// names, so the alias costs one line and keeps an installed launcher's
    /// address and session through the update. `SettingsPatch` has no such
    /// alias, because nothing but this launcher writes a patch.
    #[serde(alias = "hubUrl")]
    pub online_url: String,
    /// The bearer token of the signed-in account, 64 hex characters.
    ///
    /// This is the one secret the launcher stores. It never reaches the
    /// webview: `get_settings` and every other command that answers with a
    /// whole document call [`Settings::redacted`] first.
    #[serde(alias = "hubToken")]
    pub online_token: Option<String>,
    /// The account the token belongs to, as the service last described it. Cached
    /// so the sidebar can print a name before any request answers.
    #[serde(alias = "hubUser")]
    pub online_user: Option<OnlineUser>,

    // --- slice: play with friends ---
    /// The last settings of the **Play with friends** screen, one entry per
    /// game, without the password. `host_start` writes the entry of its
    /// game; a patch may write one too.
    pub host_defaults: BTreeMap<Game, HostDefaults>,
    /// True once a private server was started in a mode with the local
    /// network: the note about the Windows firewall has been seen by then.
    pub host_firewall_note_seen: bool,

    // --- slice: chat ---
    /// Whether the chat drawer of the main window is docked beside the page
    /// (**Pin**) rather than laid over its right edge. Whether the drawer is
    /// open is not kept: every launch starts with it closed.
    pub chat_drawer_pinned: bool,
    // --- slice: chat window ---
    /// Where a click on a chat notification and **Open chats** of the tray
    /// show a conversation: `main`, the chat drawer of the launcher window,
    /// or `window`, the separate chat window. One of [`CHAT_OPEN_IN`]; a
    /// value a newer launcher wrote reads as `main`.
    pub chat_open_in: String,
    /// The separate chat window as the player left it. Written by the core
    /// alone (`chat::window`): [`SettingsPatch::apply`] drops it, and the
    /// window's own commands change it.
    pub chat_window: ChatWindowSettings,
}

// --- slice: chat window ---
/// The places a chat can open in, the values of `chatOpenIn`.
pub const CHAT_OPEN_IN: &[&str] = &[CHAT_OPEN_IN_MAIN, CHAT_OPEN_IN_WINDOW];
/// The chat drawer of the launcher window, the default.
pub const CHAT_OPEN_IN_MAIN: &str = "main";
/// The separate chat window.
pub const CHAT_OPEN_IN_WINDOW: &str = "window";

/// The separate chat window between runs: its mode, where each mode was
/// last, whether each mode stays on top, and how opaque the compact mode is.
///
/// Two sets of bounds because the modes are two windows to the player: a
/// wide one with the list beside the thread, and a narrow one over the game.
/// Switching back puts each where it was. Bounds are physical pixels, the
/// unit the window reports them in, like `tauri-plugin-window-state` keeps
/// them for `main`; that plugin leaves this window alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatWindowSettings {
    /// Whether the window opens in its compact mode.
    pub compact: bool,
    /// Always on top in the full mode. Off by default.
    pub always_on_top: bool,
    /// Always on top in the compact mode, which exists to sit over a game.
    /// On by default.
    pub compact_always_on_top: bool,
    /// Opacity of the compact mode in percent, 40 to 100. The full mode is
    /// always opaque.
    pub compact_opacity: u8,
    /// Where the full mode was last, or `None` before it was ever moved.
    pub bounds: Option<WindowBounds>,
    /// Where the compact mode was last, or `None` before it was ever used.
    pub compact_bounds: Option<WindowBounds>,
}

impl Default for ChatWindowSettings {
    /// Written out rather than derived: the compact mode starts on top and
    /// slightly see-through, the way the chat window over a game was drawn.
    fn default() -> Self {
        ChatWindowSettings {
            compact: false,
            always_on_top: false,
            compact_always_on_top: true,
            compact_opacity: DEFAULT_CHAT_WINDOW_OPACITY,
            bounds: None,
            compact_bounds: None,
        }
    }
}

/// Opacity of the compact chat window until the player moves the slider.
pub const DEFAULT_CHAT_WINDOW_OPACITY: u8 = 90;

/// A window's outer position and inner size, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

// --- slice: play with friends ---
/// The settings of the **Play with friends** screen for one game.
///
/// The two modes are strings, like `language`: a value a newer launcher wrote
/// must not make the whole document unreadable to an older one. The hosting
/// module reads them back and falls back to its defaults for anything it does
/// not know.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HostDefaults {
    pub client_id: Option<String>,
    pub map: Option<String>,
    pub gametype: u8,
    pub max_players: u8,
    pub time_limit: u16,
    pub score_limit: u16,
    pub bots: u8,
    pub server_name: Option<String>,
    /// Whether the last server asked for a password. The password itself is
    /// never written here: every start gets a fresh one.
    pub use_password: bool,
    /// `internet_lan`, `lan` or `internet`.
    pub network: String,
    /// `friends`, `selected` or `invite`.
    pub join_policy: String,
    pub join_user_ids: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            game_data_paths: BTreeMap::new(),
            active_game: Game::default(),
            // --- slice: i18n ---
            language: SYSTEM_LANGUAGE.to_string(),
            legacy_game_data_path: None,
            default_client_id: None,
            default_client_ids: BTreeMap::new(),
            close_on_launch: false,
            library_conflict_notice_dismissed: false,
            // --- slice: pk3 editor ---
            preview_mode: default_preview_mode(),
            data_dir_override: None,
            extra_launch_args: String::new(),
            favorite_servers: Vec::new(),
            server_history: Vec::new(),
            // --- slice: server actions ---
            hidden_servers: Vec::new(),
            server_filters: ServerFilters::default(),
            // --- slice: player profiles ---
            saved_nicknames: Vec::new(),
            onboarding_completed: false,
            online_url: online::default_online_url().to_string(),
            online_token: None,
            online_user: None,
            // --- slice: play with friends ---
            host_defaults: BTreeMap::new(),
            host_firewall_note_seen: false,
            // --- slice: chat ---
            chat_drawer_pinned: false,
            // --- slice: chat window ---
            chat_open_in: CHAT_OPEN_IN_MAIN.to_string(),
            chat_window: ChatWindowSettings::default(),
        }
    }
}

/// One line of `server_history`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerHistoryEntry {
    /// `ip:port` of the server, the same key the browser uses.
    pub address: String,
    /// When Connect was last pressed, RFC 3339 in UTC.
    pub last_connected: String,
    // --- slice: server actions ---
    /// The client the player reached this server with, or `None`.
    ///
    /// What makes **Connect** a one-press button: a player who joins a
    /// modded server with the client that carries the mod's files expects the
    /// same client next time, and the default client of the game is a guess
    /// that is wrong exactly where it matters. `None` on every entry written
    /// before this field existed, and on one written by a caller that does not
    /// know the client; the reader falls back to the default client then.
    ///
    /// The id is not checked against the client list here: a client may be
    /// deleted or renamed long after the connection, and the screen already
    /// has to handle an id that names nothing.
    #[serde(default)]
    pub client_id: Option<String>,
}

// --- slice: servers browser ---
/// The filter row of the Servers screen, kept between runs.
///
/// Dropdowns and switches only. The search box is deliberately not here: a
/// browser that opens on yesterday's search word looks like a browser that lost
/// half the servers. Neither is the open tab, for the same reason — the screen
/// opens on **All**, which is what the player asked for last time they meant to
/// look at a list of servers.
///
/// The core stores the values and does not judge them. A `gametype` no server
/// on the list publishes simply matches nothing, and **Reset filters** is one
/// click away; refusing it here would only move a harmless state into an error
/// message. The single exception is the container-level `#[serde(default)]`,
/// which is what lets a `settings.json` written before this field existed read
/// as the defaults rather than as a filter row of empty strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerFilters {
    /// `gametype` as text, or `any`.
    pub gametype: String,
    /// `fs_game` folder of the server, or `any`.
    pub mod_name: String,
    /// `any`, `not-empty` or `not-full`.
    pub players: String,
    /// Network protocol as text, or `any`.
    pub protocol: String,
    /// Drop the servers where every client is a bot.
    pub hide_bot_only: bool,
    /// Drop the servers that ask for a password.
    pub hide_passworded: bool,
}

impl Default for ServerFilters {
    /// The row the screen opens in, and what **Reset filters** returns to.
    ///
    /// Written out rather than derived: `any` is not the zero of a `String`,
    /// and `hide_bot_only` starts on — a list where two thirds of the
    /// "players" are bots is a list nobody can read. Passworded servers stay
    /// on the list by default: a password is a door the player may have a key
    /// to, unlike a lobby of bots.
    fn default() -> Self {
        ServerFilters {
            gametype: ANY_FILTER.to_string(),
            mod_name: ANY_FILTER.to_string(),
            players: ANY_FILTER.to_string(),
            protocol: ANY_FILTER.to_string(),
            hide_bot_only: true,
            hide_passworded: false,
        }
    }
}

// --- slice: servers browser ---
/// What a filter holds when it narrows nothing. The same word the dropdowns of
/// the screen use as their value.
const ANY_FILTER: &str = "any";

impl Settings {
    /// Reads `settings.json`. A missing file yields the defaults; a corrupted
    /// file is an error, so the launcher never silently drops a player's
    /// configuration.
    pub fn load(state: &AppState) -> Result<Settings> {
        let file = paths::settings_file(&state.config_root);
        match fs::read_to_string(&file) {
            Ok(text) => {
                let mut settings: Settings = serde_json::from_str(&text)
                    .map_err(|e| AppError::json(format!("cannot parse {}", file.display()), e))?;
                // --- slice: game core ---
                // Every field of the one-game era moves to its `ja` entry
                // here, before anything reads the document. The write that
                // makes it permanent is the next `update_settings`; until then
                // the move simply happens again, which costs nothing and is
                // what keeps a read-only run of the launcher harmless.
                settings.migrate();
                Ok(settings)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(AppError::io_path("cannot read", &file, e)),
        }
    }

    // --- slice: game core ---
    /// Moves the fields of the one-game era into their per-game homes.
    ///
    /// Returns whether anything moved, which is what a caller writing the file
    /// straight away would branch on. Idempotent: a per-game entry that
    /// already exists is never overwritten, so a player who set a Jedi Academy
    /// folder after the upgrade keeps it even if the old key is still in the
    /// file.
    fn migrate(&mut self) -> bool {
        let mut moved = false;

        if let Some(legacy) = self.legacy_game_data_path.take() {
            let legacy = legacy.trim().to_string();
            if !legacy.is_empty() && !self.game_data_paths.contains_key(&Game::JediAcademy) {
                self.game_data_paths.insert(Game::JediAcademy, legacy);
                moved = true;
            }
        }

        if let Some(id) = self.default_client_id.clone() {
            if !id.trim().is_empty() && !self.default_client_ids.contains_key(&Game::JediAcademy) {
                self.default_client_ids.insert(Game::JediAcademy, id);
                moved = true;
            }
        }

        moved
    }

    /// The `GameData` folder of one game, or `None` when it is not set up.
    pub fn game_data_path(&self, game: Game) -> Option<&str> {
        self.game_data_paths
            .get(&game)
            .map(String::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
    }

    /// The `GameData` folder of one game, or the error naming what to do.
    pub fn require_game_data_path(&self, game: Game) -> Result<&str> {
        self.game_data_path(game).ok_or_else(|| AppError::GameDataMissing {
            game: game.display_name(),
            reason: "the folder is not set. Pick it on the Settings screen first.".into(),
        })
    }

    /// The game a command works in when the caller named none.
    pub fn game_or_active(&self, game: Option<Game>) -> Game {
        game.unwrap_or(self.active_game)
    }

    /// The document a write has to land on.
    ///
    /// The file wins over the copy in memory: it is the one another editor may
    /// have changed. An unreadable file falls back to memory with a warning,
    /// because one broken character must not block every setting the player
    /// touches afterwards.
    pub fn current(state: &AppState) -> Result<Settings> {
        match Settings::load(state) {
            Ok(settings) => Ok(settings),
            Err(e) => {
                log::warn!("{e}; the change lands on the settings held in memory");
                state.settings()
            }
        }
    }

    // --- slice: account ---
    /// The document as the frontend may see it: without the service token.
    ///
    /// Every command that answers with a whole `Settings` ends in this call.
    /// The frontend has no use for the token — the core puts it on the
    /// requests — and a secret that never crosses the IPC boundary cannot be
    /// read out of a React Query cache by anything that gets into the webview.
    pub fn redacted(mut self) -> Settings {
        self.online_token = None;
        self
    }

    /// Writes `settings.json`, creating the config root when needed.
    pub fn save(&self, state: &AppState) -> Result<()> {
        paths::create_dir(&state.config_root)?;
        let file = paths::settings_file(&state.config_root);
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::json("cannot serialize settings", e))?;
        fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
    }
}

/// A partial update of [`Settings`]: every field is optional.
///
/// A field the caller leaves out keeps whatever the document holds. The four
/// nullable fields carry two layers of `Option`: the outer one says whether
/// the caller sent the field at all, the inner one carries the `null` that
/// clears it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    // --- slice: game core ---
    /// Per-game folders, merged into the document one game at a time. A game
    /// the map does not mention keeps its folder; a game mapped to `null` or
    /// to a blank string loses it. Sending the whole map is therefore *not* a
    /// way to clear the other game, which is the same promise the top-level
    /// fields make.
    pub game_data_paths: Option<BTreeMap<Game, Option<String>>>,
    /// The game every screen works in.
    pub active_game: Option<Game>,
    // --- slice: i18n ---
    /// The language of the interface: `system` or one of [`LANGUAGES`].
    /// [`SettingsPatch::validate`] refuses anything else.
    pub language: Option<String>,
    /// The one-game field, still accepted: it writes the `ja` entry of
    /// `game_data_paths`. Kept so a caller that has not been updated yet — the
    /// onboarding of an older frontend, a hand-edited call — lands somewhere
    /// sensible instead of being refused by `deny_unknown_fields`.
    #[serde(deserialize_with = "sent")]
    pub game_data_path: Option<Option<String>>,

    #[serde(deserialize_with = "sent")]
    pub default_client_id: Option<Option<String>>,
    // --- slice: game core ---
    /// Per-game default clients, merged the same way as the folders above.
    pub default_client_ids: Option<BTreeMap<Game, Option<String>>>,
    pub close_on_launch: Option<bool>,
    pub library_conflict_notice_dismissed: Option<bool>,
    // --- slice: pk3 editor ---
    /// The mode of the Library preview: `simple` or `advanced`.
    /// [`SettingsPatch::validate`] refuses anything else.
    pub preview_mode: Option<String>,
    #[serde(deserialize_with = "sent")]
    pub data_dir_override: Option<Option<String>>,
    pub extra_launch_args: Option<String>,
    pub favorite_servers: Option<Vec<String>>,
    pub server_history: Option<Vec<ServerHistoryEntry>>,
    // --- slice: server actions ---
    /// The whole list of hidden addresses, replaced in one go, the same shape
    /// as `favorite_servers` above. `set_server_hidden` is the command that
    /// edits one address; this field is what a caller with the whole list uses.
    pub hidden_servers: Option<Vec<String>>,
    // --- slice: servers browser ---
    /// The whole filter row, replaced in one go. The screen edits one control
    /// at a time but sends the row it now shows, so a patch is never a partial
    /// row and a missing key cannot read as `any`.
    pub server_filters: Option<ServerFilters>,

    // --- slice: player profiles ---
    /// The saved nicknames, replaced in one go. Trimmed, deduplicated without
    /// regard to case and capped by [`SettingsPatch::apply`], so a form that
    /// simply prepends a name cannot grow the list without end.
    pub saved_nicknames: Option<Vec<String>>,

    // --- slice: onboarding ---
    pub onboarding_completed: Option<bool>,

    // --- slice: account ---
    pub online_url: Option<String>,
    /// Read and thrown away. See [`SettingsPatch::apply`].
    #[serde(deserialize_with = "sent")]
    pub online_token: Option<Option<String>>,
    /// Read and thrown away, for the same reason as the token above.
    #[serde(deserialize_with = "sent")]
    pub online_user: Option<Option<OnlineUser>>,

    // --- slice: play with friends ---
    /// The settings of the host screen, merged one game at a time like the
    /// folders above: a game mapped to `null` loses its entry.
    pub host_defaults: Option<BTreeMap<Game, Option<HostDefaults>>>,
    pub host_firewall_note_seen: Option<bool>,

    // --- slice: chat ---
    pub chat_drawer_pinned: Option<bool>,
    // --- slice: chat window ---
    /// `main` or `window`; [`SettingsPatch::validate`] refuses anything else.
    pub chat_open_in: Option<String>,
    /// Read and thrown away, like the token: the chat window's bounds come
    /// from the window and its switches from its own commands, and a stale
    /// copy from a whole document must not move it. Declared so such a
    /// document is still accepted.
    pub chat_window: Option<ChatWindowSettings>,
}

/// Reads a field and remembers that it was there, `null` included.
///
/// Serde turns a JSON `null` into the same `None` an absent key produces. One
/// more `Some` around the result keeps the two apart, so a patch can clear a
/// field on purpose instead of only ever setting one.
fn sent<'de, T, D>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl SettingsPatch {
    /// Copies the fields the caller sent onto `settings`.
    ///
    /// A blank string in a path or an id counts as no value: an empty
    /// `gameDataPath` is not a folder, and storing one would make the Clients
    /// screen show a path of nothing.
    ///
    /// Two fields are deliberately not copied. `onlineToken` and `onlineUser` belong
    /// to the sign-in and are written by `crate::account` alone; a patch
    /// carrying them is read and dropped. The command behind this is
    /// `update_settings`, which anything running in the webview can call, and a
    /// token settable from there would be a way around `begin_sign_in` and
    /// `poll_sign_in` — the launcher would talk to the service as whoever a
    /// crafted `invoke` says. The fields stay declared so that a caller who
    /// sends a whole settings document still gets it accepted rather than
    /// refused by `deny_unknown_fields`.
    ///
    /// --- slice: chat window ---
    /// `chatWindow` is dropped the same way: the core writes it from the
    /// chat window itself.
    pub fn apply(self, settings: &mut Settings) {
        // --- slice: game core ---
        if let Some(value) = self.active_game {
            settings.active_game = value;
        }
        // --- slice: i18n ---
        if let Some(value) = self.language {
            settings.language = value;
        }
        // The one-game field lands on the Jedi Academy entry, before the map,
        // so a patch carrying both means what the map says. The map is the
        // form of 0.3 and the only one the launcher itself sends; the 0.2
        // field is kept for a caller that still speaks the old shape, and a
        // retired field does not get to overrule the current one.
        if let Some(value) = self.game_data_path {
            set_per_game(&mut settings.game_data_paths, Game::JediAcademy, value);
        }
        if let Some(entries) = self.game_data_paths {
            merge_per_game(&mut settings.game_data_paths, entries);
        }

        if let Some(value) = self.default_client_id {
            settings.default_client_id = non_empty(value);
        }
        // --- slice: game core ---
        if let Some(entries) = self.default_client_ids {
            merge_per_game(&mut settings.default_client_ids, entries);
        }
        if let Some(value) = self.close_on_launch {
            settings.close_on_launch = value;
        }
        if let Some(value) = self.library_conflict_notice_dismissed {
            settings.library_conflict_notice_dismissed = value;
        }
        // --- slice: pk3 editor ---
        if let Some(value) = self.preview_mode {
            settings.preview_mode = value;
        }
        if let Some(value) = self.data_dir_override {
            settings.data_dir_override = non_empty(value);
        }
        if let Some(value) = self.extra_launch_args {
            settings.extra_launch_args = value.trim().to_string();
        }
        if let Some(value) = self.favorite_servers {
            settings.favorite_servers = value;
        }
        if let Some(value) = self.server_history {
            settings.server_history = value;
        }
        // --- slice: server actions ---
        if let Some(value) = self.hidden_servers {
            settings.hidden_servers = value;
        }
        // --- slice: servers browser ---
        if let Some(value) = self.server_filters {
            settings.server_filters = value;
        }
        // --- slice: player profiles ---
        if let Some(value) = self.saved_nicknames {
            settings.saved_nicknames = clean_nicknames(value);
        }
        if let Some(value) = self.onboarding_completed {
            settings.onboarding_completed = value;
        }
        if let Some(value) = self.online_url {
            // A blank address means "back to the default", which is what the
            // Settings screen offers when the field is cleared. A `null` is
            // not a way to clear it: an address is always in force, and the
            // one the field falls back to is the default service.
            settings.online_url = online::normalize_online_url(&value);
        }
        // --- slice: play with friends ---
        if let Some(entries) = self.host_defaults {
            for (game, value) in entries {
                match value {
                    Some(defaults) => {
                        settings.host_defaults.insert(game, defaults);
                    }
                    None => {
                        settings.host_defaults.remove(&game);
                    }
                }
            }
        }
        if let Some(value) = self.host_firewall_note_seen {
            settings.host_firewall_note_seen = value;
        }
        // --- slice: chat ---
        if let Some(value) = self.chat_drawer_pinned {
            settings.chat_drawer_pinned = value;
        }
        // --- slice: chat window ---
        if let Some(value) = self.chat_open_in {
            settings.chat_open_in = value;
        }
    }

    // --- slice: account ---
    /// Refuses a patch the launcher would rather not write.
    ///
    /// Two fields need this. A service address without a scheme, or with one that
    /// is not HTTP, would be stored and then rejected by every later call with
    /// a message about the address rather than about the typo — so it is
    /// refused where the typo was made. A language the launcher has no catalog
    /// for would leave the interface in English with a setting that says
    /// otherwise, which is worse than a refusal.
    pub fn validate(&self) -> Result<()> {
        // --- slice: i18n ---
        if let Some(language) = self.language.as_deref() {
            if !is_language_setting(language) {
                return Err(AppError::InvalidInput(format!(
                    "{language:?} is not a language JKNet speaks"
                )));
            }
        }
        // --- slice: pk3 editor ---
        if let Some(mode) = self.preview_mode.as_deref() {
            if !is_preview_mode(mode) {
                return Err(AppError::InvalidInput(format!(
                    "{mode:?} is not a preview mode; the modes are {PREVIEW_MODES:?}"
                )));
            }
        }
        if let Some(url) = self.online_url.as_deref() {
            let url = url.trim();
            // Blank clears the field back to the default, so there is nothing
            // to check.
            if !url.is_empty() && !online::is_http_url(url) {
                return Err(AppError::InvalidInput(format!(
                    "the service address {url:?} has to start with http:// or https://"
                )));
            }
        }
        // --- slice: chat window ---
        if let Some(place) = self.chat_open_in.as_deref() {
            if !CHAT_OPEN_IN.contains(&place) {
                return Err(AppError::InvalidInput(format!(
                    "{place:?} is not a place chats open in; the places are {CHAT_OPEN_IN:?}"
                )));
            }
        }
        Ok(())
    }
}

/// Drops a value that is blank once trimmed.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

// --- slice: player profiles ---

/// Longest nickname the list stores, **in bytes of UTF-8**. `MAX_NETNAME` of
/// the engine: the server cuts a longer one before anybody reads it, and what
/// it counts is bytes, so a Cyrillic letter costs two. The same limit
/// [`crate::profiles`] holds a nickname to, for the same reason.
const MAX_NICKNAME_LEN: usize = 36;

/// Most nicknames the list holds. The form prepends, so the oldest one falls
/// off the end rather than the list growing for ever.
const MAX_NICKNAMES: usize = 50;

/// Trims, drops the blanks, keeps the first of each spelling and caps the
/// length.
///
/// Case is ignored when comparing, and the spelling that arrived first is the
/// one kept: a player who saves `Kyle` and then `kyle` meant one name, and the
/// list is theirs to read rather than a log of what they typed. Colour codes
/// make two names different, which is right — `^1Kyle` and `^2Kyle` are two
/// different things on a server.
fn clean_nicknames(values: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || value.len() > MAX_NICKNAME_LEN {
            continue;
        }
        let key = value.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        kept.push(value.to_string());
        if kept.len() == MAX_NICKNAMES {
            break;
        }
    }
    kept
}

// --- slice: game core ---
/// Writes one game's entry, or removes it when the value is `null` or blank.
fn set_per_game(map: &mut BTreeMap<Game, String>, game: Game, value: Option<String>) {
    match non_empty(value) {
        Some(text) => {
            map.insert(game, text.trim().to_string());
        }
        None => {
            map.remove(&game);
        }
    }
}

/// Copies the entries a patch carries onto a per-game map.
///
/// A merge and not a replacement: the frontend edits one game at a time, and a
/// patch that replaced the map wholesale would let the Settings screen wipe
/// the folder of the game it is not showing.
fn merge_per_game(map: &mut BTreeMap<Game, String>, entries: BTreeMap<Game, Option<String>>) {
    for (game, value) in entries {
        set_per_game(map, game, value);
    }
}

/// Returns the current settings, without the service token.
#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Result<Settings> {
    Ok(state.settings()?.redacted())
}

/// Applies a patch to the settings document and recreates the data folders,
/// which may have moved because `dataDirOverride` changed.
///
/// The answer is the whole document, so the frontend refreshes its cache from
/// what actually landed on disk rather than from what it sent.
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<Settings> {
    // --- slice: account --- refuses a service address that is not an HTTP URL.
    patch.validate()?;
    let mut settings = Settings::current(&state)?;
    let was = settings.active_game;
    // --- slice: clients page ---
    // Both fields, because a Jedi Academy client is written into the map and
    // into the 0.2 field at once, and a patch may carry either.
    let was_defaults = (
        settings.default_client_ids.clone(),
        settings.default_client_id.clone(),
    );
    patch.apply(&mut settings);
    settings.save(&state)?;
    state.set_settings(settings.clone())?;
    state.paths()?.ensure()?;
    log::info!("settings updated, data root is {}", state.paths()?.root.display());
    // --- slice: jkhub index startup ---
    // Only the switch, not every write: the settings document is also where
    // favourites and the server history land, and neither of those is worth
    // waking a background task for.
    if settings.active_game != was {
        let payload = ActiveGameChanged {
            game: settings.active_game,
        };
        if let Err(e) = app.emit(ACTIVE_GAME_EVENT, payload) {
            log::warn!("cannot emit {ACTIVE_GAME_EVENT}: {e}");
        }
    }
    // --- slice: clients page ---
    if (settings.default_client_ids.clone(), settings.default_client_id.clone())
        != was_defaults
    {
        emit_default_clients(&app, &settings);
    }
    Ok(settings.redacted())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A document with something in every field, so a wiped one is obvious.
    fn filled() -> Settings {
        Settings {
            game_data_paths: BTreeMap::from([
                (Game::JediAcademy, "D:\\SteamLibrary\\GameData".to_string()),
                (Game::JediOutcast, "D:\\SteamLibrary\\JK2\\GameData".to_string()),
            ]),
            active_game: Game::JediAcademy,
            // --- slice: i18n ---
            language: "ru".into(),
            legacy_game_data_path: None,
            default_client_id: Some("everyday".into()),
            default_client_ids: BTreeMap::from([
                (Game::JediAcademy, "everyday".to_string()),
            ]),
            close_on_launch: false,
            data_dir_override: Some("D:\\JKNet".into()),
            library_conflict_notice_dismissed: false,
            // --- slice: pk3 editor ---
            preview_mode: "advanced".into(),
            extra_launch_args: "+set r_fullscreen 0 +set r_mode 4".into(),
            favorite_servers: vec!["203.0.113.10:29070".into()],
            server_history: vec![ServerHistoryEntry {
                address: "203.0.113.10:29070".into(),
                last_connected: "2026-09-10T10:00:00Z".into(),
                // --- slice: server actions ---
                client_id: Some("everyday".into()),
            }],
            // --- slice: server actions ---
            hidden_servers: vec!["203.0.113.99:29070".into()],
            // --- slice: servers browser ---
            server_filters: ServerFilters {
                gametype: "3".into(),
                mod_name: "japlus".into(),
                players: "not-empty".into(),
                protocol: "26".into(),
                hide_bot_only: true,
                hide_passworded: true,
            },
            // --- slice: player profiles ---
            saved_nicknames: vec!["^1Kyle".into(), "Padawan".into()],
            onboarding_completed: true,
            online_url: "https://online.jknet.gg".into(),
            online_token: Some("0123456789abcdef".into()),
            online_user: Some(OnlineUser {
                id: "01JBX7Q2".into(),
                display_name: "Kyle Katarn".into(),
                avatar_url: None,
                provider: "jkhub".into(),
                provider_name: "kyle_k".into(),
                created_at: "2026-09-10T10:00:00Z".into(),
                admin: false,
            }),
            // --- slice: play with friends ---
            host_defaults: BTreeMap::from([(
                Game::JediAcademy,
                HostDefaults {
                    client_id: Some("everyday".into()),
                    map: Some("mp/ffa3".into()),
                    max_players: 8,
                    score_limit: 20,
                    use_password: true,
                    network: "internet_lan".into(),
                    join_policy: "friends".into(),
                    ..HostDefaults::default()
                },
            )]),
            host_firewall_note_seen: true,
            // --- slice: chat ---
            chat_drawer_pinned: true,
            // --- slice: chat window ---
            chat_open_in: CHAT_OPEN_IN_WINDOW.into(),
            chat_window: ChatWindowSettings {
                compact: true,
                always_on_top: true,
                compact_always_on_top: false,
                compact_opacity: 60,
                bounds: Some(WindowBounds {
                    x: 100,
                    y: 80,
                    width: 1200,
                    height: 800,
                }),
                compact_bounds: Some(WindowBounds {
                    x: -1500,
                    y: 20,
                    width: 360,
                    height: 520,
                }),
            },
        }
    }

    fn patch(json: &str) -> SettingsPatch {
        serde_json::from_str(json).expect("the patch parses")
    }

    // --- slice: chat window ---
    #[test]
    fn chats_open_in_the_launcher_until_the_player_picks_the_window() {
        let mut settings = Settings::default();
        assert_eq!(settings.chat_open_in, CHAT_OPEN_IN_MAIN);

        let to_window = patch(r#"{"chatOpenIn":"window"}"#);
        to_window.validate().expect("a known place");
        to_window.apply(&mut settings);
        assert_eq!(
            settings,
            Settings {
                chat_open_in: CHAT_OPEN_IN_WINDOW.into(),
                ..Settings::default()
            },
            "the place changes alone"
        );

        let error = patch(r#"{"chatOpenIn":"drawer"}"#)
            .validate()
            .expect_err("an unknown place is refused");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error:?}");

        // A document written before the field opens chats in the launcher.
        let older: Settings = serde_json::from_str("{}").expect("an empty document");
        assert_eq!(older.chat_open_in, CHAT_OPEN_IN_MAIN);
    }

    #[test]
    fn the_chat_window_is_not_a_field_a_patch_can_write() {
        // The core owns it: its bounds come from the window, its switches
        // from the window's own commands. A patch carrying it is accepted
        // and the field dropped, like the token.
        let mut settings = Settings::default();
        patch(r#"{"chatWindow":{"compact":true,"compactOpacity":40},"chatOpenIn":"window"}"#)
            .apply(&mut settings);
        assert_eq!(settings.chat_window, ChatWindowSettings::default());
        assert_eq!(settings.chat_open_in, CHAT_OPEN_IN_WINDOW, "the rest lands");
    }

    #[test]
    fn the_chat_window_reads_back_and_fills_what_an_older_document_lacks() {
        let defaults = ChatWindowSettings::default();
        assert!(!defaults.compact && !defaults.always_on_top);
        assert!(
            defaults.compact_always_on_top,
            "the compact mode sits over the game"
        );
        assert_eq!(defaults.compact_opacity, DEFAULT_CHAT_WINDOW_OPACITY);
        assert_eq!((defaults.bounds, defaults.compact_bounds), (None, None));

        let settings = filled();
        let text = serde_json::to_string(&settings).expect("serializes");
        assert!(text.contains(r#""chatWindow":{"compact":true,"alwaysOnTop":true,"compactAlwaysOnTop":false,"compactOpacity":60,"bounds":{"x":100,"y":80,"width":1200,"height":800}"#), "{text}");
        let back: Settings = serde_json::from_str(&text).expect("reads back");
        assert_eq!(back.chat_window, settings.chat_window);

        // A window saved before the opacity existed keeps its bounds and
        // gets the default for the rest.
        let partial: Settings = serde_json::from_str(
            r#"{"chatWindow":{"compact":true,"compactBounds":{"x":5,"y":6,"width":360,"height":520}}}"#,
        )
        .expect("a partial window");
        assert!(partial.chat_window.compact);
        assert_eq!(
            partial.chat_window.compact_bounds,
            Some(WindowBounds {
                x: 5,
                y: 6,
                width: 360,
                height: 520
            })
        );
        assert!(partial.chat_window.compact_always_on_top);
        assert_eq!(
            partial.chat_window.compact_opacity,
            DEFAULT_CHAT_WINDOW_OPACITY
        );
    }

    // --- slice: chat ---
    #[test]
    fn pinning_the_chat_drawer_changes_only_its_preference() {
        let mut settings = Settings::default();
        assert!(!settings.chat_drawer_pinned, "the drawer starts unpinned");

        patch(r#"{"chatDrawerPinned":true}"#).apply(&mut settings);
        let expected = Settings {
            chat_drawer_pinned: true,
            ..Settings::default()
        };
        assert_eq!(settings, expected, "the pin changes only its preference");

        // The pin survives a reload and an unrelated patch.
        let saved = serde_json::to_string(&settings).expect("serializes");
        assert!(saved.contains(r#""chatDrawerPinned":true"#));
        let mut reloaded: Settings = serde_json::from_str(&saved).expect("reads back");
        patch(r#"{"closeOnLaunch":true}"#).apply(&mut reloaded);
        assert!(reloaded.chat_drawer_pinned);

        patch(r#"{"chatDrawerPinned":false}"#).apply(&mut reloaded);
        assert!(!reloaded.chat_drawer_pinned);

        // A document written before the field reads as unpinned.
        let older: Settings = serde_json::from_str("{}").expect("an empty document");
        assert!(!older.chat_drawer_pinned);
    }

    // --- slice: play with friends ---
    #[test]
    fn the_host_defaults_merge_one_game_at_a_time_and_carry_no_password() {
        let mut settings = filled();
        patch(
            r#"{ "hostDefaults": { "jo": { "clientId": "jk2", "map": "ffa_bespin", "network": "lan" } } }"#,
        )
        .apply(&mut settings);
        // The Jedi Academy entry survives a patch about the other game.
        assert_eq!(
            settings.host_defaults[&Game::JediAcademy].map.as_deref(),
            Some("mp/ffa3")
        );
        assert_eq!(settings.host_defaults[&Game::JediOutcast].network, "lan");

        patch(r#"{ "hostDefaults": { "ja": null }, "hostFirewallNoteSeen": false }"#)
            .apply(&mut settings);
        assert!(!settings.host_defaults.contains_key(&Game::JediAcademy));
        assert!(settings.host_defaults.contains_key(&Game::JediOutcast));
        assert!(!settings.host_firewall_note_seen);

        // A password has no field to land in: it is dropped on the way in and
        // never reaches `settings.json`.
        assert!(serde_json::from_str::<SettingsPatch>(
            r#"{ "hostDefaults": { "ja": { "password": "k7m2q9xa" } } }"#
        )
        .map(|patch| {
            let mut settings = Settings::default();
            patch.apply(&mut settings);
            serde_json::to_string(&settings).expect("serializes")
        })
        .is_ok_and(|json| !json.contains("k7m2q9xa")));

        // A document written before the fields reads as nothing seen yet.
        let older: Settings = serde_json::from_str("{}").expect("an empty document");
        assert!(older.host_defaults.is_empty());
        assert!(!older.host_firewall_note_seen);
    }

    #[test]
    fn dismissing_library_conflicts_survives_reload_and_unrelated_patches() {
        let mut settings = filled();
        patch(r#"{"libraryConflictNoticeDismissed":true}"#).apply(&mut settings);
        let mut expected = filled();
        expected.library_conflict_notice_dismissed = true;
        assert_eq!(settings, expected, "dismissal changes only its preference");

        let saved = serde_json::to_string(&settings).unwrap();
        let mut reloaded: Settings = serde_json::from_str(&saved).unwrap();
        patch(r#"{"activeGame":"jo","defaultClientId":"other"}"#).apply(&mut reloaded);
        assert!(reloaded.library_conflict_notice_dismissed);

        let mut legacy = serde_json::to_value(&settings).unwrap();
        legacy.as_object_mut().unwrap().remove("libraryConflictNoticeDismissed");
        let migrated: Settings = serde_json::from_value(legacy).unwrap();
        assert!(!migrated.library_conflict_notice_dismissed, "old settings show the notice once");
    }

    #[test]
    fn a_patch_changes_only_the_fields_it_carries() {
        // The defect this guards against: the Clients screen saves the game
        // folder and the launch arguments edited by hand disappear with it.
        let mut settings = filled();
        patch(r#"{"gameDataPaths":{"ja":"E:\\Games\\GameData"}}"#).apply(&mut settings);

        assert_eq!(settings.game_data_path(Game::JediAcademy), Some("E:\\Games\\GameData"));
        assert_eq!(settings.extra_launch_args, "+set r_fullscreen 0 +set r_mode 4");
        assert_eq!(settings.default_client_id.as_deref(), Some("everyday"));
        assert_eq!(settings.data_dir_override.as_deref(), Some("D:\\JKNet"));
        assert_eq!(settings.favorite_servers.len(), 1);
        assert_eq!(settings.server_history.len(), 1);
    }

    #[test]
    fn an_empty_patch_changes_nothing() {
        let mut settings = filled();
        patch("{}").apply(&mut settings);
        assert_eq!(settings, filled());
    }

    #[test]
    fn a_null_clears_a_field_and_a_missing_key_does_not() {
        let mut settings = filled();
        patch(r#"{"defaultClientId":null}"#).apply(&mut settings);
        assert_eq!(settings.default_client_id, None);
        // The other two nullable fields were not in the patch.
        assert_eq!(
            settings.game_data_path(Game::JediAcademy),
            Some("D:\\SteamLibrary\\GameData")
        );
        assert_eq!(settings.data_dir_override.as_deref(), Some("D:\\JKNet"));
    }

    #[test]
    fn a_blank_path_counts_as_no_path() {
        let mut settings = filled();
        patch(r#"{"dataDirOverride":"   ","extraLaunchArgs":"  +set r_mode 4  "}"#)
            .apply(&mut settings);
        assert_eq!(settings.data_dir_override, None);
        assert_eq!(settings.extra_launch_args, "+set r_mode 4");
    }

    #[test]
    fn the_boolean_and_the_lists_are_replaced_wholesale() {
        let mut settings = filled();
        patch(r#"{"closeOnLaunch":true,"favoriteServers":[]}"#).apply(&mut settings);
        assert!(settings.close_on_launch);
        assert!(settings.favorite_servers.is_empty());
        assert_eq!(settings.server_history.len(), 1);
    }

    #[test]
    fn a_settings_file_without_the_onboarding_flag_reads_as_not_completed() {
        // Every launcher installed before the guided setup existed has such a
        // file. Reading it as "completed" would be the comfortable answer and
        // the wrong one: the flag has to mean "the player saw the steps".
        let older: Settings =
            serde_json::from_str(r#"{"gameDataPath":"D:\\GameData","closeOnLaunch":true}"#)
                .expect("an older document parses");
        assert!(!older.onboarding_completed);
        assert!(!Settings::default().onboarding_completed);
    }

    #[test]
    fn the_onboarding_flag_follows_its_patch_and_nothing_else() {
        let mut settings = Settings::default();
        patch(r#"{"onboardingCompleted":true}"#).apply(&mut settings);
        assert!(settings.onboarding_completed);
        // The Settings screen offers a rerun, so the flag has to clear as well.
        patch(r#"{"onboardingCompleted":false}"#).apply(&mut settings);
        assert!(!settings.onboarding_completed);

        // A patch about something else leaves the flag alone, which is what
        // keeps the last step of the setup from sending the player round again.
        let mut done = filled();
        patch(r#"{"defaultClientId":"duel"}"#).apply(&mut done);
        assert!(done.onboarding_completed);
    }

    // --- slice: servers browser ---

    #[test]
    fn a_settings_file_without_the_server_filters_reads_as_the_default_row() {
        // Every launcher installed before the filter row was stored has such a
        // file. The defaults are not the zero values of the fields, so a
        // derived `Default` would open the screen on a row of empty strings
        // that matches nothing.
        let older: Settings = serde_json::from_str(r#"{"closeOnLaunch":true}"#)
            .expect("an older document parses");
        assert_eq!(older.server_filters.gametype, "any");
        assert_eq!(older.server_filters.mod_name, "any");
        assert_eq!(older.server_filters.players, "any");
        assert_eq!(older.server_filters.protocol, "any");
        assert!(older.server_filters.hide_bot_only, "bots stay hidden");
        assert!(
            !older.server_filters.hide_passworded,
            "a password is a door the player may have a key to"
        );

        // A row with only one control written out reads the same way: the
        // container-level default fills the rest control by control.
        let partial: Settings =
            serde_json::from_str(r#"{"serverFilters":{"hidePassworded":true}}"#)
                .expect("a half-written row parses");
        assert!(partial.server_filters.hide_passworded);
        assert_eq!(partial.server_filters.gametype, "any");
        assert!(partial.server_filters.hide_bot_only);
    }

    #[test]
    fn the_filter_row_is_replaced_whole_and_nothing_else_moves() {
        let mut settings = filled();
        patch(
            r#"{"serverFilters":{"gametype":"any","modName":"any","players":"any",
                "protocol":"any","hideBotOnly":false,"hidePassworded":true}}"#,
        )
        .apply(&mut settings);
        assert_eq!(settings.server_filters.gametype, "any");
        assert!(!settings.server_filters.hide_bot_only);
        assert!(settings.server_filters.hide_passworded);
        // The star list and the history live in the same document and are not
        // part of the filter row.
        assert_eq!(settings.favorite_servers.len(), 1);
        assert_eq!(settings.server_history.len(), 1);

        // A patch about something else leaves the row alone.
        patch(r#"{"closeOnLaunch":true}"#).apply(&mut settings);
        assert!(settings.server_filters.hide_passworded);
    }

    // --- slice: server actions ---

    #[test]
    fn a_settings_file_from_before_hidden_servers_reads_as_an_empty_list() {
        // The field was added after the launcher shipped, so every installed
        // `settings.json` is a file without it. Reading one as «no server is
        // hidden» is what keeps the browser showing the list it showed before
        // the update; anything else would be a screen that lost rows.
        let file: Settings = serde_json::from_str(
            r#"{"activeGame":"ja","favoriteServers":["203.0.113.10:29070"]}"#,
        )
        .expect("a document without the field parses");
        assert!(file.hidden_servers.is_empty());
        assert_eq!(file.favorite_servers.len(), 1);
    }

    #[test]
    fn a_history_entry_written_before_the_client_field_reads_as_no_client() {
        // Every installed launcher has a history of entries with two keys.
        // Reading one as «client unknown» is what sends Connect to the default
        // client, which is exactly what that press did before the field.
        let file: Settings = serde_json::from_str(
            r#"{"serverHistory":[
                 {"address":"203.0.113.10:29070","lastConnected":"2026-09-10T10:00:00Z"}]}"#,
        )
        .expect("an entry without the field parses");
        assert_eq!(file.server_history.len(), 1);
        assert_eq!(file.server_history[0].client_id, None);
    }

    #[test]
    fn the_hidden_list_is_replaced_whole_and_leaves_the_stars_alone() {
        let mut settings = filled();
        patch(r#"{"hiddenServers":["198.51.100.7:29070","198.51.100.8:29071"]}"#)
            .apply(&mut settings);
        assert_eq!(settings.hidden_servers.len(), 2);
        // Two lists of addresses in one document: hiding a server is not
        // unstarring it, and the screen shows both marks on the same row.
        assert_eq!(settings.favorite_servers, vec!["203.0.113.10:29070".to_string()]);

        patch(r#"{"closeOnLaunch":true}"#).apply(&mut settings);
        assert_eq!(settings.hidden_servers.len(), 2);
    }

    #[test]
    fn a_field_name_that_does_not_exist_is_refused() {
        // A camelCase typo on the frontend has to fail loudly rather than
        // silently write nothing.
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"gamedatapath":"x"}"#).is_err());
    }

    // --- slice: account ---

    #[test]
    fn a_settings_file_from_before_the_service_takes_the_service_of_this_build() {
        // The container-level `#[serde(default)]` fills a missing field from
        // `Settings::default()`, so this is the test that proves the manual
        // `Default` and not a derived one is in force.
        let older: Settings = serde_json::from_str(r#"{"closeOnLaunch":true}"#)
            .expect("an older document parses");
        assert_eq!(older.online_url, crate::online::default_online_url());
        assert_eq!(older.online_token, None);
        assert_eq!(older.online_user, None);
    }

    #[test]
    fn a_settings_file_from_0_2_0_keeps_its_address_and_session_under_the_new_keys() {
        // 0.2.0 called the service JKNet Hub and wrote `hubUrl`, `hubToken` and
        // `hubUser`. An installed launcher must not lose its address and its
        // session to the rename, so the three fields read the old names too.
        let document = r#"{
            "hubUrl": "https://online.jknet.gg",
            "hubToken": "0123456789abcdef",
            "hubUser": {
                "id": "01JBX7Q2",
                "displayName": "Kyle",
                "avatarUrl": null,
                "provider": "jkhub",
                "providerName": "kyle",
                "createdAt": ""
            }
        }"#;

        let older: Settings = serde_json::from_str(document).expect("a 0.2.0 document parses");
        assert_eq!(older.online_url, "https://online.jknet.gg");
        assert_eq!(older.online_token.as_deref(), Some("0123456789abcdef"));
        assert_eq!(
            older.online_user.as_ref().map(|user| user.display_name.as_str()),
            Some("Kyle")
        );

        // Written back under the new names only: the old keys leave the file on
        // the first write, so the alias never has to be read twice.
        let written = serde_json::to_string(&older).expect("the document serializes");
        for new_key in ["onlineUrl", "onlineToken", "onlineUser"] {
            assert!(written.contains(new_key), "{new_key} is missing from {written}");
        }
        for old_key in ["hubUrl", "hubToken", "hubUser"] {
            assert!(!written.contains(old_key), "{old_key} is still in {written}");
        }
    }

    #[test]
    fn the_patch_accepts_the_new_address_key_only() {
        // Nothing but this launcher writes a patch, so `hubUrl` in one is a bug
        // on the frontend rather than an old file, and it has to fail loudly.
        let old = r#"{"hubUrl":"http://127.0.0.1:8787"}"#;
        let new = r#"{"onlineUrl":"http://127.0.0.1:8787"}"#;
        assert!(serde_json::from_str::<SettingsPatch>(old).is_err());
        assert!(serde_json::from_str::<SettingsPatch>(new).is_ok());
    }

    #[test]
    fn a_service_address_is_trimmed_and_a_blank_one_returns_to_the_default() {
        let mut settings = filled();
        patch(r#"{"onlineUrl":"  http://127.0.0.1:9000/  "}"#).apply(&mut settings);
        assert_eq!(settings.online_url, "http://127.0.0.1:9000");

        // Clearing the field restores the build's default service.
        patch(r#"{"onlineUrl":""}"#).apply(&mut settings);
        assert_eq!(settings.online_url, crate::online::default_online_url());
    }

    // --- slice: online gate ---

    #[test]
    fn an_address_typed_into_the_field_switches_the_service_on() {
        // The player's way past a build that ships with the service switched off:
        // the address lands in the document and `online_configured` turns true.
        let mut settings = Settings {
            online_url: String::new(),
            ..Settings::default()
        };
        assert!(!crate::online::online_configured(&settings.online_url));

        patch(r#"{"onlineUrl":"https://online.jknet.gg/"}"#).apply(&mut settings);
        assert_eq!(settings.online_url, "https://online.jknet.gg");
        assert!(crate::online::online_configured(&settings.online_url));
    }

    #[test]
    fn a_service_address_without_an_http_scheme_is_refused() {
        // Storing it would move the complaint from the field the player typed
        // into to every later call to the service.
        assert!(patch(r#"{"onlineUrl":"127.0.0.1:8787"}"#).validate().is_err());
        assert!(patch(r#"{"onlineUrl":"file:///C:/online"}"#).validate().is_err());
        assert!(patch(r#"{"onlineUrl":"https://online.jknet.gg"}"#).validate().is_ok());
        assert!(patch(r#"{"onlineUrl":"  "}"#).validate().is_ok());
        assert!(patch("{}").validate().is_ok());
    }

    #[test]
    fn the_token_leaves_the_document_on_the_way_to_the_frontend() {
        let settings = filled();
        assert!(settings.online_token.is_some());

        let public = settings.clone().redacted();
        assert_eq!(public.online_token, None);
        // Everything else survives, the cached account included: the sidebar
        // needs the name, and the name is not the secret.
        assert_eq!(public.online_user, settings.online_user);
        assert_eq!(public.online_url, settings.online_url);

        let json = serde_json::to_string(&public).expect("the document serializes");
        assert!(!json.contains("0123456789abcdef"), "{json}");
    }

    #[test]
    fn a_whole_settings_document_still_parses_as_a_patch() {
        // Every field of `Settings` has a counterpart here, so a caller that
        // sends the lot is answered rather than refused.
        let text = serde_json::to_string(&filled()).expect("settings serialize");
        let mut settings = Settings::default();
        patch(&text).apply(&mut settings);

        // The two the sign-in owns stay behind, and so does the chat window
        // the core owns; everything else lands.
        assert_eq!(
            settings,
            Settings {
                online_token: None,
                online_user: None,
                chat_window: ChatWindowSettings::default(),
                ..filled()
            }
        );
    }

    #[test]
    fn a_patch_cannot_sign_the_launcher_in() {
        // `update_settings` is callable from the webview. A token settable
        // there would be a way around `begin_sign_in` and `poll_sign_in`: the
        // launcher would talk to the service as whoever a crafted `invoke` says.
        let mut settings = Settings::default();
        patch(
            r#"{"onlineToken":"deadbeef","onlineUser":{"id":"01JBX7Q2","displayName":"Not Me",
                "avatarUrl":null,"provider":"jkhub","providerName":"not_me",
                "createdAt":"2026-09-10T10:00:00Z"}}"#,
        )
        .apply(&mut settings);
        assert_eq!(settings.online_token, None);
        assert_eq!(settings.online_user, None);

        // And it cannot sign the launcher out either: the token of a session
        // in force survives a patch that names it.
        let mut signed_in = filled();
        patch(r#"{"onlineToken":null,"onlineUser":null}"#).apply(&mut signed_in);
        assert_eq!(signed_in.online_token.as_deref(), Some("0123456789abcdef"));
        assert!(signed_in.online_user.is_some());
    }

    // --- slice: game core ---

    #[test]
    fn a_settings_file_from_the_one_game_era_becomes_a_jedi_academy_one() {
        // The document every installed launcher has right now.
        let mut older: Settings = serde_json::from_str(
            r#"{"gameDataPath":"D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData",
                "defaultClientId":"everyday","closeOnLaunch":true}"#,
        )
        .expect("an older document parses");
        assert!(older.migrate(), "the move has something to move");

        assert_eq!(
            older.game_data_path(Game::JediAcademy),
            Some("D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData")
        );
        // Nothing is invented for the game the player has not set up.
        assert_eq!(older.game_data_path(Game::JediOutcast), None);
        assert_eq!(
            older.default_client_ids.get(&Game::JediAcademy).map(String::as_str),
            Some("everyday")
        );
        // The single field stays: the Play button is not scoped yet.
        assert_eq!(older.default_client_id.as_deref(), Some("everyday"));
        // And the game every screen works in is the one the launcher had.
        assert_eq!(older.active_game, Game::JediAcademy);
    }

    #[test]
    fn the_move_out_of_the_old_field_runs_once_and_never_overwrites() {
        // A player who set a Jedi Academy folder after the upgrade must keep
        // it even when the stale key is still in the file.
        let mut settings: Settings = serde_json::from_str(
            r#"{"gameDataPath":"D:\\old","gameDataPaths":{"ja":"E:\\new"},
                "defaultClientId":"duel","defaultClientIds":{"ja":"ffa"}}"#,
        )
        .expect("a half-migrated document parses");
        assert!(!settings.migrate(), "there is nothing left to move");
        assert_eq!(settings.game_data_path(Game::JediAcademy), Some("E:\\new"));
        assert_eq!(
            settings.default_client_ids.get(&Game::JediAcademy).map(String::as_str),
            Some("ffa")
        );

        // And running it twice changes nothing either.
        let before = settings.clone();
        assert!(!settings.migrate());
        assert_eq!(settings, before);
    }

    #[test]
    fn the_old_key_leaves_the_file_on_the_first_write() {
        // `skip_serializing` is the whole mechanism, so it gets a test: a
        // document that kept writing `gameDataPath` back would migrate for
        // ever and confuse anybody reading the file.
        let json = serde_json::to_string(&filled()).expect("settings serialize");
        assert!(!json.contains("\"gameDataPath\""), "{json}");
        assert!(json.contains("\"gameDataPaths\""), "{json}");
        assert!(json.contains("\"activeGame\":\"ja\""), "{json}");
        assert!(json.contains("\"defaultClientIds\""), "{json}");
    }

    #[test]
    fn a_settings_file_without_the_game_fields_reads_as_jedi_academy() {
        let older: Settings =
            serde_json::from_str(r#"{"closeOnLaunch":true}"#).expect("it parses");
        assert_eq!(older.active_game, Game::JediAcademy);
        assert!(older.game_data_paths.is_empty());
        assert!(older.default_client_ids.is_empty());
    }

    #[test]
    fn a_patch_edits_one_game_and_leaves_the_other_alone() {
        // The Settings screen shows two rows and saves the row that changed.
        let mut settings = filled();
        patch(r#"{"gameDataPaths":{"jo":"E:\\GOG\\Jedi Outcast\\GameData"}}"#)
            .apply(&mut settings);
        assert_eq!(
            settings.game_data_path(Game::JediOutcast),
            Some("E:\\GOG\\Jedi Outcast\\GameData")
        );
        assert_eq!(
            settings.game_data_path(Game::JediAcademy),
            Some("D:\\SteamLibrary\\GameData")
        );

        // A `null` clears exactly the game it names.
        patch(r#"{"gameDataPaths":{"jo":null}}"#).apply(&mut settings);
        assert_eq!(settings.game_data_path(Game::JediOutcast), None);
        assert!(settings.game_data_paths.contains_key(&Game::JediAcademy));

        // A blank string counts as no folder, as everywhere else.
        patch(r#"{"gameDataPaths":{"ja":"   "}}"#).apply(&mut settings);
        assert!(settings.game_data_paths.is_empty());
    }

    #[test]
    fn the_one_game_field_still_writes_the_jedi_academy_entry() {
        let mut settings = Settings::default();
        patch(r#"{"gameDataPath":"D:\\GameData"}"#).apply(&mut settings);
        assert_eq!(settings.game_data_path(Game::JediAcademy), Some("D:\\GameData"));
        assert_eq!(settings.game_data_path(Game::JediOutcast), None);
    }

    #[test]
    fn the_map_beats_the_one_game_field_in_a_patch_that_carries_both() {
        // Nothing in the launcher sends both — the screens speak the map only
        // — but the order the two are applied in decides the answer, and the
        // retired field is not the one that should win.
        let mut settings = Settings::default();
        patch(r#"{"gameDataPath":"D:\\Old","gameDataPaths":{"ja":"D:\\New"}}"#)
            .apply(&mut settings);
        assert_eq!(settings.game_data_path(Game::JediAcademy), Some("D:\\New"));

        // And the map clears the entry the old field just wrote, rather than
        // the old field restoring it.
        patch(r#"{"gameDataPath":"D:\\Old","gameDataPaths":{"ja":null}}"#)
            .apply(&mut settings);
        assert_eq!(settings.game_data_path(Game::JediAcademy), None);
    }

    #[test]
    fn the_active_game_follows_its_patch() {
        let mut settings = Settings::default();
        assert_eq!(settings.active_game, Game::JediAcademy);
        patch(r#"{"activeGame":"jo"}"#).apply(&mut settings);
        assert_eq!(settings.active_game, Game::JediOutcast);
        // And a patch about something else leaves it where it is.
        patch(r#"{"closeOnLaunch":true}"#).apply(&mut settings);
        assert_eq!(settings.active_game, Game::JediOutcast);
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"activeGame":"jk1"}"#).is_err());
    }

    #[test]
    fn a_command_without_a_game_works_in_the_active_one() {
        let mut settings = Settings::default();
        assert_eq!(settings.game_or_active(None), Game::JediAcademy);
        assert_eq!(settings.game_or_active(Some(Game::JediOutcast)), Game::JediOutcast);
        settings.active_game = Game::JediOutcast;
        assert_eq!(settings.game_or_active(None), Game::JediOutcast);
    }

    #[test]
    fn a_game_without_a_folder_is_refused_by_name() {
        let settings = Settings::default();
        let refusal = settings
            .require_game_data_path(Game::JediOutcast)
            .expect_err("there is no folder");
        // Two games mean two folders to be wrong about, so the message says
        // which one is missing.
        assert!(refusal.to_string().contains("Jedi Outcast"), "{refusal}");
    }

    // --- slice: i18n ---
    #[test]
    fn a_fresh_launcher_follows_the_system_language() {
        assert_eq!(Settings::default().language, SYSTEM_LANGUAGE);
        // A `settings.json` written before the field existed reads the same
        // way, so an installed launcher keeps following the system.
        let older: Settings = serde_json::from_str("{}").expect("an empty document reads");
        assert_eq!(older.language, SYSTEM_LANGUAGE);
    }

    // --- slice: i18n ---
    #[test]
    fn only_a_language_with_a_catalog_may_be_stored() {
        for value in ["system", "en", "ru", "uk", "de", "fr", "es", "pl", "hu"] {
            let patch = patch(&format!(r#"{{"language":{value:?}}}"#));
            patch.validate().expect("a language with a catalog is accepted");
        }

        // A tag with a region, a language JKNet does not speak and an empty
        // string all name no catalog, so all three are refused where they are
        // written rather than silently leaving the interface in English.
        for value in ["ru-RU", "pt", "", "System"] {
            let patch = patch(&format!(r#"{{"language":{value:?}}}"#));
            assert!(patch.validate().is_err(), "{value:?} should be refused");
        }
    }

    // --- slice: pk3 editor ---
    #[test]
    fn the_preview_mode_starts_simple_and_takes_only_the_two_modes() {
        assert_eq!(Settings::default().preview_mode, DEFAULT_PREVIEW_MODE);
        // A `settings.json` written before the modes existed opens the
        // preview the way it always did.
        let older: Settings = serde_json::from_str("{}").expect("an empty document reads");
        assert_eq!(older.preview_mode, "simple");

        for value in ["simple", "advanced"] {
            let patch = patch(&format!(r#"{{"previewMode":{value:?}}}"#));
            patch.validate().expect("a known mode is accepted");
            let mut settings = filled();
            let before = settings.clone();
            patch.apply(&mut settings);
            assert_eq!(settings.preview_mode, value);
            assert_eq!(settings.language, before.language);
            assert_eq!(settings.favorite_servers, before.favorite_servers);
        }
        for value in ["Simple", "expert", ""] {
            let patch = patch(&format!(r#"{{"previewMode":{value:?}}}"#));
            assert!(patch.validate().is_err(), "{value:?} should be refused");
        }

        // The mode reaches the frontend: only the token is redacted.
        let redacted = filled().redacted();
        assert_eq!(redacted.preview_mode, "advanced");
        assert!(redacted.online_token.is_none());
        let json = serde_json::to_value(&redacted).expect("settings serialize");
        assert_eq!(json["previewMode"], "advanced");
    }

    // --- slice: i18n ---
    #[test]
    fn a_language_patch_touches_nothing_else() {
        let mut settings = filled();
        let before = settings.clone();
        patch(r#"{"language":"ru"}"#).apply(&mut settings);
        assert_eq!(settings.language, "ru");
        assert_eq!(settings.online_url, before.online_url);
        assert_eq!(settings.active_game, before.active_game);
        assert_eq!(settings.favorite_servers, before.favorite_servers);
    }

    #[test]
    fn a_null_service_address_leaves_the_one_in_force_alone() {
        // `onlineUrl` is not one of the nullable fields: an address is always in
        // force. The way back to the default is a blank string, which is what
        // clearing the field on the Settings screen sends.
        let mut settings = filled();
        patch(r#"{"onlineUrl":null}"#).apply(&mut settings);
        assert_eq!(settings.online_url, "https://online.jknet.gg");
    }

    // --- slice: player profiles ---

    #[test]
    fn the_saved_nicknames_are_one_list_for_the_whole_launcher() {
        let mut settings = filled();
        patch(r#"{"savedNicknames":["  ^1Kyle  ","Padawan"]}"#).apply(&mut settings);
        assert_eq!(settings.saved_nicknames, ["^1Kyle", "Padawan"]);
        // A patch of one field touches nothing else, profiles included: those
        // live beside the client they belong to, not in this document.
        assert_eq!(settings.favorite_servers, filled().favorite_servers);

        // A document written before the field existed reads as an empty list.
        let older: Settings =
            serde_json::from_str(r#"{"activeGame":"ja"}"#).expect("an older document parses");
        assert!(older.saved_nicknames.is_empty());
    }

    #[test]
    fn a_nickname_is_saved_once_however_it_was_typed() {
        // One name, two spellings: the list is what the player reads back, not
        // a log of what they typed. Colour codes do make two names, because
        // `^1Kyle` and `^2Kyle` are two different things on a server.
        assert_eq!(
            clean_nicknames(vec![
                "Kyle".into(),
                " kyle ".into(),
                "^1Kyle".into(),
                "   ".into(),
            ]),
            ["Kyle", "^1Kyle"]
        );
        // The engine cuts a name to `MAX_NETNAME`, so a longer one is not a
        // name anybody would see.
        assert_eq!(clean_nicknames(vec!["x".repeat(MAX_NICKNAME_LEN + 1)]), Vec::<String>::new());
        // And it counts bytes: eighteen Cyrillic letters fill the buffer,
        // nineteen overflow it.
        assert_eq!(
            clean_nicknames(vec!["Т".repeat(MAX_NICKNAME_LEN / 2)]),
            ["Т".repeat(18)]
        );
        assert_eq!(
            clean_nicknames(vec!["Т".repeat(MAX_NICKNAME_LEN / 2 + 1)]),
            Vec::<String>::new()
        );
        // A colour code costs its two bytes here as well.
        assert_eq!(
            clean_nicknames(vec![format!("^1{}", "x".repeat(MAX_NICKNAME_LEN - 1))]),
            Vec::<String>::new()
        );
        // And the list cannot grow without end under a form that prepends.
        let many: Vec<String> = (0..MAX_NICKNAMES + 10).map(|n| format!("name{n}")).collect();
        assert_eq!(clean_nicknames(many).len(), MAX_NICKNAMES);
    }
}
