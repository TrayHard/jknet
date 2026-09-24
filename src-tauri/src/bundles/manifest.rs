//! The manifest of a bundle version, and the checks both sides of the wire
//! apply to it.
//!
//! A manifest is the recipe of a set of clients. Each component names an
//! engine of the registry with its release tag, the modes it starts in, the
//! files laid over `engine\` and the files of the release taken out of it,
//! the files dropped into `home\`, the config documents, the mod folder and
//! the launch arguments; the `shared` part holds files and documents every
//! component gets. The launcher builds one out of a draft at publish time and
//! reads one at install time; the service stores it per version and computes
//! the counters of the catalogue from it.
//!
//! Schema 2, camelCase on the wire:
//!
//! ```json
//! {
//!   "schema": 2,
//!   "game": "ja",
//!   "components": [
//!     {
//!       "id": "mp", "label": "Multiplayer",
//!       "engine": { "engineId": "eternaljk", "releaseTag": "v1.6.3" },
//!       "modes": ["multiplayer"], "fsGame": "eternaljk", "launchArgs": "+set cg_fov 97",
//!       "overlay": {
//!         "files": [ { "root": "engine", "path": "eternaljk.x86.exe", "size": 1182208, "sha256": "7f3c…",
//!                      "kind": "exe", "source": { "kind": "blob" },
//!                      "replaces": { "sha256": "90ab…", "size": 1146368 } } ],
//!         "remove": ["rd-vulkan_x86.dll"]
//!       },
//!       "files": [ { "root": "home", "path": "eternaljk/japro-assets.pk3", "size": 25766353, "sha256": "a1b2…",
//!                    "kind": "pk3", "source": { "kind": "jkhub", "fileId": 3937, "version": "1.6.5" },
//!                    "library": { "category": "mod", "displayName": "JAPro assets", "entries": 1450,
//!                                 "folders": { "models": 266 }, "maps": [] },
//!                    "listing": { "sha256": "e5f6…", "size": 81920 } } ],
//!       "configs": [ { "name": "RUJKA binds", "text": "bind PGDN toggle cg_dismember 0 3\n", "priority": 0 } ]
//!     }
//!   ],
//!   "shared": {
//!     "files": [ { "root": "home", "path": "base/rus_sp.pk3", "size": 55703400, "sha256": "…", "kind": "pk3",
//!                  "source": { "kind": "blob" },
//!                  "origin": { "kind": "jkhub", "fileId": 1201, "sha256": "c3d4…", "modified": true } } ],
//!     "configs": []
//!   }
//! }
//! ```
//!
//! The checks of [`validate`] are the launcher's copy of the service's. A
//! manifest is data from the internet on the way in, and the path of every
//! file becomes a path on the player's disk, so a path is refused here by
//! the same rules `engine_install::safe_entry_path` applies to an archive:
//! no `..`, no leading slash, no drive letter, forward slashes only, at most
//! 260 characters. The service refuses the same manifest with `invalid`, so
//! a launcher that publishes one never learns about a rule from a `400`.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::engines::LaunchMode;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::library::LibraryCategory;

/// The one schema this build reads and writes. Schema 1 of the first
/// edition was never deployed and is not read.
pub const SCHEMA: u32 = 2;

/// Components of one bundle.
pub const MAX_COMPONENTS: usize = 8;

/// Longest `components[].id` and `engine.engineId`, matching
/// `[a-z0-9-]{1,32}` of the contract.
pub const MAX_ID: usize = 32;

/// Characters of `components[].label`.
pub const MAX_LABEL: usize = 40;

/// File entries of one version, components and `shared` together.
pub const MAX_FILES: usize = 500;

/// Entries of `overlay.remove` of one component.
pub const MAX_REMOVALS: usize = 200;

/// Characters of one file path.
pub const MAX_PATH_LEN: usize = 260;

/// Characters of `launchArgs`.
pub const MAX_LAUNCH_ARGS: usize = 2000;

/// Documents of one `configs` list.
pub const MAX_CONFIGS: usize = 20;

/// Characters of `configs[].name`.
pub const MAX_CONFIG_NAME: usize = 64;

/// Bytes of `configs[].text`.
pub const MAX_CONFIG_TEXT: usize = 64 * 1024;

/// Top-level folders `library.folders` may name.
pub const MAX_LIBRARY_FOLDERS: usize = 32;

/// Map names `library.maps` may list.
pub const MAX_LIBRARY_MAPS: usize = 64;

/// Badges `library.features` may carry: the limit of the service, which
/// `file_preview_contents::features` keeps to when it names them.
pub const MAX_LIBRARY_FEATURES: usize = 32;

/// Bytes one badge code may be long: the limit of the service.
pub const MAX_LIBRARY_FEATURE_LEN: usize = 32;

/// Whether a code may stand in `library.features`, by the rule of the
/// service: `[a-z0-9-]` with one optional `:` group, as in
/// `strings:russian`, and at most [`MAX_LIBRARY_FEATURE_LEN`] bytes.
pub(crate) fn is_library_feature(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= MAX_LIBRARY_FEATURE_LEN
        && code.split(':').count() <= 2
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b':')
}

/// Bytes of one file the service stores: `JKNET_ONLINE_BUNDLE_MAX_FILE_BYTES`
/// at its default. A bigger file is refused when it is added to a draft
/// rather than after the upload.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Bytes of every `blob` file of one version together:
/// `JKNET_ONLINE_BUNDLE_MAX_VERSION_BYTES` at its default.
pub const MAX_VERSION_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The scope name of the files and documents every component gets. Never a
/// component id: see [`check_component_id`].
pub const SHARED_SCOPE: &str = "shared";

/// The manifest of one version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    /// `ja` or `jo`. A string rather than [`Game`], so a manifest of a game
    /// this build does not know is refused with a sentence rather than a
    /// parse error.
    pub game: String,
    #[serde(default)]
    pub components: Vec<ManifestComponent>,
    #[serde(default)]
    pub shared: ManifestShared,
}

/// One component: a client of the bundle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestComponent {
    /// `[a-z0-9-]{1,32}`, unique in the bundle. The scope of the files of
    /// the component in a draft, and the id a client remembers.
    pub id: String,
    /// What the card of the client shows after the name of the bundle.
    pub label: String,
    pub engine: ManifestEngine,
    /// The modes the client made of this component starts in, a subset of
    /// the modes of the engine.
    #[serde(default)]
    pub modes: Vec<LaunchMode>,
    /// The mod folder, `None` for `base`. The same rules as the field of a
    /// client.
    #[serde(default)]
    pub fs_game: Option<String>,
    #[serde(default)]
    pub launch_args: String,
    #[serde(default)]
    pub overlay: ManifestOverlay,
    /// Files of `home\`.
    #[serde(default)]
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub configs: Vec<ManifestConfig>,
}

/// The engine of a component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEngine {
    /// Id of the registry entry. The service knows nothing about engines;
    /// the launcher requires the entry for the game of the bundle.
    pub engine_id: String,
    /// The GitHub tag, or `None` for the newest release at install time.
    #[serde(default)]
    pub release_tag: Option<String>,
}

/// What a component does to `engine\`: files laid over the release, and
/// files of the release taken out.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestOverlay {
    /// Files with `root: "engine"`.
    #[serde(default)]
    pub files: Vec<ManifestFile>,
    /// Paths of files of the release the install deletes from `engine\`.
    #[serde(default)]
    pub remove: Vec<String>,
}

impl ManifestOverlay {
    /// Whether the component changes `engine\` at all.
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.remove.is_empty()
    }
}

/// The files and documents every component of the bundle gets.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestShared {
    /// Files with `root: "home"`.
    #[serde(default)]
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub configs: Vec<ManifestConfig>,
}

/// Where a file lands: the engine folder or the home folder of the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileRoot {
    Home,
    Engine,
}

impl FileRoot {
    /// The wire spelling, which is also the folder name inside the client
    /// and inside the `files\` folder of a draft.
    pub fn as_str(self) -> &'static str {
        match self {
            FileRoot::Home => "home",
            FileRoot::Engine => "engine",
        }
    }
}

/// What a file is, by its extension. The service computes it itself and
/// trusts nothing the launcher sends; the launcher computes it the same way
/// for its drafts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Pk3,
    Cfg,
    Dll,
    Exe,
    Other,
}

impl FileKind {
    /// The kind of a path, from its extension alone.
    pub fn of_path(path: &str) -> FileKind {
        let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        match name.rsplit_once('.').map(|(_, extension)| extension) {
            Some("pk3") => FileKind::Pk3,
            Some("cfg") => FileKind::Cfg,
            Some("dll") => FileKind::Dll,
            Some("exe") => FileKind::Exe,
            _ => FileKind::Other,
        }
    }

    /// Whether a version carrying this file goes to a reviewer first.
    pub fn is_executable(self) -> bool {
        matches!(self, FileKind::Dll | FileKind::Exe)
    }

    /// `serde(default)` of a manifest written by a service that left the
    /// kind out: the launcher recomputes it from the path anyway.
    fn other() -> FileKind {
        FileKind::Other
    }
}

/// Where the bytes of a file come from at install time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileSource {
    /// A record of jkhub.org: the launcher downloads it the way the JKHub
    /// tab does and takes the pk3 of this name out of the archive.
    Jkhub {
        #[serde(rename = "fileId")]
        file_id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// A file of the service's own store, addressed by its SHA-256.
    Blob,
}

impl FileSource {
    pub fn is_blob(&self) -> bool {
        matches!(self, FileSource::Blob)
    }
}

/// Where a `blob` file was taken from before the author changed it, for the
/// card that says what differs from the original.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileOrigin {
    Jkhub {
        #[serde(rename = "fileId")]
        file_id: u32,
        /// SHA-256 of the file as JKHub served it.
        #[serde(default)]
        sha256: String,
        /// Always `true`: an unchanged JKHub file is a `jkhub` source, not a
        /// blob with an origin.
        #[serde(default)]
        modified: bool,
    },
}

/// The file of the release an overlay file replaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

/// The listing of a pk3 in the store of the service: the hash and size of
/// the JSON document that names every entry of the archive, see
/// [`crate::bundles::listing`]. Only a pk3 carries one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingRef {
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

/// What the Library screen would say about a pk3, carried along so the
/// catalogue can say it before anything is downloaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub category: LibraryCategory,
    #[serde(default)]
    pub display_name: String,
    /// Files inside the archive, folder entries excluded.
    #[serde(default)]
    pub entries: u32,
    /// Top-level folder to the number of files under it, at most
    /// [`MAX_LIBRARY_FOLDERS`] of them.
    #[serde(default)]
    pub folders: BTreeMap<String, u32>,
    /// Names of the maps inside, at most [`MAX_LIBRARY_MAPS`].
    #[serde(default)]
    pub maps: Vec<String>,
    /// The badges of the card, the codes of
    /// [`crate::library::LibraryItem::features`], at most
    /// [`MAX_LIBRARY_FEATURES`] of them, each one [`is_library_feature`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,
}

/// One file of a bundle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub root: FileRoot,
    /// Relative path inside the root, forward slashes.
    pub path: String,
    pub size: u64,
    /// Lowercase hex.
    pub sha256: String,
    #[serde(default = "FileKind::other")]
    pub kind: FileKind,
    pub source: FileSource,
    /// The file of the release this overlay file replaces; absent on a file
    /// added next to the release and on every file of `home\`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<ReplacedFile>,
    /// Where a `blob` file came from before it was changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<FileOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<LibraryInfo>,
    /// The listing of the archive in the store, on a pk3 only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listing: Option<ListingRef>,
}

/// One config document of a bundle, in the order the layers apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestConfig {
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub priority: i32,
}

impl Manifest {
    /// Every file of every part, in manifest order: the overlay and the
    /// files of each component, then the shared files.
    pub fn all_files(&self) -> impl Iterator<Item = &ManifestFile> {
        self.components
            .iter()
            .flat_map(|component| component.overlay.files.iter().chain(component.files.iter()))
            .chain(self.shared.files.iter())
    }

    /// The component with this id.
    pub fn component(&self, id: &str) -> Option<&ManifestComponent> {
        self.components.iter().find(|component| component.id == id)
    }

    /// Whether a version carrying these files goes to a reviewer first.
    pub fn has_executables(&self) -> bool {
        self.all_files().any(|file| file.kind.is_executable())
    }

    /// Bytes the service stores for this version: every `blob` file and the
    /// listing of every pk3, whichever source the pk3 has, the way the
    /// service sums `blobBytes` from the files the store must hold.
    pub fn blob_bytes(&self) -> u64 {
        self.all_files()
            .map(|file| {
                let listing = file.listing.as_ref().map_or(0, |listing| listing.size);
                if file.source.is_blob() {
                    file.size + listing
                } else {
                    listing
                }
            })
            .sum()
    }
}

impl ManifestComponent {
    /// Whether the component lays files over `engine\` or takes files out
    /// of it: what the link of the client records as `engineOverlay`.
    pub fn has_engine_overlay(&self) -> bool {
        !self.overlay.is_empty()
    }
}

/// Refuses a manifest the launcher must not act on.
///
/// The error names the first rule broken and nothing else: a manifest is
/// built by the launcher itself or checked by the service before it is
/// stored, so a broken one is a bug report, not a form to correct.
pub fn validate(manifest: &Manifest) -> Result<()> {
    if manifest.schema != SCHEMA {
        return Err(AppError::BundleUnavailable(format!(
            "the manifest uses schema {}, and this version of JKNet reads schema {SCHEMA}. Update the launcher.",
            manifest.schema
        )));
    }
    if Game::from_id(&manifest.game).is_none() {
        return Err(AppError::BundleUnavailable(format!(
            "the manifest names the game {:?}, which this launcher does not play",
            manifest.game
        )));
    }
    if manifest.components.is_empty() || manifest.components.len() > MAX_COMPONENTS {
        return Err(AppError::InvalidInput(format!(
            "the manifest lists {} components; a bundle has 1 to {MAX_COMPONENTS}",
            manifest.components.len()
        )));
    }

    let total = manifest.all_files().count();
    if total > MAX_FILES {
        return Err(AppError::InvalidInput(format!(
            "the manifest lists {total} files, more than the {MAX_FILES} allowed"
        )));
    }

    let mut ids = HashSet::with_capacity(manifest.components.len());
    let mut blob_bytes: u64 = 0;
    let shared_paths: Vec<String> = manifest
        .shared
        .files
        .iter()
        .map(|file| file.path.to_ascii_lowercase())
        .collect();
    for component in &manifest.components {
        check_component_id(&component.id)?;
        if !ids.insert(component.id.clone()) {
            return Err(AppError::InvalidInput(format!(
                "the manifest lists the component {:?} twice",
                component.id
            )));
        }
        let label = component.label.trim().chars().count();
        if label == 0 || label > MAX_LABEL {
            return Err(AppError::InvalidInput(format!(
                "the label of the component {:?} is empty or longer than {MAX_LABEL} characters",
                component.id
            )));
        }
        check_engine_id(&component.engine.engine_id)?;
        check_modes(&component.id, &component.modes)?;
        if component.launch_args.chars().count() > MAX_LAUNCH_ARGS {
            return Err(AppError::InvalidInput(format!(
                "the launch arguments of {:?} are longer than {MAX_LAUNCH_ARGS} characters",
                component.id
            )));
        }
        if let Some(folder) = &component.fs_game {
            if crate::clients::validate_fs_game(folder)?.is_none() {
                return Err(AppError::InvalidInput(format!(
                    "the mod folder of {:?} is blank",
                    component.id
                )));
            }
        }

        // The overlay: engine files, and the paths taken out.
        let mut engine_paths = HashSet::new();
        for file in &component.overlay.files {
            if file.root != FileRoot::Engine {
                return Err(AppError::InvalidInput(format!(
                    "{} sits in the overlay of {:?} with root {}",
                    file.path,
                    component.id,
                    file.root.as_str()
                )));
            }
            check_file(file, &mut blob_bytes)?;
            if !engine_paths.insert(file.path.to_ascii_lowercase()) {
                return Err(AppError::InvalidInput(format!(
                    "the overlay of {:?} lists {} twice",
                    component.id, file.path
                )));
            }
            if let Some(replaced) = &file.replaces {
                check_sha256(&replaced.sha256)?;
            }
        }
        if component.overlay.remove.len() > MAX_REMOVALS {
            return Err(AppError::InvalidInput(format!(
                "{:?} removes {} files of the release, more than the {MAX_REMOVALS} allowed",
                component.id,
                component.overlay.remove.len()
            )));
        }
        for path in &component.overlay.remove {
            check_path(path)?;
        }

        // The files of home: unique inside the component and against shared.
        let mut home_paths = HashSet::new();
        for file in &component.files {
            if file.root != FileRoot::Home {
                return Err(AppError::InvalidInput(format!(
                    "{} sits in the files of {:?} with root {}",
                    file.path,
                    component.id,
                    file.root.as_str()
                )));
            }
            check_file(file, &mut blob_bytes)?;
            let lower = file.path.to_ascii_lowercase();
            if !home_paths.insert(lower.clone()) {
                return Err(AppError::InvalidInput(format!(
                    "{:?} lists {} twice",
                    component.id, file.path
                )));
            }
            if shared_paths.contains(&lower) {
                return Err(AppError::InvalidInput(format!(
                    "{} is both a file of {:?} and a shared file",
                    file.path, component.id
                )));
            }
        }
        check_configs(&component.configs, &component.id)?;
    }

    let mut seen_shared = HashSet::new();
    for file in &manifest.shared.files {
        if file.root != FileRoot::Home {
            return Err(AppError::InvalidInput(format!(
                "{} sits in the shared files with root {}",
                file.path,
                file.root.as_str()
            )));
        }
        check_file(file, &mut blob_bytes)?;
        if !seen_shared.insert(file.path.to_ascii_lowercase()) {
            return Err(AppError::InvalidInput(format!(
                "the shared files list {} twice",
                file.path
            )));
        }
    }
    check_configs(&manifest.shared.configs, SHARED_SCOPE)?;

    if blob_bytes > MAX_VERSION_BYTES {
        return Err(AppError::InvalidInput(format!(
            "the files of the version add up to more than the {} GiB a version may hold",
            MAX_VERSION_BYTES / (1024 * 1024 * 1024)
        )));
    }
    Ok(())
}

/// The rules of one file entry, wherever it sits.
fn check_file(file: &ManifestFile, blob_bytes: &mut u64) -> Result<()> {
    check_path(&file.path)?;
    check_sha256(&file.sha256)?;
    if file.source.is_blob() {
        if file.size > MAX_FILE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "{} is bigger than the {} MiB a bundle file may be",
                file.path,
                MAX_FILE_BYTES / (1024 * 1024)
            )));
        }
        *blob_bytes = blob_bytes.saturating_add(file.size);
    }
    if let Some(FileOrigin::Jkhub { sha256, .. }) = &file.origin {
        if !sha256.is_empty() {
            check_sha256(sha256)?;
        }
    }
    if let Some(listing) = &file.listing {
        if file.kind != FileKind::Pk3 {
            return Err(AppError::InvalidInput(format!(
                "{} carries a listing, which only a pk3 may",
                file.path
            )));
        }
        check_sha256(&listing.sha256)?;
        // The store holds the listing next to the files: the service counts
        // it into the bytes of the version.
        *blob_bytes = blob_bytes.saturating_add(listing.size);
    }
    if let Some(library) = &file.library {
        if file.kind != FileKind::Pk3 || file.root != FileRoot::Home {
            return Err(AppError::InvalidInput(format!(
                "{} carries library details, which only a pk3 in home may",
                file.path
            )));
        }
        if library.folders.len() > MAX_LIBRARY_FOLDERS {
            return Err(AppError::InvalidInput(format!(
                "{} names more than {MAX_LIBRARY_FOLDERS} folders",
                file.path
            )));
        }
        if library.maps.len() > MAX_LIBRARY_MAPS {
            return Err(AppError::InvalidInput(format!(
                "{} names more than {MAX_LIBRARY_MAPS} maps",
                file.path
            )));
        }
        if library.features.len() > MAX_LIBRARY_FEATURES {
            return Err(AppError::InvalidInput(format!(
                "{} carries more than {MAX_LIBRARY_FEATURES} badges",
                file.path
            )));
        }
        if let Some(code) = library.features.iter().find(|code| !is_library_feature(code)) {
            return Err(AppError::InvalidInput(format!(
                "{} carries the badge {code:?}, which is not lowercase letters, digits and hyphens with one optional colon",
                file.path
            )));
        }
    }
    Ok(())
}

/// The rules of one `configs` list.
fn check_configs(configs: &[ManifestConfig], scope: &str) -> Result<()> {
    if configs.len() > MAX_CONFIGS {
        return Err(AppError::InvalidInput(format!(
            "{scope:?} carries {} config documents, more than the {MAX_CONFIGS} allowed",
            configs.len()
        )));
    }
    for config in configs {
        let name = config.name.trim();
        if name.is_empty() || name.chars().count() > MAX_CONFIG_NAME {
            return Err(AppError::InvalidInput(format!(
                "the config name {:?} is empty or longer than {MAX_CONFIG_NAME} characters",
                config.name
            )));
        }
        if config.text.len() > MAX_CONFIG_TEXT {
            return Err(AppError::InvalidInput(format!(
                "the config {name:?} is longer than {} KiB",
                MAX_CONFIG_TEXT / 1024
            )));
        }
    }
    Ok(())
}

/// Refuses an empty mode list, a mode named twice, and nothing else: the
/// modes the engine has are checked at install time against the registry.
pub fn check_modes(component_id: &str, modes: &[LaunchMode]) -> Result<()> {
    if modes.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "the component {component_id:?} starts in no mode"
        )));
    }
    let mut seen = HashSet::new();
    for mode in modes {
        if !seen.insert(*mode) {
            return Err(AppError::InvalidInput(format!(
                "the component {component_id:?} names the mode {} twice",
                mode.as_str()
            )));
        }
    }
    Ok(())
}

/// Refuses an id outside `[a-z0-9-]{1,32}`: the alphabet of an engine id
/// and of a component id.
fn check_slug(what: &str, id: &str) -> Result<()> {
    let plain = !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !plain {
        return Err(AppError::InvalidInput(format!(
            "the {what} {id:?} is not lowercase letters, digits and hyphens of at most {MAX_ID} characters"
        )));
    }
    Ok(())
}

/// Refuses an engine id outside `[a-z0-9-]{1,32}`.
pub fn check_engine_id(engine_id: &str) -> Result<()> {
    check_slug("engine id", engine_id)
}

/// Refuses a component id outside `[a-z0-9-]{1,32}`, and the word `shared`,
/// which names the other scope of a draft.
pub fn check_component_id(id: &str) -> Result<()> {
    check_slug("component id", id)?;
    if id == SHARED_SCOPE {
        return Err(AppError::InvalidInput(format!(
            "{SHARED_SCOPE:?} is not a component id: it names the shared files"
        )));
    }
    Ok(())
}

/// Refuses a path that could land anywhere but inside its root.
///
/// The rules of `engine_install::safe_entry_path`, spelled for a string that
/// has to be portable rather than for a path on this machine: forward
/// slashes only, no leading slash, no drive letter or stream (`:`), no `.`
/// or `..` segment, no empty segment, nothing a Windows file name cannot be.
pub fn check_path(path: &str) -> Result<()> {
    let refuse = |why: &str| {
        Err(AppError::InvalidInput(format!(
            "the file path {path:?} {why}"
        )))
    };
    if path.is_empty() {
        return refuse("is empty");
    }
    if path.chars().count() > MAX_PATH_LEN {
        return refuse(&format!("is longer than {MAX_PATH_LEN} characters"));
    }
    if path.contains('\\') {
        return refuse("uses backslashes; a manifest path uses forward slashes");
    }
    if path.contains(':') {
        return refuse("carries a drive letter or a stream");
    }
    if path.starts_with('/') {
        return refuse("starts with a slash");
    }
    if path.chars().any(char::is_control) {
        return refuse("carries a control character");
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return refuse("has an empty segment");
        }
        if segment == "." || segment == ".." {
            return refuse("walks out of its folder");
        }
        if segment.ends_with([' ', '.']) || segment.starts_with(' ') {
            return refuse("has a segment Windows would trim");
        }
        if is_reserved_device(segment) {
            return refuse("names a device rather than a file");
        }
    }
    Ok(())
}

/// Refuses anything but 64 lowercase hex characters.
pub fn check_sha256(hash: &str) -> Result<()> {
    let hex = hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !hex {
        return Err(AppError::InvalidInput(format!(
            "{hash:?} is not a lowercase SHA-256"
        )));
    }
    Ok(())
}

/// The DOS device names Windows still answers to, with or without an
/// extension: `CON.pk3` opens the console rather than a file.
fn is_reserved_device(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or_default();
    if ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return true;
    }
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && matches!(bytes[3], b'1'..=b'9')
        && (stem[..3].eq_ignore_ascii_case("COM") || stem[..3].eq_ignore_ascii_case("LPT"))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// A file entry with a made-up hash, for manifests built by hand.
    pub(crate) fn file(root: FileRoot, path: &str, source: FileSource) -> ManifestFile {
        ManifestFile {
            root,
            path: path.into(),
            size: 3,
            sha256: "a".repeat(64),
            kind: FileKind::of_path(path),
            source,
            replaces: None,
            origin: None,
            library: None,
            listing: None,
        }
    }

    /// The manifest of the design document: an EternalJK component with an
    /// overlay, a JKHub pk3 and a config, an OpenJK single-player component
    /// with a config file, and a shared pk3 that was changed after it came
    /// from JKHub.
    pub(crate) fn manifest() -> Manifest {
        let mut exe = file(FileRoot::Engine, "eternaljk.x86.exe", FileSource::Blob);
        exe.replaces = Some(ReplacedFile {
            sha256: "9".repeat(64),
            size: 1_146_368,
        });
        let mut japro = file(
            FileRoot::Home,
            "eternaljk/japro-assets.pk3",
            FileSource::Jkhub {
                file_id: 3937,
                version: Some("1.6.5".into()),
                title: Some("JAPro".into()),
                url: Some("https://jkhub.org/files/file/3937-japro/".into()),
            },
        );
        japro.library = Some(LibraryInfo {
            category: LibraryCategory::Mod,
            display_name: "JAPro assets".into(),
            entries: 1450,
            folders: BTreeMap::from([("models".to_string(), 266), ("sound".to_string(), 879)]),
            maps: Vec::new(),
            features: vec!["textures".into()],
        });
        let mut rus = file(FileRoot::Home, "base/rus_sp.pk3", FileSource::Blob);
        rus.origin = Some(FileOrigin::Jkhub {
            file_id: 1201,
            sha256: "c".repeat(64),
            modified: true,
        });
        Manifest {
            schema: SCHEMA,
            game: "ja".into(),
            components: vec![
                ManifestComponent {
                    id: "mp".into(),
                    label: "Multiplayer".into(),
                    engine: ManifestEngine {
                        engine_id: "eternaljk".into(),
                        release_tag: Some("v1.6.3".into()),
                    },
                    modes: vec![LaunchMode::Multiplayer],
                    fs_game: Some("eternaljk".into()),
                    launch_args: "+set cg_fov 97".into(),
                    overlay: ManifestOverlay {
                        files: vec![exe],
                        remove: vec!["rd-vulkan_x86.dll".into()],
                    },
                    files: vec![japro],
                    configs: vec![ManifestConfig {
                        name: "RUJKA binds".into(),
                        text: "bind PGDN toggle cg_dismember 0 3\n".into(),
                        priority: 0,
                    }],
                },
                ManifestComponent {
                    id: "sp".into(),
                    label: "Single player".into(),
                    engine: ManifestEngine {
                        engine_id: "openjk".into(),
                        release_tag: None,
                    },
                    modes: vec![LaunchMode::Single],
                    fs_game: None,
                    launch_args: String::new(),
                    overlay: ManifestOverlay::default(),
                    files: vec![file(FileRoot::Home, "base/autoexec_sp.cfg", FileSource::Blob)],
                    configs: Vec::new(),
                },
            ],
            shared: ManifestShared {
                files: vec![rus],
                configs: Vec::new(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{file, manifest};
    use super::*;

    #[test]
    fn the_manifest_of_the_design_document_round_trips_in_camel_case() {
        let json = serde_json::to_value(manifest()).expect("it serializes");
        assert_eq!(json["schema"], 2);
        let mp = &json["components"][0];
        assert_eq!(mp["id"], "mp");
        assert_eq!(mp["engine"]["engineId"], "eternaljk");
        assert_eq!(mp["engine"]["releaseTag"], "v1.6.3");
        assert_eq!(mp["modes"], serde_json::json!(["multiplayer"]));
        assert_eq!(mp["fsGame"], "eternaljk");
        assert_eq!(mp["launchArgs"], "+set cg_fov 97");
        assert_eq!(mp["overlay"]["files"][0]["root"], "engine");
        assert_eq!(mp["overlay"]["files"][0]["kind"], "exe");
        assert_eq!(mp["overlay"]["files"][0]["source"], serde_json::json!({ "kind": "blob" }));
        assert_eq!(mp["overlay"]["files"][0]["replaces"]["size"], 1_146_368);
        assert_eq!(mp["overlay"]["remove"], serde_json::json!(["rd-vulkan_x86.dll"]));
        assert_eq!(mp["files"][0]["source"]["kind"], "jkhub");
        assert_eq!(mp["files"][0]["source"]["fileId"], 3937);
        assert_eq!(mp["files"][0]["library"]["folders"]["sound"], 879);
        assert!(mp["files"][0].get("replaces").is_none(), "absent stays absent");
        assert!(mp["files"][0].get("origin").is_none());
        assert_eq!(mp["configs"][0]["priority"], 0);
        let sp = &json["components"][1];
        assert_eq!(sp["engine"]["releaseTag"], serde_json::Value::Null);
        assert_eq!(sp["modes"], serde_json::json!(["single"]));
        assert_eq!(sp["fsGame"], serde_json::Value::Null);
        let shared = &json["shared"]["files"][0];
        assert_eq!(shared["origin"]["kind"], "jkhub");
        assert_eq!(shared["origin"]["fileId"], 1201);
        assert_eq!(shared["origin"]["modified"], true);

        let back: Manifest = serde_json::from_value(json).expect("it parses");
        assert_eq!(back, manifest());
        validate(&back).expect("the example manifest is valid");
        assert!(back.has_executables());
        assert_eq!(back.blob_bytes(), 9, "three blob files of three bytes");
        // The listing of a pk3 is a file of the store too, whichever source
        // the pk3 has: the service counts it into the bytes of the version.
        let mut listed = back.clone();
        listed.components[0].files[0].listing = Some(ListingRef {
            sha256: "b".repeat(64),
            size: 120,
        });
        listed.shared.files[0].listing = Some(ListingRef {
            sha256: "d".repeat(64),
            size: 8,
        });
        assert!(!listed.components[0].files[0].source.is_blob(), "japro comes from JKHub");
        assert_eq!(listed.blob_bytes(), 9 + 120 + 8);
        assert_eq!(back.all_files().count(), 4);
        assert!(back.component("mp").unwrap().has_engine_overlay());
        assert!(!back.component("sp").unwrap().has_engine_overlay());
        assert!(back.component("shared").is_none());
    }

    #[test]
    fn a_manifest_that_leaves_the_optional_parts_out_parses_with_its_defaults() {
        // No `fsGame`, no `launchArgs`, no `overlay`, no `kind`, no
        // `shared`, no `priority`: everything the contract lets a side leave
        // out.
        let text = r#"{"schema":2,"game":"jo","components":[{"id":"mv","label":"JK2MV",
            "engine":{"engineId":"jk2mv"},"modes":["multiplayer"],
            "files":[{"root":"home","path":"base/mymap.pk3","size":10,"sha256":"0000000000000000000000000000000000000000000000000000000000000000","source":{"kind":"blob"}}],
            "configs":[{"name":"x","text":"seta rate 25000"}]}]}"#;
        let parsed: Manifest = serde_json::from_str(text).expect("it parses");
        let component = &parsed.components[0];
        assert_eq!(component.fs_game, None);
        assert_eq!(component.launch_args, "");
        assert_eq!(component.engine.release_tag, None);
        assert!(component.overlay.is_empty());
        assert_eq!(component.files[0].kind, FileKind::Other, "left out reads as other");
        assert_eq!(component.configs[0].priority, 0);
        assert!(parsed.shared.files.is_empty());
        validate(&parsed).expect("valid");
    }

    #[test]
    fn kinds_follow_the_extension_and_executables_are_told_apart() {
        assert_eq!(FileKind::of_path("base/JAPro.PK3"), FileKind::Pk3);
        assert_eq!(FileKind::of_path("autoexec.cfg"), FileKind::Cfg);
        assert_eq!(FileKind::of_path("base/cgamex86.dll"), FileKind::Dll);
        assert_eq!(FileKind::of_path("taystjk.x86.exe"), FileKind::Exe);
        assert_eq!(FileKind::of_path("readme.txt"), FileKind::Other);
        assert_eq!(FileKind::of_path("no-extension"), FileKind::Other);
        assert!(FileKind::Dll.is_executable());
        assert!(FileKind::Exe.is_executable());
        assert!(!FileKind::Pk3.is_executable());

        let mut plain = manifest();
        assert!(plain.has_executables());
        plain.components[0].overlay = ManifestOverlay::default();
        assert!(!plain.has_executables());
        validate(&plain).expect("a manifest without an overlay is valid too");
    }

    #[test]
    fn paths_that_could_leave_the_client_are_refused() {
        for path in [
            "",
            "../evil.pk3",
            "base/../../evil.pk3",
            "/etc/passwd",
            "C:/Windows/evil.dll",
            "C:evil.dll",
            "base\\evil.pk3",
            "base//evil.pk3",
            "base/",
            "base/./x.pk3",
            "base/evil.pk3 ",
            "base/evil.pk3.",
            "base/CON.pk3",
            "base/lpt1.cfg",
            "base/ev\u{0}il.pk3",
            "base/evil:stream.pk3",
        ] {
            assert!(check_path(path).is_err(), "{path:?} should be refused");
        }
        assert!(check_path(&"x".repeat(MAX_PATH_LEN + 1)).is_err());
        for path in [
            "taystjk.x86.exe",
            "base/cgamex86.dll",
            "taystjk/japro-assets.pk3",
            "base/My Map v2.pk3",
            "base/мод.pk3",
            "base/COM0.pk3",
            "base/console.cfg",
        ] {
            check_path(path).unwrap_or_else(|e| panic!("{path:?} should pass: {e}"));
        }
        assert!(check_path(&"x".repeat(MAX_PATH_LEN)).is_ok());
    }

    #[test]
    fn a_hash_is_sixty_four_lowercase_hex_characters() {
        check_sha256(&"0123456789abcdef".repeat(4)).expect("lowercase hex");
        assert!(check_sha256(&"0123456789ABCDEF".repeat(4)).is_err(), "uppercase");
        assert!(check_sha256(&"0".repeat(63)).is_err(), "too short");
        assert!(check_sha256(&"g".repeat(64)).is_err(), "not hex");
    }

    #[test]
    fn engine_and_component_ids_follow_the_registry_alphabet() {
        check_engine_id("taystjk").expect("plain");
        check_engine_id("jk2mv").expect("with a digit");
        assert!(check_engine_id("").is_err());
        assert!(check_engine_id("TaystJK").is_err());
        assert!(check_engine_id("taystjk/x").is_err());
        assert!(check_engine_id(&"a".repeat(MAX_ID + 1)).is_err());

        check_component_id("mp").expect("plain");
        check_component_id("single-player-2").expect("with hyphens and a digit");
        assert!(check_component_id("Single").is_err(), "uppercase");
        assert!(check_component_id("").is_err());
        assert!(check_component_id(SHARED_SCOPE).is_err(), "the other scope");
    }

    #[test]
    fn the_rules_of_the_contract_are_refused_one_by_one() {
        let mut other_schema = manifest();
        other_schema.schema = 1;
        assert!(matches!(
            validate(&other_schema),
            Err(AppError::BundleUnavailable(_))
        ));

        let mut other_game = manifest();
        other_game.game = "q3".into();
        assert!(matches!(validate(&other_game), Err(AppError::BundleUnavailable(_))));

        let mut none = manifest();
        none.components.clear();
        assert!(validate(&none).is_err(), "no components");
        let mut many = manifest();
        for i in 0..MAX_COMPONENTS {
            let mut extra = manifest().components[1].clone();
            extra.id = format!("c{i}");
            many.components.push(extra);
        }
        assert!(validate(&many).is_err(), "nine components");

        let mut same_id = manifest();
        same_id.components[1].id = "mp".into();
        assert!(validate(&same_id).is_err(), "the same id twice");
        let mut bad_id = manifest();
        bad_id.components[1].id = "Single".into();
        assert!(validate(&bad_id).is_err());
        let mut shared_id = manifest();
        shared_id.components[1].id = SHARED_SCOPE.into();
        assert!(validate(&shared_id).is_err());

        let mut long_label = manifest();
        long_label.components[0].label = "x".repeat(MAX_LABEL + 1);
        assert!(validate(&long_label).is_err());
        let mut blank_label = manifest();
        blank_label.components[0].label = "  ".into();
        assert!(validate(&blank_label).is_err());

        let mut no_modes = manifest();
        no_modes.components[0].modes.clear();
        assert!(validate(&no_modes).is_err());
        let mut twice_a_mode = manifest();
        twice_a_mode.components[0].modes = vec![LaunchMode::Multiplayer, LaunchMode::Multiplayer];
        assert!(validate(&twice_a_mode).is_err());
        let mut both_modes = manifest();
        both_modes.components[1].modes = vec![LaunchMode::Multiplayer, LaunchMode::Single];
        validate(&both_modes).expect("both modes, once each");

        let mut long_args = manifest();
        long_args.components[0].launch_args = "x".repeat(MAX_LAUNCH_ARGS + 1);
        assert!(validate(&long_args).is_err());

        let mut bad_folder = manifest();
        bad_folder.components[0].fs_game = Some("../base".into());
        assert!(validate(&bad_folder).is_err());

        let mut too_many = manifest();
        too_many.shared.files = (0..MAX_FILES)
            .map(|i| file(FileRoot::Home, &format!("base/{i}.pk3"), FileSource::Blob))
            .collect();
        assert!(validate(&too_many).is_err(), "501 files in all");

        let mut home_in_overlay = manifest();
        home_in_overlay.components[0].overlay.files[0].root = FileRoot::Home;
        assert!(validate(&home_in_overlay).is_err());
        let mut engine_in_files = manifest();
        engine_in_files.components[0].files[0].root = FileRoot::Engine;
        assert!(validate(&engine_in_files).is_err());
        let mut engine_in_shared = manifest();
        engine_in_shared.shared.files[0].root = FileRoot::Engine;
        assert!(validate(&engine_in_shared).is_err());

        let mut twice = manifest();
        twice.components[0].overlay.files.push(file(
            FileRoot::Engine,
            "EternalJK.x86.exe",
            FileSource::Blob,
        ));
        assert!(validate(&twice).is_err(), "the same overlay path in another case");
        let mut twice_home = manifest();
        twice_home.components[0].files.push(file(
            FileRoot::Home,
            "EternalJK/japro-assets.pk3",
            FileSource::Blob,
        ));
        assert!(validate(&twice_home).is_err(), "the same home path in another case");
        let mut shared_too = manifest();
        shared_too.shared.files.push(file(
            FileRoot::Home,
            "eternaljk/japro-assets.pk3",
            FileSource::Blob,
        ));
        assert!(validate(&shared_too).is_err(), "a component path repeated in shared");
        let mut twice_shared = manifest();
        twice_shared.shared.files.push(file(FileRoot::Home, "base/RUS_SP.pk3", FileSource::Blob));
        assert!(validate(&twice_shared).is_err());
        // The same home path in two components is two clients: allowed.
        let mut two_clients = manifest();
        two_clients.components[1].files.push(file(
            FileRoot::Home,
            "eternaljk/japro-assets.pk3",
            FileSource::Blob,
        ));
        validate(&two_clients).expect("two components may share a path");

        let mut many_removals = manifest();
        many_removals.components[0].overlay.remove =
            (0..=MAX_REMOVALS).map(|i| format!("r{i}.dll")).collect();
        assert!(validate(&many_removals).is_err());
        let mut bad_removal = manifest();
        bad_removal.components[0].overlay.remove = vec!["../openjk.x86.exe".into()];
        assert!(validate(&bad_removal).is_err());

        let mut bad_replaced = manifest();
        bad_replaced.components[0].overlay.files[0].replaces = Some(ReplacedFile {
            sha256: "not a hash".into(),
            size: 1,
        });
        assert!(validate(&bad_replaced).is_err());
        let mut bad_origin = manifest();
        bad_origin.shared.files[0].origin = Some(FileOrigin::Jkhub {
            file_id: 1,
            sha256: "XYZ".into(),
            modified: true,
        });
        assert!(validate(&bad_origin).is_err());

        let mut huge = manifest();
        huge.components[0].overlay.files[0].size = MAX_FILE_BYTES + 1;
        assert!(validate(&huge).is_err());
        // The same size from JKHub is not the service's disk.
        let mut huge_jkhub = manifest();
        huge_jkhub.components[0].files[0].size = MAX_FILE_BYTES + 1;
        validate(&huge_jkhub).expect("a JKHub file has no store limit");
        let mut over_the_version = manifest();
        over_the_version.components[0].overlay.files[0].size = MAX_FILE_BYTES;
        over_the_version.components[1].files[0].size = MAX_FILE_BYTES;
        over_the_version.shared.files[0].size = MAX_FILE_BYTES;
        over_the_version.shared.files.push(ManifestFile {
            size: MAX_FILE_BYTES,
            ..file(FileRoot::Home, "base/big.pk3", FileSource::Blob)
        });
        over_the_version.shared.files.push(ManifestFile {
            size: 1,
            ..file(FileRoot::Home, "base/tiny.pk3", FileSource::Blob)
        });
        assert!(validate(&over_the_version).is_err(), "four halves and a byte");
        // A listing weighs the same as a byte of a file.
        over_the_version.shared.files.pop();
        validate(&over_the_version).expect("four halves fill a version");
        over_the_version.shared.files[0].listing = Some(ListingRef {
            sha256: "d".repeat(64),
            size: 1,
        });
        assert!(validate(&over_the_version).is_err(), "four halves and a listing of a byte");

        let mut listing_on_cfg = manifest();
        listing_on_cfg.components[1].files[0].listing = Some(ListingRef {
            sha256: "b".repeat(64),
            size: 120,
        });
        assert!(validate(&listing_on_cfg).is_err(), "only a pk3 has a listing");
        let mut listing_bad_hash = manifest();
        listing_bad_hash.components[0].files[0].listing = Some(ListingRef {
            sha256: "not a hash".into(),
            size: 120,
        });
        assert!(validate(&listing_bad_hash).is_err());
        let mut listing_on_pk3 = manifest();
        listing_on_pk3.components[0].files[0].listing = Some(ListingRef {
            sha256: "b".repeat(64),
            size: 120,
        });
        listing_on_pk3.shared.files[0].listing = Some(ListingRef {
            sha256: "d".repeat(64),
            size: 8,
        });
        validate(&listing_on_pk3).expect("a listing on a pk3 of home and of shared");
        let json = serde_json::to_value(&listing_on_pk3).unwrap();
        assert_eq!(json["components"][0]["files"][0]["listing"]["size"], 120);
        assert!(json["components"][1]["files"][0].get("listing").is_none(), "absent stays absent");
        let back: Manifest = serde_json::from_value(json).unwrap();
        assert_eq!(back, listing_on_pk3);

        let mut library_on_exe = manifest();
        library_on_exe.components[0].overlay.files[0].library = Some(LibraryInfo {
            category: LibraryCategory::Mod,
            display_name: "x".into(),
            entries: 1,
            folders: BTreeMap::new(),
            maps: Vec::new(),
            features: Vec::new(),
        });
        assert!(validate(&library_on_exe).is_err());
        let mut many_folders = manifest();
        many_folders.components[0].files[0].library.as_mut().unwrap().folders =
            (0..=MAX_LIBRARY_FOLDERS).map(|i| (format!("f{i}"), 1)).collect();
        assert!(validate(&many_folders).is_err());
        let mut many_maps = manifest();
        many_maps.components[0].files[0].library.as_mut().unwrap().maps =
            (0..=MAX_LIBRARY_MAPS).map(|i| format!("m{i}")).collect();
        assert!(validate(&many_maps).is_err());
        let mut many_features = manifest();
        many_features.components[0].files[0].library.as_mut().unwrap().features =
            (0..=MAX_LIBRARY_FEATURES).map(|i| format!("f{i}")).collect();
        assert!(validate(&many_features).is_err(), "33 badges");
        for code in ["Levelshots", "strings:RU", "strings:ru:x", "", "hilts weapons", "strings:русский"] {
            let mut bad_feature = manifest();
            bad_feature.components[0].files[0].library.as_mut().unwrap().features = vec![code.into()];
            assert!(validate(&bad_feature).is_err(), "{code:?} is not a badge code");
        }
        let mut long_feature = manifest();
        long_feature.components[0].files[0].library.as_mut().unwrap().features =
            vec!["x".repeat(MAX_LIBRARY_FEATURE_LEN + 1)];
        assert!(validate(&long_feature).is_err());
        let mut badges = manifest();
        badges.components[0].files[0].library.as_mut().unwrap().features = vec![
            "levelshots".into(),
            "strings:russian".into(),
            "hud-2".into(),
            "x".repeat(MAX_LIBRARY_FEATURE_LEN),
        ];
        validate(&badges).expect("the codes of the core and the longest one allowed");

        let mut many_configs = manifest();
        many_configs.shared.configs = (0..=MAX_CONFIGS)
            .map(|i| ManifestConfig {
                name: format!("c{i}"),
                text: String::new(),
                priority: i as i32,
            })
            .collect();
        assert!(validate(&many_configs).is_err());
        let mut long_config = manifest();
        long_config.components[0].configs[0].text = "x".repeat(MAX_CONFIG_TEXT + 1);
        assert!(validate(&long_config).is_err());
        let mut nameless = manifest();
        nameless.components[0].configs[0].name = "   ".into();
        assert!(validate(&nameless).is_err());
    }
}
