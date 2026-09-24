//! The listing of a pk3: every entry of the archive with its size, kept as
//! one small JSON document next to the file, so the catalogue can show what
//! is inside a bundle before anybody downloads it.
//!
//! The document is `{ "schema": 1, "entries": [ { "path", "size" } ] }`,
//! the entries sorted by path, folder entries left out, at most
//! [`MAX_ENTRIES`] of them. It is written compact and in that order every
//! time, because its SHA-256 is its name in the store of the service: the
//! same archive has to give the same document, byte for byte. The limit
//! holds on both ways: the walk over an archive stops at it, and a document
//! read back — from the folder of a draft, from the cache or from the store,
//! which takes a listing as a plain file and never looks inside — is refused
//! when it names more entries than that or weighs more than
//! [`MAX_LISTING_BYTES`].
//!
//! On disk:
//!
//! ```text
//! bundles\drafts\<draftId>\listings\<pk3 sha256>.json   the listing of one pk3 of the draft
//! cache\bundles\listings\<listing sha256>.json          a listing of the catalogue, downloaded once
//! ```
//!
//! A draft names its listings by the hash of the pk3, which is what a file
//! of the draft is looked up by; the record of the file carries the hash
//! and size of the listing itself (`DraftFile.listing`), which is what the
//! manifest sends and what the catalogue asks for. A draft written before
//! listings existed has neither: `draft_file_listing` builds the document
//! on demand and writes both.
//!
//! The text of a cfg file travels the same way, without a document: the
//! file itself is small, and the dialog shows it as it is.

use std::collections::HashMap;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use crate::archive;
use crate::error::{AppError, Result};
use crate::online::{OnlineClient, OnlineContext};
use crate::paths::{self, DataPaths};
use crate::state::AppState;

use super::draft::{self, Draft, DraftFile};
use super::manifest::{self, FileKind, FileRoot, ListingRef};
use super::types::{Listing, ListingEntry, ListingFile};
use super::{preview, sha256_hex};

/// The one schema of the document this build writes and reads.
pub const SCHEMA: u32 = 1;

/// Entries one listing may name: the limit of the preview of the Library
/// screen, which reads the same archives through the same walk.
pub const MAX_ENTRIES: usize = archive::MAX_ENTRIES;

/// Bytes a listing document may be, on its way down from the store or read
/// back from disk: fifty thousand entries of a long path each stay well
/// under it.
pub const MAX_LISTING_BYTES: u64 = 16 * 1024 * 1024;

/// Bytes of a text file the **Contents** dialog shows.
pub const MAX_TEXT_BYTES: u64 = 64 * 1024;

/// Extensions of files the **Contents** dialog refuses to show as text,
/// beyond the pk3, dll and exe kinds of the manifest: what a bundle carries
/// next to its configs that is bytes rather than words. The check is by
/// name, like the kind of a file; it stops a wrong click, not a wrong file.
const BINARY_EXTENSIONS: [&str; 24] = [
    "zip", "7z", "rar", "qvm", "so", "dylib", "pdb", "lib", "bin", "dat", "bsp", "glm", "gla", "md3", "roq",
    "wav", "mp3", "ogg", "jpg", "jpeg", "png", "tga", "gif", "ico",
];

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/// Reads the entries of an archive: files only, forward slashes, sorted by
/// path, at most [`MAX_ENTRIES`]. The walk stops at the limit rather than
/// reading on and cutting afterwards, so an archive that declares more
/// entries than that costs no more than one that declares the limit. An
/// archive that will not open is an error the caller decides about: a pk3
/// of a draft is still a file of the draft without a listing.
pub(crate) fn read_listing(archive: &Path) -> Result<ListingFile> {
    let file = fs::File::open(archive).map_err(|e| AppError::io_path("cannot open", archive, e))?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file))?;
    let mut entries: Vec<ListingEntry> = archive::entries(&mut zip, MAX_ENTRIES)?
        .into_iter()
        .map(|entry| ListingEntry {
            path: entry.path,
            size: entry.size,
        })
        .collect();
    if entries.len() == MAX_ENTRIES && zip.len() > MAX_ENTRIES {
        log::warn!(
            "bundles: {} declares {} entries, the listing keeps the first {MAX_ENTRIES}",
            archive.display(),
            zip.len()
        );
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ListingFile {
        schema: SCHEMA,
        entries,
    })
}

/// The bytes of a document: compact JSON, the fields in the order of the
/// struct. What is hashed is what is written and what is uploaded.
pub(crate) fn encode(listing: &ListingFile) -> Result<Vec<u8>> {
    serde_json::to_vec(listing).map_err(|e| AppError::json("cannot serialize a listing", e))
}

/// Reads a document back, refusing another schema, one over
/// [`MAX_LISTING_BYTES`] and one that names more than [`MAX_ENTRIES`]
/// entries: the store takes a listing as a plain file, so a document that
/// did not come out of [`read_listing`] can say anything.
pub(crate) fn decode(bytes: &[u8]) -> Result<ListingFile> {
    if bytes.len() as u64 > MAX_LISTING_BYTES {
        return Err(AppError::BundleUnavailable(format!(
            "the listing is {} bytes, more than the {} MiB a listing may be",
            bytes.len(),
            MAX_LISTING_BYTES / (1024 * 1024)
        )));
    }
    let listing: ListingFile =
        serde_json::from_slice(bytes).map_err(|e| AppError::json("cannot parse a listing", e))?;
    if listing.schema != SCHEMA {
        return Err(AppError::BundleUnavailable(format!(
            "the listing uses schema {}, and this version of JKNet reads schema {SCHEMA}. Update the launcher.",
            listing.schema
        )));
    }
    if listing.entries.len() > MAX_ENTRIES {
        return Err(AppError::BundleUnavailable(format!(
            "the listing names {} entries, more than the {MAX_ENTRIES} a listing may",
            listing.entries.len()
        )));
    }
    Ok(listing)
}

/// Where the listing of a pk3 of a draft lies.
pub(crate) fn draft_listing_path(paths: &DataPaths, draft_id: &str, pk3_sha256: &str) -> PathBuf {
    paths
        .bundle_draft_listings_dir(draft_id)
        .join(format!("{pk3_sha256}.json"))
}

/// Builds the listing of a pk3 of a draft, writes it and answers with what
/// the record of the file carries. Blocking: the callers run it on a
/// blocking thread next to the hashing of the file.
pub(crate) fn write_draft_listing(paths: &DataPaths, draft_id: &str, pk3_sha256: &str, archive: &Path) -> Result<ListingRef> {
    let listing = read_listing(archive)?;
    let bytes = encode(&listing)?;
    let target = draft_listing_path(paths, draft_id, pk3_sha256);
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    fs::write(&target, &bytes).map_err(|e| AppError::io_path("cannot write", &target, e))?;
    Ok(ListingRef {
        sha256: sha256_hex(&bytes),
        size: bytes.len() as u64,
    })
}

/// The listing of a pk3 of a draft, when adding the file: an archive that
/// will not open leaves the record without one, with a line in the log,
/// the way `pk3_info` leaves it without a category.
pub(crate) fn listing_of_new_file(paths: &DataPaths, draft_id: &str, pk3_sha256: &str, archive: &Path) -> Option<ListingRef> {
    match write_draft_listing(paths, draft_id, pk3_sha256, archive) {
        Ok(listing) => Some(listing),
        Err(e) => {
            log::warn!("bundles: cannot list {}: {e}", archive.display());
            None
        }
    }
}

/// Removes the listings of a draft that no pk3 of the draft refers to any
/// more: after a file was removed, or replaced under its path. Best effort,
/// like the removal of a copied file.
pub(crate) fn prune_draft_listings(paths: &DataPaths, draft: &Draft) {
    let dir = paths.bundle_draft_listings_dir(&draft.id);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let referenced = draft.all_files().any(|(_, file)| file.sha256 == stem);
        if !referenced {
            if let Err(e) = fs::remove_file(&path) {
                log::warn!("cannot remove {}: {e}", path.display());
            }
        }
    }
}

/// Where every listing of the draft lies, by the hash of the listing: what
/// the upload of a publish reads from. A listing whose file is gone is left
/// out, and the publish reports the hash the service asked for.
pub(crate) fn listings_by_hash(paths: &DataPaths, draft: &Draft) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    for (_, file) in draft.all_files() {
        let Some(listing) = &file.listing else {
            continue;
        };
        let path = draft_listing_path(paths, &draft.id, &file.sha256);
        if path.is_file() {
            map.entry(listing.sha256.clone()).or_insert(path);
        }
    }
    map
}

/// Gives every pk3 of a draft its listing before a publish: a draft of the
/// second edition has none in its record, and a draft copied without its
/// `listings\` folder has records without documents. Each is built on a
/// blocking thread; the record is written once when anything changed, and
/// the draft comes back as it now stands.
pub(crate) async fn ensure_listings(paths: &DataPaths, draft: Draft) -> Result<Draft> {
    let mut wanted: Vec<(String, FileRoot, String, String)> = Vec::new();
    for (scope, file) in draft.all_files() {
        if FileKind::of_path(&file.path) != FileKind::Pk3 {
            continue;
        }
        if file.listing.is_some() && draft_listing_path(paths, &draft.id, &file.sha256).is_file() {
            continue;
        }
        wanted.push((scope.to_string(), file.root, file.path.clone(), file.sha256.clone()));
    }
    if wanted.is_empty() {
        return Ok(draft);
    }
    let mut built: Vec<(String, FileRoot, String, ListingRef)> = Vec::with_capacity(wanted.len());
    for (scope, root, path, sha256) in wanted {
        let archive = draft::file_path(paths, &draft.id, &scope, root, &path)?;
        let (paths_for_build, draft_for_build, hash) = (paths.clone(), draft.id.clone(), sha256.clone());
        let listing = tauri::async_runtime::spawn_blocking(move || {
            write_draft_listing(&paths_for_build, &draft_for_build, &hash, &archive)
        })
        .await
        .map_err(|e| AppError::State(format!("the listing thread stopped: {e}")))??;
        log::info!("bundles: listed {scope}/{path} of draft {}", draft.id);
        built.push((scope, root, path, listing));
    }
    draft::edit_draft(paths, &draft.id, |record| {
        for (scope, root, path, listing) in built {
            let list = match (scope == manifest::SHARED_SCOPE, root) {
                (true, _) => &mut record.shared.files,
                (false, FileRoot::Home) => &mut draft::component_mut(record, &scope)?.files,
                (false, FileRoot::Engine) => &mut draft::component_mut(record, &scope)?.overlay.files,
            };
            if let Some(entry) = list.iter_mut().find(|file| file.path.eq_ignore_ascii_case(&path)) {
                entry.listing = Some(listing);
            }
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// The file of a draft at `path` of `scope` and `root`, with the scope
/// checked first.
pub(crate) fn find_draft_file<'a>(draft: &'a Draft, scope: &str, root: FileRoot, path: &str) -> Result<&'a DraftFile> {
    let list: &[DraftFile] = if scope == manifest::SHARED_SCOPE {
        if root != FileRoot::Home {
            return Err(AppError::NotFound(format!("{}/{path} in {scope}", root.as_str())));
        }
        &draft.shared.files
    } else {
        let component = draft
            .component(scope)
            .ok_or_else(|| AppError::NotFound(format!("component {scope} of the draft")))?;
        match root {
            FileRoot::Home => &component.files,
            FileRoot::Engine => &component.overlay.files,
        }
    };
    list.iter()
        .find(|file| file.path.eq_ignore_ascii_case(path))
        .ok_or_else(|| AppError::NotFound(format!("{}/{path} in {scope}", root.as_str())))
}

// --- slice: pk3 editor ---
/// The same file, to change: what the pk3 editor writes its new size, hash
/// and listing into after a save.
pub(crate) fn find_draft_file_mut<'a>(draft: &'a mut Draft, scope: &str, root: FileRoot, path: &str) -> Result<&'a mut DraftFile> {
    let missing = || AppError::NotFound(format!("{}/{path} in {scope}", root.as_str()));
    let list: &mut Vec<DraftFile> = if scope == manifest::SHARED_SCOPE {
        if root != FileRoot::Home {
            return Err(missing());
        }
        &mut draft.shared.files
    } else {
        let component = draft::component_mut(draft, scope)?;
        match root {
            FileRoot::Home => &mut component.files,
            FileRoot::Engine => &mut component.overlay.files,
        }
    };
    list.iter_mut()
        .find(|file| file.path.eq_ignore_ascii_case(path))
        .ok_or_else(missing)
}

/// Refuses a file that has no listing to show.
fn require_pk3(file: &DraftFile) -> Result<()> {
    if FileKind::of_path(&file.path) != FileKind::Pk3 {
        return Err(AppError::InvalidInput(format!(
            "{} is not a pk3, and only a pk3 has a listing",
            file.path
        )));
    }
    Ok(())
}

/// The listing of a pk3 of a draft, built and written first when the draft
/// predates listings or the document went missing.
pub(crate) async fn draft_listing(paths: &DataPaths, draft_id: &str, scope: &str, root: FileRoot, path: &str) -> Result<Listing> {
    let draft = draft::read_draft(paths, draft_id)?;
    let file = find_draft_file(&draft, scope, root, path)?;
    require_pk3(file)?;
    let document = draft_listing_path(paths, draft_id, &file.sha256);
    if file.listing.is_some() {
        if let Ok(bytes) = fs::read(&document) {
            if let Ok(listing) = decode(&bytes) {
                return Ok(Listing::of(listing));
            }
            log::warn!("bundles: {} is not a listing, building it again", document.display());
        }
    }

    // Build it, on a blocking thread: an archive runs to 512 MiB.
    let archive = draft::file_path(paths, draft_id, scope, root, &file.path)?;
    let (paths_for_build, draft_for_build, sha256) = (paths.clone(), draft_id.to_string(), file.sha256.clone());
    let listing = tauri::async_runtime::spawn_blocking(move || {
        write_draft_listing(&paths_for_build, &draft_for_build, &sha256, &archive)
    })
    .await
    .map_err(|e| AppError::State(format!("the listing thread stopped: {e}")))??;
    let spelled = file.path.clone();
    draft::edit_draft(paths, draft_id, |draft| {
        let list = match (scope == manifest::SHARED_SCOPE, root) {
            (true, _) => &mut draft.shared.files,
            (false, FileRoot::Home) => &mut draft::component_mut(draft, scope)?.files,
            (false, FileRoot::Engine) => &mut draft::component_mut(draft, scope)?.overlay.files,
        };
        if let Some(entry) = list.iter_mut().find(|file| file.path.eq_ignore_ascii_case(&spelled)) {
            entry.listing = Some(listing);
        }
        Ok(())
    })?;
    let bytes = fs::read(&document).map_err(|e| AppError::io_path("cannot read", &document, e))?;
    Ok(Listing::of(decode(&bytes)?))
}

/// The listing of a file of the catalogue, from `cache\bundles\listings\`
/// or from the store.
pub(crate) async fn bundle_listing(paths: &DataPaths, online: &OnlineClient, ctx: &OnlineContext, sha256: &str) -> Result<Listing> {
    manifest::check_sha256(sha256)?;
    let target = paths.bundle_listings_cache_dir().join(format!("{sha256}.json"));
    let bytes = preview::cached_blob_bytes(online, ctx, sha256, &target, MAX_LISTING_BYTES).await?;
    Ok(Listing::of(decode(&bytes)?))
}

/// Refuses a file the dialog does not show as text: a pk3, a dll, an exe,
/// or a file with one of the [`BINARY_EXTENSIONS`]. By the path alone, the
/// way the kind of a file is decided: the dialog never opens a file it was
/// not asked to.
pub(crate) fn require_text(path: &str) -> Result<()> {
    let kind = FileKind::of_path(path);
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let extension = name.rsplit_once('.').map(|(_, extension)| extension).unwrap_or("");
    if matches!(kind, FileKind::Pk3 | FileKind::Dll | FileKind::Exe) || BINARY_EXTENSIONS.contains(&extension) {
        return Err(AppError::InvalidInput(format!("{path} is not a text file")));
    }
    Ok(())
}

/// The text of a small file of a draft: a cfg or a readme.
pub(crate) fn draft_text(paths: &DataPaths, draft_id: &str, scope: &str, root: FileRoot, path: &str) -> Result<String> {
    let draft = draft::read_draft(paths, draft_id)?;
    let file = find_draft_file(&draft, scope, root, path)?;
    require_text(&file.path)?;
    let source = draft::file_path(paths, draft_id, scope, root, &file.path)?;
    let meta = fs::metadata(&source).map_err(|e| AppError::io_path("cannot read", &source, e))?;
    check_text_size(&file.path, meta.len())?;
    let bytes = fs::read(&source).map_err(|e| AppError::io_path("cannot read", &source, e))?;
    Ok(text_of(&bytes))
}

/// The text of a small file of the store, cached under
/// `cache\bundles\preview\`. `path` is the manifest path of the file, which
/// says what the file is before a byte of it is fetched: the store hands
/// out any hash, and only the manifest knows that the hash is a config.
pub(crate) async fn bundle_text(
    paths: &DataPaths,
    online: &OnlineClient,
    ctx: &OnlineContext,
    sha256: &str,
    path: &str,
) -> Result<String> {
    manifest::check_sha256(sha256)?;
    if path.is_empty() {
        return Err(AppError::InvalidInput("the text of a file is asked for without its path".into()));
    }
    require_text(path)?;
    let target = paths.bundle_preview_cache_dir().join(format!("{sha256}.txt"));
    let bytes = preview::cached_blob_bytes(online, ctx, sha256, &target, MAX_TEXT_BYTES).await?;
    Ok(text_of(&bytes))
}

fn check_text_size(path: &str, size: u64) -> Result<()> {
    if size > MAX_TEXT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{path} is bigger than the {} KiB the dialog shows",
            MAX_TEXT_BYTES / 1024
        )));
    }
    Ok(())
}

/// A config as text. Configs of the game are ASCII or a Windows code page,
/// and a byte outside UTF-8 becomes the replacement character rather than
/// a refusal: the dialog shows the file, it does not run it.
fn text_of(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The listing of a pk3 of a draft.
#[tauri::command]
pub async fn draft_file_listing(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    scope: String,
    root: FileRoot,
    path: String,
) -> Result<Listing> {
    draft_listing(&state.paths()?, &draft_id, scope.trim(), root, path.trim()).await
}

/// The listing of a pk3 of the catalogue, by the hash of the listing the
/// manifest names.
#[tauri::command]
pub async fn bundle_file_listing(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    sha256: String,
) -> Result<Listing> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    bundle_listing(&state.paths()?, &online, &ctx, sha256.trim()).await
}

/// The text of a cfg file of a draft.
#[tauri::command]
pub fn draft_file_text(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    scope: String,
    root: FileRoot,
    path: String,
) -> Result<String> {
    draft_text(&state.paths()?, &draft_id, scope.trim(), root, path.trim())
}

/// The text of a cfg file of the catalogue, by its hash and its manifest
/// path: the path decides whether the file is text at all, the way
/// `draft_file_text` decides by the path of the file of the draft.
#[tauri::command]
pub async fn bundle_file_text(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    sha256: String,
    path: String,
) -> Result<String> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    bundle_text(&state.paths()?, &online, &ctx, sha256.trim(), path.trim()).await
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;
    use crate::bundles::draft::test_support::{component, empty_draft, put_draft_file};
    use crate::bundles::draft::DraftOrigin;
    use crate::engines::LaunchMode;
    use crate::game::Game;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        fs::create_dir_all(path.parent().expect("a parent")).expect("the parent folder");
        let file = fs::File::create(path).expect("the archive is created");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, body) in entries {
            if name.ends_with('/') {
                writer.add_directory(name.trim_end_matches('/'), options).expect("a folder");
                continue;
            }
            writer.start_file(*name, options).expect("an entry starts");
            writer.write_all(body).expect("the entry is written");
        }
        writer.finish().expect("the archive is closed");
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(future)
    }

    #[test]
    fn a_listing_names_every_file_sorted_by_path_with_its_size_and_no_folders() {
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("skin.pk3");
        write_zip(
            &archive,
            &[
                ("sound/chars/reborn/misc/taunt.mp3", b"taunt taunt" as &[u8]),
                ("models/players/reborn/", b""),
                ("models/players/reborn/model.glm", b"geometry"),
                ("models\\players\\reborn\\icon_default.jpg", b"jpg"),
                ("README.txt", b"read me"),
            ],
        );
        let listing = read_listing(&archive).expect("the archive lists");
        assert_eq!(listing.schema, SCHEMA);
        let names: Vec<(&str, u64)> = listing
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.size))
            .collect();
        assert_eq!(
            names,
            [
                ("README.txt", 7),
                ("models/players/reborn/icon_default.jpg", 3),
                ("models/players/reborn/model.glm", 8),
                ("sound/chars/reborn/misc/taunt.mp3", 11),
            ]
        );

        // The document is compact, in field order, and reads back the same.
        let bytes = encode(&listing).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.starts_with(r#"{"schema":1,"entries":[{"path":"README.txt","size":7}"#), "{text}");
        assert_eq!(decode(&bytes).unwrap(), listing);
        assert_eq!(encode(&read_listing(&archive).unwrap()).unwrap(), bytes, "the same archive, the same bytes");
        let other_schema = br#"{"schema":2,"entries":[]}"#;
        assert!(matches!(decode(other_schema).unwrap_err(), AppError::BundleUnavailable(_)));

        let sums = Listing::of(listing);
        assert_eq!(sums.total, 4);
        assert_eq!(sums.bytes, 7 + 3 + 8 + 11);
        let json = serde_json::to_value(&sums).unwrap();
        assert_eq!(json["entries"][0]["path"], "README.txt");
        assert_eq!(json["total"], 4);
        assert_eq!(json["bytes"], 29);

        // Not an archive at all.
        let text_file = temp.path().join("notes.pk3");
        fs::write(&text_file, b"not a zip").unwrap();
        assert!(read_listing(&text_file).is_err());
    }

    #[test]
    fn the_listing_of_an_old_draft_is_built_on_demand_and_remembered() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().unwrap();
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "eternaljk", &[LaunchMode::Multiplayer]));
        // A pk3 written the way the second edition wrote one: copied into
        // `files\`, described, and without a listing.
        let mut pk3 = Vec::new();
        {
            let mut writer = ZipWriter::new(std::io::Cursor::new(&mut pk3));
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            writer.start_file("maps/mp/duel_x.bsp", options).unwrap();
            writer.write_all(b"map bytes").unwrap();
            writer.start_file("levelshots/duel_x.jpg", options).unwrap();
            writer.write_all(b"jpg").unwrap();
            writer.finish().unwrap();
        }
        let file = put_draft_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "base/duel_x.pk3",
            &pk3,
            DraftOrigin::Disk {
                source_path: "D:/duel_x.pk3".into(),
            },
        );
        assert_eq!(file.listing, None);
        let cfg = put_draft_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "base/autoexec.cfg",
            b"seta cg_fov 97\r\nbind x +attack\n",
            DraftOrigin::Disk {
                source_path: "D:/autoexec.cfg".into(),
            },
        );
        draft.components[0].files.push(file.clone());
        draft.components[0].files.push(cfg);
        draft::write_draft(&paths, &draft).unwrap();
        assert!(!paths.bundle_draft_listings_dir(&draft.id).exists());

        let listing = run(draft_listing(&paths, &draft.id, "mp", FileRoot::Home, "BASE/duel_x.pk3")).expect("built on demand");
        assert_eq!(listing.total, 2);
        assert_eq!(listing.entries[0].path, "levelshots/duel_x.jpg");
        assert_eq!(listing.entries[1].path, "maps/mp/duel_x.bsp");
        assert_eq!(listing.bytes, 3 + 9);
        let document = draft_listing_path(&paths, &draft.id, &file.sha256);
        assert!(document.is_file(), "the document is written under the hash of the pk3");
        let bytes = fs::read(&document).unwrap();
        let record = draft::read_draft(&paths, &draft.id).unwrap();
        let remembered = record.components[0].files[0].listing.clone().expect("the record remembers");
        assert_eq!(remembered.sha256, sha256_hex(&bytes));
        assert_eq!(remembered.size, bytes.len() as u64);
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["components"][0]["files"][0]["listing"]["size"], bytes.len());
        assert!(json["components"][0]["files"][1].get("listing").is_none(), "a cfg has none");

        // The second read comes from the document, and the map of hashes
        // finds it for the upload.
        let again = run(draft_listing(&paths, &draft.id, "mp", FileRoot::Home, "base/duel_x.pk3")).unwrap();
        assert_eq!(again, listing);
        let map = listings_by_hash(&paths, &record);
        assert_eq!(map.get(&remembered.sha256), Some(&document));

        // The manifest carries it on the pk3 and on nothing else.
        let manifest = draft::manifest_of(&record);
        manifest::validate(&manifest).expect("valid");
        assert_eq!(manifest.components[0].files[0].listing, Some(remembered.clone()));
        assert_eq!(manifest.components[0].files[1].listing, None);
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["components"][0]["files"][0]["listing"]["sha256"], remembered.sha256);

        // A cfg has no listing but has a text; a pk3 the other way round.
        let error = run(draft_listing(&paths, &draft.id, "mp", FileRoot::Home, "base/autoexec.cfg")).unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        assert_eq!(
            draft_text(&paths, &draft.id, "mp", FileRoot::Home, "base/autoexec.cfg").unwrap(),
            "seta cg_fov 97\r\nbind x +attack\n"
        );
        assert!(matches!(
            draft_text(&paths, &draft.id, "mp", FileRoot::Home, "base/duel_x.pk3").unwrap_err(),
            AppError::InvalidInput(_)
        ));
        assert!(matches!(
            draft_text(&paths, &draft.id, "shared", FileRoot::Home, "base/autoexec.cfg").unwrap_err(),
            AppError::NotFound(_)
        ));
        assert!(matches!(
            run(draft_listing(&paths, &draft.id, "sp", FileRoot::Home, "base/duel_x.pk3")).unwrap_err(),
            AppError::NotFound(_)
        ));

        // A listing nothing refers to any more is pruned.
        let mut without = record.clone();
        without.components[0].files.remove(0);
        prune_draft_listings(&paths, &without);
        assert!(!document.exists());

        // A publish gives the pk3 its document back, with the same hash, and
        // a record of the second edition (no `listing` at all) gets one too.
        let ensured = run(ensure_listings(&paths, record.clone())).expect("ensured");
        assert!(document.is_file());
        assert_eq!(ensured.components[0].files[0].listing, Some(remembered.clone()));
        let mut second_edition = record.clone();
        second_edition.components[0].files[0].listing = None;
        draft::write_draft(&paths, &second_edition).unwrap();
        fs::remove_file(&document).unwrap();
        let ensured = run(ensure_listings(&paths, second_edition)).expect("ensured");
        assert_eq!(ensured.components[0].files[0].listing, Some(remembered.clone()));
        assert_eq!(draft::read_draft(&paths, &draft.id).unwrap(), ensured);
        assert!(document.is_file());
        // Nothing to do leaves the record alone.
        let stamp = ensured.updated_at.clone();
        let same = run(ensure_listings(&paths, ensured)).expect("nothing to build");
        assert_eq!(same.updated_at, stamp);
    }

    #[test]
    fn a_config_with_bytes_outside_utf8_is_shown_rather_than_refused() {
        assert_eq!(text_of(b"seta name \"\xCA\xE0\xE9\xEB\"\n"), "seta name \"\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}\"\n");
        assert!(check_text_size("x.cfg", MAX_TEXT_BYTES).is_ok());
        assert!(check_text_size("x.cfg", MAX_TEXT_BYTES + 1).is_err());
    }

    #[test]
    fn the_listing_of_a_long_archive_stops_at_the_limit_when_read_and_when_parsed() {
        // An archive that declares one file more than the limit, and a
        // folder entry in front of them that does not count.
        let temp = tempfile::tempdir().expect("a folder");
        let archive = temp.path().join("long.pk3");
        {
            let file = fs::File::create(&archive).unwrap();
            let mut writer = ZipWriter::new(std::io::BufWriter::new(file));
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            writer.add_directory("textures", options).unwrap();
            for index in 0..=MAX_ENTRIES {
                writer.start_file(format!("textures/{index:06}.jpg"), options).unwrap();
                writer.write_all(b"j").unwrap();
            }
            writer.finish().unwrap();
        }
        let listing = read_listing(&archive).expect("the archive lists");
        assert_eq!(listing.entries.len(), MAX_ENTRIES, "the walk stops at the limit");
        assert_eq!(listing.entries[0].path, "textures/000000.jpg");
        assert_eq!(listing.entries[MAX_ENTRIES - 1].path, format!("textures/{:06}.jpg", MAX_ENTRIES - 1));
        assert!(listing.entries.windows(2).all(|pair| pair[0].path < pair[1].path), "sorted");
        let bytes = encode(&listing).unwrap();
        assert_eq!(decode(&bytes).unwrap(), listing, "what was written reads back");

        // A document that did not come out of `read_listing`: one entry too
        // many is refused, whatever its size.
        let mut long = String::from(r#"{"schema":1,"entries":["#);
        for index in 0..=MAX_ENTRIES {
            if index > 0 {
                long.push(',');
            }
            long.push_str(&format!(r#"{{"path":"{index}","size":0}}"#));
        }
        long.push_str("]}");
        let error = decode(long.as_bytes()).expect_err("too many entries");
        assert!(matches!(error, AppError::BundleUnavailable(_)), "{error}");
        assert!(error.to_string().contains("50000 a listing may"), "{error}");
        // The document one entry shorter is fine.
        let exact = long.replacen(r#"{"path":"0","size":0},"#, "", 1);
        assert_eq!(decode(exact.as_bytes()).unwrap().entries.len(), MAX_ENTRIES);

        // A document over the byte limit is refused before it is parsed.
        let mut heavy = vec![b' '; MAX_LISTING_BYTES as usize + 1];
        heavy[0] = b'{';
        let error = decode(&heavy).expect_err("too big");
        assert!(matches!(error, AppError::BundleUnavailable(_)), "{error}");
        assert!(error.to_string().contains("16 MiB"), "{error}");

        // And the answer of a command holds at most the limit, whoever
        // built the document it was made from.
        let over = ListingFile {
            schema: SCHEMA,
            entries: (0..=MAX_ENTRIES)
                .map(|index| ListingEntry {
                    path: index.to_string(),
                    size: 1,
                })
                .collect(),
        };
        let answer = Listing::of(over);
        assert_eq!(answer.total, MAX_ENTRIES as u64);
        assert_eq!(answer.bytes, MAX_ENTRIES as u64);
        assert_eq!(answer.entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn only_a_text_file_is_read_as_text() {
        for path in ["base/autoexec.cfg", "base/README.txt", "README", "base/notes.md", "docs/changes.json"] {
            require_text(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        }
        for path in [
            "base/rus.pk3",
            "base/RUS.PK3",
            "cgamex86.dll",
            "eternaljk.x86.exe",
            "base/pack.zip",
            "vm/cgame.qvm",
            "levelshots/duel.jpg",
            "textures/x.png",
            "sound/x.wav",
            "maps/duel.bsp",
            "jknet.pdb",
        ] {
            let error = require_text(path).expect_err(path);
            assert!(matches!(error, AppError::InvalidInput(_)), "{path}: {error}");
        }

        // The command of the catalogue refuses by the path before it looks
        // at the cache or asks the store: no service answers at this address.
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: "http://203.0.113.1:1".into(),
            token: None,
        };
        let hash = "a".repeat(64);
        let error = run(bundle_text(&paths, &client, &ctx, &hash, "base/rus.pk3")).expect_err("a pk3 is not text");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        let error = run(bundle_text(&paths, &client, &ctx, &hash, "")).expect_err("a path is required");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        let error = run(bundle_text(&paths, &client, &ctx, "../x", "base/autoexec.cfg")).expect_err("a hash is required");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        assert!(!paths.bundle_preview_cache_dir().exists(), "nothing was written");
    }
}
