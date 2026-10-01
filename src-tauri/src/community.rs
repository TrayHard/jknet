//! Community API bridge. Credentials stay in the native Online client.
//!
//! The webview names a route of `/v1/community/` and this module decides
//! whether the launcher sends it at all: every path of the communities
//! contract is on the list, each id is checked for the shape of a ULID, and
//! the three queries the screens build — the catalogue, the calendar and a
//! page of the news — may only carry the keys and values the service
//! accepts. Anything else never
//! leaves the machine, so a script in the webview cannot use the bridge to
//! reach another route of the service with the player's token.
//!
//! Reads carry the token when the player is signed in: the service then fills
//! the `viewer` half of a page (following, role) and the friend marks of the
//! regular players. Writes, the player's own lists and the administrator's
//! queue need the token and fail before the request without one.
use crate::{
    error::{AppError, Result},
    online::{Auth, OnlineClient, OnlineContext},
    state::AppState,
};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::Value;

#[tauri::command]
pub async fn community_request(
    state: tauri::State<'_, AppState>,
    online: tauri::State<'_, OnlineClient>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let route = route(&method, &path)?;
    // A read never carries a body, and neither does a delete.
    let body = if route.method == reqwest::Method::GET || route.method == reqwest::Method::DELETE {
        None
    } else {
        body
    };
    online
        .community(
            &ctx,
            route.method,
            &format!("/v1/community/{}", route.path),
            body,
            route.auth,
        )
        .await
}

/// A request the bridge lets through: the method, the path with its query
/// rebuilt from the checked pairs, and whether the token goes along.
#[derive(Debug, PartialEq)]
struct Route {
    method: reqwest::Method,
    path: String,
    auth: Auth,
}

/// The tags of the service's closed list (`TAGS` in `community/pages.rs`).
const TAGS: &[&str] = &[
    "ffa",
    "duel",
    "power-duel",
    "team-ffa",
    "ctf",
    "cty",
    "siege",
    "rp",
    "mb2",
    "racing",
    "makermod",
    "clan",
    "training",
    "newbie-friendly",
    "competitive",
    "casual",
];

/// The languages of the service's closed list.
const LANGUAGES: &[&str] = &[
    "en", "ru", "uk", "de", "fr", "es", "pt", "pl", "hu", "it", "tr", "cs", "nl", "sv", "fi",
];

/// The regions of the service's closed list.
const REGIONS: &[&str] = &["eu", "na", "sa", "cis", "asia", "oce", "africa", "me"];

/// The orders of the catalogue the service knows; how each one ranks is the
/// service's. `players` is one the catalogue no longer offers and the
/// service still takes. The service sorts a key it does not know as
/// `featured`.
const SORTS: &[&str] = &[
    "featured",
    "followers",
    "players",
    "regulars",
    "online",
    "new",
    "name",
];

/// Which events the calendar asks for.
const EVENT_SCOPES: &[&str] = &["all", "following", "going"];

/// The longest search a query may carry, in characters.
const MAX_SEARCH: usize = 100;

/// What a query value is escaped with: everything but the unreserved set.
const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// A ULID of the service: 26 letters and digits.
fn id(value: &str) -> bool {
    value.len() == 26 && value.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn refuse() -> AppError {
    AppError::InvalidInput("Unknown community operation".into())
}

fn route(method: &str, path: &str) -> Result<Route> {
    let (path, query) = match path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path, None),
    };
    let parts: Vec<_> = path.split('/').collect();
    let allowed = match (method, parts.as_slice()) {
        // --- the catalogue, the top communities and the player's own lists
        ("GET" | "POST", ["communities"]) => true,
        ("GET", ["ranking"] | ["following"] | ["me"] | ["events"]) => true,
        // --- one community
        ("GET" | "PUT" | "DELETE", ["communities", c]) => id(c),
        ("PUT", ["communities", c, "images" | "admin"]) => id(c),
        ("POST", ["communities", c, "servers" | "transfer"]) => id(c),
        ("PUT" | "DELETE", ["communities", c, "servers", s]) => id(c) && id(s),
        ("PUT" | "DELETE", ["communities", c, "editors", u]) => id(c) && id(u),
        ("PUT" | "DELETE", ["communities", c, "follow"]) => id(c),
        ("GET", ["communities", c, "players" | "discord" | "activity"]) => id(c),
        ("GET" | "POST", ["communities", c, "events" | "posts"]) => id(c),
        // --- the JKNet bot of the community's Discord server
        ("POST", ["communities", c, "discord", "bot", "link"]) => id(c),
        ("PUT" | "DELETE", ["communities", c, "discord", "bot"]) => id(c),
        // --- servers and claims; `servers/{id}` is also the route of before
        ("GET" | "POST", ["servers"]) => true,
        ("GET" | "PUT", ["servers", s]) => id(s),
        ("POST", ["servers", s, "claims"]) => id(s),
        ("POST", ["claims", c, "verify"]) => id(c),
        ("GET", ["admin", "claims"]) => true,
        ("POST", ["admin", "claims", c]) => id(c),
        // --- events and news
        ("GET" | "PUT" | "DELETE", ["events", e]) => id(e),
        ("PUT" | "DELETE", ["events", e, "rsvp"]) => id(e),
        ("GET", ["events", e, "attendees"]) => id(e),
        ("PUT" | "DELETE", ["posts", p]) => id(p),
        _ => false,
    };
    if !allowed {
        return Err(refuse());
    }
    let query = match (method, parts.as_slice(), query) {
        (_, _, None) => None,
        ("GET", ["communities"], Some(query)) => Some(catalogue_query(query)?),
        ("GET", ["events"], Some(query)) => Some(events_query(query)?),
        ("GET", ["communities", _, "posts"], Some(query)) => Some(posts_query(query)?),
        _ => return Err(refuse()),
    };
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| AppError::InvalidInput("Invalid HTTP method".into()))?;
    let own = matches!(
        parts.as_slice(),
        ["me"] | ["following"] | ["admin", "claims"] | ["events", _, "attendees"]
    );
    let auth = if method == reqwest::Method::GET && !own {
        Auth::Optional
    } else {
        Auth::Required
    };
    let path = match query {
        Some(query) if !query.is_empty() => format!("{path}?{query}"),
        _ => path.to_string(),
    };
    Ok(Route { method, path, auth })
}

/// The pairs of a query, each value percent-decoded. A pair without `=`, a
/// key given twice or a value that is not UTF-8 refuses the whole query.
fn pairs(query: &str) -> Result<Vec<(String, String)>> {
    let mut seen: Vec<(String, String)> = Vec::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').ok_or_else(refuse)?;
        let value = percent_decode_str(&value.replace('+', " "))
            .decode_utf8()
            .map_err(|_| refuse())?
            .into_owned();
        if seen.iter().any(|(known, _)| known == key) {
            return Err(refuse());
        }
        seen.push((key.to_string(), value));
    }
    Ok(seen)
}

/// The pairs written back, each value escaped: nothing of the webview's own
/// spelling reaches the service.
fn rebuild(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| format!("{key}={}", utf8_percent_encode(value, QUERY_VALUE)))
        .collect::<Vec<_>>()
        .join("&")
}

/// A count of 1 to 5 digits, the size of a page or where it starts.
fn count(value: &str) -> bool {
    !value.is_empty() && value.len() <= 5 && value.bytes().all(|b| b.is_ascii_digit())
}

/// `GET communities`: `game`, `tag`, `language`, `region`, `q`, `sort`,
/// `limit` and `offset`, each from its list or of its shape.
fn catalogue_query(query: &str) -> Result<String> {
    let pairs = pairs(query)?;
    for (key, value) in &pairs {
        let fits = match key.as_str() {
            "game" => matches!(value.as_str(), "ja" | "jo"),
            "tag" => TAGS.contains(&value.as_str()),
            "language" => LANGUAGES.contains(&value.as_str()),
            "region" => REGIONS.contains(&value.as_str()),
            "sort" => SORTS.contains(&value.as_str()),
            "q" => value.chars().count() <= MAX_SEARCH && !value.chars().any(char::is_control),
            "limit" | "offset" => count(value),
            _ => false,
        };
        if !fits && !value.is_empty() {
            return Err(refuse());
        }
    }
    Ok(rebuild(&pairs))
}

/// A moment of the calendar: an RFC 3339 time or a date, nothing else.
fn moment(value: &str) -> bool {
    (10..=35).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b'.' | b'+' | b'T' | b'Z'))
}

/// A cursor of a list that pages in time order, as the service writes it:
/// `YYYY-MM-DDTHH:MM:SSZ`, `_`, and the id of the last item of the page.
fn cursor(value: &str) -> bool {
    let Some((at, item)) = value.split_once('_') else {
        return false;
    };
    let shape = at.len() == 20
        && at.bytes().enumerate().all(|(index, b)| match index {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            19 => b == b'Z',
            _ => b.is_ascii_digit(),
        });
    shape && id(item)
}

/// `GET events`: `from` and `to`, `scope`, `game`, `community` and the
/// `after` of a page.
fn events_query(query: &str) -> Result<String> {
    let pairs = pairs(query)?;
    for (key, value) in &pairs {
        let fits = match key.as_str() {
            "from" | "to" => moment(value),
            "scope" => EVENT_SCOPES.contains(&value.as_str()),
            "game" => matches!(value.as_str(), "ja" | "jo"),
            "community" => id(value),
            "after" => cursor(value),
            _ => false,
        };
        if !fits && !value.is_empty() {
            return Err(refuse());
        }
    }
    Ok(rebuild(&pairs))
}

/// `GET communities/{id}/posts`: the `limit` of a page and the `before`
/// that names it.
fn posts_query(query: &str) -> Result<String> {
    let pairs = pairs(query)?;
    for (key, value) in &pairs {
        let fits = match key.as_str() {
            "limit" => count(value),
            "before" => cursor(value),
            _ => false,
        };
        if !fits && !value.is_empty() {
            return Err(refuse());
        }
    }
    Ok(rebuild(&pairs))
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: &str = "01M3SZFNW339EQKXRVRMCKHHMZ";
    const S: &str = "01M3SZFNWDPD6WMG05WGKMBSNA";
    const U: &str = "01M3SZFNVWDXSHV4C8PFCGW9W1";

    fn allowed(method: &str, path: &str) -> Route {
        route(method, path).unwrap_or_else(|e| panic!("{method} {path} was refused: {e}"))
    }

    #[test]
    fn limits_bridge_to_community_routes() {
        assert!(route("GET", "servers").is_ok());
        for path in [
            "../me",
            "servers/../../me",
            "servers?token=x",
            "https://example.com",
            "me/extra",
            "communities/../me",
            "communities//follow",
            "",
        ] {
            assert!(route("GET", path).is_err(), "{path} must be refused");
        }
        assert_eq!(allowed("GET", "servers").auth, Auth::Optional);
        assert_eq!(allowed("GET", "me").auth, Auth::Required);
    }

    #[test]
    fn every_route_of_the_contract_goes_through() {
        let routes = [
            ("GET", "communities".to_string()),
            ("POST", "communities".to_string()),
            ("GET", "ranking".to_string()),
            ("GET", format!("communities/{C}")),
            ("PUT", format!("communities/{C}")),
            ("DELETE", format!("communities/{C}")),
            ("PUT", format!("communities/{C}/images")),
            ("PUT", format!("communities/{C}/admin")),
            ("POST", format!("communities/{C}/servers")),
            ("PUT", format!("communities/{C}/servers/{S}")),
            ("DELETE", format!("communities/{C}/servers/{S}")),
            ("POST", format!("servers/{S}/claims")),
            ("POST", format!("claims/{S}/verify")),
            ("GET", "admin/claims".to_string()),
            ("POST", format!("admin/claims/{S}")),
            ("PUT", format!("communities/{C}/editors/{U}")),
            ("DELETE", format!("communities/{C}/editors/{U}")),
            ("POST", format!("communities/{C}/transfer")),
            ("PUT", format!("communities/{C}/follow")),
            ("DELETE", format!("communities/{C}/follow")),
            ("GET", "following".to_string()),
            ("GET", format!("communities/{C}/players")),
            ("GET", format!("communities/{C}/discord")),
            ("GET", format!("communities/{C}/activity")),
            ("GET", "events".to_string()),
            ("GET", format!("events/{S}")),
            ("POST", format!("communities/{C}/events")),
            ("GET", format!("communities/{C}/events")),
            ("PUT", format!("events/{S}")),
            ("DELETE", format!("events/{S}")),
            ("PUT", format!("events/{S}/rsvp")),
            ("DELETE", format!("events/{S}/rsvp")),
            ("GET", format!("events/{S}/attendees")),
            ("GET", format!("communities/{C}/posts")),
            ("POST", format!("communities/{C}/posts")),
            ("PUT", format!("posts/{S}")),
            ("DELETE", format!("posts/{S}")),
            ("POST", format!("communities/{C}/discord/bot/link")),
            ("PUT", format!("communities/{C}/discord/bot")),
            ("DELETE", format!("communities/{C}/discord/bot")),
            ("GET", "me".to_string()),
            // The routes of before, which JKNet 0.10.0 still speaks.
            ("GET", "servers".to_string()),
            ("GET", format!("servers/{C}")),
            ("POST", "servers".to_string()),
            ("PUT", format!("servers/{C}")),
        ];
        for (method, path) in routes {
            let got = allowed(method, &path);
            assert_eq!(got.path, path);
            assert_eq!(got.method.as_str(), method);
        }
    }

    #[test]
    fn a_route_takes_only_its_methods_and_ids_of_the_right_shape() {
        for (method, path) in [
            ("DELETE", "communities".to_string()),
            ("PATCH", format!("communities/{C}")),
            ("POST", format!("communities/{C}/follow")),
            ("GET", format!("communities/{C}/follow")),
            ("DELETE", "following".to_string()),
            ("POST", "ranking".to_string()),
            ("PUT", format!("communities/{C}/players")),
            ("GET", format!("communities/{C}/editors/{U}")),
            ("GET", "communities/short".to_string()),
            ("GET", "communities/01M3SZFNW339EQKXRVRMCKHH-Z".to_string()),
            ("GET", format!("communities/{C}/servers/../{S}")),
            ("PUT", format!("communities/{C}/servers/{S}x")),
            ("GET", format!("communities/{C}/unknown")),
            ("POST", format!("events/{S}/attendees")),
            ("GET", format!("posts/{S}")),
            ("DELETE", "admin/claims".to_string()),
            ("GET", format!("communities/{C}/players/extra")),
            ("TRACE", format!("communities/{C}")),
            ("GET", format!("communities/{C}/discord/bot")),
            ("GET", format!("communities/{C}/discord/bot/link")),
            ("PUT", format!("communities/{C}/discord/bot/link")),
            ("POST", format!("communities/{C}/discord/bot")),
            ("POST", format!("communities/{C}/discord/bot/link/extra")),
            ("DELETE", "communities/short/discord/bot".to_string()),
        ] {
            assert!(route(method, &path).is_err(), "{method} {path} must be refused");
        }
    }

    #[test]
    fn reads_carry_the_token_when_there_is_one_and_writes_need_it() {
        assert_eq!(allowed("GET", "communities").auth, Auth::Optional);
        assert_eq!(allowed("GET", &format!("communities/{C}")).auth, Auth::Optional);
        assert_eq!(allowed("GET", &format!("communities/{C}/players")).auth, Auth::Optional);
        assert_eq!(allowed("GET", &format!("communities/{C}/discord")).auth, Auth::Optional);
        assert_eq!(allowed("GET", &format!("servers/{C}")).auth, Auth::Optional);
        for (method, path) in [
            ("GET", "me".to_string()),
            ("GET", "following".to_string()),
            ("GET", "admin/claims".to_string()),
            ("GET", format!("events/{S}/attendees")),
            ("PUT", format!("communities/{C}/follow")),
            ("DELETE", format!("communities/{C}/follow")),
            ("POST", "communities".to_string()),
            ("PUT", format!("communities/{C}")),
            ("POST", format!("servers/{S}/claims")),
        ] {
            assert_eq!(allowed(method, &path).auth, Auth::Required, "{method} {path}");
        }
    }

    #[test]
    fn the_catalogue_query_keeps_to_its_keys_and_lists() {
        let got = allowed(
            "GET",
            "communities?game=ja&tag=power-duel&language=ru&region=cis&sort=followers&limit=50&offset=0",
        );
        assert_eq!(
            got.path,
            "communities?game=ja&tag=power-duel&language=ru&region=cis&sort=followers&limit=50&offset=0"
        );
        // A search is decoded and written back escaped, in any alphabet.
        let got = allowed("GET", "communities?q=%D0%94%D1%83%D1%8D%D0%BB%D0%B8+%26+FFA");
        assert_eq!(got.path, "communities?q=%D0%94%D1%83%D1%8D%D0%BB%D0%B8%20%26%20FFA");
        // An empty value filters nothing and is left out.
        assert_eq!(allowed("GET", "communities?tag=&q=").path, "communities");
        for query in [
            "tag=pvp",
            "language=xx",
            "region=mars",
            "game=jk3",
            "sort=random",
            "limit=-1",
            "limit=1000000",
            "offset=abc",
            "token=secret",
            "tag=duel&tag=ffa",
            "q",
            "q=%FF",
            "q=a%0Ab",
        ] {
            assert!(
                route("GET", &format!("communities?{query}")).is_err(),
                "{query} must be refused"
            );
        }
        let long = "a".repeat(MAX_SEARCH + 1);
        assert!(route("GET", &format!("communities?q={long}")).is_err());
    }

    #[test]
    fn the_calendar_query_keeps_to_its_keys() {
        let got = allowed(
            "GET",
            &format!("events?from=2026-10-01T00:00:00Z&to=2026-11-01&scope=following&game=jo&community={C}"),
        );
        assert_eq!(
            got.path,
            format!("events?from=2026-10-01T00%3A00%3A00Z&to=2026-11-01&scope=following&game=jo&community={C}")
        );
        for query in [
            "scope=mine",
            "from=yesterday",
            "to=2026-10-01%3Cscript",
            "community=../me",
            "limit=10",
            "after=page2",
            "after=2026-10-03T16%3A00%3A00%2B03%3A00_01M3SZFNW339EQKXRVRMCKHHMZ",
        ] {
            assert!(route("GET", &format!("events?{query}")).is_err(), "{query} must be refused");
        }
        // The `next` of a page reads the page after, written back escaped.
        let got = allowed(
            "GET",
            &format!("events?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&after=2026-10-03T16%3A00%3A00Z_{S}"),
        );
        assert_eq!(
            got.path,
            format!("events?from=2026-10-01T00%3A00%3A00Z&to=2026-11-01T00%3A00%3A00Z&after=2026-10-03T16%3A00%3A00Z_{S}")
        );
    }

    #[test]
    fn a_page_of_the_news_takes_its_limit_and_its_cursor() {
        let got = allowed(
            "GET",
            &format!("communities/{C}/posts?limit=20&before=2026-09-30T23%3A07%3A40Z_{S}"),
        );
        assert_eq!(
            got.path,
            format!("communities/{C}/posts?limit=20&before=2026-09-30T23%3A07%3A40Z_{S}")
        );
        assert_eq!(got.auth, Auth::Optional);
        for query in [
            "limit=-1",
            "limit=abc",
            "before=yesterday",
            "before=2026-09-30T23:07:40Z",
            "before=2026-09-30T23:07:40.5Z_01M3SZFNW339EQKXRVRMCKHHMZ",
            "before=2026-09-30T23:07:40Z_../me",
            "after=2026-09-30T23:07:40Z_01M3SZFNW339EQKXRVRMCKHHMZ",
            "limit=1&limit=2",
        ] {
            assert!(
                route("GET", &format!("communities/{C}/posts?{query}")).is_err(),
                "{query} must be refused"
            );
        }
        assert!(route("POST", &format!("communities/{C}/posts?limit=1")).is_err());
    }

    #[test]
    fn the_bot_routes_are_the_organizers() {
        for (method, path) in [
            ("POST", format!("communities/{C}/discord/bot/link")),
            ("PUT", format!("communities/{C}/discord/bot")),
            ("DELETE", format!("communities/{C}/discord/bot")),
        ] {
            assert_eq!(allowed(method, &path).auth, Auth::Required, "{method} {path}");
        }
        assert_eq!(allowed("GET", &format!("communities/{C}/activity")).auth, Auth::Optional);
    }

    #[test]
    fn only_the_catalogue_the_calendar_and_the_news_take_a_query() {
        for (method, path) in [
            ("GET", format!("communities/{C}?tab=servers")),
            ("GET", format!("communities/{C}/activity?days=7")),
            ("GET", "ranking?period=month".to_string()),
            ("GET", "following?sort=new".to_string()),
            ("POST", "communities?game=ja".to_string()),
            ("GET", "servers?game=ja".to_string()),
        ] {
            assert!(route(method, &path).is_err(), "{method} {path} must be refused");
        }
    }
}
