/**
 * Devices and sessions of the web core: the list as the launcher's card
 * reads it, and the three ways of `revoke_session` — another device, every
 * other one, and this browser, which is the sign-out of this device.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createHttp } from "./http.ts";
import { createRouter, createStats } from "./router.ts";
import { createSessions, readSession, readTarget } from "./sessions.ts";

const API = "https://api.example.com";

const ROWS = [
  {
    id: "S-PHONE",
    client: "web",
    device: "phone",
    deviceName: "JKNet web · Android · Chrome",
    createdAt: "2026-09-28T10:00:00Z",
    lastUsedAt: "2026-09-29T10:00:00Z",
    expiresAt: "2026-12-27T10:00:00Z",
    current: true,
    online: true,
    push: true,
  },
  {
    id: "S-PC",
    client: "launcher",
    device: null,
    deviceName: "KYLE-PC",
    createdAt: "2026-09-20T10:00:00Z",
    lastUsedAt: "2026-09-29T09:00:00Z",
    expiresAt: "2026-12-19T10:00:00Z",
    current: false,
    online: false,
    push: false,
  },
];

function setup({ signedIn = true, live = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url.replace(API, "")}`);
    if (init.method === "GET") return Response.json({ sessions: ROWS });
    return new Response(null, { status: 204 });
  };
  const http = createHttp({ apiBase: API, token: () => "T", onUnauthorized: () => {}, fetchImpl });
  const signOuts = [];
  const sessions = createSessions({
    http,
    signedIn: () => signedIn,
    signOut: async () => {
      signOuts.push("signOut");
    },
    live: () => live,
  });
  return { sessions, calls, signOuts };
}

test("a row is read as the launcher reads it", () => {
  assert.deepEqual(readSession(ROWS[0]), ROWS[0]);
  assert.deepEqual(readSession({ ...ROWS[1], device: "phone", deviceName: "  " }), { ...ROWS[1], deviceName: null });
  assert.equal(readSession({ ...ROWS[0], client: "tv" }).client, "launcher");
  assert.equal(readSession({ ...ROWS[0], device: "watch" }).device, null);
  assert.equal(readSession({ client: "web" }), null);
  assert.equal(readSession("S1"), null);
});

test("the arguments of revoke_session are the IPC wrapper's", () => {
  assert.deepEqual(readTarget({ id: "S1", others: false }), { id: "S1", others: false });
  assert.deepEqual(readTarget({ id: null, others: true }), { id: null, others: true });
  assert.deepEqual(readTarget({ id: " ", others: false }), { id: null, others: false });
  assert.deepEqual(readTarget({}), { id: null, others: false });
});

test("the list comes from the service, and another device is signed out by its id", async () => {
  const { sessions, calls, signOuts } = setup();
  const list = await sessions.list();
  assert.deepEqual(list.map((row) => row.id), ["S-PHONE", "S-PC"]);
  await sessions.revoke({ id: "S-PC", others: false });
  assert.deepEqual(calls, ["GET /v1/me/sessions", "DELETE /v1/me/sessions/S-PC"]);
  assert.deepEqual(signOuts, []);
});

test("this browser counts as online while its socket is up or on its way", async () => {
  const offline = { ...ROWS[0], online: false };
  for (const [live, expected] of [[false, false], [true, true]]) {
    const calls = [];
    const http = createHttp({
      apiBase: API,
      token: () => "T",
      onUnauthorized: () => {},
      fetchImpl: async (url) => {
        calls.push(url);
        return Response.json({ sessions: [offline, { ...ROWS[1] }] });
      },
    });
    const sessions = createSessions({ http, signedIn: () => true, signOut: async () => {}, live: () => live });
    const [own, pc] = await sessions.list();
    assert.equal(own.online, expected);
    assert.equal(pc.online, false, "another device is as the service sees it");
  }
});

test("every other device goes with one call", async () => {
  const { sessions, calls } = setup();
  await sessions.revoke({ id: null, others: true });
  assert.deepEqual(calls, ["DELETE /v1/me/sessions?others=true"]);
  await assert.rejects(sessions.revoke({ id: "S-PC", others: true }), (error) => error.code === "invalidInput");
});

test("this browser's own session, or none named, is the sign-out of this device", async () => {
  const { sessions, calls, signOuts } = setup();
  await sessions.revoke({ id: null, others: false });
  assert.deepEqual(signOuts, ["signOut"]);
  assert.deepEqual(calls, []);

  // The list was never read: it is read once to learn which one is this.
  await sessions.revoke({ id: "S-PHONE", others: false });
  assert.deepEqual(calls, ["GET /v1/me/sessions"]);
  assert.deepEqual(signOuts, ["signOut", "signOut"]);

  // Forgotten with the account: the next account's list says again.
  sessions.forget();
  await sessions.revoke({ id: "S-PHONE", others: false });
  assert.deepEqual(calls, ["GET /v1/me/sessions", "GET /v1/me/sessions"]);
});

test("signed out, nothing is asked", async () => {
  const { sessions, calls } = setup({ signedIn: false });
  await assert.rejects(sessions.list(), (error) => error.details.code === "unauthorized");
  await assert.rejects(sessions.revoke({ id: "S-PC", others: false }), (error) => error.details.code === "unauthorized");
  assert.deepEqual(calls, []);
});

test("the router answers get_sessions and revoke_session", async () => {
  const { sessions, calls } = setup();
  const stats = createStats();
  const router = createRouter({
    apiBase: API,
    session: { signedIn: () => true },
    sessions,
    settings: { get: () => ({ activeGame: "ja" }), update: async () => ({}) },
    friends: {},
    stats,
  });
  assert.equal((await router("get_sessions")).length, 2);
  assert.equal(await router("revoke_session", { id: "S-PC", others: false }), undefined);
  assert.deepEqual(calls, ["GET /v1/me/sessions", "DELETE /v1/me/sessions/S-PC"]);
  assert.equal(stats.refused, 0);
});
