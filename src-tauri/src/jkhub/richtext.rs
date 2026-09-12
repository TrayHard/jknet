//! Turning the description of a jkhub.org file page into markup the launcher
//! is willing to render.
//!
//! The site writes the description with the rich-text editor of Invision
//! Community: paragraphs, lists, links, pictures, quotes and the occasional
//! embedded video. The JSON-LD copy the module used to read has all of that
//! flattened into one line of text, so a list became a run-on sentence and the
//! address of a link vanished with the tag that carried it.
//!
//! Nothing here trusts the page. Every element is matched against an
//! allowlist and rebuilt from scratch; an attribute is copied only when this
//! file names it, and the only attribute values that survive are addresses
//! that start with `http://` or `https://`. What comes out is a string the
//! frontend hands to `dangerouslySetInnerHTML`, and that is the whole reason
//! the work sits in the core: one place to audit, and tests that run without a
//! browser.
//!
//! No HTML sanitizer crate was added for this. `scraper` and `html5ever` are
//! already in the tree for the parsers next door, and a rebuild from an
//! allowlist is both smaller and stricter than configuring a general-purpose
//! one: an element this file does not name cannot reach the output at all.

use scraper::{ElementRef, Node};

/// Where a site-relative address points.
const SITE: &str = "https://jkhub.org";

/// Elements copied through with their children.
///
/// `thead`, `tbody` and `tfoot` are on the list because html5ever inserts a
/// `tbody` around bare rows itself: dropping it would unwrap every row of
/// every table.
const KEPT: &[&str] = &[
    "p",
    "br",
    "ul",
    "ol",
    "li",
    "a",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "img",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "pre",
    "code",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
];

/// Elements with no closing tag in the output.
const VOID: &[&str] = &["br", "img"];

/// Elements dropped with everything inside them.
///
/// Every other unknown element is unwrapped instead — a `div` or a `span`
/// carries text worth keeping. These carry either code or a control, and the
/// text inside them is not prose: `<script>` printed as text would be the
/// author's markup read out loud.
const DROPPED: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "math", "object", "embed", "applet",
    "form", "input", "button", "select", "textarea", "option", "video", "audio", "source",
    "canvas", "link", "meta", "head", "title", "base", "frame", "frameset",
];

/// Class of the notice the site appends to every description.
///
/// The same seven-hundred-character disclaimer sits at the end of every file
/// page, and the site leaves it out of its own JSON-LD copy of the
/// description — so dropping it here keeps the two in step rather than
/// inventing a rule.
const BOILERPLATE_CLASS: &str = "dmca";

/// Cleans one description block, given the element that holds it.
pub fn sanitize_element(root: ElementRef<'_>) -> String {
    let mut out = String::new();
    render_children(root, &mut out);
    out.trim().to_string()
}

/// Cleans a fragment of markup.
///
/// The tests work on strings; the parser next door already holds a parsed
/// document and calls [`sanitize_element`] on the block it found.
#[cfg(test)]
fn sanitize_fragment(html: &str) -> String {
    let document = scraper::Html::parse_fragment(html);
    sanitize_element(document.root_element())
}

fn render_children(parent: ElementRef<'_>, out: &mut String) {
    for child in parent.children() {
        match child.value() {
            Node::Text(text) => escape_text(text, out),
            Node::Element(_) => {
                if let Some(element) = ElementRef::wrap(child) {
                    render_element(element, out);
                }
            }
            // Comments, doctypes and processing instructions carry nothing a
            // reader can see.
            _ => {}
        }
    }
}

fn render_element(element: ElementRef<'_>, out: &mut String) {
    let name = element.value().name().to_ascii_lowercase();
    if DROPPED.contains(&name.as_str()) || is_boilerplate(element) {
        return;
    }

    // An embedded video is the one element that changes shape: the launcher
    // window is not a place to run someone else's player, so the frame becomes
    // a link to the video with the still the site itself publishes for it.
    if name == "iframe" {
        if let Some(id) = element.value().attr("src").and_then(youtube_id) {
            push_video(&id, out);
        }
        return;
    }

    if !KEPT.contains(&name.as_str()) {
        // A `div`, a `span`, an `abbr`: the tag goes, the words stay.
        render_children(element, out);
        return;
    }

    match name.as_str() {
        "img" => {
            let Some(src) = element.value().attr("src").and_then(picture_url) else {
                return;
            };
            out.push_str("<img src=\"");
            escape_attr(&src, out);
            out.push_str("\" alt=\"");
            escape_attr(element.value().attr("alt").unwrap_or_default(), out);
            out.push_str("\" />");
        }
        "a" => {
            let Some(href) = element.value().attr("href").and_then(link_url) else {
                // A link the launcher will not follow is not a link, but its
                // text is still part of the sentence.
                render_children(element, out);
                return;
            };
            out.push_str("<a href=\"");
            escape_attr(&href, out);
            out.push_str("\">");
            render_children(element, out);
            out.push_str("</a>");
        }
        _ => {
            out.push('<');
            out.push_str(&name);
            if VOID.contains(&name.as_str()) {
                out.push_str(" />");
                return;
            }
            out.push('>');
            render_children(element, out);
            out.push_str("</");
            out.push_str(&name);
            out.push('>');
        }
    }
}

/// The link card an embedded video turns into.
///
/// The class is a literal written here, never one copied off the page: the
/// stylesheet needs a hook to draw the play badge over the still, and no
/// attribute of the site's own markup reaches the output.
fn push_video(id: &str, out: &mut String) {
    out.push_str("<a class=\"jkhub-video\" href=\"https://www.youtube.com/watch?v=");
    escape_attr(id, out);
    out.push_str("\"><img src=\"https://img.youtube.com/vi/");
    escape_attr(id, out);
    out.push_str("/hqdefault.jpg\" alt=\"\" /></a>");
}

/// Whether an element is the notice the site appends to every description.
fn is_boilerplate(element: ElementRef<'_>) -> bool {
    element
        .value()
        .attr("class")
        .map(|value| {
            value
                .split_ascii_whitespace()
                .any(|class| class.eq_ignore_ascii_case(BOILERPLATE_CLASS))
        })
        .unwrap_or(false)
}

/// The address of a link, or nothing when it is not one the launcher opens.
///
/// `javascript:`, `data:` and every other scheme are refused by the same
/// clause: only the two that name a page on the web get through. A path
/// without a host is the site's own, which is how the theme writes an internal
/// link.
pub fn link_url(href: &str) -> Option<String> {
    absolute(href).filter(|url| url.starts_with("http://") || url.starts_with("https://"))
}

/// The address of a picture. Stricter than a link on purpose: a picture is
/// fetched by the window itself, and `http://` inside a page served over
/// `tauri://` is a request the webview blocks anyway.
pub fn picture_url(src: &str) -> Option<String> {
    absolute(src).filter(|url| url.starts_with("https://"))
}

fn absolute(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    // A scheme-relative address takes the scheme of the page it came from, and
    // every page of this module arrives over https.
    if let Some(rest) = value.strip_prefix("//") {
        return Some(format!("https://{rest}"));
    }
    if value.starts_with('/') {
        return Some(format!("{SITE}{value}"));
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(value.to_string());
    }
    None
}

/// The video id inside the `src` of an embed, when the host is YouTube.
///
/// Both spellings of the site are accepted, `youtube-nocookie.com` included,
/// because the editor writes either one depending on how the author pasted the
/// address.
pub fn youtube_id(src: &str) -> Option<String> {
    let url = absolute(src)?;
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = match rest.split_once('/') {
        Some((host, path)) => (host, path),
        None => (rest, ""),
    };
    let host = host.trim_start_matches("www.").to_ascii_lowercase();

    let candidate = match host.as_str() {
        "youtube.com" | "youtube-nocookie.com" | "m.youtube.com" => {
            let (segment, query) = split_query(path);
            match segment.split_once('/') {
                Some(("embed" | "v", id)) => id.split('/').next().unwrap_or_default().to_string(),
                _ if segment == "watch" => query_value(query, "v")?,
                _ => return None,
            }
        }
        "youtu.be" => {
            let (segment, _) = split_query(path);
            segment.split('/').next().unwrap_or_default().to_string()
        }
        _ => return None,
    };

    is_video_id(&candidate).then_some(candidate)
}

fn split_query(path: &str) -> (&str, &str) {
    let path = path.split('#').next().unwrap_or(path);
    match path.split_once('?') {
        Some((head, query)) => (head, query),
        None => (path, ""),
    }
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| value.to_string())
    })
}

/// Whether a string looks like a YouTube id and nothing else.
///
/// The charset is what keeps the address this builds free of anything that
/// could steer it somewhere other than youtube.com.
fn is_video_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 24
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn escape_text(text: &str, out: &mut String) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

fn escape_attr(value: &str, out: &mut String) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
}

// ---------------------------------------------------------------------------
// Entities in the plain-text copy
// ---------------------------------------------------------------------------

/// Turns HTML entities in a plain-text string into the characters they name.
///
/// Only the JSON-LD copy of a description needs this, and it needs it because
/// the site encodes that copy twice: the structured block of file 2672 carries
/// `&amp;` where the visible page carries `&`, so the launcher printed
/// «Unlock &amp; upgrade» to the player. The markup path has no such problem —
/// html5ever resolves entities while it parses, and [`escape_text`] writes
/// them back once.
///
/// An entity this table does not know is left exactly as it was found: a
/// half-decoded string is worse than an undecoded one.
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        match entity_at(tail) {
            Some((decoded, length)) => {
                out.push_str(&decoded);
                rest = &tail[length..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The named entities the site's editor writes. Anything longer belongs in a
/// crate, and nothing longer has turned up in a saved page.
const NAMED: &[(&str, char)] = &[
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
    ("nbsp", '\u{a0}'),
    ("reg", '®'),
    ("copy", '©'),
    ("trade", '™'),
    ("hellip", '…'),
    ("mdash", '—'),
    ("ndash", '–'),
    ("lsquo", '\u{2018}'),
    ("rsquo", '\u{2019}'),
    ("ldquo", '\u{201c}'),
    ("rdquo", '\u{201d}'),
    ("bull", '•'),
    ("deg", '°'),
    ("middot", '·'),
    ("laquo", '«'),
    ("raquo", '»'),
];

/// `(text, bytes consumed)` of the entity a string starts with.
fn entity_at(text: &str) -> Option<(String, usize)> {
    let body = text.strip_prefix('&')?;
    let end = body.find(';')?;
    // `&` followed by a paragraph of prose is an ampersand, not an entity.
    if end == 0 || end > 10 {
        return None;
    }
    let name = &body[..end];
    let length = end + 2;

    if let Some(digits) = name.strip_prefix('#') {
        let code = match digits.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => digits.parse::<u32>().ok()?,
        };
        return char::from_u32(code).map(|ch| (ch.to_string(), length));
    }

    NAMED
        .iter()
        .find(|(entity, _)| *entity == name)
        .map(|(_, ch)| (ch.to_string(), length))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tags_of_a_readme_survive_and_the_wrapper_does_not() {
        let clean = sanitize_fragment(
            "<div class='ipsType_richText'><p>Install into <strong>base</strong></p>\
             <ul><li>one</li><li>two</li></ul></div>",
        );
        assert_eq!(
            clean,
            "<p>Install into <strong>base</strong></p><ul><li>one</li><li>two</li></ul>",
            "the div is unwrapped, everything inside it is kept"
        );
    }

    #[test]
    fn a_forbidden_tag_takes_its_contents_with_it() {
        let clean = sanitize_fragment(
            "<p>before</p><script>window.alert('x')</script><style>p{color:red}</style><p>after</p>",
        );
        assert_eq!(clean, "<p>before</p><p>after</p>");
        assert!(!clean.contains("alert"), "the body of a script is not prose");
    }

    #[test]
    fn every_attribute_but_the_named_ones_is_left_behind() {
        let clean = sanitize_fragment(
            "<p class='x' style='color:red' onclick='steal()'>text</p>\
             <a href='https://lugormod.com/' rel='external nofollow' target='_blank' onmouseover='x()'>site</a>",
        );
        assert_eq!(
            clean,
            "<p>text</p><a href=\"https://lugormod.com/\">site</a>",
            "an event handler must not survive the trip"
        );
    }

    #[test]
    fn a_javascript_link_loses_the_tag_and_keeps_the_words() {
        let clean = sanitize_fragment(
            "<a href=\"javascript:alert('x')\">press me</a> and \
             <a href='data:text/html,<b>x</b>'>this</a>",
        );
        assert_eq!(clean, "press me and this");
        assert!(!clean.contains("javascript"), "{clean}");
        assert!(!clean.contains("<a"), "{clean}");
    }

    #[test]
    fn a_relative_address_is_answered_by_the_site_it_came_from() {
        assert_eq!(
            sanitize_fragment("<a href='/dmca/'>here</a>"),
            "<a href=\"https://jkhub.org/dmca/\">here</a>"
        );
        assert_eq!(
            sanitize_fragment("<img src='//jkhub.org/shot.jpg' alt='a map'>"),
            "<img src=\"https://jkhub.org/shot.jpg\" alt=\"a map\" />"
        );
        assert_eq!(
            sanitize_fragment("<img src='http://jkhub.org/shot.jpg'>"),
            "",
            "a picture over plain http is not loaded, and an empty frame is worse than none"
        );
    }

    #[test]
    fn an_embedded_youtube_player_becomes_a_link_with_its_still() {
        let clean = sanitize_fragment(
            "<iframe src='https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0' \
             allowfullscreen width='560'></iframe>",
        );
        assert_eq!(
            clean,
            "<a class=\"jkhub-video\" href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\">\
             <img src=\"https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg\" alt=\"\" /></a>"
        );
        assert!(!clean.contains("<iframe"), "no frame reaches the window");
    }

    #[test]
    fn a_frame_pointing_anywhere_else_is_dropped_whole() {
        assert_eq!(sanitize_fragment("<iframe src='https://evil.example/x'></iframe>"), "");
        assert_eq!(sanitize_fragment("<iframe src='/local'></iframe>"), "");
        assert_eq!(sanitize_fragment("<iframe></iframe>"), "");
    }

    #[test]
    fn the_addresses_youtube_writes_all_give_the_same_id() {
        for src in [
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://youtube.com/embed/dQw4w9WgXcQ?start=30",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1",
            "//www.youtube.com/embed/dQw4w9WgXcQ",
        ] {
            assert_eq!(youtube_id(src).as_deref(), Some("dQw4w9WgXcQ"), "{src}");
        }
        assert_eq!(youtube_id("https://vimeo.com/1234"), None);
        assert_eq!(youtube_id("https://www.youtube.com/embed/../../x"), None);
    }

    #[test]
    fn text_that_looks_like_markup_is_printed_and_not_run() {
        assert_eq!(
            sanitize_fragment("<p>use &lt;script&gt; &amp; hope</p>"),
            "<p>use &lt;script&gt; &amp; hope</p>",
            "html5ever decodes the entity, the writer puts it back once"
        );
    }

    #[test]
    fn the_notice_the_site_appends_to_every_file_is_not_part_of_the_description() {
        let clean = sanitize_fragment(
            "<p>a skin</p><p class=\"ipsType_reset ipsType_light dmca\">This file is not \
             developed, distributed, or endorsed by anyone.</p>",
        );
        assert_eq!(clean, "<p>a skin</p>");
    }

    #[test]
    fn a_table_keeps_the_rows_html5ever_wraps_for_it() {
        let clean = sanitize_fragment("<table><tr><th>key</th><td>value</td></tr></table>");
        assert_eq!(
            clean,
            "<table><tbody><tr><th>key</th><td>value</td></tr></tbody></table>"
        );
    }

    #[test]
    fn the_double_encoded_ampersand_of_the_structured_block_reads_as_one() {
        // The JSON of file 2672 carries `&amp;`, which is the five
        // characters `&amp;` once the JSON is parsed.
        assert_eq!(decode_entities("Unlock &amp; upgrade"), "Unlock & upgrade");
        assert_eq!(decode_entities("Star Wars&reg; and Jedi&trade;"), "Star Wars® and Jedi™");
        assert_eq!(decode_entities("&#39;quoted&#39;"), "'quoted'");
        assert_eq!(decode_entities("&#x2014;"), "—");
        assert_eq!(decode_entities("a &nbsp; b"), "a \u{a0} b");
    }

    #[test]
    fn an_ampersand_that_names_nothing_is_left_where_it_is() {
        assert_eq!(decode_entities("Guns & Explosives"), "Guns & Explosives");
        assert_eq!(decode_entities("&notanentity;"), "&notanentity;");
        assert_eq!(decode_entities("A&B&C"), "A&B&C");
        assert_eq!(decode_entities("plain text"), "plain text");
        assert_eq!(decode_entities("&"), "&");
    }
}
