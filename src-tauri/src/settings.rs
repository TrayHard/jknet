//! Launcher settings: one JSON document in the config root.
//!
//! `update_settings` takes a patch, not a whole document. The frontend keeps
//! the settings in a React Query cache, and sending that copy back would
//! overwrite every field another writer changed in the meantime — including
//! the player editing `settings.json` in a text editor while the launcher is
//! open. Only the fields a patch carries are touched.

use std::fs;

use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{AppError, Result};
use crate::hub::{self, HubUser};
use crate::paths;
use crate::state::AppState;

/// Everything the launcher remembers between runs, except window geometry
/// (that belongs to `tauri-plugin-window-state`).
///
/// `Default` is written out rather than derived, because one field has a value
/// that is not the zero of its type in a debug build: `hub_url` names the hub
/// of the build profile, and the container-level `#[serde(default)]` fills a
/// missing field from this implementation, so a `settings.json` written before
/// the hub existed reads as the development hub rather than as nothing. A
/// release build has no hub yet, so there the same default is blank on
/// purpose; see `hub::default_hub_url`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Folder with `base\assets0.pk3`..`assets3.pk3`, confirmed by the user.
    /// `None` means the first run has not finished yet.
    pub game_data_path: Option<String>,
    /// Client started by the Play button. `None` disables the button.
    pub default_client_id: Option<String>,
    /// Hide the launcher window while the game is running.
    pub close_on_launch: bool,
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

    // --- slice: onboarding ---
    /// Whether the player has been through the three first-run steps. False by
    /// default, which is also what a settings file written before this field
    /// existed deserializes to: a launcher that cannot prove the player has
    /// seen the guided setup shows it, and the steps are derived from what is
    /// already configured, so nobody repeats work they have done.
    pub onboarding_completed: bool,

    // --- slice: account ---
    /// The JKNet hub this launcher talks to, without a trailing slash.
    ///
    /// Empty means there is no hub, which is what a release build defaults to
    /// until the service is deployed. The field is editable on the Settings
    /// screen, and typing an address there is what switches the account and
    /// friends interface on for one machine.
    pub hub_url: String,
    /// The bearer token of the signed-in account, 64 hex characters.
    ///
    /// This is the one secret the launcher stores. It never reaches the
    /// webview: `get_settings` and every other command that answers with a
    /// whole document call [`Settings::redacted`] first.
    pub hub_token: Option<String>,
    /// The account the token belongs to, as the hub last described it. Cached
    /// so the sidebar can print a name before any request answers.
    pub hub_user: Option<HubUser>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            game_data_path: None,
            default_client_id: None,
            close_on_launch: false,
            data_dir_override: None,
            extra_launch_args: String::new(),
            favorite_servers: Vec::new(),
            server_history: Vec::new(),
            onboarding_completed: false,
            hub_url: hub::default_hub_url().to_string(),
            hub_token: None,
            hub_user: None,
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
}

impl Settings {
    /// Reads `settings.json`. A missing file yields the defaults; a corrupted
    /// file is an error, so the launcher never silently drops a player's
    /// configuration.
    pub fn load(state: &AppState) -> Result<Settings> {
        let file = paths::settings_file(&state.config_root);
        match fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| AppError::json(format!("cannot parse {}", file.display()), e)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(AppError::io_path("cannot read", &file, e)),
        }
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
    /// The document as the frontend may see it: without the hub token.
    ///
    /// Every command that answers with a whole `Settings` ends in this call.
    /// The frontend has no use for the token — the core puts it on the
    /// requests — and a secret that never crosses the IPC boundary cannot be
    /// read out of a React Query cache by anything that gets into the webview.
    pub fn redacted(mut self) -> Settings {
        self.hub_token = None;
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
    #[serde(deserialize_with = "sent")]
    pub game_data_path: Option<Option<String>>,
    #[serde(deserialize_with = "sent")]
    pub default_client_id: Option<Option<String>>,
    pub close_on_launch: Option<bool>,
    #[serde(deserialize_with = "sent")]
    pub data_dir_override: Option<Option<String>>,
    pub extra_launch_args: Option<String>,
    pub favorite_servers: Option<Vec<String>>,
    pub server_history: Option<Vec<ServerHistoryEntry>>,

    // --- slice: onboarding ---
    pub onboarding_completed: Option<bool>,

    // --- slice: account ---
    pub hub_url: Option<String>,
    /// Read and thrown away. See [`SettingsPatch::apply`].
    #[serde(deserialize_with = "sent")]
    pub hub_token: Option<Option<String>>,
    /// Read and thrown away, for the same reason as the token above.
    #[serde(deserialize_with = "sent")]
    pub hub_user: Option<Option<HubUser>>,
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
    /// Two fields are deliberately not copied. `hubToken` and `hubUser` belong
    /// to the sign-in and are written by `crate::account` alone; a patch
    /// carrying them is read and dropped. The command behind this is
    /// `update_settings`, which anything running in the webview can call, and a
    /// token settable from there would be a way around `begin_sign_in` and
    /// `poll_sign_in` — the launcher would talk to the hub as whoever a
    /// crafted `invoke` says. The fields stay declared so that a caller who
    /// sends a whole settings document still gets it accepted rather than
    /// refused by `deny_unknown_fields`.
    pub fn apply(self, settings: &mut Settings) {
        if let Some(value) = self.game_data_path {
            settings.game_data_path = non_empty(value);
        }
        if let Some(value) = self.default_client_id {
            settings.default_client_id = non_empty(value);
        }
        if let Some(value) = self.close_on_launch {
            settings.close_on_launch = value;
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
        if let Some(value) = self.onboarding_completed {
            settings.onboarding_completed = value;
        }
        if let Some(value) = self.hub_url {
            // A blank address means "back to the default", which is what the
            // Settings screen offers when the field is cleared. A `null` is
            // not a way to clear it: an address is always in force, and the
            // one the field falls back to is the default hub.
            settings.hub_url = hub::normalize_hub_url(&value);
        }
    }

    // --- slice: account ---
    /// Refuses a patch the launcher would rather not write.
    ///
    /// One field needs this. A hub address without a scheme, or with one that
    /// is not HTTP, would be stored and then rejected by every later call with
    /// a message about the address rather than about the typo — so it is
    /// refused where the typo was made.
    pub fn validate(&self) -> Result<()> {
        if let Some(url) = self.hub_url.as_deref() {
            let url = url.trim();
            // Blank clears the field back to the default, so there is nothing
            // to check.
            if !url.is_empty() && !hub::is_http_url(url) {
                return Err(AppError::InvalidInput(format!(
                    "the hub address {url:?} has to start with http:// or https://"
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

/// Returns the current settings, without the hub token.
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
    state: tauri::State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<Settings> {
    // --- slice: account --- refuses a hub address that is not an HTTP URL.
    patch.validate()?;
    let mut settings = Settings::current(&state)?;
    patch.apply(&mut settings);
    settings.save(&state)?;
    state.set_settings(settings.clone())?;
    state.paths()?.ensure()?;
    log::info!("settings updated, data root is {}", state.paths()?.root.display());
    Ok(settings.redacted())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A document with something in every field, so a wiped one is obvious.
    fn filled() -> Settings {
        Settings {
            game_data_path: Some("D:\\SteamLibrary\\GameData".into()),
            default_client_id: Some("everyday".into()),
            close_on_launch: false,
            data_dir_override: Some("D:\\JKNet".into()),
            extra_launch_args: "+set r_fullscreen 0 +set r_mode 4".into(),
            favorite_servers: vec!["203.0.113.10:29070".into()],
            server_history: vec![ServerHistoryEntry {
                address: "203.0.113.10:29070".into(),
                last_connected: "2026-09-10T10:00:00Z".into(),
            }],
            onboarding_completed: true,
            hub_url: "https://hub.jknet.gg".into(),
            hub_token: Some("0123456789abcdef".into()),
            hub_user: Some(HubUser {
                id: "01JBX7Q2".into(),
                display_name: "Kyle Katarn".into(),
                avatar_url: None,
                provider: "jkhub".into(),
                provider_name: "kyle_k".into(),
                created_at: "2026-09-10T10:00:00Z".into(),
            }),
        }
    }

    fn patch(json: &str) -> SettingsPatch {
        serde_json::from_str(json).expect("the patch parses")
    }

    #[test]
    fn a_patch_changes_only_the_fields_it_carries() {
        // The defect this guards against: the Clients screen saves the game
        // folder and the launch arguments edited by hand disappear with it.
        let mut settings = filled();
        patch(r#"{"gameDataPath":"E:\\Games\\GameData"}"#).apply(&mut settings);

        assert_eq!(settings.game_data_path.as_deref(), Some("E:\\Games\\GameData"));
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
        assert_eq!(settings.game_data_path.as_deref(), Some("D:\\SteamLibrary\\GameData"));
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

    #[test]
    fn a_field_name_that_does_not_exist_is_refused() {
        // A camelCase typo on the frontend has to fail loudly rather than
        // silently write nothing.
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"gamedatapath":"x"}"#).is_err());
    }

    // --- slice: account ---

    #[test]
    fn a_settings_file_from_before_the_hub_takes_the_hub_of_this_build() {
        // The container-level `#[serde(default)]` fills a missing field from
        // `Settings::default()`, so this is the test that proves the manual
        // `Default` and not a derived one is in force.
        let older: Settings = serde_json::from_str(r#"{"closeOnLaunch":true}"#)
            .expect("an older document parses");
        assert_eq!(older.hub_url, crate::hub::default_hub_url());
        assert_eq!(older.hub_token, None);
        assert_eq!(older.hub_user, None);
    }

    #[test]
    fn a_hub_address_is_trimmed_and_a_blank_one_returns_to_the_default() {
        let mut settings = filled();
        patch(r#"{"hubUrl":"  http://127.0.0.1:9000/  "}"#).apply(&mut settings);
        assert_eq!(settings.hub_url, "http://127.0.0.1:9000");

        // Clearing the field is the way back to the default of the build,
        // which in a release build is no hub at all.
        patch(r#"{"hubUrl":""}"#).apply(&mut settings);
        assert_eq!(settings.hub_url, crate::hub::default_hub_url());
    }

    // --- slice: hub gate ---

    #[test]
    fn an_address_typed_into_the_field_switches_the_hub_on() {
        // The player's way past a build that ships with the hub switched off:
        // the address lands in the document and `hub_configured` turns true.
        let mut settings = Settings {
            hub_url: String::new(),
            ..Settings::default()
        };
        assert!(!crate::hub::hub_configured(&settings.hub_url));

        patch(r#"{"hubUrl":"https://hub.jknet.gg/"}"#).apply(&mut settings);
        assert_eq!(settings.hub_url, "https://hub.jknet.gg");
        assert!(crate::hub::hub_configured(&settings.hub_url));
    }

    #[test]
    fn a_hub_address_without_an_http_scheme_is_refused() {
        // Storing it would move the complaint from the field the player typed
        // into to every later call to the hub.
        assert!(patch(r#"{"hubUrl":"127.0.0.1:8787"}"#).validate().is_err());
        assert!(patch(r#"{"hubUrl":"file:///C:/hub"}"#).validate().is_err());
        assert!(patch(r#"{"hubUrl":"https://hub.jknet.gg"}"#).validate().is_ok());
        assert!(patch(r#"{"hubUrl":"  "}"#).validate().is_ok());
        assert!(patch("{}").validate().is_ok());
    }

    #[test]
    fn the_token_leaves_the_document_on_the_way_to_the_frontend() {
        let settings = filled();
        assert!(settings.hub_token.is_some());

        let public = settings.clone().redacted();
        assert_eq!(public.hub_token, None);
        // Everything else survives, the cached account included: the sidebar
        // needs the name, and the name is not the secret.
        assert_eq!(public.hub_user, settings.hub_user);
        assert_eq!(public.hub_url, settings.hub_url);

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

        // The two the sign-in owns stay behind; everything else lands.
        assert_eq!(
            settings,
            Settings {
                hub_token: None,
                hub_user: None,
                ..filled()
            }
        );
    }

    #[test]
    fn a_patch_cannot_sign_the_launcher_in() {
        // `update_settings` is callable from the webview. A token settable
        // there would be a way around `begin_sign_in` and `poll_sign_in`: the
        // launcher would talk to the hub as whoever a crafted `invoke` says.
        let mut settings = Settings::default();
        patch(
            r#"{"hubToken":"deadbeef","hubUser":{"id":"01JBX7Q2","displayName":"Not Me",
                "avatarUrl":null,"provider":"jkhub","providerName":"not_me",
                "createdAt":"2026-09-10T10:00:00Z"}}"#,
        )
        .apply(&mut settings);
        assert_eq!(settings.hub_token, None);
        assert_eq!(settings.hub_user, None);

        // And it cannot sign the launcher out either: the token of a session
        // in force survives a patch that names it.
        let mut signed_in = filled();
        patch(r#"{"hubToken":null,"hubUser":null}"#).apply(&mut signed_in);
        assert_eq!(signed_in.hub_token.as_deref(), Some("0123456789abcdef"));
        assert!(signed_in.hub_user.is_some());
    }

    #[test]
    fn a_null_hub_address_leaves_the_one_in_force_alone() {
        // `hubUrl` is not one of the nullable fields: an address is always in
        // force. The way back to the default is a blank string, which is what
        // clearing the field on the Settings screen sends.
        let mut settings = filled();
        patch(r#"{"hubUrl":null}"#).apply(&mut settings);
        assert_eq!(settings.hub_url, "https://hub.jknet.gg");
    }
}
