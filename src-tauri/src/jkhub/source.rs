//! Where the catalogue comes from.
//!
//! JKHub runs Invision Community, whose REST API is closed to guests: every
//! call answers `401 NO_API_KEY`, `core/hello` included (report, section 5).
//! The launcher therefore reads the same HTML a visitor reads, and the
//! [`JkhubSource`] trait exists so that a REST reader can take over without
//! the commands or the screens noticing. [`RestSource`] is the placeholder
//! for that day; it holds no key and answers that it is not configured.
//!
//! [`HtmlSource`] owns the whole HTML path: the requests, the cache and the
//! parsers. Nothing above it knows what a `csrfKey` is.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use crate::error::{AppError, Result};
use crate::game::Game;
use crate::paths::DataPaths;

use super::cache;
use super::client::{JkhubClient, Page};
use super::parse;
use super::sections;
use super::snapshot;
use super::types::{
    JkhubCategories, JkhubCategory, JkhubFile, JkhubFileView, JkhubListing, JkhubSort,
};

/// Reading the JKHub catalogue, however it arrives.
///
/// `async fn` in a trait is stable since Rust 1.75; the futures are used
/// inside this crate only, so the missing `Send` bound that comes with it is
/// not a problem — the commands await them directly.
#[allow(async_fn_in_trait)]
pub trait JkhubSource {
    /// The category tree of one game, roots first.
    ///
    /// Nothing calls it today: `jkhub_categories` wants the plan alongside the
    /// tree and goes through [`HtmlSource::categories_with_plan`]. It stays in
    /// the trait because it is the action the seam is about — a REST reader
    /// answers it in one request and needs no plan at all — and because
    /// deleting it would leave the trait describing three of the four things
    /// a reader does.
    #[allow(dead_code)]
    async fn categories(&self, game: Game) -> Result<JkhubCategories>;

    /// One page of one category.
    ///
    /// `game` names the tree the category's slug is looked up in; the page
    /// itself is addressed by id, so a category of the other game still
    /// answers.
    async fn list(
        &self,
        game: Game,
        category_id: u32,
        sort: JkhubSort,
        page: u32,
    ) -> Result<JkhubListing>;

    /// One file page.
    async fn file(&self, id: u32) -> Result<JkhubFileView>;
}

/// What a request for the category tree should cost.
///
/// The tree changes a few times a year and takes about twenty requests to
/// walk, so the reader never makes the screen wait for one when it has
/// anything else to show. Everything but [`TreeDecision::ServeFresh`] and a
/// forced walk is followed by a refresh behind the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeDecision {
    /// The disk cache is inside its lifetime: answer from it and ask nothing.
    ServeFresh,
    /// The disk cache is past its lifetime: answer from it, walk behind it.
    ServeStale,
    /// Nothing on disk: answer from the bundled snapshot, walk behind it.
    ServeSnapshot,
    /// Nothing on disk and no snapshot, or the caller forced a walk: walk
    /// before answering.
    CrawlNow,
}

impl TreeDecision {
    /// Whether the answer needs a walk behind it.
    pub fn wants_refresh(self) -> bool {
        matches!(self, TreeDecision::ServeStale | TreeDecision::ServeSnapshot)
    }
}

/// Picks what to do about a request for the tree of one game.
///
/// Pure on purpose: the four ways a tree can arrive are the part of this
/// module worth a test, and none of them needs a disk or a network.
///
/// `cached` is `Some(true)` for a cache entry inside its lifetime,
/// `Some(false)` for one past it and `None` when there is no entry at all.
pub fn decide(cached: Option<bool>, has_snapshot: bool, force: bool) -> TreeDecision {
    if force {
        return TreeDecision::CrawlNow;
    }
    match cached {
        Some(true) => TreeDecision::ServeFresh,
        Some(false) => TreeDecision::ServeStale,
        None if has_snapshot => TreeDecision::ServeSnapshot,
        None => TreeDecision::CrawlNow,
    }
}

/// Writes a walked tree into the disk cache and answers when it was written.
pub fn store_tree(data: &DataPaths, game: Game, tree: &[JkhubCategory]) -> String {
    let name = cache::categories_name(game.id());
    cache::write(data, &name, &tree, cache::CATEGORIES_TTL)
}

/// The tree of one game without asking the site for anything.
///
/// The disk cache first, the bundled snapshot after it, and an empty tree when
/// neither is there. Used by the searches that only need to know which
/// category an id belongs to, and by nothing that would rather wait for a
/// current answer.
pub fn tree_at_hand(
    data: &DataPaths,
    snapshots: Option<&PathBuf>,
    game: Game,
) -> Vec<JkhubCategory> {
    let name = cache::categories_name(game.id());
    let tree = match cache::read::<Vec<JkhubCategory>>(data, &name) {
        Some(entry) => entry.payload,
        None => snapshots
            .and_then(|dir| snapshot::read(dir, game))
            .map(|snapshot| snapshot.categories)
            .unwrap_or_default(),
    };
    sections::prune(game, tree)
}

/// Address of one page of one category listing.
///
/// The page number is part of the path and the sort is a query parameter: the
/// site accepts no `perPage`, which is fixed at 25 by the theme (report,
/// section 3).
///
/// A free function because the crawl behind the catalogue index builds the
/// same addresses without going through the page cache a reader would.
pub fn listing_url(category_id: u32, slug: &str, sort: JkhubSort, page: u32) -> String {
    let (by, direction) = sort.query();
    let base = parse::category_url(category_id, slug);
    let path = if page > 1 {
        format!("{base}page/{page}/")
    } else {
        base
    };
    format!("{path}?sortby={by}&sortdirection={direction}")
}

/// The reader that parses the public pages of jkhub.org.
pub struct HtmlSource<'a> {
    pub client: &'a JkhubClient,
    pub data: &'a DataPaths,
    /// True when the caller pressed **Update categories**: walk the tree even
    /// if the cached copy is still fresh.
    pub force: bool,
    /// Folder of the bundled category snapshots, when this build has one.
    pub snapshots: Option<PathBuf>,
}

impl<'a> HtmlSource<'a> {
    pub fn new(client: &'a JkhubClient, data: &'a DataPaths) -> Self {
        HtmlSource {
            client,
            data,
            force: false,
            snapshots: None,
        }
    }

    /// The same reader, told to ignore a fresh cache entry.
    pub fn forced(mut self, force: bool) -> Self {
        self.force = force;
        self
    }

    /// The same reader, told where the bundled snapshots live.
    pub fn with_snapshots(mut self, dir: Option<PathBuf>) -> Self {
        self.snapshots = dir;
        self
    }

    /// The tree of one game, plus whether a walk should follow the answer.
    ///
    /// The flag is answered rather than acted on: starting a background task
    /// needs an `AppHandle`, and this module has no business holding one. The
    /// command in `mod.rs` owns that half.
    ///
    /// --- slice: jkhub catalog ---
    /// The answer is pruned to [`sections::SECTIONS`] whichever of the four
    /// ways it arrived. A disk cache written before the sections existed, or
    /// a bundled snapshot of an older build, holds the whole site tree and
    /// lives for a week; pruning here rather than at the walk is what keeps
    /// either from widening the tab back out.
    pub async fn categories_with_plan(&self, game: Game) -> Result<(JkhubCategories, bool)> {
        let (mut answer, wants_refresh) = self.tree_from_anywhere(game).await?;
        answer.categories = sections::prune(game, answer.categories);
        Ok((answer, wants_refresh))
    }

    /// The tree of one game from the cache, the snapshot or the site, exactly
    /// as that source had it.
    async fn tree_from_anywhere(&self, game: Game) -> Result<(JkhubCategories, bool)> {
        let name = cache::categories_name(game.id());
        let cached = cache::read::<Vec<JkhubCategory>>(self.data, &name);
        // Read only when it could be used: the common path has a cache entry,
        // and opening a file the answer would throw away is wasted work.
        let snapshot = match (&cached, self.force, &self.snapshots) {
            (None, false, Some(dir)) => snapshot::read(dir, game),
            _ => None,
        };

        let decision = decide(
            cached.as_ref().map(|entry| entry.fresh),
            snapshot.is_some(),
            self.force,
        );
        match decision {
            TreeDecision::ServeFresh | TreeDecision::ServeStale => {
                if let Some(entry) = cached {
                    let stale = decision == TreeDecision::ServeStale;
                    return Ok((
                        JkhubCategories {
                            game,
                            categories: entry.payload,
                            fetched_at: entry.fetched_at,
                            stale,
                        },
                        decision.wants_refresh(),
                    ));
                }
            }
            TreeDecision::ServeSnapshot => {
                if let Some(snapshot) = snapshot {
                    log::info!(
                        "jkhub: serving the bundled {} tree of {}, walking behind it",
                        game.id(),
                        snapshot.generated_at
                    );
                    return Ok((
                        JkhubCategories {
                            game,
                            categories: snapshot.categories,
                            fetched_at: snapshot.generated_at,
                            // Dated by definition: it is as old as the build.
                            stale: true,
                        },
                        true,
                    ));
                }
            }
            TreeDecision::CrawlNow => {}
        }

        match crawl_tree(self.client, game).await {
            Ok(tree) => {
                let fetched_at = store_tree(self.data, game, &tree);
                Ok((
                    JkhubCategories {
                        game,
                        categories: tree,
                        fetched_at,
                        stale: false,
                    },
                    false,
                ))
            }
            // The tree is expensive to rebuild and changes a few times a
            // year: an old copy beats an empty screen.
            Err(e) => match cache::read::<Vec<JkhubCategory>>(self.data, &name) {
                Some(entry) => {
                    log::warn!("jkhub: serving the stale category tree, {e}");
                    Ok((
                        JkhubCategories {
                            game,
                            categories: entry.payload,
                            fetched_at: entry.fetched_at,
                            stale: true,
                        },
                        false,
                    ))
                }
                None => Err(e),
            },
        }
    }

    /// Address of one page of one category listing.
    fn listing_url(&self, category_id: u32, slug: &str, sort: JkhubSort, page: u32) -> String {
        listing_url(category_id, slug, sort, page)
    }

    /// One file page, answering `None` when the site says the record is gone.
    ///
    /// The whole of [`JkhubSource::file`] lives here, because the difference
    /// between «no such file» and «the site is down» matters to exactly one
    /// caller — the catalogue index, which drops an entry for the first and
    /// keeps it for the second — and to nobody else.
    ///
    /// A `404` is never served from the cache and never cached itself: the
    /// stale copy of a deleted file is what the index is about to throw away.
    pub async fn file_opt(&self, id: u32) -> Result<Option<JkhubFileView>> {
        let name = cache::file_name(id);
        let cached = cache::read::<JkhubFile>(self.data, &name);
        if let Some(entry) = &cached {
            if entry.fresh && !self.force {
                return Ok(Some(JkhubFileView {
                    file: entry.payload.clone(),
                    fetched_at: entry.fetched_at.clone(),
                    stale: false,
                }));
            }
        }

        // The slug is cosmetic in the address: an id alone redirects to the
        // canonical page, and the parser reads the real slug back out of the
        // JSON-LD `url`.
        let url = parse::file_url(id, "");
        match self.client.fetch_html_opt(&url).await {
            Ok(Some(page)) => {
                let slug = parse::file_ref(&page.url)
                    .map(|(_, slug)| slug)
                    .unwrap_or_default();
                let file = parse::parse_file_page(&page.body, id, &slug)?;
                let ttl = cache::ttl_from(page.max_age, cache::PAGE_TTL);
                let fetched_at = cache::write(self.data, &name, &file, ttl);
                Ok(Some(JkhubFileView {
                    file,
                    fetched_at,
                    stale: false,
                }))
            }
            Ok(None) => Ok(None),
            Err(e) => match cached {
                Some(entry) => {
                    log::warn!("jkhub: serving a stale card for {id}, {e}");
                    Ok(Some(JkhubFileView {
                        file: entry.payload,
                        fetched_at: entry.fetched_at,
                        stale: true,
                    }))
                }
                None => Err(e),
            },
        }
    }

    /// Slug of a category, taken from any cached tree that names it.
    ///
    /// The site redirects `/files/category/{id}-{wrong-slug}/` to the right
    /// address, so a stale slug costs one redirect and never a wrong page —
    /// which is why an unknown category is asked for with an empty slug
    /// rather than refused.
    ///
    /// The tree of `game` is read first because that is the one the screen
    /// asking for the listing is showing; the other game's tree is a fallback
    /// for a category opened from a file page.
    fn slug_of(&self, game: Game, category_id: u32) -> String {
        let others = Game::ALL.into_iter().filter(|entry| *entry != game);
        for game in std::iter::once(game).chain(others) {
            let name = cache::categories_name(game.id());
            let Some(cached) = cache::read::<Vec<JkhubCategory>>(self.data, &name) else {
                continue;
            };
            if let Some(found) = cached.payload.iter().find(|entry| entry.id == category_id) {
                return found.slug.clone();
            }
        }
        String::new()
    }

}

/// Walks the tree of one game, one page per direct child of a root.
///
/// The walk is what the report calls for: a container such as Maps (71)
/// answers with «No files in this category yet.» and a menu of children, so an
/// empty listing is not the end of the branch (report, section 2).
///
/// The file count of a category is printed in exactly one place — the
/// **Subcategories** widget on the page of its **parent** — and the two game
/// roots have no such page: `/files/category/41-jedi-academy/` redirects to a
/// hand-written page of the site's CMS, which carries no widget at all. So the
/// counts come from three honest sources and are left empty rather than
/// guessed:
///
/// * `/files/categories/` prints the count of each root;
/// * `/files/` carries a trimmed widget with the count of each root and of its
///   first five children;
/// * the widget on a child's own page counts every grandchild, and when the
///   child's listing fits on one page the cards on it are the count.
///
/// A free function rather than a method: the walk needs no cache and no
/// snapshot folder, and the background refresh in `mod.rs` runs it with
/// nothing but the shared client.
///
/// --- slice: jkhub catalog ---
/// Only the categories of [`sections::SECTIONS`] are walked. The game roots
/// are not nodes of the launcher's tree, and a child outside the table — Code
/// Mods, Cosmetic Mods, Media, Prefabs, Utilities — costs no request at all,
/// which is what takes the walk from about twenty pages per game down to
/// nine. A section id therefore has to be a direct child of a game root, or a
/// child of one that is; the test in [`sections`] holds the table to it.
pub async fn crawl_tree(client: &JkhubClient, game: Game) -> Result<Vec<JkhubCategory>> {
    let index = client
        .fetch_html(&format!("{}/files/categories/", parse::SITE))
        .await?;
    let roots = parse::parse_category_index(&index.body)?;

    let home = client.fetch_html(&format!("{}/files/", parse::SITE)).await?;
    let counts: BTreeMap<u32, u32> = parse::parse_subcategories(&home.body)
        .into_iter()
        .filter_map(|entry| entry.file_count.map(|count| (entry.id, count)))
        .collect();

    let mut tree = Vec::new();
    for root in roots {
        let Some(root_game) = parse::game_of_root(root.id) else {
            // Contest Entries (77) has no game and is usually empty; the
            // screens hide it, so it is not walked either.
            continue;
        };
        if !root_game.matches(game) {
            continue;
        }
        for child in root.children {
            // Outside the eight sections, so neither walked nor kept. The
            // game root itself is not kept either: the tree the screen draws
            // is the flat one `sections::tree` builds out of this one.
            if !sections::covers(game, child.id) {
                continue;
            }
            let page = client
                .fetch_html(&parse::category_url(child.id, &child.slug))
                .await?;
            let grandchildren = parse::parse_subcategories(&page.body);
            let has_files = !parse::says_no_files(&page.body);
            tree.push(JkhubCategory {
                id: child.id,
                slug: child.slug.clone(),
                name: child.name.clone(),
                parent_id: Some(root.id),
                game: root_game,
                file_count: counts
                    .get(&child.id)
                    .copied()
                    .or_else(|| exact_count(&page.body, has_files)),
                has_files,
                url: parse::category_url(child.id, &child.slug),
                section: None,
            });
            for grandchild in grandchildren {
                if grandchild.id == child.id || !sections::covers(game, grandchild.id) {
                    continue;
                }
                tree.push(JkhubCategory {
                    id: grandchild.id,
                    slug: grandchild.slug.clone(),
                    name: grandchild.name.clone(),
                    parent_id: Some(child.id),
                    game: root_game,
                    file_count: grandchild
                        .file_count
                        .or_else(|| counts.get(&grandchild.id).copied()),
                    // Not visited: the site's tree is three deep, and a page
                    // per grandchild would double the walk. A wrong `true`
                    // costs one empty listing, which the screen already
                    // renders.
                    has_files: true,
                    url: parse::category_url(grandchild.id, &grandchild.slug),
                    section: None,
                });
            }
        }
    }

    // The counts of the direct children are printed on the parent's page, and
    // the two game roots have no page of their own — so a child of a root
    // keeps whatever count the walk found, and the rest come from the
    // grandchild entries above. Nothing is invented here.
    dedup(&mut tree);
    Ok(sections::prune(game, tree))
}

/// The file count of a category whose whole listing fits on one page.
///
/// Exact, and free: the page was fetched to look for subcategories anyway.
/// A listing that spills onto a second page says only how many pages it has,
/// and `(pages - 1) * 25 + something` is a guess, so this answers `None`
/// rather than printing one.
fn exact_count(html: &str, has_files: bool) -> Option<u32> {
    if !has_files {
        return None;
    }
    let listing = parse::parse_listing(html).ok()?;
    (listing.pages == 1).then_some(listing.cards.len() as u32)
}

/// Drops repeats, keeping the first entry of each id.
///
/// `Both Games/Other` is walked once per game, and a child that appears both
/// in the index and in a widget would otherwise show up twice.
fn dedup(tree: &mut Vec<JkhubCategory>) {
    let mut seen = BTreeSet::new();
    tree.retain(|entry| seen.insert(entry.id));
}

impl JkhubSource for HtmlSource<'_> {
    /// The tree, dropping the plan the command half of the module acts on.
    async fn categories(&self, game: Game) -> Result<JkhubCategories> {
        self.categories_with_plan(game)
            .await
            .map(|(categories, _)| categories)
    }

    async fn list(
        &self,
        game: Game,
        category_id: u32,
        sort: JkhubSort,
        page: u32,
    ) -> Result<JkhubListing> {
        let page = page.max(1);
        let name = cache::listing_name(category_id, sort.as_str(), page);
        let cached = cache::read::<JkhubListing>(self.data, &name);
        if let Some(entry) = &cached {
            if entry.fresh && !self.force {
                let mut listing = entry.payload.clone();
                listing.fetched_at = entry.fetched_at.clone();
                listing.stale = false;
                return Ok(listing);
            }
        }

        let url = self.listing_url(category_id, &self.slug_of(game, category_id), sort, page);
        match self.client.fetch_html(&url).await {
            Ok(Page { body, max_age, .. }) => {
                let parsed = parse::parse_listing(&body)?;
                let listing = JkhubListing {
                    category_id,
                    sort,
                    page,
                    pages: parsed.pages,
                    per_page: parse::PER_PAGE,
                    cards: parsed.cards,
                    fetched_at: String::new(),
                    stale: false,
                };
                let ttl = cache::ttl_from(max_age, cache::PAGE_TTL);
                let fetched_at = cache::write(self.data, &name, &listing, ttl);
                Ok(JkhubListing {
                    fetched_at,
                    ..listing
                })
            }
            Err(e) => match cached {
                Some(entry) => {
                    log::warn!("jkhub: serving a stale listing of {category_id}, {e}");
                    let mut listing = entry.payload;
                    listing.fetched_at = entry.fetched_at;
                    listing.stale = true;
                    Ok(listing)
                }
                None => Err(e),
            },
        }
    }

    async fn file(&self, id: u32) -> Result<JkhubFileView> {
        self.file_opt(id).await?.ok_or_else(|| {
            AppError::JkhubUnavailable(format!("jkhub.org has no file {id} any more"))
        })
    }
}

/// The reader for the day JKHub issues a read-only API key.
///
/// Kept as a type rather than a comment so the shape of the second reader is
/// decided now: it implements the same trait, so `HtmlSource` can be swapped
/// for it in one place. The key would be a setting (`jkhubApiKey`); this
/// slice deliberately does not add it, because a key that no one has yet is
/// a field that can only be wrong.
///
/// Nothing constructs it yet, which is the point: it is the seam, not a
/// feature.
#[allow(dead_code)]
pub struct RestSource;

impl JkhubSource for RestSource {
    async fn categories(&self, _game: Game) -> Result<JkhubCategories> {
        Err(not_configured())
    }

    async fn list(
        &self,
        _game: Game,
        _category_id: u32,
        _sort: JkhubSort,
        _page: u32,
    ) -> Result<JkhubListing> {
        Err(not_configured())
    }

    async fn file(&self, _id: u32) -> Result<JkhubFileView> {
        Err(not_configured())
    }
}

/// Only [`RestSource`] returns this, and nothing constructs one yet; the
/// message is what the seam will say the day a key is added and forgotten.
#[allow(dead_code)]
fn not_configured() -> AppError {
    AppError::JkhubUnavailable(
        "the JKHub REST API needs a key this build does not have; the launcher reads the public pages instead"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only a fixture names a shelf of the site here: the reader itself speaks
    // the launcher's `Game`.
    use super::super::types::JkhubGame;

    fn source<'a>(client: &'a JkhubClient, data: &'a DataPaths) -> HtmlSource<'a> {
        HtmlSource::new(client, data)
    }

    #[test]
    fn a_listing_address_puts_the_page_in_the_path_and_the_sort_in_the_query() {
        let client = JkhubClient::new().expect("a client");
        let dir = tempfile::tempdir().expect("a temp dir");
        let data = DataPaths::new(dir.path().to_path_buf());
        let source = source(&client, &data);

        assert_eq!(
            source.listing_url(13, "free-for-all", JkhubSort::RecentlyUpdated, 1),
            "https://jkhub.org/files/category/13-free-for-all/?sortby=file_updated&sortdirection=desc"
        );
        assert_eq!(
            source.listing_url(13, "free-for-all", JkhubSort::Name, 3),
            "https://jkhub.org/files/category/13-free-for-all/page/3/?sortby=file_name&sortdirection=asc"
        );
    }

    #[test]
    fn the_rest_reader_says_it_has_no_key_rather_than_pretending() {
        let error = not_configured();
        assert!(matches!(error, AppError::JkhubUnavailable(_)));
        assert!(error.to_string().contains("needs a key"));
    }

    /// Asks the live site for one category page.
    ///
    /// Ignored by default: a test suite must not call another project's
    /// server. Run it by hand with
    /// `cargo test -- --ignored jkhub::source::tests::live` when the parsers
    /// change, and check the numbers against the saved sample.
    #[test]
    #[ignore = "talks to jkhub.org"]
    fn live_a_category_page_still_parses() {
        let client = JkhubClient::new().expect("a client");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime");
        let page = runtime
            .block_on(client.fetch_html("https://jkhub.org/files/category/13-free-for-all/"))
            .expect("the category answers");
        let listing = parse::parse_listing(&page.body).expect("it parses");
        assert_eq!(listing.cards.len(), parse::PER_PAGE as usize);
        assert!(listing.pages >= 14, "pages: {}", listing.pages);
        assert_eq!(listing.title.as_deref(), Some("Free For All"));
        let first = &listing.cards[0];
        assert!(first.id > 0 && !first.title.is_empty());
        println!(
            "live: {} cards, {} pages, max-age {:?}, first {} ({})",
            listing.cards.len(),
            listing.pages,
            page.max_age,
            first.title,
            first.id
        );

        // `jkhub_file` and `jkhub_install` know an id and no slug, so this is
        // the address they actually request. An empty segment would 404.
        let by_id = runtime
            .block_on(client.fetch_html(&parse::file_url(1486, "")))
            .expect("an id alone reaches the file page");
        assert_eq!(
            parse::file_ref(&by_id.url),
            Some((1486, "saber-changer".to_string())),
            "the redirect hands back the real slug"
        );
        let file = parse::parse_file_page(&by_id.body, 1486, "saber-changer").expect("it parses");
        assert_eq!(file.title, "Saber Changer");
        println!("live: 1486 resolved to {}", by_id.url);

        // The index is the other page the tree walk depends on, and the one
        // whose markup a theme update would break first.
        let index = runtime
            .block_on(client.fetch_html("https://jkhub.org/files/categories/"))
            .expect("the index answers");
        let roots = parse::parse_category_index(&index.body).expect("it parses");
        let ids: Vec<u32> = roots.iter().map(|root| root.id).collect();
        assert_eq!(ids, vec![41, 40, 74, 77]);
        let academy = &roots[0];
        assert_eq!(academy.children.len(), 17);
        println!(
            "live: roots {ids:?}, Jedi Academy has {} children and {:?} files",
            academy.children.len(),
            academy.file_count
        );
    }

    #[test]
    fn a_one_page_category_counts_itself_and_a_longer_one_does_not() {
        const FFA: &str = include_str!("../../tests/fixtures/jkhub/cat-13-ffa.html");
        const MAPS: &str = include_str!("../../tests/fixtures/jkhub/cat-71-maps.html");

        assert_eq!(
            exact_count(FFA, true),
            None,
            "fifteen pages: the count is a guess, so it stays empty"
        );
        assert_eq!(
            exact_count(MAPS, false),
            None,
            "a container holds no files of its own"
        );
    }

    #[test]
    fn the_tree_is_served_from_whatever_is_at_hand_and_walked_behind_it() {
        // fresh cache, stale cache, no cache with a snapshot, nothing at all.
        assert_eq!(decide(Some(true), false, false), TreeDecision::ServeFresh);
        assert_eq!(decide(Some(false), false, false), TreeDecision::ServeStale);
        assert_eq!(decide(None, true, false), TreeDecision::ServeSnapshot);
        assert_eq!(decide(None, false, false), TreeDecision::CrawlNow);

        // A snapshot never wins over the cache: the cache was read from the
        // site, the snapshot is as old as the build.
        assert_eq!(decide(Some(true), true, false), TreeDecision::ServeFresh);
        assert_eq!(decide(Some(false), true, false), TreeDecision::ServeStale);

        // **Update categories** walks whatever is on disk.
        for cached in [Some(true), Some(false), None] {
            for has_snapshot in [true, false] {
                assert_eq!(
                    decide(cached, has_snapshot, true),
                    TreeDecision::CrawlNow,
                    "cached {cached:?}, snapshot {has_snapshot}"
                );
            }
        }

        // Only the two answers that served something old ask for a walk.
        assert!(!TreeDecision::ServeFresh.wants_refresh());
        assert!(TreeDecision::ServeStale.wants_refresh());
        assert!(TreeDecision::ServeSnapshot.wants_refresh());
        assert!(!TreeDecision::CrawlNow.wants_refresh());
    }

    #[tokio::test]
    async fn a_bundled_snapshot_answers_without_a_single_request() {
        use super::super::snapshot::Snapshot;

        let client = JkhubClient::new().expect("a client");
        let dir = tempfile::tempdir().expect("a temp dir");
        let data = DataPaths::new(dir.path().to_path_buf());
        data.ensure().expect("the layout is created");

        let bundle = dir.path().join("resources").join("jkhub");
        std::fs::create_dir_all(&bundle).expect("the folder exists");
        let snapshot = Snapshot {
            game: Game::JediAcademy,
            generated_at: "2026-09-10T12:00:00Z".into(),
            categories: vec![JkhubCategory {
                id: 13,
                slug: "free-for-all".into(),
                name: "Free For All".into(),
                parent_id: Some(71),
                game: JkhubGame::Ja,
                file_count: Some(367),
                has_files: true,
                url: parse::category_url(13, "free-for-all"),
                section: None,
            }],
        };
        std::fs::write(
            bundle.join(snapshot::file_name(Game::JediAcademy)),
            serde_json::to_string(&snapshot).expect("it serializes"),
        )
        .expect("it writes");

        // No cache entry and no network: the answer can only be the bundle.
        // A walk would need jkhub.org, and this test never reaches it.
        let source = HtmlSource::new(&client, &data).with_snapshots(Some(bundle));
        let (answer, wants_refresh) = source
            .categories_with_plan(Game::JediAcademy)
            .await
            .expect("the bundle answers");
        assert_eq!(answer.categories.len(), 1);
        assert_eq!(answer.categories[0].id, 13);
        assert_eq!(answer.fetched_at, "2026-09-10T12:00:00Z");
        assert!(answer.stale, "a bundled tree is as old as the build");
        assert!(wants_refresh, "and is walked behind the answer");
    }

    #[tokio::test]
    async fn a_fresh_cache_entry_answers_and_asks_for_nothing() {
        let client = JkhubClient::new().expect("a client");
        let dir = tempfile::tempdir().expect("a temp dir");
        let data = DataPaths::new(dir.path().to_path_buf());
        data.ensure().expect("the layout is created");

        // A category of the eight sections, and a root of the pruned tree:
        // anything else would come back changed and say nothing about the
        // cache, which is what this test is about.
        let tree = vec![JkhubCategory {
            id: 38,
            slug: "audio".into(),
            name: "Audio".into(),
            parent_id: None,
            game: JkhubGame::Ja,
            file_count: Some(52),
            has_files: true,
            url: parse::category_url(38, "audio"),
            section: None,
        }];
        let written = store_tree(&data, Game::JediAcademy, &tree);
        assert!(!written.is_empty());

        let source = HtmlSource::new(&client, &data);
        let (answer, wants_refresh) = source
            .categories_with_plan(Game::JediAcademy)
            .await
            .expect("the cache answers");
        assert_eq!(answer.categories, tree);
        assert!(!answer.stale);
        assert!(!wants_refresh, "nothing to walk behind a current tree");

        // The same entry past its lifetime still answers, and asks for a walk
        // behind it. A lifetime of zero seconds is spent by the time it is
        // read, so this needs no clock and no network either.
        cache::write(
            &data,
            &cache::categories_name(Game::JediAcademy.id()),
            &tree,
            0,
        );
        let (answer, wants_refresh) = source
            .categories_with_plan(Game::JediAcademy)
            .await
            .expect("the spent entry answers");
        assert_eq!(answer.categories, tree);
        assert!(answer.stale, "the screen says From cache");
        assert!(wants_refresh, "and the tree is walked behind it");
    }

    #[test]
    fn a_repeated_category_is_kept_once() {
        let entry = |id: u32| JkhubCategory {
            id,
            slug: "x".into(),
            name: "X".into(),
            parent_id: None,
            game: JkhubGame::Both,
            file_count: None,
            has_files: true,
            url: parse::category_url(id, "x"),
            section: None,
        };
        let mut tree = vec![entry(74), entry(3), entry(74)];
        dedup(&mut tree);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].id, 74);
        assert_eq!(tree[1].id, 3);
    }
}
