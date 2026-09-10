//! Wire format of the Quake 3 out-of-band queries Jedi Academy speaks.
//!
//! Everything here is pure: bytes in, values out. No socket, no clock, no
//! error type — a malformed datagram yields an empty result instead of a
//! failure, because a stranger on the internet decides what arrives.
//!
//! The formats were read out of the OpenJK sources at
//! `D:\Dev\Personal\jedi academy\OpenJK`, branch `master` @ `1a6a6434`:
//!
//! | Fact | Source |
//! | --- | --- |
//! | `\xff\xff\xff\xff` header, no trailing NUL | `codemp/qcommon/net_chan.cpp`, `NET_OutOfBandPrint` |
//! | `getservers <protocol>` request | `codemp/client/cl_main.cpp:3446`, `CL_GlobalServers_f` |
//! | `getserversResponse` record layout | `codemp/client/cl_main.cpp:1723`, `CL_ServersResponsePacket` |
//! | `infoResponse\n<infostring>` | `codemp/server/sv_main.cpp:553`, `SVC_Info` |
//! | `statusResponse\n<infostring>\n<players>` | `codemp/server/sv_main.cpp:465`, `SVC_Status` |
//! | `g_humanplayers` counts the clients that are not `NA_BOT` | `codemp/server/sv_main.cpp:503`, `SVC_Info` |
//! | A bot's ping is `0`, a client not yet in the game gets `999` | `codemp/server/sv_main.cpp:868`, `SV_CalcPings` |
//! | `gametype_t` order | `codemp/game/bg_public.h:234` |
//! | Colour codes `^0`..`^9` | `shared/qcommon/q_color.h:15` |

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddrV4};

/// Header of every connectionless datagram.
pub const OOB_HEADER: [u8; 4] = [0xff, 0xff, 0xff, 0xff];

/// Network protocol of Jedi Academy 1.01, the only build the community plays.
/// `PROTOCOL_VERSION` in `codemp/qcommon/qcommon.h:214`.
pub const PROTOCOL_VERSION: u16 = 26;

/// Default port of both master servers, `PORT_MASTER` in `qcommon.h:222`.
pub const MASTER_PORT: u16 = 29060;

/// The master servers a stock client asks, `sv_master1` and `sv_master2` in
/// `codemp/server/sv_init.cpp:989`.
pub const DEFAULT_MASTERS: &[&str] = &["masterjk3.ravensoft.com", "master.jkhub.org"];

/// Builds a connectionless datagram: the four `0xff` bytes and the text.
///
/// The engine sends `strlen(string)` bytes, so the command is *not*
/// NUL-terminated. A master that trims on the NUL would otherwise see a
/// different request than the game sends.
pub fn oob_packet(body: &str) -> Vec<u8> {
    let mut packet = Vec::with_capacity(OOB_HEADER.len() + body.len());
    packet.extend_from_slice(&OOB_HEADER);
    packet.extend_from_slice(body.as_bytes());
    packet
}

/// Returns the payload of a connectionless datagram, or `None` when the
/// header is missing.
pub fn oob_payload(datagram: &[u8]) -> Option<&[u8]> {
    datagram.strip_prefix(&OOB_HEADER)
}

/// Splits a payload into its leading command word and the rest.
///
/// The engine separates the command from its argument with a space or a
/// newline. A master answers `getserversResponse\<record>...` with no
/// separator at all, so the caller checks the command with `starts_with`
/// rather than for equality.
pub fn split_command(payload: &[u8]) -> (&[u8], &[u8]) {
    let end = payload
        .iter()
        .position(|b| *b == b' ' || *b == b'\n' || *b == b'\\')
        .unwrap_or(payload.len());
    let rest = payload.get(end + 1..).unwrap_or(&[]);
    (&payload[..end], rest)
}

/// Parses one `getserversResponse` datagram into addresses.
///
/// Record layout, copied from `CL_ServersResponsePacket`: a `\`, four address
/// bytes, then the port as two big-endian bytes. Every record must be followed
/// by the next `\`, which is what makes the `\EOT` trailer stop the loop.
/// A record that does not fit ends the scan, so a truncated datagram costs the
/// last entry and nothing else.
pub fn parse_master_response(datagram: &[u8]) -> Vec<SocketAddrV4> {
    let Some(payload) = oob_payload(datagram) else {
        return Vec::new();
    };
    if !payload.starts_with(b"getserversResponse") {
        return Vec::new();
    }
    let Some(start) = payload.iter().position(|b| *b == b'\\') else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut at = start;
    // Seven bytes per record: the separator, four for the address, two for the
    // port. The eighth byte is the separator of the next record and must be
    // there, exactly as the engine requires.
    while payload.len() > at + 7 {
        if payload[at] != b'\\' {
            break;
        }
        let ip = Ipv4Addr::new(
            payload[at + 1],
            payload[at + 2],
            payload[at + 3],
            payload[at + 4],
        );
        let port = u16::from_be_bytes([payload[at + 5], payload[at + 6]]);
        at += 7;
        if payload[at] != b'\\' {
            break;
        }
        if port != 0 && !ip.is_unspecified() {
            out.push(SocketAddrV4::new(ip, port));
        }
    }
    out
}

/// True when the datagram carries the master's end-of-transmission marker.
pub fn is_master_end(datagram: &[u8]) -> bool {
    oob_payload(datagram)
        .map(|payload| payload.windows(4).any(|w| w == b"\\EOT"))
        .unwrap_or(false)
}

/// Parses `\key\value\key\value` into a map.
///
/// Keys are lowercased: `Info_ValueForKey` in the engine compares them without
/// case, and every key Jedi Academy writes is lowercase already. A key with no
/// value closes the string, which is how the engine's own parser behaves.
pub fn parse_infostring(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut parts = text.trim_matches('\n').split('\\');
    // Everything before the first separator is not a key.
    parts.next();
    while let Some(key) = parts.next() {
        let Some(value) = parts.next() else { break };
        if key.is_empty() {
            continue;
        }
        out.insert(key.to_ascii_lowercase(), value.to_string());
    }
    out
}

/// Removes the game's colour codes.
///
/// `Q_IsColorString` accepts `^` followed by `0`..`9` and nothing else, so
/// `^a` and a trailing lone `^` survive as written. `^^1` keeps its first
/// caret and then loses `^1`, because the engine's scan restarts one character
/// later rather than treating `^^` as an escape.
pub fn strip_colors(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^' {
            if let Some(next) = chars.peek() {
                if next.is_ascii_digit() {
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// Labels of `gametype_t`, in the order of `codemp/game/bg_public.h:234`.
const GAMETYPE_LABELS: [&str; 10] = [
    "FFA",
    "Holocron",
    "Jedi Master",
    "Duel",
    "Power Duel",
    "Single Player",
    "Team FFA",
    "Siege",
    "CTF",
    "CTY",
];

/// Turns a `gametype` number into the label the browser shows.
///
/// Mods invent their own numbers above the enum, so an unknown value keeps its
/// digits instead of pretending to be FFA.
pub fn gametype_label(gametype: u8) -> String {
    GAMETYPE_LABELS
        .get(gametype as usize)
        .map(|label| (*label).to_string())
        .unwrap_or_else(|| format!("Mode {gametype}"))
}

/// One row of a `statusResponse` player list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusPlayer {
    pub name_raw: String,
    pub score: i32,
    pub ping: i32,
}

impl StatusPlayer {
    /// True when this line describes a bot.
    ///
    /// `SV_CalcPings` in `codemp/server/sv_main.cpp:868` writes `cl->ping = 0`
    /// for every client whose entity carries `SVF_BOT`, and that is the only
    /// way a client reaches zero: a player who is connected but not yet in the
    /// game gets 999, and a measured round trip is at least one millisecond.
    /// A human on the same machine as the server would still be routed through
    /// the network stack, so zero over the internet does not happen.
    ///
    /// The rule is exact on OpenJK and on every engine that kept this loop —
    /// which is all of them, since it is Quake 3 code — and remains a
    /// heuristic on a closed mod that rewrites `cl->ping` by hand.
    pub fn is_bot(&self) -> bool {
        self.ping == 0
    }
}

/// Splits a player list into humans and bots.
///
/// Counts saturate at [`u16::MAX`], which no server can reach: `sv_maxclients`
/// is a byte in the protocol.
pub fn count_humans_and_bots(players: &[StatusPlayer]) -> (u16, u16) {
    let bots = players.iter().filter(|player| player.is_bot()).count();
    let humans = players.len() - bots;
    (
        u16::try_from(humans).unwrap_or(u16::MAX),
        u16::try_from(bots).unwrap_or(u16::MAX),
    )
}

/// Parses the player lines of a `statusResponse` body.
///
/// The engine prints `%i %i "%s"\n` and never escapes the name, so a player
/// called `he"llo` produces a line with three quotes. The name is therefore
/// read between the *first* and the *last* quote of the line, which is the
/// only reading that survives that name.
pub fn parse_status_players(body: &str) -> Vec<StatusPlayer> {
    let mut out = Vec::new();
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        let Some(open) = line.find('"') else { continue };
        let Some(close) = line.rfind('"') else { continue };
        if close <= open {
            continue;
        }
        let mut numbers = line[..open].split_whitespace();
        let Some(score) = numbers.next().and_then(|n| n.parse::<i32>().ok()) else {
            continue;
        };
        let Some(ping) = numbers.next().and_then(|n| n.parse::<i32>().ok()) else {
            continue;
        };
        out.push(StatusPlayer {
            name_raw: line[open + 1..close].to_string(),
            score,
            ping,
        });
    }
    out
}

/// The 32 code points where Windows-1252 parts ways with Latin-1.
///
/// A byte the code page leaves undefined keeps its Latin-1 meaning, so the
/// table never loses information.
const CP1252_HIGH: [char; 32] = [
    '\u{20ac}', '\u{81}', '\u{201a}', '\u{192}', '\u{201e}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{2c6}', '\u{2030}', '\u{160}', '\u{2039}', '\u{152}', '\u{8d}', '\u{17d}', '\u{8f}',
    '\u{90}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{2dc}', '\u{2122}', '\u{161}', '\u{203a}', '\u{153}', '\u{9d}', '\u{17e}', '\u{178}',
];

/// Decodes bytes that came off the wire into text that can be rendered.
///
/// Jedi Academy has no encoding: a host name is whatever bytes the server
/// operator typed, and the game draws them through a Windows code page. UTF-8
/// wins when the bytes happen to be valid UTF-8, which covers every server run
/// by a modern tool; the rest is read as Windows-1252. Either way the function
/// returns a string, never an error, so one server with an odd name cannot
/// take out a whole refresh.
pub fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes
            .iter()
            .map(|byte| match byte {
                0x80..=0x9f => CP1252_HIGH[(byte - 0x80) as usize],
                other => *other as char,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a `getserversResponse` datagram the way a master server does.
    fn master_datagram(servers: &[(&str, u16)], with_eot: bool) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(&OOB_HEADER);
        packet.extend_from_slice(b"getserversResponse");
        for (ip, port) in servers {
            let octets: Ipv4Addr = ip.parse().unwrap();
            packet.push(b'\\');
            packet.extend_from_slice(&octets.octets());
            packet.extend_from_slice(&port.to_be_bytes());
        }
        if with_eot {
            packet.extend_from_slice(b"\\EOT\0\0\0");
        }
        packet
    }

    #[test]
    fn reads_every_record_of_a_master_datagram() {
        let packet = master_datagram(
            &[
                ("192.168.1.10", 29070),
                ("8.8.8.8", 29071),
                ("81.19.210.136", 29072),
            ],
            true,
        );
        let found = parse_master_response(&packet);
        assert_eq!(
            found,
            vec![
                "192.168.1.10:29070".parse().unwrap(),
                "8.8.8.8:29071".parse().unwrap(),
                "81.19.210.136:29072".parse().unwrap(),
            ]
        );
        assert!(is_master_end(&packet));
    }

    #[test]
    fn drops_the_last_record_of_a_truncated_datagram() {
        let mut packet = master_datagram(&[("1.2.3.4", 29070), ("5.6.7.8", 29070)], true);
        packet.truncate(packet.len() - 10); // eats `\EOT\0\0\0` and three more
        assert_eq!(
            parse_master_response(&packet),
            vec!["1.2.3.4:29070".parse().unwrap()]
        );
        assert!(!is_master_end(&packet));
    }

    #[test]
    fn ignores_a_padding_record() {
        // dpmaster pads with zeroes when a datagram would otherwise be short.
        let packet = master_datagram(&[("0.0.0.0", 0), ("1.2.3.4", 29070)], true);
        assert_eq!(
            parse_master_response(&packet),
            vec!["1.2.3.4:29070".parse().unwrap()]
        );
    }

    #[test]
    fn rejects_a_datagram_that_is_not_a_master_reply() {
        assert!(parse_master_response(b"getserversResponse\\").is_empty());
        assert!(parse_master_response(&oob_packet("infoResponse\n\\a\\b")).is_empty());
        assert!(parse_master_response(&[]).is_empty());
        assert!(parse_master_response(&OOB_HEADER).is_empty());
    }

    #[test]
    fn reads_an_infostring() {
        let info = parse_infostring(
            "\\challenge\\1234\\protocol\\26\\hostname\\^1Test ^7Server\\clients\\3\\needpass\\0",
        );
        assert_eq!(info["hostname"], "^1Test ^7Server");
        assert_eq!(info["clients"], "3");
        assert_eq!(info["protocol"], "26");
        assert_eq!(info.len(), 5);
    }

    #[test]
    fn survives_a_broken_infostring() {
        assert!(parse_infostring("").is_empty());
        assert!(parse_infostring("\\").is_empty());
        // A key with no value ends the string instead of inventing one.
        let info = parse_infostring("\\map\\mp/ffa3\\dangling");
        assert_eq!(info.len(), 1);
        assert_eq!(info["map"], "mp/ffa3");
    }

    #[test]
    fn lowercases_keys_like_the_engine() {
        let info = parse_infostring("\\HostName\\Blue\\SV_MaxClients\\32");
        assert_eq!(info["hostname"], "Blue");
        assert_eq!(info["sv_maxclients"], "32");
    }

    #[test]
    fn strips_color_codes() {
        assert_eq!(strip_colors("^1Red ^7White"), "Red White");
        assert_eq!(strip_colors("^0^1^2^3^4^5^6^7^8^9"), "");
        assert_eq!(strip_colors("plain"), "plain");
        assert_eq!(strip_colors(""), "");
    }

    #[test]
    fn keeps_what_is_not_a_color_code() {
        // `^` is outside `0`..`9`, so `^^` is not a code and the first caret
        // is drawn. The engine then re-tests from the second caret, where
        // `^1` is a code after all — hence `^x` and not `^^1x`.
        assert_eq!(strip_colors("^^1x"), "^x");
        assert_eq!(strip_colors("2^2 vs ^a b^"), "2 vs ^a b^");
        assert_eq!(strip_colors("^"), "^");
    }

    #[test]
    fn maps_every_gametype_of_the_enum() {
        assert_eq!(gametype_label(0), "FFA");
        assert_eq!(gametype_label(3), "Duel");
        assert_eq!(gametype_label(4), "Power Duel");
        assert_eq!(gametype_label(6), "Team FFA");
        assert_eq!(gametype_label(7), "Siege");
        assert_eq!(gametype_label(9), "CTY");
        assert_eq!(gametype_label(10), "Mode 10");
        assert_eq!(gametype_label(200), "Mode 200");
    }

    #[test]
    fn reads_a_player_list() {
        let players = parse_status_players("12 45 \"Kyle\"\n0 999 \"^1Bot\"\n-3 8 \"a b  c\"\n");
        assert_eq!(players.len(), 3);
        assert_eq!(players[0].name_raw, "Kyle");
        assert_eq!(players[0].score, 12);
        assert_eq!(players[0].ping, 45);
        assert_eq!(players[1].name_raw, "^1Bot");
        assert_eq!(players[2].name_raw, "a b  c");
        assert_eq!(players[2].score, -3);
    }

    #[test]
    fn reads_a_name_that_contains_a_quote() {
        // The engine prints the name unescaped, so the outermost quotes win.
        let players = parse_status_players("5 30 \"he\"llo\"\n");
        assert_eq!(players.len(), 1);
        assert_eq!(players[0].name_raw, "he\"llo");
    }

    #[test]
    fn skips_lines_that_are_not_players() {
        let players = parse_status_players("\n\\sv_hostname\\Blue\\g_gametype\\0\nnot a player\n");
        assert!(players.is_empty());
    }

    #[test]
    fn a_player_with_zero_ping_is_a_bot() {
        let players = parse_status_players(
            "12 45 \"Kyle\"\n5 0 \"Reborn\"\n0 999 \"Connecting\"\n7 1 \"Lag free\"\n",
        );
        let flags: Vec<bool> = players.iter().map(StatusPlayer::is_bot).collect();
        // 999 is what a client gets before it is in the game, not a bot; 1 ms
        // is what a player on the same LAN as the server gets.
        assert_eq!(flags, vec![false, true, false, false]);
    }

    #[test]
    fn counts_humans_and_bots_of_a_player_list() {
        let players = parse_status_players("1 30 \"a\"\n2 0 \"b\"\n3 0 \"c\"\n4 120 \"d\"\n");
        assert_eq!(count_humans_and_bots(&players), (2, 2));
    }

    #[test]
    fn counts_the_edges_of_a_player_list() {
        assert_eq!(count_humans_and_bots(&[]), (0, 0));
        let all_bots = parse_status_players("0 0 \"b1\"\n0 0 \"b2\"\n0 0 \"b3\"\n");
        assert_eq!(count_humans_and_bots(&all_bots), (0, 3));
        let all_humans = parse_status_players("0 24 \"h1\"\n0 500 \"h2\"\n");
        assert_eq!(count_humans_and_bots(&all_humans), (2, 0));
    }

    #[test]
    fn a_negative_ping_is_not_a_bot() {
        // No engine writes one, but a mod that does must not turn a player
        // into a bot by accident: the rule is equality with zero, not a range.
        let players = parse_status_players("0 -5 \"weird\"\n");
        assert!(!players[0].is_bot());
    }

    #[test]
    fn splits_a_command_from_its_argument() {
        assert_eq!(split_command(b"infoResponse\n\\a\\b").0, b"infoResponse");
        assert_eq!(split_command(b"infoResponse\n\\a\\b").1, b"\\a\\b");
        assert_eq!(split_command(b"getserversResponse\\x").0, b"getserversResponse");
        assert_eq!(split_command(b"getstatus").0, b"getstatus");
        assert_eq!(split_command(b"getstatus").1, b"");
    }

    #[test]
    fn decodes_utf8_and_falls_back_to_the_code_page() {
        assert_eq!(decode_bytes("Привет".as_bytes()), "Привет");
        assert_eq!(decode_bytes(b"plain"), "plain");
        // 0xE9 is `é` in Latin-1 and invalid on its own in UTF-8.
        assert_eq!(decode_bytes(&[b'c', b'a', b'f', 0xe9]), "café");
        // 0x93 and 0x94 are the curly quotes of Windows-1252.
        assert_eq!(decode_bytes(&[0x93, b'x', 0x94, 0xe9]), "“x”é");
        assert_eq!(decode_bytes(&[]), "");
    }

    #[test]
    fn writes_a_request_without_a_trailing_nul() {
        let packet = oob_packet("getservers 26");
        assert_eq!(packet.len(), 4 + 13);
        assert_eq!(&packet[..4], &OOB_HEADER);
        assert_eq!(oob_payload(&packet), Some(&b"getservers 26"[..]));
        assert_eq!(oob_payload(b"getservers 26"), None);
    }
}
