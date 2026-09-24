//! Player-facing objects assembled from package resources. The parts of an
//! object — geometry, skins, the voice of a character — never become choices
//! in the preview UI; everything else the archive carries, from a map
//! picture to a translation, is listed by `file_preview_contents` under its
//! own kind.
use crate::{
    error::Result,
    file_preview::{logical_name, PreviewEntry},
    file_preview_contents::{self, PreviewFont, PreviewImage, PreviewStrings, PreviewText},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::Read,
    path::PathBuf,
};
use zip::ZipArchive;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProduct {
    pub id: String,
    pub archive: usize,
    /// Resource name, used only by the loader.
    pub name: String,
    pub label: String,
    /// A finished object: `skin`, `hilt`, `weapon`, `npc`, `vehicle`, `map`,
    /// `music`, `sound`; or a file of the archive by the taxonomy of
    /// `file_preview_contents::ContentKind`: `levelshot`, `splash`,
    /// `menuImage`, `hudImage`, `texture`, `icon`, `image`, `font`,
    /// `strings`, `shader`, `effect`, `menu`, `config`, `data`, `script`,
    /// `video`, `other`.
    pub kind: String,
    pub model: Option<String>,
    pub skins: Vec<String>,
    pub audio: Vec<PreviewAudio>,
    pub appearance: Option<crate::appearance::PlayerModel>,
    pub hilt_id: Option<String>,
    /// Bytes of the entry, on a product that stands for one file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// The header of a picture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<PreviewImage>,
    /// What a text file is, for the products `get_file_preview_text` opens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<PreviewText>,
    /// A translation file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strings: Option<PreviewStrings>,
    /// A font table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<PreviewFont>,
    /// The map a `levelshot` stands for, spelled the way `.arena` files
    /// name it: `mp/ffa3`, `academy1`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
    /// The folder of the entry, for a gallery to group by: `gfx/2d`,
    /// `levelshots/mp`; the language of a `strings` product.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewAudio {
    pub name: String,
    pub label: String,
}

fn label(name: &str) -> String {
    let mut out = String::new();
    let mut chars = name.chars().peekable();
    let mut lower = false;
    while let Some(c) = chars.next() {
        if c == '^' && chars.peek().is_some_and(|c| c.is_ascii_digit()) {
            chars.next();
            continue;
        }
        if c == '_' {
            out.push(' ');
            lower = false;
            continue;
        }
        if lower && c.is_uppercase() {
            out.push(' ');
        }
        out.push(c);
        lower = c.is_lowercase();
    }
    let text = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

/// Quoted names and braces matter; scripts are parsed as data and never run.
fn definitions(text: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let chars: Vec<_> = text.chars().collect();
    let mut at = 0;
    let mut tokens = Vec::new();
    while at < chars.len() {
        if chars[at].is_whitespace() {
            at += 1;
            continue;
        }
        if chars[at] == '/' && chars.get(at + 1) == Some(&'/') {
            while at < chars.len() && chars[at] != '\n' {
                at += 1;
            }
            continue;
        }
        if chars[at] == '/' && chars.get(at + 1) == Some(&'*') {
            at += 2;
            while at + 1 < chars.len() && !(chars[at] == '*' && chars[at + 1] == '/') {
                at += 1;
            }
            at = (at + 2).min(chars.len());
            continue;
        }
        if matches!(chars[at], '{' | '}') {
            tokens.push(chars[at].to_string());
            at += 1;
            continue;
        }
        let quoted = chars[at] == '"';
        if quoted {
            at += 1;
        }
        let start = at;
        while at < chars.len()
            && if quoted {
                chars[at] != '"'
            } else {
                !chars[at].is_whitespace() && !matches!(chars[at], '{' | '}')
            }
        {
            at += 1;
        }
        tokens.push(chars[start..at].iter().collect::<String>());
        if quoted && at < chars.len() {
            at += 1;
        }
    }
    let mut result = Vec::new();
    let mut at = 0;
    while at + 1 < tokens.len() {
        let id = if tokens[at] == "{" {
            String::new()
        } else {
            let id = tokens[at].clone();
            at += 1;
            id
        };
        if tokens[at] != "{" {
            continue;
        }
        at += 1;
        let mut depth = 1;
        let mut fields = BTreeMap::new();
        while at < tokens.len() && depth > 0 {
            match tokens[at].as_str() {
                "{" => {
                    depth += 1;
                    at += 1;
                }
                "}" => {
                    depth -= 1;
                    at += 1;
                }
                _ if depth == 1
                    && at + 1 < tokens.len()
                    && !matches!(tokens[at + 1].as_str(), "{" | "}") =>
                {
                    fields.insert(tokens[at].to_ascii_lowercase(), tokens[at + 1].clone());
                    at += 2;
                }
                _ => at += 1,
            }
        }
        result.push((id, fields));
    }
    result
}

pub(crate) fn products(
    sources: &[PathBuf],
    entries: &[PreviewEntry],
) -> Result<Vec<PreviewProduct>> {
    products_mode(sources, entries, false)
}

pub(crate) fn combined_products(
    sources: &[PathBuf],
    entries: &[PreviewEntry],
) -> Result<Vec<PreviewProduct>> {
    products_mode(sources, entries, true)
}

fn products_mode(
    sources: &[PathBuf],
    entries: &[PreviewEntry],
    combined: bool,
) -> Result<Vec<PreviewProduct>> {
    let mut products = Vec::new();
    let mut defined = HashSet::new();
    let mut map_titles = BTreeMap::new();
    let mut definitions_seen = HashSet::new();
    let mut files_seen = HashSet::new();
    let resource_names: HashSet<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
    let mut source_order: Vec<_> = sources.iter().enumerate().collect();
    if combined {
        source_order.reverse();
    }
    for (archive_id, path) in source_order {
        let archive_id = if combined { 0 } else { archive_id };
        let Ok(file) = File::open(path) else { continue };
        let Ok(mut archive) = ZipArchive::new(file) else {
            continue;
        };
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let Some(name) = logical_name(entry.name()) else {
                continue;
            };
            let kind = if name.ends_with(".sab") {
                "hilt"
            } else if name.ends_with(".npc") || name == "ext_data/npcs.cfg" {
                "npc"
            } else if name.ends_with(".veh") {
                "vehicle"
            } else if name.ends_with(".arena") {
                "map"
            } else {
                continue;
            };
            if combined && !files_seen.insert(name.clone()) {
                continue;
            }
            if entry.size() > 1024 * 1024 {
                continue;
            }
            let mut text = String::new();
            if entry
                .by_ref()
                .take(1024 * 1024)
                .read_to_string(&mut text)
                .is_err()
            {
                continue;
            }
            for (id, fields) in definitions(&text) {
                if kind == "map" {
                    if let (Some(map), Some(title)) = (fields.get("map"), fields.get("longname")) {
                        map_titles.insert((archive_id, map.to_ascii_lowercase()), label(title));
                    }
                    continue;
                }
                if combined && !definitions_seen.insert((kind, id.to_ascii_lowercase())) {
                    continue;
                }
                let reference = fields
                    .get("sabermodel")
                    .or_else(|| fields.get("playermodel"))
                    .or_else(|| fields.get("model"));
                let Some(reference) = reference.and_then(|name| logical_name(name)) else {
                    continue;
                };
                let model = if reference.starts_with("models/") {
                    reference
                } else {
                    format!("models/players/{reference}/model.glm")
                };
                if !model.ends_with(".glm") && !model.ends_with(".md3") {
                    continue;
                }
                if model.contains("/noweap/")
                    || (combined && !resource_names.contains(model.as_str()))
                {
                    continue;
                }
                let mut skins: Vec<_> = fields
                    .get("customskin")
                    .and_then(|name| logical_name(name))
                    .into_iter()
                    .collect();
                if skins.is_empty() && model.starts_with("models/players/") {
                    let directory = model.rsplit_once('/').unwrap().0;
                    let skin = fields.get("skin").or_else(|| fields.get("modelskin"));
                    // Vehicle definitions may choose a random variant from a pipe-separated list.
                    let variants: Vec<_> = skin
                        .map(String::as_str)
                        .unwrap_or("default")
                        .split('|')
                        .collect();
                    let variant = variants
                        .iter()
                        .find(|variant| **variant == "default")
                        .or_else(|| {
                            variants.iter().find(|variant| {
                                resource_names
                                    .contains(format!("{directory}/model_{variant}.skin").as_str())
                            })
                        })
                        .or_else(|| variants.first())
                        .copied()
                        .unwrap_or("default");
                    skins.push(format!("{directory}/model_{}.skin", variant));
                }
                if combined {
                    skins.retain(|skin| resource_names.contains(skin.as_str()));
                }
                let title = fields
                    .get("name")
                    .filter(|value| !value.starts_with('@'))
                    .unwrap_or(&id);
                products.push(PreviewProduct {
                    id: format!("{archive_id}:{name}:{id}"),
                    archive: archive_id,
                    name: name.clone(),
                    label: label(title),
                    kind: kind.into(),
                    model: Some(model.clone()),
                    skins,
                    hilt_id: (kind == "hilt").then_some(id),
                    ..PreviewProduct::default()
                });
                defined.insert((archive_id, model));
            }
        }
    }
    let mut signatures = HashSet::new();
    let mut weapons: BTreeMap<(usize, String), (u8, &PreviewEntry)> = BTreeMap::new();
    for entry in entries {
        if entry.kind == "map" && entry.name.starts_with("maps/") {
            let name = entry
                .name
                .trim_start_matches("maps/")
                .trim_end_matches(".bsp");
            products.push(PreviewProduct {
                id: entry.id.clone(),
                archive: entry.archive,
                name: entry.name.clone(),
                label: map_titles
                    .get(&(entry.archive, name.to_string()))
                    .cloned()
                    .unwrap_or_else(|| label(name)),
                kind: "map".into(),
                size: Some(entry.size),
                ..PreviewProduct::default()
            });
            continue;
        }
        if entry.kind == "audio" {
            let stem = entry
                .name
                .rsplit('/')
                .next()
                .unwrap_or(&entry.name)
                .rsplit_once('.')
                .map(|(stem, _)| stem)
                .unwrap_or(&entry.name);
            let music = entry.name.starts_with("music/");
            products.push(PreviewProduct {
                id: entry.id.clone(),
                archive: entry.archive,
                name: entry.name.clone(),
                label: label(stem),
                kind: if music { "music" } else { "sound" }.into(),
                size: music.then_some(entry.size),
                ..PreviewProduct::default()
            });
            continue;
        }
        let Some(model) = entry.model.as_ref() else {
            continue;
        };
        if defined.contains(&(entry.archive, model.clone()))
            && products.iter().any(|product| {
                product.archive == entry.archive
                    && product.model.as_ref() == Some(model)
                    && (product.kind == "hilt"
                        || ((!combined || product.kind != "npc") && product.skins == entry.skins))
            })
        {
            continue;
        }
        let parts: Vec<_> = model.split('/').collect();
        if parts.len() < 4 {
            continue;
        }
        if parts[1] == "players" {
            // Legacy MD3 heads and limbs are attachment resources, not characters.
            if model.ends_with(".md3") && parts.last() != Some(&"model.md3") {
                continue;
            }
            let skin = entry
                .skins
                .first()
                .and_then(|name| name.rsplit('/').next())
                .unwrap_or("model_default.skin");
            let assembled = entry.skins.len() == 3 && skin.starts_with("head_");
            if !skin.starts_with("model_") && !assembled {
                continue;
            }
            let variant = skin.trim_start_matches("model_").trim_end_matches(".skin");
            let caption = if variant == "default" || assembled {
                label(parts[2])
            } else {
                format!("{} · {}", label(parts[2]), label(variant))
            };
            if !signatures.insert((entry.archive, model.clone(), entry.skins.clone())) {
                continue;
            }
            let kind = if products.iter().any(|product| {
                product.archive == entry.archive
                    && product.kind == "vehicle"
                    && product.model.as_ref() == Some(model)
            }) {
                "vehicle"
            } else {
                "skin"
            };
            products.push(PreviewProduct {
                id: entry.id.clone(),
                archive: entry.archive,
                name: entry.name.clone(),
                label: caption,
                kind: kind.into(),
                model: Some(model.clone()),
                skins: entry.skins.clone(),
                ..PreviewProduct::default()
            });
        } else if parts[1] == "map_objects" && parts[2].contains("vehicle") {
            let stem = parts.last().unwrap().rsplit_once('.').unwrap().0;
            products.push(PreviewProduct {
                id: entry.id.clone(),
                archive: entry.archive,
                name: entry.name.clone(),
                label: label(stem),
                kind: "vehicle".into(),
                model: Some(model.clone()),
                skins: entry.skins.clone(),
                ..PreviewProduct::default()
            });
        } else if parts[1] == "weapons2" || parts[1] == "weapons" {
            if parts[2] == "noweap" {
                continue;
            }
            let stem = parts
                .last()
                .unwrap_or(&"")
                .rsplit_once('.')
                .map(|(name, _)| name)
                .unwrap_or("");
            if ["hand", "flash", "barrel", "projectile", "ammo", "tag_"]
                .iter()
                .any(|part| stem.contains(part))
            {
                continue;
            }
            let score = if stem.ends_with("_w") || stem == "model" {
                0
            } else if stem == parts[2] {
                1
            } else {
                2
            };
            let group = (entry.archive, parts[..parts.len() - 1].join("/"));
            if weapons.get(&group).is_none_or(|(old, _)| score < *old) {
                weapons.insert(group, (score, entry));
            }
        }
    }
    for ((_, directory), (_, entry)) in weapons {
        let stem = directory.rsplit('/').next().unwrap_or(&directory);
        products.push(PreviewProduct {
            id: entry.id.clone(),
            archive: entry.archive,
            name: entry.name.clone(),
            label: label(stem),
            kind: if directory.contains("saber") {
                "hilt"
            } else {
                "weapon"
            }
            .into(),
            model: entry.model.clone(),
            skins: entry.skins.clone(),
            ..PreviewProduct::default()
        });
    }
    // A character's voice and a weapon's effects belong to the finished object.
    // Standalone sound packs become named collections, never a list of resources.
    let sounds: Vec<_> = products
        .iter()
        .filter(|p| p.kind == "sound")
        .cloned()
        .collect();
    products.retain(|p| p.kind != "sound");
    for mut sound in sounds {
        let segments: Vec<_> = sound.name.split('/').collect();
        let object = segments
            .get(2)
            .filter(|_| segments.len() > 3)
            .copied()
            .unwrap_or("");
        let language = match segments.get(1).copied() {
            Some("chr_d") => "DE",
            Some("chr_f") => "FR",
            Some("chr_e") => "ES",
            _ => "",
        };
        if !language.is_empty() {
            sound.label = format!("{} · {language}", sound.label);
        }
        let candidates: Vec<_> = products
            .iter()
            .enumerate()
            .filter(|(_, p)| p.archive == sound.archive && p.model.is_some())
            .map(|(i, _)| i)
            .collect();
        let matches: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|&i| {
                !object.is_empty() && {
                    products[i].model.as_ref().is_some_and(|model| {
                        model
                            .split('/')
                            .nth(2)
                            .is_some_and(|name| name.contains(object))
                    })
                }
            })
            .collect();
        let targets = if !matches.is_empty() {
            matches
        } else if candidates.len() == 1 {
            candidates
        } else {
            Vec::new()
        };
        if !targets.is_empty() {
            for i in targets {
                products[i].audio.push(PreviewAudio {
                    name: sound.name.clone(),
                    label: sound.label.clone(),
                });
            }
        } else {
            let group = sound
                .name
                .rsplit_once('/')
                .map(|(dir, _)| dir)
                .unwrap_or("sound");
            let id = format!("{}:sounds:{group}", sound.archive);
            if let Some(product) = products.iter_mut().find(|p| p.id == id) {
                product.audio.push(PreviewAudio {
                    name: sound.name,
                    label: sound.label,
                });
            } else {
                let mut product = sound.clone();
                product.id = id;
                let caption = group
                    .strip_prefix("sound/")
                    .unwrap_or(group)
                    .split('/')
                    .filter(|part| !matches!(*part, "chars" | "chr_d" | "chr_f" | "chr_e"))
                    .map(label)
                    .collect::<Vec<_>>()
                    .join(" · ");
                product.label = if language.is_empty() {
                    caption
                } else {
                    format!("{caption} · {language}")
                };
                product.audio.push(PreviewAudio {
                    name: sound.name,
                    label: sound.label,
                });
                products.push(product);
            }
        }
    }
    // What the archive carries besides its finished objects: pictures,
    // strings, fonts, shaders, text. The combined catalogue of the retail
    // archives stays a catalogue of objects: its twenty thousand files
    // would bury the eight hundred objects it exists for.
    if !combined {
        products.extend(file_preview_contents::products(sources, entries)?);
    }
    products.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(products)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoted_product_names_and_comments_are_parsed_without_script_execution() {
        let parsed=definitions("// ignored\n cool_hilt { name \"^1Cool Hilt\" saberModel models/weapons2/cool/hilt.glm } /* skipped */ bot { playerModel kyle }");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].1["name"], "^1Cool Hilt");
        assert_eq!(label(&parsed[0].1["name"]), "Cool Hilt");
    }
}
