import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NEEDS_LAUNCHER } from "./errors.ts";
import { EVENTS, EventBus } from "./events.ts";
import { cleanQuery, createFriends, openInvites, signedOutView, webPresence } from "./friends.ts";
import { createHttp } from "./http.ts";
import { neutralAnswer } from "./neutral.ts";
import { createRouter, createStats } from "./router.ts";

test("every event name is the one lib/ipc.ts uses", () => {
  const ipc = readFileSync(new URL("../../../src/lib/ipc.ts", import.meta.url), "utf8");
  for (const name of Object.values(EVENTS)) {
    assert.ok(ipc.includes(`"${name}"`), `${name} is not in lib/ipc.ts`);
  }
});

test("a throwing listener does not stop the others", () => {
  const bus = new EventBus();
  const heard = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    bus.on("x", () => {
      throw new Error("boom");
    });
    const off = bus.on("x", (payload) => heard.push(payload));
    bus.emit("x", 1);
    off();
    bus.emit("x", 2);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(heard, [1]);
});

function fetchAnswering(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

test("requests carry the token in the header and nowhere else", async () => {
  const { calls, fetchImpl } = fetchAnswering(200, { ok: true });
  const http = createHttp({ apiBase: "https://api.example.com/", token: () => "T", onUnauthorized: () => {}, fetchImpl });
  assert.deepEqual(await http.request("GET", "/v1/friends"), { ok: true });
  assert.equal(calls[0].url, "https://api.example.com/v1/friends");
  assert.equal(calls[0].init.headers.Authorization, "Bearer T");
  assert.equal(calls[0].init.credentials, "omit");
});

test("a refusal becomes the contract's code", async () => {
  const { fetchImpl } = fetchAnswering(409, { error: { code: "conflict", message: "Name taken" } });
  const http = createHttp({ apiBase: "https://api.example.com", token: () => "T", onUnauthorized: () => {}, fetchImpl });
  await assert.rejects(http.request("PATCH", "/v1/me", { body: {} }), (error) => {
    assert.equal(error.code, "online");
    assert.equal(error.message, "online conflict: Name taken");
    assert.equal(error.details.status, 409);
    return true;
  });
});

test("a 401 with the token reports it; the sign-in routes never do", async () => {
  let reported = 0;
  const { fetchImpl } = fetchAnswering(401, { error: { code: "unauthorized", message: "no" } });
  const http = createHttp({
    apiBase: "https://api.example.com",
    token: () => "T",
    onUnauthorized: () => {
      reported += 1;
    },
    fetchImpl,
  });
  await assert.rejects(http.request("GET", "/v1/friends"));
  assert.equal(reported, 1);
  await assert.rejects(http.request("POST", "/v1/auth/logout"));
  await assert.rejects(http.request("GET", "/v1/auth/login-sessions/x", { auth: false }));
  assert.equal(reported, 1);
});

test("a call without a token never leaves the browser", async () => {
  const { calls, fetchImpl } = fetchAnswering(200, {});
  const http = createHttp({ apiBase: "https://api.example.com", token: () => null, onUnauthorized: () => {}, fetchImpl });
  await assert.rejects(http.request("GET", "/v1/friends"), (error) => error.details.code === "unauthorized");
  assert.equal(calls.length, 0);
});

test("a network failure is a network error, 204 is undefined", async () => {
  const http = createHttp({
    apiBase: "https://api.example.com",
    token: () => "T",
    onUnauthorized: () => {},
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(http.request("GET", "/v1/friends"), (error) => error.code === "network");
  const ok = createHttp({ apiBase: "https://api.example.com", token: () => "T", onUnauthorized: () => {}, fetchImpl: fetchAnswering(204).fetchImpl });
  assert.equal(await ok.request("DELETE", "/v1/invites/1"), undefined);
});

test("the timeout also covers a body that stalls after the headers", async () => {
  let aborted = false;
  const http = createHttp({
    apiBase: "https://api.example.com",
    token: () => "T",
    onUnauthorized: () => {},
    timeoutMs: 50,
    fetchImpl: async (_url, init) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
      });
      // Headers arrive at once; the body never ends.
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    },
  });
  const started = Date.now();
  await assert.rejects(http.request("GET", "/v1/chat/conversations"), (error) => {
    assert.equal(error.code, "network");
    assert.match(error.message, /within/);
    return true;
  });
  assert.ok(Date.now() - started < 2_000);
  assert.ok(aborted, "the request is aborted when the deadline passes");
});

const USER = (id, name) => ({ id, displayName: name, avatarUrl: null, provider: "dev", providerName: name, createdAt: "x" });

function friendsWith(routes, signedIn = true) {
  const events = new EventBus();
  const heard = [];
  for (const name of Object.values(EVENTS)) events.on(name, (payload) => heard.push([name, payload]));
  const calls = [];
  const http = createHttp({
    apiBase: "https://api.example.com",
    token: () => "T",
    onUnauthorized: () => {},
    fetchImpl: async (url, init) => {
      const key = `${init.method} ${url.replace("https://api.example.com", "")}`;
      calls.push(key);
      const answer = routes[key] ?? { status: 404, body: { error: { code: "not_found", message: "no" } } };
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200 });
    },
  });
  const renamed = [];
  const friends = createFriends({
    http,
    events,
    signedIn: () => signedIn,
    device: () => "desktop",
    live: () => true,
    meUpdated: (user) => renamed.push(user),
  });
  return { friends, heard, calls, renamed };
}

const LISTS = {
  "GET /v1/friends": { body: { friends: [], incoming: [], outgoing: [] } },
  "GET /v1/invites": { body: [] },
};

test("the view of a signed-out browser is empty and asks nothing", async () => {
  const { friends, calls } = friendsWith({}, false);
  const view = await friends.state();
  assert.equal(view.signedIn, false);
  assert.deepEqual(view.friends, []);
  assert.equal(calls.length, 0);
});

test("my presence says web and the device kind", async () => {
  const { friends } = friendsWith(LISTS);
  const view = await friends.state();
  assert.equal(view.presence.status, "online");
  assert.equal(view.presence.via, "web");
  assert.equal(view.presence.device, "desktop");
  assert.equal(view.live, true);
  assert.deepEqual(webPresence("phone", "t").device, "phone");
  assert.equal(signedOutView(webPresence("phone", "t")).signedIn, false);
});

test("a request answered 201 was sent, 200 made a friendship", async () => {
  const sent = friendsWith({
    ...LISTS,
    "POST /v1/friends/requests": { status: 201, body: { id: "R1", from: USER("me", "Me"), to: USER("u2", "Jan"), createdAt: "x" } },
  });
  const requested = await sent.friends.sendRequest("  Jan ");
  assert.equal(requested.outcome, "requested");
  assert.equal(requested.displayName, "Jan");
  assert.equal(requested.state.signedIn, true);

  const accepted = friendsWith({
    ...LISTS,
    "POST /v1/friends/requests": { status: 200, body: { friend: { user: USER("u2", "Jan"), presence: {}, friendsSince: "x" } } },
  });
  assert.equal((await accepted.friends.sendRequest("Jan")).outcome, "accepted");
});

test("a blank or overlong query never reaches the service", () => {
  assert.throws(() => cleanQuery("   "));
  assert.throws(() => cleanQuery("x".repeat(97)));
  assert.equal(cleanQuery(" dev:Kyle "), "dev:Kyle");
});

test("frames become the three friends events", () => {
  const { friends, heard, renamed } = friendsWith(LISTS);
  const presence = { status: "online", via: "web", device: "phone" };
  assert.equal(friends.handleFrame({ type: "presence.updated", payload: { userId: "u2", presence } }), true);
  const invite = { id: "I1", from: USER("u2", "Jan"), serverAddress: "203.0.113.5:29070", createdAt: "x", expiresAt: "y" };
  friends.handleFrame({ type: "invite", payload: { invite } });
  friends.handleFrame({ type: "friend.request", payload: {} });
  friends.handleFrame({ type: "me.updated", payload: { user: USER("me", "New name") } });
  assert.equal(friends.handleFrame({ type: "chat.message", payload: {} }), false);
  assert.deepEqual(heard, [
    ["friends:presence", { userId: "u2", presence }],
    ["friends:invite", invite],
    ["friends:changed", undefined],
    ["friends:changed", undefined],
    ["friends:changed", undefined],
  ]);
  assert.equal(renamed[0].displayName, "New name");
});

test("expired invites are left out, the newest first", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const invites = [
    { id: "old", createdAt: "2026-09-27T11:55:00Z", expiresAt: "2026-09-27T12:05:00Z" },
    { id: "gone", createdAt: "2026-09-27T11:40:00Z", expiresAt: "2026-09-27T11:50:00Z" },
    { id: "new", createdAt: "2026-09-27T11:59:00Z", expiresAt: "2026-09-27T12:09:00Z" },
  ];
  assert.deepEqual(openInvites(invites, now).map((invite) => invite.id), ["new", "old"]);
});

function routerWith() {
  const stats = createStats();
  const session = {
    signedIn: () => true,
    accountState: () => ({ onlineConfigured: true }),
  };
  const router = createRouter({
    apiBase: "https://api.example.com",
    session,
    settings: { get: () => ({ activeGame: "ja" }), update: async () => ({}) },
    friends: {},
    stats,
  });
  return { router, stats };
}

test("launcher state reads answer empty and are counted as neutral", async () => {
  const { router, stats } = routerWith();
  assert.deepEqual(await router("list_clients"), []);
  assert.equal(await router("get_running_game"), null);
  assert.equal(await router("host_get_session"), null);
  assert.deepEqual(await router("list_profiles", { clientId: "x" }), { profiles: [], defaultProfileId: null });
  assert.deepEqual(await router("detect_game_files"), { ja: [], jo: [] });
  const games = await router("list_games");
  assert.deepEqual(games.map((game) => game.id), ["ja", "jo"]);
  assert.equal(stats.neutral, 6);
  assert.equal(stats.refused, 0);
});

test("the game, local files and windows are refused and counted", async () => {
  const { router, stats } = routerWith();
  for (const command of ["join_friend", "accept_invite", "send_invite", "chat_join_host_card", "open_chat_window", "made_up"]) {
    await assert.rejects(router(command), (error) => error.code === NEEDS_LAUNCHER && error.message === NEEDS_LAUNCHER);
  }
  assert.equal(stats.refused, 6);
  assert.deepEqual(stats.refusedCommands.slice(0, 2), ["join_friend", "accept_invite"]);
});

test("the neutral list holds only reads", () => {
  for (const command of ["send_invite", "update_settings", "chat_send", "host_start"]) {
    assert.equal(neutralAnswer(command), undefined, command);
  }
});
