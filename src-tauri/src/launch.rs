//! Starting a client.
//!
//! The launcher runs the engine executable itself. Steam is never in the
//! chain, and the game folder stays read only: JKNet reads
//! `base\assets0.pk3`..`assets3.pk3` from it and writes nothing.
//!
//! ## The three search paths
//!
//! An engine built from the Quake 3 tree looks for its files in three roots
//! and prefers the last one that answers (`codemp/qcommon/files.cpp` of
//! OpenJK, `FS_Startup`):
//!
//! ```text
//! fs_cdpath   <GameData>                 the player's retail archives
//! fs_basepath <clients\<slug>\engine>    the build JKNet unpacked
//! fs_homepath <clients\<slug>\home>      configs, screenshots, downloads
//! ```
//!
//! The layout matters. Every engine ships its own `base\cgamex86.dll`,
//! `uix86.dll` and `jampgamex86.dll` inside its archive, and those must win
//! over the 1.01 modules that sit in the retail `base`; the retail folder is
//! not writable by JKNet, so the engine cannot be copied into it. Pointing
//! `fs_basepath` at the unpacked build and `fs_cdpath` at the game gives the
//! engine its own modules and the player's assets at once. `fs_copyfiles`
//! stays at its default of 0, so nothing is ever written back to the game.
//!
//! ## One game at a time
//!
//! [`LaunchState`] holds the child process. A second launch is refused while
//! the first one lives, `get_running_game` tells the interface what is up, and
//! `stop_game` kills it. A watcher thread turns the exit into
//! `launch:game-exited`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::clients;
use crate::engines;
use crate::error::{AppError, Result};
use crate::game_files;
use crate::state::AppState;
use crate::timestamp;

/// How often the watcher thread asks whether the game is still there.
const WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// Emitted right after the process starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStarted {
    pub client_id: String,
    pub pid: u32,
}

/// Emitted once the process is gone, however it went.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameExited {
    pub client_id: String,
    /// Exit code, `None` when the process was killed by a signal or the code
    /// could not be read.
    pub exit_code: Option<i32>,
}

/// What `get_running_game` answers with.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub client_id: String,
    pub pid: u32,
    /// Start time in RFC 3339, so the interface can count the session.
    pub started_at: String,
}

/// The one game JKNet started, if any.
///
/// Managed by Tauri next to [`AppState`]; a separate type rather than a field
/// so that a process handle never sits behind the settings lock.
#[derive(Default)]
pub struct LaunchState {
    running: Mutex<Option<Running>>,
}

struct Running {
    view: RunningGame,
    child: Child,
}

impl LaunchState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Running>>> {
        self.running
            .lock()
            .map_err(|_| AppError::State("the running game lock is poisoned".into()))
    }

    /// The game as the interface sees it, or `None`.
    pub fn current(&self) -> Result<Option<RunningGame>> {
        Ok(self.lock()?.as_ref().map(|running| running.view.clone()))
    }
}

// ---------------------------------------------------------------------------
// Building the command line
// ---------------------------------------------------------------------------

/// Everything [`build_launch_args`] needs, resolved from disk beforehand.
#[derive(Debug, Clone)]
pub struct LaunchPlan<'a> {
    /// The `GameData` folder that holds `base\assets0.pk3`.
    pub game_data: &'a Path,
    /// `clients\<slug>\engine`, where the executable lives.
    pub engine_dir: &'a Path,
    /// `clients\<slug>\home`, the writable root of the client.
    pub home_dir: &'a Path,
    /// Mod folder, already resolved from the client and the engine.
    pub fs_game: Option<&'a str>,
    /// Tokens from the settings, already split.
    pub settings_args: &'a [String],
    /// Tokens the caller passed for this run only.
    pub extra_args: &'a [String],
    /// `address:port` of a server to join straight away.
    pub connect: Option<&'a str>,
}

/// Builds the argument list of the engine process.
///
/// Every token is its own item: `std::process::Command` quotes what needs
/// quoting on Windows, and a hand-built string is how a path with a space
/// turns into two arguments.
///
/// Order is deliberate. The three roots come first because the engine reads
/// them once at startup, then `fs_game`, then the player's own tokens (which
/// may override anything above), then `+connect`, which must be the last
/// command so the console runs it after everything is set.
pub fn build_launch_args(plan: &LaunchPlan<'_>) -> Vec<String> {
    let mut args = Vec::new();
    let mut set = |name: &str, value: String| {
        args.push("+set".to_string());
        args.push(name.to_string());
        args.push(value);
    };

    set("fs_cdpath", plan.game_data.display().to_string());
    set("fs_basepath", plan.engine_dir.display().to_string());
    set("fs_homepath", plan.home_dir.display().to_string());
    if let Some(fs_game) = plan.fs_game.map(str::trim).filter(|v| !v.is_empty()) {
        set("fs_game", fs_game.to_string());
    }

    args.extend(plan.settings_args.iter().cloned());
    args.extend(plan.extra_args.iter().cloned());

    if let Some(address) = plan.connect.map(str::trim).filter(|v| !v.is_empty()) {
        args.push("+connect".to_string());
        args.push(address.to_string());
    }
    args
}

/// Splits a line of extra arguments the way a shell would.
///
/// Whitespace separates tokens, double quotes keep a group together, and a
/// quote inside a token ends there. Backslashes are left alone: this line is
/// full of Windows paths, and treating `\` as an escape would break every one
/// of them.
pub fn split_args(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;

    for ch in line.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        tokens.push(current);
    }
    tokens
}

/// Refuses an address that would smuggle extra console commands.
///
/// `+connect` takes one token. A value with whitespace in it would let the
/// rest of the line become commands of its own.
fn validate_address(address: &str) -> Result<&str> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("the server address is empty".into()));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::InvalidInput(format!(
            "the server address {trimmed} contains a space"
        )));
    }
    Ok(trimmed)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Starts the client, optionally connecting straight to a server.
#[tauri::command]
pub fn launch_client(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    launch: tauri::State<'_, LaunchState>,
    client_id: String,
    connect: Option<String>,
    extra_args: Option<Vec<String>>,
) -> Result<RunningGame> {
    if let Some(running) = launch.current()? {
        return Err(AppError::Launch(format!(
            "{} is already running (pid {}). Stop it first.",
            running.client_id, running.pid
        )));
    }

    let settings = state.settings()?;
    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    let engine = engines::require(&client.engine_id)?;

    let game_data = settings.game_data_path.as_deref().ok_or_else(|| {
        AppError::Launch(
            "the game folder is not set. Pick it on the Clients screen first.".into(),
        )
    })?;
    let game_data = PathBuf::from(game_data);
    game_files::validate(&game_data)?;

    let client_dir = paths.client_dir(&client.id);
    let engine_dir = client_dir.join("engine");
    let home_dir = client_dir.join("home");
    let executable = engine_dir.join(engine.executable);
    if !executable.is_file() {
        return Err(AppError::Launch(format!(
            "{} is not installed for {}. Install the engine on the Clients screen.",
            engine.name, client.name
        )));
    }
    // The engine creates the rest itself, but it will not create its root.
    crate::paths::create_dir(&home_dir)?;

    let connect = match connect.as_deref() {
        Some(address) => Some(validate_address(address)?),
        None => None,
    };
    let settings_args = split_args(&settings.extra_launch_args);
    let extra_args = extra_args.unwrap_or_default();
    let fs_game = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game);

    let args = build_launch_args(&LaunchPlan {
        game_data: &game_data,
        engine_dir: &engine_dir,
        home_dir: &home_dir,
        fs_game,
        settings_args: &settings_args,
        extra_args: &extra_args,
        connect,
    });

    log::info!(
        "launching {}: {} {}",
        client.id,
        executable.display(),
        args.join(" ")
    );

    let child = spawn(&executable, &engine_dir, &args)?;
    let view = RunningGame {
        client_id: client.id.clone(),
        pid: child.id(),
        started_at: timestamp::now_rfc3339(),
    };
    *launch.lock()? = Some(Running {
        view: view.clone(),
        child,
    });

    if let Err(e) = app.emit(
        "launch:game-started",
        GameStarted {
            client_id: view.client_id.clone(),
            pid: view.pid,
        },
    ) {
        log::warn!("cannot emit launch:game-started: {e}");
    }
    watch(app, view.client_id.clone());
    Ok(view)
}

/// Returns the game JKNet started, or `null`.
#[tauri::command]
pub fn get_running_game(launch: tauri::State<'_, LaunchState>) -> Result<Option<RunningGame>> {
    launch.current()
}

/// Kills the running game. Doing nothing is not an error: the button exists to
/// make sure no game is running, and a game that already exited satisfies that.
#[tauri::command]
pub fn stop_game(launch: tauri::State<'_, LaunchState>) -> Result<()> {
    let mut guard = launch.lock()?;
    let Some(running) = guard.as_mut() else {
        return Ok(());
    };
    log::info!("stopping {} (pid {})", running.view.client_id, running.view.pid);
    running
        .child
        .kill()
        .map_err(|e| AppError::Launch(format!("cannot stop the game: {e}")))?;
    // The watcher clears the slot and emits `launch:game-exited`.
    Ok(())
}

// ---------------------------------------------------------------------------
// The process itself
// ---------------------------------------------------------------------------

/// Starts the engine with no console of its own and no pipes to the launcher.
///
/// The standard streams go to the void on purpose: an engine that writes more
/// than the pipe buffer would block forever on a reader that never comes.
fn spawn(executable: &Path, working_dir: &Path, args: &[String]) -> Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW`: no console flashes up behind the game.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|e| {
        AppError::Launch(format!("cannot start {}: {e}", executable.display()))
    })
}

/// Watches the child in a plain thread and reports the exit once.
///
/// Polling rather than `wait()`, because the same handle has to stay reachable
/// for `stop_game` and `Child` cannot be shared any other way. The thread
/// reaches the managed state through the `AppHandle`, which is the only
/// borrow of it that may outlive a command.
fn watch(app: AppHandle, client_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_INTERVAL);
        let launch = app.state::<LaunchState>();
        let Ok(mut guard) = launch.running.lock() else {
            log::error!("the running game lock is poisoned, stopping the watcher");
            return;
        };
        let Some(running) = guard.as_mut() else {
            return; // stop_game or a later launch cleared the slot
        };
        if running.view.client_id != client_id {
            return; // a later launch owns the slot now
        }

        let exit_code = match running.child.try_wait() {
            Ok(None) => continue,
            Ok(Some(status)) => status.code(),
            Err(e) => {
                log::error!("cannot watch {client_id}: {e}");
                None
            }
        };
        *guard = None;
        drop(guard);

        log::info!("{client_id} exited with {exit_code:?}");
        if let Err(e) = app.emit(
            "launch:game-exited",
            GameExited {
                client_id: client_id.clone(),
                exit_code,
            },
        ) {
            log::warn!("cannot emit launch:game-exited: {e}");
        }
        return;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan<'a>(
        game_data: &'a Path,
        engine_dir: &'a Path,
        home_dir: &'a Path,
    ) -> LaunchPlan<'a> {
        LaunchPlan {
            game_data,
            engine_dir,
            home_dir,
            fs_game: None,
            settings_args: &[],
            extra_args: &[],
            connect: None,
        }
    }

    #[test]
    fn the_three_roots_come_first_and_each_token_is_its_own_argument() {
        let args = build_launch_args(&plan(
            Path::new("D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData"),
            Path::new("C:\\JKNet\\clients\\everyday\\engine"),
            Path::new("C:\\JKNet\\clients\\everyday\\home"),
        ));
        assert_eq!(
            args,
            vec![
                "+set",
                "fs_cdpath",
                "D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData",
                "+set",
                "fs_basepath",
                "C:\\JKNet\\clients\\everyday\\engine",
                "+set",
                "fs_homepath",
                "C:\\JKNet\\clients\\everyday\\home",
            ]
        );
    }

    #[test]
    fn a_path_with_spaces_stays_one_argument() {
        let args = build_launch_args(&plan(
            Path::new("C:\\Program Files (x86)\\Jedi Academy\\GameData"),
            Path::new("C:\\Users\\Ben Kenobi\\JKNet\\clients\\duel\\engine"),
            Path::new("C:\\Users\\Ben Kenobi\\JKNet\\clients\\duel\\home"),
        ));
        assert_eq!(args[2], "C:\\Program Files (x86)\\Jedi Academy\\GameData");
        assert!(!args[2].contains('"'), "quoting is the job of Command");
        assert_eq!(args.len(), 9);
    }

    #[test]
    fn fs_game_appears_only_when_the_client_has_one() {
        let game = Path::new("D:\\GameData");
        let engine = Path::new("C:\\JKNet\\clients\\mme\\engine");
        let home = Path::new("C:\\JKNet\\clients\\mme\\home");

        let without = build_launch_args(&plan(game, engine, home));
        assert!(!without.iter().any(|arg| arg == "fs_game"));

        let mut with = plan(game, engine, home);
        with.fs_game = Some("mme");
        let args = build_launch_args(&with);
        assert_eq!(&args[9..12], ["+set", "fs_game", "mme"]);

        // A blank value is the same as no value.
        let mut blank = plan(game, engine, home);
        blank.fs_game = Some("   ");
        assert!(!build_launch_args(&blank)
            .iter()
            .any(|arg| arg == "fs_game"));
    }

    #[test]
    fn connect_is_last_and_settings_come_before_the_client_arguments() {
        let game = Path::new("D:\\GameData");
        let engine = Path::new("C:\\JKNet\\clients\\duel\\engine");
        let home = Path::new("C:\\JKNet\\clients\\duel\\home");
        let settings_args = vec!["+set".to_string(), "r_mode".to_string(), "-1".to_string()];
        let extra_args = vec!["+set".to_string(), "name".to_string(), "Kyle".to_string()];

        let mut with = plan(game, engine, home);
        with.fs_game = Some("japlus");
        with.settings_args = &settings_args;
        with.extra_args = &extra_args;
        with.connect = Some("jkhub.org:29070");

        let args = build_launch_args(&with);
        let tail = &args[12..];
        assert_eq!(
            tail,
            [
                "+set",
                "r_mode",
                "-1",
                "+set",
                "name",
                "Kyle",
                "+connect",
                "jkhub.org:29070"
            ]
        );
    }

    #[test]
    fn a_blank_address_is_left_out() {
        let game = Path::new("D:\\GameData");
        let engine = Path::new("C:\\e");
        let home = Path::new("C:\\h");
        let mut with = plan(game, engine, home);
        with.connect = Some("  ");
        assert!(!build_launch_args(&with).iter().any(|arg| arg == "+connect"));
    }

    #[test]
    fn extra_arguments_split_like_a_shell() {
        assert_eq!(split_args(""), Vec::<String>::new());
        assert_eq!(split_args("   "), Vec::<String>::new());
        assert_eq!(
            split_args("+set r_mode -1"),
            vec!["+set", "r_mode", "-1"]
        );
        assert_eq!(
            split_args("  +set   com_hunkMegs   512  "),
            vec!["+set", "com_hunkMegs", "512"]
        );
    }

    #[test]
    fn a_quoted_group_stays_one_token() {
        assert_eq!(
            split_args("+set fs_extraGames \"japlus japp\""),
            vec!["+set", "fs_extraGames", "japlus japp"]
        );
        assert_eq!(
            split_args("+set name \"Ben Kenobi\" +set cg_fov 97"),
            vec!["+set", "name", "Ben Kenobi", "+set", "cg_fov", "97"]
        );
        // An empty quoted value is a value, not a missing token.
        assert_eq!(split_args("+set rconpassword \"\""), vec!["+set", "rconpassword", ""]);
    }

    #[test]
    fn a_windows_path_survives_the_split() {
        assert_eq!(
            split_args("+set fs_dirbeforepak \"C:\\Games\\My Mods\""),
            vec!["+set", "fs_dirbeforepak", "C:\\Games\\My Mods"]
        );
    }

    #[test]
    fn an_address_with_a_space_is_refused() {
        assert!(validate_address("127.0.0.1:29070").is_ok());
        assert_eq!(validate_address("  jkhub.org:29070 ").unwrap(), "jkhub.org:29070");
        assert!(validate_address("").is_err());
        assert!(validate_address("   ").is_err());
        assert!(validate_address("127.0.0.1:29070 +quit").is_err());
    }
}
