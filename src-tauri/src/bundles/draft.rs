//! Drafts of bundles: the recipe the editor of the launcher builds before a
//! bundle is published, kept on disk and edited one command at a time.
//!
//! A draft lives in `bundles\drafts\<draftId>\` of the data folder:
//!
//! ```text
//! draft.json                          the record below, camelCase
//! files\<scope>\<root>\<path>         a copy of every file the draft holds
//! images\<sha256>.<ext>               the pictures of the description, see images.rs
//! listings\<sha256>.json              the listing of each pk3, by the hash of
//!                                     the pk3, see listing.rs
//! ```
//!
//! `scope` is the id of a component or `shared`; `root` is `engine` for the
//! overlay of a component and `home` for everything else. A file is copied
//! into the draft when it is added, hashed on the way, and never read from
//! its original path again: a draft survives the client it was taken from,
//! the download folder it came from and the other machine it is moved to.
//! A pk3 gets its listing written next to the copy, and the record of the
//! file remembers the hash and size of that document for the manifest.
//!
//! Every command of this module reads `draft.json`, changes it and writes
//! it back through a temporary file and a rename, under one lock, so a
//! half-written record never exists on disk and the editor needs no save
//! button. The commands answer with the whole draft, which is what the
//! editor draws.
//!
//! What goes into a manifest is decided from the `origin` of each file at
//! publish time, see [`DraftFile::source`]: a JKHub file that still hashes
//! to what JKHub served is a reference to the record, everything else is
//! uploaded to the store of the service.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Deserializer, Serialize};
use tauri::AppHandle;

use crate::clients::{self, Client};
use crate::configs;
use crate::engine_install::{self, ArchiveEntry};
use crate::engines::{self, Engine, LaunchMode};
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::jkhub::types::Provenance;
use crate::jkhub::JkhubState;
use crate::library;
use crate::online::{path_segment, Auth, OnlineClient, OnlineContext};
use crate::paths::{self, DataPaths};
use crate::settings::{Settings, LANGUAGES};
use crate::state::AppState;
use crate::timestamp;
use crate::user_files;

use super::images::{self, DraftImage};
use super::install::{self, FileSource, JkhubArchive};
use super::listing;
use super::manifest::{
    self, FileKind, FileOrigin, FileRoot, FileSource as ManifestSource, LibraryInfo, ListingRef,
    Manifest, ManifestFile, MAX_COMPONENTS, MAX_CONFIGS, MAX_CONFIG_NAME, MAX_CONFIG_TEXT,
    MAX_FILES, MAX_FILE_BYTES, MAX_LABEL, MAX_LIBRARY_FEATURES, MAX_LIBRARY_FOLDERS,
    MAX_LIBRARY_MAPS, MAX_REMOVALS, MAX_VERSION_BYTES, SHARED_SCOPE,
};
use super::release;
use super::types::{BundleCard, BundleDetails, BundleVersion, Translation, DEFAULT_LANGUAGE};
use super::{sha256_of, BundlesState};

/// Event the editor listens to while a draft is being filled from a bundle
/// of the catalogue.
pub const PROGRESS_EVENT: &str = "bundles:draft-progress";

// The limits of the bundle fields, as the service checks them.
const NAME_MIN: usize = 2;
const NAME_MAX: usize = 64;
const SUMMARY_MAX: usize = 200;
/// Bytes of Markdown the service takes as a description.
pub const DESCRIPTION_MAX: usize = 32 * 1024;
/// Bytes of description a draft holds at all. Between the two limits the
/// draft keeps what the editor sent and `validate` reports
/// `descriptionTooLong`, the way a short name is kept and reported: the
/// editor saves half a second after every change, and a refusal there would
/// drop the text the author just typed.
const DESCRIPTION_HARD_MAX: usize = 8 * DESCRIPTION_MAX;
const TAGS_MAX: usize = 10;
const TAG_MAX: usize = 24;
const LABEL_MAX: usize = 32;
const CHANGELOG_MAX: usize = 4000;
/// Longest link the service takes, in characters.
const LINK_MAX: usize = 500;
/// Translations one bundle may carry: every language of the launcher but
/// the main one.
pub const MAX_TRANSLATIONS: usize = 7;

// Codes of `validate_bundle_draft`, never sentences: the interface
// translates them.
pub const ISSUE_NO_COMPONENTS: &str = "noComponents";
pub const ISSUE_NO_ENGINE: &str = "noEngine";
pub const ISSUE_ENGINE_UNKNOWN: &str = "engineUnknown";
pub const ISSUE_NO_MODES: &str = "noModes";
pub const ISSUE_EMPTY_BUNDLE: &str = "emptyBundle";
pub const ISSUE_NAME_INVALID: &str = "nameInvalid";
pub const ISSUE_TOO_LARGE: &str = "tooLarge";
pub const ISSUE_DUPLICATE_PATH: &str = "duplicatePath";
pub const ISSUE_EXECUTABLES_PRESENT: &str = "executablesPresent";
pub const ISSUE_PASSWORDS_STRIPPED: &str = "passwordsStripped";
pub const ISSUE_CONFIG_TOO_LONG: &str = "configTooLong";
pub const ISSUE_DESCRIPTION_TOO_LONG: &str = "descriptionTooLong";
pub const ISSUE_SUMMARY_TOO_LONG: &str = "summaryTooLong";
pub const ISSUE_IMAGE_MISSING: &str = "imageMissing";
pub const ISSUE_UNUSED_IMAGES: &str = "unusedImages";

/// Folders under `home\<folder>\` a draft made from a client never enters:
/// what the engine writes while the player plays, not what makes the client.
const MEDIA_FOLDERS: [&str; 3] = ["screenshots", "demos", "videos"];

/// The folder of the launcher's own notes inside `home\`.
const NOTES_FOLDER: &str = ".jknet";

/// Extensions of the loose files of a mod folder a draft made from a client
/// takes along.
const TAKEN_EXTENSIONS: [&str; 4] = ["cfg", "dll", "qvm", "txt"];

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/// `draft.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub game: Game,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: String,
    /// The language `name`, `summary` and `description` are written in: one
    /// of [`LANGUAGES`]. Absent in a record written before translations
    /// existed, which reads as English.
    #[serde(default = "default_language")]
    pub language: String,
    /// The same three fields in the other languages, by code: never the code
    /// of `language`, at most [`MAX_TRANSLATIONS`] entries. An empty field
    /// of a translation means the field is not translated.
    #[serde(default)]
    pub translations: BTreeMap<String, DraftTranslation>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub discord: Option<String>,
    #[serde(default)]
    pub version_label: String,
    #[serde(default)]
    pub changelog: String,
    /// The bundle on the service the draft belongs to: a publish creates a
    /// version of it. `None` until the first publish, or on a draft made
    /// from somebody else's bundle.
    #[serde(default)]
    pub bundle_id: Option<String>,
    #[serde(default)]
    pub bundle_slug: Option<String>,
    /// The version the last publish of this draft made.
    #[serde(default)]
    pub last_version_id: Option<String>,
    #[serde(default)]
    pub components: Vec<DraftComponent>,
    #[serde(default)]
    pub shared: DraftShared,
    /// The pictures the description refers to, in `images\`. Absent in a
    /// record of the second edition, which reads as none.
    #[serde(default)]
    pub images: Vec<DraftImage>,
}

/// One component of a draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftComponent {
    /// Built from the label, unique in the draft, never `shared`.
    pub id: String,
    pub label: String,
    pub engine_id: String,
    /// `None` means the newest release at install time.
    #[serde(default)]
    pub release_tag: Option<String>,
    #[serde(default)]
    pub modes: Vec<LaunchMode>,
    #[serde(default)]
    pub fs_game: Option<String>,
    #[serde(default)]
    pub launch_args: String,
    #[serde(default)]
    pub overlay: DraftOverlay,
    /// Files of `home\`.
    #[serde(default)]
    pub files: Vec<DraftFile>,
    #[serde(default)]
    pub configs: Vec<DraftConfig>,
}

/// What a component does to `engine\`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOverlay {
    /// Files with `root: "engine"`.
    #[serde(default)]
    pub files: Vec<DraftFile>,
    /// Paths of files of the release the install takes out of `engine\`.
    #[serde(default)]
    pub remove: Vec<String>,
}

/// The files and documents every component gets.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftShared {
    #[serde(default)]
    pub files: Vec<DraftFile>,
    #[serde(default)]
    pub configs: Vec<DraftConfig>,
}

/// One file of a draft, copied into its `files\` folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftFile {
    pub root: FileRoot,
    /// Relative path inside the root, forward slashes: `base/x.pk3` in
    /// `home`, `taystjk.x86.exe` in `engine`.
    pub path: String,
    pub size: u64,
    /// Lowercase hex, computed when the file was added.
    pub sha256: String,
    pub kind: FileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<LibraryInfo>,
    /// The hash and size of the listing of a pk3, written into `listings\`
    /// when the file was added. Absent on other kinds, and on a pk3 of a
    /// draft written before listings existed: `draft_file_listing` builds
    /// that one on demand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listing: Option<ListingRef>,
    pub origin: DraftOrigin,
}

/// Where a file of a draft was taken from, which decides how the manifest
/// refers to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DraftOrigin {
    /// Picked in a file dialog. Uploaded to the store.
    Disk {
        #[serde(rename = "sourcePath")]
        source_path: String,
    },
    /// Downloaded from a record of jkhub.org. `sha256` is the hash of the
    /// file as JKHub served it: while the file still hashes to it, the
    /// manifest points at the record; a file changed since is uploaded with
    /// the record named as its origin.
    Jkhub {
        #[serde(rename = "fileId")]
        file_id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        sha256: String,
    },
    /// Copied from the library of a client. With the provenance the JKHub
    /// tab wrote for it, the manifest points at the record; without one the
    /// file is uploaded.
    Client {
        #[serde(rename = "clientId")]
        client_id: String,
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provenance: Option<Provenance>,
    },
    /// An overlay file that replaces a file of the release: the hash and
    /// size of the file it replaces, which the manifest carries as
    /// `replaces`.
    Release {
        sha256: String,
        #[serde(default)]
        size: u64,
    },
}

/// The name, summary and description of a draft in one more language, as
/// `translations` of `draft.json` lists them. Every field is a string: an
/// empty one is a field the author has not translated, which the
/// catalogue shows in the main language. The service spells the same
/// entry as [`Translation`], with the description optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTranslation {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: String,
}

impl DraftTranslation {
    /// The entry as `POST /v1/bundles` and `PUT /v1/bundles/{id}` take it.
    pub fn to_contract(&self) -> Translation {
        Translation {
            name: self.name.trim().to_string(),
            summary: self.summary.trim().to_string(),
            description: Some(self.description.trim().to_string()),
        }
    }

    /// The entry out of an answer of the service, a missing description
    /// read as an empty one.
    pub fn from_contract(translation: &Translation) -> DraftTranslation {
        DraftTranslation {
            name: translation.name.clone(),
            summary: translation.summary.clone(),
            description: translation.description.clone().unwrap_or_default(),
        }
    }
}

fn default_language() -> String {
    DEFAULT_LANGUAGE.to_string()
}

/// Whether a code names a language the launcher ships a catalog for, and
/// therefore one a bundle may be written in.
pub(crate) fn is_bundle_language(code: &str) -> bool {
    LANGUAGES.contains(&code)
}

/// The language a new draft starts in: the language of the interface when
/// it is one of [`LANGUAGES`], English while the setting follows the
/// operating system.
pub(crate) fn initial_language(settings: &Settings) -> String {
    if is_bundle_language(&settings.language) {
        settings.language.clone()
    } else {
        default_language()
    }
}

/// One config document of a draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftConfig {
    pub name: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub priority: i32,
    /// The document of the Configs screen it was taken from, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_config_id: Option<String>,
}

impl DraftFile {
    /// How the manifest refers to the file: the JKHub record when the file
    /// is still what JKHub served, the store of the service otherwise, with
    /// the record named as the origin of a changed JKHub file.
    pub fn source(&self) -> (ManifestSource, Option<FileOrigin>) {
        match &self.origin {
            DraftOrigin::Jkhub {
                file_id,
                version,
                title,
                url,
                sha256,
            } => {
                if sha256 == &self.sha256 {
                    (
                        ManifestSource::Jkhub {
                            file_id: *file_id,
                            version: version.clone(),
                            title: title.clone(),
                            url: url.clone(),
                        },
                        None,
                    )
                } else {
                    (
                        ManifestSource::Blob,
                        Some(FileOrigin::Jkhub {
                            file_id: *file_id,
                            sha256: sha256.clone(),
                            modified: true,
                        }),
                    )
                }
            }
            DraftOrigin::Client {
                provenance: Some(provenance),
                ..
            } if provenance.source == "jkhub" => (
                ManifestSource::Jkhub {
                    file_id: provenance.file_id,
                    version: provenance.version.clone(),
                    title: Some(provenance.title.clone()).filter(|title| !title.is_empty()),
                    url: Some(provenance.url.clone()).filter(|url| !url.is_empty()),
                },
                None,
            ),
            _ => (ManifestSource::Blob, None),
        }
    }

    /// Whether the file goes to the store of the service.
    pub fn is_blob(&self) -> bool {
        self.source().0.is_blob()
    }

    /// The entry of the manifest for this file.
    pub fn manifest_file(&self) -> ManifestFile {
        let (source, origin) = self.source();
        let replaces = match &self.origin {
            DraftOrigin::Release { sha256, size } => Some(manifest::ReplacedFile {
                sha256: sha256.clone(),
                size: *size,
            }),
            _ => None,
        };
        let kind = FileKind::of_path(&self.path);
        ManifestFile {
            root: self.root,
            path: self.path.clone(),
            size: self.size,
            sha256: self.sha256.clone(),
            kind,
            source,
            replaces,
            origin,
            library: self.library.clone(),
            listing: (kind == FileKind::Pk3).then(|| self.listing.clone()).flatten(),
        }
    }
}

impl Draft {
    /// The component with this id.
    pub fn component(&self, id: &str) -> Option<&DraftComponent> {
        self.components.iter().find(|component| component.id == id)
    }

    /// Every file of every part, in manifest order.
    pub fn all_files(&self) -> impl Iterator<Item = (&str, &DraftFile)> {
        self.components
            .iter()
            .flat_map(|component| {
                component
                    .overlay
                    .files
                    .iter()
                    .chain(component.files.iter())
                    .map(move |file| (component.id.as_str(), file))
            })
            .chain(self.shared.files.iter().map(|file| (SHARED_SCOPE, file)))
    }

    /// Bytes of the store a version of this draft takes: every file the
    /// manifest would call a blob, and the listing of every pk3, which the
    /// service counts into `blobBytes` of the version the same way.
    pub fn version_bytes(&self) -> u64 {
        self.all_files()
            .map(|(_, file)| {
                let listing = file.listing.as_ref().map_or(0, |listing| listing.size);
                if file.is_blob() {
                    file.size + listing
                } else {
                    listing
                }
            })
            .sum()
    }

    /// The description in every language: the main one first, then the
    /// translations by code, each with the code it is written in.
    pub fn descriptions(&self) -> impl Iterator<Item = (&str, &str)> {
        std::iter::once((self.language.as_str(), self.description.as_str())).chain(
            self.translations
                .iter()
                .map(|(code, translation)| (code.as_str(), translation.description.as_str())),
        )
    }

    /// The pictures the descriptions of every language refer to, each hash
    /// once, in the order of their first appearance: what the publish
    /// uploads and what the service joins into `bundle_images`.
    pub fn image_refs(&self) -> Vec<String> {
        let mut refs: Vec<String> = Vec::new();
        for (_, description) in self.descriptions() {
            for sha256 in images::description_refs(description) {
                if !refs.contains(&sha256) {
                    refs.push(sha256);
                }
            }
        }
        refs
    }

    /// Bytes of the pictures the descriptions refer to: what the publish
    /// uploads before the bundle, and what the service holds against the
    /// quota of the account next to the files. A picture of the draft no
    /// description names stays on disk and is not counted.
    pub fn image_bytes(&self) -> u64 {
        let referenced = self.image_refs();
        self.images
            .iter()
            .filter(|image| referenced.contains(&image.sha256))
            .map(|image| image.size)
            .sum()
    }

    /// Bytes the publish uploads and the service holds for the bundle: the
    /// files and listings of the version plus the pictures of the
    /// description.
    pub fn blob_bytes(&self) -> u64 {
        self.version_bytes() + self.image_bytes()
    }

    /// What the list of drafts shows.
    pub fn summary(&self) -> DraftSummary {
        DraftSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            game: self.game,
            component_count: self.components.len() as u32,
            file_count: self.all_files().count() as u32,
            blob_bytes: self.blob_bytes(),
            bundle_id: self.bundle_id.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// The answers and arguments of the commands
// ---------------------------------------------------------------------------

/// One row of `list_bundle_drafts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub name: String,
    pub game: Game,
    pub component_count: u32,
    pub file_count: u32,
    /// Bytes a publish would upload: the files and listings of the version
    /// and the pictures of the description.
    pub blob_bytes: u64,
    pub bundle_id: Option<String>,
    pub updated_at: String,
}

/// Reads a field that may be absent, `null`, or a value, and tells the
/// three apart: absent keeps the field, `null` clears it.
fn double_option<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// The `patch` of `update_bundle_draft`: a field left out keeps its value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The main language. A code that has a translation swaps the main
    /// fields with that translation, the way **Default language** of the
    /// editor works; any other code relabels the main fields. Applied
    /// before `translations`, so a patch that carries both describes the
    /// new state whole.
    #[serde(default)]
    pub language: Option<String>,
    /// Every translation, replacing the set the draft holds.
    #[serde(default)]
    pub translations: Option<BTreeMap<String, DraftTranslation>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// `null` clears the link.
    #[serde(default, deserialize_with = "double_option")]
    pub website: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub discord: Option<Option<String>>,
    #[serde(default)]
    pub version_label: Option<String>,
    #[serde(default)]
    pub changelog: Option<String>,
}

/// The component `draft_add_component` adds, as one object.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewComponent {
    pub engine_id: String,
    #[serde(default)]
    pub release_tag: Option<String>,
    pub label: String,
    #[serde(default)]
    pub modes: Vec<LaunchMode>,
}

/// The `patch` of `draft_update_component`: a field left out keeps its
/// value, `null` puts `releaseTag` on the newest release and `fsGame` on
/// `base`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentPatch {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub release_tag: Option<Option<String>>,
    #[serde(default)]
    pub modes: Option<Vec<LaunchMode>>,
    #[serde(default, deserialize_with = "double_option")]
    pub fs_game: Option<Option<String>>,
    #[serde(default)]
    pub launch_args: Option<String>,
}

/// One finding of `validate_bundle_draft`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// A code the interface translates, one of the `ISSUE_*` constants.
    pub code: String,
    /// The component the finding is about, or `shared`. Absent for the
    /// draft as a whole.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// The component of `scope`, when the scope is one: what the editor
    /// looks a component up by. Absent for `shared` and for the whole draft.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Lines or bytes the finding counts, when it counts anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// The translation the finding is about, by its language code. Absent
    /// for the fields of the main language and for everything else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// An English sentence for the log and for a screen without the key.
    pub message: String,
}

/// The answer of `validate_bundle_draft`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftIssues {
    /// What stops a publish.
    pub errors: Vec<Issue>,
    /// What the author should know.
    pub warnings: Vec<Issue>,
    /// Bytes the publish uploads: the files and listings of the version and
    /// the pictures of the description, what the service holds for the
    /// bundle.
    pub blob_bytes: u64,
    /// Bytes JKHub serves at install time.
    pub jkhub_bytes: u64,
    pub file_count: u32,
    /// Paths of the exe and dll files, with the scope in front:
    /// `mp/eternaljk.x86.exe`.
    pub executables: Vec<String>,
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/// The lock every read-modify-write of a `draft.json` goes through.
///
/// One lock for every draft: a record is a few kilobytes, and the editor
/// sends one command at a time. What the lock stops is two commands of one
/// window, or of two windows, interleaving their read and their write.
static EDITS: Mutex<()> = Mutex::new(());

/// Refuses an id that is not one this module made, before it becomes a
/// folder name.
fn check_draft_id(id: &str) -> Result<()> {
    user_files::valid_id(id).map_err(|_| AppError::InvalidInput(format!("{id:?} is not a draft id")))
}

fn record_path(paths: &DataPaths, id: &str) -> PathBuf {
    paths.bundle_draft_dir(id).join("draft.json")
}

/// Reads one draft.
pub(crate) fn read_draft(paths: &DataPaths, id: &str) -> Result<Draft> {
    check_draft_id(id)?;
    let file = record_path(paths, id);
    if !file.is_file() {
        return Err(AppError::NotFound(format!("bundle draft {id}")));
    }
    let text = fs::read_to_string(&file).map_err(|e| AppError::io_path("cannot read", &file, e))?;
    serde_json::from_str(&text).map_err(|e| AppError::json(format!("cannot parse {}", file.display()), e))
}

/// Writes a draft whole: into a temporary file next to `draft.json`, then a
/// rename over it, so a reader never sees half a record.
pub(crate) fn write_draft(paths: &DataPaths, draft: &Draft) -> Result<()> {
    check_draft_id(&draft.id)?;
    user_files::write(&record_path(paths, &draft.id), draft)
}

/// Reads a draft, changes it, stamps it and writes it back as one step.
pub(crate) fn edit_draft(
    paths: &DataPaths,
    id: &str,
    edit: impl FnOnce(&mut Draft) -> Result<()>,
) -> Result<Draft> {
    let _step = EDITS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut draft = read_draft(paths, id)?;
    edit(&mut draft)?;
    draft.updated_at = timestamp::now_rfc3339();
    write_draft(paths, &draft)?;
    Ok(draft)
}

/// Every draft on disk, newest change first. A folder without a readable
/// record is skipped with a warning: one broken draft must not hide the
/// others.
pub(crate) fn read_all(paths: &DataPaths) -> Result<Vec<Draft>> {
    let Ok(entries) = fs::read_dir(paths.bundle_drafts_dir()) else {
        return Ok(Vec::new());
    };
    let mut drafts = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !entry.path().is_dir() || !record_path(paths, &id).is_file() {
            continue;
        }
        match read_draft(paths, &id) {
            Ok(draft) => drafts.push(draft),
            Err(e) => log::warn!("skipping bundle draft {id}: {e}"),
        }
    }
    drafts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
    Ok(drafts)
}

/// Where the file at `path` of `scope` and `root` lies inside the draft.
pub(crate) fn file_path(paths: &DataPaths, draft_id: &str, scope: &str, root: FileRoot, path: &str) -> Result<PathBuf> {
    manifest::check_path(path)?;
    let dir = paths.bundle_draft_files_dir(draft_id, scope, root.as_str());
    engine_install::safe_entry_path(&dir, path)
}

/// A new, empty draft, its fields in `language`.
fn new_draft(game: Game, name: &str, language: &str) -> Draft {
    let now = timestamp::now_rfc3339();
    Draft {
        id: user_files::id(),
        game,
        created_at: now.clone(),
        updated_at: now,
        name: name.trim().to_string(),
        summary: String::new(),
        description: String::new(),
        language: language.to_string(),
        translations: BTreeMap::new(),
        tags: Vec::new(),
        website: None,
        discord: None,
        version_label: String::new(),
        changelog: String::new(),
        bundle_id: None,
        bundle_slug: None,
        last_version_id: None,
        components: Vec::new(),
        shared: DraftShared::default(),
        images: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Scopes and lists
// ---------------------------------------------------------------------------

pub(crate) fn component_mut<'a>(draft: &'a mut Draft, id: &str) -> Result<&'a mut DraftComponent> {
    draft
        .components
        .iter_mut()
        .find(|component| component.id == id)
        .ok_or_else(|| AppError::NotFound(format!("component {id} of the draft")))
}

/// The files of `home\` of a scope.
fn home_files_mut<'a>(draft: &'a mut Draft, scope: &str) -> Result<&'a mut Vec<DraftFile>> {
    if scope == SHARED_SCOPE {
        Ok(&mut draft.shared.files)
    } else {
        Ok(&mut component_mut(draft, scope)?.files)
    }
}

fn configs_mut<'a>(draft: &'a mut Draft, scope: &str) -> Result<&'a mut Vec<DraftConfig>> {
    if scope == SHARED_SCOPE {
        Ok(&mut draft.shared.configs)
    } else {
        Ok(&mut component_mut(draft, scope)?.configs)
    }
}

/// Refuses a scope the draft does not have.
fn check_scope(draft: &Draft, scope: &str) -> Result<()> {
    if scope == SHARED_SCOPE || draft.component(scope).is_some() {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("component {scope} of the draft")))
    }
}

/// Puts a file into a list, replacing the entry of the same path.
fn put_file(list: &mut Vec<DraftFile>, file: DraftFile) {
    list.retain(|known| !known.path.eq_ignore_ascii_case(&file.path));
    list.push(file);
}

/// Takes the entry of `path` out of a list, if it is there.
fn take_file(list: &mut Vec<DraftFile>, path: &str) -> Option<DraftFile> {
    let index = list.iter().position(|file| file.path.eq_ignore_ascii_case(path))?;
    Some(list.remove(index))
}

/// Removes a copied file from the draft folder, and the empty folders it
/// leaves behind. A file already gone is not an error.
fn remove_copy(paths: &DataPaths, draft_id: &str, scope: &str, root: FileRoot, path: &str) {
    let Ok(file) = file_path(paths, draft_id, scope, root, path) else {
        return;
    };
    match fs::remove_file(&file) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("cannot remove {}: {e}", file.display()),
    }
    let stop = paths.bundle_draft_files_dir(draft_id, scope, root.as_str());
    let mut parent = file.parent().map(Path::to_path_buf);
    while let Some(dir) = parent {
        if !dir.starts_with(&stop) || dir == stop || fs::remove_dir(&dir).is_err() {
            break;
        }
        parent = dir.parent().map(Path::to_path_buf);
    }
}

/// The folder of `home\` a file goes into: `base` or a mod folder, by the
/// rules of the `fs_game` field.
fn check_folder(folder: &str) -> Result<String> {
    clients::validate_fs_game(folder)?
        .ok_or_else(|| AppError::InvalidInput("the folder of the file is blank".into()))
}

/// A component id out of a label: lowercase letters, digits and hyphens,
/// at most 32 characters, unique in the draft, never `shared`.
fn component_id(label: &str, taken: &[String]) -> String {
    let mut slug = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let mut base: String = slug.trim_matches('-').chars().take(manifest::MAX_ID).collect();
    base = base.trim_matches('-').to_string();
    if base.is_empty() || base == SHARED_SCOPE {
        base = "component".to_string();
    }
    if !taken.iter().any(|id| id == &base) {
        return base;
    }
    (2..)
        .map(|n| {
            let suffix = format!("-{n}");
            let head: String = base.chars().take(manifest::MAX_ID - suffix.len()).collect();
            format!("{}{suffix}", head.trim_end_matches('-'))
        })
        .find(|candidate| !taken.iter().any(|id| id == candidate))
        .unwrap_or(base)
}

/// The modes a component may name: a non-empty subset of the engine's.
fn check_component_modes(engine: &Engine, modes: &[LaunchMode]) -> Result<Vec<LaunchMode>> {
    manifest::check_modes(engine.id, modes)?;
    let allowed: Vec<LaunchMode> = engine
        .modes()
        .into_iter()
        .filter(|mode| modes.contains(mode))
        .collect();
    if allowed.len() != modes.len() {
        return Err(AppError::InvalidInput(format!(
            "{} starts in {:?} only",
            engine.name,
            engine.modes().iter().map(|mode| mode.as_str()).collect::<Vec<_>>()
        )));
    }
    Ok(allowed)
}

fn check_label(label: &str) -> Result<String> {
    let label = label.trim();
    let count = label.chars().count();
    if count == 0 || count > MAX_LABEL {
        return Err(AppError::InvalidInput(format!(
            "the label of a component is 1 to {MAX_LABEL} characters"
        )));
    }
    Ok(label.to_string())
}

fn trimmed_tag(tag: Option<String>) -> Option<String> {
    tag.map(|tag| tag.trim().to_string()).filter(|tag| !tag.is_empty())
}

// ---------------------------------------------------------------------------
// Files: hashing, classifying, copying
// ---------------------------------------------------------------------------

/// The retail archives of the game: `assets0.pk3` to `assets3.pk3` and the
/// patch archives of Jedi Outcast. The player's own copy of the game supplies
/// them, and a bundle must never carry them.
pub(crate) fn is_game_asset(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    let Some(stem) = lower.strip_suffix(".pk3") else {
        return false;
    };
    stem.strip_prefix("assets")
        .is_some_and(|rest| rest.chars().all(|ch| ch.is_ascii_digit()))
}

/// The number of files inside an archive and the number under each
/// top-level folder, the biggest folders first, at most
/// [`MAX_LIBRARY_FOLDERS`].
fn archive_layout(path: &Path) -> Result<(u32, BTreeMap<String, u32>)> {
    let file = fs::File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let archive = zip::ZipArchive::new(BufReader::new(file))?;
    let mut entries = 0u32;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for name in archive.file_names() {
        let name = name.replace('\\', "/");
        if name.ends_with('/') {
            continue;
        }
        entries += 1;
        if let Some((folder, _)) = name.split_once('/') {
            *counts.entry(folder.to_ascii_lowercase()).or_default() += 1;
        }
    }
    let mut ranked: Vec<(String, u32)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok((
        entries,
        ranked.into_iter().take(MAX_LIBRARY_FOLDERS).collect(),
    ))
}

/// What the manifest says about a pk3: the category the Library screen
/// would give it, and what the archive holds. An archive that will not open
/// is still a file of the draft, as `other` with no entries.
pub(crate) fn pk3_info(path: &Path, display_name: String) -> LibraryInfo {
    let (category, maps, features) = match library::inspect(path) {
        Ok(report) => (report.category, report.map_names, report.features),
        Err(e) => {
            log::warn!("bundles: cannot read {}: {e}", path.display());
            (library::LibraryCategory::Other, Vec::new(), Vec::new())
        }
    };
    let (entries, folders) = archive_layout(path).unwrap_or_else(|e| {
        log::warn!("bundles: cannot list {}: {e}", path.display());
        (0, BTreeMap::new())
    });
    LibraryInfo {
        category,
        display_name,
        entries,
        folders,
        maps: maps.into_iter().take(MAX_LIBRARY_MAPS).collect(),
        features: features.into_iter().take(MAX_LIBRARY_FEATURES).collect(),
    }
}

/// The name a card shows for a file: the file name without its extension.
fn display_name_of(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name)
        .to_string()
}

/// Copies one file into the draft, hashes it and describes it. Blocking:
/// the callers run it on a blocking thread.
#[allow(clippy::too_many_arguments)]
fn import_file(
    paths: &DataPaths,
    draft_id: &str,
    scope: &str,
    root: FileRoot,
    path: &str,
    source: &Path,
    display_name: Option<String>,
    origin: DraftOrigin,
) -> Result<DraftFile> {
    let meta = fs::metadata(source).map_err(|e| AppError::io_path("cannot read", source, e))?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!("{} is not a file", source.display())));
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    if root == FileRoot::Home && is_game_asset(name) {
        return Err(AppError::InvalidInput(format!(
            "{name} is a retail archive of the game; the copy of the game supplies it"
        )));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{name} is bigger than the {} MiB a bundle file may be",
            MAX_FILE_BYTES / (1024 * 1024)
        )));
    }
    let target = file_path(paths, draft_id, scope, root, path)?;
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    if target != source {
        fs::copy(source, &target).map_err(|e| AppError::io_path("cannot copy into", &target, e))?;
    }
    let sha256 = sha256_of(&target)?;
    let kind = FileKind::of_path(path);
    let library = (root == FileRoot::Home && kind == FileKind::Pk3)
        .then(|| pk3_info(&target, display_name.unwrap_or_else(|| display_name_of(name))));
    let listing = (kind == FileKind::Pk3)
        .then(|| listing::listing_of_new_file(paths, draft_id, &sha256, &target))
        .flatten();
    Ok(DraftFile {
        root,
        path: path.to_string(),
        size: meta.len(),
        sha256,
        kind,
        library,
        listing,
        origin,
    })
}

/// The manifest path of a file picked from disk into a folder of `home\`.
fn home_path(folder: &str, source: &Path) -> Result<String> {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput(format!("{} has no file name", source.display())))?;
    let path = format!("{folder}/{name}");
    manifest::check_path(&path)?;
    Ok(path)
}

/// Runs blocking file work off the runtime.
async fn off_thread<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::State(format!("the file thread stopped: {e}")))?
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/// Drops every line that sets a cvar with `password` in its name, and says
/// how many went.
///
/// A line is the unit, not a command: a config is a text the author reads,
/// and a line half removed reads as a line the launcher broke. The check
/// runs on the commands the engine would see, so `seta rconPassword x`,
/// `sv_privatePassword "x"` and a line with two commands behind a `;` all
/// count.
///
/// Known limit: a quoted value that spans a line break is two lines here,
/// and only the first names the cvar; the second stays. No engine writes
/// such a config, and the parser of the engine reads a line break as the end
/// of the value too, so the tail that stays is also what the engine never
/// treated as the password.
pub(crate) fn strip_passwords(text: &str) -> (String, u32) {
    let mut kept = Vec::new();
    let mut stripped = 0u32;
    for line in text.split_inclusive('\n') {
        let sets_password = configs::values(line).iter().any(|value| {
            value
                .key
                .strip_prefix("cvar:")
                .is_some_and(|name| name.contains("password"))
        });
        if sets_password {
            stripped += 1;
        } else {
            kept.push(line);
        }
    }
    (kept.concat(), stripped)
}

// ---------------------------------------------------------------------------
// The fields of a bundle
// ---------------------------------------------------------------------------

fn blank_to_none(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

/// The rule the service applies to `website` and `discord`: blank, or a
/// complete HTTPS link without credentials, and for Discord one on
/// `discord.gg` or `discord.com`.
pub(crate) fn check_link(value: Option<&str>, what: &str, discord: bool) -> Result<Option<String>> {
    let Some(value) = blank_to_none(value) else {
        return Ok(None);
    };
    let refuse = |why: &str| Err(AppError::InvalidInput(format!("the {what} {value:?} {why}")));
    if value.chars().count() > LINK_MAX {
        return refuse(&format!("is longer than {LINK_MAX} characters"));
    }
    if value.chars().any(char::is_control) {
        return refuse("holds control characters");
    }
    let Ok(url) = reqwest::Url::parse(&value) else {
        return refuse("is not a complete HTTPS link");
    };
    if url.scheme() != "https" || url.host_str().is_none() {
        return refuse("is not an HTTPS link");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return refuse("carries credentials");
    }
    if discord && !matches!(url.host_str(), Some("discord.gg" | "discord.com" | "www.discord.com")) {
        return refuse("does not belong to discord.gg or discord.com");
    }
    Ok(Some(value))
}

/// Lowercases and checks the tags the way the service does.
fn check_tags(tags: &[String]) -> Result<Vec<String>> {
    let tags: Vec<String> = tags
        .iter()
        .map(|tag| tag.trim().to_ascii_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect();
    if tags.len() > TAGS_MAX {
        return Err(AppError::InvalidInput(format!("more than {TAGS_MAX} tags")));
    }
    for tag in &tags {
        let plain = tag.len() <= TAG_MAX
            && tag
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if !plain {
            return Err(AppError::InvalidInput(format!(
                "the tag {tag:?} is not lowercase letters, digits and hyphens of at most {TAG_MAX} characters"
            )));
        }
    }
    Ok(tags)
}

fn check_length(value: &str, what: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.chars().count() > max {
        return Err(AppError::InvalidInput(format!(
            "the {what} is longer than {max} characters"
        )));
    }
    Ok(value.to_string())
}

/// Whether the name would pass the service: 2 to 64 characters.
pub(crate) fn name_is_valid(name: &str) -> bool {
    (NAME_MIN..=NAME_MAX).contains(&name.trim().chars().count())
}

/// Trims a description and refuses one over the hard limit. Bytes rather
/// than characters: the service measures the Markdown in bytes. Over the
/// limit of the service is kept and reported by `validate`.
fn check_description(description: &str, what: &str) -> Result<String> {
    let description = description.trim();
    if description.len() > DESCRIPTION_HARD_MAX {
        return Err(AppError::InvalidInput(format!(
            "the {what} is longer than {} KiB",
            DESCRIPTION_HARD_MAX / 1024
        )));
    }
    Ok(description.to_string())
}

/// The rule the service applies to a language code: one of the languages
/// the launcher ships a catalog for, spelled as its folder is.
fn check_language(code: &str) -> Result<String> {
    let code = code.trim();
    if !is_bundle_language(code) {
        return Err(AppError::InvalidInput(format!(
            "{code:?} is not a language a bundle can be written in"
        )));
    }
    Ok(code.to_string())
}

/// The rules the service applies to `translations`: at most
/// [`MAX_TRANSLATIONS`] entries, every code a language of the launcher and
/// none of them `language`, every field within the limits of the main one.
/// The fields are trimmed the way the main ones are, and a short name is
/// kept for `validate` to report, the way the main name is.
fn check_translations(
    translations: BTreeMap<String, DraftTranslation>,
    language: &str,
) -> Result<BTreeMap<String, DraftTranslation>> {
    if translations.len() > MAX_TRANSLATIONS {
        return Err(AppError::InvalidInput(format!(
            "more than {MAX_TRANSLATIONS} translations"
        )));
    }
    let mut checked = BTreeMap::new();
    for (code, translation) in translations {
        let code = check_language(&code)?;
        if code == language {
            return Err(AppError::InvalidInput(format!(
                "{code:?} is the main language of the bundle, not a translation"
            )));
        }
        let entry = DraftTranslation {
            name: check_length(&translation.name, &format!("{code} name"), NAME_MAX)?,
            summary: check_length(&translation.summary, &format!("{code} summary"), SUMMARY_MAX)?,
            description: check_description(&translation.description, &format!("{code} description"))?,
        };
        if checked.insert(code.clone(), entry).is_some() {
            return Err(AppError::InvalidInput(format!("{code:?} is translated twice")));
        }
    }
    Ok(checked)
}

/// Makes `language` the main language of the draft. A code that has a
/// translation swaps the main fields with it: the translation becomes the
/// main fields and the main fields become the translation of the language
/// that was main, which is what **Default language** of the editor does.
/// Any other code relabels the main fields.
fn set_language(draft: &mut Draft, language: String) {
    if language == draft.language {
        return;
    }
    match draft.translations.remove(&language) {
        Some(translation) => {
            let previous = DraftTranslation {
                name: std::mem::replace(&mut draft.name, translation.name),
                summary: std::mem::replace(&mut draft.summary, translation.summary),
                description: std::mem::replace(&mut draft.description, translation.description),
            };
            let was = std::mem::replace(&mut draft.language, language);
            draft.translations.insert(was, previous);
        }
        None => draft.language = language,
    }
}

/// Applies a patch of the bundle fields to a draft, refusing what the
/// service would refuse. The name is the one field a draft may hold in an
/// invalid state: the editor reports it as `nameInvalid` rather than
/// refusing every keystroke.
///
/// The fields of the main language go first, then `language`, then
/// `translations`: a patch that carries all three edits the fields the
/// author was looking at, swaps them under the new main language and
/// replaces the translations against that language.
fn apply_patch(draft: &mut Draft, patch: DraftPatch) -> Result<()> {
    if let Some(name) = patch.name {
        draft.name = check_length(&name, "name", NAME_MAX)?;
    }
    if let Some(summary) = patch.summary {
        draft.summary = check_length(&summary, "summary", SUMMARY_MAX)?;
    }
    if let Some(description) = patch.description {
        draft.description = check_description(&description, "description")?;
    }
    if let Some(language) = patch.language {
        set_language(draft, check_language(&language)?);
    }
    if let Some(translations) = patch.translations {
        draft.translations = check_translations(translations, &draft.language)?;
    }
    if let Some(tags) = patch.tags {
        draft.tags = check_tags(&tags)?;
    }
    if let Some(website) = patch.website {
        draft.website = check_link(website.as_deref(), "website", false)?;
    }
    if let Some(discord) = patch.discord {
        draft.discord = check_link(discord.as_deref(), "Discord link", true)?;
    }
    if let Some(label) = patch.version_label {
        draft.version_label = check_length(&label, "version label", LABEL_MAX)?;
    }
    if let Some(changelog) = patch.changelog {
        draft.changelog = check_length(&changelog, "changelog", CHANGELOG_MAX)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// What stands between a draft and a publish, and what the author should
/// know before one.
pub(crate) fn validate(draft: &Draft) -> DraftIssues {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let issue = |code: &str, scope: Option<&str>, path: Option<&str>, count: Option<u64>, message: String| Issue {
        code: code.to_string(),
        scope: scope.map(str::to_string),
        component_id: scope.filter(|scope| *scope != SHARED_SCOPE).map(str::to_string),
        path: path.map(str::to_string),
        count,
        language: None,
        message,
    };

    if !name_is_valid(&draft.name) {
        errors.push(issue(
            ISSUE_NAME_INVALID,
            None,
            None,
            None,
            format!("the name of the bundle is {NAME_MIN} to {NAME_MAX} characters"),
        ));
    }
    if draft.components.is_empty() {
        errors.push(issue(
            ISSUE_NO_COMPONENTS,
            None,
            None,
            None,
            "the bundle has no component".into(),
        ));
    }

    // A finding about the fields of one translation names its language.
    let in_language = |code: &str, finding: Issue| Issue {
        language: Some(code.to_string()),
        ..finding
    };

    // The fields of every translation, by the rules of the main ones. An
    // empty name is a name that is not translated, not a short one.
    for (code, translation) in &draft.translations {
        let name = translation.name.trim();
        if !name.is_empty() && !name_is_valid(name) {
            errors.push(in_language(
                code,
                issue(
                    ISSUE_NAME_INVALID,
                    None,
                    None,
                    None,
                    format!("the name of the bundle in {code} is {NAME_MIN} to {NAME_MAX} characters"),
                ),
            ));
        }
        if translation.summary.chars().count() > SUMMARY_MAX {
            errors.push(in_language(
                code,
                issue(
                    ISSUE_SUMMARY_TOO_LONG,
                    None,
                    None,
                    Some(translation.summary.chars().count() as u64),
                    format!("the summary in {code} is longer than {SUMMARY_MAX} characters"),
                ),
            ));
        }
        if translation.description.len() > DESCRIPTION_MAX {
            errors.push(in_language(
                code,
                issue(
                    ISSUE_DESCRIPTION_TOO_LONG,
                    None,
                    None,
                    Some(translation.description.len() as u64),
                    format!(
                        "the description in {code} is longer than {} KiB",
                        DESCRIPTION_MAX / 1024
                    ),
                ),
            ));
        }
    }

    // The description and its pictures, in every language: a picture the
    // description of any language refers to has to be in the draft, and a
    // picture no description names is not uploaded.
    if draft.summary.chars().count() > SUMMARY_MAX {
        errors.push(issue(
            ISSUE_SUMMARY_TOO_LONG,
            None,
            None,
            Some(draft.summary.chars().count() as u64),
            format!("the summary is longer than {SUMMARY_MAX} characters"),
        ));
    }
    if draft.description.len() > DESCRIPTION_MAX {
        errors.push(issue(
            ISSUE_DESCRIPTION_TOO_LONG,
            None,
            None,
            Some(draft.description.len() as u64),
            format!("the description is longer than {} KiB", DESCRIPTION_MAX / 1024),
        ));
    }
    for (code, description) in draft.descriptions() {
        for sha256 in images::description_refs(description) {
            if draft.images.iter().any(|image| image.sha256 == sha256) {
                continue;
            }
            let finding = if code == draft.language {
                issue(
                    ISSUE_IMAGE_MISSING,
                    None,
                    Some(&sha256),
                    None,
                    format!("the description refers to the picture {sha256}, which the draft does not hold"),
                )
            } else {
                in_language(
                    code,
                    issue(
                        ISSUE_IMAGE_MISSING,
                        None,
                        Some(&sha256),
                        None,
                        format!(
                            "the description in {code} refers to the picture {sha256}, which the draft does not hold"
                        ),
                    ),
                )
            };
            errors.push(finding);
        }
    }
    let referenced = draft.image_refs();
    let unused = draft
        .images
        .iter()
        .filter(|image| !referenced.contains(&image.sha256))
        .count();
    if unused > 0 {
        warnings.push(issue(
            ISSUE_UNUSED_IMAGES,
            None,
            None,
            Some(unused as u64),
            format!("{unused} picture(s) of the draft are not in any description and are not uploaded"),
        ));
    }

    let shared_paths: Vec<String> = draft
        .shared
        .files
        .iter()
        .map(|file| file.path.to_ascii_lowercase())
        .collect();
    for component in &draft.components {
        let scope = Some(component.id.as_str());
        if component.engine_id.trim().is_empty() {
            errors.push(issue(
                ISSUE_NO_ENGINE,
                scope,
                None,
                None,
                format!("the component {} names no engine", component.label),
            ));
        } else {
            match engines::find(&component.engine_id) {
                Some(engine) if engine.game == draft.game => {
                    let modes: Vec<LaunchMode> = component
                        .modes
                        .iter()
                        .filter(|mode| engine.supports(**mode))
                        .copied()
                        .collect();
                    if modes.is_empty() {
                        errors.push(issue(
                            ISSUE_NO_MODES,
                            scope,
                            None,
                            None,
                            format!("the component {} starts in no mode of {}", component.label, engine.name),
                        ));
                    }
                }
                _ => errors.push(issue(
                    ISSUE_ENGINE_UNKNOWN,
                    scope,
                    None,
                    None,
                    format!(
                        "the engine {} of the component {} is not in the registry for {}",
                        component.engine_id,
                        component.label,
                        draft.game.display_name()
                    ),
                )),
            }
        }
        let mut engine_paths = HashSet::new();
        for file in &component.overlay.files {
            if !engine_paths.insert(file.path.to_ascii_lowercase()) {
                errors.push(issue(
                    ISSUE_DUPLICATE_PATH,
                    scope,
                    Some(&file.path),
                    None,
                    format!("{} is in the overlay of {} twice", file.path, component.label),
                ));
            }
        }
        let mut home_paths = HashSet::new();
        for file in &component.files {
            let lower = file.path.to_ascii_lowercase();
            if !home_paths.insert(lower.clone()) {
                errors.push(issue(
                    ISSUE_DUPLICATE_PATH,
                    scope,
                    Some(&file.path),
                    None,
                    format!("{} is in {} twice", file.path, component.label),
                ));
            } else if shared_paths.contains(&lower) {
                errors.push(issue(
                    ISSUE_DUPLICATE_PATH,
                    scope,
                    Some(&file.path),
                    None,
                    format!("{} is both in {} and in the shared files", file.path, component.label),
                ));
            }
        }
        if component.overlay.remove.len() > MAX_REMOVALS {
            errors.push(issue(
                ISSUE_TOO_LARGE,
                scope,
                None,
                Some(component.overlay.remove.len() as u64),
                format!("{} removes more than {MAX_REMOVALS} files of the release", component.label),
            ));
        }
        check_config_lengths(&component.configs, scope, &mut errors, &issue);
    }
    let mut seen_shared = HashSet::new();
    for file in &draft.shared.files {
        if !seen_shared.insert(file.path.to_ascii_lowercase()) {
            errors.push(issue(
                ISSUE_DUPLICATE_PATH,
                Some(SHARED_SCOPE),
                Some(&file.path),
                None,
                format!("{} is in the shared files twice", file.path),
            ));
        }
    }
    check_config_lengths(&draft.shared.configs, Some(SHARED_SCOPE), &mut errors, &issue);

    // Sums. The version holds its files and the listings of its pk3 files,
    // which is what the service weighs against the limit of a version; the
    // pictures of the description go to the store next to them and count
    // in the bytes shown, not in that limit.
    let mut version_bytes = 0u64;
    let mut jkhub_bytes = 0u64;
    let mut file_count = 0u32;
    let mut executables = Vec::new();
    for (scope, file) in draft.all_files() {
        file_count += 1;
        version_bytes += file.listing.as_ref().map_or(0, |listing| listing.size);
        if file.is_blob() {
            version_bytes += file.size;
            if file.size > MAX_FILE_BYTES {
                errors.push(issue(
                    ISSUE_TOO_LARGE,
                    Some(scope),
                    Some(&file.path),
                    Some(file.size),
                    format!(
                        "{} is bigger than the {} MiB a bundle file may be",
                        file.path,
                        MAX_FILE_BYTES / (1024 * 1024)
                    ),
                ));
            }
        } else {
            jkhub_bytes += file.size;
        }
        if FileKind::of_path(&file.path).is_executable() {
            executables.push(format!("{scope}/{}", file.path));
        }
    }
    if version_bytes > MAX_VERSION_BYTES {
        errors.push(issue(
            ISSUE_TOO_LARGE,
            None,
            None,
            Some(version_bytes),
            format!(
                "the files and listings to upload add up to more than the {} GiB a version may hold",
                MAX_VERSION_BYTES / (1024 * 1024 * 1024)
            ),
        ));
    }
    let blob_bytes = version_bytes + draft.image_bytes();
    if file_count as usize > MAX_FILES {
        errors.push(issue(
            ISSUE_TOO_LARGE,
            None,
            None,
            Some(file_count as u64),
            format!("the bundle lists {file_count} files, more than the {MAX_FILES} allowed"),
        ));
    }
    let configs_count = draft.shared.configs.len()
        + draft
            .components
            .iter()
            .map(|component| component.configs.len())
            .sum::<usize>();
    if !draft.components.is_empty() && file_count == 0 && configs_count == 0 {
        errors.push(issue(
            ISSUE_EMPTY_BUNDLE,
            None,
            None,
            None,
            "the bundle carries no file and no config document".into(),
        ));
    }

    if !executables.is_empty() {
        warnings.push(issue(
            ISSUE_EXECUTABLES_PRESENT,
            None,
            None,
            Some(executables.len() as u64),
            "the version carries executables and goes to a reviewer before it is published".into(),
        ));
    }
    let stripped: u32 = draft
        .components
        .iter()
        .flat_map(|component| component.configs.iter())
        .chain(draft.shared.configs.iter())
        .map(|config| strip_passwords(&config.text).1)
        .sum();
    if stripped > 0 {
        warnings.push(issue(
            ISSUE_PASSWORDS_STRIPPED,
            None,
            None,
            Some(stripped as u64),
            format!("{stripped} line(s) that set a password are left out of the configs"),
        ));
    }

    DraftIssues {
        errors,
        warnings,
        blob_bytes,
        jkhub_bytes,
        file_count,
        executables,
    }
}

/// How [`validate`] builds one finding.
type IssueMaker<'a> = &'a dyn Fn(&str, Option<&str>, Option<&str>, Option<u64>, String) -> Issue;

fn check_config_lengths(
    configs: &[DraftConfig],
    scope: Option<&str>,
    errors: &mut Vec<Issue>,
    issue: IssueMaker<'_>,
) {
    for config in configs {
        if config.text.len() > MAX_CONFIG_TEXT {
            errors.push(issue(
                ISSUE_CONFIG_TOO_LONG,
                scope,
                None,
                Some(config.text.len() as u64),
                format!(
                    "the config {} is longer than {} KiB",
                    config.name,
                    MAX_CONFIG_TEXT / 1024
                ),
            ));
        }
    }
}

/// The checks of `draft_set_configs`: what a list may hold at all. The
/// length of a text is reported by [`validate`] rather than refused here,
/// so the editor can show the document and say why.
fn check_config_list(configs: &[DraftConfig]) -> Result<Vec<DraftConfig>> {
    if configs.len() > MAX_CONFIGS {
        return Err(AppError::InvalidInput(format!(
            "more than {MAX_CONFIGS} config documents"
        )));
    }
    configs
        .iter()
        .map(|config| {
            let name = config.name.trim();
            if name.is_empty() || name.chars().count() > MAX_CONFIG_NAME {
                return Err(AppError::InvalidInput(format!(
                    "the config name {:?} is empty or longer than {MAX_CONFIG_NAME} characters",
                    config.name
                )));
            }
            Ok(DraftConfig {
                name: name.to_string(),
                text: config.text.clone(),
                priority: config.priority,
                source_config_id: config.source_config_id.clone(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The manifest of a draft
// ---------------------------------------------------------------------------

/// The manifest a publish sends and a test install reads: sources by origin,
/// `replaces` from the release, the password lines out of the configs.
pub(crate) fn manifest_of(draft: &Draft) -> Manifest {
    let configs = |list: &[DraftConfig]| {
        list.iter()
            .map(|config| manifest::ManifestConfig {
                name: config.name.trim().to_string(),
                text: strip_passwords(&config.text).0,
                priority: config.priority,
            })
            .collect()
    };
    Manifest {
        schema: manifest::SCHEMA,
        game: draft.game.id().to_string(),
        components: draft
            .components
            .iter()
            .map(|component| manifest::ManifestComponent {
                id: component.id.clone(),
                label: component.label.trim().to_string(),
                engine: manifest::ManifestEngine {
                    engine_id: component.engine_id.clone(),
                    release_tag: component.release_tag.clone(),
                },
                modes: component.modes.clone(),
                fs_game: component.fs_game.clone(),
                launch_args: component.launch_args.trim().to_string(),
                overlay: manifest::ManifestOverlay {
                    files: component.overlay.files.iter().map(DraftFile::manifest_file).collect(),
                    remove: component.overlay.remove.clone(),
                },
                files: component.files.iter().map(DraftFile::manifest_file).collect(),
                configs: configs(&component.configs),
            })
            .collect(),
        shared: manifest::ManifestShared {
            files: draft.shared.files.iter().map(DraftFile::manifest_file).collect(),
            configs: configs(&draft.shared.configs),
        },
    }
}

/// Where every file of the draft lies, by its hash: what the upload of a
/// publish and the test install read from.
pub(crate) fn files_by_hash(paths: &DataPaths, draft: &Draft) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    for (scope, file) in draft.all_files() {
        if let Ok(path) = file_path(paths, &draft.id, scope, file.root, &file.path) {
            map.entry(file.sha256.clone()).or_insert(path);
        }
    }
    map
}

// ---------------------------------------------------------------------------
// A component out of a client
// ---------------------------------------------------------------------------

/// Everything the blocking half of `create_bundle_draft` reads, resolved
/// beforehand.
struct ClientInputs {
    paths: DataPaths,
    draft_id: String,
    client: Client,
    engine: &'static Engine,
    /// The entries of the release archive, `None` when the engine is not
    /// installed and there is no overlay to look for.
    release: Option<HashMap<String, ArchiveEntry>>,
    configs: Vec<DraftConfig>,
}

/// The folders of `home\` the client loads: `base`, the mod folder, and the
/// overlay folder of a fork that keeps one (`EternalJK\`, `taystjk\`).
/// Lowercase-unique, in that order.
fn loaded_folders(client: &Client, engine: &Engine) -> Vec<String> {
    let mut folders: Vec<String> = vec!["base".to_string()];
    let mut push = |folder: &str| {
        let folder = folder.trim();
        if !folder.is_empty() && !folders.iter().any(|known| known.eq_ignore_ascii_case(folder)) {
            folders.push(folder.to_string());
        }
    };
    if let Some(folder) = client.fs_game.as_deref().or(engine.default_fs_game) {
        push(folder);
    }
    if let Some(folder) = configs::engine_folder(client) {
        push(folder);
    }
    folders
}

/// The names of the configs the engine writes on its own, lowercase: the
/// startup file of this build, the two stock names of the games, and the
/// name of the executable with `.cfg`. Personal, and left out of a draft.
fn personal_configs(client: &Client, engine: &Engine) -> Vec<String> {
    let mut names = vec![
        configs::startup_file(client).to_ascii_lowercase(),
        "jampconfig.cfg".to_string(),
        "jk2mvconfig.cfg".to_string(),
        "jk2mpconfig.cfg".to_string(),
    ];
    let stem = engine
        .executable
        .split('.')
        .next()
        .unwrap_or(engine.executable)
        .to_ascii_lowercase();
    if !stem.is_empty() {
        names.push(format!("{stem}.cfg"));
    }
    names.sort();
    names.dedup();
    names
}

/// Every file under `dir`, as `(relative path, absolute path, size)`, media
/// folders and the notes of the launcher skipped. Symlinked folders are not
/// followed: a link out of the client is not the client.
fn walk(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf, u64)>) -> Result<()> {
    let entries = fs::read_dir(dir).map_err(|e| AppError::io_path("cannot list", dir, e))?;
    let mut listed: Vec<fs::DirEntry> = entries.flatten().collect();
    listed.sort_by_key(|entry| entry.file_name());
    for entry in listed {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if meta.is_dir() {
            let lower = name.to_ascii_lowercase();
            if meta.file_type().is_symlink()
                || MEDIA_FOLDERS.contains(&lower.as_str())
                || lower == NOTES_FOLDER
            {
                continue;
            }
            walk(root, &path, files)?;
        } else if meta.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            files.push((relative, path, meta.len()));
        }
    }
    Ok(())
}

/// The blocking half: the overlay of `engine\` against the release, the pk3
/// files of the library, the loose files of the folders the client loads,
/// every one copied into the draft.
fn component_from_client(inputs: &ClientInputs) -> Result<DraftComponent> {
    let client = &inputs.client;
    let engine = inputs.engine;
    let paths = &inputs.paths;
    let scope = component_id(engine.name, &[]);
    let engine_dir = paths.client_engine_dir(&client.id);
    let home_dir = paths.client_home_dir(&client.id);

    // The overlay: what differs from the release, and what is gone.
    let mut overlay = DraftOverlay::default();
    if let Some(release) = &inputs.release {
        let mut on_disk = Vec::new();
        if engine_dir.is_dir() {
            walk(&engine_dir, &engine_dir, &mut on_disk)?;
        }
        let mut present = HashSet::new();
        for (relative, path, size) in on_disk {
            let lower = relative.to_ascii_lowercase();
            present.insert(lower.clone());
            if lower.ends_with(".log") {
                continue;
            }
            if manifest::check_path(&relative).is_err() {
                log::warn!("bundles: skipping {relative}: not a portable path");
                continue;
            }
            if size > MAX_FILE_BYTES {
                log::warn!("bundles: skipping {relative}: bigger than a bundle file may be");
                continue;
            }
            let sha256 = sha256_of(&path)?;
            if release.get(&lower).is_some_and(|entry| entry.sha256 == sha256) {
                continue; // the release's own file, unchanged
            }
            let origin = release::overlay_origin(release, &relative, &path);
            let spelled = release::release_spelling(release, &relative);
            let file = import_file(paths, &inputs.draft_id, &scope, FileRoot::Engine, &spelled, &path, None, origin)?;
            put_file(&mut overlay.files, file);
        }
        let mut removed: Vec<String> = release
            .iter()
            .filter(|(key, _)| !present.contains(*key))
            .map(|(_, entry)| entry.path.clone())
            .collect();
        removed.sort_by_key(|path| path.to_ascii_lowercase());
        removed.truncate(MAX_REMOVALS);
        overlay.remove = removed;
    }

    // The library: the enabled pk3 files of the folders the client loads.
    let loaded = loaded_folders(client, engine);
    let mut files = Vec::new();
    for item in library::read_library(paths, &client.id)? {
        let loads = loaded.iter().any(|folder| folder.eq_ignore_ascii_case(&item.folder));
        if !item.enabled || !loads || is_game_asset(&item.file_name) {
            continue;
        }
        let source = home_dir.join(&item.folder).join(&item.file_name);
        let relative = format!("{}/{}", item.folder, item.file_name);
        if manifest::check_path(&relative).is_err() {
            continue;
        }
        let from_jkhub = item.provenance.as_ref().is_some_and(|p| p.source == "jkhub");
        if !from_jkhub && item.size > MAX_FILE_BYTES {
            log::warn!("bundles: skipping {relative}: bigger than a bundle file may be");
            continue;
        }
        let origin = DraftOrigin::Client {
            client_id: client.id.clone(),
            item_id: item.id.clone(),
            provenance: item.provenance.clone(),
        };
        // A JKHub file is referenced, not uploaded, whatever its size: the
        // limit of the store does not apply. The import refuses the size
        // itself, so the copy is made by hand for that one case.
        let file = if from_jkhub && item.size > MAX_FILE_BYTES {
            let target = file_path(paths, &inputs.draft_id, &scope, FileRoot::Home, &relative)?;
            if let Some(parent) = target.parent() {
                paths::create_dir(parent)?;
            }
            fs::copy(&source, &target).map_err(|e| AppError::io_path("cannot copy into", &target, e))?;
            let sha256 = sha256_of(&target)?;
            let listing = listing::listing_of_new_file(paths, &inputs.draft_id, &sha256, &target);
            DraftFile {
                root: FileRoot::Home,
                path: relative,
                size: item.size,
                sha256,
                kind: FileKind::Pk3,
                library: Some(pk3_info(&target, item.display_name.clone())),
                listing,
                origin,
            }
        } else {
            import_file(
                paths,
                &inputs.draft_id,
                &scope,
                FileRoot::Home,
                &relative,
                &source,
                Some(item.display_name.clone()),
                origin,
            )?
        };
        put_file(&mut files, file);
    }

    // The loose files of the same folders: configs, module binaries,
    // readmes. The personal config of the engine stays out.
    let personal = personal_configs(client, engine);
    for folder in &loaded {
        let dir = home_dir.join(folder);
        if !dir.is_dir() {
            continue;
        }
        let mut loose = Vec::new();
        walk(&dir, &dir, &mut loose)?;
        for (inner, path, size) in loose {
            let name = inner.rsplit('/').next().unwrap_or(&inner).to_ascii_lowercase();
            let extension = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or_default().to_string();
            if extension == "pk3" || name.ends_with(".pk3.disabled") {
                continue; // the library's
            }
            if name.starts_with("jknet-") && extension == "cfg"
                || extension == "log"
                || matches!(name.as_str(), "library.json" | "client.json" | "profiles.json")
                || !inner.contains('/') && personal.iter().any(|known| known == &name)
                || !TAKEN_EXTENSIONS.contains(&extension.as_str())
                || size > MAX_FILE_BYTES
            {
                continue;
            }
            let relative = format!("{folder}/{inner}");
            if manifest::check_path(&relative).is_err() {
                continue;
            }
            let origin = DraftOrigin::Disk {
                source_path: path.display().to_string(),
            };
            let file = import_file(paths, &inputs.draft_id, &scope, FileRoot::Home, &relative, &path, None, origin)?;
            put_file(&mut files, file);
        }
    }
    files.sort_by_key(|file| file.path.to_ascii_lowercase());
    overlay.files.sort_by_key(|file| file.path.to_ascii_lowercase());

    Ok(DraftComponent {
        id: scope,
        label: engine.name.to_string(),
        engine_id: engine.id.to_string(),
        release_tag: client.engine_version.clone(),
        modes: client.launch_modes(engine),
        fs_game: client.fs_game.clone(),
        launch_args: client.launch_args.clone(),
        overlay,
        files,
        configs: inputs.configs.clone(),
    })
}

/// A draft with one component made out of a client, or an empty one. Its
/// fields are in the language of the interface, and a client brings no
/// translation: the name of a client is in whatever language the player
/// typed it.
pub(crate) async fn create(state: &AppState, game: Game, name: &str, from_client: Option<&str>) -> Result<Draft> {
    let paths = state.paths()?;
    let language = initial_language(&state.settings()?);
    let mut draft = new_draft(game, name, &language);
    let Some(client_id) = from_client else {
        write_draft(&paths, &draft)?;
        return Ok(draft);
    };
    let client = clients::read_record(&paths, client_id)?;
    if client.game != game {
        return Err(AppError::GameMismatch(format!(
            "{} plays {}, and the draft is for {}",
            client.name,
            client.game.display_name(),
            game.display_name()
        )));
    }
    let engine = engines::require_for_game(&client.engine_id, game)?;
    let engine_dir = paths.client_engine_dir(&client.id);
    let installed = client.engine_version.is_some() && engine.installed_executable(&engine_dir).is_file();
    let release = if installed {
        let (_, archive) = release::release_archive(&paths, engine, client.engine_version.as_deref()).await?;
        Some(release::read_entries(&archive).await?)
    } else {
        None
    };
    let configs = configs::assigned_documents(state, &client)?
        .into_iter()
        .map(|(layer, document)| DraftConfig {
            name: document.name,
            text: document.text,
            priority: layer.priority,
            source_config_id: Some(document.id),
        })
        .collect();
    if draft.name.is_empty() {
        draft.name = client.name.clone();
    }
    let inputs = ClientInputs {
        paths: paths.clone(),
        draft_id: draft.id.clone(),
        client,
        engine,
        release,
        configs,
    };
    let component = match off_thread(move || component_from_client(&inputs)).await {
        Ok(component) => component,
        Err(e) => {
            let _ = fs::remove_dir_all(paths.bundle_draft_dir(&draft.id));
            return Err(e);
        }
    };
    draft.components.push(component);
    write_draft(&paths, &draft)?;
    log::info!(
        "bundles: draft {} made out of {} with {} file(s)",
        draft.id,
        client_id,
        draft.all_files().count()
    );
    Ok(draft)
}

// ---------------------------------------------------------------------------
// A draft out of a bundle of the catalogue
// ---------------------------------------------------------------------------

/// Payload of [`PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftProgress {
    pub draft_id: String,
    pub bundle_id: String,
    pub version_id: String,
    /// `files`, `done` or `error`.
    pub phase: &'static str,
    pub file_index: u32,
    pub file_count: u32,
    pub current_file: Option<String>,
    pub downloaded: u64,
    pub total: u64,
    pub message: String,
}

/// The main language of a bundle of the catalogue, for a draft made out of
/// it: what the card says, or English when the card names a language this
/// build has no catalog for, with a line in the log. The service only
/// stores the languages of the launcher, so the second case is a newer
/// service in front of an older launcher.
fn language_of_bundle(card: &BundleCard) -> String {
    if is_bundle_language(&card.language) {
        card.language.clone()
    } else {
        log::warn!(
            "bundles: {} is written in {:?}, which this build does not know; the draft calls it {DEFAULT_LANGUAGE}",
            card.name,
            card.language
        );
        default_language()
    }
}

/// The translations of a bundle of the catalogue, for a draft made out of
/// it: every entry in a language this build knows, other than the main
/// one, the description read as empty where the answer left it out.
fn translations_of_bundle(card: &BundleCard, language: &str) -> BTreeMap<String, DraftTranslation> {
    let mut translations = BTreeMap::new();
    for (code, translation) in &card.translations {
        if !is_bundle_language(code) || code == language {
            log::warn!("bundles: the translation of {} into {code:?} is left out of the draft", card.name);
            continue;
        }
        if translations.len() >= MAX_TRANSLATIONS {
            log::warn!("bundles: {} carries more than {MAX_TRANSLATIONS} translations; {code} is left out", card.name);
            continue;
        }
        translations.insert(code.clone(), DraftTranslation::from_contract(translation));
    }
    translations
}

/// A draft linked to a bundle, with every file of the version downloaded
/// into it: for a new version from another machine, or after the draft was
/// lost.
pub(crate) async fn create_from_bundle(
    app: &AppHandle,
    state: &AppState,
    online: &OnlineClient,
    jkhub: &JkhubState,
    bundle_id: &str,
    version_id: Option<&str>,
) -> Result<Draft> {
    use tauri::Emitter;

    let paths = state.paths()?;
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    let bundle_path = format!("/v1/bundles/{}", path_segment(bundle_id)?);
    let details: BundleDetails = online
        .request(&ctx, reqwest::Method::GET, &bundle_path, None, Auth::Optional)
        .await?;
    let version = match (details.latest.clone(), version_id) {
        (Some(latest), None) => latest,
        (Some(latest), Some(wanted)) if latest.summary.id == wanted => latest,
        (_, Some(wanted)) => {
            let path = format!("{bundle_path}/versions/{}", path_segment(wanted)?);
            online
                .request::<BundleVersion>(&ctx, reqwest::Method::GET, &path, None, Auth::Optional)
                .await?
        }
        (None, None) => {
            return Err(AppError::BundleUnavailable(format!(
                "{} has no published version to start a draft from",
                details.card.name
            )))
        }
    };
    let manifest = version.manifest.clone();
    manifest::validate(&manifest)?;
    let game = Game::from_id(&manifest.game).ok_or_else(|| {
        AppError::BundleUnavailable(format!("the game {:?} is not one of ours", manifest.game))
    })?;

    let mut draft = new_draft(game, &details.card.name, &language_of_bundle(&details.card));
    draft.summary = details.card.summary.clone();
    draft.description = details.description.clone();
    draft.translations = translations_of_bundle(&details.card, &draft.language);
    draft.tags = details.card.tags.clone();
    draft.website = details.website.clone();
    draft.discord = details.discord.clone();
    draft.version_label = version.summary.label.clone();
    // Linked only when the bundle is the account's own: a publish of the
    // draft would otherwise be refused, and a draft of somebody else's
    // bundle is the start of a bundle of one's own.
    let mine = settings
        .online_user
        .as_ref()
        .zip(details.card.owner.as_ref())
        .is_some_and(|(me, owner)| me.id == owner.id);
    if mine {
        draft.bundle_id = Some(details.card.id.clone());
        draft.bundle_slug = Some(details.card.slug.clone());
        draft.last_version_id = Some(version.summary.id.clone());
    }

    let ids = (draft.id.clone(), details.card.id.clone(), version.summary.id.clone());
    let emit = |phase: &'static str, index: u32, count: u32, file: Option<String>, downloaded: u64, total: u64, message: String| {
        let progress = DraftProgress {
            draft_id: ids.0.clone(),
            bundle_id: ids.1.clone(),
            version_id: ids.2.clone(),
            phase,
            file_index: index,
            file_count: count,
            current_file: file,
            downloaded,
            total,
            message,
        };
        if let Err(e) = app.emit(PROGRESS_EVENT, progress) {
            log::warn!("cannot emit {PROGRESS_EVENT}: {e}");
        }
    };

    let source = install::OnlineSource::new(app, online, ctx.clone(), jkhub, paths.clone());
    let cache_dir = paths.cache.join(install::CACHE_FOLDER);
    // The pictures of the descriptions of every language, each once.
    let picture_refs = draft.image_refs();
    let pictures = picture_refs.len() as u32;
    let count = manifest.all_files().count() as u32 + pictures;
    let outcome: Result<()> = async {
        let mut index = 0u32;
        // The pictures of the descriptions first: they are small, and the
        // Overview section shows them while the files still come down.
        if pictures > 0 {
            let mut report = |picture: u32, _: u32, sha256: &str| {
                emit(
                    "files",
                    picture,
                    count,
                    Some(format!("images/{sha256}")),
                    0,
                    0,
                    format!("Fetching picture {sha256}"),
                );
            };
            draft.images = images::fetch_images(online, &ctx, &paths, &draft.id, &picture_refs, &mut report).await?;
            index += pictures;
        }
        for component in &manifest.components {
            let mut made = DraftComponent {
                id: component.id.clone(),
                label: component.label.clone(),
                engine_id: component.engine.engine_id.clone(),
                release_tag: component.engine.release_tag.clone(),
                modes: component.modes.clone(),
                fs_game: component.fs_game.clone(),
                launch_args: component.launch_args.clone(),
                overlay: DraftOverlay {
                    files: Vec::new(),
                    remove: component.overlay.remove.clone(),
                },
                files: Vec::new(),
                configs: component
                    .configs
                    .iter()
                    .map(|config| DraftConfig {
                        name: config.name.clone(),
                        text: config.text.clone(),
                        priority: config.priority,
                        source_config_id: None,
                    })
                    .collect(),
            };
            for file in component.overlay.files.iter().chain(component.files.iter()) {
                index += 1;
                let made_file =
                    fetch_into_draft(&source, &paths, &cache_dir, &draft.id, &component.id, file, index, count, &emit).await?;
                if file.root == FileRoot::Engine {
                    made.overlay.files.push(made_file);
                } else {
                    made.files.push(made_file);
                }
            }
            draft.components.push(made);
        }
        for file in &manifest.shared.files {
            index += 1;
            let made_file =
                fetch_into_draft(&source, &paths, &cache_dir, &draft.id, SHARED_SCOPE, file, index, count, &emit).await?;
            draft.shared.files.push(made_file);
        }
        draft.shared.configs = manifest
            .shared
            .configs
            .iter()
            .map(|config| DraftConfig {
                name: config.name.clone(),
                text: config.text.clone(),
                priority: config.priority,
                source_config_id: None,
            })
            .collect();
        write_draft(&paths, &draft)
    }
    .await;
    match outcome {
        Ok(()) => {
            emit("done", count, count, None, 0, 0, format!("{} is ready to edit", draft.name));
            log::info!("bundles: draft {} made out of bundle {} version {}", draft.id, ids.1, ids.2);
            Ok(draft)
        }
        Err(e) => {
            log::error!("bundles: making a draft out of bundle {} failed: {e}", ids.1);
            let file = match &e {
                AppError::BundleFile { path, .. } => Some(path.clone()),
                _ => None,
            };
            emit("error", 0, count, file, 0, 0, e.to_string());
            let _ = fs::remove_dir_all(paths.bundle_draft_dir(&draft.id));
            Err(e)
        }
    }
}

/// Fetches one file of a version into the draft and describes it.
#[allow(clippy::too_many_arguments)]
async fn fetch_into_draft<S: FileSource + ?Sized>(
    source: &S,
    paths: &DataPaths,
    cache_dir: &Path,
    draft_id: &str,
    scope: &str,
    file: &ManifestFile,
    index: u32,
    count: u32,
    emit: &(dyn Fn(&'static str, u32, u32, Option<String>, u64, u64, String) + Sync),
) -> Result<DraftFile> {
    let target = file_path(paths, draft_id, scope, file.root, &file.path)?;
    let mut report = |downloaded: u64, total: u64| {
        emit(
            "files",
            index,
            count,
            Some(file.path.clone()),
            downloaded,
            total,
            format!("Fetching {}", file.path),
        );
    };
    let fetched = install::fetch_file(source, cache_dir, file, &target, None, &mut report).await?;
    let origin = match (&file.source, &file.origin, &file.replaces) {
        (ManifestSource::Jkhub { file_id, version, title, url }, _, _) => DraftOrigin::Jkhub {
            file_id: *file_id,
            version: version.clone(),
            title: title.clone(),
            url: url.clone(),
            // What JKHub serves today, which may differ from the manifest.
            sha256: fetched.sha256.clone(),
        },
        (ManifestSource::Blob, Some(FileOrigin::Jkhub { file_id, sha256, .. }), _) => DraftOrigin::Jkhub {
            file_id: *file_id,
            version: None,
            title: None,
            url: None,
            sha256: sha256.clone(),
        },
        (ManifestSource::Blob, _, Some(replaced)) => DraftOrigin::Release {
            sha256: replaced.sha256.clone(),
            size: replaced.size,
        },
        (ManifestSource::Blob, _, None) => DraftOrigin::Disk {
            source_path: target.display().to_string(),
        },
    };
    let name = file.path.rsplit('/').next().unwrap_or(&file.path);
    let kind = FileKind::of_path(&file.path);
    let library = if file.root == FileRoot::Home && kind == FileKind::Pk3 {
        match file.library.clone() {
            Some(library) => Some(library),
            None => {
                // A manifest may leave `library` out; reading the archive is
                // a full pass over up to 512 MiB, so it goes off the runtime
                // thread like every other inspection of this module.
                let display = display_name_of(name);
                let archive = target.clone();
                Some(off_thread(move || Ok(pk3_info(&archive, display))).await?)
            }
        }
    } else {
        None
    };
    // The listing is built here rather than downloaded: the archive is on
    // disk now, and its document is a pass over the central directory.
    let listing = if kind == FileKind::Pk3 {
        let (paths_for_listing, draft_for_listing, sha256, archive) =
            (paths.clone(), draft_id.to_string(), fetched.sha256.clone(), target.clone());
        off_thread(move || Ok(listing::listing_of_new_file(&paths_for_listing, &draft_for_listing, &sha256, &archive))).await?
    } else {
        None
    };
    Ok(DraftFile {
        root: file.root,
        path: file.path.clone(),
        size: fetched.size,
        sha256: fetched.sha256,
        kind,
        library,
        listing,
        origin,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every draft on this machine, newest change first.
#[tauri::command]
pub fn list_bundle_drafts(state: tauri::State<'_, AppState>) -> Result<Vec<DraftSummary>> {
    Ok(read_all(&state.paths()?)?
        .iter()
        .map(Draft::summary)
        .collect())
}

/// A new draft: empty, or with one component made out of a client.
#[tauri::command]
pub async fn create_bundle_draft(
    state: tauri::State<'_, AppState>,
    game: Game,
    name: String,
    from_client_id: Option<String>,
) -> Result<Draft> {
    let from_client = from_client_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    create(&state, game, &name, from_client.as_deref()).await
}

/// A draft out of a bundle of the catalogue, its files downloaded.
/// Progress arrives through `bundles:draft-progress`.
#[tauri::command]
pub async fn create_bundle_draft_from_bundle(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    jkhub: tauri::State<'_, JkhubState>,
    bundle_id: String,
    version_id: Option<String>,
) -> Result<Draft> {
    let version = version_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    create_from_bundle(&app, &state, &online, &jkhub, &bundle_id, version.as_deref()).await
}

/// One draft, whole.
#[tauri::command]
pub fn get_bundle_draft(state: tauri::State<'_, AppState>, draft_id: String) -> Result<Draft> {
    read_draft(&state.paths()?, &draft_id)
}

/// Changes the fields of the bundle a draft describes.
#[tauri::command]
pub fn update_bundle_draft(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    patch: DraftPatch,
) -> Result<Draft> {
    edit_draft(&state.paths()?, &draft_id, |draft| apply_patch(draft, patch))
}

/// Deletes a draft with every file it copied. Refused while the draft is
/// being installed or published.
#[tauri::command]
pub fn delete_bundle_draft(
    state: tauri::State<'_, AppState>,
    bundles: tauri::State<'_, BundlesState>,
    draft_id: String,
) -> Result<()> {
    let paths = state.paths()?;
    check_draft_id(&draft_id)?;
    let _claim = bundles.claim(&super::draft_key(&draft_id), BundlesState::DELETE)?;
    let _step = EDITS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = paths.bundle_draft_dir(&draft_id);
    if !record_path(&paths, &draft_id).is_file() {
        return Err(AppError::NotFound(format!("bundle draft {draft_id}")));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io_path("cannot delete", &dir, e))?;
    log::info!("bundles: deleted draft {draft_id}");
    Ok(())
}

/// Adds a component. The component travels as one `component` argument or
/// as its fields spelled out; either is read.
#[tauri::command]
pub fn draft_add_component(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component: Option<NewComponent>,
    engine_id: Option<String>,
    release_tag: Option<String>,
    label: Option<String>,
    modes: Option<Vec<LaunchMode>>,
) -> Result<Draft> {
    let component = match component {
        Some(component) => component,
        None => NewComponent {
            engine_id: engine_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| AppError::InvalidInput("the component names no engine".into()))?,
            release_tag,
            label: label.unwrap_or_default(),
            modes: modes.unwrap_or_default(),
        },
    };
    edit_draft(&state.paths()?, &draft_id, |draft| {
        if draft.components.len() >= MAX_COMPONENTS {
            return Err(AppError::InvalidInput(format!(
                "a bundle has at most {MAX_COMPONENTS} components"
            )));
        }
        let engine = engines::require_for_game(component.engine_id.trim(), draft.game)?;
        let label = check_label(&component.label)?;
        let modes = if component.modes.is_empty() {
            engine.modes()
        } else {
            check_component_modes(engine, &component.modes)?
        };
        let taken: Vec<String> = draft.components.iter().map(|c| c.id.clone()).collect();
        draft.components.push(DraftComponent {
            id: component_id(&label, &taken),
            label,
            engine_id: engine.id.to_string(),
            release_tag: trimmed_tag(component.release_tag),
            modes,
            fs_game: None,
            launch_args: String::new(),
            overlay: DraftOverlay::default(),
            files: Vec::new(),
            configs: Vec::new(),
        });
        Ok(())
    })
}

/// Changes the label, release, modes, mod folder or launch arguments of a
/// component. The id of the component stays: files are filed under it.
#[tauri::command]
pub fn draft_update_component(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component_id: String,
    patch: ComponentPatch,
) -> Result<Draft> {
    edit_draft(&state.paths()?, &draft_id, |draft| {
        let component = component_mut(draft, &component_id)?;
        let engine = engines::require(&component.engine_id)?;
        if let Some(label) = patch.label {
            component.label = check_label(&label)?;
        }
        if let Some(tag) = patch.release_tag {
            component.release_tag = trimmed_tag(tag);
        }
        if let Some(modes) = patch.modes {
            component.modes = check_component_modes(engine, &modes)?;
        }
        if let Some(folder) = patch.fs_game {
            component.fs_game = match folder {
                Some(folder) => clients::validate_fs_game(&folder)?,
                None => None,
            };
        }
        if let Some(args) = patch.launch_args {
            let args = args.trim().to_string();
            if args.chars().count() > manifest::MAX_LAUNCH_ARGS {
                return Err(AppError::InvalidInput(format!(
                    "the launch arguments are longer than {} characters",
                    manifest::MAX_LAUNCH_ARGS
                )));
            }
            component.launch_args = args;
        }
        Ok(())
    })
}

/// Removes a component and every file filed under it.
#[tauri::command]
pub fn draft_remove_component(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component_id: String,
) -> Result<Draft> {
    let paths = state.paths()?;
    let draft = edit_draft(&paths, &draft_id, |draft| {
        let before = draft.components.len();
        draft.components.retain(|component| component.id != component_id);
        if draft.components.len() == before {
            return Err(AppError::NotFound(format!("component {component_id} of the draft")));
        }
        Ok(())
    })?;
    if manifest::check_component_id(&component_id).is_ok() {
        let dir = paths
            .bundle_draft_dir(&draft_id)
            .join(paths::BUNDLE_DRAFT_FILES_DIR)
            .join(&component_id);
        if dir.is_dir() {
            if let Err(e) = fs::remove_dir_all(&dir) {
                log::warn!("cannot remove {}: {e}", dir.display());
            }
        }
    }
    listing::prune_draft_listings(&paths, &draft);
    Ok(draft)
}

/// Adds files picked on disk to a folder of `home\` of a scope. A pk3 is
/// classified the way the Library screen would classify it.
#[tauri::command]
pub async fn draft_add_files_from_disk(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    scope: String,
    folder: String,
    paths: Vec<String>,
) -> Result<Draft> {
    let data = state.paths()?;
    let folder = check_folder(&folder)?;
    check_scope(&read_draft(&data, &draft_id)?, &scope)?;
    let sources: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let (draft_for_copy, scope_for_copy, data_for_copy) = (draft_id.clone(), scope.clone(), data.clone());
    let files = off_thread(move || {
        sources
            .iter()
            .map(|source| {
                let path = home_path(&folder, source)?;
                let origin = DraftOrigin::Disk {
                    source_path: source.display().to_string(),
                };
                import_file(&data_for_copy, &draft_for_copy, &scope_for_copy, FileRoot::Home, &path, source, None, origin)
            })
            .collect::<Result<Vec<DraftFile>>>()
    })
    .await?;
    let draft = edit_draft(&data, &draft_id, |draft| {
        let list = home_files_mut(draft, &scope)?;
        for file in files {
            put_file(list, file);
        }
        Ok(())
    })?;
    listing::prune_draft_listings(&data, &draft);
    Ok(draft)
}

/// Downloads a record of JKHub and adds every pk3 of its archive to a
/// folder of `home\` of a scope. Progress arrives through
/// `jkhub:download-progress`, the way the JKHub tab reports it.
#[tauri::command]
pub async fn draft_add_file_from_jkhub(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    draft_id: String,
    scope: String,
    folder: String,
    file_id: u32,
) -> Result<Draft> {
    let data = state.paths()?;
    let folder = check_folder(&folder)?;
    let draft = read_draft(&data, &draft_id)?;
    check_scope(&draft, &scope)?;
    let _guard = jkhub.claim(file_id)?;
    let mut report = |_: u64, _: u64| {};
    let JkhubArchive { archive, file } = install::fetch_jkhub_archive(&app, &jkhub, &data, file_id, &mut report).await?;
    if !file.game.matches(draft.game) {
        return Err(AppError::InvalidInput("This JKHub file belongs to another game".into()));
    }
    let (draft_for_copy, scope_for_copy, data_for_copy) = (draft_id.clone(), scope.clone(), data.clone());
    let files = off_thread(move || {
        let contents = crate::jkhub::install::read_archive(&archive)?;
        let entries = crate::jkhub::install::require_pk3(&contents)?;
        let staging = data_for_copy.cache.join(install::CACHE_FOLDER).join(format!("jkhub-{file_id}"));
        paths::create_dir(&staging)?;
        let written = crate::jkhub::install::extract(&archive, entries, &staging)?;
        let mut files = Vec::with_capacity(written.len());
        for name in written {
            let source = staging.join(&name);
            let path = home_path(&folder, &source)?;
            let sha256 = sha256_of(&source)?;
            let origin = DraftOrigin::Jkhub {
                file_id,
                version: file.version.clone(),
                title: Some(file.title.clone()).filter(|title| !title.is_empty()),
                url: Some(file.url.clone()).filter(|url| !url.is_empty()),
                sha256,
            };
            let imported = import_file(&data_for_copy, &draft_for_copy, &scope_for_copy, FileRoot::Home, &path, &source, None, origin);
            let _ = fs::remove_file(&source);
            files.push(imported?);
        }
        let _ = fs::remove_dir(&staging);
        Ok(files)
    })
    .await;
    crate::jkhub::cache::forget_download(&data, file_id);
    let files = files?;
    let draft = edit_draft(&data, &draft_id, |draft| {
        let list = home_files_mut(draft, &scope)?;
        for file in files {
            put_file(list, file);
        }
        Ok(())
    })?;
    listing::prune_draft_listings(&data, &draft);
    Ok(draft)
}

/// Copies files of the library of a client into a scope, with the
/// provenance the JKHub tab wrote for them.
#[tauri::command]
pub async fn draft_add_files_from_client(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    scope: String,
    client_id: String,
    item_ids: Vec<String>,
) -> Result<Draft> {
    let data = state.paths()?;
    let draft = read_draft(&data, &draft_id)?;
    check_scope(&draft, &scope)?;
    let client = clients::read_record(&data, &client_id)?;
    if client.game != draft.game {
        return Err(AppError::GameMismatch(format!(
            "{} plays {}, and the draft is for {}",
            client.name,
            client.game.display_name(),
            draft.game.display_name()
        )));
    }
    let (draft_for_copy, scope_for_copy, data_for_copy) = (draft_id.clone(), scope.clone(), data.clone());
    let files = off_thread(move || {
        let library = library::read_library(&data_for_copy, &client.id)?;
        let home = data_for_copy.client_home_dir(&client.id);
        item_ids
            .iter()
            .map(|id| {
                let item = library
                    .iter()
                    .find(|item| &item.id == id)
                    .ok_or_else(|| AppError::NotFound(format!("library item {id} of {}", client.name)))?;
                let name = if item.enabled {
                    item.file_name.clone()
                } else {
                    format!("{}.disabled", item.file_name)
                };
                let source = home.join(&item.folder).join(name);
                let path = format!("{}/{}", item.folder, item.file_name);
                manifest::check_path(&path)?;
                let origin = DraftOrigin::Client {
                    client_id: client.id.clone(),
                    item_id: item.id.clone(),
                    provenance: item.provenance.clone(),
                };
                import_file(
                    &data_for_copy,
                    &draft_for_copy,
                    &scope_for_copy,
                    FileRoot::Home,
                    &path,
                    &source,
                    Some(item.display_name.clone()),
                    origin,
                )
            })
            .collect::<Result<Vec<DraftFile>>>()
    })
    .await?;
    let draft = edit_draft(&data, &draft_id, |draft| {
        let list = home_files_mut(draft, &scope)?;
        for file in files {
            put_file(list, file);
        }
        Ok(())
    })?;
    listing::prune_draft_listings(&data, &draft);
    Ok(draft)
}

/// Takes a file out of a scope and out of the draft folder.
#[tauri::command]
pub fn draft_remove_file(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    scope: String,
    root: FileRoot,
    path: String,
) -> Result<Draft> {
    let data = state.paths()?;
    let draft = edit_draft(&data, &draft_id, |draft| {
        let list = match root {
            FileRoot::Home => home_files_mut(draft, &scope)?,
            FileRoot::Engine => &mut component_mut(draft, &scope)?.overlay.files,
        };
        take_file(list, &path)
            .map(|_| ())
            .ok_or_else(|| AppError::NotFound(format!("{}/{path} in {scope}", root.as_str())))
    })?;
    remove_copy(&data, &draft_id, &scope, root, &path);
    listing::prune_draft_listings(&data, &draft);
    Ok(draft)
}

/// Replaces the config documents of a scope.
#[tauri::command]
pub fn draft_set_configs(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    scope: String,
    configs: Vec<DraftConfig>,
) -> Result<Draft> {
    let configs = check_config_list(&configs)?;
    edit_draft(&state.paths()?, &draft_id, |draft| {
        *configs_mut(draft, &scope)? = configs;
        Ok(())
    })
}

/// The files of the release of a component with what the component does
/// to each: the tree of the **Engine files** tab.
#[tauri::command]
pub async fn draft_engine_files(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component_id: String,
) -> Result<release::ReleaseView> {
    let data = state.paths()?;
    let draft = read_draft(&data, &draft_id)?;
    let component = draft
        .component(&component_id)
        .ok_or_else(|| AppError::NotFound(format!("component {component_id} of the draft")))?;
    let engine = engines::require(&component.engine_id)?;
    let (tag, entries) = release::component_release(&data, engine, component).await?;
    Ok(release::view(tag, &entries, component))
}

/// Lays one file picked on disk over a file of the release, under the
/// path of that file. A path the release does not have is an added file.
#[tauri::command]
pub async fn draft_replace_engine_file(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component_id: String,
    path: String,
    source_path: String,
) -> Result<Draft> {
    manifest::check_path(&path)?;
    add_engine_files(&state, &draft_id, &component_id, vec![(path, PathBuf::from(source_path))]).await
}

/// Adds files picked on disk to a folder of `engine\` of a component. A file
/// that lands on a path of the release replaces that file.
#[tauri::command]
pub async fn draft_add_engine_files(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component_id: String,
    folder: String,
    paths: Vec<String>,
) -> Result<Draft> {
    let folder = folder.trim().trim_matches('/').replace('\\', "/");
    if !folder.is_empty() {
        manifest::check_path(&folder)?;
    }
    let mut wanted = Vec::with_capacity(paths.len());
    for source in paths {
        let source = PathBuf::from(source);
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::InvalidInput(format!("{} has no file name", source.display())))?;
        let path = if folder.is_empty() {
            name.to_string()
        } else {
            format!("{folder}/{name}")
        };
        manifest::check_path(&path)?;
        wanted.push((path, source));
    }
    add_engine_files(&state, &draft_id, &component_id, wanted).await
}

/// The body of the two commands above: the release for the origins, the
/// copies, the record.
async fn add_engine_files(
    state: &AppState,
    draft_id: &str,
    component_id: &str,
    wanted: Vec<(String, PathBuf)>,
) -> Result<Draft> {
    let data = state.paths()?;
    let draft = read_draft(&data, draft_id)?;
    let component = draft
        .component(component_id)
        .ok_or_else(|| AppError::NotFound(format!("component {component_id} of the draft")))?;
    let engine = engines::require(&component.engine_id)?;
    let (_, entries) = release::component_release(&data, engine, component).await?;
    let (draft_for_copy, scope_for_copy, data_for_copy) = (draft_id.to_string(), component_id.to_string(), data.clone());
    let files = off_thread(move || {
        wanted
            .iter()
            .map(|(path, source)| {
                let spelled = release::release_spelling(&entries, path);
                let origin = release::overlay_origin(&entries, path, source);
                let file = import_file(&data_for_copy, &draft_for_copy, &scope_for_copy, FileRoot::Engine, &spelled, source, None, origin)?;
                if let DraftOrigin::Release { sha256, .. } = &file.origin {
                    if sha256 == &file.sha256 {
                        remove_copy(&data_for_copy, &draft_for_copy, &scope_for_copy, FileRoot::Engine, &spelled);
                        return Err(AppError::InvalidInput(format!(
                            "{spelled} is the same file the release ships"
                        )));
                    }
                }
                Ok(file)
            })
            .collect::<Result<Vec<DraftFile>>>()
    })
    .await?;
    let draft = edit_draft(&data, draft_id, |draft| {
        let component = component_mut(draft, component_id)?;
        for file in files {
            component
                .overlay
                .remove
                .retain(|removed| !removed.eq_ignore_ascii_case(&file.path));
            put_file(&mut component.overlay.files, file);
        }
        Ok(())
    })?;
    listing::prune_draft_listings(&data, &draft);
    Ok(draft)
}

/// Marks a file of the release as one the install takes out of `engine\`,
/// or takes the mark off.
#[tauri::command]
pub async fn draft_exclude_engine_file(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component_id: String,
    path: String,
    excluded: bool,
) -> Result<Draft> {
    manifest::check_path(&path)?;
    let data = state.paths()?;
    let spelled = if excluded {
        let draft = read_draft(&data, &draft_id)?;
        let component = draft
            .component(&component_id)
            .ok_or_else(|| AppError::NotFound(format!("component {component_id} of the draft")))?;
        let engine = engines::require(&component.engine_id)?;
        let (_, entries) = release::component_release(&data, engine, component).await?;
        if !entries.contains_key(&path.to_ascii_lowercase()) {
            return Err(AppError::InvalidInput(format!(
                "{path} is not a file of the release of {}",
                engine.name
            )));
        }
        release::release_spelling(&entries, &path)
    } else {
        path.clone()
    };
    let mut dropped = None;
    let draft = edit_draft(&data, &draft_id, |draft| {
        let component = component_mut(draft, &component_id)?;
        component
            .overlay
            .remove
            .retain(|removed| !removed.eq_ignore_ascii_case(&spelled));
        if excluded {
            if component.overlay.remove.len() >= MAX_REMOVALS {
                return Err(AppError::InvalidInput(format!(
                    "a component removes at most {MAX_REMOVALS} files of the release"
                )));
            }
            dropped = take_file(&mut component.overlay.files, &spelled);
            component.overlay.remove.push(spelled.clone());
        }
        Ok(())
    })?;
    if let Some(file) = dropped {
        remove_copy(&data, &draft_id, &component_id, FileRoot::Engine, &file.path);
        listing::prune_draft_listings(&data, &draft);
    }
    Ok(draft)
}

/// Puts a file of the release back the way the release ships it: takes the
/// replacement or the addition out, and the mark of removal off.
#[tauri::command]
pub fn draft_restore_engine_file(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    component_id: String,
    path: String,
) -> Result<Draft> {
    let data = state.paths()?;
    let mut dropped = None;
    let draft = edit_draft(&data, &draft_id, |draft| {
        let component = component_mut(draft, &component_id)?;
        let before = component.overlay.remove.len();
        component
            .overlay
            .remove
            .retain(|removed| !removed.eq_ignore_ascii_case(&path));
        dropped = take_file(&mut component.overlay.files, &path);
        if dropped.is_none() && component.overlay.remove.len() == before {
            return Err(AppError::NotFound(format!("{path} in the overlay of {component_id}")));
        }
        Ok(())
    })?;
    if let Some(file) = dropped {
        remove_copy(&data, &draft_id, &component_id, FileRoot::Engine, &file.path);
        listing::prune_draft_listings(&data, &draft);
    }
    Ok(draft)
}

/// What stands between the draft and a publish.
#[tauri::command]
pub fn validate_bundle_draft(state: tauri::State<'_, AppState>, draft_id: String) -> Result<DraftIssues> {
    Ok(validate(&read_draft(&state.paths()?, &draft_id)?))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// A file entry of a draft, for records built by hand.
    pub(crate) fn draft_file(root: FileRoot, path: &str, body: &[u8], origin: DraftOrigin) -> DraftFile {
        DraftFile {
            root,
            path: path.into(),
            size: body.len() as u64,
            sha256: crate::bundles::test_support::sha256_hex(body),
            kind: FileKind::of_path(path),
            library: None,
            listing: None,
            origin,
        }
    }

    /// Writes a file of a draft into its `files\` folder and returns its
    /// entry.
    pub(crate) fn put_draft_file(
        paths: &DataPaths,
        draft_id: &str,
        scope: &str,
        root: FileRoot,
        path: &str,
        body: &[u8],
        origin: DraftOrigin,
    ) -> DraftFile {
        let target = file_path(paths, draft_id, scope, root, path).expect("a draft path");
        fs::create_dir_all(target.parent().unwrap()).expect("the folder");
        fs::write(&target, body).expect("the file");
        draft_file(root, path, body, origin)
    }

    /// An empty draft record on disk.
    pub(crate) fn empty_draft(paths: &DataPaths, game: Game, name: &str) -> Draft {
        let draft = new_draft(game, name, DEFAULT_LANGUAGE);
        write_draft(paths, &draft).expect("the draft is written");
        draft
    }

    /// A component with nothing in it.
    pub(crate) fn component(id: &str, label: &str, engine_id: &str, modes: &[LaunchMode]) -> DraftComponent {
        DraftComponent {
            id: id.into(),
            label: label.into(),
            engine_id: engine_id.into(),
            release_tag: None,
            modes: modes.to_vec(),
            fs_game: None,
            launch_args: String::new(),
            overlay: DraftOverlay::default(),
            files: Vec::new(),
            configs: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::test_support::{component, draft_file, empty_draft};
    use super::*;
    use crate::bundles::test_support::sha256_hex;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        fs::create_dir_all(path.parent().expect("a parent")).expect("the parent folder");
        let file = fs::File::create(path).expect("the archive is created");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, body) in entries {
            writer.start_file(*name, options).expect("an entry starts");
            writer.write_all(body).expect("the entry is written");
        }
        writer.finish().expect("the archive is closed");
    }

    fn write(path: &Path, body: &[u8]) {
        fs::create_dir_all(path.parent().expect("a parent")).expect("the parent folder");
        fs::write(path, body).expect("the file is written");
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(future)
    }

    #[test]
    fn a_draft_is_written_whole_and_read_back_in_camel_case() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let mut draft = empty_draft(&paths, Game::JediAcademy, "  RUJKA  ");
        assert_eq!(draft.name, "RUJKA");
        check_draft_id(&draft.id).expect("the id is a folder name");

        let mut sp = component("sp", "Single player", "openjk", &[LaunchMode::Single]);
        sp.files.push(draft_file(
            FileRoot::Home,
            "base/autoexec_sp.cfg",
            b"seta x 1",
            DraftOrigin::Disk {
                source_path: "D:/x/autoexec_sp.cfg".into(),
            },
        ));
        sp.overlay.files.push(draft_file(
            FileRoot::Engine,
            "openjk_sp.x86.exe",
            b"MZ",
            DraftOrigin::Release {
                sha256: "9".repeat(64),
                size: 10,
            },
        ));
        sp.overlay.remove.push("rd-vulkan_x86.dll".into());
        draft.components.push(sp);
        draft.shared.files.push(draft_file(
            FileRoot::Home,
            "base/rus_sp.pk3",
            b"pk3",
            DraftOrigin::Jkhub {
                file_id: 1201,
                version: Some("3".into()),
                title: Some("RUS".into()),
                url: None,
                sha256: "c".repeat(64),
            },
        ));
        draft.shared.configs.push(DraftConfig {
            name: "Binds".into(),
            text: "bind x +attack\n".into(),
            priority: 0,
            source_config_id: Some("binds".into()),
        });
        write_draft(&paths, &draft).expect("written");

        let text = fs::read_to_string(record_path(&paths, &draft.id)).expect("the record");
        assert!(text.contains("\"versionLabel\""), "{text}");
        assert!(text.contains("\"releaseTag\": null"), "{text}");
        assert!(text.contains("\"kind\": \"release\""), "{text}");
        assert!(text.contains("\"sourcePath\""), "{text}");
        assert!(text.contains("\"fileId\": 1201"), "{text}");
        assert!(text.contains("\"sourceConfigId\": \"binds\""), "{text}");
        assert!(text.contains("\"modes\": [\n        \"single\"\n      ]"), "{text}");
        let back = read_draft(&paths, &draft.id).expect("it reads back");
        assert_eq!(back, draft);

        // No temporary file survives the write, and a later write replaces
        // the record in one step: the temporary file goes by rename.
        let entries: Vec<String> = fs::read_dir(paths.bundle_draft_dir(&draft.id))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["draft.json"]);
        let edited = edit_draft(&paths, &draft.id, |draft| {
            draft.name = "RUJKA v3".into();
            Ok(())
        })
        .expect("edited");
        assert_eq!(edited.name, "RUJKA v3");
        assert!(edited.updated_at >= draft.updated_at);
        let entries: Vec<String> = fs::read_dir(paths.bundle_draft_dir(&draft.id))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["draft.json"]);
        // An edit that fails leaves the record as it was.
        let error = edit_draft(&paths, &draft.id, |draft| {
            draft.name = "lost".into();
            Err(AppError::InvalidInput("no".into()))
        })
        .expect_err("refused");
        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(read_draft(&paths, &draft.id).unwrap().name, "RUJKA v3");

        // The list, and an id that is not a draft.
        let summaries: Vec<DraftSummary> = read_all(&paths).unwrap().iter().map(Draft::summary).collect();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].component_count, 1);
        assert_eq!(summaries[0].file_count, 3);
        assert_eq!(summaries[0].blob_bytes, 8 + 2 + 3, "the JKHub file changed, so it uploads too");
        assert!(matches!(read_draft(&paths, "../x").unwrap_err(), AppError::InvalidInput(_)));
        assert!(matches!(read_draft(&paths, "ghost").unwrap_err(), AppError::NotFound(_)));
    }

    #[test]
    fn the_source_of_a_file_follows_its_origin() {
        let jkhub_hash = sha256_hex(b"japro");
        let unchanged = draft_file(
            FileRoot::Home,
            "base/japro.pk3",
            b"japro",
            DraftOrigin::Jkhub {
                file_id: 3937,
                version: Some("1.6.5".into()),
                title: Some("JAPro".into()),
                url: Some("https://jkhub.org/files/file/3937-japro/".into()),
                sha256: jkhub_hash.clone(),
            },
        );
        let (source, origin) = unchanged.source();
        assert_eq!(
            source,
            ManifestSource::Jkhub {
                file_id: 3937,
                version: Some("1.6.5".into()),
                title: Some("JAPro".into()),
                url: Some("https://jkhub.org/files/file/3937-japro/".into()),
            }
        );
        assert_eq!(origin, None);
        assert!(!unchanged.is_blob());

        let changed = draft_file(
            FileRoot::Home,
            "base/japro.pk3",
            b"japro edited",
            DraftOrigin::Jkhub {
                file_id: 3937,
                version: None,
                title: None,
                url: None,
                sha256: jkhub_hash.clone(),
            },
        );
        let (source, origin) = changed.source();
        assert_eq!(source, ManifestSource::Blob);
        assert_eq!(
            origin,
            Some(FileOrigin::Jkhub {
                file_id: 3937,
                sha256: jkhub_hash,
                modified: true
            })
        );

        let provenance = Provenance {
            source: "jkhub".into(),
            file_id: 42,
            version: Some("2".into()),
            updated_at: None,
            installed_at: "2026-09-15T00:00:00Z".into(),
            title: "Skin".into(),
            url: String::new(),
        };
        let from_client = draft_file(
            FileRoot::Home,
            "base/skin.pk3",
            b"skin",
            DraftOrigin::Client {
                client_id: "voip".into(),
                item_id: "base/skin.pk3".into(),
                provenance: Some(provenance),
            },
        );
        let (source, origin) = from_client.source();
        assert_eq!(
            source,
            ManifestSource::Jkhub {
                file_id: 42,
                version: Some("2".into()),
                title: Some("Skin".into()),
                url: None,
            }
        );
        assert_eq!(origin, None);
        let plain = draft_file(
            FileRoot::Home,
            "base/skin.pk3",
            b"skin",
            DraftOrigin::Client {
                client_id: "voip".into(),
                item_id: "base/skin.pk3".into(),
                provenance: None,
            },
        );
        assert_eq!(plain.source(), (ManifestSource::Blob, None));
        let disk = draft_file(
            FileRoot::Home,
            "base/x.cfg",
            b"x",
            DraftOrigin::Disk {
                source_path: "D:/x.cfg".into(),
            },
        );
        assert!(disk.is_blob());

        let replaced = draft_file(
            FileRoot::Engine,
            "taystjk.x86.exe",
            b"MZ custom",
            DraftOrigin::Release {
                sha256: "9".repeat(64),
                size: 10,
            },
        );
        let entry = replaced.manifest_file();
        assert_eq!(entry.source, ManifestSource::Blob);
        assert_eq!(
            entry.replaces,
            Some(manifest::ReplacedFile {
                sha256: "9".repeat(64),
                size: 10
            })
        );
        assert_eq!(entry.kind, FileKind::Exe);
        assert_eq!(disk.manifest_file().replaces, None);
    }

    #[test]
    fn component_ids_are_slugs_of_labels_and_never_collide() {
        assert_eq!(component_id("Multiplayer", &[]), "multiplayer");
        assert_eq!(component_id("Single player", &[]), "single-player");
        assert_eq!(component_id("  jaMME (demos) ", &[]), "jamme-demos");
        assert_eq!(component_id("Мультиплеер", &[]), "component");
        assert_eq!(component_id("Shared", &[]), "component", "never the other scope");
        assert_eq!(
            component_id("Multiplayer", &["multiplayer".into(), "multiplayer-2".into()]),
            "multiplayer-3"
        );
        let long = component_id(&"x".repeat(50), &[]);
        assert_eq!(long.len(), manifest::MAX_ID);
        let long_again = component_id(&"x".repeat(50), std::slice::from_ref(&long));
        assert!(long_again.len() <= manifest::MAX_ID, "{long_again}");
        assert!(long_again.ends_with("-2"));
        manifest::check_component_id(&long_again).expect("a valid id");
    }

    #[test]
    fn the_fields_of_a_bundle_are_patched_by_the_rules_of_the_service() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let draft = empty_draft(&paths, Game::JediAcademy, "x");

        let patch: DraftPatch = serde_json::from_str(
            r#"{"name":" RUJKA ","summary":"s","tags":["VoIP","duel"],"website":"https://example.com/x",
                "discord":"https://discord.gg/abc","versionLabel":"3","changelog":"c"}"#,
        )
        .unwrap();
        let edited = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(edited.name, "RUJKA");
        assert_eq!(edited.tags, ["voip", "duel"]);
        assert_eq!(edited.website.as_deref(), Some("https://example.com/x"));
        assert_eq!(edited.version_label, "3");
        assert_eq!(edited.description, "", "a field left out keeps its value");

        // `null` clears a link, absent keeps it.
        let clear: DraftPatch = serde_json::from_str(r#"{"website":null}"#).unwrap();
        let edited = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, clear)).unwrap();
        assert_eq!(edited.website, None);
        assert_eq!(edited.discord.as_deref(), Some("https://discord.gg/abc"));

        for bad in [
            r#"{"summary":"x"}"#.replace('x', &"y".repeat(SUMMARY_MAX + 1)),
            r#"{"tags":["VoIP!"]}"#.to_string(),
            r#"{"website":"http://example.com"}"#.to_string(),
            r#"{"discord":"https://example.com/discord"}"#.to_string(),
            r#"{"versionLabel":"x"}"#.replace('x', &"y".repeat(LABEL_MAX + 1)),
            r#"{"name":"x"}"#.replace('x', &"y".repeat(NAME_MAX + 1)),
        ] {
            let patch: DraftPatch = serde_json::from_str(&bad).unwrap();
            let error = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).expect_err(&bad);
            assert!(matches!(error, AppError::InvalidInput(_)), "{bad}: {error}");
        }
        // A short name is stored and reported by the validation, not refused.
        let patch: DraftPatch = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        let edited = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(edited.name, "x");
        let issues = validate(&edited);
        assert!(issues.errors.iter().any(|issue| issue.code == ISSUE_NAME_INVALID));

        // A description over the limit of the service is kept and reported;
        // one over the hard limit is refused.
        let long = "x".repeat(DESCRIPTION_MAX + 1);
        let patch: DraftPatch = serde_json::from_str(&format!(r#"{{"description":"{long}"}}"#)).unwrap();
        let edited = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(edited.description.len(), DESCRIPTION_MAX + 1);
        let issues = validate(&edited);
        let too_long = issues
            .errors
            .iter()
            .find(|issue| issue.code == ISSUE_DESCRIPTION_TOO_LONG)
            .expect("reported");
        assert_eq!(too_long.count, Some(DESCRIPTION_MAX as u64 + 1));
        let huge = "x".repeat(DESCRIPTION_HARD_MAX + 1);
        let patch: DraftPatch = serde_json::from_str(&format!(r#"{{"description":"{huge}"}}"#)).unwrap();
        let error = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).expect_err("refused");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        // A description of Cyrillic text is measured in bytes, as the
        // service measures it: 16 385 letters of two bytes are over.
        let cyrillic = "ю".repeat(DESCRIPTION_MAX / 2 + 1);
        let patch: DraftPatch = serde_json::from_str(&format!(r#"{{"description":"{cyrillic}"}}"#)).unwrap();
        let edited = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert!(validate(&edited).errors.iter().any(|issue| issue.code == ISSUE_DESCRIPTION_TOO_LONG));
    }

    #[test]
    fn the_pictures_of_a_description_are_checked_against_the_draft() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "eternaljk", &[LaunchMode::Multiplayer]));
        draft.components[0].configs.push(DraftConfig {
            name: "Binds".into(),
            text: "bind x +attack\n".into(),
            priority: 0,
            source_config_id: None,
        });
        let shown = "a".repeat(64);
        let gone = "b".repeat(64);
        let spare = "c".repeat(64);
        let picture = |sha256: &str, name: &str| DraftImage {
            sha256: sha256.to_string(),
            size: 10,
            content_type: "image/png".into(),
            file_name: name.into(),
        };
        draft.images.push(picture(&shown, "shot.png"));
        draft.images.push(picture(&spare, "spare.png"));
        draft.description = format!("# RUJKA\n\n![shot](blob:{shown})\n\n![gone](blob:{gone})\n");

        let issues = validate(&draft);
        let errors: Vec<(&str, Option<&str>)> = issues
            .errors
            .iter()
            .map(|issue| (issue.code.as_str(), issue.path.as_deref()))
            .collect();
        assert_eq!(errors, [(ISSUE_IMAGE_MISSING, Some(gone.as_str()))]);
        let warnings: Vec<(&str, Option<u64>)> = issues
            .warnings
            .iter()
            .map(|issue| (issue.code.as_str(), issue.count))
            .collect();
        assert_eq!(warnings, [(ISSUE_UNUSED_IMAGES, Some(1))]);
        let json = serde_json::to_value(&issues).unwrap();
        assert_eq!(json["errors"][0]["path"], gone);
        assert!(json["errors"][0].get("scope").is_none());

        // The reference put back, the spare picture taken out: clean.
        draft.description = format!("![shot](blob:{shown})");
        draft.images.retain(|image| image.sha256 == shown);
        let issues = validate(&draft);
        assert!(issues.errors.is_empty(), "{:?}", issues.errors);
        assert!(issues.warnings.is_empty(), "{:?}", issues.warnings);

        // A record of the second edition reads with no pictures, in English
        // and without translations.
        let text = r#"{"id":"old","game":"ja","createdAt":"2026-09-15T00:00:00Z","updatedAt":"2026-09-15T00:00:00Z","name":"Old"}"#;
        let old: Draft = serde_json::from_str(text).expect("an old record parses");
        assert!(old.images.is_empty());
        assert_eq!(old.language, "en");
        assert!(old.translations.is_empty());
    }

    #[test]
    fn a_draft_starts_in_the_language_of_the_interface_and_swaps_its_fields_with_a_translation() {
        // The language a draft starts in: the setting when it names a
        // catalog, English while it follows the system.
        let mut settings = Settings::default();
        assert_eq!(initial_language(&settings), "en");
        settings.language = "ru".into();
        assert_eq!(initial_language(&settings), "ru");
        settings.language = "system".into();
        assert_eq!(initial_language(&settings), "en");

        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        assert_eq!(draft.language, "en");

        // The translations, replaced whole and trimmed the way the main
        // fields are; the record spells both fields in camelCase.
        let patch: DraftPatch = serde_json::from_str(
            r##"{"summary":"Russian edition","description":"# RUJKA",
                 "translations":{"ru":{"name":" Русская сборка ","summary":"Русское издание","description":" # Русская сборка "},
                                 "uk":{"name":"","summary":"Українське видання","description":""}}}"##,
        )
        .unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(draft.translations.len(), 2);
        assert_eq!(draft.translations["ru"].name, "Русская сборка");
        assert_eq!(draft.translations["ru"].description, "# Русская сборка");
        assert_eq!(draft.translations["uk"].name, "", "an empty field stays empty: not translated");
        let text = fs::read_to_string(record_path(&paths, &draft.id)).unwrap();
        assert!(text.contains("\"language\": \"en\""), "{text}");
        assert!(text.contains("\"translations\": {"), "{text}");
        let back = read_draft(&paths, &draft.id).unwrap();
        assert_eq!(back, draft);

        // Default language set to a translated one: the fields swap.
        let patch: DraftPatch = serde_json::from_str(r#"{"language":"ru"}"#).unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(draft.language, "ru");
        assert_eq!(draft.name, "Русская сборка");
        assert_eq!(draft.summary, "Русское издание");
        assert_eq!(draft.description, "# Русская сборка");
        assert_eq!(
            draft.translations.keys().map(String::as_str).collect::<Vec<_>>(),
            ["en", "uk"]
        );
        assert_eq!(draft.translations["en"].name, "RUJKA");
        assert_eq!(draft.translations["en"].summary, "Russian edition");
        assert_eq!(draft.translations["en"].description, "# RUJKA");
        assert_eq!(draft.summary().name, "Русская сборка", "the list shows the main name");
        // And back again.
        let patch: DraftPatch = serde_json::from_str(r#"{"language":"en"}"#).unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(draft.language, "en");
        assert_eq!(draft.name, "RUJKA");
        assert_eq!(draft.translations["ru"].name, "Русская сборка");
        assert!(!draft.translations.contains_key("en"));
        // The same language again changes nothing.
        let patch: DraftPatch = serde_json::from_str(r#"{"language":"en"}"#).unwrap();
        let same = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!((same.language.as_str(), &same.name, &same.translations), ("en", &draft.name, &draft.translations));
        // A language without a translation relabels the fields.
        let patch: DraftPatch = serde_json::from_str(r#"{"language":"de"}"#).unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(draft.language, "de");
        assert_eq!(draft.name, "RUJKA");
        assert_eq!(draft.translations.len(), 2, "no translation appears out of nothing");
        assert!(!draft.translations.contains_key("en"));

        // A patch with both fields describes the new state whole: the
        // language goes first, the translations are checked against it.
        let patch: DraftPatch = serde_json::from_str(
            r#"{"language":"ru","translations":{"en":{"name":"RUJKA","summary":"","description":""}}}"#,
        )
        .unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(draft.language, "ru");
        assert_eq!(draft.name, "Русская сборка", "the swap came first");
        assert_eq!(
            draft.translations.keys().map(String::as_str).collect::<Vec<_>>(),
            ["en"],
            "then the replacement"
        );
        // Fields of the main language in the same patch are edited before
        // the swap: they describe what the author was looking at.
        let patch: DraftPatch =
            serde_json::from_str(r#"{"name":"RUJKA Edition","language":"en"}"#).unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(draft.language, "en");
        assert_eq!(draft.name, "RUJKA");
        assert_eq!(draft.translations["ru"].name, "RUJKA Edition");

        // What the service would refuse is refused here.
        let all_eight = LANGUAGES
            .iter()
            .map(|code| format!(r#"{code:?}:{{"name":"x","summary":"","description":""}}"#))
            .collect::<Vec<_>>()
            .join(",");
        for (bad, why) in [
            (r#"{"language":"xx"}"#.to_string(), "an unknown code"),
            (r#"{"language":"system"}"#.to_string(), "the system setting is not a language"),
            (r#"{"language":"EN"}"#.to_string(), "codes are spelled as the folders are"),
            (r#"{"language":""}"#.to_string(), "an empty code"),
            (r#"{"translations":{"en":{"name":"x"}}}"#.to_string(), "the main language"),
            (r#"{"translations":{"xx":{"name":"x"}}}"#.to_string(), "an unknown code"),
            (r#"{"translations":{" ru":{"name":"x"},"ru":{"name":"y"}}}"#.to_string(), "the same code twice"),
            (format!(r#"{{"translations":{{{all_eight}}}}}"#), "more than seven"),
            (
                r#"{"translations":{"ru":{"name":"x"}}}"#.replace('x', &"y".repeat(NAME_MAX + 1)),
                "a long name",
            ),
            (
                r#"{"translations":{"ru":{"summary":"x"}}}"#.replace('x', &"y".repeat(SUMMARY_MAX + 1)),
                "a long summary",
            ),
            (
                r#"{"translations":{"ru":{"description":"x"}}}"#.replace('x', &"y".repeat(DESCRIPTION_HARD_MAX + 1)),
                "a huge description",
            ),
            (
                r#"{"language":"ru","translations":{"ru":{"name":"x"}}}"#.to_string(),
                "the new main language among the translations",
            ),
        ] {
            let patch: DraftPatch = serde_json::from_str(&bad).unwrap_or_else(|e| panic!("{why}: {e}"));
            let error = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).expect_err(why);
            assert!(matches!(error, AppError::InvalidInput(_)), "{why}: {error}");
        }
        // A refused patch leaves the record as it was.
        assert_eq!(read_draft(&paths, &draft.id).unwrap(), draft);
        // Seven translations are the most, and every code of the launcher
        // but the main one fits.
        let seven = LANGUAGES
            .iter()
            .filter(|code| **code != "en")
            .map(|code| format!(r#"{code:?}:{{"name":"","summary":"","description":""}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let patch: DraftPatch = serde_json::from_str(&format!(r#"{{"translations":{{{seven}}}}}"#)).unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert_eq!(draft.translations.len(), MAX_TRANSLATIONS);
        // An empty object clears them.
        let patch: DraftPatch = serde_json::from_str(r#"{"translations":{}}"#).unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| apply_patch(draft, patch)).unwrap();
        assert!(draft.translations.is_empty());
    }

    #[test]
    fn the_fields_and_pictures_of_a_translation_are_checked_like_the_main_ones() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "eternaljk", &[LaunchMode::Multiplayer]));
        draft.components[0].configs.push(DraftConfig {
            name: "Binds".into(),
            text: "bind x +attack\n".into(),
            priority: 0,
            source_config_id: None,
        });
        let shown = "a".repeat(64);
        let translated_only = "b".repeat(64);
        let gone = "c".repeat(64);
        let spare = "d".repeat(64);
        let picture = |sha256: &str, size: u64| DraftImage {
            sha256: sha256.to_string(),
            size,
            content_type: "image/png".into(),
            file_name: format!("{}.png", &sha256[..4]),
        };
        draft.images.push(picture(&shown, 10));
        draft.images.push(picture(&translated_only, 20));
        draft.images.push(picture(&spare, 40));
        draft.description = format!("![shot](blob:{shown})");
        draft.translations.insert(
            "ru".into(),
            DraftTranslation {
                name: "Р".into(),
                summary: String::new(),
                description: format!("![кадр](blob:{translated_only})\n\n![нет](blob:{gone})"),
            },
        );
        draft.translations.insert(
            "uk".into(),
            DraftTranslation {
                name: String::new(),
                summary: "Українське видання".into(),
                description: "x".repeat(DESCRIPTION_MAX + 1),
            },
        );

        // The pictures of every description count, each once.
        assert_eq!(draft.image_refs(), [shown.clone(), translated_only.clone(), gone.clone()]);
        assert_eq!(draft.image_bytes(), 10 + 20, "a picture only a translation names is uploaded too");
        assert_eq!(
            draft.descriptions().map(|(code, _)| code).collect::<Vec<_>>(),
            ["en", "ru", "uk"]
        );

        let issues = validate(&draft);
        /// A finding as the assertions below spell it: code, language, path, count.
        type Finding<'a> = (&'a str, Option<&'a str>, Option<&'a str>, Option<u64>);
        let errors: Vec<Finding<'_>> = issues
            .errors
            .iter()
            .map(|issue| (issue.code.as_str(), issue.language.as_deref(), issue.path.as_deref(), issue.count))
            .collect();
        assert_eq!(
            errors,
            [
                (ISSUE_NAME_INVALID, Some("ru"), None, None),
                (ISSUE_DESCRIPTION_TOO_LONG, Some("uk"), None, Some(DESCRIPTION_MAX as u64 + 1)),
                (ISSUE_IMAGE_MISSING, Some("ru"), Some(gone.as_str()), None),
            ],
            "an empty translated name is not a short one"
        );
        let warnings: Vec<(&str, Option<u64>)> = issues
            .warnings
            .iter()
            .map(|issue| (issue.code.as_str(), issue.count))
            .collect();
        assert_eq!(warnings, [(ISSUE_UNUSED_IMAGES, Some(1))], "only the spare picture is unused");
        assert_eq!(issues.blob_bytes, 10 + 20);
        let json = serde_json::to_value(&issues).unwrap();
        assert_eq!(json["errors"][0]["language"], "ru");
        assert_eq!(json["errors"][2]["path"], gone);
        assert!(json["errors"][0].get("scope").is_none());

        // The same picture gone from the main description is reported for
        // the main language, without a language on the finding.
        draft.description = format!("![shot](blob:{shown}) ![gone](blob:{gone})");
        let issues = validate(&draft);
        let missing: Vec<(Option<&str>, &str)> = issues
            .errors
            .iter()
            .filter(|issue| issue.code == ISSUE_IMAGE_MISSING)
            .map(|issue| (issue.language.as_deref(), issue.path.as_deref().unwrap()))
            .collect();
        assert_eq!(missing, [(None, gone.as_str()), (Some("ru"), gone.as_str())]);
        let json = serde_json::to_value(&issues).unwrap();
        let main = json["errors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["code"] == ISSUE_IMAGE_MISSING)
            .unwrap();
        assert!(main.get("language").is_none(), "{main}");

        // Translations that pass leave no finding of their own.
        draft.description = format!("![shot](blob:{shown})");
        draft.translations.get_mut("ru").unwrap().name = "Русская сборка".into();
        draft.translations.get_mut("ru").unwrap().description = format!("![кадр](blob:{translated_only})");
        draft.translations.get_mut("uk").unwrap().description = String::new();
        draft.images.retain(|image| image.sha256 != spare);
        let issues = validate(&draft);
        assert!(issues.errors.is_empty(), "{:?}", issues.errors);
        assert!(issues.warnings.is_empty(), "{:?}", issues.warnings);
    }

    #[test]
    fn a_draft_out_of_a_bundle_takes_its_language_and_its_translations() {
        let mut card = BundleCard {
            id: "01J".into(),
            name: "RUJKA".into(),
            language: "ru".into(),
            ..BundleCard::default()
        };
        card.translations.insert(
            "en".into(),
            Translation {
                name: "RUJKA".into(),
                summary: "Russian edition".into(),
                description: Some("# RUJKA".into()),
            },
        );
        card.translations.insert(
            "uk".into(),
            Translation {
                name: String::new(),
                summary: "Українське видання".into(),
                description: None,
            },
        );
        // What the service must never send, and what this build cannot
        // hold: the main language among the translations, a code without a
        // catalog.
        card.translations.insert("ru".into(), Translation::default());
        card.translations.insert("xx".into(), Translation::default());
        let language = language_of_bundle(&card);
        assert_eq!(language, "ru");
        let translations = translations_of_bundle(&card, &language);
        assert_eq!(translations.keys().map(String::as_str).collect::<Vec<_>>(), ["en", "uk"]);
        assert_eq!(translations["en"].description, "# RUJKA");
        assert_eq!(translations["uk"].description, "", "a description left out reads as empty");
        assert_eq!(translations["uk"].summary, "Українське видання");
        // A language this build does not know falls back to English, and
        // an English translation then makes no sense, while the Russian one
        // is a translation again.
        card.language = "xx".into();
        let language = language_of_bundle(&card);
        assert_eq!(language, "en");
        assert_eq!(
            translations_of_bundle(&card, &language).keys().map(String::as_str).collect::<Vec<_>>(),
            ["ru", "uk"]
        );
        // The round trip through the contract keeps the fields.
        let entry = DraftTranslation {
            name: " Русская сборка ".into(),
            summary: "".into(),
            description: " # Русская сборка ".into(),
        };
        let contract = entry.to_contract();
        assert_eq!(contract.name, "Русская сборка");
        assert_eq!(contract.description.as_deref(), Some("# Русская сборка"));
        assert_eq!(DraftTranslation::from_contract(&contract).description, "# Русская сборка");
    }

    #[test]
    fn the_bytes_of_a_draft_count_its_listings_and_the_pictures_of_the_description() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "eternaljk", &[LaunchMode::Multiplayer]));
        let disk = |path: &str| DraftOrigin::Disk {
            source_path: path.into(),
        };
        let listing = |size: u64| ListingRef {
            sha256: sha256_hex(&size.to_le_bytes()),
            size,
        };
        // A pk3 of the store with a listing, a config, and a pk3 of JKHub
        // whose listing goes to the store all the same.
        draft.components[0].files.push(DraftFile {
            listing: Some(listing(100)),
            ..draft_file(FileRoot::Home, "base/x.pk3", b"xxxxxxxx", disk("a"))
        });
        draft.components[0].files.push(draft_file(FileRoot::Home, "base/autoexec.cfg", b"cfg", disk("b")));
        draft.shared.files.push(DraftFile {
            listing: Some(listing(1000)),
            ..draft_file(
                FileRoot::Home,
                "base/japro.pk3",
                b"japro",
                DraftOrigin::Jkhub {
                    file_id: 1,
                    version: None,
                    title: None,
                    url: None,
                    sha256: sha256_hex(b"japro"),
                },
            )
        });
        // Two pictures, one of them in the description.
        let shown = "a".repeat(64);
        let spare = "b".repeat(64);
        for (sha256, size) in [(&shown, 10_000u64), (&spare, 20_000)] {
            draft.images.push(DraftImage {
                sha256: sha256.clone(),
                size,
                content_type: "image/png".into(),
                file_name: format!("{}.png", &sha256[..4]),
            });
        }
        draft.description = format!("![shot](blob:{})", shown.to_ascii_uppercase());

        assert_eq!(draft.version_bytes(), 8 + 3 + 100 + 1000, "files of the store and every listing");
        assert_eq!(draft.image_bytes(), 10_000, "the picture the description names, in either case");
        assert_eq!(draft.blob_bytes(), 8 + 3 + 100 + 1000 + 10_000);
        assert_eq!(draft.summary().blob_bytes, draft.blob_bytes());
        let issues = validate(&draft);
        assert_eq!(issues.blob_bytes, draft.blob_bytes());
        assert_eq!(issues.jkhub_bytes, 5);
        assert!(issues.errors.is_empty(), "{:?}", issues.errors);
        let unused: Vec<&str> = issues.warnings.iter().map(|issue| issue.code.as_str()).collect();
        assert_eq!(unused, [ISSUE_UNUSED_IMAGES]);

        // The limit of a version weighs the files and the listings the way
        // the service does: a listing tips it, a picture does not. Four
        // files of the size one file may be fill a version to the byte.
        for name in ["y1", "y2", "y3"] {
            draft.components[0].files.push(DraftFile {
                size: MAX_FILE_BYTES,
                ..draft_file(FileRoot::Home, &format!("base/{name}.pk3"), name.as_bytes(), disk(name))
            });
        }
        draft.components[0].files[0].size = MAX_FILE_BYTES - 100 - 3 - 1000;
        assert_eq!(draft.version_bytes(), MAX_VERSION_BYTES);
        assert!(validate(&draft).errors.is_empty(), "at the limit is allowed");
        draft.components[0].files[0].listing = Some(listing(200));
        let issues = validate(&draft);
        let codes: Vec<(&str, Option<u64>)> = issues.errors.iter().map(|issue| (issue.code.as_str(), issue.count)).collect();
        assert_eq!(codes, [(ISSUE_TOO_LARGE, Some(MAX_VERSION_BYTES + 100))]);
        draft.components[0].files[0].listing = Some(listing(100));
        draft.images[0].size = 2 * 1024 * 1024;
        let issues = validate(&draft);
        assert!(issues.errors.is_empty(), "{:?}", issues.errors);
        assert_eq!(issues.blob_bytes, MAX_VERSION_BYTES + 2 * 1024 * 1024);

        // The manifest out of the draft sums the same store bytes, listings
        // of JKHub files included, and its own check weighs them too.
        let manifest = manifest_of(&draft);
        assert_eq!(manifest.blob_bytes(), MAX_VERSION_BYTES);
        assert_eq!(manifest.shared.files[0].listing.as_ref().map(|l| l.size), Some(1000));
        manifest::validate(&manifest).expect("at the limit is allowed");
        draft.components[0].files[0].listing = Some(listing(101));
        let error = manifest::validate(&manifest_of(&draft)).expect_err("over the limit");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
    }

    #[test]
    fn every_spelling_of_a_password_cvar_is_stripped_and_nothing_else_is() {
        let text = "seta rconPassword \"x\"\nset g_password x\nsv_privatePassword \"y\"\nseta rate 1; seta cl_password z\nbind x \"say password\"\nseta name \"pass word\"\n// password comment\n";
        let (kept, stripped) = strip_passwords(text);
        assert_eq!(stripped, 4);
        assert_eq!(kept, "bind x \"say password\"\nseta name \"pass word\"\n// password comment\n");
        let (kept, stripped) = strip_passwords("seta rate 1\nseta password x");
        assert_eq!((kept.as_str(), stripped), ("seta rate 1\n", 1));
        assert_eq!(strip_passwords(""), (String::new(), 0));
    }

    #[test]
    fn retail_archives_are_recognised_by_name() {
        assert!(is_game_asset("assets0.pk3"));
        assert!(is_game_asset("Assets3.PK3"));
        assert!(is_game_asset("assets.pk3"));
        assert!(!is_game_asset("assetsmv.pk3"), "JK2MV's own archive is the engine's");
        assert!(!is_game_asset("my_assets0.pk3"));
    }

    #[test]
    fn a_draft_reports_what_stops_a_publish_and_what_the_author_should_know() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let mut draft = empty_draft(&paths, Game::JediAcademy, "x");
        let issues = validate(&draft);
        let codes: Vec<&str> = issues.errors.iter().map(|issue| issue.code.as_str()).collect();
        assert_eq!(codes, [ISSUE_NAME_INVALID, ISSUE_NO_COMPONENTS]);
        assert!(issues.warnings.is_empty());

        draft.name = "RUJKA".into();
        draft.components.push(component("mp", "Multiplayer", "eternaljk", &[LaunchMode::Multiplayer]));
        let issues = validate(&draft);
        assert_eq!(
            issues.errors.iter().map(|i| i.code.as_str()).collect::<Vec<_>>(),
            [ISSUE_EMPTY_BUNDLE]
        );

        // An engine of the other game, a wrong engine, no mode, no engine.
        draft.components.push(component("mv", "JK2MV", "jk2mv", &[LaunchMode::Multiplayer]));
        draft.components.push(component("q3", "Quake", "quake3", &[LaunchMode::Multiplayer]));
        draft.components.push(component("sp", "SP", "eternaljk", &[LaunchMode::Single]));
        draft.components.push(component("none", "None", "", &[LaunchMode::Multiplayer]));
        let issues = validate(&draft);
        let by_scope: Vec<(Option<&str>, &str)> = issues
            .errors
            .iter()
            .map(|i| (i.scope.as_deref(), i.code.as_str()))
            .collect();
        assert!(by_scope.contains(&(Some("mv"), ISSUE_ENGINE_UNKNOWN)), "{by_scope:?}");
        assert!(by_scope.contains(&(Some("q3"), ISSUE_ENGINE_UNKNOWN)));
        assert!(by_scope.contains(&(Some("sp"), ISSUE_NO_MODES)));
        assert!(by_scope.contains(&(Some("none"), ISSUE_NO_ENGINE)));
        draft.components.truncate(1);

        // Files: duplicates inside a component, against shared, a big one,
        // executables, passwords, a long config.
        let mp = &mut draft.components[0];
        let disk = |path: &str| DraftOrigin::Disk {
            source_path: path.into(),
        };
        mp.overlay.files.push(draft_file(FileRoot::Engine, "eternaljk.x86.exe", b"MZ", disk("a")));
        mp.overlay.files.push(draft_file(FileRoot::Engine, "EternalJK.x86.exe", b"MZ2", disk("b")));
        mp.files.push(draft_file(FileRoot::Home, "base/x.pk3", b"x", disk("c")));
        mp.files.push(draft_file(FileRoot::Home, "base/y.pk3", b"y", disk("d")));
        mp.files.push(DraftFile {
            size: MAX_FILE_BYTES + 1,
            ..draft_file(FileRoot::Home, "base/big.pk3", b"big", disk("e"))
        });
        mp.configs.push(DraftConfig {
            name: "Binds".into(),
            text: "seta rconPassword x\nseta g_password y\nbind x +attack\n".into(),
            priority: 0,
            source_config_id: None,
        });
        draft.shared.files.push(draft_file(FileRoot::Home, "base/Y.pk3", b"y", disk("f")));
        draft.shared.files.push(draft_file(
            FileRoot::Home,
            "base/japro.pk3",
            b"japro",
            DraftOrigin::Jkhub {
                file_id: 1,
                version: None,
                title: None,
                url: None,
                sha256: sha256_hex(b"japro"),
            },
        ));
        draft.shared.configs.push(DraftConfig {
            name: "Long".into(),
            text: "x".repeat(MAX_CONFIG_TEXT + 1),
            priority: 0,
            source_config_id: None,
        });
        let issues = validate(&draft);
        let errors: Vec<(Option<&str>, &str, Option<&str>)> = issues
            .errors
            .iter()
            .map(|i| (i.scope.as_deref(), i.code.as_str(), i.path.as_deref()))
            .collect();
        assert!(errors.contains(&(Some("mp"), ISSUE_DUPLICATE_PATH, Some("EternalJK.x86.exe"))), "{errors:?}");
        assert!(errors.contains(&(Some("mp"), ISSUE_DUPLICATE_PATH, Some("base/y.pk3"))), "{errors:?}");
        assert!(errors.contains(&(Some("mp"), ISSUE_TOO_LARGE, Some("base/big.pk3"))), "{errors:?}");
        assert!(errors.contains(&(Some("shared"), ISSUE_CONFIG_TOO_LONG, None)), "{errors:?}");
        assert!(!errors.iter().any(|(_, code, _)| *code == ISSUE_EMPTY_BUNDLE));
        let warnings: Vec<(&str, Option<u64>)> = issues
            .warnings
            .iter()
            .map(|i| (i.code.as_str(), i.count))
            .collect();
        assert_eq!(
            warnings,
            [(ISSUE_EXECUTABLES_PRESENT, Some(2)), (ISSUE_PASSWORDS_STRIPPED, Some(2))]
        );
        assert_eq!(issues.executables, ["mp/eternaljk.x86.exe", "mp/EternalJK.x86.exe"]);
        assert_eq!(issues.file_count, 7);
        assert_eq!(issues.jkhub_bytes, 5);
        assert_eq!(issues.blob_bytes, 2 + 3 + 1 + 1 + (MAX_FILE_BYTES + 1) + 1);
        let json = serde_json::to_value(&issues).unwrap();
        assert_eq!(json["warnings"][1]["count"], 2);
        assert_eq!(json["blobBytes"], issues.blob_bytes);
        // A finding about a component names it twice, as the scope and as the
        // component; one about the shared files names the scope alone.
        let about_mp = json["errors"].as_array().unwrap().iter().find(|e| e["scope"] == "mp").unwrap();
        assert_eq!(about_mp["componentId"], "mp");
        let about_shared = json["errors"].as_array().unwrap().iter().find(|e| e["scope"] == "shared").unwrap();
        assert!(about_shared.get("componentId").is_none());
    }

    #[test]
    fn a_manifest_out_of_a_draft_carries_sources_replacements_and_clean_configs() {
        let mut draft = new_draft(Game::JediAcademy, "RUJKA", DEFAULT_LANGUAGE);
        let mut mp = component("mp", " Multiplayer ", "eternaljk", &[LaunchMode::Multiplayer]);
        mp.release_tag = Some("v1.6.3".into());
        mp.fs_game = Some("eternaljk".into());
        mp.launch_args = " +set cg_fov 97 ".into();
        mp.overlay.files.push(draft_file(
            FileRoot::Engine,
            "eternaljk.x86.exe",
            b"MZ custom",
            DraftOrigin::Release {
                sha256: "9".repeat(64),
                size: 10,
            },
        ));
        mp.overlay.files.push(draft_file(
            FileRoot::Engine,
            "rd-vanilla_x86.dll",
            b"renderer",
            DraftOrigin::Disk {
                source_path: "D:/rd.dll".into(),
            },
        ));
        mp.overlay.remove.push("rd-vulkan_x86.dll".into());
        mp.files.push(draft_file(
            FileRoot::Home,
            "eternaljk/japro-assets.pk3",
            b"japro",
            DraftOrigin::Jkhub {
                file_id: 3937,
                version: Some("1.6.5".into()),
                title: Some("JAPro".into()),
                url: None,
                sha256: sha256_hex(b"japro"),
            },
        ));
        mp.configs.push(DraftConfig {
            name: " RUJKA binds ".into(),
            text: "bind PGDN toggle cg_dismember 0 3\nseta rconPassword \"secret\"\n".into(),
            priority: 5,
            source_config_id: Some("binds".into()),
        });
        draft.components.push(mp);
        draft.components.push(component("sp", "Single player", "openjk", &[LaunchMode::Single]));
        draft.shared.files.push(draft_file(
            FileRoot::Home,
            "base/rus_sp.pk3",
            b"rus edited",
            DraftOrigin::Jkhub {
                file_id: 1201,
                version: None,
                title: None,
                url: None,
                sha256: sha256_hex(b"rus"),
            },
        ));

        let manifest = manifest_of(&draft);
        manifest::validate(&manifest).expect("the manifest is valid");
        assert_eq!(manifest.schema, manifest::SCHEMA);
        assert_eq!(manifest.game, "ja");
        let mp = &manifest.components[0];
        assert_eq!(mp.label, "Multiplayer");
        assert_eq!(mp.launch_args, "+set cg_fov 97");
        assert_eq!(mp.engine.release_tag.as_deref(), Some("v1.6.3"));
        assert_eq!(mp.overlay.files[0].replaces.as_ref().unwrap().size, 10);
        assert_eq!(mp.overlay.files[1].replaces, None);
        assert_eq!(mp.overlay.remove, ["rd-vulkan_x86.dll"]);
        assert!(matches!(mp.files[0].source, ManifestSource::Jkhub { file_id: 3937, .. }));
        assert_eq!(mp.configs[0].name, "RUJKA binds");
        assert_eq!(mp.configs[0].text, "bind PGDN toggle cg_dismember 0 3\n");
        assert_eq!(mp.configs[0].priority, 5);
        assert_eq!(manifest.components[1].modes, [LaunchMode::Single]);
        let shared = &manifest.shared.files[0];
        assert_eq!(shared.source, ManifestSource::Blob);
        assert_eq!(
            shared.origin,
            Some(FileOrigin::Jkhub {
                file_id: 1201,
                sha256: sha256_hex(b"rus"),
                modified: true
            })
        );
        assert!(manifest.has_executables());
        assert_eq!(manifest.blob_bytes(), 9 + 8 + 10);
    }

    /// A data root with a TaystJK client: an installed engine that differs
    /// from its release, pk3 files with and without provenance, configs and
    /// junk, plus the release archive in `cache\downloads\`.
    fn client_fixture(root: &Path) -> (DataPaths, Client, HashMap<String, ArchiveEntry>) {
        let paths = DataPaths::new(root.to_path_buf());
        paths.ensure().expect("the data layout");
        let client = Client {
            id: "voip".into(),
            name: "Taystjka VoIP".into(),
            engine_id: "taystjk".into(),
            game: Game::JediAcademy,
            engine_version: Some("v1.6.3".into()),
            created_at: "2026-09-15T00:00:00Z".into(),
            engine_installed_at: None,
            engine_published_at: None,
            fs_game: Some("taystjk".into()),
            launch_args: "+set cg_fov 97".into(),
            modes: vec![LaunchMode::Multiplayer],
            bundle: None,
        };
        clients::write_record(&paths, &client).expect("the record");

        let archive = paths.cache.join("downloads").join("taystjk-v1.6.3.zip");
        write_zip(
            &archive,
            &[
                ("TaystJK/taystjk.x86.exe", b"MZ release" as &[u8]),
                ("TaystJK/Base/cgamex86.dll", b"cgame release"),
                ("TaystJK/README.md", b"read me"),
                ("TaystJK/rd-vulkan_x86.dll", b"vulkan"),
            ],
        );
        let entries = engine_install::archive_entries(&archive).expect("the archive reads");

        let engine_dir = paths.client_engine_dir("voip");
        write(&engine_dir.join("taystjk.x86.exe"), b"MZ custom");
        write(&engine_dir.join("base").join("cgamex86.dll"), b"cgame release");
        write(&engine_dir.join("README.md"), b"read me");
        write(&engine_dir.join("rd-vanilla_x86.dll"), b"renderer");
        write(&engine_dir.join("qconsole.log"), b"log");
        // `rd-vulkan_x86.dll` of the release is gone.

        let home = paths.client_home_dir("voip");
        write_zip(&home.join("base").join("assets0.pk3"), &[("models/players/kyle/model.glm", b"retail")]);
        write_zip(
            &home.join("base").join("zz_skin.pk3"),
            &[("models/players/reborn/model.glm", b"skin"), ("models/players/reborn/icon.jpg", b"i")],
        );
        write_zip(&home.join("base").join("old_map.pk3.disabled"), &[("maps/mp/old.bsp", b"map")]);
        write_zip(
            &home.join("taystjk").join("japro-assets.pk3"),
            &[("ui/jaPRO.menu", b"menu"), ("sound/x.mp3", b"s"), ("maps/mp/duel_x.bsp", b"m")],
        );
        write_zip(&home.join("japlus").join("elsewhere.pk3"), &[("models/players/x/model.glm", b"x")]);
        write(&home.join("base").join("autoexec.cfg"), b"seta name Kyle\n");
        write(&home.join("taystjk").join("taystjk.cfg"), b"seta r_mode 4\n");
        write(&home.join("taystjk").join("jknet-active.cfg"), b"seta rate 25000\n");
        write(&home.join("taystjk").join("readme.txt"), b"hello");
        write(&home.join("taystjk").join("notes.md"), b"notes");
        write(&home.join("taystjk").join("cgamex86.dll"), b"mod module");
        write(&home.join("taystjk").join("screenshots").join("shot0001.jpg"), b"jpg");
        write(&home.join("taystjk").join("demos").join("x.dm_26"), b"demo");
        write(&home.join("taystjk").join("qconsole.log"), b"log");
        let mut provenance = BTreeMap::new();
        provenance.insert(
            "taystjk/japro-assets.pk3".to_string(),
            Provenance {
                source: "jkhub".into(),
                file_id: 3937,
                version: Some("1.6.5".into()),
                updated_at: None,
                installed_at: "2026-09-15T00:00:00Z".into(),
                title: "JAPro".into(),
                url: "https://jkhub.org/files/file/3937-japro/".into(),
            },
        );
        library::write_provenance(&paths.client_dir("voip"), &provenance).expect("provenance");
        (paths, client, entries)
    }

    #[test]
    fn a_component_out_of_a_client_takes_the_overlay_the_library_and_the_loose_files() {
        let temp = tempfile::tempdir().expect("a data root");
        let (paths, client, entries) = client_fixture(temp.path());
        let engine = engines::require("taystjk").unwrap();
        let draft = empty_draft(&paths, Game::JediAcademy, "Taystjka VoIP");
        let inputs = ClientInputs {
            paths: paths.clone(),
            draft_id: draft.id.clone(),
            client: client.clone(),
            engine,
            release: Some(entries),
            configs: vec![DraftConfig {
                name: "Binds".into(),
                text: "bind x +attack\n".into(),
                priority: 5,
                source_config_id: Some("binds".into()),
            }],
        };
        let component = component_from_client(&inputs).expect("the component");
        assert_eq!(component.id, "taystjk");
        assert_eq!(component.label, "TaystJK");
        assert_eq!(component.release_tag.as_deref(), Some("v1.6.3"));
        assert_eq!(component.modes, [LaunchMode::Multiplayer]);
        assert_eq!(component.fs_game.as_deref(), Some("taystjk"));
        assert_eq!(component.launch_args, "+set cg_fov 97");
        assert_eq!(component.configs.len(), 1);

        // The overlay: the rebuilt executable replaces, the renderer is
        // added, the module and the readme of the release stay out, the log
        // stays out, the missing vulkan renderer is removed.
        let overlay: Vec<(&str, &DraftOrigin)> = component
            .overlay
            .files
            .iter()
            .map(|file| (file.path.as_str(), &file.origin))
            .collect();
        assert_eq!(overlay.len(), 2, "{overlay:?}");
        assert_eq!(overlay[0].0, "rd-vanilla_x86.dll");
        assert!(matches!(overlay[0].1, DraftOrigin::Disk { .. }));
        assert_eq!(overlay[1].0, "taystjk.x86.exe");
        assert_eq!(
            overlay[1].1,
            &DraftOrigin::Release {
                sha256: sha256_hex(b"MZ release"),
                size: 10
            }
        );
        assert_eq!(component.overlay.files[1].sha256, sha256_hex(b"MZ custom"));
        assert_eq!(component.overlay.remove, ["rd-vulkan_x86.dll"]);
        assert!(file_path(&paths, &draft.id, "taystjk", FileRoot::Engine, "taystjk.x86.exe").unwrap().is_file());

        // The library and the loose files.
        let files: Vec<&str> = component.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            files,
            [
                "base/autoexec.cfg",
                "base/zz_skin.pk3",
                "taystjk/cgamex86.dll",
                "taystjk/japro-assets.pk3",
                "taystjk/readme.txt",
            ]
        );
        let japro = component.files.iter().find(|f| f.path == "taystjk/japro-assets.pk3").unwrap();
        match &japro.origin {
            DraftOrigin::Client { client_id, item_id, provenance } => {
                assert_eq!(client_id, "voip");
                assert_eq!(item_id, "taystjk/japro-assets.pk3");
                assert_eq!(provenance.as_ref().map(|p| p.file_id), Some(3937));
            }
            other => panic!("{other:?}"),
        }
        assert!(!japro.is_blob(), "a JKHub file of the client is a reference");
        let info = japro.library.as_ref().expect("library details");
        assert_eq!(info.maps, ["mp/duel_x.bsp"]);
        assert_eq!(info.entries, 3);
        let skin = component.files.iter().find(|f| f.path == "base/zz_skin.pk3").unwrap();
        assert_eq!(skin.library.as_ref().unwrap().category, library::LibraryCategory::Skin);
        assert_eq!(skin.library.as_ref().unwrap().folders.get("models"), Some(&2));
        assert!(skin.is_blob());
        // Every pk3 of the component has its listing, the JKHub one too.
        for pk3 in component.files.iter().filter(|f| f.kind == FileKind::Pk3) {
            let listing = pk3.listing.as_ref().unwrap_or_else(|| panic!("{} has a listing", pk3.path));
            let document = listing::draft_listing_path(&paths, &draft.id, &pk3.sha256);
            assert_eq!(listing.size, fs::metadata(&document).unwrap().len());
        }
        assert!(component.files.iter().filter(|f| f.kind != FileKind::Pk3).all(|f| f.listing.is_none()));
        let autoexec = component.files.iter().find(|f| f.path == "base/autoexec.cfg").unwrap();
        assert!(matches!(&autoexec.origin, DraftOrigin::Disk { source_path } if source_path.ends_with("autoexec.cfg")));
        assert!(file_path(&paths, &draft.id, "taystjk", FileRoot::Home, "base/zz_skin.pk3").unwrap().is_file());

        // A client whose engine is not installed has no overlay to look for.
        let mut fresh = client.clone();
        fresh.engine_version = None;
        let inputs = ClientInputs {
            paths: paths.clone(),
            draft_id: draft.id.clone(),
            client: fresh,
            engine,
            release: None,
            configs: Vec::new(),
        };
        let component = component_from_client(&inputs).expect("the component");
        assert!(component.overlay.is_empty_for_test());
        assert_eq!(component.release_tag, None);
    }

    impl DraftOverlay {
        fn is_empty_for_test(&self) -> bool {
            self.files.is_empty() && self.remove.is_empty()
        }
    }

    #[test]
    fn files_are_added_from_disk_replaced_excluded_and_restored() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().unwrap();
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "eternaljk", &[LaunchMode::Multiplayer]));
        write_draft(&paths, &draft).unwrap();
        let picked = temp.path().join("picked");
        write_zip(&picked.join("zz_skin.pk3"), &[("models/players/reborn/model.glm", b"skin")]);
        write(&picked.join("autoexec.cfg"), b"seta cg_fov 97\n");
        write(&picked.join("assets1.pk3"), b"retail");

        // From disk into a folder of home, with the classification of a pk3.
        let files = [picked.join("zz_skin.pk3"), picked.join("autoexec.cfg")];
        let mut imported = Vec::new();
        for source in &files {
            let path = home_path("base", source).unwrap();
            imported.push(
                import_file(&paths, &draft.id, "mp", FileRoot::Home, &path, source, None, DraftOrigin::Disk {
                    source_path: source.display().to_string(),
                })
                .unwrap(),
            );
        }
        let draft = edit_draft(&paths, &draft.id, |draft| {
            let list = home_files_mut(draft, "mp")?;
            for file in imported {
                put_file(list, file);
            }
            Ok(())
        })
        .unwrap();
        let mp = draft.component("mp").unwrap();
        assert_eq!(mp.files.len(), 2);
        assert_eq!(mp.files[0].path, "base/zz_skin.pk3");
        assert_eq!(mp.files[0].library.as_ref().unwrap().category, library::LibraryCategory::Skin);
        assert_eq!(mp.files[0].library.as_ref().unwrap().display_name, "zz_skin");
        assert_eq!(mp.files[1].kind, FileKind::Cfg);
        assert_eq!(mp.files[1].sha256, sha256_hex(b"seta cg_fov 97\n"));
        // The pk3 got its listing next to the copy; the cfg has none.
        let listing = mp.files[0].listing.as_ref().expect("a listing of the pk3");
        let document = listing::draft_listing_path(&paths, &draft.id, &mp.files[0].sha256);
        assert!(document.is_file());
        assert_eq!(listing.size, fs::metadata(&document).unwrap().len());
        assert_eq!(listing.sha256, sha256_of(&document).unwrap());
        assert_eq!(mp.files[1].listing, None);
        let record = fs::read_to_string(record_path(&paths, &draft.id)).unwrap();
        assert!(record.contains("\"listing\": {"), "{record}");
        assert!(file_path(&paths, &draft.id, "mp", FileRoot::Home, "base/autoexec.cfg").unwrap().is_file());

        // A retail archive is refused, a shared scope takes files too, a
        // folder name is checked, and the same path again replaces.
        let error = import_file(&paths, &draft.id, "mp", FileRoot::Home, "base/assets1.pk3", &picked.join("assets1.pk3"), None, DraftOrigin::Disk {
            source_path: String::new(),
        })
        .expect_err("retail");
        assert!(error.to_string().contains("retail"), "{error}");
        assert!(check_folder("../x").is_err());
        assert!(check_folder("  ").is_err());
        assert_eq!(check_folder(" base ").unwrap(), "base");
        write(&picked.join("autoexec.cfg"), b"seta cg_fov 110\n");
        let again = import_file(&paths, &draft.id, "mp", FileRoot::Home, "base/autoexec.cfg", &picked.join("autoexec.cfg"), None, DraftOrigin::Disk {
            source_path: String::new(),
        })
        .unwrap();
        let draft = edit_draft(&paths, &draft.id, |draft| {
            put_file(home_files_mut(draft, "mp")?, again);
            Ok(())
        })
        .unwrap();
        assert_eq!(draft.component("mp").unwrap().files.len(), 2);
        assert_eq!(
            draft.component("mp").unwrap().files.iter().find(|f| f.path == "base/autoexec.cfg").unwrap().sha256,
            sha256_hex(b"seta cg_fov 110\n")
        );

        // Removing a file takes its copy with it.
        let draft = edit_draft(&paths, &draft.id, |draft| {
            take_file(home_files_mut(draft, "mp")?, "BASE/autoexec.cfg").ok_or_else(|| AppError::NotFound("x".into()))?;
            Ok(())
        })
        .unwrap();
        remove_copy(&paths, &draft.id, "mp", FileRoot::Home, "base/autoexec.cfg");
        assert_eq!(draft.component("mp").unwrap().files.len(), 1);
        assert!(!file_path(&paths, &draft.id, "mp", FileRoot::Home, "base/autoexec.cfg").unwrap().exists());
        assert!(file_path(&paths, &draft.id, "mp", FileRoot::Home, "base/zz_skin.pk3").unwrap().is_file(), "the folder stays for the other file");

        // The overlay against a release: replace, add, exclude, restore.
        let entries: HashMap<String, ArchiveEntry> = [
            ("eternaljk.x86.exe", b"MZ release" as &[u8]),
            ("rd-vulkan_x86.dll", b"vulkan"),
        ]
        .into_iter()
        .map(|(path, body)| {
            (
                path.to_string(),
                ArchiveEntry {
                    path: path.into(),
                    size: body.len() as u64,
                    sha256: sha256_hex(body),
                },
            )
        })
        .collect();
        write(&picked.join("eternaljk.x86.exe"), b"MZ custom");
        write(&picked.join("rd-vanilla_x86.dll"), b"renderer");
        let replaced = import_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Engine,
            &release::release_spelling(&entries, "ETERNALJK.x86.exe"),
            &picked.join("eternaljk.x86.exe"),
            None,
            release::overlay_origin(&entries, "ETERNALJK.x86.exe", &picked.join("eternaljk.x86.exe")),
        )
        .unwrap();
        assert_eq!(replaced.path, "eternaljk.x86.exe");
        assert_eq!(
            replaced.origin,
            DraftOrigin::Release {
                sha256: sha256_hex(b"MZ release"),
                size: 10
            }
        );
        let added = import_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Engine,
            "rd-vanilla_x86.dll",
            &picked.join("rd-vanilla_x86.dll"),
            None,
            release::overlay_origin(&entries, "rd-vanilla_x86.dll", &picked.join("rd-vanilla_x86.dll")),
        )
        .unwrap();
        assert!(matches!(added.origin, DraftOrigin::Disk { .. }));
        let draft = edit_draft(&paths, &draft.id, |draft| {
            let component = component_mut(draft, "mp")?;
            put_file(&mut component.overlay.files, replaced);
            put_file(&mut component.overlay.files, added);
            component.overlay.remove.push("rd-vulkan_x86.dll".into());
            Ok(())
        })
        .unwrap();
        let tree = release::view("v1.6.3".into(), &entries, draft.component("mp").unwrap());
        let states: Vec<(&str, &str)> = tree.files.iter().map(|f| (f.path.as_str(), f.state)).collect();
        assert_eq!(
            states,
            [
                ("eternaljk.x86.exe", release::STATE_REPLACED),
                ("rd-vanilla_x86.dll", release::STATE_ADDED),
                ("rd-vulkan_x86.dll", release::STATE_REMOVED),
            ]
        );
        assert!(draft.component("mp").unwrap().has_overlay_for_test());

        // Restore: the replacement goes with its copy, the removal mark too.
        let draft = edit_draft(&paths, &draft.id, |draft| {
            let component = component_mut(draft, "mp")?;
            component.overlay.remove.retain(|r| !r.eq_ignore_ascii_case("RD-VULKAN_x86.dll"));
            take_file(&mut component.overlay.files, "eternaljk.x86.exe");
            Ok(())
        })
        .unwrap();
        remove_copy(&paths, &draft.id, "mp", FileRoot::Engine, "eternaljk.x86.exe");
        let tree = release::view("v1.6.3".into(), &entries, draft.component("mp").unwrap());
        let states: Vec<(&str, &str)> = tree.files.iter().map(|f| (f.path.as_str(), f.state)).collect();
        assert_eq!(
            states,
            [
                ("eternaljk.x86.exe", release::STATE_RELEASE),
                ("rd-vanilla_x86.dll", release::STATE_ADDED),
                ("rd-vulkan_x86.dll", release::STATE_RELEASE),
            ]
        );
        assert!(!file_path(&paths, &draft.id, "mp", FileRoot::Engine, "eternaljk.x86.exe").unwrap().exists());
        assert!(file_path(&paths, &draft.id, "mp", FileRoot::Engine, "rd-vanilla_x86.dll").unwrap().is_file());

        // The map of hashes for an upload or a test install.
        let map = files_by_hash(&paths, &draft);
        assert_eq!(map.len(), 2);
        assert!(map[&sha256_hex(b"renderer")].is_file());
    }

    impl DraftComponent {
        fn has_overlay_for_test(&self) -> bool {
            !self.overlay.files.is_empty() || !self.overlay.remove.is_empty()
        }
    }

    #[test]
    fn a_draft_is_made_out_of_a_client_through_the_state() {
        let temp = tempfile::tempdir().expect("a data root");
        let state = AppState::bootstrap(temp.path().to_path_buf());
        let paths = state.paths().unwrap();
        let (_, client, _) = client_fixture(&paths.root);
        // The config documents of the client, assigned as one layer.
        let assigned = configs::install_documents(
            &state,
            &client,
            &[configs::NewDocument {
                name: "Binds".into(),
                text: "bind x +attack
seta rconPassword x
".into(),
                priority: 3,
            }],
        )
        .expect("the document is assigned");
        let binds_id = assigned[0].id.clone();

        // The engine of the fixture is installed, and its release is in the
        // cache, so no network is touched: the release list is asked of
        // GitHub only when the tag is not cached. The cache is primed the
        // way an install leaves it.
        crate::engine_install::test_support::prime_release_cache(
            &paths,
            "taystjk",
            "v1.6.3",
            &paths.cache.join("downloads").join("taystjk-v1.6.3.zip"),
        );
        let draft = run(create(&state, Game::JediAcademy, "", Some("voip"))).expect("the draft");
        assert_eq!(draft.name, "Taystjka VoIP", "an empty name takes the name of the client");
        assert_eq!(draft.components.len(), 1);
        let component = &draft.components[0];
        assert_eq!(component.id, "taystjk");
        assert_eq!(component.configs.len(), 1);
        assert_eq!(component.configs[0].source_config_id.as_deref(), Some(binds_id.as_str()));
        assert_eq!(component.configs[0].priority, 3);
        assert_eq!(component.overlay.remove, ["rd-vulkan_x86.dll"]);
        let issues = validate(&draft);
        assert!(issues.errors.is_empty(), "{:?}", issues.errors);
        assert_eq!(
            issues.warnings.iter().map(|w| w.code.as_str()).collect::<Vec<_>>(),
            [ISSUE_EXECUTABLES_PRESENT, ISSUE_PASSWORDS_STRIPPED]
        );
        assert_eq!(read_all(&paths).unwrap().len(), 1);

        // A client brings only the main language, which follows the
        // interface: the system setting reads as English.
        assert_eq!(draft.language, "en");
        assert!(draft.translations.is_empty());

        // The other game is refused, and an empty draft needs no client.
        let error = run(create(&state, Game::JediOutcast, "x", Some("voip"))).expect_err("the other game");
        assert!(matches!(error, AppError::GameMismatch(_)), "{error}");
        let empty = run(create(&state, Game::JediOutcast, "JK2", None)).unwrap();
        assert!(empty.components.is_empty());
        assert_eq!(empty.game, Game::JediOutcast);
        assert_eq!(empty.language, "en");

        // With the interface in Russian, a new draft is in Russian.
        let mut settings = state.settings().unwrap();
        settings.language = "ru".into();
        state.set_settings(settings).unwrap();
        let russian = run(create(&state, Game::JediOutcast, "JK2", None)).unwrap();
        assert_eq!(russian.language, "ru");
        assert!(russian.translations.is_empty());
    }
}
