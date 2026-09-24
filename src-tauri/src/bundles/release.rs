//! The files of an engine release, and what a component of a draft does to
//! them.
//!
//! A component lays files over the release of its engine and takes files
//! out of it. To say which is which, the launcher needs the release itself:
//! the archive comes from `cache\downloads\`, where an engine install left
//! it, or from GitHub through `engine_install::fetch_archive`, and its
//! entries are hashed once per call. The comparison is what
//! `draft_engine_files` shows as a tree with four states, what
//! `create_bundle_draft` uses to turn the `engine\` folder of a client into
//! an overlay, and what the replace, add and exclude commands check a path
//! against.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::engine_install::{self, ArchiveEntry};
use crate::engines::Engine;
use crate::error::{AppError, Result};
use crate::paths::DataPaths;

use super::draft::{DraftComponent, DraftOrigin};

/// One file of the release, or of the overlay, as the editor lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseFile {
    /// Forward slashes, spelled the way the archive spells it, or the way
    /// the author added it.
    pub path: String,
    /// Size and hash of the file the install lays down: the overlay file
    /// for `replaced` and `added`, the file of the release otherwise.
    pub size: u64,
    pub sha256: String,
    /// `release`, `replaced`, `added` or `removed`.
    pub state: &'static str,
    /// Size and hash of the file of the release under a `replaced` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_sha256: Option<String>,
}

/// The answer of `draft_engine_files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseView {
    /// The tag the files belong to: the tag of the component, or the newest
    /// release when the component names none.
    pub release_tag: String,
    pub files: Vec<ReleaseFile>,
}

pub const STATE_RELEASE: &str = "release";
pub const STATE_REPLACED: &str = "replaced";
pub const STATE_ADDED: &str = "added";
pub const STATE_REMOVED: &str = "removed";

/// The release archive of an engine at a tag, from the cache or from GitHub,
/// and the tag it turned out to be.
///
/// `None` for the tag picks the newest release, which is what a component
/// without a tag installs. A tag that is not among the releases GitHub still
/// lists is refused with `AppError::NotFound`: without the archive there is
/// no telling the build's files from the author's.
pub(crate) async fn release_archive(
    paths: &DataPaths,
    engine: &'static Engine,
    tag: Option<&str>,
) -> Result<(String, PathBuf)> {
    let releases = engine_install::releases(engine, &paths.cache).await?;
    let release = match tag {
        Some(tag) => releases
            .into_iter()
            .find(|release| release.tag == tag)
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "release {tag} of {} among the releases GitHub lists",
                    engine.name
                ))
            })?,
        None => releases.into_iter().next().ok_or_else(|| {
            AppError::NotFound(format!("a release of {} this machine can install", engine.name))
        })?,
    };
    let archive = engine_install::fetch_archive(paths, engine, &release, |_| {}).await?;
    Ok((release.tag, archive))
}

/// The files of an archive with their hashes, read on a blocking thread:
/// a release runs to fifty megabytes, and hashing it must not hold up the
/// runtime.
pub(crate) async fn read_entries(archive: &Path) -> Result<HashMap<String, ArchiveEntry>> {
    let archive = archive.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || engine_install::archive_entries(&archive))
        .await
        .map_err(|e| AppError::State(format!("the hashing thread stopped: {e}")))?
}

/// The release archive of a component and its entries, in one call.
pub(crate) async fn component_release(
    paths: &DataPaths,
    engine: &'static Engine,
    component: &DraftComponent,
) -> Result<(String, HashMap<String, ArchiveEntry>)> {
    let (tag, archive) = release_archive(paths, engine, component.release_tag.as_deref()).await?;
    let entries = read_entries(&archive).await?;
    Ok((tag, entries))
}

/// The tree of `draft_engine_files`: every file of the release with the
/// state the component gives it, then the files the component adds, sorted
/// by path without regard to case.
pub(crate) fn view(
    release_tag: String,
    entries: &HashMap<String, ArchiveEntry>,
    component: &DraftComponent,
) -> ReleaseView {
    let removed: Vec<String> = component
        .overlay
        .remove
        .iter()
        .map(|path| path.to_ascii_lowercase())
        .collect();
    let mut files = Vec::with_capacity(entries.len() + component.overlay.files.len());
    for (key, entry) in entries {
        if removed.contains(key) {
            files.push(ReleaseFile {
                path: entry.path.clone(),
                size: entry.size,
                sha256: entry.sha256.clone(),
                state: STATE_REMOVED,
                release_size: None,
                release_sha256: None,
            });
            continue;
        }
        match component
            .overlay
            .files
            .iter()
            .find(|file| file.path.eq_ignore_ascii_case(key))
        {
            Some(over) => files.push(ReleaseFile {
                path: over.path.clone(),
                size: over.size,
                sha256: over.sha256.clone(),
                state: STATE_REPLACED,
                release_size: Some(entry.size),
                release_sha256: Some(entry.sha256.clone()),
            }),
            None => files.push(ReleaseFile {
                path: entry.path.clone(),
                size: entry.size,
                sha256: entry.sha256.clone(),
                state: STATE_RELEASE,
                release_size: None,
                release_sha256: None,
            }),
        }
    }
    for over in &component.overlay.files {
        if !entries.contains_key(&over.path.to_ascii_lowercase()) {
            files.push(ReleaseFile {
                path: over.path.clone(),
                size: over.size,
                sha256: over.sha256.clone(),
                state: STATE_ADDED,
                release_size: None,
                release_sha256: None,
            });
        }
    }
    files.sort_by_key(|file| file.path.to_ascii_lowercase());
    ReleaseView { release_tag, files }
}

/// The origin of an overlay file at `path`: the file of the release it
/// replaces, or the disk it was added from.
pub(crate) fn overlay_origin(
    entries: &HashMap<String, ArchiveEntry>,
    path: &str,
    source_path: &Path,
) -> DraftOrigin {
    match entries.get(&path.to_ascii_lowercase()) {
        Some(entry) => DraftOrigin::Release {
            sha256: entry.sha256.clone(),
            size: entry.size,
        },
        None => DraftOrigin::Disk {
            source_path: source_path.display().to_string(),
        },
    }
}

/// The spelling the release uses for `path`, when it is a file of the
/// release; the path itself otherwise. A replacement written under the
/// archive's own spelling lands on the file it replaces on every file
/// system, not only on the one that ignores case.
pub(crate) fn release_spelling(entries: &HashMap<String, ArchiveEntry>, path: &str) -> String {
    entries
        .get(&path.to_ascii_lowercase())
        .map(|entry| entry.path.clone())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundles::draft::{DraftFile, DraftOverlay};
    use crate::bundles::manifest::{FileKind, FileRoot};
    use crate::engines::LaunchMode;

    fn entry(path: &str, body: &[u8]) -> (String, ArchiveEntry) {
        (
            path.to_ascii_lowercase(),
            ArchiveEntry {
                path: path.into(),
                size: body.len() as u64,
                sha256: crate::bundles::test_support::sha256_hex(body),
            },
        )
    }

    fn overlay_file(path: &str, body: &[u8], origin: DraftOrigin) -> DraftFile {
        DraftFile {
            root: FileRoot::Engine,
            path: path.into(),
            size: body.len() as u64,
            sha256: crate::bundles::test_support::sha256_hex(body),
            kind: FileKind::of_path(path),
            library: None,
            listing: None,
            origin,
        }
    }

    #[test]
    fn the_tree_gives_every_file_one_of_four_states() {
        let entries: HashMap<String, ArchiveEntry> = [
            entry("taystjk.x86.exe", b"MZ release"),
            entry("Base/cgamex86.dll", b"cgame"),
            entry("rd-vulkan_x86.dll", b"vulkan"),
            entry("README.md", b"read me"),
        ]
        .into_iter()
        .collect();
        let component = DraftComponent {
            id: "mp".into(),
            label: "Multiplayer".into(),
            engine_id: "taystjk".into(),
            release_tag: Some("v1.6.3".into()),
            modes: vec![LaunchMode::Multiplayer],
            fs_game: None,
            launch_args: String::new(),
            overlay: DraftOverlay {
                files: vec![
                    overlay_file(
                        "taystjk.x86.exe",
                        b"MZ custom",
                        DraftOrigin::Release {
                            sha256: crate::bundles::test_support::sha256_hex(b"MZ release"),
                            size: 10,
                        },
                    ),
                    overlay_file(
                        "rd-vanilla_x86.dll",
                        b"renderer",
                        DraftOrigin::Disk {
                            source_path: "D:/build/rd-vanilla_x86.dll".into(),
                        },
                    ),
                ],
                remove: vec!["RD-VULKAN_x86.dll".into()],
            },
            files: Vec::new(),
            configs: Vec::new(),
        };

        let tree = view("v1.6.3".into(), &entries, &component);
        assert_eq!(tree.release_tag, "v1.6.3");
        let states: Vec<(&str, &str)> = tree
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.state))
            .collect();
        assert_eq!(
            states,
            [
                ("Base/cgamex86.dll", STATE_RELEASE),
                ("rd-vanilla_x86.dll", STATE_ADDED),
                ("rd-vulkan_x86.dll", STATE_REMOVED),
                ("README.md", STATE_RELEASE),
                ("taystjk.x86.exe", STATE_REPLACED),
            ]
        );
        let replaced = tree.files.iter().find(|f| f.state == STATE_REPLACED).unwrap();
        assert_eq!(replaced.size, 9, "the size of the overlay file");
        assert_eq!(replaced.release_size, Some(10));
        assert_eq!(
            replaced.release_sha256.as_deref(),
            Some(crate::bundles::test_support::sha256_hex(b"MZ release").as_str())
        );
        let plain = tree.files.iter().find(|f| f.path == "README.md").unwrap();
        assert_eq!(plain.release_size, None);
        let json = serde_json::to_value(&tree).unwrap();
        assert_eq!(json["files"][4]["releaseSha256"], replaced.release_sha256.clone().unwrap());
        assert!(json["files"][0].get("releaseSize").is_none());

        // The origin and the spelling of an overlay file follow the release.
        let source = Path::new("D:/build/taystjk.x86.exe");
        assert_eq!(
            overlay_origin(&entries, "TAYSTJK.X86.EXE", source),
            DraftOrigin::Release {
                sha256: crate::bundles::test_support::sha256_hex(b"MZ release"),
                size: 10
            }
        );
        assert_eq!(
            overlay_origin(&entries, "rd-vanilla_x86.dll", source),
            DraftOrigin::Disk {
                source_path: source.display().to_string()
            }
        );
        assert_eq!(release_spelling(&entries, "base/CGAMEX86.DLL"), "Base/cgamex86.dll");
        assert_eq!(release_spelling(&entries, "new.dll"), "new.dll");
    }
}
