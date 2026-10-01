//! The logo and the cover of a community, picked on disk and put in the
//! store of JKNet Online.
//!
//! The webview never names a path: the core opens the system dialog, reads
//! the file and checks it the way the service will when the picture is bound
//! to the community (`PUT communities/{id}/images`): PNG, JPEG or WebP by
//! its first bytes, a logo up to 1 MiB and a cover up to 3 MiB. A picture
//! that passes loses what a JPEG or a PNG records about where and when it
//! was taken, as a picture sent to chat does, is hashed with SHA-256 and goes
//! up with `PUT /v1/blobs/{sha256}`, unless `HEAD` says the store holds it
//! already. The webview gets the hash back and binds it through the bridge
//! of `crate::community`.
//!
//! A cancelled dialog and a refused file are answers, not errors: the screen
//! says them in the player's language. A failure of the upload is an error.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::bundles::images::ImageType;
use crate::error::{AppError, Result};
use crate::online::{OnlineClient, OnlineContext};
use crate::state::AppState;

const MIB: u64 = 1024 * 1024;

/// The extensions the dialog offers: the three types the service takes.
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];

/// The two pictures of a community. `banner` is the cover of its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageKind {
    Logo,
    Banner,
}

impl ImageKind {
    /// The most bytes the service binds as this picture.
    pub fn max_bytes(self) -> u64 {
        match self {
            ImageKind::Logo => MIB,
            ImageKind::Banner => 3 * MIB,
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
        Some(ImageType::Gif) | None => {
            return Err(PickedImage::Refused {
                reason: Refusal::NotPicture,
                file_name: file_name.to_string(),
                max_bytes: None,
            })
        }
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
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
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

/// The system dialog for a logo or a cover, over the window that asked; the
/// picture goes to the store of the service. `title` and `filter` are the
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
    let ctx = OnlineContext::from_settings(&state.settings()?);
    if !ctx.signed_in() {
        return Err(AppError::Online {
            code: "unauthorized".into(),
            message: "Sign in to JKNet Online first.".into(),
        });
    }
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
    let prepared = tauri::async_runtime::spawn_blocking(move || read_picked(&path, kind))
        .await
        .map_err(|e| AppError::State(format!("reading the picture did not finish: {e}")))??;
    let picture = match prepared {
        Ok(picture) => picture,
        Err(refused) => return Ok(refused),
    };
    upload(&online, &ctx, &picture).await?;
    Ok(PickedImage::Uploaded(picture.image))
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
        assert!(
            prepare("big.png", big, ImageKind::Banner).is_ok(),
            "a cover takes it"
        );
        let mut huge = encoded(image::ImageFormat::Png, 4, 4);
        huge.resize(3 * MIB as usize + 1, 0);
        assert!(matches!(
            prepare("huge.png", huge, ImageKind::Banner),
            Err(PickedImage::Refused { reason: Refusal::TooBig, max_bytes: Some(max), .. }) if max == 3 * MIB
        ));
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
        let kind: ImageKind = serde_json::from_value(serde_json::json!("banner")).unwrap();
        assert_eq!(kind, ImageKind::Banner);
    }
}
