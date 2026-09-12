//! The eight sections of the JKHub catalogue the launcher shows.
//!
//! jkhub.org sorts its files into about twenty categories per game, and most
//! of them are not a file a player installs into a client: demos, frag
//! movies, configuration files, prefabs, map sources, utilities. The launcher
//! carries eight sections instead, and [`SECTIONS`] is the only place that
//! says which site categories each of them is made of.
//!
//! Everything downstream reads this table and nothing else:
//!
//! | Step | What the table decides |
//! | ---- | ---------------------- |
//! | [`super::source::crawl_tree`] | which category pages the walk visits at all |
//! | [`prune`] | which nodes survive in a cached or bundled tree |
//! | [`tree`] | the eight nodes the screen draws |
//! | [`super::index::crawl`] | which listings are read, and under which section a file lands |
//! | [`retain`] | which entries of an older index on disk are still catalogue |
//!
//! Two consequences worth naming. A section is one node even when the site
//! spells it as two — **Skins** and **Player Models** are one **Skins & Player
//! Models** with one count — and a section can be empty for one game: Jedi
//! Outcast has no NPCs category at all, so that section is absent from its
//! tree rather than shown at zero.
//!
//! Names come from `src/locales/*/jkhub.json` through [`Section::key`], not
//! from the site: the launcher names its own shelves, and the site's spelling
//! («Lightsabers & Melee», «Source FIles» with the typo it has carried for
//! years) is not the launcher's to inherit.

use crate::game::Game;

use super::types::{JkhubCategory, JkhubGame};

/// One section of the launcher's catalogue.
///
/// The first id of a game's list is the section's own id: the node the tree
/// draws carries it, an entry of the index carries it as `category_id`, and
/// narrowing a search to the section narrows to it. Choosing a real site id
/// rather than inventing one keeps `category_id` a thing the site knows, so a
/// listing page of the section still has an address.
pub struct Section {
    /// Stable key of the section. The locale key under `sections` of
    /// `jkhub.json`, and what the wire carries in `JkhubCategory::section`.
    pub key: &'static str,
    /// English name, and the fallback for a screen without a catalog loaded.
    pub name: &'static str,
    /// Site categories of Jedi Academy, the first being the section's id.
    pub ja: &'static [u32],
    /// The same for Jedi Outcast. Empty when the site has no such category.
    pub jo: &'static [u32],
}

impl Section {
    /// Site categories this section is made of in one game.
    pub fn ids(&self, game: Game) -> &'static [u32] {
        match game {
            Game::JediAcademy => self.ja,
            Game::JediOutcast => self.jo,
        }
    }

    /// The id the tree, the index and a search use for this section, or `None`
    /// when the game has no such category.
    pub fn id(&self, game: Game) -> Option<u32> {
        self.ids(game).first().copied()
    }
}

/// Launcher section to site categories, for both games.
///
/// The ids are the ones the snapshot of 10 September 2026 carries, and the
/// test `every_site_id_of_the_table_exists_in_the_bundled_tree` fails the day
/// one of them stops existing. Three of the site's categories are named here
/// only to say they are left out:
///
/// * `35` and `63` **Source Files** under Maps hand out map sources, not
///   archives a client can load;
/// * `76` and `45` **Single Player** under Code Mods are code mods, and the
///   section takes the **Single Player** of the game root instead;
/// * `10` and `47` **Cosmetic Mods** are the largest category outside the
///   eight, and are not one of them.
pub const SECTIONS: [Section; 8] = [
    Section {
        key: "maps",
        name: "Maps",
        // The container (71) and every gametype under it but Source Files.
        ja: &[71, 16, 28, 34, 13, 15, 33, 17],
        jo: &[55, 57, 58, 61, 56, 59, 60],
    },
    Section {
        key: "skins",
        name: "Skins & Player Models",
        // Two categories of the site, one section here.
        ja: &[4, 5],
        jo: &[67, 66],
    },
    Section {
        key: "sabers",
        name: "Sabers",
        // The site calls it «Lightsabers & Melee».
        ja: &[24],
        jo: &[54],
    },
    Section {
        key: "guns",
        name: "Guns",
        // The site calls it «Guns & Explosives».
        ja: &[23],
        jo: &[53],
    },
    Section {
        key: "npcs",
        name: "NPCs",
        // Jedi Outcast has no such category on the site.
        ja: &[36],
        jo: &[],
    },
    Section {
        key: "vehicles",
        name: "Vehicles",
        // 70 exists and held nothing on the day of the walk. It stays: an
        // empty section of a game is the site's answer, not a gap in ours.
        ja: &[6],
        jo: &[70],
    },
    Section {
        key: "singlePlayer",
        name: "Single Player",
        ja: &[30],
        jo: &[68],
    },
    Section {
        key: "audio",
        name: "Audio",
        ja: &[38],
        jo: &[80],
    },
];

/// The section a site category belongs to, or `None` when it is outside the
/// eight.
pub fn of(game: Game, category_id: u32) -> Option<&'static Section> {
    SECTIONS
        .iter()
        .find(|section| section.ids(game).contains(&category_id))
}

/// The id a file of this site category is filed under, or `None` when the
/// category is outside the eight.
///
/// A section id maps to itself, so running an already mapped index through
/// this changes nothing.
pub fn id_of(game: Game, category_id: u32) -> Option<u32> {
    of(game, category_id).and_then(|section| section.id(game))
}

/// Whether the launcher shows this site category at all.
pub fn covers(game: Game, category_id: u32) -> bool {
    of(game, category_id).is_some()
}

/// Drops every node of a site tree that is outside the eight sections.
///
/// Applied to whatever tree arrives — walked, cached or bundled — so an index
/// of the disk cache written before the sections existed cannot widen the tab
/// back out. A node whose parent did not survive becomes a root, which keeps
/// the pruned tree walkable rather than leaving a dangling `parent_id`.
pub fn prune(game: Game, mut tree: Vec<JkhubCategory>) -> Vec<JkhubCategory> {
    tree.retain(|entry| covers(game, entry.id));
    let kept: Vec<u32> = tree.iter().map(|entry| entry.id).collect();
    for entry in &mut tree {
        if entry.parent_id.is_some_and(|parent| !kept.contains(&parent)) {
            entry.parent_id = None;
        }
    }
    tree
}

/// The tree the screen draws: one flat node per section, in the order of
/// [`SECTIONS`].
///
/// `site` is the pruned site tree, and is read for two things only — whether
/// the game has the section at all, and how many files the site printed under
/// it. The counts add up the leaves only: a container such as Maps prints the
/// total of its children when it prints anything, and adding it in would
/// count every map twice.
///
/// A section the game has but the tree has not yet learned about still gets a
/// node, with no count: the tab must list `Vehicles` of Jedi Outcast even on
/// the day the site's tree says nothing about it.
pub fn tree(game: Game, site: &[JkhubCategory]) -> Vec<JkhubCategory> {
    let mut nodes = Vec::with_capacity(SECTIONS.len());
    for section in &SECTIONS {
        let Some(id) = section.id(game) else { continue };
        let members: Vec<&JkhubCategory> = site
            .iter()
            .filter(|entry| section.ids(game).contains(&entry.id))
            .collect();
        let counted: Vec<u32> = members
            .iter()
            .filter(|entry| entry.has_files)
            .filter_map(|entry| entry.file_count)
            .collect();
        let head = members.iter().find(|entry| entry.id == id);
        nodes.push(JkhubCategory {
            id,
            slug: head.map(|entry| entry.slug.clone()).unwrap_or_default(),
            // The site's own name, kept as the fallback of a screen that has
            // no catalog for the language. What the player reads comes from
            // `sections.<key>` of `jkhub.json`.
            name: section.name.to_string(),
            parent_id: None,
            game: JkhubGame::from(game),
            file_count: (!counted.is_empty()).then(|| counted.iter().sum()),
            // Every section is selectable, container or not: the grid answers
            // out of the index, which files a map under `Maps` and not under
            // the gametype the site put it in.
            has_files: true,
            url: head
                .map(|entry| entry.url.clone())
                .unwrap_or_else(|| super::parse::category_url(id, "")),
            section: Some(section.key.to_string()),
        });
    }
    nodes
}

/// Files an index onto the sections, dropping what no longer belongs.
///
/// Answers how many entries were dropped. Two things happen at once, and both
/// are needed by an index written before this table existed: an entry of a
/// gametype under Maps is moved to the Maps section, and an entry of Cosmetic
/// Mods is thrown away.
pub fn retain(game: Game, files: &mut Vec<super::index::IndexedFile>) -> usize {
    let before = files.len();
    files.retain_mut(|file| match id_of(game, file.category_id) {
        Some(id) => {
            file.category_id = id;
            true
        }
        None => false,
    });
    before - files.len()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    use super::*;
    use crate::jkhub::snapshot;

    fn node(id: u32, parent: Option<u32>, count: Option<u32>, has_files: bool) -> JkhubCategory {
        JkhubCategory {
            id,
            slug: format!("c{id}"),
            name: format!("Category {id}"),
            parent_id: parent,
            game: JkhubGame::Ja,
            file_count: count,
            has_files,
            url: format!("https://jkhub.org/files/category/{id}-c{id}/"),
            section: None,
        }
    }

    /// The table is the contract with the site, so every id in it has to be a
    /// category the site actually has. The bundled trees are the record of
    /// what it had on the day of the last walk.
    ///
    /// The second half is what keeps [`super::source::crawl_tree`] able to
    /// reach the table at all: the walk visits the direct children of a game
    /// root and reads their subcategory widgets, so a member of a section is
    /// either the section itself or a child of it.
    #[test]
    fn every_site_id_of_the_table_exists_in_the_bundled_tree() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(snapshot::RESOURCE_DIR);
        for game in Game::ALL {
            let bundled = snapshot::read(&dir, game)
                .unwrap_or_else(|| panic!("{} ships a category tree", game.id()));
            let known: BTreeSet<u32> = bundled.categories.iter().map(|entry| entry.id).collect();
            for section in &SECTIONS {
                let head = section.id(game);
                for id in section.ids(game) {
                    assert!(
                        known.contains(id),
                        "{}: the {} section names category {id}, which the tree of this game \
                         does not have",
                        game.id(),
                        section.key
                    );
                    let parent = bundled
                        .categories
                        .iter()
                        .find(|entry| entry.id == *id)
                        .and_then(|entry| entry.parent_id);
                    // A direct child of a game root is walked by name; a
                    // deeper one is only ever met in the subcategory widget
                    // of the category above it, which has to be in the table
                    // too. A pruned tree has dropped the roots, so a member
                    // without a parent is one of the first kind.
                    let under_a_root = parent
                        .is_none_or(|parent| crate::jkhub::parse::game_of_root(parent).is_some());
                    assert!(
                        Some(*id) == head || parent == head || under_a_root,
                        "{}: category {id} of the {} section is neither a child of a game root \
                         nor of {head:?}, so the walk would never reach it",
                        game.id(),
                        section.key
                    );
                }
            }
        }
    }

    /// A file of the catalogue belongs to one section and no more: an id in
    /// two lists would file the same file twice.
    #[test]
    fn no_site_category_belongs_to_two_sections() {
        for game in Game::ALL {
            let mut seen = BTreeSet::new();
            for section in &SECTIONS {
                for id in section.ids(game) {
                    assert!(
                        seen.insert(*id),
                        "{}: category {id} is in two sections",
                        game.id()
                    );
                }
            }
        }
    }

    /// The three decisions the table is asked about most often, written down
    /// as a test so a rewrite of the ids cannot quietly undo one.
    #[test]
    fn the_categories_left_out_stay_left_out() {
        // Source files, single player code mods and cosmetic mods.
        for id in [35, 76, 10] {
            assert!(!covers(Game::JediAcademy, id), "ja: {id} is not catalogue");
        }
        for id in [63, 45, 47] {
            assert!(!covers(Game::JediOutcast, id), "jo: {id} is not catalogue");
        }
        // And the eight that are.
        assert_eq!(id_of(Game::JediAcademy, 13), Some(71), "a gametype is Maps");
        assert_eq!(id_of(Game::JediAcademy, 5), Some(4), "models are Skins");
        assert_eq!(id_of(Game::JediAcademy, 30), Some(30), "and an id maps to itself");
        assert_eq!(id_of(Game::JediOutcast, 36), None, "jo has no NPCs");
    }

    #[test]
    fn pruning_keeps_the_table_and_makes_an_orphan_a_root() {
        let tree = vec![
            node(41, None, Some(3299), false),
            node(71, Some(41), None, false),
            node(13, Some(71), Some(367), true),
            node(35, Some(71), Some(14), true),
            node(10, Some(41), Some(349), true),
        ];
        let pruned = prune(Game::JediAcademy, tree);
        let ids: Vec<u32> = pruned.iter().map(|entry| entry.id).collect();
        assert_eq!(ids, vec![71, 13], "source files and cosmetic mods are gone");
        assert_eq!(pruned[0].parent_id, None, "the game root did not survive");
        assert_eq!(pruned[1].parent_id, Some(71), "Maps did");
    }

    #[test]
    fn a_section_is_one_node_carrying_the_sum_of_its_leaves() {
        let site = prune(
            Game::JediAcademy,
            vec![
                node(71, Some(41), Some(999), false),
                node(13, Some(71), Some(367), true),
                node(28, Some(71), Some(122), true),
                node(4, Some(41), Some(584), true),
                node(5, Some(41), Some(644), true),
            ],
        );
        let nodes = tree(Game::JediAcademy, &site);
        assert_eq!(nodes.len(), 8, "every section of Jedi Academy has a node");
        assert!(
            nodes.iter().all(|entry| entry.parent_id.is_none() && entry.has_files),
            "the launcher tree is flat and every node opens"
        );

        let maps = &nodes[0];
        assert_eq!(maps.id, 71);
        assert_eq!(maps.section.as_deref(), Some("maps"));
        assert_eq!(
            maps.file_count,
            Some(489),
            "the container's own 999 would count every map twice"
        );

        let skins = &nodes[1];
        assert_eq!(skins.id, 4, "the section is filed under Skins");
        assert_eq!(skins.file_count, Some(1228), "and shows both categories");

        assert_eq!(
            nodes[7].file_count, None,
            "a section the tree knows nothing about shows no badge"
        );
    }

    #[test]
    fn jedi_outcast_has_no_npcs_node() {
        let nodes = tree(Game::JediOutcast, &[]);
        assert_eq!(nodes.len(), 7);
        assert!(nodes.iter().all(|entry| entry.section.as_deref() != Some("npcs")));
    }
}
