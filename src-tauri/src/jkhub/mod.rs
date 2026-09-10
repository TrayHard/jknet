//! Browsing and installing the files of jkhub.org.
//!
//! JKHub is where the community publishes skins, hilts, maps and mods. It runs
//! Invision Community, whose REST API answers `401 NO_API_KEY` to every
//! anonymous call — `core/hello` included — and offers no working RSS
//! (research report `jkhub-files-research-report.md`, sections 3 and 5). So
//! this module reads the same public pages a visitor reads, prefers the
//! JSON-LD of a file page over the CSS classes of the theme, and hides all of
//! that behind [`source::JkhubSource`] so a REST reader can take over the day
//! a read-only key exists.
//!
//! | File | Responsibility |
//! | ---- | -------------- |
//! | `types.rs` | the wire types, mirrored in `src/lib/ipc.ts` |
//! | `client.rs` | one HTTP client, one cookie jar, and the limiter in front |
//! | `cache.rs` | `cache\jkhub\`: the tree, the listings, the file pages |
//! | `snapshot.rs` | the category tree bundled with the build |
//! | `index.rs` | the local catalogue index, and the search that runs on it |
//! | `parse.rs` | pure parsers, tested against saved pages |
//! | `source.rs` | the trait, the HTML reader, the REST placeholder |
//! | `download.rs` | the `csrfKey` flow and the streaming download |
//! | `install.rs` | pulling the pk3 files out of an archive into a client |
//!
//! Politeness is not a detail here: the launcher runs on players' machines,
//! and a careless one would look like an attack from many addresses at once.
//! Every request is paced by [`client::JkhubClient`], carries a `User-Agent`
//! that names the program and the repository, and is cached for as long as
//! the site itself asks for.

pub mod cache;
pub mod client;
pub mod download;
pub mod index;
pub mod install;
pub mod parse;
pub mod snapshot;
pub mod source;
pub mod types;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::clients;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::library;
use crate::paths::DataPaths;
use crate::state::AppState;
use crate::timestamp;

use client::JkhubClient;
use index::{IndexSource, IndexUpdate, LoadedIndex, RefreshContext, SearchRequest};
use source::{HtmlSource, JkhubSource};
use types::{
    CategoriesUpdatedEvent, InstalledEvent, JkhubCard, JkhubCategories, JkhubDownload,
    JkhubFileView, JkhubInstallOutcome, JkhubInstallResult, JkhubListing, JkhubSort, Provenance,
};

/// Emitted once an install finished, so any open screen refetches.
const INSTALLED_EVENT: &str = "jkhub:installed";

/// Emitted once a walk behind an answer produced a newer tree.
const CATEGORIES_UPDATED_EVENT: &str = "jkhub:categories-updated";

/// Shortest gap between two walks of the same tree, in seconds.
///
/// The disk cache already keeps a walked tree for a week
/// ([`cache::CATEGORIES_TTL`]); this is the separate promise that a launcher
/// which cannot reach the site — or reaches it and gets an unparsable page —
/// still walks at most once a day rather than on every open of the tab.
/// **Update categories** ignores it: the player asked.
pub const TREE_REFRESH_INTERVAL: u64 = 24 * 60 * 60;

/// What the background work on one game is up to.
#[derive(Debug, Clone, Copy, Default)]
struct Refresh {
    /// A walk or a crawl is in flight right now.
    running: bool,
    /// Unix seconds of the last one that was started, whichever way it ended.
    last_attempt: u64,
}

/// Keeps work behind an answer from running twice, or too often.
///
/// Two screens can ask for the same tree in the same second — the tab renders
/// while a toast from the previous open is still up — and every one of those
/// answers would otherwise start its own twenty-request walk. The catalogue
/// index has the same problem and a bigger bill, so it keeps its own instance
/// of this.
#[derive(Debug, Default)]
pub struct Refreshes(Mutex<HashMap<Game, Refresh>>);

impl Refreshes {
    /// Claims the work of one game, or refuses and says nothing happened.
    ///
    /// `interval` is the shortest gap between two attempts; zero means the
    /// player asked and only a run already in flight can refuse.
    ///
    /// A poisoned lock refuses: a launcher that skips a background walk shows
    /// a tree up to a week old, and one that panics in a spawned task shows
    /// nothing at all.
    fn start(&self, game: Game, now: u64, interval: u64) -> bool {
        let Ok(mut entries) = self.0.lock() else {
            log::error!("jkhub: the refresh lock is poisoned, skipping the work");
            return false;
        };
        let entry = entries.entry(game).or_default();
        if entry.running {
            return false;
        }
        if entry.last_attempt > 0 && now.saturating_sub(entry.last_attempt) < interval {
            return false;
        }
        entry.running = true;
        entry.last_attempt = now;
        true
    }

    /// Releases the claim, however the work ended.
    fn finish(&self, game: Game) {
        match self.0.lock() {
            Ok(mut entries) => entries.entry(game).or_default().running = false,
            Err(e) => log::error!("cannot release the JKHub claim of {}: {e}", game.id()),
        }
    }

    /// Records work that ran in the foreground, so the run behind the next
    /// answer does not repeat it.
    fn note(&self, game: Game, now: u64) {
        match self.0.lock() {
            Ok(mut entries) => entries.entry(game).or_default().last_attempt = now,
            Err(e) => log::error!("cannot note the JKHub work of {}: {e}", game.id()),
        }
    }

    /// Whether a run of this game is in flight, for a screen that wants to say
    /// so.
    fn running(&self, game: Game) -> bool {
        match self.0.lock() {
            Ok(entries) => entries.get(&game).is_some_and(|entry| entry.running),
            Err(_) => false,
        }
    }
}

/// Everything the module keeps between calls.
///
/// The client is here rather than built per call because its cookie jar is
/// the session a `csrfKey` belongs to, and its limiter is what keeps two
/// screens from asking the site twice as fast as one.
pub struct JkhubState {
    client: Option<JkhubClient>,
    /// Files with an install in flight. A second call for the same file is
    /// refused rather than queued, the way `InstallState` guards an engine.
    busy: Mutex<HashSet<u32>>,
    /// Walks of the category tree, one entry per game.
    trees: Refreshes,
    /// Crawls and top-ups of the catalogue index, one entry per game.
    catalogues: Refreshes,
    /// The catalogue index of each game, once something has asked for it.
    ///
    /// Kept in memory because a search runs on it and a player types: reading
    /// a megabyte of JSON and folding three thousand descriptions per
    /// keystroke is the one way this feature could be slow.
    indexes: Mutex<HashMap<Game, Arc<LoadedIndex>>>,
}

impl Default for JkhubState {
    fn default() -> Self {
        let client = match JkhubClient::new() {
            Ok(client) => Some(client),
            Err(e) => {
                log::error!("jkhub: {e}");
                None
            }
        };
        JkhubState {
            client,
            busy: Mutex::new(HashSet::new()),
            trees: Refreshes::default(),
            catalogues: Refreshes::default(),
            indexes: Mutex::new(HashMap::new()),
        }
    }
}

impl JkhubState {
    fn client(&self) -> Result<&JkhubClient> {
        self.client.as_ref().ok_or_else(|| {
            AppError::JkhubUnavailable("the JKHub client could not be built at startup".into())
        })
    }

    /// The catalogue index of one game, read from disk or from the bundle the
    /// first time it is asked for.
    ///
    /// `None` means neither exists, which is the state of a build that ships
    /// no index and a machine that has never crawled.
    fn index(
        &self,
        data: &DataPaths,
        snapshots: Option<&PathBuf>,
        game: Game,
    ) -> Option<Arc<LoadedIndex>> {
        let mut cached = self.indexes.lock().ok()?;
        if let Some(loaded) = cached.get(&game) {
            return Some(loaded.clone());
        }
        let loaded = Arc::new(index::load(data, snapshots, game)?);
        cached.insert(game, loaded.clone());
        Some(loaded)
    }

    /// Drops the copy in memory, so the next search reads the newer document.
    fn forget_index(&self, game: Option<Game>) {
        match self.indexes.lock() {
            Ok(mut cached) => match game {
                Some(game) => {
                    cached.remove(&game);
                }
                None => cached.clear(),
            },
            Err(e) => log::error!("cannot drop the JKHub index held in memory: {e}"),
        }
    }

    /// Claims a file for the caller, or refuses because someone holds it.
    fn claim(&self, file_id: u32) -> Result<InstallGuard<'_>> {
        let mut busy = self
            .busy
            .lock()
            .map_err(|_| AppError::State("the JKHub install lock is poisoned".into()))?;
        if !busy.insert(file_id) {
            return Err(AppError::Busy(format!(
                "file {file_id} is already being installed. Wait for it to finish."
            )));
        }
        Ok(InstallGuard {
            state: self,
            file_id,
        })
    }
}

/// Releases the claim when the install ends, however it ends.
struct InstallGuard<'a> {
    state: &'a JkhubState,
    file_id: u32,
}

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        match self.state.busy.lock() {
            Ok(mut busy) => {
                busy.remove(&self.file_id);
            }
            // A poisoned lock would hold the file until the launcher restarts,
            // which is worse than the panic that poisoned it.
            Err(e) => log::error!("cannot release the JKHub claim of {}: {e}", self.file_id),
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The category tree of one game, roots first.
///
/// Answers from whatever is at hand and walks the site behind the answer, so
/// the first open of the tab renders instead of waiting for twenty requests:
///
/// | On disk | Answer | Behind it |
/// | --- | --- | --- |
/// | a walked tree under a week old | it, `stale: false` | nothing |
/// | a walked tree older than that | it, `stale: true` | a walk |
/// | nothing, but the build ships a snapshot | the snapshot, `stale: true` | a walk |
/// | nothing at all | a walk | — |
///
/// The walk behind the answer emits `jkhub:categories-updated` when it
/// produced a tree, and runs at most once a day per game
/// ([`TREE_REFRESH_INTERVAL`]).
///
/// `refresh` is the **Update categories** action of the screen: it walks
/// before answering and ignores both the cache and that daily limit.
///
/// --- slice: game core ---
/// `game` picks the tree; leaving it out means the active game, the way every
/// other command that takes a game behaves. The site keeps the two games in
/// separate roots, and `Both Games/Other` shows up under either.
#[tauri::command]
pub async fn jkhub_categories(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    game: Option<Game>,
    refresh: Option<bool>,
) -> Result<JkhubCategories> {
    let game = state.settings()?.game_or_active(game);
    let data = state.paths()?;
    let force = refresh.unwrap_or(false);
    let source = HtmlSource::new(jkhub.client()?, &data)
        .forced(force)
        .with_snapshots(snapshot::bundled_dir(&app));
    let (categories, wants_refresh) = source.categories_with_plan(game).await?;
    if force {
        // The player just paid for a walk in the foreground; the one behind
        // the next answer has nothing left to find.
        jkhub.trees.note(game, timestamp::now_unix());
    } else if wants_refresh {
        refresh_tree_behind(&app, game);
    }
    Ok(categories)
}

/// Walks the tree of one game behind an answer that was already served.
///
/// Silent by design: the screen has a tree on it already, and a walk that
/// fails leaves that tree where it is. The one thing it does say is
/// `jkhub:categories-updated`, and only when it wrote a newer tree.
fn refresh_tree_behind(app: &AppHandle, game: Game) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let jkhub = app.state::<JkhubState>();
        if !jkhub.trees.start(game, timestamp::now_unix(), TREE_REFRESH_INTERVAL) {
            return;
        }
        let walked = match (app.state::<AppState>().paths(), jkhub.client()) {
            (Ok(data), Ok(client)) => match source::crawl_tree(client, game).await {
                Ok(tree) => {
                    source::store_tree(&data, game, &tree);
                    log::info!(
                        "jkhub: the {} tree now holds {} categories",
                        game.id(),
                        tree.len()
                    );
                    true
                }
                Err(e) => {
                    log::warn!("jkhub: the {} tree stays as it was, {e}", game.id());
                    false
                }
            },
            (Err(e), _) | (_, Err(e)) => {
                log::warn!("jkhub: cannot walk the {} tree, {e}", game.id());
                false
            }
        };
        jkhub.trees.finish(game);
        if walked {
            if let Err(e) = app.emit(CATEGORIES_UPDATED_EVENT, CategoriesUpdatedEvent { game }) {
                log::warn!("cannot emit {CATEGORIES_UPDATED_EVENT}: {e}");
            }
        }
    });
}

/// One page of one category, 25 cards at a time.
///
/// --- slice: game core ---
/// `game` says which cached tree the category's slug is read from; leaving it
/// out means the active game. The listing itself is addressed by id, so a
/// wrong guess costs one redirect and never a wrong page.
#[tauri::command]
pub async fn jkhub_list(
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    game: Option<Game>,
    category_id: u32,
    sort: Option<JkhubSort>,
    page: Option<u32>,
    refresh: Option<bool>,
) -> Result<JkhubListing> {
    let game = state.settings()?.game_or_active(game);
    let data = state.paths()?;
    let source = HtmlSource::new(jkhub.client()?, &data).forced(refresh.unwrap_or(false));
    source
        .list(game, category_id, sort.unwrap_or_default(), page.unwrap_or(1))
        .await
}

/// One file page: description, screenshots, counters, version, tags.
#[tauri::command]
pub async fn jkhub_file(
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    id: u32,
    refresh: Option<bool>,
) -> Result<JkhubFileView> {
    let data = state.paths()?;
    let source = HtmlSource::new(jkhub.client()?, &data).forced(refresh.unwrap_or(false));
    source.file(id).await
}

/// Follows the download button and says where it leads, without fetching the
/// archive.
///
/// The screen calls this to show a size before an install, and the install
/// calls it again on its own: the key is bound to a short session and must
/// not be resolved in advance (report, section 4).
#[tauri::command]
pub async fn jkhub_resolve_download(
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    id: u32,
) -> Result<JkhubDownload> {
    let data = state.paths()?;
    let http = jkhub.client()?;
    let view = HtmlSource::new(http, &data).file(id).await?;
    download::resolve(http, id, &view.file.slug).await
}

/// Downloads a file if needed and installs its pk3 files into a client.
///
/// Answers in the success path even when nothing was installed: an archive
/// with no pk3, a record that points at another site, a format this build
/// cannot open and a name collision are all things the player has to decide
/// about, and a list of names does not fit into an error string.
#[tauri::command]
pub async fn jkhub_install(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    id: u32,
    client_id: String,
    replace: Option<bool>,
) -> Result<JkhubInstallResult> {
    let data = state.paths()?;
    let http = jkhub.client()?;
    let _guard = jkhub.claim(id)?;

    let client = clients::read_record(&data, &client_id)?;
    let folder = folder_of(&client);
    let client_dir = data.client_dir(&client_id);
    if !client_dir.is_dir() {
        return Err(AppError::NotFound(format!("client {client_id}")));
    }

    let view = HtmlSource::new(http, &data).file(id).await?;
    let resolved = download::resolve(http, id, &view.file.slug).await?;
    let (url, file_name, size) = match resolved {
        JkhubDownload::Hosted {
            url,
            file_name,
            size,
            ..
        } => (url, file_name, size),
        JkhubDownload::External { url } => {
            return Ok(JkhubInstallResult {
                file_id: id,
                client_id,
                folder,
                outcome: JkhubInstallOutcome::External { url },
            })
        }
    };

    let dir = cache::download_dir(&data, id)?;
    let archive =
        download::fetch(&app, http, id, &url, &dir, &file_name, size).await?;

    let target = install::target_folder(&client_dir, &folder)?;
    let replace = replace.unwrap_or(false);
    // Reading and unpacking an archive is blocking work, and a map from the
    // site runs to 217 MB (report, section 7), so it stays off the async
    // workers the whole launcher shares.
    let archive_for_task = archive.clone();
    let target_for_task = target.clone();
    let unpacked = tokio::task::spawn_blocking(move || {
        unpack(&archive_for_task, &target_for_task, replace)
    })
    .await
    .map_err(|e| AppError::Archive(format!("the unpacker stopped: {e}")))?;
    // --- review: downloads of failed installs are never removed ---
    // An unpack that failed outright leaves nothing on screen pointing at the
    // archive, so the bytes go with the error.
    let outcome = match unpacked {
        Ok(outcome) => outcome,
        Err(e) => {
            cache::forget_download(&data, id);
            return Err(e);
        }
    };

    if let JkhubInstallOutcome::Installed { files } = &outcome {
        record(&client_dir, &folder, files, &view.file)?;
        library::notify(&app, &client_id);
        if let Err(e) = app.emit(
            INSTALLED_EVENT,
            InstalledEvent {
                file_id: id,
                client_id: client_id.clone(),
                files: files.clone(),
            },
        ) {
            log::warn!("cannot emit {INSTALLED_EVENT}: {e}");
        }
        log::info!(
            "jkhub: installed {} file(s) of {id} into {client_id}\\{folder}",
            files.len()
        );
    }

    // --- review: downloads of failed installs are never removed ---
    // The archive was only ever a cache entry. It goes as soon as nothing the
    // player can press still needs it — which is more than the installed case
    // and less than every other one; `download::keep_reason` holds the rule,
    // and `download::sweep` at startup ages out what it keeps.
    match download::keep_reason(&outcome) {
        Some(why) => log::debug!("jkhub: keeping the archive of {id}, {why}"),
        None => cache::forget_download(&data, id),
    }

    Ok(JkhubInstallResult {
        file_id: id,
        client_id,
        folder,
        outcome: with_archive_path(outcome, &archive, &view.file.url),
    })
}

/// Opens the page of one file in the system browser.
#[tauri::command]
pub async fn jkhub_open(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    id: u32,
) -> Result<()> {
    let data = state.paths()?;
    // The canonical address comes from the cached card when there is one, so
    // the common case costs no request at all.
    let url = match HtmlSource::new(jkhub.client()?, &data).file(id).await {
        Ok(view) => view.file.url,
        Err(e) => {
            log::warn!("jkhub: opening {id} without its page, {e}");
            parse::file_url(id, "")
        }
    };
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| AppError::Launch(format!("the system browser did not open {url}: {e}")))?;
    Ok(())
}

/// Empties `cache\jkhub\`, downloaded archives and the catalogue index
/// included.
///
/// The index goes with the rest because it is a cache too: the tab falls back
/// to the copy inside the build and crawls again behind the next answer.
#[tauri::command]
pub fn jkhub_clear_cache(
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
) -> Result<()> {
    let data = state.paths()?;
    cache::clear(&data)?;
    jkhub.forget_index(None);
    Ok(())
}

// ---------------------------------------------------------------------------
// The catalogue index
// ---------------------------------------------------------------------------

/// What `jkhub_search` is asked for, as one argument.
///
/// A struct rather than six more parameters: the command already carries the
/// three Tauri ones, and a search grows a field far more easily than a
/// signature does. Mirrored by `JkhubSearchQuery` in `src/lib/ipc.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubSearchArgs {
    /// Leaving it out means the active game, the way every other command that
    /// takes a game behaves.
    pub game: Option<Game>,
    /// Empty is the full listing rather than an empty answer.
    #[serde(default)]
    pub query: String,
    /// `None` searches the whole catalogue of the game.
    pub category_id: Option<u32>,
    #[serde(default)]
    pub sort: JkhubSort,
    /// One-based, the way the site numbers its pages.
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

/// The answer of `jkhub_search`: one page of results out of the local index.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubSearchResult {
    pub game: Game,
    /// Files that match, across the whole catalogue of the game.
    pub total: u32,
    pub page: u32,
    pub per_page: u32,
    pub pages: u32,
    pub cards: Vec<JkhubCard>,
    /// Matches per category, rolled up the tree: a container carries what its
    /// children hold. Keys are category ids as strings, the way JSON spells a
    /// map.
    pub category_counts: BTreeMap<u32, u32>,
    /// RFC 3339 moment the index was last written. Empty when there is none.
    pub indexed_at: String,
    /// True when the answer came out of the copy inside the build, when the
    /// index is past [`index::FULL_REBUILD_AFTER`], or when there is no index
    /// at all.
    pub stale: bool,
}

/// The answer of `jkhub_index_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubIndexStatus {
    pub game: Game,
    pub indexed: bool,
    pub built_at: String,
    pub updated_at: String,
    /// Seconds since the last write, so the screen needs no date parser.
    pub age: u64,
    pub files: u32,
    pub source: Option<IndexSource>,
    pub stale: bool,
    /// True while a crawl or a top-up of this game is in flight.
    pub building: bool,
}

/// Searches the whole catalogue of one game, without asking jkhub.org.
///
/// This is what the tab lists from, query or no query: an empty query is the
/// full listing of the selected category, and no category is the full
/// catalogue of the game. Nothing here touches the network — the index is
/// either on disk, inside the build, or missing, and a missing one answers
/// with nothing rather than crawling under a player who is typing.
///
/// `categoryCounts` covers every category the query has answers in, including
/// the ones `categoryId` narrowed away: the tree needs them to show where else
/// to look.
#[tauri::command]
pub async fn jkhub_search(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    request: JkhubSearchArgs,
) -> Result<JkhubSearchResult> {
    let game = state.settings()?.game_or_active(request.game);
    let data = state.paths()?;
    let snapshots = snapshot::bundled_dir(&app);

    let Some(loaded) = jkhub.index(&data, snapshots.as_ref(), game) else {
        return Ok(JkhubSearchResult {
            game,
            total: 0,
            page: 1,
            per_page: index::RESULTS_PER_PAGE,
            pages: 1,
            cards: Vec::new(),
            category_counts: BTreeMap::new(),
            indexed_at: String::new(),
            stale: true,
        });
    };

    let answer = loaded.search(&SearchRequest {
        query: request.query,
        category_id: request.category_id,
        sort: request.sort,
        page: request.page.unwrap_or(1),
        per_page: request.per_page.unwrap_or(index::RESULTS_PER_PAGE),
    });
    let tree = source::tree_at_hand(&data, snapshots.as_ref(), game);
    Ok(JkhubSearchResult {
        game,
        total: answer.total,
        page: answer.page,
        per_page: answer.per_page,
        pages: answer.pages,
        cards: answer.cards,
        category_counts: index::roll_up(&answer.category_counts, &tree),
        indexed_at: loaded.index.updated_at.clone(),
        stale: is_stale(&loaded),
    })
}

/// What the launcher knows about the catalogue index of one game.
///
/// Answers from whatever is at hand and tops the index up behind the answer,
/// exactly the way `jkhub_categories` treats the tree: opening the tab must
/// not wait for the site. The work behind it runs at most once a day per game
/// and says `jkhub:index-updated` only when it changed something.
#[tauri::command]
pub async fn jkhub_index_status(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    game: Option<Game>,
) -> Result<JkhubIndexStatus> {
    let game = state.settings()?.game_or_active(game);
    let data = state.paths()?;
    let snapshots = snapshot::bundled_dir(&app);
    let loaded = jkhub.index(&data, snapshots.as_ref(), game);

    let status = match &loaded {
        Some(loaded) => JkhubIndexStatus {
            game,
            indexed: true,
            built_at: loaded.index.built_at.clone(),
            updated_at: loaded.index.updated_at.clone(),
            age: loaded.index.age(timestamp::now_unix()),
            files: loaded.index.files.len() as u32,
            source: Some(loaded.source),
            stale: is_stale(loaded),
            building: jkhub.catalogues.running(game),
        },
        None => JkhubIndexStatus {
            game,
            indexed: false,
            built_at: String::new(),
            updated_at: String::new(),
            age: 0,
            files: 0,
            source: None,
            stale: true,
            building: jkhub.catalogues.running(game),
        },
    };
    refresh_index_behind(&app, game);
    Ok(status)
}

/// Reads jkhub.org and brings the catalogue index of one game up to date.
///
/// The **Refresh** action of the tab. It takes one request plus one per file
/// the front page names and the index does not know; `full` is the crawl of
/// every listing page, which the launcher also falls back to on its own when
/// the cheap path cannot do the job ([`index::plan`]).
///
/// Runs in the foreground and answers with what changed, so the screen can say
/// so. A second call for the same game while one is in flight is refused
/// rather than queued.
#[tauri::command]
pub async fn jkhub_refresh_index(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    game: Option<Game>,
    full: Option<bool>,
) -> Result<IndexUpdate> {
    let game = state.settings()?.game_or_active(game);
    let data = state.paths()?;
    let client = jkhub.client()?;
    // Zero interval: the player asked, and only a run already in flight
    // refuses.
    if !jkhub.catalogues.start(game, timestamp::now_unix(), 0) {
        return Err(AppError::Busy(format!(
            "the {} catalogue is already being indexed. Wait for it to finish.",
            game.id()
        )));
    }
    let context = RefreshContext {
        app: &app,
        client,
        data: &data,
        snapshots: snapshot::bundled_dir(&app),
        game,
    };
    let answer = index::run(&context, true, full.unwrap_or(false)).await;
    jkhub.catalogues.finish(game);
    if answer.as_ref().is_ok_and(|update| update.touched()) {
        jkhub.forget_index(Some(game));
    }
    answer
}

/// Tops the index of one game up behind an answer that was already served.
///
/// Silent by design, like the tree walk next to it: the tab has a catalogue on
/// it already, and a refresh that fails leaves that catalogue where it is. The
/// one thing it says is `jkhub:index-updated`, and only when something changed.
fn refresh_index_behind(app: &AppHandle, game: Game) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let jkhub = app.state::<JkhubState>();
        if !jkhub
            .catalogues
            .start(game, timestamp::now_unix(), index::AUTO_REFRESH_INTERVAL)
        {
            return;
        }
        let done = match (app.state::<AppState>().paths(), jkhub.client()) {
            (Ok(data), Ok(client)) => {
                let context = RefreshContext {
                    app: &app,
                    client,
                    data: &data,
                    snapshots: snapshot::bundled_dir(&app),
                    game,
                };
                match index::run(&context, false, false).await {
                    Ok(update) => update.touched(),
                    Err(e) => {
                        log::warn!("jkhub: the {} index stays as it was, {e}", game.id());
                        false
                    }
                }
            }
            (Err(e), _) | (_, Err(e)) => {
                log::warn!("jkhub: cannot refresh the {} index, {e}", game.id());
                false
            }
        };
        jkhub.catalogues.finish(game);
        if done {
            jkhub.forget_index(Some(game));
        }
    });
}

/// Whether an index is old enough that the screen should say so.
///
/// Two ways to be stale, and they mean the same thing to a player: the answer
/// came from the copy that shipped with the build, or the crawl behind it is
/// old enough that the launcher no longer trusts the cheap refresh path.
fn is_stale(loaded: &LoadedIndex) -> bool {
    loaded.source == IndexSource::Snapshot
        || loaded.index.age(timestamp::now_unix()) >= index::FULL_REBUILD_AFTER
}

// ---------------------------------------------------------------------------
// The install itself
// ---------------------------------------------------------------------------

/// Opens the archive and writes what belongs in the client.
///
/// The two refusals of `install` — a format this build cannot open and an
/// archive with no pk3 — arrive here as `AppError` variants and leave as
/// outcomes: they are answers, not failures, and the screen has to show what
/// was inside.
fn unpack(archive: &Path, target: &Path, replace: bool) -> Result<JkhubInstallOutcome> {
    let contents = match install::read_archive(archive) {
        Ok(contents) => contents,
        Err(AppError::ArchiveUnsupported { format }) => {
            return Ok(JkhubInstallOutcome::Unsupported {
                format,
                archive_path: None,
                url: String::new(),
            })
        }
        Err(e) => return Err(e),
    };

    let entries = match install::require_pk3(&contents) {
        Ok(entries) => entries.to_vec(),
        Err(AppError::NoPk3Files { .. }) => {
            return Ok(JkhubInstallOutcome::NoPk3Files {
                entries: contents.preview.clone(),
                archive_path: String::new(),
            })
        }
        Err(e) => return Err(e),
    };

    let taken = install::conflicts(&entries, target);
    if !taken.is_empty() && !replace {
        return Ok(JkhubInstallOutcome::Conflicts { files: taken });
    }

    let files = install::extract(archive, &entries, target)?;
    Ok(JkhubInstallOutcome::Installed { files })
}

/// Fills in the two fields the unpacker cannot know: where the archive landed
/// and which page it came from.
fn with_archive_path(
    outcome: JkhubInstallOutcome,
    archive: &Path,
    url: &str,
) -> JkhubInstallOutcome {
    let path = archive.to_string_lossy().to_string();
    match outcome {
        JkhubInstallOutcome::NoPk3Files { entries, .. } => JkhubInstallOutcome::NoPk3Files {
            entries,
            archive_path: path,
        },
        JkhubInstallOutcome::Unsupported { format, .. } => JkhubInstallOutcome::Unsupported {
            format,
            archive_path: Some(path),
            url: url.to_string(),
        },
        other => other,
    }
}

/// Writes down where each installed file came from.
///
/// The record is what lets a card say **Installed**, what puts a JKHub badge
/// on the Library screen, and what a later update check compares against.
fn record(
    client_dir: &std::path::Path,
    folder: &str,
    files: &[String],
    file: &types::JkhubFile,
) -> Result<()> {
    let mut entries = library::read_provenance(client_dir);
    let now = timestamp::now_rfc3339();
    for name in files {
        entries.insert(
            format!("{folder}/{name}"),
            Provenance {
                source: "jkhub".into(),
                file_id: file.id,
                version: file.version.clone(),
                updated_at: file.updated_at.clone(),
                installed_at: now.clone(),
                title: file.title.clone(),
                url: file.url.clone(),
            },
        );
    }
    library::write_provenance(client_dir, &entries)
}

/// The folder inside `home\` a client's files belong to.
///
/// `fs_game` when the client has one, `base` otherwise: that is the folder
/// the engine loads from, and installing anywhere else would leave the file
/// invisible to the game.
fn folder_of(client: &clients::Client) -> String {
    client
        .fs_game
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("base")
        .to_string()
}

/// Registers the state this module keeps. Called from `lib.rs`.
pub fn manage(app: &AppHandle) {
    app.manage(JkhubState::default());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::Client;
    // Only the fixture below names a shelf of the site; the commands speak
    // the launcher's `Game`, which `super::*` already brings in.
    use types::JkhubGame;

    fn client(fs_game: Option<&str>) -> Client {
        Client {
            id: "everyday".into(),
            name: "Everyday".into(),
            engine_id: "openjk".into(),
            game: Game::JediAcademy,
            engine_version: None,
            created_at: timestamp::now_rfc3339(),
            engine_installed_at: None,
            engine_published_at: None,
            fs_game: fs_game.map(str::to_string),
        }
    }

    #[test]
    fn the_tree_is_walked_once_at_a_time_and_once_a_day() {
        let trees = Refreshes::default();
        let day = TREE_REFRESH_INTERVAL;
        let now = 1_800_000_000;

        assert!(trees.start(Game::JediAcademy, now, TREE_REFRESH_INTERVAL), "the first walk starts");
        assert!(
            !trees.start(Game::JediAcademy, now + 5, TREE_REFRESH_INTERVAL),
            "a second answer must not start a second walk"
        );
        assert!(
            trees.start(Game::JediOutcast, now, TREE_REFRESH_INTERVAL),
            "the other game has its own walk"
        );

        trees.finish(Game::JediAcademy);
        assert!(
            !trees.start(Game::JediAcademy, now + day - 1, TREE_REFRESH_INTERVAL),
            "a walk that just ran is not repeated within the day"
        );
        assert!(
            trees.start(Game::JediAcademy, now + day, TREE_REFRESH_INTERVAL),
            "a day later it walks again"
        );
        trees.finish(Game::JediAcademy);

        // **Update categories** walks in the foreground and only writes down
        // that it did, so the answer after it starts nothing.
        trees.note(Game::JediAcademy, now + day + 10);
        assert!(!trees.start(Game::JediAcademy, now + day + 11, TREE_REFRESH_INTERVAL));
        assert!(trees.start(Game::JediAcademy, now + 2 * day + 10, TREE_REFRESH_INTERVAL));
    }

    /// --- slice: jkhub index ---
    #[test]
    fn the_player_waits_for_nothing_but_a_run_already_going() {
        let catalogues = Refreshes::default();
        let now = 1_800_000_000;

        assert!(!catalogues.running(Game::JediAcademy), "nothing has run yet");
        // Interval zero is the **Refresh** action: it ignores how recently the
        // last one ran.
        assert!(catalogues.start(Game::JediAcademy, now, 0));
        assert!(catalogues.running(Game::JediAcademy));
        assert!(
            !catalogues.start(Game::JediAcademy, now + 1, 0),
            "a crawl already in flight is the one thing that refuses"
        );
        assert!(
            !catalogues.running(Game::JediOutcast),
            "the other game is idle and says so"
        );

        catalogues.finish(Game::JediAcademy);
        assert!(!catalogues.running(Game::JediAcademy));
        assert!(catalogues.start(Game::JediAcademy, now + 2, 0));
        catalogues.finish(Game::JediAcademy);

        // The automatic path passes the daily interval and is held to it.
        assert!(!catalogues.start(
            Game::JediAcademy,
            now + 3,
            index::AUTO_REFRESH_INTERVAL
        ));
    }

    #[test]
    fn files_go_to_the_folder_the_engine_reads() {
        assert_eq!(folder_of(&client(None)), "base");
        assert_eq!(folder_of(&client(Some("japlus"))), "japlus");
        assert_eq!(folder_of(&client(Some("  "))), "base");
    }

    #[test]
    fn an_archive_with_nothing_installable_answers_instead_of_failing() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = dir.path().join("readme.zip");
        {
            use std::io::Write;
            let file = std::fs::File::create(&archive).expect("a file");
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("Readme.txt", zip::write::SimpleFileOptions::default())
                .expect("an entry");
            writer.write_all(b"text").expect("written");
            writer.finish().expect("closed");
        }
        let target = dir.path().join("base");
        std::fs::create_dir_all(&target).expect("the target exists");

        let outcome = unpack(&archive, &target, false).expect("it answers");
        let filled = with_archive_path(outcome, &archive, "https://jkhub.org/files/file/1-x/");
        match filled {
            JkhubInstallOutcome::NoPk3Files {
                entries,
                archive_path,
            } => {
                assert_eq!(entries, vec!["Readme.txt".to_string()]);
                assert!(archive_path.ends_with("readme.zip"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_rar_answers_with_the_page_to_open_instead() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = dir.path().join("skin.rar");
        std::fs::write(&archive, b"Rar!").expect("a file");
        let target = dir.path().join("base");
        std::fs::create_dir_all(&target).expect("the target exists");

        let outcome = unpack(&archive, &target, false).expect("it answers");
        match with_archive_path(outcome, &archive, "https://jkhub.org/files/file/1-x/") {
            JkhubInstallOutcome::Unsupported { format, url, .. } => {
                assert_eq!(format, "rar");
                assert_eq!(url, "https://jkhub.org/files/file/1-x/");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_taken_name_is_reported_and_overwritten_only_when_asked() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = dir.path().join("skin.zip");
        {
            use std::io::Write;
            let file = std::fs::File::create(&archive).expect("a file");
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("kyle.pk3", zip::write::SimpleFileOptions::default())
                .expect("an entry");
            writer.write_all(b"new").expect("written");
            writer.finish().expect("closed");
        }
        let target = dir.path().join("base");
        std::fs::create_dir_all(&target).expect("the target exists");
        std::fs::write(target.join("kyle.pk3"), b"old").expect("an older file");

        match unpack(&archive, &target, false).expect("it answers") {
            JkhubInstallOutcome::Conflicts { files } => {
                assert_eq!(files, vec!["kyle.pk3".to_string()])
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(std::fs::read(target.join("kyle.pk3")).unwrap(), b"old");

        match unpack(&archive, &target, true).expect("it answers") {
            JkhubInstallOutcome::Installed { files } => {
                assert_eq!(files, vec!["kyle.pk3".to_string()])
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(std::fs::read(target.join("kyle.pk3")).unwrap(), b"new");
    }

    #[test]
    fn provenance_survives_a_write_and_a_read() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let client_dir = dir.path().join("clients").join("everyday");
        std::fs::create_dir_all(client_dir.join("home").join("base")).expect("the layout");

        let file = types::JkhubFile {
            id: 4234,
            slug: "saitohajime".into(),
            title: "Saito Hajime".into(),
            url: "https://jkhub.org/files/file/4234-saitohajime/".into(),
            game: JkhubGame::Jo,
            category_id: Some(67),
            category_name: Some("Skins".into()),
            author: None,
            description: String::new(),
            submitted_at: None,
            updated_at: Some("2020-01-01T00:00:00Z".into()),
            version: Some("1.0".into()),
            views: 0,
            downloads: 0,
            comments: 0,
            reviews: 0,
            rating: None,
            screenshots: Vec::new(),
            tags: Vec::new(),
            changelog: Vec::new(),
        };
        record(&client_dir, "base", &["saitohajime.pk3".to_string()], &file)
            .expect("it writes");

        let back = library::read_provenance(&client_dir);
        let entry = back.get("base/saitohajime.pk3").expect("the entry is there");
        assert_eq!(entry.source, "jkhub");
        assert_eq!(entry.file_id, 4234);
        assert_eq!(entry.version.as_deref(), Some("1.0"));
        assert_eq!(entry.title, "Saito Hajime");
        assert!(!entry.installed_at.is_empty());
        assert!(client_dir.join("home").join(".jknet").is_dir());
    }
}
