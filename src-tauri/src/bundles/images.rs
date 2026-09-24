//! The pictures of the description of a draft.
//!
//! A description is Markdown, and a picture in it is
//! `![caption](blob:<sha256>)`: the file itself sits in the store of the
//! service, addressed by its hash, and the catalogue resolves the scheme to
//! `GET /v1/blobs/<sha256>`. While the bundle is a draft, the same file lies
//! in `bundles\drafts\<draftId>\images\<sha256>.<ext>` of the data folder,
//! listed in `draft.json` as [`DraftImage`], and the editor shows it from
//! there through the asset protocol: `draft_image_path` hands the path out
//! and allows it in the scope, the way `levelshots` serves map pictures.
//! The scope opens the `images\` folder of a draft and nothing else of it:
//! `files\`, `listings\` and `draft.json` stay out of reach of the webview.
//!
//! A publish uploads the pictures the descriptions refer to before it
//! creates or updates the bundle, because the service checks every
//! `blob:` reference of a description when it takes the fields: the file
//! has to exist, be a picture and stay under 2 MiB. The same three rules are
//! applied here when a picture is added, so the refusal comes from the
//! dialog rather than from a `400` at the end of an upload. A description
//! exists per language, the main one and each translation, and the pictures
//! of every one of them count: [`Draft::image_refs`] gathers them.
//!
//! The type of a picture is read from its first bytes, not from its
//! extension, the way the service reads it: PNG, JPEG, GIF and WebP.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::online::{OnlineClient, OnlineContext};
use crate::paths::{self, DataPaths};
use crate::state::AppState;

use super::draft::{self, Draft};
use super::manifest;
use super::sha256_of;

/// Bytes one picture may have: `JKNET_ONLINE_BUNDLE_MAX_IMAGE_BYTES` at its
/// default.
pub const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024;

/// Pictures one description may refer to: `JKNET_ONLINE_BUNDLE_MAX_IMAGES`
/// at its default. A draft holds at most this many, so a description cannot
/// refer to more.
pub const MAX_IMAGES: usize = 20;

/// The scheme a description names a picture of the store by.
const BLOB_SCHEME: &str = "blob:";

/// Bytes read to tell the type of a picture: the longest signature is the
/// twelve bytes of WebP.
const SIGNATURE_BYTES: usize = 12;

/// One picture of the description, as `draft.json` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftImage {
    /// Lowercase hex: the name of the file in `images\` and in the store.
    pub sha256: String,
    pub size: u64,
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub content_type: String,
    /// The name of the file the author picked, for the editor to show.
    pub file_name: String,
}

/// The four kinds of picture the service takes, told apart by signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageType {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageType {
    /// The type the first bytes of a file announce, or `None` for anything
    /// that is not one of the four.
    pub fn detect(head: &[u8]) -> Option<ImageType> {
        if head.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            Some(ImageType::Png)
        } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(ImageType::Jpeg)
        } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
            Some(ImageType::Gif)
        } else if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
            Some(ImageType::Webp)
        } else {
            None
        }
    }

    /// The type a content type names, for a record read back from disk.
    pub fn of_content_type(content_type: &str) -> Option<ImageType> {
        match content_type {
            "image/png" => Some(ImageType::Png),
            "image/jpeg" => Some(ImageType::Jpeg),
            "image/gif" => Some(ImageType::Gif),
            "image/webp" => Some(ImageType::Webp),
            _ => None,
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            ImageType::Png => "image/png",
            ImageType::Jpeg => "image/jpeg",
            ImageType::Gif => "image/gif",
            ImageType::Webp => "image/webp",
        }
    }

    /// The extension of the copy in `images\`, which is what lets the
    /// webview pick a decoder for the asset URL.
    pub fn extension(self) -> &'static str {
        match self {
            ImageType::Png => "png",
            ImageType::Jpeg => "jpg",
            ImageType::Gif => "gif",
            ImageType::Webp => "webp",
        }
    }
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

/// The hashes a description refers to as `blob:<sha256>`, each once, in
/// lowercase, in the order of their first appearance.
///
/// The scan is by the scheme and the 64 hex digits after it rather than by
/// the Markdown around them: the service reads a description the same way
/// (`image_references`), and a reference outside an image tag is still a
/// file it will look for. The digits may come in either case, as the
/// service takes them, and are lowercased here as the service lowercases
/// them in the text it stores: a hash typed by hand in capitals names the
/// same picture. Anything else after `blob:` is prose.
pub(crate) fn description_refs(description: &str) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    let mut rest = description;
    while let Some(at) = rest.find(BLOB_SCHEME) {
        let after = &rest[at + BLOB_SCHEME.len()..];
        let digits = after.bytes().take_while(u8::is_ascii_hexdigit).count();
        if digits == 64 {
            let hash = after[..64].to_ascii_lowercase();
            debug_assert!(manifest::check_sha256(&hash).is_ok());
            if !refs.contains(&hash) {
                refs.push(hash);
            }
            rest = &after[64..];
        } else {
            rest = after;
        }
    }
    refs
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// Where the copy of a picture lies: `images\<sha256>.<ext>`.
pub(crate) fn image_path(paths: &DataPaths, draft_id: &str, sha256: &str, image_type: ImageType) -> PathBuf {
    paths
        .bundle_draft_images_dir(draft_id)
        .join(format!("{sha256}.{}", image_type.extension()))
}

/// The path of a listed picture, when its type is one this build knows.
fn listed_path(paths: &DataPaths, draft_id: &str, image: &DraftImage) -> Option<PathBuf> {
    ImageType::of_content_type(&image.content_type).map(|kind| image_path(paths, draft_id, &image.sha256, kind))
}

/// Reads the first bytes of a file and says what picture it is.
fn detect_file(source: &Path) -> Result<Option<ImageType>> {
    let mut file = fs::File::open(source).map_err(|e| AppError::io_path("cannot open", source, e))?;
    let mut head = [0u8; SIGNATURE_BYTES];
    let mut read = 0;
    while read < head.len() {
        let n = file
            .read(&mut head[read..])
            .map_err(|e| AppError::io_path("cannot read", source, e))?;
        if n == 0 {
            break;
        }
        read += n;
    }
    Ok(ImageType::detect(&head[..read]))
}

/// Refuses what the service would refuse: a file that is not a picture, or
/// one over the limit.
fn check_picture(source: &Path, size: u64) -> Result<ImageType> {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("the file");
    if size > MAX_IMAGE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{name} is bigger than the {} MiB a picture of the description may be",
            MAX_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    detect_file(source)?.ok_or_else(|| {
        AppError::InvalidInput(format!(
            "{name} is not a PNG, JPEG, GIF or WebP picture"
        ))
    })
}

/// Copies a picture into the draft and describes it. Blocking: the caller
/// runs it on a blocking thread.
fn import_image(paths: &DataPaths, draft_id: &str, source: &Path) -> Result<DraftImage> {
    let meta = fs::metadata(source).map_err(|e| AppError::io_path("cannot read", source, e))?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!("{} is not a file", source.display())));
    }
    let image_type = check_picture(source, meta.len())?;
    let sha256 = sha256_of(source)?;
    let target = image_path(paths, draft_id, &sha256, image_type);
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    if target != source {
        fs::copy(source, &target).map_err(|e| AppError::io_path("cannot copy into", &target, e))?;
    }
    Ok(DraftImage {
        sha256,
        size: meta.len(),
        content_type: image_type.content_type().to_string(),
        file_name: source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("picture")
            .to_string(),
    })
}

/// Adds a picture to a draft, or answers with the one it already holds
/// under the same hash.
pub(crate) async fn add_image(paths: &DataPaths, draft_id: &str, source: PathBuf) -> Result<DraftImage> {
    let draft = draft::read_draft(paths, draft_id)?;
    let full = || {
        AppError::InvalidInput(format!(
            "a description carries at most {MAX_IMAGES} pictures; remove one first"
        ))
    };
    if draft.images.len() >= MAX_IMAGES {
        return Err(full());
    }
    let (paths_for_copy, draft_for_copy) = (paths.clone(), draft_id.to_string());
    let imported = tauri::async_runtime::spawn_blocking(move || import_image(&paths_for_copy, &draft_for_copy, &source))
        .await
        .map_err(|e| AppError::State(format!("the file thread stopped: {e}")))??;
    if let Some(known) = draft.images.iter().find(|image| image.sha256 == imported.sha256) {
        return Ok(known.clone());
    }
    let mut added = imported.clone();
    let recorded = draft::edit_draft(paths, draft_id, |draft| {
        if let Some(known) = draft.images.iter().find(|image| image.sha256 == imported.sha256) {
            added = known.clone();
            return Ok(());
        }
        if draft.images.len() >= MAX_IMAGES {
            return Err(full());
        }
        draft.images.push(imported.clone());
        Ok(())
    });
    if let Err(e) = recorded {
        // The copy has no record to belong to.
        if let Some(path) = listed_path(paths, draft_id, &added) {
            let _ = fs::remove_file(path);
        }
        return Err(e);
    }
    Ok(added)
}

/// Takes a picture out of the draft and off the disk. The description is
/// left as it is: a reference to a picture that is gone is what
/// `validate_bundle_draft` reports as `imageMissing`.
pub(crate) fn remove_image(paths: &DataPaths, draft_id: &str, sha256: &str) -> Result<Draft> {
    manifest::check_sha256(sha256)?;
    let mut removed = None;
    let draft = draft::edit_draft(paths, draft_id, |draft| {
        let index = draft
            .images
            .iter()
            .position(|image| image.sha256 == sha256)
            .ok_or_else(|| AppError::NotFound(format!("picture {sha256} of the draft")))?;
        removed = Some(draft.images.remove(index));
        Ok(())
    })?;
    if let Some(path) = removed.as_ref().and_then(|image| listed_path(paths, draft_id, image)) {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("cannot remove {}: {e}", path.display()),
        }
    }
    Ok(draft)
}

/// The absolute path of a picture of the draft, for `convertFileSrc`.
pub(crate) fn path_of(paths: &DataPaths, draft_id: &str, sha256: &str) -> Result<PathBuf> {
    manifest::check_sha256(sha256)?;
    let draft = draft::read_draft(paths, draft_id)?;
    let image = draft
        .images
        .iter()
        .find(|image| image.sha256 == sha256)
        .ok_or_else(|| AppError::NotFound(format!("picture {sha256} of the draft")))?;
    let path = listed_path(paths, draft_id, image)
        .filter(|path| path.is_file())
        .ok_or_else(|| AppError::NotFound(format!("the file of picture {sha256} of the draft")))?;
    Ok(path)
}

/// Lets the webview read the pictures of one draft through the asset
/// protocol: its `images\` folder, without subfolders, and nothing else of
/// the draft.
///
/// The static scope in `tauri.conf.json` covers
/// `$APPLOCALDATA/bundles/drafts/*/images/**`, which is where the folder is
/// unless the player set `dataDirOverride`; this adds the resolved folder
/// of the draft the editor is showing, the way `levelshots::allow_cache_folder`
/// adds the cache of map pictures: one folder that holds pictures alone, not
/// recursive. It runs when a picture is added or asked for, because
/// `allow_directory` escapes a `*` in a path rather than matching by it,
/// so the folders of every draft cannot be allowed in one pattern. The path
/// handed out by `draft_image_path` is allowed by itself as well, for the
/// reason `levelshots::allow_picture` gives: a folder pattern and a file
/// are canonicalised separately, and only the file cannot disagree with
/// itself.
fn allow_images_folder(app: &AppHandle, paths: &DataPaths, draft_id: &str) {
    use tauri::Manager;

    let dir = paths.bundle_draft_images_dir(draft_id);
    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, false) {
        log::warn!("cannot serve {}: {e}", dir.display());
    }
}

/// Lets the webview read one picture, by the very path it is handed.
fn allow_picture(app: &AppHandle, path: &Path) {
    use tauri::Manager;

    if let Err(e) = app.asset_protocol_scope().allow_file(path) {
        log::warn!("cannot serve {}: {e}", path.display());
    }
}

// ---------------------------------------------------------------------------
// A draft out of a bundle
// ---------------------------------------------------------------------------

/// Downloads the pictures the descriptions refer to into the `images\`
/// folder of a draft, and answers with their records. `refs` is what
/// [`Draft::image_refs`] gathers out of the description of every language,
/// each hash once.
///
/// A reference the store does not hold, or one that is not a picture, is
/// skipped with a line in the log: the description keeps the reference, and
/// `validate_bundle_draft` reports it as `imageMissing`, so the author sees
/// which picture to put back. `report` hears the index and count of the
/// picture being fetched.
pub(crate) async fn fetch_images(
    online: &OnlineClient,
    ctx: &OnlineContext,
    paths: &DataPaths,
    draft_id: &str,
    refs: &[String],
    report: &mut (dyn FnMut(u32, u32, &str) + Send),
) -> Result<Vec<DraftImage>> {
    let count = refs.len() as u32;
    let mut images = Vec::with_capacity(refs.len());
    for (index, sha256) in refs.iter().enumerate() {
        report(index as u32 + 1, count, sha256);
        match fetch_image(online, ctx, paths, draft_id, sha256).await {
            Ok(image) => images.push(image),
            Err(e) => log::warn!("bundles: picture {sha256} of the description is left out: {e}"),
        }
    }
    Ok(images)
}

/// Downloads one picture of the store into the draft.
async fn fetch_image(
    online: &OnlineClient,
    ctx: &OnlineContext,
    paths: &DataPaths,
    draft_id: &str,
    sha256: &str,
) -> Result<DraftImage> {
    let response = online.get_blob(ctx, sha256, 0).await?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IMAGE_BYTES)
    {
        return Err(AppError::InvalidInput(format!(
            "{sha256} is bigger than the {} MiB a picture may be",
            MAX_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("the download stopped: {e}")))?;
        if bytes.len() as u64 + chunk.len() as u64 > MAX_IMAGE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "{sha256} is bigger than the {} MiB a picture may be",
                MAX_IMAGE_BYTES / (1024 * 1024)
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    let image_type = ImageType::detect(&bytes)
        .ok_or_else(|| AppError::InvalidInput(format!("{sha256} is not a PNG, JPEG, GIF or WebP picture")))?;
    let actual = super::sha256_hex(&bytes);
    if actual != sha256 {
        return Err(AppError::BundleFile {
            path: sha256.to_string(),
            reason: "the fetched picture does not match its hash".into(),
        });
    }
    let target = image_path(paths, draft_id, sha256, image_type);
    if let Some(parent) = target.parent() {
        paths::create_dir(parent)?;
    }
    fs::write(&target, &bytes).map_err(|e| AppError::io_path("cannot write", &target, e))?;
    Ok(DraftImage {
        sha256: sha256.to_string(),
        size: bytes.len() as u64,
        content_type: image_type.content_type().to_string(),
        file_name: format!("{}.{}", &sha256[..12], image_type.extension()),
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Copies a picture picked on disk into the draft, and opens the `images\`
/// folder of the draft to the webview. The same picture added again answers
/// with the record it already has.
#[tauri::command]
pub async fn draft_add_image(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    draft_id: String,
    source_path: String,
) -> Result<DraftImage> {
    let source = PathBuf::from(source_path.trim());
    if source.as_os_str().is_empty() {
        return Err(AppError::InvalidInput("no picture was picked".into()));
    }
    let paths = state.paths()?;
    let image = add_image(&paths, &draft_id, source).await?;
    allow_images_folder(&app, &paths, &draft_id);
    Ok(image)
}

/// Takes a picture out of the draft.
#[tauri::command]
pub fn draft_remove_image(
    state: tauri::State<'_, AppState>,
    draft_id: String,
    sha256: String,
) -> Result<Draft> {
    remove_image(&state.paths()?, &draft_id, sha256.trim())
}

/// The absolute path of a picture of the draft, allowed for the asset
/// protocol together with the `images\` folder it lies in, for the editor
/// to show through `convertFileSrc`.
#[tauri::command]
pub fn draft_image_path(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    draft_id: String,
    sha256: String,
) -> Result<String> {
    let paths = state.paths()?;
    let path = path_of(&paths, &draft_id, sha256.trim())?;
    allow_images_folder(&app, &paths, &draft_id);
    allow_picture(&app, &path);
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundles::draft::test_support::empty_draft;
    use crate::bundles::test_support::sha256_hex;
    use crate::game::Game;

    /// The smallest bytes each decoder would call a picture, for a test
    /// that only reads signatures.
    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(b"IHDR....");
        bytes
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(future)
    }

    #[test]
    fn the_four_picture_types_are_told_by_their_first_bytes() {
        assert_eq!(ImageType::detect(&png()), Some(ImageType::Png));
        assert_eq!(ImageType::detect(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]), Some(ImageType::Jpeg));
        assert_eq!(ImageType::detect(b"GIF89a\x01\x00"), Some(ImageType::Gif));
        assert_eq!(ImageType::detect(b"GIF87a\x01\x00"), Some(ImageType::Gif));
        assert_eq!(ImageType::detect(b"RIFF\x24\x00\x00\x00WEBPVP8 "), Some(ImageType::Webp));
        assert_eq!(ImageType::detect(b"RIFF\x24\x00\x00\x00WAVEfmt "), None, "a wave file is RIFF too");
        assert_eq!(ImageType::detect(b"PK\x03\x04"), None);
        assert_eq!(ImageType::detect(b""), None);
        assert_eq!(ImageType::detect(b"RIFF"), None, "too short to be WebP");
        assert_eq!(ImageType::Jpeg.extension(), "jpg");
        assert_eq!(ImageType::of_content_type("image/webp"), Some(ImageType::Webp));
        assert_eq!(ImageType::of_content_type("text/plain"), None);
    }

    #[test]
    fn the_references_of_a_description_are_the_hashes_behind_the_scheme_lowercased() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let text = format!(
            "# Title\n\n![shot](blob:{a}) and again ![shot](blob:{a})\n\nblob:{b}\nblob:{} blob:{}\n",
            "C".repeat(64),
            "d".repeat(63)
        );
        // A hash typed in capitals is the same picture, the way the service
        // reads it; 63 digits are prose.
        assert_eq!(description_refs(&text), [a.clone(), b, c.clone()]);
        let mixed = format!("![x](blob:{}{}) blob:{}", "A".repeat(32), "b".repeat(32), "C".repeat(64));
        assert_eq!(description_refs(&mixed), [format!("{}{}", "a".repeat(32), "b".repeat(32)), c]);
        // 65 digits are not a hash either, and the scan goes on behind them.
        assert_eq!(description_refs(&format!("blob:{}e blob:{a}", "f".repeat(64))), [a]);
        assert!(description_refs("no pictures here").is_empty());
        assert!(description_refs("blob:").is_empty());
        assert!(description_refs("blob:blob:").is_empty());
    }

    #[test]
    fn a_picture_is_copied_once_and_what_is_not_a_picture_is_refused() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        let draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        let picked = temp.path().join("picked");
        fs::create_dir_all(&picked).unwrap();
        let shot = picked.join("shot.png");
        fs::write(&shot, png()).unwrap();

        let image = run(add_image(&paths, &draft.id, shot.clone())).expect("the picture is added");
        assert_eq!(image.sha256, sha256_hex(&png()));
        assert_eq!(image.size, png().len() as u64);
        assert_eq!(image.content_type, "image/png");
        assert_eq!(image.file_name, "shot.png");
        let copy = image_path(&paths, &draft.id, &image.sha256, ImageType::Png);
        assert_eq!(fs::read(&copy).unwrap(), png());
        let record = draft::read_draft(&paths, &draft.id).unwrap();
        assert_eq!(record.images, std::slice::from_ref(&image));
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["images"][0]["contentType"], "image/png");
        assert_eq!(json["images"][0]["fileName"], "shot.png");

        // The same bytes under another name: the record already there.
        let again = picked.join("renamed.png");
        fs::write(&again, png()).unwrap();
        let repeated = run(add_image(&paths, &draft.id, again)).expect("the repeat is taken");
        assert_eq!(repeated, image);
        assert_eq!(draft::read_draft(&paths, &draft.id).unwrap().images.len(), 1);

        // The path for the editor.
        assert_eq!(path_of(&paths, &draft.id, &image.sha256).unwrap(), copy);
        assert!(matches!(path_of(&paths, &draft.id, &"0".repeat(64)).unwrap_err(), AppError::NotFound(_)));
        assert!(matches!(path_of(&paths, &draft.id, "../x").unwrap_err(), AppError::InvalidInput(_)));

        // Not a picture, and too big a picture.
        let text = picked.join("notes.png");
        fs::write(&text, b"just text").unwrap();
        let error = run(add_image(&paths, &draft.id, text)).expect_err("text is refused");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        assert!(error.to_string().contains("not a PNG"), "{error}");
        let big = picked.join("big.png");
        let mut bytes = png();
        bytes.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        fs::write(&big, &bytes).unwrap();
        let error = run(add_image(&paths, &draft.id, big)).expect_err("too big");
        assert!(error.to_string().contains("bigger"), "{error}");
        assert_eq!(draft::read_draft(&paths, &draft.id).unwrap().images.len(), 1);

        // The twenty-first picture is refused before it is copied.
        let mut full = draft::read_draft(&paths, &draft.id).unwrap();
        for i in 0..MAX_IMAGES {
            full.images.push(DraftImage {
                sha256: format!("{i:064x}"),
                size: 1,
                content_type: "image/png".into(),
                file_name: format!("{i}.png"),
            });
        }
        draft::write_draft(&paths, &full).unwrap();
        let extra = picked.join("extra.png");
        let mut bytes = png();
        bytes.push(7);
        fs::write(&extra, &bytes).unwrap();
        let error = run(add_image(&paths, &draft.id, extra)).expect_err("full");
        assert!(error.to_string().contains("at most"), "{error}");
        assert!(!image_path(&paths, &draft.id, &sha256_hex(&bytes), ImageType::Png).exists());
        full.images.truncate(1);
        draft::write_draft(&paths, &full).unwrap();

        // Removal takes the copy with it; a hash that is not there is not found.
        let after = remove_image(&paths, &draft.id, &image.sha256).expect("removed");
        assert!(after.images.is_empty());
        assert!(!copy.exists());
        assert!(matches!(
            remove_image(&paths, &draft.id, &image.sha256).unwrap_err(),
            AppError::NotFound(_)
        ));
    }
}
