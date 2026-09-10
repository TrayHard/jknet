//! The wire types of the JKHub module.
//!
//! Every structure here is mirrored one to one in `src/lib/ipc.ts`. Fields are
//! renamed to camelCase by serde, so a name change belongs in both files in
//! the same edit.

use serde::{Deserialize, Serialize};

/// Which game a category or a file belongs to.
///
/// A private enum of this module on purpose. The launcher grows a shared
/// `Game` type in a parallel change; the serde ids are chosen to match it
/// (`"ja"`, `"jo"`), so the merge replaces this type without touching the
/// wire format. `Both` has no counterpart there: it is a property of the
/// JKHub tree, where `Both Games/Other` (74) is a root of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JkhubGame {
    Ja,
    Jo,
    Both,
}

impl JkhubGame {
    /// Whether a category of this game shows up while browsing `game`.
    ///
    /// `Both Games/Other` appears under both games, which is what the site
    /// means by the name.
    pub fn shown_for(self, game: JkhubGame) -> bool {
        self == game || self == JkhubGame::Both || game == JkhubGame::Both
    }

    /// The id used in cache file names.
    pub fn as_str(self) -> &'static str {
        match self {
            JkhubGame::Ja => "ja",
            JkhubGame::Jo => "jo",
            JkhubGame::Both => "both",
        }
    }
}

/// One node of the category tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubCategory {
    pub id: u32,
    pub slug: String,
    pub name: String,
    /// `None` for a root of the tree.
    pub parent_id: Option<u32>,
    pub game: JkhubGame,
    /// Files in the category, `None` when the site did not print a count.
    pub file_count: Option<u32>,
    /// False when the category page says it holds no files of its own, which
    /// is how a container such as Maps (71) behaves.
    pub has_files: bool,
    pub url: String,
}

/// The answer of `jkhub_categories`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubCategories {
    pub game: JkhubGame,
    /// Depth-first: a root, then its children, then their children.
    pub categories: Vec<JkhubCategory>,
    /// RFC 3339 time the tree was read from the site.
    pub fetched_at: String,
    /// True when the site could not be reached and this came out of the cache
    /// past its lifetime.
    pub stale: bool,
}

/// Who uploaded a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubAuthor {
    pub name: String,
    pub url: Option<String>,
    pub avatar_url: Option<String>,
}

/// Stars and how many reviews they average.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubRating {
    pub value: f32,
    pub count: u32,
}

/// One picture of a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubScreenshot {
    pub url: String,
    pub thumbnail_url: Option<String>,
}

/// A version the author registered through the version machinery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubChangelogEntry {
    pub version: String,
    pub url: Option<String>,
}

/// One card of a category listing.
///
/// A card carries less than a file page: no version, no screenshots and no
/// category id. Opening the card fills those in with `jkhub_file`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubCard {
    pub id: u32,
    pub slug: String,
    pub title: String,
    pub url: String,
    pub author: Option<JkhubAuthor>,
    pub thumbnail_url: Option<String>,
    pub description: String,
    pub downloads: Option<u64>,
    /// RFC 3339 time printed on the card.
    pub date: Option<String>,
    /// `Updated` or `Submitted`: which of the two dates the card printed.
    pub date_label: Option<String>,
    pub tags: Vec<String>,
    pub rating: Option<JkhubRating>,
}

/// How a listing is ordered. The values map to the `sortby` parameter of the
/// site (report, section 3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JkhubSort {
    #[default]
    RecentlyUpdated,
    Newest,
    MostDownloaded,
    TopRated,
    Name,
}

impl JkhubSort {
    /// `(sortby, sortdirection)` as the site spells them.
    pub fn query(self) -> (&'static str, &'static str) {
        match self {
            JkhubSort::RecentlyUpdated => ("file_updated", "desc"),
            JkhubSort::Newest => ("file_submitted", "desc"),
            JkhubSort::MostDownloaded => ("file_downloads", "desc"),
            JkhubSort::TopRated => ("file_rating", "desc"),
            JkhubSort::Name => ("file_name", "asc"),
        }
    }

    /// The id used in cache file names.
    pub fn as_str(self) -> &'static str {
        self.query().0
    }
}

/// The answer of `jkhub_list`: one page of one category.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubListing {
    pub category_id: u32,
    pub sort: JkhubSort,
    /// One-based, as the site numbers its pages.
    pub page: u32,
    /// Pages the site announced, so the screen knows whether to offer more.
    pub pages: u32,
    /// Cards per page. Fixed at 25 by the theme; the site accepts no
    /// `perPage` parameter (report, section 3).
    pub per_page: u32,
    pub cards: Vec<JkhubCard>,
    pub fetched_at: String,
    pub stale: bool,
}

/// Everything a file page carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubFile {
    pub id: u32,
    pub slug: String,
    pub title: String,
    pub url: String,
    pub game: JkhubGame,
    pub category_id: Option<u32>,
    pub category_name: Option<String>,
    pub author: Option<JkhubAuthor>,
    /// Plain text: the JSON-LD copy of the description, with the markup of
    /// the site removed. The launcher has no HTML sanitizer and renders this
    /// as paragraphs, never as markup.
    pub description: String,
    pub submitted_at: Option<String>,
    pub updated_at: Option<String>,
    pub version: Option<String>,
    pub views: u64,
    pub downloads: u64,
    pub comments: u64,
    pub reviews: u64,
    pub rating: Option<JkhubRating>,
    pub screenshots: Vec<JkhubScreenshot>,
    pub tags: Vec<String>,
    pub changelog: Vec<JkhubChangelogEntry>,
}

/// The answer of `jkhub_file`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubFileView {
    #[serde(flatten)]
    pub file: JkhubFile,
    pub fetched_at: String,
    pub stale: bool,
}

/// Where the **Download this file** button ends up.
///
/// Downloads records are not always uploads: one of the thirteen files the
/// research checked points at another site instead (report, section 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JkhubDownload {
    /// An archive on `files.jkhub.org`, ready to install.
    Hosted {
        url: String,
        file_name: String,
        size: Option<u64>,
        content_type: Option<String>,
    },
    /// A link to another site. The launcher opens it, it does not install it.
    External { url: String },
}

/// What became of an install attempt.
///
/// The four results a player has to answer travel in the success path, not as
/// an error: an `AppError` reaches the frontend as one string and cannot
/// carry a list of names for the dialog to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JkhubInstallOutcome {
    /// Names of the pk3 files written into the client.
    Installed { files: Vec<String> },
    /// Names already present in the target folder. Call again with
    /// `replace: true` to overwrite them.
    Conflicts { files: Vec<String> },
    /// The archive downloaded and opened, and holds no pk3 at all: a config,
    /// a script or a readme (report, section 7). `archivePath` is on disk so
    /// the screen can reveal it in the file manager.
    NoPk3Files {
        entries: Vec<String>,
        archive_path: String,
    },
    /// The record points at another site.
    External { url: String },
    /// The archive is in a format this build cannot open, `rar` being the
    /// only one so far.
    Unsupported {
        format: String,
        archive_path: Option<String>,
        url: String,
    },
}

/// The answer of `jkhub_install`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubInstallResult {
    pub file_id: u32,
    pub client_id: String,
    /// Folder inside `home\` the files went to: `base` or the client's mod.
    pub folder: String,
    #[serde(flatten)]
    pub outcome: JkhubInstallOutcome,
}

/// What `provenance.json` remembers about one installed file.
///
/// Written next to the pk3 files of a client, read back by the library so a
/// card can say where the file came from and whether JKHub has a newer
/// version of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// Always `jkhub` today. A second source would add its own value.
    pub source: String,
    pub file_id: u32,
    pub version: Option<String>,
    /// `dateModified` of the file page at install time, RFC 3339.
    pub updated_at: Option<String>,
    pub installed_at: String,
    pub title: String,
    pub url: String,
}

/// Payload of `jkhub:download-progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub file_id: u32,
    pub received: u64,
    /// Zero when the server sent no length.
    pub total: u64,
}

/// Payload of `jkhub:installed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledEvent {
    pub file_id: u32,
    pub client_id: String,
    pub files: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_game_ids_are_the_ones_the_launcher_will_share() {
        assert_eq!(serde_json::to_string(&JkhubGame::Ja).unwrap(), "\"ja\"");
        assert_eq!(serde_json::to_string(&JkhubGame::Jo).unwrap(), "\"jo\"");
        assert_eq!(serde_json::to_string(&JkhubGame::Both).unwrap(), "\"both\"");
    }

    #[test]
    fn both_games_categories_are_shown_under_each_game() {
        assert!(JkhubGame::Both.shown_for(JkhubGame::Ja));
        assert!(JkhubGame::Both.shown_for(JkhubGame::Jo));
        assert!(JkhubGame::Ja.shown_for(JkhubGame::Ja));
        assert!(!JkhubGame::Ja.shown_for(JkhubGame::Jo));
    }

    #[test]
    fn every_sort_maps_to_a_parameter_the_site_understands() {
        assert_eq!(JkhubSort::default(), JkhubSort::RecentlyUpdated);
        assert_eq!(JkhubSort::RecentlyUpdated.query(), ("file_updated", "desc"));
        assert_eq!(JkhubSort::Name.query(), ("file_name", "asc"));
        assert_eq!(JkhubSort::TopRated.as_str(), "file_rating");
    }

    #[test]
    fn an_install_result_is_flat_on_the_wire() {
        let json = serde_json::to_value(JkhubInstallResult {
            file_id: 1486,
            client_id: "everyday".into(),
            folder: "base".into(),
            outcome: JkhubInstallOutcome::Installed {
                files: vec!["saber.pk3".into()],
            },
        })
        .expect("it serializes");
        assert_eq!(json["kind"], "installed");
        assert_eq!(json["files"][0], "saber.pk3");
        assert_eq!(json["fileId"], 1486);
    }
}
