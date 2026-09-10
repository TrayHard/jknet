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

use crate::clients::Client;
use crate::engine_install;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// One attempt at recognising the Windows 32-bit archive of a release.
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

/// One engine JKNet can install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    /// Stable key stored in `client.json`. Never shown to the player.
    pub id: &'static str,
    /// Name shown on the engine tile.
    pub name: &'static str,
    /// One sentence for the tile, in the interface language (English).
    pub description: &'static str,
    /// Executable inside the client's `engine\` folder.
    pub executable: &'static str,
    /// `owner/name` of the GitHub repository that publishes the releases.
    pub repo: &'static str,
    /// The build offered to a player who has no preference.
    pub recommended: bool,
    /// False when the project ships no archive JKNet can use. Such an engine
    /// stays in the list so the player learns why, instead of wondering where
    /// it went.
    pub installable: bool,
    /// Why [`Engine::installable`] is false. `None` when it is true.
    pub not_installable_reason: Option<&'static str>,
    /// `fs_game` the build needs to run at all. jaMME lives in `mme\` and
    /// starts into the main menu without it; the other three run from `base`.
    pub default_fs_game: Option<&'static str>,
    /// Whether a release flagged as a pre-release may be installed. Only the
    /// projects that publish rolling builds need it.
    #[serde(skip)]
    pub allow_prerelease: bool,
    /// Rules tried in order until one recognises an asset of the release.
    #[serde(skip)]
    pub asset_rules: &'static [AssetRule],
}

/// Every engine, in the order the Clients screen shows them.
///
/// Asset names observed on 2026-09-10 (GitHub API, `?per_page=10`):
///
/// | Engine | Newest release | Windows 32-bit asset | Executable in it |
/// | --- | --- | --- | --- |
/// | OpenJK | `latest`, rolling | `OpenJK-windows-x86.zip` | `openjk.x86.exe` |
/// | EternalJK | `1.5.8.5`, 2020-06-15 | `eternaljk-win32-portable.zip` | `eternaljk.x86.exe` |
/// | TaystJK | `latest`, rolling | `TaystJK-windows-x86.zip` | `taystjk.x86.exe` |
/// | jaMME | `latest`, rolling | `jamme-windows-x86.zip` | `jamme.exe` |
///
/// Two traps the rules exist for: the OpenJK release carries `OpenJO-*`
/// archives for the *other* game next to its own, and TaystJK publishes an
/// `-AddressSanitizer` build that is a debugging tool, not a game.
const ENGINES: &[Engine] = &[
    Engine {
        id: "openjk",
        name: "OpenJK",
        description: "The community reference build. Stable, closest to the original game.",
        executable: "openjk.x86.exe",
        repo: "JACoders/OpenJK",
        recommended: true,
        installable: true,
        not_installable_reason: None,
        default_fs_game: None,
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
    },
    Engine {
        id: "eternaljk",
        name: "EternalJK",
        description: "OpenJK with the modern multiplayer patches most servers expect.",
        executable: "eternaljk.x86.exe",
        repo: "eternalcodes/EternalJK",
        recommended: false,
        installable: true,
        not_installable_reason: None,
        default_fs_game: None,
        allow_prerelease: false,
        asset_rules: &[
            AssetRule {
                require: &["win32", ".zip"],
                // `ejk-japro-pk3only.zip` is content, not an engine.
                forbid: &["pk3only"],
            },
            AssetRule {
                require: &["windows", ".zip"],
                forbid: &["x86_64", "pk3only"],
            },
        ],
    },
    Engine {
        id: "taystjk",
        name: "TaystJK",
        description: "Fork focused on competitive play and quality of life fixes.",
        executable: "taystjk.x86.exe",
        repo: "taysta/TaystJK",
        recommended: false,
        installable: true,
        not_installable_reason: None,
        default_fs_game: None,
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
    },
    Engine {
        id: "jamme",
        name: "jaMME",
        description: "Movie maker edition: demo playback, camera work and capture.",
        // `jamme.exe`, without the `.x86` the other three carry.
        executable: "jamme.exe",
        repo: "entdark/jaMME",
        recommended: false,
        installable: true,
        not_installable_reason: None,
        // `start_jaMME.cmd` inside the archive runs
        // `jamme +set fs_game mme +set fs_extraGames "japlus japp"`.
        default_fs_game: Some("mme"),
        allow_prerelease: true,
        asset_rules: &[
            AssetRule {
                require: &["jamme-windows-x86", ".zip"],
                forbid: &["x86_64"],
            },
            AssetRule {
                require: &["windows", ".zip"],
                forbid: &["x86_64", "android", "macos", "arm"],
            },
        ],
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

/// Lists every engine the launcher knows.
#[tauri::command]
pub fn list_engines() -> Result<Vec<Engine>> {
    Ok(ENGINES.to_vec())
}

// ---------------------------------------------------------------------------
// Asset matching
// ---------------------------------------------------------------------------

/// Picks the asset of a release that holds the Windows 32-bit build.
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
            rule.require.iter().all(|needle| name.contains(needle))
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
#[tauri::command]
pub async fn install_engine(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    installs: tauri::State<'_, engine_install::InstallState>,
    client_id: String,
    tag: Option<String>,
) -> Result<Client> {
    let paths = state.paths()?;
    engine_install::install(&app, &installs, &paths, &client_id, tag.as_deref()).await
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

    fn pick(engine_id: &str, assets: &[&str]) -> Option<String> {
        let engine = find(engine_id).expect("engine is in the registry");
        match_asset(engine.asset_rules, assets.iter().copied())
            .map(|index| assets[index].to_string())
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
    fn exactly_one_engine_is_recommended() {
        let recommended: Vec<&str> = ENGINES
            .iter()
            .filter(|engine| engine.recommended)
            .map(|engine| engine.id)
            .collect();
        assert_eq!(recommended, vec!["openjk"]);
    }

    #[test]
    fn lookup_finds_a_known_engine_and_rejects_the_rest() {
        assert!(find("eternaljk").is_some());
        assert!(find("quake3").is_none());
        assert!(require("quake3").is_err());
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
            for rule in engine.asset_rules {
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
            engine_version: version.map(str::to_string),
            engine_published_at: published.map(str::to_string),
            engine_installed_at: None,
            fs_game: None,
            created_at: "2026-09-10T00:00:00Z".into(),
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
}
