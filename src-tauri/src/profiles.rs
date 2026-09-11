//! Player profiles: who the player is inside the game.
//!
//! A profile is the fourth entity of the launcher, next to the engine, the
//! client and the library file. It holds the nickname other players read, the
//! skin the character wears, the saber hilts in its hands and the colours of
//! the blades and of the character itself — nine launch cvars and a name for
//! the launcher to call the set by.
//!
//! The entity the `CLAUDE.md` of this repository forbids is a different one: a
//! wrapper around «engine + files + settings», which is what a **client**
//! already is. A player profile owns none of that. It belongs *to* a client and
//! adds cosmetics on top of it.
//!
//! On disk, next to the record of the client it belongs to:
//!
//! ```text
//! clients\<slug>\client.json     the client itself
//! clients\<slug>\profiles.json   the document below
//! ```
//!
//! Both files go through the same [`crate::state::StepLock`], so a window
//! saving a profile and a window renaming the client cannot overwrite each
//! other — see [`crate::clients::edit_record`], which this module mirrors.
//!
//! ## How a profile reaches the game
//!
//! [`launch_tokens`] turns it into `+set` tokens, and
//! [`crate::launch::build_launch_args`] puts them after the client's own
//! arguments and before the ones a single run passes. That order is the whole
//! rule: `Com_StartupVariable` keeps the last `+set` of a cvar, so a profile
//! beats the `+set name` a player typed into the client's argument field. A
//! field the profile does not set writes no token at all, and the engine keeps
//! whatever its own configuration says.

use std::fs;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::clients;
use crate::error::{AppError, Result};
use crate::game::Game;
use crate::paths::{self, DataPaths};
use crate::state::AppState;

/// The document beside `client.json`.
const PROFILES_FILE: &str = "profiles.json";

/// Longest profile name the launcher accepts. The same limit a client name
/// has: both are names on a card, and a longer one says nothing extra.
///
/// Characters, not bytes, and on purpose: this name is read in the launcher
/// and never reaches the engine, so nothing downstream counts its bytes.
const MAX_NAME_LEN: usize = 48;

/// Longest nickname the launcher accepts, **in bytes of UTF-8**.
///
/// `MAX_NETNAME` of the engine (`codemp/game/g_local.h:478` of OpenJK
/// `1a6a6434`): `ClientCleanName` copies the name byte by byte into a buffer
/// of this size and stops at `outpos < outSize - 1`, so what it counts is
/// bytes and not letters. A Cyrillic letter costs two of them, which makes a
/// nickname of eighteen Cyrillic letters exactly as long as one of thirty-six
/// Latin ones. Colour codes count towards the limit as well.
///
/// Counting characters here instead would let the window promise a name the
/// server then cuts in half, possibly through the middle of a letter.
const MAX_NICKNAME_LEN: usize = 36;

/// Longest value of the cvars that name a file: the model and the two hilts.
/// `MAX_QPATH` in `codemp/qcommon/qfiles.h:39` of OpenJK `1a6a6434`, a byte
/// buffer like the one above.
const MAX_VALUE_LEN: usize = 64;

/// Most profiles one client may hold. High enough that nobody meets it and low
/// enough that a broken writer cannot fill a disk.
const MAX_PROFILES: usize = 64;

/// --- slice: connect dialog ---
/// The name a profile of one launch borrows on its way through [`validate`].
///
/// [`validate`] refuses a blank name, and rightly so for a stored profile: a
/// row with no name is one the player cannot tell from the next. A profile of
/// one run is never listed and never written, so it borrows a name rather than
/// a second copy of every other check.
const INLINE_NAME: &str = "one run";

/// Highest value `color1` and `color2` take.
///
/// `saber_colors_t` in `codemp/qcommon/q_shared.h:349-358` of OpenJK
/// `1a6a6434` holds six: 0 red, 1 orange, 2 yellow, 3 green, 4 blue, 5 purple.
pub const MAX_SABER_COLOR: u8 = 5;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// The tint of the character model, `char_color_red|green|blue`.
///
/// Three bytes rather than one string, because the engine reads three cvars and
/// the window draws one swatch. A field of the profile as a whole: a tint with
/// one channel missing is not a tint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharColor {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
}

/// One player profile of one client.
///
/// Every field but `id` and `name` is optional, and `None` means «this profile
/// has no opinion»: no token goes out and the engine keeps its own value. That
/// is not the same as an empty string, which would hand the engine a blank
/// nickname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerProfile {
    /// Slug derived from the first name, stable afterwards: the default
    /// profile is stored by id, and a rename must not move it.
    #[serde(default)]
    pub id: String,
    /// Name of the profile in the launcher. Not the nickname.
    pub name: String,
    /// Value of the cvar `name`, colour codes included.
    #[serde(default)]
    pub nickname: Option<String>,
    /// Value of the cvar `model`: `kyle` or `kyle/red`.
    #[serde(default)]
    pub model: Option<String>,
    /// Value of the cvar `saber1`: the block name of a `.sab` entry.
    #[serde(default)]
    pub saber1: Option<String>,
    /// Value of the cvar `saber2`. `none` is a deliberate second hand left
    /// empty; `None` is a profile that does not manage the field.
    #[serde(default)]
    pub saber2: Option<String>,
    /// Blade colour of the first hilt, 0 to [`MAX_SABER_COLOR`].
    #[serde(default)]
    pub color1: Option<u8>,
    /// Blade colour of the second hilt.
    #[serde(default)]
    pub color2: Option<u8>,
    /// Tint of the character model.
    #[serde(default)]
    pub char_color: Option<CharColor>,
}

// --- slice: connect dialog ---

/// A profile that belongs to one launch and to nothing else.
///
/// The **Connect…** dialog fills these fields in by hand, presses **Connect**
/// and is done: nothing reaches `profiles.json` and no id names it afterwards.
/// It is a [`PlayerProfile`] without the `id` and the `name`, which are the two
/// fields a *stored* profile is found and listed by, and which a profile that
/// is neither stored nor listed has no use for.
///
/// The values pass the very gate a saved profile passes — see
/// [`InlineProfile::into_profile`] — and become tokens through the very
/// function a saved profile goes through, [`launch_tokens`]. A second copy of
/// either would be a second set of rules about what may reach a command line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineProfile {
    /// Value of the cvar `name`, colour codes included.
    #[serde(default)]
    pub nickname: Option<String>,
    /// Value of the cvar `model`: `kyle` or `kyle/red`.
    #[serde(default)]
    pub model: Option<String>,
    /// Value of the cvar `saber1`.
    #[serde(default)]
    pub saber1: Option<String>,
    /// Value of the cvar `saber2`.
    #[serde(default)]
    pub saber2: Option<String>,
    /// Blade colour of the first hilt, 0 to [`MAX_SABER_COLOR`].
    #[serde(default)]
    pub color1: Option<u8>,
    /// Blade colour of the second hilt.
    #[serde(default)]
    pub color2: Option<u8>,
    /// Tint of the character model.
    #[serde(default)]
    pub char_color: Option<CharColor>,
}

impl InlineProfile {
    /// The same fields, checked and trimmed exactly as a stored profile is.
    ///
    /// The `id` stays empty and the `name` is [`INLINE_NAME`]: neither leaves
    /// this function, because the only thing the caller does with the answer is
    /// ask [`launch_tokens`] for the `+set` of it.
    pub fn into_profile(self) -> Result<PlayerProfile> {
        validate(PlayerProfile {
            id: String::new(),
            name: INLINE_NAME.to_string(),
            nickname: self.nickname,
            model: self.model,
            saber1: self.saber1,
            saber2: self.saber2,
            color1: self.color1,
            color2: self.color2,
            char_color: self.char_color,
        })
    }
}

/// Which profile one launch runs with.
///
/// Two ways to name a profile and one value to carry both, because the pair
/// travels together from the command down to `resolve_launch` and a signature
/// that took them apart would be one that could be handed both at once.
#[derive(Debug, Clone, Default)]
pub struct ProfileChoice {
    /// Id of a profile of this client. `None` means the client's default one,
    /// which is what **Play** and the quick **Connect** send.
    pub id: Option<String>,
    /// A profile of this run alone. When it is here it *is* the answer and
    /// [`ProfileChoice::id`] is never read: the dialog that fills the fields in
    /// by hand has switched away from the list of stored profiles, and reading
    /// both would put a nickname on a server that the player did not pick.
    pub inline: Option<InlineProfile>,
}

impl ProfileChoice {
    /// The `+set` tokens this choice adds to a command line.
    ///
    /// One place for the rule, so the preview and the launch cannot disagree
    /// about whose nickname goes out.
    pub fn tokens(self, paths: &DataPaths, client_id: &str, game: Game) -> Result<Vec<String>> {
        if let Some(inline) = self.inline {
            return Ok(launch_tokens(&inline.into_profile()?, game));
        }
        Ok(read_book(paths, client_id)
            .resolve(self.id.as_deref())?
            .map(|profile| launch_tokens(profile, game))
            .unwrap_or_default())
    }
}

/// `clients\<slug>\profiles.json`.
///
/// Container-level `serde(default)`, so a client folder written before this
/// slice — that is, every client on every installed launcher — reads as an
/// empty list rather than as a failure.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileBook {
    /// Profiles in the order the player made them.
    pub profiles: Vec<PlayerProfile>,
    /// The profile **Play** and **Connect** start the client with. `None`
    /// means the client launches without any profile tokens.
    pub default_profile_id: Option<String>,
}

impl ProfileBook {
    /// The profile a launch uses when the caller named none.
    ///
    /// An id that names nothing answers `None` rather than falling back to the
    /// first profile: the two writers of this field — [`save_profile`] and
    /// [`delete_profile`] — keep it pointing at a real profile, so a dangling
    /// id means the document was edited by hand and guessing would start a game
    /// with somebody else's name on it.
    pub fn default_profile(&self) -> Option<&PlayerProfile> {
        let id = self.default_profile_id.as_deref()?;
        self.find(id)
    }

    /// The profile with this id, or `None`.
    pub fn find(&self, id: &str) -> Option<&PlayerProfile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }

    /// The profile a launch should use: the one named, or the default one.
    ///
    /// A named id that is not in the document is a refusal, not a silent
    /// fallback: a **Connect** that quietly used another profile would put the
    /// wrong nickname on a server.
    pub fn resolve(&self, wanted: Option<&str>) -> Result<Option<&PlayerProfile>> {
        match wanted {
            Some(id) => self
                .find(id)
                .map(Some)
                .ok_or_else(|| AppError::NotFound(format!("player profile {id}"))),
            None => Ok(self.default_profile()),
        }
    }
}

// ---------------------------------------------------------------------------
// Launch tokens
// ---------------------------------------------------------------------------

/// Turns a profile into the `+set` tokens of a command line.
///
/// One token per argument of the process, exactly as
/// [`crate::launch::build_launch_args`] builds the rest: `std::process::Command`
/// puts the quotes back around a nickname with a space in it, and a value
/// quoted here would reach the engine with the quotes inside the name.
///
/// The order is the order of the form in the window — name, model, hilts, blade
/// colours, character tint — and it does not matter to the engine, which reads
/// nine different cvars. It matters to the player reading the preview line.
///
/// A game with no hilt data writes neither `saber1` nor `saber2`, whatever the
/// profile holds. See [`crate::game::GameSpec::has_saber_hilts`].
pub fn launch_tokens(profile: &PlayerProfile, game: Game) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut set = |name: &str, value: String| {
        args.push("+set".to_string());
        args.push(name.to_string());
        args.push(value);
    };

    if let Some(value) = profile.nickname.as_deref() {
        set("name", value.to_string());
    }
    if let Some(value) = profile.model.as_deref() {
        set("model", value.to_string());
    }
    if game.spec().has_saber_hilts {
        if let Some(value) = profile.saber1.as_deref() {
            set("saber1", value.to_string());
        }
        if let Some(value) = profile.saber2.as_deref() {
            set("saber2", value.to_string());
        }
    }
    if let Some(color) = profile.color1 {
        set("color1", color.to_string());
    }
    if let Some(color) = profile.color2 {
        set("color2", color.to_string());
    }
    if let Some(tint) = profile.char_color {
        set("char_color_red", tint.red.to_string());
        set("char_color_green", tint.green.to_string());
        set("char_color_blue", tint.blue.to_string());
    }
    args
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The profiles of one client and which of them is the default.
#[tauri::command]
pub fn list_profiles(
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<ProfileBook> {
    let paths = state.paths()?;
    // The record is read first, so an id that names nothing is a refusal
    // instead of an empty list the window would draw as «no profiles yet».
    clients::read_record(&paths, &client_id)?;
    Ok(read_book(&paths, &client_id))
}

/// Creates a profile or rewrites one, and answers with the whole document.
///
/// A profile whose `id` is empty is a new one and gets a slug of its own; any
/// other id has to name a profile that is already there. The first profile a
/// client gets becomes its default, because a client with one profile and no
/// default would launch without it and nothing on screen would explain why.
#[tauri::command]
pub fn save_profile(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    profile: PlayerProfile,
) -> Result<ProfileBook> {
    // Checked before the lock: a refused value must not cost another window
    // the wait, and it never reaches a document.
    let profile = validate(profile)?;

    let paths = state.paths()?;
    let book = edit_book(&state, &paths, &client_id, move |book| {
        if profile.id.is_empty() {
            if book.profiles.len() >= MAX_PROFILES {
                return Err(AppError::InvalidInput(format!(
                    "a client may hold {MAX_PROFILES} player profiles"
                )));
            }
            let taken: Vec<String> = book
                .profiles
                .iter()
                .map(|stored| stored.id.clone())
                .collect();
            let mut added = profile;
            added.id = unique_slug(&added.name, &taken);
            book.default_profile_id
                .get_or_insert_with(|| added.id.clone());
            book.profiles.push(added);
            return Ok(());
        }
        let Some(stored) = book
            .profiles
            .iter_mut()
            .find(|stored| stored.id == profile.id)
        else {
            return Err(AppError::NotFound(format!("player profile {}", profile.id)));
        };
        *stored = profile;
        Ok(())
    })?;

    log::info!(
        "client {client_id} has {} player profile(s)",
        book.profiles.len()
    );
    clients::emit_changed(&app, &client_id);
    Ok(book)
}

/// Deletes a profile and answers with the whole document.
///
/// Deleting the default one moves the badge to the first profile left, so a
/// client never ends up with profiles and no default: **Play** would then
/// launch bare and the card would have nothing to say about it.
#[tauri::command]
pub fn delete_profile(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    profile_id: String,
) -> Result<ProfileBook> {
    let paths = state.paths()?;
    let book = edit_book(&state, &paths, &client_id, |book| {
        let before = book.profiles.len();
        book.profiles.retain(|profile| profile.id != profile_id);
        if book.profiles.len() == before {
            return Err(AppError::NotFound(format!("player profile {profile_id}")));
        }
        if book.default_profile_id.as_deref() == Some(profile_id.as_str()) {
            book.default_profile_id = book.profiles.first().map(|profile| profile.id.clone());
        }
        Ok(())
    })?;

    log::info!("deleted the player profile {profile_id} of client {client_id}");
    clients::emit_changed(&app, &client_id);
    Ok(book)
}

/// Points the client at another default profile, or at none.
#[tauri::command]
pub fn set_default_profile(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    profile_id: Option<String>,
) -> Result<ProfileBook> {
    let paths = state.paths()?;
    let book = edit_book(&state, &paths, &client_id, |book| {
        match profile_id.as_deref() {
            Some(id) => {
                if book.find(id).is_none() {
                    return Err(AppError::NotFound(format!("player profile {id}")));
                }
                book.default_profile_id = Some(id.to_string());
            }
            None => book.default_profile_id = None,
        }
        Ok(())
    })?;

    log::info!(
        "client {client_id} launches with the player profile {:?}",
        book.default_profile_id
    );
    clients::emit_changed(&app, &client_id);
    Ok(book)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Reads, changes and writes `profiles.json` without anything else getting
/// between the three steps.
///
/// The same lock as `client.json`, for the same reason and with one more: the
/// two documents describe one client, and a profile saved while the client is
/// being deleted would put the folder back on disk.
fn edit_book(
    state: &AppState,
    paths: &DataPaths,
    client_id: &str,
    edit: impl FnOnce(&mut ProfileBook) -> Result<()>,
) -> Result<ProfileBook> {
    let _step = state.client_records().enter();
    // Under the lock, so a client deleted a moment ago is a refusal rather
    // than a folder this write brings back.
    clients::read_record(paths, client_id)?;
    let mut book = read_book(paths, client_id);
    edit(&mut book)?;
    write_book(paths, client_id, &book)?;
    Ok(book)
}

/// Reads the document of one client, treating a missing or broken one as
/// empty.
///
/// A client written before this slice has no such file, which is the ordinary
/// case and not a failure. A file that will not parse costs the profiles of one
/// client and is logged; refusing to open the window over it would leave the
/// player with no way to write a new one.
pub(crate) fn read_book(paths: &DataPaths, client_id: &str) -> ProfileBook {
    let file = paths.client_dir(client_id).join(PROFILES_FILE);
    let Ok(text) = fs::read_to_string(&file) else {
        return ProfileBook::default();
    };
    match serde_json::from_str(&text) {
        Ok(book) => book,
        Err(e) => {
            log::warn!("cannot parse {}: {e}, starting an empty one", file.display());
            ProfileBook::default()
        }
    }
}

fn write_book(paths: &DataPaths, client_id: &str, book: &ProfileBook) -> Result<()> {
    let dir = paths.client_dir(client_id);
    paths::create_dir(&dir)?;
    let file = dir.join(PROFILES_FILE);
    let text = serde_json::to_string_pretty(book)
        .map_err(|e| AppError::json("cannot serialize the player profiles", e))?;
    fs::write(&file, text).map_err(|e| AppError::io_path("cannot write", &file, e))
}

// ---------------------------------------------------------------------------
// What a profile may hold
// ---------------------------------------------------------------------------

/// Trims every field and refuses what the command line could not carry.
///
/// The values go onto a command line the engine parses as one string, so the
/// rules are the ones of [`crate::launch_tokens`]: a double quote flips the
/// parser's «inside quotes» flag for everything after it, and a line break
/// opens a console segment of its own. A blank field becomes `None`, which is
/// the launcher's way of saying «this profile does not manage the cvar».
fn validate(profile: PlayerProfile) -> Result<PlayerProfile> {
    let name = profile.name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("the profile name is empty".into()));
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::InvalidInput(format!(
            "the profile name is longer than {MAX_NAME_LEN} characters"
        )));
    }

    for color in [profile.color1, profile.color2].into_iter().flatten() {
        if color > MAX_SABER_COLOR {
            return Err(AppError::InvalidInput(format!(
                "a saber colour is 0 to {MAX_SABER_COLOR}, not {color}"
            )));
        }
    }

    Ok(PlayerProfile {
        id: profile.id.trim().to_string(),
        name: name.to_string(),
        nickname: clean(
            profile.nickname.as_deref(),
            MAX_NICKNAME_LEN,
            "nickname",
            Shape::Free,
        )?,
        model: clean(profile.model.as_deref(), MAX_VALUE_LEN, "model", Shape::Model)?,
        saber1: clean(
            profile.saber1.as_deref(),
            MAX_VALUE_LEN,
            "saber1",
            Shape::Block,
        )?,
        saber2: clean(
            profile.saber2.as_deref(),
            MAX_VALUE_LEN,
            "saber2",
            Shape::Block,
        )?,
        color1: profile.color1,
        color2: profile.color2,
        char_color: profile.char_color,
    })
}

/// The form a value has to keep on top of the rules of the command line.
#[derive(Clone, Copy)]
enum Shape {
    /// Whatever the player typed. The nickname: colour codes, any alphabet and
    /// any punctuation are theirs to choose.
    Free,
    /// `<model>` or `<model>/<variant>`, the two forms the cvar `model` takes.
    Model,
    /// The name of a block in a `.sab` file, which is one part with no slash.
    Block,
}

impl Shape {
    /// Whether the value is one the game could look a file up by.
    fn fits(self, value: &str) -> bool {
        match self {
            Shape::Free => true,
            Shape::Model => match value.split_once('/') {
                Some((model, variant)) => is_file_part(model) && is_file_part(variant),
                None => is_file_part(value),
            },
            Shape::Block => is_file_part(value),
        }
    }
}

/// Whether the value is one part of a name the game holds a file under.
///
/// The rule of [`crate::appearance`], which guards the very same names on
/// their way out of an archive: letters, digits and the four marks a Raven
/// folder name uses, never a lone `.` or `..`, never a slash. Upper case
/// passes here because a player types this value and a `.sab` block keeps the
/// case its author gave it, while the paths inside an archive are lowercased
/// before `appearance` ever compares them.
///
/// The window only ever offers values the core itself found, but `profiles.json`
/// is a text file and `save_profile` is a command any page in the window can
/// call, so the value that arrives has to pass the same gate as the value the
/// launcher went and looked for.
fn is_file_part(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+'))
}

/// One cvar value of a profile, trimmed, bounded and refused when it would
/// rewrite the command line it goes onto or name a file the game has no name
/// for.
///
/// `max` counts **bytes of UTF-8**, because the buffers of the engine this
/// value ends up in are counted in bytes. See [`MAX_NICKNAME_LEN`].
fn clean(value: Option<&str>, max: usize, what: &str, shape: Shape) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > max {
        return Err(AppError::InvalidInput(format!(
            "the {what} is longer than {max} bytes of UTF-8"
        )));
    }
    if value.contains('"') || value.contains('\n') || value.contains('\r') {
        return Err(AppError::InvalidInput(format!(
            "the {what} cannot hold a double quote or a line break"
        )));
    }
    if !shape.fits(value) {
        return Err(AppError::InvalidInput(format!(
            "the {what} is not a name the game holds a file under"
        )));
    }
    Ok(Some(value.to_string()))
}

/// Turns a profile name into a folder-safe slug, the same rule client ids
/// follow. A name with no usable characters — a nickname in Cyrillic, which is
/// the ordinary case here — becomes `profile`.
fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "profile".to_string()
    } else {
        slug
    }
}

/// Appends `-2`, `-3` and so on until the slug is free within one client.
fn unique_slug(name: &str, taken: &[String]) -> String {
    let base = slugify(name);
    if !taken.iter().any(|id| id == &base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.iter().any(|id| id == candidate))
        .unwrap_or(base)
}

/// Where the document of one client lives. Tests only: the two functions above
/// are the whole of the storage, and nothing else builds this path.
#[cfg(test)]
fn book_file(paths: &DataPaths, client_id: &str) -> std::path::PathBuf {
    paths.client_dir(client_id).join(PROFILES_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(name: &str) -> PlayerProfile {
        PlayerProfile {
            id: String::new(),
            name: name.to_string(),
            nickname: None,
            model: None,
            saber1: None,
            saber2: None,
            color1: None,
            color2: None,
            char_color: None,
        }
    }

    #[test]
    fn a_profile_writes_only_the_fields_it_carries() {
        // The point of every field being optional: a profile that says nothing
        // about hilts leaves the engine's own `saber1` alone rather than
        // resetting it to the default.
        let mut only_a_name = profile("Duel");
        only_a_name.nickname = Some("Kyle".to_string());

        assert_eq!(
            launch_tokens(&only_a_name, Game::JediAcademy),
            ["+set", "name", "Kyle"]
        );
        assert_eq!(launch_tokens(&profile("Empty"), Game::JediAcademy), Vec::<String>::new());
    }

    #[test]
    fn the_nine_fields_go_out_in_the_order_of_the_form() {
        let full = PlayerProfile {
            id: "duel".to_string(),
            name: "Duel".to_string(),
            nickname: Some("^1Kyle".to_string()),
            model: Some("kyle/red".to_string()),
            saber1: Some("single_1".to_string()),
            saber2: Some("none".to_string()),
            color1: Some(0),
            color2: Some(5),
            char_color: Some(CharColor { red: 255, green: 128, blue: 0 }),
        };

        assert_eq!(
            launch_tokens(&full, Game::JediAcademy),
            [
                "+set", "name", "^1Kyle",
                "+set", "model", "kyle/red",
                "+set", "saber1", "single_1",
                "+set", "saber2", "none",
                "+set", "color1", "0",
                "+set", "color2", "5",
                "+set", "char_color_red", "255",
                "+set", "char_color_green", "128",
                "+set", "char_color_blue", "0",
            ]
        );
    }

    #[test]
    fn jedi_outcast_gets_no_hilts_however_the_profile_was_filled() {
        // The archives of that game carry no `ext_data/sabers/`, so there is
        // no hilt the two cvars could name. The rest of the profile still goes
        // out: a nickname and a skin work in both games.
        let mut jedi = profile("Duel");
        jedi.nickname = Some("Kyle".to_string());
        jedi.model = Some("kyle/red".to_string());
        jedi.saber1 = Some("single_1".to_string());
        jedi.saber2 = Some("single_2".to_string());

        let tokens = launch_tokens(&jedi, Game::JediOutcast);
        assert!(!tokens.iter().any(|token| token == "saber1"), "{tokens:?}");
        assert!(!tokens.iter().any(|token| token == "saber2"), "{tokens:?}");
        assert_eq!(
            tokens,
            ["+set", "name", "Kyle", "+set", "model", "kyle/red"]
        );
    }

    #[test]
    fn a_nickname_with_a_space_stays_one_token() {
        // Quoting is the job of `std::process::Command` and of the preview
        // line, exactly as it is for a path with a space. A value quoted here
        // would reach the engine with the quotes inside the name.
        let mut named = profile("Duel");
        named.nickname = Some("Kyle Katarn".to_string());

        let tokens = launch_tokens(&named, Game::JediAcademy);
        assert_eq!(tokens, ["+set", "name", "Kyle Katarn"]);
        assert!(!tokens[2].contains('"'));
    }

    #[test]
    fn a_blank_field_is_a_field_the_profile_does_not_manage() {
        let mut blank = profile("  Duel  ");
        blank.nickname = Some("   ".to_string());
        blank.model = Some(String::new());

        let clean = validate(blank).expect("a blank field is not a refusal");
        assert_eq!(clean.name, "Duel");
        assert_eq!(clean.nickname, None);
        assert_eq!(clean.model, None);
        assert_eq!(launch_tokens(&clean, Game::JediAcademy), Vec::<String>::new());
    }

    #[test]
    fn a_value_that_would_rewrite_the_command_line_is_refused() {
        let mut quoted = profile("Duel");
        quoted.nickname = Some("say \"hi\"".to_string());
        assert!(validate(quoted).is_err());

        let mut broken = profile("Duel");
        broken.model = Some("kyle\nred".to_string());
        assert!(validate(broken).is_err());

        let mut long = profile("Duel");
        long.nickname = Some("x".repeat(MAX_NICKNAME_LEN + 1));
        assert!(validate(long).is_err());

        assert!(validate(profile("   ")).is_err());
        assert!(validate(profile(&"x".repeat(MAX_NAME_LEN + 1))).is_err());
    }

    #[test]
    fn a_nickname_is_measured_in_bytes_the_way_the_engine_measures_it() {
        // `ClientCleanName` copies bytes into a buffer of `MAX_NETNAME`, so a
        // Cyrillic letter costs two and eighteen of them fill the name.
        let mut fits = profile("Duel");
        fits.nickname = Some("Т".repeat(MAX_NICKNAME_LEN / 2));
        let clean = validate(fits).expect("eighteen Cyrillic letters are thirty-six bytes");
        assert_eq!(clean.nickname.as_deref(), Some("Т".repeat(18).as_str()));

        let mut over = profile("Duel");
        over.nickname = Some("Т".repeat(MAX_NICKNAME_LEN / 2 + 1));
        // Nineteen letters are thirty-eight bytes: the server would cut the
        // name, possibly through the middle of a letter, so the launcher says
        // so instead of promising a name nobody will read.
        assert!(matches!(
            validate(over),
            Err(AppError::InvalidInput(_)),
        ));

        // A colour code is two bytes of the limit like any other pair of Latin
        // characters, because the engine counts it in and the launcher has to
        // agree.
        let mut coloured = profile("Duel");
        coloured.nickname = Some(format!("^1{}", "x".repeat(MAX_NICKNAME_LEN - 2)));
        assert!(validate(coloured).is_ok());

        let mut coloured_over = profile("Duel");
        coloured_over.nickname = Some(format!("^1{}", "x".repeat(MAX_NICKNAME_LEN - 1)));
        assert!(validate(coloured_over).is_err());
    }

    #[test]
    fn a_model_or_a_hilt_that_is_not_a_file_name_is_refused() {
        // `save_profile` is a command the window can call with anything, and
        // `profiles.json` is a text file, so the form of these three values is
        // checked here rather than trusted to the pickers.
        for bad in ["../../secret", "a/b/c", "/", "kyle/", "/red", "..", "."] {
            let mut wrong = profile("Duel");
            wrong.model = Some(bad.to_string());
            assert!(validate(wrong).is_err(), "{bad:?} is not a model");
        }

        for bad in ["kyle/red", "../hilt", "single 1"] {
            let mut wrong = profile("Duel");
            wrong.saber1 = Some(bad.to_string());
            assert!(validate(wrong).is_err(), "{bad:?} is not a hilt");
        }

        // And what the pickers do offer still goes through.
        let mut right = profile("Duel");
        right.model = Some("kyle".to_string());
        right.saber1 = Some("single_1".to_string());
        right.saber2 = Some("none".to_string());
        assert!(validate(right).is_ok());

        let mut variant = profile("Duel");
        variant.model = Some("jedi_hf/red".to_string());
        assert!(validate(variant).is_ok());
    }

    #[test]
    fn a_saber_colour_outside_the_six_of_the_engine_is_refused() {
        let mut wrong = profile("Duel");
        wrong.color1 = Some(MAX_SABER_COLOR + 1);
        assert!(validate(wrong).is_err());

        let mut right = profile("Duel");
        right.color1 = Some(MAX_SABER_COLOR);
        right.color2 = Some(0);
        assert!(validate(right).is_ok());
    }

    #[test]
    fn profile_ids_are_slugs_that_do_not_collide() {
        assert_eq!(slugify("Duel main"), "duel-main");
        assert_eq!(slugify("^1Kyle"), "1kyle");
        assert_eq!(slugify("дуэли"), "profile");

        let taken = vec!["duel".to_string(), "duel-2".to_string()];
        assert_eq!(unique_slug("Duel", &taken), "duel-3");
        assert_eq!(unique_slug("Duel", &[]), "duel");
    }

    #[test]
    fn a_client_without_the_document_has_no_profiles() {
        // Every client on every installed launcher is in this state, and it is
        // not a failure: the window draws an empty list and a New profile
        // button.
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");

        assert_eq!(read_book(&paths, "duel"), ProfileBook::default());
        assert!(!book_file(&paths, "duel").is_file());
        assert!(read_book(&paths, "duel").default_profile().is_none());
    }

    #[test]
    fn a_document_of_an_older_shape_reads_field_by_field() {
        // The nine launch fields arrived together, but a hand-written document
        // may carry any subset of them, and every one is `serde(default)`.
        let book: ProfileBook = serde_json::from_str(
            r#"{"profiles":[{"id":"duel","name":"Duel","nickname":"Kyle"}]}"#,
        )
        .expect("a partial document parses");
        let profile = book.find("duel").expect("the profile");
        assert_eq!(profile.nickname.as_deref(), Some("Kyle"));
        assert_eq!(profile.model, None);
        assert_eq!(profile.char_color, None);
        assert_eq!(book.default_profile_id, None);
    }

    #[test]
    fn the_default_is_resolved_by_id_and_never_guessed() {
        let mut book = ProfileBook::default();
        book.profiles.push(PlayerProfile { id: "duel".into(), ..profile("Duel") });
        book.profiles.push(PlayerProfile { id: "ffa".into(), ..profile("FFA") });

        // No default named: no tokens, rather than the first profile.
        assert!(book.default_profile().is_none());
        assert!(book.resolve(None).expect("no default is not a refusal").is_none());

        book.default_profile_id = Some("ffa".to_string());
        assert_eq!(book.default_profile().map(|p| p.id.as_str()), Some("ffa"));
        assert_eq!(
            book.resolve(Some("duel")).expect("a named profile").map(|p| p.id.as_str()),
            Some("duel")
        );

        // A named id that is not there is a refusal: a Connect that silently
        // used another profile would put the wrong nickname on a server.
        assert!(book.resolve(Some("ghost")).is_err());

        // And so is a stored default that names nothing, which only a
        // hand-edited document can produce.
        book.default_profile_id = Some("ghost".to_string());
        assert!(book.default_profile().is_none());
    }

    #[test]
    fn the_document_round_trips_through_disk() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");

        let book = ProfileBook {
            profiles: vec![PlayerProfile {
                id: "duel".to_string(),
                name: "Duel".to_string(),
                nickname: Some("^1Kyle ^7Katarn".to_string()),
                model: Some("kyle/red".to_string()),
                saber1: Some("single_1".to_string()),
                saber2: Some("none".to_string()),
                color1: Some(2),
                color2: Some(4),
                char_color: Some(CharColor { red: 1, green: 2, blue: 3 }),
            }],
            default_profile_id: Some("duel".to_string()),
        };
        write_book(&paths, "duel", &book).expect("the document");

        assert!(book_file(&paths, "duel").is_file());
        assert_eq!(read_book(&paths, "duel"), book);

        // camelCase on the wire and on disk, as everywhere else.
        let text = fs::read_to_string(book_file(&paths, "duel")).expect("the file");
        assert!(text.contains("\"defaultProfileId\""), "{text}");
        assert!(text.contains("\"charColor\""), "{text}");
    }

    #[test]
    fn a_broken_document_costs_the_profiles_of_one_client_and_nothing_else() {
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");
        paths::create_dir(&paths.client_dir("duel")).expect("the client folder");
        fs::write(book_file(&paths, "duel"), "{ not json").expect("a broken document");

        assert_eq!(read_book(&paths, "duel"), ProfileBook::default());
    }

    // --- slice: connect dialog ---

    /// The same seven fields, filled the same way, for the two tests below.
    fn inline() -> InlineProfile {
        InlineProfile {
            nickname: Some("  Kyle Katarn  ".to_string()),
            model: Some("kyle/red".to_string()),
            saber1: Some("single_1".to_string()),
            saber2: Some("none".to_string()),
            color1: Some(3),
            color2: None,
            char_color: Some(CharColor {
                red: 10,
                green: 20,
                blue: 30,
            }),
        }
    }

    #[test]
    fn a_profile_of_one_run_makes_the_very_tokens_a_stored_one_makes() {
        // The dialog fills the fields in by hand and nothing is written, but
        // what reaches the engine has to be indistinguishable: one function
        // builds the tokens and one function checks the values.
        let mut stored = profile("Duel");
        stored.nickname = Some("  Kyle Katarn  ".to_string());
        stored.model = Some("kyle/red".to_string());
        stored.saber1 = Some("single_1".to_string());
        stored.saber2 = Some("none".to_string());
        stored.color1 = Some(3);
        stored.char_color = Some(CharColor {
            red: 10,
            green: 20,
            blue: 30,
        });

        let from_disk = validate(stored).expect("a stored profile of these values");
        let from_dialog = inline().into_profile().expect("a profile of one run");

        assert_eq!(
            launch_tokens(&from_dialog, Game::JediAcademy),
            launch_tokens(&from_disk, Game::JediAcademy),
        );
        // Trimmed by the same call, so the name reaches the server without the
        // spaces the field happened to hold.
        assert_eq!(from_dialog.nickname.as_deref(), Some("Kyle Katarn"));
        // Neither field of a stored profile leaves the conversion.
        assert!(from_dialog.id.is_empty());
        assert_eq!(from_dialog.name, INLINE_NAME);
    }

    #[test]
    fn a_profile_of_one_run_passes_the_same_gate_as_a_stored_one() {
        // `save_profile` is not in this path, so the checks have to stand
        // between the dialog and the command line on their own.
        let mut quoted = inline();
        quoted.nickname = Some("say \"hi\"".to_string());
        assert!(quoted.into_profile().is_err());

        let mut sliced = inline();
        sliced.model = Some("../kyle".to_string());
        assert!(sliced.into_profile().is_err());

        let mut bright = inline();
        bright.color1 = Some(MAX_SABER_COLOR + 1);
        assert!(bright.into_profile().is_err());

        let mut long = inline();
        long.nickname = Some("x".repeat(MAX_NICKNAME_LEN + 1));
        assert!(long.into_profile().is_err());

        // An empty one is legal and simply manages nothing: the dialog opens on
        // exactly this, and a player who types nowhere gets the command line
        // the client would have had anyway.
        let empty = InlineProfile {
            nickname: None,
            model: None,
            saber1: None,
            saber2: None,
            color1: None,
            color2: None,
            char_color: None,
        };
        let blank = empty.into_profile().expect("a profile that manages nothing");
        assert!(launch_tokens(&blank, Game::JediAcademy).is_empty());
    }

    #[test]
    fn a_profile_of_one_run_is_the_answer_and_the_stored_id_is_not_read() {
        // The dialog switches between a list of stored profiles and fields of
        // its own, and sending both would put a nickname on a server that the
        // player is not looking at.
        let temp = tempfile::tempdir().expect("a data root");
        let paths = DataPaths::new(temp.path().to_path_buf());
        paths.ensure().expect("the data layout");
        paths::create_dir(&paths.client_dir("duel")).expect("the client folder");

        let mut stored = profile("Duel");
        stored.id = "duel".to_string();
        stored.nickname = Some("Padawan".to_string());
        write_book(
            &paths,
            "duel",
            &ProfileBook {
                profiles: vec![stored],
                default_profile_id: Some("duel".to_string()),
            },
        )
        .expect("the document");

        let both = ProfileChoice {
            id: Some("duel".to_string()),
            inline: Some(inline()),
        };
        let tokens = both
            .tokens(&paths, "duel", Game::JediAcademy)
            .expect("the tokens of one run");
        assert!(tokens.contains(&"Kyle Katarn".to_string()), "{tokens:?}");
        assert!(!tokens.contains(&"Padawan".to_string()), "{tokens:?}");

        // Without one, the stored profile is what answers, exactly as before.
        let stored_only = ProfileChoice {
            id: Some("duel".to_string()),
            inline: None,
        };
        assert_eq!(
            stored_only
                .tokens(&paths, "duel", Game::JediAcademy)
                .expect("the tokens of the stored profile"),
            ["+set", "name", "Padawan"],
        );
    }
}
