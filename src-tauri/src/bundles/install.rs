//! Installing a bundle: one client per component, its engine, its overlay,
//! its files, its configs.
//!
//! `install_bundle` and `install_bundle_draft` run the same steps over the
//! same manifest; what differs is where the bytes come from, which sits
//! behind [`FileSource`]: the store of the service and jkhub.org for the
//! catalogue, the `files\` folder of the draft for a test install. The
//! engine step, the notifications and the progress events sit behind
//! [`InstallHost`] for the same reason, so the whole run can be driven in a
//! test against a folder.
//!
//! For every selected component, in the order of the manifest:
//!
//! 1. a client is created (or the one an earlier attempt made is continued
//!    in), named `<baseName> · <label>`, with the modes, mod folder and
//!    launch arguments of the component, and the link to the bundle written
//!    into `client.json` with `pending: true`;
//! 2. the engine is installed through `engine_install::install` when it is
//!    not there or the tag differs;
//! 3. the paths of `overlay.remove` are taken out of `engine\`, the overlay
//!    files are laid into `engine\`, the files of the component and then the
//!    shared files into `home\`;
//! 4. the config documents of the component and then the shared ones become
//!    layers of the client;
//! 5. the link is rewritten without `pending`.
//!
//! Every file is checked by its SHA-256 before and after: a file already in
//! place with the right hash is skipped, which is what makes a second call
//! with `existingClientIds` continue where the first one stopped rather than
//! download everything again. A `blob` comes down into
//! `cache\bundles\<sha256>.part`, resumed with a `Range` when a partial file
//! is there, and is moved into the client once the hash matches. A `jkhub`
//! file comes down the way the JKHub tab fetches it, and the pk3 of the
//! manifest's name is taken out of the archive; a hash that differs from the
//! manifest is a warning rather than a failure, because JKHub authors
//! re-upload files under the same record.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::clients::{self, Client, ClientBundleLink};
use crate::configs::{self, NewDocument};
use crate::engine_install::{self, InstallState};
use crate::engines::{self, Engine, LaunchMode};
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::host_system::HostSystem;
use crate::jkhub::source::{HtmlSource, JkhubSource};
use crate::jkhub::types::{JkhubDownload, JkhubFile};
use crate::jkhub::{self, JkhubState};
use crate::library;
use crate::online::{OnlineClient, OnlineContext};
use crate::paths::{self, DataPaths};
use crate::state::AppState;
use crate::timestamp;

use super::draft::{self, Draft};
use super::manifest::{self, FileSource as ManifestSource, Manifest, ManifestComponent, ManifestFile};
use super::types::{BundleDetails, BundleVersion};
use super::{draft_key, sha256_of, version_key, BundlesGuard, BundlesState};

/// Event the install dialog and the card of the client listen to.
pub const PROGRESS_EVENT: &str = "bundles:install-progress";

/// Warning of an install whose JKHub file differs from the manifest.
pub const WARNING_JKHUB_DIFFERS: &str = "jkhubDiffers";

/// Shortest gap between two progress events of one download, in
/// milliseconds.
const PROGRESS_INTERVAL_MS: u128 = 150;

/// Folder under `cache\` the files of the service land in before they are
/// checked.
pub(crate) const CACHE_FOLDER: &str = "bundles";

/// Longest client name `clients::create_record` accepts, in characters.
const MAX_CLIENT_NAME: usize = 48;

/// What joins the base name and the label of a component in a client name.
const NAME_SEPARATOR: &str = " · ";

/// Payload of [`PROGRESS_EVENT`].
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// `None` for an install from a draft.
    pub bundle_id: Option<String>,
    pub version_id: Option<String>,
    /// `None` for an install from the catalogue.
    pub draft_id: Option<String>,
    /// The component being installed, and the client it becomes. `None`
    /// before the first component starts.
    pub component_id: Option<String>,
    pub client_id: Option<String>,
    /// `engine`, `files`, `configs`, `done` or `error`.
    pub phase: &'static str,
    /// One-based index of the file being fetched, zero outside the files.
    pub file_index: u32,
    pub file_count: u32,
    /// Manifest path of the file being fetched, or the file that failed.
    /// `None` between files and on the other phases.
    pub current_file: Option<String>,
    /// Bytes of the current file fetched so far.
    pub downloaded: u64,
    /// Bytes of the current file.
    pub total: u64,
    pub message: String,
    /// Codes of the `done` phase, `jkhubDiffers` today. Empty otherwise.
    pub warnings: Vec<String>,
}

/// What `install_bundle` and `install_bundle_draft` are asked for.
#[derive(Debug, Clone)]
pub(crate) struct InstallArgs {
    pub base_name: String,
    pub component_ids: Vec<String>,
    /// Component id to the client an earlier attempt made for it.
    pub existing_client_ids: HashMap<String, String>,
}

/// Where the manifest came from, which is what the link of a client says.
#[derive(Debug, Clone)]
pub(crate) enum JobOrigin {
    Catalogue {
        bundle: Box<BundleDetails>,
        version: Box<BundleVersion>,
    },
    Draft {
        draft: Box<Draft>,
    },
}

/// One install: the manifest and its origin.
#[derive(Debug, Clone)]
pub(crate) struct Job {
    pub manifest: Manifest,
    pub origin: JobOrigin,
}

impl Job {
    /// The key of [`BundlesState`] the whole install holds.
    fn key(&self) -> String {
        match &self.origin {
            JobOrigin::Catalogue { bundle, version } => version_key(&bundle.card.id, &version.summary.id),
            JobOrigin::Draft { draft } => draft_key(&draft.id),
        }
    }

    fn name(&self) -> &str {
        match &self.origin {
            JobOrigin::Catalogue { bundle, .. } => &bundle.card.name,
            JobOrigin::Draft { draft } => &draft.name,
        }
    }

    /// The link a client of `component` carries, `pending` or finished.
    fn link_for(&self, component: &ManifestComponent, pending: bool) -> ClientBundleLink {
        let (bundle_id, bundle_slug, bundle_name, draft_id, version_id, version_label) = match &self.origin {
            JobOrigin::Catalogue { bundle, version } => (
                Some(bundle.card.id.clone()),
                bundle.card.slug.clone(),
                bundle.card.name.clone(),
                None,
                Some(version.summary.id.clone()),
                version.summary.label.clone(),
            ),
            JobOrigin::Draft { draft } => (
                draft.bundle_id.clone(),
                draft.bundle_slug.clone().unwrap_or_default(),
                draft.name.clone(),
                Some(draft.id.clone()),
                draft.last_version_id.clone(),
                draft.version_label.clone(),
            ),
        };
        ClientBundleLink {
            bundle_id,
            bundle_slug,
            bundle_name,
            draft_id,
            version_id,
            version_label,
            component_id: component.id.clone(),
            component_label: component.label.clone(),
            role: ClientBundleLink::INSTALLED.into(),
            engine_overlay: component.has_engine_overlay(),
            linked_at: timestamp::now_rfc3339(),
            pending,
        }
    }

    /// The ids every event of the install carries.
    fn ids(&self) -> InstallProgress {
        let mut progress = InstallProgress::default();
        match &self.origin {
            JobOrigin::Catalogue { bundle, version } => {
                progress.bundle_id = Some(bundle.card.id.clone());
                progress.version_id = Some(version.summary.id.clone());
            }
            JobOrigin::Draft { draft } => progress.draft_id = Some(draft.id.clone()),
        }
        progress
    }
}

/// One step of laying out the files, for the caller that turns it into an
/// event.
pub(crate) struct FileStep {
    pub index: u32,
    pub count: u32,
    pub path: String,
    pub downloaded: u64,
    pub total: u64,
    pub message: String,
}

/// A progress sink that survives an `await`.
pub(crate) type Report<'a> = &'a mut (dyn FnMut(FileStep) + Send);

/// The archive of one JKHub record, downloaded, and the page it came from.
pub(crate) struct JkhubArchive {
    pub archive: PathBuf,
    pub file: JkhubFile,
}

/// Where the bytes of a file come from.
///
/// Three implementations: the service and jkhub.org for the catalogue, the
/// folder of a draft for a test install, and a folder on disk in the tests.
/// The layout of files knows none of them.
pub(crate) trait FileSource: Sync {
    /// Writes the bytes of a blob into `partial`. `have` is what the file
    /// already holds; the source appends after it when it can resume, and
    /// starts the file over when it cannot.
    fn fetch_blob<'a>(
        &'a self,
        sha256: &'a str,
        size: u64,
        partial: &'a Path,
        have: u64,
        report: &'a mut (dyn FnMut(u64, u64) + Send),
    ) -> BoxFuture<'a, Result<()>>;

    /// Downloads the archive of one JKHub record.
    fn fetch_jkhub<'a>(
        &'a self,
        file_id: u32,
        report: &'a mut (dyn FnMut(u64, u64) + Send),
    ) -> BoxFuture<'a, Result<JkhubArchive>>;

    /// Drops the archive of a record once its pk3 is in the client. The
    /// archive was only ever a cache entry.
    fn forget_jkhub(&self, file_id: u32) {
        let _ = file_id;
    }

    /// Whether every file, a `jkhub` one included, is served through
    /// [`FileSource::fetch_blob`]: a draft holds a copy of each of its files
    /// and asks jkhub.org for nothing.
    fn holds_every_file(&self) -> bool {
        false
    }
}

/// What the install needs from the launcher around it: the engine
/// installer, the notifications, the events.
///
/// A trait so the whole run can be tested against a folder: the engine step
/// of the test writes an executable instead of asking GitHub, and the events
/// land in a list instead of a window.
pub(crate) trait InstallHost: Sync {
    /// Installs the release `tag` (or the newest one) into the client and
    /// answers with the updated record.
    fn install_engine<'a>(&'a self, client_id: &'a str, tag: Option<&'a str>) -> BoxFuture<'a, Result<Client>>;

    /// Tells every window a client record changed.
    fn client_changed(&self, client_id: &str);

    /// Tells the Library screen the files of a client changed.
    fn library_changed(&self, client_id: &str);

    /// Sends one progress event.
    fn progress(&self, event: InstallProgress);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/// One selected component with everything checked about it up front.
struct Selected {
    component: ManifestComponent,
    engine: &'static Engine,
    modes: Vec<LaunchMode>,
}

/// Installs the selected components of a job into clients. The caller
/// holds no claim: the run claims the job and every client it makes.
pub(crate) async fn install(
    state: &AppState,
    bundles: &BundlesState,
    host: &dyn InstallHost,
    source: &dyn FileSource,
    job: Job,
    args: InstallArgs,
) -> Result<Vec<Client>> {
    let mut current = job.ids();
    match install_inner(state, bundles, host, source, &job, &args, &mut current).await {
        Ok((clients, warnings)) => {
            let mut done = current;
            done.phase = "done";
            done.message = format!("{} is ready", job.name());
            done.warnings = warnings;
            host.progress(done);
            Ok(clients)
        }
        Err(e) => {
            log::error!("installing {} failed: {e}", job.key());
            let mut failed = current;
            failed.phase = "error";
            failed.message = e.to_string();
            if let AppError::BundleFile { path, .. } = &e {
                failed.current_file = Some(path.clone());
            }
            host.progress(failed);
            Err(e)
        }
    }
}

/// The checks before anything is claimed: the manifest, the game, the
/// selection, and the engine and modes of every selected component.
fn select(job: &Job, args: &InstallArgs) -> Result<(Game, Vec<Selected>)> {
    let manifest = &job.manifest;
    manifest::validate(manifest)?;
    let game = Game::from_id(&manifest.game).ok_or_else(|| {
        AppError::BundleUnavailable(format!("the game {:?} is not one of ours", manifest.game))
    })?;
    if args.base_name.trim().is_empty() {
        return Err(AppError::InvalidInput("the base name of the clients is empty".into()));
    }
    if args.base_name.trim().chars().count() > MAX_CLIENT_NAME {
        return Err(AppError::InvalidInput(format!(
            "the base name is longer than {MAX_CLIENT_NAME} characters"
        )));
    }
    let mut wanted: Vec<&str> = Vec::new();
    for id in &args.component_ids {
        let id = id.trim();
        if !wanted.contains(&id) {
            wanted.push(id);
        }
    }
    if wanted.is_empty() {
        return Err(AppError::InvalidInput("no component of the bundle is selected".into()));
    }
    for id in &wanted {
        if manifest.component(id).is_none() {
            return Err(AppError::InvalidInput(format!(
                "{} has no component {id:?}",
                job.name()
            )));
        }
    }
    for (id, client_id) in &args.existing_client_ids {
        if !wanted.contains(&id.as_str()) {
            return Err(AppError::InvalidInput(format!(
                "{client_id} continues the component {id:?}, which is not selected"
            )));
        }
    }
    let mut selected = Vec::with_capacity(wanted.len());
    for component in manifest.components.iter().filter(|c| wanted.contains(&c.id.as_str())) {
        let engine = engines::find(&component.engine.engine_id).ok_or_else(|| AppError::EngineUnknown {
            engine_id: component.engine.engine_id.clone(),
        })?;
        if engine.game != game {
            return Err(AppError::BundleUnavailable(format!(
                "the bundle says {} but the engine {} of {} plays {}",
                game.display_name(),
                engine.name,
                component.label,
                engine.game.display_name()
            )));
        }
        engine.require_host(HostSystem::current())?;
        let modes: Vec<LaunchMode> = engine
            .modes()
            .into_iter()
            .filter(|mode| component.modes.contains(mode))
            .collect();
        if modes.is_empty() {
            return Err(AppError::BundleUnavailable(format!(
                "{} starts in none of the modes the component {} asks for",
                engine.name, component.label
            )));
        }
        selected.push(Selected {
            component: component.clone(),
            engine,
            modes,
        });
    }
    Ok((game, selected))
}

/// The name of the client of a component: the base name alone for a single
/// component, the base name and the label otherwise, cut to what a client
/// name may be.
fn client_name(base_name: &str, label: &str, alone: bool) -> String {
    let base = base_name.trim();
    let name = if alone {
        base.to_string()
    } else {
        format!("{base}{NAME_SEPARATOR}{}", label.trim())
    };
    name.chars().take(MAX_CLIENT_NAME).collect::<String>().trim().to_string()
}

async fn install_inner(
    state: &AppState,
    bundles: &BundlesState,
    host: &dyn InstallHost,
    source: &dyn FileSource,
    job: &Job,
    args: &InstallArgs,
    current: &mut InstallProgress,
) -> Result<(Vec<Client>, Vec<String>)> {
    let (game, selected) = select(job, args)?;
    let paths = state.paths()?;
    let cache_dir = paths.cache.join(CACHE_FOLDER);
    let alone = selected.len() == 1;

    // Held until the last record is written, with every client claimed
    // along the way.
    let _job_claim = bundles.claim(&job.key(), BundlesState::INSTALL)?;
    let mut client_claims: Vec<BundlesGuard<'_>> = Vec::with_capacity(selected.len());
    let mut clients = Vec::with_capacity(selected.len());
    let mut warnings: Vec<String> = Vec::new();

    for Selected { component, engine, modes } in &selected {
        // 1. The client, new or continued, and its pending link.
        let link = job.link_for(component, true);
        let existing = args.existing_client_ids.get(&component.id).map(String::as_str);
        let mut client = claim_client(
            bundles,
            state,
            &paths,
            existing,
            &client_name(&args.base_name, &component.label, alone),
            engine,
            game,
            modes,
            component,
            link,
            &mut client_claims,
        )?;
        current.component_id = Some(component.id.clone());
        current.client_id = Some(client.id.clone());
        host.client_changed(&client.id);

        // 2. The engine.
        let engine_dir = paths.client_engine_dir(&client.id);
        let wanted = component.engine.release_tag.as_deref();
        let installed = client.engine_version.as_deref();
        let engine_missing = !engine.installed_executable(&engine_dir).is_file();
        let needs_engine = engine_missing
            || installed.is_none()
            || wanted.is_some_and(|tag| Some(tag) != installed);
        if needs_engine {
            let mut step = current.clone();
            step.phase = "engine";
            step.message = format!("Installing {} {}", engine.name, wanted.unwrap_or("latest"));
            host.progress(step);
            client = host.install_engine(&client.id, wanted).await?;
        }

        // 3. The overlay, then the files of the component and the shared
        //    ones.
        let client_dir = paths.client_dir(&client.id);
        remove_overlay_paths(&engine_dir, &component.overlay.remove)?;
        let files: Vec<&ManifestFile> = component
            .overlay
            .files
            .iter()
            .chain(component.files.iter())
            .chain(job.manifest.shared.files.iter())
            .collect();
        let ids = current.clone();
        let mut report = move |step: FileStep| {
            let mut event = ids.clone();
            event.phase = "files";
            event.file_index = step.index;
            event.file_count = step.count;
            event.current_file = Some(step.path);
            event.downloaded = step.downloaded;
            event.total = step.total;
            event.message = step.message;
            host.progress(event);
        };
        for warning in lay_out_files(source, &client_dir, &cache_dir, &files, &mut report).await? {
            if !warnings.contains(&warning) {
                warnings.push(warning);
            }
        }

        // 4. The configs: the component's, then the shared ones.
        let docs: Vec<NewDocument> = component
            .configs
            .iter()
            .chain(job.manifest.shared.configs.iter())
            .map(|config| NewDocument {
                name: config.name.trim().to_string(),
                text: config.text.clone(),
                priority: config.priority,
            })
            .collect();
        if !docs.is_empty() {
            let mut step = current.clone();
            step.phase = "configs";
            step.message = "Adding the config documents".into();
            host.progress(step);
            configs::install_documents(state, &client, &docs)?;
        }

        // 5. The link, no longer pending.
        let link = job.link_for(component, false);
        let client = clients::edit_record(state.client_records(), &paths, &client.id, |record| {
            record.bundle = Some(link);
        })?;
        host.library_changed(&client.id);
        host.client_changed(&client.id);
        log::info!(
            "installed component {} of {} into {}",
            component.id,
            job.key(),
            client.id
        );
        clients.push(client);
    }
    Ok((clients, warnings))
}

/// Step 1 of one component: the client, new or continued, its record, and
/// the claim on it. Nothing here touches the network, so a test can run it
/// against a folder.
///
/// A continued install is allowed only in a client whose record points at
/// the same bundle (or draft), the same version and the same component with
/// an `installed` link, which the first attempt wrote before it fetched
/// anything; any other client is refused, however well its engine matches,
/// because the files of the component would land on top of whatever the
/// player keeps there.
#[allow(clippy::too_many_arguments)]
fn claim_client<'a>(
    bundles: &'a BundlesState,
    state: &AppState,
    paths: &DataPaths,
    existing: Option<&str>,
    name: &str,
    engine: &Engine,
    game: Game,
    modes: &[LaunchMode],
    component: &ManifestComponent,
    link: ClientBundleLink,
    claims: &mut Vec<BundlesGuard<'a>>,
) -> Result<Client> {
    let client = match existing {
        Some(id) => {
            let client = clients::read_record(paths, id)?;
            check_existing_client(&client, engine, game, &link)?;
            client
        }
        None => clients::create_record(paths, name, engine.id, game, Some(modes))?,
    };
    claims.push(bundles.claim(&client.id, BundlesState::INSTALL)?);
    let fs_game = component
        .fs_game
        .as_deref()
        .map(clients::validate_fs_game)
        .transpose()?
        .flatten();
    let launch_args = component.launch_args.trim().to_string();
    let modes = modes.to_vec();
    clients::edit_record(state.client_records(), paths, &client.id, |record| {
        record.bundle = Some(link);
        record.fs_game = fs_game;
        record.launch_args = launch_args;
        record.modes = modes;
    })
}

/// Whether an install of `link` may continue in `client`.
fn check_existing_client(client: &Client, engine: &Engine, game: Game, link: &ClientBundleLink) -> Result<()> {
    if client.engine_id != engine.id || client.game != game {
        return Err(AppError::State(format!(
            "{} runs {} for {}, and the component needs {} for {}",
            client.name,
            client.engine_id,
            client.game.display_name(),
            engine.id,
            game.display_name()
        )));
    }
    let what = match (&link.bundle_id, &link.draft_id) {
        (_, Some(draft_id)) => format!("the draft {draft_id}"),
        (Some(_), None) => format!("{} {}", link.bundle_name, link.version_label),
        (None, None) => link.bundle_name.clone(),
    };
    let same_origin = |own: &ClientBundleLink| match (&link.draft_id, &link.bundle_id) {
        (Some(draft_id), _) => own.draft_id.as_deref() == Some(draft_id.as_str()),
        (None, Some(bundle_id)) => {
            own.draft_id.is_none()
                && own.bundle_id.as_deref() == Some(bundle_id.as_str())
                && own.version_id == link.version_id
        }
        (None, None) => false,
    };
    match &client.bundle {
        Some(own) if same_origin(own) && own.component_id == link.component_id && own.role == ClientBundleLink::INSTALLED => Ok(()),
        Some(own) if same_origin(own) => Err(AppError::InvalidInput(format!(
            "{} is the component {:?} of {what}, not {:?}. Install the bundle into new clients.",
            client.name, own.component_id, link.component_id
        ))),
        Some(own) => Err(AppError::InvalidInput(format!(
            "{} is linked to {} {}, not to {what}. Install the bundle into new clients.",
            client.name, own.bundle_name, own.version_label
        ))),
        None => Err(AppError::InvalidInput(format!(
            "{} was not created from {what}. Install the bundle into new clients.",
            client.name
        ))),
    }
}

/// Takes the paths of `overlay.remove` out of `engine\`. A path already
/// gone is nothing to do; a path that would leave the folder is refused.
fn remove_overlay_paths(engine_dir: &Path, remove: &[String]) -> Result<()> {
    for path in remove {
        let target = target_path(engine_dir, path)?;
        match fs::remove_file(&target) {
            Ok(()) => log::info!("removed {} of the release", path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::io_path("cannot remove", &target, e)),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The layout of files
// ---------------------------------------------------------------------------

/// Lays every file into the client, in the order given.
///
/// Returns the warnings of the run. The caller decides what a step looks
/// like on screen; a test passes a closure that remembers them.
pub(crate) async fn lay_out_files<S: FileSource + ?Sized>(
    source: &S,
    client_dir: &Path,
    cache_dir: &Path,
    files: &[&ManifestFile],
    report: Report<'_>,
) -> Result<Vec<String>> {
    let count = files.len() as u32;
    let mut warnings = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let index = index as u32 + 1;
        let root = client_dir.join(file.root.as_str());
        let target = target_path(&root, &file.path)?;
        let mut say = |downloaded: u64, total: u64, message: &str| {
            report(FileStep {
                index,
                count,
                path: file.path.clone(),
                downloaded,
                total,
                message: format!("{message} {}", file.path),
            });
        };
        say(0, file.size, "Fetching");
        let mut on_bytes = |downloaded: u64, total: u64| say(downloaded, total, "Fetching");
        let fetched = fetch_file(source, cache_dir, file, &target, Some(client_dir), &mut on_bytes).await?;
        if fetched.differs && !warnings.iter().any(|known| known == WARNING_JKHUB_DIFFERS) {
            warnings.push(WARNING_JKHUB_DIFFERS.to_string());
        }
        say(file.size, file.size, if fetched.skipped { "Already there:" } else { "Installed" });
    }
    Ok(warnings)
}

/// What [`fetch_file`] answers with.
pub(crate) struct Fetched {
    pub size: u64,
    /// The hash of the file that landed: the manifest's for a blob, the
    /// actual one for a JKHub file, which may differ.
    pub sha256: String,
    /// Whether a JKHub file differs from the manifest.
    pub differs: bool,
    /// Whether the file was already in place.
    pub skipped: bool,
}

/// Puts one file of a manifest at `target`: nothing when it is there
/// already, a blob through the cache and a hash check otherwise, a JKHub
/// file through the archive of its record. `provenance_dir` is the client
/// the JKHub record is noted in, `None` for a draft.
pub(crate) async fn fetch_file<S: FileSource + ?Sized>(
    source: &S,
    cache_dir: &Path,
    file: &ManifestFile,
    target: &Path,
    provenance_dir: Option<&Path>,
    report: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<Fetched> {
    if is_in_place(target, file.size, &file.sha256).await? {
        return Ok(Fetched {
            size: file.size,
            sha256: file.sha256.clone(),
            differs: false,
            skipped: true,
        });
    }
    match &file.source {
        ManifestSource::Jkhub { file_id, .. } if !source.holds_every_file() => {
            let (landed, sha256) =
                fetch_jkhub_into(source, provenance_dir, *file_id, &file.path, target, report).await?;
            let size = fs::metadata(&landed).map(|meta| meta.len()).unwrap_or(file.size);
            let differs = sha256 != file.sha256;
            if differs {
                log::warn!(
                    "bundles: {} from JKHub record {file_id} differs from the manifest",
                    file.path
                );
            }
            Ok(Fetched {
                size,
                sha256,
                differs,
                skipped: false,
            })
        }
        _ => {
            fetch_blob_into(source, cache_dir, &file.sha256, file.size, target, &file.path, report).await?;
            Ok(Fetched {
                size: file.size,
                sha256: file.sha256.clone(),
                differs: false,
                skipped: false,
            })
        }
    }
}

/// Where a manifest path lands, checked twice: by the rules of the manifest
/// and by the rules of an archive entry.
fn target_path(root: &Path, path: &str) -> Result<PathBuf> {
    manifest::check_path(path)?;
    engine_install::safe_entry_path(root, path)
}

/// Whether the file at `target` already is the file the manifest describes.
///
/// The size is read here; the hash, which reads the whole file, on a
/// blocking thread.
async fn is_in_place(target: &Path, size: u64, sha256: &str) -> Result<bool> {
    let Ok(meta) = fs::metadata(target) else {
        return Ok(false);
    };
    if !meta.is_file() || meta.len() != size {
        return Ok(false);
    }
    Ok(hash_off_thread(target).await? == sha256)
}

/// SHA-256 of a file on a blocking thread: a file of a bundle runs to
/// hundreds of megabytes, and the thread of the runtime that reads it would
/// hold up every other command for the seconds that takes.
pub(crate) async fn hash_off_thread(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || sha256_of(&path))
        .await
        .map_err(|e| AppError::State(format!("the hashing thread stopped: {e}")))?
}

/// Downloads a blob into the cache, checks it and moves it into place.
async fn fetch_blob_into<S: FileSource + ?Sized>(
    source: &S,
    cache_dir: &Path,
    sha256: &str,
    size: u64,
    target: &Path,
    manifest_path: &str,
    report: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<()> {
    paths::create_dir(cache_dir)?;
    let partial = cache_dir.join(format!("{sha256}.part"));
    let have = fs::metadata(&partial)
        .ok()
        .filter(|meta| meta.is_file() && meta.len() < size)
        .map(|meta| meta.len())
        .unwrap_or_else(|| {
            // A partial file as big as the whole one, or bigger, is not a
            // file to resume: it is a file that failed its check last time.
            let _ = fs::remove_file(&partial);
            0
        });
    let fetched = source.fetch_blob(sha256, size, &partial, have, report).await;
    if let Err(e) = fetched {
        // A network failure leaves the partial file for the next run to
        // resume. An answer of the service does not: a file the service
        // refuses to serve is not one to resume, and a range it refused
        // would be refused again.
        if !matches!(e, AppError::Network(_)) {
            let _ = fs::remove_file(&partial);
        }
        return Err(match e {
            AppError::BundleFile { .. } => e,
            other => AppError::BundleFile {
                path: manifest_path.to_string(),
                reason: other.to_string(),
            },
        });
    }
    let actual = fs::metadata(&partial)
        .map(|meta| meta.len())
        .map_err(|e| AppError::io_path("cannot read", &partial, e))?;
    if actual != size {
        let _ = fs::remove_file(&partial);
        return Err(AppError::BundleFile {
            path: manifest_path.to_string(),
            reason: format!("the source sent {actual} bytes instead of {size}"),
        });
    }
    let hash = hash_off_thread(&partial).await?;
    if hash != sha256 {
        let _ = fs::remove_file(&partial);
        return Err(AppError::BundleFile {
            path: manifest_path.to_string(),
            reason: "the fetched file does not match the hash of the manifest".into(),
        });
    }
    move_into_place(&partial, target)
}

/// Downloads a JKHub record and takes the named pk3 out of it.
///
/// Answers with the path the pk3 landed at and its hash.
async fn fetch_jkhub_into<S: FileSource + ?Sized>(
    source: &S,
    provenance_dir: Option<&Path>,
    file_id: u32,
    manifest_path: &str,
    target: &Path,
    report: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<(PathBuf, String)> {
    let Some((folder, file_name)) = manifest_path.rsplit_once('/') else {
        return Err(AppError::BundleFile {
            path: manifest_path.to_string(),
            reason: "a JKHub file lands in a folder of home, and the path names none".into(),
        });
    };
    let downloaded = source.fetch_jkhub(file_id, report).await.map_err(|e| match e {
        AppError::BundleFile { .. } => e,
        other => AppError::BundleFile {
            path: manifest_path.to_string(),
            reason: other.to_string(),
        },
    })?;

    let contents = jkhub::install::read_archive(&downloaded.archive).map_err(|e| AppError::BundleFile {
        path: manifest_path.to_string(),
        reason: e.to_string(),
    })?;
    let Some(entry) = contents
        .pk3
        .iter()
        .find(|entry| entry.file_name.eq_ignore_ascii_case(file_name))
    else {
        let inside: Vec<&str> = contents.pk3.iter().map(|entry| entry.file_name.as_str()).collect();
        return Err(AppError::BundleFile {
            path: manifest_path.to_string(),
            reason: format!(
                "JKHub record {file_id} holds no {file_name}; it holds: {}",
                if inside.is_empty() { "no pk3 at all".to_string() } else { inside.join(", ") }
            ),
        });
    };
    let target_folder = target
        .parent()
        .ok_or_else(|| AppError::BundleFile {
            path: manifest_path.to_string(),
            reason: "the path has no folder".into(),
        })?
        .to_path_buf();
    paths::create_dir(&target_folder)?;
    // The pk3 lands under the name the archive spells; on the disk the
    // client lives on, that is the file the manifest names.
    let (archive, entry, folder_for_extract) = (downloaded.archive.clone(), entry.clone(), target_folder.clone());
    let written = tauri::async_runtime::spawn_blocking(move || {
        jkhub::install::extract(&archive, &[entry], &folder_for_extract)
    })
    .await
    .map_err(|e| AppError::Archive(format!("the unpacker stopped: {e}")))?
    .map_err(|e| AppError::BundleFile {
        path: manifest_path.to_string(),
        reason: e.to_string(),
    })?;
    let landed = target_folder.join(written.first().map(String::as_str).unwrap_or(file_name));
    let sha256 = hash_off_thread(&landed).await?;
    if let Some(client_dir) = provenance_dir {
        jkhub::record(client_dir, folder, &[landed_name(&landed, file_name)], &downloaded.file)?;
    }
    source.forget_jkhub(file_id);
    Ok((landed, sha256))
}

/// The name the pk3 was written under.
fn landed_name(landed: &Path, fallback: &str) -> String {
    landed
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback)
        .to_string()
}

/// Moves a checked file into the client, replacing whatever is there.
///
/// A rename first; a copy when the cache and the client sit on different
/// volumes, which `dataDirOverride` cannot cause but a junction can.
fn move_into_place(from: &Path, to: &Path) -> Result<()> {
    move_with(from, to, |from: &Path, to: &Path| fs::rename(from, to))
}

/// [`move_into_place`] with the rename handed in, so a test can make it
/// fail the way a rename across volumes fails and see the copy run.
fn move_with(
    from: &Path,
    to: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    if let Some(parent) = to.parent() {
        paths::create_dir(parent)?;
    }
    if to.exists() {
        fs::remove_file(to).map_err(|e| AppError::io_path("cannot replace", to, e))?;
    }
    if rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| AppError::io_path("cannot copy into", to, e))?;
    fs::remove_file(from).map_err(|e| AppError::io_path("cannot remove", from, e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The sources and the host of the launcher
// ---------------------------------------------------------------------------

/// The service and jkhub.org.
pub(crate) struct OnlineSource<'a> {
    app: &'a AppHandle,
    online: &'a OnlineClient,
    ctx: OnlineContext,
    jkhub: &'a JkhubState,
    paths: DataPaths,
}

impl<'a> OnlineSource<'a> {
    pub(crate) fn new(
        app: &'a AppHandle,
        online: &'a OnlineClient,
        ctx: OnlineContext,
        jkhub: &'a JkhubState,
        paths: DataPaths,
    ) -> Self {
        OnlineSource {
            app,
            online,
            ctx,
            jkhub,
            paths,
        }
    }
}

/// Downloads the archive of one JKHub record the way the JKHub tab does,
/// with `jkhub:download-progress` along the way, and answers with its path
/// and the page of the record.
pub(crate) async fn fetch_jkhub_archive(
    app: &AppHandle,
    jkhub: &JkhubState,
    paths: &DataPaths,
    file_id: u32,
    report: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<JkhubArchive> {
    let http = jkhub.client()?;
    let view = HtmlSource::new(http, paths).file(file_id).await?;
    let resolved = jkhub::download::resolve(http, file_id, &view.file.slug).await?;
    let (url, file_name, size) = match resolved {
        JkhubDownload::Hosted {
            url,
            file_name,
            size,
            ..
        } => (url, file_name, size),
        JkhubDownload::External { url } => {
            return Err(AppError::JkhubDownload(format!(
                "JKHub record {file_id} links to another site: {url}"
            )))
        }
    };
    report(0, size.unwrap_or(0));
    let dir = jkhub::cache::download_dir(paths, file_id)?;
    let archive = jkhub::download::fetch(app, http, file_id, &url, &dir, &file_name, size).await?;
    let bytes = fs::metadata(&archive).map(|meta| meta.len()).unwrap_or(0);
    report(bytes, bytes);
    Ok(JkhubArchive {
        archive,
        file: view.file,
    })
}

impl FileSource for OnlineSource<'_> {
    fn fetch_blob<'a>(
        &'a self,
        sha256: &'a str,
        size: u64,
        partial: &'a Path,
        have: u64,
        report: &'a mut (dyn FnMut(u64, u64) + Send),
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let response = self.online.get_blob(&self.ctx, sha256, have).await?;
            // A server that ignored the range restarts the file, so the
            // partial one has to go: appending would splice two copies.
            let resuming = have > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
            let mut received = if resuming { have } else { 0 };
            let mut sink = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(resuming)
                .truncate(!resuming)
                .open(partial)
                .await
                .map_err(|e| AppError::io_path("cannot create", partial, e))?;
            let mut stream = response.bytes_stream();
            let mut last = std::time::Instant::now();
            report(received, size);
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| AppError::Network(format!("the download stopped: {e}")))?;
                sink.write_all(&chunk)
                    .await
                    .map_err(|e| AppError::io_path("cannot write", partial, e))?;
                received += chunk.len() as u64;
                if last.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
                    last = std::time::Instant::now();
                    report(received, size);
                }
            }
            sink.flush()
                .await
                .map_err(|e| AppError::io_path("cannot write", partial, e))?;
            sink.sync_all()
                .await
                .map_err(|e| AppError::io_path("cannot write", partial, e))?;
            report(received, size);
            Ok(())
        })
    }

    fn fetch_jkhub<'a>(
        &'a self,
        file_id: u32,
        report: &'a mut (dyn FnMut(u64, u64) + Send),
    ) -> BoxFuture<'a, Result<JkhubArchive>> {
        Box::pin(fetch_jkhub_archive(self.app, self.jkhub, &self.paths, file_id, report))
    }

    fn forget_jkhub(&self, file_id: u32) {
        jkhub::cache::forget_download(&self.paths, file_id);
    }
}

/// The `files\` folder of a draft: every file the manifest names, by its
/// hash, JKHub files included.
pub(crate) struct DraftSource {
    files: HashMap<String, PathBuf>,
}

impl DraftSource {
    pub(crate) fn new(paths: &DataPaths, draft: &Draft) -> Self {
        DraftSource {
            files: draft::files_by_hash(paths, draft),
        }
    }
}

impl FileSource for DraftSource {
    fn fetch_blob<'a>(
        &'a self,
        sha256: &'a str,
        size: u64,
        partial: &'a Path,
        _have: u64,
        report: &'a mut (dyn FnMut(u64, u64) + Send),
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let Some(source) = self.files.get(sha256) else {
                return Err(AppError::BundleFile {
                    path: sha256.to_string(),
                    reason: "the draft holds no file with this hash".into(),
                });
            };
            let (from, to) = (source.clone(), partial.to_path_buf());
            tauri::async_runtime::spawn_blocking(move || {
                fs::copy(&from, &to)
                    .map(|_| ())
                    .map_err(|e| AppError::io_path("cannot copy", &from, e))
            })
            .await
            .map_err(|e| AppError::State(format!("the copy thread stopped: {e}")))??;
            report(size, size);
            Ok(())
        })
    }

    fn fetch_jkhub<'a>(
        &'a self,
        file_id: u32,
        _report: &'a mut (dyn FnMut(u64, u64) + Send),
    ) -> BoxFuture<'a, Result<JkhubArchive>> {
        Box::pin(async move {
            Err(AppError::BundleFile {
                path: format!("jkhub:{file_id}"),
                reason: "a draft holds its JKHub files itself and asks jkhub.org for nothing".into(),
            })
        })
    }

    fn holds_every_file(&self) -> bool {
        true
    }
}

/// The launcher itself: the engine installer, the windows, the events.
pub(crate) struct TauriHost<'a> {
    pub app: &'a AppHandle,
    pub installs: &'a InstallState,
    pub paths: DataPaths,
}

impl InstallHost for TauriHost<'_> {
    fn install_engine<'a>(&'a self, client_id: &'a str, tag: Option<&'a str>) -> BoxFuture<'a, Result<Client>> {
        Box::pin(engine_install::install(self.app, self.installs, &self.paths, client_id, tag))
    }

    fn client_changed(&self, client_id: &str) {
        clients::emit_changed(self.app, client_id);
    }

    fn library_changed(&self, client_id: &str) {
        library::notify(self.app, client_id);
    }

    fn progress(&self, event: InstallProgress) {
        if let Err(e) = self.app.emit(PROGRESS_EVENT, event) {
            log::warn!("cannot emit {PROGRESS_EVENT}: {e}");
        }
    }
}

/// The provenance of the files a bundle fetched from JKHub, keyed the way
/// the library keys them. Read back by the tests.
#[cfg(test)]
pub(crate) fn provenance_of(
    client_dir: &Path,
) -> std::collections::BTreeMap<String, crate::jkhub::types::Provenance> {
    library::read_provenance(client_dir)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;
    use crate::bundles::draft::test_support::{component, empty_draft, put_draft_file};
    use crate::bundles::draft::{DraftConfig, DraftOrigin};
    use crate::bundles::manifest::{FileKind, FileRoot, ManifestComponent, ManifestEngine, ManifestOverlay, ManifestShared, SCHEMA};
    use crate::bundles::test_support::sha256_hex;
    use crate::jkhub::types::JkhubGame;

    /// A source that reads from a folder on disk: `blobs\<sha256>` for the
    /// service's files, `jkhub\<fileId>.zip` for the archives of records.
    struct DiskSource {
        root: PathBuf,
        /// Every blob request, as `(sha256, have)`, so a test can see which
        /// files were fetched and where they resumed.
        requests: Arc<Mutex<Vec<(String, u64)>>>,
        /// Whether the source honours `have`, the way a `206` does.
        resumes: bool,
    }

    impl FileSource for DiskSource {
        fn fetch_blob<'a>(
            &'a self,
            sha256: &'a str,
            size: u64,
            partial: &'a Path,
            have: u64,
            report: &'a mut (dyn FnMut(u64, u64) + Send),
        ) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move {
                self.requests.lock().unwrap().push((sha256.to_string(), have));
                let bytes = fs::read(self.root.join("blobs").join(sha256))
                    .map_err(|e| AppError::Network(format!("no such blob {sha256}: {e}")))?;
                let (from, truncate) = if self.resumes && have > 0 {
                    (have as usize, false)
                } else {
                    (0, true)
                };
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .append(!truncate)
                    .truncate(truncate)
                    .open(partial)
                    .map_err(|e| AppError::io_path("cannot open", partial, e))?;
                file.write_all(&bytes[from.min(bytes.len())..])
                    .map_err(|e| AppError::io_path("cannot write", partial, e))?;
                report(size, size);
                Ok(())
            })
        }

        fn fetch_jkhub<'a>(
            &'a self,
            file_id: u32,
            report: &'a mut (dyn FnMut(u64, u64) + Send),
        ) -> BoxFuture<'a, Result<JkhubArchive>> {
            Box::pin(async move {
                let archive = self.root.join("jkhub").join(format!("{file_id}.zip"));
                if !archive.is_file() {
                    return Err(AppError::JkhubDownload(format!("no archive for record {file_id}")));
                }
                report(1, 1);
                Ok(JkhubArchive {
                    archive,
                    file: JkhubFile {
                        id: file_id,
                        slug: format!("record-{file_id}"),
                        title: format!("Record {file_id}"),
                        url: format!("https://jkhub.org/files/file/{file_id}-record/"),
                        game: JkhubGame::Ja,
                        category_id: None,
                        category_name: None,
                        author: None,
                        description: String::new(),
                        description_html: String::new(),
                        submitted_at: None,
                        updated_at: Some("2026-09-01T00:00:00Z".into()),
                        version: Some("1.6.5".into()),
                        views: 0,
                        downloads: 0,
                        comments: 0,
                        reviews: 0,
                        rating: None,
                        screenshots: Vec::new(),
                        tags: Vec::new(),
                        changelog: Vec::new(),
                    },
                })
            })
        }
    }

    /// A host that writes an executable instead of asking GitHub and keeps
    /// every event and notification in a list.
    struct TestHost {
        paths: DataPaths,
        events: Mutex<Vec<InstallProgress>>,
        changed: Mutex<Vec<String>>,
        engines_installed: Mutex<Vec<(String, Option<String>)>>,
    }

    impl TestHost {
        fn new(paths: &DataPaths) -> Self {
            TestHost {
                paths: paths.clone(),
                events: Mutex::new(Vec::new()),
                changed: Mutex::new(Vec::new()),
                engines_installed: Mutex::new(Vec::new()),
            }
        }

        fn phases(&self) -> Vec<(Option<String>, &'static str)> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .map(|event| (event.component_id.clone(), event.phase))
                .collect()
        }
    }

    impl InstallHost for TestHost {
        fn install_engine<'a>(&'a self, client_id: &'a str, tag: Option<&'a str>) -> BoxFuture<'a, Result<Client>> {
            Box::pin(async move {
                self.engines_installed
                    .lock()
                    .unwrap()
                    .push((client_id.to_string(), tag.map(str::to_string)));
                let client = clients::read_record(&self.paths, client_id)?;
                let engine = engines::require(&client.engine_id)?;
                let dir = self.paths.client_engine_dir(client_id);
                // The release: the executable, a renderer to remove, a module.
                fs::create_dir_all(dir.join("base")).unwrap();
                fs::write(dir.join(engine.executable), b"MZ release").unwrap();
                if let Some(single) = engine.single_player {
                    fs::write(dir.join(single.executable), b"MZ sp").unwrap();
                }
                fs::write(dir.join("rd-vulkan_x86.dll"), b"vulkan").unwrap();
                fs::write(dir.join("base").join("cgamex86.dll"), b"cgame").unwrap();
                let lock = crate::state::StepLock::default();
                clients::edit_record(&lock, &self.paths, client_id, |record| {
                    record.engine_version = Some(tag.unwrap_or("latest").to_string());
                    record.engine_installed_at = Some("2026-09-16T00:00:00Z".into());
                })
            })
        }

        fn client_changed(&self, client_id: &str) {
            self.changed.lock().unwrap().push(client_id.to_string());
        }

        fn library_changed(&self, _client_id: &str) {}

        fn progress(&self, event: InstallProgress) {
            self.events.lock().unwrap().push(event);
        }
    }

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

    fn blob(source_root: &Path, body: &[u8]) -> (String, u64) {
        let hash = sha256_hex(body);
        let dir = source_root.join("blobs");
        fs::create_dir_all(&dir).expect("the blobs folder");
        fs::write(dir.join(&hash), body).expect("the blob");
        (hash, body.len() as u64)
    }

    fn file(root: FileRoot, path: &str, size: u64, sha256: &str, source: ManifestSource) -> ManifestFile {
        ManifestFile {
            root,
            path: path.into(),
            size,
            sha256: sha256.into(),
            kind: FileKind::of_path(path),
            source,
            replaces: None,
            origin: None,
            library: None,
            listing: None,
        }
    }

    /// A manifest with an overlay file, a config in home, a pk3 of the
    /// service and a pk3 of JKHub, and the source that serves them.
    fn fixture(root: &Path) -> (DiskSource, Manifest, Vec<u8>) {
        let source_root = root.join("source");
        let (exe_hash, exe_size) = blob(&source_root, b"MZ custom build");
        let (cfg_hash, cfg_size) = blob(&source_root, b"seta cg_fov 97\n");
        let mut pk3 = Vec::new();
        {
            let mut writer = ZipWriter::new(std::io::Cursor::new(&mut pk3));
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            writer.start_file("models/players/reborn/model.glm", options).expect("entry");
            writer.write_all(b"skin").expect("body");
            writer.finish().expect("closed");
        }
        let (pk3_hash, pk3_size) = blob(&source_root, &pk3);
        // The JKHub record: the archive holds the pk3 next to a readme.
        write_zip(
            &source_root.join("jkhub").join("3937.zip"),
            &[("JAPro/japro-assets.pk3", b"japro" as &[u8]), ("JAPro/readme.txt", b"read")],
        );
        let manifest = Manifest {
            schema: SCHEMA,
            game: "ja".into(),
            components: vec![ManifestComponent {
                id: "mp".into(),
                label: "Multiplayer".into(),
                engine: ManifestEngine {
                    engine_id: "taystjk".into(),
                    release_tag: Some("v1.6.3".into()),
                },
                modes: vec![LaunchMode::Multiplayer],
                fs_game: Some("taystjk".into()),
                launch_args: String::new(),
                overlay: ManifestOverlay {
                    files: vec![file(FileRoot::Engine, "taystjk.x86.exe", exe_size, &exe_hash, ManifestSource::Blob)],
                    remove: Vec::new(),
                },
                files: vec![
                    file(FileRoot::Home, "taystjk/autoexec.cfg", cfg_size, &cfg_hash, ManifestSource::Blob),
                    file(FileRoot::Home, "base/zz_skin.pk3", pk3_size, &pk3_hash, ManifestSource::Blob),
                    file(
                        FileRoot::Home,
                        "taystjk/japro-assets.pk3",
                        5,
                        &sha256_hex(b"japro"),
                        ManifestSource::Jkhub {
                            file_id: 3937,
                            version: Some("1.6.5".into()),
                            title: Some("JAPro".into()),
                            url: None,
                        },
                    ),
                ],
                configs: Vec::new(),
            }],
            shared: ManifestShared::default(),
        };
        let source = DiskSource {
            root: source_root,
            requests: Arc::new(Mutex::new(Vec::new())),
            resumes: true,
        };
        (source, manifest, pk3)
    }

    fn files_of(manifest: &Manifest) -> Vec<&ManifestFile> {
        manifest.all_files().collect()
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
            .block_on(future)
    }

    #[test]
    fn the_files_of_a_manifest_land_where_the_manifest_says() {
        let temp = tempfile::tempdir().expect("a folder");
        let (source, manifest, pk3) = fixture(temp.path());
        let client_dir = temp.path().join("clients").join("voip");
        let cache_dir = temp.path().join("cache").join("bundles");
        let mut steps = Vec::new();
        let mut report = |step: FileStep| steps.push((step.index, step.count, step.path, step.message));

        let warnings = run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report))
            .expect("the files land");
        assert!(warnings.is_empty(), "{warnings:?}");

        assert_eq!(fs::read(client_dir.join("engine").join("taystjk.x86.exe")).unwrap(), b"MZ custom build");
        assert_eq!(
            fs::read(client_dir.join("home").join("taystjk").join("autoexec.cfg")).unwrap(),
            b"seta cg_fov 97\n"
        );
        assert_eq!(fs::read(client_dir.join("home").join("base").join("zz_skin.pk3")).unwrap(), pk3);
        assert_eq!(
            fs::read(client_dir.join("home").join("taystjk").join("japro-assets.pk3")).unwrap(),
            b"japro"
        );
        // Nothing but the pk3 came out of the JKHub archive.
        assert!(!client_dir.join("home").join("taystjk").join("readme.txt").exists());
        // The provenance of the JKHub file is written the way the tab writes it.
        let provenance = provenance_of(&client_dir);
        let origin = provenance.get("taystjk/japro-assets.pk3").expect("a provenance note");
        assert_eq!(origin.file_id, 3937);
        assert_eq!(origin.source, "jkhub");
        assert_eq!(origin.version.as_deref(), Some("1.6.5"));
        assert!(provenance.len() == 1);
        // No partial file survives a checked download.
        assert!(fs::read_dir(&cache_dir).map(|dir| dir.count()).unwrap_or(0) == 0);
        // Every file reported with its index of four.
        assert!(steps.iter().all(|(_, count, _, _)| *count == 4));
        assert_eq!(steps.first().map(|s| s.0), Some(1));
        assert_eq!(steps.last().map(|s| s.0), Some(4));
        assert!(steps.iter().any(|(_, _, path, _)| path == "taystjk/japro-assets.pk3"));
    }

    #[test]
    fn a_second_run_skips_what_is_in_place_and_resumes_what_is_not() {
        let temp = tempfile::tempdir().expect("a folder");
        let (source, manifest, _) = fixture(temp.path());
        let client_dir = temp.path().join("clients").join("voip");
        let cache_dir = temp.path().join("cache").join("bundles");
        let mut report = |_: FileStep| {};
        run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report)).expect("first run");
        let first = source.requests.lock().unwrap().len();
        assert_eq!(first, 3, "three blobs, one JKHub file");

        // The player deleted the config, and a download of the executable
        // stopped halfway: a partial file with the first bytes is in the
        // cache and the executable is gone.
        fs::remove_file(client_dir.join("home").join("taystjk").join("autoexec.cfg")).unwrap();
        fs::remove_file(client_dir.join("engine").join("taystjk.x86.exe")).unwrap();
        let exe = &manifest.components[0].overlay.files[0];
        fs::write(cache_dir.join(format!("{}.part", exe.sha256)), b"MZ cus").unwrap();

        let warnings = run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report))
            .expect("second run");
        assert!(warnings.is_empty());
        let requests = source.requests.lock().unwrap();
        let second: Vec<&(String, u64)> = requests.iter().skip(first).collect();
        assert_eq!(second.len(), 2, "the pk3 in place was not fetched again: {second:?}");
        assert!(second.contains(&&(exe.sha256.clone(), 6)), "the executable resumed at byte 6: {second:?}");
        assert!(second.contains(&&(manifest.components[0].files[0].sha256.clone(), 0)));
        drop(requests);
        assert_eq!(fs::read(client_dir.join("engine").join("taystjk.x86.exe")).unwrap(), b"MZ custom build");
    }

    #[test]
    fn a_file_that_fails_its_hash_stops_the_install_and_names_itself() {
        let temp = tempfile::tempdir().expect("a folder");
        let (source, mut manifest, _) = fixture(temp.path());
        // The service holds a file under this hash whose bytes hash to
        // something else: a corrupted store, or a tampered one.
        manifest.components[0].files[0].sha256 = "0".repeat(64);
        fs::write(source.root.join("blobs").join("0".repeat(64)), b"seta cg_fov 97\n").unwrap();
        let client_dir = temp.path().join("clients").join("voip");
        let cache_dir = temp.path().join("cache").join("bundles");
        let mut report = |_: FileStep| {};

        let error = run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report))
            .expect_err("the hash does not match");
        match &error {
            AppError::BundleFile { path, reason } => {
                assert_eq!(path, "taystjk/autoexec.cfg");
                assert!(reason.contains("hash"), "{reason}");
            }
            other => panic!("{other}"),
        }
        assert_eq!(error.code(), "bundleFile");
        // The first file landed, the second did not, the cache is clean.
        assert!(client_dir.join("engine").join("taystjk.x86.exe").is_file());
        assert!(!client_dir.join("home").join("taystjk").join("autoexec.cfg").exists());
        assert!(!cache_dir.join(format!("{}.part", "0".repeat(64))).exists());
    }

    #[test]
    fn a_jkhub_file_that_changed_is_a_warning_and_a_missing_one_is_a_failure() {
        let temp = tempfile::tempdir().expect("a folder");
        let (source, mut manifest, _) = fixture(temp.path());
        manifest.components[0].files[2].sha256 = "1".repeat(64);
        let client_dir = temp.path().join("clients").join("voip");
        let cache_dir = temp.path().join("cache").join("bundles");
        let mut report = |_: FileStep| {};

        let warnings = run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report))
            .expect("a changed JKHub file still installs");
        assert_eq!(warnings, vec![WARNING_JKHUB_DIFFERS]);
        assert!(client_dir.join("home").join("taystjk").join("japro-assets.pk3").is_file());

        manifest.components[0].files[2].path = "taystjk/other.pk3".into();
        let error = run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report))
            .expect_err("the archive holds no such pk3");
        match error {
            AppError::BundleFile { path, reason } => {
                assert_eq!(path, "taystjk/other.pk3");
                assert!(reason.contains("japro-assets.pk3"), "{reason}");
            }
            other => panic!("{other}"),
        }
    }

    #[test]
    fn a_path_that_leaves_the_client_is_refused_before_anything_is_fetched() {
        let temp = tempfile::tempdir().expect("a folder");
        let (source, mut manifest, _) = fixture(temp.path());
        manifest.components[0].overlay.files[0].path = "../evil.exe".into();
        let client_dir = temp.path().join("clients").join("voip");
        let cache_dir = temp.path().join("cache").join("bundles");
        let mut report = |_: FileStep| {};

        let error = run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report))
            .expect_err("refused");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        assert!(source.requests.lock().unwrap().is_empty());
        assert!(!temp.path().join("clients").join("evil.exe").exists());

        // The same rule for a path of `overlay.remove`.
        let engine_dir = client_dir.join("engine");
        fs::create_dir_all(&engine_dir).unwrap();
        let error = remove_overlay_paths(&engine_dir, &["../client.json".to_string()]).expect_err("refused");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        fs::write(engine_dir.join("rd-vulkan_x86.dll"), b"vulkan").unwrap();
        remove_overlay_paths(&engine_dir, &["rd-vulkan_x86.dll".to_string(), "gone.dll".to_string()])
            .expect("a missing file is nothing to do");
        assert!(!engine_dir.join("rd-vulkan_x86.dll").exists());
    }

    #[test]
    fn a_partial_file_the_server_cannot_resume_is_started_over() {
        let temp = tempfile::tempdir().expect("a folder");
        let (mut source, manifest, _) = fixture(temp.path());
        source.resumes = false;
        let client_dir = temp.path().join("clients").join("voip");
        let cache_dir = temp.path().join("cache").join("bundles");
        fs::create_dir_all(&cache_dir).unwrap();
        let exe = &manifest.components[0].overlay.files[0];
        fs::write(cache_dir.join(format!("{}.part", exe.sha256)), b"garbage").unwrap();
        let mut report = |_: FileStep| {};

        run(lay_out_files(&source, &client_dir, &cache_dir, &files_of(&manifest), &mut report)).expect("the run");
        assert_eq!(fs::read(client_dir.join("engine").join("taystjk.x86.exe")).unwrap(), b"MZ custom build");
    }

    #[test]
    fn a_file_that_cannot_be_renamed_is_copied_and_the_cache_entry_removed() {
        // Every other test of this module moves within one folder, where a
        // rename always works; this is the volume boundary, with the rename
        // failing the way Windows fails it.
        let temp = tempfile::tempdir().expect("a folder");
        let from = temp.path().join("cache").join("x.part");
        fs::create_dir_all(from.parent().unwrap()).unwrap();
        fs::write(&from, b"payload").unwrap();
        let to = temp.path().join("clients").join("voip").join("home").join("x.pk3");
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::write(&to, b"an older file of the same name").unwrap();

        let across_volumes = |_: &Path, _: &Path| {
            Err(std::io::Error::other("The system cannot move the file to a different disk drive."))
        };
        move_with(&from, &to, across_volumes).expect("copied instead");
        assert_eq!(fs::read(&to).unwrap(), b"payload");
        assert!(!from.exists(), "the cache entry is gone after the copy");

        // The plain rename takes the same road and ends the same way.
        fs::write(&from, b"renamed").unwrap();
        move_into_place(&from, &to).expect("renamed");
        assert_eq!(fs::read(&to).unwrap(), b"renamed");
        assert!(!from.exists());
    }

    #[test]
    fn client_names_join_the_base_name_and_the_label_within_the_limit() {
        assert_eq!(client_name("RUJKA", "Multiplayer", false), "RUJKA · Multiplayer");
        assert_eq!(client_name(" RUJKA ", "Single player", true), "RUJKA");
        let long = client_name(&"x".repeat(40), "Single player", false);
        assert_eq!(long.chars().count(), MAX_CLIENT_NAME);
        assert!(long.starts_with(&"x".repeat(40)));
    }

    /// A draft of two components on OpenJK with a shared file, ready to be
    /// installed from its own folder: the multiplayer component replaces the
    /// executable and takes a renderer out, the single-player one only adds
    /// a config file, both get the shared pk3 and the shared config.
    fn draft_fixture(paths: &DataPaths) -> (Draft, Vec<u8>) {
        let mut draft = empty_draft(paths, Game::JediAcademy, "RUJKA");
        draft.version_label = "3".into();
        let mut pk3 = Vec::new();
        {
            let mut writer = ZipWriter::new(std::io::Cursor::new(&mut pk3));
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            writer.start_file("models/players/reborn/model.glm", options).expect("entry");
            writer.write_all(b"skin").expect("body");
            writer.finish().expect("closed");
        }
        let mut mp = component("mp", "Multiplayer", "openjk", &[LaunchMode::Multiplayer]);
        mp.release_tag = Some("latest".into());
        mp.fs_game = Some("rujka".into());
        mp.launch_args = "+set cg_fov 97".into();
        mp.overlay.files.push(put_draft_file(
            paths,
            &draft.id,
            "mp",
            FileRoot::Engine,
            "openjk.x86.exe",
            b"MZ custom",
            DraftOrigin::Release {
                sha256: sha256_hex(b"MZ release"),
                size: 10,
            },
        ));
        mp.overlay.remove.push("rd-vulkan_x86.dll".into());
        mp.files.push(put_draft_file(
            paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "rujka/cgamex86.dll",
            b"mod module",
            DraftOrigin::Disk {
                source_path: "D:/rujka/cgamex86.dll".into(),
            },
        ));
        mp.files.push(put_draft_file(
            paths,
            &draft.id,
            "mp",
            FileRoot::Home,
            "rujka/japro-assets.pk3",
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
            name: "RUJKA binds".into(),
            text: "bind PGDN toggle cg_dismember 0 3\nseta rconPassword x\n".into(),
            priority: 0,
            source_config_id: None,
        });
        draft.components.push(mp);
        let mut sp = component("sp", "Single player", "openjk", &[LaunchMode::Single]);
        sp.files.push(put_draft_file(
            paths,
            &draft.id,
            "sp",
            FileRoot::Home,
            "base/autoexec_sp.cfg",
            b"seta g_speed 250\n",
            DraftOrigin::Disk {
                source_path: "D:/autoexec_sp.cfg".into(),
            },
        ));
        draft.components.push(sp);
        draft.shared.files.push(put_draft_file(
            paths,
            &draft.id,
            "shared",
            FileRoot::Home,
            "base/rus_sp.pk3",
            &pk3,
            DraftOrigin::Disk {
                source_path: "D:/rus_sp.pk3".into(),
            },
        ));
        draft.shared.configs.push(DraftConfig {
            name: "Shared binds".into(),
            text: "bind x +attack\n".into(),
            priority: 1,
            source_config_id: None,
        });
        draft::write_draft(paths, &draft).expect("the draft");
        (draft, pk3)
    }

    fn draft_job(draft: &Draft) -> Job {
        Job {
            manifest: draft::manifest_of(draft),
            origin: JobOrigin::Draft {
                draft: Box::new(draft.clone()),
            },
        }
    }

    fn client_folders(paths: &DataPaths) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&paths.clients)
            .map(|dir| {
                dir.flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn a_draft_is_installed_into_one_client_per_component_with_the_shared_files() {
        let temp = tempfile::tempdir().expect("a data root");
        let state = AppState::bootstrap(temp.path().to_path_buf());
        let paths = state.paths().unwrap();
        let (draft, pk3) = draft_fixture(&paths);
        let bundles = BundlesState::default();
        let host = TestHost::new(&paths);
        let source = DraftSource::new(&paths, &draft);
        let args = InstallArgs {
            base_name: "RUJKA".into(),
            component_ids: vec!["mp".into(), "sp".into()],
            existing_client_ids: HashMap::new(),
        };

        let clients = run(install(&state, &bundles, &host, &source, draft_job(&draft), args)).expect("installed");
        assert_eq!(clients.len(), 2);
        let (mp, sp) = (&clients[0], &clients[1]);
        assert_eq!(mp.name, "RUJKA · Multiplayer");
        assert_eq!(sp.name, "RUJKA · Single player");
        assert_eq!(mp.modes, [LaunchMode::Multiplayer]);
        assert_eq!(sp.modes, [LaunchMode::Single]);
        assert_eq!(mp.fs_game.as_deref(), Some("rujka"));
        assert_eq!(mp.launch_args, "+set cg_fov 97");
        assert_eq!(sp.fs_game, None);
        assert_eq!(mp.engine_version.as_deref(), Some("latest"));
        assert_eq!(client_folders(&paths), ["rujka-multiplayer", "rujka-single-player"]);

        // The links: draft, no bundle, no version, the component, finished.
        let link = mp.bundle.as_ref().expect("linked");
        assert_eq!(link.draft_id.as_deref(), Some(draft.id.as_str()));
        assert_eq!(link.bundle_id, None);
        assert_eq!(link.version_id, None);
        assert_eq!(link.bundle_name, "RUJKA");
        assert_eq!(link.version_label, "3");
        assert_eq!(link.component_id, "mp");
        assert_eq!(link.component_label, "Multiplayer");
        assert!(link.engine_overlay);
        assert!(!link.pending);
        assert!(!sp.bundle.as_ref().unwrap().engine_overlay);

        // The overlay: the executable replaced, the renderer gone, the rest
        // of the release in place.
        let mp_dir = paths.client_dir(&mp.id);
        assert_eq!(fs::read(mp_dir.join("engine").join("openjk.x86.exe")).unwrap(), b"MZ custom");
        assert!(!mp_dir.join("engine").join("rd-vulkan_x86.dll").exists());
        assert!(mp_dir.join("engine").join("base").join("cgamex86.dll").is_file());
        let sp_dir = paths.client_dir(&sp.id);
        assert_eq!(fs::read(sp_dir.join("engine").join("openjk.x86.exe")).unwrap(), b"MZ release");
        assert!(sp_dir.join("engine").join("rd-vulkan_x86.dll").is_file());
        assert!(sp_dir.join("engine").join("openjk_sp.x86.exe").is_file());

        // The files of each component, and the shared file in both.
        assert_eq!(fs::read(mp_dir.join("home").join("rujka").join("cgamex86.dll")).unwrap(), b"mod module");
        assert_eq!(fs::read(mp_dir.join("home").join("rujka").join("japro-assets.pk3")).unwrap(), b"japro");
        assert!(!mp_dir.join("home").join("base").join("autoexec_sp.cfg").exists());
        assert_eq!(fs::read(sp_dir.join("home").join("base").join("autoexec_sp.cfg")).unwrap(), b"seta g_speed 250\n");
        assert_eq!(fs::read(mp_dir.join("home").join("base").join("rus_sp.pk3")).unwrap(), pk3);
        assert_eq!(fs::read(sp_dir.join("home").join("base").join("rus_sp.pk3")).unwrap(), pk3);
        // A JKHub file of a draft came out of the draft, not of jkhub.org,
        // so no provenance note is written for it.
        assert!(provenance_of(&mp_dir).is_empty());

        // The configs: the component's first, the shared one after, with
        // the password line gone.
        let mp_docs = configs::assigned_documents(&state, mp).unwrap();
        assert_eq!(
            mp_docs.iter().map(|(_, doc)| doc.name.as_str()).collect::<Vec<_>>(),
            ["RUJKA binds", "Shared binds"]
        );
        assert_eq!(mp_docs[0].1.text, "bind PGDN toggle cg_dismember 0 3\n");
        let sp_docs = configs::assigned_documents(&state, sp).unwrap();
        assert_eq!(sp_docs.iter().map(|(_, doc)| doc.name.as_str()).collect::<Vec<_>>(), ["Shared binds"]);

        // The engines went in once each, and the events name the component
        // that runs.
        assert_eq!(
            *host.engines_installed.lock().unwrap(),
            [(mp.id.clone(), Some("latest".into())), (sp.id.clone(), None)]
        );
        let phases = host.phases();
        assert_eq!(phases[0], (Some("mp".into()), "engine"));
        assert!(phases.contains(&(Some("mp".into()), "files")));
        assert!(phases.contains(&(Some("mp".into()), "configs")));
        assert!(phases.contains(&(Some("sp".into()), "engine")));
        let done = host.events.lock().unwrap().last().cloned().unwrap();
        assert_eq!(done.phase, "done");
        assert_eq!(done.draft_id.as_deref(), Some(draft.id.as_str()));
        assert_eq!(done.bundle_id, None);
        assert_eq!(done.component_id.as_deref(), Some("sp"));
        assert_eq!(done.client_id.as_deref(), Some(sp.id.as_str()));
        assert!(done.warnings.is_empty());
        let json = serde_json::to_value(&done).unwrap();
        assert_eq!(json["bundleId"], serde_json::Value::Null);
        assert_eq!(json["draftId"], draft.id);
        assert!(host.changed.lock().unwrap().contains(&mp.id));

        // The claims are free again.
        bundles.claim(&mp.id, BundlesState::INSTALL).expect("released");
        bundles.claim(&draft_key(&draft.id), BundlesState::INSTALL).expect("released");
    }

    #[test]
    fn a_second_run_continues_in_the_same_clients_and_skips_what_is_there() {
        let temp = tempfile::tempdir().expect("a data root");
        let state = AppState::bootstrap(temp.path().to_path_buf());
        let paths = state.paths().unwrap();
        let (draft, _) = draft_fixture(&paths);
        let bundles = BundlesState::default();
        let host = TestHost::new(&paths);
        let source = DraftSource::new(&paths, &draft);
        let args = InstallArgs {
            base_name: "RUJKA".into(),
            component_ids: vec!["mp".into(), "sp".into()],
            existing_client_ids: HashMap::new(),
        };
        let clients = run(install(&state, &bundles, &host, &source, draft_job(&draft), args)).expect("installed");
        let (mp, sp) = (&clients[0], &clients[1]);
        let files_before = host
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.phase == "files" && e.message.starts_with("Installed"))
            .count();
        assert_eq!(files_before, 4 + 2, "four files of mp, two of sp");

        // The player deleted a file of the first client; the second run
        // continues in both clients, puts it back and skips the rest.
        fs::remove_file(paths.client_dir(&mp.id).join("home").join("rujka").join("cgamex86.dll")).unwrap();
        let host = TestHost::new(&paths);
        let args = InstallArgs {
            base_name: "RUJKA".into(),
            component_ids: vec!["mp".into(), "sp".into()],
            existing_client_ids: HashMap::from([("mp".to_string(), mp.id.clone()), ("sp".to_string(), sp.id.clone())]),
        };
        let again = run(install(&state, &bundles, &host, &source, draft_job(&draft), args)).expect("continued");
        assert_eq!(again.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [mp.id.as_str(), sp.id.as_str()]);
        assert_eq!(client_folders(&paths).len(), 2, "no third client");
        assert!(host.engines_installed.lock().unwrap().is_empty(), "the engines were in place");
        assert!(paths.client_dir(&mp.id).join("home").join("rujka").join("cgamex86.dll").is_file());
        let events = host.events.lock().unwrap();
        let installed: Vec<&str> = events
            .iter()
            .filter(|e| e.phase == "files" && e.message.starts_with("Installed"))
            .map(|e| e.current_file.as_deref().unwrap())
            .collect();
        assert_eq!(installed, ["rujka/cgamex86.dll"]);
        let skipped = events
            .iter()
            .filter(|e| e.phase == "files" && e.message.starts_with("Already there"))
            .count();
        assert_eq!(skipped, 5);
        drop(events);
        // The configs were not doubled.
        assert_eq!(configs::assigned_documents(&state, mp).unwrap().len(), 2);

        // One component alone continues alone, and a client of the other
        // component is refused for it.
        let host = TestHost::new(&paths);
        let args = InstallArgs {
            base_name: "RUJKA".into(),
            component_ids: vec!["mp".into()],
            existing_client_ids: HashMap::from([("mp".to_string(), sp.id.clone())]),
        };
        let error = run(install(&state, &bundles, &host, &source, draft_job(&draft), args)).expect_err("the wrong client");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        assert!(error.to_string().contains("\"sp\""), "{error}");
        assert_eq!(host.events.lock().unwrap().last().unwrap().phase, "error");
        assert_eq!(client_folders(&paths).len(), 2);

        // A hand-made client, and one that is not selected, are refused too.
        let plain = clients::create_record(&paths, "Plain", "openjk", Game::JediAcademy, None).unwrap();
        let args = InstallArgs {
            base_name: "RUJKA".into(),
            component_ids: vec!["mp".into()],
            existing_client_ids: HashMap::from([("mp".to_string(), plain.id.clone())]),
        };
        let error = run(install(&state, &bundles, &host, &source, draft_job(&draft), args)).expect_err("not linked");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        assert!(clients::read_record(&paths, &plain.id).unwrap().bundle.is_none(), "untouched");
        let args = InstallArgs {
            base_name: "RUJKA".into(),
            component_ids: vec!["sp".into()],
            existing_client_ids: HashMap::from([("mp".to_string(), mp.id.clone())]),
        };
        let error = run(install(&state, &bundles, &host, &source, draft_job(&draft), args)).expect_err("not selected");
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
    }

    #[test]
    fn the_selection_is_checked_before_anything_is_claimed() {
        let temp = tempfile::tempdir().expect("a data root");
        let state = AppState::bootstrap(temp.path().to_path_buf());
        let paths = state.paths().unwrap();
        let (draft, _) = draft_fixture(&paths);
        let bundles = BundlesState::default();
        let host = TestHost::new(&paths);
        let source = DraftSource::new(&paths, &draft);
        let args = |ids: &[&str], base: &str| InstallArgs {
            base_name: base.into(),
            component_ids: ids.iter().map(|id| id.to_string()).collect(),
            existing_client_ids: HashMap::new(),
        };

        let error = run(install(&state, &bundles, &host, &source, draft_job(&draft), args(&[], "RUJKA"))).unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        let error = run(install(&state, &bundles, &host, &source, draft_job(&draft), args(&["ghost"], "RUJKA"))).unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");
        let error = run(install(&state, &bundles, &host, &source, draft_job(&draft), args(&["mp"], "  "))).unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)), "{error}");

        // An engine the registry lacks, and a mode the engine lacks.
        let mut job = draft_job(&draft);
        job.manifest.components[0].engine.engine_id = "future-engine".into();
        let error = run(install(&state, &bundles, &host, &source, job, args(&["mp"], "RUJKA"))).unwrap_err();
        assert!(matches!(error, AppError::EngineUnknown { .. }), "{error}");
        let mut job = draft_job(&draft);
        job.manifest.components[1].engine.engine_id = "eternaljk".into();
        let error = run(install(&state, &bundles, &host, &source, job, args(&["sp"], "RUJKA"))).unwrap_err();
        assert!(matches!(error, AppError::BundleUnavailable(_)), "{error}");
        assert!(client_folders(&paths).is_empty(), "nothing was made: {:?}", client_folders(&paths));
        bundles.claim(&draft_key(&draft.id), BundlesState::INSTALL).expect("nothing held");

        // A single selected component takes the base name alone, and an
        // install of the same draft is refused while one runs.
        let held = bundles.claim(&draft_key(&draft.id), BundlesState::PUBLISH).unwrap();
        let error = run(install(&state, &bundles, &host, &source, draft_job(&draft), args(&["sp"], "RUJKA"))).unwrap_err();
        assert!(matches!(error, AppError::Busy(_)), "{error}");
        drop(held);
        let clients = run(install(&state, &bundles, &host, &source, draft_job(&draft), args(&["sp"], "RUJKA"))).unwrap();
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].name, "RUJKA");
        assert_eq!(clients[0].modes, [LaunchMode::Single]);
    }
}
