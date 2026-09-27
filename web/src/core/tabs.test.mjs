import assert from "node:assert/strict";
import { test } from "node:test";

import { createTabGate } from "./tabs.ts";

/**
 * Web Locks for one lock name, shared by the "tabs" of a test. Like a
 * browser, it decides a request after the call returns, so two calls in a
 * row both run before either is granted.
 */
function fakeLocks() {
  let held = false;
  const queue = [];
  const stats = { requests: 0 };
  const grant = async (callback) => {
    held = true;
    try {
      await callback({ name: "jknet-active" });
    } finally {
      held = false;
      const next = queue.shift();
      if (next !== undefined) void grant(next.callback).then(next.resolve);
    }
  };
  return {
    stats,
    async request(_name, options, callback) {
      stats.requests += 1;
      await Promise.resolve();
      if (!held) return grant(callback);
      if (options.ifAvailable) return callback(null);
      return new Promise((resolve) => queue.push({ callback, resolve }));
    },
  };
}

/** A broadcast channel between the gates of a test; the sender does not hear itself. */
function fakeChannels() {
  const members = [];
  return () => {
    const listeners = [];
    const me = {
      postMessage(message) {
        for (const other of members) {
          if (other !== me) for (const listener of other.listeners) queueMicrotask(() => listener({ data: message }));
        }
      },
      addEventListener(_type, listener) {
        listeners.push(listener);
      },
      listeners,
    };
    members.push(me);
    return me;
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the first tab gets the lock, the second is told it is elsewhere", async () => {
  const locks = fakeLocks();
  const channel = fakeChannels();
  const first = createTabGate({ locks, channel: channel(), release: async () => {} });
  const second = createTabGate({ locks, channel: channel(), release: async () => {} });
  assert.equal(await first.tryAcquire(), true);
  assert.equal(await second.tryAcquire(), false);
  assert.equal(first.active(), true);
  assert.equal(second.active(), false);
});

test("Open here stops the holder and moves the lock", async () => {
  const locks = fakeLocks();
  const channel = fakeChannels();
  const stopped = [];
  const first = createTabGate({ locks, channel: channel(), release: async () => stopped.push("first") });
  const second = createTabGate({ locks, channel: channel(), release: async () => {} });
  const lost = [];
  first.subscribe((event) => lost.push(event));
  await first.tryAcquire();
  await second.tryAcquire();
  await second.takeOver();
  await tick();
  assert.deepEqual(stopped, ["first"]);
  assert.deepEqual(lost, ["lost"]);
  assert.equal(first.active(), false);
  assert.equal(second.active(), true);
});

test("overlapping acquires in one tab share one request and both get the lock", async () => {
  // React runs the gate's effect twice in development, before either request is granted.
  const locks = fakeLocks();
  const channel = fakeChannels();
  const gate = createTabGate({ locks, channel: channel(), release: async () => {} });
  const answers = await Promise.all([gate.tryAcquire(), gate.tryAcquire()]);
  assert.deepEqual(answers, [true, true]);
  assert.equal(locks.stats.requests, 1);
  assert.equal(gate.active(), true);
  // The lock is really held: another tab is still refused.
  const other = createTabGate({ locks, channel: channel(), release: async () => {} });
  assert.equal(await other.tryAcquire(), false);
});

test("Open here in the tab that holds or is getting the lock asks nobody", async () => {
  const locks = fakeLocks();
  const channel = fakeChannels();
  const gate = createTabGate({ locks, channel: channel(), release: async () => {} });
  const heard = [];
  channel().addEventListener("message", (event) => heard.push(event.data));
  // The acquire still in flight when Open here comes grants the lock.
  const acquired = gate.tryAcquire();
  await gate.takeOver();
  assert.equal(await acquired, true);
  // Open here once more, now that the lock is held.
  await gate.takeOver();
  await tick();
  assert.equal(locks.stats.requests, 1);
  assert.deepEqual(heard, []);
  assert.equal(gate.active(), true);
});

test("Open here pressed twice queues one request and stops the holder once", async () => {
  const locks = fakeLocks();
  const channel = fakeChannels();
  const stopped = [];
  const first = createTabGate({ locks, channel: channel(), release: async () => stopped.push("first") });
  const second = createTabGate({ locks, channel: channel(), release: async () => {} });
  await first.tryAcquire();
  await second.tryAcquire();
  const before = locks.stats.requests;
  await Promise.all([second.takeOver(), second.takeOver()]);
  await tick();
  assert.equal(locks.stats.requests, before + 1);
  assert.deepEqual(stopped, ["first"]);
  assert.equal(first.active(), false);
  assert.equal(second.active(), true);
});

test("an acquire during a takeover answers with the takeover's outcome", async () => {
  const locks = fakeLocks();
  const channel = fakeChannels();
  const first = createTabGate({ locks, channel: channel(), release: async () => {} });
  const second = createTabGate({ locks, channel: channel(), release: async () => {} });
  await first.tryAcquire();
  await second.tryAcquire();
  const [, granted] = await Promise.all([second.takeOver(), second.tryAcquire()]);
  assert.equal(granted, true);
  assert.equal(second.active(), true);
});

test("two takeover requests stop the holder once", async () => {
  const locks = fakeLocks();
  const channel = fakeChannels();
  const stopped = [];
  const first = createTabGate({ locks, channel: channel(), release: async () => stopped.push("first") });
  const second = createTabGate({ locks, channel: channel(), release: async () => {} });
  const third = createTabGate({ locks, channel: channel(), release: async () => {} });
  await first.tryAcquire();
  // The lock goes to the first tab in the queue; the other keeps waiting.
  await Promise.race([second.takeOver(), third.takeOver()]);
  await tick();
  assert.deepEqual(stopped, ["first"]);
  assert.equal(first.active(), false);
  assert.equal(second.active() !== third.active(), true);
});

test("a sign-out in one tab reaches the others", async () => {
  const channel = fakeChannels();
  const first = createTabGate({ locks: fakeLocks(), channel: channel(), release: async () => {} });
  const second = createTabGate({ locks: fakeLocks(), channel: channel(), release: async () => {} });
  const heard = [];
  second.subscribe((event) => heard.push(event));
  first.announceSignOut();
  await tick();
  assert.deepEqual(heard, ["signedOut"]);
});

test("without Web Locks every tab runs", async () => {
  const gate = createTabGate({ locks: null, channel: null, release: async () => {} });
  const other = createTabGate({ locks: null, channel: null, release: async () => {} });
  assert.equal(gate.active(), true);
  assert.equal(await gate.tryAcquire(), true);
  assert.equal(await other.tryAcquire(), true);
});
