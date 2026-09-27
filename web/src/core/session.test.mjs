import assert from "node:assert/strict";
import { test } from "node:test";

import { onlineError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { createHttp } from "./http.ts";
import {
  createSession,
  isFresh,
  isLocalService,
  PENDING_TTL_MS,
  safeNext,
} from "./session.ts";
import { memoryStorage } from "./storage.ts";

test("next stays inside the app", () => {
  assert.equal(safeNext("/c/01J9"), "/c/01J9");
  assert.equal(safeNext("/servers?game=jo&q=duel"), "/servers?game=jo&q=duel");
  assert.equal(safeNext("/"), "/");
  for (const bad of [
    null,
    undefined,
    "",
    "chats",
    "//evil.example.com/x",
    "/\\evil.example.com",
    "https://evil.example.com",
    "javascript:alert(1)",
    "/c/1\nx",
    "/signin",
    "/signin?next=/chats",
    "/signin/done",
  ]) {
    assert.equal(safeNext(bad), null, String(bad));
  }
});

test("a pending sign-in is fresh for ten minutes", () => {
  const at = Date.parse("2026-09-27T10:00:00Z");
  const pending = { sessionId: "s", provider: "dev", next: null, createdAt: new Date(at).toISOString() };
  assert.equal(isFresh(pending, at + 1000), true);
  assert.equal(isFresh(pending, at + PENDING_TTL_MS - 1), true);
  assert.equal(isFresh(pending, at + PENDING_TTL_MS), false);
  assert.equal(isFresh(undefined, at), false);
  assert.equal(isFresh({ ...pending, createdAt: "garbage" }, at), false);
});

test("the Developer sign-in shows only against a local service", () => {
  assert.equal(isLocalService("http://127.0.0.1:8787"), true);
  assert.equal(isLocalService("http://localhost:8787"), true);
  assert.equal(isLocalService("https://api.example.com"), false);
});

/** A fake service: answers by method and path, records what it was asked. */
function fakeService(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace("https://api.example.com", "");
    calls.push({ method: init.method, path, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = routes[`${init.method} ${path}`];
    if (answer === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "No such endpoint" } }), { status: 404 });
    const { status = 200, body } = typeof answer === "function" ? answer() : answer;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

function setup(routes, extra = {}) {
  const service = fakeService(routes);
  const storage = memoryStorage();
  const events = new EventBus();
  const changes = [];
  events.on("account:changed", (payload) => changes.push(payload));
  let session;
  const http = createHttp({
    apiBase: "https://api.example.com",
    token: () => session.token(),
    onUnauthorized: () => void session.expire(),
    fetchImpl: service.fetchImpl,
  });
  const wiped = [];
  let signedInCalls = 0;
  session = createSession({
    http,
    storage,
    events,
    apiBase: "https://api.example.com",
    origin: "https://web.example.com",
    device: { kind: () => "phone", name: () => "JKNet web · Android · Chrome" },
    wipe: async (reason) => {
      wiped.push(reason);
      await storage.wipe();
    },
    signedIn: () => {
      signedInCalls += 1;
    },
    ...extra,
  });
  return { session, storage, service, changes, wiped, signedIn: () => signedInCalls };
}

const USER = {
  id: "01USER",
  displayName: "Kyle",
  avatarUrl: null,
  provider: "dev",
  providerName: "Kyle",
  createdAt: "2026-09-27T10:00:00Z",
};

test("a web sign-in names the client, the device and the way back", async () => {
  const { session, service, storage } = setup({
    "POST /v1/auth/login-sessions": {
      status: 201,
      body: { id: "S1", provider: "dev", url: "https://api.example.com/v1/auth/dev/start?session=S1", status: "pending" },
    },
  });
  const start = await session.beginSignIn("dev", "/c/01J9");
  assert.deepEqual(start, { sessionId: "S1", url: "https://api.example.com/v1/auth/dev/start?session=S1" });
  assert.deepEqual(service.calls[0].body, {
    provider: "dev",
    deviceName: "JKNet web · Android · Chrome",
    device: "phone",
    client: "web",
    returnTo: "https://web.example.com/signin/done",
  });
  assert.equal(service.calls[0].headers.Authorization, undefined);
  const pending = await storage.get("pendingSignIn", "current");
  assert.equal(pending.sessionId, "S1");
  assert.equal(pending.next, "/c/01J9");
  assert.equal(session.status().phase, "waiting");
});

test("a next that leaves the app is dropped at the start", async () => {
  const { session, storage } = setup({
    "POST /v1/auth/login-sessions": { status: 201, body: { id: "S1", provider: "dev", url: "u", status: "pending" } },
  });
  await session.beginSignIn("dev", "//evil.example.com");
  assert.equal((await storage.get("pendingSignIn", "current")).next, null);
});

test("the poll that finds done stores the token, clears the pending and says so", async () => {
  const { session, storage, changes, signedIn } = setup({
    "GET /v1/auth/login-sessions/S1": { body: { id: "S1", provider: "dev", url: "u", status: "done", token: "TOKEN", user: USER } },
    "GET /v1/me": { body: { user: USER, admin: false } },
  });
  await storage.put("pendingSignIn", "current", { sessionId: "S1", provider: "dev", next: "/friends", createdAt: new Date().toISOString() });
  const answer = await session.poll("S1");
  assert.deepEqual(answer, { status: "done", user: USER, error: null });
  assert.equal(session.token(), "TOKEN");
  assert.equal(session.signedIn(), true);
  assert.equal((await storage.get("session", "current")).token, "TOKEN");
  assert.equal(await storage.get("pendingSignIn", "current"), undefined);
  assert.deepEqual(changes[0], { signedIn: true, reason: "signedIn" });
  assert.equal(signedIn(), 1);
  const state = session.accountState();
  assert.equal(state.onlineSignedIn, true);
  assert.equal(state.onlineUser.displayName, "Kyle");
  assert.equal(state.onlineConfigured, true);
});

test("watching a pending sign-in ends in done with its next", async () => {
  const { session, storage } = setup({
    "GET /v1/auth/login-sessions/S1": { body: { id: "S1", provider: "dev", url: "u", status: "done", token: "T", user: USER } },
    "GET /v1/me": { body: { user: USER } },
  });
  await storage.put("pendingSignIn", "current", { sessionId: "S1", provider: "dev", next: "/c/9", createdAt: new Date().toISOString() });
  const settled = new Promise((resolve) => session.subscribe(() => session.status().phase === "done" && resolve()));
  await session.watchPending();
  await settled;
  assert.deepEqual(session.status(), { phase: "done", next: "/c/9", error: null });
  session.stop();
});

test("an expired session is reported and forgotten", async () => {
  const { session, storage } = setup({
    "GET /v1/auth/login-sessions/S1": { body: { id: "S1", provider: "dev", url: "u", status: "expired" } },
  });
  await storage.put("pendingSignIn", "current", { sessionId: "S1", provider: "dev", next: null, createdAt: new Date().toISOString() });
  const settled = new Promise((resolve) => session.subscribe(() => session.status().phase === "expired" && resolve()));
  await session.watchPending();
  await settled;
  assert.equal(await storage.get("pendingSignIn", "current"), undefined);
  session.stop();
});

test("a pending sign-in older than ten minutes is not polled", async () => {
  const { session, storage, service } = setup({});
  await storage.put("pendingSignIn", "current", {
    sessionId: "S1",
    provider: "dev",
    next: null,
    createdAt: new Date(Date.now() - PENDING_TTL_MS - 1000).toISOString(),
  });
  await session.watchPending();
  assert.equal(service.calls.length, 0);
  assert.equal(await storage.get("pendingSignIn", "current"), undefined);
  assert.equal(session.status().phase, "idle");
});

test("a 401 on a call with the token wipes the account as expired", async () => {
  const { session, storage, changes, wiped } = setup({
    "GET /v1/me": { status: 401, body: { error: { code: "unauthorized", message: "Token expired" } } },
  });
  await storage.put("session", "current", { token: "OLD", userId: "u", apiBase: "https://api.example.com", createdAt: "x", user: USER });
  await session.load();
  assert.equal(session.signedIn(), true);
  await assert.rejects(session.refreshMe(), (error) => error.details.code === "unauthorized");
  // The wipe runs from the refusal itself; give it a turn to finish.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.signedIn(), false);
  assert.deepEqual(wiped, ["expired"]);
  assert.deepEqual(changes.at(-1), { signedIn: false, reason: "expired" });
});

test("sign-out tells the service, then forgets everything", async () => {
  const { session, storage, service, changes, wiped } = setup({
    "POST /v1/auth/logout": { status: 204 },
  });
  await storage.put("session", "current", { token: "T", userId: "u", apiBase: "https://api.example.com", createdAt: "x" });
  await session.load();
  await session.signOut();
  assert.equal(service.calls[0].headers.Authorization, "Bearer T");
  assert.equal(session.token(), null);
  assert.deepEqual(wiped, ["signedOut"]);
  assert.deepEqual(changes.at(-1), { signedIn: false, reason: "signedOut" });
});

test("sign-out still forgets the token when the service refuses the logout", async () => {
  const { session, storage, wiped } = setup({});
  await storage.put("session", "current", { token: "T", userId: "u", apiBase: "https://api.example.com", createdAt: "x" });
  await session.load();
  await session.signOut();
  assert.equal(session.signedIn(), false);
  assert.deepEqual(wiped, ["signedOut"]);
});

test("a token of another service is never loaded", async () => {
  const { session, storage } = setup({});
  await storage.put("session", "current", { token: "T", userId: "u", apiBase: "https://other.example.com", createdAt: "x" });
  await session.load();
  assert.equal(session.signedIn(), false);
  assert.equal(await storage.get("session", "current"), undefined);
});

test("renaming answers the new account and announces it", async () => {
  const renamed = { ...USER, displayName: "Kyle K" };
  const { session, storage, changes } = setup({ "PATCH /v1/me": { body: renamed } });
  await storage.put("session", "current", { token: "T", userId: "u", apiBase: "https://api.example.com", createdAt: "x", user: USER });
  await session.load();
  assert.deepEqual(await session.updateDisplayName("Kyle K"), renamed);
  assert.equal(session.user().displayName, "Kyle K");
  assert.deepEqual(changes.at(-1), { signedIn: true, reason: "renamed" });
});

test("a refusal carries the contract code", () => {
  const error = onlineError("conflict", "Name taken", 409);
  assert.equal(error.code, "online");
  assert.equal(error.message, "online conflict: Name taken");
  assert.deepEqual(error.details, { code: "conflict", message: "Name taken", status: 409 });
});
