//! Publishing a draft as a bundle: the manifest, the upload, the version.
//!
//! `publish_bundle_draft` checks the draft, turns it into a manifest and
//! then, in the order the service wants them:
//!
//! 1. `HEAD /v1/blobs/{sha256}` for every picture the descriptions of every
//!    language refer to, and `PUT /v1/blobs/{sha256}` for each the store
//!    does not hold: the service looks the references up when it takes the
//!    fields;
//! 2. `POST /v1/bundles` for a new bundle, or a read of the bundle the draft
//!    is linked to, to check it belongs to the account and to learn its
//!    `revision`, then `PUT /v1/bundles/{id}` with the fields of the draft,
//!    its `language` and its `translations` among them;
//! 3. `POST /v1/bundles/{id}/versions` with the manifest, which answers with
//!    the files the service does not hold yet;
//! 4. `PUT /v1/blobs/{sha256}` for each of those, streamed from the `files\`
//!    and `listings\` folders of the draft, with a progress event every
//!    chunk and one more try after a network failure; then a `HEAD` for each
//!    listing the answer did not name, and an upload where it is missing;
//! 5. `POST /v1/bundles/{id}/versions/{versionId}/publish`, which publishes
//!    the version or puts it in front of a reviewer when it carries
//!    executables.
//!
//! Pictures and listings travel through the same `uploading` phase as the
//! files: a picture under the name the author picked, a listing under the
//! path of its pk3 with ` (listing)` behind it.
//!
//! The draft learns the bundle and the version last, and so do the clients
//! that were installed from it. A publish that failed halfway leaves a draft
//! version on the service and a draft that says nothing about it; the next
//! attempt creates a new version and the service collects the abandoned
//! files on its own.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use futures_util::stream;
use reqwest::Method;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;

use crate::clients;
use crate::error::{AppError, Result};
use crate::online::{path_segment, Auth, OnlineClient, OnlineContext};
use crate::state::AppState;

use super::draft::{self, Draft};
use super::images;
use super::listing;
use super::manifest;
use super::types::{BundleDetails, BundleVersion, CreatedVersion, PublishResult, Translation};

/// Event the editor listens to.
pub const PROGRESS_EVENT: &str = "bundles:publish-progress";

/// Bytes of one chunk of an upload, and therefore the distance between two
/// progress events.
const CHUNK: usize = 256 * 1024;

/// Payload of [`PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishProgress {
    pub draft_id: String,
    /// Always `None`: a publish comes out of a draft, not out of a client.
    /// Kept so the event reads like the one of the first edition.
    pub client_id: Option<String>,
    /// `hashing`, `creating`, `uploading`, `publishing`, `done` or `error`.
    pub phase: &'static str,
    /// One-based index of the file being uploaded, zero outside uploads.
    pub file_index: u32,
    /// Files the service asked for.
    pub file_count: u32,
    /// Manifest path of the file being uploaded, `None` on the other phases.
    pub current_file: Option<String>,
    /// Bytes of the current file sent so far.
    pub uploaded: u64,
    /// Bytes of the current file.
    pub total: u64,
    pub message: String,
    /// The bundle the version goes into, known from the `creating` phase on
    /// (a fresh bundle is created first). In the `error` phase it carries
    /// the last known value, so a retry goes on in the same bundle.
    pub bundle_id: Option<String>,
}

/// Sends one progress event. A failed emit is logged, never propagated: a
/// publish must not fail because a window went away.
fn emit(app: &AppHandle, progress: PublishProgress) {
    if let Err(e) = app.emit(PROGRESS_EVENT, progress) {
        log::warn!("cannot emit {PROGRESS_EVENT}: {e}");
    }
}

fn step(app: &AppHandle, draft_id: &str, bundle_id: Option<&str>, phase: &'static str, message: String) {
    emit(
        app,
        PublishProgress {
            draft_id: draft_id.to_string(),
            client_id: None,
            phase,
            file_index: 0,
            file_count: 0,
            current_file: None,
            uploaded: 0,
            total: 0,
            message,
            bundle_id: bundle_id.map(str::to_string),
        },
    );
}

/// Publishes a draft. The caller holds the claim of the draft.
pub(crate) async fn publish(
    app: &AppHandle,
    state: &AppState,
    online: &OnlineClient,
    draft_id: &str,
) -> Result<PublishResult> {
    // The bundle the run got as far as creating or reading: the `error`
    // event names it, so a retry can go on in it.
    let mut known_bundle = None;
    match publish_inner(app, state, online, draft_id, &mut known_bundle).await {
        Ok(result) => Ok(result),
        Err(e) => {
            log::error!("publishing draft {draft_id} failed: {e}");
            step(app, draft_id, known_bundle.as_deref(), "error", e.to_string());
            Err(e)
        }
    }
}

async fn publish_inner(
    app: &AppHandle,
    state: &AppState,
    online: &OnlineClient,
    draft_id: &str,
    known_bundle: &mut Option<String>,
) -> Result<PublishResult> {
    let paths = state.paths()?;
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    if !ctx.signed_in() {
        return Err(AppError::SignedOut);
    }
    let account_id = settings
        .online_user
        .as_ref()
        .map(|user| user.id.clone())
        .unwrap_or_default();

    // 1. The draft, checked, and its manifest. A pk3 without a listing gets
    //    one here: a draft of the second edition has none.
    step(app, draft_id, None, "hashing", "Checking the draft".into());
    let draft = listing::ensure_listings(&paths, draft::read_draft(&paths, draft_id)?).await?;
    let issues = draft::validate(&draft);
    if !issues.errors.is_empty() {
        let codes: Vec<&str> = issues.errors.iter().map(|issue| issue.code.as_str()).collect();
        return Err(AppError::InvalidInput(format!(
            "the draft is not ready to publish: {}",
            codes.join(", ")
        )));
    }
    let manifest = draft::manifest_of(&draft);
    manifest::validate(&manifest)?;
    *known_bundle = draft.bundle_id.clone();

    // 2. The pictures of the description, before the bundle: the service
    //    looks every `blob:` reference up when it takes the fields.
    upload_images(app, online, &ctx, &paths, &draft, draft.bundle_id.as_deref()).await?;

    // 3. The bundle: created, or the linked one read for its revision and
    //    written with the fields of the draft.
    step(app, draft_id, draft.bundle_id.as_deref(), "creating", "Creating the bundle".into());
    let fields = bundle_fields(&draft, &manifest.game);
    let bundle = match &draft.bundle_id {
        None => {
            online
                .request::<BundleDetails>(&ctx, Method::POST, "/v1/bundles", Some(fields), Auth::Required)
                .await?
        }
        Some(bundle_id) => {
            let path = format!("/v1/bundles/{}", path_segment(bundle_id)?);
            let bundle: BundleDetails = online
                .request(&ctx, Method::GET, &path, None, Auth::Required)
                .await?;
            let owner = bundle.card.owner.as_ref().map(|owner| owner.id.as_str());
            if owner != Some(account_id.as_str()) {
                return Err(AppError::Online {
                    code: "forbidden".into(),
                    message: format!(
                        "the bundle {} belongs to another account",
                        bundle.card.name
                    ),
                });
            }
            step(app, draft_id, Some(bundle_id), "creating", "Updating the bundle".into());
            let mut body = fields;
            body["revision"] = serde_json::json!(bundle.revision);
            online
                .request::<BundleDetails>(&ctx, Method::PUT, &path, Some(body), Auth::Required)
                .await?
        }
    };
    let bundle_id = bundle.card.id.clone();
    *known_bundle = Some(bundle_id.clone());
    let bundle_path = format!("/v1/bundles/{}", path_segment(&bundle_id)?);

    // 4. The version, and what the service still needs for it.
    step(app, draft_id, Some(&bundle_id), "creating", "Creating the version".into());
    let manifest_document = serde_json::to_value(&manifest)
        .map_err(|e| AppError::json("the manifest of the draft", e))?;
    let body = serde_json::json!({
        "label": draft.version_label.trim(),
        "changelog": draft.changelog.trim(),
        "manifest": manifest_document,
    });
    let created: CreatedVersion = online
        .request(&ctx, Method::POST, &format!("{bundle_path}/versions"), Some(body), Auth::Required)
        .await?;
    let version_id = created.version.summary.id.clone();

    // 5. The files and the listings, from the folder of the draft: what the
    //    service asked for, then the listings it did not mention, which a
    //    service that stores them as plain files may still be missing.
    let files = draft::files_by_hash(&paths, &draft);
    let listings = listing::listings_by_hash(&paths, &draft);
    let mut wanted: Vec<Upload> = Vec::with_capacity(created.missing_blobs.len());
    for missing in &created.missing_blobs {
        wanted.push(upload_of(&draft, &files, &listings, &missing.sha256)?);
    }
    for (scope, file) in draft.all_files() {
        let Some(listing) = &file.listing else {
            continue;
        };
        if created.missing_blobs.iter().any(|missing| missing.sha256 == listing.sha256)
            || wanted.iter().any(|upload| upload.sha256 == listing.sha256)
        {
            continue;
        }
        if !online.head_blob(&ctx, &listing.sha256).await? {
            log::info!("the listing of {scope}/{} is not in the store yet", file.path);
            wanted.push(upload_of(&draft, &files, &listings, &listing.sha256)?);
        }
    }
    let count = wanted.len() as u32;
    for (index, upload) in wanted.iter().enumerate() {
        self::upload(
            app,
            online,
            &ctx,
            draft_id,
            Some(&bundle_id),
            &upload.label,
            upload.size,
            &upload.sha256,
            &upload.path,
            index as u32 + 1,
            count,
        )
        .await?;
    }

    // 6. Publish, and remember.
    step(
        app,
        draft_id,
        Some(&bundle_id),
        "publishing",
        if manifest.has_executables() {
            "Sending the version for review".into()
        } else {
            "Publishing the version".into()
        },
    );
    let version: BundleVersion = online
        .request(
            &ctx,
            Method::POST,
            &format!("{bundle_path}/versions/{}/publish", path_segment(&version_id)?),
            None,
            Auth::Required,
        )
        .await?;

    remember(state, &paths, &draft, &bundle, &version)?;
    log::info!(
        "published draft {draft_id} as bundle {bundle_id} version {} ({}, {} bytes of files)",
        version.summary.id,
        version.summary.status,
        manifest.blob_bytes()
    );
    let outcome = match version.summary.status.as_str() {
        BundleVersion::PUBLISHED => "is published",
        BundleVersion::PENDING => "is waiting for a reviewer",
        BundleVersion::REJECTED => "was rejected",
        BundleVersion::DRAFT => "is still a draft",
        other => other,
    };
    step(
        app,
        draft_id,
        Some(&bundle_id),
        "done",
        format!("Version {} {outcome}", version.summary.label),
    );
    Ok(PublishResult { bundle, version })
}

/// The fields of a bundle as `POST /v1/bundles` and `PUT /v1/bundles/{id}`
/// take them, out of the draft: the main fields in `language`, and every
/// translation, empty fields included, because an empty field is what
/// tells the service the field is not translated.
fn bundle_fields(draft: &Draft, game: &str) -> serde_json::Value {
    let translations: BTreeMap<&str, Translation> = draft
        .translations
        .iter()
        .map(|(code, translation)| (code.as_str(), translation.to_contract()))
        .collect();
    serde_json::json!({
        "name": draft.name.trim(),
        "summary": draft.summary.trim(),
        "description": draft.description.trim(),
        "language": draft.language,
        "translations": translations,
        "game": game,
        "tags": draft.tags,
        "website": draft.website.as_deref().map(str::trim).filter(|v| !v.is_empty()),
        "discord": draft.discord.as_deref().map(str::trim).filter(|v| !v.is_empty()),
    })
}

/// One file on its way up: a file of the draft, a listing or a picture.
#[derive(Debug)]
struct Upload {
    /// What the progress event names: the manifest path of a file, the
    /// path with ` (listing)` for a listing, the file name of a picture.
    label: String,
    size: u64,
    sha256: String,
    path: PathBuf,
}

/// The upload of the hash the service asked for: a file of the draft or the
/// listing of one, whichever carries it.
fn upload_of(
    draft: &Draft,
    files: &HashMap<String, PathBuf>,
    listings: &HashMap<String, PathBuf>,
    sha256: &str,
) -> Result<Upload> {
    if let Some((path, file)) = draft
        .all_files()
        .find(|(_, file)| file.sha256 == sha256)
        .and_then(|(_, file)| files.get(&file.sha256).map(|path| (path.clone(), file)))
    {
        return Ok(Upload {
            label: file.path.clone(),
            size: file.size,
            sha256: file.sha256.clone(),
            path,
        });
    }
    if let Some((path, file, listing)) = draft
        .all_files()
        .filter_map(|(_, file)| file.listing.as_ref().map(|listing| (file, listing)))
        .find(|(_, listing)| listing.sha256 == sha256)
        .and_then(|(file, listing)| listings.get(&listing.sha256).map(|path| (path.clone(), file, listing)))
    {
        return Ok(Upload {
            label: format!("{} (listing)", file.path),
            size: listing.size,
            sha256: listing.sha256.clone(),
            path,
        });
    }
    Err(AppError::BundleFile {
        path: sha256.to_string(),
        reason: "the service asked for a file that is not in the draft".into(),
    })
}

/// Uploads the pictures the descriptions of every language refer to and
/// the store does not hold yet, as files of the `uploading` phase. The
/// validation before this step made sure every reference has a picture in
/// the draft.
async fn upload_images(
    app: &AppHandle,
    online: &OnlineClient,
    ctx: &OnlineContext,
    paths: &crate::paths::DataPaths,
    draft: &Draft,
    bundle_id: Option<&str>,
) -> Result<()> {
    let referenced = draft.image_refs();
    let pictures: Vec<&images::DraftImage> = draft
        .images
        .iter()
        .filter(|image| referenced.contains(&image.sha256))
        .collect();
    let count = pictures.len() as u32;
    for (index, image) in pictures.iter().enumerate() {
        let path = images::path_of(paths, &draft.id, &image.sha256)?;
        if online.head_blob(ctx, &image.sha256).await? {
            log::info!("the picture {} is in the store already", image.file_name);
            continue;
        }
        upload(
            app,
            online,
            ctx,
            &draft.id,
            bundle_id,
            &image.file_name,
            image.size,
            &image.sha256,
            &path,
            index as u32 + 1,
            count,
        )
        .await?;
    }
    Ok(())
}

/// Writes the bundle and the version into the draft, and into the link of
/// every client that was installed from the draft.
pub(crate) fn remember(
    state: &AppState,
    paths: &crate::paths::DataPaths,
    draft: &Draft,
    bundle: &BundleDetails,
    version: &BundleVersion,
) -> Result<()> {
    draft::edit_draft(paths, &draft.id, |record| {
        record.bundle_id = Some(bundle.card.id.clone());
        record.bundle_slug = Some(bundle.card.slug.clone());
        record.last_version_id = Some(version.summary.id.clone());
        Ok(())
    })?;
    for client in clients::read_all(paths)? {
        let from_this_draft = client
            .bundle
            .as_ref()
            .is_some_and(|link| link.draft_id.as_deref() == Some(draft.id.as_str()));
        if !from_this_draft {
            continue;
        }
        clients::edit_record(state.client_records(), paths, &client.id, |record| {
            if let Some(link) = record.bundle.as_mut() {
                link.bundle_id = Some(bundle.card.id.clone());
                link.bundle_slug = bundle.card.slug.clone();
                link.bundle_name = bundle.card.name.clone();
                link.version_id = Some(version.summary.id.clone());
                link.version_label = version.summary.label.clone();
            }
        })?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// Uploads one file, trying twice when the network lets it down.
#[allow(clippy::too_many_arguments)]
async fn upload(
    app: &AppHandle,
    online: &OnlineClient,
    ctx: &OnlineContext,
    draft_id: &str,
    bundle_id: Option<&str>,
    manifest_path: &str,
    expected_size: u64,
    sha256: &str,
    path: &Path,
    index: u32,
    count: u32,
) -> Result<()> {
    let size = std::fs::metadata(path)
        .map(|meta| meta.len())
        .map_err(|e| AppError::io_path("cannot read", path, e))?;
    if size != expected_size {
        return Err(AppError::BundleFile {
            path: manifest_path.to_string(),
            reason: format!(
                "the file of the draft changed since it was added: {size} bytes now, {expected_size} in the draft"
            ),
        });
    }
    let mut attempt = 0;
    loop {
        let mut progress = Progress {
            app: app.clone(),
            draft_id: draft_id.to_string(),
            bundle_id: bundle_id.map(str::to_string),
            index,
            count,
            path: manifest_path.to_string(),
            total: size,
            uploaded: 0,
        };
        progress.emit("Uploading");
        let body = file_body(path, move |read| {
            progress.uploaded += read;
            progress.emit("Uploading");
        })
        .await?;
        match online.put_blob(ctx, sha256, size, body).await {
            Ok(receipt) => {
                log::info!("uploaded {manifest_path} ({} bytes, {})", receipt.size, receipt.sha256);
                return Ok(());
            }
            Err(AppError::Network(reason)) if attempt == 0 => {
                attempt += 1;
                log::warn!("uploading {manifest_path} failed: {reason}, trying once more");
            }
            Err(e) => {
                return Err(match e {
                    AppError::Network(reason) => AppError::BundleFile {
                        path: manifest_path.to_string(),
                        reason,
                    },
                    other => other,
                })
            }
        }
    }
}

/// The counters of one upload, and the event they turn into.
struct Progress {
    app: AppHandle,
    draft_id: String,
    /// `None` while the pictures go up ahead of a bundle that is not
    /// created yet.
    bundle_id: Option<String>,
    index: u32,
    count: u32,
    path: String,
    total: u64,
    uploaded: u64,
}

impl Progress {
    fn emit(&self, message: &str) {
        emit(
            &self.app,
            PublishProgress {
                draft_id: self.draft_id.clone(),
                client_id: None,
                phase: "uploading",
                file_index: self.index,
                file_count: self.count,
                current_file: Some(self.path.clone()),
                uploaded: self.uploaded,
                total: self.total,
                message: format!("{message} {}", self.path),
                bundle_id: self.bundle_id.clone(),
            },
        );
    }
}

/// The body of a `PUT /v1/blobs/{sha256}`: the file, read in chunks of
/// [`CHUNK`] as the request goes out, with `on_chunk` told the size of
/// every chunk that went.
///
/// A stream rather than `Vec<u8>`: a bundle file is allowed 512 MiB, and
/// the launcher must not hold one in memory to send it.
pub(crate) async fn file_body(
    path: &Path,
    on_chunk: impl FnMut(u64) + Send + 'static,
) -> Result<reqwest::Body> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| AppError::io_path("cannot open", path, e))?;
    let source: PathBuf = path.to_path_buf();
    let chunks = stream::unfold(
        (file, on_chunk, source),
        |(mut file, mut on_chunk, source)| async move {
            let mut buffer = vec![0u8; CHUNK];
            match file.read(&mut buffer).await {
                Ok(0) => None,
                Ok(read) => {
                    buffer.truncate(read);
                    on_chunk(read as u64);
                    Some((Ok(buffer), (file, on_chunk, source)))
                }
                Err(e) => {
                    log::warn!("cannot read {}: {e}", source.display());
                    Some((Err(e), (file, on_chunk, source)))
                }
            }
        },
    );
    Ok(reqwest::Body::wrap_stream(chunks))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundles::draft::test_support::{component, empty_draft};
    use crate::bundles::types::{BundleCard, BundleVersionSummary};
    use crate::clients::ClientBundleLink;
    use crate::engines::LaunchMode;
    use crate::game::Game;

    #[test]
    fn a_publish_is_remembered_by_the_draft_and_by_its_clients() {
        let temp = tempfile::tempdir().expect("a data root");
        let state = AppState::bootstrap(temp.path().to_path_buf());
        let paths = state.paths().unwrap();
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "openjk", &[LaunchMode::Multiplayer]));
        draft::write_draft(&paths, &draft).unwrap();

        // Two clients of the draft, one of another draft, one by hand.
        let lock = state.client_records();
        let mine = clients::create_record(&paths, "RUJKA · Multiplayer", "openjk", Game::JediAcademy, None).unwrap();
        clients::edit_record(lock, &paths, &mine.id, |record| {
            record.bundle = Some(ClientBundleLink {
                draft_id: Some(draft.id.clone()),
                bundle_name: "RUJKA".into(),
                component_id: "mp".into(),
                role: ClientBundleLink::INSTALLED.into(),
                ..ClientBundleLink::default()
            });
        })
        .unwrap();
        let other = clients::create_record(&paths, "Other", "openjk", Game::JediAcademy, None).unwrap();
        clients::edit_record(lock, &paths, &other.id, |record| {
            record.bundle = Some(ClientBundleLink {
                draft_id: Some("another-draft".into()),
                role: ClientBundleLink::INSTALLED.into(),
                ..ClientBundleLink::default()
            });
        })
        .unwrap();
        let plain = clients::create_record(&paths, "Plain", "openjk", Game::JediAcademy, None).unwrap();

        let bundle = BundleDetails {
            card: BundleCard {
                id: "01J".into(),
                slug: "rujka".into(),
                name: "JKA RUJKA Edition".into(),
                ..BundleCard::default()
            },
            ..BundleDetails::default()
        };
        let version = BundleVersion {
            summary: BundleVersionSummary {
                id: "01V".into(),
                label: "3".into(),
                status: BundleVersion::PUBLISHED.into(),
                ..BundleVersionSummary::default()
            },
            manifest: draft::manifest_of(&draft),
        };
        remember(&state, &paths, &draft, &bundle, &version).expect("remembered");

        let draft = draft::read_draft(&paths, &draft.id).unwrap();
        assert_eq!(draft.bundle_id.as_deref(), Some("01J"));
        assert_eq!(draft.bundle_slug.as_deref(), Some("rujka"));
        assert_eq!(draft.last_version_id.as_deref(), Some("01V"));

        let link = clients::read_record(&paths, &mine.id).unwrap().bundle.unwrap();
        assert_eq!(link.bundle_id.as_deref(), Some("01J"));
        assert_eq!(link.bundle_slug, "rujka");
        assert_eq!(link.bundle_name, "JKA RUJKA Edition");
        assert_eq!(link.version_id.as_deref(), Some("01V"));
        assert_eq!(link.version_label, "3");
        assert_eq!(link.draft_id.as_deref(), Some(draft.id.as_str()), "the draft stays named");
        assert_eq!(link.component_id, "mp");
        let untouched = clients::read_record(&paths, &other.id).unwrap().bundle.unwrap();
        assert_eq!(untouched.bundle_id, None);
        assert!(clients::read_record(&paths, &plain.id).unwrap().bundle.is_none());
    }

    #[test]
    fn the_hash_the_service_asks_for_is_a_file_of_the_draft_or_the_listing_of_one() {
        use crate::bundles::draft::test_support::put_draft_file;
        use crate::bundles::draft::DraftOrigin;
        use crate::bundles::manifest::{FileRoot, ListingRef};

        let temp = tempfile::tempdir().expect("a data root");
        let paths = crate::paths::DataPaths::new(temp.path().to_path_buf());
        let mut draft = empty_draft(&paths, Game::JediAcademy, "RUJKA");
        draft.components.push(component("mp", "Multiplayer", "openjk", &[LaunchMode::Multiplayer]));
        let mut pk3 = put_draft_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "base/x.pk3",
            b"PK\x03\x04 not really",
            DraftOrigin::Disk {
                source_path: "D:/x.pk3".into(),
            },
        );
        let document = listing::draft_listing_path(&paths, &draft.id, &pk3.sha256);
        std::fs::create_dir_all(document.parent().unwrap()).unwrap();
        let listing_bytes = br#"{"schema":1,"entries":[{"path":"a.txt","size":1}]}"#;
        std::fs::write(&document, listing_bytes).unwrap();
        pk3.listing = Some(ListingRef {
            sha256: crate::bundles::sha256_hex(listing_bytes),
            size: listing_bytes.len() as u64,
        });
        draft.components[0].files.push(pk3.clone());
        let cfg = put_draft_file(
            &paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "base/x.cfg",
            b"seta x 1\n",
            DraftOrigin::Disk {
                source_path: "D:/x.cfg".into(),
            },
        );
        draft.components[0].files.push(cfg.clone());

        let files = draft::files_by_hash(&paths, &draft);
        let listings = listing::listings_by_hash(&paths, &draft);
        let file = upload_of(&draft, &files, &listings, &cfg.sha256).expect("the cfg");
        assert_eq!(file.label, "base/x.cfg");
        assert_eq!(file.size, cfg.size);
        assert!(file.path.ends_with("x.cfg"));
        let listing_hash = pk3.listing.as_ref().unwrap().sha256.clone();
        let listing = upload_of(&draft, &files, &listings, &listing_hash).expect("the listing");
        assert_eq!(listing.label, "base/x.pk3 (listing)");
        assert_eq!(listing.size, listing_bytes.len() as u64);
        assert_eq!(listing.path, document);
        let unknown = upload_of(&draft, &files, &listings, &"0".repeat(64)).expect_err("not in the draft");
        assert!(matches!(unknown, AppError::BundleFile { .. }), "{unknown}");

        // The fields of the bundle as the service takes them.
        draft.website = Some("  https://example.com  ".into());
        draft.discord = Some("   ".into());
        let fields = bundle_fields(&draft, "ja");
        assert_eq!(fields["name"], "RUJKA");
        assert_eq!(fields["game"], "ja");
        assert_eq!(fields["website"], "https://example.com");
        assert_eq!(fields["discord"], serde_json::Value::Null);
        assert_eq!(fields["language"], "en");
        assert_eq!(fields["translations"], serde_json::json!({}), "no translation is an empty object");
        assert!(fields.get("revision").is_none(), "the revision goes only with a PUT");
    }

    #[test]
    fn the_language_and_every_translation_go_into_the_fields_of_the_bundle() {
        use crate::bundles::draft::DraftTranslation;

        let temp = tempfile::tempdir().expect("a data root");
        let paths = crate::paths::DataPaths::new(temp.path().to_path_buf());
        let mut draft = empty_draft(&paths, Game::JediAcademy, "Русская сборка");
        draft.language = "ru".into();
        draft.summary = "Русское издание".into();
        draft.description = "# Русская сборка".into();
        draft.translations.insert(
            "en".into(),
            DraftTranslation {
                name: " JKA RUJKA Edition ".into(),
                summary: "Russian edition".into(),
                description: " # RUJKA\n\n![shot](blob:aaaa) ".into(),
            },
        );
        // A language added and left empty travels as empty fields: that is
        // how the service learns the fields are not translated.
        draft.translations.insert("uk".into(), DraftTranslation::default());

        let fields = bundle_fields(&draft, "ja");
        assert_eq!(fields["name"], "Русская сборка");
        assert_eq!(fields["language"], "ru");
        assert_eq!(
            fields["translations"],
            serde_json::json!({
                "en": { "name": "JKA RUJKA Edition", "summary": "Russian edition", "description": "# RUJKA\n\n![shot](blob:aaaa)" },
                "uk": { "name": "", "summary": "", "description": "" },
            })
        );
        // The body of the POST is the fields whole; the PUT adds the revision
        // to the same object.
        let mut put = fields.clone();
        put["revision"] = serde_json::json!(3);
        assert_eq!(put["translations"]["en"]["name"], "JKA RUJKA Edition");
        assert_eq!(put["revision"], 3);
    }
}
