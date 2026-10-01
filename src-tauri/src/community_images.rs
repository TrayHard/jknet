//! The logo and the cover of a community and the cover of an event, picked
//! on disk and put in the store of JKNet Online.
//!
//! The webview never names a path: the core opens the system dialog, reads
//! the file and checks it the way the service will when the picture is bound
//! to the community (`PUT communities/{id}/images`) or to an event
//! (`POST communities/{id}/events`, `PUT events/{id}`): PNG, JPEG or WebP
//! by its first bytes, a logo up to 1 MiB and either cover up to 3 MiB. A
//! picture that passes loses what a JPEG or a PNG records about where and
//! when it was taken, as a picture sent to chat does, is hashed with SHA-256
//! and goes up with `PUT /v1/blobs/{sha256}`, unless `HEAD` says the store
//! holds it already. The webview gets the hash back and binds it through the
//! bridge of `crate::community`.
//!
//! A cancelled dialog and a refused file are answers, not errors: the screen
//! says them in the player's language. A failure of the upload is an error.
//!
//! A picture can also be dropped on its tile. Tauri hands the webview the
//! paths and the position of a drop, never the bytes, so the screen names
//! the dropped file to `community_drop_image`, which reads it only when it is
//! a file of the last drop on that window ([`DropState`]) and then checks
//! and uploads it as a picked one.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::bundles::images::ImageType;
use crate::error::{AppError, Result};
use crate::online::{OnlineClient, OnlineContext};
use crate::state::AppState;

const MIB: u64 = 1024 * 1024;

/// The extensions the dialog offers: the three types the service takes.
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];

/// The pictures the screens put in the store: the two of a community, where
/// `banner` is the cover of its page, and the cover of an event. A kind the
/// service has no picture of does not deserialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageKind {
    Logo,
    Banner,
    Cover,
}

impl ImageKind {
    /// The most bytes the service binds as this picture: its
    /// `community/images.rs` for a community, `community/events` for an event.
    pub fn max_bytes(self) -> u64 {
        match self {
            ImageKind::Logo => MIB,
            ImageKind::Banner | ImageKind::Cover => 3 * MIB,
        }
    }
}

/// Why a picked file is not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    TooBig,
    NotPicture,
}

/// A picture in the store, ready to bind to a community.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedImage {
    /// Lowercase hex: the address of the picture in the store.
    pub sha256: String,
    /// Bytes, as stored: after the metadata went.
    pub size: u64,
    /// The name of the file the organizer picked.
    pub file_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// What the dialog came back with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum PickedImage {
    Cancelled,
    #[serde(rename_all = "camelCase")]
    Refused {
        reason: Refusal,
        file_name: String,
        /// The limit a file over it passed; only for `tooBig`.
        #[serde(skip_serializing_if = "Option::is_none")]
        max_bytes: Option<u64>,
    },
    Uploaded(UploadedImage),
}

/// A picture that passed the checks: the bytes to upload and what the screen shows of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picture {
    pub bytes: Vec<u8>,
    pub image: UploadedImage,
}

fn too_big(file_name: &str, kind: ImageKind) -> PickedImage {
    PickedImage::Refused {
        reason: Refusal::TooBig,
        file_name: file_name.to_string(),
        max_bytes: Some(kind.max_bytes()),
    }
}

fn not_picture(file_name: &str) -> PickedImage {
    PickedImage::Refused {
        reason: Refusal::NotPicture,
        file_name: file_name.to_string(),
        max_bytes: None,
    }
}

/// The name a refusal shows: the last part of the path, or all of it.
fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Checks the bytes of a picked file as the service will, and prepares them:
/// the metadata of a JPEG or a PNG stripped, the hash and the size of what
/// is left. Pure: the tests call it with bytes of their own.
pub fn prepare(
    file_name: &str,
    bytes: Vec<u8>,
    kind: ImageKind,
) -> std::result::Result<Picture, PickedImage> {
    if bytes.len() as u64 > kind.max_bytes() {
        return Err(too_big(file_name, kind));
    }
    match ImageType::detect(&bytes) {
        Some(ImageType::Png | ImageType::Jpeg | ImageType::Webp) => {}
        // The service binds no GIF, and anything else is not a picture.
        Some(ImageType::Gif) | None => return Err(not_picture(file_name)),
    }
    let bytes = crate::chat::files::strip_metadata(&bytes).unwrap_or(bytes);
    let size = crate::chat::files::picture_size(&bytes);
    Ok(Picture {
        image: UploadedImage {
            sha256: crate::bundles::sha256_hex(&bytes),
            size: bytes.len() as u64,
            file_name: file_name.to_string(),
            width: size.map(|(width, _)| width),
            height: size.map(|(_, height)| height),
        },
        bytes,
    })
}

/// Reads a picked file, at most one byte past the limit: a file over it is
/// refused without reading the rest. Blocking: the caller runs it on a
/// blocking thread.
fn read_picked(path: &Path, kind: ImageKind) -> Result<std::result::Result<Picture, PickedImage>> {
    let file_name = file_name_of(path);
    let meta = std::fs::metadata(path).map_err(|e| AppError::io_path("cannot read", path, e))?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!(
            "{} is not a file",
            path.display()
        )));
    }
    if meta.len() > kind.max_bytes() {
        return Ok(Err(too_big(&file_name, kind)));
    }
    let file = std::fs::File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(kind.max_bytes() + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::io_path("cannot read", path, e))?;
    Ok(prepare(&file_name, bytes, kind))
}

/// Reads a dropped file as a picked one when it is a regular file. A drop
/// may carry a folder, and a path may be a link or a device: none of them is
/// a picture, and the screen says so as it does of any other file. Blocking,
/// as `read_picked` is.
fn read_dropped(path: &Path, kind: ImageKind) -> Result<std::result::Result<Picture, PickedImage>> {
    let meta =
        std::fs::symlink_metadata(path).map_err(|e| AppError::io_path("cannot read", path, e))?;
    if !meta.file_type().is_file() {
        return Ok(Err(not_picture(&file_name_of(path))));
    }
    read_picked(path, kind)
}

/// How long the files of a drop stay open to `community_drop_image`. The
/// screen asks at once; a file dropped and never asked for closes again.
const DROP_WINDOW: Duration = Duration::from_secs(60);

/// The drops of files on the windows, as the window event of `lib.rs` sees
/// them, and the claims of their screens.
///
/// `community_drop_image` reads a path only when it is a file of the last
/// drop on the window that asks, once, within [`DROP_WINDOW`]: a script in
/// the page cannot name any other file of the disk and put it in the public
/// store. A screen claims the drop while a drag is over a picture's tile, so
/// the chat composer of the same window does not take the file too.
#[derive(Default)]
pub struct DropState {
    windows: Mutex<HashMap<String, WindowDrop>>,
}

#[derive(Debug, Default)]
struct WindowDrop {
    /// The screen has a picture's tile under the drag.
    claimed: bool,
    /// The files of the last drop not yet read.
    files: Vec<PathBuf>,
    /// When that drop came.
    at: Option<Instant>,
}

impl DropState {
    /// A poisoned lock answers with the value in it: a claim or a list of
    /// paths is never half written.
    fn windows(&self) -> MutexGuard<'_, HashMap<String, WindowDrop>> {
        self.windows.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The screen of a window says whether a drop now lands on a picture's tile.
    pub fn claim(&self, label: &str, claimed: bool) {
        self.windows()
            .entry(label.to_string())
            .or_default()
            .claimed = claimed;
    }

    /// Files were dropped on a window: they become the ones the drop command
    /// may read, and the claim ends with the drop. Answers whether the
    /// screen claimed it.
    pub fn dropped(&self, label: &str, paths: &[PathBuf], now: Instant) -> bool {
        let mut windows = self.windows();
        let window = windows.entry(label.to_string()).or_default();
        window.files = paths.to_vec();
        window.at = Some(now);
        std::mem::take(&mut window.claimed)
    }

    /// The drag left the window without a drop: no claim outlives it.
    pub fn left(&self, label: &str) {
        if let Some(window) = self.windows().get_mut(label) {
            window.claimed = false;
        }
    }

    /// Takes one file of the last drop on a window while it is recent.
    /// Answers whether `path` was one.
    fn take(&self, label: &str, path: &Path, now: Instant) -> bool {
        let mut windows = self.windows();
        let Some(window) = windows.get_mut(label) else {
            return false;
        };
        let recent = window
            .at
            .is_some_and(|at| now.saturating_duration_since(at) <= DROP_WINDOW);
        if !recent {
            window.files.clear();
            return false;
        }
        match window.files.iter().position(|file| file == path) {
            Some(index) => {
                window.files.swap_remove(index);
                true
            }
            None => false,
        }
    }

    /// A closed window takes its drop with it.
    pub fn forget(&self, label: &str) {
        self.windows().remove(label);
    }
}

/// The window event of a drop, before anything else sees it: see
/// [`DropState`]. Answers whether a picture's tile claimed it.
pub fn dropped(app: &AppHandle, label: &str, paths: &[PathBuf]) -> bool {
    app.try_state::<DropState>()
        .is_some_and(|drops| drops.dropped(label, paths, Instant::now()))
}

/// The window event of a drag that left the window: the claim goes.
pub fn drag_left(app: &AppHandle, label: &str) {
    if let Some(drops) = app.try_state::<DropState>() {
        drops.left(label);
    }
}

/// The window event of a closed window.
pub fn forget_window(app: &AppHandle, label: &str) {
    if let Some(drops) = app.try_state::<DropState>() {
        drops.forget(label);
    }
}

/// Puts the picture in the store, unless the store holds it already.
async fn upload(online: &OnlineClient, ctx: &OnlineContext, picture: &Picture) -> Result<()> {
    let sha256 = &picture.image.sha256;
    if online.head_blob(ctx, sha256).await? {
        log::info!("community picture {sha256} is in the store already");
        return Ok(());
    }
    let receipt = online
        .put_blob(
            ctx,
            sha256,
            picture.bytes.len() as u64,
            reqwest::Body::from(picture.bytes.clone()),
        )
        .await?;
    log::info!(
        "uploaded community picture {} ({} bytes)",
        receipt.sha256,
        receipt.size
    );
    Ok(())
}

/// The session a picture goes up with; a guest is refused before any dialog.
fn signed_in(state: &AppState) -> Result<OnlineContext> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    if !ctx.signed_in() {
        return Err(AppError::Online {
            code: "unauthorized".into(),
            message: "Sign in to JKNet Online first.".into(),
        });
    }
    Ok(ctx)
}

/// Reads a file on a blocking thread, then uploads what passed the checks.
async fn read_and_upload(
    online: &OnlineClient,
    ctx: &OnlineContext,
    read: impl FnOnce() -> Result<std::result::Result<Picture, PickedImage>> + Send + 'static,
) -> Result<PickedImage> {
    let prepared = tauri::async_runtime::spawn_blocking(read)
        .await
        .map_err(|e| AppError::State(format!("reading the picture did not finish: {e}")))??;
    let picture = match prepared {
        Ok(picture) => picture,
        Err(refused) => return Ok(refused),
    };
    upload(online, ctx, &picture).await?;
    Ok(PickedImage::Uploaded(picture.image))
}

/// The system dialog for a logo or a cover of a community or the cover of an
/// event, over the window that asked; the picture goes to the store of the
/// service. `title` and `filter` are the
/// dialog's words in the player's language.
#[tauri::command]
pub async fn community_pick_image(
    app: AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    kind: ImageKind,
    title: String,
    filter: String,
) -> Result<PickedImage> {
    let ctx = signed_in(&state)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title(title.trim())
        .add_filter(filter.trim(), EXTENSIONS)
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(PickedImage::Cancelled);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::InvalidInput(format!("the picked file has no path: {e}")))?;
    read_and_upload(&online, &ctx, move || read_picked(&path, kind)).await
}

/// The screen of the window that asks says whether a drop now would land on
/// a picture's tile; see [`DropState`].
#[tauri::command]
pub fn community_claim_drop(
    window: tauri::Window,
    drops: tauri::State<'_, DropState>,
    claimed: bool,
) {
    drops.claim(window.label(), claimed);
}

/// A logo or a cover of a community or the cover of an event, dropped on its
/// tile. `path` has to be a file of the last drop on the window that asks
/// ([`DropState`]); it is checked, stripped and uploaded as a picked file is,
/// and a folder or a link is refused as not a picture. Never `cancelled`.
#[tauri::command]
pub async fn community_drop_image(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    drops: tauri::State<'_, DropState>,
    kind: ImageKind,
    path: PathBuf,
) -> Result<PickedImage> {
    let ctx = signed_in(&state)?;
    if !drops.take(window.label(), &path, Instant::now()) {
        return Err(AppError::InvalidInput(format!(
            "{} was not dropped on this window",
            path.display()
        )));
    }
    read_and_upload(&online, &ctx, move || read_dropped(&path, kind)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::files::test_support::{jpeg_with_gps, GPS_RATIONALS};
    use std::io::Cursor;

    fn encoded(format: image::ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let picture = image::RgbImage::from_pixel(width, height, image::Rgb([34, 184, 240]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(picture)
            .write_to(&mut Cursor::new(&mut bytes), format)
            .expect("encode");
        bytes
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    /// The head of a lossless WebP: what the type and the size are read from.
    /// The launcher's `image` has no WebP encoder, and the checks need no more.
    fn webp(width: u32, height: u32) -> Vec<u8> {
        let bits = (width - 1) | ((height - 1) << 14);
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&17u32.to_le_bytes());
        bytes.extend_from_slice(b"WEBPVP8L");
        bytes.extend_from_slice(&5u32.to_le_bytes());
        bytes.push(0x2F);
        bytes.extend_from_slice(&bits.to_le_bytes());
        bytes
    }

    #[test]
    fn the_three_types_the_service_binds_pass_with_their_size_and_hash() {
        for (bytes, name) in [
            (encoded(image::ImageFormat::Png, 64, 32), "logo.png"),
            (encoded(image::ImageFormat::Jpeg, 64, 32), "logo.jpg"),
            (webp(64, 32), "logo.webp"),
        ] {
            let picture = prepare(name, bytes, ImageKind::Logo)
                .unwrap_or_else(|refused| panic!("{name}: {refused:?}"));
            assert_eq!(picture.image.file_name, name);
            assert_eq!(picture.image.size, picture.bytes.len() as u64);
            assert_eq!(
                picture.image.sha256,
                crate::bundles::sha256_hex(&picture.bytes),
                "{name}"
            );
            assert_eq!(
                (picture.image.width, picture.image.height),
                (Some(64), Some(32)),
                "{name}"
            );
        }
    }

    #[test]
    fn a_gif_or_what_is_not_a_picture_is_refused() {
        let gif = b"GIF89a\x08\x00\x08\x00\x00\x00\x00;".to_vec();
        for (name, bytes) in [
            ("anim.gif", gif),
            ("notes.png", b"just text".to_vec()),
            ("empty.png", Vec::new()),
        ] {
            assert_eq!(
                prepare(name, bytes, ImageKind::Banner),
                Err(PickedImage::Refused {
                    reason: Refusal::NotPicture,
                    file_name: name.into(),
                    max_bytes: None
                }),
                "{name}"
            );
        }
    }

    #[test]
    fn a_logo_holds_one_mebibyte_and_a_cover_three() {
        let mut big = encoded(image::ImageFormat::Png, 4, 4);
        big.resize(MIB as usize + 1, 0);
        assert_eq!(
            prepare("big.png", big.clone(), ImageKind::Logo),
            Err(PickedImage::Refused {
                reason: Refusal::TooBig,
                file_name: "big.png".into(),
                max_bytes: Some(MIB)
            })
        );
        for kind in [ImageKind::Banner, ImageKind::Cover] {
            assert!(
                prepare("big.png", big.clone(), kind).is_ok(),
                "a cover takes it: {kind:?}"
            );
            let mut huge = encoded(image::ImageFormat::Png, 4, 4);
            huge.resize(3 * MIB as usize + 1, 0);
            assert!(
                matches!(
                    prepare("huge.png", huge, kind),
                    Err(PickedImage::Refused { reason: Refusal::TooBig, max_bytes: Some(max), .. }) if max == 3 * MIB
                ),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn a_photo_loses_where_it_was_taken_before_it_is_hashed() {
        let photo = jpeg_with_gps();
        assert!(contains(&photo, &GPS_RATIONALS));
        let picture = prepare("camera.jpg", photo.clone(), ImageKind::Banner).expect("a JPEG");
        assert!(
            !contains(&picture.bytes, &GPS_RATIONALS),
            "the GPS position is gone"
        );
        assert!(
            !contains(&picture.bytes, b"taken at home"),
            "the comment is gone"
        );
        assert!(picture.bytes.len() < photo.len());
        assert_eq!(
            picture.image.sha256,
            crate::bundles::sha256_hex(&picture.bytes),
            "the hash is of what goes up"
        );
        assert_eq!(
            (picture.image.width, picture.image.height),
            (Some(16), Some(8))
        );
    }

    #[test]
    fn a_file_on_disk_is_read_no_further_than_its_limit() {
        let temp = tempfile::tempdir().expect("a folder");
        let small = temp.path().join("logo.png");
        std::fs::write(&small, encoded(image::ImageFormat::Png, 8, 8)).unwrap();
        assert!(matches!(read_picked(&small, ImageKind::Logo), Ok(Ok(_))));
        let big = temp.path().join("cover.png");
        let mut bytes = encoded(image::ImageFormat::Png, 8, 8);
        bytes.resize(MIB as usize + 10, 0);
        std::fs::write(&big, &bytes).unwrap();
        assert!(matches!(
            read_picked(&big, ImageKind::Logo),
            Ok(Err(PickedImage::Refused {
                reason: Refusal::TooBig,
                ..
            }))
        ));
        assert!(
            matches!(
                read_picked(temp.path(), ImageKind::Logo),
                Err(AppError::InvalidInput(_))
            ),
            "a folder is not a file"
        );
    }

    #[test]
    fn a_dropped_file_is_read_as_a_picked_one() {
        let temp = tempfile::tempdir().expect("a folder");
        let logo = temp.path().join("logo.png");
        std::fs::write(&logo, encoded(image::ImageFormat::Png, 8, 8)).unwrap();
        let picture = match read_dropped(&logo, ImageKind::Logo) {
            Ok(Ok(picture)) => picture,
            other => panic!("a PNG: {other:?}"),
        };
        assert_eq!(picture.image.file_name, "logo.png");
        assert_eq!(
            picture.image.sha256,
            crate::bundles::sha256_hex(&picture.bytes)
        );

        let mut big = encoded(image::ImageFormat::Png, 8, 8);
        big.resize(MIB as usize + 1, 0);
        let cover = temp.path().join("cover.png");
        std::fs::write(&cover, &big).unwrap();
        assert_eq!(
            read_dropped(&cover, ImageKind::Logo).unwrap(),
            Err(too_big("cover.png", ImageKind::Logo)),
            "a logo holds one mebibyte"
        );
        assert!(
            matches!(read_dropped(&cover, ImageKind::Banner), Ok(Ok(_))),
            "a cover holds three"
        );

        let notes = temp.path().join("notes.png");
        std::fs::write(&notes, b"just text").unwrap();
        assert_eq!(
            read_dropped(&notes, ImageKind::Cover).unwrap(),
            Err(not_picture("notes.png")),
            "the type is the first bytes', not the name's"
        );
        let photo = temp.path().join("photo.jfif");
        std::fs::write(&photo, encoded(image::ImageFormat::Jpeg, 8, 8)).unwrap();
        assert!(
            matches!(read_dropped(&photo, ImageKind::Cover), Ok(Ok(_))),
            "a JPEG under another name"
        );
    }

    #[test]
    fn a_dropped_folder_or_link_is_not_a_picture_and_a_missing_file_fails() {
        let temp = tempfile::tempdir().expect("a folder");
        let folder = temp.path().join("Pictures");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            read_dropped(&folder, ImageKind::Logo).unwrap(),
            Err(not_picture("Pictures"))
        );

        let target = temp.path().join("logo.png");
        std::fs::write(&target, encoded(image::ImageFormat::Png, 8, 8)).unwrap();
        let link = temp.path().join("link.png");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &link);
        // Windows lets a process make a link only in developer mode or as an
        // administrator; without one there is nothing to check.
        if linked.is_ok() {
            assert_eq!(
                read_dropped(&link, ImageKind::Logo).unwrap(),
                Err(not_picture("link.png")),
                "a link is not followed"
            );
        }

        assert!(
            matches!(
                read_dropped(&temp.path().join("gone.png"), ImageKind::Logo),
                Err(AppError::Io { .. })
            ),
            "a file that is not there is an error, not a refusal"
        );
    }

    #[test]
    fn only_a_file_of_the_last_drop_on_the_window_is_read_once_and_soon() {
        let drops = DropState::default();
        let at = Instant::now();
        let logo = PathBuf::from(r"C:\Users\Quinn\Pictures\logo.png");
        let cover = PathBuf::from(r"C:\Users\Quinn\Pictures\cover.png");
        let other = PathBuf::from(r"C:\Users\Quinn\Documents\secret.png");

        assert!(
            !drops.take("main", &logo, at),
            "nothing was dropped on the window"
        );
        drops.dropped("main", &[logo.clone(), cover.clone()], at);
        assert!(
            !drops.take("main", &other, at),
            "a file the drop did not carry"
        );
        assert!(
            !drops.take("chat", &logo, at),
            "the drop was on another window"
        );
        assert!(drops.take("main", &logo, at + Duration::from_secs(1)));
        assert!(
            !drops.take("main", &logo, at + Duration::from_secs(1)),
            "a file of a drop is read once"
        );
        assert!(
            !drops.take("main", &cover, at + DROP_WINDOW + Duration::from_secs(1)),
            "a drop nobody asked for in time closes"
        );
        assert!(
            !drops.take("main", &cover, at + Duration::from_secs(2)),
            "and stays closed"
        );

        let later = at + Duration::from_secs(120);
        drops.dropped("main", std::slice::from_ref(&cover), later);
        assert!(
            !drops.take("main", &logo, later),
            "a new drop replaces the files of the one before"
        );
        assert!(drops.take("main", &cover, later));

        drops.dropped("main", std::slice::from_ref(&logo), later);
        drops.forget("main");
        assert!(
            !drops.take("main", &logo, later),
            "a closed window takes its drop with it"
        );
    }

    #[test]
    fn a_claim_lasts_until_the_drop_or_the_drag_leaves() {
        let drops = DropState::default();
        let at = Instant::now();
        let logo = [PathBuf::from(r"C:\Users\Quinn\Pictures\logo.png")];
        assert!(!drops.dropped("main", &logo, at), "nobody claimed it");

        drops.claim("main", true);
        assert!(
            !drops.dropped("chat", &logo, at),
            "the claim is the window's own"
        );
        assert!(drops.dropped("main", &logo, at));
        assert!(
            !drops.dropped("main", &logo, at),
            "the claim ended with the drop"
        );

        drops.claim("main", true);
        drops.left("main");
        assert!(
            !drops.dropped("main", &logo, at),
            "the drag left the window"
        );

        drops.claim("main", true);
        drops.claim("main", false);
        assert!(
            !drops.dropped("main", &logo, at),
            "the drag moved off the tile"
        );
    }

    #[test]
    fn the_answer_has_the_shape_the_screen_reads() {
        assert_eq!(
            serde_json::to_value(PickedImage::Cancelled).unwrap(),
            serde_json::json!({ "outcome": "cancelled" })
        );
        assert_eq!(
            serde_json::to_value(too_big("big.png", ImageKind::Logo)).unwrap(),
            serde_json::json!({ "outcome": "refused", "reason": "tooBig", "fileName": "big.png", "maxBytes": MIB })
        );
        assert_eq!(
            serde_json::to_value(PickedImage::Refused {
                reason: Refusal::NotPicture,
                file_name: "x.txt".into(),
                max_bytes: None
            })
            .unwrap(),
            serde_json::json!({ "outcome": "refused", "reason": "notPicture", "fileName": "x.txt" })
        );
        let uploaded = PickedImage::Uploaded(UploadedImage {
            sha256: "a".repeat(64),
            size: 10,
            file_name: "logo.png".into(),
            width: Some(1),
            height: None,
        });
        assert_eq!(
            serde_json::to_value(uploaded).unwrap(),
            serde_json::json!({ "outcome": "uploaded", "sha256": "a".repeat(64), "size": 10, "fileName": "logo.png", "width": 1, "height": null })
        );
        for (name, kind) in [
            ("logo", ImageKind::Logo),
            ("banner", ImageKind::Banner),
            ("cover", ImageKind::Cover),
        ] {
            assert_eq!(
                serde_json::from_value::<ImageKind>(serde_json::json!(name)).unwrap(),
                kind
            );
        }
        assert!(
            serde_json::from_value::<ImageKind>(serde_json::json!("avatar")).is_err(),
            "the service has no such picture"
        );
    }
}
