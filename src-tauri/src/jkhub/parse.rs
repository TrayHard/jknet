//! Pure parsers for the pages of jkhub.org.
//!
//! Nothing here touches the network or the disk: every function takes the text
//! of one page and returns owned data, which is what makes the whole module
//! testable against the saved samples in `tests/fixtures/jkhub/`.
//!
//! The order of preference comes from the research report
//! (`jkhub-files-research-report.md`, section 8): read the JSON-LD block first,
//! because it is part of the Invision Community contract, and fall back to the
//! CSS classes of the theme only where JSON-LD carries nothing — the category
//! tree, the file counts, the cards of a listing and the `csrfKey`.
//!
//! `scraper::Html` is not `Send`, so every function here is synchronous and
//! returns owned values. A caller may not hold a parsed document across an
//! `await`.

use std::collections::BTreeSet;

use scraper::{ElementRef, Html, Selector};
use serde_json::Value;

use crate::error::{AppError, Result};

use super::types::{
    JkhubAuthor, JkhubCard, JkhubChangelogEntry, JkhubFile, JkhubGame, JkhubRating,
    JkhubScreenshot,
};

/// Host every canonical link on the site starts with.
pub const SITE: &str = "https://jkhub.org";

/// Longest description kept from a listing card. The card in the HTML holds
/// the whole text — the theme truncates it with CSS — and some of them run to
/// several kilobytes of readme (report, section 3).
const MAX_CARD_DESCRIPTION: usize = 600;

/// Entries of an archive listing shown when nothing installable is inside.
pub const MAX_ENTRY_PREVIEW: usize = 20;

/// Files a category page lists at once. Fixed by the theme, not a parameter
/// (`data-ipsPagination-perPage='25'`, report section 3).
pub const PER_PAGE: u32 = 25;

/// Marker a container category shows instead of a file list (report,
/// section 2). Its presence means the real files live in the children.
const NO_FILES_MARKER: &str = "No files in this category yet.";

/// Builds a selector or panics, which is what a wrong literal deserves.
///
/// Every call site passes a constant, so a failure here is a typo in this
/// file and can only happen in a build that never ran.
fn sel(selector: &'static str) -> Selector {
    Selector::parse(selector).expect("static selector")
}

// ---------------------------------------------------------------------------
// Category tree
// ---------------------------------------------------------------------------

/// One top-level category with the names of its direct children.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopCategory {
    pub id: u32,
    pub slug: String,
    pub name: String,
    pub file_count: Option<u32>,
    pub children: Vec<ChildLink>,
}

/// A child named on `/files/categories/`, where counts are not printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildLink {
    pub id: u32,
    pub slug: String,
    pub name: String,
}

/// Reads `/files/categories/`: the top level with its file counts, plus the
/// direct children of each, which that page names without counts.
pub fn parse_category_index(html: &str) -> Result<Vec<TopCategory>> {
    let document = Html::parse_document(html);
    let item = sel("li.ipsDataItem");
    let title = sel("h4.ipsDataItem_title a[href]");
    let child = sel("ul.ipsDataItem_subList a[href]");
    let count = sel("dt.ipsDataItem_stats_number");

    let mut categories = Vec::new();
    for element in document.select(&item) {
        let Some(link) = element.select(&title).next() else {
            continue;
        };
        let Some((id, slug)) = category_ref(link.value().attr("href").unwrap_or_default()) else {
            continue;
        };
        let children = element
            .select(&child)
            .filter_map(|link| {
                let (id, slug) = category_ref(link.value().attr("href").unwrap_or_default())?;
                Some(ChildLink {
                    id,
                    slug,
                    name: text_of(link),
                })
            })
            .collect();
        categories.push(TopCategory {
            id,
            slug,
            name: text_of(link),
            file_count: element.select(&count).next().and_then(|node| number(&text_of(node))),
            children,
        });
    }

    if categories.is_empty() {
        return Err(AppError::JkhubParse {
            what: "the category index has no category links".into(),
        });
    }
    Ok(categories)
}

/// Reads the **Subcategories** widget of one category page.
///
/// This is the only place on the site that prints the file count of a
/// non-top-level category (`cDownloadsCategoryCount`), so the tree is filled
/// in by walking down, not by reading one index (report, section 2).
pub fn parse_subcategories(html: &str) -> Vec<CountedCategory> {
    let document = Html::parse_document(html);
    let link = sel("a.ipsSideMenu_item[href]");
    let badge = sel(".cDownloadsCategoryCount");

    let mut found = Vec::new();
    for element in document.select(&link) {
        let Some((id, slug)) = category_ref(element.value().attr("href").unwrap_or_default())
        else {
            continue;
        };
        let count = element.select(&badge).next().and_then(|node| number(&text_of(node)));
        // The count sits inside the link, so the name is what is left after
        // the badge text is taken away.
        let whole = text_of(element);
        let name = match element.select(&badge).next().map(text_of) {
            Some(badge_text) => whole.replacen(badge_text.trim(), "", 1).trim().to_string(),
            None => whole,
        };
        if name.is_empty() {
            continue;
        }
        found.push(CountedCategory {
            id,
            slug,
            name,
            file_count: count,
        });
    }
    found
}

/// A child of the category whose page was parsed, with its file count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CountedCategory {
    pub id: u32,
    pub slug: String,
    pub name: String,
    pub file_count: Option<u32>,
}

/// Whether the category page says it holds no files of its own.
///
/// A container such as Maps (71) answers with this line and a menu of
/// children instead of a listing, so an empty answer is not the end of the
/// tree (report, section 2).
pub fn says_no_files(html: &str) -> bool {
    html.contains(NO_FILES_MARKER)
}

/// Turns a top-level category id into the game it belongs to.
///
/// The four roots are fixed by the site: 41 Jedi Academy, 40 Jedi Outcast,
/// 74 Both Games/Other, 77 Contest Entries (report, section 2).
pub fn game_of_root(id: u32) -> Option<JkhubGame> {
    match id {
        41 => Some(JkhubGame::Ja),
        40 => Some(JkhubGame::Jo),
        74 => Some(JkhubGame::Both),
        _ => None,
    }
}

/// Canonical address of a category page.
pub fn category_url(id: u32, slug: &str) -> String {
    format!("{SITE}/files/category/{id}-{slug}/")
}

/// Canonical address of a file page.
pub fn file_url(id: u32, slug: &str) -> String {
    format!("{SITE}/files/file/{id}-{slug}/")
}

// ---------------------------------------------------------------------------
// Listing cards
// ---------------------------------------------------------------------------

/// What one page of a category listing carries.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedListing {
    pub cards: Vec<JkhubCard>,
    /// Number of pages the pagination widget announces, 1 when it is absent.
    pub pages: u32,
    /// Title printed above the list, used when the category is not in the
    /// cached tree yet.
    pub title: Option<String>,
}

/// Reads one page of `/files/category/{id}-{slug}/`.
pub fn parse_listing(html: &str) -> Result<ParsedListing> {
    let document = Html::parse_document(html);
    let item = sel("li.ipsDataItem");
    let title_link = sel("h4.ipsDataItem_title a[href]");

    let mut cards = Vec::new();
    for element in document.select(&item) {
        let Some(link) = element.select(&title_link).next() else {
            continue;
        };
        let Some((id, slug)) = file_ref(link.value().attr("href").unwrap_or_default()) else {
            continue;
        };
        cards.push(card(element, id, slug, text_of(link)));
    }

    Ok(ParsedListing {
        cards,
        pages: page_count(&document),
        title: document
            .select(&sel("h1.ipsType_pageTitle"))
            .next()
            .map(|node| text_of(node)),
    })
}

/// Fills one card from its `li`.
fn card(element: ElementRef<'_>, id: u32, slug: String, title: String) -> JkhubCard {
    let thumb = sel("a.ipsThumb");
    let profile = sel("a[href*='/profile/']");
    let rich = sel("div.ipsType_richText");
    let paragraph = sel("p");
    let time = sel("time[datetime]");

    let thumbnail_url = element.select(&thumb).next().and_then(|node| {
        node.value()
            .attr("data-background-src")
            .map(str::to_string)
            .or_else(|| {
                node.select(&sel("img[src]"))
                    .next()
                    .and_then(|img| img.value().attr("src"))
                    .map(str::to_string)
            })
    });

    let author = element.select(&profile).next().map(|node| JkhubAuthor {
        name: text_of(node),
        url: node.value().attr("href").map(str::to_string),
        avatar_url: None,
    });

    let description = element
        .select(&rich)
        .next()
        .map(|node| truncate(&text_of(node), MAX_CARD_DESCRIPTION))
        .unwrap_or_default();

    // The stats column prints "Updated <time>" or "Submitted <time>". Reading
    // the label matters: a category sorted by submission date shows the other
    // one, and a card that says "Updated" about a submission date is a lie.
    let mut date = None;
    let mut date_label = None;
    for node in element.select(&paragraph) {
        let text = text_of(node);
        let label = if text.contains("Updated") {
            "Updated"
        } else if text.contains("Submitted") {
            "Submitted"
        } else {
            continue;
        };
        if let Some(stamp) = node.select(&time).next().and_then(|t| t.value().attr("datetime")) {
            date = Some(stamp.to_string());
            date_label = Some(label.to_string());
            break;
        }
    }
    if date.is_none() {
        date = element
            .select(&time)
            .next()
            .and_then(|t| t.value().attr("datetime"))
            .map(str::to_string);
    }

    JkhubCard {
        id,
        slug: slug.clone(),
        title,
        url: file_url(id, &slug),
        author,
        thumbnail_url,
        description,
        downloads: downloads_of(element),
        date,
        date_label,
        tags: tags_of(element),
        rating: rating_of(element),
    }
}

/// Reads `<i class='fa fa-arrow-circle-down'></i> 7,877 downloads`.
fn downloads_of(element: ElementRef<'_>) -> Option<u64> {
    let span = sel("span");
    for node in element.select(&span) {
        let text = text_of(node);
        if text.contains("downloads") || text.contains("download") {
            if let Some(value) = number(&text) {
                return Some(u64::from(value));
            }
        }
    }
    None
}

/// Collects the tags of an item, in page order and without repeats.
///
/// The theme prints the first few inline and then repeats all of them inside
/// a popup menu, so the same tag appears twice in the HTML (report,
/// section 3).
fn tags_of(element: ElementRef<'_>) -> Vec<String> {
    let tag = sel("a.ipsTag");
    let mut seen = BTreeSet::new();
    let mut tags = Vec::new();
    for node in element.select(&tag) {
        let label = node
            .value()
            .attr("data-tag-label")
            .map(str::to_string)
            .unwrap_or_else(|| text_of(node));
        let label = label.trim().to_string();
        if label.is_empty() || !seen.insert(label.to_lowercase()) {
            continue;
        }
        tags.push(label);
    }
    tags
}

/// Reads the star row of a card.
///
/// The research report expected no stars in a listing card; the saved sample
/// has them (`ipsRating_collective` with `ipsRating_on` per filled star), so
/// this reads them when they are there and answers `None` when they are not.
fn rating_of(element: ElementRef<'_>) -> Option<JkhubRating> {
    let stars = sel("ul.ipsRating_collective li.ipsRating_on");
    let block = sel("div.ipsRating");
    element.select(&block).next()?;
    let value = element.select(&stars).count() as f32;
    let count = element
        .select(&sel("span.ipsType_light"))
        .filter_map(|node| {
            let text = text_of(node);
            text.contains("review").then(|| number(&text)).flatten()
        })
        .next()
        .unwrap_or(0);
    if value == 0.0 && count == 0 {
        return None;
    }
    Some(JkhubRating { value, count })
}

/// Number of pages the pagination widget announces.
fn page_count(document: &Html) -> u32 {
    document
        .select(&sel("ul.ipsPagination[data-pages]"))
        .next()
        .and_then(|node| node.value().attr("data-pages"))
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pages| *pages > 0)
        .unwrap_or(1)
}

// ---------------------------------------------------------------------------
// File page
// ---------------------------------------------------------------------------

/// Reads `/files/file/{id}-{slug}/` into the record the screens render.
///
/// The `WebApplication` block of JSON-LD carries almost every field at once
/// and survives a change of theme, which the CSS classes do not (report,
/// section 4). `fileSize` is deliberately ignored: it reads `"0 B"` for every
/// file on this installation.
pub fn parse_file_page(html: &str, id: u32, slug: &str) -> Result<JkhubFile> {
    let document = Html::parse_document(html);
    let blocks = json_ld(&document);

    let app = blocks
        .iter()
        .find(|value| type_of(value) == Some("WebApplication"))
        .ok_or_else(|| AppError::JkhubParse {
            what: format!("file {id} has no WebApplication block"),
        })?;

    let crumbs = blocks
        .iter()
        .find(|value| type_of(value) == Some("BreadcrumbList"))
        .map(breadcrumb_categories)
        .unwrap_or_default();
    // The first crumb with a category address is the game root, the last one
    // is the category the file sits in, however deep the tree goes.
    let game = crumbs
        .first()
        .and_then(|(id, _, _)| game_of_root(*id))
        .unwrap_or(JkhubGame::Both);
    let category = crumbs.last().cloned();

    let counters = interaction_counters(app);

    Ok(JkhubFile {
        id,
        slug: slug.to_string(),
        title: string(app, "name").unwrap_or_else(|| format!("File {id}")),
        url: string(app, "url").unwrap_or_else(|| file_url(id, slug)),
        game,
        category_id: category.as_ref().map(|(id, _, _)| *id),
        category_name: category
            .as_ref()
            .map(|(_, _, name)| name.clone())
            .or_else(|| string(app, "applicationCategory")),
        author: app.get("author").and_then(|author| {
            Some(JkhubAuthor {
                name: string(author, "name")?,
                url: string(author, "url"),
                avatar_url: string(author, "image"),
            })
        }),
        description: string(app, "description").unwrap_or_default(),
        submitted_at: string(app, "dateCreated"),
        updated_at: string(app, "dateModified"),
        version: string(app, "softwareVersion"),
        views: counters.0,
        downloads: counters.1,
        comments: counters.2,
        reviews: counters.3,
        rating: app.get("aggregateRating").and_then(|rating| {
            Some(JkhubRating {
                value: number_value(rating.get("ratingValue")?)? as f32,
                count: number_value(rating.get("reviewCount").unwrap_or(&Value::Null))
                    .unwrap_or(0.0) as u32,
            })
        }),
        screenshots: screenshots(app),
        tags: tags_of(document.root_element()),
        changelog: changelog(&document),
    })
}

/// Every `application/ld+json` block of the page that parses as JSON.
fn json_ld(document: &Html) -> Vec<Value> {
    document
        .select(&sel("script[type='application/ld+json']"))
        .filter_map(|node| serde_json::from_str::<Value>(&node.text().collect::<String>()).ok())
        .collect()
}

fn type_of(value: &Value) -> Option<&str> {
    value.get("@type").and_then(Value::as_str)
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn number_value(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

/// `(views, downloads, comments, reviews)` from `interactionStatistic`.
fn interaction_counters(app: &Value) -> (u64, u64, u64, u64) {
    let mut counters = (0, 0, 0, 0);
    let Some(list) = app.get("interactionStatistic").and_then(Value::as_array) else {
        return counters;
    };
    for entry in list {
        let kind = entry
            .get("interactionType")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let count = entry
            .get("userInteractionCount")
            .and_then(number_value)
            .unwrap_or(0.0) as u64;
        // The type is a schema.org URL: compare its last segment so that
        // `http://` and `https://` spellings both land.
        match kind.rsplit('/').next().unwrap_or_default() {
            "ViewAction" => counters.0 = count,
            "DownloadAction" => counters.1 = count,
            "CommentAction" => counters.2 = count,
            "ReviewAction" => counters.3 = count,
            _ => {}
        }
    }
    counters
}

fn screenshots(app: &Value) -> Vec<JkhubScreenshot> {
    let Some(list) = app.get("screenshot").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| {
            Some(JkhubScreenshot {
                url: string(entry, "url")?,
                thumbnail_url: entry.get("thumbnail").and_then(|thumb| string(thumb, "url")),
            })
        })
        .collect()
}

/// Category ids, slugs and names named by a `BreadcrumbList`, in page order.
fn breadcrumb_categories(value: &Value) -> Vec<(u32, String, String)> {
    let Some(list) = value.get("itemListElement").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| {
            let item = entry.get("item")?;
            let (id, slug) = category_ref(item.get("@id")?.as_str()?)?;
            Some((id, slug, string(item, "name").unwrap_or_default()))
        })
        .collect()
}

/// Versions the author registered through the version machinery of Downloads.
///
/// Often shorter than the real history: some authors replace the archive
/// without adding an entry (report, section 4).
fn changelog(document: &Html) -> Vec<JkhubChangelogEntry> {
    document
        // The parser lowercases attribute names, so the theme's
        // `data-ipsMenuValue` has to be asked for in lowercase here.
        .select(&sel("#elChangelog_menu li[data-ipsmenuvalue]"))
        .filter_map(|node| {
            let version = node.value().attr("data-ipsmenuvalue")?.to_string();
            let url = node
                .select(&sel("a[href]"))
                .next()
                .and_then(|link| link.value().attr("href"))
                .map(str::to_string);
            Some(JkhubChangelogEntry { version, url })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Download link
// ---------------------------------------------------------------------------

/// Pulls the session's `csrfKey` out of a page.
///
/// The key is bound to the `ips4_IPSSessionFront` cookie the same response
/// set, so it has to be read from the page the download request is made from
/// and never stored (report, section 4). This is the one place the module
/// looks at raw HTML instead of the parsed tree: the key appears in a
/// `<script>` body, which is text, not markup.
pub fn find_csrf_key(html: &str) -> Option<String> {
    for prefix in ["csrfKey: \"", "name=\"csrfKey\" value=\"", "csrfKey="] {
        let mut rest = html;
        while let Some(start) = rest.find(prefix) {
            let tail = &rest[start + prefix.len()..];
            let key: String = tail
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if key.len() >= 16 && key.len() <= 64 {
                return Some(key);
            }
            rest = tail;
        }
    }
    None
}

/// The address the **Download this file** button points at.
pub fn download_url(id: u32, slug: &str, csrf_key: &str) -> String {
    format!("{SITE}/files/file/{id}-{slug}/?do=download&csrfKey={csrf_key}")
}

/// Whether a resolved address is an archive on the site's own file host.
///
/// Not every entry is an upload: a record may point at another site, and
/// those are opened in a browser rather than installed (report, section 4).
pub fn is_hosted_archive(url: &str) -> bool {
    url.starts_with("https://files.jkhub.org/") || url.starts_with("http://files.jkhub.org/")
}

/// Last path segment of an address, percent-decoded.
///
/// `files.jkhub.org` sends no `Content-Disposition`, so this is the only
/// source of the archive's real name (report, section 4).
pub fn file_name_from_url(url: &str) -> Option<String> {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let segment = without_query.trim_end_matches('/').rsplit('/').next()?;
    if segment.is_empty() {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(segment)
        .decode_utf8_lossy()
        .to_string();
    Some(decoded)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// `/files/category/{id}-{slug}/` to `(id, slug)`, ignoring anything else.
pub fn category_ref(href: &str) -> Option<(u32, String)> {
    id_and_slug(href, "/files/category/")
}

/// `/files/file/{id}-{slug}/` to `(id, slug)`.
pub fn file_ref(href: &str) -> Option<(u32, String)> {
    id_and_slug(href, "/files/file/")
}

fn id_and_slug(href: &str, marker: &str) -> Option<(u32, String)> {
    let start = href.find(marker)? + marker.len();
    let rest = &href[start..];
    let segment = rest.split('/').next()?;
    let (id, slug) = segment.split_once('-')?;
    Some((id.parse().ok()?, slug.to_string()))
}

/// Visible text of an element with runs of whitespace collapsed.
fn text_of(element: ElementRef<'_>) -> String {
    let mut out = String::new();
    let mut space = true;
    for chunk in element.text() {
        for ch in chunk.chars() {
            if ch.is_whitespace() || ch == '\u{a0}' {
                if !space {
                    out.push(' ');
                    space = true;
                }
            } else {
                out.push(ch);
                space = false;
            }
        }
    }
    out.trim().to_string()
}

/// First run of digits in a string, with the thousands separators removed.
fn number(text: &str) -> Option<u32> {
    let mut digits = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if (ch == ',' || ch == ' ' || ch == '\u{a0}') && !digits.is_empty() {
            // A separator inside a number keeps the run going; anything else
            // ends it, so "(8 reviews)" reads 8 and not 8 followed by junk.
            continue;
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse().ok()
}

/// Cuts a description on a character boundary and marks the cut.
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATEGORIES: &str = include_str!("../../tests/fixtures/jkhub/categories-all.html");
    const HOME: &str = include_str!("../../tests/fixtures/jkhub/files-home.html");
    const MAPS: &str = include_str!("../../tests/fixtures/jkhub/cat-71-maps.html");
    const FFA: &str = include_str!("../../tests/fixtures/jkhub/cat-13-ffa.html");
    const SABER: &str = include_str!("../../tests/fixtures/jkhub/gp-saber-page.html");
    const LUGORMOD: &str = include_str!("../../tests/fixtures/jkhub/file-2672-lugormod.html");
    const SAITO: &str = include_str!("../../tests/fixtures/jkhub/file-4234-saitohajime.html");

    #[test]
    fn the_category_index_gives_the_four_roots_and_their_children() {
        let roots = parse_category_index(CATEGORIES).expect("the index parses");
        let ids: Vec<u32> = roots.iter().map(|root| root.id).collect();
        assert_eq!(ids, vec![41, 40, 74, 77]);

        let academy = &roots[0];
        assert_eq!(academy.slug, "jedi-academy");
        assert_eq!(academy.name, "Jedi Academy");
        assert_eq!(academy.file_count, Some(3299));
        assert_eq!(academy.children.len(), 17);
        assert!(academy
            .children
            .iter()
            .any(|child| child.id == 71 && child.name == "Maps"));

        let both = &roots[2];
        assert_eq!(both.name, "Both Games/Other");
        assert_eq!(both.children.len(), 2);
        assert_eq!(game_of_root(both.id), Some(JkhubGame::Both));
        assert_eq!(game_of_root(roots[3].id), None, "contest entries have no game");
    }

    #[test]
    fn a_container_category_lists_its_children_with_counts() {
        assert!(says_no_files(MAPS), "Maps holds no files of its own");
        let children = parse_subcategories(MAPS);
        let names: Vec<&str> = children.iter().map(|child| child.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Capture The Flag",
                "Duel",
                "Entity Mods",
                "Free For All",
                "Mixed Gametypes",
                "Other Gamemodes",
                "Siege",
                "Source FIles",
            ]
        );
        let ffa = children.iter().find(|child| child.id == 13).expect("Free For All");
        assert_eq!(ffa.slug, "free-for-all");
        assert_eq!(ffa.file_count, Some(367));
    }

    #[test]
    fn the_downloads_home_page_prints_counts_the_index_does_not() {
        // The trimmed widget on `/files/` is the only page that puts a number
        // next to a child of a game root: the root's own page redirects to a
        // hand-written page with no widget at all.
        let counted = parse_subcategories(HOME);
        let by_id = |id: u32| {
            counted
                .iter()
                .find(|entry| entry.id == id)
                .and_then(|entry| entry.file_count)
        };
        assert_eq!(by_id(41), Some(3299), "Jedi Academy, a root");
        assert_eq!(by_id(38), Some(52), "Audio, a child of that root");
        assert_eq!(by_id(72), Some(73), "Code Mods, a container child");
        assert_eq!(by_id(75), Some(96), "Utilities under Both Games/Other");
        assert_eq!(
            by_id(4),
            None,
            "the widget stops after five children, and Skins is the fourteenth"
        );
    }

    #[test]
    fn a_leaf_category_has_no_children_and_says_nothing_about_being_empty() {
        assert!(!says_no_files(FFA));
        assert!(parse_subcategories(FFA).is_empty());
    }

    #[test]
    fn a_listing_page_gives_twenty_five_cards() {
        let listing = parse_listing(FFA).expect("the listing parses");
        assert_eq!(listing.cards.len(), PER_PAGE as usize);
        assert_eq!(listing.pages, 15);
        assert_eq!(listing.title.as_deref(), Some("Free For All"));

        let first = &listing.cards[0];
        assert_eq!(first.id, 1422);
        assert_eq!(first.slug, "expedition");
        assert_eq!(first.title, "Expedition");
        assert_eq!(first.url, "https://jkhub.org/files/file/1422-expedition/");
        assert_eq!(first.author.as_ref().map(|a| a.name.as_str()), Some("Acrobat"));
        assert_eq!(
            first.author.as_ref().and_then(|a| a.url.as_deref()),
            Some("https://jkhub.org/profile/506-acrobat/")
        );
        assert_eq!(first.downloads, Some(7877));
        assert_eq!(first.date.as_deref(), Some("2026-09-02T14:15:36Z"));
        assert_eq!(first.date_label.as_deref(), Some("Updated"));
        assert!(first.thumbnail_url.as_deref().unwrap().ends_with("120822_8.jpg"));
        assert!(first.description.starts_with("This is an academy map"));
        assert_eq!(
            first.tags,
            vec!["jk2", "climbing map", "botroute support", "forest"],
            "the popup repeats the inline tags and must not double them"
        );
        let rating = first.rating.as_ref().expect("the card shows stars");
        assert_eq!(rating.value, 5.0);
        assert_eq!(rating.count, 8);
    }

    #[test]
    fn a_file_page_gives_the_game_the_category_and_the_counters() {
        let file = parse_file_page(SABER, 1486, "saber-changer").expect("the page parses");
        assert_eq!(file.title, "Saber Changer");
        assert_eq!(file.game, JkhubGame::Ja, "second breadcrumb names the game");
        assert_eq!(file.category_id, Some(32));
        assert_eq!(file.category_name.as_deref(), Some("Configuration Files"));
        assert_eq!(file.version.as_deref(), Some("v1"));
        assert_eq!(file.submitted_at.as_deref(), Some("2013-02-26T05:19:56+0000"));
        assert_eq!(file.updated_at.as_deref(), Some("2013-02-26T15:33:25+0000"));
        assert_eq!(file.author.as_ref().map(|a| a.name.as_str()), Some("Carbon"));
        assert_eq!((file.views, file.downloads), (19245, 564));
        assert_eq!((file.comments, file.reviews), (1, 4));
        let rating = file.rating.as_ref().expect("four reviews mean a rating");
        assert_eq!((rating.value, rating.count), (5.0, 4));
        assert_eq!(file.screenshots.len(), 1);
        assert!(file.screenshots[0].thumbnail_url.is_some());
        assert!(file.description.contains("scrollable list"));
        assert!(file.changelog.is_empty());
    }

    #[test]
    fn a_jedi_outcast_file_reads_as_jedi_outcast() {
        let file = parse_file_page(SAITO, 4234, "saitohajime").expect("the page parses");
        assert_eq!(file.game, JkhubGame::Jo);
        assert!(file.category_name.is_some());
    }

    #[test]
    fn a_registered_version_shows_up_in_the_changelog() {
        let file = parse_file_page(LUGORMOD, 2672, "lugormod").expect("the page parses");
        assert_eq!(file.changelog.len(), 1);
        assert_eq!(file.changelog[0].version, "v3.3.2");
        assert!(file.changelog[0].url.is_some());
    }

    #[test]
    fn the_csrf_key_comes_out_of_the_page_that_will_be_downloaded_from() {
        let key = find_csrf_key(SABER).expect("the page carries a key");
        assert_eq!(key, "47d5ba0ec91e50b52cc7404f6879c43c");
        assert_eq!(
            download_url(1486, "saber-changer", &key),
            "https://jkhub.org/files/file/1486-saber-changer/?do=download&csrfKey=47d5ba0ec91e50b52cc7404f6879c43c"
        );
        assert_eq!(find_csrf_key("<html><body>nothing here</body></html>"), None);
    }

    #[test]
    fn a_page_without_the_structured_block_is_refused_by_name() {
        let error = parse_file_page("<html></html>", 1, "x").expect_err("no JSON-LD");
        assert!(matches!(error, AppError::JkhubParse { .. }), "{error}");
    }

    #[test]
    fn addresses_split_into_an_id_and_a_slug() {
        assert_eq!(
            category_ref("https://jkhub.org/files/category/13-free-for-all/"),
            Some((13, "free-for-all".to_string()))
        );
        assert_eq!(file_ref("/files/file/4234-saitohajime/"), Some((4234, "saitohajime".to_string())));
        assert_eq!(category_ref("https://jkhub.org/jk3files/"), None);
        assert_eq!(file_ref("https://jkhub.org/profile/506-acrobat/"), None);
    }

    #[test]
    fn a_download_address_is_recognised_by_its_host_and_gives_the_file_name() {
        assert!(is_hosted_archive("https://files.jkhub.org/jka/configs/SaberChanger.zip"));
        assert!(!is_hosted_archive("https://mrwonko.de/g2tools/jk3-to-jk2/"));
        assert_eq!(
            file_name_from_url("https://files.jkhub.org/jka/configs/SaberChanger.zip"),
            Some("SaberChanger.zip".to_string())
        );
        assert_eq!(
            file_name_from_url("https://files.jkhub.org/jka/utilities/g2c%202.0.zip"),
            Some("g2c 2.0.zip".to_string()),
            "the path is percent-encoded, the name on disk is not"
        );
        assert_eq!(file_name_from_url("https://mrwonko.de/g2tools/jk3-to-jk2/"), Some("jk3-to-jk2".to_string()));
    }

    #[test]
    fn numbers_survive_the_thousands_separator() {
        assert_eq!(number("7,877 downloads"), Some(7877));
        assert_eq!(number("(8 reviews)"), Some(8));
        assert_eq!(number("3,299"), Some(3299));
        assert_eq!(number("no digits"), None);
    }
}
