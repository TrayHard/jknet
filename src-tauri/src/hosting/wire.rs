//! The messages between the tunnel of a private server and a relay node.
//!
//! Every message starts with the same 14-byte header and, except for `PING`
//! and `PONG`, ends with an 8-byte signature. All integers are unsigned and
//! big-endian.
//!
//! ```text
//! offset size field
//! 0      3    magic       4A 4B 52, "JKR"
//! 3      1    version     01
//! 4      1    type        the code of the message
//! 5      1    flags       00 on the way out, not checked on the way in
//! 6      8    session_id  u64; 0 in PING and PONG
//! 14     n    body
//! 14+n   8    signature   HMAC-SHA256(host_key, bytes[0 .. 14+n]), first 8 bytes
//! ```
//!
//! | Code | Message | Sender | Body |
//! | --- | --- | --- | --- |
//! | `01` | `HELLO` | host | `nonce` u64, `prev_port` u16, `ticket_len` u16, `ticket` |
//! | `02` | `HELLO_ACK` | node | `nonce` u64, `public_ipv4` 4 bytes, `public_port` u16, `expires_at` u64, `keepalive_secs` u16, `max_guests` u16 |
//! | `03` | `KEEPALIVE` | host | `nonce` u64 |
//! | `04` | `KEEPALIVE_ACK` | node | `nonce` u64, `guests` u16, `expires_at` u64 |
//! | `05` | `REHELLO` | node | empty |
//! | `10` | `DATA` | both | `guest_id` u16, `payload` |
//! | `11` | `GUEST_CLOSE` | both | `guest_id` u16, `reason` u8 |
//! | `20` | `CLOSE` | both | `reason` u8 |
//! | `30` | `PING` | anyone | `nonce` u64, zeros up to 64 bytes in all; unsigned |
//! | `31` | `PONG` | node | `nonce` u64, `load` u8, `node_id_len` u8, `node_id`; unsigned |
//! | `3F` | `ERROR` | node | `code` u8, signed with the key the ticket derives |
//!
//! The source of truth is the section «Протокол ретранслятора» of the plan
//! of TASK-41 in the workspace. `tests/fixtures/relay-vectors.json` holds byte
//! strings computed outside this code; the tests below read them.
//!
//! Nothing here touches a socket: bytes in, messages out.

use std::net::Ipv4Addr;

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// `JKR`.
pub const MAGIC: [u8; 3] = *b"JKR";
/// The one version of the protocol.
pub const VERSION: u8 = 1;
/// Magic, version, type, flags and session id.
pub const HEADER_LEN: usize = 14;
/// The first 8 bytes of the HMAC.
pub const SIGNATURE_LEN: usize = 8;
/// The host key the service hands out: 16 bytes.
pub const KEY_LEN: usize = 16;
/// Length of a `PING`, and the most a `PONG` may take.
pub const PING_LEN: usize = 64;
/// The longest datagram a guest may send: the engine never sends more than
/// `MAX_PACKETLEN` (`codemp/qcommon/net_chan.cpp:50`).
pub const MAX_GUEST_PACKET: usize = 1400;
/// The longest answer of the server the tunnel forwards: a `statusResponse` is
/// not fragmented and may pass 1400 bytes.
pub const MAX_HOST_PAYLOAD: usize = 4096;

/// The 16-byte secret of one relay session.
pub type HostKey = [u8; KEY_LEN];

type HmacSha256 = Hmac<Sha256>;

/// Why `GUEST_CLOSE` closed a guest.
///
/// The tunnel sends the first two. It closes a guest whatever reason the node
/// gives, so the other two are the table of the protocol and nothing reads
/// them outside the tests.
pub mod guest_close {
    /// The guest fell silent.
    pub const SILENT: u8 = 1;
    /// A limit of the session.
    pub const LIMIT: u8 = 2;
    /// The host closed the guest.
    #[allow(dead_code)]
    pub const BY_HOST: u8 = 3;
    /// The session is closing.
    #[allow(dead_code)]
    pub const SESSION_CLOSING: u8 = 4;
}

/// Why `CLOSE` closed a session.
pub mod close {
    /// The host stopped the server.
    pub const HOST_STOPPED: u8 = 1;
    /// The ticket ran out.
    pub const EXPIRED: u8 = 2;
    /// The host went silent.
    pub const HOST_LOST: u8 = 3;
    /// The node is shutting down.
    pub const NODE_SHUTDOWN: u8 = 4;
    /// An administrator closed it.
    pub const ADMIN: u8 = 5;
}

/// What an `ERROR` says.
pub mod error_code {
    /// The ticket ran out.
    pub const TICKET_EXPIRED: u8 = 1;
    /// The node has no free port.
    pub const NO_FREE_PORT: u8 = 2;
    /// The session is closed.
    pub const SESSION_CLOSED: u8 = 3;
    /// The ticket was issued for another node.
    pub const WRONG_NODE: u8 = 4;
}

/// One message of the protocol, without its header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Hello {
        nonce: u64,
        /// The port the session held before, `0` for none.
        prev_port: u16,
        ticket: Vec<u8>,
    },
    HelloAck {
        nonce: u64,
        public_ip: Ipv4Addr,
        public_port: u16,
        /// Unix seconds.
        expires_at: u64,
        keepalive_secs: u16,
        max_guests: u16,
    },
    Keepalive {
        nonce: u64,
    },
    KeepaliveAck {
        nonce: u64,
        guests: u16,
        expires_at: u64,
    },
    Rehello,
    Data {
        guest_id: u16,
        payload: Vec<u8>,
    },
    GuestClose {
        guest_id: u16,
        reason: u8,
    },
    Close {
        reason: u8,
    },
    Ping {
        nonce: u64,
    },
    Pong {
        nonce: u64,
        /// 0–100.
        load: u8,
        node_id: String,
    },
    Error {
        code: u8,
    },
}

impl Message {
    /// The `type` byte of the header.
    pub fn code(&self) -> u8 {
        match self {
            Message::Hello { .. } => 0x01,
            Message::HelloAck { .. } => 0x02,
            Message::Keepalive { .. } => 0x03,
            Message::KeepaliveAck { .. } => 0x04,
            Message::Rehello => 0x05,
            Message::Data { .. } => 0x10,
            Message::GuestClose { .. } => 0x11,
            Message::Close { .. } => 0x20,
            Message::Ping { .. } => 0x30,
            Message::Pong { .. } => 0x31,
            Message::Error { .. } => 0x3f,
        }
    }

    /// Whether the message carries a signature: all but the two that anyone
    /// may exchange with a node to measure it.
    pub fn is_signed(&self) -> bool {
        !matches!(self, Message::Ping { .. } | Message::Pong { .. })
    }
}

/// Why a datagram is not a message this side accepts.
///
/// The tunnel drops every one of these without a word, as the protocol
/// demands of both ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    /// Shorter than a header, or than the body its type needs.
    Short,
    /// Not `JKR`.
    Magic,
    /// A version this build does not speak.
    Version,
    /// A type code the protocol does not have.
    Type(u8),
    /// The body is longer or shorter than its fields say.
    Length,
    /// The signature does not match the key.
    Signature,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::Short => f.write_str("the datagram is too short"),
            WireError::Magic => f.write_str("the datagram is not a relay message"),
            WireError::Version => f.write_str("the relay message has another version"),
            WireError::Type(code) => write!(f, "the relay message type {code:#04x} is unknown"),
            WireError::Length => f.write_str("the relay message has the wrong length"),
            WireError::Signature => f.write_str("the relay message has a wrong signature"),
        }
    }
}

/// The signature of `bytes` under `key`: the first 8 bytes of the HMAC.
fn sign(key: &HostKey, bytes: &[u8]) -> [u8; SIGNATURE_LEN] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(bytes);
    let tag = mac.finalize().into_bytes();
    let mut out = [0u8; SIGNATURE_LEN];
    out.copy_from_slice(&tag[..SIGNATURE_LEN]);
    out
}

/// Whether `signature` is the signature of `bytes`, compared in constant time.
fn verify(key: &HostKey, bytes: &[u8], signature: &[u8]) -> bool {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(bytes);
    mac.verify_truncated_left(signature).is_ok()
}

/// Builds the datagram of one message.
///
/// `PING` and `PONG` carry session `0` and no signature whatever is passed.
/// A `DATA` payload longer than [`MAX_HOST_PAYLOAD`] is the caller's bug; the
/// tunnel checks it before it gets here.
pub fn encode(message: &Message, session_id: u64, key: &HostKey) -> Vec<u8> {
    let session_id = if message.is_signed() { session_id } else { 0 };
    let mut out = Vec::with_capacity(HEADER_LEN + 32);
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(message.code());
    out.push(0);
    out.extend_from_slice(&session_id.to_be_bytes());

    match message {
        Message::Hello { nonce, prev_port, ticket } => {
            out.extend_from_slice(&nonce.to_be_bytes());
            out.extend_from_slice(&prev_port.to_be_bytes());
            let len = u16::try_from(ticket.len()).unwrap_or(u16::MAX);
            out.extend_from_slice(&len.to_be_bytes());
            out.extend_from_slice(&ticket[..usize::from(len)]);
        }
        Message::HelloAck { nonce, public_ip, public_port, expires_at, keepalive_secs, max_guests } => {
            out.extend_from_slice(&nonce.to_be_bytes());
            out.extend_from_slice(&public_ip.octets());
            out.extend_from_slice(&public_port.to_be_bytes());
            out.extend_from_slice(&expires_at.to_be_bytes());
            out.extend_from_slice(&keepalive_secs.to_be_bytes());
            out.extend_from_slice(&max_guests.to_be_bytes());
        }
        Message::Keepalive { nonce } => out.extend_from_slice(&nonce.to_be_bytes()),
        Message::KeepaliveAck { nonce, guests, expires_at } => {
            out.extend_from_slice(&nonce.to_be_bytes());
            out.extend_from_slice(&guests.to_be_bytes());
            out.extend_from_slice(&expires_at.to_be_bytes());
        }
        Message::Rehello => {}
        Message::Data { guest_id, payload } => {
            out.extend_from_slice(&guest_id.to_be_bytes());
            out.extend_from_slice(payload);
        }
        Message::GuestClose { guest_id, reason } => {
            out.extend_from_slice(&guest_id.to_be_bytes());
            out.push(*reason);
        }
        Message::Close { reason } => out.push(*reason),
        Message::Ping { nonce } => {
            out.extend_from_slice(&nonce.to_be_bytes());
            out.resize(PING_LEN, 0);
        }
        Message::Pong { nonce, load, node_id } => {
            out.extend_from_slice(&nonce.to_be_bytes());
            out.push(*load);
            let id = &node_id.as_bytes()[..node_id.len().min(32)];
            out.push(id.len() as u8);
            out.extend_from_slice(id);
        }
        Message::Error { code } => out.push(*code),
    }

    if message.is_signed() {
        let signature = sign(key, &out);
        out.extend_from_slice(&signature);
    }
    out
}

/// The session id in the header of a datagram, without checking anything
/// else. `None` for something shorter than a header.
pub fn peek_session(bytes: &[u8]) -> Option<u64> {
    let raw: [u8; 8] = bytes.get(6..HEADER_LEN)?.try_into().ok()?;
    Some(u64::from_be_bytes(raw))
}

/// Reads one datagram: header, body and, for a signed type, the signature
/// under `key`. Answers the session id of the header with the message.
pub fn decode(bytes: &[u8], key: &HostKey) -> Result<(u64, Message), WireError> {
    if bytes.len() < HEADER_LEN {
        return Err(WireError::Short);
    }
    if bytes[..3] != MAGIC {
        return Err(WireError::Magic);
    }
    if bytes[3] != VERSION {
        return Err(WireError::Version);
    }
    let code = bytes[4];
    let session_id = peek_session(bytes).ok_or(WireError::Short)?;
    let signed = !matches!(code, 0x30 | 0x31);

    let body = if signed {
        if bytes.len() < HEADER_LEN + SIGNATURE_LEN {
            return Err(WireError::Short);
        }
        let (signed_part, signature) = bytes.split_at(bytes.len() - SIGNATURE_LEN);
        if !verify(key, signed_part, signature) {
            return Err(WireError::Signature);
        }
        &signed_part[HEADER_LEN..]
    } else {
        &bytes[HEADER_LEN..]
    };

    let mut reader = Reader { bytes: body, at: 0 };
    let message = match code {
        0x01 => {
            let nonce = reader.u64()?;
            let prev_port = reader.u16()?;
            let len = usize::from(reader.u16()?);
            let ticket = reader.take(len)?.to_vec();
            reader.end()?;
            Message::Hello { nonce, prev_port, ticket }
        }
        0x02 => {
            let nonce = reader.u64()?;
            let ip = reader.take(4)?;
            let public_ip = Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]);
            let public_port = reader.u16()?;
            let expires_at = reader.u64()?;
            let keepalive_secs = reader.u16()?;
            let max_guests = reader.u16()?;
            reader.end()?;
            Message::HelloAck { nonce, public_ip, public_port, expires_at, keepalive_secs, max_guests }
        }
        0x03 => {
            let nonce = reader.u64()?;
            reader.end()?;
            Message::Keepalive { nonce }
        }
        0x04 => {
            let nonce = reader.u64()?;
            let guests = reader.u16()?;
            let expires_at = reader.u64()?;
            reader.end()?;
            Message::KeepaliveAck { nonce, guests, expires_at }
        }
        0x05 => {
            reader.end()?;
            Message::Rehello
        }
        0x10 => {
            let guest_id = reader.u16()?;
            let payload = reader.rest().to_vec();
            Message::Data { guest_id, payload }
        }
        0x11 => {
            let guest_id = reader.u16()?;
            let reason = reader.u8()?;
            reader.end()?;
            Message::GuestClose { guest_id, reason }
        }
        0x20 => {
            let reason = reader.u8()?;
            reader.end()?;
            Message::Close { reason }
        }
        0x30 => {
            if bytes.len() != PING_LEN {
                return Err(WireError::Length);
            }
            Message::Ping { nonce: reader.u64()? }
        }
        0x31 => {
            let nonce = reader.u64()?;
            let load = reader.u8()?;
            let len = usize::from(reader.u8()?);
            let node_id = String::from_utf8_lossy(reader.take(len)?).into_owned();
            reader.end()?;
            Message::Pong { nonce, load, node_id }
        }
        0x3f => {
            let code = reader.u8()?;
            reader.end()?;
            Message::Error { code }
        }
        other => return Err(WireError::Type(other)),
    };
    Ok((session_id, message))
}

/// A cursor over a body.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], WireError> {
        let end = self.at.checked_add(len).ok_or(WireError::Length)?;
        let slice = self.bytes.get(self.at..end).ok_or(WireError::Short)?;
        self.at = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, WireError> {
        let raw: [u8; 2] = self.take(2)?.try_into().map_err(|_| WireError::Short)?;
        Ok(u16::from_be_bytes(raw))
    }

    fn u64(&mut self) -> Result<u64, WireError> {
        let raw: [u8; 8] = self.take(8)?.try_into().map_err(|_| WireError::Short)?;
        Ok(u64::from_be_bytes(raw))
    }

    fn rest(&mut self) -> &'a [u8] {
        let rest = &self.bytes[self.at..];
        self.at = self.bytes.len();
        rest
    }

    /// Refuses trailing bytes: a message is exactly as long as its fields.
    fn end(&self) -> Result<(), WireError> {
        if self.at == self.bytes.len() {
            Ok(())
        } else {
            Err(WireError::Length)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vectors both sides of the relay check themselves against: the
    /// file of `jknet-online/tests/fixtures/relay-vectors.json`, copied as it
    /// is. The service writes it from its own encoder; this side builds every
    /// message from the fields alone and must land on the same bytes.
    const VECTORS: &str = include_str!("../../tests/fixtures/relay-vectors.json");

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
            .collect()
    }

    fn doc() -> serde_json::Value {
        serde_json::from_str(VECTORS).expect("the fixture parses")
    }

    fn fixture() -> (HostKey, u64, Vec<serde_json::Value>) {
        let doc = doc();
        let key: HostKey = hex(doc["hostKey"]["hex"].as_str().expect("hostKey.hex"))
            .try_into()
            .expect("16 bytes");
        let session = u64::from_str_radix(doc["hostKey"]["sessionId"].as_str().expect("sessionId"), 16)
            .expect("a u64");
        let vectors = doc["messages"].as_array().expect("messages").clone();
        (key, session, vectors)
    }

    fn number(value: &serde_json::Value) -> u64 {
        match value {
            serde_json::Value::String(text) => text.parse().expect("a decimal u64"),
            other => other.as_u64().expect("a number"),
        }
    }

    /// The message a vector describes, built from its fields alone.
    fn message_of(vector: &serde_json::Value) -> Message {
        let fields = &vector["fields"];
        match vector["name"].as_str().expect("name") {
            "HELLO" => Message::Hello {
                nonce: number(&fields["nonce"]),
                prev_port: number(&fields["prevPort"]) as u16,
                ticket: hex(fields["ticket"].as_str().expect("ticket")),
            },
            "HELLO_ACK" => Message::HelloAck {
                nonce: number(&fields["nonce"]),
                public_ip: fields["publicIpv4"].as_str().expect("ip").parse().expect("an IPv4"),
                public_port: number(&fields["publicPort"]) as u16,
                expires_at: number(&fields["expiresAt"]),
                keepalive_secs: number(&fields["keepaliveSecs"]) as u16,
                max_guests: number(&fields["maxGuests"]) as u16,
            },
            "KEEPALIVE" => Message::Keepalive { nonce: number(&fields["nonce"]) },
            "KEEPALIVE_ACK" => Message::KeepaliveAck {
                nonce: number(&fields["nonce"]),
                guests: number(&fields["guests"]) as u16,
                expires_at: number(&fields["expiresAt"]),
            },
            "REHELLO" => Message::Rehello,
            "DATA" => Message::Data {
                guest_id: number(&fields["guestId"]) as u16,
                payload: hex(fields["payload"].as_str().expect("payload")),
            },
            "GUEST_CLOSE" => Message::GuestClose {
                guest_id: number(&fields["guestId"]) as u16,
                reason: number(&fields["reason"]) as u8,
            },
            "CLOSE" => Message::Close { reason: number(&fields["reason"]) as u8 },
            "ERROR" => Message::Error { code: number(&fields["code"]) as u8 },
            "PING" => Message::Ping { nonce: number(&fields["nonce"]) },
            "PONG" => Message::Pong {
                nonce: number(&fields["nonce"]),
                load: number(&fields["load"]) as u8,
                node_id: String::from_utf8(hex(fields["nodeId"].as_str().expect("nodeId")))
                    .expect("an ASCII node id"),
            },
            other => panic!("unknown vector type {other}"),
        }
    }

    #[test]
    fn every_message_encodes_to_the_bytes_of_the_shared_vectors() {
        let (key, session, vectors) = fixture();
        let names: std::collections::BTreeSet<&str> =
            vectors.iter().filter_map(|vector| vector["name"].as_str()).collect();
        assert_eq!(names.len(), 11, "every message type has a vector: {names:?}");
        for vector in &vectors {
            let expected = hex(vector["hex"].as_str().expect("hex"));
            let message = message_of(vector);
            assert_eq!(u64::from(message.code()), number(&vector["type"]), "{}", vector["name"]);
            assert_eq!(message.is_signed(), vector["signed"] == true, "{}", vector["name"]);
            assert_eq!(
                encode(&message, session, &key),
                expected,
                "{}",
                vector["name"]
            );
            let (decoded_session, decoded) = decode(&expected, &key).expect("the vector decodes");
            assert_eq!(decoded, message, "{}", vector["name"]);
            let expected_session = u64::from_str_radix(vector["sessionId"].as_str().expect("sessionId"), 16)
                .expect("a u64");
            assert_eq!(decoded_session, expected_session, "{}", vector["name"]);
            let expected_session = if message.is_signed() { session } else { 0 };
            assert_eq!(decoded_session, expected_session, "{}", vector["name"]);
        }
    }

    #[test]
    fn every_datagram_the_shared_vectors_reject_is_refused() {
        let (key, _, _) = fixture();
        let rejected = doc()["rejected"].as_array().expect("rejected").clone();
        assert!(!rejected.is_empty());
        for vector in rejected {
            let bytes = hex(vector["hex"].as_str().expect("hex"));
            assert!(decode(&bytes, &key).is_err(), "{}", vector["why"]);
        }
    }

    #[test]
    fn the_ticket_of_the_api_decodes_to_the_bytes_the_node_checks() {
        use base64::Engine as _;
        let doc = doc();
        let ticket = &doc["ticket"];
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(ticket["base64url"].as_str().expect("base64url"))
            .expect("unpadded base64url");
        assert_eq!(decoded, hex(ticket["hex"].as_str().expect("hex")));
        // The session id sits at offset 2, which is where the tunnel reads it
        // when the API spells it some other way.
        let session: [u8; 8] = decoded[2..10].try_into().unwrap();
        assert_eq!(
            format!("{:016x}", u64::from_be_bytes(session)),
            doc["hostKey"]["sessionId"].as_str().unwrap()
        );
        let key = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(doc["hostKey"]["base64url"].as_str().expect("base64url"))
            .expect("unpadded base64url");
        assert_eq!(key, hex(doc["hostKey"]["hex"].as_str().unwrap()));
        assert_eq!(key.len(), KEY_LEN);
    }

    #[test]
    fn a_broken_signature_or_another_key_is_refused() {
        let (key, session, _) = fixture();
        let bytes = encode(&Message::Keepalive { nonce: 7 }, session, &key);

        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(decode(&tampered, &key), Err(WireError::Signature));

        // A changed body with the old signature.
        let mut body = bytes.clone();
        body[HEADER_LEN] ^= 0x80;
        assert_eq!(decode(&body, &key), Err(WireError::Signature));

        let other: HostKey = [7; KEY_LEN];
        assert_eq!(decode(&bytes, &other), Err(WireError::Signature));
        // The session id is covered as well: a message cannot be moved to
        // another session.
        let mut moved = bytes;
        moved[13] ^= 1;
        assert_eq!(decode(&moved, &key), Err(WireError::Signature));
    }

    #[test]
    fn a_datagram_that_is_not_a_message_is_refused_before_the_signature() {
        let key: HostKey = [1; KEY_LEN];
        assert_eq!(decode(b"JKR", &key), Err(WireError::Short));
        assert_eq!(decode(&[0xff; 30], &key), Err(WireError::Magic));
        // A game packet that reached the control port by mistake.
        let mut oob = vec![0xff, 0xff, 0xff, 0xff];
        oob.extend_from_slice(b"getinfo xxx");
        assert_eq!(decode(&oob, &key), Err(WireError::Magic));

        let mut version = encode(&Message::Rehello, 1, &key);
        version[3] = 2;
        assert_eq!(decode(&version, &key), Err(WireError::Version));

        // An unknown type with a valid signature over it.
        let mut unknown = encode(&Message::Rehello, 1, &key);
        unknown.truncate(HEADER_LEN);
        unknown[4] = 0x7e;
        let signature = sign(&key, &unknown);
        unknown.extend_from_slice(&signature);
        assert_eq!(decode(&unknown, &key), Err(WireError::Type(0x7e)));
    }

    #[test]
    fn a_body_of_the_wrong_length_is_refused_even_when_signed() {
        let key: HostKey = [3; KEY_LEN];
        // A KEEPALIVE with one byte too many, signed correctly.
        let mut long = encode(&Message::Keepalive { nonce: 1 }, 5, &key);
        long.truncate(long.len() - SIGNATURE_LEN);
        long.push(0);
        let signature = sign(&key, &long);
        long.extend_from_slice(&signature);
        assert_eq!(decode(&long, &key), Err(WireError::Length));

        // A HELLO whose ticket length claims more than it carries.
        let mut short = encode(
            &Message::Hello { nonce: 1, prev_port: 0, ticket: vec![1, 2, 3] },
            5,
            &key,
        );
        short.truncate(short.len() - SIGNATURE_LEN);
        short[HEADER_LEN + 10..HEADER_LEN + 12].copy_from_slice(&9u16.to_be_bytes());
        let signature = sign(&key, &short);
        short.extend_from_slice(&signature);
        assert_eq!(decode(&short, &key), Err(WireError::Short));

        // A PING is exactly 64 bytes.
        let mut ping = encode(&Message::Ping { nonce: 1 }, 0, &key);
        assert_eq!(ping.len(), PING_LEN);
        ping.pop();
        assert_eq!(decode(&ping, &key), Err(WireError::Length));
    }

    #[test]
    fn the_overhead_of_data_is_24_bytes_so_a_full_guest_packet_fits_one_datagram() {
        let key: HostKey = [9; KEY_LEN];
        let data = encode(
            &Message::Data { guest_id: 1, payload: vec![0; MAX_GUEST_PACKET] },
            1,
            &key,
        );
        assert_eq!(data.len(), MAX_GUEST_PACKET + 24);
        // 1472 bytes of UDP payload fit an Ethernet MTU of 1500.
        assert!(data.len() <= 1472);
    }

    #[test]
    fn ping_and_pong_are_unsigned_and_a_pong_is_never_longer_than_a_ping() {
        let key: HostKey = [0; KEY_LEN];
        let other: HostKey = [1; KEY_LEN];
        let pong = encode(
            &Message::Pong { nonce: 1, load: 50, node_id: "x".repeat(40) },
            99,
            &key,
        );
        assert!(pong.len() <= PING_LEN);
        // Any key reads them, and their session is 0.
        let (session, message) = decode(&pong, &other).expect("unsigned");
        assert_eq!(session, 0);
        assert!(matches!(message, Message::Pong { ref node_id, .. } if node_id.len() == 32));
    }
}
