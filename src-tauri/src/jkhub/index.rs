//! A local index of the JKHub catalogue, one per game.
//!
//! The tab used to search only the pages it had already loaded, so a map that
//! lives in `Mixed Gametypes` could not be found while browsing `Free For All`
//! — jkhub.org's own search finds it, but `/search/` is closed in `robots.txt`
//! and answers guests with activity-stream markup rather than file cards
//! (research report, section 3, and the saved `jkhub-samples/search-*`).
//!
//! So the launcher keeps its own copy of the catalogue: every listing card of
//! every leaf category, in one document per game.
//!
//! ```text
//! cache\jkhub\index-<game>.json           what this machine crawled
//! resources\jkhub\index-<game>.json       what the build shipped
//! ```
//!
//! Three things happen to it, and they are deliberately separate:
//!
//! | Path | Cost | When |
//! | --- | --- | --- |
//! | serve | no requests | every search, every listing |
//! | incremental refresh | 1 request, plus one per file the front page names and the index does not know | at most once a day behind an answer, and on **Refresh** |
//! | full crawl | one request per listing page, about 150 for Jedi Academy | no index at all, one older than a week, or more than [`MAX_UNKNOWN`] unknown files on the front page |
//!
//! The index is not a cache of pages: it holds the fields a card shows and
//! nothing else, so a search never has to open a second document. A file page
//! — description, screenshots, version, rating — is still read by
//! `jkhub_file` and cached the way it always was.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};
use crate::game::Game;
use crate::paths::DataPaths;
use crate::timestamp;

use super::cache;
use super::client::JkhubClient;
use super::parse;
use super::source::{self, HtmlSource};
use super::types::{JkhubAuthor, JkhubCard, JkhubCategory, JkhubGame, JkhubSort};

/// Shape of the stored document. A file written by an older launcher is a
/// miss, not a failure: the fields of a card change with the parsers.
pub const INDEX_VERSION: u32 = 1;

/// Shortest gap between two automatic refreshes of one game's index.
pub const AUTO_REFRESH_INTERVAL: u64 = 24 * 60 * 60;

/// Age past which the incremental path is not trusted and the whole catalogue
/// is crawled again.
///
/// The front page names the newest files, not the ones whose author uploaded a
/// new version, so an index left alone drifts. A week of drift is the most the
/// launcher accepts before paying for a crawl.
pub const FULL_REBUILD_AFTER: u64 = 7 * 24 * 60 * 60;

/// Unknown files on the front page that turn an incremental refresh into a
/// full crawl.
///
/// One request per unknown file is cheaper than a crawl only while there are
/// few of them. Past this, the index is missing so much that crawling is both
/// cheaper and more complete.
pub const MAX_UNKNOWN: usize = 25;

/// Cards in one page of results, and the most a caller may ask for.
///
/// The ceiling is not about this module: a hundred cards is a hundred
/// thumbnails the webview pulls from jkhub.org, and that is the load worth
/// capping.
pub const RESULTS_PER_PAGE: u32 = 25;
pub const MAX_RESULTS_PER_PAGE: u32 = 100;

/// Description kept per file, in characters.
///
/// Enough to search over and to preview under a title; the full text lives on
/// the file page. Three hundred characters times three and a half thousand
/// files is what keeps the Jedi Academy document near a megabyte.
pub const MAX_DESCRIPTION: usize = 300;

/// Listing pages read from one category before the crawl gives up on it.
///
/// The largest category of the site is `Free For All` at fifteen pages. This
/// is a guard against a pagination the parser misreads, not a limit anybody
/// is meant to reach.
const MAX_PAGES_PER_CATEGORY: u32 = 80;

/// Emitted while a crawl runs.
pub const INDEX_PROGRESS_EVENT: &str = "jkhub:index-progress";

/// Emitted once a refresh or a crawl changed the index.
pub const INDEX_UPDATED_EVENT: &str = "jkhub:index-updated";

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/// One file of the catalogue, as its listing card describes it.
///
/// Everything here comes from a card, except the two fields a card cannot
/// carry: `category_id`, which is the category the card was read from, and
/// `game`, which is the shelf that category sits on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    pub id: u32,
    pub slug: String,
    pub title: String,
    pub author_name: Option<String>,
    pub author_url: Option<String>,
    pub category_id: u32,
    pub game: JkhubGame,
    pub thumbnail_url: Option<String>,
    /// Plain text, cut at [`MAX_DESCRIPTION`] characters.
    pub description: String,
    pub downloads: Option<u64>,
    /// RFC 3339. `None` when the card printed the other date and no file page
    /// has been read for this file yet.
    pub submitted_at: Option<String>,
    pub updated_at: Option<String>,
    pub tags: Vec<String>,
}

impl IndexedFile {
    /// The card the screen draws, rebuilt from the index.
    ///
    /// `rating` is always `None`: listing cards of this theme print no stars
    /// at all, whether or not the file has reviews (research report,
    /// section 3), so the index never had one to keep.
    pub fn to_card(&self) -> JkhubCard {
        let (date, date_label) = match (&self.updated_at, &self.submitted_at) {
            (Some(updated), _) => (Some(updated.clone()), Some("Updated".to_string())),
            (None, Some(submitted)) => (Some(submitted.clone()), Some("Submitted".to_string())),
            (None, None) => (None, None),
        };
        JkhubCard {
            id: self.id,
            slug: self.slug.clone(),
            title: self.title.clone(),
            url: parse::file_url(self.id, &self.slug),
            category_id: Some(self.category_id),
            author: self.author_name.as_ref().map(|name| JkhubAuthor {
                name: name.clone(),
                url: self.author_url.clone(),
                avatar_url: None,
            }),
            thumbnail_url: self.thumbnail_url.clone(),
            description: self.description.clone(),
            downloads: self.downloads,
            date,
            date_label,
            tags: self.tags.clone(),
            rating: None,
        }
    }

    /// The card of a listing, turned into an entry of the index.
    ///
    /// The listing is read ordered by `file_updated`, and the theme prints
    /// «Submitted» only for a file that was never updated — its place in that
    /// ordering is the submitted date, so both fields hold it. A card that
    /// says «Updated» hides the submission date; the file page carries it, and
    /// [`from_file`] fills it in the day the incremental refresh touches this
    /// file.
    pub fn from_card(card: JkhubCard, category_id: u32, game: JkhubGame) -> Self {
        let (submitted_at, updated_at) = match card.date_label.as_deref() {
            Some("Submitted") => (card.date.clone(), card.date),
            _ => (None, card.date),
        };
        IndexedFile {
            id: card.id,
            slug: card.slug,
            title: card.title,
            author_name: card.author.as_ref().map(|author| author.name.clone()),
            author_url: card.author.and_then(|author| author.url),
            category_id,
            game,
            thumbnail_url: card.thumbnail_url,
            description: cut(&card.description, MAX_DESCRIPTION),
            downloads: card.downloads,
            submitted_at,
            updated_at,
            tags: card.tags,
        }
    }

    /// A file page, turned into an entry of the index.
    ///
    /// Richer than a card in every field the index keeps: the page carries
    /// both dates and the category the file really sits in, which is what
    /// makes an incremental refresh able to move a file between categories.
    /// The one thing it lacks is the thumbnail the listing prints, so an entry
    /// that already had one keeps it.
    pub fn from_file(file: &super::types::JkhubFile, previous: Option<&IndexedFile>) -> Self {
        IndexedFile {
            id: file.id,
            slug: file.slug.clone(),
            title: file.title.clone(),
            author_name: file.author.as_ref().map(|author| author.name.clone()),
            author_url: file.author.as_ref().and_then(|author| author.url.clone()),
            category_id: file
                .category_id
                .or_else(|| previous.map(|entry| entry.category_id))
                .unwrap_or(0),
            game: file.game,
            thumbnail_url: file
                .screenshots
                .first()
                .and_then(|shot| shot.thumbnail_url.clone().or(Some(shot.url.clone())))
                .or_else(|| previous.and_then(|entry| entry.thumbnail_url.clone())),
            description: cut(&file.description, MAX_DESCRIPTION),
            downloads: Some(file.downloads),
            submitted_at: file.submitted_at.clone(),
            updated_at: file.updated_at.clone(),
            tags: file.tags.clone(),
        }
    }
}

/// Cuts a text to `max` characters without splitting one in half.
fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// The whole catalogue of one game, as this machine last saw it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogIndex {
    /// [`INDEX_VERSION`] at the time of writing.
    pub version: u32,
    pub game: Game,
    /// RFC 3339 moment the last full crawl finished.
    pub built_at: String,
    /// RFC 3339 moment anything was last written into it.
    pub updated_at: String,
    /// The same moment in Unix seconds, for the age check.
    ///
    /// Both are stored for the reason `cache::Envelope` stores both: the
    /// string is what a person reads in the document, the number is what the
    /// decision subtracts, and the launcher owns no RFC 3339 parser.
    pub updated_unix: u64,
    pub files: Vec<IndexedFile>,
}

/// What a merge changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MergeReport {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
}

impl MergeReport {
    pub fn touched(self) -> bool {
        self.added + self.updated + self.removed > 0
    }
}

impl CatalogIndex {
    pub fn new(game: Game) -> Self {
        let now = timestamp::now_rfc3339();
        CatalogIndex {
            version: INDEX_VERSION,
            game,
            built_at: now.clone(),
            updated_at: now,
            updated_unix: timestamp::now_unix(),
            files: Vec::new(),
        }
    }

    /// The whole catalogue, replacing whatever was here.
    ///
    /// A crawl is authoritative in a way a refresh is not: a file it did not
    /// see is a file the site no longer lists, so the report counts it as
    /// removed rather than keeping it out of caution.
    pub fn replace(&mut self, files: Vec<IndexedFile>) -> MergeReport {
        let before: HashMap<u32, &IndexedFile> =
            self.files.iter().map(|entry| (entry.id, entry)).collect();
        let mut report = MergeReport::default();
        let mut seen = HashSet::with_capacity(files.len());
        for file in &files {
            seen.insert(file.id);
            match before.get(&file.id) {
                None => report.added += 1,
                Some(old) if *old != file => report.updated += 1,
                Some(_) => {}
            }
        }
        report.removed = before.keys().filter(|id| !seen.contains(id)).count() as u32;
        let now = timestamp::now_rfc3339();
        self.files = files;
        self.built_at = now.clone();
        self.updated_at = now;
        self.updated_unix = timestamp::now_unix();
        report
    }

    /// Writes one file in, whether it was there or not.
    pub fn upsert(&mut self, file: IndexedFile) -> MergeReport {
        let mut report = MergeReport::default();
        match self.files.iter_mut().find(|entry| entry.id == file.id) {
            Some(entry) => {
                if *entry != file {
                    *entry = file;
                    report.updated = 1;
                }
            }
            None => {
                self.files.push(file);
                report.added = 1;
            }
        }
        report
    }

    /// Drops one file, for the day the site answers `404` about it.
    pub fn remove(&mut self, id: u32) -> MergeReport {
        let before = self.files.len();
        self.files.retain(|entry| entry.id != id);
        MergeReport {
            removed: (before - self.files.len()) as u32,
            ..MergeReport::default()
        }
    }

    /// Marks the moment of the last write. Called once per refresh, not once
    /// per file.
    pub fn touch(&mut self) {
        self.updated_at = timestamp::now_rfc3339();
        self.updated_unix = timestamp::now_unix();
    }

    pub fn ids(&self) -> HashSet<u32> {
        self.files.iter().map(|entry| entry.id).collect()
    }

    pub fn get(&self, id: u32) -> Option<&IndexedFile> {
        self.files.iter().find(|entry| entry.id == id)
    }

    /// Age of the last write, in seconds.
    ///
    /// A document written by a machine whose clock later moved backwards has a
    /// stamp in the future; that answers zero, which is the same thing a
    /// just-written index answers.
    pub fn age(&self, now: u64) -> u64 {
        now.saturating_sub(self.updated_unix)
    }
}

// ---------------------------------------------------------------------------
// Folding, tokens and matching
// ---------------------------------------------------------------------------

/// Lowercases a text and strips the diacritics of the Latin alphabet.
///
/// `Sébastien` and `Sebastien` are the same author to a player typing either,
/// and so are `Łukasz` and `Lukasz`. Everything outside the two Latin blocks —
/// Cyrillic included — is only lowercased, which is what those alphabets want.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match folded_char(ch) {
            Some(replacement) => out.push_str(replacement),
            None => out.extend(ch.to_lowercase()),
        }
    }
    out
}

/// One character of the two Latin blocks, folded to ASCII.
fn folded_char(ch: char) -> Option<&'static str> {
    let point = ch as u32;
    if (0xC0..=0xFF).contains(&point) {
        return Some(LATIN_1[(point - 0xC0) as usize]);
    }
    if (0x100..=0x17F).contains(&point) {
        return Some(LATIN_EXTENDED_A[(point - 0x100) as usize]);
    }
    None
}

/// Latin-1 Supplement, U+00C0 to U+00FF. The two signs in the middle of the
/// block are not letters and are kept as they are.
#[rustfmt::skip]
const LATIN_1: [&str; 64] = [
    "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i",
    "d", "n", "o", "o", "o", "o", "o", "\u{d7}", "o", "u", "u", "u", "u", "y", "th", "ss",
    "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i",
    "d", "n", "o", "o", "o", "o", "o", "\u{f7}", "o", "u", "u", "u", "u", "y", "th", "y",
];

/// Latin Extended-A, U+0100 to U+017F: the Polish, Czech, Hungarian, Baltic
/// and Turkish letters an author's name can carry.
#[rustfmt::skip]
const LATIN_EXTENDED_A: [&str; 128] = [
    "a", "a", "a", "a", "a", "a", "c", "c", "c", "c", "c", "c", "c", "c", "d", "d",
    "d", "d", "e", "e", "e", "e", "e", "e", "e", "e", "e", "e", "g", "g", "g", "g",
    "g", "g", "g", "g", "h", "h", "h", "h", "i", "i", "i", "i", "i", "i", "i", "i",
    "i", "i", "ij", "ij", "j", "j", "k", "k", "k", "l", "l", "l", "l", "l", "l", "l",
    "l", "l", "l", "n", "n", "n", "n", "n", "n", "n", "n", "n", "o", "o", "o", "o",
    "o", "o", "oe", "oe", "r", "r", "r", "r", "r", "r", "s", "s", "s", "s", "s", "s",
    "s", "s", "t", "t", "t", "t", "t", "t", "u", "u", "u", "u", "u", "u", "u", "u",
    "u", "u", "u", "u", "w", "w", "y", "y", "y", "z", "z", "z", "z", "z", "z", "s",
];

/// Splits a query into the tokens every result has to match.
///
/// Whitespace separates them and nothing else does: `mp/ffa3` is one token,
/// because that is how the player typed the name of a map.
pub fn tokenize(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(fold)
        .filter(|token| !token.is_empty())
        .collect()
}

/// Where a token was found. Smaller sorts first.
const FIELD_TITLE: u8 = 0;
const FIELD_META: u8 = 1;
const FIELD_DESCRIPTION: u8 = 2;

/// The folded text of one file, built once when the index is loaded.
///
/// Folding three and a half thousand descriptions on every keystroke would be
/// the slowest part of a search that otherwise touches no I/O at all.
#[derive(Debug, Clone)]
struct Haystack {
    title: String,
    /// Author and tags: the fields that rank between a title and a
    /// description.
    meta: String,
    description: String,
}

impl Haystack {
    fn of(file: &IndexedFile) -> Self {
        let mut meta = String::new();
        if let Some(author) = &file.author_name {
            meta.push_str(&fold(author));
        }
        for tag in &file.tags {
            meta.push(' ');
            meta.push_str(&fold(tag));
        }
        Haystack {
            title: fold(&file.title),
            meta,
            description: fold(&file.description),
        }
    }

    /// How well this file answers the query, or `None` when it does not.
    ///
    /// Every token has to be somewhere. The rank is the worst field any of
    /// them needed: a query whose words are all in the title outranks one that
    /// had to reach into a description for a word.
    fn rank(&self, tokens: &[String]) -> Option<u8> {
        let mut worst = FIELD_TITLE;
        for token in tokens {
            let field = if self.title.contains(token.as_str()) {
                FIELD_TITLE
            } else if self.meta.contains(token.as_str()) {
                FIELD_META
            } else if self.description.contains(token.as_str()) {
                FIELD_DESCRIPTION
            } else {
                return None;
            };
            worst = worst.max(field);
        }
        Some(worst)
    }
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/// Where the index that answered came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexSource {
    /// Crawled on this machine.
    Cache,
    /// The copy that shipped with the build.
    Snapshot,
}

/// An index in memory, with the folded text a search runs over.
#[derive(Debug)]
pub struct LoadedIndex {
    pub index: CatalogIndex,
    pub source: IndexSource,
    haystacks: Vec<Haystack>,
}

impl LoadedIndex {
    pub fn new(index: CatalogIndex, source: IndexSource) -> Self {
        let haystacks = index.files.iter().map(Haystack::of).collect();
        LoadedIndex {
            index,
            source,
            haystacks,
        }
    }

    /// One page of results, plus how many matches each category holds.
    ///
    /// The counts are over the whole match, not over the page, and they ignore
    /// `category_id`: the tree has to show where else the query has answers,
    /// which is the entire point of narrowing by a category rather than
    /// guessing one first.
    pub fn search(&self, request: &SearchRequest) -> SearchAnswer {
        let tokens = tokenize(&request.query);
        let mut counts: BTreeMap<u32, u32> = BTreeMap::new();
        let mut hits: Vec<(u8, usize)> = Vec::new();

        for (position, file) in self.index.files.iter().enumerate() {
            let rank = if tokens.is_empty() {
                Some(FIELD_TITLE)
            } else {
                self.haystacks[position].rank(&tokens)
            };
            let Some(rank) = rank else { continue };
            *counts.entry(file.category_id).or_default() += 1;
            if let Some(wanted) = request.category_id {
                if file.category_id != wanted {
                    continue;
                }
            }
            hits.push((rank, position));
        }

        let files = &self.index.files;
        hits.sort_by(|(left_rank, left), (right_rank, right)| {
            left_rank
                .cmp(right_rank)
                .then_with(|| compare(&files[*left], &files[*right], request.sort))
                .then_with(|| files[*left].id.cmp(&files[*right].id))
        });

        let total = hits.len() as u32;
        let per_page = request.per_page.clamp(1, MAX_RESULTS_PER_PAGE);
        let page = request.page.max(1);
        let from = ((page - 1) * per_page) as usize;
        let cards = hits
            .iter()
            .skip(from)
            .take(per_page as usize)
            .map(|(_, position)| files[*position].to_card())
            .collect();

        SearchAnswer {
            total,
            page,
            per_page,
            pages: total.div_ceil(per_page).max(1),
            cards,
            category_counts: counts,
        }
    }
}

/// What `jkhub_search` was asked for.
#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub query: String,
    pub category_id: Option<u32>,
    pub sort: JkhubSort,
    pub page: u32,
    pub per_page: u32,
}

/// What the search found, before the command adds the age of the index.
#[derive(Debug, Clone)]
pub struct SearchAnswer {
    pub total: u32,
    pub page: u32,
    pub per_page: u32,
    pub pages: u32,
    pub cards: Vec<JkhubCard>,
    /// Matches per category the files sit in, before the tree rolls them up.
    pub category_counts: BTreeMap<u32, u32>,
}

/// Orders two files the way the player asked.
///
/// `TopRated` is the one sort the index cannot serve: a listing card of this
/// theme prints no stars, so no crawl ever saw a rating. It falls back to the
/// number of downloads, which is the other thing a player means by «the good
/// ones», and the tab does not offer it.
fn compare(left: &IndexedFile, right: &IndexedFile, sort: JkhubSort) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match sort {
        JkhubSort::RecentlyUpdated => newest_first(
            left.updated_at.as_deref().or(left.submitted_at.as_deref()),
            right.updated_at.as_deref().or(right.submitted_at.as_deref()),
        ),
        JkhubSort::Newest => newest_first(
            left.submitted_at.as_deref().or(left.updated_at.as_deref()),
            right.submitted_at.as_deref().or(right.updated_at.as_deref()),
        ),
        JkhubSort::MostDownloaded | JkhubSort::TopRated => {
            match (left.downloads, right.downloads) {
                (Some(a), Some(b)) => b.cmp(&a),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            }
        }
        JkhubSort::Name => fold(&left.title).cmp(&fold(&right.title)),
    }
}

/// Newer first, and a file without a date last.
///
/// The site prints RFC 3339 in UTC (`2026-09-02T14:15:36Z`), so comparing the
/// strings is comparing the moments.
fn newest_first(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (left, right) {
        (Some(a), Some(b)) => b.cmp(a),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// Rolls the per-category counts up the tree.
///
/// A player looking at `Maps` wants to know that the query has answers
/// somewhere under it, not that `Maps` itself holds none — it holds none by
/// design, it is a container. So every node carries its own matches plus
/// everything below it, and a node left at zero is one the pruned tree hides.
pub fn roll_up(counts: &BTreeMap<u32, u32>, tree: &[JkhubCategory]) -> BTreeMap<u32, u32> {
    let parents: HashMap<u32, Option<u32>> = tree
        .iter()
        .map(|entry| (entry.id, entry.parent_id))
        .collect();
    let mut rolled: BTreeMap<u32, u32> = BTreeMap::new();
    for (id, count) in counts {
        let mut node = Some(*id);
        let mut guard = 0;
        while let Some(current) = node {
            *rolled.entry(current).or_default() += count;
            // The tree is three deep; the guard is against a parent chain a
            // damaged document could make circular.
            guard += 1;
            if guard > 8 {
                break;
            }
            node = parents.get(&current).copied().flatten();
        }
    }
    rolled
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Name of the index of one game, the same on disk and inside the bundle.
pub fn file_name(game: Game) -> String {
    format!("index-{}.json", game.id())
}

/// Reads an index out of a text, saying why it is unusable.
pub fn parse_index(text: &str, game: Game) -> Result<CatalogIndex> {
    let index: CatalogIndex = serde_json::from_str(text)
        .map_err(|e| AppError::json("cannot parse a JKHub catalogue index", e))?;
    if index.version != INDEX_VERSION {
        return Err(AppError::InvalidInput(format!(
            "the JKHub index of {} is version {}, this build reads {INDEX_VERSION}",
            game.id(),
            index.version
        )));
    }
    if index.game != game {
        return Err(AppError::InvalidInput(format!(
            "the JKHub index of {} holds the catalogue of {}",
            game.id(),
            index.game.id()
        )));
    }
    if index.files.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "the JKHub index of {} holds no files",
            game.id()
        )));
    }
    Ok(index)
}

/// Reads an index out of a folder, whichever folder that is.
///
/// Every failure is a miss: a document of an older shape, a file the installer
/// dropped, a half-written one. The launcher then falls back to the bundle and,
/// failing that, crawls.
pub fn read_from(dir: &Path, game: Game) -> Option<CatalogIndex> {
    let file = dir.join(file_name(game));
    let text = std::fs::read_to_string(&file).ok()?;
    match parse_index(&text, game) {
        Ok(index) => Some(index),
        Err(e) => {
            log::warn!("jkhub: ignoring {}, {e}", file.display());
            None
        }
    }
}

/// Writes the index of one game into the cache folder.
pub fn store(data: &DataPaths, index: &CatalogIndex) -> Result<()> {
    let dir = cache::dir(data)?;
    let file = dir.join(file_name(index.game));
    let text = serde_json::to_string(index)
        .map_err(|e| AppError::json("cannot serialize the JKHub catalogue index", e))?;
    std::fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))?;
    log::info!(
        "jkhub: the {} index now holds {} files, {}",
        index.game.id(),
        index.files.len(),
        file.display()
    );
    Ok(())
}

/// The index of one game, from the cache or from the bundle.
pub fn load(data: &DataPaths, snapshots: Option<&PathBuf>, game: Game) -> Option<LoadedIndex> {
    if let Ok(dir) = cache::dir(data) {
        if let Some(index) = read_from(&dir, game) {
            return Some(LoadedIndex::new(index, IndexSource::Cache));
        }
    }
    let dir = snapshots?;
    read_from(dir, game).map(|index| LoadedIndex::new(index, IndexSource::Snapshot))
}

// ---------------------------------------------------------------------------
// Deciding what a refresh should cost
// ---------------------------------------------------------------------------

/// What a request to refresh one index should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshPlan {
    /// The index is current and nobody asked: spend nothing.
    Nothing,
    /// Read the front page and fill in what it names.
    Incremental,
    /// Crawl every listing page of every leaf category.
    Full,
}

/// Picks what a refresh of one game's index should cost.
///
/// Pure on purpose: the five ways this decision goes are the part of the
/// module worth a test, and none of them needs a disk or a network.
///
/// | State | Manual | Plan |
/// | --- | --- | --- |
/// | nothing indexed | either | full crawl |
/// | older than [`FULL_REBUILD_AFTER`] | either | full crawl |
/// | younger than [`AUTO_REFRESH_INTERVAL`] | no | nothing |
/// | younger than [`AUTO_REFRESH_INTERVAL`] | yes | incremental |
/// | in between | either | incremental |
///
/// `full` is the player asking for a crawl outright and wins over all of it.
pub fn plan(age: Option<u64>, manual: bool, full: bool) -> RefreshPlan {
    if full {
        return RefreshPlan::Full;
    }
    match age {
        None => RefreshPlan::Full,
        Some(age) if age >= FULL_REBUILD_AFTER => RefreshPlan::Full,
        Some(age) if age < AUTO_REFRESH_INTERVAL && !manual => RefreshPlan::Nothing,
        Some(_) => RefreshPlan::Incremental,
    }
}

/// Whether an incremental refresh has found too much to be the cheap path.
pub fn escalates(unknown: usize) -> bool {
    unknown > MAX_UNKNOWN
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Which half of the work a crawl is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexPhase {
    /// Reading the category tree the crawl needs before it can start.
    Categories,
    /// Reading the listing pages.
    Files,
    /// Reading the file pages the front page named.
    Details,
}

/// Payload of `jkhub:index-progress`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub game: Game,
    pub done: u32,
    /// Requests the crawl still expects to make, including the ones it made.
    /// An estimate: a category whose file count the tree never learned counts
    /// as one page until its first page says otherwise.
    pub total: u32,
    pub phase: IndexPhase,
}

/// Payload of `jkhub:index-updated`, and the answer of `jkhub_refresh_index`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexUpdate {
    pub game: Game,
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    /// Files in the index once the work finished.
    pub files: u32,
    /// Requests this refresh made to jkhub.org.
    pub requests: u32,
    /// True when the whole catalogue was crawled rather than topped up.
    pub full: bool,
    /// True when the plan was to do nothing: the index was current and nobody
    /// asked for a refresh.
    pub skipped: bool,
}

impl IndexUpdate {
    /// A refresh that decided to spend nothing.
    pub fn skipped(game: Game, files: u32) -> Self {
        IndexUpdate {
            game,
            added: 0,
            updated: 0,
            removed: 0,
            files,
            requests: 0,
            full: false,
            skipped: true,
        }
    }

    /// Whether anything about the catalogue actually changed.
    pub fn touched(&self) -> bool {
        self.added + self.updated + self.removed > 0
    }
}

/// Sends one progress event, and says nothing when the channel is gone.
fn progress(app: &AppHandle, game: Game, phase: IndexPhase, done: u32, total: u32) {
    if let Err(e) = app.emit(
        INDEX_PROGRESS_EVENT,
        IndexProgress {
            game,
            done,
            total,
            phase,
        },
    ) {
        log::debug!("cannot emit {INDEX_PROGRESS_EVENT}: {e}");
    }
}

// ---------------------------------------------------------------------------
// Building the index
// ---------------------------------------------------------------------------

/// Every listing page of every leaf category of one game.
///
/// The tree decides what to walk: a category with `has_files` is a leaf that
/// lists files, and a container such as `Maps` answers «No files in this
/// category yet.» and is skipped. `Both Games/Other` sits in both trees, so
/// its files land in both indexes — which is what the site means by the name.
///
/// Pages are read one at a time, ordered by `file_updated` descending, the
/// same address the tab opens. Nothing here goes through the page cache: the
/// index is the cache, and a hundred and fifty listing documents on disk would
/// be a second copy of it.
pub async fn crawl(
    client: &JkhubClient,
    game: Game,
    tree: &[JkhubCategory],
    requests: &mut u32,
    on_progress: &mut (dyn FnMut(u32, u32) + Send),
) -> Result<Vec<IndexedFile>> {
    let leaves: Vec<&JkhubCategory> = tree.iter().filter(|entry| entry.has_files).collect();
    let mut total = leaves
        .iter()
        .map(|leaf| estimated_pages(leaf.file_count))
        .sum::<u32>()
        .max(1);
    let mut done = 0;
    let mut files: Vec<IndexedFile> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();

    on_progress(done, total);
    for leaf in leaves {
        let mut expected = estimated_pages(leaf.file_count);
        let mut page = 1;
        loop {
            let url = source::listing_url(leaf.id, &leaf.slug, JkhubSort::RecentlyUpdated, page);
            let body = client.fetch_html(&url).await?;
            *requests += 1;
            let listing = parse::parse_listing(&body.body)?;
            for card in listing.cards {
                // A file listed twice — the site puts one under two categories
                // now and then — keeps the first category the crawl met it in.
                if seen.insert(card.id) {
                    files.push(IndexedFile::from_card(card, leaf.id, leaf.game));
                }
            }

            done += 1;
            // The estimate from the tree is replaced by what the site says the
            // moment it says it, so the count stops lying about a category
            // whose file count the tree never learned.
            let real = listing.pages.clamp(1, MAX_PAGES_PER_CATEGORY);
            total = (total + real).saturating_sub(expected);
            expected = real;
            on_progress(done, total.max(done));

            if page >= real {
                break;
            }
            page += 1;
        }
    }

    log::info!(
        "jkhub: crawled {} files of {} in {requests} request(s)",
        files.len(),
        game.id()
    );
    Ok(files)
}

/// Pages a category of this size takes, or one when the size is unknown.
fn estimated_pages(file_count: Option<u32>) -> u32 {
    file_count
        .map(|count| count.div_ceil(parse::PER_PAGE).clamp(1, MAX_PAGES_PER_CATEGORY))
        .unwrap_or(1)
}

/// The files the front page of `/files/` names, newest first.
///
/// The page carries four carousels and two custom blocks — «What's New»,
/// «Featured», «Highest Rated», «Most Downloaded», «Latest Jedi Academy Mods»,
/// «Latest Jedi Outcast Mods» — and every one of them links files by their
/// canonical address. The addresses are all this needs: the ids the index does
/// not know are the ones worth a request each.
pub fn front_page_files(html: &str) -> Vec<u32> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut rest = html;
    while let Some(at) = rest.find(MARKER) {
        rest = &rest[at..];
        // The address ends at the quote, the space or the tag that closes the
        // attribute it sits in. `find` answers a byte index on a character
        // boundary, and so does the end of the text, so both slices are safe.
        let end = rest.find(['\'', '"', ' ', '<']).unwrap_or(rest.len());
        if let Some((id, _)) = parse::file_ref(&rest[..end]) {
            if seen.insert(id) {
                ids.push(id);
            }
        }
        rest = &rest[end.max(MARKER.len())..];
    }
    ids
}

/// The path every file address of the site starts with.
const MARKER: &str = "/files/file/";

// ---------------------------------------------------------------------------
// Keeping the index current
// ---------------------------------------------------------------------------

/// Everything one refresh needs, gathered so the signature stays readable.
pub struct RefreshContext<'a> {
    pub app: &'a AppHandle,
    pub client: &'a JkhubClient,
    pub data: &'a DataPaths,
    /// Folder of the bundled indexes and category trees, when this build has
    /// one.
    pub snapshots: Option<PathBuf>,
    pub game: Game,
}

/// Brings the index of one game up to date, by whichever path is warranted.
///
/// `manual` is the player pressing **Refresh**: it ignores the once-a-day
/// floor but not the rules that make a crawl necessary. `full` is the player
/// asking for the crawl itself.
///
/// The answer says what changed and what it cost, and the same document goes
/// out as `jkhub:index-updated` so a screen that did not ask still hears
/// about it.
pub async fn run(context: &RefreshContext<'_>, manual: bool, full: bool) -> Result<IndexUpdate> {
    let RefreshContext {
        app,
        data,
        snapshots,
        game,
        ..
    } = context;
    let game = *game;

    let loaded = load(data, snapshots.as_ref(), game);
    let mut index = match loaded {
        Some(loaded) => loaded.index,
        None => CatalogIndex::new(game),
    };
    let age = if index.files.is_empty() {
        None
    } else {
        Some(index.age(timestamp::now_unix()))
    };

    let mut requests = 0;
    let plan = plan(age, manual, full);
    log::info!(
        "jkhub: the {} index is {} and the plan is {plan:?}",
        game.id(),
        age.map(|age| format!("{age} s old")).unwrap_or("missing".into())
    );

    let mut crawled = false;
    let report = match plan {
        RefreshPlan::Nothing => {
            return Ok(IndexUpdate::skipped(game, index.files.len() as u32));
        }
        RefreshPlan::Incremental => match top_up(context, &mut index, &mut requests).await? {
            Some(report) => report,
            // The front page named more than the cheap path is for, so the
            // refresh turns into the crawl it was trying to avoid.
            None => {
                crawled = true;
                rebuild(context, &mut index, &mut requests).await?
            }
        },
        RefreshPlan::Full => {
            crawled = true;
            rebuild(context, &mut index, &mut requests).await?
        }
    };

    if report.touched() {
        index.touch();
        store(data, &index)?;
    }
    let update = IndexUpdate {
        game,
        added: report.added,
        updated: report.updated,
        removed: report.removed,
        files: index.files.len() as u32,
        requests,
        full: crawled,
        skipped: false,
    };
    log::info!(
        "jkhub: the {} index took {requests} request(s): +{} ~{} -{}, {} files",
        game.id(),
        update.added,
        update.updated,
        update.removed,
        update.files
    );
    if let Err(e) = app.emit(INDEX_UPDATED_EVENT, update) {
        log::warn!("cannot emit {INDEX_UPDATED_EVENT}: {e}");
    }
    Ok(update)
}

/// Reads the front page and fills in the files the index does not know.
///
/// Answers `None` when the front page named more than [`MAX_UNKNOWN`] of them:
/// past that, one request per file is no longer the cheap path, and the index
/// is missing enough that a crawl is also the more complete one.
///
/// A file page that answers `404` takes its entry with it — that is the one
/// way the launcher ever learns a record was deleted.
async fn top_up(
    context: &RefreshContext<'_>,
    index: &mut CatalogIndex,
    requests: &mut u32,
) -> Result<Option<MergeReport>> {
    let source = HtmlSource::new(context.client, context.data);
    let page = context
        .client
        .fetch_html(&format!("{}/files/", parse::SITE))
        .await?;
    *requests += 1;

    let known = index.ids();
    let unknown: Vec<u32> = front_page_files(&page.body)
        .into_iter()
        .filter(|id| !known.contains(id))
        .collect();
    log::info!(
        "jkhub: the front page names {} file(s) the {} index does not know",
        unknown.len(),
        index.game.id()
    );
    if escalates(unknown.len()) {
        return Ok(None);
    }

    let total = unknown.len() as u32;
    let mut report = MergeReport::default();
    for (done, id) in unknown.into_iter().enumerate() {
        progress(context.app, index.game, IndexPhase::Details, done as u32, total);
        let view = source.file_opt(id).await?;
        *requests += 1;
        match view {
            Some(view) => {
                let entry = IndexedFile::from_file(&view.file, index.get(id));
                let one = index.upsert(entry);
                report.added += one.added;
                report.updated += one.updated;
            }
            None => report.removed += index.remove(id).removed,
        }
    }
    progress(context.app, index.game, IndexPhase::Details, total, total);
    Ok(Some(report))
}

/// Crawls every listing page of every leaf category of one game.
async fn rebuild(
    context: &RefreshContext<'_>,
    index: &mut CatalogIndex,
    requests: &mut u32,
) -> Result<MergeReport> {
    progress(context.app, index.game, IndexPhase::Categories, 0, 1);
    let source = HtmlSource::new(context.client, context.data)
        .with_snapshots(context.snapshots.clone());
    // The tree comes from the disk cache or from the bundle in the common
    // case; only a machine with neither pays for the twenty-request walk here,
    // and it would have paid for it when the tab opened anyway.
    let (tree, _) = source.categories_with_plan(index.game).await?;
    let game = index.game;
    let app = context.app;
    let files = crawl(
        context.client,
        game,
        &tree.categories,
        requests,
        &mut |done, total| progress(app, game, IndexPhase::Files, done, total),
    )
    .await?;
    if files.is_empty() {
        return Err(AppError::JkhubParse {
            what: format!("the {} catalogue crawled to nothing", index.game.id()),
        });
    }
    Ok(index.replace(files))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn file(id: u32, title: &str, category_id: u32) -> IndexedFile {
        IndexedFile {
            id,
            slug: title.to_lowercase().replace(' ', "-"),
            title: title.into(),
            author_name: Some("Author".into()),
            author_url: None,
            category_id,
            game: JkhubGame::Ja,
            thumbnail_url: None,
            description: String::new(),
            downloads: Some(10),
            submitted_at: Some("2026-01-01T00:00:00Z".into()),
            updated_at: Some("2026-01-01T00:00:00Z".into()),
            tags: Vec::new(),
        }
    }

    fn index(files: Vec<IndexedFile>) -> LoadedIndex {
        let mut catalogue = CatalogIndex::new(Game::JediAcademy);
        catalogue.files = files;
        LoadedIndex::new(catalogue, IndexSource::Cache)
    }

    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            query: query.into(),
            category_id: None,
            sort: JkhubSort::RecentlyUpdated,
            page: 1,
            per_page: RESULTS_PER_PAGE,
        }
    }

    #[test]
    fn a_query_is_split_on_whitespace_and_folded() {
        assert_eq!(tokenize("  Terminative   3 "), vec!["terminative", "3"]);
        assert_eq!(tokenize("mp/ffa3"), vec!["mp/ffa3"]);
        assert!(tokenize("   ").is_empty());
    }

    #[test]
    fn the_diacritics_of_the_latin_alphabet_are_folded_away() {
        assert_eq!(fold("Sébastien"), "sebastien");
        assert_eq!(fold("Łukasz"), "lukasz");
        assert_eq!(fold("Ærø"), "aero");
        assert_eq!(fold("Größe"), "grosse");
        assert_eq!(fold("Škoda ŽIŽKA"), "skoda zizka");
        assert_eq!(fold("Ĳsselmeer"), "ijsselmeer");
        // Outside the Latin blocks nothing is invented, only lowercased.
        assert_eq!(fold("ДУЭЛЬ"), "дуэль");
        assert_eq!(fold("MP/FFA3"), "mp/ffa3");
    }

    #[test]
    fn a_title_match_outranks_an_author_match_which_outranks_a_description() {
        let mut by_title = file(1, "Terminative 3 Home", 15);
        by_title.author_name = Some("Someone".into());
        let mut by_tag = file(2, "Another Map", 13);
        by_tag.tags = vec!["terminative".into()];
        let mut by_description = file(3, "Third Map", 13);
        by_description.description = "a remake of terminative".into();

        let loaded = index(vec![by_description, by_tag, by_title]);
        let found = loaded.search(&request("terminative"));
        assert_eq!(found.total, 3);
        let ids: Vec<u32> = found.cards.iter().map(|card| card.id).collect();
        assert_eq!(ids, vec![1, 2, 3], "title, then tag, then description");
    }

    #[test]
    fn every_token_has_to_match_somewhere() {
        let mut map = file(1, "Terminative 3 Home", 15);
        map.tags = vec!["ffa".into()];
        let loaded = index(vec![map]);

        assert_eq!(loaded.search(&request("terminative home")).total, 1);
        assert_eq!(loaded.search(&request("terminative ffa")).total, 1);
        assert_eq!(loaded.search(&request("terminative duel")).total, 0);
        // A substring is a match: the player types half a word and expects it.
        assert_eq!(loaded.search(&request("termin")).total, 1);
        // An empty query is the whole catalogue, not an empty answer.
        assert_eq!(loaded.search(&request("   ")).total, 1);
    }

    #[test]
    fn a_search_counts_every_category_and_narrows_to_one() {
        let mut mixed = file(1, "Terminative 3 Home", 15);
        mixed.updated_at = Some("2026-05-01T00:00:00Z".into());
        let ffa = file(2, "Terminative Arena", 13);
        let other = file(3, "Duel Yard", 28);
        let loaded = index(vec![mixed, ffa, other]);

        let all = loaded.search(&request("terminative"));
        assert_eq!(all.total, 2);
        assert_eq!(all.category_counts.get(&15), Some(&1));
        assert_eq!(all.category_counts.get(&13), Some(&1));
        assert_eq!(all.category_counts.get(&28), None, "no match, no count");

        // Narrowing keeps the counts of the other categories: the tree has to
        // keep showing where else the query has answers.
        let narrowed = loaded.search(&SearchRequest {
            category_id: Some(13),
            ..request("terminative")
        });
        assert_eq!(narrowed.total, 1);
        assert_eq!(narrowed.cards[0].id, 2);
        assert_eq!(narrowed.category_counts.get(&15), Some(&1));
    }

    #[test]
    fn counts_climb_the_tree_so_a_container_shows_what_is_under_it() {
        let tree = vec![
            JkhubCategory {
                id: 41,
                slug: "jedi-academy".into(),
                name: "Jedi Academy".into(),
                parent_id: None,
                game: JkhubGame::Ja,
                file_count: None,
                has_files: false,
                url: String::new(),
            },
            JkhubCategory {
                id: 71,
                slug: "maps".into(),
                name: "Maps".into(),
                parent_id: Some(41),
                game: JkhubGame::Ja,
                file_count: None,
                has_files: false,
                url: String::new(),
            },
            JkhubCategory {
                id: 13,
                slug: "free-for-all".into(),
                name: "Free For All".into(),
                parent_id: Some(71),
                game: JkhubGame::Ja,
                file_count: None,
                has_files: true,
                url: String::new(),
            },
            JkhubCategory {
                id: 15,
                slug: "mixed-gametypes".into(),
                name: "Mixed Gametypes".into(),
                parent_id: Some(71),
                game: JkhubGame::Ja,
                file_count: None,
                has_files: true,
                url: String::new(),
            },
        ];
        let counts = BTreeMap::from([(13, 2), (15, 3)]);
        let rolled = roll_up(&counts, &tree);
        assert_eq!(rolled.get(&13), Some(&2));
        assert_eq!(rolled.get(&15), Some(&3));
        assert_eq!(rolled.get(&71), Some(&5), "Maps holds both of its children");
        assert_eq!(rolled.get(&41), Some(&5));
    }

    #[test]
    fn the_selected_order_breaks_the_ties_inside_one_rank() {
        let mut old = file(1, "Alpha Map", 13);
        old.updated_at = Some("2020-01-01T00:00:00Z".into());
        old.downloads = Some(900);
        let mut fresh = file(2, "Beta Map", 13);
        fresh.updated_at = Some("2026-09-01T00:00:00Z".into());
        fresh.downloads = Some(5);
        let loaded = index(vec![old, fresh]);

        let by_date = loaded.search(&request("map"));
        assert_eq!(by_date.cards[0].id, 2, "recently updated first");

        let by_downloads = loaded.search(&SearchRequest {
            sort: JkhubSort::MostDownloaded,
            ..request("map")
        });
        assert_eq!(by_downloads.cards[0].id, 1);

        let by_name = loaded.search(&SearchRequest {
            sort: JkhubSort::Name,
            ..request("map")
        });
        assert_eq!(by_name.cards[0].id, 1, "Alpha before Beta");
    }

    #[test]
    fn results_are_paged_and_the_page_size_is_capped() {
        let files: Vec<IndexedFile> = (1..=60).map(|id| file(id, "Map", 13)).collect();
        let loaded = index(files);

        let first = loaded.search(&request(""));
        assert_eq!(first.total, 60);
        assert_eq!(first.cards.len(), RESULTS_PER_PAGE as usize);
        assert_eq!(first.pages, 3);

        let third = loaded.search(&SearchRequest {
            page: 3,
            ..request("")
        });
        assert_eq!(third.cards.len(), 10);

        // A caller that asks for everything gets the ceiling, which is what
        // keeps the grid from pulling a thousand thumbnails off jkhub.org.
        let greedy = loaded.search(&SearchRequest {
            per_page: 10_000,
            ..request("")
        });
        assert_eq!(greedy.per_page, MAX_RESULTS_PER_PAGE);
        assert_eq!(greedy.cards.len(), 60, "and no more than the catalogue holds");
        assert_eq!(greedy.pages, 1);
    }

    #[test]
    fn an_index_takes_files_in_and_lets_a_missing_one_go() {
        let mut catalogue = CatalogIndex::new(Game::JediAcademy);
        assert_eq!(catalogue.upsert(file(1, "One", 13)).added, 1);
        assert_eq!(catalogue.upsert(file(2, "Two", 13)).added, 1);
        assert_eq!(catalogue.files.len(), 2);

        // The same document twice is not a change.
        assert_eq!(catalogue.upsert(file(1, "One", 13)), MergeReport::default());

        let mut renamed = file(1, "One", 13);
        renamed.title = "One and a half".into();
        assert_eq!(catalogue.upsert(renamed).updated, 1);
        assert_eq!(catalogue.get(1).unwrap().title, "One and a half");

        // A file page that answers 404 takes its entry with it.
        assert_eq!(catalogue.remove(2).removed, 1);
        assert_eq!(catalogue.remove(2).removed, 0, "and a second call is calm");
        assert_eq!(catalogue.ids(), HashSet::from([1]));
    }

    #[test]
    fn a_crawl_replaces_the_catalogue_and_counts_what_the_site_dropped() {
        let mut catalogue = CatalogIndex::new(Game::JediAcademy);
        catalogue.replace(vec![file(1, "One", 13), file(2, "Two", 13)]);

        let mut changed = file(1, "One", 13);
        changed.downloads = Some(4000);
        let report = catalogue.replace(vec![changed, file(3, "Three", 13)]);
        assert_eq!(report.added, 1, "3 is new");
        assert_eq!(report.updated, 1, "1 has a new counter");
        assert_eq!(report.removed, 1, "2 is gone from the site");
        assert!(report.touched());
        assert!(!MergeReport::default().touched());
    }

    #[test]
    fn the_refresh_decision_covers_every_state_of_the_index() {
        let day = AUTO_REFRESH_INTERVAL;
        let week = FULL_REBUILD_AFTER;

        // Nothing indexed: only a crawl produces one.
        assert_eq!(plan(None, false, false), RefreshPlan::Full);
        assert_eq!(plan(None, true, false), RefreshPlan::Full);

        // Fresh: the automatic path spends nothing, the player's does not.
        assert_eq!(plan(Some(60), false, false), RefreshPlan::Nothing);
        assert_eq!(plan(Some(60), true, false), RefreshPlan::Incremental);
        assert_eq!(plan(Some(day - 1), false, false), RefreshPlan::Nothing);

        // A day old: the front page is read behind the answer.
        assert_eq!(plan(Some(day), false, false), RefreshPlan::Incremental);
        assert_eq!(plan(Some(week - 1), false, false), RefreshPlan::Incremental);

        // A week old: the front page cannot tell what was re-uploaded, so the
        // whole catalogue is read again.
        assert_eq!(plan(Some(week), false, false), RefreshPlan::Full);
        assert_eq!(plan(Some(week * 4), true, false), RefreshPlan::Full);

        // `full` is the player asking outright.
        for age in [None, Some(0), Some(day), Some(week)] {
            assert_eq!(plan(age, false, true), RefreshPlan::Full, "age {age:?}");
        }

        // And the front page escalates on its own when it names too much.
        assert!(!escalates(0));
        assert!(!escalates(MAX_UNKNOWN));
        assert!(escalates(MAX_UNKNOWN + 1));
    }

    #[test]
    fn a_stored_index_survives_a_write_and_a_read() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let data = DataPaths::new(dir.path().to_path_buf());
        data.ensure().expect("the layout is created");

        let mut catalogue = CatalogIndex::new(Game::JediAcademy);
        catalogue.replace(vec![file(1, "One", 13)]);
        store(&data, &catalogue).expect("it writes");

        let cache_dir = cache::dir(&data).expect("the cache folder");
        let back = read_from(&cache_dir, Game::JediAcademy).expect("it is there");
        assert_eq!(back, catalogue);
        assert!(
            read_from(&cache_dir, Game::JediOutcast).is_none(),
            "the other game has no document here"
        );

        let loaded = load(&data, None, Game::JediAcademy).expect("it loads");
        assert_eq!(loaded.source, IndexSource::Cache);
        assert_eq!(loaded.index.files.len(), 1);
    }

    #[test]
    fn an_index_of_the_wrong_version_game_or_shape_is_refused() {
        let mut catalogue = CatalogIndex::new(Game::JediOutcast);
        catalogue.replace(vec![file(1, "One", 13)]);
        let text = serde_json::to_string(&catalogue).expect("it serializes");
        let error = parse_index(&text, Game::JediAcademy).expect_err("the games disagree");
        assert!(error.to_string().contains("holds the catalogue of"), "{error}");

        catalogue.version = INDEX_VERSION + 1;
        let text = serde_json::to_string(&catalogue).expect("it serializes");
        let error = parse_index(&text, Game::JediOutcast).expect_err("the shapes disagree");
        assert!(error.to_string().contains("this build reads"), "{error}");

        catalogue.version = INDEX_VERSION;
        catalogue.files.clear();
        let text = serde_json::to_string(&catalogue).expect("it serializes");
        assert!(parse_index(&text, Game::JediOutcast).is_err(), "an empty index is no index");
        assert!(parse_index("{", Game::JediOutcast).is_err());
    }

    #[test]
    fn a_bundled_index_answers_when_the_cache_holds_nothing() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let data = DataPaths::new(dir.path().to_path_buf());
        data.ensure().expect("the layout is created");
        let bundle = dir.path().join("resources").join("jkhub");
        std::fs::create_dir_all(&bundle).expect("the folder exists");

        let mut catalogue = CatalogIndex::new(Game::JediOutcast);
        catalogue.replace(vec![file(1, "One", 56)]);
        std::fs::write(
            bundle.join(file_name(Game::JediOutcast)),
            serde_json::to_string(&catalogue).expect("it serializes"),
        )
        .expect("it writes");

        let loaded = load(&data, Some(&bundle), Game::JediOutcast).expect("the bundle answers");
        assert_eq!(loaded.source, IndexSource::Snapshot);
        assert_eq!(loaded.index.files.len(), 1);
        assert!(load(&data, Some(&bundle), Game::JediAcademy).is_none());
    }

    #[test]
    fn the_file_name_carries_the_game() {
        assert_eq!(file_name(Game::JediAcademy), "index-ja.json");
        assert_eq!(file_name(Game::JediOutcast), "index-jo.json");
    }

    #[test]
    fn a_card_turns_into_an_entry_and_back() {
        let card = JkhubCard {
            id: 4283,
            slug: "terminative-3-home".into(),
            title: "Terminative 3 Home".into(),
            url: "https://jkhub.org/files/file/4283-terminative-3-home/".into(),
            category_id: None,
            author: Some(JkhubAuthor {
                name: "Szico VII".into(),
                url: Some("https://jkhub.org/profile/1-szico/".into()),
                avatar_url: None,
            }),
            thumbnail_url: Some("https://jkhub.org/screenshots/x.jpg".into()),
            description: "a".repeat(MAX_DESCRIPTION + 40),
            downloads: Some(1234),
            date: Some("2026-09-02T14:15:36Z".into()),
            date_label: Some("Updated".into()),
            tags: vec!["ffa".into()],
            rating: None,
        };

        let entry = IndexedFile::from_card(card, 15, JkhubGame::Ja);
        assert_eq!(entry.category_id, 15);
        assert_eq!(entry.updated_at.as_deref(), Some("2026-09-02T14:15:36Z"));
        assert_eq!(entry.submitted_at, None, "the card printed only one date");
        assert_eq!(
            entry.description.chars().count(),
            MAX_DESCRIPTION,
            "the description is cut, not stored whole"
        );

        let back = entry.to_card();
        assert_eq!(back.id, 4283);
        assert_eq!(back.url, "https://jkhub.org/files/file/4283-terminative-3-home/");
        assert_eq!(back.author.as_ref().map(|a| a.name.as_str()), Some("Szico VII"));
        assert_eq!(back.date_label.as_deref(), Some("Updated"));
        assert_eq!(back.rating, None, "listing cards carry no stars");
    }

    #[test]
    fn a_card_that_was_never_updated_carries_both_dates() {
        let card = JkhubCard {
            id: 1,
            slug: "x".into(),
            title: "X".into(),
            url: String::new(),
            category_id: None,
            author: None,
            thumbnail_url: None,
            description: String::new(),
            downloads: None,
            date: Some("2026-07-28T00:10:46Z".into()),
            date_label: Some("Submitted".into()),
            tags: Vec::new(),
            rating: None,
        };
        let entry = IndexedFile::from_card(card, 13, JkhubGame::Ja);
        assert_eq!(entry.submitted_at.as_deref(), Some("2026-07-28T00:10:46Z"));
        assert_eq!(
            entry.updated_at.as_deref(),
            Some("2026-07-28T00:10:46Z"),
            "the listing is ordered by file_updated, so this is that date too"
        );
    }

    #[test]
    fn a_file_page_fills_in_what_a_card_could_not_and_keeps_the_thumbnail() {
        let previous = file(4234, "Saito Hajime", 67);
        let mut kept = previous.clone();
        kept.thumbnail_url = Some("https://jkhub.org/screenshots/thumb.jpg".into());

        let page = super::super::types::JkhubFile {
            id: 4234,
            slug: "saitohajime".into(),
            title: "Saito Hajime".into(),
            url: "https://jkhub.org/files/file/4234-saitohajime/".into(),
            game: JkhubGame::Jo,
            category_id: Some(67),
            category_name: Some("Skins".into()),
            author: None,
            description: "A skin".into(),
            submitted_at: Some("2020-01-01T00:00:00Z".into()),
            updated_at: Some("2021-02-02T00:00:00Z".into()),
            version: Some("1.0".into()),
            views: 0,
            downloads: 77,
            comments: 0,
            reviews: 0,
            rating: None,
            screenshots: Vec::new(),
            tags: vec!["skin".into()],
            changelog: Vec::new(),
        };

        let entry = IndexedFile::from_file(&page, Some(&kept));
        assert_eq!(entry.submitted_at.as_deref(), Some("2020-01-01T00:00:00Z"));
        assert_eq!(entry.updated_at.as_deref(), Some("2021-02-02T00:00:00Z"));
        assert_eq!(entry.downloads, Some(77));
        assert_eq!(
            entry.thumbnail_url.as_deref(),
            Some("https://jkhub.org/screenshots/thumb.jpg"),
            "a page without screenshots must not blank the card's picture"
        );

        // With nothing remembered, a page with no screenshots has no picture.
        let fresh = IndexedFile::from_file(&page, None);
        assert_eq!(fresh.thumbnail_url, None);
        assert_eq!(fresh.category_id, 67);
    }

    #[test]
    fn the_front_page_names_the_files_it_links() {
        const HOME: &str = include_str!("../../tests/fixtures/jkhub/files-home.html");
        let ids = front_page_files(HOME);
        assert!(
            ids.len() >= 50,
            "the four carousels and the two blocks name dozens of files: {}",
            ids.len()
        );
        assert_eq!(
            ids.len(),
            ids.iter().collect::<HashSet<_>>().len(),
            "a file linked twice is named once"
        );
        assert!(ids.contains(&4559), "the newest file of the sample");
        assert!(ids.iter().all(|id| *id > 0));
    }

    #[test]
    fn a_page_estimate_never_promises_less_than_one_request() {
        assert_eq!(estimated_pages(None), 1);
        assert_eq!(estimated_pages(Some(0)), 1);
        assert_eq!(estimated_pages(Some(25)), 1);
        assert_eq!(estimated_pages(Some(26)), 2);
        assert_eq!(estimated_pages(Some(367)), 15);
        assert_eq!(estimated_pages(Some(100_000)), MAX_PAGES_PER_CATEGORY);
    }

    /// Rewrites `resources/jkhub/index-*.json` from the live site.
    ///
    /// Ignored by default: a test suite must not crawl another project's site.
    /// Run it before a release with `scripts/refresh-jkhub-index.ps1`, and run
    /// `scripts/refresh-jkhub-categories.ps1` first — the crawl reads the
    /// bundled tree to know which categories exist, so a stale tree ships a
    /// catalogue that is missing whatever category the site added since.
    ///
    /// The crawl costs one request per listing page, paced at one every
    /// 300 ms by the launcher's own limiter: about 150 for Jedi Academy and
    /// about 35 for Jedi Outcast.
    #[test]
    #[ignore = "talks to jkhub.org"]
    fn live_rebuild_the_bundled_indexes() {
        use std::time::Instant;

        let client = JkhubClient::new().expect("a client");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime");
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(super::super::snapshot::RESOURCE_DIR);
        std::fs::create_dir_all(&dir).expect("the folder exists");

        for game in Game::ALL {
            let tree = super::super::snapshot::read(&dir, game)
                .unwrap_or_else(|| panic!("{} ships a category tree", game.id()))
                .categories;
            let started = Instant::now();
            let mut requests = 0;
            let files = runtime
                .block_on(crawl(&client, game, &tree, &mut requests, &mut |done, total| {
                    if done % 10 == 0 {
                        println!("live: {} page {done} of {total}", game.id());
                    }
                }))
                .unwrap_or_else(|e| panic!("the {} catalogue crawls: {e}", game.id()));

            let mut index = CatalogIndex::new(game);
            index.replace(files);
            let file = dir.join(file_name(game));
            let text = serde_json::to_string(&index).expect("it serializes");
            std::fs::write(&file, format!("{text}\n")).expect("it writes");
            println!(
                "live: {} holds {} files, {} bytes, {requests} request(s), {:.1} s",
                file.display(),
                index.files.len(),
                text.len() + 1,
                started.elapsed().as_secs_f32()
            );
        }
    }

    /// The report this whole module answers: a file of one category was not
    /// findable while browsing another, although jkhub.org's own search found
    /// it.
    ///
    /// Runs on the catalogue the build ships, and names no file of it: the
    /// site deletes records, and a test that knows one by id fails the day it
    /// goes.
    #[test]
    fn a_file_of_another_category_is_found_while_browsing_this_one() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(super::super::snapshot::RESOURCE_DIR);
        let catalogue = read_from(&dir, Game::JediAcademy).expect("the build ships an index");
        let loaded = LoadedIndex::new(catalogue, IndexSource::Snapshot);

        let target = loaded.index.files[0].clone();
        let elsewhere = loaded
            .index
            .files
            .iter()
            .map(|entry| entry.category_id)
            .find(|id| *id != target.category_id)
            .expect("the catalogue spans more than one category");

        // Browsing the wrong category, the way the report described it.
        let narrowed = loaded.search(&SearchRequest {
            category_id: Some(elsewhere),
            ..request(&target.title)
        });
        assert!(
            narrowed.category_counts.contains_key(&target.category_id),
            "the tree has to say which category the answer is in"
        );

        // And with the category cleared, the file itself.
        let everywhere = loaded.search(&request(&target.title));
        assert!(
            everywhere.cards.iter().any(|card| card.id == target.id),
            "{} was not found by its own title",
            target.title
        );
        assert_eq!(
            everywhere.cards[0].category_id,
            Some(target.category_id),
            "a card of a search says which category it came out of"
        );
    }

    /// The documents the build ships, as the installer will carry them.
    #[test]
    fn the_bundled_indexes_parse_and_name_their_own_game() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(super::super::snapshot::RESOURCE_DIR);
        for game in Game::ALL {
            let index = read_from(&dir, game)
                .unwrap_or_else(|| panic!("{} ships an index", file_name(game)));
            assert_eq!(index.game, game);
            assert_eq!(index.version, INDEX_VERSION);
            assert!(!index.built_at.is_empty());
            assert!(
                index.files.len() >= 200,
                "{}: {} files is not a catalogue",
                file_name(game),
                index.files.len()
            );
            assert!(
                index.files.iter().all(|entry| entry.game.matches(game)),
                "{}: a shelf of the other game leaked in",
                file_name(game)
            );
            assert!(
                index.files.iter().all(|entry| entry.category_id > 0),
                "{}: a file without a category cannot be found by narrowing",
                file_name(game)
            );
            assert!(
                index
                    .files
                    .iter()
                    .all(|entry| entry.description.chars().count() <= MAX_DESCRIPTION),
                "{}: a description escaped the cut",
                file_name(game)
            );
        }
    }
}
