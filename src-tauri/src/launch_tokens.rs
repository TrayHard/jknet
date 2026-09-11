//! One cvar at a time inside the launch arguments of a client.
//!
//! The client window edits `+set r_mode 4` with a dropdown and `+set s_volume
//! 0.5` with a slider, while the same string stays a plain command line the
//! player may write by hand. Both halves therefore read and write the *same*
//! text, and every rule about what that means lives here as a pure function
//! over a string.
//!
//! Three rules carry the whole module:
//!
//! - **The last occurrence is the value.** `Com_StartupVariable` walks the `+`
//!   segments left to right and overwrites the cvar on every match
//!   (`codemp/qcommon/common.cpp:440` of OpenJK `1a6a6434`), so a line that
//!   names `r_mode` twice hands the engine the second one. A control that read
//!   the first would show something the game never sees.
//! - **A write keeps everything else.** The first occurrence is edited where it
//!   stands, the later ones go, and no other token moves. A control that
//!   rebuilt the line from the values it knows about would quietly drop the
//!   `+exec duel.cfg` the player typed next to them.
//! - **Names match the way the engine matches them.** Case is ignored and the
//!   console `+` is optional, which is [`crate::launch::names_cvar`], the same
//!   function the launch warning goes by. `+set r_mode`, `+seta R_Mode` and a
//!   bare `+r_mode` are one cvar.
//!
//! The tokenizer is [`crate::launch::split_args`] — the one the launcher
//! already hands the engine — so what a player learns about quoting in the
//! **Extra arguments** field holds for every control above it.

use std::collections::HashMap;

use tauri::AppHandle;

use crate::clients::{self, Client};
use crate::error::{AppError, Result};
use crate::launch::{names_cvar, split_args};
use crate::state::AppState;

/// Longest cvar name the commands accept. The longest one the engine
/// registers is nowhere near this; the limit is here so a name cannot become a
/// command line of its own.
const MAX_CVAR_NAME_LEN: usize = 64;

/// Longest value the commands accept, for the same reason.
const MAX_CVAR_VALUE_LEN: usize = 256;

/// Console words that put a value into a cvar.
///
/// `set` and `seta` are the two the launcher writes about in the architecture
/// document; `sets` and `setu` are in the same family (`Cvar_Register` of
/// OpenJK gives each its own command) and a line that uses one must not lose
/// the word when the cvar next to it is cleared.
const SETTERS: [&str; 4] = ["set", "seta", "sets", "setu"];

/// The value of a cvar as the engine would read it, or `None`.
///
/// The last occurrence wins, quotes are gone — the tokenizer drops them — and
/// the name is matched without regard to case or a leading `+`.
pub fn read_cvar(args: &str, name: &str) -> Option<String> {
    let tokens = split_args(args);
    occurrences(&tokens, name)
        .last()
        .map(|found| tokens[found.value].clone())
}

/// Writes one cvar into a command line and gives back the whole line.
///
/// `Some` replaces the value of the first occurrence where it stands and drops
/// every later one, so the line ends up naming the cvar exactly once and the
/// engine reads what the caller asked for. `None` removes the cvar. A cvar the
/// line does not mention is appended as `+set <name> <value>`.
///
/// Tokens that are not part of an occurrence come out in the order they went
/// in. Their quoting is normalized, because the line is rebuilt from the
/// tokenizer's output: a value that holds whitespace comes back in double
/// quotes and one that does not comes back bare.
pub fn write_cvar(args: &str, name: &str, value: Option<&str>) -> String {
    let tokens = split_args(args);
    let found = occurrences(&tokens, name);

    if found.is_empty() {
        let mut appended = tokens;
        if let Some(value) = value {
            appended.push("+set".to_string());
            appended.push(name.to_string());
            appended.push(value.to_string());
        }
        return join_args(&appended);
    }

    let mut out: Vec<String> = Vec::with_capacity(tokens.len() + 3);
    let mut copied = 0;
    let mut first = true;
    for occurrence in &found {
        out.extend_from_slice(&tokens[copied..occurrence.start]);
        if first {
            if let Some(value) = value {
                // Everything up to the value — the setter word as the player
                // spelled it and the name as they spelled it — stays put.
                out.extend_from_slice(&tokens[occurrence.start..occurrence.value]);
                out.push(value.to_string());
            }
            first = false;
        }
        copied = occurrence.end;
    }
    out.extend_from_slice(&tokens[copied..]);
    join_args(&out)
}

/// Where one mention of a cvar begins and ends in the token list.
///
/// `start` is the setter word when there is one and the name otherwise, so
/// removing the range never leaves a `+set` with nothing to set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Occurrence {
    start: usize,
    value: usize,
    end: usize,
}

/// Every mention of the cvar, in the order they stand on the line.
///
/// A mention is a token that names the cvar followed by a token that is its
/// value, which is how [`crate::launch::launch_warning`] reads a command line
/// as well. A name at the very end has no value and is not a mention.
fn occurrences(tokens: &[String], name: &str) -> Vec<Occurrence> {
    let mut found: Vec<Occurrence> = Vec::new();
    let mut index = 0;
    while index + 1 < tokens.len() {
        if !names_cvar(&tokens[index], name) {
            index += 1;
            continue;
        }
        // The setter word joins the mention only when it is free: after
        // `+set r_mode set r_mode 4` the second `set` is the value of the
        // first mention and belongs to it.
        let previous_is_free = found.last().is_none_or(|last| last.end < index);
        let start = if index > 0 && previous_is_free && is_setter(&tokens[index - 1]) {
            index - 1
        } else {
            index
        };
        found.push(Occurrence {
            start,
            value: index + 1,
            end: index + 2,
        });
        index += 2;
    }
    found
}

/// True when the token is a console word that assigns a cvar.
fn is_setter(token: &str) -> bool {
    let word = token.trim().trim_start_matches('+');
    SETTERS
        .iter()
        .any(|setter| word.eq_ignore_ascii_case(setter))
}

/// Rebuilds a command line out of tokens, quoting what has to be quoted.
///
/// The engine's own parser counts quotes across the whole line
/// (`Com_ParseCommandLine`), so a token that holds whitespace gets a pair of
/// them and nothing else does. An empty token would vanish without a pair.
fn join_args(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| {
            if token.is_empty() || token.chars().any(char::is_whitespace) {
                format!("\"{token}\"")
            } else {
                token.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Reads several cvars of one client in a single call.
///
/// A name the line does not carry answers `null`, which is what the control
/// bound to it draws as «not set». One call rather than one per control: the
/// window has a dozen of them and they all read the same string.
#[tauri::command]
pub fn read_launch_cvars(
    state: tauri::State<'_, AppState>,
    client_id: String,
    names: Vec<String>,
) -> Result<HashMap<String, Option<String>>> {
    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    names
        .into_iter()
        .map(|name| {
            let name = validate_name(&name)?.to_string();
            let value = read_cvar(&client.launch_args, &name);
            Ok((name, value))
        })
        .collect()
}

/// Writes one cvar into the launch arguments of a client and saves it.
///
/// `null` removes the cvar. The record goes to disk through the same path as
/// [`clients::update_client`], so a window that changed a slider and a window
/// showing the card both learn about it from `clients:changed`.
#[tauri::command]
pub fn write_launch_cvar(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    name: String,
    value: Option<String>,
) -> Result<Client> {
    let name = validate_name(&name)?;
    let value = match value.as_deref() {
        Some(value) => Some(validate_value(value)?),
        None => None,
    };

    let paths = state.paths()?;
    let client = clients::read_record(&paths, &client_id)?;
    let line = write_cvar(&client.launch_args, name, value);
    clients::set_launch_args(&app, &state, &client_id, &line)
}

/// Refuses a cvar name that would not survive the command line.
///
/// Whitespace, quotes and the console `+` are what the tokenizer and the
/// engine's parser go by, so a name carrying one of them would not name a cvar
/// at all. Everything the engine registers is ASCII with underscores.
fn validate_name(name: &str) -> Result<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("the cvar name is empty".into()));
    }
    if trimmed.len() > MAX_CVAR_NAME_LEN {
        return Err(AppError::InvalidInput(format!(
            "the cvar name is longer than {MAX_CVAR_NAME_LEN} characters"
        )));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(AppError::InvalidInput(format!(
            "{trimmed} is not a cvar name: letters, digits and _ only"
        )));
    }
    Ok(trimmed)
}

/// Refuses a value that would break the line it is written into.
///
/// A double quote flips the parser's «inside quotes» flag for everything after
/// it, and a newline opens a console segment of its own. A value holding one
/// would turn the rest of the player's arguments into something else.
fn validate_value(value: &str) -> Result<&str> {
    let trimmed = value.trim();
    if trimmed.len() > MAX_CVAR_VALUE_LEN {
        return Err(AppError::InvalidInput(format!(
            "the value is longer than {MAX_CVAR_VALUE_LEN} characters"
        )));
    }
    if trimmed.contains('"') || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err(AppError::InvalidInput(
            "a cvar value cannot hold a double quote or a line break".into(),
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_occurrence_is_the_one_the_engine_reads() {
        let line = "+set r_mode 3 +exec duel.cfg +set r_mode 9";
        assert_eq!(read_cvar(line, "r_mode"), Some("9".to_string()));
    }

    #[test]
    fn a_cvar_the_line_does_not_carry_reads_as_nothing() {
        assert_eq!(read_cvar("+set r_mode 4", "com_maxfps"), None);
        assert_eq!(read_cvar("", "r_mode"), None);
    }

    #[test]
    fn the_name_is_matched_without_case_and_without_the_plus() {
        assert_eq!(read_cvar("+seta R_Mode 4", "r_mode"), Some("4".to_string()));
        assert_eq!(read_cvar("+r_mode 4", "r_mode"), Some("4".to_string()));
        assert_eq!(read_cvar("+set R_MODE 4", "R_mode"), Some("4".to_string()));
    }

    #[test]
    fn a_quoted_value_reads_without_its_quotes() {
        assert_eq!(
            read_cvar("+set name \"Kyle Katarn\"", "name"),
            Some("Kyle Katarn".to_string())
        );
    }

    #[test]
    fn a_name_with_no_value_after_it_is_not_a_mention() {
        assert_eq!(read_cvar("+exec duel.cfg +set r_mode", "r_mode"), None);
    }

    #[test]
    fn a_write_leaves_every_other_token_where_it_was() {
        let line = "+set com_maxfps 125 +exec duel.cfg +set r_mode 3 +connect 127.0.0.1";
        assert_eq!(
            write_cvar(line, "r_mode", Some("9")),
            "+set com_maxfps 125 +exec duel.cfg +set r_mode 9 +connect 127.0.0.1"
        );
    }

    #[test]
    fn a_write_edits_the_first_mention_and_drops_the_rest() {
        let line = "+set r_mode 3 +exec duel.cfg +seta r_mode 6 +r_mode 8";
        assert_eq!(
            write_cvar(line, "r_mode", Some("9")),
            "+set r_mode 9 +exec duel.cfg"
        );
    }

    #[test]
    fn the_setter_word_the_player_wrote_is_kept() {
        assert_eq!(
            write_cvar("+seta r_mode 3", "r_mode", Some("9")),
            "+seta r_mode 9"
        );
        assert_eq!(write_cvar("+r_mode 3", "r_mode", Some("9")), "+r_mode 9");
    }

    #[test]
    fn a_cvar_the_line_does_not_carry_is_appended() {
        assert_eq!(
            write_cvar("+exec duel.cfg", "r_mode", Some("4")),
            "+exec duel.cfg +set r_mode 4"
        );
        assert_eq!(write_cvar("", "r_mode", Some("4")), "+set r_mode 4");
    }

    #[test]
    fn removing_a_cvar_takes_its_setter_with_it() {
        let line = "+set com_maxfps 125 +set r_mode 3 +exec duel.cfg";
        assert_eq!(
            write_cvar(line, "r_mode", None),
            "+set com_maxfps 125 +exec duel.cfg"
        );
    }

    #[test]
    fn removing_a_cvar_written_without_a_setter_leaves_nothing_behind() {
        assert_eq!(write_cvar("+r_mode 3 +exec duel.cfg", "r_mode", None), "+exec duel.cfg");
    }

    #[test]
    fn removing_every_mention_clears_them_all() {
        let line = "+set r_mode 3 +exec duel.cfg +set r_mode 9";
        assert_eq!(write_cvar(line, "r_mode", None), "+exec duel.cfg");
    }

    #[test]
    fn removing_a_cvar_that_is_not_there_changes_nothing() {
        assert_eq!(
            write_cvar("+exec duel.cfg", "r_mode", None),
            "+exec duel.cfg"
        );
    }

    #[test]
    fn a_value_with_a_space_comes_back_quoted() {
        assert_eq!(
            write_cvar("+exec duel.cfg", "name", Some("Kyle Katarn")),
            "+exec duel.cfg +set name \"Kyle Katarn\""
        );
        assert_eq!(
            write_cvar("+set name Kyle", "name", Some("Kyle Katarn")),
            "+set name \"Kyle Katarn\""
        );
    }

    #[test]
    fn a_quoted_neighbour_keeps_its_quotes() {
        let line = "+exec \"my duel.cfg\" +set r_mode 3";
        assert_eq!(
            write_cvar(line, "r_mode", Some("9")),
            "+exec \"my duel.cfg\" +set r_mode 9"
        );
    }

    #[test]
    fn a_write_finds_the_cvar_whatever_case_it_was_written_in() {
        assert_eq!(
            write_cvar("+set R_Mode 3", "r_mode", Some("9")),
            "+set R_Mode 9"
        );
    }

    #[test]
    fn what_a_write_puts_in_is_what_a_read_gives_back() {
        let line = write_cvar("+exec duel.cfg", "s_volume", Some("0.5"));
        assert_eq!(read_cvar(&line, "s_volume"), Some("0.5".to_string()));
        let cleared = write_cvar(&line, "s_volume", None);
        assert_eq!(read_cvar(&cleared, "s_volume"), None);
        assert_eq!(cleared, "+exec duel.cfg");
    }

    #[test]
    fn a_setter_that_is_the_value_of_the_mention_before_it_stays_there() {
        // `set` is the value of the first mention, so the second mention must
        // not claim it as its own word and cut the line in half.
        let line = "+set r_mode set r_mode 4";
        assert_eq!(write_cvar(line, "r_mode", None), "");
        assert_eq!(read_cvar(line, "r_mode"), Some("4".to_string()));
    }

    #[test]
    fn a_cvar_name_has_to_look_like_one() {
        assert!(validate_name("r_mode").is_ok());
        assert!(validate_name("  com_maxfps  ").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("+set r_mode").is_err());
        assert!(validate_name("r-mode").is_err());
        assert!(validate_name(&"a".repeat(MAX_CVAR_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn a_value_that_would_rewrite_the_line_is_refused() {
        assert!(validate_value("Kyle Katarn").is_ok());
        assert!(validate_value("4").is_ok());
        assert!(validate_value("say \"hi\"").is_err());
        assert!(validate_value("one\ntwo").is_err());
        assert!(validate_value(&"a".repeat(MAX_CVAR_VALUE_LEN + 1)).is_err());
    }
}
