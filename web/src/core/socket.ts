/**
 * The live socket of the web app: `/v1/ws` opened with a one-time ticket.
 *
 * A browser's `WebSocket` sends no headers, so the token cannot travel the
 * way the launcher sends it. The core asks `POST /v1/ws/tickets` for a ticket
 * with the token in the header, and opens `/v1/ws?ticket=` within its 30 s.
 * The ticket carries the socket's context: chat frames on, the device kind
 * friends see ("Online from phone" or "Online in browser") and whether the
 * tab is visible.
 *
 * | What happens                  | What the socket does                        |
 * | ----------------------------- | ------------------------------------------- |
 * | server `ping`                 | answers `pong`                              |
 * | any frame                     | resets the 90 s silence timer              |
 * | 90 s without a frame          | closes and reconnects                       |
 * | close, error, ticket refused  | reconnects after 1, 2, 4 … 30 s ± 20 %      |
 * | close code 4401, ticket `401` | the token is gone: the session expires      |
 * | open                          | bumps `epoch`: chat resyncs, friends refetch |
 * | a minute open                 | the backoff starts over                     |
 *
 * Frames sent while the socket is closed are dropped: only hints travel this
 * way (typing, the tab's visibility), and a stale hint is worse than none.
 *
 * Everything the socket touches outside itself comes in through
 * `SocketDeps`, so the tests drive it with a fake `WebSocket` and fake
 * timers.
 */

/** A frame of the service: `{ "type", "payload", "at" }`. */
export interface Frame {
  type: string;
  payload?: unknown;
  at?: string;
}

/** The close code of a socket whose token was signed out. */
export const SIGNED_OUT_CLOSE = 4401;
/** No frame for this long: the connection is dead even if nothing said so. */
export const SILENCE_MS = 90_000;
/** Open this long and the backoff starts over. */
export const STABLE_MS = 60_000;
export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
/** A visible tab that heard nothing for this long asks whether the socket lives. */
export const PROBE_AFTER_MS = 25_000;
/** How long the answer to that question may take. */
export const PROBE_WAIT_MS = 5_000;

/** The wait before attempt `n` (0-based): 1, 2, 4 … 30 s, ± 20 %. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, attempt));
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.round(base * jitter);
}

/** The part of `WebSocket` the socket uses. */
export interface SocketLike {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export type SocketStatus = "idle" | "connecting" | "open" | "closed";

export interface SocketDeps {
  /** `https://api.jknet.app`; the socket's address is its `wss:` twin. */
  apiBase: string;
  /** `POST /v1/ws/tickets`; rejects with the service's refusal. */
  requestTicket(): Promise<string>;
  /** Whether a refusal of the ticket means the token is gone. */
  isUnauthorized(error: unknown): boolean;
  open: SocketFactory;
  timers: Timers;
  random(): number;
  onFrame(frame: Frame): void;
  /** Every opening, with its number. */
  onOpen(epoch: number): void;
  onStatus(status: SocketStatus): void;
  /** Close code 4401 or a `401` on the ticket. */
  onSignedOut(): void;
}

export interface LiveSocket {
  start(): void;
  /** Closes and stays closed until `start`. */
  stop(): void;
  /** Sends a frame if the socket is open; answers whether it did. */
  send(frame: Frame): boolean;
  status(): SocketStatus;
  epoch(): number;
  /** Reconnects at once, the backoff reset: the `online` event. */
  reconnectNow(): void;
  /**
   * A visible tab asks whether the socket still lives: if nothing arrived
   * for 25 s it sends `ping` and reconnects unless a frame comes within 5 s.
   * Resolves once the socket is known to be up or a reconnect was started.
   */
  probe(): Promise<void>;
  /** `pagehide`/`freeze`: closes so the page can enter the back-forward cache. */
  suspend(): void;
  /** `pageshow`/`resume`: opens again after `suspend`. */
  resume(): void;
}

const OPEN = 1;

export function createSocket(deps: SocketDeps): LiveSocket {
  const { timers } = deps;
  let socket: SocketLike | null = null;
  let status: SocketStatus = "idle";
  let running = false;
  let suspended = false;
  let attempt = 0;
  let epoch = 0;
  let lastFrameAt = 0;
  let reconnectTimer: unknown = null;
  let silenceTimer: unknown = null;
  let stableTimer: unknown = null;
  /** Bumped per connection, so a late callback of an old one is ignored. */
  let generation = 0;

  const setStatus = (next: SocketStatus) => {
    if (status === next) return;
    status = next;
    deps.onStatus(next);
  };

  const clear = (handle: unknown) => {
    if (handle !== null) timers.clearTimeout(handle);
  };

  const clearTimers = () => {
    clear(reconnectTimer);
    clear(silenceTimer);
    clear(stableTimer);
    reconnectTimer = silenceTimer = stableTimer = null;
  };

  const drop = () => {
    const current = socket;
    socket = null;
    generation += 1;
    if (current !== null) {
      current.onopen = current.onmessage = current.onclose = current.onerror = null;
      try {
        current.close(1000, "closing");
      } catch {
        // Already closed.
      }
    }
  };

  const armSilence = () => {
    clear(silenceTimer);
    silenceTimer = timers.setTimeout(() => {
      silenceTimer = null;
      // Nothing for 90 s: the service pings every 30 s, so this connection
      // is dead whatever the browser thinks.
      reconnect();
    }, SILENCE_MS);
  };

  const scheduleReconnect = () => {
    if (!running || suspended) return;
    clear(reconnectTimer);
    const delay = backoffDelay(attempt, deps.random);
    attempt += 1;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const reconnect = () => {
    drop();
    clear(silenceTimer);
    clear(stableTimer);
    silenceTimer = stableTimer = null;
    setStatus("closed");
    scheduleReconnect();
  };

  const signedOut = () => {
    running = false;
    drop();
    clearTimers();
    setStatus("closed");
    deps.onSignedOut();
  };

  const connect = async () => {
    if (!running || suspended) return;
    drop();
    const mine = generation;
    setStatus("connecting");
    let ticket: string;
    try {
      ticket = await deps.requestTicket();
    } catch (error) {
      if (mine !== generation || !running) return;
      if (deps.isUnauthorized(error)) {
        signedOut();
        return;
      }
      setStatus("closed");
      scheduleReconnect();
      return;
    }
    if (mine !== generation || !running || suspended) return;

    const url = `${deps.apiBase.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`;
    let next: SocketLike;
    try {
      next = deps.open(url);
    } catch {
      setStatus("closed");
      scheduleReconnect();
      return;
    }
    socket = next;

    next.onopen = () => {
      if (mine !== generation) return;
      lastFrameAt = timers.now();
      epoch += 1;
      setStatus("open");
      armSilence();
      clear(stableTimer);
      stableTimer = timers.setTimeout(() => {
        stableTimer = null;
        attempt = 0;
      }, STABLE_MS);
      deps.onOpen(epoch);
    };
    next.onmessage = (event) => {
      if (mine !== generation) return;
      lastFrameAt = timers.now();
      armSilence();
      if (typeof event.data !== "string") return;
      let frame: Frame;
      try {
        frame = JSON.parse(event.data) as Frame;
      } catch {
        return;
      }
      if (frame === null || typeof frame !== "object" || typeof frame.type !== "string") return;
      if (frame.type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (frame.type === "pong") return;
      deps.onFrame(frame);
    };
    next.onclose = (event) => {
      if (mine !== generation) return;
      socket = null;
      if (event.code === SIGNED_OUT_CLOSE) {
        signedOut();
        return;
      }
      clear(silenceTimer);
      clear(stableTimer);
      silenceTimer = stableTimer = null;
      setStatus("closed");
      scheduleReconnect();
    };
    next.onerror = () => {
      // `close` follows an error; the reconnect is decided there.
    };
  };

  const send = (frame: Frame): boolean => {
    if (socket === null || socket.readyState !== OPEN || status !== "open") return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      suspended = false;
      attempt = 0;
      void connect();
    },
    stop: () => {
      running = false;
      drop();
      clearTimers();
      setStatus("idle");
    },
    send,
    status: () => status,
    epoch: () => epoch,
    reconnectNow: () => {
      if (!running || suspended) return;
      attempt = 0;
      if (status === "open") return;
      clear(reconnectTimer);
      reconnectTimer = null;
      void connect();
    },
    probe: () =>
      new Promise<void>((resolve) => {
        if (!running || suspended) {
          resolve();
          return;
        }
        if (status !== "open") {
          attempt = 0;
          if (status !== "connecting") {
            clear(reconnectTimer);
            reconnectTimer = null;
            void connect();
          }
          resolve();
          return;
        }
        if (timers.now() - lastFrameAt <= PROBE_AFTER_MS) {
          resolve();
          return;
        }
        const asked = timers.now();
        send({ type: "ping" });
        timers.setTimeout(() => {
          if (lastFrameAt < asked && status === "open") {
            // No answer: a connection the phone's radio dropped while the tab
            // slept. A new one now, not after a backoff.
            attempt = 0;
            clearTimers();
            setStatus("closed");
            void connect();
          }
          resolve();
        }, PROBE_WAIT_MS);
      }),
    suspend: () => {
      if (!running) return;
      suspended = true;
      drop();
      clearTimers();
      setStatus("closed");
    },
    resume: () => {
      if (!running || !suspended) return;
      suspended = false;
      attempt = 0;
      void connect();
    },
  };
}
