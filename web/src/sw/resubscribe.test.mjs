import assert from "node:assert/strict";
import { test } from "node:test";

import { resubscribe } from "./resubscribe.ts";

const OLD = {
  id: "old",
  deviceName: "JKNet web · Android · Chrome",
  locale: "ru",
  current: true,
  createdAt: "2026-09-01T00:00:00Z",
  lastOkAt: null,
  settings: { preview: "sender", whileActiveElsewhere: "never" },
};

function world({ session = { token: "T", apiBase: "https://api.example.com/" }, prefs = { pushSubscriptionId: "old", vapidKey: "KEY" }, rows = [OLD], put = 201 } = {}) {
  const calls = [];
  const written = {};
  const told = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (init.method === "GET") return new Response(JSON.stringify({ subscriptions: rows }), { status: 200 });
    if (init.method === "PUT") return new Response(JSON.stringify({ id: "new", publicKey: "KEY", settings: {} }), { status: put });
    return new Response(null, { status: 204 });
  };
  return {
    calls,
    written,
    told,
    deps: (newSubscription) => ({
      readSession: async () => session,
      readPref: async (name) => prefs[name],
      writePref: async (name, value) => {
        written[name] = value;
      },
      newSubscription,
      subscribe: async (key) => ({ endpoint: `https://push.example.com/fresh/${key}`, keys: { p256dh: "P2", auth: "A2" } }),
      fetch,
      tellPages: async (id) => {
        told.push(id);
      },
    }),
  };
}

const handed = { endpoint: "https://push.example.com/handed", keys: { p256dh: "P", auth: "A" } };

test("the browser's new subscription takes the old row's name, language and settings", async () => {
  const w = world();
  assert.equal(await resubscribe(w.deps(handed)), "new");
  const put = w.calls.find((call) => call.method === "PUT");
  assert.equal(put.url, "https://api.example.com/v1/push/subscriptions");
  assert.equal(put.headers.Authorization, "Bearer T");
  assert.deepEqual(put.body, {
    endpoint: "https://push.example.com/handed",
    keys: { p256dh: "P", auth: "A" },
    deviceName: OLD.deviceName,
    locale: "ru",
    settings: OLD.settings,
  });
  assert.ok(w.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/push/subscriptions/old")));
  assert.deepEqual(w.written, { pushSubscriptionId: "new", vapidKey: "KEY" });
  assert.deepEqual(w.told, ["new"]);
});

test("without a subscription from the browser the worker subscribes with the stored key", async () => {
  const w = world();
  await resubscribe(w.deps(null));
  assert.equal(w.calls.find((call) => call.method === "PUT").body.endpoint, "https://push.example.com/fresh/KEY");
});

test("signed out, or never subscribed, nothing happens", async () => {
  for (const setup of [{ session: null }, { prefs: {} }]) {
    const w = world(setup);
    assert.equal(await resubscribe(w.deps(handed)), null);
    assert.equal(w.calls.length, 0);
  }
});

test("a device removed from the list is not brought back", async () => {
  const w = world({ rows: [] });
  assert.equal(await resubscribe(w.deps(handed)), null);
  assert.deepEqual(w.calls.map((call) => call.method), ["GET"]);
  assert.deepEqual(w.written, {});
});

test("a refused save keeps the old id", async () => {
  const w = world({ put: 503 });
  assert.equal(await resubscribe(w.deps(handed)), null);
  assert.deepEqual(w.written, {});
  assert.deepEqual(w.told, []);
});
