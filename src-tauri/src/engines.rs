//! The engine registry and the commands that install an engine into a client.
//!
//! An engine is a community build of the Jedi Academy multiplayer client. A
//! **client** is a named instance of one engine with its own files and
//! settings, so the same engine backs any number of clients.
//!
//! The registry is static on purpose: four builds, each with a GitHub releases
//! page. What is *not* static is the release list — [`list_engine_releases`]
//! asks GitHub, [`install_engine`] downloads and unpacks, and
//! [`check_engine_update`] compares what is on disk with what is published.
//! The machinery behind those three lives in [`crate::engine_install`].
//!
//! Every asset name and executable name below was read from a real release
//! archive on 2026-09-10; the download log is in the slice report. Nothing
//! here is guessed.

use serde::{Deserialize, Serialize};

use crate::bundles::{BundlesGuard, BundlesState};
use crate::clients::Client;
use crate::engine_install;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::host_system::HostSystem;
use crate::paths::DataPaths;
use crate::state::AppState;

/// One attempt at recognising a Windows archive of a release.
///
/// Matching is substring based and case insensitive, because the four projects
/// spell their platforms four different ways (`windows-x86`, `win32-portable`)
/// and none of them promises to keep doing so. An asset matches when it
/// contains every string in `require` and none of the strings in `forbid`.
#[derive(Debug, Clone, Copy)]
pub struct AssetRule {
    pub require: &'static [&'static str],
    pub forbid: &'static [&'static str],
}

/// How much of a bet an engine is, and why.
///
/// One build of each game is `Recommended`: the New client dialog preselects
/// it for a player who has no preference. The rest are `Supported` — a working
/// choice with nothing to warn about.
///
/// `Legacy` is the third answer, and the reason this is an enum rather than a
/// flag: an abandoned build stays installable, because a server may still ask
/// for it, but the player deserves a sentence saying what they are choosing.
/// The note travels as a catalog key, not as English text, so it reaches the
/// player in the language of the interface — and the payload makes the pairing
/// unrepresentable the wrong way round: there is no legacy build without a
/// note, and no note hanging off a build that is fine.
///
/// No build in the registry is `Legacy` today. EternalJK was, on a reading of
/// crash reports that turned out to blame the wrong thing — see the comment on
/// its entry — and the variant stays because the next abandoned project is a
/// question of when, not whether. The interface draws the badge and the note
/// off it already; nothing but a registry entry is missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineStatus {
    /// The build offered to a player of this game who has no preference.
    Recommended,
    /// A working choice. Nothing to say about it beyond its description.
    Supported,
    /// No longer maintained. `note_key` names a key of the `clients`
    /// namespace, under `engines.notes.`, holding one or two sentences on what
    /// the player is in for and what to use instead.
    Legacy {
        #[serde(rename = "noteKey")]
        note_key: &'static str,
    },
}

// --- slice: bundles ---
/// How a client is started: the multiplayer executable, or the single-player
/// one of a release that ships both.
///
/// A mode of the engine first: OpenJK for Jedi Academy carries
/// `openjk_sp.x86.exe` next to `openjk.x86.exe` in one archive, the other
/// builds carry one executable. A client keeps the modes it may start in
/// (see [`crate::clients::Client::modes`]), and a component of a bundle names
/// a subset of the modes of its engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    /// The multiplayer client: the Servers screen, `+connect`, the profile
    /// tokens. What every engine has.
    #[default]
    Multiplayer,
    /// The single-player game of a release that ships one. No server, no
    /// player profile: the game opens on its own menu.
    Single,
}

impl LaunchMode {
    /// The wire spelling, which is what `client.json` and a manifest carry.
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchMode::Multiplayer => "multiplayer",
            LaunchMode::Single => "single",
        }
    }
}

/// The single-player executable of a release that ships one, in both widths.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinglePlayer {
    /// Executable of the Windows x86 archive.
    pub executable: &'static str,
    /// Executable of the Windows x64 archive.
    pub executable_x64: &'static str,
}

// --- slice: play with friends ---
/// The dedicated server a release ships next to the client, in both widths.
///
/// The names were checked on 2026-09-25 against the `engine\` folders of the
/// installed clients of the user and by starting each server (stage 0 of
/// TASK-41). A build whose project ships one width names the same file twice.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedicatedServer {
    /// Executable of the Windows x86 archive.
    pub executable: &'static str,
    /// Executable of the Windows x64 archive.
    pub executable_x64: &'static str,
}

/// One engine JKNet can install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    /// Stable key stored in `client.json`. Never shown to the player.
    pub id: &'static str,
    // --- slice: game core ---
    /// The game this build plays. An engine belongs to exactly one: OpenJK
    /// builds a Jedi Outcast client too, but it is a different executable in a
    /// different archive, and its multiplayer is explicitly unsupported.
    pub game: Game,
    /// Name shown on the engine tile.
    pub name: &'static str,
    /// One sentence for the tile, in the interface language (English).
    pub description: &'static str,
    /// Executable inside the client's `engine\` folder.
    pub executable: &'static str,
    /// `owner/name` of the GitHub repository that publishes the releases.
    pub repo: &'static str,
    /// The same repository as a link the player can open.
    ///
    /// Spelled out rather than built from [`Engine::repo`] so that a project
    /// that ever moves off GitHub needs one edit in one place and no string
    /// concatenation anywhere. A test below proves the two agree.
    pub repo_url: &'static str,
    /// The page that lists every published build.
    ///
    /// The engine page links it next to the ten releases it shows: JKNet only
    /// lists the archives it could install, and a player looking for an older
    /// one or for a source tarball belongs on the project's own page.
    pub releases_url: &'static str,
    /// The project's own site, when its README names one. `None` otherwise —
    /// a repository is not a site, and the page already links that.
    pub homepage: Option<&'static str>,
    /// Who the project credits for its icon, when it credits anyone.
    ///
    /// The About card names it. JK2MV is the one build whose README hands the
    /// icon to a person rather than to the project, and the credit belongs
    /// wherever the icon is shown.
    pub icon_credit: Option<&'static str>,
    /// Recommended, merely supported, or legacy with a note saying why.
    pub status: EngineStatus,
    /// False when the project ships no archive JKNet can use. Such an engine
    /// stays in the list so the player learns why, instead of wondering where
    /// it went.
    pub installable: bool,
    /// Why [`Engine::installable`] is false. `None` when it is true.
    pub not_installable_reason: Option<&'static str>,
    /// `fs_game` the build needs to run at all. jaMME lives in `mme\` and
    /// starts into the main menu without it; the other three run from `base`.
    pub default_fs_game: Option<&'static str>,
    // --- slice: bundles ---
    /// The single-player executable the same archive ships, when it ships
    /// one. `None` for a build that is a multiplayer client and nothing else.
    /// The frontend reads [`EngineAvailability::modes`] instead of this.
    #[serde(skip)]
    pub single_player: Option<SinglePlayer>,
    // --- slice: play with friends ---
    /// The dedicated server of the release, `None` for a build that ships
    /// none (jaMME). The frontend reads [`EngineAvailability::can_host`].
    #[serde(skip)]
    pub dedicated: Option<DedicatedServer>,
    /// Whether a release flagged as a pre-release may be installed. Only the
    /// projects that publish rolling builds need it.
    #[serde(skip)]
    pub allow_prerelease: bool,
    /// Rules tried in order until one recognises an asset of the release.
    ///
    /// These are the rules for Windows x86. Windows x64 prefers
    /// [`Engine::asset_rules_x64`] when the project publishes a 64-bit build;
    /// read both through [`Engine::rules_for_host`].
    #[serde(skip)]
    pub asset_rules: &'static [AssetRule],
    // --- slice: game core ---
    /// Rules preferred on Windows x64, or `None` when the project ships
    /// one architecture only.
    #[serde(skip)]
    pub asset_rules_x64: Option<&'static [AssetRule]>,
}

impl Engine {
    /// Rules selected by the native OS architecture, including under WOW64.
    pub fn rules_for_host(&self) -> &'static [AssetRule] {
        self.rules_for_system(HostSystem::current())
    }

    pub fn rules_for_system(&self, host: HostSystem) -> &'static [AssetRule] {
        if !self.installable || !host.supports_engines() {
            return &[];
        }
        match self.asset_rules_x64 {
            Some(rules) if host.arch == "x86_64" => rules,
            _ => self.asset_rules,
        }
    }

    pub fn require_host(&self, host: HostSystem) -> Result<()> {
        if !host.supports_engines() {
            return Err(AppError::UnsupportedEngineSystem { system: host.label() });
        }
        Ok(())
    }

    /// x64 archives of OpenJK and TaystJK use a different executable name.
    pub fn executable_for_asset(&self, asset_name: &str) -> &'static str {
        if asset_name.to_ascii_lowercase().contains("x86_64") {
            match self.id {
                "openjk" => return "openjk.x86_64.exe",
                "taystjk" => return "taystjk.x86_64.exe",
                _ => {}
            }
        }
        self.executable
    }

    /// Existing x86 clients keep working after x64 becomes the default.
    pub fn installed_executable(&self, dir: &std::path::Path) -> std::path::PathBuf {
        let original = dir.join(self.executable);
        if original.is_file() { return original; }
        let x64 = dir.join(self.executable_for_asset("x86_64"));
        if x64.is_file() { x64 } else { original }
    }

    // --- slice: bundles ---
    /// The modes this build can start in: every build plays multiplayer, and
    /// the one whose archive ships a single-player executable plays that too.
    pub fn modes(&self) -> Vec<LaunchMode> {
        match self.single_player {
            Some(_) => vec![LaunchMode::Multiplayer, LaunchMode::Single],
            None => vec![LaunchMode::Multiplayer],
        }
    }

    /// Whether the build can start in `mode` at all.
    pub fn supports(&self, mode: LaunchMode) -> bool {
        match mode {
            LaunchMode::Multiplayer => true,
            LaunchMode::Single => self.single_player.is_some(),
        }
    }

    /// The single-player executable inside `engine\`, chosen the way
    /// [`Engine::installed_executable`] chooses the multiplayer one: the x86
    /// name when that file is there, the x64 name when that one is, the x86
    /// name otherwise so the caller can say which file is missing. `None` for
    /// a build without a single-player game.
    pub fn single_player_executable(&self, dir: &std::path::Path) -> Option<std::path::PathBuf> {
        let single = self.single_player?;
        let original = dir.join(single.executable);
        if original.is_file() {
            return Some(original);
        }
        let x64 = dir.join(single.executable_x64);
        Some(if x64.is_file() { x64 } else { original })
    }

    // --- slice: play with friends ---
    /// The dedicated server inside `engine\`, or `None` when the build ships
    /// none or the file is not there.
    ///
    /// The width of the installed client goes first, the way
    /// [`Engine::installed_executable`] picks the client: an x64 install
    /// starts the x64 server when it has one, and falls back to the other
    /// width rather than to nothing.
    pub fn dedicated_executable(&self, dir: &std::path::Path) -> Option<std::path::PathBuf> {
        let server = self.dedicated?;
        let client_is_x64 = !dir.join(self.executable).is_file()
            && dir.join(self.executable_for_asset("x86_64")).is_file();
        let order = if client_is_x64 {
            [server.executable_x64, server.executable]
        } else {
            [server.executable, server.executable_x64]
        };
        order
            .into_iter()
            .map(|name| dir.join(name))
            .find(|path| path.is_file())
    }
}

/// Every engine, in the order the Clients screen shows them.
///
/// Asset names observed on 2026-09-10 (GitHub API, `?per_page=10`):
///
/// | Engine | Status | Newest release | Windows 32-bit asset | Executable in it |
/// | --- | --- | --- | --- | --- |
/// | OpenJK | recommended | `latest`, rolling | `OpenJK-windows-x86.zip` | `openjk.x86.exe` |
/// | EternalJK | supported | `1.5.8.5`, 2020-06-15 | `eternaljk-win32-portable.zip` | `eternaljk.x86.exe` |
/// | TaystJK | supported | `latest`, rolling | `TaystJK-windows-x86.zip` | `taystjk.x86.exe` |
/// | jaMME | supported | `latest`, rolling | `jamme-windows-x86.zip` | `jamme.exe` |
///
/// Two traps the rules exist for: the OpenJK release carries `OpenJO-*`
/// archives for the *other* game next to its own, and TaystJK publishes an
/// `-AddressSanitizer` build that is a debugging tool, not a game.
///
/// --- slice: game core ---
/// The fifth entry plays the other game. JK2MV is the only live Jedi Outcast
/// multiplayer client: OpenJK says outright that it does not support Jedi
/// Outcast multiplayer and points at JK2MV, OpenJO is single player, and
/// EternalJK and TaystJK are Jedi Academy forks. Its archive was downloaded
/// and listed on 2026-09-10; the layout is in the table below the registry.
const ENGINES: &[Engine] = &[
    Engine {
        id: "openjk",
        game: Game::JediAcademy,
        name: "OpenJK",
        description: "The community reference build. Stable, closest to the original game.",
        executable: "openjk.x86.exe",
        repo: "JACoders/OpenJK",
        repo_url: "https://github.com/JACoders/OpenJK",
        releases_url: "https://github.com/JACoders/OpenJK/releases",
        // The README names `builds.openjk.org`, which serves nightly archives
        // rather than describing the project. Not a site to send a player to.
        homepage: None,
        icon_credit: None,
        status: EngineStatus::Recommended,
        installable: true,
        not_installable_reason: None,
        default_fs_game: None,
        // The same archive carries the single-player game next to the
        // multiplayer client: `openjk_sp.x86.exe` listed from
        // `OpenJK-windows-x86.zip` on 2026-09-16, the x64 name spelled the
        // way `openjk.x86_64.exe` is and not read from an archive yet.
        single_player: Some(SinglePlayer {
            executable: "openjk_sp.x86.exe",
            executable_x64: "openjk_sp.x86_64.exe",
        }),
        // --- slice: play with friends --- both widths started on 2026-09-25.
        dedicated: Some(DedicatedServer {
            executable: "openjkded.x86.exe",
            executable_x64: "openjkded.x86_64.exe",
        }),
        // OpenJK ships one rolling `latest` release and keeps an old tagged
        // one flagged as a pre-release; taking both leaves a fallback.
        allow_prerelease: true,
        asset_rules: &[
            AssetRule {
                require: &["openjk-windows-x86", ".zip"],
                forbid: &["x86_64"],
            },
            AssetRule {
                require: &["windows", "x86", ".zip"],
                forbid: &["x86_64", "openjo", "arm"],
            },
        ],
        asset_rules_x64: Some(&[
            AssetRule { require: &["openjk-windows-x86_64", ".zip"], forbid: &["sanitizer", "arm"] },
            AssetRule { require: &["openjk-windows-x86", ".zip"], forbid: &["x86_64", "sanitizer", "arm"] },
        ]),
    },
    Engine {
        id: "eternaljk",
        game: Game::JediAcademy,
        name: "EternalJK",
        description: "OpenJK with the modern multiplayer patches most servers expect.",
        executable: "eternaljk.x86.exe",
        repo: "eternalcodes/EternalJK",
        repo_url: "https://github.com/eternalcodes/EternalJK",
        releases_url: "https://github.com/eternalcodes/EternalJK/releases",
        homepage: Some("https://playja.pro"),
        icon_credit: None,
        // Last release 1.5.8.5 of 2020-06-15, and a build people play every
        // day. It was briefly marked legacy here over a fault on every map
        // load — 0xC0000005 inside `eternaljk.x86.exe` right after the
        // client's `CM_LoadMap` — which turned out to be one argument, not one
        // engine: every one of those runs carried `+set s_initsound 0`. With
        // the sound system on, the build loads maps and plays. OpenJK and
        // TaystJK survive `s_initsound 0`, this one does not, so `launch.rs`
        // warns when the command line about to start it contains that pair.
        status: EngineStatus::Supported,
        installable: true,
        not_installable_reason: None,
        default_fs_game: None,
        single_player: None,
        // --- slice: play with friends --- the project ships no x64 archive,
        // so the one width is named twice. Started on 2026-09-25.
        dedicated: Some(DedicatedServer {
            executable: "eternaljkded.x86.exe",
            executable_x64: "eternaljkded.x86.exe",
        }),
        allow_prerelease: false,
        asset_rules: &[
            AssetRule {
                require: &["win32", ".zip"],
                // `ejk-japro-pk3only.zip` is content, not an engine.
                forbid: &["pk3only", "x64", "x86_64", "arm", "sanitizer"],
            },
            AssetRule {
                require: &["windows", ".zip"],
                forbid: &["x86_64", "x64", "pk3only", "arm", "sanitizer"],
            },
        ],
        asset_rules_x64: None,
    },
    Engine {
        id: "taystjk",
        game: Game::JediAcademy,
        name: "TaystJK",
        description: "Fork focused on competitive play and quality of life fixes.",
        executable: "taystjk.x86.exe",
        repo: "taysta/TaystJK",
        repo_url: "https://github.com/taysta/TaystJK",
        releases_url: "https://github.com/taysta/TaystJK/releases",
        homepage: Some("https://taysta.github.io/TaystJK/"),
        icon_credit: None,
        status: EngineStatus::Supported,
        installable: true,
        not_installable_reason: None,
        default_fs_game: None,
        single_player: None,
        // --- slice: play with friends --- x86 started on 2026-09-25; the x64
        // name follows the client's and was not seen in an archive yet.
        dedicated: Some(DedicatedServer {
            executable: "taystjkded.x86.exe",
            executable_x64: "taystjkded.x86_64.exe",
        }),
        allow_prerelease: true,
        asset_rules: &[
            AssetRule {
                require: &["taystjk-windows-x86", ".zip"],
                forbid: &["x86_64", "windowsxp", "sanitizer"],
            },
            AssetRule {
                require: &["windows", "x86", ".zip"],
                forbid: &["x86_64", "sanitizer", "arm"],
            },
        ],
        asset_rules_x64: Some(&[
            AssetRule { require: &["taystjk-windows-x86_64", ".zip"], forbid: &["sanitizer", "windowsxp", "arm"] },
            AssetRule { require: &["taystjk-windows-x86", ".zip"], forbid: &["x86_64", "sanitizer", "windowsxp", "arm"] },
        ]),
    },
    Engine {
        id: "jamme",
        game: Game::JediAcademy,
        name: "jaMME",
        description: "Movie maker edition: demo playback, camera work and capture.",
        // `jamme.exe`, without the `.x86` the other three carry.
        executable: "jamme.exe",
        repo: "entdark/jaMME",
        repo_url: "https://github.com/entdark/jaMME",
        releases_url: "https://github.com/entdark/jaMME/releases",
        homepage: None,
        icon_credit: None,
        status: EngineStatus::Supported,
        installable: true,
        not_installable_reason: None,
        // `start_jaMME.cmd` inside the archive runs
        // `jamme +set fs_game mme +set fs_extraGames "japlus japp"`.
        default_fs_game: Some("mme"),
        single_player: None,
        // --- slice: play with friends --- the archive holds `jamme.exe` and
        // no server, so a jaMME client cannot host.
        dedicated: None,
        allow_prerelease: true,
        asset_rules: &[
            AssetRule {
                require: &["jamme-windows-x86", ".zip"],
                forbid: &["x86_64"],
            },
            AssetRule {
                require: &["windows", ".zip"],
                forbid: &["x86_64", "x64", "android", "macos", "arm", "sanitizer"],
            },
        ],
        asset_rules_x64: None,
    },
    // --- slice: game core ---
    Engine {
        id: "jk2mv",
        game: Game::JediOutcast,
        name: "JK2MV",
        description: "The Jedi Outcast multiplayer client. Plays 1.02, 1.03 and 1.04.",
        executable: "jk2mvmp.exe",
        repo: "mvdevs/jk2mv",
        repo_url: "https://github.com/mvdevs/jk2mv",
        releases_url: "https://github.com/mvdevs/jk2mv/releases",
        homepage: Some("https://jk2mv.org"),
        // The README of the project hands the icon to this author by name.
        icon_credit: Some("Thoroughbred-Of-Sin"),
        // Recommended within its game; the status is read per game, so the two
        // recommendations do not compete.
        status: EngineStatus::Recommended,
        installable: true,
        not_installable_reason: None,
        // No `fs_game`: JK2MV runs from `base`, and its own `assetsmv.pk3` and
        // `assetsmv2.pk3` ride in the archive into `engine\base\`, which
        // `fs_basepath` already covers.
        default_fs_game: None,
        single_player: None,
        // --- slice: play with friends --- the same name in both archives;
        // the x64 one was started on 2026-09-25.
        dedicated: Some(DedicatedServer {
            executable: "jk2mvded.exe",
            executable_x64: "jk2mvded.exe",
        }),
        // 1.4.1 of 2018-02-15 is the only tagged release; the project builds
        // every push but tags nothing, so there is no pre-release to fall back
        // on and nothing to allow.
        allow_prerelease: false,
        asset_rules: &[AssetRule {
            require: &["win32-x86-portable", ".zip"],
            forbid: &["x64"],
        }],
        asset_rules_x64: Some(&[
            AssetRule {
                require: &["win32-x64-portable", ".zip"],
                forbid: &[],
            },
            // A 64-bit machine runs the 32-bit build too, so a release that
            // ever drops the x64 archive still installs.
            AssetRule {
                require: &["win32-x86-portable", ".zip"],
                forbid: &[],
            },
        ]),
    },
];

/// Returns the engine with this id.
pub fn find(id: &str) -> Option<&'static Engine> {
    ENGINES.iter().find(|engine| engine.id == id)
}

/// Returns the engine with this id, or an error naming it.
pub fn require(id: &str) -> Result<&'static Engine> {
    find(id).ok_or_else(|| AppError::InvalidInput(format!("unknown engine {id}")))
}

// --- slice: game core ---
/// Returns the engine with this id, and refuses one that plays another game.
///
/// Its own error, because the cure is picking a different engine rather than
/// fixing a typo: the id is real, it just belongs to the other list.
pub fn require_for_game(id: &str, game: Game) -> Result<&'static Engine> {
    let engine = require(id)?;
    if engine.game != game {
        return Err(AppError::GameMismatch(format!(
            "{} plays {}, not {}",
            engine.name,
            engine.game.display_name(),
            game.display_name()
        )));
    }
    Ok(engine)
}

/// Lists the engines of one game, or every engine when `game` is `None`.
///
/// The Clients screen asks once without a game and filters the answer itself:
/// the registry is static, and refetching it every time a radio button moves
/// would be a round trip for a constant.
#[tauri::command]
pub fn list_engines(game: Option<Game>) -> Result<Vec<EngineAvailability>> {
    let host = HostSystem::current();
    Ok(ENGINES.iter()
        .filter(|engine| game.is_none_or(|game| engine.game == game))
        .map(|engine| availability(engine, host))
        .collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAvailability {
    #[serde(flatten)]
    pub engine: Engine,
    pub system: String,
    pub compatibility_error: Option<&'static str>,
    // --- slice: bundles ---
    /// The modes the build starts in: `multiplayer`, and `single` when the
    /// archive ships a single-player executable. A client made on the
    /// Clients screen gets all of them.
    pub modes: Vec<LaunchMode>,
    // --- slice: play with friends ---
    /// Whether the release ships a dedicated server, so a client of it can
    /// host a private server. Whether the file is on disk is a question about
    /// one client, which `host_get_options` answers.
    pub can_host: bool,
}

fn availability(engine: &Engine, host: HostSystem) -> EngineAvailability {
    let modes = engine.modes();
    let can_host = engine.dedicated.is_some();
    let mut engine = engine.clone();
    let compatibility_error = if host.supports_engines() {
        None
    } else {
        engine.installable = false;
        Some("unsupportedEngineSystem")
    };
    EngineAvailability { engine, system: host.label(), compatibility_error, modes, can_host }
}

// ---------------------------------------------------------------------------
// Asset matching
// ---------------------------------------------------------------------------

/// Picks the compatible archive using the host's ordered rules.
///
/// Rules are tried in order and the first rule that matches anything wins, so
/// a precise rule can sit in front of a loose one. Within a rule the first
/// matching asset wins, which is stable because a release never carries two
/// archives for the same platform.
pub fn match_asset<'a, I>(rules: &[AssetRule], assets: I) -> Option<usize>
where
    I: IntoIterator<Item = &'a str> + Clone,
{
    for rule in rules {
        let found = assets.clone().into_iter().position(|name| {
            let name = name.to_ascii_lowercase();
            let is_x64 = |text: &str| ["x86_64", "x64", "amd64"].iter().any(|arch| text.contains(arch));
            name.ends_with(".zip")
                && (!is_x64(&name) || rule.require.iter().any(|part| is_x64(part)))
                && !["sanitizer", "debug", "symbols", "arm", "aarch", "linux", "macos", "windowsxp"].iter().any(|needle| name.contains(needle))
                && rule.require.iter().all(|needle| name.contains(needle))
                && !rule.forbid.iter().any(|needle| name.contains(needle))
        });
        if found.is_some() {
            return found;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Releases, installation and updates
// ---------------------------------------------------------------------------

/// One release of an engine, reduced to the archive JKNet would install.
///
/// A release without a matching asset never reaches the frontend: it is not a
/// choice the player can make.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineRelease {
    /// Git tag. Written into `client.json` as the installed version.
    pub tag: String,
    /// Release title, or the tag when the project left the title empty.
    pub name: String,
    /// Publication time, RFC 3339. Empty when GitHub reports none.
    pub published_at: String,
    pub prerelease: bool,
    pub asset_name: String,
    pub asset_size: u64,
    pub asset_url: String,
}

/// Answer of [`check_engine_update`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineUpdate {
    /// Tag recorded in `client.json`, `None` when nothing is installed.
    pub installed: Option<String>,
    /// Newest tag with a usable archive, `None` when the project publishes
    /// none.
    pub latest: Option<String>,
    /// Publication time of `latest`, RFC 3339.
    pub latest_published_at: Option<String>,
    pub update_available: bool,
}

/// Lists the releases of an engine, newest first, at most ten.
///
/// Answers from the release cache while it is fresh and falls back to it when
/// GitHub is unreachable, so the Clients screen keeps working offline.
#[tauri::command]
pub async fn list_engine_releases(
    state: tauri::State<'_, AppState>,
    engine_id: String,
) -> Result<Vec<EngineRelease>> {
    let engine = require(&engine_id)?;
    let cache_dir = state.paths()?.cache;
    engine_install::releases(engine, &cache_dir).await
}

/// Downloads a release of the client's engine and unpacks it into
/// `clients\<slug>\engine\`.
///
/// Returns the updated client record. Progress arrives through
/// `launch:engine-install-progress` while the command runs. A second call for
/// a client whose install has not finished is refused with `AppError::Busy`.
///
/// --- slice: bundles ---
/// A client installed from a bundle that laid files over `engine\` keeps a
/// custom build: [`engine_install::install`] empties that folder before
/// unpacking, so an update would take the overlay with it. Such a client is
/// refused here once its engine is in place; the card shows **Custom build**
/// instead of **Check updates** for the same reason.
///
/// A client a bundle operation is running for is refused with
/// `AppError::Busy` as well: the install of a bundle lays files into
/// `engine\` after its own engine step has released `InstallState`, and an
/// engine install in that window would wipe them. The claim on
/// [`BundlesState`] is held for the whole install, so a bundle operation
/// cannot start under this one either.
#[tauri::command]
pub async fn install_engine(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    installs: tauri::State<'_, engine_install::InstallState>,
    bundles: tauri::State<'_, BundlesState>,
    // --- slice: play with friends ---
    host: tauri::State<'_, crate::hosting::HostState>,
    client_id: String,
    tag: Option<String>,
) -> Result<Client> {
    // Unpacking empties `engine\`, which a running private server holds open.
    host.refuse_if_hosting(&client_id)?;
    let paths = state.paths()?;
    let _claim = admit_engine_install(&bundles, &paths, &client_id)?;
    engine_install::install(&app, &installs, &paths, &client_id, tag.as_deref()).await
}

// --- slice: bundles ---
/// The two refusals of [`install_engine`] before it touches the disk: a
/// client a bundle operation holds, then a client whose bundle laid files
/// over its engine. The claim comes first, so the record is read only when
/// nothing is writing it, and it is handed back to be held for the install.
fn admit_engine_install<'a>(
    bundles: &'a BundlesState,
    paths: &DataPaths,
    client_id: &str,
) -> Result<BundlesGuard<'a>> {
    let claim = bundles.claim(client_id, BundlesState::ENGINE_INSTALL)?;
    refuse_overlay_update(&crate::clients::read_record(paths, client_id)?)?;
    Ok(claim)
}

/// Refuses to replace the engine of a client whose bundle laid files over it.
///
/// Only an installed engine is protected: a client whose bundle install
/// stopped before the engine arrived has nothing to lose yet, and the retry
/// of that install goes through the same unpacking.
fn refuse_overlay_update(client: &Client) -> Result<()> {
    let overlaid = client
        .bundle
        .as_ref()
        .is_some_and(|link| link.engine_overlay);
    if overlaid && client.engine_version.is_some() {
        let name = client
            .bundle
            .as_ref()
            .map(|link| link.bundle_name.as_str())
            .unwrap_or_default();
        return Err(AppError::State(format!(
            "the engine of {} is a custom build from the bundle {name}: reinstalling the release would overwrite the files the bundle laid over it. Install the bundle again instead.",
            client.name
        )));
    }
    Ok(())
}

/// Compares the installed tag with the newest published one.
///
/// Three of the four projects publish a rolling `latest` tag that never
/// changes, so an equal tag alone does not mean an equal build. When the tags
/// match, the publication time of the release decides.
#[tauri::command]
pub async fn check_engine_update(
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<EngineUpdate> {
    let paths = state.paths()?;
    let client = crate::clients::read_record(&paths, &client_id)?;
    let engine = require(&client.engine_id)?;
    let releases = engine_install::releases(engine, &paths.cache).await?;

    let latest = releases.first();
    Ok(EngineUpdate {
        update_available: is_update_available(&client, latest),
        installed: client.engine_version.clone(),
        latest: latest.map(|release| release.tag.clone()),
        latest_published_at: latest.map(|release| release.published_at.clone()),
    })
}

/// Whether `latest` is worth installing over what the client already has.
///
/// RFC 3339 in UTC with a fixed width sorts the same as time does, so the
/// publication times compare as plain strings.
fn is_update_available(client: &Client, latest: Option<&EngineRelease>) -> bool {
    let Some(latest) = latest else {
        return false;
    };
    let Some(installed) = client.engine_version.as_deref() else {
        // Nothing installed: an available build is an available build.
        return true;
    };
    if installed != latest.tag {
        return true;
    }
    match client.engine_published_at.as_deref() {
        Some(known) => latest.published_at.as_str() > known,
        // A record written before JKNet stored the publication time. Claiming
        // an update would nag every player on every start.
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The asset lists of the four projects, read from the GitHub API on
    /// 2026-09-10. Keep them verbatim: they are the test.
    const OPENJK_ASSETS: &[&str] = &[
        "OpenJK-linux-x86.tar.gz",
        "OpenJK-linux-x86_64.tar.gz",
        "OpenJK-macos-arm64.tar.gz",
        "OpenJK-macos-x86_64.tar.gz",
        "OpenJK-windows-x86.zip",
        "OpenJK-windows-x86_64.zip",
        "OpenJO-linux-x86.tar.gz",
        "OpenJO-windows-x86.zip",
        "OpenJO-windows-x86_64.zip",
    ];

    const ETERNALJK_ASSETS: &[&str] = &[
        "ejk-japro-pk3only.zip",
        "eternaljk-linux-i686.tar.gz",
        "eternaljk-linux-x86_64.tar.gz",
        "eternaljk-macos-x86_64.tar.gz",
        "eternaljk-win32-portable.zip",
    ];

    const TAYSTJK_ASSETS: &[&str] = &[
        "TaystJK-linux-x86.tar.gz",
        "TaystJK-linux-x86_64.tar.gz",
        "TaystJK-macos-arm64.tar.gz",
        "TaystJK-macos-universal2.tar.gz",
        "TaystJK-macos-x86_64.tar.gz",
        "TaystJK-windows-x86.zip",
        "TaystJK-windows-x86_64-AddressSanitizer.zip",
        "TaystJK-windows-x86_64.zip",
    ];

    const JAMME_ASSETS: &[&str] = &[
        "jamme-linux-x86.tar.gz",
        "jamme-linux-x86_64.tar.gz",
        "jamme-macos-arm64.tar.gz",
        "jamme-macos-x86_64.tar.gz",
        "jamme-windows-x86.zip",
    ];

    /// jaMME 1.11, the older layout, exists to prove the fallback rule works.
    const JAMME_1_11_ASSETS: &[&str] = &[
        "jaMME-1.11_Android.zip",
        "jaMME-1.11_macOS_arm64.zip",
        "jaMME-1.11_macOS_x86_64.zip",
        "jaMME-1.11_Windows.zip",
    ];

    // --- slice: game core ---
    /// JK2MV 1.4.1, listed from the GitHub release on 2026-09-10 and confirmed
    /// by downloading `jk2mv-v1.4.1-win32-x64-portable.zip` (17 335 197 bytes).
    const JK2MV_ASSETS: &[&str] = &[
        "jk2mv-v1.4.1-dedicated.zip",
        "jk2mv-v1.4.1-win32-x64-portable.zip",
        "jk2mv-v1.4.1-win32-x86-installer.exe",
        "jk2mv-v1.4.1-win32-x86-portable.zip",
    ];

    fn pick(engine_id: &str, assets: &[&str]) -> Option<String> {
        let engine = find(engine_id).expect("engine is in the registry");
        match_asset(engine.rules_for_system(HostSystem { os: "windows", arch: "x86" }), assets.iter().copied())
            .map(|index| assets[index].to_string())
    }

    /// Picks with one explicit rule list, so a test can name the architecture
    /// rather than depend on the width of the machine running it.
    fn pick_with(rules: &[AssetRule], assets: &[&str]) -> Option<String> {
        match_asset(rules, assets.iter().copied()).map(|index| assets[index].to_string())
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<&str> = ENGINES.iter().map(|engine| engine.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }

    #[test]
    fn exactly_one_engine_of_each_game_is_recommended() {
        // The New client dialog preselects the recommended build of the game
        // the player picked, so two of them in one game would be a coin toss.
        for game in Game::ALL {
            let recommended: Vec<&str> = ENGINES
                .iter()
                .filter(|engine| engine.game == game && engine.status == EngineStatus::Recommended)
                .map(|engine| engine.id)
                .collect();
            assert_eq!(recommended.len(), 1, "{game}: {recommended:?}");
        }
        assert_eq!(
            find("openjk").expect("openjk").status,
            EngineStatus::Recommended
        );
        assert_eq!(
            find("jk2mv").expect("jk2mv").status,
            EngineStatus::Recommended
        );
    }

    #[test]
    fn no_build_is_legacy_and_eternaljk_is_supported() {
        // EternalJK carried the mark for a day on a crash that belonged to one
        // launch argument, `s_initsound 0`, and not to the build. The warning
        // for that pair lives in `launch.rs`; the registry says what it always
        // should have: a working choice.
        let eternaljk = find("eternaljk").expect("eternaljk");
        assert_eq!(eternaljk.status, EngineStatus::Supported);
        assert!(eternaljk.installable);

        let legacy: Vec<&str> = ENGINES
            .iter()
            .filter(|engine| matches!(engine.status, EngineStatus::Legacy { .. }))
            .map(|engine| engine.id)
            .collect();
        assert!(legacy.is_empty(), "{legacy:?}");
    }

    #[test]
    fn every_note_key_is_a_key_of_the_english_client_catalog() {
        // The status travels to the screen as a key, so a key with no sentence
        // behind it would reach the player as `engines.notes.whatever`. No
        // entry is legacy today, which makes this a guard for the next one
        // rather than a check of the current list. The catalog is read as
        // text: matching the nesting of the JSON here would pull serde_json
        // into the check for nothing.
        let catalog = include_str!("../../src/locales/en/clients.json");
        for engine in ENGINES {
            let EngineStatus::Legacy { note_key } = engine.status else {
                continue;
            };
            let leaf = note_key
                .rsplit('.')
                .next()
                .expect("a key has a last segment");
            assert!(
                catalog.contains(&format!("\"{leaf}\":")),
                "{}: {note_key} is missing from en/clients.json",
                engine.id
            );
        }
    }

    #[test]
    fn a_status_reaches_the_frontend_as_a_tagged_object() {
        // The frontend switches on `kind` and reads `noteKey` off the legacy
        // branch, so the wire shape is part of the contract, not an accident
        // of how serde happens to render an enum.
        let recommended =
            serde_json::to_value(EngineStatus::Recommended).expect("recommended serializes");
        assert_eq!(recommended, serde_json::json!({ "kind": "recommended" }));

        let supported =
            serde_json::to_value(EngineStatus::Supported).expect("supported serializes");
        assert_eq!(supported, serde_json::json!({ "kind": "supported" }));

        // No entry is legacy, so the shape of that branch is checked on a
        // value built here. It is the branch most likely to be got wrong
        // later, and the frontend reads `noteKey` off it.
        let legacy = serde_json::to_value(EngineStatus::Legacy {
            note_key: "engines.notes.example",
        })
        .expect("legacy serializes");
        assert_eq!(
            legacy,
            serde_json::json!({ "kind": "legacy", "noteKey": "engines.notes.example" })
        );

        // And the whole entry carries it under `status`, camelCased with the
        // rest of the DTO.
        let entry = serde_json::to_value(find("eternaljk").expect("eternaljk"))
            .expect("the entry serializes");
        assert_eq!(entry["status"]["kind"], "supported");
        assert_eq!(entry["status"].get("noteKey"), None);
        assert_eq!(entry["notInstallableReason"], serde_json::Value::Null);
    }

    // --- slice: game core ---

    #[test]
    fn every_engine_names_the_game_it_plays() {
        assert_eq!(find("openjk").unwrap().game, Game::JediAcademy);
        assert_eq!(find("eternaljk").unwrap().game, Game::JediAcademy);
        assert_eq!(find("taystjk").unwrap().game, Game::JediAcademy);
        assert_eq!(find("jamme").unwrap().game, Game::JediAcademy);
        assert_eq!(find("jk2mv").unwrap().game, Game::JediOutcast);
    }

    #[test]
    fn the_list_is_filtered_by_game_and_whole_without_one() {
        let all = list_engines(None).expect("the registry answers");
        assert_eq!(all.len(), ENGINES.len());

        let ja = list_engines(Some(Game::JediAcademy)).expect("the registry answers");
        assert_eq!(ja.len(), 4);
        assert!(ja.iter().all(|entry| entry.engine.game == Game::JediAcademy));

        let jo = list_engines(Some(Game::JediOutcast)).expect("the registry answers");
        assert_eq!(
            jo.iter().map(|entry| entry.engine.id).collect::<Vec<_>>(),
            vec!["jk2mv"]
        );
    }

    #[test]
    fn an_engine_of_the_other_game_is_refused_by_name() {
        assert!(require_for_game("jk2mv", Game::JediOutcast).is_ok());
        assert!(require_for_game("openjk", Game::JediAcademy).is_ok());

        let refusal = require_for_game("jk2mv", Game::JediAcademy)
            .expect_err("JK2MV does not play Jedi Academy");
        let text = refusal.to_string();
        assert!(text.contains("JK2MV"), "{text}");
        assert!(text.contains("Jedi Outcast"), "{text}");
        assert!(text.contains("Jedi Academy"), "{text}");

        // An id that is not in the registry is still an input error, not a
        // mismatch: there is no other list to look in.
        assert!(require_for_game("quake3", Game::JediAcademy).is_err());
    }

    #[test]
    fn jk2mv_picks_the_portable_archive_of_the_host_architecture() {
        let engine = find("jk2mv").expect("jk2mv is in the registry");

        assert_eq!(
            pick_with(engine.asset_rules_x64.expect("a 64-bit list"), JK2MV_ASSETS).as_deref(),
            Some("jk2mv-v1.4.1-win32-x64-portable.zip")
        );
        assert_eq!(
            pick_with(engine.asset_rules, JK2MV_ASSETS).as_deref(),
            Some("jk2mv-v1.4.1-win32-x86-portable.zip")
        );
        // Whatever this machine is, the installer executable and the dedicated
        // server archive are never what a player gets.
        let chosen = pick("jk2mv", JK2MV_ASSETS).expect("something matches");
        assert!(chosen.ends_with("-portable.zip"), "{chosen}");
        assert!(!chosen.contains("dedicated"), "{chosen}");
    }

    #[test]
    fn a_64_bit_launcher_falls_back_to_the_32_bit_archive() {
        // If a future release drops the x64 zip, the x86 one still installs.
        let engine = find("jk2mv").expect("jk2mv is in the registry");
        let without_x64 = ["jk2mv-v1.4.1-win32-x86-portable.zip"];
        assert_eq!(
            pick_with(engine.asset_rules_x64.unwrap(), &without_x64).as_deref(),
            Some("jk2mv-v1.4.1-win32-x86-portable.zip")
        );
    }

    #[test]
    fn lookup_finds_a_known_engine_and_rejects_the_rest() {
        assert!(find("eternaljk").is_some());
        assert!(find("quake3").is_none());
        assert!(require("quake3").is_err());
    }

    #[test]
    fn the_links_of_every_engine_match_its_repo() {
        // Three spellings of one fact, so they are compared rather than
        // trusted: the short form names the project in a log line, the links
        // are what the About card and the engine page open.
        for engine in ENGINES {
            assert_eq!(
                engine.repo_url,
                format!("https://github.com/{}", engine.repo),
                "{}",
                engine.id
            );
            assert_eq!(
                engine.releases_url,
                format!("{}/releases", engine.repo_url),
                "{}",
                engine.id
            );
        }
    }

    #[test]
    fn every_link_of_the_registry_is_https() {
        // The engine page hands these straight to the system browser. A plain
        // `http` link in a build that ships to players is a downgrade nobody
        // asked for, and both sites in the registry answer on TLS.
        for engine in ENGINES {
            for url in [Some(engine.repo_url), Some(engine.releases_url), engine.homepage]
                .into_iter()
                .flatten()
            {
                assert!(url.starts_with("https://"), "{}: {url}", engine.id);
            }
        }
    }

    #[test]
    fn an_engine_that_cannot_be_installed_says_why() {
        for engine in ENGINES {
            assert_eq!(
                engine.installable,
                engine.not_installable_reason.is_none(),
                "{} states installability and its reason inconsistently",
                engine.id
            );
        }
    }

    #[test]
    fn every_rule_is_written_in_lowercase() {
        // `match_asset` lowercases the asset name, not the needle.
        for engine in ENGINES {
            let lists = [Some(engine.asset_rules), engine.asset_rules_x64];
            for rule in lists.into_iter().flatten().flatten() {
                for needle in rule.require.iter().chain(rule.forbid.iter()) {
                    assert_eq!(*needle, needle.to_ascii_lowercase(), "{}", engine.id);
                }
            }
        }
    }

    #[test]
    fn picks_the_windows_32_bit_archive_of_every_engine() {
        assert_eq!(
            pick("openjk", OPENJK_ASSETS).as_deref(),
            Some("OpenJK-windows-x86.zip")
        );
        assert_eq!(
            pick("eternaljk", ETERNALJK_ASSETS).as_deref(),
            Some("eternaljk-win32-portable.zip")
        );
        assert_eq!(
            pick("taystjk", TAYSTJK_ASSETS).as_deref(),
            Some("TaystJK-windows-x86.zip")
        );
        assert_eq!(
            pick("jamme", JAMME_ASSETS).as_deref(),
            Some("jamme-windows-x86.zip")
        );
    }

    #[test]
    fn selects_native_x64_or_compatible_x86_from_mixed_releases() {
        let host = HostSystem { os: "windows", arch: "x86_64" };
        for (id, assets, expected) in [
            ("openjk", OPENJK_ASSETS, "OpenJK-windows-x86_64.zip"),
            ("taystjk", TAYSTJK_ASSETS, "TaystJK-windows-x86_64.zip"),
            ("jk2mv", JK2MV_ASSETS, "jk2mv-v1.4.1-win32-x64-portable.zip"),
            ("eternaljk", ETERNALJK_ASSETS, "eternaljk-win32-portable.zip"),
            ("jamme", JAMME_ASSETS, "jamme-windows-x86.zip"),
        ] {
            let engine = require(id).unwrap();
            assert_eq!(pick_with(engine.rules_for_system(host), assets).as_deref(), Some(expected), "{id}");
            let only_x86: Vec<&str> = assets.iter().copied().filter(|name| !name.contains("x86_64") && !name.contains("x64")).collect();
            assert!(pick_with(engine.rules_for_system(host), &only_x86).is_some(), "{id}");
        }
    }

    #[test]
    fn unsupported_hosts_disable_catalog_and_refuse_installation() {
        for host in [
            HostSystem { os: "linux", arch: "x86_64" },
            HostSystem { os: "macos", arch: "aarch64" },
            HostSystem { os: "windows", arch: "aarch64" },
            HostSystem { os: "windows", arch: "unknown" },
        ] {
            for engine in ENGINES {
                assert!(engine.rules_for_system(host).is_empty());
                let error = engine.require_host(host).unwrap_err();
                assert_eq!(error.code(), "unsupportedEngineSystem");
                assert_eq!(error.details()["system"], host.label());
                let entry = serde_json::to_value(availability(engine, host)).unwrap();
                assert_eq!(entry["installable"], false);
                assert_eq!(entry["compatibilityError"], error.code());
                assert_eq!(entry["id"], engine.id);
            }
        }
    }

    #[test]
    fn x86_rules_never_accept_x64_arm_debug_or_non_archives() {
        let host = HostSystem { os: "windows", arch: "x86" };
        for engine in ENGINES {
            let assets = [
                format!("{}-windows-x86_64.zip", engine.id),
                format!("{}-windows-x64.zip", engine.id),
                format!("{}-win32-arm64-portable.zip", engine.id),
                format!("{}-windows-x86-AddressSanitizer.zip", engine.id),
                format!("{}-windows-x86.zip.sha256", engine.id),
                format!("{}-windows-x86-debug.zip", engine.id),
                format!("{}-win32-x64-portable.zip", engine.id),
            ];
            assert!(match_asset(engine.rules_for_system(host), assets.iter().map(String::as_str)).is_none(), "{}", engine.id);
        }
    }

    #[test]
    fn both_existing_x86_and_installed_x64_executables_are_found() {
        let temp = tempfile::tempdir().unwrap();
        for id in ["openjk", "taystjk"] {
            let engine = require(id).unwrap();
            let dir = temp.path().join(id);
            std::fs::create_dir(&dir).unwrap();
            let x64 = dir.join(engine.executable_for_asset("windows-x86_64.zip"));
            std::fs::write(&x64, b"MZ").unwrap();
            assert_eq!(engine.installed_executable(&dir), x64);
            let x86 = dir.join(engine.executable);
            std::fs::write(&x86, b"MZ").unwrap();
            assert_eq!(engine.installed_executable(&dir), x86);
        }
    }

    // --- slice: bundles ---

    #[test]
    fn only_openjk_plays_single_player_and_every_build_plays_multiplayer() {
        for engine in ENGINES {
            let modes = engine.modes();
            assert_eq!(modes[0], LaunchMode::Multiplayer, "{}", engine.id);
            assert!(engine.supports(LaunchMode::Multiplayer));
            assert_eq!(
                modes.contains(&LaunchMode::Single),
                engine.id == "openjk",
                "{}: {modes:?}",
                engine.id
            );
            assert_eq!(engine.supports(LaunchMode::Single), engine.single_player.is_some());
        }
        let openjk = find("openjk").expect("openjk");
        let single = openjk.single_player.expect("the single-player executable");
        assert_eq!(single.executable, "openjk_sp.x86.exe");
        assert_eq!(single.executable_x64, "openjk_sp.x86_64.exe");
        assert_eq!(openjk.modes(), [LaunchMode::Multiplayer, LaunchMode::Single]);

        // On the wire: lowercase, the way `client.json` and a manifest spell it.
        assert_eq!(serde_json::to_value(LaunchMode::Single).unwrap(), "single");
        assert_eq!(
            serde_json::from_value::<LaunchMode>(serde_json::json!("multiplayer")).unwrap(),
            LaunchMode::Multiplayer
        );
        assert!(serde_json::from_value::<LaunchMode>(serde_json::json!("sp")).is_err());
        assert_eq!(LaunchMode::default(), LaunchMode::Multiplayer);
        assert_eq!(LaunchMode::Single.as_str(), "single");

        // And in the answer of `list_engines`, next to the flattened entry.
        let listed = list_engines(Some(Game::JediAcademy)).expect("the registry answers");
        let entry = serde_json::to_value(listed.iter().find(|e| e.engine.id == "openjk").unwrap())
            .expect("serializes");
        assert_eq!(entry["modes"], serde_json::json!(["multiplayer", "single"]));
        assert!(entry.get("singlePlayer").is_none(), "the executable names stay in the core");
        let eternal = serde_json::to_value(listed.iter().find(|e| e.engine.id == "eternaljk").unwrap())
            .expect("serializes");
        assert_eq!(eternal["modes"], serde_json::json!(["multiplayer"]));
    }

    #[test]
    fn the_single_player_executable_is_found_in_either_width_or_named_when_missing() {
        let temp = tempfile::tempdir().unwrap();
        let openjk = require("openjk").unwrap();
        let dir = temp.path().join("openjk");
        std::fs::create_dir(&dir).unwrap();
        // Nothing installed: the x86 name, so a refusal can name the file.
        let missing = openjk.single_player_executable(&dir).expect("openjk has one");
        assert_eq!(missing, dir.join("openjk_sp.x86.exe"));
        assert!(!missing.is_file());
        // The x64 archive unpacked.
        std::fs::write(dir.join("openjk_sp.x86_64.exe"), b"MZ").unwrap();
        assert_eq!(openjk.single_player_executable(&dir).unwrap(), dir.join("openjk_sp.x86_64.exe"));
        // The x86 one, which keeps winning the way `installed_executable` does.
        std::fs::write(dir.join("openjk_sp.x86.exe"), b"MZ").unwrap();
        assert_eq!(openjk.single_player_executable(&dir).unwrap(), dir.join("openjk_sp.x86.exe"));
        // A build without a single-player game has no file to name.
        assert!(require("eternaljk").unwrap().single_player_executable(&dir).is_none());
    }

    // --- slice: play with friends ---

    #[test]
    fn every_engine_but_jamme_ships_a_dedicated_server() {
        for engine in ENGINES {
            assert_eq!(engine.dedicated.is_some(), engine.id != "jamme", "{}", engine.id);
            let listed = availability(engine, HostSystem::current());
            assert_eq!(listed.can_host, engine.id != "jamme", "{}", engine.id);
        }
        let json = serde_json::to_value(availability(require("jamme").unwrap(), HostSystem::current()))
            .expect("serializes");
        assert_eq!(json["canHost"], false);
        // The file names stay in the core, like the single-player ones.
        assert!(json.get("dedicated").is_none(), "{json}");
    }

    #[test]
    fn the_dedicated_server_follows_the_width_of_the_installed_client() {
        let temp = tempfile::tempdir().unwrap();
        let openjk = require("openjk").unwrap();
        let dir = temp.path().join("openjk");
        std::fs::create_dir(&dir).unwrap();
        // Nothing unpacked: no server to start.
        assert_eq!(openjk.dedicated_executable(&dir), None);

        // An x64 install with both servers in it starts the x64 one.
        std::fs::write(dir.join("openjk.x86_64.exe"), b"MZ").unwrap();
        std::fs::write(dir.join("openjkded.x86_64.exe"), b"MZ").unwrap();
        std::fs::write(dir.join("openjkded.x86.exe"), b"MZ").unwrap();
        assert_eq!(openjk.dedicated_executable(&dir), Some(dir.join("openjkded.x86_64.exe")));

        // An x86 install starts the x86 one.
        std::fs::write(dir.join("openjk.x86.exe"), b"MZ").unwrap();
        assert_eq!(openjk.dedicated_executable(&dir), Some(dir.join("openjkded.x86.exe")));

        // The other width stands in when the first one is gone.
        std::fs::remove_file(dir.join("openjkded.x86.exe")).unwrap();
        assert_eq!(openjk.dedicated_executable(&dir), Some(dir.join("openjkded.x86_64.exe")));

        // jaMME has nothing to find.
        assert_eq!(require("jamme").unwrap().dedicated_executable(&dir), None);
    }

    #[test]
    fn the_fallback_rule_catches_an_older_naming_scheme() {
        assert_eq!(
            pick("jamme", JAMME_1_11_ASSETS).as_deref(),
            Some("jaMME-1.11_Windows.zip")
        );
    }

    #[test]
    fn a_release_without_a_windows_build_matches_nothing() {
        let assets = ["eternaljk-linux-i686.tar.gz", "eternaljk-macos-x86_64.tar.gz"];
        assert!(pick("eternaljk", &assets).is_none());
        assert!(pick("openjk", &[]).is_none());
    }

    #[test]
    fn nothing_installed_means_an_update_is_available() {
        let client = client_with(None, None);
        let release = release_at("latest", "2026-07-11T05:36:53Z");
        assert!(is_update_available(&client, Some(&release)));
        assert!(!is_update_available(&client, None));
    }

    #[test]
    fn a_rolling_tag_updates_on_a_newer_publication_time() {
        let client = client_with(Some("latest"), Some("2026-07-11T05:36:53Z"));
        let same = release_at("latest", "2026-07-11T05:36:53Z");
        let newer = release_at("latest", "2026-09-01T00:00:00Z");
        assert!(!is_update_available(&client, Some(&same)));
        assert!(is_update_available(&client, Some(&newer)));
    }

    #[test]
    fn a_different_tag_is_an_update_whatever_the_time_says() {
        let client = client_with(Some("1.5.7"), Some("2026-09-01T00:00:00Z"));
        let other = release_at("1.5.8.5", "2020-06-15T21:56:55Z");
        assert!(is_update_available(&client, Some(&other)));
    }

    #[test]
    fn a_record_without_a_publication_time_does_not_nag() {
        let client = client_with(Some("latest"), None);
        let release = release_at("latest", "2026-09-01T00:00:00Z");
        assert!(!is_update_available(&client, Some(&release)));
    }

    fn client_with(version: Option<&str>, published: Option<&str>) -> Client {
        Client {
            id: "everyday".into(),
            name: "Everyday".into(),
            engine_id: "openjk".into(),
            game: Game::JediAcademy,
            engine_version: version.map(str::to_string),
            engine_published_at: published.map(str::to_string),
            engine_installed_at: None,
            fs_game: None,
            launch_args: String::new(),
            created_at: "2026-09-10T00:00:00Z".into(),
            modes: Vec::new(),
            bundle: None,
        }
    }

    fn release_at(tag: &str, published_at: &str) -> EngineRelease {
        EngineRelease {
            tag: tag.into(),
            name: tag.into(),
            published_at: published_at.into(),
            prerelease: false,
            asset_name: "OpenJK-windows-x86.zip".into(),
            asset_size: 6_070_386,
            asset_url: "https://example.invalid/OpenJK-windows-x86.zip".into(),
        }
    }

    // --- slice: bundles ---

    #[test]
    fn a_custom_build_from_a_bundle_is_not_replaced_by_a_release() {
        use crate::clients::ClientBundleLink;

        let link = ClientBundleLink {
            bundle_id: Some("01J".into()),
            bundle_slug: "taystjka-voip".into(),
            bundle_name: "Taystjka VoIP".into(),
            version_id: Some("01K".into()),
            version_label: "2026.1".into(),
            component_id: "mp".into(),
            component_label: "Multiplayer".into(),
            role: ClientBundleLink::INSTALLED.into(),
            engine_overlay: true,
            linked_at: "2026-09-15T00:00:00Z".into(),
            ..ClientBundleLink::default()
        };

        // Installed and overlaid: the update would wipe the overlay.
        let mut client = client_with(Some("v1.6.3"), Some("2026-09-01T00:00:00Z"));
        client.bundle = Some(link.clone());
        let error = refuse_overlay_update(&client).expect_err("refused");
        assert!(matches!(error, AppError::State(_)), "{error}");
        assert!(error.to_string().contains("Taystjka VoIP"), "{error}");

        // Not installed yet: a retry of the bundle install still has to
        // unpack the release, so nothing stands in its way.
        let mut fresh = client_with(None, None);
        fresh.bundle = Some(link.clone());
        refuse_overlay_update(&fresh).expect("nothing to protect yet");

        // A bundle without an overlay changes nothing about updates.
        let mut plain = client_with(Some("latest"), None);
        plain.bundle = Some(ClientBundleLink {
            engine_overlay: false,
            ..link
        });
        refuse_overlay_update(&plain).expect("a plain release updates as before");
        refuse_overlay_update(&client_with(Some("latest"), None)).expect("no bundle at all");
    }

    #[test]
    fn an_engine_install_waits_for_the_bundle_operation_that_holds_the_client() {
        use crate::clients;
        use crate::paths::DataPaths;

        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the layout");
        let client = clients::create_record(&paths, "Everyday", "openjk", Game::JediAcademy, None)
            .expect("a client");
        let bundles = BundlesState::default();

        // A bundle install holds the client: the window between its engine
        // step and its last step, where `engine\` holds the overlay and the
        // record does not say so yet.
        let install = bundles
            .claim(&client.id, BundlesState::INSTALL)
            .expect("the bundle install claims it");
        let error = admit_engine_install(&bundles, &paths, &client.id).expect_err("refused");
        assert!(matches!(error, AppError::Busy(_)), "{error}");
        assert!(error.to_string().contains("a bundle install"), "{error}");
        drop(install);

        // Free: admitted, and the claim it returns keeps a bundle operation
        // out for as long as the engine install runs.
        let claim = admit_engine_install(&bundles, &paths, &client.id).expect("admitted");
        let error = bundles
            .claim(&client.id, BundlesState::PUBLISH)
            .expect_err("the publish is refused while the engine installs");
        assert!(error.to_string().contains("an engine installation"), "{error}");
        drop(claim);
        bundles
            .claim(&client.id, BundlesState::PUBLISH)
            .expect("free once the engine install is over");

        // An unknown client is refused for what it is, and holds nothing.
        let error = admit_engine_install(&bundles, &paths, "ghost").expect_err("unknown");
        assert!(matches!(error, AppError::NotFound(_)), "{error}");
        bundles
            .claim("ghost", BundlesState::PUBLISH)
            .expect("a refused admission holds no claim");
    }
}
