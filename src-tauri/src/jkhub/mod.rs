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
pub mod install;
pub mod parse;
pub mod source;
pub mod types;

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::clients;
use crate::error::{AppError, Result};
use crate::library;
use crate::state::AppState;
use crate::timestamp;

use client::JkhubClient;
use source::{HtmlSource, JkhubSource};
use types::{
    InstalledEvent, JkhubCategories, JkhubDownload, JkhubFileView, JkhubGame, JkhubInstallOutcome,
    JkhubInstallResult, JkhubListing, JkhubSort, Provenance,
};

/// Emitted once an install finished, so any open screen refetches.
const INSTALLED_EVENT: &str = "jkhub:installed";

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
        }
    }
}

impl JkhubState {
    fn client(&self) -> Result<&JkhubClient> {
        self.client.as_ref().ok_or_else(|| {
            AppError::JkhubUnavailable("the JKHub client could not be built at startup".into())
        })
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
/// `refresh` skips a cache entry that is still fresh, which is what the
/// **Refresh** action on the screen does. The walk costs one request per
/// direct child of a root, so it is cached for a day.
#[tauri::command]
pub async fn jkhub_categories(
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    game: JkhubGame,
    refresh: Option<bool>,
) -> Result<JkhubCategories> {
    let data = state.paths()?;
    let source = HtmlSource::new(jkhub.client()?, &data).forced(refresh.unwrap_or(false));
    source.categories(game).await
}

/// One page of one category, 25 cards at a time.
#[tauri::command]
pub async fn jkhub_list(
    state: tauri::State<'_, AppState>,
    jkhub: tauri::State<'_, JkhubState>,
    category_id: u32,
    sort: Option<JkhubSort>,
    page: Option<u32>,
    refresh: Option<bool>,
) -> Result<JkhubListing> {
    let data = state.paths()?;
    let source = HtmlSource::new(jkhub.client()?, &data).forced(refresh.unwrap_or(false));
    source
        .list(category_id, sort.unwrap_or_default(), page.unwrap_or(1))
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
    let outcome = tokio::task::spawn_blocking(move || {
        unpack(&archive_for_task, &target_for_task, replace)
    })
    .await
    .map_err(|e| AppError::Archive(format!("the unpacker stopped: {e}")))??;

    if let JkhubInstallOutcome::Installed { files } = &outcome {
        record(&client_dir, &folder, files, &view.file)?;
        // The archive was only ever a cache entry; once its files are in the
        // client it is dead weight.
        cache::forget_download(&data, id);
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

/// Empties `cache\jkhub\`, downloaded archives included.
#[tauri::command]
pub fn jkhub_clear_cache(state: tauri::State<'_, AppState>) -> Result<()> {
    let data = state.paths()?;
    cache::clear(&data)
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
    use crate::game::Game;

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
