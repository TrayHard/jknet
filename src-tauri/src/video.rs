//! Isolated jaMME capture jobs. No client config is rewritten by rendering.
use crate::{
    appearance, clients, engines,
    error::{AppError, Result},
    launch,
    media::{self, MediaBook, MediaItem},
    state::AppState,
    user_files,
    video_progress::{encoder_sample, CaptureProgress, VideoProgress},
    video_settings::{self, VideoSettings},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJob {
    pub id: String,
    pub demo_id: String,
    pub client_id: String,
    pub status: String,
    pub error: Option<String>,
    pub video_ids: Vec<String>,
    pub phase: String,
    pub demo_name: String,
    pub elapsed_seconds: u64,
    pub progress: VideoProgress,
}
/// Rebuild a browser-compatible preview of a legacy AVI without changing it.
#[tauri::command]
pub async fn prepare_video_preview(app: tauri::AppHandle, id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let item = media::find_item(&state, &id)?;
        if item.kind != "videos" || item.extension != "avi" {
            return Err(AppError::InvalidInput("select a legacy AVI video".into()));
        }
        let paths = state.paths()?;
        let target = paths.cache.join("videos").join(format!("{}.mp4", item.id));
        if target.is_file() {
            return Ok(());
        }
        fs::create_dir_all(target.parent().unwrap())
            .map_err(|e| AppError::io_path("cannot create video preview", &target, e))?;
        let encoder = crate::video_encoder::ensure(&paths.root, || false)?;
        let temp = target.with_extension("part.mp4");
        let mut command = Command::new(encoder);
        command
            .args(["-nostdin", "-y", "-i"])
            .arg(media::media_file(&state, &item)?)
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ])
            .arg(&temp)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Err(error) = run(&mut command, &Cancellation::default()) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        fs::rename(&temp, &target)
            .map_err(|e| AppError::io_path("cannot save video preview", &target, e))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::State(e.to_string()))?
}
fn progress(app: &tauri::AppHandle, id: &str, phase: &str, progress: VideoProgress) {
    if let Ok(mut jobs) = app.state::<VideoState>().0.lock() {
        if let Some(job) = jobs.get_mut(id) {
            job.view.phase = phase.into();
            job.view.progress = progress;
        }
    }
}
#[derive(Default)]
struct Cancellation {
    requested: AtomicBool,
    child: Mutex<Option<crate::video_process::VideoProcess>>,
}
impl Cancellation {
    fn stop(&self) {
        self.requested.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    fn cancelled(&self) -> bool {
        self.requested.load(Ordering::Relaxed)
    }
}
struct Job {
    view: VideoJob,
    cancel: Arc<Cancellation>,
    started: Instant,
}
#[derive(Default)]
pub struct VideoState(Mutex<BTreeMap<String, Job>>);
impl VideoState {
    pub(crate) fn with_idle_media<T>(
        &self,
        ids: &BTreeSet<String>,
        delete: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let jobs = self
            .0
            .lock()
            .map_err(|_| AppError::State("video jobs lock".into()))?;
        if jobs
            .values()
            .any(|job| job.view.status == "rendering" && ids.contains(&job.view.demo_id))
        {
            return Err(AppError::Busy(
                "cancel or finish the demo export before deleting it".into(),
            ));
        }
        let result = delete();
        drop(jobs);
        result
    }
}

fn no_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.stdin(Stdio::null());
}
fn collect(dir: &Path, extension: &str, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                collect(&entry.path(), extension, depth - 1, out);
            } else if entry
                .path()
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case(extension))
            {
                out.push(entry.path());
            }
        }
    }
}
fn run(command: &mut Command, cancel: &Cancellation) -> Result<()> {
    run_watched(command, cancel, None, || {})
}
fn run_watched(
    command: &mut Command,
    cancel: &Cancellation,
    capture_log: Option<&Path>,
    mut tick: impl FnMut(),
) -> Result<()> {
    no_console(command);
    {
        let mut slot = cancel
            .child
            .lock()
            .map_err(|_| AppError::State("video process lock".into()))?;
        if cancel.cancelled() {
            return Err(AppError::Launch("video export cancelled".into()));
        }
        *slot = Some(
            crate::video_process::VideoProcess::spawn(command, capture_log.is_some())
                .map_err(|e| AppError::Launch(e.to_string()))?,
        );
    }
    let start = Instant::now();
    let mut closing: Option<Instant> = None;
    loop {
        if cancel.cancelled() || start.elapsed() > Duration::from_secs(24 * 3600) {
            cancel.stop();
            return Err(AppError::Launch(
                "video export cancelled or timed out".into(),
            ));
        }
        tick();
        let status = {
            let mut slot = cancel
                .child
                .lock()
                .map_err(|_| AppError::State("video process lock".into()))?;
            if let (Some(log), Some(child)) = (capture_log, slot.as_mut()) {
                if closing.is_none()
                    && fs::read_to_string(log).is_ok_and(|text| demo_finished(&text))
                {
                    child.close();
                    closing = Some(Instant::now());
                }
                if closing.is_some_and(|time| time.elapsed() > Duration::from_secs(15)) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::Launch(
                        "capture did not shut down cleanly; see capture log".into(),
                    ));
                }
            }
            let status = slot
                .as_mut()
                .ok_or_else(|| AppError::State("missing video process".into()))?
                .try_wait()
                .map_err(|e| AppError::Launch(e.to_string()))?;
            if status.is_some() {
                *slot = None;
            }
            status
        };
        if let Some(status) = status {
            tick();
            return if status.success() {
                Ok(())
            } else {
                Err(AppError::Launch(format!(
                    "video renderer exited with {status}"
                )))
            };
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
pub fn cancel_all(state: &VideoState) {
    if let Ok(jobs) = state.0.lock() {
        for job in jobs.values() {
            job.cancel.stop();
        }
    }
}
#[tauri::command]
pub fn list_video_jobs(state: tauri::State<'_, VideoState>) -> Result<Vec<VideoJob>> {
    Ok(state
        .0
        .lock()
        .map_err(|_| AppError::State("video jobs lock".into()))?
        .values()
        .map(|j| {
            let mut view = j.view.clone();
            if view.status == "rendering" {
                view.elapsed_seconds = j.started.elapsed().as_secs();
            }
            view
        })
        .collect())
}
#[tauri::command]
pub fn cancel_video_job(state: tauri::State<'_, VideoState>, id: String) -> Result<()> {
    if let Some(job) = state
        .0
        .lock()
        .map_err(|_| AppError::State("video jobs lock".into()))?
        .get(&id)
    {
        job.cancel.stop();
    }
    Ok(())
}
#[tauri::command]
pub fn export_demo_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    videos: tauri::State<'_, VideoState>,
    demo_id: String,
    client_id: String,
    settings: VideoSettings,
) -> Result<VideoJob> {
    settings.validate()?;
    // Use the same lock as media deletion, including the initial demo lookup.
    let mut jobs = videos
        .0
        .lock()
        .map_err(|_| AppError::State("video jobs lock".into()))?;
    let demo = media::find_item(&state, &demo_id)?;
    let client = clients::read_record(&state.paths()?, &client_id)?;
    if demo.kind != "demos" || client.engine_id != "jamme" || demo.game != client.game {
        return Err(AppError::InvalidInput(
            "select a jaMME client for this demo".into(),
        ));
    }
    if jobs.values().any(|j| j.view.status == "rendering") {
        return Err(AppError::Busy("a video export is already running".into()));
    }
    video_settings::remember(&state, &settings)?;
    let view = VideoJob {
        id: user_files::id(),
        demo_id,
        client_id,
        status: "rendering".into(),
        error: None,
        video_ids: Vec::new(),
        phase: "preparing".into(),
        demo_name: demo.name.clone(),
        elapsed_seconds: 0,
        progress: VideoProgress::default(),
    };
    let cancel = Arc::new(Cancellation::default());
    jobs.insert(
        view.id.clone(),
        Job {
            view: view.clone(),
            cancel: cancel.clone(),
            started: Instant::now(),
        },
    );
    let worker = view.clone();
    std::thread::spawn(move || {
        let result = capture(
            &app.state::<AppState>(),
            &worker,
            &demo,
            &settings,
            &cancel,
            |phase, value| progress(&app, &worker.id, phase, value),
        );
        let state = app.state::<VideoState>();
        if let Ok(mut jobs) = state.0.lock() {
            if let Some(job) = jobs.get_mut(&worker.id) {
                job.view.elapsed_seconds = job.started.elapsed().as_secs();
                match result {
                    Ok(ids) => {
                        job.view.status = "complete".into();
                        job.view.video_ids = ids;
                        job.view.progress.encoding_percent = Some(100.0);
                    }
                    Err(error) => {
                        log::warn!("video export {}: {error}", worker.id);
                        job.view.status = if cancel.cancelled() {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        job.view.error = Some(error.to_string());
                    }
                }
            }
        };
    });
    Ok(view)
}
fn capture(
    state: &AppState,
    job: &VideoJob,
    demo: &MediaItem,
    options: &VideoSettings,
    cancel: &Cancellation,
    update: impl Fn(&str, VideoProgress),
) -> Result<Vec<String>> {
    let paths = state.paths()?;
    let encoder = crate::video_encoder::ensure(&paths.root, || cancel.cancelled())?;
    let settings = state.settings()?;
    let client = clients::read_record(&paths, &job.client_id)?;
    let engine = engines::require(&client.engine_id)?;
    let job_root = paths.root.join("media/jobs").join(&job.id);
    let home = job_root.join("home");
    let folder = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game)
        .unwrap_or("base");
    user_files::valid_folder(folder)?;
    let mod_dir = home.join(folder);
    fs::create_dir_all(mod_dir.join("demos"))
        .map_err(|e| AppError::io_path("cannot create capture workspace", &home, e))?;
    // Stage only client-owned enabled pk3 dependencies. Retail files remain on
    // fs_cdpath and engine modules remain on fs_basepath.
    let client_home = paths.client_home_dir(&client.id);
    for source in appearance::preview_sources(&paths, &settings, &client) {
        let Ok(relative) = source.strip_prefix(&client_home) else {
            continue;
        };
        let target = home.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::io_path("cannot stage capture assets", parent, e))?;
        }
        if fs::hard_link(&source, &target).is_err() {
            fs::copy(&source, &target)
                .map_err(|e| AppError::io_path("cannot stage capture assets", &target, e))?;
        }
    }
    let demo_name = format!("jknet-{}.{}", demo.id, demo.extension);
    fs::copy(
        media::media_file(state, demo)?,
        mod_dir.join("demos").join(&demo_name),
    )
    .map_err(|e| AppError::io_path("cannot stage capture demo", &mod_dir, e))?;
    let executable = paths.client_engine_dir(&client.id).join(engine.executable);
    if !executable.is_file() {
        return Err(AppError::NotFound("jaMME is not installed".into()));
    }
    let engine_dir = paths.client_engine_dir(&client.id);
    let game_data = PathBuf::from(settings.require_game_data_path(client.game)?);
    user_files::write_bytes(
        &mod_dir.join("jknet-render.cfg"),
        options.commands.as_bytes(),
    )?;
    // autoexec runs before renderer/input initialization. Keep startup options
    // in a file: jaMME silently drops commands after 32 '+' segments.
    user_files::write_bytes(
        &mod_dir.join("autoexec.cfg"),
        capture_config(options).as_bytes(),
    )?;
    let extra = capture_args(&demo_name, options);
    let args = launch::build_launch_args(&launch::LaunchPlan {
        game: client.game,
        game_data: &game_data,
        engine_dir: &engine_dir,
        base_dir: &engine_dir,
        home_dir: &home,
        fs_game: Some(folder),
        settings_args: &[],
        client_args: &[],
        profile_args: &[],
        extra_args: &extra,
        connect: None,
    });
    let log_path = job_root.join("capture.log");
    let log = fs::File::create(&log_path)
        .map_err(|e| AppError::io_path("cannot create capture log", &log_path, e))?;
    let mut command = Command::new(&executable);
    command
        .current_dir(&engine_dir)
        .args(&args)
        .stdout(
            log.try_clone()
                .map_err(|e| AppError::io_path("cannot clone capture log", &log_path, e))?,
        )
        .stderr(log);
    update("capturing", VideoProgress::default());
    let mut meter = CaptureProgress::default();
    let mut captured = VideoProgress::default();
    run_watched(
        &mut command,
        cancel,
        Some(&mod_dir.join("qconsole.log")),
        || {
            let mut files = Vec::new();
            collect(&mod_dir.join("capture"), "avi", 5, &mut files);
            captured = meter.sample(&files, options.fps);
            update("capturing", captured.clone());
        },
    )?;
    let mut output = Vec::new();
    collect(&mod_dir.join("capture"), "avi", 5, &mut output);
    output.sort();
    if output.is_empty() {
        return Err(AppError::Launch(format!(
            "jaMME produced no video. Check the map/mod dependencies and {}",
            log_path.display()
        )));
    }
    update("encoding", captured.clone());
    let item = encode_video(
        state,
        demo,
        &encoder,
        &output,
        &job_root,
        &options.format,
        cancel,
        &mut |path| {
            let (seconds, percent) = encoder_sample(path, captured.captured_seconds);
            captured.encoded_seconds = seconds;
            captured.encoding_percent = percent;
            update("encoding", captured.clone());
        },
    )?;
    update("finalizing", captured);
    let id = item.id.clone();
    {
        let _guard = state.client_records().enter();
        let index_path = paths.root.join("media/index.json");
        let mut book: MediaBook = user_files::read(&index_path)?;
        book.items.push(item);
        user_files::write(&index_path, &book)?;
    }
    // Only completed, job-owned intermediate AVI files are removed.
    for file in output {
        if file.starts_with(&job_root) {
            let _ = fs::remove_file(file);
        }
    }
    Ok(vec![id])
}

#[allow(clippy::too_many_arguments)]
fn encode_video(
    state: &AppState,
    demo: &MediaItem,
    encoder: &Path,
    sources: &[PathBuf],
    workspace: &Path,
    format: &str,
    cancel: &Cancellation,
    update: &mut impl FnMut(&Path),
) -> Result<MediaItem> {
    let mut item = MediaItem {
        id: user_files::id(),
        name: demo.name.clone(),
        kind: "videos".into(),
        game: demo.game,
        extension: format.into(),
        tags: demo.tags.clone(),
        origins: demo.origins.clone(),
        size: 0,
        preview: None,
        source_demo: Some(demo.id.clone()),
        file_name: None,
    };
    let target = media::media_file(state, &item)?;
    fs::create_dir_all(target.parent().unwrap())
        .map_err(|e| AppError::io_path("cannot create video bank", &target, e))?;
    let list = workspace.join("segments.txt");
    user_files::write_bytes(&list, concat_list(sources).as_bytes())?;
    let mut encode = Command::new(encoder);
    encode
        .args(["-nostdin", "-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-map", "0:v:0", "-map", "0:a?", "-pix_fmt", "yuv420p"]);
    if format == "webm" {
        encode.args([
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "30",
            "-b:v",
            "0",
            "-deadline",
            "good",
            "-cpu-used",
            "4",
            "-c:a",
            "libopus",
        ]);
    } else {
        encode.args([
            "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-c:a", "aac",
        ]);
        if format == "mp4" {
            encode.args(["-movflags", "+faststart"]);
        }
    }
    let log_path = workspace.join("encode.log");
    let log = fs::File::create(&log_path)
        .map_err(|e| AppError::io_path("cannot create encoder log", &log_path, e))?;
    let progress_path = workspace.join("encode-progress.txt");
    encode
        .args(["-nostats", "-progress"])
        .arg(&progress_path)
        .arg(&target)
        .stdout(Stdio::null())
        .stderr(log);
    if let Err(error) = run_watched(&mut encode, cancel, None, || update(&progress_path)) {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    item.size = fs::metadata(&target)
        .map_err(|e| AppError::io_path("cannot inspect video", &target, e))?
        .len();
    if item.size < 1024 {
        let _ = fs::remove_file(&target);
        return Err(AppError::Launch("encoder produced an empty video".into()));
    }
    if format == "mkv" {
        let preview = state
            .paths()?
            .cache
            .join("videos")
            .join(format!("{}.mp4", item.id));
        fs::create_dir_all(preview.parent().unwrap())
            .map_err(|e| AppError::io_path("cannot create video preview", &preview, e))?;
        let mut remux = Command::new(encoder);
        remux
            .args(["-nostdin", "-y", "-i"])
            .arg(&target)
            .args(["-c", "copy", "-movflags", "+faststart"])
            .arg(&preview)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        run(&mut remux, cancel)?;
    }
    Ok(item)
}

fn concat_list(sources: &[PathBuf]) -> String {
    sources
        .iter()
        .map(|p| {
            format!(
                "file '{}'\n",
                p.to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', "'\\''")
            )
        })
        .collect()
}
fn demo_finished(log: &str) -> bool {
    log.lines()
        .any(|line| line.trim() == "DISCONNECTED" || line.contains("Disconnected from server"))
}

fn capture_config(settings: &VideoSettings) -> String {
    let mut config = String::new();
    for (name, value) in [
        ("r_fullscreen", "0"),
        ("r_mode", "-1"),
        ("r_customwidth", "1280"),
        ("r_customheight", "720"),
        ("r_centerWindow", "0"),
        // A hidden desktop shares the window station cursor. Disable input
        // before IN_Init, not by releasing the user's cursor from the launcher.
        ("in_mouse", "0"),
        ("in_joystick", "0"),
        ("in_midi", "0"),
        ("mme_aviFormat", "1"),
        ("r_ignorehwgamma", "1"),
        ("r_gamma", "1"),
        ("mme_renderWidth", "0"),
        ("mme_renderHeight", "0"),
        ("mme_demoConvert", "0"),
        ("mme_screenShotFormat", "avi"),
        ("mme_saveWav", "2"),
        ("mme_saveShot", "1"),
        ("mme_blurFrames", "0"),
        ("mov_captureName", "jknet"),
        ("s_initsound", "1"),
        ("s_muteWhenMinimized", "0"),
        ("nextdemo", "quit"),
        ("logfile", "2"),
    ] {
        config.push_str(&format!("set {name} \"{value}\"\n"));
    }
    config.push_str(&format!("set cg_fov \"{}\"\n", settings.fov));
    config
}
fn capture_args(demo: &str, settings: &VideoSettings) -> Vec<String> {
    vec![
        "+set".into(),
        "in_mouse".into(),
        "0".into(),
        "+exec".into(),
        "jknet-render.cfg".into(),
        "+set".into(),
        "in_mouse".into(),
        "0".into(),
        "+set".into(),
        "cl_avidemo".into(),
        settings.fps.to_string(),
        "+demo".into(),
        demo.into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleting_the_source_is_blocked_until_rendering_finishes() {
        let videos = VideoState::default();
        videos.0.lock().unwrap().insert(
            "job".into(),
            Job {
                view: VideoJob {
                    id: "job".into(),
                    demo_id: "demo".into(),
                    client_id: "client".into(),
                    status: "rendering".into(),
                    error: None,
                    video_ids: Vec::new(),
                    phase: "preparing".into(),
                    demo_name: "Demo".into(),
                    elapsed_seconds: 0,
                    progress: VideoProgress::default(),
                },
                cancel: Arc::new(Cancellation::default()),
                started: Instant::now(),
            },
        );
        let called = std::cell::Cell::new(false);
        assert!(videos
            .with_idle_media(
                &BTreeSet::from(["demo".into(), "another-item".into()]),
                || {
                    called.set(true);
                    Ok(())
                }
            )
            .is_err());
        assert!(!called.get());
        assert!(videos
            .with_idle_media(&BTreeSet::from(["another-item".into()]), || Ok(()))
            .is_ok());
        videos.0.lock().unwrap().get_mut("job").unwrap().view.status = "cancelled".into();
        assert!(videos
            .with_idle_media(
                &BTreeSet::from(["demo".into(), "another-item".into()]),
                || Ok(())
            )
            .is_ok());
    }
    #[test]
    fn detects_demo_end_without_matching_configuration() {
        assert!(!demo_finished("nextdemo quit\nDISCONNECTED_MENU\n"));
        assert!(demo_finished("Not recording a demo.\nDISCONNECTED\n"));
    }
    #[test]
    #[ignore = "requires isolated QA client, retail assets and demo"]
    fn capture_fixture_on_private_desktop() {
        let root =
            PathBuf::from(std::env::var("JKNET_CAPTURE_QA_ROOT").expect("explicit fixture root"));
        assert!(root.to_string_lossy().contains("capture-qa"));
        let state = AppState::bootstrap(root);
        let demo = media::find_item(&state, "3954a03571bd8531b169a2ba2451edf4236d521e").unwrap();
        let job = VideoJob {
            id: user_files::id(),
            demo_id: demo.id.clone(),
            client_id: "demos".into(),
            status: "rendering".into(),
            error: None,
            video_ids: Vec::new(),
            phase: "preparing".into(),
            demo_name: demo.name.clone(),
            elapsed_seconds: 0,
            progress: VideoProgress::default(),
        };
        let cancel = Arc::new(Cancellation::default());
        let watchdog = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(300));
            watchdog.stop();
        });
        println!("Job {}", job.id);
        let options = VideoSettings {
            fps: 30,
            fov: 110,
            commands: "cg_draw2D 0\necho JKNET_RENDER_COMMANDS_APPLIED\ncg_fov\n".into(),
            ..Default::default()
        };
        let ids = capture(&state, &job, &demo, &options, &cancel, |phase, progress| {
            if progress.frames % 120 < 5 {
                println!(
                    "Phase: {phase}, frames {}, encoded {:?}",
                    progress.frames, progress.encoding_percent
                );
            }
        })
        .unwrap();
        println!("Video: {}", ids[0]);
        assert_eq!(ids.len(), 1);
    }
    #[test]
    fn capture_uses_regular_demo_player_and_stops_at_end() {
        let a = capture_args("jknet-test.dm_26", &VideoSettings::default());
        let config = capture_config(&VideoSettings::default());
        assert!(config.contains("set mme_demoConvert \"0\""));
        assert!(config.contains("set nextdemo \"quit\""));
        assert_eq!(&a[a.len() - 2..], ["+demo", "jknet-test.dm_26"]);
        assert!(a.windows(3).any(|v| v == ["+set", "in_mouse", "0"]));
        assert!(config.contains("set cg_fov \"100\""));
        assert!(a.iter().filter(|v| v.starts_with('+')).count() < 10);
        assert!(a.windows(2).any(|v| v == ["+exec", "jknet-render.cfg"]));
    }
}
