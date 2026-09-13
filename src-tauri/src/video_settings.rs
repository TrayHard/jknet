//! User-owned render settings, separate from game client configuration.
use crate::{
    error::{AppError, Result},
    state::AppState,
    user_files,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct VideoSettings {
    pub format: String,
    pub fps: u32,
    pub fov: u32,
    pub commands: String,
}
impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            format: "mp4".into(),
            fps: 60,
            fov: 100,
            commands: String::new(),
        }
    }
}
impl VideoSettings {
    pub fn validate(&self) -> Result<()> {
        if ![30, 60].contains(&self.fps) || !["mp4", "webm", "mkv"].contains(&self.format.as_str())
        {
            return Err(AppError::InvalidInput(
                "choose MP4, WebM or MKV at 30 or 60 fps".into(),
            ));
        }
        if !(1..=160).contains(&self.fov) {
            return Err(AppError::InvalidInput(
                "FOV must be between 1 and 160".into(),
            ));
        }
        if self.commands.len() > 32 * 1024 || self.commands.contains('\0') {
            return Err(AppError::InvalidInput(
                "render commands exceed 32 KiB or contain a null byte".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct VideoPreset {
    pub id: String,
    pub name: String,
    pub settings: VideoSettings,
}
#[derive(Default, Serialize, Deserialize)]
pub struct VideoPreferences {
    #[serde(flatten)]
    pub settings: VideoSettings,
    #[serde(default)]
    pub presets: Vec<VideoPreset>,
}
fn read(state: &AppState) -> Result<VideoPreferences> {
    user_files::read(&state.paths()?.root.join("media/video-preferences.json"))
}
fn write(state: &AppState, preferences: &VideoPreferences) -> Result<()> {
    user_files::write(
        &state.paths()?.root.join("media/video-preferences.json"),
        preferences,
    )
}
pub fn remember(state: &AppState, settings: &VideoSettings) -> Result<()> {
    let _guard = state.client_records().enter();
    let mut preferences = read(state)?;
    preferences.settings = settings.clone();
    write(state, &preferences)
}
#[tauri::command]
pub fn video_preferences(state: tauri::State<'_, AppState>) -> Result<VideoPreferences> {
    let _guard = state.client_records().enter();
    read(&state)
}
#[tauri::command]
pub fn save_video_preset(
    state: tauri::State<'_, AppState>,
    preset: VideoPreset,
) -> Result<VideoPreset> {
    save_preset(&state, preset)
}
fn save_preset(state: &AppState, mut preset: VideoPreset) -> Result<VideoPreset> {
    preset.settings.validate()?;
    preset.name = user_files::label(&preset.name)?;
    let _guard = state.client_records().enter();
    let mut preferences = read(state)?;
    if preset.id.is_empty() {
        preset.id = user_files::id();
        preferences.presets.push(preset.clone());
    } else {
        let stored = preferences
            .presets
            .iter_mut()
            .find(|p| p.id == preset.id)
            .ok_or_else(|| AppError::NotFound("render preset".into()))?;
        *stored = preset.clone();
    }
    write(state, &preferences)?;
    Ok(preset)
}
#[tauri::command]
pub fn delete_video_preset(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    delete_preset(&state, &id)
}
fn delete_preset(state: &AppState, id: &str) -> Result<()> {
    let _guard = state.client_records().enter();
    let mut preferences = read(state)?;
    preferences.presets.retain(|p| p.id != id);
    write(state, &preferences)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presets_survive_restart_last_used_settings_update_and_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::bootstrap(dir.path().into());
        let mut preset = save_preset(
            &state,
            VideoPreset {
                id: String::new(),
                name: "Duel".into(),
                settings: VideoSettings::default(),
            },
        )
        .unwrap();
        preset.settings.fov = 120;
        save_preset(&state, preset.clone()).unwrap();
        remember(
            &state,
            &VideoSettings {
                format: "webm".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let restarted = AppState::bootstrap(dir.path().into());
        let stored = read(&restarted).unwrap();
        assert_eq!(stored.presets.len(), 1);
        assert_eq!(stored.presets[0].settings.fov, 120);
        assert_eq!(stored.settings.format, "webm");
        delete_preset(&restarted, &preset.id).unwrap();
        assert!(read(&state).unwrap().presets.is_empty());
        assert_eq!(read(&state).unwrap().settings.format, "webm");
    }
    #[test]
    fn upgrades_legacy_preferences_and_roundtrips_presets() {
        let mut prefs: VideoPreferences =
            serde_json::from_str(r#"{"format":"webm","fps":30}"#).unwrap();
        assert_eq!(prefs.settings.fov, 100);
        assert_eq!(prefs.settings.format, "webm");
        prefs.presets.push(VideoPreset {
            id: "test".into(),
            name: "Wide".into(),
            settings: VideoSettings {
                fov: 115,
                commands: "cg_draw2D 0\necho \"ready; render\"".into(),
                ..Default::default()
            },
        });
        let copy: VideoPreferences =
            serde_json::from_slice(&serde_json::to_vec(&prefs).unwrap()).unwrap();
        assert_eq!(copy.presets[0].settings, prefs.presets[0].settings);
    }
    #[test]
    fn validates_render_settings() {
        assert!(VideoSettings::default().validate().is_ok());
        assert!(VideoSettings {
            fov: 0,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(VideoSettings {
            commands: "echo \0".into(),
            ..Default::default()
        }
        .validate()
        .is_err());
    }
}
