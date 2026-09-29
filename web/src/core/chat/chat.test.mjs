/**
 * The chat of the web core wired together (`createChat`), against a fake
 * service and a clock the test moves: what a message that arrives does —
 * the toast, the system notification and the sound, the tab visible or not —
 * and how a send goes out, once, with its client id.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { networkError } from "../errors.ts";
import { EventBus } from "../events.ts";
import { memoryStorage } from "../storage.ts";
import { DEFAULT_CHAT_NOTIFICATIONS } from "../settings.ts";
import { createChat } from "./index.ts";
import { maySound, soundUrl } from "./sounds.ts";

const ME = "01HME000000000000000000000";
const KYLE = "01HKYLE0000000000000000000";
const DIRECT = "01HDIRECT00000000000000000";

function user(id) {
  return { id, displayName: id === ME ? "Me" : "Kyle", avatarUrl: null, provider: "dev", providerName: id, createdAt: "" };
}

function conversation(lastSeq = 1, notify = "all") {
  return {
    id: DIRECT,
    kind: "direct",
    title: null,
    members: [
      { user: user(ME), role: "member", joinedAt: "", readSeq: lastSeq },
      { user: user(KYLE), role: "member", joinedAt: "", readSeq: lastSeq },
    ],
    lastSeq,
    readSeq: lastSeq,
    unread: 0,
    unreadMentions: 0,
    notify,
    canSend: true,
    createdAt: "2026-09-28T10:00:00Z",
  };
}

function message(seq, sender = KYLE, extra = {}) {
  return {
    conversationId: DIRECT,
    seq,
    senderId: sender,
    kind: "user",
    body: `message ${seq}`,
    createdAt: `2026-09-28T10:00:${String(seq).padStart(2, "0")}Z`,
    mentions: [],
    ...extra,
  };
}

/** A clock whose timers run only when the test moves it. */
function manualClock(start = Date.parse("2026-09-28T12:00:00Z")) {
  let now = start;
  let next = 1;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(handler, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, handler, every: null });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval(handler, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, handler, every: ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === null) timers.delete(id);
        else timer.at += timer.every;
        timer.handler();
        await settle();
      }
      now = until;
      await settle();
    },
  };
  return clock;
}

/** Lets every promise the core started run to its end. */
async function settle() {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A chat core over a fake service. `routes` answers `METHOD path` with a
 * value or a function of the body; anything else is a 404.
 */
function harness({ visible = true, notifications = {}, pushSubscribed = false, routes = {}, storage = memoryStorage() } = {}) {
  const clock = manualClock();
  const events = new EventBus();
  const calls = [];
  const sounds = [];
  const shown = [];
  const closed = [];
  const emitted = [];
  const page = { visible };
  for (const name of ["chat:notify", "chat:message", "chat:outbox", "chat:resync", "chat:joinable"]) {
    events.on(name, (payload) => emitted.push({ name, payload }));
  }
  const http = {
    apiBase: "https://api.example.com",
    url: (path) => `https://api.example.com${path}`,
    async request(method, path, options = {}) {
      calls.push({ method, path, body: options.body });
      const key = `${method} ${path}`;
      if (!(key in routes)) throw Object.assign(new Error(`no route ${key}`), { code: "online", details: { code: "not_found" } });
      const answer = routes[key];
      return typeof answer === "function" ? answer(options.body, calls) : structuredClone(answer);
    },
    async send(method, path, options) {
      return { status: 200, data: await this.request(method, path, options) };
    },
  };
  const chat = createChat({
    http,
    events,
    storage,
    me: () => ME,
    signedIn: () => true,
    live: () => true,
    sendFrame: () => true,
    notifications: () => ({ ...DEFAULT_CHAT_NOTIFICATIONS, ...notifications }),
    pushSubscribed: () => pushSubscribed,
    texts: () => ({ newMessage: "New message", deletedAccount: "Deleted account" }),
    openExternal: async () => undefined,
    clock,
    page: {
      visible: () => page.visible,
      online: () => true,
      playSound: (name, mentioned) => sounds.push({ name, mentioned }),
      showNotification: (title, options) => shown.push({ title, ...options }),
      closeNotifications: (tag) => closed.push(tag),
    },
  });
  return { chat, clock, calls, sounds, shown, closed, emitted, page, storage };
}

/** Starts the core and reads the sync document with one direct chat. */
async function synced(options = {}) {
  const run = harness({
    ...options,
    routes: {
      "GET /v1/chat/conversations": { conversations: [conversation(1, options.notify)], groupInvites: [] },
      ...(options.routes ?? {}),
    },
  });
  await run.chat.start();
  run.chat.connected();
  await settle();
  assert.equal(run.chat.synced(), true);
  return run;
}

function arrive(chat, seq, extra = {}) {
  chat.handleFrame({ type: "chat.message", payload: { message: message(seq, KYLE, extra) } });
}

describe("what a message that arrives does", () => {
  test("a hidden tab plays the sound and shows the system notification", async () => {
    const { chat, sounds, shown, emitted } = await synced({ visible: false });
    arrive(chat, 2);
    await settle();
    assert.deepEqual(sounds, [{ name: "default", mentioned: false }]);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].tag, `c:${DIRECT}`);
    assert.equal(shown[0].url, `/c/${DIRECT}`);
    assert.equal(emitted.filter((event) => event.name === "chat:notify").length, 0, "no toast in a hidden tab");
  });

  test("a visible tab plays the sound with the toast, and no system notification", async () => {
    const { chat, sounds, shown, emitted } = await synced({ visible: true });
    arrive(chat, 2);
    await settle();
    assert.deepEqual(sounds, [{ name: "default", mentioned: false }]);
    assert.equal(shown.length, 0);
    const toast = emitted.find((event) => event.name === "chat:notify");
    assert.equal(toast?.payload.conversationId, DIRECT);
    assert.equal(toast?.payload.text, "message 2");
  });

  test("the chosen set plays, the mention sound for a mention", async () => {
    const { chat, sounds, clock } = await synced({ visible: false, notifications: { soundName: "saber" } });
    arrive(chat, 2, { mentions: [ME] });
    await settle();
    await clock.advance(1_500);
    arrive(chat, 3);
    await settle();
    assert.deepEqual(sounds, [
      { name: "saber", mentioned: true },
      { name: "saber", mentioned: false },
    ]);
  });

  test("the sound switch off keeps the page silent, the rest still notifies", async () => {
    const { chat, sounds, shown } = await synced({ visible: false, notifications: { sound: false } });
    arrive(chat, 2);
    await settle();
    assert.deepEqual(sounds, []);
    assert.equal(shown.length, 1);
  });

  test("a burst of messages is one chime", async () => {
    const { chat, sounds } = await synced({ visible: false });
    arrive(chat, 2);
    arrive(chat, 3);
    arrive(chat, 4);
    await settle();
    assert.equal(sounds.length, 1);
  });

  test("with a push subscription the page shows no system notification, but still plays", async () => {
    const { chat, sounds, shown } = await synced({ visible: false, pushSubscribed: true });
    arrive(chat, 2);
    await settle();
    assert.equal(shown.length, 0, "push is the one system notification");
    assert.equal(sounds.length, 1);
  });

  test("the conversation on screen, a muted one and my own message make no sound", async () => {
    const viewed = await synced({ visible: true, routes: { [`POST /v1/chat/conversations/${DIRECT}/read`]: { readSeq: 2 } } });
    await viewed.chat.setViewing({ conversationId: DIRECT, focused: true, atBottom: true, composer: true });
    arrive(viewed.chat, 2);
    await settle();
    assert.deepEqual(viewed.sounds, []);

    const muted = await synced({ visible: false, notify: "mute" });
    arrive(muted.chat, 2);
    await settle();
    assert.deepEqual(muted.sounds, []);

    const own = await synced({ visible: false });
    own.chat.handleFrame({ type: "chat.message", payload: { message: message(2, ME) } });
    await settle();
    assert.deepEqual(own.sounds, []);
  });

  test("do not disturb holds the sound unless a mention breaks through", async () => {
    const quiet = await synced({ visible: false, notifications: { dnd: true } });
    arrive(quiet.chat, 2);
    await settle();
    assert.deepEqual(quiet.sounds, []);

    const breaking = await synced({ visible: false, notifications: { dnd: true, mentionsBreakDnd: true } });
    arrive(breaking.chat, 2, { mentions: [ME] });
    await settle();
    assert.deepEqual(breaking.sounds, [{ name: "default", mentioned: true }]);
  });
});

describe("sending", () => {
  test("a send goes out with its client id and the answer settles the queue", async () => {
    const { chat, calls, storage } = await synced({
      routes: {
        [`POST /v1/chat/conversations/${DIRECT}/messages`]: (body) => message(2, ME, { body: body.body, clientId: body.clientId }),
      },
    });
    const clientId = await chat.send(DIRECT, { body: "hello" });
    assert.match(clientId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    await settle();
    const posts = calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { clientId, body: "hello" });
    assert.deepEqual(chat.view().outbox, []);
    assert.equal(chat.view().conversations[0].lastSeq, 2);
    assert.deepEqual(await storage.entries("outbox"), [], "a settled entry leaves IndexedDB");
  });

  test("a lost answer is sent again with the same client id after the backoff", async () => {
    let attempts = 0;
    const { chat, calls, clock } = await synced({
      routes: {
        [`POST /v1/chat/conversations/${DIRECT}/messages`]: (body) => {
          attempts += 1;
          if (attempts === 1) throw networkError("connection reset");
          return message(2, ME, { body: body.body, clientId: body.clientId });
        },
      },
    });
    const clientId = await chat.send(DIRECT, { body: "once" });
    await settle();
    assert.equal(chat.view().outbox[0]?.status, "queued", "waits for its next attempt");
    await clock.advance(1_000);
    const posts = calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"));
    assert.deepEqual(
      posts.map((call) => call.body.clientId),
      [clientId, clientId],
    );
    assert.deepEqual(chat.view().outbox, []);
  });

  test("messages of one conversation go out one at a time, in order", async () => {
    const order = [];
    let release = null;
    const { chat } = await synced({
      routes: {
        [`POST /v1/chat/conversations/${DIRECT}/messages`]: async (body) => {
          order.push(body.body);
          if (release === null) await new Promise((resolve) => (release = resolve));
          return message(1 + order.length, ME, { body: body.body, clientId: body.clientId });
        },
      },
    });
    await chat.send(DIRECT, { body: "first" });
    await chat.send(DIRECT, { body: "second" });
    await chat.send(DIRECT, { body: "third" });
    await settle();
    assert.deepEqual(order, ["first"], "the rest wait for the head");
    release();
    await settle();
    assert.deepEqual(order, ["first", "second", "third"]);
    assert.deepEqual(chat.view().outbox, []);
  });
});

describe("keeping in step with the service", () => {
  const SYNC = "GET /v1/chat/conversations";

  test("a failed sync document is read again while the socket stays up", async () => {
    let answers = 0;
    const run = harness({
      routes: {
        [SYNC]: () => {
          answers += 1;
          if (answers <= 4) throw networkError("timed out");
          return { conversations: [conversation(1)], groupInvites: [] };
        },
      },
    });
    await run.chat.start();
    run.chat.connected();
    await settle();
    await run.clock.advance(2_000);
    assert.equal(run.chat.synced(), false, "the socket open, the first timer and a retry failed");
    await run.clock.advance(60_000);
    assert.equal(run.chat.synced(), true, "a retry came without the socket dropping");
    const gets = run.calls.filter((call) => call.method === "GET" && call.path === "/v1/chat/conversations").length;
    assert.equal(gets, 5);
    await run.clock.advance(10 * 60_000);
    assert.equal(
      run.calls.filter((call) => call.method === "GET" && call.path === "/v1/chat/conversations").length,
      5,
      "no retry once a document arrived",
    );
  });

  test("a message that lands while the sync document is on its way is not undone by it", async () => {
    let release = null;
    let held = false;
    // What the service holds when it computes the document.
    let serviceSeq = 2;
    const run = await synced({
      visible: false,
      routes: {
        [SYNC]: async () => {
          const seq = serviceSeq;
          if (held) await new Promise((resolve) => (release = resolve));
          return { conversations: [conversation(seq)], groupInvites: [] };
        },
      },
    });
    held = true;
    run.chat.connected();
    await settle();
    // Message 3 is stored after the document was computed, and its frame
    // comes before the answer.
    serviceSeq = 3;
    arrive(run.chat, 3);
    await settle();
    assert.equal(run.chat.view().conversations[0].lastSeq, 3);
    release();
    await settle();
    // The stale document is dropped and read again; the second answer is held too.
    assert.equal(run.chat.view().conversations[0].lastSeq, 3, "the book keeps message 3");
    held = false;
    release();
    await settle();
    const resets = run.emitted.filter((event) => event.name === "chat:resync").flatMap((event) => event.payload.reset);
    assert.deepEqual(resets, [], "nothing counts as a restored database");
  });

  test("after another tab took over, the next start reads the queue and the drafts from IndexedDB", async () => {
    const storage = memoryStorage();
    const run = harness({
      storage,
      routes: {
        [SYNC]: { conversations: [conversation(1)], groupInvites: [] },
        [`POST /v1/chat/conversations/${DIRECT}/messages`]: () => {
          throw networkError("offline");
        },
      },
    });
    await run.chat.start();
    run.chat.connected();
    await settle();
    await run.chat.setDraft(DIRECT, "half a thought");
    await run.chat.send(DIRECT, { body: "queued" });
    await settle();
    assert.equal(run.chat.view().outbox.length, 1);

    run.chat.stop();
    await settle();
    // The other tab sent the draft and discarded the queued message.
    for (const { key } of await storage.entries("outbox")) await storage.delete("outbox", key);
    for (const { key } of await storage.entries("drafts")) await storage.delete("drafts", key);

    const postsBefore = run.calls.filter((call) => call.method === "POST").length;
    await run.chat.start();
    run.chat.connected();
    await settle();
    await run.clock.advance(60_000);
    assert.equal(await run.chat.getDraft(DIRECT), "", "the draft sent elsewhere does not come back");
    assert.deepEqual(run.chat.view().outbox, [], "the discarded message does not come back");
    assert.equal(run.calls.filter((call) => call.method === "POST").length, postsBefore, "and is never sent");
  });

  test("a message queued just before another tab takes over still reaches IndexedDB", async () => {
    const storage = memoryStorage();
    const run = harness({
      storage,
      routes: {
        [SYNC]: { conversations: [conversation(1)], groupInvites: [] },
        [`POST /v1/chat/conversations/${DIRECT}/messages`]: () => {
          throw networkError("offline");
        },
      },
    });
    await run.chat.start();
    run.chat.connected();
    await settle();
    await run.chat.send(DIRECT, { body: "right before" });
    run.chat.stop();
    await settle();
    const rows = await storage.entries("outbox");
    assert.equal(rows.length, 1, "the tab that takes over finds it");
    assert.equal(rows[0].value.draft.body, "right before");
  });

  test("reading a conversation closes its system notifications", async () => {
    const run = await synced({ visible: false, routes: { [`POST /v1/chat/conversations/${DIRECT}/read`]: { readSeq: 2 } } });
    arrive(run.chat, 2);
    await settle();
    assert.deepEqual(run.closed, []);
    await run.chat.markRead(DIRECT);
    await settle();
    assert.deepEqual(run.closed, [`c:${DIRECT}`]);
  });

  test("leaving a server chat tells the joinable list to refresh", async () => {
    const server = {
      ...conversation(1),
      kind: "server",
      server: { sessionId: "01HSESSION0000000000000000", hostId: KYLE, name: "Duel", game: "ja", ended: false },
    };
    const run = harness({
      routes: {
        [SYNC]: { conversations: [server], groupInvites: [] },
        [`DELETE /v1/chat/conversations/${DIRECT}/members/${ME}`]: undefined,
      },
    });
    await run.chat.start();
    run.chat.connected();
    await settle();
    await run.chat.leave(DIRECT);
    assert.equal(run.emitted.filter((event) => event.name === "chat:joinable").length, 1);
  });
});

describe("the sound files", () => {
  test("each set has a message and a mention sound, the default for an unknown set", () => {
    assert.equal(soundUrl("default", false), "/sounds/default-message.wav");
    assert.equal(soundUrl("saber", true), "/sounds/saber-mention.wav");
    assert.equal(soundUrl("comlink", false), "/sounds/comlink-message.wav");
    assert.equal(soundUrl("newer-set", true), "/sounds/default-mention.wav");
  });

  test("a browser driven by automation never makes a sound", () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, "Audio");
    const navigatorHad = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "Audio", { value: class {}, configurable: true, writable: true });
      Object.defineProperty(globalThis, "navigator", { value: { webdriver: true }, configurable: true, writable: true });
      assert.equal(maySound(), false);
      Object.defineProperty(globalThis, "navigator", { value: { webdriver: false }, configurable: true, writable: true });
      assert.equal(maySound(), true);
    } finally {
      if (had === undefined) delete globalThis.Audio;
      else Object.defineProperty(globalThis, "Audio", had);
      if (navigatorHad !== undefined) Object.defineProperty(globalThis, "navigator", navigatorHad);
    }
  });
});
