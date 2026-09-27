/**
 * The chat of the web core against a real JKNet Online: two, then three
 * players, each with a whole web core (`createWebCore`) — HTTP, the ticket,
 * the live socket, the send queue — driven through the commands the screens
 * send, the way `lib/ipc.ts` names them.
 *
 * Not part of `web:test` or CI. It needs the service running locally with
 * the developer provider (`JKNET_ONLINE_DEV_PROVIDER=1`); its address is
 * `JKNET_WEB_TEST_API`, by default `http://127.0.0.1:8787`, the service the
 * launcher's online tests use. Run with `npm run web:test:online`.
 *
 * Node has `fetch` and `WebSocket` but no page: the few page objects the core
 * listens to are stood in for below, and the tab gate's broadcast channel is
 * left out, as in a browser without one.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

const API = (process.env.JKNET_WEB_TEST_API ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
/** The page the core pretends to run in: the e2e preview's origin, which the developer service lets in. */
const ORIGIN = "http://127.0.0.1:5175";

// The page around the core: a visible tab, events that never fire.
globalThis.window ??= new EventTarget();
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
// One core per player in one process: a shared broadcast channel would tell
// every other player about one player's sign-out, and keep Node running.
delete globalThis.BroadcastChannel;
// A browser sends its page's origin with the socket, and the service opens a
// ticket's socket only for a web origin; Node's WebSocket has no page.
const NodeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, { protocols, headers: { origin: ORIGIN } });
  }
};

const { createWebCore } = await import("../index.ts");
const { loadPrefs } = await import("../prefs.ts");
const { memoryStorage } = await import("../storage.ts");

/** Every core the run started, stopped at the end. */
const cores = [];
/** Frames a core could not read: the wire of the service and the core's parser disagree. */
const unreadable = [];

const originalDebug = console.debug;
console.debug = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("unreadable ")) unreadable.push(args.map(String).join(" "));
  else originalDebug(...args);
};

function uniqueName(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

async function waitFor(what, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function answer(response, what) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what}: ${response.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
}

/**
 * Signs a player in with the developer provider, as the web app does, and
 * answers the token and the account. A client address of its own spares the
 * service's per-address sign-in limit.
 */
async function devSignIn(name) {
  const headers = { "content-type": "application/json", "x-forwarded-for": `203.0.113.${1 + Math.floor(Math.random() * 254)}` };
  const session = await answer(
    await fetch(`${API}/v1/auth/login-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "dev", deviceName: "JKNet web · online test", device: "desktop", client: "web" }),
    }),
    "a login session",
  );
  const form = await (await fetch(session.url, { headers })).text();
  const state = /name="state" value="([^"]+)"/.exec(form)?.[1];
  assert.ok(state, "the developer sign-in form carries its state");
  const callback = await fetch(
    `${API}/v1/auth/dev/callback?state=${encodeURIComponent(state)}&name=${encodeURIComponent(name)}`,
    { headers, redirect: "manual" },
  );
  assert.ok(callback.status < 400, `the developer sign-in went through (${callback.status})`);
  const done = await answer(await fetch(`${API}/v1/auth/login-sessions/${session.id}`, { headers }), "the finished session");
  assert.equal(done.status, "done");
  return { token: done.token, user: done.user };
}

/**
 * One player: a signed-in web core with its own storage, started, its
 * socket open and its first sync document read. `events` keeps every
 * event the core sent, by name.
 */
async function player(prefix, storage = memoryStorage()) {
  const name = uniqueName(prefix);
  const { token, user } = await devSignIn(name);
  return open({ name, token, user, storage });
}

async function open({ name, token, user, storage }) {
  await storage.put("session", "current", { token, userId: user.id, apiBase: API, createdAt: new Date().toISOString(), user });
  const prefs = await loadPrefs(storage);
  const core = createWebCore({
    apiBase: API,
    storage,
    prefs,
    device: { kind: () => "desktop", name: () => "JKNet web · online test" },
    origin: ORIGIN,
  });
  cores.push(core);
  const events = new Map();
  for (const event of [
    "chat:state",
    "chat:message",
    "chat:read",
    "chat:typing",
    "chat:reaction",
    "chat:outbox",
    "chat:removed",
    "chat:resync",
  ]) {
    events.set(event, []);
    core.events.on(event, (payload) => events.get(event).push(payload));
  }
  await core.start();
  await waitFor(`${name}'s socket`, () => core.socketStatus() === "open");
  await waitFor(`${name}'s first sync`, () => core.chat.synced());
  return { name, token, user, storage, core, events, invoke: (command, args) => core.invoke(command, args) };
}

/** Makes two players friends: each asks the other, the second request accepts the first. */
async function befriend(a, b) {
  await a.invoke("send_friend_request", { query: b.name });
  const answered = await b.invoke("send_friend_request", { query: a.name });
  assert.equal(answered.outcome, "accepted");
}

function conversationOf(p, id) {
  return p.core.chat.view().conversations.find((conversation) => conversation.id === id);
}

function messagesOf(p, conversationId) {
  return p.events.get("chat:message").filter((message) => message.conversationId === conversationId);
}

before(async () => {
  let health;
  try {
    health = await fetch(`${API}/healthz`);
  } catch (error) {
    throw new Error(
      `No JKNet Online at ${API} (${error.message}). Start the service locally with JKNET_ONLINE_DEV_PROVIDER=1, ` +
        "or point JKNET_WEB_TEST_API at one.",
    );
  }
  assert.ok(health.ok, `${API}/healthz answers ${health.status}`);
});

after(async () => {
  for (const core of cores) await core.stop().catch(() => undefined);
  console.debug = originalDebug;
});

describe("the web core's chat against JKNet Online", () => {
  let kyle;
  let jan;
  let direct;

  before(async () => {
    kyle = await player("Kyle");
    jan = await player("Jan");
    await befriend(kyle, jan);
    direct = await kyle.invoke("chat_open_direct", { userId: jan.user.id });
  });

  test("a message goes out once, reaches the friend live and comes back read", async () => {
    const clientId = await kyle.invoke("chat_send", { conversationId: direct.id, draft: { body: "Hello from the web core" } });
    const arrived = await waitFor("Jan's message", () =>
      messagesOf(jan, direct.id).find((message) => message.clientId === clientId),
    );
    assert.equal(arrived.body, "Hello from the web core");
    assert.equal(arrived.senderId, kyle.user.id);
    await waitFor("Kyle's queue to empty", () => kyle.core.chat.view().outbox.length === 0);
    assert.equal(conversationOf(kyle, direct.id).lastSeq, arrived.seq);
    await waitFor("Jan's unread count", () => conversationOf(jan, direct.id)?.unread === 1);

    // Jan reads it on screen: one marker a second later, and Kyle sees it.
    await jan.invoke("chat_set_viewing", { conversationId: direct.id, focused: true, atBottom: true, composer: true });
    assert.equal(conversationOf(jan, direct.id).unread, 0, "read here at once");
    const read = await waitFor("Kyle's read frame", () =>
      kyle.events.get("chat:read").find((mark) => mark.userId === jan.user.id && mark.seq >= arrived.seq),
    );
    assert.equal(read.conversationId, direct.id);
    const member = conversationOf(kyle, direct.id).members.find((entry) => entry.user.id === jan.user.id);
    assert.ok(member.readSeq >= arrived.seq);
    await jan.invoke("chat_set_viewing", { conversationId: null });
  });

  test("a queued message whose answer was lost is stored once", async () => {
    const clientId = await kyle.invoke("chat_send", { conversationId: direct.id, draft: { body: "exactly once" } });
    const first = await waitFor("the first delivery", () =>
      messagesOf(jan, direct.id).find((message) => message.clientId === clientId),
    );

    // The same entry, as a reload finds it when the answer never came: the
    // row is still in IndexedDB. A second core of Kyle's resumes it.
    const storage = memoryStorage();
    await storage.put("outbox", clientId, {
      clientId,
      conversationId: direct.id,
      draft: { body: "exactly once", cards: [], attachments: [], replySeq: null },
      files: [],
      status: "sending",
      attempts: 1,
      firstTryAt: new Date().toISOString(),
      onlineMs: 500,
      createdAt: new Date().toISOString(),
    });
    const again = await open({ ...kyle, name: `${kyle.name} (reload)`, storage });
    await waitFor("the resumed entry to settle", () => again.core.chat.view().outbox.length === 0);
    assert.deepEqual(await storage.entries("outbox"), [], "the settled row leaves the database");

    const page = await kyle.invoke("chat_get_messages", { conversationId: direct.id, limit: 50 });
    const stored = page.messages.filter((message) => message.clientId === clientId);
    assert.equal(stored.length, 1, "the service kept one message for the client id");
    assert.equal(stored[0].seq, first.seq);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(messagesOf(jan, direct.id).filter((message) => message.clientId === clientId).length, 1);
    await again.core.stop();
  });

  test("messages written in a burst arrive in order", async () => {
    const bodies = ["one", "two", "three", "four"];
    const ids = [];
    for (const body of bodies) ids.push(await kyle.invoke("chat_send", { conversationId: direct.id, draft: { body } }));
    await waitFor("the whole burst", () => ids.every((id) => messagesOf(jan, direct.id).some((message) => message.clientId === id)));
    const seqs = ids.map((id) => messagesOf(jan, direct.id).find((message) => message.clientId === id).seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "sequence numbers follow the order of writing");
  });

  test("typing reaches the friend, one hint per three seconds", async () => {
    const before = jan.events.get("chat:typing").length;
    await kyle.invoke("chat_typing", { conversationId: direct.id });
    await kyle.invoke("chat_typing", { conversationId: direct.id });
    const hint = await waitFor("Jan's typing event", () =>
      jan.events.get("chat:typing").slice(before).find((event) => event.userIds.includes(kyle.user.id)),
    );
    assert.equal(hint.conversationId, direct.id);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const shown = jan.events.get("chat:typing").slice(before).filter((event) => event.userIds.includes(kyle.user.id));
    assert.equal(shown.length, 1, "the second hint within 3 s never left Kyle's core");
    assert.equal(kyle.events.get("chat:typing").some((event) => event.userIds.includes(kyle.user.id)), false, "nobody sees themselves type");
  });

  test("a reaction and a reply travel both ways", async () => {
    const clientId = await jan.invoke("chat_send", { conversationId: direct.id, draft: { body: "react to me" } });
    const message = await waitFor("Kyle's copy", () => messagesOf(kyle, direct.id).find((entry) => entry.clientId === clientId));
    const groups = await kyle.invoke("chat_react", { conversationId: direct.id, seq: message.seq, emoji: "👍", on: true });
    assert.deepEqual(groups, [{ emoji: "👍", userIds: [kyle.user.id] }]);
    const change = await waitFor("Jan's reaction frame", () =>
      jan.events.get("chat:reaction").find((entry) => entry.seq === message.seq && entry.userId === kyle.user.id),
    );
    assert.equal(change.on, true);

    const replyId = await kyle.invoke("chat_send", { conversationId: direct.id, draft: { body: "a reply", replySeq: message.seq } });
    const reply = await waitFor("Jan's reply", () => messagesOf(jan, direct.id).find((entry) => entry.clientId === replyId));
    assert.equal(reply.replyTo?.seq, message.seq);
    assert.equal(reply.replyTo?.senderId, jan.user.id);
  });

  test("search finds a message by its words", async () => {
    const clientId = await kyle.invoke("chat_send", { conversationId: direct.id, draft: { body: "the holocron is under the floor" } });
    await waitFor("the message to be stored", () => kyle.core.chat.view().outbox.length === 0);
    const page = await waitFor("a search hit", async () => {
      const found = await jan.invoke("chat_search", { q: "holocron" });
      return found.results.length > 0 ? found : null;
    });
    assert.ok(page.results.some((hit) => hit.message.clientId === clientId));
    await assert.rejects(jan.invoke("chat_search", { q: "   " }), (error) => error.code === "invalidInput");
  });

  test("read receipts switched off both ways, and back", async () => {
    const privacy = await jan.invoke("chat_update_privacy", { patch: { shareReadReceipts: false } });
    assert.equal(privacy.shareReadReceipts, false);
    // The switch flipped: the core reads the whole document again (D8).
    await waitFor("Jan's resync", () => jan.core.chat.view().privacy?.shareReadReceipts === false);
    const clientId = await kyle.invoke("chat_send", { conversationId: direct.id, draft: { body: "unseen" } });
    const arrived = await waitFor("Jan's copy", () => messagesOf(jan, direct.id).find((message) => message.clientId === clientId));
    const reads = kyle.events.get("chat:read").length;
    await jan.invoke("chat_set_viewing", { conversationId: direct.id, focused: true, atBottom: true, composer: true });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(
      kyle.events.get("chat:read").slice(reads).some((mark) => mark.userId === jan.user.id && mark.seq >= arrived.seq),
      false,
      "Kyle does not see Jan read",
    );
    await jan.invoke("chat_set_viewing", { conversationId: null });
    const back = await jan.invoke("chat_update_privacy", { patch: { shareReadReceipts: true } });
    assert.equal(back.shareReadReceipts, true);
  });
});

describe("groups against JKNet Online", () => {
  test("a group is made, renamed, joined by invitation and left", async () => {
    const mara = await player("Mara");
    const bast = await player("Bast");
    const cade = await player("Cade");
    await befriend(mara, bast);
    await befriend(mara, cade);
    await cade.invoke("chat_update_privacy", { patch: { groupAdd: "ask" } });

    const made = await mara.invoke("chat_create_group", { title: "Clan night", memberIds: [bast.user.id, cade.user.id] });
    const id = made.conversation.id;
    assert.deepEqual(made.added, [bast.user.id]);
    assert.deepEqual(made.invited, [cade.user.id]);
    await waitFor("Bast's copy of the group", () => conversationOf(bast, id)?.title === "Clan night");
    await waitFor("Cade's invitation", () => cade.core.chat.view().groupInvites.some((invite) => invite.conversationId === id));

    await mara.invoke("chat_rename_group", { conversationId: id, title: "Clan nights" });
    await waitFor("the new title at Bast's", () => conversationOf(bast, id)?.title === "Clan nights");

    const joined = await cade.invoke("chat_answer_group_invite", { conversationId: id, accept: true });
    assert.equal(joined.id, id);
    assert.equal(cade.core.chat.view().groupInvites.some((invite) => invite.conversationId === id), false);
    await waitFor("Cade among Mara's members", () =>
      conversationOf(mara, id)?.members.some((member) => member.user.id === cade.user.id),
    );

    await mara.invoke("chat_remove_member", { conversationId: id, userId: cade.user.id });
    await waitFor("the group to leave Cade's list", () => conversationOf(cade, id) === undefined);
    assert.ok(cade.events.get("chat:removed").some((removal) => removal.conversationId === id));

    await bast.invoke("chat_leave", { conversationId: id });
    assert.equal(conversationOf(bast, id), undefined);
    await waitFor("Bast gone from Mara's members", () =>
      !conversationOf(mara, id)?.members.some((member) => member.user.id === bast.user.id),
    );
  });
});

describe("the wire", () => {
  test("every frame the service sent was readable", () => {
    assert.deepEqual(unreadable, []);
  });
});
