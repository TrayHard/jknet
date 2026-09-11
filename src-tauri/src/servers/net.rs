//! UDP transport for the master and per-server queries.
//!
//! Every query gets its own socket bound to `0.0.0.0:0` and `connect`ed to the
//! peer, so the kernel drops datagrams from anybody else and a spoofed reply
//! never reaches the parser. IPv4 only: Jedi Academy 1.01 has no IPv6 stack,
//! and the master's record format has no room for a longer address.
//!
//! Nothing here retries forever. Each function takes a time budget and returns
//! whatever it collected when the budget runs out, because a browser that
//! waits for the slowest server on the internet is a browser nobody uses.

use std::collections::BTreeMap;
use std::net::SocketAddrV4;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::net::UdpSocket;
use tokio::time::timeout;

use crate::error::{AppError, Result};
use crate::servers::protocol::{
    self, oob_packet, oob_payload, parse_infostring, split_command, MASTER_PORT,
};

/// Largest datagram the launcher accepts. A master reply is a few kilobytes;
/// the rest of the buffer only exists so a hostile packet cannot be truncated
/// into something that parses differently.
const MAX_DATAGRAM: usize = 65_535;

/// Counter that keeps two challenges apart inside the same millisecond.
static CHALLENGE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Returns a token the server echoes back in its reply.
///
/// The engine copies `getinfo`'s argument into the `challenge` key of the
/// answer, which is how a late reply from a previous refresh is told apart
/// from the one this request is waiting for. The value only has to be
/// unguessable within a session, so the clock plus a counter is enough — no
/// random number generator, no extra crate.
fn next_challenge() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let count = CHALLENGE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}", nanos.rotate_left(17) ^ count.wrapping_mul(0x9e37_79b9_7f4a_7c15))
}

/// Opens a socket bound to an ephemeral IPv4 port and points it at `peer`.
async fn connected_socket(peer: SocketAddrV4) -> Result<UdpSocket> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| AppError::Network(format!("cannot open a UDP socket: {e}")))?;
    socket
        .connect(peer)
        .await
        .map_err(|e| AppError::Network(format!("cannot reach {peer}: {e}")))?;
    Ok(socket)
}

/// Resolves `masterjk3.ravensoft.com` or `1.2.3.4:29060` to one IPv4 endpoint.
///
/// A name with no port gets `PORT_MASTER`. A name that resolves only to IPv6
/// is an error rather than a silent skip: the player should learn that the
/// master is unreachable on this network.
pub async fn resolve_master(master: &str) -> Result<SocketAddrV4> {
    let master = master.trim();
    if master.is_empty() {
        return Err(AppError::InvalidInput("master server address is empty".into()));
    }
    let with_port = if master.contains(':') {
        master.to_string()
    } else {
        format!("{master}:{MASTER_PORT}")
    };

    let mut resolved = tokio::net::lookup_host(&with_port)
        .await
        .map_err(|e| AppError::Network(format!("cannot resolve {master}: {e}")))?;
    resolved
        .find_map(|addr| match addr {
            std::net::SocketAddr::V4(v4) => Some(v4),
            std::net::SocketAddr::V6(_) => None,
        })
        .ok_or_else(|| AppError::Network(format!("{master} has no IPv4 address")))
}

// --- slice: servers robustness ---
/// One answered `getservers`.
pub struct MasterReply {
    /// Every address the datagrams carried, in the order they arrived.
    pub addresses: Vec<SocketAddrV4>,
    /// True when the `\EOT` marker closed the list.
    ///
    /// False means the budget ran out first, so the list is whatever arrived
    /// before it did — a truncated answer that looks exactly like a short one.
    /// The caller asks again rather than treating it as the whole world.
    pub complete: bool,
}

/// Asks one master server for its address list.
///
/// The reply arrives as one or more datagrams, the last of them carrying the
/// `\EOT` marker. The function stops on that marker or when `budget` expires,
/// whichever comes first, and returns everything it managed to read along with
/// which of the two ended it.
///
/// A master that sends nothing at all is an error, not an empty list. The
/// distinction matters: `masterjk3.ravensoft.com` still resolves but has been
/// silent for years, and a silent master must not be mistaken for one
/// reporting that nobody is playing.
pub async fn query_master(
    master: &str,
    protocol: u16,
    budget: Duration,
) -> Result<MasterReply> {
    let peer = resolve_master(master).await?;
    let socket = connected_socket(peer).await?;
    let request = oob_packet(&format!("getservers {protocol}"));
    socket
        .send(&request)
        .await
        .map_err(|e| AppError::Network(format!("cannot query the master {peer}: {e}")))?;

    let deadline = Instant::now() + budget;
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    let mut found = Vec::new();
    let mut datagrams = 0usize;
    let mut complete = false;

    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let read = match timeout(remaining, socket.recv(&mut buffer)).await {
            Ok(Ok(read)) => read,
            // A timeout is the normal end of a master reply, and an ICMP
            // "port unreachable" surfaces here as an error on the next recv.
            Ok(Err(_)) | Err(_) => break,
        };
        let datagram = &buffer[..read];
        datagrams += 1;
        found.extend(protocol::parse_master_response(datagram));
        if protocol::is_master_end(datagram) {
            complete = true;
            break;
        }
    }

    if datagrams == 0 {
        return Err(AppError::Network(format!("{master} did not answer")));
    }
    Ok(MasterReply {
        addresses: found,
        complete,
    })
}

/// One answered `getinfo`.
pub struct InfoReply {
    /// The raw infostring, already decoded into text.
    pub infostring: String,
    /// Round trip time of the request that was answered.
    pub ping_ms: u32,
}

/// Sends `getinfo` to one server and waits for the matching `infoResponse`.
///
/// `attempts` counts the requests, not the retries, so `2` means one retry.
/// Returns `None` for every failure — an unreachable server is an ordinary
/// outcome of a refresh, not an error the player needs to read.
pub async fn query_info(
    address: SocketAddrV4,
    per_attempt: Duration,
    attempts: u32,
) -> Option<InfoReply> {
    let socket = connected_socket(address).await.ok()?;
    let mut buffer = vec![0u8; MAX_DATAGRAM];

    for _ in 0..attempts.max(1) {
        let challenge = next_challenge();
        let sent_at = Instant::now();
        if socket
            .send(&oob_packet(&format!("getinfo {challenge}")))
            .await
            .is_err()
        {
            return None;
        }

        let deadline = sent_at + per_attempt;
        // Keep reading until the budget runs out: a server may answer an
        // earlier request first, and that datagram must not count as the reply.
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(Ok(read)) = timeout(remaining, socket.recv(&mut buffer)).await else {
                break;
            };
            let elapsed = sent_at.elapsed();
            let Some(payload) = oob_payload(&buffer[..read]) else {
                continue;
            };
            let (command, body) = split_command(payload);
            if command != b"infoResponse" {
                continue;
            }
            let infostring = protocol::decode_bytes(body);
            if parse_infostring(&infostring).get("challenge") != Some(&challenge) {
                continue;
            }
            return Some(InfoReply {
                infostring,
                ping_ms: elapsed.as_millis().min(u128::from(u32::MAX)) as u32,
            });
        }
    }
    None
}

// --- slice: servers browser ---
/// How many times a LAN sweep sends its `getinfo` to every port.
///
/// Two, as `CL_LocalServers_f` does (`codemp/client/cl_main.cpp:3361` in
/// OpenJK `1a6a6434`). A broadcast datagram is the first thing a busy wireless
/// access point drops, and one lost packet would cost the whole sweep.
const BROADCAST_ATTEMPTS: u32 = 2;

/// Broadcasts one `getinfo` and collects whoever answers.
///
/// This is what the engine's **Local** source does: the same out-of-band
/// `getinfo` goes to several consecutive ports of the broadcast address, twice,
/// and every server that hears it answers from its own address. One socket
/// carries the whole sweep — the answers come back to the port the request
/// left from, and `recv_from` names the sender, which is how an address is
/// learned in the first place.
///
/// `targets` is an argument rather than something built here so a test can aim
/// the sweep at four localhost ports and never touch the network. A duplicate
/// answer — the second send reaching a server that already replied — is
/// dropped: the first reply is the one whose round trip was measured.
///
/// Fails only when not a single datagram could be sent, which is a socket the
/// operating system refused rather than a network with no servers on it.
pub async fn scan_lan(
    targets: &[SocketAddrV4],
    budget: Duration,
) -> Result<Vec<(SocketAddrV4, InfoReply)>> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| AppError::Network(format!("cannot open a UDP socket: {e}")))?;
    socket
        .set_broadcast(true)
        .map_err(|e| AppError::Network(format!("cannot broadcast on this socket: {e}")))?;

    // One challenge for the whole sweep: every answer echoes it, so a late
    // datagram from the previous sweep is told apart from this one's.
    let challenge = next_challenge();
    let request = oob_packet(&format!("getinfo {challenge}"));
    let started = Instant::now();
    let mut sent = 0usize;
    for _ in 0..BROADCAST_ATTEMPTS {
        for target in targets {
            match socket.send_to(&request, target).await {
                Ok(_) => sent += 1,
                Err(e) => log::warn!("cannot broadcast to {target}: {e}"),
            }
        }
    }
    if sent == 0 {
        return Err(AppError::Network(
            "the local network scan could not send a single datagram".into(),
        ));
    }

    let deadline = started + budget;
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    let mut found: BTreeMap<SocketAddrV4, InfoReply> = BTreeMap::new();
    let mut errors = 0usize;

    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let (read, from) = match timeout(remaining, socket.recv_from(&mut buffer)).await {
            Ok(Ok(received)) => received,
            // Windows reports an ICMP "port unreachable" as an error on the
            // next read of the socket that sent the datagram, and one socket
            // carries the whole sweep: a port with nothing behind it would
            // otherwise end the scan before the server on the next port
            // answered. Reading on — but not forever, because more errors than
            // datagrams sent means the socket itself is gone.
            Ok(Err(e)) => {
                errors += 1;
                if errors > sent {
                    log::warn!("the local network scan gave up after {errors} socket errors: {e}");
                    break;
                }
                continue;
            }
            // The budget ran out, which is the ordinary end of a sweep.
            Err(_) => break,
        };
        // IPv4 only, like the rest of the module: the socket is bound to
        // `0.0.0.0`, so anything else here would be a surprise.
        let std::net::SocketAddr::V4(from) = from else {
            continue;
        };
        let elapsed = started.elapsed();
        let Some(payload) = oob_payload(&buffer[..read]) else {
            continue;
        };
        let (command, body) = split_command(payload);
        if command != b"infoResponse" {
            continue;
        }
        let infostring = protocol::decode_bytes(body);
        if parse_infostring(&infostring).get("challenge") != Some(&challenge) {
            continue;
        }
        found.entry(from).or_insert(InfoReply {
            infostring,
            ping_ms: elapsed.as_millis().min(u128::from(u32::MAX)) as u32,
        });
    }

    Ok(found.into_iter().collect())
}

/// One answered `getstatus`: the server's own info string and its player list.
pub struct StatusReply {
    pub infostring: String,
    pub players: String,
}

/// Sends `getstatus` to one server and waits for the `statusResponse`.
///
/// The reply is `statusResponse\n<infostring>\n<player lines>`, so the body is
/// split on the first newline. Servers with many players answer in one large
/// datagram; there is no continuation packet to collect.
pub async fn query_status(address: SocketAddrV4, budget: Duration) -> Result<StatusReply> {
    let socket = connected_socket(address).await?;
    let challenge = next_challenge();
    socket
        .send(&oob_packet(&format!("getstatus {challenge}")))
        .await
        .map_err(|e| AppError::Network(format!("cannot query {address}: {e}")))?;

    let deadline = Instant::now() + budget;
    let mut buffer = vec![0u8; MAX_DATAGRAM];

    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let Ok(Ok(read)) = timeout(remaining, socket.recv(&mut buffer)).await else {
            break;
        };
        let Some(payload) = oob_payload(&buffer[..read]) else {
            continue;
        };
        let (command, body) = split_command(payload);
        if command != b"statusResponse" {
            continue;
        }
        let text = protocol::decode_bytes(body);
        let (infostring, players) = match text.split_once('\n') {
            Some((info, rest)) => (info.to_string(), rest.to_string()),
            None => (text, String::new()),
        };
        if parse_infostring(&infostring).get("challenge") != Some(&challenge) {
            continue;
        }
        return Ok(StatusReply {
            infostring,
            players,
        });
    }

    Err(AppError::Network(format!("{address} did not answer")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenges_do_not_repeat() {
        let first = next_challenge();
        let second = next_challenge();
        assert_ne!(first, second);
        assert!(!first.contains(' '));
        assert!(!first.is_empty());
    }

    #[tokio::test]
    async fn an_empty_master_address_is_rejected() {
        assert!(resolve_master("   ").await.is_err());
    }

    #[tokio::test]
    async fn a_literal_address_needs_no_dns() {
        let addr = resolve_master("127.0.0.1").await.unwrap();
        assert_eq!(addr.port(), MASTER_PORT);
        let addr = resolve_master("127.0.0.1:29061").await.unwrap();
        assert_eq!(addr.port(), 29061);
    }

    /// A server that never answers must cost exactly the time budget, not the
    /// operating system's own retry schedule.
    #[tokio::test]
    async fn an_unreachable_server_gives_up_on_time() {
        let started = Instant::now();
        let reply = query_info(
            "127.0.0.1:1".parse().unwrap(),
            Duration::from_millis(120),
            2,
        )
        .await;
        assert!(reply.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// Talks to a socket that answers `getinfo` the way `SVC_Info` does.
    #[tokio::test]
    async fn reads_an_info_reply_and_its_ping() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let address = match server.local_addr().unwrap() {
            std::net::SocketAddr::V4(v4) => v4,
            other => panic!("expected IPv4, got {other}"),
        };

        tokio::spawn(async move {
            let mut buffer = vec![0u8; MAX_DATAGRAM];
            // The first request is answered with a stale challenge, which the
            // client must ignore; the second gets the right one.
            for stale in [true, false] {
                let (read, from) = server.recv_from(&mut buffer).await.unwrap();
                let payload = oob_payload(&buffer[..read]).unwrap();
                let (_, challenge) = split_command(payload);
                let challenge = String::from_utf8_lossy(challenge).to_string();
                let echoed = if stale { "stale".to_string() } else { challenge };
                let reply = oob_packet(&format!(
                    "infoResponse\n\\challenge\\{echoed}\\hostname\\Test\\clients\\2"
                ));
                server.send_to(&reply, from).await.unwrap();
            }
        });

        let reply = query_info(address, Duration::from_millis(250), 2)
            .await
            .expect("the second attempt must be answered");
        let info = parse_infostring(&reply.infostring);
        assert_eq!(info["hostname"], "Test");
        assert_eq!(info["clients"], "2");
        assert!(reply.ping_ms < 250);
    }

    #[tokio::test]
    async fn reads_a_status_reply() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let address = match server.local_addr().unwrap() {
            std::net::SocketAddr::V4(v4) => v4,
            other => panic!("expected IPv4, got {other}"),
        };

        tokio::spawn(async move {
            let mut buffer = vec![0u8; MAX_DATAGRAM];
            let (read, from) = server.recv_from(&mut buffer).await.unwrap();
            let payload = oob_payload(&buffer[..read]).unwrap();
            let (_, challenge) = split_command(payload);
            let challenge = String::from_utf8_lossy(challenge).to_string();
            let reply = oob_packet(&format!(
                "statusResponse\n\\challenge\\{challenge}\\sv_hostname\\Blue\n12 45 \"Kyle\"\n"
            ));
            server.send_to(&reply, from).await.unwrap();
        });

        let reply = query_status(address, Duration::from_millis(800)).await.unwrap();
        assert_eq!(parse_infostring(&reply.infostring)["sv_hostname"], "Blue");
        assert_eq!(protocol::parse_status_players(&reply.players).len(), 1);
    }

    #[tokio::test]
    async fn an_unanswered_status_is_an_error() {
        let reply = query_status("127.0.0.1:1".parse().unwrap(), Duration::from_millis(120)).await;
        assert!(reply.is_err());
    }
}
