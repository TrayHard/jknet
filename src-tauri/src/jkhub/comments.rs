//! Public file comments, fetched one page at a time through the shared limiter.

use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths::DataPaths;

use super::{cache, client::JkhubClient, parse, richtext};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubComment {
    pub id: u32,
    pub author: String,
    pub posted_at: Option<String>,
    /// Rebuilt using the same allowlist as the file description.
    pub content_html: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubComments {
    pub items: Vec<JkhubComment>,
    pub page: u32,
    pub pages: u32,
    pub fetched_at: String,
    pub stale: bool,
}

fn sel(value: &str) -> Selector {
    Selector::parse(value).expect("a static comment selector")
}

pub fn parse_comments(html: &str, page: u32) -> Result<JkhubComments> {
    let document = Html::parse_document(html);
    let feed = document
        .select(&sel("[data-commentsType='comments']"))
        .next()
        .ok_or_else(|| AppError::JkhubParse {
            what: "file page has no comments feed".into(),
        })?;
    let pages = feed
        .select(&sel(".ipsPagination[data-pages]"))
        .filter_map(|node| node.value().attr("data-pages")?.parse::<u32>().ok())
        .max()
        .unwrap_or(1)
        .max(1);
    let mut seen = std::collections::HashSet::new();
    let items = feed
        .select(&sel("[data-role='commentFeed'] article.ipsComment"))
        .filter_map(|article| {
            let wrapper = article.select(&sel("[data-commentid]")).next()?;
            let id = wrapper.value().attr("data-commentid")?.parse().ok()?;
            if !seen.insert(id) {
                return None;
            }
            let body = article
                .select(&sel("[data-role='commentContent']"))
                .next()?;
            let author = article
                .select(&sel(".ipsComment_author strong, .ipsComment_author"))
                .next()
                .map(|node| node.text().collect::<Vec<_>>().join(" "))
                .unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let posted_at = article
                .select(&sel(".ipsComment_meta time[datetime]"))
                .next()
                .and_then(|node| node.value().attr("datetime"))
                .map(str::to_string);
            Some(JkhubComment {
                id,
                author,
                posted_at,
                content_html: richtext::sanitize_element(body),
            })
        })
        .collect();
    Ok(JkhubComments {
        items,
        page,
        pages,
        fetched_at: String::new(),
        stale: false,
    })
}

pub async fn fetch(
    client: &JkhubClient,
    data: &DataPaths,
    id: u32,
    slug: &str,
    page: u32,
    refresh: bool,
) -> Result<JkhubComments> {
    let page = page.clamp(1, 10_000);
    let name = format!("comments-{id}-{page}.json");
    let cached = cache::read::<JkhubComments>(data, &name);
    if let Some(entry) = &cached {
        if entry.fresh && !refresh {
            return Ok(JkhubComments {
                fetched_at: entry.fetched_at.clone(),
                ..entry.payload.clone()
            });
        }
    }
    let base = parse::file_url(id, slug);
    let url = if page == 1 {
        format!("{base}?tab=comments")
    } else {
        format!("{base}page/{page}/?tab=comments")
    };
    let fetched = async {
        let response = client.fetch_html(&url).await?;
        let mut comments = parse_comments(&response.body, page)?;
        comments.fetched_at = cache::write(
            data,
            &name,
            &comments,
            cache::ttl_from(response.max_age, cache::PAGE_TTL),
        );
        Ok(comments)
    }
    .await;
    match (fetched, cached) {
        (Ok(comments), _) => Ok(comments),
        (Err(error), Some(entry)) => {
            log::warn!("jkhub: serving stale comments for {id}: {error}");
            Ok(JkhubComments {
                fetched_at: entry.fetched_at,
                stale: true,
                ..entry.payload
            })
        }
        (Err(error), None) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_real_comments_separately_from_reviews() {
        let html = include_str!("../../tests/fixtures/jkhub/comments-2672.html");
        let page = parse_comments(html, 1).unwrap();
        assert_eq!(page.items.len(), 13);
        assert_eq!(page.items[0].id, 6841);
        assert_eq!(page.items[0].author, "the_raven");
        assert_eq!(
            page.items[0].posted_at.as_deref(),
            Some("2016-02-05T16:19:10Z")
        );
        assert!(page.items[0]
            .content_html
            .contains("so what is this exactly?"));
        assert_eq!(page.pages, 1);
        let reviews = include_str!("../../tests/fixtures/jkhub/file-2672-lugormod.html");
        assert!(parse_comments(reviews, 1).is_err());
    }

    #[test]
    fn reads_distinct_live_pages_and_an_empty_feed() {
        let first = parse_comments(
            include_str!("../../tests/fixtures/jkhub/comments-3552.html"),
            1,
        )
        .unwrap();
        let second = parse_comments(
            include_str!("../../tests/fixtures/jkhub/comments-3552-page2.html"),
            2,
        )
        .unwrap();
        assert_eq!((first.items.len(), first.pages), (25, 4));
        assert_eq!((second.items.len(), second.pages), (25, 4));
        assert!(second
            .items
            .iter()
            .all(|comment| !first.items.iter().any(|old| old.id == comment.id)));
        assert!(parse_comments(
            include_str!("../../tests/fixtures/jkhub/comments-empty.html"),
            1
        )
        .unwrap()
        .items
        .is_empty());
    }

    #[test]
    fn scopes_pagination_and_sanitizes_comment_markup() {
        let html = r#"<ul class='ipsPagination' data-pages='99'></ul>
          <div data-commentsType='comments'><ul class='ipsPagination' data-pages='3'></ul>
          <div data-role='commentFeed'><article class='ipsComment'><div data-commentID='10'>
          <h3 class='ipsComment_author'>Guest</h3><div data-role='commentContent'>
          <p onclick='bad()'>Hello<script>bad()</script><a href='javascript:bad()'>link</a></p>
          </div></div></article></div></div>"#;
        let page = parse_comments(html, 2).unwrap();
        assert_eq!((page.page, page.pages), (2, 3));
        assert_eq!(page.items[0].author, "Guest");
        assert!(!page.items[0].content_html.contains("onclick"));
        assert!(!page.items[0].content_html.contains("javascript:"));
        assert!(!page.items[0].content_html.contains("<script"));
        assert!(
            parse_comments("<div data-commentsType='comments'></div>", 1)
                .unwrap()
                .items
                .is_empty()
        );
    }
}
