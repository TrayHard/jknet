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
//! | [`tree`] | the nodes the screen draws: a section and the site categories under it |
//! | [`super::index::crawl`] | which listings are read at all |
//! | [`retain`] | which entries of an older index on disk are still catalogue |
//!
//! Two consequences worth naming. A section is one shelf even when the site
//! spells it as two — **Skins** and **Player Models** are one **Skins & Player
//! Models**, with both of them under it — and a section can be empty for one
//! game: Jedi Outcast has no NPCs category at all, so that section is absent
//! from its tree rather than shown at zero.
//!
//! Names come from `src/locales/*/jkhub.json` through [`Section::key`], not
//! from the site: the launcher names its own shelves, and the site's spelling
//! («Lightsabers & Melee», «Source FIles» with the typo it has carried for
//! years) is not the launcher's to inherit. A category *below* a section
//! keeps the site's own name: the launcher named the shelf, not every drawer
//! in it.

use crate::game::Game;

use super::types::{JkhubCategory, JkhubGame};

/// Where the ids of the launcher's own tree nodes start.
///
/// --- slice: library polish ---
/// A section is a node of the launcher and not of the site, so it needs an id
/// no site category can take. The site numbers its categories in the tens;
/// a million away from them is a number that reads as «not the site's» at a
/// glance in a log line or a React key.
///
/// The section node used to carry the first site id of the table instead, and
/// that worked only while the tree was flat. With the site's categories back
/// under the section, **Skins & Player Models** would have had to be both the
/// parent and one of its own two children.
pub const NODE_ID_BASE: u32 = 1_000_000;

/// One section of the launcher's catalogue.
///
/// The first id of a game's list is the section's site id: the address of the
/// section on jkhub.org, the head of the tree branch it draws, and what
/// [`Section::node_id`] turns into the id of the node itself.
pub struct Section {
    /// Stable key of the section. The locale key under `sections` of
    /// `jkhub.json`, and what the wire carries in `JkhubCategory::section`.
    pub key: &'static str,
    /// English name, and the fallback for a screen without a catalog loaded.
    pub name: &'static str,
    /// Site categories of Jedi Academy, the first being the section's own.
    ///
    /// The order is the order the tree draws them in, so keep it the order a
    /// player reads: the section first, its categories alphabetically after.
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

    /// The site id of this section, or `None` when the game has no such
    /// category.
    pub fn id(&self, game: Game) -> Option<u32> {
        self.ids(game).first().copied()
    }

    /// The id of the node the tree draws for this section.
    ///
    /// --- slice: library polish ---
    /// A launcher id, not a site one: see [`NODE_ID_BASE`]. Derived from the
    /// site id rather than from the position in [`SECTIONS`], so reordering
    /// the table cannot renumber the shelves.
    pub fn node_id(&self, game: Game) -> Option<u32> {
        self.id(game).map(|id| NODE_ID_BASE + id)
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

/// The node of the launcher's tree a file of this site category sits under.
///
/// --- slice: library polish ---
/// What narrowing a search to a whole section means: a file of **Duel** is
/// answered under **Maps** because this says so, and a file of **Duel** is
/// answered under **Duel** because the ids match outright. The search needs
/// no tree to decide it — the table is enough, and the table is the same
/// whichever tree the walk brought back.
pub fn node_id_of(game: Game, category_id: u32) -> Option<u32> {
    of(game, category_id).and_then(|section| section.node_id(game))
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

/// The tree the screen draws: a node per section, in the order of
/// [`SECTIONS`], with the site's own categories under it.
///
/// `site` is the pruned site tree, and is read for three things — whether the
/// game has the section at all, which of the section's categories the site
/// still has, and how many files it printed under each. The count of a
/// section adds up the leaves only: a container such as Maps prints the total
/// of its children when it prints anything, and adding it in would count
/// every map twice.
///
/// A section the game has but the tree has not yet learned about still gets a
/// node, with no count and no children: the tab must list `Vehicles` of Jedi
/// Outcast even on the day the site's tree says nothing about it.
///
/// --- slice: library polish ---
/// Two rules decide what appears under a section, and both are about not
/// drawing the same shelf twice:
///
/// * a section made of one site category has no children — the node *is* that
///   category, and a lone `Audio` under `Audio` says nothing;
/// * the head of a section whose other members are its children on the site
///   has no row either — `Maps` (71) holds no files of its own and every
///   gametype hangs off it, so the section node stands in for it.
///
/// What is left is the case the flat tree could not express: **Skins** and
/// **Player Models** are siblings on the site, neither can be the parent of
/// the other, and both get a row under a section node that is the launcher's
/// own.
pub fn tree(game: Game, site: &[JkhubCategory]) -> Vec<JkhubCategory> {
    let mut nodes = Vec::with_capacity(SECTIONS.len());
    for section in &SECTIONS {
        let (Some(id), Some(node_id)) = (section.id(game), section.node_id(game)) else {
            continue;
        };
        // In the order of the table rather than of the walk: the table is
        // written the way the rail reads, the walk is written the way the
        // site serves.
        let members: Vec<&JkhubCategory> = section
            .ids(game)
            .iter()
            .filter_map(|wanted| site.iter().find(|entry| entry.id == *wanted))
            .collect();
        let counted: Vec<u32> = members
            .iter()
            .filter(|entry| entry.has_files)
            .filter_map(|entry| entry.file_count)
            .collect();
        let head = members.iter().find(|entry| entry.id == id).copied();
        // The head is the container of the branch when the rest of the
        // section hangs off it, and then the section node stands in for it.
        let head_is_the_branch = members
            .iter()
            .any(|entry| entry.parent_id == Some(id) && entry.id != id);
        nodes.push(JkhubCategory {
            id: node_id,
            slug: head.map(|entry| entry.slug.clone()).unwrap_or_default(),
            // The site's own name, kept as the fallback of a screen that has
            // no catalog for the language. What the player reads comes from
            // `sections.<key>` of `jkhub.json`.
            name: section.name.to_string(),
            parent_id: None,
            game: JkhubGame::from(game),
            file_count: (!counted.is_empty()).then(|| counted.iter().sum()),
            // Every section is selectable, container or not: the grid answers
            // out of the index, and narrowing to a section takes in every
            // category under it.
            has_files: true,
            url: head
                .map(|entry| entry.url.clone())
                .unwrap_or_else(|| super::parse::category_url(id, "")),
            section: Some(section.key.to_string()),
            site_id: Some(id),
        });
        if members.len() < 2 {
            continue;
        }
        let drawn: Vec<u32> = members
            .iter()
            .map(|entry| entry.id)
            .filter(|member| !(*member == id && head_is_the_branch))
            .collect();
        for member in members.iter().filter(|entry| drawn.contains(&entry.id)) {
            // A member whose parent is drawn too keeps it; everything else
            // hangs off the section itself — a gametype whose container is
            // the section, and a node the pruning orphaned when it dropped a
            // game root.
            let parent = member
                .parent_id
                .filter(|parent| drawn.contains(parent))
                .unwrap_or(node_id);
            nodes.push(JkhubCategory {
                parent_id: Some(parent),
                // The site's name, and no section key: the launcher named the
                // shelf, not the drawers in it.
                section: None,
                site_id: None,
                ..(*member).clone()
            });
        }
    }
    nodes
}

/// Drops the entries of an index that are no longer catalogue.
///
/// Answers how many went. An index written before the sections existed
/// carries a file of **Cosmetic Mods** under `10`, and this is the one place
/// every reader of an index goes through.
///
/// --- slice: library polish ---
/// The site's own category is left exactly as it is. It used to be rewritten
/// to the id of the section, which is what made a rail of eight flat shelves
/// the only tree the index could serve: once a map of **Duel** and a map of
/// **Siege** both read `71`, no amount of work on the front end could tell
/// them apart again. The section of an entry is now worked out from the
/// table when it is needed, by [`node_id_of`], and the field keeps what the
/// site said.
pub fn retain(game: Game, files: &mut Vec<super::index::IndexedFile>) -> usize {
    let before = files.len();
    files.retain(|file| covers(game, file.category_id));
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
            site_id: None,
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
        // And the eight that are, by the node of the rail they answer under.
        let maps = NODE_ID_BASE + 71;
        assert_eq!(node_id_of(Game::JediAcademy, 13), Some(maps), "a gametype is under Maps");
        assert_eq!(node_id_of(Game::JediAcademy, 71), Some(maps), "and so is the container");
        assert_eq!(
            node_id_of(Game::JediAcademy, 5),
            Some(NODE_ID_BASE + 4),
            "player models are under Skins & Player Models"
        );
        assert_eq!(
            node_id_of(Game::JediAcademy, 30),
            Some(NODE_ID_BASE + 30),
            "a section of one category still gets a node of its own"
        );
        assert_eq!(node_id_of(Game::JediOutcast, 36), None, "jo has no NPCs");
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
    fn a_section_carries_the_sum_of_its_leaves_and_the_site_under_it() {
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
        let sections: Vec<&JkhubCategory> =
            nodes.iter().filter(|entry| entry.parent_id.is_none()).collect();
        assert_eq!(sections.len(), 8, "every section of Jedi Academy has a node");
        assert!(
            sections.iter().all(|entry| entry.has_files && entry.section.is_some()),
            "a section opens and is named by the launcher"
        );
        assert!(
            nodes
                .iter()
                .filter(|entry| entry.parent_id.is_some())
                .all(|entry| entry.section.is_none()),
            "a category under a section keeps the site's own name"
        );

        let maps = sections[0];
        assert_eq!(maps.id, NODE_ID_BASE + 71);
        assert_eq!(maps.section.as_deref(), Some("maps"));
        assert_eq!(
            maps.file_count,
            Some(489),
            "the container's own 999 would count every map twice"
        );
        let under_maps: Vec<u32> = children(&nodes, maps.id);
        assert_eq!(
            under_maps,
            vec![28, 13],
            "the gametypes hang off the section in the order of the table — Duel, then Free \
             For All — and 71 itself does not: it is the section"
        );

        let skins = sections[1];
        assert_eq!(skins.id, NODE_ID_BASE + 4, "neither site category can be the parent");
        assert_eq!(skins.file_count, Some(1228), "and it shows both of them");
        assert_eq!(
            children(&nodes, skins.id),
            vec![4, 5],
            "Skins and Player Models are siblings on the site and children here"
        );

        let audio = sections[7];
        assert_eq!(audio.file_count, None, "a section the tree knows nothing about shows no badge");
        assert!(children(&nodes, audio.id).is_empty(), "and a section of one category has no children");
    }

    #[test]
    fn a_section_of_one_category_stays_one_row() {
        let site = prune(Game::JediAcademy, vec![node(38, Some(41), Some(52), true)]);
        let nodes = tree(Game::JediAcademy, &site);
        let audio: Vec<&JkhubCategory> = nodes
            .iter()
            .filter(|entry| entry.section.as_deref() == Some("audio"))
            .collect();
        assert_eq!(audio.len(), 1, "Audio under Audio would say nothing");
        assert_eq!(audio[0].file_count, Some(52));
        assert!(children(&nodes, audio[0].id).is_empty());
    }

    #[test]
    fn jedi_outcast_has_no_npcs_node() {
        let nodes = tree(Game::JediOutcast, &[]);
        assert_eq!(nodes.len(), 7);
        assert!(nodes.iter().all(|entry| entry.section.as_deref() != Some("npcs")));
    }

    /// Site ids of the nodes directly under one node, in the order they are
    /// drawn.
    fn children(nodes: &[JkhubCategory], parent: u32) -> Vec<u32> {
        nodes
            .iter()
            .filter(|entry| entry.parent_id == Some(parent))
            .map(|entry| entry.id)
            .collect()
    }
}
