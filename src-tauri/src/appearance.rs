//! What a player may look like: the skins and the saber hilts a client offers.
//!
//! A player profile names a skin in the cvar `model` and a hilt in `saber1`
//! and `saber2`, and both values have to exist in the files the client will
//! actually load. This module reads those files — the retail archives of the
//! game and the enabled pk3 of the client — and answers with the two lists the
//! profile form draws. Nothing is downloaded and nothing is written into the
//! game folder.
//!
//! ## Skins
//!
//! A player model is a folder under `models/players/`. Inside it, every
//! `model_<variant>.skin` is one choosable skin and every `icon_<variant>.jpg`
//! is its picture, 128×128 in the retail game. The cvar takes `<model>` for the
//! `default` variant and `<model>/<variant>` for the rest, because
//! `CG_RegisterClientModelname` (`codemp/cgame/cg_players.c:1679-1690` of
//! OpenJK `1a6a6434`) splits on the first `/` and reads a name without one as
//! `default`.
//!
//! A variant is listed only when an `icon_<variant>` entry stands next to its
//! `.skin`, which is the rule the game's own menu goes by: `UI_BuildQ3Model_List`
//! (`codemp/ui/ui_main.c:9427-9531`) skips a skin whose icon `bIsImageFile`
//! cannot find. Without that rule the list fills with the 62 combinations of
//! `assets1.pk3` that are vehicles, droids and story NPCs — `x-wing`,
//! `rancor`, `tie_bomber` — none of which a player picks.
//!
//! The pictures are extracted into a cache of the launcher's own and handed to
//! the window through Tauri's asset protocol, the same way map pictures are:
//!
//! ```text
//! cache\skins\ja\kyle__red.jpg
//! cache\skins\jo\kyle__default.jpg
//! ```
//!
//! The game folder is separate from the client's, so the game is part of the
//! path: `kyle/default` is a different picture in the two games.
//!
//! ## Assembled models
//!
//! Six folders of `assets1.pk3` hold a jedi the player builds out of three
//! parts instead of picking whole. They are marked by a `PlayerChoice.txt`
//! beside the model, which is what `UI_BuildPlayerModel_List`
//! (`codemp/ui/ui_main.c:9689` of OpenJK `1a6a6434`) looks for, and their parts
//! are `.skin` files named by the row they fill: `head_a1.skin`,
//! `torso_a1.skin`, `lower_a1.skin`. A part is offered on the same terms as a
//! whole skin — only with an `icon_<part>` entry beside it — and a folder
//! missing a whole row is not offered at all, which is the engine's own
//! `iSkinParts != 7` (`ui_main.c:9787`).
//!
//! The cvar takes the three parts joined by `|` after the model:
//! `jedi_hm/head_a1|torso_a1|lower_a1`. `UI_UpdateCharacterCvars`
//! (`ui_main.c:4981`) writes exactly that, and `CG_RegisterClientModelname`
//! (`codemp/cgame/cg_players.c:491-497`) reads it back: a value carrying a `|`
//! together with `head`, `torso` and `lower` loads
//! `models/players/<model>/|<parts>` rather than one `model_<variant>.skin`.
//!
//! Part icons go into the same cache under the same rule, because the row
//! prefix is part of the name the game holds the picture under —
//! `icon_head_a1.jpg`, not `icon_a1.jpg`:
//!
//! ```text
//! cache\skins\ja\jedi_hm__head_a1.jpg
//! ```
//!
//! The colours a `PlayerChoice.txt` also carries are not read. They set
//! `char_color_red`, `char_color_green` and `char_color_blue`
//! (`ui_main.c:5003-5005`), which a player profile already owns as three
//! sliders of its own.
//!
//! ## Hilts
//!
//! A hilt is a named block in `ext_data/sabers/*.sab`, and the block name *is*
//! the value of `saber1`. The format carries no icon field — `saberParseKeywords`
//! (`codemp/game/bg_saberLoad.c:1849-1919`) has no such keyword, and the game's
//! own menu draws a live Ghoul2 model next to a plain text list — so the list
//! here is text: the name, and whether the hilt is one blade or a staff.
//!
//! ## Why there is no 3D preview of either
//!
//! `.glm` and `.gla` are Raven's Ghoul2, parsed by the engine's own renderer
//! (`codemp/rd-vanilla/tr_ghoul2.cpp`) and by nothing else. There is no
//! JavaScript or WebAssembly reader for the format, and the game's own menu
//! does not draw a picture either: it runs the real engine underneath the list.
//! A 128×128 icon is what the game has, so it is what the launcher shows.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use image::codecs::jpeg::JpegEncoder;
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zip::ZipArchive;

use crate::clients::{self, Client};
use crate::error::{AppError, Result};
use crate::library::pak_order;
use crate::paths::{self, DataPaths};
use crate::settings::Settings;
use crate::state::AppState;

/// Folder of the extracted skin icons inside `cache\`.
const CACHE_DIR: &str = "skins";

/// Folder inside an archive that holds the player models.
const MODEL_PREFIX: &str = "models/players/";

/// Folder inside an archive that holds the hilt definitions.
const SABER_PREFIX: &str = "ext_data/sabers/";

/// Folder of the English string tables, where a hilt name such as
/// `@MENUS_SINGLE_HILT1` is written out.
const STRINGS_PREFIX: &str = "strings/english/";

/// Extensions the game reads for a skin icon, in the order it tries them.
const ICON_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "tga"];

/// The file that marks a model folder as one the player assembles.
///
/// Lowercase, because every entry path is lowercased before it is compared.
/// The archive spells it `playerchoice.txt` and the engine asks for
/// `PlayerChoice.txt`; a Quake III file system is case insensitive and finds
/// it either way.
const PLAYERCHOICE_FILE: &str = "playerchoice.txt";

/// The three rows of an assembled model, by the prefix the `.skin` files of
/// each row carry, in the order the window draws them.
///
/// The engine's own three tests, `Q_stricmpn(skinname,"head_",5)` and the two
/// beside it (`codemp/ui/ui_main.c:9753-9785`). The whole file name is the
/// part name, prefix included: `head_a1`, and the icon is `icon_head_a1`.
const PART_PREFIXES: [&str; 3] = ["head_", "torso_", "lower_"];

/// Longest side a cached icon may have. The retail icons are 128×128; a custom
/// skin that ships a 2048 px icon would fill the cache for a 64 px tile.
const MAX_SIDE: u32 = 256;

/// Quality of a re-encoded JPEG. Only icons above [`MAX_SIDE`] are encoded at
/// all: everything else is copied byte for byte.
const JPEG_QUALITY: u8 = 85;

/// Refuses an archive entry too large to be an icon before it is read into
/// memory. A 8 MB icon does not exist; a crafted pk3 does.
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

/// Longest side the decoder is allowed to read. A few kilobytes of PNG header
/// can declare 60000×60000 and cost gigabytes to decode.
const MAX_DECODE_SIDE: u32 = 8192;

/// What one icon may allocate while it is decoded, output buffer included. The
/// crate's own default is 512 MB and is a default: an upgrade that changed it
/// would quietly change what a downloaded pk3 is allowed to do here.
const MAX_DECODE_BYTES: u64 = 64 * 1024 * 1024;

/// Longest model or variant name the cache accepts.
const MAX_SEGMENT_LEN: usize = 64;

/// --- slice: assembled skins ---
/// Longest name of one part of an assembled model the engine keeps.
///
/// `SKIN_LENGTH` of the engine (`codemp/ui/ui_local.h:258` of OpenJK
/// `1a6a6434`) is 16, the size of the `skinName_t` buffer the character menu
/// fills with `Q_strncpyz(…, skinname, SKIN_LENGTH)` for each of the three
/// rows (`codemp/ui/ui_main.c:9762`, `:9772` and `:9782`). `Q_strncpyz` keeps
/// the last byte for the terminator, so 15 bytes of the name survive. A longer
/// name is cut there rather than refused, and the value the menu then builds
/// names a file no archive holds, so a part that does not fit is not offered
/// here at all.
///
/// Neither the model folder nor the variant of an ordinary skin is bounded by
/// this. The engine copies the folder with
/// `Q_strncpyz(species->Name, dirptr, MAX_QPATH)` (`ui_main.c:9723`) and reads
/// the variant into a `MAX_QPATH` buffer beside it (`ui_main.c:4983`), so both
/// stay on [`MAX_SEGMENT_LEN`] with every other path segment.
///
/// Nothing in the retail archives meets it: the longest part is 8 bytes.
const MAX_SKIN_PART_LEN: usize = 15;

/// Refuses a `.sab` or `.str` entry too large to be a text table.
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

/// --- slice: skins and hilts ---
/// Folder of the composed previews inside the icon cache of one game.
///
/// A folder of its own rather than one more flat name, because a preview is
/// named after four segments — the model and the three parts — and a name that
/// long could collide with the `<model>__<variant>` of an ordinary icon.
const PREVIEW_DIR: &str = "assembled";

/// --- slice: skins and hilts ---
/// Side of one row of a composed preview, in pixels.
///
/// The retail part icons are 128×128, so a row of this size neither enlarges
/// nor throws anything away. A picture that is not square is fitted inside the
/// row and centred rather than stretched.
const PREVIEW_SIDE: u32 = 128;

/// --- slice: skins and hilts ---
/// The ground a composed preview is painted on: `--gray-200` of the design
/// tokens, `#b9c1d1`.
///
/// Light and opaque, and both halves matter. A part icon may carry an alpha
/// channel — every TGA the cache converts becomes a PNG — and a head drawn
/// straight onto the page showed the dark surface through everything the
/// artist had cut away. The composed picture has no alpha at all, so there is
/// nothing left to show through.
const PREVIEW_GROUND: [u8; 3] = [0xb9, 0xc1, 0xd1];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// One skin a profile may name: a model folder plus one of its variants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerModel {
    /// What goes into the cvar `model`: `kyle`, `kyle/red`, or the three parts
    /// of an assembled model, `jedi_hm/head_a1|torso_a1|lower_a1`.
    pub value: String,
    /// Folder under `models/players/`, lowercase.
    pub model: String,
    /// What the engine calls the skin name: the suffix of
    /// `model_<variant>.skin` for an ordinary skin, and the three parts joined
    /// by `|` for an assembled one. Lowercase.
    pub variant: String,
    /// Absolute path of the cached icon, or `null` when the picture could not
    /// be read. The window turns it into a URL with `convertFileSrc` and draws
    /// a text tile for a `null`.
    ///
    /// For an assembled model this is the icon of the head in [`Self::value`],
    /// which is the picture the game itself falls back to for a three-part
    /// skin (`codemp/cgame/cg_players.c:700-720`).
    pub icon: Option<String>,
    /// The three rows this model is assembled from, or `null` for an ordinary
    /// skin. The presence of this field *is* the «assembled» flag.
    pub parts: Option<ModelParts>,
    /// --- slice: skins and hilts ---
    /// Absolute path of the composed picture of [`Self::value`]: the icons of
    /// its head, torso and legs stacked on a light ground. `null` for an
    /// ordinary skin, and for an assembled model whose three icons could none
    /// of them be read.
    ///
    /// The tile of the grid draws this instead of the three part icons, which
    /// as three tiles read as three cut-out body parts with the page showing
    /// through them. A combination the player builds afterwards is composed by
    /// [`assembled_skin_preview`]; this field is the one the list opens on.
    pub preview: Option<String>,
    /// The archive the skin was found in, for the log and the card.
    pub source: String,
}

/// One part of an assembled model: a head, a torso or a pair of legs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPart {
    /// The name the part carries inside the cvar and the `.skin` file it
    /// names, row prefix included: `head_a1`.
    pub id: String,
    /// Absolute path of the cached icon, or `null` when the picture could not
    /// be read. A part with no icon *entry* is not listed at all; this is the
    /// narrower case of an entry that failed to decode.
    pub icon: Option<String>,
}

/// The three rows an assembled model offers, each already filtered down to the
/// parts that carry an icon and sorted by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelParts {
    pub heads: Vec<ModelPart>,
    pub torsos: Vec<ModelPart>,
    pub legs: Vec<ModelPart>,
}

/// One saber hilt a profile may name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaberHilt {
    /// What goes into `saber1` or `saber2`: the name of the `.sab` block.
    pub id: String,
    /// Name for the list: the `name` field of the block, written out of the
    /// string table when it is a `@KEY`, and the block name when it is
    /// neither.
    pub name: String,
    /// `single`, `staff`, or the `saberType` of the block lowercased without
    /// its `saber_` prefix for the dozen shapes only story sabers use.
    pub saber_type: String,
    /// The archive the hilt was found in.
    pub source: String,
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/// Last answer per client, keyed by what the sources looked like.
///
/// Scanning `assets1.pk3` is 652 MB of central directory and two hundred icons
/// to extract, and the profile form asks again on every mount. The signature
/// covers the path, the size and the modification time of every source, so any
/// change on disk misses the cache by itself; [`forget`] drops the entry when
/// the library of a client changes, which is the one event that arrives before
/// the file times are read again.
type Answers<T> = LazyLock<Mutex<HashMap<String, (String, Vec<T>)>>>;

static MODEL_CACHE: Answers<PlayerModel> = LazyLock::new(|| Mutex::new(HashMap::new()));
static HILT_CACHE: Answers<SaberHilt> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Forgets what was found for one client.
///
/// Called by `library::notify`, so a pk3 the player enabled a second ago is in
/// the skin list without waiting for the file times to be compared.
pub(crate) fn forget(client_id: &str) {
    if let Ok(mut cache) = MODEL_CACHE.lock() {
        cache.remove(client_id);
    }
    if let Ok(mut cache) = HILT_CACHE.lock() {
        cache.remove(client_id);
    }
}

fn cached<T: Clone>(cache: &Answers<T>, client_id: &str, signature: &str) -> Option<Vec<T>> {
    let guard = cache.lock().ok()?;
    let (stored, answer) = guard.get(client_id)?;
    (stored == signature).then(|| answer.clone())
}

fn remember<T>(cache: &Answers<T>, client_id: &str, signature: &str, answer: &[T])
where
    T: Clone,
{
    if let Ok(mut guard) = cache.lock() {
        guard.insert(
            client_id.to_string(),
            (signature.to_string(), answer.to_vec()),
        );
    }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// One archive a scan reads.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Source {
    path: PathBuf,
    /// Modification time in Unix seconds, `0` when the system reports none.
    mtime: u64,
    size: u64,
}

/// Every archive one client loads, in the order the engine loads them.
///
/// Later wins, exactly as in `levelshots.rs`: the retail archives of the game
/// first, then the mod folders of the client's own `home\` in name order, and
/// inside each folder the archives sorted by `paksort`. A skin a player
/// installed into a client therefore beats a stock skin of the same name, which
/// is what they see in the game.
///
/// Loose files are not read. The engine does read an unpacked
/// `models/players/kyle/model_red.skin`, and nobody ships skins that way; the
/// limitation is written down in `docs/architecture.md` rather than guessed at.
fn collect_sources(paths: &DataPaths, settings: &Settings, client: &Client) -> Vec<Source> {
    let mut sources = Vec::new();

    if let Some(game_data) = settings.game_data_path(client.game) {
        collect_from_folder(
            &Path::new(game_data).join(paths::BASE_FOLDER),
            &mut sources,
        );
    }

    // Every folder under `home\`, not only `base` and the client's own
    // `fs_game`: reading the folder names costs one `read_dir` each and spares
    // this module a second copy of the rule that resolves `fs_game`.
    let home = paths.client_home_dir(&client.id);
    let Ok(entries) = fs::read_dir(&home) else {
        return sources;
    };
    let mut folders: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();
    folders.sort();
    for folder in folders {
        collect_from_folder(&folder, &mut sources);
    }
    sources
}

/// Adds the enabled archives of one folder, in `paksort` order.
///
/// A `.pk3.disabled` file is skipped: the engine reads the extension alone, so
/// a file the player switched off is not on the search path and its skins are
/// not there to choose.
fn collect_from_folder(folder: &Path, out: &mut Vec<Source>) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut archives: Vec<((u8, String), Source)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !name.to_ascii_lowercase().ends_with(".pk3") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                pak_order(&name),
                Source {
                    path: entry.path(),
                    mtime: meta
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|since| since.as_secs())
                        .unwrap_or(0),
                    size: meta.len(),
                },
            ))
        })
        .collect();
    archives.sort_by(|a, b| a.0.cmp(&b.0));
    out.extend(archives.into_iter().map(|(_, source)| source));
}

/// What the sources looked like, so an unchanged disk costs no second scan.
fn signature(sources: &[Source]) -> String {
    sources
        .iter()
        .map(|source| {
            format!(
                "{}|{}|{}",
                source.path.display(),
                source.size,
                source.mtime
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Everything a scan needs, read off the state in one place.
struct Inputs {
    client: Client,
    sources: Vec<Source>,
    signature: String,
    cache_dir: PathBuf,
}

fn resolve(state: &AppState, client_id: &str) -> Result<Inputs> {
    let paths = state.paths()?;
    let settings = state.settings()?;
    let client = clients::read_record(&paths, client_id)?;
    let sources = collect_sources(&paths, &settings, &client);
    let signature = signature(&sources);
    let cache_dir = paths.cache.join(CACHE_DIR).join(client.game.id());
    Ok(Inputs {
        client,
        sources,
        signature,
        cache_dir,
    })
}

// ---------------------------------------------------------------------------
// Entry names
// ---------------------------------------------------------------------------

/// Reads `models/players/<model>/model_<variant>.skin` out of an entry path.
///
/// Returns the model folder and the variant, both lowercase. Anything else —
/// a folder entry, a texture, a `.skin` outside a model folder, a file in a
/// subfolder of one — yields nothing.
fn skin_entry(entry: &str) -> Option<(String, String)> {
    let lower = entry.replace('\\', "/").to_ascii_lowercase();
    let rest = lower.strip_prefix(MODEL_PREFIX)?;
    let (model, file) = rest.split_once('/')?;
    let variant = file.strip_prefix("model_")?.strip_suffix(".skin")?;
    if model.is_empty() || variant.is_empty() || file.contains('/') {
        return None;
    }
    Some((model.to_string(), variant.to_string()))
}

/// Reads `models/players/<model>/icon_<variant>.<ext>` out of an entry path.
fn icon_entry(entry: &str) -> Option<(String, String, String)> {
    let lower = entry.replace('\\', "/").to_ascii_lowercase();
    let rest = lower.strip_prefix(MODEL_PREFIX)?;
    let (model, file) = rest.split_once('/')?;
    if model.is_empty() || file.contains('/') {
        return None;
    }
    let (stem, extension) = file.rsplit_once('.')?;
    let variant = stem.strip_prefix("icon_")?;
    if variant.is_empty() || !ICON_EXTENSIONS.contains(&extension) {
        return None;
    }
    Some((model.to_string(), variant.to_string(), extension.to_string()))
}

/// Reads `models/players/<model>/<row>_<variant>.skin` out of an entry path.
///
/// Returns the model folder and the whole part name, row prefix included, both
/// lowercase. An ordinary `model_<variant>.skin` yields nothing: none of the
/// three row prefixes is `model_`, so the two readers never claim the same
/// entry.
fn part_entry(entry: &str) -> Option<(String, String)> {
    let lower = entry.replace('\\', "/").to_ascii_lowercase();
    let rest = lower.strip_prefix(MODEL_PREFIX)?;
    let (model, file) = rest.split_once('/')?;
    if model.is_empty() || file.contains('/') {
        return None;
    }
    let part = file.strip_suffix(".skin")?;
    let prefix = PART_PREFIXES
        .iter()
        .find(|prefix| part.starts_with(**prefix))?;
    // `head_.skin` names a row and no variant inside it. The engine would
    // take it — it compares the prefix and nothing else — and the value it
    // built would name a part nobody can tell from another.
    if part.len() == prefix.len() {
        return None;
    }
    // The row prefix counts: it is part of the name the engine copies into a
    // `skinName_t`, and that copy cuts what does not fit. See
    // `MAX_SKIN_PART_LEN`.
    if part.len() > MAX_SKIN_PART_LEN {
        return None;
    }
    Some((model.to_string(), part.to_string()))
}

/// The model folder of a `models/players/<model>/playerchoice.txt` entry.
fn playerchoice_entry(entry: &str) -> Option<String> {
    let lower = entry.replace('\\', "/").to_ascii_lowercase();
    let rest = lower.strip_prefix(MODEL_PREFIX)?;
    let (model, file) = rest.split_once('/')?;
    (!model.is_empty() && file == PLAYERCHOICE_FILE).then(|| model.to_string())
}

/// The value the cvar `model` takes for one model and variant.
///
/// `default` is the variant the engine assumes for a name without a `/`, so
/// `kyle` and `kyle/default` are the same skin and the shorter one is what the
/// game's own menu writes.
fn model_value(model: &str, variant: &str) -> String {
    if variant == "default" {
        model.to_string()
    } else {
        format!("{model}/{variant}")
    }
}

/// The skin name of an assembled model: the three parts joined by `|`.
///
/// The order is the engine's, `head|torso|lower`, and it is not free: the
/// three names go into `ui_char_skin_head`, `ui_char_skin_torso` and
/// `ui_char_skin_legs` in that order in `UI_GetCharacterCvars`
/// (`codemp/ui/ui_main.c:5010` and below), which reads the value back by
/// position and not by the row prefix each name happens to carry.
fn assembled_variant(head: &str, torso: &str, legs: &str) -> String {
    format!("{head}|{torso}|{legs}")
}

/// Whether a model or a variant name may become part of a file name.
///
/// Entry paths come out of an archive a stranger built, and this is what keeps
/// a crafted `..` from naming a file outside the cache folder.
fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SEGMENT_LEN
        && value != "."
        && value != ".."
        && value.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.' | '+')
        })
}

/// The name a cached icon gets: `<model>__<variant>.<ext>`, one flat file, so
/// the cache folder of a game never grows a subfolder.
fn cache_file_name(model: &str, variant: &str, extension: &str) -> Option<String> {
    (safe_segment(model) && safe_segment(variant))
        .then(|| format!("{model}__{variant}.{extension}"))
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/// The limits every decode in this module runs under.
///
/// Explicit rather than inherited: [`Limits::default`] leaves the dimensions
/// unbounded and caps allocation alone, so the protection would be whatever the
/// next version of the crate decides it is.
fn decode_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits
}

fn reader(bytes: &[u8], format: ImageFormat) -> ImageReader<Cursor<&[u8]>> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decode_limits());
    reader
}

/// Reads an icon, caps it and writes it into the cache folder of the game.
///
/// JPEG and PNG within [`MAX_SIDE`] are copied byte for byte: re-encoding a
/// 128×128 retail icon only makes it worse. Anything larger is downscaled, and
/// TGA is always converted because no browser reads it.
///
/// An icon over the decode limits is skipped with a warning rather than failing
/// the archive around it, exactly as a map picture is: the pk3 usually carries
/// other skins, and the player wrote none of them.
fn store_icon(
    bytes: &[u8],
    model: &str,
    variant: &str,
    extension: &str,
    source: &str,
    dir: &Path,
) -> Result<Option<PathBuf>> {
    let format = match extension {
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "tga" => ImageFormat::Tga,
        _ => return Ok(None),
    };
    let (width, height) = match reader(bytes, format).into_dimensions() {
        Ok(size) => size,
        Err(e) if matches!(e, image::ImageError::Limits(_)) => {
            log::warn!("the icon of {model}/{variant} in {source} is too large: {e}");
            return Ok(None);
        }
        Err(e) => return Err(e.into()),
    };
    if width == 0 || height == 0 {
        return Ok(None);
    }

    let fits = width.max(height) <= MAX_SIDE;
    let target_extension = match format {
        ImageFormat::Jpeg => "jpg",
        // A converted TGA becomes a PNG: it may carry an alpha channel, and an
        // icon is flat art, where PNG is both smaller and lossless.
        _ => "png",
    };
    let Some(file_name) = cache_file_name(model, variant, target_extension) else {
        log::warn!("{model}/{variant} from {source} is not a usable file name");
        return Ok(None);
    };

    let encoded = if fits && format != ImageFormat::Tga {
        bytes.to_vec()
    } else {
        let decoded = match reader(bytes, format).decode() {
            Ok(decoded) => decoded,
            // The dimensions passed and the pixels did not: a picture inside
            // the side limit can still ask for more memory than the budget.
            Err(e) if matches!(e, image::ImageError::Limits(_)) => {
                log::warn!("the icon of {model}/{variant} in {source} is too large: {e}");
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        };
        let decoded = if fits {
            decoded
        } else {
            decoded.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle)
        };
        let mut out = Vec::new();
        if format == ImageFormat::Jpeg {
            // The JPEG encoder refuses an alpha channel, and a decoded picture
            // may well have one.
            decoded
                .to_rgb8()
                .write_with_encoder(JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY))?;
        } else {
            decoded.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)?;
        }
        out
    };

    let file = dir.join(&file_name);
    // A picture the webview is showing may be locked on Windows. That costs
    // this one skin its icon, not the whole scan.
    if let Err(e) = fs::write(&file, &encoded) {
        log::warn!("cannot write {}: {e}", file.display());
        return Ok(None);
    }
    Ok(Some(file))
}

/// Whether the cached icon is already newer than the archive it came from.
///
/// The scan runs once per launcher run per client, and without this every run
/// would extract two hundred icons again. A changed pk3 is newer than the
/// cache file and gets extracted; an unchanged one is skipped.
fn icon_is_current(file: &Path, source: &Source) -> bool {
    let Ok(meta) = fs::metadata(file) else {
        return false;
    };
    if meta.len() == 0 {
        return false;
    }
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_secs() >= source.mtime)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// --- slice: skins and hilts ---
// The composed preview of an assembled model
// ---------------------------------------------------------------------------

/// The three parts of an assembled `model` value, in the order the engine
/// reads them back.
///
/// The reader is the engine's own, `UI_GetCharacterCvars`
/// (`codemp/ui/ui_main.c:5010` and below of OpenJK `1a6a6434`): cut at the
/// **last** `/`, then take what is left apart at two `|`. Anything else — an
/// ordinary `kyle/red`, a value with four parts, a part left empty — is not an
/// assembled skin and yields nothing.
fn split_assembled(value: &str) -> Option<(&str, [&str; 3])> {
    let (model, skin) = value.rsplit_once('/')?;
    let mut parts = skin.split('|');
    let (Some(head), Some(torso), Some(legs), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if model.is_empty() || head.is_empty() || torso.is_empty() || legs.is_empty() {
        return None;
    }
    Some((model, [head, torso, legs]))
}

/// The name the composed preview of one combination is cached under.
///
/// Four segments and not three: two models may well share a head named
/// `head_a1`, and the whole combination is what the picture shows. Every
/// segment goes through [`safe_segment`] for the reason the icon cache does —
/// the names come out of an archive a stranger built.
fn preview_file_name(model: &str, picks: [&str; 3]) -> Option<String> {
    if !safe_segment(model) || !picks.iter().all(|pick| safe_segment(pick)) {
        return None;
    }
    let [head, torso, legs] = picks;
    Some(format!("{model}__{head}__{torso}__{legs}.png"))
}

/// Whether the composed file is newer than every icon that went into it.
///
/// The icons themselves are kept current against the archives they came out of
/// by [`icon_is_current`], so this second comparison is the whole freshness
/// rule: a pk3 the player installed makes the icon newer, and the newer icon
/// makes the preview stale.
fn preview_is_current(file: &Path, icons: [Option<&Path>; 3]) -> bool {
    let Some(made) = modified_at(file) else {
        return false;
    };
    if made == 0 {
        return false;
    }
    icons
        .iter()
        .flatten()
        .all(|icon| modified_at(icon).is_some_and(|when| made >= when))
}

/// Modification time of a non-empty file in Unix seconds.
fn modified_at(file: &Path) -> Option<u64> {
    let meta = fs::metadata(file).ok()?;
    if meta.len() == 0 {
        return None;
    }
    Some(
        meta.modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_secs())
            .unwrap_or(0),
    )
}

/// Stacks a head, a torso and a pair of legs into one picture on a light
/// ground.
///
/// Three square rows, top to bottom, which is the order the engine reads the
/// value in and the order a person is built in. The answer is a PNG **without
/// an alpha channel**: [`PREVIEW_GROUND`] is opaque and the encode drops the
/// channel, so nothing of the page behind shows through a part the artist cut
/// away. That is the whole point of composing at all — three part icons drawn
/// as three tiles read as three cut-out limbs floating over a dark surface.
///
/// A row whose icon is missing or will not decode is left as bare ground
/// rather than failing the picture around it, exactly as one unreadable icon
/// costs its own skin and not the archive. Only a combination with no
/// readable icon at all answers `None`: a picture of nothing but ground says
/// less than the text tile the window already draws for a skin with no icon.
fn compose_preview(rows: [Option<Vec<u8>>; 3]) -> Result<Option<Vec<u8>>> {
    use image::imageops::{self, FilterType};
    use image::{DynamicImage, Rgba, RgbaImage};

    let [ground_r, ground_g, ground_b] = PREVIEW_GROUND;
    let mut sheet = RgbaImage::from_pixel(
        PREVIEW_SIDE,
        PREVIEW_SIDE * rows.len() as u32,
        Rgba([ground_r, ground_g, ground_b, 0xff]),
    );

    let mut drawn = 0usize;
    for (row, bytes) in rows.iter().enumerate() {
        let Some(bytes) = bytes else { continue };
        let Some(decoded) = decode_row(bytes) else {
            continue;
        };
        // `resize` fits inside the box and keeps the aspect ratio; the retail
        // icons are square and come back untouched.
        let scaled = decoded
            .resize(PREVIEW_SIDE, PREVIEW_SIDE, FilterType::Triangle)
            .to_rgba8();
        let x = (PREVIEW_SIDE.saturating_sub(scaled.width()) / 2) as i64;
        let y = (row as u32 * PREVIEW_SIDE + PREVIEW_SIDE.saturating_sub(scaled.height()) / 2)
            as i64;
        // `overlay` blends by alpha, so a cut-away pixel keeps the ground.
        imageops::overlay(&mut sheet, &scaled, x, y);
        drawn += 1;
    }
    if drawn == 0 {
        return Ok(None);
    }

    let mut out = Vec::new();
    DynamicImage::ImageRgba8(sheet)
        .to_rgb8()
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)?;
    Ok(Some(out))
}

/// Decodes one cached icon under the limits of this module, or `None`.
///
/// The format is guessed rather than taken from the file name: the cache holds
/// JPEG and PNG, and a byte that is neither is a file somebody else wrote into
/// the folder.
fn decode_row(bytes: &[u8]) -> Option<image::DynamicImage> {
    let format = image::guess_format(bytes).ok()?;
    match reader(bytes, format).decode() {
        Ok(decoded) => Some(decoded),
        Err(e) => {
            log::warn!("a part icon of an assembled model will not decode: {e}");
            None
        }
    }
}

/// The composed preview of one combination, built when the cache holds nothing
/// current.
///
/// `dir` is the icon cache of the game; the picture goes into [`PREVIEW_DIR`]
/// inside it.
fn cached_preview(
    dir: &Path,
    model: &str,
    picks: [&str; 3],
    icons: [Option<&Path>; 3],
) -> Result<Option<PathBuf>> {
    let Some(name) = preview_file_name(model, picks) else {
        log::warn!("{model} and its parts are not a usable file name");
        return Ok(None);
    };
    let folder = dir.join(PREVIEW_DIR);
    let file = folder.join(name);
    if preview_is_current(&file, icons) {
        return Ok(Some(file));
    }

    let rows = icons.map(|icon| icon.and_then(|path| fs::read(path).ok()));
    let Some(bytes) = compose_preview(rows)? else {
        return Ok(None);
    };
    paths::create_dir(&folder)?;
    // A picture the webview is showing may be locked on Windows, exactly as an
    // icon may. That costs this one preview and not the scan around it.
    if let Err(e) = fs::write(&file, &bytes) {
        log::warn!("cannot write {}: {e}", file.display());
        return Ok(None);
    }
    Ok(Some(file))
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// What one archive holds of the things this module looks for.
#[derive(Default)]
struct Found {
    /// `<model>/<variant>` to the entry name of its `.skin`.
    skins: BTreeMap<String, String>,
    /// `<model>/<variant>` to the entry name of its icon and its extension.
    /// Keyed the same way for a whole skin and for a part, because
    /// `icon_head_a1.jpg` reads as the variant `head_a1` of its model.
    icons: BTreeMap<String, (String, String)>,
    /// `<model>/<part>` of every `head_`, `torso_` or `lower_` `.skin`.
    parts: BTreeSet<String>,
    /// Model folders that carry a `playerchoice.txt`.
    choices: BTreeSet<String>,
}

/// Reads the central directory of one archive and sorts the names it wants.
fn look_into(path: &Path) -> Result<(ZipArchive<BufReader<File>>, Found)> {
    let file = File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let archive = ZipArchive::new(BufReader::new(file))?;

    let mut found = Found::default();
    for name in archive.file_names() {
        if let Some((model, variant)) = skin_entry(name) {
            found
                .skins
                .insert(format!("{model}/{variant}"), name.to_string());
            continue;
        }
        if let Some((model, part)) = part_entry(name) {
            found.parts.insert(format!("{model}/{part}"));
            continue;
        }
        if let Some(model) = playerchoice_entry(name) {
            found.choices.insert(model);
            continue;
        }
        if let Some((model, variant, extension)) = icon_entry(name) {
            found
                .icons
                .insert(format!("{model}/{variant}"), (name.to_string(), extension));
        }
    }
    Ok((archive, found))
}

/// Reads one entry, or `None` when it is larger than the cap for its kind.
fn read_entry(
    archive: &mut ZipArchive<BufReader<File>>,
    name: &str,
    path: &Path,
    cap: u64,
) -> Result<Option<Vec<u8>>> {
    let mut entry = archive.by_name(name)?;
    if entry.size() > cap {
        log::warn!(
            "{name} in {} is {} bytes, more than this kind of file can be",
            path.display(),
            entry.size()
        );
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::io_path("cannot read an entry of", path, e))?;
    Ok(Some(bytes))
}

/// Builds the skin list of one client out of its sources.
///
/// Later sources overwrite earlier ones by `<model>/<variant>`, which is the
/// engine's own rule: a skin installed into the client beats the stock one of
/// the same name.
fn scan_models(sources: &[Source], dir: &Path) -> Result<Vec<PlayerModel>> {
    paths::create_dir(dir)?;
    let mut skins: BTreeMap<String, PlayerModel> = BTreeMap::new();

    for source in sources {
        let outcome = scan_models_of(source, dir, &mut skins);
        // One damaged pk3 costs its own skins and nothing else.
        if let Err(e) = outcome {
            log::warn!("cannot read {}: {e}", source.path.display());
        }
    }
    Ok(skins.into_values().collect())
}

fn scan_models_of(
    source: &Source,
    dir: &Path,
    skins: &mut BTreeMap<String, PlayerModel>,
) -> Result<()> {
    let (mut archive, found) = look_into(&source.path)?;
    let label = source.path.display().to_string();

    for key in found.skins.keys() {
        // The rule of the game's own menu: a skin with no icon beside it is
        // not a skin a player picks. See the module docs.
        let Some((entry, extension)) = found.icons.get(key) else {
            continue;
        };
        let Some((model, variant)) = key.split_once('/') else {
            continue;
        };
        if !safe_segment(model) || !safe_segment(variant) {
            continue;
        }

        let icon = match cached_icon(&mut archive, source, dir, model, variant, entry, extension) {
            Ok(icon) => icon,
            Err(e) => {
                log::warn!("cannot extract the icon of {key} from {label}: {e}");
                None
            }
        };
        skins.insert(
            key.to_string(),
            PlayerModel {
                value: model_value(model, variant),
                model: model.to_string(),
                variant: variant.to_string(),
                icon: icon.map(|path| path.display().to_string()),
                parts: None,
                preview: None,
                source: label.clone(),
            },
        );
    }

    scan_assembled_of(&mut archive, &found, source, dir, &label, skins);
    Ok(())
}

/// Adds the assembled models of one archive to the same list as its skins.
///
/// A model folder qualifies when it carries a `playerchoice.txt` and has at
/// least one head, one torso and one pair of legs with an icon beside each.
/// The engine's own gate is the same one written differently: `iSkinParts`
/// gets a bit per row and a folder that did not collect all three is dropped
/// (`codemp/ui/ui_main.c:9787`).
///
/// One archive at a time, exactly as whole skins are read: a part and its icon
/// have to come out of the same pk3, and an archive later on the search path
/// replaces the whole model rather than merging a row into it. That is the
/// module's existing rule — `found.skins` and `found.icons` have always been
/// per archive — and it costs a skin pack that ships one extra head with no
/// `playerchoice.txt` beside it, which is not how such packs are built
/// (**unverified**: no such pack was tried).
fn scan_assembled_of(
    archive: &mut ZipArchive<BufReader<File>>,
    found: &Found,
    source: &Source,
    dir: &Path,
    label: &str,
    skins: &mut BTreeMap<String, PlayerModel>,
) {
    for model in &found.choices {
        if !safe_segment(model) {
            continue;
        }
        let prefix = format!("{model}/");
        // `BTreeSet` keeps the parts of one model together and in name order,
        // so the first of each row is the one the tile opens on.
        let mut rows: [Vec<ModelPart>; PART_PREFIXES.len()] = Default::default();
        let of_this_model = found
            .parts
            .range(prefix.clone()..)
            .take_while(|key| key.starts_with(&prefix));
        for key in of_this_model {
            let part = &key[prefix.len()..];
            let Some(row) = PART_PREFIXES
                .iter()
                .position(|candidate| part.starts_with(candidate))
            else {
                continue;
            };
            // The rule of the game's own menu, the same one whole skins go by.
            let Some((entry, extension)) = found.icons.get(key) else {
                continue;
            };
            if !safe_segment(part) {
                continue;
            }
            let icon = match cached_icon(archive, source, dir, model, part, entry, extension) {
                Ok(icon) => icon,
                Err(e) => {
                    log::warn!("cannot extract the icon of {key} from {label}: {e}");
                    None
                }
            };
            rows[row].push(ModelPart {
                id: part.to_string(),
                icon: icon.map(|path| path.display().to_string()),
            });
        }

        let [heads, torsos, legs] = rows;
        let (Some(head), Some(torso), Some(leg)) = (heads.first(), torsos.first(), legs.first())
        else {
            // A row with nothing in it is a model the game does not offer
            // either, and offering two rows of three would build a value the
            // engine reads as an ordinary skin that does not exist.
            continue;
        };
        let variant = assembled_variant(&head.id, &torso.id, &leg.id);
        // --- slice: skins and hilts ---
        // Composed here, where the three icons of the combination the list
        // opens on are already in hand. A combination the player builds
        // afterwards goes through `assembled_skin_preview`, which shares
        // every function below this line.
        let preview = match cached_preview(
            dir,
            model,
            [&head.id, &torso.id, &leg.id],
            [
                head.icon.as_deref().map(Path::new),
                torso.icon.as_deref().map(Path::new),
                leg.icon.as_deref().map(Path::new),
            ],
        ) {
            Ok(preview) => preview,
            Err(e) => {
                log::warn!("cannot compose the preview of {model} from {label}: {e}");
                None
            }
        };
        let entry = PlayerModel {
            value: format!("{model}/{variant}"),
            model: model.clone(),
            variant,
            icon: head.icon.clone(),
            parts: Some(ModelParts {
                heads: heads.clone(),
                torsos: torsos.clone(),
                legs: legs.clone(),
            }),
            preview: preview.map(|path| path.display().to_string()),
            source: label.to_string(),
        };
        // A key no ordinary variant can take, so a model has one assembled
        // tile however its rows are filled and a later archive replaces that
        // tile instead of adding a second one. `safe_segment` refuses `|`.
        skins.insert(format!("{model}/|"), entry);
    }
}

/// The cached icon of one skin, extracted if the cache has nothing current.
fn cached_icon(
    archive: &mut ZipArchive<BufReader<File>>,
    source: &Source,
    dir: &Path,
    model: &str,
    variant: &str,
    entry: &str,
    extension: &str,
) -> Result<Option<PathBuf>> {
    let target_extension = if extension == "png" || extension == "tga" {
        "png"
    } else {
        "jpg"
    };
    if let Some(name) = cache_file_name(model, variant, target_extension) {
        let file = dir.join(name);
        if icon_is_current(&file, source) {
            return Ok(Some(file));
        }
    }
    let Some(bytes) = read_entry(archive, entry, &source.path, MAX_ENTRY_BYTES)? else {
        return Ok(None);
    };
    store_icon(
        &bytes,
        model,
        variant,
        extension,
        &source.path.display().to_string(),
        dir,
    )
}

/// Builds the hilt list of one client out of its sources.
fn scan_hilts(sources: &[Source]) -> Vec<SaberHilt> {
    let mut hilts: BTreeMap<String, SaberHilt> = BTreeMap::new();
    let mut strings: BTreeMap<String, String> = BTreeMap::new();

    for source in sources {
        if let Err(e) = scan_hilts_of(source, &mut hilts, &mut strings) {
            log::warn!("cannot read {}: {e}", source.path.display());
        }
    }

    // The names are written out after every source is read, so a string table
    // in a later archive still reaches a hilt defined in an earlier one.
    for hilt in hilts.values_mut() {
        if let Some(key) = hilt.name.strip_prefix('@') {
            hilt.name = strings
                .get(&key.to_ascii_lowercase())
                .cloned()
                .unwrap_or_else(|| hilt.id.clone());
        }
        if hilt.name.is_empty() {
            hilt.name = hilt.id.clone();
        }
    }
    hilts.into_values().collect()
}

fn scan_hilts_of(
    source: &Source,
    hilts: &mut BTreeMap<String, SaberHilt>,
    strings: &mut BTreeMap<String, String>,
) -> Result<()> {
    let file = File::open(&source.path)
        .map_err(|e| AppError::io_path("cannot open", &source.path, e))?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;

    let names: Vec<String> = archive
        .file_names()
        .filter(|name| {
            let lower = name.replace('\\', "/").to_ascii_lowercase();
            (lower.starts_with(SABER_PREFIX) && lower.ends_with(".sab"))
                || (lower.starts_with(STRINGS_PREFIX) && lower.ends_with(".str"))
        })
        .map(|name| name.to_string())
        .collect();

    let label = source.path.display().to_string();
    for name in names {
        let bytes = match read_entry(&mut archive, &name, &source.path, MAX_TEXT_BYTES) {
            Ok(Some(bytes)) => bytes,
            // Over the size a text file can be: already logged, and the
            // remaining entries of the archive are still worth reading.
            Ok(None) => continue,
            // One damaged entry costs its own hilts and nothing else, exactly
            // as one damaged icon costs its own skin in `scan_models_of`.
            //
            // This used to be a `?`, and the difference is the whole of «the
            // skins are there and the hilts are not»: the question mark left
            // the loop, `scan_hilts` logged one warning about the archive and
            // went on to the next source, and every hilt this archive had not
            // yet been read for was gone. On a retail install `assets1.pk3`
            // holds all fifteen of them, so a single unreadable entry emptied
            // the list while the skin grid, which forgives the same failure,
            // filled normally.
            Err(e) => {
                log::warn!("cannot read {name} of {}: {e}", source.path.display());
                continue;
            }
        };
        // Raven wrote these tables in the code page of their machine, so a
        // stray byte is replaced rather than failing the file around it.
        let text = String::from_utf8_lossy(&bytes);
        let lower = name.replace('\\', "/").to_ascii_lowercase();
        if lower.ends_with(".str") {
            let stem = Path::new(&lower)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_string();
            strings.extend(parse_strings(&text, &stem));
            continue;
        }
        for hilt in parse_sabers(&text, &label) {
            hilts.insert(hilt.id.to_ascii_lowercase(), hilt);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The two text formats
// ---------------------------------------------------------------------------

/// Splits a Raven text file into tokens, dropping both kinds of comment.
///
/// A quoted group is one token without its quotes, `{` and `}` are tokens of
/// their own, and everything else is separated by whitespace. The same shape
/// the engine's `COM_ParseExt` reads.
fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut at = 0;

    while at < bytes.len() {
        let ch = bytes[at];
        if ch.is_whitespace() {
            at += 1;
            continue;
        }
        if ch == '/' && bytes.get(at + 1) == Some(&'/') {
            while at < bytes.len() && bytes[at] != '\n' {
                at += 1;
            }
            continue;
        }
        if ch == '/' && bytes.get(at + 1) == Some(&'*') {
            at += 2;
            while at < bytes.len() && !(bytes[at] == '*' && bytes.get(at + 1) == Some(&'/')) {
                at += 1;
            }
            at = (at + 2).min(bytes.len());
            continue;
        }
        if ch == '"' {
            at += 1;
            let mut quoted = String::new();
            while at < bytes.len() && bytes[at] != '"' {
                quoted.push(bytes[at]);
                at += 1;
            }
            at += 1;
            tokens.push(quoted);
            continue;
        }
        if ch == '{' || ch == '}' {
            tokens.push(ch.to_string());
            at += 1;
            continue;
        }
        let mut word = String::new();
        while at < bytes.len()
            && !bytes[at].is_whitespace()
            && bytes[at] != '{'
            && bytes[at] != '}'
            && bytes[at] != '"'
        {
            word.push(bytes[at]);
            at += 1;
        }
        tokens.push(word);
    }
    tokens
}

/// Reads the named blocks of a `.sab` file.
///
/// The block name is what `saber1` takes; `name` is the label the menu prints,
/// often a `@KEY` of a string table; `saberType` is the shape; `notInMP 1`
/// hides the hilt from multiplayer, which is `WP_SaberValidForPlayerInMP`
/// (`codemp/game/bg_saberLoad.c:2170-2185` of OpenJK `1a6a6434`) and the reason
/// the fourteen story sabers of `sabers.sab` are not on this list.
fn parse_sabers(text: &str, source: &str) -> Vec<SaberHilt> {
    let tokens = tokenize(text);
    let mut hilts = Vec::new();
    let mut at = 0;

    while at < tokens.len() {
        let id = tokens[at].clone();
        at += 1;
        if id == "{" || id == "}" || tokens.get(at).map(String::as_str) != Some("{") {
            continue;
        }
        at += 1; // the opening brace

        let mut fields: BTreeMap<String, String> = BTreeMap::new();
        let mut depth = 1usize;
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
                key if depth == 1 => {
                    let key = key.to_ascii_lowercase();
                    at += 1;
                    let value = match tokens.get(at) {
                        Some(value) if value != "}" && value != "{" => {
                            at += 1;
                            value.clone()
                        }
                        _ => String::new(),
                    };
                    fields.insert(key, value);
                }
                _ => at += 1,
            }
        }

        if fields.get("notinmp").is_some_and(|value| value.trim() != "0") {
            continue;
        }
        let saber_type = fields
            .get("sabertype")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        let saber_type = saber_type
            .strip_prefix("saber_")
            .unwrap_or(&saber_type)
            .to_string();
        if saber_type.is_empty() || saber_type == "none" {
            continue;
        }
        hilts.push(SaberHilt {
            name: fields.get("name").cloned().unwrap_or_default(),
            id,
            saber_type,
            source: source.to_string(),
        });
    }
    hilts
}

/// Reads a Raven `.str` table into `<file>_<reference>` → English text.
///
/// The format is pairs of lines: `REFERENCE SINGLE_HILT1` then
/// `LANG_ENGLISH "Arbiter"`. A `.sab` refers to an entry by the file name and
/// the reference joined with an underscore, which is what `@MENUS_SINGLE_HILT1`
/// is: the table `MENUS.str`, the reference `SINGLE_HILT1`.
fn parse_strings(text: &str, file_stem: &str) -> BTreeMap<String, String> {
    let mut table = BTreeMap::new();
    let mut reference: Option<String> = None;

    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("REFERENCE") {
            reference = Some(rest.trim().to_ascii_lowercase());
            continue;
        }
        let Some(rest) = line.strip_prefix("LANG_ENGLISH") else {
            continue;
        };
        let Some(reference) = reference.take() else {
            continue;
        };
        let value = rest.trim().trim_matches('"').to_string();
        if !value.is_empty() {
            table.insert(format!("{file_stem}_{reference}"), value);
        }
    }
    table
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every skin this client can offer a profile, sorted by model and variant.
///
/// The work goes through `spawn_blocking`: opening the central directory of a
/// 652 MB archive and extracting two hundred icons both block, and the runtime
/// has to keep answering the rest of the launcher meanwhile.
#[tauri::command]
pub async fn list_player_models(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<Vec<PlayerModel>> {
    let (found, fresh) = models_of(&app, &state, &client_id).await?;
    if fresh {
        let assembled = found.iter().filter(|model| model.parts.is_some()).count();
        log::info!(
            "client {client_id}: {} skin(s), {assembled} of them assembled",
            found.len()
        );
    }
    Ok(found)
}

/// The skin list of one client, off the cache or off the archives.
///
/// The second half of the answer says which of the two it was, so the command
/// logs a scan once and [`assembled_skin_preview`], which asks the same
/// question to find three icons, adds no second line per click.
async fn models_of(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    client_id: &str,
) -> Result<(Vec<PlayerModel>, bool)> {
    let inputs = resolve(state, client_id)?;
    if let Some(answer) = cached(&MODEL_CACHE, client_id, &inputs.signature) {
        allow_icons(app, &answer);
        return Ok((answer, false));
    }

    let signature = inputs.signature.clone();
    let found = blocking("the skin list", move || {
        scan_models(&inputs.sources, &inputs.cache_dir)
    })
    .await?;

    remember(&MODEL_CACHE, client_id, &signature, &found);
    allow_icons(app, &found);
    Ok((found, true))
}

/// --- slice: skins and hilts ---
/// The composed picture of one combination of head, torso and legs.
///
/// `value` is the whole cvar, `jedi_hm/head_a1|torso_a1|lower_a1`, and the
/// three parts are looked up in the client's own list rather than trusted: the
/// window is handed cached file paths, and a page that could name any three of
/// them would be a page that could name any file on the disk.
///
/// Answers `null` for a value that is not an assembled skin of this client and
/// for one whose icons could none of them be read. The path it does answer
/// with is allowed on the asset protocol by the very call that built it, the
/// same per-file permission the icons get.
#[tauri::command]
pub async fn assembled_skin_preview(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    value: String,
) -> Result<Option<String>> {
    let Some((model, picks)) = split_assembled(&value) else {
        return Ok(None);
    };
    let (found, _) = models_of(&app, &state, &client_id).await?;
    let Some(entry) = found
        .iter()
        .find(|entry| entry.model == model && entry.parts.is_some())
    else {
        return Ok(None);
    };
    // The list opens on this very combination, so the tile of a model nobody
    // has touched costs no work at all.
    if entry.value == value {
        return Ok(entry.preview.clone());
    }

    let parts = entry.parts.as_ref().expect("filtered above");
    let rows = [&parts.heads, &parts.torsos, &parts.legs];
    let icons: Vec<Option<PathBuf>> = rows
        .iter()
        .zip(picks)
        .map(|(row, pick)| {
            row.iter()
                .find(|part| part.id == pick)
                .and_then(|part| part.icon.as_deref())
                .map(PathBuf::from)
        })
        .collect();
    let [head, torso, legs] = <[Option<PathBuf>; 3]>::try_from(icons).expect("three rows");

    let dir = resolve(&state, &client_id)?.cache_dir;
    let model = model.to_string();
    let picks = picks.map(str::to_string);
    let composed = blocking("the character preview", move || {
        let borrowed = [picks[0].as_str(), picks[1].as_str(), picks[2].as_str()];
        cached_preview(
            &dir,
            &model,
            borrowed,
            [head.as_deref(), torso.as_deref(), legs.as_deref()],
        )
    })
    .await?;

    let Some(file) = composed else {
        return Ok(None);
    };
    let path = file.display().to_string();
    allow_file(&app, &path);
    Ok(Some(path))
}

/// Every saber hilt this client can offer a profile, sorted by id.
#[tauri::command]
pub async fn list_saber_hilts(
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<Vec<SaberHilt>> {
    let inputs = resolve(&state, &client_id)?;
    // A game with no hilt data has no list, and opening four archives to say so
    // would be the cost of answering a question that cannot have an answer.
    if !inputs.client.game.spec().has_saber_hilts {
        return Ok(Vec::new());
    }
    if let Some(answer) = cached(&HILT_CACHE, &client_id, &inputs.signature) {
        return Ok(answer);
    }

    let signature = inputs.signature.clone();
    let found = blocking("the hilt list", move || Ok(scan_hilts(&inputs.sources))).await?;

    remember(&HILT_CACHE, &client_id, &signature, &found);
    log::info!("client {client_id}: {} saber hilt(s)", found.len());
    Ok(found)
}

/// Runs disk and picture work off the async runtime.
async fn blocking<T, F>(what: &'static str, job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::Image(format!("{what} did not finish: {e}")))?
}

/// Lets the webview read the cached icons, each by the very path it is handed.
///
/// A folder pattern is not enough. `Scope::is_allowed` canonicalises the path
/// of the request and matches the result against the patterns
/// (`tauri-2.11.5/src/scope/fs.rs`), so a folder added at startup and a file
/// asked for later agree only while the file system resolves both the same way
/// — and where it does not, every pattern misses and the window gets
/// `asset protocol not configured to allow the path`. That is what happened to
/// the map pictures on 11 September 2026. Allowing the file itself closes the
/// gap: the same call canonicalises the same string.
fn allow_icons(app: &AppHandle, models: &[PlayerModel]) {
    for icon in models.iter().flat_map(icons_of) {
        allow_file(app, icon);
    }
}

/// The same permission for one path, which is what a preview composed after
/// the list needs.
fn allow_file(app: &AppHandle, path: &str) {
    use tauri::Manager;

    if let Err(e) = app.asset_protocol_scope().allow_file(path) {
        log::warn!("cannot serve {path}: {e}");
    }
}

/// Every cached picture of one entry: the tile, the composed preview of an
/// assembled model, and the three rows of parts behind it. The part icons need
/// the same per-file permission as the tile, because the panel draws them.
fn icons_of(model: &PlayerModel) -> impl Iterator<Item = &str> {
    let parts = model.parts.iter().flat_map(|parts| {
        parts
            .heads
            .iter()
            .chain(&parts.torsos)
            .chain(&parts.legs)
            .filter_map(|part| part.icon.as_deref())
    });
    model
        .icon
        .as_deref()
        .into_iter()
        .chain(model.preview.as_deref())
        .chain(parts)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use image::{Rgb, RgbImage};
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;

    fn picture(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let mut image = RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), format)
            .expect("encode");
        bytes
    }

    fn write_pk3(path: &Path, entries: &[(&str, Vec<u8>)]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("the folder");
        }
        let file = File::create(path).expect("create pk3");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("start entry");
            writer.write_all(bytes).expect("write entry");
        }
        writer.finish().expect("finish pk3");
    }

    /// The same archive, with the bytes of one entry damaged.
    ///
    /// `write_pk3` stores its entries rather than deflating them, so the
    /// content of each sits in the file verbatim: finding it and flipping a
    /// byte leaves an archive `zip` opens and lists happily and whose entry
    /// fails its checksum when something reads it. That is what a pk3 left
    /// behind by a dropped download looks like from the reader's side.
    fn damage_entry(path: &Path, content: &[u8]) {
        let mut bytes = fs::read(path).expect("the archive");
        let at = bytes
            .windows(content.len())
            .position(|window| window == content)
            .expect("the stored bytes of the entry");
        bytes[at] ^= 0xFF;
        fs::write(path, bytes).expect("the damaged archive");
    }

    fn source_of(path: &Path) -> Source {
        let meta = fs::metadata(path).expect("the archive");
        Source {
            path: path.to_path_buf(),
            mtime: meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_secs())
                .unwrap_or(0),
            size: meta.len(),
        }
    }

    #[test]
    fn an_entry_path_names_a_model_and_a_variant() {
        assert_eq!(
            skin_entry("models/players/kyle/model_default.skin"),
            Some(("kyle".into(), "default".into()))
        );
        assert_eq!(
            skin_entry("MODELS\\PLAYERS\\Jedi_HF\\Model_Siege.skin"),
            Some(("jedi_hf".into(), "siege".into()))
        );
        // Everything that is not one choosable skin.
        assert_eq!(skin_entry("models/players/kyle/"), None);
        assert_eq!(skin_entry("models/players/kyle/kyle_legs.tga"), None);
        assert_eq!(skin_entry("models/players/_humanoid/animation.cfg"), None);
        assert_eq!(skin_entry("models/weapons2/saber/saber_w.glm"), None);
        assert_eq!(skin_entry("models/players/kyle/sub/model_red.skin"), None);
    }

    #[test]
    fn an_entry_path_names_an_icon() {
        assert_eq!(
            icon_entry("models/players/kyle/icon_red.jpg"),
            Some(("kyle".into(), "red".into(), "jpg".into()))
        );
        assert_eq!(
            icon_entry("models/players/jedi_hf/icon_torso_a1.PNG"),
            Some(("jedi_hf".into(), "torso_a1".into(), "png".into()))
        );
        assert_eq!(icon_entry("models/players/kyle/icon_.jpg"), None);
        assert_eq!(icon_entry("models/players/kyle/kyle.jpg"), None);
        assert_eq!(icon_entry("models/players/kyle/icon_red.txt"), None);
    }

    // --- slice: assembled skins ---

    #[test]
    fn an_entry_path_names_one_part_of_an_assembled_model() {
        assert_eq!(
            part_entry("models/players/jedi_hm/head_a1.skin"),
            Some(("jedi_hm".into(), "head_a1".into()))
        );
        assert_eq!(
            part_entry("MODELS\\PLAYERS\\Jedi_TF\\Lower_D1.skin"),
            Some(("jedi_tf".into(), "lower_d1".into()))
        );
        assert_eq!(
            part_entry("models/players/jedi_hm/torso_g1.skin"),
            Some(("jedi_hm".into(), "torso_g1".into()))
        );
        // A whole skin belongs to the other reader, and nothing else is a part.
        assert_eq!(part_entry("models/players/jedi_hm/model_siege.skin"), None);
        assert_eq!(part_entry("models/players/jedi_hm/head_.skin"), None);
        assert_eq!(part_entry("models/players/jedi_hm/hips_01.png"), None);
        assert_eq!(part_entry("models/players/jedi_hm/sub/head_a1.skin"), None);

        assert_eq!(
            playerchoice_entry("models/players/jedi_hm/playerchoice.txt"),
            Some("jedi_hm".into())
        );
        assert_eq!(
            playerchoice_entry("MODELS/PLAYERS/jedi_hf/PlayerChoice.txt"),
            Some("jedi_hf".into())
        );
        assert_eq!(playerchoice_entry("models/players/playerchoice.txt"), None);
        assert_eq!(playerchoice_entry("models/players/kyle/sounds.cfg"), None);
    }

    #[test]
    fn a_part_longer_than_the_engine_buffer_is_not_offered() {
        let part_fits = "head_aaaaaaaaaa";
        let part_over = "head_aaaaaaaaaaa";
        assert_eq!(part_fits.len(), MAX_SKIN_PART_LEN);
        assert_eq!(part_over.len(), MAX_SKIN_PART_LEN + 1);
        assert_eq!(
            part_entry(&format!("models/players/jedi_hm/{part_fits}.skin")),
            Some(("jedi_hm".into(), part_fits.into()))
        );
        assert_eq!(
            part_entry(&format!("models/players/jedi_hm/{part_over}.skin")),
            None
        );

        // The variant of an ordinary skin is not measured that way: it has no
        // buffer of its own and keeps the longer bound of every other path
        // segment, as does the model folder.
        let variant = "b".repeat(MAX_SKIN_PART_LEN * 2);
        assert_eq!(
            skin_entry(&format!("models/players/kyle/model_{variant}.skin")),
            Some(("kyle".into(), variant.clone()))
        );
        let folder = "e".repeat(MAX_SKIN_PART_LEN * 2);
        assert_eq!(
            skin_entry(&format!("models/players/{folder}/model_red.skin")),
            Some((folder, "red".into()))
        );
    }

    #[test]
    fn the_three_parts_are_joined_the_way_the_engine_reads_them_back() {
        // `UI_UpdateCharacterCvars` writes `%s/%s|%s|%s` and
        // `UI_GetCharacterCvars` reads the three back by position.
        assert_eq!(
            assembled_variant("head_a1", "torso_a1", "lower_a1"),
            "head_a1|torso_a1|lower_a1"
        );
    }

    /// A model folder shaped like the retail ones, in as few entries as the
    /// rules allow.
    fn assembled_pk3(path: &Path, extra: &[(&str, Vec<u8>)]) {
        let icon = || picture(128, 128, ImageFormat::Jpeg);
        let mut entries: Vec<(&str, Vec<u8>)> = vec![
            ("models/players/jedi_hm/playerchoice.txt", b"x".to_vec()),
            ("models/players/jedi_hm/head_a1.skin", b"hips,x".to_vec()),
            ("models/players/jedi_hm/icon_head_a1.jpg", icon()),
            ("models/players/jedi_hm/head_b1.skin", b"hips,x".to_vec()),
            ("models/players/jedi_hm/icon_head_b1.jpg", icon()),
            ("models/players/jedi_hm/torso_a1.skin", b"hips,x".to_vec()),
            ("models/players/jedi_hm/icon_torso_a1.jpg", icon()),
            ("models/players/jedi_hm/lower_a1.skin", b"hips,x".to_vec()),
            ("models/players/jedi_hm/icon_lower_a1.jpg", icon()),
        ];
        entries.extend(extra.iter().map(|(name, bytes)| (*name, bytes.clone())));
        write_pk3(path, &entries);
    }

    #[test]
    fn a_folder_with_a_playerchoice_becomes_one_assembled_tile() {
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        assembled_pk3(
            &pk3,
            &[
                // The whole skin of the same folder stays a tile of its own.
                ("models/players/jedi_hm/model_siege.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_siege.jpg",
                    picture(128, 128, ImageFormat::Jpeg),
                ),
                // A part with no icon is not a part the player picks, the same
                // rule that governs a whole skin.
                ("models/players/jedi_hm/torso_g1.skin", b"hips,x".to_vec()),
            ],
        );

        let dir = temp.path().join("cache");
        let models = scan_models(&[source_of(&pk3)], &dir).expect("the scan");
        let values: Vec<&str> = models.iter().map(|model| model.value.as_str()).collect();
        assert_eq!(values, ["jedi_hm/siege", "jedi_hm/head_a1|torso_a1|lower_a1"]);

        let assembled = models.last().expect("the assembled tile");
        assert_eq!(assembled.model, "jedi_hm");
        assert_eq!(assembled.variant, "head_a1|torso_a1|lower_a1");
        let parts = assembled.parts.as_ref().expect("the three rows");
        let ids = |row: &[ModelPart]| {
            row.iter()
                .map(|part| part.id.clone())
                .collect::<Vec<String>>()
        };
        assert_eq!(ids(&parts.heads), ["head_a1", "head_b1"]);
        assert_eq!(ids(&parts.torsos), ["torso_a1"], "torso_g1 has no icon");
        assert_eq!(ids(&parts.legs), ["lower_a1"]);
        // The tile wears the head of its own value, which is the picture the
        // game falls back to for a three-part skin.
        assert_eq!(
            assembled.icon.as_deref(),
            parts.heads[0].icon.as_deref(),
            "the tile shows the head it names"
        );
        assert!(dir.join("jedi_hm__head_a1.jpg").is_file());
        assert!(dir.join("jedi_hm__lower_a1.jpg").is_file());
        // The whole skin beside it is not an assembled one.
        assert!(models[0].parts.is_none());
    }

    // --- slice: skins and hilts ---

    /// A 128×128 picture whose left half is opaque and whose right half is cut
    /// away — the shape of a part icon that used to show the page through it.
    fn cut_out_png() -> Vec<u8> {
        use image::{Rgba, RgbaImage};

        let mut image = RgbaImage::new(128, 128);
        for (x, _, pixel) in image.enumerate_pixels_mut() {
            *pixel = if x < 64 {
                Rgba([200, 30, 40, 255])
            } else {
                Rgba([0, 0, 0, 0])
            };
        }
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("encode");
        bytes
    }

    #[test]
    fn an_assembled_value_is_taken_apart_the_way_the_engine_reads_it() {
        assert_eq!(
            split_assembled("jedi_hm/head_a1|torso_a1|lower_a1"),
            Some(("jedi_hm", ["head_a1", "torso_a1", "lower_a1"]))
        );
        // Everything the engine reads as one variant instead.
        assert_eq!(split_assembled("kyle/red"), None);
        assert_eq!(split_assembled("kyle"), None);
        assert_eq!(split_assembled("jedi_hm/a1|b1|c1|d1"), None);
        assert_eq!(split_assembled("jedi_hm/|torso_a1|lower_a1"), None);
        assert_eq!(split_assembled("/head_a1|torso_a1|lower_a1"), None);
    }

    #[test]
    fn a_composed_preview_is_three_rows_over_an_opaque_ground() {
        let rows = [Some(cut_out_png()), None, Some(cut_out_png())];
        let bytes = compose_preview(rows)
            .expect("the compose")
            .expect("two readable rows are a picture");

        let composed = image::load_from_memory(&bytes).expect("a picture");
        assert_eq!(composed.width(), PREVIEW_SIDE);
        assert_eq!(composed.height(), PREVIEW_SIDE * 3);
        // No alpha channel at all, so there is nothing for the dark page to
        // show through. That is the whole reason the picture is composed.
        assert_eq!(composed.color(), image::ColorType::Rgb8);

        let pixels = composed.to_rgb8();
        let ground = image::Rgb(PREVIEW_GROUND);
        assert_eq!(pixels.get_pixel(10, 10), &image::Rgb([200, 30, 40]));
        assert_eq!(
            pixels.get_pixel(110, 10),
            &ground,
            "what the icon cut away is ground, not a hole"
        );
        assert_eq!(
            pixels.get_pixel(64, PREVIEW_SIDE + 64),
            &ground,
            "a row with no readable icon is bare ground and costs no picture"
        );
        assert_eq!(
            pixels.get_pixel(10, PREVIEW_SIDE * 2 + 10),
            &image::Rgb([200, 30, 40]),
            "the legs are the third row"
        );

        // And a combination with nothing readable in it is no picture: the
        // window already draws a text tile for a skin with no icon.
        assert_eq!(compose_preview([None, None, None]).expect("no rows"), None);
    }

    #[test]
    fn a_preview_is_named_after_the_whole_combination() {
        assert_eq!(
            preview_file_name("jedi_hm", ["head_a1", "torso_a1", "lower_a1"]).as_deref(),
            Some("jedi_hm__head_a1__torso_a1__lower_a1.png")
        );
        // Two models may share a part name, so the model is part of the name.
        assert_ne!(
            preview_file_name("jedi_hm", ["head_a1", "torso_a1", "lower_a1"]),
            preview_file_name("jedi_tf", ["head_a1", "torso_a1", "lower_a1"])
        );
        // The names come out of an archive a stranger built.
        assert_eq!(
            preview_file_name("jedi_hm", ["..", "torso_a1", "lower_a1"]),
            None
        );
        assert_eq!(
            preview_file_name("../secret", ["head_a1", "torso_a1", "lower_a1"]),
            None
        );
    }

    #[test]
    fn the_scan_composes_the_preview_the_grid_opens_on() {
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        assembled_pk3(&pk3, &[]);

        let dir = temp.path().join("cache");
        let models = scan_models(&[source_of(&pk3)], &dir).expect("the scan");
        let assembled = models.last().expect("the assembled tile");

        let file = dir
            .join(PREVIEW_DIR)
            .join("jedi_hm__head_a1__torso_a1__lower_a1.png");
        assert!(file.is_file(), "the preview of the default combination");
        assert_eq!(assembled.preview.as_deref(), Some(file.display().to_string().as_str()));
        // And the window is allowed to read it by the same per-file rule the
        // icons go through.
        assert!(
            icons_of(assembled).any(|path| path == file.display().to_string()),
            "the preview is handed to the window"
        );

        // An ordinary skin has no preview: there is nothing to compose.
        let ordinary = models
            .iter()
            .find(|model| model.parts.is_none())
            .or(Some(assembled))
            .expect("a model");
        if ordinary.parts.is_none() {
            assert_eq!(ordinary.preview, None);
        }

        // A second scan reuses the file rather than composing it again.
        let made = fs::metadata(&file).expect("the preview").modified().ok();
        let again = scan_models(&[source_of(&pk3)], &dir).expect("the second scan");
        assert_eq!(
            again.last().expect("the tile").preview,
            assembled.preview,
            "the same path"
        );
        assert_eq!(
            fs::metadata(&file).expect("the preview").modified().ok(),
            made,
            "and the same file"
        );
    }

    #[test]
    fn a_model_missing_a_whole_row_is_not_offered_assembled() {
        // The engine's own `iSkinParts != 7`: two rows out of three build a
        // value that names a skin the game cannot load.
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        write_pk3(
            &pk3,
            &[
                ("models/players/jedi_hm/playerchoice.txt", b"x".to_vec()),
                ("models/players/jedi_hm/head_a1.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_head_a1.jpg",
                    picture(128, 128, ImageFormat::Jpeg),
                ),
                ("models/players/jedi_hm/torso_a1.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_torso_a1.jpg",
                    picture(128, 128, ImageFormat::Jpeg),
                ),
                // The legs are there and their icon is not, so the row is empty.
                ("models/players/jedi_hm/lower_a1.skin", b"hips,x".to_vec()),
            ],
        );

        let dir = temp.path().join("cache");
        let models = scan_models(&[source_of(&pk3)], &dir).expect("the scan");
        assert!(models.is_empty(), "{models:?}");
    }

    #[test]
    fn a_folder_of_parts_without_a_playerchoice_is_not_assembled() {
        // The mark the engine goes by. Without it a folder of loose
        // `head_*.skin` files is a model the menu never offers in parts.
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        assembled_pk3(&pk3, &[]);
        let with_choice = scan_models(&[source_of(&pk3)], &temp.path().join("a")).expect("scan");
        assert_eq!(with_choice.len(), 1);

        let bare = temp.path().join("bare.pk3");
        write_pk3(
            &bare,
            &[
                ("models/players/jedi_hm/head_a1.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_head_a1.jpg",
                    picture(128, 128, ImageFormat::Jpeg),
                ),
                ("models/players/jedi_hm/torso_a1.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_torso_a1.jpg",
                    picture(128, 128, ImageFormat::Jpeg),
                ),
                ("models/players/jedi_hm/lower_a1.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_lower_a1.jpg",
                    picture(128, 128, ImageFormat::Jpeg),
                ),
            ],
        );
        let without = scan_models(&[source_of(&bare)], &temp.path().join("b")).expect("scan");
        assert!(without.is_empty(), "{without:?}");
    }

    #[test]
    fn a_later_archive_replaces_the_assembled_tile_rather_than_adding_one() {
        let temp = TempDir::new().expect("temp dir");
        let stock = temp.path().join("base").join("assets1.pk3");
        assembled_pk3(&stock, &[]);
        let mine = temp.path().join("home").join("zzz_jedi.pk3");
        write_pk3(
            &mine,
            &[
                ("models/players/jedi_hm/playerchoice.txt", b"x".to_vec()),
                ("models/players/jedi_hm/head_z9.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_head_z9.png",
                    picture(64, 64, ImageFormat::Png),
                ),
                ("models/players/jedi_hm/torso_z9.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_torso_z9.png",
                    picture(64, 64, ImageFormat::Png),
                ),
                ("models/players/jedi_hm/lower_z9.skin", b"hips,x".to_vec()),
                (
                    "models/players/jedi_hm/icon_lower_z9.png",
                    picture(64, 64, ImageFormat::Png),
                ),
            ],
        );

        let dir = temp.path().join("cache");
        let models = scan_models(&[source_of(&stock), source_of(&mine)], &dir).expect("scan");
        assert_eq!(models.len(), 1, "one tile per model, not two");
        assert_eq!(models[0].value, "jedi_hm/head_z9|torso_z9|lower_z9");
        assert!(models[0].source.ends_with("zzz_jedi.pk3"), "{}", models[0].source);
    }

    #[test]
    fn every_part_icon_is_handed_to_the_window() {
        // `allow_icons` permits each path it hands over one by one, so a path
        // the panel draws and the list does not name would be refused by the
        // asset protocol.
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        assembled_pk3(&pk3, &[]);

        let models = scan_models(&[source_of(&pk3)], &temp.path().join("cache")).expect("scan");
        let handed: Vec<&str> = models.iter().flat_map(icons_of).collect();
        let parts = models[0].parts.as_ref().expect("the three rows");
        for part in parts.heads.iter().chain(&parts.torsos).chain(&parts.legs) {
            let icon = part.icon.as_deref().expect("a cached icon");
            assert!(handed.contains(&icon), "{icon} is drawn and never allowed");
        }
    }

    #[test]
    fn the_default_variant_is_the_model_name_on_its_own() {
        // `CG_RegisterClientModelname` splits on the first `/` and reads a name
        // without one as `default`, so the two spellings are one skin and the
        // game's own menu writes the shorter one.
        assert_eq!(model_value("kyle", "default"), "kyle");
        assert_eq!(model_value("kyle", "red"), "kyle/red");
        assert_eq!(model_value("jedi_hf", "siege"), "jedi_hf/siege");
    }

    #[test]
    fn a_crafted_entry_never_names_a_file_outside_the_cache() {
        assert_eq!(
            cache_file_name("kyle", "red", "jpg").as_deref(),
            Some("kyle__red.jpg")
        );
        assert_eq!(cache_file_name("..", "red", "jpg"), None);
        assert_eq!(cache_file_name("kyle", "..", "jpg"), None);
        assert_eq!(cache_file_name("", "red", "jpg"), None);
        assert_eq!(cache_file_name("c:", "red", "jpg"), None);
        assert_eq!(cache_file_name(&"x".repeat(MAX_SEGMENT_LEN + 1), "red", "jpg"), None);
    }

    #[test]
    fn a_skin_is_listed_only_with_an_icon_beside_it() {
        // The rule of the game's own menu. Without it the list fills with the
        // vehicles and story NPCs of `assets1.pk3`, which carry a `.skin` and
        // no icon because nobody is meant to pick them.
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        write_pk3(
            &pk3,
            &[
                ("models/players/kyle/model_default.skin", b"hips,x".to_vec()),
                ("models/players/kyle/icon_default.jpg", picture(128, 128, ImageFormat::Jpeg)),
                ("models/players/kyle/model_red.skin", b"hips,x".to_vec()),
                ("models/players/kyle/icon_red.jpg", picture(128, 128, ImageFormat::Jpeg)),
                // A variant the game hides: a skin with no icon.
                ("models/players/kyle/model_menu.skin", b"hips,x".to_vec()),
                // A vehicle: the same shape, and not a player at all.
                ("models/players/x-wing/model_default.skin", b"hips,x".to_vec()),
            ],
        );

        let dir = temp.path().join("cache");
        let models = scan_models(&[source_of(&pk3)], &dir).expect("the scan");
        let values: Vec<&str> = models.iter().map(|model| model.value.as_str()).collect();
        assert_eq!(values, ["kyle", "kyle/red"]);
        assert!(models.iter().all(|model| model.icon.is_some()));
        assert!(dir.join("kyle__default.jpg").is_file());
        assert!(dir.join("kyle__red.jpg").is_file());
    }

    #[test]
    fn a_client_archive_beats_the_stock_skin_of_the_same_name() {
        let temp = TempDir::new().expect("temp dir");
        let stock = temp.path().join("base").join("assets1.pk3");
        write_pk3(
            &stock,
            &[
                ("models/players/kyle/model_default.skin", b"hips,x".to_vec()),
                ("models/players/kyle/icon_default.jpg", picture(128, 128, ImageFormat::Jpeg)),
            ],
        );
        let mine = temp.path().join("home").join("zzz_kyle.pk3");
        write_pk3(
            &mine,
            &[
                ("models/players/kyle/model_default.skin", b"hips,x".to_vec()),
                ("models/players/kyle/icon_default.png", picture(64, 64, ImageFormat::Png)),
            ],
        );

        let dir = temp.path().join("cache");
        let models = scan_models(&[source_of(&stock), source_of(&mine)], &dir).expect("scan");
        assert_eq!(models.len(), 1);
        let icon = models[0].icon.as_deref().expect("an icon");
        assert!(icon.ends_with("kyle__default.png"), "{icon}");
        assert!(models[0].source.ends_with("zzz_kyle.pk3"), "{}", models[0].source);
    }

    #[test]
    fn a_tga_icon_becomes_a_png_and_a_large_one_is_shrunk() {
        let temp = TempDir::new().expect("temp dir");
        let dir = temp.path().join("cache");
        fs::create_dir_all(&dir).expect("cache folder");

        let converted = store_icon(
            &picture(32, 16, ImageFormat::Tga),
            "kyle",
            "red",
            "tga",
            "test.pk3",
            &dir,
        )
        .expect("store")
        .expect("a picture");
        assert!(converted.ends_with("kyle__red.png"));

        let shrunk = store_icon(
            &picture(MAX_SIDE * 2, MAX_SIDE, ImageFormat::Png),
            "kyle",
            "huge",
            "png",
            "test.pk3",
            &dir,
        )
        .expect("store")
        .expect("a picture");
        let size = ImageReader::open(&shrunk)
            .expect("open")
            .into_dimensions()
            .expect("dimensions");
        assert_eq!(size, (MAX_SIDE, MAX_SIDE / 2));
    }

    /// The eighteen bytes a TGA begins with: no magic number and no checksum,
    /// which makes a header the cheapest way to write down a decode bomb.
    fn tga_header(width: u16, height: u16) -> Vec<u8> {
        let mut header = vec![0u8; 18];
        header[2] = 2; // uncompressed true colour
        header[12..14].copy_from_slice(&width.to_le_bytes());
        header[14..16].copy_from_slice(&height.to_le_bytes());
        header[16] = 24; // bits per pixel
        header
    }

    #[test]
    fn an_icon_too_large_to_decode_costs_only_itself() {
        let temp = TempDir::new().expect("temp dir");
        let dir = temp.path().join("cache");
        fs::create_dir_all(&dir).expect("cache folder");

        // 20000 × 20000 × 3 bytes out of eighteen bytes of header. The
        // launcher reads archives a player downloaded from anywhere.
        assert!(
            store_icon(&tga_header(20_000, 20_000), "kyle", "bomb", "tga", "crafted.pk3", &dir)
                .expect("an icon over the limit is not an error")
                .is_none()
        );
        assert_eq!(fs::read_dir(&dir).expect("cache folder").count(), 0);
    }

    #[test]
    fn the_decode_limits_are_the_launcher_s_own_and_not_the_crate_s() {
        let stock = Limits::default();
        assert_eq!(stock.max_image_width, None);
        assert_eq!(stock.max_image_height, None);

        let ours = decode_limits();
        assert_eq!(ours.max_image_width, Some(MAX_DECODE_SIDE));
        assert_eq!(ours.max_image_height, Some(MAX_DECODE_SIDE));
        assert_eq!(ours.max_alloc, Some(MAX_DECODE_BYTES));
        const {
            assert!(MAX_DECODE_SIDE >= MAX_SIDE);
        }
    }

    // --- hilts ---

    /// `ext_data/sabers/single_1.sab` of `assets1.pk3`, byte for byte.
    const SINGLE_1: &str = "\nsingle_1\n{\n\tname\t\t@MENUS_SINGLE_HILT1\n\
        \tsaberType\tSABER_SINGLE\n\
        \tsaberModel\t\"models/weapons2/saber_1/saber_1.glm\"\n\
        \tsaberLength\t40\n\tsaberColor\trandom\n}\n";

    #[test]
    fn a_sab_block_names_the_value_the_cvar_takes() {
        let hilts = parse_sabers(SINGLE_1, "assets1.pk3");
        assert_eq!(hilts.len(), 1);
        assert_eq!(hilts[0].id, "single_1");
        assert_eq!(hilts[0].name, "@MENUS_SINGLE_HILT1");
        assert_eq!(hilts[0].saber_type, "single");
    }

    #[test]
    fn the_story_sabers_of_the_retail_file_stay_out_of_multiplayer() {
        // `notInMP 1` is the engine's own rule, `WP_SaberValidForPlayerInMP`.
        // Fourteen of the thirty blocks in `assets1.pk3` carry it.
        let text = "\
//Lightsaber configurations
/* a block comment
   with a { brace } inside it */
Kyle
{
\tname\t\"Katarn\"
\tsaberType\tSABER_SINGLE
\tsaberColor\tblue
}

Luke
{
\tname\t\"Skywalker\"
\tsaberType\tSABER_SINGLE
\tnotInMP\t1
}

dual_1
{
\tname\t@MENUS_STAFF_HILT1
\tsaberType\tSABER_STAFF
\tnumBlades\t2
}
";
        let hilts = parse_sabers(text, "assets1.pk3");
        let ids: Vec<&str> = hilts.iter().map(|hilt| hilt.id.as_str()).collect();
        assert_eq!(ids, ["Kyle", "dual_1"]);
        assert_eq!(hilts[0].name, "Katarn");
        assert_eq!(hilts[1].saber_type, "staff");
    }

    #[test]
    fn a_block_with_no_shape_is_not_a_hilt() {
        // `empty.sab` of the retail game, and any block a mod left half
        // written: a hilt with no `saberType` is nothing to hold.
        assert!(parse_sabers("empty\n{\n\tsaberType\tSABER_NONE\n}\n", "x").is_empty());
        assert!(parse_sabers("half\n{\n\tname\t\"Half\"\n}\n", "x").is_empty());
        assert!(parse_sabers("", "x").is_empty());
        assert!(parse_sabers("stray words with no block", "x").is_empty());
    }

    #[test]
    fn a_string_table_writes_a_hilt_name_out() {
        let table = parse_strings(
            "REFERENCE           SINGLE_HILT1\n\
             NOTES               \"saber hilt name\"\n\
             LANG_ENGLISH        \"Arbiter\"\n\
             \n\
             REFERENCE           STAFF_HILT1\n\
             LANG_ENGLISH        \"Guardian\"\n",
            "menus",
        );
        assert_eq!(table.get("menus_single_hilt1").map(String::as_str), Some("Arbiter"));
        assert_eq!(table.get("menus_staff_hilt1").map(String::as_str), Some("Guardian"));
    }

    // --- slice: profiles polish ---

    #[test]
    fn a_damaged_entry_costs_its_own_hilts_and_not_the_whole_archive() {
        // The bug behind «the skins are there and the hilts are not»: the
        // hilt scan left the archive on the first entry it could not read,
        // and everything after that entry — on a retail install, the file
        // that holds every hilt — was silently gone. The skin scan forgives
        // the same failure, which is why one list filled and the other did
        // not.
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        let broken = b"broken\n{\n\tname\t\"Broken\"\n\tsaberType\tSABER_SINGLE\n}\n".to_vec();
        write_pk3(
            &pk3,
            &[
                // First, so that a scan which gives up on it gives up before
                // reaching either of the two good files.
                ("ext_data/sabers/broken.sab", broken.clone()),
                ("ext_data/sabers/single_1.sab", SINGLE_1.as_bytes().to_vec()),
                (
                    "ext_data/sabers/staff_1.sab",
                    b"staff_1\n{\n\tname\t\"Guardian\"\n\tsaberType\tSABER_STAFF\n}\n".to_vec(),
                ),
            ],
        );
        damage_entry(&pk3, &broken);

        let hilts = scan_hilts(&[source_of(&pk3)]);
        let ids: Vec<&str> = hilts.iter().map(|hilt| hilt.id.as_str()).collect();
        assert_eq!(
            ids,
            ["single_1", "staff_1"],
            "the two readable hilts survive the one that is not"
        );
    }

    #[test]
    fn a_hilt_name_is_written_out_of_the_table_beside_it() {
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        write_pk3(
            &pk3,
            &[
                ("ext_data/sabers/single_1.sab", SINGLE_1.as_bytes().to_vec()),
                (
                    "ext_data/sabers/mystery.sab",
                    b"mystery\n{\n\tname\t@MENUS_NOTHING\n\tsaberType\tSABER_SINGLE\n}\n".to_vec(),
                ),
                (
                    "strings/English/MENUS.str",
                    b"REFERENCE           SINGLE_HILT1\nLANG_ENGLISH        \"Arbiter\"\n".to_vec(),
                ),
            ],
        );

        let hilts = scan_hilts(&[source_of(&pk3)]);
        let named: Vec<(&str, &str)> = hilts
            .iter()
            .map(|hilt| (hilt.id.as_str(), hilt.name.as_str()))
            .collect();
        // A key the table does not carry falls back to the block name, which
        // is at least the value the cvar takes.
        assert_eq!(named, [("mystery", "mystery"), ("single_1", "Arbiter")]);
    }

    // --- sources ---

    #[test]
    fn sources_follow_the_load_order_of_the_engine() {
        let temp = TempDir::new().expect("temp dir");
        let base = temp.path().join("base");
        write_pk3(&base.join("assets1.pk3"), &[]);
        write_pk3(&base.join("dl_extra.pk3"), &[]);
        write_pk3(&base.join("zzz_skins.pk3"), &[]);
        // A file the player switched off is not on the search path, so its
        // skins are not there to choose.
        fs::write(base.join("off.pk3.disabled"), b"x").expect("a disabled file");

        let mut sources = Vec::new();
        collect_from_folder(&base, &mut sources);
        let names: Vec<String> = sources
            .iter()
            .map(|source| {
                source
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string()
            })
            .collect();
        assert_eq!(names, ["assets1.pk3", "zzz_skins.pk3", "dl_extra.pk3"]);
    }

    /// Reads the skins and hilts of the real installation and prints what it
    /// cost.
    ///
    /// Hardcodes a path that exists on one machine, which is why it is
    /// ignored. Run it with:
    ///
    /// ```text
    /// cargo test --lib -- --ignored --nocapture reads_the_retail_archives
    /// ```
    #[test]
    #[ignore]
    fn reads_the_retail_archives() {
        use std::time::Instant;

        let base = Path::new("D:\\SteamLibrary\\steamapps\\common\\Jedi Academy\\GameData\\base");
        let mut sources = Vec::new();
        collect_from_folder(base, &mut sources);
        assert!(!sources.is_empty(), "no archive in {}", base.display());

        let temp = TempDir::new().expect("temp dir");
        let dir = temp.path().join("skins");

        let started = Instant::now();
        let models = scan_models(&sources, &dir).expect("the skin list");
        println!(
            "{} skins from {} archives in {} ms",
            models.len(),
            sources.len(),
            started.elapsed().as_millis()
        );
        for value in ["kyle", "kyle/red", "jedi_hf/siege"] {
            let model = models
                .iter()
                .find(|model| model.value == value)
                .unwrap_or_else(|| panic!("{value}"));
            println!("{value}: {:?}", model.icon);
            assert!(model.icon.is_some(), "{value} has no cached icon");
        }
        // The rule of the game's own menu, on the archive it was written for.
        assert!(!models.iter().any(|model| model.model == "x-wing"));

        // --- slice: assembled skins ---
        // The six folders of `assets1.pk3` that carry a `playerchoice.txt`.
        let assembled: Vec<&PlayerModel> =
            models.iter().filter(|model| model.parts.is_some()).collect();
        let mut total = 0;
        for model in &assembled {
            let parts = model.parts.as_ref().expect("the three rows");
            total += parts.heads.len() + parts.torsos.len() + parts.legs.len();
            println!(
                "{}: {} head(s), {} torso(s), {} leg(s) -> {}",
                model.model,
                parts.heads.len(),
                parts.torsos.len(),
                parts.legs.len(),
                model.value
            );
            assert!(model.icon.is_some(), "{} has no tile icon", model.model);
        }
        println!("{} assembled model(s), {total} part(s)", assembled.len());
        let names: Vec<&str> = assembled.iter().map(|model| model.model.as_str()).collect();
        assert_eq!(
            names,
            ["jedi_hf", "jedi_hm", "jedi_kdm", "jedi_rm", "jedi_tf", "jedi_zf"]
        );
        assert_eq!(total, 84, "{names:?}");

        let started = Instant::now();
        let hilts = scan_hilts(&sources);
        println!(
            "{} hilts in {} ms: {}",
            hilts.len(),
            started.elapsed().as_millis(),
            hilts
                .iter()
                .map(|hilt| format!("{} ({}, {})", hilt.id, hilt.name, hilt.saber_type))
                .collect::<Vec<_>>()
                .join(", ")
        );
        // Fifteen hilts are valid for multiplayer in the retail game: `Kyle`,
        // `single_1`..`single_9` and `dual_1`..`dual_5`.
        assert_eq!(hilts.len(), 15, "{hilts:?}");
        let arbiter = hilts.iter().find(|hilt| hilt.id == "single_1").expect("single_1");
        assert_eq!(arbiter.name, "Arbiter");
        assert!(!hilts.iter().any(|hilt| hilt.id == "Luke"), "notInMP");
    }

    #[test]
    fn an_unchanged_disk_has_the_same_signature() {
        let temp = TempDir::new().expect("temp dir");
        let pk3 = temp.path().join("assets1.pk3");
        write_pk3(&pk3, &[]);
        let first = signature(&[source_of(&pk3)]);
        assert_eq!(first, signature(&[source_of(&pk3)]));

        write_pk3(&pk3, &[("models/players/kyle/model_red.skin", b"x".to_vec())]);
        assert_ne!(first, signature(&[source_of(&pk3)]));
        assert_eq!(signature(&[]), "");
    }
}
