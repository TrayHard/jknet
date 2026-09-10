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

use crate::error::{AppError, Result};
use crate::paths::DataPaths;

use super::cache;
use super::client::{JkhubClient, Page};
use super::parse;
use super::types::{
    JkhubCategories, JkhubCategory, JkhubFile, JkhubFileView, JkhubGame, JkhubListing, JkhubSort,
};

/// Reading the JKHub catalogue, however it arrives.
///
/// `async fn` in a trait is stable since Rust 1.75; the futures are used
/// inside this crate only, so the missing `Send` bound that comes with it is
/// not a problem — the commands await them directly.
#[allow(async_fn_in_trait)]
pub trait JkhubSource {
    /// The category tree of one game, roots first.
    async fn categories(&self, game: JkhubGame) -> Result<JkhubCategories>;

    /// One page of one category.
    async fn list(&self, category_id: u32, sort: JkhubSort, page: u32) -> Result<JkhubListing>;

    /// One file page.
    async fn file(&self, id: u32) -> Result<JkhubFileView>;
}

/// The reader that parses the public pages of jkhub.org.
pub struct HtmlSource<'a> {
    pub client: &'a JkhubClient,
    pub data: &'a DataPaths,
    /// True when the caller pressed **Refresh**: ask the site even if the
    /// cached copy is still fresh.
    pub force: bool,
}

impl<'a> HtmlSource<'a> {
    pub fn new(client: &'a JkhubClient, data: &'a DataPaths) -> Self {
        HtmlSource {
            client,
            data,
            force: false,
        }
    }

    /// The same reader, told to ignore a fresh cache entry.
    pub fn forced(mut self, force: bool) -> Self {
        self.force = force;
        self
    }

    /// Address of one page of one category listing.
    ///
    /// The page number is part of the path and the sort is a query parameter:
    /// the site accepts no `perPage`, which is fixed at 25 by the theme
    /// (report, section 3).
    fn listing_url(&self, category_id: u32, slug: &str, sort: JkhubSort, page: u32) -> String {
        let (by, direction) = sort.query();
        let base = parse::category_url(category_id, slug);
        let path = if page > 1 {
            format!("{base}page/{page}/")
        } else {
            base
        };
        format!("{path}?sortby={by}&sortdirection={direction}")
    }

    /// Slug of a category, taken from any cached tree that names it.
    ///
    /// The site redirects `/files/category/{id}-{wrong-slug}/` to the right
    /// address, so a stale slug costs one redirect and never a wrong page —
    /// which is why an unknown category is asked for with an empty slug
    /// rather than refused.
    fn slug_of(&self, category_id: u32) -> String {
        for game in [JkhubGame::Ja, JkhubGame::Jo, JkhubGame::Both] {
            let name = cache::categories_name(game.as_str());
            let Some(cached) = cache::read::<Vec<JkhubCategory>>(self.data, &name) else {
                continue;
            };
            if let Some(found) = cached.payload.iter().find(|entry| entry.id == category_id) {
                return found.slug.clone();
            }
        }
        String::new()
    }

    /// Walks the tree of one game, one page per direct child of a root.
    ///
    /// The walk is what the report calls for: a container such as Maps (71)
    /// answers with «No files in this category yet.» and a menu of children,
    /// so an empty listing is not the end of the branch (report, section 2).
    ///
    /// The file count of a category is printed in exactly one place — the
    /// **Subcategories** widget on the page of its **parent** — and the two
    /// game roots have no such page: `/files/category/41-jedi-academy/`
    /// redirects to a hand-written page of the site's CMS, which carries no
    /// widget at all. So the counts come from three honest sources and are
    /// left empty rather than guessed:
    ///
    /// * `/files/categories/` prints the count of each root;
    /// * `/files/` carries a trimmed widget with the count of each root and
    ///   of its first five children;
    /// * the widget on a child's own page counts every grandchild, and when
    ///   the child's listing fits on one page the cards on it are the count.
    async fn crawl_tree(&self, game: JkhubGame) -> Result<Vec<JkhubCategory>> {
        let index = self
            .client
            .fetch_html(&format!("{}/files/categories/", parse::SITE))
            .await?;
        let roots = parse::parse_category_index(&index.body)?;

        let home = self
            .client
            .fetch_html(&format!("{}/files/", parse::SITE))
            .await?;
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
            if !root_game.shown_for(game) {
                continue;
            }
            tree.push(JkhubCategory {
                id: root.id,
                slug: root.slug.clone(),
                name: root.name.clone(),
                parent_id: None,
                game: root_game,
                file_count: root.file_count,
                // The two game roots redirect to hand-written pages of the
                // site's CMS and never list files themselves (report,
                // section 2).
                has_files: false,
                url: parse::category_url(root.id, &root.slug),
            });

            for child in root.children {
                let page = self
                    .client
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
                });
                for grandchild in grandchildren {
                    if grandchild.id == child.id {
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
                        // Not visited: the site's tree is three deep, and a
                        // page per grandchild would double the walk. A wrong
                        // `true` costs one empty listing, which the screen
                        // already renders.
                        has_files: true,
                        url: parse::category_url(grandchild.id, &grandchild.slug),
                    });
                }
            }
        }

        // The counts of the direct children are printed on the parent's page,
        // and the two game roots have no page of their own — so a child of a
        // root keeps whatever count the walk found, and the rest come from
        // the grandchild entries above. Nothing is invented here.
        dedup(&mut tree);
        Ok(tree)
    }
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
    async fn categories(&self, game: JkhubGame) -> Result<JkhubCategories> {
        let name = cache::categories_name(game.as_str());
        let cached = cache::read::<Vec<JkhubCategory>>(self.data, &name);
        if let Some(entry) = &cached {
            if entry.fresh && !self.force {
                return Ok(JkhubCategories {
                    game,
                    categories: entry.payload.clone(),
                    fetched_at: entry.fetched_at.clone(),
                    stale: false,
                });
            }
        }

        match self.crawl_tree(game).await {
            Ok(tree) => {
                let fetched_at = cache::write(self.data, &name, &tree, cache::CATEGORIES_TTL);
                Ok(JkhubCategories {
                    game,
                    categories: tree,
                    fetched_at,
                    stale: false,
                })
            }
            // The tree is expensive to rebuild and changes a few times a
            // year: an old copy beats an empty screen.
            Err(e) => match cached {
                Some(entry) => {
                    log::warn!("jkhub: serving the stale category tree, {e}");
                    Ok(JkhubCategories {
                        game,
                        categories: entry.payload,
                        fetched_at: entry.fetched_at,
                        stale: true,
                    })
                }
                None => Err(e),
            },
        }
    }

    async fn list(&self, category_id: u32, sort: JkhubSort, page: u32) -> Result<JkhubListing> {
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

        let url = self.listing_url(category_id, &self.slug_of(category_id), sort, page);
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
        let name = cache::file_name(id);
        let cached = cache::read::<JkhubFile>(self.data, &name);
        if let Some(entry) = &cached {
            if entry.fresh && !self.force {
                return Ok(JkhubFileView {
                    file: entry.payload.clone(),
                    fetched_at: entry.fetched_at.clone(),
                    stale: false,
                });
            }
        }

        // The slug is cosmetic in the address: an id alone redirects to the
        // canonical page, and the parser reads the real slug back out of the
        // JSON-LD `url`.
        let url = parse::file_url(id, "");
        match self.client.fetch_html(&url).await {
            Ok(page) => {
                let slug = parse::file_ref(&page.url)
                    .map(|(_, slug)| slug)
                    .unwrap_or_default();
                let file = parse::parse_file_page(&page.body, id, &slug)?;
                let ttl = cache::ttl_from(page.max_age, cache::PAGE_TTL);
                let fetched_at = cache::write(self.data, &name, &file, ttl);
                Ok(JkhubFileView {
                    file,
                    fetched_at,
                    stale: false,
                })
            }
            Err(e) => match cached {
                Some(entry) => {
                    log::warn!("jkhub: serving a stale card for {id}, {e}");
                    Ok(JkhubFileView {
                        file: entry.payload,
                        fetched_at: entry.fetched_at,
                        stale: true,
                    })
                }
                None => Err(e),
            },
        }
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
    async fn categories(&self, _game: JkhubGame) -> Result<JkhubCategories> {
        Err(not_configured())
    }

    async fn list(&self, _category_id: u32, _sort: JkhubSort, _page: u32) -> Result<JkhubListing> {
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
        };
        let mut tree = vec![entry(74), entry(3), entry(74)];
        dedup(&mut tree);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].id, 74);
        assert_eq!(tree[1].id, 3);
    }
}
