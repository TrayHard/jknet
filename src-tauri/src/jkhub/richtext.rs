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

/// What every picture of a description is written with, after its `alt`.
///
/// Both values are the launcher's, not the page's. jkhub.org answers `403` to
/// a request for one of its own screenshots that carries a `Referer`, and the
/// window's origin is `tauri://localhost` — so a picture without this loads on
/// the site and fails here. The screenshots of the dialog carry the same
/// policy, and so does `index.html` for the page as a whole; this repeats it
/// on the element because the markup is inserted as a string and no React prop
/// reaches it.
const PICTURE_ATTRS: &str = "\" loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\" />";

/// Class of the notice the site appends to every description.
///
/// The same seven-hundred-character disclaimer sits at the end of every file
/// page, and the site leaves it out of its own JSON-LD copy of the
/// description — so dropping it here keeps the two in step rather than
/// inventing a rule.
const BOILERPLATE_CLASS: &str = "dmca";

/// Longest run of markup one description may produce, in bytes.
///
/// Both text copies of a description have had a ceiling from the start —
/// `MAX_CARD_DESCRIPTION` in `parse.rs`, `MAX_DESCRIPTION` in `index.rs` —
/// and this one had none, although it travels furthest of the three: it sits
/// in the file cache for half an hour and reaches the window as a single
/// `dangerouslySetInnerHTML`. The page writes the description, so its length
/// is the site's to decide and not the launcher's to trust.
///
/// The number is a guard rail rather than a layout rule: no description read
/// off jkhub.org comes close, and a page that does is one nobody scrolls to
/// the end of anyway.
const MAX_HTML: usize = 256 * 1024;

/// What closes a description the budget cut short.
///
/// An ellipsis and not a sentence: this file knows nothing of the player's
/// language, and adding a translated string would mean carrying one through
/// the core to a string built from an allowlist. Three dots read the same in
/// all eight catalogs. The class is a literal written here, like
/// `jkhub-video`, never one copied off the page.
const CUT_MARK: &str = "<p class=\"jkhub-cut\">…</p>";

/// Cleans one description block, given the element that holds it.
pub fn sanitize_element(root: ElementRef<'_>) -> String {
    let mut out = Sink::default();
    render_children(root, &mut out);
    if out.cut {
        out.html.push_str(CUT_MARK);
    }
    out.html.trim().to_string()
}

/// The markup as it is built, plus the one thing the string cannot say for
/// itself: whether [`MAX_HTML`] ended the description early.
#[derive(Default)]
struct Sink {
    html: String,
    cut: bool,
}

impl Sink {
    /// Whether the budget is spent, asked once before each child.
    ///
    /// A cut therefore always falls between two nodes, never inside a tag or
    /// halfway through an address, and every element already open still gets
    /// its closing tag written on the way back out. The overshoot is one
    /// node: whatever the last child of the description happened to hold.
    fn full(&mut self) -> bool {
        self.cut |= self.html.len() >= MAX_HTML;
        self.cut
    }
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

fn render_children(parent: ElementRef<'_>, out: &mut Sink) {
    for child in parent.children() {
        if out.full() {
            break;
        }
        match child.value() {
            Node::Text(text) => escape_text(text, &mut out.html),
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

fn render_element(element: ElementRef<'_>, out: &mut Sink) {
    let name = element.value().name().to_ascii_lowercase();
    if DROPPED.contains(&name.as_str()) || is_boilerplate(element) {
        return;
    }

    // An embedded video is the one element that changes shape: the launcher
    // window is not a place to run someone else's player, so the frame becomes
    // a link to the video with the still the site itself publishes for it.
    //
    // --- slice: library polish ---
    // The address is read from `data-embed-src` as well as from `src`, and
    // that is where jkhub.org actually keeps it: the theme of Invision
    // Community ships the frame empty and lets its own JavaScript fill `src`
    // in the browser. Nothing here runs JavaScript, so every video of every
    // description was being dropped — all three of «Music Replacement Pack:
    // Star Wars Visions» (file 4471) among them, which is the page the
    // complaint came from. The wrappers the theme puts around the frame —
    // `div.ipsEmbeddedVideo`, and a `div` with a `data-controller` on it —
    // need no rule of their own: an unknown element is unwrapped and the
    // walk reaches the frame inside it.
    if name == "iframe" {
        let source = element
            .value()
            .attr("src")
            .or_else(|| element.value().attr("data-embed-src"));
        if let Some(id) = source.and_then(youtube_id) {
            push_video(&id, &mut out.html);
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
            out.html.push_str("<img src=\"");
            escape_attr(&src, &mut out.html);
            out.html.push_str("\" alt=\"");
            escape_attr(
                element.value().attr("alt").unwrap_or_default(),
                &mut out.html,
            );
            out.html.push_str(PICTURE_ATTRS);
        }
        "a" => {
            let Some(href) = element.value().attr("href").and_then(link_url) else {
                // A link the launcher will not follow is not a link, but its
                // text is still part of the sentence.
                render_children(element, out);
                return;
            };
            // --- slice: library polish ---
            // The other shape an embed arrives in: a placeholder the site
            // means to replace with a player, and a bare address the editor
            // never got to. Both become the same card as a frame does.
            if let Some(id) = video_of_link(element, &href) {
                push_video(&id, &mut out.html);
                return;
            }
            out.html.push_str("<a href=\"");
            escape_attr(&href, &mut out.html);
            out.html.push_str("\">");
            render_children(element, out);
            out.html.push_str("</a>");
        }
        _ => {
            out.html.push('<');
            out.html.push_str(&name);
            if VOID.contains(&name.as_str()) {
                out.html.push_str(" />");
                return;
            }
            out.html.push('>');
            render_children(element, out);
            out.html.push_str("</");
            out.html.push_str(&name);
            out.html.push('>');
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
    out.push_str("/hqdefault.jpg\" alt=\"");
    out.push_str(PICTURE_ATTRS);
    out.push_str("</a>");
}

/// The video an anchor stands for, or nothing when it is a word with a link
/// on it.
///
/// --- slice: library polish ---
/// Two shapes, both made by the editor of Invision Community:
///
/// * an anchor the site marked as an embed it will swap for a player —
///   `data-embedcontent` is what the theme writes today, `data-embed` what
///   older posts carry;
/// * an anchor that is the address and nothing else, which is a link the
///   author pasted and the editor never converted.
///
/// An anchor with words in it stays a link. The author wrote a sentence, and
/// a thumbnail in place of one would be the launcher rewriting prose.
fn video_of_link(element: ElementRef<'_>, href: &str) -> Option<String> {
    let value = element.value();
    let marked = value.attr("data-embedcontent").is_some() || value.attr("data-embed").is_some();
    let text = element.text().collect::<String>();
    let text = text.trim();
    // Against the resolved address and against the one the page wrote, so a
    // scheme-relative `//youtu.be/…` still reads as bare.
    let bare = text == href || value.attr("href").is_some_and(|raw| raw.trim() == text);
    (marked || bare).then(|| youtube_id(href)).flatten()
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
            "<img src=\"https://jkhub.org/shot.jpg\" alt=\"a map\" loading=\"lazy\" \
             decoding=\"async\" referrerpolicy=\"no-referrer\" />"
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
             <img src=\"https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg\" alt=\"\" \
             loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\" /></a>"
        );
        assert!(!clean.contains("<iframe"), "no frame reaches the window");
    }

    #[test]
    fn a_frame_pointing_anywhere_else_is_dropped_whole() {
        assert_eq!(sanitize_fragment("<iframe src='https://evil.example/x'></iframe>"), "");
        assert_eq!(sanitize_fragment("<iframe src='/local'></iframe>"), "");
        assert_eq!(sanitize_fragment("<iframe></iframe>"), "");
        assert_eq!(
            sanitize_fragment("<iframe data-embed-src='https://evil.example/x'></iframe>"),
            "",
            "the lazy attribute is held to the same hosts as the plain one"
        );
    }

    /// --- slice: library polish ---
    /// The markup jkhub.org actually serves, copied out of file 4471 — the
    /// page whose three previews the window showed nothing of. The theme
    /// ships the frame with no `src` at all and fills it in the browser;
    /// nothing here runs its JavaScript, so the address has to be read where
    /// the server left it.
    #[test]
    fn a_lazily_loaded_embed_is_read_from_data_embed_src() {
        let clean = sanitize_fragment(
            "<div class=\"ipsEmbeddedVideo\" contenteditable=\"false\"><div>\
             <iframe allowfullscreen=\"\" frameborder=\"0\" height=\"150\" \
             title=\"The Twin Star Destroyer\" width=\"200\" \
             data-embed-src=\"https://www.youtube-nocookie.com/embed/k6aUNGhUE0c?feature=oembed\">\
             </iframe></div></div>",
        );
        assert_eq!(
            clean,
            "<a class=\"jkhub-video\" href=\"https://www.youtube.com/watch?v=k6aUNGhUE0c\">\
             <img src=\"https://img.youtube.com/vi/k6aUNGhUE0c/hqdefault.jpg\" alt=\"\" \
             loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\" /></a>"
        );
        assert!(!clean.contains("<iframe"), "no frame reaches the window");
    }

    /// --- slice: library polish ---
    /// The two anchors that are an embed rather than a word with a link on
    /// it, and the one that is neither.
    #[test]
    fn an_anchor_becomes_a_card_when_it_is_the_embed_and_not_a_word() {
        let card = "<a class=\"jkhub-video\" href=\"https://www.youtube.com/watch?v=k6aUNGhUE0c\">\
                    <img src=\"https://img.youtube.com/vi/k6aUNGhUE0c/hqdefault.jpg\" alt=\"\" \
                    loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\" /></a>";
        assert_eq!(
            sanitize_fragment(
                "<a href='https://www.youtube.com/watch?v=k6aUNGhUE0c' \
                 data-embedcontent=''>The Twin Star Destroyer</a>"
            ),
            card,
            "the site said it would put a player here"
        );
        assert_eq!(
            sanitize_fragment(
                "<a href='https://youtu.be/k6aUNGhUE0c'>https://youtu.be/k6aUNGhUE0c</a>"
            ),
            card,
            "an address pasted as an address loses no words to the card"
        );
        assert_eq!(
            sanitize_fragment(
                "<a href='https://www.youtube.com/watch?v=k6aUNGhUE0c'>watch the trailer</a>"
            ),
            "<a href=\"https://www.youtube.com/watch?v=k6aUNGhUE0c\">watch the trailer</a>",
            "a sentence with a link on it stays a sentence"
        );
        assert_eq!(
            sanitize_fragment("<a href='https://jkhub.org/x' data-embedcontent=''>x</a>"),
            "<a href=\"https://jkhub.org/x\">x</a>",
            "and an embed of anything but a video is left as the link it is"
        );
    }

    /// --- slice: library polish ---
    /// The rule that turns a pasted address into a card runs that address
    /// through [`youtube_id`], so it reaches four hosts and no further. An
    /// address of any other site is a link the author put in the text, and
    /// nothing here may turn it into a picture with a play button on it.
    #[test]
    fn a_bare_link_to_anywhere_but_youtube_stays_a_link() {
        assert_eq!(
            sanitize_fragment("<a href='https://example.com/x'>https://example.com/x</a>"),
            "<a href=\"https://example.com/x\">https://example.com/x</a>",
            "an unmarked address is a card only when it is a video"
        );
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

    #[test]
    fn a_description_within_the_budget_is_not_marked_as_cut() {
        let clean = sanitize_fragment("<p>a readme of ordinary length</p>");
        assert_eq!(clean, "<p>a readme of ordinary length</p>");
        assert!(
            !clean.contains("jkhub-cut"),
            "the mark belongs to a description that was actually shortened"
        );
    }

    #[test]
    fn a_description_past_the_budget_is_cut_between_two_elements() {
        let paragraph = "<p>the readme goes on and on</p>";
        let clean = sanitize_fragment(&paragraph.repeat(20_000));

        assert!(
            clean.len() <= MAX_HTML + paragraph.len() + CUT_MARK.len(),
            "the output stays within the budget plus the node that crossed it, got {}",
            clean.len()
        );
        assert!(
            clean.len() > MAX_HTML - paragraph.len(),
            "everything up to the budget is kept, got {}",
            clean.len()
        );
        assert!(
            clean.ends_with(CUT_MARK),
            "the reader is told the description goes on"
        );
        assert_eq!(
            clean.matches("<p").count(),
            clean.matches("</p>").count(),
            "the cut never lands inside a tag"
        );
    }

    #[test]
    fn a_cut_inside_a_list_still_closes_the_list() {
        let item = "<li>one line of a list that never ends</li>";
        let clean = sanitize_fragment(&format!("<ul>{}</ul><p>after</p>", item.repeat(20_000)));

        assert!(clean.ends_with(CUT_MARK));
        assert!(
            clean.contains("</ul>"),
            "the element the cut fell inside is closed on the way out"
        );
        assert!(
            !clean.contains("<p>after</p>"),
            "what follows a spent budget is left out"
        );
        assert_eq!(
            clean.matches("<li>").count(),
            clean.matches("</li>").count(),
            "every item that opened also closed"
        );
    }
}
