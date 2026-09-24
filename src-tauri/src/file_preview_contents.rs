//! What an archive holds beyond its finished objects: the pictures, the
//! strings, the fonts, the shaders and the text files of the taxonomy in
//! `docs/jknet/pk3-anatomy.md`, each one a [`PreviewProduct`] of its own
//! kind, and the two commands that read one of them out of an open preview
//! session: a picture as a data URL, a text file decoded.
//!
//! The kind of an entry is decided by its path, the way the engine decides
//! who reads it: `levelshots/` is a map picture whatever the extension of
//! the file says, a picture under `models/` is a texture, `strings/<lang>/`
//! is a translation. Geometry, skins, audio and maps never appear here: the
//! finished objects of `file_preview_products` consume them.
//!
//! Sizes of pictures come from the headers alone (JPEG SOF, TGA, PNG IHDR),
//! read from the first bytes of the entry without decoding it; the count of
//! lines and of `REFERENCE` keys comes from the bytes of the text, bounded.
//! Nothing here writes to disk: the thumbnails a gallery asks for live in
//! memory for the life of the session and go with it.

use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

use base64::Engine;
use serde::Serialize;
use zip::ZipArchive;

use crate::{
    error::{AppError, Result},
    file_preview::{logical_name, PreviewEntry},
    file_preview_products::PreviewProduct,
};

/// Bytes of a picture read for its header: a JPEG with a long ICC or EXIF
/// segment keeps its size marker this far in.
pub(crate) const IMAGE_HEADER_BYTES: u64 = 64 * 1024;

/// Longest text file whose lines and keys are counted while the products
/// are built. A longer one is listed with `lines: 0`.
const TEXT_SCAN_BYTES: u64 = 1024 * 1024;

/// Bytes read across one archive while the products are built, all kinds
/// together. Past it an entry is listed without its header details.
const SCAN_BUDGET_BYTES: u64 = 128 * 1024 * 1024;

/// Longest text `get_file_preview_text` answers with; a longer file comes
/// back cut here and marked `truncated`.
pub(crate) const MAX_TEXT_BYTES: u64 = 512 * 1024;

/// Largest picture `get_file_preview_image` reads out of an archive.
pub(crate) const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// Longest side a thumbnail may be asked for; the gallery asks for 192.
const MAX_THUMBNAIL_SIDE: u32 = 4096;

/// The size of the `dfontdat_t` table the renderer accepts and nothing
/// else (`codemp/rd-common/tr_font.cpp:888`): 256 glyphs of 28 bytes, then
/// five `short` fields and two bytes of padding.
const FONTDAT_BYTES: usize = 7180;

/// Thumbnails kept in memory for open sessions, all sessions together.
const THUMBNAIL_CACHE_BYTES: usize = 64 * 1024 * 1024;
const THUMBNAIL_CACHE_ENTRIES: usize = 4096;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// The kind of a product the taxonomy gives an entry, spelled the way the
/// `kind` field of a product carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContentKind {
    Levelshot,
    Splash,
    MenuImage,
    HudImage,
    Texture,
    Icon,
    Image,
    Font,
    Strings,
    Shader,
    Effect,
    Menu,
    Config,
    Data,
    Script,
    Video,
    Other,
}

impl ContentKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ContentKind::Levelshot => "levelshot",
            ContentKind::Splash => "splash",
            ContentKind::MenuImage => "menuImage",
            ContentKind::HudImage => "hudImage",
            ContentKind::Texture => "texture",
            ContentKind::Icon => "icon",
            ContentKind::Image => "image",
            ContentKind::Font => "font",
            ContentKind::Strings => "strings",
            ContentKind::Shader => "shader",
            ContentKind::Effect => "effect",
            ContentKind::Menu => "menu",
            ContentKind::Config => "config",
            ContentKind::Data => "data",
            ContentKind::Script => "script",
            ContentKind::Video => "video",
            ContentKind::Other => "other",
        }
    }

    /// Whether a product of this kind is a picture the gallery shows.
    pub(crate) fn is_picture(self) -> bool {
        matches!(
            self,
            ContentKind::Levelshot
                | ContentKind::Splash
                | ContentKind::MenuImage
                | ContentKind::HudImage
                | ContentKind::Texture
                | ContentKind::Icon
                | ContentKind::Image
        )
    }
}

/// The size and format of a picture, read from its header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewImage {
    /// Zero when the header could not be read.
    pub width: u32,
    pub height: u32,
    /// `jpg`, `png` or `tga`.
    pub format: String,
}

/// What a text file is before it is opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewText {
    /// Zero when the file was too long to count.
    pub lines: u32,
    /// `utf-8`, `windows-1251`, `windows-1250` or `windows-1252`.
    pub encoding: String,
}

/// A `strings/<language>/<package>.str` file of StringEd, or a
/// `strip/<package>.sp` file of Jedi Outcast under the language `strip`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStrings {
    /// The folder of the file, lower case: `russian`, `english`.
    pub language: String,
    /// The file name without its extension: `menus`, `mp_ingame`.
    pub package: String,
    /// `REFERENCE` lines in the file.
    pub keys: u32,
}

/// The header of a `fonts/<name>.fontdat` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFont {
    /// `mPointSize`; zero when the file is not a font table.
    pub point_size: i16,
    /// `mHeight`, the tallest glyph.
    pub height: i16,
    /// The picture of the glyphs, `fonts/<name>.tga` or another
    /// extension, when the archive carries one.
    pub atlas: Option<String>,
}

/// A picture of a session as the webview can show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewImageData {
    /// `data:image/jpeg;base64,…` or `data:image/png;base64,…`.
    pub data_url: String,
    /// The size of the picture in the URL: the thumbnail's when one was
    /// asked for.
    pub width: u32,
    pub height: u32,
}

/// A text file of a session, decoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTextData {
    pub text: String,
    /// The encoding the bytes were decoded with.
    pub encoding: String,
    /// True when the file was longer than the text answers with.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// The taxonomy
// ---------------------------------------------------------------------------

pub(crate) fn is_picture_extension(extension: &str) -> bool {
    matches!(extension, "jpg" | "jpeg" | "png" | "tga")
}

/// The extension of a path, lower case, empty when there is none.
pub(crate) fn extension_of(name: &str) -> &str {
    let file = name.rsplit('/').next().unwrap_or(name);
    file.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("")
}

/// What an entry is for the preview, or `None` for a resource a finished
/// object consumes: geometry and skins, audio, maps. The path is read the
/// way the engine reads it, case and separators aside.
pub(crate) fn content_kind(name: &str) -> Option<ContentKind> {
    let name = name.replace('\\', "/").to_ascii_lowercase();
    let (folder, file) = name.rsplit_once('/').unwrap_or(("", name.as_str()));
    let extension = file.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    let picture = is_picture_extension(extension);
    let mut segments = folder.split('/').filter(|part| !part.is_empty());
    let top = segments.next().unwrap_or("");
    let second = segments.next().unwrap_or("");

    if extension == "roq" {
        return Some(ContentKind::Video);
    }
    if matches!(
        extension,
        "glm" | "gla" | "md3" | "skin" | "bsp" | "wav" | "mp3" | "ogg" | "flac" | "m4a"
    ) {
        return None;
    }
    let kind = match top {
        "levelshots" if picture => ContentKind::Levelshot,
        "menu" if picture => {
            if (folder == "menu" && file.starts_with("splash"))
                || (second == "video" && file.starts_with("tc_"))
            {
                ContentKind::Splash
            } else {
                ContentKind::MenuImage
            }
        }
        "gfx" if picture => match second {
            "hud" => ContentKind::HudImage,
            _ if second.ends_with("_hud") => ContentKind::HudImage,
            "menus" | "2d" | "mplevels" | "mp" | "interface" => ContentKind::MenuImage,
            "effects" | "damage" | "misc" | "sprites" | "world" | "decals" | "chunks" | "exp" => {
                ContentKind::Texture
            }
            _ => ContentKind::Image,
        },
        "hud" if picture => ContentKind::HudImage,
        "ui" => match extension {
            "menu" | "txt" | "h" => ContentKind::Menu,
            _ if picture => ContentKind::MenuImage,
            _ => ContentKind::Other,
        },
        "models" if picture => {
            if second == "players" && file.starts_with("icon_") {
                ContentKind::Icon
            } else {
                ContentKind::Texture
            }
        }
        "textures" if picture => ContentKind::Texture,
        "maps" if picture => ContentKind::Texture,
        "maps" if extension == "siege" => ContentKind::Data,
        "fonts" if extension == "fontdat" => ContentKind::Font,
        "strings" if extension == "str" => ContentKind::Strings,
        "strip" if extension == "sp" => ContentKind::Strings,
        "ext_data" | "botfiles" | "botroutes" | "forcecfg" => ContentKind::Data,
        "scripts" => match extension {
            "arena" | "bot" => ContentKind::Data,
            "ibi" | "rof" | "txt" => ContentKind::Script,
            _ => ContentKind::Other,
        },
        _ => match extension {
            "shader" => ContentKind::Shader,
            "efx" => ContentKind::Effect,
            "ibi" | "rof" => ContentKind::Script,
            "cfg" if folder.is_empty() || matches!(top, "configs" | "cfg") => ContentKind::Config,
            "fontdat" | "mus" | "dat" | "sab" | "npc" | "veh" | "vwp" | "scl" | "team" | "arena"
            | "bot" => ContentKind::Data,
            _ if picture => ContentKind::Image,
            _ => ContentKind::Other,
        },
    };
    Some(kind)
}

/// Whether an entry is a text file the preview opens: by extension, with
/// `.dat` only where the game keeps its text tables.
pub(crate) fn is_text(name: &str) -> bool {
    let name = name.replace('\\', "/").to_ascii_lowercase();
    match extension_of(&name) {
        "txt" | "md" | "nfo" | "ini" | "log" | "json" | "xml" | "htm" | "html" | "h" | "c"
        | "cpp" | "def" | "qc" | "cfg" | "str" | "sp" | "shader" | "menu" | "arena" | "bot"
        | "sab" | "npc" | "veh" | "vwp" | "scl" | "team" | "skin" | "efx" | "jkb" | "fcf"
        | "wnt" | "siege" | "mus" => true,
        "dat" => name.starts_with("ext_data/"),
        _ => false,
    }
}

/// The language folder of a strings file: `russian` for
/// `strings/russian/menus.str`, `strip` for `strip/sp_ingame.sp`.
pub(crate) fn strings_language(name: &str) -> String {
    let mut parts = name.split('/');
    match parts.next() {
        Some("strings") => parts.next().unwrap_or("").to_string(),
        Some("strip") => "strip".to_string(),
        _ => String::new(),
    }
}

/// The single-byte code page of a language folder of `strings/`. The
/// renderer knows two overrides (`codemp/rd-common/tr_font.cpp:83-88`),
/// Russian and Polish; every other language of the game writes
/// Windows-1252.
pub(crate) fn code_page_of_language(language: &str) -> &'static str {
    match language {
        "russian" => "windows-1251",
        "polish" => "windows-1250",
        _ => "windows-1252",
    }
}

/// The encoding of a text file: `utf-8` when the bytes are valid UTF-8,
/// otherwise the code page of the language folder for a strings file and
/// Windows-1252 elsewhere. Bytes that are mostly high letters are
/// Windows-1251 whatever the folder says: `rus_sp.pk3` keeps Russian text
/// in `strings/french/`.
pub(crate) fn encoding_of(name: &str, bytes: &[u8]) -> &'static str {
    if std::str::from_utf8(bytes).is_ok() {
        return "utf-8";
    }
    let high = bytes.iter().filter(|byte| **byte >= 0x80).count();
    let letters = bytes.iter().filter(|byte| byte.is_ascii_alphabetic()).count();
    if high * 10 >= (high + letters) * 4 {
        return "windows-1251";
    }
    match content_kind(name) {
        Some(ContentKind::Strings) => code_page_of_language(&strings_language(name)),
        _ => "windows-1252",
    }
}

/// The bytes as text, by the label `encoding_of` gave them. A byte order
/// mark names the encoding over the label, the way `encoding_rs` reads it.
pub(crate) fn decode_text(bytes: &[u8], encoding: &str) -> String {
    let encoding = match encoding {
        "windows-1251" => encoding_rs::WINDOWS_1251,
        "windows-1250" => encoding_rs::WINDOWS_1250,
        "windows-1252" => encoding_rs::WINDOWS_1252,
        _ => encoding_rs::UTF_8,
    };
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

/// Lines of a text: newlines, plus the last line when it has none.
fn count_lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count();
    let tail = usize::from(bytes.last() != Some(&b'\n'));
    (newlines + tail).min(u32::MAX as usize) as u32
}

/// `REFERENCE` lines of a StringEd file, which is its number of keys. The
/// keyword matches in any case, the way the game and the table of the
/// frontend (`src/lib/stringsFile.ts`) read it.
pub(crate) fn count_references(bytes: &[u8]) -> u32 {
    const KEYWORD: &[u8] = b"REFERENCE";
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| {
            let line = line.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(line);
            let mut trimmed = line;
            while let Some((first, rest)) = trimmed.split_first() {
                if first.is_ascii_whitespace() {
                    trimmed = rest;
                } else {
                    break;
                }
            }
            trimmed
                .get(..KEYWORD.len())
                .is_some_and(|word| word.eq_ignore_ascii_case(KEYWORD))
                && trimmed
                    .get(KEYWORD.len())
                    .is_some_and(|byte| byte.is_ascii_whitespace())
        })
        .count()
        .min(u32::MAX as usize) as u32
}

// ---------------------------------------------------------------------------
// Picture headers
// ---------------------------------------------------------------------------

/// The format the bytes say they are, or the one the extension says for a
/// TGA, which has no signature.
pub(crate) fn picture_format(name: &str, bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return Some("jpg");
    }
    match extension_of(name) {
        "tga" => Some("tga"),
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        _ => None,
    }
}

/// Width and height from the first bytes of a picture, `(0, 0)` when the
/// header is not there.
pub(crate) fn image_size(format: &str, bytes: &[u8]) -> (u32, u32) {
    match format {
        "png" => png_size(bytes),
        "jpg" => jpeg_size(bytes),
        "tga" => tga_size(bytes),
        _ => (0, 0),
    }
}

/// The IHDR chunk follows the signature: length, `IHDR`, width, height.
fn png_size(bytes: &[u8]) -> (u32, u32) {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return (0, 0);
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    (width, height)
}

/// Bytes 12 to 15 of the 18-byte header, little endian.
fn tga_size(bytes: &[u8]) -> (u32, u32) {
    if bytes.len() < 18 {
        return (0, 0);
    }
    let width = u16::from_le_bytes([bytes[12], bytes[13]]);
    let height = u16::from_le_bytes([bytes[14], bytes[15]]);
    (u32::from(width), u32::from(height))
}

/// The first start-of-frame segment: baseline `SOF0`, progressive `SOF2`
/// or any other `SOFn`, whose payload starts with the precision, the
/// height and the width.
fn jpeg_size(bytes: &[u8]) -> (u32, u32) {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return (0, 0);
    }
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return (0, 0);
        }
        let marker = bytes[at + 1];
        match marker {
            // Fill bytes before a marker.
            0xFF => {
                at += 1;
                continue;
            }
            // Standalone markers: restart, temporary, start and end of image.
            0x01 | 0xD0..=0xD8 => {
                at += 2;
                continue;
            }
            0xD9 | 0xDA => return (0, 0),
            _ => {}
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        if length < 2 {
            return (0, 0);
        }
        let start_of_frame = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if start_of_frame {
            if at + 9 > bytes.len() {
                return (0, 0);
            }
            let height = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]);
            let width = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]);
            return (u32::from(width), u32::from(height));
        }
        at += 2 + length;
    }
    (0, 0)
}

/// The header of a `.fontdat` table: `mPointSize` and `mHeight` follow the
/// 256 glyphs of 28 bytes (`codemp/qcommon/qfiles.h:513-540`). A file of
/// another size is not a font to the renderer.
pub(crate) fn fontdat_header(bytes: &[u8]) -> Option<(i16, i16)> {
    if bytes.len() != FONTDAT_BYTES {
        return None;
    }
    let at = 256 * 28;
    let point_size = i16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let height = i16::from_le_bytes([bytes[at + 2], bytes[at + 3]]);
    Some((point_size, height))
}

// ---------------------------------------------------------------------------
// The products
// ---------------------------------------------------------------------------

/// Reads at most `limit` bytes of the entry at `index`, and says whether
/// more were left.
pub(crate) fn read_prefix<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    index: usize,
    limit: u64,
) -> Result<(Vec<u8>, bool)> {
    let mut entry = archive.by_index(index)?;
    let mut bytes = Vec::with_capacity(limit.min(entry.size()).min(1024 * 1024) as usize + 1);
    entry
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::Archive(format!("cannot read {}: {e}", entry.name())))?;
    let more = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    Ok((bytes, more))
}

/// The index of the first entry of each logical name, in the order of the
/// central directory: the one `file_preview::inspect_packages` listed. The
/// walk of `crate::archive` bounds it the way the session was bounded when
/// it opened, so no entry of a session falls past the limit.
fn index_by_name<R: Read + std::io::Seek>(archive: &ZipArchive<R>) -> HashMap<String, usize> {
    let mut indexes = HashMap::new();
    for (index, path) in crate::archive::walk(archive, crate::archive::MAX_ENTRIES) {
        if let Some(name) = logical_name(&path) {
            indexes.entry(name).or_insert(index);
        }
    }
    indexes
}

/// The picture of the glyphs of a font, in the order the renderer tries
/// extensions: `jpg`, `png`, `tga` (`codemp/rd-common/tr_image_load.cpp:93`).
fn font_atlas(stem: &str, names: &dyn Fn(&str) -> bool) -> Option<String> {
    ["jpg", "png", "tga"]
        .iter()
        .map(|extension| format!("{stem}.{extension}"))
        .find(|candidate| names(candidate))
}

/// One product per entry the taxonomy claims, with what its header says.
/// The entries of a dependency archive are not part of the archive and
/// stay out; so does everything a finished object consumes.
pub(crate) fn products(sources: &[PathBuf], entries: &[PreviewEntry]) -> Result<Vec<PreviewProduct>> {
    let mut products = Vec::new();
    for (archive_id, path) in sources.iter().enumerate() {
        let mut claimed: Vec<(&PreviewEntry, ContentKind)> = entries
            .iter()
            .filter(|entry| entry.archive == archive_id && !entry.id.contains(":dependency:"))
            .filter(|entry| matches!(entry.kind.as_str(), "image" | "text" | "other"))
            .filter_map(|entry| content_kind(&entry.name).map(|kind| (entry, kind)))
            .collect();
        if claimed.is_empty() {
            continue;
        }
        claimed.sort_by(|a, b| a.0.name.cmp(&b.0.name));
        let file = File::open(path)
            .map_err(|e| AppError::io_path("cannot open preview archive", path, e))?;
        let mut archive = ZipArchive::new(file)?;
        let indexes = index_by_name(&archive);
        let has = |candidate: &str| indexes.contains_key(candidate);
        let mut budget = SCAN_BUDGET_BYTES;
        for (entry, kind) in claimed {
            let name = entry.name.as_str();
            let (folder, file) = name.rsplit_once('/').unwrap_or(("", name));
            let stem = file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file);
            let mut product = PreviewProduct {
                id: entry.id.clone(),
                archive: archive_id,
                name: entry.name.clone(),
                label: file.to_string(),
                kind: kind.as_str().to_string(),
                size: Some(entry.size),
                group: (!folder.is_empty()).then(|| folder.to_string()),
                ..PreviewProduct::default()
            };
            let index = indexes.get(name).copied();
            let mut take = |limit: u64| -> Option<(Vec<u8>, bool)> {
                let index = index?;
                let cost = limit.min(entry.size);
                if cost > budget {
                    return None;
                }
                budget -= cost;
                read_prefix(&mut archive, index, limit).ok()
            };
            if kind.is_picture() {
                product.label = stem.to_string();
                let (bytes, _) = take(IMAGE_HEADER_BYTES).unwrap_or_default();
                let format = picture_format(name, &bytes).unwrap_or("jpg");
                let (width, height) = image_size(format, &bytes);
                product.image = Some(PreviewImage {
                    width,
                    height,
                    format: format.to_string(),
                });
                if kind == ContentKind::Levelshot {
                    product.map = Some(
                        folder
                            .strip_prefix("levelshots")
                            .map(|rest| rest.trim_start_matches('/'))
                            .filter(|rest| !rest.is_empty())
                            .map(|rest| format!("{rest}/{stem}"))
                            .unwrap_or_else(|| stem.to_string()),
                    );
                }
            } else if kind == ContentKind::Font {
                product.label = stem.to_string();
                let header = take(FONTDAT_BYTES as u64 + 1)
                    .filter(|(_, more)| !more)
                    .and_then(|(bytes, _)| fontdat_header(&bytes));
                let (point_size, height) = header.unwrap_or((0, 0));
                product.font = Some(PreviewFont {
                    point_size,
                    height,
                    atlas: font_atlas(&format!("{folder}/{stem}"), &has),
                });
            } else if is_text(name) {
                let scanned = take(TEXT_SCAN_BYTES).filter(|(_, more)| !more);
                let (lines, encoding) = match &scanned {
                    Some((bytes, _)) => (count_lines(bytes), encoding_of(name, bytes)),
                    None => (0, "utf-8"),
                };
                product.text = Some(PreviewText {
                    lines,
                    encoding: encoding.to_string(),
                });
                if kind == ContentKind::Strings {
                    product.label = stem.to_string();
                    let language = strings_language(name);
                    product.group = Some(language.clone());
                    product.strings = Some(PreviewStrings {
                        language,
                        package: stem.to_string(),
                        keys: scanned
                            .as_ref()
                            .map(|(bytes, _)| count_references(bytes))
                            .unwrap_or(0),
                    });
                }
            }
            products.push(product);
        }
    }
    Ok(products)
}

// ---------------------------------------------------------------------------
// The badges of a card
// ---------------------------------------------------------------------------

/// Whether an entry is a part of a model the preview assembles an object
/// from, or a picture of one: a reskin of a character or a weapon ships
/// its pictures alone and the preview finds the model in the game.
fn is_model_part(extension: &str) -> bool {
    matches!(extension, "glm" | "md3" | "skin") || is_picture_extension(extension)
}

fn is_audio_extension(extension: &str) -> bool {
    matches!(extension, "wav" | "mp3" | "ogg" | "flac" | "m4a")
}

/// What an archive carries besides its category, as the codes the card of
/// a library file shows, in a fixed order. First the files of the taxonomy:
/// `levelshots`, `splash`, `menu`, `hud`, `textures`, `fonts`,
/// `strings:<language>` (one per language folder, languages in alphabetical
/// order), `shaders`, `effects`, `scripts`, `videos`, `configs`, `modules`.
/// Then the finished objects the preview assembles, told by their names
/// alone: `characters`, `hilts`, `weapons`, `npcs`, `vehicles`, `maps`,
/// `music`, `sounds`.
///
/// - `characters`: a model, a skin or a picture under
///   `models/players/<folder>/`, unless `<folder>.veh` says the model is
///   a vehicle.
/// - `hilts`: a `.sab`, or a model part under `models/weapons2/<folder>/`
///   (or `models/weapons/`) whose folder says `saber`. When the archive
///   carries a `.sab`, the model parts of its other weapon folders are the
///   hilts those files describe, not weapons.
/// - `weapons`: a model part under a weapon folder that is not `noweap`
///   and does not say `saber`, in an archive without a `.sab`.
/// - `npcs`: a `.npc`, or `ext_data/npcs.cfg`.
/// - `vehicles`: a `.veh`, or a model part under
///   `models/map_objects/<folder>/` whose folder says `vehicle`.
/// - `maps`: `maps/**/*.bsp`.
/// - `music`: audio under `music/`; `sounds`: audio anywhere else.
///
/// Every code passes the rule the service applies to `library.features`
/// of a bundle ([`crate::bundles::manifest::is_library_feature`]), and the
/// list stays within [`crate::bundles::manifest::MAX_LIBRARY_FEATURES`]: a
/// language folder not spelled `[a-z0-9-]` gets no badge, and only as many
/// languages as fit next to every fixed code are named.
pub(crate) fn features(entries: &[String]) -> Vec<String> {
    use crate::bundles::manifest::{is_library_feature, MAX_LIBRARY_FEATURES};

    let mut levelshots = false;
    let mut splash = false;
    let mut menu = false;
    let mut hud = false;
    let mut textures = false;
    let mut fonts = false;
    let mut languages = BTreeSet::new();
    let mut shaders = false;
    let mut effects = false;
    let mut scripts = false;
    let mut videos = false;
    let mut configs = false;
    let mut modules = false;
    let mut player_folders = BTreeSet::new();
    let mut vehicle_definitions = BTreeSet::new();
    let mut hilts = false;
    let mut saber_definitions = false;
    let mut weapon_models = false;
    let mut npcs = false;
    let mut vehicles = false;
    let mut maps = false;
    let mut music = false;
    let mut sounds = false;
    for entry in entries {
        let name = entry.replace('\\', "/").to_ascii_lowercase();
        let extension = extension_of(&name);
        if matches!(extension, "dll" | "qvm") || name.starts_with("vm/") {
            modules = true;
        }
        let hud_menu = extension == "menu" && name.contains("hud");
        let hud_list = matches!(name.as_str(), "ui/jahud.txt" | "ui/jk2hud.txt");
        if name.starts_with("ui/") && (hud_menu || hud_list) {
            hud = true;
        }
        match content_kind(&name) {
            Some(ContentKind::Levelshot) => levelshots = true,
            Some(ContentKind::Splash) => splash = true,
            Some(ContentKind::MenuImage | ContentKind::Menu) => menu = true,
            Some(ContentKind::HudImage) => hud = true,
            Some(ContentKind::Texture) => textures = true,
            Some(ContentKind::Font) => fonts = true,
            Some(ContentKind::Strings) => {
                let language = strings_language(&name);
                if !language.is_empty() {
                    languages.insert(language);
                }
            }
            Some(ContentKind::Shader) => shaders = true,
            Some(ContentKind::Effect) => effects = true,
            Some(ContentKind::Script) => scripts = true,
            Some(ContentKind::Video) => videos = true,
            Some(ContentKind::Config) => configs = true,
            _ => {}
        }

        // The finished objects, by the file that makes one.
        let parts: Vec<&str> = name.split('/').collect();
        let file = parts.last().copied().unwrap_or("");
        let stem = file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file);
        match extension {
            "sab" => {
                hilts = true;
                saber_definitions = true;
            }
            "npc" => npcs = true,
            "veh" => {
                vehicles = true;
                vehicle_definitions.insert(stem.to_string());
            }
            _ => {}
        }
        if name == "ext_data/npcs.cfg" {
            npcs = true;
        }
        let model_folder = (parts.len() >= 4 && parts[0] == "models" && is_model_part(extension))
            .then(|| (parts[1], parts[2]));
        match model_folder {
            Some(("players", folder)) => {
                player_folders.insert(folder.to_string());
            }
            Some(("weapons2" | "weapons", folder)) if folder != "noweap" => {
                if folder.contains("saber") {
                    hilts = true;
                } else {
                    weapon_models = true;
                }
            }
            Some(("map_objects", folder)) if folder.contains("vehicle") => vehicles = true,
            _ => {}
        }
        if parts[0] == "maps" && extension == "bsp" {
            maps = true;
        }
        if is_audio_extension(extension) {
            if parts[0] == "music" {
                music = true;
            } else {
                sounds = true;
            }
        }
    }
    let characters = player_folders
        .iter()
        .any(|folder| !vehicle_definitions.contains(folder));
    let weapons = weapon_models && !saber_definitions;

    let before_languages = [
        ("levelshots", levelshots),
        ("splash", splash),
        ("menu", menu),
        ("hud", hud),
        ("textures", textures),
        ("fonts", fonts),
    ];
    let after_languages = [
        ("shaders", shaders),
        ("effects", effects),
        ("scripts", scripts),
        ("videos", videos),
        ("configs", configs),
        ("modules", modules),
        ("characters", characters),
        ("hilts", hilts),
        ("weapons", weapons),
        ("npcs", npcs),
        ("vehicles", vehicles),
        ("maps", maps),
        ("music", music),
        ("sounds", sounds),
    ];
    // Room for languages whatever fixed codes the archive has: a badge never
    // pushes another out.
    let language_room = MAX_LIBRARY_FEATURES - before_languages.len() - after_languages.len();
    let present = |codes: &[(&'static str, bool)]| -> Vec<String> {
        codes
            .iter()
            .filter(|(_, present)| *present)
            .map(|(code, _)| code.to_string())
            .collect()
    };
    let mut codes = present(&before_languages);
    codes.extend(
        languages
            .into_iter()
            .map(|language| format!("strings:{language}"))
            .filter(|code| is_library_feature(code))
            .take(language_room),
    );
    codes.extend(present(&after_languages));
    codes
}

// ---------------------------------------------------------------------------
// Reading one entry of a session
// ---------------------------------------------------------------------------

/// The first entry of the archive with this logical name, at most `limit`
/// bytes of it, and whether more were left. The same walk as
/// `index_by_name`, stopped at the entry asked for.
fn read_named(path: &Path, name: &str, limit: u64) -> Result<(Vec<u8>, bool)> {
    let file =
        File::open(path).map_err(|e| AppError::io_path("cannot open preview archive", path, e))?;
    let mut archive = ZipArchive::new(file)?;
    let index = crate::archive::walk(&archive, crate::archive::MAX_ENTRIES)
        .find(|(_, path)| logical_name(path).is_some_and(|candidate| candidate == name))
        .map(|(index, _)| index)
        .ok_or_else(|| AppError::NotFound(format!("{name} in the previewed archive")))?;
    read_prefix(&mut archive, index, limit)
}

/// The logical name of a request, refused when it is not one.
fn requested_name(name: &str) -> Result<String> {
    logical_name(name)
        .filter(|logical| !logical.is_empty())
        .ok_or_else(|| AppError::InvalidInput("invalid preview entry name".into()))
}

pub(crate) fn image_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits
}

pub(crate) fn decode_picture(bytes: &[u8], format: &str) -> Result<image::DynamicImage> {
    let format = match format {
        "png" => image::ImageFormat::Png,
        "jpg" => image::ImageFormat::Jpeg,
        "tga" => image::ImageFormat::Tga,
        other => return Err(AppError::Image(format!("{other} is not a picture format"))),
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(image_limits());
    reader.decode().map_err(|e| AppError::Image(e.to_string()))
}

pub(crate) fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// A picture of a session as a data URL: JPEG and PNG bytes as they are,
/// a TGA re-encoded as PNG, and with `max_size` a thumbnail that fits a
/// square of that many pixels, JPEG for a JPEG source and PNG otherwise.
pub(crate) fn picture(path: &Path, name: &str, max_size: Option<u32>) -> Result<PreviewImageData> {
    check_picture_request(name, max_size)?;
    let (bytes, more) = read_named(path, name, MAX_IMAGE_BYTES)?;
    if more {
        return Err(AppError::InvalidInput(format!(
            "{name} is bigger than the {} MiB the preview reads",
            MAX_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    picture_from_bytes(name, &bytes, max_size)
}

/// Refuses a request for a picture that is not one, or for a thumbnail of
/// a side the gallery never asks for.
///
/// --- slice: pk3 editor ---
/// `pub(crate)`: the pk3 editor answers the same request for an entry it
/// reads out of its own session.
pub(crate) fn check_picture_request(name: &str, max_size: Option<u32>) -> Result<()> {
    let extension = extension_of(name);
    if !is_picture_extension(extension) {
        return Err(AppError::InvalidInput(format!("{name} is not a picture")));
    }
    if max_size.is_some_and(|side| side == 0 || side > MAX_THUMBNAIL_SIDE) {
        return Err(AppError::InvalidInput(format!(
            "a thumbnail side must be between 1 and {MAX_THUMBNAIL_SIDE} pixels"
        )));
    }
    Ok(())
}

/// The bytes of a picture as the webview can show them: the data URL of
/// [`picture`], with the reading of the archive left to the caller.
pub(crate) fn picture_from_bytes(name: &str, bytes: &[u8], max_size: Option<u32>) -> Result<PreviewImageData> {
    let format = picture_format(name, bytes)
        .ok_or_else(|| AppError::Image(format!("{name} has no picture format")))?;
    let (width, height) = image_size(format, bytes);
    let fits = |side: u32| width > 0 && height > 0 && width <= side && height <= side;
    match max_size {
        // The bytes as they are, when the webview can show them and they
        // are small enough already.
        None if format != "tga" => Ok(PreviewImageData {
            data_url: data_url(mime_of(format), bytes),
            width,
            height,
        }),
        Some(side) if format != "tga" && fits(side) => Ok(PreviewImageData {
            data_url: data_url(mime_of(format), bytes),
            width,
            height,
        }),
        _ => {
            let decoded = decode_picture(bytes, format)?;
            let picture = match max_size {
                Some(side) => decoded.thumbnail(side, side),
                None => decoded,
            };
            let mut encoded = Cursor::new(Vec::new());
            let mime = if format == "jpg" {
                let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 85);
                picture
                    .to_rgb8()
                    .write_with_encoder(encoder)
                    .map_err(|e| AppError::Image(e.to_string()))?;
                "image/jpeg"
            } else {
                picture
                    .write_to(&mut encoded, image::ImageFormat::Png)
                    .map_err(|e| AppError::Image(e.to_string()))?;
                "image/png"
            };
            Ok(PreviewImageData {
                data_url: data_url(mime, encoded.get_ref()),
                width: picture.width(),
                height: picture.height(),
            })
        }
    }
}

pub(crate) fn mime_of(format: &str) -> &'static str {
    if format == "png" {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// A text file of a session, decoded by `encoding_of`, at most
/// `MAX_TEXT_BYTES` of it.
pub(crate) fn text(path: &Path, name: &str) -> Result<PreviewTextData> {
    if !is_text(name) {
        return Err(AppError::InvalidInput(format!("{name} is not a text file")));
    }
    let (bytes, truncated) = read_named(path, name, MAX_TEXT_BYTES)?;
    let encoding = encoding_of(name, &bytes);
    Ok(PreviewTextData {
        text: decode_text(&bytes, encoding),
        encoding: encoding.to_string(),
        truncated,
    })
}

// ---------------------------------------------------------------------------
// The thumbnail cache
// ---------------------------------------------------------------------------

type ThumbnailKey = (String, usize, String, u32);

#[derive(Default)]
struct Thumbnails {
    entries: HashMap<ThumbnailKey, PreviewImageData>,
    bytes: usize,
}

static THUMBNAILS: LazyLock<Mutex<Thumbnails>> = LazyLock::new(|| Mutex::new(Thumbnails::default()));

fn cached_thumbnail(key: &ThumbnailKey) -> Option<PreviewImageData> {
    THUMBNAILS.lock().ok()?.entries.get(key).cloned()
}

fn remember_thumbnail(key: ThumbnailKey, picture: &PreviewImageData) {
    let Ok(mut cache) = THUMBNAILS.lock() else {
        return;
    };
    let cost = picture.data_url.len();
    if cache.bytes + cost > THUMBNAIL_CACHE_BYTES || cache.entries.len() >= THUMBNAIL_CACHE_ENTRIES {
        cache.entries.clear();
        cache.bytes = 0;
    }
    if cache.entries.insert(key, picture.clone()).is_none() {
        cache.bytes += cost;
    }
}

/// Drops the thumbnails of a session that was released.
pub(crate) fn forget_session(preview_id: &str) {
    let Ok(mut cache) = THUMBNAILS.lock() else {
        return;
    };
    let mut freed = 0;
    cache.entries.retain(|(id, _, _, _), picture| {
        let keep = id != preview_id;
        if !keep {
            freed += picture.data_url.len();
        }
        keep
    });
    cache.bytes = cache.bytes.saturating_sub(freed);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// A picture of an open preview session, by the `archive` and `name` of
/// its product. `max_size` asks for a thumbnail that fits a square of that
/// many pixels, which the session keeps in memory for the next call.
#[tauri::command]
pub async fn get_file_preview_image(
    preview_id: String,
    archive: usize,
    name: String,
    max_size: Option<u32>,
) -> Result<PreviewImageData> {
    let name = requested_name(&name)?;
    let path = crate::file_preview::session_archive(&preview_id, archive)?;
    let key = max_size.map(|side| (preview_id.clone(), archive, name.clone(), side));
    if let Some(cached) = key.as_ref().and_then(cached_thumbnail) {
        return Ok(cached);
    }
    let picture = tauri::async_runtime::spawn_blocking(move || picture(&path, &name, max_size))
        .await
        .map_err(|e| AppError::State(e.to_string()))??;
    if let Some(key) = key {
        remember_thumbnail(key, &picture);
    }
    Ok(picture)
}

/// A text file of an open preview session, decoded, at most 512 KiB of it.
#[tauri::command]
pub async fn get_file_preview_text(
    preview_id: String,
    archive: usize,
    name: String,
) -> Result<PreviewTextData> {
    let name = requested_name(&name)?;
    let path = crate::file_preview::session_archive(&preview_id, archive)?;
    tauri::async_runtime::spawn_blocking(move || text(&path, &name))
        .await
        .map_err(|e| AppError::State(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "jknet-contents-{name}-{}-{}",
            std::process::id(),
            crate::user_files::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A JPEG of `width` by `height` whose size marker is the given SOF.
    fn jpeg(sof: u8, width: u16, height: u16, app_padding: usize) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8];
        // An APP1 segment, the way a camera or an ICC profile pads a file.
        let app = app_padding + 2;
        bytes.extend_from_slice(&[0xFF, 0xE1, (app >> 8) as u8, app as u8]);
        bytes.extend(std::iter::repeat_n(0, app_padding));
        // A DHT, which shares the SOF range and is not a frame.
        bytes.extend_from_slice(&[0xFF, 0xC4, 0x00, 0x03, 0x00]);
        bytes.extend_from_slice(&[0xFF, sof, 0x00, 0x0B, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
        bytes.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
        bytes
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    fn tga(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0u8; 18];
        bytes[2] = 2;
        bytes[12..14].copy_from_slice(&width.to_le_bytes());
        bytes[14..16].copy_from_slice(&height.to_le_bytes());
        bytes[16] = 24;
        bytes
    }

    fn fontdat(point_size: i16, height: i16) -> Vec<u8> {
        let mut bytes = vec![0u8; FONTDAT_BYTES];
        bytes[7168..7170].copy_from_slice(&point_size.to_le_bytes());
        bytes[7170..7172].copy_from_slice(&height.to_le_bytes());
        bytes
    }

    #[test]
    fn picture_sizes_come_from_the_headers_alone() {
        assert_eq!(image_size("jpg", &jpeg(0xC0, 1024, 512, 0)), (1024, 512));
        assert_eq!(
            image_size("jpg", &jpeg(0xC2, 2048, 2048, 40_000)),
            (2048, 2048),
            "a progressive JPEG behind a long APP segment"
        );
        assert_eq!(image_size("jpg", &[0xFF, 0xD8, 0xFF]), (0, 0));
        assert_eq!(image_size("jpg", b"not a jpeg"), (0, 0));
        assert_eq!(image_size("png", &png(256, 128)), (256, 128));
        assert_eq!(image_size("png", &png(256, 128)[..20]), (0, 0));
        assert_eq!(image_size("tga", &tga(512, 2048)), (512, 2048));
        assert_eq!(image_size("tga", &[0; 17]), (0, 0));
        assert_eq!(picture_format("gfx/2d/x.tga", &tga(1, 1)), Some("tga"));
        assert_eq!(picture_format("levelshots/x.jpg", &png(1, 1)), Some("png"));
        assert_eq!(picture_format("readme.txt", b"hello"), None);
    }

    #[test]
    fn paths_are_classified_by_the_folder_that_reads_them() {
        let cases = [
            ("levelshots/mp/ffa3.jpg", Some(ContentKind::Levelshot)),
            ("LevelShots/Academy1.JPG", Some(ContentKind::Levelshot)),
            ("levelshots/Thumbs.db", Some(ContentKind::Other)),
            ("menu/splash.jpg", Some(ContentKind::Splash)),
            ("menu/splash_16_9.jpg", Some(ContentKind::Splash)),
            ("menu/video/tc_russian.tga", Some(ContentKind::Splash)),
            ("menu/art/unknownmap_mp.jpg", Some(ContentKind::MenuImage)),
            ("menu/new/crosshairb.tga", Some(ContentKind::MenuImage)),
            ("menu/medals/gold.png", Some(ContentKind::MenuImage)),
            ("gfx/menus/main_background.jpg", Some(ContentKind::MenuImage)),
            ("gfx/2d/charsgrid_med.tga", Some(ContentKind::MenuImage)),
            ("gfx/mplevels/ffa3.jpg", Some(ContentKind::MenuImage)),
            ("gfx/mp/icon.png", Some(ContentKind::MenuImage)),
            ("ui/assets/button.tga", Some(ContentKind::MenuImage)),
            ("gfx/hud/w_icon_blaster.tga", Some(ContentKind::HudImage)),
            ("hud/mod/death.png", Some(ContentKind::HudImage)),
            ("gfx/tayst_hud/bar.png", Some(ContentKind::HudImage)),
            ("gfx/effects/flare.jpg", Some(ContentKind::Texture)),
            ("gfx/emoji/cheers.png", Some(ContentKind::Image)),
            ("textures/common/caps.jpg", Some(ContentKind::Texture)),
            ("textures/yavin/video.roq", Some(ContentKind::Video)),
            ("models/weapons2/detpack/pack.jpg", Some(ContentKind::Texture)),
            ("models/players/kyle/icon_default.jpg", Some(ContentKind::Icon)),
            ("models/players/kyle/kyle_torso.png", Some(ContentKind::Texture)),
            ("models/players/kyle/model.glm", None),
            ("models/players/kyle/model_default.skin", None),
            ("models/players/kyle/animation.cfg", Some(ContentKind::Other)),
            ("models/weapons2/detpack/det_pack.qc", Some(ContentKind::Other)),
            ("maps/mp/ffa3.bsp", None),
            ("maps/mp/siege_hoth.siege", Some(ContentKind::Data)),
            ("maps/ffa3/lm_0000.tga", Some(ContentKind::Texture)),
            ("sound/interface/click.wav", None),
            ("music/mp/duel.mp3", None),
            ("fonts/russian.fontdat", Some(ContentKind::Font)),
            ("fonts/russian.tga", Some(ContentKind::Image)),
            ("fonts/tha_widths.dat", Some(ContentKind::Data)),
            ("strings/Russian/menus.str", Some(ContentKind::Strings)),
            ("strip/sp_ingame.sp", Some(ContentKind::Strings)),
            ("shaders/gfx.shader", Some(ContentKind::Shader)),
            ("effects/mp/spawn.efx", Some(ContentKind::Effect)),
            ("ui/jamp/main.menu", Some(ContentKind::Menu)),
            ("ui/jampmenus.txt", Some(ContentKind::Menu)),
            ("ui/jamp/menudef.h", Some(ContentKind::Menu)),
            ("mpdefault.cfg", Some(ContentKind::Config)),
            ("configs/high.cfg", Some(ContentKind::Config)),
            ("cfg/jk2mpconfig.cfg", Some(ContentKind::Config)),
            ("ext_data/sabers/japro.sab", Some(ContentKind::Data)),
            ("ext_data/npcs.cfg", Some(ContentKind::Data)),
            ("ext_data/dms.dat", Some(ContentKind::Data)),
            ("scripts/mp.arena", Some(ContentKind::Data)),
            ("scripts/bots.bot", Some(ContentKind::Data)),
            ("botfiles/bots.txt", Some(ContentKind::Data)),
            ("botroutes/mp/ffa3.wnt", Some(ContentKind::Data)),
            ("forcecfg/light/jedi.fcf", Some(ContentKind::Data)),
            ("scripts/t1_sour/door.ibi", Some(ContentKind::Script)),
            ("scripts/cam1.rof", Some(ContentKind::Script)),
            ("scripts/t1_sour/door.txt", Some(ContentKind::Script)),
            ("scripts/japro_entities.def", Some(ContentKind::Other)),
            ("video/ja01.roq", Some(ContentKind::Video)),
            ("cgamex86.dll", Some(ContentKind::Other)),
            ("vm/cgame.qvm", Some(ContentKind::Other)),
            ("readme.txt", Some(ContentKind::Other)),
            ("preview.jpg", Some(ContentKind::Image)),
            ("screenshots/shot0001.jpg", Some(ContentKind::Image)),
        ];
        for (path, expected) in cases {
            assert_eq!(content_kind(path), expected, "{path}");
        }
        assert_eq!(ContentKind::MenuImage.as_str(), "menuImage");
        assert_eq!(ContentKind::HudImage.as_str(), "hudImage");
    }

    #[test]
    fn strings_files_count_their_keys_and_decode_by_their_folder() {
        let english = b"VERSION \"1\"\r\nREFERENCE PICKUPLINE\r\nLANG_ENGLISH \"Obtained\"\r\nREFERENCE\tOTHER\r\n  REFERENCE SPACED\r\nREFERENCES_NOT \"x\"\r\nreference LOWER\r\nReference MIXED\r\nENDMARKER\r\n";
        assert_eq!(count_references(english), 5, "the keyword counts in any case, as the table of the frontend reads it");
        assert_eq!(count_lines(english), 9);
        assert_eq!(count_references(b"referenced X\r\nREFERENCES \"x\"\r\n"), 0, "a longer word is not the keyword");
        assert_eq!(count_lines(b"one\ntwo"), 2);
        assert_eq!(count_lines(b""), 0);
        assert_eq!(encoding_of("strings/english/menus.str", english), "utf-8");

        // Windows-1251 bytes of the Russian word for "Obtained".
        let russian = b"REFERENCE PICKUPLINE\r\nLANG_RUSSIAN \"\xCF\xEE\xEB\xF3\xF7\xE5\xED\xEE\"\r\n";
        assert_eq!(encoding_of("strings/russian/mp_ingame.str", russian), "windows-1251");
        assert_eq!(
            decode_text(russian, "windows-1251"),
            "REFERENCE PICKUPLINE\r\nLANG_RUSSIAN \"Получено\"\r\n"
        );

        // A German umlaut in Windows-1252, one high byte among many letters.
        let german = b"REFERENCE HELLO\r\nLANG_GERMAN \"Sch\xF6ne Gr\xFC\xDFe aus der Akademie\"\r\n";
        assert_eq!(encoding_of("strings/german/menus.str", german), "windows-1252");
        assert!(decode_text(german, "windows-1252").contains("Schöne Grüße"));
        assert_eq!(encoding_of("strings/polish/menus.str", b"\xB3\xF3d\xBC and letters"), "windows-1250");

        // Russian text kept in a French folder is still Russian, the way
        // `rus_sp.pk3` ships it.
        let hidden = b"LANG_FRENCH \"\xCF\xF0\xE8\xE2\xE5\xF2, \xE4\xF0\xF3\xE3\"\r\n";
        assert_eq!(encoding_of("strings/french/menus.str", hidden), "windows-1251");
        assert_eq!(encoding_of("shaders/gfx.shader", b"caf\xE9 { }"), "windows-1252");

        // A byte order mark names UTF-8 over the label.
        assert_eq!(decode_text(b"\xEF\xBB\xBFabc", "windows-1251"), "abc");
        assert_eq!(strings_language("strings/russian/menus.str"), "russian");
        assert_eq!(strings_language("strip/sp_ingame.sp"), "strip");
        assert_eq!(strings_language("ui/x.menu"), "");
    }

    #[test]
    fn a_font_table_is_read_by_its_size_and_offsets() {
        assert_eq!(fontdat_header(&fontdat(16, 18)), Some((16, 18)));
        assert_eq!(fontdat_header(&fontdat(24, 30)[..7000]), None);
        assert_eq!(fontdat_header(&[0; FONTDAT_BYTES + 1]), None);
    }

    #[test]
    fn products_list_pictures_strings_shaders_and_text_with_their_headers() {
        let dir = temp_dir("products");
        let path = dir.join("rujka.pk3");
        let russian = b"REFERENCE PICKUPLINE\r\nLANG_ENGLISH \"Obtained\"\r\nLANG_RUSSIAN \"\xCF\xEE\xEB\xF3\xF7\xE5\xED\xEE\"\r\nREFERENCE SECOND\r\nLANG_ENGLISH \"Two\"\r\nLANG_RUSSIAN \"\xC4\xE2\xE0\"\r\n";
        let ffa3_jpeg = jpeg(0xC2, 1024, 1024, 100);
        let academy_jpeg = jpeg(0xC0, 512, 512, 0);
        let splash_jpeg = jpeg(0xC2, 2048, 2048, 0);
        let small_jpeg = jpeg(0xC0, 128, 128, 0);
        // A real TGA, because the reader of a session decodes it to PNG.
        let mut charsgrid_tga = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(256, 256)
            .write_to(&mut charsgrid_tga, image::ImageFormat::Tga)
            .unwrap();
        let charsgrid_tga = charsgrid_tga.into_inner();
        let font_table = fontdat(16, 18);
        let atlas_tga = tga(512, 512);
        let entries: Vec<(&str, &[u8])> = vec![
            ("levelshots/mp/ffa3.jpg", &ffa3_jpeg),
            ("levelshots/academy1.jpg", &academy_jpeg),
            ("levelshots/Thumbs.db", b"thumbs"),
            ("menu/splash.jpg", &splash_jpeg),
            ("strings/Russian/mp_ingame.str", russian),
            ("shaders/gfx.shader", b"gfx/console\n{\n}\n"),
            ("textures/a/b.jpg", &small_jpeg),
            ("gfx/2d/charsgrid_med.tga", &charsgrid_tga),
            ("fonts/russian.fontdat", &font_table),
            ("fonts/russian.tga", &atlas_tga),
            ("readme.txt", b"read me\n"),
            ("maps/mp/ffa3.bsp", b"map"),
            ("sound/interface/click.wav", b"audio"),
            ("models/players/hero/model.glm", b"model"),
            ("models/players/hero/model_default.skin", b"body,models/players/hero/body"),
            ("models/players/hero/icon_default.jpg", &small_jpeg),
        ];
        archive(&path, &entries);
        let sources = vec![path];
        let raw = crate::file_preview::inspect_packages(&sources, &[], false).unwrap();
        let products = crate::file_preview_products::products(&sources, &raw).unwrap();
        let kind_count = |kind: &str| products.iter().filter(|p| p.kind == kind).count();
        assert_eq!(kind_count("levelshot"), 2, "{products:#?}");
        assert_eq!(kind_count("splash"), 1);
        assert_eq!(kind_count("strings"), 1);
        assert_eq!(kind_count("shader"), 1);
        assert_eq!(kind_count("texture"), 1);
        assert_eq!(kind_count("menuImage"), 1);
        assert_eq!(kind_count("font"), 1);
        assert_eq!(kind_count("image"), 1);
        assert_eq!(kind_count("icon"), 1);
        assert_eq!(kind_count("other"), 2, "Thumbs.db and readme.txt");
        assert_eq!(kind_count("map"), 1);
        assert_eq!(kind_count("skin"), 1);
        // The one sound of the archive goes with its one character, as before.
        assert_eq!(kind_count("sound"), 0);
        assert_eq!(products.iter().find(|p| p.kind == "skin").unwrap().audio.len(), 1);
        assert!(
            !products
                .iter()
                .any(|p| p.kind != "skin" && (p.name.ends_with(".skin") || p.name.ends_with(".glm"))),
            "resources of finished objects are not listed twice"
        );

        let ffa3 = products.iter().find(|p| p.name == "levelshots/mp/ffa3.jpg").unwrap();
        assert_eq!(ffa3.label, "ffa3");
        assert_eq!(ffa3.map.as_deref(), Some("mp/ffa3"));
        assert_eq!(ffa3.group.as_deref(), Some("levelshots/mp"));
        assert_eq!(ffa3.size, Some(entries[0].1.len() as u64));
        assert_eq!(
            ffa3.image,
            Some(PreviewImage { width: 1024, height: 1024, format: "jpg".into() })
        );
        let academy = products.iter().find(|p| p.name == "levelshots/academy1.jpg").unwrap();
        assert_eq!(academy.map.as_deref(), Some("academy1"));
        assert_eq!(academy.group.as_deref(), Some("levelshots"));
        let splash = products.iter().find(|p| p.kind == "splash").unwrap();
        assert_eq!(splash.image.as_ref().unwrap().width, 2048);
        assert_eq!(splash.group.as_deref(), Some("menu"));

        let strings = products.iter().find(|p| p.kind == "strings").unwrap();
        assert_eq!(strings.label, "mp_ingame");
        assert_eq!(strings.group.as_deref(), Some("russian"));
        assert_eq!(
            strings.strings,
            Some(PreviewStrings { language: "russian".into(), package: "mp_ingame".into(), keys: 2 })
        );
        assert_eq!(
            strings.text,
            Some(PreviewText { lines: 6, encoding: "windows-1251".into() })
        );

        let shader = products.iter().find(|p| p.kind == "shader").unwrap();
        assert_eq!(shader.label, "gfx.shader");
        assert_eq!(shader.text, Some(PreviewText { lines: 3, encoding: "utf-8".into() }));
        assert_eq!(shader.group.as_deref(), Some("shaders"));

        let charsgrid = products.iter().find(|p| p.kind == "menuImage").unwrap();
        assert_eq!(charsgrid.label, "charsgrid_med");
        assert_eq!(charsgrid.image.as_ref().unwrap().format, "tga");
        assert_eq!(charsgrid.image.as_ref().unwrap().width, 256);
        assert_eq!(charsgrid.group.as_deref(), Some("gfx/2d"));

        let font = products.iter().find(|p| p.kind == "font").unwrap();
        assert_eq!(font.label, "russian");
        assert_eq!(
            font.font,
            Some(PreviewFont { point_size: 16, height: 18, atlas: Some("fonts/russian.tga".into()) })
        );

        let readme = products.iter().find(|p| p.name == "readme.txt").unwrap();
        assert_eq!(readme.kind, "other");
        assert_eq!(readme.group, None);
        assert_eq!(readme.text, Some(PreviewText { lines: 1, encoding: "utf-8".into() }));
        let thumbs = products.iter().find(|p| p.name == "levelshots/thumbs.db").unwrap();
        assert_eq!(thumbs.text, None);
        assert_eq!(thumbs.image, None);

        // The finished objects keep their fields and gain the size of the
        // file they stand for.
        let map = products.iter().find(|p| p.kind == "map").unwrap();
        assert_eq!(map.size, Some(3));
        assert_eq!(map.image, None);

        // The two readers of a session answer for the same names.
        let source = sources[0].as_path();
        let charsgrid = picture(source, "gfx/2d/charsgrid_med.tga", None).unwrap();
        assert!(charsgrid.data_url.starts_with("data:image/png;base64,"));
        assert_eq!((charsgrid.width, charsgrid.height), (256, 256));
        let raw_jpeg = picture(source, "levelshots/mp/ffa3.jpg", None).unwrap();
        assert!(raw_jpeg.data_url.starts_with("data:image/jpeg;base64,"));
        assert_eq!((raw_jpeg.width, raw_jpeg.height), (1024, 1024));
        assert!(matches!(picture(source, "readme.txt", None), Err(AppError::InvalidInput(_))));
        assert!(matches!(picture(source, "levelshots/missing.jpg", None), Err(AppError::NotFound(_))));
        assert!(matches!(picture(source, "menu/splash.jpg", Some(0)), Err(AppError::InvalidInput(_))));

        let decoded = text(source, "strings/russian/mp_ingame.str").unwrap();
        assert_eq!(decoded.encoding, "windows-1251");
        assert!(!decoded.truncated);
        assert!(decoded.text.contains("\"Получено\""));
        assert!(decoded.text.contains("\"Два\""));
        assert!(matches!(text_of(source, "levelshots/mp/ffa3.jpg"), Err(AppError::InvalidInput(_))));
        assert!(matches!(text_of(source, "../secrets.txt"), Err(AppError::InvalidInput(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn text_of(source: &Path, name: &str) -> Result<PreviewTextData> {
        let name = requested_name(name)?;
        text(source, &name)
    }

    #[test]
    fn a_thumbnail_of_a_tga_is_a_png_that_fits_the_square() {
        let dir = temp_dir("thumbnail");
        let path = dir.join("picture.pk3");
        let mut tga = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(64, 32, image::Rgba([255, 0, 0, 128])))
            .write_to(&mut tga, image::ImageFormat::Tga)
            .unwrap();
        let mut jpeg = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(300, 150)
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .unwrap();
        archive(
            &path,
            &[("gfx/2d/crosshair.tga", tga.get_ref()), ("levelshots/wide.jpg", jpeg.get_ref())],
        );
        let thumbnail = picture(&path, "gfx/2d/crosshair.tga", Some(16)).unwrap();
        assert!(thumbnail.data_url.starts_with("data:image/png;base64,"));
        assert_eq!((thumbnail.width, thumbnail.height), (16, 8));
        let png = base64::engine::general_purpose::STANDARD
            .decode(thumbnail.data_url.trim_start_matches("data:image/png;base64,"))
            .unwrap();
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (16, 8));
        assert!(decoded.color().has_alpha(), "the alpha of the TGA survives");

        let small = picture(&path, "levelshots/wide.jpg", Some(100)).unwrap();
        assert!(small.data_url.starts_with("data:image/jpeg;base64,"));
        assert_eq!((small.width, small.height), (100, 50));
        // A picture that already fits comes back as its own bytes.
        let same = picture(&path, "levelshots/wide.jpg", Some(400)).unwrap();
        assert_eq!((same.width, same.height), (300, 150));
        assert_eq!(same.data_url.len(), 23 + jpeg.get_ref().len().div_ceil(3) * 4);

        let key = ("session".to_string(), 0, "gfx/2d/crosshair.tga".to_string(), 16);
        remember_thumbnail(key.clone(), &thumbnail);
        assert_eq!(cached_thumbnail(&key), Some(thumbnail));
        forget_session("session");
        assert_eq!(cached_thumbnail(&key), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_entry_is_read_by_the_logical_name_the_session_listed() {
        let dir = temp_dir("logical");
        let path = dir.join("wrapped.pk3");
        // A wrapper folder, backslashes and upper case: what JKHub archives
        // ship, and what `logical_name` takes out of the names of a session.
        archive(
            &path,
            &[
                ("MyMod/", b"" as &[u8]),
                ("MyMod\\Menu\\Splash.jpg", &jpeg(0xC0, 64, 32, 0)),
                ("menu/splash.jpg", &jpeg(0xC0, 16, 16, 0)),
                ("MyMod/readme.txt", b"first\n"),
            ],
        );
        // The first entry of a logical name wins, as in the session.
        let splash = picture(&path, "menu/splash.jpg", None).unwrap();
        assert_eq!((splash.width, splash.height), (64, 32));
        // A folder that is not a root of the game stays in the name.
        assert_eq!(text(&path, "mymod/readme.txt").unwrap().text, "first\n");
        assert!(matches!(text(&path, "readme.txt"), Err(AppError::NotFound(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_text_is_cut_and_marked() {
        let dir = temp_dir("long");
        let path = dir.join("text.pk3");
        let long: Vec<u8> = b"seta cg_fov 97\n".iter().cycle().take(MAX_TEXT_BYTES as usize + 100).copied().collect();
        archive(&path, &[("autoexec.cfg", &long)]);
        let decoded = text(&path, "autoexec.cfg").unwrap();
        assert!(decoded.truncated);
        assert_eq!(decoded.text.len(), MAX_TEXT_BYTES as usize);
        assert_eq!(decoded.encoding, "utf-8");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_badges_of_a_card_follow_the_taxonomy() {
        let entries: Vec<String> = [
            "levelshots/mp/ffa3.jpg",
            "levelshots/Thumbs.db",
            "menu/splash.jpg",
            "gfx/2d/charsgrid_med.tga",
            "strings/Russian/menus.str",
            "strings/English/menus.str",
            "shaders/gfx.shader",
            "textures/common/caps.jpg",
            "models/weapons2/detpack/det_pack.md3",
            "sound/interface/click.wav",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            features(&entries),
            [
                "levelshots",
                "splash",
                "menu",
                "textures",
                "strings:english",
                "strings:russian",
                "shaders",
                "weapons",
                "sounds"
            ]
        );
        let japro: Vec<String> = [
            "ui/jamp/main.menu",
            "ui/hud.menu",
            "gfx/hud/bar.png",
            "fonts/anewhope.fontdat",
            "effects/mp/drain.efx",
            "scripts/t1/door.ibi",
            "video/intro.roq",
            "japro_default.cfg",
            "cgamex86.dll",
            "strip/sp_ingame.sp",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            features(&japro),
            ["menu", "hud", "fonts", "strings:strip", "effects", "scripts", "videos", "configs", "modules"]
        );
        assert!(features(&["ui/jahud.txt".to_string()]).contains(&"hud".to_string()));
        assert!(features(&[]).is_empty());
    }

    #[test]
    fn the_badges_of_a_card_name_the_objects_the_preview_assembles() {
        let names = |paths: &[&str]| paths.iter().map(|path| path.to_string()).collect::<Vec<_>>();
        // A character with its voice, a map with its music, an NPC.
        assert_eq!(
            features(&names(&[
                "models/players/kyle/model.glm",
                "models/players/kyle/model_default.skin",
                "models/players/_humanoid/_humanoid.gla",
                "sound/chars/kyle/misc/taunt.mp3",
                "music/mp/duel.mp3",
                "maps/mp/ffa3.bsp",
                "ext_data/npcs/kyle.npc",
            ])),
            ["characters", "npcs", "maps", "music", "sounds"]
        );
        // A reskin ships pictures alone; the preview finds the model in the game.
        assert_eq!(features(&names(&["models/players/kyle/kyle_torso.png"])), ["textures", "characters"]);
        assert_eq!(features(&names(&["models/players/kyle/icon_default.jpg"])), ["characters"]);
        assert_eq!(features(&names(&["ext_data/npcs.cfg"])), ["npcs"]);
        // A vehicle is not a character, though its model lives with them.
        assert_eq!(
            features(&names(&[
                "ext_data/vehicles/swoop.veh",
                "models/players/swoop/model.glm",
                "models/players/swoop/model_default.skin",
            ])),
            ["vehicles"]
        );
        assert_eq!(
            features(&names(&["ext_data/vehicles/swoop.veh", "models/players/swoop/model.glm", "models/players/reborn/model.glm"])),
            ["characters", "vehicles"]
        );
        assert_eq!(features(&names(&["models/map_objects/szico_vehicles/xwing.md3"])), ["vehicles"]);
        // Hilts: by the folder, or by the `.sab` that describes them.
        assert_eq!(features(&names(&["models/weapons2/saber_1/saber_1.glm"])), ["hilts"]);
        assert_eq!(
            features(&names(&[
                "ext_data/sabers/cool.sab",
                "models/weapons2/cool_hilt/hilt.glm",
                "models/weapons2/cool_hilt/hilt.jpg",
            ])),
            ["textures", "hilts"],
            "a hilt in a folder of its own is not a weapon"
        );
        // Weapons: a model or a reskin in a weapon folder, `noweap` aside.
        assert_eq!(features(&names(&["models/weapons2/blaster_pistol/blaster_pistol.jpg"])), ["textures", "weapons"]);
        assert_eq!(features(&names(&["Models\\Weapons2\\Thermal\\thermal.md3"])), ["weapons"]);
        assert!(features(&names(&["models/weapons2/noweap/noweap.glm", "models/weapons2/readme.txt"])).is_empty());
        // Music is under `music/`; every other audio file is a sound.
        assert_eq!(features(&names(&["music/mp/duel.mp3"])), ["music"]);
        assert_eq!(features(&names(&["sound/interface/click.wav", "taunt.ogg"])), ["sounds"]);
    }

    #[test]
    fn the_badges_of_a_card_fit_the_manifest_of_a_bundle() {
        use crate::bundles::manifest::{is_library_feature, MAX_LIBRARY_FEATURES};
        // Every fixed code passes the rule of the service.
        let everything: Vec<String> = [
            "levelshots/x.jpg",
            "menu/splash.jpg",
            "ui/jamp/main.menu",
            "gfx/hud/bar.png",
            "textures/a/b.jpg",
            "fonts/x.fontdat",
            "strings/russian/x.str",
            "shaders/x.shader",
            "effects/x.efx",
            "scripts/x.ibi",
            "video/x.roq",
            "x.cfg",
            "cgamex86.dll",
            "models/players/kyle/model.glm",
            "models/weapons2/saber_1/saber_1.glm",
            "models/weapons2/blaster/blaster.glm",
            "ext_data/npcs/x.npc",
            "ext_data/vehicles/x.veh",
            "maps/x.bsp",
            "music/x.mp3",
            "sound/x.wav",
        ]
        .map(String::from)
        .to_vec();
        let codes = features(&everything);
        assert_eq!(codes.len(), 21, "every fixed code and one language: {codes:?}");
        assert!(codes.iter().all(|code| is_library_feature(code)), "{codes:?}");
        assert_eq!(codes.last().map(String::as_str), Some("sounds"));
        // A language folder outside the alphabet gets no badge, and only as
        // many languages as fit next to the fixed codes are named.
        let mut many: Vec<String> = (0..20).map(|i| format!("strings/lang{i:02}/menus.str")).collect();
        many.push("strings/pt_br/menus.str".into());
        many.push("strings/Русский/menus.str".into());
        many.push(format!("strings/{}/menus.str", "l".repeat(30)));
        many.extend(everything.iter().cloned());
        let codes = features(&many);
        assert_eq!(codes.len(), MAX_LIBRARY_FEATURES, "{codes:?}");
        let languages: Vec<_> = codes.iter().filter(|code| code.starts_with("strings:")).collect();
        assert_eq!(languages.len(), 12);
        assert_eq!(languages[0], "strings:lang00");
        assert_eq!(languages[11], "strings:lang11");
        assert!(codes.iter().all(|code| is_library_feature(code)), "{codes:?}");
        assert_eq!(codes.last().map(String::as_str), Some("sounds"), "a language never pushes a fixed code out");
    }
}
