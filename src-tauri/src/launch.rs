//! Starting a client.
//!
//! The launcher runs the engine executable itself. Steam is never in the
//! chain, and the game folder stays read only: JKNet reads the retail
//! archives out of its `base` and writes nothing.
//!
//! ## The three search paths of a Jedi Academy client
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
//! `fs_basepath` at the unpacked build and the game data root at the game
//! gives the engine its own modules and the player's assets at once.
//! `fs_copyfiles` stays at its default of 0, so nothing is ever written back
//! to the game.
//!
//! ## The base root of a Jedi Outcast client
//!
//! --- slice: game core ---
//! JK2MV cannot be told where the retail archives are. It registers a cvar
//! that looks like the answer and then builds its search path from something
//! else (`mvdevs/jk2mv`, tag `1.4.1`, `src/qcommon/files.cpp:3257`):
//!
//! ```text
//! assetsPath = Sys_DefaultAssetsPath();
//! fs_assetspath = Cvar_Get("fs_assetspath", assetsPath ? assetsPath : "", CVAR_INIT | CVAR_VM_NOWRITE);
//!
//! if (!FS_AllPath_Base_FileExists("assets5.pk3")) {
//!     Com_Error(ERR_FATAL, "could not find assets(0,1,2,5).pk3 files... copy them into the base directory.");
//! }
//!
//! // don't use the assetspath if assets files already found in fs_basepath or fs_homepath
//! if (assetsPath && !FS_BaseHome_Base_FileExists("assets5.pk3")) {
//!     FS_AddGameDirectory(assetsPath, BASEGAME, qtrue);
//! }
//! ```
//!
//! `assetsPath` is the local from `Sys_DefaultAssetsPath()` — registry
//! auto-detection, and `Sys_Cwd()` in the portable build JKNet installs. The
//! cvar is written and never read. Worse, the pre-flight check above looks
//! only at `fs_basepath\base` and `fs_homepath\base`: its `fs_assetspath`
//! branch is compiled out under `#if !defined(PORTABLE)` (`files.cpp:699`).
//! A Steam copy on another drive therefore killed the engine with
//! «could not find assets(0,1,2,5).pk3 files» however carefully
//! `fs_assetspath` was set. Only the current `master` uses
//! `fs_assetspath->string`.
//!
//! A second 1.4.1 rule pulls in the same direction. `CL_InitUI` creates the
//! JK2MV menu as a native module, `VM_Create("jk2mvmenu", qtrue, …)`, and
//! `Sys_LoadModuleLibrary` with that override flag tries a single path,
//! `<fs_basepath>\jk2mvmenu_<arch>.dll` (`src/sys/sys_win32.cpp`). With the
//! game folder on `fs_basepath` the engine died on «Failed loading library
//! file: jk2mvmenu», and the cure of the previous attempt —
//! `+set mv_menuOverride 1` — only moved the funeral: the engine then loads
//! MVSDK's `vm/ui.qvm` out of `assetsmv.pk3` as the main menu and dies on
//! «MVSDK: Unable to detect jk2version [UI]», because the MV API is not
//! negotiated on that path.
//!
//! Both rules say the same thing: `fs_basepath` has to be a folder JKNet owns
//! *and* the retail archives have to be under it. So the launcher builds one:
//!
//! ```text
//! clients\<slug>\basepath\              fs_basepath, built by prepare_basepath
//!   jk2mvmenu_x64.dll                   copied from engine\, loaded by name
//!   base  →  <GameData>\base            NTFS directory junction, read only
//! clients\<slug>\engine\                the unpacked build; working directory
//! clients\<slug>\home\                  fs_homepath: assetsmv*.pk3, pk3, configs
//! ```
//!
//! ```text
//! fs_assetspath <GameData>                    sent, ignored by 1.4.1, right for master
//! fs_basepath   <clients\<slug>\basepath>     menu module, and base → the game's base
//! fs_homepath   <clients\<slug>\home>         configs, screenshots, downloads,
//!                                             and the engine's own base\*.pk3
//! ```
//!
//! The engine then finds `assets5.pk3` through the junction, which also stops
//! it from adding the auto-detected assets path a second time, and it finds
//! `jk2mvmenu_x64.dll` by the single name it looks for.
//!
//! Nothing is written into the game folder. A junction is a read path here:
//! JKNet writes to `basepath\` only the modules it copies there, the engine
//! writes through `fs_homepath`, and `fs_copyfiles` stays 0. [`prepare_basepath`]
//! has the rules that keep the link safe, and it never deletes a real folder.
//!
//! `clients\<slug>\engine\` is off the search path in this layout, so the
//! archives JK2MV ships there — `base\assetsmv.pk3` and `base\assetsmv2.pk3` —
//! are mirrored into `clients\<slug>\home\base\` before the game starts.
//! [`crate::engine_install::sync_engine_archives`] does that, from here on
//! every launch and from the installer on every install, so a client made
//! before this fix repairs itself.
//!
//! `clients\<slug>\engine\` is the working directory of the process in both
//! games, so `SDL2.dll` and the rest sit next to the binary that loads them.
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
use crate::engine_install;
use crate::engines;
use crate::error::{AppError, Result};
use crate::game::{Game, LaunchLayout};
use crate::game_files;
use crate::state::AppState;
use crate::timestamp;

/// How often the watcher thread asks whether the game is still there.
const WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// Emitted right after the process starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStarted {
    pub client_id: String,
    pub pid: u32,
    // --- slice: friends ---
    /// The `+connect` address, when the game was started to join a server.
    /// `None` means the Play button: the game opens on its main menu, and
    /// there is no server to tell anybody about.
    #[serde(default)]
    pub connect: Option<String>,
}

/// Emitted once the process is gone, however it went.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    // --- slice: game core ---
    /// Which game is starting. Decides the layout of the roots below.
    pub game: Game,
    /// The `GameData` folder that holds `base\assets0.pk3`.
    pub game_data: &'a Path,
    /// `clients\<slug>\engine`, where the executable lives.
    pub engine_dir: &'a Path,
    /// `clients\<slug>\basepath`, the launcher-owned base root. Read only in
    /// the [`LaunchLayout::OwnBasepath`] layout, and [`prepare_basepath`] has
    /// already built it by the time the arguments are assembled.
    pub base_dir: &'a Path,
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
/// Order is deliberate. The roots come first because the engine reads them once
/// at startup, then `fs_game`, then the player's own tokens (which may override
/// anything above), then `+connect`, which must be the last command so the
/// console runs it after everything is set.
///
/// --- slice: game core ---
/// The roots come from the game's own spec, because the two engines disagree
/// about what they will listen to. Jedi Academy hands `fs_basepath` to the
/// unpacked build and names the game folder with `fs_cdpath`; Jedi Outcast
/// hands `fs_basepath` to the client's own `basepath\`, whose `base` is a
/// junction to the game's. Either way `fs_homepath` is the client's `home\`,
/// three roots go out, and the tail of the command line is identical. The
/// module docs quote the JK2MV source that forces the split.
pub fn build_launch_args(plan: &LaunchPlan<'_>) -> Vec<String> {
    let spec = plan.game.spec();
    let mut args = Vec::new();
    let mut set = |name: &str, value: String| {
        args.push("+set".to_string());
        args.push(name.to_string());
        args.push(value);
    };

    // Sent in both layouts. Under `EngineIsBasepath` it *is* the game data
    // root; under `OwnBasepath` it is a note for the engine build that starts
    // reading it, and one ignored token in the one that does not.
    if let Some(cvar) = spec.game_data_cvar {
        set(cvar, plan.game_data.display().to_string());
    }
    let base_path = match spec.launch_layout {
        LaunchLayout::EngineIsBasepath => plan.engine_dir,
        LaunchLayout::OwnBasepath => plan.base_dir,
    };
    set("fs_basepath", base_path.display().to_string());
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
// The base root of a client that owns one
// ---------------------------------------------------------------------------

// --- slice: game core ---

/// Marker file that says `basepath\base` is a copy JKNet made, not a link.
///
/// It sits in `basepath\`, next to `base\`, so that nothing lands in a folder
/// the engine scans. Without it the two rules of [`prepare_basepath`] would
/// contradict each other on the second launch: the fallback below fills
/// `basepath\base` with real files, and a real folder there is otherwise the
/// one thing the function refuses to touch.
const COPIED_BASE_MARKER: &str = ".jknet-copied-base";

/// What the marker file says, for the player who opens it.
const COPIED_BASE_NOTE: &str = "\
JKNet could not link basepath\\base to the game's base folder on this disk, so
it copied the retail archives instead. Delete the whole basepath folder to make
JKNet build it again.
";

/// Builds `clients\<slug>\basepath\`, the `fs_basepath` of a client whose game
/// asks for one, and returns it.
///
/// Three steps, all idempotent, all cheap on the second run:
///
/// 1. Create the folder.
/// 2. Copy `<prefix>*.dll` out of `engine\` — the modules the engine loads
///    from `fs_basepath` by name rather than through its file system. The
///    prefix comes from [`crate::game::GameSpec::basepath_module_prefix`].
/// 3. Make `basepath\base` a directory junction to `<GameData>\base`.
///
/// ## What may happen to `basepath\base`, and what is done about it
///
/// | On disk | Answer |
/// | --- | --- |
/// | nothing | create the junction |
/// | a junction to the same folder | leave it alone |
/// | a junction elsewhere (the player moved the game) | `remove_dir`, create again |
/// | a real folder JKNet filled, marked by [`COPIED_BASE_MARKER`] | refresh the copies |
/// | any other real folder, or a file | [`AppError::BasepathOccupied`], touch nothing |
///
/// Removing a junction with [`std::fs::remove_dir`] deletes the link and
/// nothing else: Windows `RemoveDirectoryW` on a reparse point removes the
/// entry, not the target. That is the whole safety argument, and it is why the
/// last row of the table refuses instead of clearing the way — a real folder
/// there holds somebody's bytes, and JKNet has none of its own to put back.
///
/// A junction needs no elevation, unlike a symbolic link, so this runs as the
/// player. When it fails anyway — a FAT32 or exFAT disk, a network share, a
/// policy — the function copies the game's own archives into `basepath\base\`
/// and logs why. Hundreds of megabytes, which is why it is the fallback and
/// not the plan.
pub(crate) fn prepare_basepath(
    game: Game,
    client_dir: &Path,
    game_data: &Path,
) -> Result<PathBuf> {
    prepare_basepath_with(game, client_dir, game_data, make_junction)
}

/// The body of [`prepare_basepath`] with the junction call injected, so a test
/// can watch the fallback run on a machine where junctions work.
fn prepare_basepath_with(
    game: Game,
    client_dir: &Path,
    game_data: &Path,
    junction: fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<PathBuf> {
    let base_dir = client_dir.join(crate::paths::CLIENT_BASEPATH_DIR);
    crate::paths::create_dir(&base_dir)?;
    copy_basepath_modules(game, &client_dir.join(crate::paths::CLIENT_ENGINE_DIR), &base_dir)?;
    link_game_base(game, &base_dir, game_data, junction)?;
    Ok(base_dir)
}

/// Copies the modules the engine loads straight out of `fs_basepath`.
///
/// Matched by prefix and extension rather than by full name: the JK2MV archive
/// carries the module of its own architecture, and a build that ships both has
/// to hand over both. A game with no such module copies nothing.
fn copy_basepath_modules(game: Game, engine_dir: &Path, base_dir: &Path) -> Result<Vec<String>> {
    let Some(prefix) = game.spec().basepath_module_prefix else {
        return Ok(Vec::new());
    };
    // Both sides folded, because the table is written by hand and a release
    // may spell its own file `JK2MVmenu_x64.dll` any day it likes.
    let prefix = prefix.to_ascii_lowercase();
    let Ok(entries) = std::fs::read_dir(engine_dir) else {
        // No build unpacked yet. The launch path checks for the executable
        // itself and says so in a sentence the player can act on.
        return Ok(Vec::new());
    };

    let mut copied = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if !lower.starts_with(&prefix) || !lower.ends_with(".dll") {
            continue;
        }
        if engine_install::copy_if_changed(&entry.path(), &base_dir.join(&name))? {
            copied.push(name);
        }
    }
    if !copied.is_empty() {
        log::info!(
            "copied {} module(s) into {}: {}",
            copied.len(),
            base_dir.display(),
            copied.join(", ")
        );
    }
    Ok(copied)
}

/// Points `basepath\base` at `<GameData>\base`, by the table in
/// [`prepare_basepath`].
fn link_game_base(
    game: Game,
    base_dir: &Path,
    game_data: &Path,
    junction: fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    let link = base_dir.join(crate::paths::BASE_FOLDER);
    let target = game_data.join(crate::paths::BASE_FOLDER);

    match std::fs::symlink_metadata(&link) {
        // A link of some kind. Windows reports a junction as a symlink, which
        // is the property that matters here: `remove_dir` unlinks it.
        Ok(meta) if meta.file_type().is_symlink() => match junction_target(&link) {
            Some(current) if same_folder(&current, &target) => {
                log::debug!("{} already links to {}", link.display(), target.display());
                return Ok(());
            }
            current => {
                log::info!(
                    "{} links to {}, relinking it to {}",
                    link.display(),
                    current.as_deref().unwrap_or(Path::new("something else")).display(),
                    target.display()
                );
                std::fs::remove_dir(&link)
                    .map_err(|e| AppError::io_path("cannot unlink", &link, e))?;
            }
        },
        // The fallback of an earlier run: real files, and the launcher's own.
        Ok(meta) if meta.is_dir() && base_dir.join(COPIED_BASE_MARKER).is_file() => {
            return copy_game_archives(game, base_dir, game_data, None);
        }
        // A real folder or a file somebody else put there.
        Ok(_) => return Err(AppError::BasepathOccupied(link.display().to_string())),
        // Not there yet, which is the ordinary first launch.
        Err(_) => {}
    }

    match junction(&target, &link) {
        Ok(()) => {
            log::info!("linked {} to {}", link.display(), target.display());
            Ok(())
        }
        Err(e) => copy_game_archives(game, base_dir, game_data, Some(&e)),
    }
}

/// Fills `basepath\base\` with copies of the game's own archives.
///
/// The list is [`crate::game::GameSpec::assets`], so an archive a patch adds
/// and this copy does not have is skipped rather than missed. Files already
/// there with the same size and time are left alone, which makes the second
/// call free.
fn copy_game_archives(
    game: Game,
    base_dir: &Path,
    game_data: &Path,
    reason: Option<&std::io::Error>,
) -> Result<()> {
    let target_dir = base_dir.join(crate::paths::BASE_FOLDER);
    let source_dir = game_data.join(crate::paths::BASE_FOLDER);
    crate::paths::create_dir(&target_dir)?;

    let mut names = Vec::new();
    let mut bytes = 0u64;
    for asset in game.spec().assets {
        let source = source_dir.join(asset.name);
        let size = std::fs::metadata(&source).map(|meta| meta.len()).unwrap_or(0);
        if engine_install::copy_if_changed(&source, &target_dir.join(asset.name))? {
            names.push(asset.name);
            bytes += size;
        }
    }

    let marker = base_dir.join(COPIED_BASE_MARKER);
    if !marker.is_file() {
        std::fs::write(&marker, COPIED_BASE_NOTE)
            .map_err(|e| AppError::io_path("cannot write", &marker, e))?;
    }

    if let Some(reason) = reason {
        log::warn!(
            "cannot link {} to {}: {reason}. Copied {} archive(s), {} MB, instead: {}",
            target_dir.display(),
            source_dir.display(),
            names.len(),
            bytes / (1024 * 1024),
            names.join(", ")
        );
    } else if !names.is_empty() {
        log::info!(
            "refreshed {} copied archive(s) in {}: {}",
            names.len(),
            target_dir.display(),
            names.join(", ")
        );
    }
    Ok(())
}

/// Creates a directory junction from `link` to `target`.
///
/// The `junction` crate writes the reparse point itself through
/// `FSCTL_SET_REPARSE_POINT`, which needs no elevation and no `mklink`
/// subprocess. It creates the directory on the way, so `link` must not exist.
#[cfg(windows)]
fn make_junction(target: &Path, link: &Path) -> std::io::Result<()> {
    junction::create(target, link)
}

#[cfg(not(windows))]
fn make_junction(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "a directory junction is a Windows thing",
    ))
}

/// Where a junction points, or `None` for anything that is not one.
#[cfg(windows)]
fn junction_target(link: &Path) -> Option<PathBuf> {
    junction::exists(link)
        .ok()
        .filter(|yes| *yes)
        .and_then(|_| junction::get_target(link).ok())
}

#[cfg(not(windows))]
fn junction_target(_link: &Path) -> Option<PathBuf> {
    None
}

/// Whether two Windows paths name the same folder.
///
/// Compared as text, case-insensitively, with `/` folded to `\`, a `\\?\`
/// prefix dropped and a trailing separator ignored. Not [`std::fs::canonicalize`]:
/// a junction whose target has been deleted still has to compare — that is the
/// «the player moved the game» row of the table — and the stored target is
/// already what `GetFullPathNameW` made of the path JKNet passed.
fn same_folder(a: &Path, b: &Path) -> bool {
    fn key(path: &Path) -> String {
        let text = path.to_string_lossy().replace('/', "\\");
        let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
        text.trim_end_matches('\\').to_lowercase()
    }
    key(a) == key(b)
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
    start_client(
        &app,
        &state,
        &launch,
        &client_id,
        connect.as_deref(),
        &extra_args.unwrap_or_default(),
    )
}

/// The body of [`launch_client`], reachable from another module.
///
/// --- slice: friends ---
/// `join_friend` starts a game the same way the Play button does, and the
/// argument order in [`build_launch_args`] is the kind of thing that only
/// stays right while there is one copy of it.
pub(crate) fn start_client(
    app: &AppHandle,
    state: &AppState,
    launch: &LaunchState,
    client_id: &str,
    connect: Option<&str>,
    extra_args: &[String],
) -> Result<RunningGame> {
    if let Some(running) = launch.current()? {
        return Err(AppError::Launch(format!(
            "{} is already running (pid {}). Stop it first.",
            running.client_id, running.pid
        )));
    }

    let settings = state.settings()?;
    let paths = state.paths()?;
    let client = clients::read_record(&paths, client_id)?;
    // --- slice: game core ---
    // The engine of a record whose game was edited by hand is refused here
    // rather than started against the wrong archives.
    let engine = engines::require_for_game(&client.engine_id, client.game)?;

    let game_data = PathBuf::from(settings.require_game_data_path(client.game)?);
    game_files::validate(client.game, &game_data)?;

    let client_dir = paths.client_dir(&client.id);
    let engine_dir = paths.client_engine_dir(&client.id);
    let home_dir = paths.client_home_dir(&client.id);
    let executable = engine_dir.join(engine.executable);
    if !executable.is_file() {
        return Err(AppError::Launch(format!(
            "{} is not installed for {}. Install the engine on the Clients screen.",
            engine.name, client.name
        )));
    }
    // The engine creates the rest itself, but it will not create its root.
    crate::paths::create_dir(&home_dir)?;

    // --- slice: game core ---
    // Jedi Outcast leaves the unpacked build off the search path, so its own
    // archives have to be in `home\base\` before the process starts, and its
    // `fs_basepath` has to be built. Both steps are idempotent and both run on
    // every launch on purpose: a client installed before this fix repairs
    // itself without a reinstall, and a player who moved their game gets the
    // link redrawn.
    let layout = client.game.spec().launch_layout;
    if !layout.engine_dir_on_search_path() {
        engine_install::sync_engine_archives(&engine_dir, &home_dir)?;
    }
    let base_dir = if layout.needs_own_basepath() {
        prepare_basepath(client.game, &client_dir, &game_data)?
    } else {
        paths.client_basepath_dir(&client.id)
    };

    let connect = match connect {
        Some(address) => Some(validate_address(address)?),
        None => None,
    };
    let settings_args = split_args(&settings.extra_launch_args);
    let fs_game = client
        .fs_game
        .as_deref()
        .or(engine.default_fs_game);

    let args = build_launch_args(&LaunchPlan {
        game: client.game,
        game_data: &game_data,
        engine_dir: &engine_dir,
        base_dir: &base_dir,
        home_dir: &home_dir,
        fs_game,
        settings_args: &settings_args,
        extra_args,
        connect,
    });

    log::info!(
        "launching {} ({}): {} {}",
        client.id,
        client.game.display_name(),
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
            // --- slice: friends ---
            // The presence reporter reads the address from here: it is the
            // only place in the launcher that knows the game went to a server
            // rather than to its main menu.
            connect: connect.map(str::to_string),
        },
    ) {
        log::warn!("cannot emit launch:game-started: {e}");
    }
    watch(app.clone(), view.client_id.clone());
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
///
/// `working_dir` is `clients\<slug>\engine` for both games, and that is not
/// decoration: every build loads DLLs from next to its executable —
/// `jk2mvmenu_x64.dll` and `SDL2.dll` for JK2MV, `SDL2.dll` and `openal32.dll`
/// for the Jedi Academy forks — and a portable JK2MV also writes its crash log
/// there, which is where the report that started this fix came from.
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
        base_dir: &'a Path,
        home_dir: &'a Path,
    ) -> LaunchPlan<'a> {
        LaunchPlan {
            game: Game::JediAcademy,
            game_data,
            engine_dir,
            base_dir,
            home_dir,
            fs_game: None,
            settings_args: &[],
            extra_args: &[],
            connect: None,
        }
    }

    // --- slice: game core ---
    /// The same plan for the other game, whose engine names the game data root
    /// `fs_assetspath` instead of `fs_cdpath` and takes `fs_basepath` from the
    /// client's own base root.
    fn jo_plan<'a>(
        game_data: &'a Path,
        engine_dir: &'a Path,
        base_dir: &'a Path,
        home_dir: &'a Path,
    ) -> LaunchPlan<'a> {
        LaunchPlan {
            game: Game::JediOutcast,
            ..plan(game_data, engine_dir, base_dir, home_dir)
        }
    }

    #[test]
    fn the_three_roots_come_first_and_each_token_is_its_own_argument() {
        let args = build_launch_args(&plan(
            Path::new("D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData"),
            Path::new("C:\\JKNet\\clients\\everyday\\engine"),
            Path::new("C:\\JKNet\\clients\\everyday\\basepath"),
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
            Path::new("C:\\Users\\Ben Kenobi\\JKNet\\clients\\duel\\basepath"),
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
        let base = Path::new("C:\\JKNet\\clients\\mme\\basepath");
        let home = Path::new("C:\\JKNet\\clients\\mme\\home");

        let without = build_launch_args(&plan(game, engine, base, home));
        assert!(!without.iter().any(|arg| arg == "fs_game"));

        let mut with = plan(game, engine, base, home);
        with.fs_game = Some("mme");
        let args = build_launch_args(&with);
        assert_eq!(&args[9..12], ["+set", "fs_game", "mme"]);

        // A blank value is the same as no value.
        let mut blank = plan(game, engine, base, home);
        blank.fs_game = Some("   ");
        assert!(!build_launch_args(&blank)
            .iter()
            .any(|arg| arg == "fs_game"));
    }

    #[test]
    fn connect_is_last_and_settings_come_before_the_client_arguments() {
        let game = Path::new("D:\\GameData");
        let engine = Path::new("C:\\JKNet\\clients\\duel\\engine");
        let base = Path::new("C:\\JKNet\\clients\\duel\\basepath");
        let home = Path::new("C:\\JKNet\\clients\\duel\\home");
        let settings_args = vec!["+set".to_string(), "r_mode".to_string(), "-1".to_string()];
        let extra_args = vec!["+set".to_string(), "name".to_string(), "Kyle".to_string()];

        let mut with = plan(game, engine, base, home);
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
        let base = Path::new("C:\\b");
        let home = Path::new("C:\\h");
        let mut with = plan(game, engine, base, home);
        with.connect = Some("  ");
        assert!(!build_launch_args(&with).iter().any(|arg| arg == "+connect"));
    }

    // --- slice: game core ---

    #[test]
    fn a_jedi_outcast_client_hands_fs_basepath_to_its_own_base_root() {
        // JK2MV 1.4.1 registers `fs_assetspath` and never reads it; its
        // pre-flight check for `assets5.pk3` looks only under `fs_basepath` and
        // `fs_homepath`; and it loads its menu module out of `fs_basepath` by
        // name. A folder JKNet owns, holding a link to the game's `base`, is
        // the one root that answers all three.
        let game_data = "D:\\SteamLibrary\\steamapps\\common\\Jedi Outcast\\GameData";
        let args = build_launch_args(&jo_plan(
            Path::new(game_data),
            Path::new("C:\\JKNet\\clients\\jk2\\engine"),
            Path::new("C:\\JKNet\\clients\\jk2\\basepath"),
            Path::new("C:\\JKNet\\clients\\jk2\\home"),
        ));
        assert_eq!(
            args,
            vec![
                "+set",
                "fs_assetspath",
                game_data,
                "+set",
                "fs_basepath",
                "C:\\JKNet\\clients\\jk2\\basepath",
                "+set",
                "fs_homepath",
                "C:\\JKNet\\clients\\jk2\\home",
            ]
        );
        // `fs_assetspath` is still sent: harmless in 1.4.1, and the value the
        // `master` build reads. `fs_cdpath` does not exist in this engine.
        assert!(!args.iter().any(|arg| arg == "fs_cdpath"));
        // No `mv_menuOverride`. It was the previous attempt at the menu module
        // and it made things worse: the engine then loads MVSDK's `vm/ui.qvm`
        // and dies on «MVSDK: Unable to detect jk2version [UI]». The module is
        // copied into the base root instead.
        assert!(!args.iter().any(|arg| arg == "mv_menuOverride"));
        // The game folder is named once, under the cvar only a future build
        // reads. It is *not* a root: it reaches the engine through the
        // junction at `basepath\base`.
        assert_eq!(args.iter().filter(|arg| *arg == game_data).count(), 1);
        // The unpacked build is deliberately not a root either. Its own
        // archives reach the engine through `home\base\` — see
        // `engine_install::sync_engine_archives`.
        assert!(!args.iter().any(|arg| arg.ends_with("\\engine")));
    }

    #[test]
    fn the_unpacked_build_stays_a_search_root_in_jedi_academy() {
        // Unchanged, and the reason is unchanged too: `base\cgamex86.dll` of
        // the fork has to win over the 1.01 module in the retail folder.
        let game = Path::new("D:\\GameData");
        let engine = Path::new("C:\\JKNet\\clients\\everyday\\engine");
        let base = Path::new("C:\\JKNet\\clients\\everyday\\basepath");
        let home = Path::new("C:\\JKNet\\clients\\everyday\\home");

        let ja = build_launch_args(&plan(game, engine, base, home));
        let root = ja
            .iter()
            .position(|arg| arg == "fs_basepath")
            .expect("fs_basepath is always set");
        assert_eq!(ja[root + 1], engine.display().to_string());
        assert_eq!(ja[1], "fs_cdpath");
        assert_eq!(ja[2], game.display().to_string());
        // Jedi Academy builds no base root of its own, so the folder is never
        // named on its command line.
        assert!(!ja.iter().any(|arg| arg == base.display().to_string().as_str()));
    }

    #[test]
    fn every_game_sets_the_home_folder_of_its_client() {
        // The one root both layouts agree on, and the only one the engine
        // writes into: configs, screenshots, downloads and the pk3 library.
        let game = Path::new("D:\\GameData");
        let engine = Path::new("C:\\JKNet\\clients\\c\\engine");
        let base = Path::new("C:\\JKNet\\clients\\c\\basepath");
        let home = Path::new("C:\\JKNet\\clients\\c\\home");
        for args in [
            build_launch_args(&plan(game, engine, base, home)),
            build_launch_args(&jo_plan(game, engine, base, home)),
        ] {
            let root = args
                .iter()
                .position(|arg| arg == "fs_homepath")
                .expect("fs_homepath is always set");
            assert_eq!(args[root + 1], home.display().to_string());
        }
    }

    #[test]
    fn the_tail_of_a_jedi_outcast_command_line_is_the_same_as_a_jedi_academy_one() {
        // Only the values of the roots differ, never their number or order.
        // `fs_game`, the player's tokens and `+connect` are built once for both
        // games, and this is what keeps them that way.
        let game = Path::new("D:\\GameData");
        let engine = Path::new("C:\\JKNet\\clients\\jk2\\engine");
        let base = Path::new("C:\\JKNet\\clients\\jk2\\basepath");
        let home = Path::new("C:\\JKNet\\clients\\jk2\\home");
        let settings_args = vec!["+set".to_string(), "r_mode".to_string(), "-1".to_string()];

        let mut with = jo_plan(game, engine, base, home);
        with.fs_game = Some("mv");
        with.settings_args = &settings_args;
        with.connect = Some("jk2.example.org:28070");

        let args = build_launch_args(&with);
        // Nine tokens of roots, then the tail both games share. Jedi Outcast
        // adds nothing of its own any more: what it needs is on disk, not on
        // the command line.
        assert_eq!(
            &args[9..],
            [
                "+set",
                "fs_game",
                "mv",
                "+set",
                "r_mode",
                "-1",
                "+connect",
                "jk2.example.org:28070"
            ]
        );

        let mut ja = plan(game, engine, base, home);
        ja.fs_game = Some("mv");
        ja.settings_args = &settings_args;
        ja.connect = Some("jk2.example.org:28070");
        assert_eq!(&build_launch_args(&ja)[9..], &args[9..]);
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

    // --- slice: game core ---
    // The base root of a Jedi Outcast client.

    /// A client folder and a game folder in temp roots of their own.
    ///
    /// Two roots rather than one, because the point of most of these tests is
    /// that a junction from the first into the second never carries anything
    /// back — including the cleanup that runs when the fixture drops.
    struct Fixture {
        client_root: tempfile::TempDir,
        game_root: tempfile::TempDir,
    }

    /// A file the player owns, dropped into the game's `base` so a test can
    /// prove the game folder came through untouched.
    const GAME_MARKER: &str = "kyle.cfg";

    impl Fixture {
        /// A client with a JK2MV build unpacked, and a 1.04 game folder.
        fn new() -> Fixture {
            let fixture = Fixture {
                client_root: tempfile::tempdir().expect("a client root"),
                game_root: tempfile::tempdir().expect("a game root"),
            };

            let engine = fixture.client_dir().join("engine");
            std::fs::create_dir_all(&engine).expect("the engine folder");
            std::fs::write(engine.join("jk2mvmp.exe"), b"MZ").expect("the executable");
            std::fs::write(engine.join("jk2mvmenu_x64.dll"), b"menu").expect("the menu module");
            // Loaded from next to the executable, so it stays in `engine\`.
            std::fs::write(engine.join("SDL2.dll"), b"sdl").expect("a plain dll");

            fixture.fill_game(&fixture.game_data());
            fixture
        }

        /// Writes the retail archives and one file of the player's own.
        fn fill_game(&self, game_data: &Path) {
            let base = game_data.join("base");
            std::fs::create_dir_all(&base).expect("the game base folder");
            for asset in Game::JediOutcast.spec().assets {
                std::fs::write(base.join(asset.name), asset.name.as_bytes()).expect("an archive");
            }
            std::fs::write(base.join(GAME_MARKER), b"seta name Kyle").expect("a player file");
        }

        fn client_dir(&self) -> PathBuf {
            self.client_root.path().join("jk2")
        }

        fn game_data(&self) -> PathBuf {
            self.game_root.path().join("GameData")
        }

        fn link(&self) -> PathBuf {
            self.client_dir().join("basepath").join("base")
        }

        /// Whether the game folder is still whole.
        fn game_is_intact(&self) -> bool {
            let base = self.game_data().join("base");
            base.join(GAME_MARKER).is_file()
                && Game::JediOutcast
                    .spec()
                    .assets
                    .iter()
                    .all(|asset| base.join(asset.name).is_file())
        }

        fn prepare(&self) -> Result<PathBuf> {
            prepare_basepath(Game::JediOutcast, &self.client_dir(), &self.game_data())
        }
    }

    /// Stands in for a disk that will not take a junction.
    fn refuse_junction(_target: &Path, _link: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "this file system has no reparse points",
        ))
    }

    /// Fails the test if the link is touched when it should not be.
    fn never_junction(_target: &Path, _link: &Path) -> std::io::Result<()> {
        panic!("the link was already there and must not be made again");
    }

    #[cfg(windows)]
    #[test]
    fn the_base_root_gets_the_menu_module_and_a_link_to_the_game() {
        let fixture = Fixture::new();
        let base_dir = fixture.prepare().expect("the base root is built");

        assert_eq!(base_dir, fixture.client_dir().join("basepath"));
        // The module `Sys_LoadModuleLibrary` looks for, by the one name it
        // tries. `SDL2.dll` is loaded from next to the executable and stays
        // where the archive put it.
        assert!(base_dir.join("jk2mvmenu_x64.dll").is_file());
        assert!(!base_dir.join("SDL2.dll").exists());

        let link = fixture.link();
        assert!(
            junction_target(&link).is_some_and(|target| same_folder(
                &target,
                &fixture.game_data().join("base")
            )),
            "{} must be a junction to the game's base",
            link.display()
        );
        // The engine reads the retail archives through it, and nothing was
        // copied to make that true.
        assert!(link.join("assets5.pk3").is_file());
        assert!(!base_dir.join(".jknet-copied-base").exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_second_launch_leaves_the_link_and_the_module_alone() {
        let fixture = Fixture::new();
        fixture.prepare().expect("the first launch");

        let stamp = std::fs::metadata(fixture.client_dir().join("basepath").join("jk2mvmenu_x64.dll"))
            .and_then(|meta| meta.modified())
            .expect("the copied module");
        // `never_junction` panics if the link is remade, so reaching the
        // assertions below is itself the result.
        prepare_basepath_with(
            Game::JediOutcast,
            &fixture.client_dir(),
            &fixture.game_data(),
            never_junction,
        )
        .expect("the second launch");

        let again = std::fs::metadata(fixture.client_dir().join("basepath").join("jk2mvmenu_x64.dll"))
            .and_then(|meta| meta.modified())
            .expect("the copied module");
        assert_eq!(stamp, again, "an unchanged module is not copied again");
        assert!(fixture.game_is_intact());
    }

    #[cfg(windows)]
    #[test]
    fn a_game_that_moved_gets_the_link_redrawn() {
        let fixture = Fixture::new();
        fixture.prepare().expect("the first launch");

        // The player moved their copy of the game to another folder.
        let moved = fixture.game_root.path().join("Moved").join("GameData");
        fixture.fill_game(&moved);
        prepare_basepath(Game::JediOutcast, &fixture.client_dir(), &moved)
            .expect("the launch after the move");

        let link = fixture.link();
        assert!(junction_target(&link)
            .is_some_and(|target| same_folder(&target, &moved.join("base"))));
        assert!(link.join(GAME_MARKER).is_file());
        // Unlinking is not deleting: the folder the link used to name is whole.
        assert!(fixture.game_is_intact());
    }

    #[cfg(windows)]
    #[test]
    fn a_newer_build_replaces_the_copied_module() {
        let fixture = Fixture::new();
        fixture.prepare().expect("the first launch");

        let source = fixture.client_dir().join("engine").join("jk2mvmenu_x64.dll");
        std::fs::write(&source, b"menu of 1.4.2").expect("the updated module");
        fixture.prepare().expect("the launch after the update");

        let copy = fixture.client_dir().join("basepath").join("jk2mvmenu_x64.dll");
        assert_eq!(
            std::fs::read(&copy).expect("the copy"),
            b"menu of 1.4.2".to_vec()
        );
    }

    #[test]
    fn a_real_folder_where_the_link_belongs_is_refused() {
        // The one case that must never turn into a deletion: somebody's files
        // sit where the launcher wants its link.
        let fixture = Fixture::new();
        let link = fixture.link();
        std::fs::create_dir_all(&link).expect("a folder in the way");
        std::fs::write(link.join("mine.pk3"), b"my work").expect("a file in it");

        let error = fixture.prepare().expect_err("it must refuse");
        assert!(matches!(error, AppError::BasepathOccupied(_)), "{error}");
        assert!(link.join("mine.pk3").is_file(), "nothing may be deleted");
    }

    #[test]
    fn a_file_where_the_link_belongs_is_refused_too() {
        let fixture = Fixture::new();
        let link = fixture.link();
        std::fs::create_dir_all(link.parent().expect("the base root")).expect("the base root");
        std::fs::write(&link, b"not even a folder").expect("a file in the way");

        let error = fixture.prepare().expect_err("it must refuse");
        assert!(matches!(error, AppError::BasepathOccupied(_)), "{error}");
        assert!(link.is_file());
    }

    #[test]
    fn a_disk_that_takes_no_junction_gets_the_archives_copied() {
        let fixture = Fixture::new();
        prepare_basepath_with(
            Game::JediOutcast,
            &fixture.client_dir(),
            &fixture.game_data(),
            refuse_junction,
        )
        .expect("the fallback still starts the game");

        let link = fixture.link();
        for asset in Game::JediOutcast.spec().assets {
            assert!(link.join(asset.name).is_file(), "{} is missing", asset.name);
        }
        // Only the archives the table names. The player's own file in the game
        // folder is not part of the copy.
        assert!(!link.join(GAME_MARKER).exists());
        assert!(fixture
            .client_dir()
            .join("basepath")
            .join(".jknet-copied-base")
            .is_file());
        assert!(fixture.game_is_intact());
    }

    #[test]
    fn a_copy_made_by_the_fallback_is_refreshed_and_not_refused() {
        // Without the marker the second launch would meet a real folder and
        // stop, which is what the rule above says about a folder JKNet did not
        // make. The marker is how the two rules stay apart.
        let fixture = Fixture::new();
        let roots = (fixture.client_dir(), fixture.game_data());
        prepare_basepath_with(Game::JediOutcast, &roots.0, &roots.1, refuse_junction)
            .expect("the first fallback");

        // A patch the player installed between the two launches.
        std::fs::write(roots.1.join("base").join("assets5.pk3"), b"the 1.04 patch, rebuilt")
            .expect("the patched archive");
        prepare_basepath_with(Game::JediOutcast, &roots.0, &roots.1, refuse_junction)
            .expect("the second fallback");

        assert_eq!(
            std::fs::read(fixture.link().join("assets5.pk3")).expect("the copy"),
            b"the 1.04 patch, rebuilt".to_vec()
        );
    }

    #[test]
    fn a_copy_of_an_archive_the_player_has_not_got_is_not_a_failure() {
        // `assets2.pk3` and `assets5.pk3` come with a patch, and a 1.02 copy
        // has neither.
        let fixture = Fixture::new();
        let base = fixture.game_data().join("base");
        std::fs::remove_file(base.join("assets2.pk3")).expect("remove the 1.03 archive");
        std::fs::remove_file(base.join("assets5.pk3")).expect("remove the 1.04 archive");

        prepare_basepath_with(
            Game::JediOutcast,
            &fixture.client_dir(),
            &fixture.game_data(),
            refuse_junction,
        )
        .expect("the fallback copies what is there");

        assert!(fixture.link().join("assets0.pk3").is_file());
        assert!(!fixture.link().join("assets5.pk3").exists());
    }

    #[test]
    fn a_client_of_the_other_game_copies_no_modules() {
        // Jedi Academy names no module prefix, so the same code copies nothing
        // even when a `jk2mvmenu` happens to be lying about.
        let fixture = Fixture::new();
        let base_dir = fixture.client_dir().join("basepath");
        std::fs::create_dir_all(&base_dir).expect("the base root");
        let copied = copy_basepath_modules(
            Game::JediAcademy,
            &fixture.client_dir().join("engine"),
            &base_dir,
        )
        .expect("nothing to copy");
        assert!(copied.is_empty());
        assert!(!base_dir.join("jk2mvmenu_x64.dll").exists());
    }

    #[test]
    fn two_spellings_of_one_folder_compare_equal() {
        assert!(same_folder(
            Path::new("D:\\Games\\Jedi Outcast\\GameData\\base"),
            Path::new("d:\\games\\jedi outcast\\gamedata\\base\\")
        ));
        assert!(same_folder(
            Path::new("\\\\?\\D:\\GameData\\base"),
            Path::new("D:/GameData/base")
        ));
        assert!(!same_folder(
            Path::new("D:\\GameData\\base"),
            Path::new("E:\\GameData\\base")
        ));
    }
}
