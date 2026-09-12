//! The wire types of the JKHub module.
//!
//! Every structure here is mirrored one to one in `src/lib/ipc.ts`. Fields are
//! renamed to camelCase by serde, so a name change belongs in both files in
//! the same edit.

use serde::{Deserialize, Serialize};

use crate::game::Game;

/// Which game a category or a file on JKHub belongs to.
///
/// Not a replacement for [`Game`] and never the game the player browses in:
/// that one is always one of the two the launcher knows, and every command
/// here takes it as a [`Game`]. This enum answers the other question — whose
/// shelf a category or a file sits on — and the site has a third answer for
/// it. `Both Games/Other` (74) is a root of its own, and the files under it
/// belong to Jedi Academy and Jedi Outcast alike.
///
/// The serde ids of the first two are the ids of [`Game`], so the wire format
/// of a category is the same string on both sides of the launcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JkhubGame {
    Ja,
    Jo,
    Both,
}

impl From<Game> for JkhubGame {
    fn from(game: Game) -> Self {
        match game {
            Game::JediAcademy => JkhubGame::Ja,
            Game::JediOutcast => JkhubGame::Jo,
        }
    }
}

impl JkhubGame {
    /// Whether a category of this shelf shows up while browsing `game`.
    ///
    /// `Both` matches either, which is what the site means by the name.
    pub fn matches(self, game: Game) -> bool {
        self == JkhubGame::Both || self == JkhubGame::from(game)
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
    /// Key of the launcher section this node is, for a node of the tree the
    /// screen draws; `None` for a raw site category.
    ///
    /// The screen names a section from `sections.<key>` of `jkhub.json` rather
    /// than from `name`: the eight sections are the launcher's own, and the
    /// site's spelling of them is not. The table behind the key lives in
    /// [`super::sections`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    // --- slice: library polish ---
    /// Site category a section node stands for; `None` for every other node.
    ///
    /// A section node carries an id of the launcher's own (see
    /// [`super::sections::NODE_ID_BASE`]) because it can be the parent of the
    /// very category the site names it after. This is that category: the
    /// address of the shelf on jkhub.org, and the id an entry of the index
    /// carries when the site filed a file on the shelf itself rather than in
    /// a drawer of it. The screen reads it to say which section a card came
    /// out of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_id: Option<u32>,
}

/// The answer of `jkhub_categories`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubCategories {
    /// The game the tree was walked for. One of the launcher's two: the
    /// shelf `Both Games/Other` shows up in either tree, but nobody browses
    /// it on its own.
    pub game: Game,
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
/// A card carries less than a file page: no version and no screenshots.
/// Opening the card fills those in with `jkhub_file`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JkhubCard {
    pub id: u32,
    pub slug: String,
    pub title: String,
    pub url: String,
    /// The category the card came out of.
    ///
    /// `None` from a parsed listing page — a card there says nothing about its
    /// category, and the caller asked for one anyway. The catalogue index
    /// fills it in, because a search crosses categories and every card then has
    /// to say which one it is in.
    #[serde(default)]
    pub category_id: Option<u32>,
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
    /// the site removed and its HTML entities resolved. What the catalogue
    /// index searches, and what the window falls back to when the block below
    /// is empty.
    pub description: String,
    /// --- slice: jkhub details ---
    /// The same description with the author's markup kept, rebuilt from the
    /// allowlist in [`super::richtext`]. Safe to render: no element, attribute
    /// or address reaches this string unless that file names it.
    ///
    /// Empty when the theme moved the block. `serde(default)` because a file
    /// page cached by an older build has no such key, and a cache that fails
    /// to read is a page fetched again for nothing.
    #[serde(default)]
    pub description_html: String,
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
    /// --- slice: jkhub details ---
    /// That same folder as a path on disk, so the toast of a finished install
    /// can reveal the pk3 in the file manager without the screen stitching a
    /// path together out of the client's directory and two names.
    ///
    /// `None` for the one outcome where nothing was written: a record that
    /// points at another site is resolved before a folder is ever touched.
    #[serde(default)]
    pub folder_path: Option<String>,
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
    /// --- slice: jkhub details ---
    /// Name of the archive coming down, as it will land on disk.
    ///
    /// The progress card names what it is fetching, and this is the one place
    /// that knows: `files.jkhub.org` sends no `Content-Disposition`, so the
    /// name is read out of the address and nothing on the screen has it until
    /// the install answers.
    pub file_name: String,
}

/// Payload of `jkhub:installed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledEvent {
    pub file_id: u32,
    pub client_id: String,
    pub files: Vec<String>,
}

/// Payload of `jkhub:categories-updated`.
///
/// Sent when the walk behind an answer produced a newer tree. Carries the game
/// and nothing else: the screen refetches that one tree rather than reading a
/// second copy of it out of an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoriesUpdatedEvent {
    pub game: Game,
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
        assert!(JkhubGame::Both.matches(Game::JediAcademy));
        assert!(JkhubGame::Both.matches(Game::JediOutcast));
        assert!(JkhubGame::Ja.matches(Game::JediAcademy));
        assert!(!JkhubGame::Ja.matches(Game::JediOutcast));
        assert!(JkhubGame::Jo.matches(Game::JediOutcast));
        assert!(!JkhubGame::Jo.matches(Game::JediAcademy));
    }

    #[test]
    fn a_shelf_of_the_core_game_carries_the_id_of_that_game() {
        assert_eq!(JkhubGame::from(Game::JediAcademy), JkhubGame::Ja);
        assert_eq!(JkhubGame::from(Game::JediOutcast), JkhubGame::Jo);
        // The launcher and the site spell the two shared ids the same way,
        // which is what keeps `JkhubCategory.game` readable on both sides.
        assert_eq!(
            serde_json::to_string(&JkhubGame::from(Game::JediAcademy)).unwrap(),
            serde_json::to_string(&Game::JediAcademy).unwrap()
        );
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
            folder_path: Some("C:\\clients\\everyday\\home\\base".into()),
            outcome: JkhubInstallOutcome::Installed {
                files: vec!["saber.pk3".into()],
            },
        })
        .expect("it serializes");
        assert_eq!(json["kind"], "installed");
        assert_eq!(json["files"][0], "saber.pk3");
        assert_eq!(json["fileId"], 1486);
        assert_eq!(json["folderPath"], "C:\\clients\\everyday\\home\\base");
    }
}
