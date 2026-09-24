//! Wire types of the bundle routes of JKNet Online API v1, and the answers
//! of the catalogue commands.
//!
//! The service side is mirrored one to one, in camelCase, the way
//! `crate::online::types` mirrors accounts and friends rather than the way
//! `crate::community` passes JSON through: a card is drawn on the Clients
//! screen, an install reads the manifest field by field, and a typo in a
//! field name has to fail in a test rather than on a player's screen.
//!
//! Two rules keep the file forward compatible with a service that ships
//! before the launcher does. Enumerations of the contract (`status`, `game`,
//! `sort`) are plain strings, so a status added on the server does not turn
//! every answer into a parse error; and every field the service may leave out
//! carries `#[serde(default)]`, because the contract says both sides ignore
//! what they do not know.
//!
//! The types of drafts live in `draft.rs`, next to the commands that write
//! them.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};

use super::manifest::Manifest;
use crate::engines::LaunchMode;
use crate::game::Game;

/// Reads a field the service may send as `null` into its default: a bundle
/// without a version has no engine yet, and `"engineId": null` must not
/// turn the whole answer into a parse error.
pub(crate) fn or_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

/// The language of a bundle whose answer names none: the default of the
/// contract, which a service from before translations never sends.
pub(crate) const DEFAULT_LANGUAGE: &str = "en";

fn default_language() -> String {
    DEFAULT_LANGUAGE.to_string()
}

/// Reads `language`, which the service may leave out or send as `null` or
/// empty, into the default of the contract rather than into an empty string:
/// a card always has a language, and a draft made out of it needs one.
fn or_default_language<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?
        .filter(|language| !language.trim().is_empty())
        .unwrap_or_else(default_language))
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/// The name, summary and description of a bundle in one more language:
/// `Translation` of the contract, one type for a card and for the details.
/// An empty field means the field is not translated, and the interface shows
/// the main language for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Translation {
    #[serde(default, deserialize_with = "or_default")]
    pub name: String,
    #[serde(default, deserialize_with = "or_default")]
    pub summary: String,
    /// Left out of a card of the catalogue, carried by `BundleDetails`. It is
    /// left out of the JSON again when absent, so a card reaches the
    /// frontend in the shape the service sent it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The author of a bundle, as the catalogue shows them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleOwner {
    #[serde(default, deserialize_with = "or_default")]
    pub id: String,
    #[serde(default, deserialize_with = "or_default")]
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// One component of a version, as the service sums it up for a card:
/// `components[]` of `BundleCard` and `BundleVersion`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSummary {
    #[serde(default, deserialize_with = "or_default")]
    pub id: String,
    #[serde(default, deserialize_with = "or_default")]
    pub label: String,
    #[serde(default, deserialize_with = "or_default")]
    pub engine_id: String,
    #[serde(default)]
    pub release_tag: Option<String>,
    #[serde(default)]
    pub modes: Vec<LaunchMode>,
    /// Overlay files that replace a file of the release.
    #[serde(default)]
    pub replaced: u32,
    /// Overlay files added next to the release.
    #[serde(default)]
    pub added: u32,
    /// Files of the release the install takes out.
    #[serde(default)]
    pub removed: u32,
    #[serde(default)]
    pub file_count: u32,
}

/// One card of the catalogue: `BundleCard` of the contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleCard {
    pub id: String,
    #[serde(default, deserialize_with = "or_default")]
    pub slug: String,
    #[serde(default, deserialize_with = "or_default")]
    pub name: String,
    #[serde(default, deserialize_with = "or_default")]
    pub summary: String,
    /// The language `name`, `summary` and `description` are written in: one
    /// of the languages of the launcher, `en` when the service names none.
    #[serde(default = "default_language", deserialize_with = "or_default_language")]
    pub language: String,
    /// The other languages of the bundle, by code: without `description` on
    /// a card of the catalogue, with it in `BundleDetails`.
    #[serde(default)]
    pub translations: BTreeMap<String, Translation>,
    /// `ja` or `jo`.
    #[serde(default, deserialize_with = "or_default")]
    pub game: String,
    /// The engine of the first component of the latest version.
    #[serde(default, deserialize_with = "or_default")]
    pub engine_id: String,
    #[serde(default)]
    pub release_tag: Option<String>,
    /// The components of the latest version. Empty for a bundle without a
    /// published one.
    #[serde(default)]
    pub components: Vec<ComponentSummary>,
    /// `None` when the owner deleted their account: the service keeps the
    /// bundle and sets the owner to null.
    #[serde(default)]
    pub owner: Option<BundleOwner>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Bytes the service stores for the latest version.
    #[serde(default)]
    pub blob_bytes: u64,
    #[serde(default)]
    pub file_count: u32,
    #[serde(default)]
    pub has_executables: bool,
    #[serde(default)]
    pub featured: bool,
    #[serde(default)]
    pub likes: u64,
    #[serde(default)]
    pub installs: u64,
    #[serde(default)]
    pub latest_version_id: Option<String>,
    #[serde(default)]
    pub latest_label: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default, deserialize_with = "or_default")]
    pub updated_at: String,
    /// Present in answers to a request that carried a token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub liked_by_me: Option<bool>,
}

/// One version without its manifest: `BundleVersionSummary` of the contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleVersionSummary {
    pub id: String,
    #[serde(default, deserialize_with = "or_default")]
    pub bundle_id: String,
    #[serde(default, deserialize_with = "or_default")]
    pub label: String,
    #[serde(default, deserialize_with = "or_default")]
    pub changelog: String,
    /// The engine of the first component.
    #[serde(default, deserialize_with = "or_default")]
    pub engine_id: String,
    #[serde(default)]
    pub release_tag: Option<String>,
    #[serde(default)]
    pub components: Vec<ComponentSummary>,
    #[serde(default)]
    pub file_count: u32,
    #[serde(default)]
    pub blob_bytes: u64,
    #[serde(default)]
    pub has_executables: bool,
    /// `draft`, `pending`, `published` or `rejected`.
    #[serde(default, deserialize_with = "or_default")]
    pub status: String,
    #[serde(default)]
    pub review_note: Option<String>,
    #[serde(default)]
    pub reviewed_by: Option<String>,
    #[serde(default)]
    pub reviewed_at: Option<String>,
    #[serde(default, deserialize_with = "or_default")]
    pub created_at: String,
    #[serde(default)]
    pub published_at: Option<String>,
}

/// One version with its manifest: `BundleVersion` of the contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleVersion {
    #[serde(flatten)]
    pub summary: BundleVersionSummary,
    pub manifest: Manifest,
}

impl BundleVersion {
    pub const DRAFT: &'static str = "draft";
    pub const PENDING: &'static str = "pending";
    pub const PUBLISHED: &'static str = "published";
    pub const REJECTED: &'static str = "rejected";
}

/// One bundle with everything the dialog shows: `BundleDetails` of the
/// contract. The card is flattened into it, so `id`, `name` and the counters
/// sit at the top level next to the description and the versions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleDetails {
    #[serde(flatten)]
    pub card: BundleCard,
    #[serde(default, deserialize_with = "or_default")]
    pub description: String,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub discord: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub revision: u64,
    /// The newest published version, with its manifest. `None` for a bundle
    /// without one, which only its owner and an administrator can see.
    #[serde(default)]
    pub latest: Option<BundleVersion>,
    #[serde(default)]
    pub versions: Vec<BundleVersionSummary>,
    #[serde(default)]
    pub liked_by_me: bool,
}

/// The answer of `GET /v1/bundles`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleList {
    #[serde(default)]
    pub items: Vec<BundleCard>,
    #[serde(default)]
    pub total: u64,
}

/// What `list_bundles` is asked for, as one argument. Mirrored by the query
/// type of `src/lib/ipc.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleQuery {
    /// Leaving it out means the active game, the way every other command
    /// that takes a game behaves.
    #[serde(default)]
    pub game: Option<Game>,
    /// `popular`, `new` or `installs`; `popular` when left out.
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub engine_id: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

/// A client on this machine that points at a bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledClient {
    pub client_id: String,
    /// `None` on a client of a draft of the bundle that was installed before
    /// the draft was published.
    pub version_id: Option<String>,
    pub component_id: String,
    /// `installed`, as the record of the client says.
    pub role: String,
    /// Whether the install of the client is still running or stopped
    /// halfway.
    pub pending: bool,
}

/// What this launcher knows about a bundle that the service cannot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleLocal {
    pub installed_clients: Vec<InstalledClient>,
    /// Component id to whether the registry of this build has its engine,
    /// for the components of the latest version.
    pub engine_known: BTreeMap<String, bool>,
}

/// The answer of `get_bundle`: the details plus the local block.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleView {
    #[serde(flatten)]
    pub details: BundleDetails,
    pub local: BundleLocal,
}

/// The answer of `PUT` and `DELETE /v1/bundles/{id}/like`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LikeResult {
    #[serde(default)]
    pub likes: u64,
    #[serde(default)]
    pub liked_by_me: bool,
}

/// The answer of `POST /v1/bundles/{id}/installs`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallsResult {
    #[serde(default)]
    pub installs: u64,
}

/// The answer of `GET /v1/bundles/me`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyBundles {
    #[serde(default)]
    pub bundles: Vec<BundleDetails>,
    #[serde(default)]
    pub used_bytes: u64,
    #[serde(default)]
    pub quota_bytes: u64,
}

/// One entry of the review queue: a version waiting for a reviewer and the
/// bundle it belongs to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingVersion {
    pub bundle: BundleCard,
    pub version: BundleVersion,
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/// The answer of `publish_bundle_draft`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub bundle: BundleDetails,
    pub version: BundleVersion,
}

/// The answer of `POST /v1/bundles/{id}/versions`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedVersion {
    pub version: BundleVersion,
    #[serde(default)]
    pub missing_blobs: Vec<MissingBlob>,
}

/// One file the service does not hold yet.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingBlob {
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

// ---------------------------------------------------------------------------
// Listings and previews
// ---------------------------------------------------------------------------

/// One entry of a pk3, as the listing names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingEntry {
    /// Forward slashes, as the archive spells it.
    pub path: String,
    /// Uncompressed bytes.
    pub size: u64,
}

/// The listing document itself, as it lies in `listings\` of a draft and in
/// the store of the service: `{ "schema": 1, "entries": [...] }`, the
/// entries sorted by path, folders left out, see
/// [`crate::bundles::listing`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingFile {
    pub schema: u32,
    #[serde(default)]
    pub entries: Vec<ListingEntry>,
}

/// The answer of `draft_file_listing` and `bundle_file_listing`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<ListingEntry>,
    /// Entries of the listing.
    pub total: u64,
    /// Uncompressed bytes of every entry together.
    pub bytes: u64,
}

impl Listing {
    /// The sums of a document, over at most
    /// [`MAX_ENTRIES`](super::listing::MAX_ENTRIES) of its entries: what the
    /// answer holds is bounded here, whoever wrote the document.
    pub fn of(mut file: ListingFile) -> Listing {
        file.entries.truncate(super::listing::MAX_ENTRIES);
        let bytes = file.entries.iter().map(|entry| entry.size).sum();
        Listing {
            total: file.entries.len() as u64,
            bytes,
            entries: file.entries,
        }
    }
}

/// Payload of `bundles:preview-progress`: how far the download of a file of
/// the catalogue a preview asked for has got.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProgress {
    pub sha256: String,
    pub downloaded: u64,
    pub total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_of_the_contract_parses_with_and_without_the_optional_fields() {
        let full: BundleCard = serde_json::from_str(
            r#"{"id":"01J","slug":"rujka","name":"JKA RUJKA Edition","summary":"s",
                "game":"ja","engineId":"eternaljk","releaseTag":"v1.6.3",
                "components":[{"id":"mp","label":"Multiplayer","engineId":"eternaljk","releaseTag":"v1.6.3",
                               "modes":["multiplayer"],"replaced":5,"added":2,"removed":1,"fileCount":12},
                              {"id":"sp","label":"Single player","engineId":"openjk","releaseTag":null,
                               "modes":["single"],"replaced":0,"added":0,"removed":0,"fileCount":2}],
                "owner":{"id":"01U","displayName":"Kyle","avatarUrl":null},
                "tags":["voip","duel"],"blobBytes":90000000,"fileCount":14,"hasExecutables":true,
                "featured":false,"likes":3,"installs":10,"latestVersionId":"01V","latestLabel":"3",
                "publishedAt":"2026-09-15T00:00:00Z","updatedAt":"2026-09-15T00:00:00Z","likedByMe":true}"#,
        )
        .expect("the full card parses");
        assert_eq!(full.owner.as_ref().map(|o| o.display_name.as_str()), Some("Kyle"));
        assert_eq!(full.liked_by_me, Some(true));
        assert!(full.has_executables);
        assert_eq!(full.components.len(), 2);
        assert_eq!(full.components[0].replaced, 5);
        assert_eq!(full.components[1].modes, vec![LaunchMode::Single]);
        assert_eq!(full.components[1].release_tag, None);

        let bare: BundleCard = serde_json::from_str(r#"{"id":"01J","engineId":null}"#)
            .expect("a bare card parses");
        assert_eq!(bare.owner, None);
        assert_eq!(bare.liked_by_me, None);
        assert!(bare.components.is_empty());
        assert_eq!(bare.language, "en", "a service from before translations names no language");
        assert!(bare.translations.is_empty());
        let json = serde_json::to_value(&bare).expect("it serializes");
        assert!(json.get("likedByMe").is_none(), "absent stays absent: {json}");
        assert_eq!(json["engineId"], "");
        assert_eq!(json["language"], "en");
        assert_eq!(json["translations"], serde_json::json!({}));
        let null_language: BundleCard = serde_json::from_str(r#"{"id":"01J","language":null}"#).unwrap();
        assert_eq!(null_language.language, "en");
        let blank_language: BundleCard = serde_json::from_str(r#"{"id":"01J","language":""}"#).unwrap();
        assert_eq!(blank_language.language, "en");
    }

    #[test]
    fn the_translations_of_a_card_come_without_the_description_and_those_of_the_details_with_it() {
        let card: BundleCard = serde_json::from_str(
            r#"{"id":"01J","name":"JKA RUJKA Edition","summary":"Russian edition","language":"ru",
                "translations":{"en":{"name":"JKA RUJKA Edition","summary":"Russian edition"},
                                "uk":{"name":"","summary":"Українське видання"}}}"#,
        )
        .expect("the card parses");
        assert_eq!(card.language, "ru");
        assert_eq!(card.translations.len(), 2);
        assert_eq!(card.translations["en"].summary, "Russian edition");
        assert_eq!(card.translations["en"].description, None);
        assert_eq!(card.translations["uk"].name, "", "an empty field is not translated");
        let json = serde_json::to_value(&card).expect("it serializes");
        assert!(
            json["translations"]["en"].get("description").is_none(),
            "a card reaches the frontend without descriptions: {json}"
        );
        assert_eq!(json["translations"]["uk"]["summary"], "Українське видання");

        let details: BundleDetails = serde_json::from_str(
            r##"{"id":"01J","name":"X","language":"en","description":"# X",
                 "translations":{"ru":{"name":"Икс","summary":"","description":"# Икс"},
                                 "de":{"name":"X","summary":"s","description":null}}}"##,
        )
        .expect("the details parse");
        assert_eq!(details.card.language, "en");
        assert_eq!(details.description, "# X");
        assert_eq!(details.card.translations["ru"].description.as_deref(), Some("# Икс"));
        assert_eq!(details.card.translations["de"].description, None, "null reads as absent");
        let json = serde_json::to_value(&details).expect("it serializes");
        assert_eq!(json["translations"]["ru"]["description"], "# Икс");
        assert_eq!(json["translations"]["ru"]["summary"], "");
        assert!(json["translations"]["de"].get("description").is_none());
        // A translation with null fields reads as empty ones.
        let nulls: Translation = serde_json::from_str(r#"{"name":null,"summary":null}"#).unwrap();
        assert_eq!(nulls, Translation::default());
    }

    #[test]
    fn details_carry_the_card_at_the_top_level_next_to_the_versions() {
        let details: BundleDetails = serde_json::from_str(
            r#"{"id":"01J","slug":"x","name":"X","game":"ja","engineId":"openjk",
                "description":"long","website":"https://example.com","discord":null,"revision":2,
                "latest":{"id":"01V","bundleId":"01J","label":"1","status":"published",
                          "components":[{"id":"sp","label":"SP","engineId":"openjk","modes":["single"]}],
                          "manifest":{"schema":2,"game":"ja","components":[{"id":"sp","label":"SP",
                                      "engine":{"engineId":"openjk"},"modes":["single"]}]}},
                "versions":[{"id":"01V","status":"published"},{"id":"01W","status":"pending"}],
                "likedByMe":false}"#,
        )
        .expect("details parse");
        assert_eq!(details.card.id, "01J");
        assert_eq!(details.card.engine_id, "openjk");
        assert_eq!(details.description, "long");
        assert_eq!(details.revision, 2);
        let latest = details.latest.as_ref().expect("a latest version");
        assert_eq!(latest.summary.id, "01V");
        assert_eq!(latest.summary.status, BundleVersion::PUBLISHED);
        assert_eq!(latest.summary.components[0].id, "sp");
        assert_eq!(latest.manifest.components[0].engine.engine_id, "openjk");
        assert_eq!(details.versions.len(), 2);

        // On the way to the frontend the card stays flat and the local block
        // sits next to it.
        let view = BundleView {
            details,
            local: BundleLocal {
                installed_clients: vec![InstalledClient {
                    client_id: "x".into(),
                    version_id: Some("01V".into()),
                    component_id: "sp".into(),
                    role: "installed".into(),
                    pending: false,
                }],
                engine_known: BTreeMap::from([("sp".to_string(), true)]),
            },
        };
        let json = serde_json::to_value(&view).expect("it serializes");
        assert_eq!(json["id"], "01J");
        assert_eq!(json["latest"]["manifest"]["schema"], 2);
        assert_eq!(json["local"]["engineKnown"]["sp"], true);
        assert_eq!(json["local"]["installedClients"][0]["clientId"], "x");
        assert_eq!(json["local"]["installedClients"][0]["componentId"], "sp");
        assert_eq!(json["local"]["installedClients"][0]["pending"], false);
    }
}
