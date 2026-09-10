//! The one HTTP client that talks to jkhub.org, and the limiter in front of
//! it.
//!
//! JKHub has no public API without a key, so the launcher reads the same
//! pages a visitor reads. That puts the burden of behaving well on this file:
//!
//! * one connection pool, one cookie jar. The jar is not optional — a guest
//!   download needs the `csrfKey` of the page **and** the session cookie that
//!   page was served with (report, section 4);
//! * two budgets, and never more than [`MAX_PARALLEL_TOTAL`] requests in
//!   flight whatever they are for. What a player is waiting on keeps the pace
//!   the research session measured — [`MAX_PARALLEL`] at a time,
//!   [`MIN_GAP_MS`] apart — and the catalogue crawl gets its own,
//!   [`CRAWL_PARALLEL`] at a time [`CRAWL_MIN_GAP_MS`] apart. The research
//!   session held one request per second across 54 requests without ever
//!   meeting a Cloudflare check; the crawl is ten a second for a quarter of a
//!   minute, once a week at most, and never while another crawl runs;
//! * a `User-Agent` that names the program and where to complain about it;
//! * redirects are followed by hand, in [`fetch_html`], because the download
//!   step needs to read a `Location` instead of chasing it (report,
//!   section 4).
//!
//! The site sends no `X-RateLimit-*` headers and no `Retry-After`, so there
//! is nothing to obey beyond the limits above (report, section 6).

use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, CACHE_CONTROL, LOCATION};
use reqwest::redirect::Policy;
use reqwest::{Response, StatusCode};
use tokio::sync::{Mutex, Semaphore};

use crate::error::{AppError, Result};

/// Requests in flight at once, whatever they are for.
///
/// The two lanes below have their own allowances; this is the promise the site
/// gets no matter how many of them are busy. A player who opens a file page
/// while the catalogue is being crawled waits behind a crawl request rather
/// than adding a fifth connection.
pub const MAX_PARALLEL_TOTAL: usize = 4;

/// Requests in flight at once for what a player is waiting on.
pub const MAX_PARALLEL: usize = 2;

/// Shortest gap between the starts of two of those, in milliseconds.
pub const MIN_GAP_MS: u64 = 300;

/// Requests in flight at once for the catalogue crawl.
pub const CRAWL_PARALLEL: usize = 4;

/// Shortest gap between the starts of two crawl requests, in milliseconds.
///
/// Four at a time a tenth of a second apart is ten requests a second at the
/// most. The whole Jedi Academy catalogue is about 150 listing pages, so the
/// crawl is over in a quarter of a minute — short enough that the launcher can
/// pay for it before the player searches instead of under them.
pub const CRAWL_MIN_GAP_MS: u64 = 100;

/// How fast one kind of work may read the site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pace {
    pub parallel: usize,
    pub min_gap_ms: u64,
}

/// What a player is waiting for: a listing, a file page, a download.
pub const INTERACTIVE: Pace = Pace {
    parallel: MAX_PARALLEL,
    min_gap_ms: MIN_GAP_MS,
};

/// The catalogue crawl, which nobody is watching a single request of.
pub const CRAWL: Pace = Pace {
    parallel: CRAWL_PARALLEL,
    min_gap_ms: CRAWL_MIN_GAP_MS,
};

/// Which budget a request is spent from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Lane {
    #[default]
    Interactive,
    Crawl,
}

impl Lane {
    pub fn pace(self) -> Pace {
        match self {
            Lane::Interactive => INTERACTIVE,
            Lane::Crawl => CRAWL,
        }
    }
}

/// One lane's allowance: how many at once, and how far apart.
#[derive(Debug)]
pub struct Limiter {
    pace: Pace,
    /// Caps how many requests of this lane are in flight.
    permits: Semaphore,
    /// When the last request of this lane was started. Behind an async lock
    /// because it is held across the sleep that spaces requests out.
    last: Mutex<Option<Instant>>,
}

impl Limiter {
    pub fn new(pace: Pace) -> Self {
        Limiter {
            pace,
            permits: Semaphore::new(pace.parallel),
            last: Mutex::new(None),
        }
    }

    /// The allowance this limiter hands out, for a caller that has to keep to
    /// it on its own — the crawl reads its pages [`Pace::parallel`] at a time
    /// so that it never queues more of them than the limiter would let
    /// through.
    pub fn pace(&self) -> Pace {
        self.pace
    }

    /// Waits for a slot and for the gap, then hands out a permit.
    ///
    /// The permit is held for the length of the request, which is what makes
    /// [`Pace::parallel`] mean requests rather than calls. The lock on `last`
    /// is held across the sleep on purpose: it is what keeps two callers from
    /// deciding at the same moment that the gap has passed.
    async fn ticket(&self) -> Result<tokio::sync::SemaphorePermit<'_>> {
        let permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| AppError::State("the JKHub limiter is closed".into()))?;
        let mut last = self.last.lock().await;
        if let Some(previous) = *last {
            let gap = Duration::from_millis(self.pace.min_gap_ms);
            let elapsed = previous.elapsed();
            if elapsed < gap {
                tokio::time::sleep(gap - elapsed).await;
            }
        }
        *last = Some(Instant::now());
        Ok(permit)
    }
}

/// Time allowed to open the connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Time allowed for the whole request, downloads excluded.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Redirect hops [`fetch_html`] follows before giving up.
const MAX_HOPS: u8 = 5;

/// Where the site is. The host the archives come from, `files.jkhub.org`, is
/// recognised by [`super::parse::is_hosted_archive`].
pub const SITE: &str = "https://jkhub.org";

/// Names the program and points at the repository, so an administrator who
/// sees the traffic knows what it is and where to write.
fn user_agent() -> String {
    format!(
        "JKNet/{} (+https://github.com/TrayHard/jknet)",
        env!("CARGO_PKG_VERSION")
    )
}

/// The client, its cookie jar and the limiter that paces it.
///
/// Lives in Tauri's managed state, so one jar serves the whole run: a session
/// cookie taken while a card was being shown is still the session the
/// download request needs.
#[derive(Debug)]
pub struct JkhubClient {
    http: reqwest::Client,
    /// Every request in flight, whichever lane it belongs to.
    all: Semaphore,
    /// What a player is waiting on.
    interactive: Limiter,
    /// The catalogue crawl.
    crawl: Limiter,
}

impl JkhubClient {
    /// Builds the client, or reports why it could not be built.
    ///
    /// Called once at startup. A failure here means rustls could not start,
    /// which is not something a retry fixes, so it is logged and the module
    /// answers `JkhubUnavailable` from then on.
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(user_agent())
            .gzip(true)
            .cookie_store(true)
            // Followed by hand: `resolve_download` has to read the `Location`
            // of the first hop rather than chase it.
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(READ_TIMEOUT)
            .build()
            .map_err(|e| AppError::Network(format!("cannot build the JKHub client: {e}")))?;
        Ok(JkhubClient {
            http,
            all: Semaphore::new(MAX_PARALLEL_TOTAL),
            interactive: Limiter::new(Lane::Interactive.pace()),
            crawl: Limiter::new(Lane::Crawl.pace()),
        })
    }

    /// The allowance one lane spends from.
    pub fn limiter(&self, lane: Lane) -> &Limiter {
        match lane {
            Lane::Interactive => &self.interactive,
            Lane::Crawl => &self.crawl,
        }
    }

    /// One request, paced and logged.
    ///
    /// Every call to the site goes through here, so the log holds the whole
    /// conversation at debug level and a report about "the launcher hammers
    /// JKHub" can be answered with evidence.
    pub async fn send(&self, request: reqwest::RequestBuilder) -> Result<Response> {
        self.send_in(Lane::Interactive, request).await
    }

    /// The same request, spent from the budget of one lane.
    ///
    /// Two permits, always in this order: the lane's first, the shared one
    /// second. Nothing ever waits for a lane permit while holding a shared
    /// one, so the pair cannot deadlock.
    pub async fn send_in(
        &self,
        lane: Lane,
        request: reqwest::RequestBuilder,
    ) -> Result<Response> {
        let _lane = self.limiter(lane).ticket().await?;
        let _all = self
            .all
            .acquire()
            .await
            .map_err(|_| AppError::State("the JKHub limiter is closed".into()))?;
        let response = request.send().await.map_err(unreachable)?;
        log::debug!("jkhub {} {}", response.status().as_u16(), response.url());
        Ok(response)
    }

    /// Fetches a page as text, following redirects by hand.
    ///
    /// Two of the categories redirect to hand-written pages of the site's CMS
    /// (`/jk3files/`, `/jk2files/`), and those carry no file list, so the hop
    /// count is capped and the final address is returned with the body: a
    /// caller that ends up somewhere else can say so.
    pub async fn fetch_html(&self, url: &str) -> Result<Page> {
        self.fetch_html_in(url, Lane::Interactive).await
    }

    /// The same fetch, spent from the budget of one lane.
    ///
    /// The catalogue crawl reads its hundred and fifty listing pages through
    /// [`Lane::Crawl`], which is four at a time rather than two and a tenth of
    /// a second apart rather than three tenths.
    pub async fn fetch_html_in(&self, url: &str, lane: Lane) -> Result<Page> {
        self.fetch(url, false, lane)
            .await?
            .ok_or_else(|| AppError::JkhubUnavailable(format!("{url} answered 404")))
    }

    /// The same fetch, treating `404` as an answer rather than a failure.
    ///
    /// The catalogue index needs the difference: a file page that is gone
    /// means the record was deleted and the entry has to go with it, while
    /// every other refusal means the site is having a bad minute and the entry
    /// stays.
    pub async fn fetch_html_opt(&self, url: &str) -> Result<Option<Page>> {
        self.fetch(url, true, Lane::Interactive).await
    }

    /// The shared body of the two fetches.
    async fn fetch(&self, url: &str, allow_missing: bool, lane: Lane) -> Result<Option<Page>> {
        let mut address = url.to_string();
        for _ in 0..MAX_HOPS {
            let response = self.send_in(lane, self.http.get(&address)).await?;
            let status = response.status();
            if status.is_redirection() {
                let Some(next) = location(response.headers(), &address) else {
                    return Err(AppError::JkhubUnavailable(format!(
                        "{address} answered {status} without a destination"
                    )));
                };
                address = next;
                continue;
            }
            if allow_missing && status == StatusCode::NOT_FOUND {
                log::debug!("jkhub: {address} is gone");
                return Ok(None);
            }
            if !status.is_success() {
                return Err(status_error(&address, status));
            }
            let max_age = max_age(response.headers());
            let text = response.text().await.map_err(unreachable)?;
            return Ok(Some(Page {
                url: address,
                body: text,
                max_age,
            }));
        }
        Err(AppError::JkhubUnavailable(format!(
            "{url} keeps redirecting"
        )))
    }

    /// One request without following the redirect, for the download step.
    pub async fn get_no_redirect(&self, url: &str) -> Result<Response> {
        self.send(self.http.get(url)).await
    }

    /// A `HEAD` on the resolved archive: its size and type without its body.
    pub async fn head(&self, url: &str) -> Result<Response> {
        self.send(self.http.head(url)).await
    }

    /// A `GET` for the bytes of an archive, optionally resuming at `from`.
    pub async fn get_range(&self, url: &str, from: u64) -> Result<Response> {
        let mut request = self.http.get(url);
        if from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
        }
        self.send(request).await
    }
}

/// A page as it came back, with what the site said about keeping it.
#[derive(Debug, Clone)]
pub struct Page {
    /// Where the body actually came from, after any redirect.
    pub url: String,
    pub body: String,
    /// `Cache-Control: max-age` in seconds, when the answer carried one.
    pub max_age: Option<u64>,
}

/// Turns a transport failure into the variant the screens answer with.
fn unreachable(e: reqwest::Error) -> AppError {
    AppError::JkhubUnavailable(e.to_string())
}

/// Turns a refusal into a sentence that says what to do about it.
fn status_error(url: &str, status: StatusCode) -> AppError {
    if status == StatusCode::FORBIDDEN {
        // The one way a guest earns a 403 here is a `csrfKey` from another
        // session (report, section 4).
        return AppError::JkhubDownload(format!(
            "{url} answered 403. The session key went stale; try the download again."
        ));
    }
    AppError::JkhubUnavailable(format!("{url} answered {status}"))
}

/// The `Location` of a redirect, made absolute.
fn location(headers: &HeaderMap, from: &str) -> Option<String> {
    let value = headers.get(LOCATION)?.to_str().ok()?.trim().to_string();
    Some(absolute(&value, from))
}

/// Resolves a `Location` that may be relative or protocol-relative.
///
/// The site writes `//jkhub.org/...` in places, which is neither absolute nor
/// rooted, and `Url::join` is not available without pulling in the `url`
/// crate on purpose.
pub fn absolute(value: &str, from: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        return value.to_string();
    }
    if let Some(rest) = value.strip_prefix("//") {
        return format!("https://{rest}");
    }
    if value.starts_with('/') {
        let origin = origin_of(from);
        return format!("{origin}{value}");
    }
    let base = from.rsplit_once('/').map(|(head, _)| head).unwrap_or(from);
    format!("{base}/{value}")
}

/// `https://host` of an address, falling back to the site itself.
fn origin_of(url: &str) -> String {
    let Some(rest) = url.split_once("://") else {
        return SITE.to_string();
    };
    let host = rest.1.split('/').next().unwrap_or_default();
    if host.is_empty() {
        return SITE.to_string();
    }
    format!("{}://{host}", rest.0)
}

/// `max-age` out of a `Cache-Control` header.
///
/// The site serves guest pages with `max-age=900`, which is a better lifetime
/// for a cached listing than a number invented here (report, section 6).
pub fn max_age(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(CACHE_CONTROL)?.to_str().ok()?;
    for part in value.split(',') {
        let part = part.trim();
        if let Some(seconds) = part.strip_prefix("max-age=") {
            return seconds.trim().parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn the_user_agent_names_the_program_and_the_repository() {
        let agent = user_agent();
        assert!(agent.starts_with("JKNet/"));
        assert!(agent.contains("github.com/TrayHard/jknet"));
    }

    #[test]
    fn a_location_header_is_resolved_against_the_page_it_came_from() {
        assert_eq!(
            absolute("https://files.jkhub.org/jka/configs/x.zip", SITE),
            "https://files.jkhub.org/jka/configs/x.zip"
        );
        assert_eq!(absolute("//jkhub.org/jk3files/", SITE), "https://jkhub.org/jk3files/");
        assert_eq!(
            absolute("/files/category/13-free-for-all/", "https://jkhub.org/files/"),
            "https://jkhub.org/files/category/13-free-for-all/"
        );
        assert_eq!(
            absolute("page/2/", "https://jkhub.org/files/category/13-x/"),
            "https://jkhub.org/files/category/13-x/page/2/"
        );
    }

    #[test]
    fn the_sites_own_cache_lifetime_is_read_back() {
        let mut headers = HeaderMap::new();
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=900, stale-while-revalidate"),
        );
        assert_eq!(max_age(&headers), Some(900));

        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store"));
        assert_eq!(max_age(&headers), None);
        assert_eq!(max_age(&HeaderMap::new()), None);
    }

    /// The numbers the politeness section of the architecture document
    /// promises. A change here is a change to what jkhub.org sees.
    #[test]
    fn the_two_lanes_keep_their_own_pace() {
        assert_eq!(Lane::Interactive.pace(), INTERACTIVE);
        assert_eq!(INTERACTIVE.parallel, 2);
        assert_eq!(INTERACTIVE.min_gap_ms, 300);

        assert_eq!(Lane::Crawl.pace(), CRAWL);
        assert_eq!(CRAWL.parallel, 4);
        assert_eq!(CRAWL.min_gap_ms, 100);

        assert_eq!(Limiter::new(CRAWL).pace(), CRAWL);
        assert_eq!(Limiter::new(INTERACTIVE).pace(), INTERACTIVE);
    }

    /// Whatever the lanes allow on their own, the site never sees more than
    /// four at once.
    #[test]
    fn the_shared_cap_is_never_smaller_than_a_lane_and_never_larger_than_four() {
        assert_eq!(MAX_PARALLEL_TOTAL, 4);
        let widest = [Lane::Interactive, Lane::Crawl]
            .into_iter()
            .map(|lane| lane.pace().parallel)
            .max()
            .expect("two lanes");
        assert_eq!(
            widest, MAX_PARALLEL_TOTAL,
            "no lane may ask for more than the site is ever shown"
        );
        assert_eq!(
            Lane::Crawl.pace().parallel,
            widest,
            "the crawl is the lane the wider allowance was added for"
        );
    }

    /// The gap is what caps the rate: four at a time a tenth of a second apart
    /// is ten requests a second, and about fifteen seconds for the hundred and
    /// fifty pages of the Jedi Academy catalogue.
    #[test]
    fn the_crawl_pace_puts_a_full_catalogue_inside_twenty_seconds() {
        let pages = 154_u64;
        let seconds = (pages * CRAWL.min_gap_ms) as f64 / 1000.0;
        assert!((15.0..=20.0).contains(&seconds), "{seconds} s");
    }

    #[test]
    fn a_stale_key_is_answered_with_advice_rather_than_a_status_code() {
        let error = status_error("https://jkhub.org/x", StatusCode::FORBIDDEN);
        assert!(matches!(error, AppError::JkhubDownload(_)), "{error}");
        assert!(error.to_string().contains("try the download again"));

        let error = status_error("https://jkhub.org/x", StatusCode::NOT_FOUND);
        assert!(matches!(error, AppError::JkhubUnavailable(_)), "{error}");
    }
}
