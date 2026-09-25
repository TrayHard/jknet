//! The tunnel of a private server: one outgoing UDP flow to the control port
//! of a relay node, and one local socket per guest towards the server.
//!
//! ```text
//! guest ──▶ node:session port ──DATA(guest_id)──▶ tunnel ──▶ 127.77.x.y:any ──▶ 127.0.0.1:server
//! guest ◀── node:session port ◀──DATA(guest_id)── tunnel ◀── 127.77.x.y:any ◀── 127.0.0.1:server
//! ```
//!
//! 1. The tunnel sends `HELLO` with the ticket. Without `HELLO_ACK` it sends
//!    it again after 1, 2 and 4 s and gives up after 10 s.
//! 2. `KEEPALIVE` goes out every 15 s, or at the interval the node asked for.
//!    Two unanswered in a row mean the path is gone: the tunnel opens a new
//!    socket, which is a new mapping in the home router, and sends `HELLO`
//!    with the port it held, which the node restores after a restart. An
//!    answer counts only with the nonce of a message still unanswered — the
//!    last `KEEPALIVE`, a `HELLO` sent since the last `HELLO_ACK` — so acks
//!    replayed on the path neither hide a dead path nor revive one.
//! 3. `REHELLO` from the node gets a `HELLO` at once: the node saw a signed
//!    message from an address it does not know, the host's new one.
//! 4. The first `DATA` of an unknown `guest_id` opens a socket for that guest
//!    on `127.77.<id >> 8>.<id & 0xFF>` and connects it to the server. The
//!    engine counts its out-of-band rate limit per IP, so guests sharing
//!    `127.0.0.1` would share one bucket with the launcher's own polls; if
//!    such an address cannot be bound, `127.0.0.1:0` stands in.
//! 5. A guest socket closes after `GUEST_CLOSE` or 120 s of silence both
//!    ways. At most 16 are open; the node holds the real limit.
//! 6. A renewed ticket goes out in a new `HELLO`. `ERROR` «ticket expired»
//!    asks the session for one: `HELLO` waits until it comes, and the node
//!    refusing the renewed ticket as well ends the tunnel.
//! 7. Closing sends `CLOSE` three times.
//!
//! The ticket and the host key stay in memory: they reach neither the disk nor
//! the log.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::wire::{self, HostKey, Message};

/// The schedule of one tunnel. The defaults are the protocol's; the tests
/// shorten them.
#[derive(Debug, Clone)]
pub struct Timing {
    /// Pauses between the `HELLO`s of one attempt.
    pub hello_retries: Vec<Duration>,
    /// How long an attempt waits for `HELLO_ACK` in all.
    pub hello_budget: Duration,
    /// `KEEPALIVE` interval until the node names its own.
    pub keepalive: Duration,
    /// How often a lost tunnel tries again.
    pub reconnect_every: Duration,
    /// Silence after which a guest socket closes.
    pub guest_idle: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            hello_retries: vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
            ],
            hello_budget: Duration::from_secs(10),
            keepalive: Duration::from_secs(15),
            reconnect_every: Duration::from_secs(5),
            guest_idle: Duration::from_secs(120),
        }
    }
}

/// Where guests get their local addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestBind {
    /// `127.77.x.y`, one address per guest.
    PerGuest,
    /// `127.0.0.1` for everyone: the fallback, and what a test can force.
    Loopback,
}

/// What a tunnel needs to start.
#[derive(Clone)]
pub struct TunnelConfig {
    /// The control port of the node.
    pub control: SocketAddrV4,
    /// The relay session, the `session_id` of every message.
    pub session_id: u64,
    pub key: HostKey,
    pub ticket: Vec<u8>,
    /// The port of the server, when it is already known.
    pub server_port: Option<u16>,
    pub max_guests: usize,
    pub guest_bind: GuestBind,
    pub timing: Timing,
}

impl std::fmt::Debug for TunnelConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelConfig")
            .field("control", &self.control)
            .field("session_id", &format_args!("{:016x}", self.session_id))
            .field("key", &"<redacted>")
            .field("ticket", &"<redacted>")
            .field("server_port", &self.server_port)
            .finish()
    }
}

/// Why a tunnel gave up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelFailure {
    /// No `HELLO_ACK` within the budget.
    NodeSilent,
    /// The node said the ticket ran out.
    Expired,
    /// The node refused the session: no free port, closed, another node.
    Refused,
    /// The local socket could not be opened.
    Socket,
}

/// What the tunnel tells the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelEvent {
    /// `HELLO_ACK`: guests reach the server at `public`.
    Active {
        public: SocketAddrV4,
        expires_at: u64,
        max_guests: u16,
    },
    /// The node counts this many guests.
    Guests(u16),
    /// The node moved the end of the session.
    Expires(u64),
    /// The node refused the ticket as run out. The session asks the service
    /// for a later ticket of the same session and hands it over with
    /// [`TunnelHandle::renew`]; until then the tunnel sends no `HELLO`.
    TicketExpired,
    /// The path to the node is gone; the tunnel keeps trying.
    Lost,
    /// The tunnel stopped for good.
    Failed { failure: TunnelFailure, message: String },
    /// The node closed the session with this `CLOSE` reason.
    Closed { reason: u8 },
}

/// What the session tells the tunnel.
#[derive(Debug)]
enum Command {
    ServerPort(u16),
    Renew(Vec<u8>),
    Close,
}

/// A running tunnel.
pub struct TunnelHandle {
    commands: mpsc::UnboundedSender<Command>,
    task: JoinHandle<()>,
}

impl TunnelHandle {
    /// The server answered on this port: guests go there from now on.
    pub fn set_server_port(&self, port: u16) {
        let _ = self.commands.send(Command::ServerPort(port));
    }

    /// A renewed ticket of the same session.
    pub fn renew(&self, ticket: Vec<u8>) {
        let _ = self.commands.send(Command::Renew(ticket));
    }

    /// Sends `CLOSE` and waits a moment for the tunnel to end.
    pub async fn close(self) {
        let _ = self.commands.send(Command::Close);
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(2), &mut task).await.is_err() {
            task.abort();
        }
    }

    /// Whether the tunnel task has ended.
    #[cfg(test)]
    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
    }
}

/// Starts a tunnel. Events arrive on `events` until it ends.
pub fn spawn(config: TunnelConfig, events: mpsc::UnboundedSender<TunnelEvent>) -> TunnelHandle {
    let (commands, receiver) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(config, events, receiver));
    TunnelHandle { commands, task }
}

/// The phase of the connection to the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Waiting for the first `HELLO_ACK`.
    Connecting,
    Active,
    /// Two keepalives went unanswered; `HELLO` again until it comes back.
    Lost,
}

struct Guest {
    socket: Arc<UdpSocket>,
    last_activity: Instant,
    reader: JoinHandle<()>,
}

impl Drop for Guest {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

struct Tunnel {
    config: TunnelConfig,
    events: mpsc::UnboundedSender<TunnelEvent>,
    control: Arc<UdpSocket>,
    nonce: u64,
    prev_port: u16,
    phase: Phase,
    /// When the current attempt sent its first `HELLO`, and how many went.
    attempt_started: Instant,
    hellos_sent: usize,
    next_hello: Option<Instant>,
    keepalive: Duration,
    next_keepalive: Instant,
    unanswered: u32,
    public: Option<SocketAddrV4>,
    guests_seen: Option<u16>,
    expires_at: Option<u64>,
    guests: HashMap<u16, Guest>,
    replies: mpsc::Sender<(u16, Vec<u8>)>,
    guest_bind: GuestBind,
    /// The node said the ticket ran out, and the session was asked for a
    /// later one.
    awaiting_ticket: bool,
    /// The ticket in hand answered that request: the node refusing it as
    /// well ends the tunnel.
    renewed_after_expiry: bool,
    /// The nonce of the first `HELLO` not answered yet. A `HELLO_ACK` counts
    /// only for a `HELLO` sent since, so an old one replayed on the path
    /// brings nothing back.
    hello_pending_from: Option<u64>,
    /// The nonce of the last `KEEPALIVE`: only its `KEEPALIVE_ACK` counts,
    /// so a replayed old one cannot hide a dead path.
    keepalive_pending: Option<u64>,
}

async fn open_control(control: SocketAddrV4) -> std::io::Result<UdpSocket> {
    let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).await?;
    socket.connect(control).await?;
    Ok(socket)
}

async fn run(
    config: TunnelConfig,
    events: mpsc::UnboundedSender<TunnelEvent>,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    let control = match open_control(config.control).await {
        Ok(socket) => Arc::new(socket),
        Err(e) => {
            let _ = events.send(TunnelEvent::Failed {
                failure: TunnelFailure::Socket,
                message: format!("cannot open the tunnel socket: {e}"),
            });
            return;
        }
    };
    let (replies, mut replies_rx) = mpsc::channel::<(u16, Vec<u8>)>(1024);
    let now = Instant::now();
    let mut tunnel = Tunnel {
        keepalive: config.timing.keepalive,
        guest_bind: config.guest_bind,
        // The protocol starts the counter at the Unix time in milliseconds, so
        // a tunnel opened after a restart of the launcher outbids every nonce
        // the node saw from the one before.
        nonce: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0),
        config,
        events,
        control,
        prev_port: 0,
        phase: Phase::Connecting,
        attempt_started: now,
        hellos_sent: 0,
        next_hello: Some(now),
        next_keepalive: now,
        unanswered: 0,
        public: None,
        guests_seen: None,
        expires_at: None,
        guests: HashMap::new(),
        replies,
        awaiting_ticket: false,
        renewed_after_expiry: false,
        hello_pending_from: None,
        keepalive_pending: None,
    };

    let mut buffer = vec![0u8; 65_535];
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let control = tunnel.control.clone();
        tokio::select! {
            received = control.recv(&mut buffer) => {
                match received {
                    Ok(read) => {
                        if !tunnel.on_datagram(&buffer[..read]).await {
                            return;
                        }
                    }
                    // A reset from an ICMP of a node that is down, or a
                    // socket that went away with the network: the timers
                    // take it from here.
                    Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
            Some((guest_id, payload)) = replies_rx.recv() => {
                tunnel.forward_to_guest(guest_id, payload).await;
            }
            command = commands.recv() => {
                match command {
                    Some(Command::ServerPort(port)) => tunnel.config.server_port = Some(port),
                    Some(Command::Renew(ticket)) => tunnel.take_ticket(ticket).await,
                    Some(Command::Close) | None => {
                        tunnel.close().await;
                        return;
                    }
                }
            }
            _ = tick.tick() => {
                if !tunnel.on_tick().await {
                    return;
                }
            }
        }
    }
}

impl Tunnel {
    fn emit(&self, event: TunnelEvent) {
        let _ = self.events.send(event);
    }

    async fn send(&self, message: &Message) {
        let bytes = wire::encode(message, self.config.session_id, &self.config.key);
        let _ = self.control.send(&bytes).await;
    }

    async fn send_hello(&mut self) {
        self.nonce += 1;
        self.hello_pending_from.get_or_insert(self.nonce);
        let hello = Message::Hello {
            nonce: self.nonce,
            prev_port: self.prev_port,
            ticket: self.config.ticket.clone(),
        };
        self.send(&hello).await;
    }

    /// A renewed ticket goes out in a `HELLO` at once. After the node refused
    /// the old one as run out, a first attempt starts over, budget and all.
    async fn take_ticket(&mut self, ticket: Vec<u8>) {
        self.config.ticket = ticket;
        if std::mem::take(&mut self.awaiting_ticket) {
            self.renewed_after_expiry = true;
            if self.phase == Phase::Connecting {
                self.begin_attempt();
                return;
            }
        }
        self.send_hello().await;
        if self.phase == Phase::Lost {
            self.next_hello = Some(Instant::now() + self.config.timing.reconnect_every);
        }
    }

    /// Starts an attempt: `HELLO` now, again on the schedule.
    fn begin_attempt(&mut self) {
        let now = Instant::now();
        self.attempt_started = now;
        self.hellos_sent = 0;
        self.next_hello = Some(now);
    }

    /// Answers `false` when the tunnel is over.
    async fn on_datagram(&mut self, bytes: &[u8]) -> bool {
        let Ok((session_id, message)) = wire::decode(bytes, &self.config.key) else {
            return true;
        };
        if message.is_signed() && session_id != self.config.session_id {
            return true;
        }
        match message {
            Message::HelloAck { nonce, public_ip, public_port, expires_at, keepalive_secs, max_guests } => {
                // Any `HELLO` of the ones out may be the one answered: the
                // retries of an attempt carry growing nonces.
                match self.hello_pending_from {
                    Some(from) if (from..=self.nonce).contains(&nonce) => self.hello_pending_from = None,
                    _ => return true,
                }
                let public = SocketAddrV4::new(public_ip, public_port);
                self.prev_port = public_port;
                self.unanswered = 0;
                self.next_hello = None;
                self.renewed_after_expiry = false;
                if keepalive_secs > 0 {
                    self.keepalive = Duration::from_secs(u64::from(keepalive_secs.clamp(5, 60)));
                }
                self.next_keepalive = Instant::now() + self.keepalive;
                let was = self.phase;
                self.phase = Phase::Active;
                if was != Phase::Active || self.public != Some(public) {
                    self.public = Some(public);
                    self.emit(TunnelEvent::Active { public, expires_at, max_guests });
                }
                self.note_expiry(expires_at);
            }
            Message::KeepaliveAck { nonce, guests, expires_at } => {
                if self.keepalive_pending != Some(nonce) {
                    return true;
                }
                self.keepalive_pending = None;
                self.unanswered = 0;
                if self.guests_seen != Some(guests) {
                    self.guests_seen = Some(guests);
                    self.emit(TunnelEvent::Guests(guests));
                }
                self.note_expiry(expires_at);
            }
            Message::Rehello => {
                self.send_hello().await;
            }
            Message::Data { guest_id, payload } => {
                self.forward_to_server(guest_id, payload).await;
            }
            Message::GuestClose { guest_id, .. } => {
                self.guests.remove(&guest_id);
            }
            Message::Close { reason } => {
                self.emit(TunnelEvent::Closed { reason });
                match reason {
                    wire::close::EXPIRED | wire::close::ADMIN | wire::close::HOST_STOPPED => {
                        self.guests.clear();
                        return false;
                    }
                    // The node is going away or lost track of the host: the
                    // session comes back with a `HELLO` once it answers.
                    wire::close::NODE_SHUTDOWN | wire::close::HOST_LOST => self.lose().await,
                    // A reason newer than this build: try to come back all
                    // the same, the node refuses what it will not restore.
                    _ => self.lose().await,
                }
            }
            Message::Error { code }
                if code == wire::error_code::TICKET_EXPIRED && !self.renewed_after_expiry =>
            {
                // The session may still hold a later ticket: the service
                // renews it while the session is open. Every `HELLO` sent
                // before this one gets the same answer, so one request does.
                if !self.awaiting_ticket {
                    self.awaiting_ticket = true;
                    self.emit(TunnelEvent::TicketExpired);
                }
            }
            Message::Error { code } => {
                let (failure, message) = match code {
                    wire::error_code::TICKET_EXPIRED => {
                        (TunnelFailure::Expired, "the relay ticket ran out")
                    }
                    wire::error_code::NO_FREE_PORT => {
                        (TunnelFailure::Refused, "the relay node has no free port")
                    }
                    wire::error_code::SESSION_CLOSED => {
                        (TunnelFailure::Refused, "the relay session is closed")
                    }
                    wire::error_code::WRONG_NODE => {
                        (TunnelFailure::Refused, "the ticket belongs to another relay node")
                    }
                    _ => (TunnelFailure::Refused, "the relay node refused the session"),
                };
                self.emit(TunnelEvent::Failed { failure, message: message.into() });
                return false;
            }
            // What a node never sends to a host.
            Message::Hello { .. }
            | Message::Keepalive { .. }
            | Message::Ping { .. }
            | Message::Pong { .. } => {}
        }
        true
    }

    fn note_expiry(&mut self, expires_at: u64) {
        if expires_at > 0 && self.expires_at != Some(expires_at) {
            let first = self.expires_at.is_none();
            self.expires_at = Some(expires_at);
            if !first {
                self.emit(TunnelEvent::Expires(expires_at));
            }
        }
    }

    /// The path to the node is gone: a new socket, a new mapping in the
    /// router, and `HELLO` with the port the session held.
    async fn lose(&mut self) {
        if self.phase != Phase::Lost {
            self.phase = Phase::Lost;
            self.emit(TunnelEvent::Lost);
        }
        match open_control(self.config.control).await {
            Ok(socket) => self.control = Arc::new(socket),
            Err(e) => log::debug!("relay: cannot reopen the tunnel socket: {e}"),
        }
        self.unanswered = 0;
        self.begin_attempt();
    }

    /// A packet of a guest, towards the server.
    async fn forward_to_server(&mut self, guest_id: u16, payload: Vec<u8>) {
        if payload.len() > wire::MAX_GUEST_PACKET || guest_id == 0 {
            return;
        }
        let Some(server_port) = self.config.server_port else {
            // The server is not up yet; the client of the guest retries.
            return;
        };
        if !self.guests.contains_key(&guest_id) {
            if self.guests.len() >= self.config.max_guests {
                self.send(&Message::GuestClose { guest_id, reason: wire::guest_close::LIMIT })
                    .await;
                return;
            }
            match self.open_guest(guest_id, server_port).await {
                Some(guest) => {
                    self.guests.insert(guest_id, guest);
                }
                None => return,
            }
        }
        if let Some(guest) = self.guests.get_mut(&guest_id) {
            guest.last_activity = Instant::now();
            let _ = guest.socket.send(&payload).await;
        }
    }

    /// An answer of the server, towards the guest it belongs to.
    async fn forward_to_guest(&mut self, guest_id: u16, payload: Vec<u8>) {
        if payload.len() > wire::MAX_HOST_PAYLOAD {
            return;
        }
        let Some(guest) = self.guests.get_mut(&guest_id) else {
            return;
        };
        guest.last_activity = Instant::now();
        self.send(&Message::Data { guest_id, payload }).await;
    }

    async fn open_guest(&mut self, guest_id: u16, server_port: u16) -> Option<Guest> {
        let server = SocketAddrV4::new(Ipv4Addr::LOCALHOST, server_port);
        let socket = match self.guest_bind {
            GuestBind::PerGuest => {
                let address = SocketAddrV4::new(guest_address(guest_id), 0);
                match UdpSocket::bind(address).await {
                    Ok(socket) => Some(socket),
                    Err(e) => {
                        log::warn!(
                            "relay: cannot bind a guest socket to {address} ({e}); guests share 127.0.0.1 from now on"
                        );
                        self.guest_bind = GuestBind::Loopback;
                        None
                    }
                }
            }
            GuestBind::Loopback => None,
        };
        let socket = match socket {
            Some(socket) => socket,
            None => UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).await.ok()?,
        };
        socket.connect(server).await.ok()?;
        let socket = Arc::new(socket);
        let reader = {
            let socket = socket.clone();
            let replies = self.replies.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 65_535];
                loop {
                    match socket.recv(&mut buffer).await {
                        Ok(read) => {
                            if replies.send((guest_id, buffer[..read].to_vec())).await.is_err() {
                                return;
                            }
                        }
                        // The server port answered with a reset: it is not
                        // there yet or not any more. Nothing to forward.
                        Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                    }
                }
            })
        };
        Some(Guest {
            socket,
            last_activity: Instant::now(),
            reader,
        })
    }

    /// Answers `false` when the tunnel is over.
    async fn on_tick(&mut self) -> bool {
        let now = Instant::now();
        match self.phase {
            // No `HELLO` without a ticket the node takes; the budget of the
            // attempt starts over with the renewed one.
            Phase::Connecting | Phase::Lost if self.awaiting_ticket => {}
            Phase::Connecting => {
                if now.duration_since(self.attempt_started) >= self.config.timing.hello_budget {
                    self.emit(TunnelEvent::Failed {
                        failure: TunnelFailure::NodeSilent,
                        message: format!(
                            "the relay node did not answer within {} s",
                            self.config.timing.hello_budget.as_secs()
                        ),
                    });
                    return false;
                }
                self.hello_on_schedule(now).await;
            }
            Phase::Lost => {
                if self.next_hello.is_none_or(|at| now >= at) {
                    self.send_hello().await;
                    self.next_hello = Some(now + self.config.timing.reconnect_every);
                }
            }
            Phase::Active => {
                if now >= self.next_keepalive {
                    if self.unanswered >= 2 {
                        self.lose().await;
                        return true;
                    }
                    self.nonce += 1;
                    let keepalive = Message::Keepalive { nonce: self.nonce };
                    self.keepalive_pending = Some(self.nonce);
                    self.send(&keepalive).await;
                    self.unanswered += 1;
                    self.next_keepalive = now + self.keepalive;
                }
            }
        }

        let idle = self.config.timing.guest_idle;
        let silent: Vec<u16> = self
            .guests
            .iter()
            .filter(|(_, guest)| now.duration_since(guest.last_activity) >= idle)
            .map(|(id, _)| *id)
            .collect();
        for guest_id in silent {
            self.guests.remove(&guest_id);
            self.send(&Message::GuestClose { guest_id, reason: wire::guest_close::SILENT })
                .await;
        }
        true
    }

    /// `HELLO` at 0, then after each pause of the schedule.
    async fn hello_on_schedule(&mut self, now: Instant) {
        let Some(at) = self.next_hello else {
            return;
        };
        if now < at {
            return;
        }
        self.send_hello().await;
        let pause = self.config.timing.hello_retries.get(self.hellos_sent).copied();
        self.hellos_sent += 1;
        self.next_hello = pause.map(|pause| now + pause);
    }

    async fn close(&mut self) {
        self.guests.clear();
        let close = Message::Close { reason: wire::close::HOST_STOPPED };
        for _ in 0..3 {
            self.send(&close).await;
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }
}

/// The address a guest socket would get, for the tests and the log.
pub fn guest_address(guest_id: u16) -> Ipv4Addr {
    let [high, low] = guest_id.to_be_bytes();
    Ipv4Addr::new(127, 77, high, low)
}

/// Resolves the `ip:port` of a control address; a host name is looked up.
pub async fn resolve_control(address: &str) -> Option<SocketAddrV4> {
    if let Ok(parsed) = address.trim().parse::<SocketAddrV4>() {
        return Some(parsed);
    }
    tokio::net::lookup_host(address.trim())
        .await
        .ok()?
        .find_map(|found| match found {
            SocketAddr::V4(v4) => Some(v4),
            SocketAddr::V6(_) => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    const KEY: HostKey = [0x42; 16];
    const SESSION: u64 = 0x9f3c_0a1d_2b4e_5f60;

    fn fast() -> Timing {
        Timing {
            hello_retries: vec![Duration::from_millis(100); 3],
            hello_budget: Duration::from_millis(900),
            keepalive: Duration::from_millis(300),
            reconnect_every: Duration::from_millis(200),
            guest_idle: Duration::from_secs(30),
        }
    }

    /// A relay node in a few lines: a control socket and one session port.
    struct FakeNode {
        control: Arc<UdpSocket>,
        session: Arc<UdpSocket>,
        host: Mutex<Option<SocketAddr>>,
        guests: Mutex<HashMap<SocketAddr, u16>>,
        hellos: Mutex<Vec<(u64, u16, Vec<u8>)>>,
        answer_hello: std::sync::atomic::AtomicBool,
        /// Tickets a `HELLO` gets `ERROR` for, with the code.
        refuse: Mutex<Vec<(Vec<u8>, u8)>>,
        answer_keepalive: std::sync::atomic::AtomicBool,
        /// The nonces of the `KEEPALIVE`s that came.
        keepalives: Mutex<Vec<u64>>,
        /// Where the host's last message came from, answered or not.
        last_from: Mutex<Option<SocketAddr>>,
    }

    impl FakeNode {
        async fn start() -> Arc<FakeNode> {
            let node = Arc::new(FakeNode {
                control: Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap()),
                session: Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap()),
                host: Mutex::new(None),
                guests: Mutex::new(HashMap::new()),
                hellos: Mutex::new(Vec::new()),
                answer_hello: std::sync::atomic::AtomicBool::new(true),
                refuse: Mutex::new(Vec::new()),
                answer_keepalive: std::sync::atomic::AtomicBool::new(true),
                keepalives: Mutex::new(Vec::new()),
                last_from: Mutex::new(None),
            });
            // Control port: HELLO, KEEPALIVE, DATA from the host.
            let control_node = node.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 65_535];
                loop {
                    let Ok((read, from)) = control_node.control.recv_from(&mut buffer).await else {
                        continue;
                    };
                    let Ok((session, message)) = wire::decode(&buffer[..read], &KEY) else {
                        continue;
                    };
                    assert_eq!(session, SESSION);
                    *control_node.last_from.lock().unwrap() = Some(from);
                    match message {
                        Message::Hello { nonce, prev_port, ticket } => {
                            control_node.hellos.lock().unwrap().push((nonce, prev_port, ticket.clone()));
                            if !control_node.answer_hello.load(std::sync::atomic::Ordering::Relaxed) {
                                continue;
                            }
                            let refused = control_node
                                .refuse
                                .lock()
                                .unwrap()
                                .iter()
                                .find(|(refused, _)| *refused == ticket)
                                .map(|(_, code)| *code);
                            if let Some(code) = refused {
                                let error = Message::Error { code };
                                let _ = control_node.control.send_to(&wire::encode(&error, SESSION, &KEY), from).await;
                                continue;
                            }
                            *control_node.host.lock().unwrap() = Some(from);
                            let port = control_node.session.local_addr().unwrap().port();
                            let ack = Message::HelloAck {
                                nonce,
                                public_ip: Ipv4Addr::LOCALHOST,
                                public_port: port,
                                expires_at: 1_790_373_600,
                                keepalive_secs: 0,
                                max_guests: 16,
                            };
                            let _ = control_node.control.send_to(&wire::encode(&ack, SESSION, &KEY), from).await;
                        }
                        Message::Keepalive { nonce } => {
                            control_node.keepalives.lock().unwrap().push(nonce);
                            if !control_node.answer_keepalive.load(std::sync::atomic::Ordering::Relaxed) {
                                continue;
                            }
                            let guests = control_node.guests.lock().unwrap().len() as u16;
                            let ack = Message::KeepaliveAck { nonce, guests, expires_at: 1_790_373_600 };
                            let _ = control_node.control.send_to(&wire::encode(&ack, SESSION, &KEY), from).await;
                        }
                        Message::Data { guest_id, payload } => {
                            let target = control_node
                                .guests
                                .lock()
                                .unwrap()
                                .iter()
                                .find(|(_, id)| **id == guest_id)
                                .map(|(address, _)| *address);
                            if let Some(target) = target {
                                let _ = control_node.session.send_to(&payload, target).await;
                            }
                        }
                        _ => {}
                    }
                }
            });
            // Session port: guests.
            let session_node = node.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 65_535];
                loop {
                    let Ok((read, from)) = session_node.session.recv_from(&mut buffer).await else {
                        continue;
                    };
                    let guest_id = {
                        let mut guests = session_node.guests.lock().unwrap();
                        let next = guests.len() as u16 + 1;
                        *guests.entry(from).or_insert(next)
                    };
                    let Some(host) = *session_node.host.lock().unwrap() else { continue };
                    let data = Message::Data { guest_id, payload: buffer[..read].to_vec() };
                    let _ = session_node.control.send_to(&wire::encode(&data, SESSION, &KEY), host).await;
                }
            });
            node
        }

        fn control_address(&self) -> SocketAddrV4 {
            match self.control.local_addr().unwrap() {
                SocketAddr::V4(v4) => v4,
                other => panic!("{other}"),
            }
        }

        async fn to_host(&self, message: &Message) {
            let host = self.host.lock().unwrap().expect("a host");
            let _ = self.control.send_to(&wire::encode(message, SESSION, &KEY), host).await;
        }

        /// To wherever the host last spoke from, a new socket included.
        async fn to_last_sender(&self, message: &Message) {
            let Some(to) = *self.last_from.lock().unwrap() else { return };
            let _ = self.control.send_to(&wire::encode(message, SESSION, &KEY), to).await;
        }
    }

    /// A server that answers every datagram with `echo:<datagram>` and
    /// remembers who asked.
    async fn fake_server() -> (u16, Arc<Mutex<BTreeSet<SocketAddr>>>) {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(BTreeSet::new()));
        let record = seen.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 65_535];
            loop {
                let Ok((read, from)) = socket.recv_from(&mut buffer).await else { continue };
                record.lock().unwrap().insert(from);
                let mut reply = b"echo:".to_vec();
                reply.extend_from_slice(&buffer[..read]);
                let _ = socket.send_to(&reply, from).await;
            }
        });
        (port, seen)
    }

    async fn next_event(events: &mut mpsc::UnboundedReceiver<TunnelEvent>) -> TunnelEvent {
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("an event in time")
            .expect("the tunnel is alive")
    }

    async fn ask(guest: &UdpSocket, text: &str) -> String {
        guest.send(text.as_bytes()).await.unwrap();
        let mut buffer = vec![0u8; 4096];
        let read = tokio::time::timeout(Duration::from_secs(3), guest.recv(&mut buffer))
            .await
            .expect("an answer in time")
            .unwrap();
        String::from_utf8_lossy(&buffer[..read]).into_owned()
    }

    async fn guest_of(node: &FakeNode) -> UdpSocket {
        let guest = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        guest.connect(node.session.local_addr().unwrap()).await.unwrap();
        guest
    }

    fn config(node: &FakeNode, server_port: Option<u16>) -> TunnelConfig {
        TunnelConfig {
            control: node.control_address(),
            session_id: SESSION,
            key: KEY,
            ticket: b"opaque ticket".to_vec(),
            server_port,
            max_guests: 16,
            guest_bind: GuestBind::PerGuest,
            timing: fast(),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_guests_reach_the_server_from_their_own_addresses_and_get_their_own_answers() {
        let node = FakeNode::start().await;
        let (server_port, seen) = fake_server().await;
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let tunnel = spawn(config(&node, None), events_tx);

        let TunnelEvent::Active { public, max_guests, .. } = next_event(&mut events).await else {
            panic!("the first event is the node's answer");
        };
        assert_eq!(public.port(), node.session.local_addr().unwrap().port());
        assert_eq!(max_guests, 16);
        let first_hello = node.hellos.lock().unwrap()[0].clone();
        assert_eq!(first_hello.1, 0, "no port to restore on the first HELLO");
        assert_eq!(first_hello.2, b"opaque ticket");

        // Before the server is up, a guest packet has nowhere to go.
        tunnel.set_server_port(server_port);
        tokio::time::sleep(Duration::from_millis(50)).await;

        let one = guest_of(&node).await;
        let two = guest_of(&node).await;
        assert_eq!(ask(&one, "getinfo one").await, "echo:getinfo one");
        assert_eq!(ask(&two, "getinfo two").await, "echo:getinfo two");
        assert_eq!(ask(&one, "again").await, "echo:again");

        let sources: Vec<Ipv4Addr> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|address| match address {
                SocketAddr::V4(v4) => *v4.ip(),
                other => panic!("{other}"),
            })
            .collect();
        assert_eq!(sources.len(), 2, "one socket per guest: {sources:?}");
        let expected: BTreeSet<Ipv4Addr> = [guest_address(1), guest_address(2)].into();
        let got: BTreeSet<Ipv4Addr> = sources.into_iter().collect();
        if got != expected {
            // A machine that refuses 127.77.x.y falls back to 127.0.0.1, and
            // the two guests still differ by port.
            assert!(got.iter().all(|ip| ip.is_loopback()), "{got:?}");
        }

        tunnel.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rehello_gets_a_hello_with_a_larger_nonce_and_the_held_port() {
        let node = FakeNode::start().await;
        let (server_port, _) = fake_server().await;
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let tunnel = spawn(config(&node, Some(server_port)), events_tx);
        assert!(matches!(next_event(&mut events).await, TunnelEvent::Active { .. }));

        node.to_host(&Message::Rehello).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let hellos = node.hellos.lock().unwrap().clone();
        assert!(hellos.len() >= 2, "{hellos:?}");
        let (first, second) = (&hellos[0], &hellos[hellos.len() - 1]);
        assert!(second.0 > first.0, "the nonce grows");
        assert_eq!(second.1, node.session.local_addr().unwrap().port(), "prev_port");
        tunnel.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replayed_old_acks_neither_hide_a_dead_path_nor_bring_the_tunnel_back() {
        let node = FakeNode::start().await;
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let tunnel = spawn(config(&node, None), events_tx);
        assert!(matches!(next_event(&mut events).await, TunnelEvent::Active { .. }));

        // One keepalive answered, then the node goes quiet.
        tokio::time::sleep(Duration::from_millis(450)).await;
        let old_keepalive = *node.keepalives.lock().unwrap().first().expect("a keepalive went out");
        let old_hello = node.hellos.lock().unwrap()[0].0;
        let port = node.session.local_addr().unwrap().port();
        node.answer_keepalive.store(false, std::sync::atomic::Ordering::Relaxed);
        node.answer_hello.store(false, std::sync::atomic::Ordering::Relaxed);

        // Someone on the path sends the old, genuinely signed answers again
        // and again, to the host's newest socket.
        let replayer = {
            let node = node.clone();
            tokio::spawn(async move {
                loop {
                    let keepalive_ack =
                        Message::KeepaliveAck { nonce: old_keepalive, guests: 0, expires_at: 1_790_373_600 };
                    node.to_last_sender(&keepalive_ack).await;
                    let hello_ack = Message::HelloAck {
                        nonce: old_hello,
                        public_ip: Ipv4Addr::LOCALHOST,
                        public_port: port,
                        expires_at: 1_790_373_600,
                        keepalive_secs: 0,
                        max_guests: 16,
                    };
                    node.to_last_sender(&hello_ack).await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
        };

        // Two keepalives go unanswered: the path is gone all the same. The
        // count of the one genuine answer may come first.
        let mut event = next_event(&mut events).await;
        if event == TunnelEvent::Guests(0) {
            event = next_event(&mut events).await;
        }
        assert_eq!(event, TunnelEvent::Lost);
        // And the old HELLO_ACK does not bring the tunnel back.
        let back = tokio::time::timeout(Duration::from_millis(700), events.recv()).await;
        assert!(back.is_err(), "nothing while the node is quiet: {back:?}");
        replayer.abort();

        // The node answering again does.
        node.answer_hello.store(true, std::sync::atomic::Ordering::Relaxed);
        node.answer_keepalive.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(matches!(next_event(&mut events).await, TunnelEvent::Active { .. }));
        tunnel.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn guest_close_drops_the_socket_and_the_next_packet_opens_a_new_one() {
        let node = FakeNode::start().await;
        let (server_port, seen) = fake_server().await;
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let tunnel = spawn(config(&node, Some(server_port)), events_tx);
        assert!(matches!(next_event(&mut events).await, TunnelEvent::Active { .. }));

        let guest = guest_of(&node).await;
        assert_eq!(ask(&guest, "hello").await, "echo:hello");
        node.to_host(&Message::GuestClose { guest_id: 1, reason: wire::guest_close::BY_HOST })
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(ask(&guest, "back").await, "echo:back");
        // Two different local sockets carried the same guest.
        assert_eq!(seen.lock().unwrap().len(), 2);
        tunnel.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_silent_node_ends_the_attempt_with_a_failure() {
        let node = FakeNode::start().await;
        node.answer_hello.store(false, std::sync::atomic::Ordering::Relaxed);
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let tunnel = spawn(config(&node, None), events_tx);
        match next_event(&mut events).await {
            TunnelEvent::Failed { failure, .. } => assert_eq!(failure, TunnelFailure::NodeSilent),
            other => panic!("{other:?}"),
        }
        // HELLO at 0, then after each of the three pauses.
        assert_eq!(node.hellos.lock().unwrap().len(), 4);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(tunnel.is_finished());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_from_the_node_and_an_error_are_reported() {
        let node = FakeNode::start().await;
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let _tunnel = spawn(config(&node, None), events_tx);
        assert!(matches!(next_event(&mut events).await, TunnelEvent::Active { .. }));
        node.to_host(&Message::Close { reason: wire::close::EXPIRED }).await;
        assert_eq!(
            next_event(&mut events).await,
            TunnelEvent::Closed { reason: wire::close::EXPIRED }
        );

        // A ticket for another node is not renewed: the tunnel ends.
        let node = FakeNode::start().await;
        node.refuse.lock().unwrap().push((b"opaque ticket".to_vec(), wire::error_code::WRONG_NODE));
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let tunnel = spawn(config(&node, None), events_tx);
        match next_event(&mut events).await {
            TunnelEvent::Failed { failure, .. } => assert_eq!(failure, TunnelFailure::Refused),
            other => panic!("{other:?}"),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(tunnel.is_finished());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_expired_ticket_waits_for_a_renewed_one_and_a_second_refusal_ends_the_tunnel() {
        let node = FakeNode::start().await;
        node.refuse.lock().unwrap().push((b"opaque ticket".to_vec(), wire::error_code::TICKET_EXPIRED));
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let tunnel = spawn(config(&node, None), events_tx);
        assert_eq!(next_event(&mut events).await, TunnelEvent::TicketExpired);

        // Past the budget of the attempt: no failure and no HELLO while the
        // ticket is out.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let asked = node.hellos.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        assert_eq!(node.hellos.lock().unwrap().len(), asked, "HELLO waits for the ticket");
        assert!(events.try_recv().is_err(), "one request, no failure");
        assert!(!tunnel.is_finished());

        tunnel.renew(b"renewed ticket".to_vec());
        assert!(matches!(next_event(&mut events).await, TunnelEvent::Active { .. }));
        let last = node.hellos.lock().unwrap().last().cloned().expect("a HELLO");
        assert_eq!(last.2, b"renewed ticket");

        // Later the renewed ticket runs out as well: after a HELLO_ACK it may
        // be renewed again, but a renewal the node refuses too is the end.
        node.refuse.lock().unwrap().push((b"renewed ticket".to_vec(), wire::error_code::TICKET_EXPIRED));
        node.to_host(&Message::Rehello).await;
        assert_eq!(next_event(&mut events).await, TunnelEvent::TicketExpired);
        tunnel.renew(b"renewed ticket".to_vec());
        match next_event(&mut events).await {
            TunnelEvent::Failed { failure, .. } => assert_eq!(failure, TunnelFailure::Expired),
            other => panic!("{other:?}"),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(tunnel.is_finished());
    }

    #[test]
    fn a_guest_address_spreads_the_id_over_the_last_two_bytes() {
        assert_eq!(guest_address(5), Ipv4Addr::new(127, 77, 0, 5));
        assert_eq!(guest_address(456), Ipv4Addr::new(127, 77, 1, 200));
    }
}
