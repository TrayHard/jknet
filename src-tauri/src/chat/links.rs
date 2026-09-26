//! Links of messages: which open at once, which ask first, and how they open.
//!
//! A message is text another player wrote, and so is the address behind a
//! link in it. The thread draws `http://` and `https://` addresses as links
//! and nothing else; opening one is this module's job, and it checks the
//! address again rather than trust the window:
//!
//! - `http` and `https` only, at most 2048 characters, with a host, and
//!   without white space or control characters, which a URL parser would
//!   quietly drop;
//! - `jknet.app`, `jkhub.org` and their subdomains open at once; any other
//!   host and an IP address need `confirmed`, which the window sets after its
//!   dialog named the host. The host decides, as in `isTrustedLink` of the
//!   thread: `https://jkhub.org@example.com/` goes to example.com and asks;
//!   a user name in front of a trusted host still goes to that host;
//! - the address that opens is the one the parser wrote back, so the browser
//!   gets exactly what was checked. It opens in the system browser through
//!   the opener plugin; nothing opens inside the launcher.
//!
//! An address that needs confirmation is refused as `online` with
//! `details.code` [`CONFIRM_LINK`] and the host as `details.message`, the way
//! a save that needs confirmation is.

use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, Result};

use super::cards::is_bidi_control;

/// The code of the refusal of a link that has to be confirmed first.
pub const CONFIRM_LINK: &str = "confirm_link";

/// The longest address the launcher opens, the limit of the thread too.
pub const MAX_LINK_CHARS: usize = 2048;

/// Hosts a link opens without asking first: the launcher's own site and
/// JKHub, and their subdomains.
const TRUSTED_HOSTS: [&str; 2] = ["jknet.app", "jkhub.org"];

/// An address that may open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Link {
    /// The address as the parser writes it back: what opens.
    pub url: String,
    /// The host, lower case, as a confirmation names it.
    pub host: String,
    /// Opens without asking.
    pub trusted: bool,
}

/// Checks an address of a message. A refusal is an address that never
/// opens, confirmed or not.
pub(crate) fn check_link(raw: &str) -> Result<Link> {
    if raw.chars().count() > MAX_LINK_CHARS {
        return Err(AppError::InvalidInput(format!(
            "a link is at most {MAX_LINK_CHARS} characters"
        )));
    }
    if raw.is_empty()
        || raw
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || is_bidi_control(c))
    {
        return Err(AppError::InvalidInput(
            "a link cannot be empty or hold spaces or control characters".into(),
        ));
    }
    let url = Url::parse(raw).map_err(|e| AppError::InvalidInput(format!("not a link: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::InvalidInput(format!(
            "only http and https links open, not {}",
            url.scheme()
        )));
    }
    let host = url
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .ok_or_else(|| AppError::InvalidInput("a link without a host".into()))?;
    // `domain()` is `None` for an IP address: those always ask.
    let trusted = url.domain().is_some()
        && TRUSTED_HOSTS
            .iter()
            .any(|trusted| host == *trusted || host.ends_with(&format!(".{trusted}")));
    Ok(Link {
        url: url.to_string(),
        host,
        trusted,
    })
}

/// Opens a link of a message in the system browser. A host other than
/// jknet.app and jkhub.org needs `confirmed`; without it the answer is
/// `online` with `details.code` `confirm_link` and the host as its message.
#[tauri::command]
pub async fn chat_open_link(app: AppHandle, url: String, confirmed: bool) -> Result<()> {
    let link = check_link(&url)?;
    if !link.trusted && !confirmed {
        return Err(AppError::Online {
            code: CONFIRM_LINK.to_string(),
            message: link.host,
        });
    }
    app.opener()
        .open_url(link.url.clone(), None::<&str>)
        .map_err(|e| AppError::Launch(format!("the system browser did not open the link: {e}")))?;
    // The host only: the rest of an address may carry a token of a site.
    log::info!("chat: opened a link to {}", link.host);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trusted(raw: &str) -> bool {
        check_link(raw).expect("a link").trusted
    }

    #[test]
    fn the_project_sites_and_their_subdomains_open_at_once() {
        for raw in [
            "https://jknet.app",
            "https://jknet.app/ru/#download",
            "http://jkhub.org/files/file/1234-duel-sabers/",
            "https://www.jkhub.org/",
            "https://docs.jknet.app/guide",
            "https://JKHub.org/",
            "https://jknet.app./",
            "https://jkhub.org:443/",
            // The host decides, as in the thread: this still goes to JKHub.
            "https://user@jkhub.org/",
        ] {
            assert!(trusted(raw), "{raw} opens at once");
        }
    }

    #[test]
    fn every_other_host_asks_first() {
        for raw in [
            "https://example.com/",
            "https://jknet.app.example.com/",
            "https://notjknet.app/",
            "https://jkhub.org.example.com/path",
            "https://jkhub.org@example.com/",
            "https://jknet.app:pass@example.com/",
            "http://203.0.113.5:8080/",
            "http://[2001:db8::1]/",
            // A look-alike letter is another host.
            "https://jknеt.app/",
        ] {
            assert!(!trusted(raw), "{raw} asks first");
        }
        assert_eq!(
            check_link("https://jkhub.org@example.com/").unwrap().host,
            "example.com"
        );
    }

    #[test]
    fn only_web_addresses_open_at_all() {
        for raw in [
            "",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "steam://run/6020",
            "ftp://example.com/",
            "data:text/html,hi",
            "https://",
            "https:// jknet.app",
            "https://jk\thub.org/",
            "https://jk\nhub.org/",
            "https://jknet.app/\u{202E}gpj.exe",
            "not a link",
        ] {
            assert!(check_link(raw).is_err(), "{raw:?} never opens");
        }
        let long = format!("https://jknet.app/{}", "a".repeat(MAX_LINK_CHARS));
        assert!(check_link(&long).is_err());
        let fits = format!("https://jknet.app/{}", "a".repeat(MAX_LINK_CHARS - 18));
        assert!(check_link(&fits).is_ok());
    }

    #[test]
    fn what_opens_is_what_the_parser_wrote_back() {
        let link = check_link("https://JKHub.org/files/../search?q=\"duel\"").unwrap();
        assert_eq!(link.url, "https://jkhub.org/search?q=%22duel%22");
        // A backslash is a slash to a browser, so it is one here too.
        let link = check_link("https://jknet.app\\@example.com/").unwrap();
        assert_eq!((link.host.as_str(), link.trusted), ("jknet.app", true));
        assert_eq!(link.url, "https://jknet.app/@example.com/");
    }
}
