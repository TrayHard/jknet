//! Resolving and fetching the archive behind a file page.
//!
//! A guest download on Invision Community takes three steps, and skipping any
//! of them fails in a way that looks like something else (report, section 4):
//!
//! 1. load the file page. The response sets `ips4_IPSSessionFront` and the
//!    body carries a `csrfKey` bound to exactly that session;
//! 2. request `?do=download&csrfKey=…` **with the same cookie jar** and do not
//!    follow the redirect. A key from another session answers `403`; no key at
//!    all answers a redirect back to the page, which looks like success;
//! 3. the `Location` is the real address. On `files.jkhub.org` it is an
//!    archive; anywhere else the record is a link to another site and there is
//!    nothing to install.
//!
//! The key is never stored between calls: it lives as long as the session
//! does, and a stale one is the one failure this flow has.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use reqwest::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::StatusCode;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, Result};
use crate::paths::DataPaths;

use super::client::{self, JkhubClient};
use super::parse;
use super::types::{DownloadProgress, JkhubDownload, JkhubInstallOutcome};

/// Event the Library screen listens to while an archive is coming down.
pub const PROGRESS_EVENT: &str = "jkhub:download-progress";

/// Shortest gap between two progress events, in milliseconds. A 217 MB map
/// would otherwise emit thousands of them (report, section 7).
const PROGRESS_INTERVAL_MS: u128 = 150;

/// Follows the download button of one file and says where it leads.
///
/// The `slug` is only cosmetic in the address, but the page has to be fetched
/// anyway: that request is what mints the session the key belongs to.
pub async fn resolve(http: &JkhubClient, id: u32, slug: &str) -> Result<JkhubDownload> {
    let page = http.fetch_html(&parse::file_url(id, slug)).await?;
    let slug = parse::file_ref(&page.url)
        .map(|(_, slug)| slug)
        .unwrap_or_else(|| slug.to_string());
    let key = parse::find_csrf_key(&page.body).ok_or_else(|| AppError::JkhubParse {
        what: format!("file {id} has no download key on its page"),
    })?;

    let response = http
        .get_no_redirect(&parse::download_url(id, &slug, &key))
        .await?;
    let status = response.status();
    if status == StatusCode::FORBIDDEN {
        return Err(AppError::JkhubDownload(format!(
            "JKHub refused the download of file {id}: the page key belongs to another session"
        )));
    }
    if !status.is_redirection() {
        return Err(AppError::JkhubDownload(format!(
            "the download of file {id} answered {status} instead of a redirect"
        )));
    }
    let Some(target) = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| client::absolute(value, &page.url))
    else {
        return Err(AppError::JkhubDownload(format!(
            "the download of file {id} redirected nowhere"
        )));
    };

    // A redirect back to the file page means the key never made it through.
    if parse::file_ref(&target).is_some() {
        return Err(AppError::JkhubDownload(format!(
            "JKHub sent the download of file {id} back to its own page, which means the key was not accepted"
        )));
    }

    if !parse::is_hosted_archive(&target) {
        log::info!("jkhub file {id} points at {target}");
        return Ok(JkhubDownload::External { url: target });
    }

    let head = http.head(&target).await?;
    Ok(JkhubDownload::Hosted {
        file_name: parse::file_name_from_url(&target)
            .unwrap_or_else(|| format!("jkhub-{id}.zip")),
        size: header_u64(head.headers().get(CONTENT_LENGTH)),
        content_type: head
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(';').next().unwrap_or(value).trim().to_string()),
        url: target,
    })
}

/// Streams an archive into `dir`, resuming a partial file when it can.
///
/// `files.jkhub.org` answers `Accept-Ranges: bytes` (report, section 4), so a
/// download interrupted at 200 MB of a 217 MB map picks up where it stopped
/// instead of starting again. The server is asked first and the resume is
/// dropped when the answer is not a `206`.
pub async fn fetch(
    app: &AppHandle,
    http: &JkhubClient,
    file_id: u32,
    url: &str,
    dir: &Path,
    file_name: &str,
    expected: Option<u64>,
) -> Result<PathBuf> {
    let target = dir.join(sanitize(file_name));
    if let Ok(metadata) = std::fs::metadata(&target) {
        if Some(metadata.len()) == expected && metadata.len() > 0 {
            log::info!("jkhub: reusing {}", target.display());
            return Ok(target);
        }
    }

    let partial = target.with_extension("part");
    let have = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    let response = http.get_range(url, have).await?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::JkhubDownload(format!("{url} answered {status}")));
    }

    // A server that ignored the range restarts the file, so the partial one
    // has to go: appending to it would splice two copies together.
    let resuming = have > 0
        && status == StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(ACCEPT_RANGES)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.contains("bytes"))
            .unwrap_or(true);
    let already = if resuming { have } else { 0 };
    let total = header_u64(response.headers().get(CONTENT_LENGTH))
        .map(|length| length + already)
        .or(expected)
        .unwrap_or(0);

    let mut sink = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resuming)
        .truncate(!resuming)
        .open(&partial)
        .await
        .map_err(|e| AppError::io_path("cannot create", &partial, e))?;

    let mut received = already;
    let mut last = std::time::Instant::now();
    emit(app, file_id, received, total, file_name);

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::JkhubDownload(e.to_string()))?;
        sink.write_all(&chunk)
            .await
            .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
        received += chunk.len() as u64;
        if last.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
            last = std::time::Instant::now();
            emit(app, file_id, received, total, file_name);
        }
    }
    sink.flush()
        .await
        .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
    // `flush` empties the writer's buffer; `sync_all` is what survives a
    // power cut, and the rename below must not promote a file the disk has
    // not taken yet.
    sink.sync_all()
        .await
        .map_err(|e| AppError::io_path("cannot write", &partial, e))?;
    drop(sink);

    if total > 0 && received != total {
        return Err(AppError::JkhubDownload(format!(
            "{file_name} stopped at {received} of {total} bytes"
        )));
    }

    if target.exists() {
        std::fs::remove_file(&target)
            .map_err(|e| AppError::io_path("cannot replace", &target, e))?;
    }
    std::fs::rename(&partial, &target)
        .map_err(|e| AppError::io_path("cannot rename", &partial, e))?;
    emit(app, file_id, received, total.max(received), file_name);
    log::info!("jkhub: downloaded {received} bytes into {}", target.display());
    Ok(target)
}

/// Sends one progress event. A failed emit is logged, never propagated: a
/// download must not fail because a window went away.
fn emit(app: &AppHandle, file_id: u32, received: u64, total: u64, file_name: &str) {
    let payload = DownloadProgress {
        file_id,
        received,
        total,
        file_name: file_name.to_string(),
    };
    if let Err(e) = app.emit(PROGRESS_EVENT, payload) {
        log::warn!("cannot emit {PROGRESS_EVENT}: {e}");
    }
}

fn header_u64(value: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    value?.to_str().ok()?.trim().parse().ok()
}

/// Keeps a name from the site from becoming a path.
///
/// The name comes from the last segment of a URL after percent-decoding, so
/// `%2E%2E%2F` would otherwise arrive as `../`.
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "download.zip".to_string()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// What happens to an archive nobody installed
// ---------------------------------------------------------------------------

/// How long the archive of an install that did not install is kept.
///
/// Long enough for the player to come back to the screen and press the button
/// the outcome offered, short enough that a day of declined installs does not
/// live in `cache\jkhub\downloads\` for the rest of the launcher's life.
pub const KEPT_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// Why the archive of a finished attempt is still worth its disk, if it is.
///
/// Review finding (Low): the archive used to be deleted after `Installed` and
/// after nothing else, so every declined install left a file — up to 217 MB of
/// it — that only **Clear JKHub cache** could remove. Deleting it after every
/// other outcome instead would be wrong in the other direction: three of the
/// outcomes put a button on screen that needs those exact bytes. So the answer
/// is per outcome, and [`sweep`] is what bounds the ones that are kept.
pub fn keep_reason(outcome: &JkhubInstallOutcome) -> Option<&'static str> {
    match outcome {
        // The files are in the client; the archive is dead weight.
        JkhubInstallOutcome::Installed { .. } => None,
        // Nothing was downloaded: the record points at another site.
        JkhubInstallOutcome::External { .. } => None,
        // The screen offers «Replace and install», which reads these bytes
        // again. Fetching a 217 MB map twice to answer one question is not a
        // trade the player agreed to.
        JkhubInstallOutcome::Conflicts { .. } => Some("the player can still replace and install"),
        // Both of these put «Show the archive» on screen, and a button that
        // reveals a file deleted a moment ago is worse than the disk it saves.
        JkhubInstallOutcome::NoPk3Files { .. } | JkhubInstallOutcome::Unsupported { .. } => {
            Some("the screen offers Show the archive")
        }
    }
}

/// Removes the archives of attempts that ended more than `kept_for` ago.
///
/// Returns how many folders went. Called at startup: an install that ended
/// yesterday cannot be resumed by any screen open today, and a failure here is
/// a warning in the log rather than something that holds up the window.
pub fn sweep(data: &DataPaths, kept_for: Duration) -> usize {
    let downloads = data.cache.join("jkhub").join("downloads");
    let Ok(entries) = std::fs::read_dir(&downloads) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !is_stale(newest_change(&path), now, kept_for) {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                removed += 1;
                log::info!("jkhub: dropped the stale download in {}", path.display());
            }
            Err(e) => log::warn!("cannot remove {}: {e}", path.display()),
        }
    }
    removed
}

/// Whether a download folder has outlived its welcome.
fn is_stale(changed: Option<SystemTime>, now: SystemTime, kept_for: Duration) -> bool {
    match changed {
        // A folder whose age the filesystem will not say is a folder nothing
        // can ever decide to keep, so it goes rather than staying forever.
        None => true,
        // A time in the future — a clock the player moved back, a file copied
        // from another machine — reads as brand new, which errs towards
        // keeping a file somebody may still want.
        Some(changed) => now
            .duration_since(changed)
            .map(|age| age >= kept_for)
            .unwrap_or(false),
    }
}

/// When anything in a folder last changed, the folder itself included.
///
/// The folder's own timestamp moves when a file is written into it, but only
/// on some filesystems, so the files are asked too.
fn newest_change(dir: &Path) -> Option<SystemTime> {
    let own = std::fs::metadata(dir).and_then(|meta| meta.modified()).ok();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return own;
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().and_then(|meta| meta.modified()).ok())
        .chain(own)
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The saved headers of a successful guest download and of the one record
    /// that points at another site (report, section 7).
    const HOSTED: &str = include_str!("../../tests/fixtures/jkhub/gp-saber-download.headers.txt");
    const EXTERNAL: &str =
        include_str!("../../tests/fixtures/jkhub/fmt-converter-download.headers.txt");

    /// Reads one header out of a saved `curl -I -L` transcript.
    fn header<'a>(transcript: &'a str, name: &str) -> Option<&'a str> {
        transcript.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    #[test]
    fn a_hosted_archive_is_recognised_from_its_saved_headers() {
        let location = header(HOSTED, "Location").expect("the 301 carries one");
        assert_eq!(location, "https://files.jkhub.org/jka/configs/SaberChanger.zip");
        assert!(parse::is_hosted_archive(location));
        assert_eq!(
            parse::file_name_from_url(location),
            Some("SaberChanger.zip".to_string())
        );
        // The second response of the transcript is the archive itself.
        assert!(HOSTED.contains("Content-Type: application/zip"));
        assert!(HOSTED.contains("Content-Length: 1651"));
        assert!(
            HOSTED.contains("Accept-Ranges: bytes"),
            "the file host supports resuming"
        );
    }

    #[test]
    fn a_record_that_links_to_another_site_is_not_an_archive() {
        let location = header(EXTERNAL, "Location").expect("the 301 carries one");
        assert_eq!(location, "https://mrwonko.de/g2tools/jk3-to-jk2/");
        assert!(!parse::is_hosted_archive(location));
        assert!(
            EXTERNAL.contains("Content-Type: text/html"),
            "and the type confirms it"
        );
    }

    /// Walks the whole guest download flow against the live site, on the
    /// smallest archive the research found: 1 651 bytes of config script.
    ///
    /// Ignored by default: a test suite must not fetch from another project's
    /// server. Run it by hand with
    /// `cargo test -- --ignored jkhub::download::tests::live` after touching
    /// the `csrfKey` flow.
    #[test]
    #[ignore = "downloads from jkhub.org"]
    fn live_the_smallest_archive_comes_down_whole() {
        let client = JkhubClient::new().expect("a client");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime");
        let resolved = runtime
            .block_on(resolve(&client, 1486, "saber-changer"))
            .expect("the download resolves");
        let JkhubDownload::Hosted {
            url,
            file_name,
            size,
            content_type,
        } = resolved
        else {
            panic!("1486 is an upload, not a link");
        };
        assert_eq!(file_name, "SaberChanger.zip");
        assert!(parse::is_hosted_archive(&url));
        assert_eq!(content_type.as_deref(), Some("application/zip"));
        let size = size.expect("the file host sends a length");
        assert!(size < 2 * 1024 * 1024, "kept small on purpose: {size}");

        let dir = tempfile::tempdir().expect("a temp dir");
        let response = runtime
            .block_on(client.get_range(&url, 0))
            .expect("the archive answers");
        let bytes = runtime.block_on(response.bytes()).expect("the body arrives");
        assert_eq!(bytes.len() as u64, size);
        assert_eq!(&bytes[..2], b"PK", "a zip starts with PK");
        std::fs::write(dir.path().join(&file_name), &bytes).expect("it lands on disk");
        println!("live: {file_name}, {size} bytes, {url}");
    }

    /// Review finding (Low): the archive of an attempt that did not install.
    #[test]
    fn only_an_outcome_with_nothing_left_to_press_loses_its_archive() {
        let kept = [
            JkhubInstallOutcome::Conflicts {
                files: vec!["kyle.pk3".into()],
            },
            JkhubInstallOutcome::NoPk3Files {
                entries: vec!["Readme.txt".into()],
                archive_path: "C:\\cache\\x.zip".into(),
            },
            JkhubInstallOutcome::Unsupported {
                format: "rar".into(),
                archive_path: Some("C:\\cache\\x.rar".into()),
                url: "https://jkhub.org/files/file/1-x/".into(),
            },
        ];
        for outcome in kept {
            assert!(
                keep_reason(&outcome).is_some(),
                "a button on screen still needs {outcome:?}"
            );
        }

        let dropped = [
            JkhubInstallOutcome::Installed {
                files: vec!["kyle.pk3".into()],
            },
            JkhubInstallOutcome::External {
                url: "https://mrwonko.de/".into(),
            },
        ];
        for outcome in dropped {
            assert_eq!(keep_reason(&outcome), None, "{outcome:?}");
        }
    }

    #[test]
    fn an_archive_kept_for_a_retry_does_not_stay_for_ever() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let data = crate::paths::DataPaths::new(dir.path().to_path_buf());
        data.ensure().expect("the layout is created");
        let downloads = data.cache.join("jkhub").join("downloads");

        assert_eq!(sweep(&data, KEPT_FOR), 0, "no folder, nothing to do");

        for id in ["1", "2"] {
            std::fs::create_dir_all(downloads.join(id)).expect("a download folder");
            std::fs::write(downloads.join(id).join("x.zip"), b"zip").expect("an archive");
        }
        // A stray file rather than a folder: whatever put it there, it is not
        // a download and the sweep leaves it alone.
        std::fs::write(downloads.join("notes.txt"), b"text").expect("a stray file");

        assert_eq!(sweep(&data, KEPT_FOR), 0, "both were downloaded just now");
        assert!(downloads.join("1").is_dir());

        // Nothing may be kept for no time at all, which is every folder.
        assert_eq!(sweep(&data, Duration::ZERO), 2);
        assert!(!downloads.join("1").exists());
        assert!(!downloads.join("2").exists());
        assert!(downloads.join("notes.txt").exists(), "not a download");
    }

    #[test]
    fn the_age_of_a_download_decides_and_a_clock_that_went_back_does_not() {
        let now = SystemTime::now();
        let day = Duration::from_secs(24 * 60 * 60);
        assert!(is_stale(Some(now - day - Duration::from_secs(1)), now, day));
        assert!(is_stale(Some(now - day), now, day), "exactly a day is spent");
        assert!(!is_stale(Some(now - Duration::from_secs(3600)), now, day));
        assert!(!is_stale(Some(now + day), now, day), "a clock moved back");
        assert!(is_stale(None, now, day), "an age nobody can read");
    }

    #[test]
    fn a_name_from_the_site_cannot_become_a_path() {
        assert_eq!(sanitize("SaberChanger.zip"), "SaberChanger.zip");
        assert_eq!(sanitize("g2c 2.0.zip"), "g2c 2.0.zip");
        assert_eq!(sanitize("../../evil.zip"), "_.._evil.zip");
        assert_eq!(sanitize("C:\\windows\\x.zip"), "C__windows_x.zip");
        assert_eq!(sanitize("   "), "download.zip");
        assert_eq!(sanitize(".."), "download.zip");
    }
}
