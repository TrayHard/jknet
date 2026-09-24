//! Bundles: published recipes of sets of clients, on JKNet Online.
//!
//! A bundle is made of components. A component is an engine of the registry
//! with its release tag, the files laid over that release and the files
//! taken out of it, the pk3 files of `home\`, the config documents, the mod
//! folder, the launch arguments and the modes the client starts in; the
//! shared files and documents go to every component. Installing a bundle
//! creates one client per component; publishing one takes a draft the
//! editor of the launcher built. The bundle itself lives on the service, the
//! draft in the data folder, and a client only remembers the link in its
//! `client.json` (see [`crate::clients::ClientBundleLink`]).
//!
//! | File          | Responsibility                                            |
//! | ------------- | --------------------------------------------------------- |
//! | `manifest.rs` | the manifest of a version (schema 2) and its checks       |
//! | `types.rs`    | the wire types of the contract and of the catalogue       |
//! | `draft.rs`    | drafts on disk and the commands that edit them            |
//! | `release.rs`  | the files of an engine release and the overlay on them    |
//! | `publish.rs`  | the manifest out of a draft, the upload, the version      |
//! | `install.rs`  | clients out of a version or a draft, one per component    |
//! | `images.rs`   | the pictures of the description of a draft                |
//! | `listing.rs`  | the listing of a pk3, and the text of a config            |
//! | `preview.rs`  | the Library preview on a pk3 of a draft or the catalogue  |
//!
//! Every request goes through [`crate::online::OnlineClient`]: the JSON
//! routes through its ten-second client, the files through its transfer
//! client, which has no whole-request budget. The catalogue routes answer
//! without a token and answer more with one, so the token goes along when
//! there is one.
//!
//! On disk:
//!
//! ```text
//! bundles\drafts\<draftId>\draft.json   a draft, see draft.rs
//! bundles\drafts\<draftId>\files\       the files of the draft, by scope and root
//! bundles\drafts\<draftId>\images\      the pictures of its description, by hash
//! bundles\drafts\<draftId>\listings\    the listing of each pk3, by the hash of the pk3
//! cache\bundles\<sha256>.part           a file of the service on its way in,
//!                                       resumed by a Range when a run stops
//! cache\bundles\listings\               listings of the catalogue, by their hash
//! cache\bundles\preview\                files of the catalogue a preview opened
//! clients\<slug>\client.json            the `bundle` field: written first with
//!                                       `pending`, rewritten last without it
//! ```
//!
//! Long operations, one guard: [`BundlesState`] holds the clients an install
//! is making, the version or the draft the install or the publish works on,
//! and the drafts being deleted, the way `InstallState` holds the clients an
//! engine install is running for. A second call for the same key is refused
//! with `AppError::Busy` before anything touches the disk. The plain engine
//! install and the deletion of a client claim the same set, so neither can
//! start under a bundle operation.

pub mod draft;
pub mod images;
pub mod install;
pub mod listing;
pub mod manifest;
pub mod preview;
pub mod publish;
pub mod release;
pub mod types;

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::Method;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::clients::{self, Client};
use crate::engine_install::InstallState;
use crate::engines;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::jkhub::JkhubState;
use crate::online::{path_segment, Auth, OnlineClient, OnlineContext};
use crate::state::AppState;

use install::{DraftSource, InstallArgs, Job, JobOrigin, OnlineSource, TauriHost};
use types::{
    BundleDetails, BundleList, BundleLocal, BundleQuery, BundleVersion, BundleView,
    InstalledClient, InstallsResult, LikeResult, MyBundles, PendingVersion, PublishResult,
};

/// Most cards one page of the catalogue may ask for, as the contract caps it.
const MAX_PAGE: u32 = 100;

// ---------------------------------------------------------------------------
// One long operation per key
// ---------------------------------------------------------------------------

/// The clients, versions and drafts a bundle operation, an engine install
/// or a deletion is running for, managed by Tauri next to
/// [`crate::state::AppState`].
///
/// A publish reads gigabytes and an install writes them; two of either for
/// the same client would race over the same folders, and a plain engine
/// install, which empties `engine\` before it unpacks, would race over the
/// files a bundle is laying there. The interface disables its buttons while
/// one runs; this refuses the call that gets through anyway, from a double
/// click, a second window, or a retry.
///
/// Keys are client ids, plus one key per bundle version an install has
/// started for (see [`version_key`]) and one per draft an install, a publish
/// or a deletion works on (see [`draft_key`]): those claims are taken before
/// any client exists, so a second call for the same version or draft has
/// nothing to race with. Each claim remembers what holds it, so the refusal
/// can say so.
#[derive(Debug, Default)]
pub struct BundlesState {
    busy: Mutex<HashMap<String, &'static str>>,
}

impl BundlesState {
    /// What a claim can be held for, as the refusal spells it.
    pub const PUBLISH: &'static str = "a publish";
    pub const INSTALL: &'static str = "a bundle install";
    pub const ENGINE_INSTALL: &'static str = "an engine installation";
    pub const DELETE: &'static str = "a deletion";
    // --- slice: pk3 editor ---
    /// The save of the pk3 editor, which rewrites a file of a draft or of
    /// the library of a client under the same claim a publish or an install
    /// would take.
    pub const EDIT: &'static str = "a pk3 edit";

    /// Claims a key for `what`, or refuses because someone holds it.
    ///
    /// `pub(crate)` for [`crate::engines::install_engine`] and
    /// [`crate::clients::delete_client`], which take a client the same way a
    /// bundle operation does.
    pub(crate) fn claim<'a>(&'a self, key: &str, what: &'static str) -> Result<BundlesGuard<'a>> {
        let mut busy = self
            .busy
            .lock()
            .map_err(|_| AppError::State("the bundles lock is poisoned".into()))?;
        if let Some(holder) = busy.get(key) {
            return Err(AppError::Busy(format!(
                "{holder} is already running for {key}. Wait for it to finish."
            )));
        }
        busy.insert(key.to_string(), what);
        Ok(BundlesGuard {
            state: self,
            key: key.to_string(),
        })
    }
}

/// The key an install claims for the version it installs, before the
/// client exists.
pub(crate) fn version_key(bundle_id: &str, version_id: &str) -> String {
    format!("bundle:{bundle_id}:{version_id}")
}

/// The key an install, a publish or a deletion claims for a draft.
pub(crate) fn draft_key(draft_id: &str) -> String {
    format!("draft:{draft_id}")
}

/// Releases the claim when the operation ends, however it ends.
#[derive(Debug)]
pub(crate) struct BundlesGuard<'a> {
    state: &'a BundlesState,
    key: String,
}

impl Drop for BundlesGuard<'_> {
    fn drop(&mut self) {
        match self.state.busy.lock() {
            Ok(mut busy) => {
                busy.remove(&self.key);
            }
            // A poisoned lock would keep the key busy until the launcher
            // restarts, which is worse than the panic that poisoned it.
            Err(e) => log::error!("cannot release the bundles claim of {}: {e}", self.key),
        }
    }
}

// ---------------------------------------------------------------------------
// Commands: the catalogue
// ---------------------------------------------------------------------------

/// One page of the catalogue of one game.
#[tauri::command]
pub async fn list_bundles(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    query: BundleQuery,
) -> Result<BundleList> {
    let settings = state.settings()?;
    let ctx = OnlineContext::from_settings(&settings);
    let game = query.game.unwrap_or(settings.active_game);
    let path = catalogue_path(game, &query);
    online
        .request(&ctx, Method::GET, &path, None, Auth::Optional)
        .await
}

/// The query string of `GET /v1/bundles`, with every value escaped.
fn catalogue_path(game: Game, query: &BundleQuery) -> String {
    let mut path = format!("/v1/bundles?game={}", game.id());
    let sort = query
        .sort
        .as_deref()
        .map(str::trim)
        .filter(|sort| matches!(*sort, "popular" | "new" | "installs"))
        .unwrap_or("popular");
    path.push_str("&sort=");
    path.push_str(sort);
    if let Some(q) = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        path.push_str("&q=");
        path.push_str(&utf8_percent_encode(q, NON_ALPHANUMERIC).to_string());
    }
    if let Some(engine) = query.engine_id.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        path.push_str("&engine=");
        path.push_str(&utf8_percent_encode(engine, NON_ALPHANUMERIC).to_string());
    }
    if let Some(tag) = query.tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        path.push_str("&tag=");
        path.push_str(&utf8_percent_encode(tag, NON_ALPHANUMERIC).to_string());
    }
    let limit = query.limit.unwrap_or(50).clamp(1, MAX_PAGE);
    path.push_str(&format!("&limit={limit}&offset={}", query.offset.unwrap_or(0)));
    path
}

/// One bundle with its versions, plus what this machine knows about it:
/// the clients that point at it and whether the engines of its components
/// are in the registry.
#[tauri::command]
pub async fn get_bundle(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    bundle_id: String,
) -> Result<BundleView> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let path = format!("/v1/bundles/{}", path_segment(&bundle_id)?);
    let details: BundleDetails = online
        .request(&ctx, Method::GET, &path, None, Auth::Optional)
        .await?;
    let local = local_block(&clients::read_all(&state.paths()?)?, &details);
    Ok(BundleView { details, local })
}

/// What the launcher adds to the answer of the service.
///
/// Every client that points at the bundle is listed, an unfinished install
/// with `pending: true`, so the dialog can tell an installed component from
/// one that stopped halfway. `engineKnown` is keyed by the components of
/// the latest version, or of the card when the details carry no version.
fn local_block(clients: &[Client], details: &BundleDetails) -> BundleLocal {
    let card = &details.card;
    let installed_clients = clients
        .iter()
        .filter_map(|client| {
            let link = client.bundle.as_ref()?;
            (link.bundle_id.as_deref() == Some(card.id.as_str())).then(|| InstalledClient {
                client_id: client.id.clone(),
                version_id: link.version_id.clone(),
                component_id: link.component_id.clone(),
                role: link.role.clone(),
                pending: link.pending,
            })
        })
        .collect();
    let mut engine_known = BTreeMap::new();
    match &details.latest {
        Some(latest) => {
            for component in &latest.manifest.components {
                engine_known.insert(
                    component.id.clone(),
                    engines::find(&component.engine.engine_id).is_some(),
                );
            }
        }
        None => {
            for component in &card.components {
                engine_known.insert(component.id.clone(), engines::find(&component.engine_id).is_some());
            }
        }
    }
    BundleLocal {
        installed_clients,
        engine_known,
    }
}

/// One version with its manifest.
#[tauri::command]
pub async fn get_bundle_version(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    bundle_id: String,
    version_id: String,
) -> Result<BundleVersion> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let path = format!(
        "/v1/bundles/{}/versions/{}",
        path_segment(&bundle_id)?,
        path_segment(&version_id)?
    );
    online
        .request(&ctx, Method::GET, &path, None, Auth::Optional)
        .await
}

/// Likes or unlikes a bundle.
#[tauri::command]
pub async fn like_bundle(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    bundle_id: String,
    liked: bool,
) -> Result<LikeResult> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let path = format!("/v1/bundles/{}/like", path_segment(&bundle_id)?);
    let method = if liked { Method::PUT } else { Method::DELETE };
    online
        .request(&ctx, method, &path, None, Auth::Required)
        .await
}

/// The bundles of the signed-in account, every version included, and the
/// space they take of the quota.
#[tauri::command]
pub async fn my_bundles(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
) -> Result<MyBundles> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    online
        .request(&ctx, Method::GET, "/v1/bundles/me", None, Auth::Required)
        .await
}

/// Hides a bundle of the account. The service keeps its rows until an
/// administrator removes the versions, and its files until the collector
/// finds nothing pointing at them.
#[tauri::command]
pub async fn delete_bundle(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    bundle_id: String,
) -> Result<()> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let path = format!("/v1/bundles/{}", path_segment(&bundle_id)?);
    online
        .request::<serde_json::Value>(&ctx, Method::DELETE, &path, None, Auth::Required)
        .await
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// Commands: install and publish
// ---------------------------------------------------------------------------

/// Installs the selected components of a version into new clients, or
/// continues an install that stopped, in the clients it had made.
///
/// Progress arrives through `bundles:install-progress`; the engine step
/// reports through `launch:engine-install-progress` as well, so the card of
/// each client shows the same bar it shows for any engine install. Once the
/// clients are ready the install is counted on the service when somebody is
/// signed in; a failure there changes nothing on this machine.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_bundle(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    installs: tauri::State<'_, InstallState>,
    jkhub: tauri::State<'_, JkhubState>,
    bundles: tauri::State<'_, BundlesState>,
    bundle_id: String,
    version_id: String,
    base_name: String,
    component_ids: Vec<String>,
    existing_client_ids: Option<HashMap<String, String>>,
) -> Result<Vec<Client>> {
    let paths = state.paths()?;
    let ctx = OnlineContext::from_settings(&state.settings()?);

    // The version and its manifest.
    let bundle_path = format!("/v1/bundles/{}", path_segment(&bundle_id)?);
    let (details, version) = fetch_version(&online, &ctx, &bundle_id, &version_id).await?;
    let job = Job {
        manifest: version.manifest.clone(),
        origin: JobOrigin::Catalogue {
            bundle: Box::new(details.clone()),
            version: Box::new(version.clone()),
        },
    };
    let source = OnlineSource::new(&app, &online, ctx.clone(), &jkhub, paths.clone());
    let host = TauriHost {
        app: &app,
        installs: &installs,
        paths: paths.clone(),
    };
    let clients = install::install(
        &state,
        &bundles,
        &host,
        &source,
        job,
        InstallArgs {
            base_name,
            component_ids,
            existing_client_ids: trimmed_ids(existing_client_ids),
        },
    )
    .await?;

    // The counter on the service, when somebody is signed in.
    if ctx.signed_in() {
        let path = format!("{bundle_path}/installs");
        let body = serde_json::json!({ "versionId": version.summary.id });
        match online
            .request::<InstallsResult>(&ctx, Method::POST, &path, Some(body), Auth::Required)
            .await
        {
            Ok(counted) => log::info!("bundle {} has {} install(s)", details.card.id, counted.installs),
            Err(e) => log::warn!("the install of bundle {} was not counted: {e}", details.card.id),
        }
    }
    Ok(clients)
}

/// Installs the selected components of a draft into new clients, with the
/// files taken from the folder of the draft: the **Test locally** button of
/// the editor. `existingClientIds` continues an install that stopped.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_bundle_draft(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    installs: tauri::State<'_, InstallState>,
    bundles: tauri::State<'_, BundlesState>,
    draft_id: String,
    base_name: String,
    component_ids: Vec<String>,
    existing_client_ids: Option<HashMap<String, String>>,
) -> Result<Vec<Client>> {
    let paths = state.paths()?;
    let draft = draft::read_draft(&paths, &draft_id)?;
    let job = Job {
        manifest: draft::manifest_of(&draft),
        origin: JobOrigin::Draft {
            draft: Box::new(draft.clone()),
        },
    };
    let source = DraftSource::new(&paths, &draft);
    let host = TauriHost {
        app: &app,
        installs: &installs,
        paths: paths.clone(),
    };
    install::install(
        &state,
        &bundles,
        &host,
        &source,
        job,
        InstallArgs {
            base_name,
            component_ids,
            existing_client_ids: trimmed_ids(existing_client_ids),
        },
    )
    .await
}

/// One bundle and one of its versions with its manifest: the latest one
/// when that is the version asked for, which every read of the bundle
/// already carries, a second read otherwise.
pub(crate) async fn fetch_version(
    online: &OnlineClient,
    ctx: &OnlineContext,
    bundle_id: &str,
    version_id: &str,
) -> Result<(BundleDetails, BundleVersion)> {
    let bundle_path = format!("/v1/bundles/{}", path_segment(bundle_id)?);
    let details: BundleDetails = online
        .request(ctx, Method::GET, &bundle_path, None, Auth::Optional)
        .await?;
    let version = match details.latest.clone() {
        Some(latest) if latest.summary.id == version_id => latest,
        _ => {
            let path = format!("{bundle_path}/versions/{}", path_segment(version_id)?);
            online
                .request::<BundleVersion>(ctx, Method::GET, &path, None, Auth::Optional)
                .await?
        }
    };
    Ok((details, version))
}

/// The map of component ids to client ids with the blanks taken out.
fn trimmed_ids(ids: Option<HashMap<String, String>>) -> HashMap<String, String> {
    ids.unwrap_or_default()
        .into_iter()
        .map(|(component, client)| (component.trim().to_string(), client.trim().to_string()))
        .filter(|(component, client)| !component.is_empty() && !client.is_empty())
        .collect()
}

/// Publishes a draft as a new bundle, or as a new version of the bundle it
/// is linked to. Progress arrives through `bundles:publish-progress`.
#[tauri::command]
pub async fn publish_bundle_draft(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    bundles: tauri::State<'_, BundlesState>,
    draft_id: String,
) -> Result<PublishResult> {
    let draft_id = draft_id.trim().to_string();
    // Held until the answer: the draft and the records of its clients are
    // written last.
    let _claim = bundles.claim(&draft_key(&draft_id), BundlesState::PUBLISH)?;
    publish::publish(&app, &state, &online, &draft_id).await
}

// ---------------------------------------------------------------------------
// Commands: review
// ---------------------------------------------------------------------------

/// The versions waiting for a reviewer, with the bundles they belong to.
/// Answers `forbidden` for an account that is not an administrator.
#[tauri::command]
pub async fn list_pending_bundle_versions(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
) -> Result<Vec<PendingVersion>> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let answer: serde_json::Value = online
        .request(&ctx, Method::GET, "/v1/bundles/admin/pending", None, Auth::Required)
        .await?;
    pending_versions(answer)
}

/// Reads the review queue whichever way the service shapes it: a bare list
/// or `{ items }`, each entry with the version next to its bundle or with
/// the bundle nested inside the version.
fn pending_versions(answer: serde_json::Value) -> Result<Vec<PendingVersion>> {
    let items = match answer {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(mut object) => match object.remove("items") {
            Some(serde_json::Value::Array(items)) => items,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    items
        .into_iter()
        .map(|mut item| {
            let bundle = item
                .get_mut("bundle")
                .map(serde_json::Value::take)
                .ok_or_else(|| AppError::json(
                    "cannot parse the review queue",
                    serde::de::Error::custom("an entry without a bundle"),
                ))?;
            let version = match item.get_mut("version") {
                Some(version) => version.take(),
                None => item,
            };
            Ok(PendingVersion {
                bundle: serde_json::from_value(bundle)
                    .map_err(|e| AppError::json("cannot parse the review queue", e))?,
                version: serde_json::from_value(version)
                    .map_err(|e| AppError::json("cannot parse the review queue", e))?,
            })
        })
        .collect()
}

/// Approves or rejects a version that carries executables.
#[tauri::command]
pub async fn review_bundle_version(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    version_id: String,
    approve: bool,
    note: Option<String>,
) -> Result<BundleVersion> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let path = format!("/v1/bundles/admin/versions/{}", path_segment(&version_id)?);
    let body = if approve {
        serde_json::json!({ "approve": true })
    } else {
        serde_json::json!({
            "approve": false,
            "note": note.as_deref().map(str::trim).unwrap_or_default(),
        })
    };
    online
        .request(&ctx, Method::POST, &path, Some(body), Auth::Required)
        .await
}

/// Features or hides a bundle. A flag left out keeps its value.
#[tauri::command]
pub async fn set_bundle_flags(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    bundle_id: String,
    featured: Option<bool>,
    hidden: Option<bool>,
) -> Result<BundleDetails> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let path = format!("/v1/bundles/admin/{}", path_segment(&bundle_id)?);
    let mut body = serde_json::Map::new();
    if let Some(featured) = featured {
        body.insert("featured".into(), featured.into());
    }
    if let Some(hidden) = hidden {
        body.insert("hidden".into(), hidden.into());
    }
    online
        .request(&ctx, Method::POST, &path, Some(body.into()), Auth::Required)
        .await
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/// SHA-256 of a whole file as lowercase hex, streamed so a 500 MB pk3 costs
/// one buffer.
pub(crate) fn sha256_of(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| AppError::io_path("cannot read", path, e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// SHA-256 of bytes in memory as lowercase hex: the hash of a listing
/// document before it is written, or of a picture as it came down.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
pub(crate) mod test_support {
    /// The hash the manifest would carry for these bytes.
    pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
        super::sha256_hex(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::ClientBundleLink;
    use types::{BundleCard, ComponentSummary};

    #[test]
    fn one_bundle_operation_per_key_at_a_time() {
        let bundles = BundlesState::default();
        let first = bundles
            .claim("voip", BundlesState::INSTALL)
            .expect("the first claim");
        let second = bundles
            .claim("voip", BundlesState::PUBLISH)
            .expect_err("the second is refused");
        assert!(matches!(second, AppError::Busy(_)), "{second}");
        // The refusal names what holds the client, not what asked for it.
        assert!(second.to_string().contains("a bundle install"), "{second}");
        let other = bundles
            .claim("duel", BundlesState::DELETE)
            .expect("another client is free");
        drop(other);
        drop(first);
        bundles
            .claim("voip", BundlesState::PUBLISH)
            .expect("released with the guard");

        // A version key and a draft key are keys like any other, and a
        // second install of the same version, or of the same draft, is
        // refused by them before any client exists.
        let key = version_key("01J", "01V");
        assert_eq!(key, "bundle:01J:01V");
        let version = bundles.claim(&key, BundlesState::INSTALL).expect("the version");
        let again = bundles
            .claim(&key, BundlesState::INSTALL)
            .expect_err("the same version twice");
        assert!(matches!(again, AppError::Busy(_)), "{again}");
        bundles
            .claim(&version_key("01J", "01W"), BundlesState::INSTALL)
            .expect("another version of the bundle is free");
        drop(version);
        assert_eq!(draft_key("d1"), "draft:d1");
        let draft = bundles.claim(&draft_key("d1"), BundlesState::PUBLISH).expect("the draft");
        let again = bundles
            .claim(&draft_key("d1"), BundlesState::INSTALL)
            .expect_err("a test install under a publish");
        assert!(again.to_string().contains("a publish"), "{again}");
        drop(draft);
    }

    #[test]
    fn the_catalogue_query_is_escaped_and_bounded() {
        let query = BundleQuery {
            game: None,
            sort: Some("new".into()),
            q: Some("duel & voip".into()),
            engine_id: Some("taystjk".into()),
            tag: Some("competitive".into()),
            limit: Some(500),
            offset: Some(20),
        };
        assert_eq!(
            catalogue_path(Game::JediAcademy, &query),
            "/v1/bundles?game=ja&sort=new&q=duel%20%26%20voip&engine=taystjk&tag=competitive&limit=100&offset=20"
        );
        let plain = BundleQuery::default();
        assert_eq!(
            catalogue_path(Game::JediOutcast, &plain),
            "/v1/bundles?game=jo&sort=popular&limit=50&offset=0"
        );
        let odd = BundleQuery {
            sort: Some("../admin".into()),
            q: Some("   ".into()),
            limit: Some(0),
            ..BundleQuery::default()
        };
        assert_eq!(
            catalogue_path(Game::JediAcademy, &odd),
            "/v1/bundles?game=ja&sort=popular&limit=1&offset=0"
        );
    }

    #[test]
    fn the_local_block_names_the_clients_that_point_at_a_bundle_and_its_engines() {
        let link = ClientBundleLink {
            bundle_id: Some("01J".into()),
            bundle_slug: "x".into(),
            bundle_name: "X".into(),
            draft_id: None,
            version_id: Some("01V".into()),
            version_label: "1".into(),
            component_id: "mp".into(),
            component_label: "Multiplayer".into(),
            role: ClientBundleLink::INSTALLED.into(),
            engine_overlay: false,
            linked_at: String::new(),
            pending: false,
        };
        let mut from_bundle: Client = serde_json::from_str(
            r#"{"id":"x","name":"X","engineId":"openjk","engineVersion":null,"createdAt":"2026-09-15"}"#,
        )
        .expect("a client");
        from_bundle.bundle = Some(link.clone());
        let mut sp = from_bundle.clone();
        sp.id = "y".into();
        sp.bundle = Some(ClientBundleLink {
            component_id: "sp".into(),
            ..link.clone()
        });
        let mut other = from_bundle.clone();
        other.id = "z".into();
        other.bundle = Some(ClientBundleLink {
            bundle_id: Some("01K".into()),
            ..link.clone()
        });
        let mut plain = from_bundle.clone();
        plain.id = "w".into();
        plain.bundle = None;
        // An install that is running, or stopped halfway: listed as pending.
        let mut unfinished = from_bundle.clone();
        unfinished.id = "v".into();
        unfinished.bundle = Some(ClientBundleLink {
            pending: true,
            ..link.clone()
        });
        // A client of an unpublished draft points at no bundle yet.
        let mut from_draft = from_bundle.clone();
        from_draft.id = "u".into();
        from_draft.bundle = Some(ClientBundleLink {
            bundle_id: None,
            draft_id: Some("d1".into()),
            version_id: None,
            ..link
        });

        let details: BundleDetails = serde_json::from_str(
            r#"{"id":"01J","engineId":"eternaljk",
                "components":[{"id":"mp","engineId":"eternaljk"},{"id":"sp","engineId":"openjk"}],
                "latest":{"id":"01V","status":"published","manifest":{"schema":2,"game":"ja",
                  "components":[{"id":"mp","label":"MP","engine":{"engineId":"eternaljk"},"modes":["multiplayer"]},
                                {"id":"sp","label":"SP","engine":{"engineId":"openjk"},"modes":["single"]},
                                {"id":"mme","label":"Demos","engine":{"engineId":"future-engine"},"modes":["multiplayer"]}]}}}"#,
        )
        .expect("details");
        let local = local_block(&[from_bundle, sp, other, plain, unfinished, from_draft], &details);
        let listed: Vec<(&str, &str, bool)> = local
            .installed_clients
            .iter()
            .map(|c| (c.client_id.as_str(), c.component_id.as_str(), c.pending))
            .collect();
        assert_eq!(listed, [("x", "mp", false), ("y", "sp", false), ("v", "mp", true)]);
        assert_eq!(local.installed_clients[0].version_id.as_deref(), Some("01V"));
        assert_eq!(
            local.engine_known,
            BTreeMap::from([
                ("mp".to_string(), true),
                ("sp".to_string(), true),
                ("mme".to_string(), false)
            ])
        );

        // Without a version, the components of the card answer.
        let card_only = BundleDetails {
            card: BundleCard {
                id: "01J".into(),
                components: vec![ComponentSummary {
                    id: "mp".into(),
                    engine_id: "taystjk".into(),
                    ..ComponentSummary::default()
                }],
                ..BundleCard::default()
            },
            ..BundleDetails::default()
        };
        let local = local_block(&[], &card_only);
        assert!(local.installed_clients.is_empty());
        assert_eq!(local.engine_known, BTreeMap::from([("mp".to_string(), true)]));
        let json = serde_json::to_value(&local).unwrap();
        assert_eq!(json["engineKnown"]["mp"], true);
    }

    #[test]
    fn the_review_queue_is_read_in_either_shape() {
        let version = serde_json::json!({
            "id": "01V", "bundleId": "01J", "label": "1", "status": "pending",
            "manifest": { "schema": 2, "game": "ja",
                          "components": [{ "id": "mp", "label": "MP", "engine": { "engineId": "openjk" }, "modes": ["multiplayer"] }] }
        });
        let bundle = serde_json::json!({ "id": "01J", "name": "X", "engineId": "openjk" });

        let nested = serde_json::json!({ "items": [ { "bundle": bundle, "version": version } ] });
        let parsed = pending_versions(nested).expect("nested parses");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].bundle.name, "X");
        assert_eq!(parsed[0].version.summary.status, "pending");

        let mut flat = version.clone();
        flat["bundle"] = bundle.clone();
        let parsed = pending_versions(serde_json::json!([flat])).expect("flat parses");
        assert_eq!(parsed[0].version.summary.id, "01V");
        assert_eq!(parsed[0].bundle.id, "01J");

        assert!(pending_versions(serde_json::json!({ "items": [] })).expect("empty").is_empty());
        assert!(pending_versions(serde_json::json!([{ "version": version }])).is_err());
    }

    #[test]
    fn the_ids_of_a_continued_install_are_trimmed_and_the_blanks_dropped() {
        let ids = trimmed_ids(Some(HashMap::from([
            (" mp ".to_string(), " rujka-mp ".to_string()),
            ("sp".to_string(), "  ".to_string()),
            ("".to_string(), "x".to_string()),
        ])));
        assert_eq!(ids, HashMap::from([("mp".to_string(), "rujka-mp".to_string())]));
        assert!(trimmed_ids(None).is_empty());
    }

    /// The service the ignored tests talk to: `scripts/mock-online.mjs` by
    /// default, or a real service when `JKNET_BUNDLES_E2E_URL` names one, a
    /// local build with the dev provider on, like `http://127.0.0.1:8797`.
    /// The real one is what proves the contract: the stand-in only mirrors it.
    enum Service {
        Mock(crate::online::mock_tests::MockOnline),
        External(String),
    }

    impl Service {
        fn start(port: u16) -> Service {
            match std::env::var("JKNET_BUNDLES_E2E_URL") {
                Ok(url) if !url.trim().is_empty() => {
                    Service::External(url.trim().trim_end_matches('/').to_string())
                }
                _ => Service::Mock(crate::online::mock_tests::MockOnline::start(port)),
            }
        }

        fn base_url(&self) -> String {
            match self {
                Service::Mock(mock) => mock.base_url(),
                Service::External(url) => url.clone(),
            }
        }
    }

    /// Signs in through the dev provider and returns the token. The stand-in
    /// completes the session by itself; a real service shows the dev form,
    /// whose `state` goes back to the callback together with a name, the way
    /// the browser would submit it.
    async fn dev_sign_in(client: &OnlineClient, guest: &OnlineContext, name: &str) -> String {
        let session = client
            .create_login_session(guest, "dev", Some("TESTBOX"))
            .await
            .expect("a dev session opens");
        if !session.url.is_empty() {
            let http = reqwest::Client::new();
            if let Ok(page) = http.get(&session.url).send().await {
                let page = page.text().await.unwrap_or_default();
                let state = page
                    .split("name=\"state\" value=\"")
                    .nth(1)
                    .and_then(|rest| rest.split('"').next())
                    .map(str::to_string);
                if let Some(state) = state {
                    let callback = format!(
                        "{}/v1/auth/dev/callback?state={state}&name={name}",
                        guest.base_url
                    );
                    // The stand-in may have completed the session on its own
                    // by now; then the callback is refused and the poll below
                    // still finds the token.
                    let _ = http.get(callback).send().await;
                }
            }
        }
        for _ in 0..40 {
            let polled = client
                .poll_login_session(guest, &session.id)
                .await
                .expect("the session reads");
            if polled.status == "done" {
                return polled.token.expect("a done session carries the token once");
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("the dev session did not complete");
    }

    /// The catalogue and one bundle against `scripts/mock-online.mjs`, the
    /// stand-in of the service, or against a real one (see [`Service`]).
    /// Ignored like the tests of `online::mock_tests`: it needs Node and a
    /// free port. Run it by hand:
    /// `cargo test --lib -- --ignored --nocapture bundles::tests::mock`.
    #[tokio::test]
    #[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
    async fn mock_catalogue_and_bundle_parse_into_the_contract_types() {
        let mock = Service::start(8795);
        let client = OnlineClient::new();
        let ctx = OnlineContext {
            base_url: mock.base_url(),
            token: None,
        };
        let path = catalogue_path(Game::JediAcademy, &BundleQuery::default());
        let list: BundleList = client
            .request(&ctx, Method::GET, &path, None, Auth::Optional)
            .await
            .expect("the mock answers the catalogue");
        assert!(list.items.len() as u64 <= list.total);
        if let Some(card) = list.items.first() {
            assert!(!card.id.is_empty());
            let details: BundleDetails = client
                .request(
                    &ctx,
                    Method::GET,
                    &format!("/v1/bundles/{}", path_segment(&card.id).expect("an id")),
                    None,
                    Auth::Optional,
                )
                .await
                .expect("the mock answers the bundle");
            assert_eq!(details.card.id, card.id);
            let latest = details.latest.expect("a published bundle has a latest version");
            manifest::validate(&latest.manifest).expect("the mock serves a valid manifest");
            assert!(!latest.manifest.components.is_empty());
            assert_eq!(latest.summary.components.len(), latest.manifest.components.len());
            println!(
                "mock: {} with {} component(s) and {} files",
                details.card.name,
                latest.manifest.components.len(),
                latest.manifest.all_files().count()
            );
        }
    }

    /// The whole transport of a publish and the reads of an install against
    /// the stand-in: sign in, create a bundle and a version of two
    /// components, stream a file up, publish, read the file back whole and
    /// from an offset, like and count an install. Ignored for the same
    /// reason as the test above. Run it by hand:
    /// `cargo test --lib -- --ignored --nocapture bundles::tests::mock_publish`.
    #[tokio::test]
    #[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
    async fn mock_publish_flow_streams_a_file_up_and_reads_it_back() {
        use manifest::test_support::manifest as design_manifest;
        use manifest::{FileKind, FileRoot, FileSource, ManifestFile};
        use types::CreatedVersion;

        let mock = Service::start(8796);
        let client = OnlineClient::new();
        let guest = OnlineContext {
            base_url: mock.base_url(),
            token: None,
        };

        // Sign in through the dev provider, the way `online::mock_tests` does.
        // The name changes per run: a real service keeps its accounts, and a
        // bundle name is taken once per account.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() % 100_000)
            .unwrap_or(0);
        let token = dev_sign_in(&client, &guest, &format!("Publisher{stamp}")).await;
        let ctx = OnlineContext {
            base_url: mock.base_url(),
            token: Some(token),
        };
        let me = client.get_me(&ctx).await.expect("the account reads");
        println!("mock: signed in as {}, admin: {}", me.user.display_name, me.admin);

        let mine: MyBundles = client
            .request(&ctx, Method::GET, "/v1/bundles/me", None, Auth::Required)
            .await
            .expect("my bundles read");
        assert!(mine.quota_bytes > 0);

        // A file on disk, the way a draft holds one.
        let temp = tempfile::tempdir().expect("a folder");
        let file = temp.path().join("hello.cfg");
        // Unique per run: a real service keeps its store, and a file it
        // already holds is not asked for again, which is right but would
        // leave the upload untested.
        let body: Vec<u8> = (0..(600 * 1024))
            .map(|i| ((i + stamp as usize) % 253) as u8)
            .collect();
        std::fs::write(&file, &body).expect("the file");
        let hash = sha256_of(&file).expect("the hash");

        // The manifest of the design document, with the one uploaded file as
        // the only blob: every other file is a JKHub reference or is dropped.
        let mut manifest = design_manifest();
        manifest.components[0].overlay = manifest::ManifestOverlay::default();
        manifest.components[1].files = vec![ManifestFile {
            root: FileRoot::Home,
            path: "base/hello.cfg".into(),
            size: body.len() as u64,
            sha256: hash.clone(),
            kind: FileKind::Cfg,
            source: FileSource::Blob,
            replaces: None,
            origin: None,
            library: None,
            listing: None,
        }];
        manifest.shared.files.clear();
        manifest::validate(&manifest).expect("valid");

        let bundle: BundleDetails = client
            .request(
                &ctx,
                Method::POST,
                "/v1/bundles",
                Some(serde_json::json!({
                    "name": "Transport check", "summary": "s", "description": "d",
                    "game": "ja", "tags": ["test"], "website": null, "discord": null,
                })),
                Auth::Required,
            )
            .await
            .expect("the bundle is created");
        assert_eq!(
            bundle.card.owner.as_ref().map(|o| o.id.as_str()),
            Some(me.user.id.as_str())
        );
        let bundle_path = format!("/v1/bundles/{}", bundle.card.id);

        let created: CreatedVersion = client
            .request(
                &ctx,
                Method::POST,
                &format!("{bundle_path}/versions"),
                Some(serde_json::json!({ "label": "1", "changelog": "", "manifest": manifest })),
                Auth::Required,
            )
            .await
            .expect("the version is drafted");
        assert_eq!(created.version.summary.status, BundleVersion::DRAFT);
        assert_eq!(created.missing_blobs.len(), 1);
        assert_eq!(created.missing_blobs[0].sha256, hash);
        assert_eq!(created.version.manifest.components.len(), 2);

        // The upload, streamed from the file in chunks.
        let chunks = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter = chunks.clone();
        let stream = publish::file_body(&file, move |read| {
            counter.fetch_add(read, std::sync::atomic::Ordering::Relaxed);
        })
        .await
        .expect("the body opens");
        let receipt = client
            .put_blob(&ctx, &hash, body.len() as u64, stream)
            .await
            .expect("the upload is taken");
        assert_eq!(receipt.size, body.len() as u64);
        assert_eq!(
            chunks.load(std::sync::atomic::Ordering::Relaxed),
            body.len() as u64
        );

        let published: BundleVersion = client
            .request(
                &ctx,
                Method::POST,
                &format!("{bundle_path}/versions/{}/publish", created.version.summary.id),
                None,
                Auth::Required,
            )
            .await
            .expect("the version publishes");
        assert_eq!(published.summary.status, BundleVersion::PUBLISHED);
        assert_eq!(published.summary.components.len(), 2, "the service sums the components up");
        assert_eq!(published.summary.components[0].id, "mp");

        // The file comes back whole, and from an offset as a 206.
        let whole = client.get_blob(&guest, &hash, 0).await.expect("the file downloads");
        assert_eq!(whole.status(), reqwest::StatusCode::OK);
        assert_eq!(whole.bytes().await.expect("bytes").as_ref(), body.as_slice());
        let tail = client.get_blob(&guest, &hash, 1000).await.expect("the tail downloads");
        assert_eq!(tail.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(tail.bytes().await.expect("bytes").as_ref(), &body[1000..]);
        let missing = client
            .get_blob(&guest, &"0".repeat(64), 0)
            .await
            .expect_err("an unknown hash is refused");
        assert!(
            matches!(&missing, AppError::Online { code, .. } if code == "not_found"),
            "{missing}"
        );

        let liked: LikeResult = client
            .request(&ctx, Method::PUT, &format!("{bundle_path}/like"), None, Auth::Required)
            .await
            .expect("the like is taken");
        assert!(liked.liked_by_me);
        assert_eq!(liked.likes, 1);
        let counted: InstallsResult = client
            .request(
                &ctx,
                Method::POST,
                &format!("{bundle_path}/installs"),
                Some(serde_json::json!({ "versionId": published.summary.id })),
                Auth::Required,
            )
            .await
            .expect("the install is counted");
        assert_eq!(counted.installs, 1);

        // Back in the catalogue, with the local block of this machine.
        let view: BundleDetails = client
            .request(&ctx, Method::GET, &bundle_path, None, Auth::Optional)
            .await
            .expect("the bundle reads back");
        assert!(view.liked_by_me);
        assert_eq!(
            view.latest.as_ref().map(|v| v.summary.id.as_str()),
            Some(published.summary.id.as_str())
        );
        let local = local_block(&[], &view);
        assert_eq!(local.engine_known.get("mp"), Some(&true));
        assert_eq!(local.engine_known.get("sp"), Some(&true));

        // The review queue belongs to administrators.
        let queue = client
            .request::<serde_json::Value>(
                &ctx,
                Method::GET,
                "/v1/bundles/admin/pending",
                None,
                Auth::Required,
            )
            .await;
        match queue {
            Ok(answer) => {
                assert!(me.admin, "a plain account must not read the queue");
                let pending = pending_versions(answer).expect("the queue parses");
                println!("mock: {} version(s) pending", pending.len());
            }
            Err(AppError::Online { code, .. }) => assert_eq!(code, "forbidden"),
            Err(other) => panic!("{other}"),
        }
        println!("mock: bundle {} published and read back", bundle.card.slug);
    }

    /// The order of the third edition against the stand-in: a picture of
    /// the description goes up before the bundle exists (`HEAD`, then
    /// `PUT`), the linked bundle is read for its `revision` and written
    /// back with `PUT /v1/bundles/{id}` (a stale revision is a `409`), the
    /// listing of a pk3 goes up as a file of the store next to the pk3, and
    /// the listing and a config read back through the caches of
    /// `listing::bundle_listing` and `listing::bundle_text`. Ignored for the
    /// same reason as the tests above. Run it by hand:
    /// `cargo test --lib -- --ignored --nocapture bundles::tests::mock_publish_order`.
    #[tokio::test]
    #[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
    async fn mock_publish_order_uploads_pictures_first_and_listings_with_the_files() {
        use std::io::Write;

        use manifest::{FileKind, FileRoot, FileSource, ManifestFile};
        use types::CreatedVersion;

        let mock = Service::start(8797);
        let client = OnlineClient::new();
        let guest = OnlineContext {
            base_url: mock.base_url(),
            token: None,
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() % 100_000)
            .unwrap_or(0);
        let token = dev_sign_in(&client, &guest, &format!("Author{stamp}")).await;
        let ctx = OnlineContext {
            base_url: mock.base_url(),
            token: Some(token),
        };
        let temp = tempfile::tempdir().expect("a folder");
        let paths = crate::paths::DataPaths::new(temp.path().join("data"));

        // 1. The picture, unique per run: `HEAD` says no, `PUT` stores it,
        //    `HEAD` says yes.
        let mut png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(format!("IHDR{stamp}").as_bytes());
        let picture_hash = sha256_hex(&png);
        let picture = temp.path().join("shot.png");
        std::fs::write(&picture, &png).expect("the picture");
        assert!(!client.head_blob(&guest, &picture_hash).await.expect("HEAD answers"));
        let body = publish::file_body(&picture, |_| {}).await.expect("the body opens");
        client
            .put_blob(&ctx, &picture_hash, png.len() as u64, body)
            .await
            .expect("the picture is taken");
        assert!(client.head_blob(&guest, &picture_hash).await.expect("HEAD answers"));

        // 2. The bundle, with the description pointing at the picture.
        let description = format!("# Order check\n\n![shot](blob:{picture_hash})\n");
        let bundle: BundleDetails = client
            .request(
                &ctx,
                Method::POST,
                "/v1/bundles",
                Some(serde_json::json!({
                    "name": format!("Order check {stamp}"), "summary": "s", "description": description,
                    "game": "ja", "tags": ["test"], "website": null, "discord": null,
                })),
                Auth::Required,
            )
            .await
            .expect("the bundle is created");
        let bundle_path = format!("/v1/bundles/{}", bundle.card.id);

        // 3. The linked bundle: read for its revision, written back with the
        //    fields; a stale revision is refused.
        let read: BundleDetails = client
            .request(&ctx, Method::GET, &bundle_path, None, Auth::Required)
            .await
            .expect("the bundle reads");
        let fields = |revision: u64| {
            serde_json::json!({
                "name": format!("Order check {stamp}"), "summary": "updated", "description": description,
                "game": "ja", "tags": ["test", "voip"], "website": null, "discord": null,
                "revision": revision,
            })
        };
        let stale = client
            .request::<BundleDetails>(&ctx, Method::PUT, &bundle_path, Some(fields(read.revision + 5)), Auth::Required)
            .await
            .expect_err("a stale revision is refused");
        assert!(matches!(&stale, AppError::Online { code, .. } if code == "conflict"), "{stale}");
        let updated: BundleDetails = client
            .request(&ctx, Method::PUT, &bundle_path, Some(fields(read.revision)), Auth::Required)
            .await
            .expect("the bundle is updated");
        assert_eq!(updated.card.summary, "updated");
        assert!(updated.revision > read.revision);

        // 4. A version with a pk3 and its listing, both unique per run.
        let pk3 = temp.path().join("run.pk3");
        {
            let file = std::fs::File::create(&pk3).expect("the archive");
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer.start_file(format!("models/run{stamp}.md3"), options).unwrap();
            writer.write_all(b"geometry").unwrap();
            writer.start_file("sound/x.wav", options).unwrap();
            writer.write_all(b"audio").unwrap();
            writer.finish().unwrap();
        }
        let pk3_size = std::fs::metadata(&pk3).unwrap().len();
        let pk3_hash = sha256_of(&pk3).unwrap();
        let listing = listing::read_listing(&pk3).expect("the listing");
        let listing_bytes = listing::encode(&listing).unwrap();
        let listing_hash = sha256_hex(&listing_bytes);
        let listing_file = temp.path().join("run.listing.json");
        std::fs::write(&listing_file, &listing_bytes).unwrap();
        let cfg = temp.path().join("run.cfg");
        let cfg_text = format!("seta name \"Runner {stamp}\"\n");
        std::fs::write(&cfg, cfg_text.as_bytes()).unwrap();
        let cfg_hash = sha256_of(&cfg).unwrap();
        let mut manifest = manifest::test_support::manifest();
        manifest.components.truncate(1);
        manifest.components[0].overlay = manifest::ManifestOverlay::default();
        manifest.components[0].files = vec![
            ManifestFile {
                root: FileRoot::Home,
                path: "base/run.pk3".into(),
                size: pk3_size,
                sha256: pk3_hash.clone(),
                kind: FileKind::Pk3,
                source: FileSource::Blob,
                replaces: None,
                origin: None,
                library: None,
                listing: Some(manifest::ListingRef {
                    sha256: listing_hash.clone(),
                    size: listing_bytes.len() as u64,
                }),
            },
            ManifestFile {
                root: FileRoot::Home,
                path: "base/run.cfg".into(),
                size: cfg_text.len() as u64,
                sha256: cfg_hash.clone(),
                kind: FileKind::Cfg,
                source: FileSource::Blob,
                replaces: None,
                origin: None,
                library: None,
                listing: None,
            },
        ];
        manifest.shared.files.clear();
        manifest::validate(&manifest).expect("valid");
        let created: CreatedVersion = client
            .request(
                &ctx,
                Method::POST,
                &format!("{bundle_path}/versions"),
                Some(serde_json::json!({ "label": "1", "changelog": "", "manifest": manifest })),
                Auth::Required,
            )
            .await
            .expect("the version is drafted");
        let missing: Vec<&str> = created.missing_blobs.iter().map(|b| b.sha256.as_str()).collect();
        assert!(missing.contains(&pk3_hash.as_str()), "{missing:?}");
        assert!(missing.contains(&cfg_hash.as_str()), "{missing:?}");
        println!(
            "mock: the version asks for {} file(s); the listing is {}",
            missing.len(),
            if missing.contains(&listing_hash.as_str()) { "among them" } else { "not named" }
        );
        for (path, hash, size) in [
            (&pk3, &pk3_hash, pk3_size),
            (&cfg, &cfg_hash, cfg_text.len() as u64),
            (&listing_file, &listing_hash, listing_bytes.len() as u64),
        ] {
            if client.head_blob(&guest, hash).await.expect("HEAD answers") {
                continue;
            }
            let body = publish::file_body(path, |_| {}).await.expect("the body opens");
            client.put_blob(&ctx, hash, size, body).await.expect("the upload is taken");
        }
        assert!(client.head_blob(&guest, &listing_hash).await.expect("HEAD answers"));
        let published: BundleVersion = client
            .request(
                &ctx,
                Method::POST,
                &format!("{bundle_path}/versions/{}/publish", created.version.summary.id),
                None,
                Auth::Required,
            )
            .await
            .expect("the version publishes");
        assert_eq!(published.summary.status, BundleVersion::PUBLISHED);
        assert_eq!(
            published.manifest.components[0].files[0].listing.as_ref().map(|l| l.sha256.as_str()),
            Some(listing_hash.as_str()),
            "the listing survives the round trip"
        );

        // 5. Back through the caches: the listing, then the config, each
        //    twice, the second time without the network.
        let read = listing::bundle_listing(&paths, &client, &guest, &listing_hash)
            .await
            .expect("the listing reads");
        assert_eq!(read.total, 2);
        assert_eq!(read.entries[0].path, format!("models/run{stamp}.md3"));
        assert_eq!(read.bytes, 8 + 5);
        let cached = paths.bundle_listings_cache_dir().join(format!("{listing_hash}.json"));
        assert_eq!(std::fs::read(&cached).unwrap(), listing_bytes);
        let again = listing::bundle_listing(&paths, &client, &guest, &listing_hash).await.unwrap();
        assert_eq!(again, read);
        let text = listing::bundle_text(&paths, &client, &guest, &cfg_hash, "base/autoexec.cfg")
            .await
            .expect("the config reads");
        assert_eq!(text, cfg_text);
        assert!(paths.bundle_preview_cache_dir().join(format!("{cfg_hash}.txt")).is_file());
        assert_eq!(
            listing::bundle_text(&paths, &client, &guest, &cfg_hash, "base/autoexec.cfg").await.unwrap(),
            cfg_text
        );
        // The path says what the hash is: a pk3 is not read as text, however
        // small, and the cache is not even looked at.
        let refused = listing::bundle_text(&paths, &client, &guest, &cfg_hash, "base/rus.pk3")
            .await
            .expect_err("a pk3 is not text");
        assert!(matches!(refused, AppError::InvalidInput(_)), "{refused}");
        let unknown = listing::bundle_text(&paths, &client, &guest, &"0".repeat(64), "base/autoexec.cfg")
            .await
            .expect_err("an unknown hash is refused");
        assert!(matches!(&unknown, AppError::Online { code, .. } if code == "not_found"), "{unknown}");
        // A file over the limit of the reader is refused before it is read.
        let tiny = temp.path().join("tiny.bin");
        let refused = preview::cached_blob_bytes(&client, &guest, &pk3_hash, &tiny, 4).await.expect_err("too big");
        assert!(matches!(refused, AppError::InvalidInput(_)), "{refused}");
        assert!(!tiny.exists());
        println!("mock: bundle {} published with a picture and a listing", bundle.card.slug);
    }

    /// The fourth edition against the stand-in: a bundle is created with a
    /// main language and a translation, the translation reads back from the
    /// details with its description and from the card of the catalogue
    /// without it, `PUT` replaces the whole set, the catalogue finds the
    /// bundle by a translated name, and what the service must refuse is
    /// refused. Ignored for the same reason as the tests above. Run it by
    /// hand:
    /// `cargo test --lib -- --ignored --nocapture bundles::tests::mock_publish_carries`.
    #[tokio::test]
    #[ignore = "starts scripts/mock-online.mjs, so it needs Node and a free port"]
    async fn mock_publish_carries_the_language_and_the_translations_of_a_bundle() {
        use manifest::{FileKind, FileRoot, FileSource, ManifestFile};
        use types::CreatedVersion;

        let mock = Service::start(8798);
        let client = OnlineClient::new();
        let guest = OnlineContext {
            base_url: mock.base_url(),
            token: None,
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() % 100_000)
            .unwrap_or(0);
        let token = dev_sign_in(&client, &guest, &format!("Translator{stamp}")).await;
        let ctx = OnlineContext {
            base_url: mock.base_url(),
            token: Some(token),
        };

        // 1. A bundle in English with a Russian translation, as the fields
        //    of a draft go up.
        let name = format!("Translated bundle {stamp}");
        let russian_name = format!("Переведённая сборка {stamp}");
        let fields = |summary: &str, translations: serde_json::Value| {
            serde_json::json!({
                "name": name, "summary": summary, "description": "# Translated",
                "language": "en", "translations": translations,
                "game": "ja", "tags": ["test"], "website": null, "discord": null,
            })
        };
        let russian = serde_json::json!({
            "name": russian_name, "summary": "Русское издание", "description": "# Перевод",
        });
        let bundle: BundleDetails = client
            .request(
                &ctx,
                Method::POST,
                "/v1/bundles",
                Some(fields("s", serde_json::json!({ "ru": russian }))),
                Auth::Required,
            )
            .await
            .expect("the bundle is created");
        assert_eq!(bundle.card.language, "en");
        assert_eq!(bundle.card.translations.len(), 1, "{:?}", bundle.card.translations);
        assert_eq!(bundle.card.translations["ru"].name, russian_name);
        assert_eq!(bundle.card.translations["ru"].summary, "Русское издание");
        assert_eq!(
            bundle.card.translations["ru"].description.as_deref(),
            Some("# Перевод"),
            "the details carry the description of a translation"
        );
        let bundle_path = format!("/v1/bundles/{}", bundle.card.id);

        // 2. What the service refuses: the main language among the
        //    translations, a code it does not know.
        for (body, why) in [
            (fields("s", serde_json::json!({ "en": russian })), "the main language"),
            (fields("s", serde_json::json!({ "xx": russian })), "an unknown code"),
            (
                serde_json::json!({
                    "name": name, "summary": "s", "description": "d", "language": "xx",
                    "game": "ja", "tags": [], "website": null, "discord": null,
                }),
                "an unknown main language",
            ),
        ] {
            let refused = client
                .request::<BundleDetails>(&ctx, Method::POST, "/v1/bundles", Some(body), Auth::Required)
                .await
                .expect_err(why);
            assert!(matches!(&refused, AppError::Online { code, .. } if code == "invalid"), "{why}: {refused}");
        }

        // 3. `PUT` replaces the set whole: Ukrainian in, Russian out.
        let read: BundleDetails = client
            .request(&ctx, Method::GET, &bundle_path, None, Auth::Required)
            .await
            .expect("the bundle reads");
        let mut body = fields(
            "updated",
            serde_json::json!({ "uk": { "name": format!("Перекладена збірка {stamp}"), "summary": "", "description": "" } }),
        );
        body["revision"] = serde_json::json!(read.revision);
        let updated: BundleDetails = client
            .request(&ctx, Method::PUT, &bundle_path, Some(body), Auth::Required)
            .await
            .expect("the bundle is updated");
        assert_eq!(updated.card.translations.keys().collect::<Vec<_>>(), ["uk"]);
        assert_eq!(updated.card.translations["uk"].summary, "", "an empty field is kept as not translated");
        // And back to Russian, with the description, for the catalogue.
        let mut body = fields("updated", serde_json::json!({ "ru": russian }));
        body["revision"] = serde_json::json!(updated.revision);
        let restored: BundleDetails = client
            .request(&ctx, Method::PUT, &bundle_path, Some(body), Auth::Required)
            .await
            .expect("the bundle is updated again");
        assert_eq!(restored.card.translations.keys().collect::<Vec<_>>(), ["ru"]);

        // 4. A version with one file, published, so the bundle is in the
        //    catalogue.
        let temp = tempfile::tempdir().expect("a folder");
        let cfg = temp.path().join("run.cfg");
        let cfg_text = format!("seta name \"Translator {stamp}\"\n");
        std::fs::write(&cfg, cfg_text.as_bytes()).unwrap();
        let cfg_hash = sha256_of(&cfg).unwrap();
        let mut manifest = manifest::test_support::manifest();
        manifest.components.truncate(1);
        manifest.components[0].overlay = manifest::ManifestOverlay::default();
        manifest.components[0].files = vec![ManifestFile {
            root: FileRoot::Home,
            path: "base/run.cfg".into(),
            size: cfg_text.len() as u64,
            sha256: cfg_hash.clone(),
            kind: FileKind::Cfg,
            source: FileSource::Blob,
            replaces: None,
            origin: None,
            library: None,
            listing: None,
        }];
        manifest.shared.files.clear();
        manifest::validate(&manifest).expect("valid");
        let created: CreatedVersion = client
            .request(
                &ctx,
                Method::POST,
                &format!("{bundle_path}/versions"),
                Some(serde_json::json!({ "label": "1", "changelog": "", "manifest": manifest })),
                Auth::Required,
            )
            .await
            .expect("the version is drafted");
        if !client.head_blob(&guest, &cfg_hash).await.expect("HEAD answers") {
            let body = publish::file_body(&cfg, |_| {}).await.expect("the body opens");
            client
                .put_blob(&ctx, &cfg_hash, cfg_text.len() as u64, body)
                .await
                .expect("the upload is taken");
        }
        let published: BundleVersion = client
            .request(
                &ctx,
                Method::POST,
                &format!("{bundle_path}/versions/{}/publish", created.version.summary.id),
                None,
                Auth::Required,
            )
            .await
            .expect("the version publishes");
        assert_eq!(published.summary.status, BundleVersion::PUBLISHED);

        // 5. The card of the catalogue: the language and the translation
        //    without its description; the details with it. The catalogue
        //    finds the bundle by its translated name too.
        let card_of = |list: BundleList| list.items.into_iter().find(|card| card.id == bundle.card.id);
        let path = catalogue_path(
            Game::JediAcademy,
            &BundleQuery {
                q: Some(name.clone()),
                ..BundleQuery::default()
            },
        );
        let list: BundleList = client
            .request(&ctx, Method::GET, &path, None, Auth::Optional)
            .await
            .expect("the catalogue answers");
        let card = card_of(list).expect("the bundle is in the catalogue under its name");
        assert_eq!(card.language, "en");
        assert_eq!(card.translations["ru"].name, russian_name);
        assert_eq!(card.translations["ru"].summary, "Русское издание");
        assert_eq!(
            card.translations["ru"].description, None,
            "a card of the catalogue carries no description of a translation"
        );
        let path = catalogue_path(
            Game::JediAcademy,
            &BundleQuery {
                q: Some(russian_name.clone()),
                ..BundleQuery::default()
            },
        );
        let list: BundleList = client
            .request(&ctx, Method::GET, &path, None, Auth::Optional)
            .await
            .expect("the catalogue answers");
        assert!(
            card_of(list).is_some(),
            "the catalogue finds the bundle by its translated name"
        );
        let details: BundleDetails = client
            .request(&ctx, Method::GET, &bundle_path, None, Auth::Optional)
            .await
            .expect("the details read");
        assert_eq!(details.card.language, "en");
        assert_eq!(details.card.translations["ru"].description.as_deref(), Some("# Перевод"));
        assert_eq!(details.description, "# Translated");
        let mine: MyBundles = client
            .request(&ctx, Method::GET, "/v1/bundles/me", None, Auth::Required)
            .await
            .expect("my bundles read");
        let own = mine
            .bundles
            .iter()
            .find(|b| b.card.id == bundle.card.id)
            .expect("the bundle is among mine");
        assert_eq!(own.card.translations["ru"].name, russian_name);
        println!(
            "mock: bundle {} published in {} with translations into {:?}",
            bundle.card.slug,
            details.card.language,
            details.card.translations.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_file_hashes_to_the_same_value_as_its_bytes() {
        let temp = tempfile::tempdir().expect("a folder");
        let path = temp.path().join("x.bin");
        let body: Vec<u8> = (0..(300 * 1024)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &body).expect("written");
        assert_eq!(sha256_of(&path).expect("hash"), test_support::sha256_hex(&body));
    }
}
