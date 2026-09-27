import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backoffDelay,
  createSocket,
  MAX_BACKOFF_MS,
  PROBE_AFTER_MS,
  PROBE_WAIT_MS,
  SIGNED_OUT_CLOSE,
  SILENCE_MS,
  STABLE_MS,
} from "./socket.ts";

/** Timers under the test's hand. */
function fakeTimers() {
  let now = 1_000_000;
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (handler, ms) => {
        const id = nextId++;
        pending.set(id, { at: now + ms, handler });
        return id;
      },
      clearTimeout: (id) => pending.delete(id),
      now: () => now,
    },
    /** Moves the clock and runs what came due, in order. */
    advance: async (ms) => {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].handler();
        await flush();
      }
      now = until;
    },
    pendingDelays: () => [...pending.values()].map((t) => t.at - now).sort((a, b) => a - b),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = null;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.closed = code ?? 1000;
    this.readyState = 3;
  }
  // The service's side.
  accept() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function setup(overrides = {}) {
  const clock = fakeTimers();
  const sockets = [];
  const frames = [];
  const opens = [];
  const statuses = [];
  let signedOut = 0;
  let tickets = 0;
  const socket = createSocket({
    apiBase: "https://api.example.com",
    requestTicket: async () => {
      tickets += 1;
      if (overrides.ticket) return overrides.ticket(tickets);
      return `ticket-${tickets}`;
    },
    isUnauthorized: (error) => error?.status === 401,
    open: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    timers: clock.timers,
    random: () => 0.5,
    onFrame: (frame) => frames.push(frame),
    onOpen: (epoch) => opens.push(epoch),
    onStatus: (status) => statuses.push(status),
    onSignedOut: () => {
      signedOut += 1;
    },
  });
  return { socket, clock, sockets, frames, opens, statuses, signedOut: () => signedOut, tickets: () => tickets };
}

test("the backoff doubles from 1 s to 30 s with ±20 % jitter", () => {
  const exact = (attempt) => backoffDelay(attempt, () => 0.5);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(exact), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(backoffDelay(0, () => 0), 800);
  assert.equal(backoffDelay(0, () => 1), 1200);
  assert.equal(backoffDelay(9, () => 1), MAX_BACKOFF_MS * 1.2);
});

test("the socket opens with a ticket on the ws twin of the API", async () => {
  const { socket, sockets, opens, statuses } = setup();
  socket.start();
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://api.example.com/v1/ws?ticket=ticket-1");
  sockets[0].accept();
  assert.deepEqual(opens, [1]);
  assert.equal(socket.status(), "open");
  assert.deepEqual(statuses, ["connecting", "open"]);
});

test("a server ping is answered with pong and never reaches the handlers", async () => {
  const { socket, sockets, frames } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  sockets[0].deliver({ type: "ping", payload: {} });
  sockets[0].deliver({ type: "presence.updated", payload: { userId: "u" } });
  assert.deepEqual(sockets[0].sent, [{ type: "pong" }]);
  assert.deepEqual(frames.map((frame) => frame.type), ["presence.updated"]);
});

test("frames are dropped while the socket is closed", async () => {
  const { socket, sockets } = setup();
  assert.equal(socket.send({ type: "chat.typing" }), false);
  socket.start();
  await flush();
  assert.equal(socket.send({ type: "chat.typing" }), false, "still connecting");
  sockets[0].accept();
  assert.equal(socket.send({ type: "chat.typing" }), true);
});

test("a dropped socket reconnects after the backoff, each open a new epoch", async () => {
  const { socket, clock, sockets, opens } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  sockets[0].drop();
  assert.equal(socket.status(), "closed");
  assert.deepEqual(clock.pendingDelays().slice(-1), [1000]);
  await clock.advance(1000);
  assert.equal(sockets.length, 2);
  sockets[1].accept();
  assert.deepEqual(opens, [1, 2]);
});

test("attempts back off until a socket stays up a minute", async () => {
  const { socket, clock, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].drop();
  await clock.advance(1000);
  sockets[1].drop();
  assert.ok(clock.pendingDelays().includes(2000));
  await clock.advance(2000);
  sockets[2].accept();
  await clock.advance(STABLE_MS);
  sockets[2].drop();
  assert.ok(clock.pendingDelays().includes(1000), "the backoff started over");
});

test("ninety seconds of silence closes and reconnects", async () => {
  const { socket, clock, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  await clock.advance(SILENCE_MS - 1);
  sockets[0].deliver({ type: "ping" });
  await clock.advance(SILENCE_MS - 1);
  assert.equal(sockets.length, 1, "a frame reset the timer");
  await clock.advance(1);
  assert.notEqual(sockets[0].closed, null);
  assert.equal(socket.status(), "closed");
  await clock.advance(1000);
  assert.equal(sockets.length, 2);
});

test("close code 4401 means signed out: no reconnect", async () => {
  const { socket, clock, sockets, signedOut } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  sockets[0].drop(SIGNED_OUT_CLOSE);
  assert.equal(signedOut(), 1);
  await clock.advance(60_000);
  assert.equal(sockets.length, 1);
});

test("a ticket refused with 401 means signed out", async () => {
  const { socket, clock, sockets, signedOut } = setup({
    ticket: () => {
      throw { status: 401 };
    },
  });
  socket.start();
  await flush();
  assert.equal(signedOut(), 1);
  assert.equal(sockets.length, 0);
  await clock.advance(60_000);
  assert.equal(sockets.length, 0);
});

test("another ticket refusal retries after the backoff", async () => {
  const { socket, clock, sockets, tickets } = setup({
    ticket: (n) => {
      if (n === 1) throw { status: 503 };
      return `ticket-${n}`;
    },
  });
  socket.start();
  await flush();
  assert.equal(socket.status(), "closed");
  await clock.advance(1000);
  assert.equal(tickets(), 2);
  assert.equal(sockets.length, 1);
});

test("the online event reconnects at once", async () => {
  const { socket, clock, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].drop();
  await clock.advance(1000);
  sockets[1].drop();
  socket.reconnectNow();
  await flush();
  assert.equal(sockets.length, 3);
});

test("a visible tab probes a quiet socket and reconnects when nothing answers", async () => {
  const { socket, clock, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  await clock.advance(PROBE_AFTER_MS + 1);
  const probed = socket.probe();
  assert.deepEqual(sockets[0].sent, [{ type: "ping" }]);
  await clock.advance(PROBE_WAIT_MS);
  await probed;
  assert.equal(sockets.length, 2);
});

test("a probe answered in time keeps the socket", async () => {
  const { socket, clock, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  await clock.advance(PROBE_AFTER_MS + 1);
  const probed = socket.probe();
  sockets[0].deliver({ type: "pong", payload: {} });
  await clock.advance(PROBE_WAIT_MS);
  await probed;
  assert.equal(sockets.length, 1);
  assert.equal(socket.status(), "open");
});

test("a recent frame needs no probe", async () => {
  const { socket, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  await socket.probe();
  assert.deepEqual(sockets[0].sent, []);
});

test("suspend closes for the page cache, resume opens again", async () => {
  const { socket, clock, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  socket.suspend();
  assert.notEqual(sockets[0].closed, null);
  await clock.advance(60_000);
  assert.equal(sockets.length, 1, "no reconnect while suspended");
  socket.resume();
  await flush();
  assert.equal(sockets.length, 2);
});

test("stop closes and stays closed", async () => {
  const { socket, clock, sockets } = setup();
  socket.start();
  await flush();
  sockets[0].accept();
  socket.stop();
  assert.equal(socket.status(), "idle");
  await clock.advance(120_000);
  assert.equal(sockets.length, 1);
});
