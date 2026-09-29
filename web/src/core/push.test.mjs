import assert from "node:assert/strict";
import { test } from "node:test";

import { createHttp } from "./http.ts";
import { loadPrefs } from "./prefs.ts";
import { createPush, DEFAULT_PUSH_SETTINGS, fromBase64url, toBase64url } from "./push.ts";
import { memoryStorage } from "./storage.ts";

const KEY = "BPublicKeyOfTheService";
const OTHER_KEY = "BAnotherKeyOfTheService";

/** A service that answers the push routes from a table of rows. */
function fakeService({ enabled = true, publicKey = KEY, rows = [] } = {}) {
  const calls = [];
  let next = 1;
  const state = { rows: rows.map((row) => ({ ...row })) };
  const json = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, path, body });
    if (method === "GET" && path === "/v1/push/config") return json(200, { enabled, publicKey: enabled ? publicKey : null });
    if (method === "GET" && path === "/v1/push/subscriptions") return json(200, { subscriptions: state.rows });
    if (method === "PUT" && path === "/v1/push/subscriptions") {
      const found = state.rows.find((row) => row.endpoint === body.endpoint);
      if (found !== undefined) {
        found.locale = body.locale;
        if (body.settings !== undefined) found.settings = { ...DEFAULT_PUSH_SETTINGS, ...body.settings };
        return json(200, { id: found.id, settings: found.settings, publicKey });
      }
      const row = {
        id: `sub${next++}`,
        endpoint: body.endpoint,
        deviceName: body.deviceName ?? null,
        locale: body.locale,
        current: true,
        createdAt: "2026-09-29T10:00:00Z",
        lastOkAt: null,
        settings: { ...DEFAULT_PUSH_SETTINGS, ...(body.settings ?? {}) },
      };
      state.rows.push(row);
      return json(201, { id: row.id, settings: row.settings, publicKey });
    }
    const one = /^\/v1\/push\/subscriptions\/([^/]+)(\/test)?$/.exec(path);
    if (one !== null) {
      const row = state.rows.find((entry) => entry.id === one[1]);
      if (row === undefined) return json(404, { error: { code: "not_found", message: "No such push subscription" } });
      if (method === "PATCH") {
        if (body.settings !== undefined) row.settings = { ...row.settings, ...body.settings };
        if (body.locale !== undefined) row.locale = body.locale;
        return json(200, { id: row.id, settings: row.settings });
      }
      if (method === "DELETE") {
        state.rows = state.rows.filter((entry) => entry !== row);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && one[2] === "/test") return json(202, {});
    }
    return json(404, { error: { code: "not_found", message: "No such endpoint" } });
  };
  return { calls, fetchImpl, state };
}

/** The browser's side: a permission and at most one subscription. */
function fakeTransport({ permission = "default", answer = "granted", subscription = null } = {}) {
  const log = [];
  let current = subscription;
  let made = 0;
  return {
    log,
    get current() {
      return current;
    },
    transport: {
      supported: () => true,
      permission: () => permission,
      requestPermission: () => {
        log.push("ask");
        permission = answer;
        return Promise.resolve(answer);
      },
      current: async () => current,
      subscribe: async (publicKey) => {
        made += 1;
        log.push(`subscribe ${publicKey}`);
        current = { endpoint: `https://push.example.com/send/${made}`, p256dh: "P", auth: "A", key: publicKey };
        return current;
      },
      unsubscribe: async () => {
        log.push("unsubscribe");
        current = null;
      },
    },
  };
}

async function setup({ service = fakeService(), browser = fakeTransport(), prefs = {}, signedIn = true } = {}) {
  const store = await loadPrefs(memoryStorage());
  for (const [name, value] of Object.entries(prefs)) await store.set(name, value);
  const http = createHttp({ apiBase: "https://api.example.com", token: () => "T", onUnauthorized: () => {}, fetchImpl: service.fetchImpl });
  let reconnects = 0;
  const push = createPush({
    http,
    prefs: store,
    transport: browser.transport,
    signedIn: () => signedIn,
    locale: () => "ru",
    deviceName: () => "JKNet web · Android · Chrome",
    reconnect: () => {
      reconnects += 1;
    },
  });
  return { push, prefs: store, service, browser, reconnects: () => reconnects };
}

test("base64url keys survive the round trip", () => {
  const bytes = new Uint8Array([4, 250, 0, 63, 62, 255]);
  assert.deepEqual([...fromBase64url(toBase64url(bytes))], [...bytes]);
  assert.equal(toBase64url(new Uint8Array([251, 255])), "-_8");
});

test("enable asks inside the click, subscribes with the service's key and saves the device", async () => {
  const { push, prefs, service, browser, reconnects } = await setup();
  const pending = push.enable();
  // The question goes out before anything was awaited: browsers ask only then.
  assert.deepEqual(browser.log, ["ask"]);
  const device = await pending;
  assert.deepEqual(browser.log, ["ask", `subscribe ${KEY}`]);
  const put = service.calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body, {
    endpoint: "https://push.example.com/send/1",
    keys: { p256dh: "P", auth: "A" },
    deviceName: "JKNet web · Android · Chrome",
    locale: "ru",
  });
  assert.equal(prefs.get("pushSubscriptionId"), "sub1");
  assert.equal(prefs.get("vapidKey"), KEY);
  assert.equal(push.local().subscriptionId, "sub1");
  assert.equal(reconnects(), 1, "the socket's ticket names the new subscription");
  // A new device starts from the user's final defaults.
  assert.equal(device.settings.preview, "full");
  assert.equal(device.settings.whileActiveElsewhere, "delay");
});

test("a refused permission subscribes nothing", async () => {
  const { push, prefs, service } = await setup({ browser: fakeTransport({ answer: "denied" }) });
  await assert.rejects(push.enable(), (error) => error.code === "pushBlocked");
  assert.equal(prefs.get("pushSubscriptionId"), undefined);
  assert.equal(service.calls.filter((call) => call.method === "PUT").length, 0);
  assert.equal(push.local().permission, "denied");
});

test("a service with push off refuses to enable", async () => {
  const { push } = await setup({ service: fakeService({ enabled: false }), browser: fakeTransport({ permission: "granted" }) });
  await assert.rejects(push.enable(), (error) => error.details?.code === "push_disabled");
});

test("a start saves the subscription again, with the language on screen", async () => {
  const service = fakeService({
    rows: [{ id: "sub7", endpoint: "https://push.example.com/send/old", deviceName: "x", locale: "en", current: true, createdAt: "", lastOkAt: null, settings: { ...DEFAULT_PUSH_SETTINGS, preview: "sender" } }],
  });
  const browser = fakeTransport({ permission: "granted", subscription: { endpoint: "https://push.example.com/send/old", p256dh: "P", auth: "A", key: KEY } });
  const { push, prefs, reconnects } = await setup({ service, browser, prefs: { pushSubscriptionId: "sub7", vapidKey: KEY } });
  await push.refresh();
  const put = service.calls.find((call) => call.method === "PUT");
  assert.equal(put.body.locale, "ru");
  assert.equal(put.body.settings.preview, "sender", "the stored settings go along");
  assert.equal(service.state.rows.length, 1);
  assert.equal(prefs.get("pushSubscriptionId"), "sub7");
  assert.equal(reconnects(), 0, "the same id needs no new ticket");
});

test("a start without the browser's subscription forgets the local id", async () => {
  const { push, prefs, service } = await setup({ browser: fakeTransport({ permission: "granted" }), prefs: { pushSubscriptionId: "sub3", vapidKey: KEY } });
  await push.refresh();
  assert.equal(prefs.get("pushSubscriptionId"), undefined);
  assert.equal(service.calls.length, 0);
});

test("a start without permission touches nothing", async () => {
  const { push, service } = await setup({ browser: fakeTransport({ permission: "default" }), prefs: { pushSubscriptionId: "sub3" } });
  await push.refresh();
  assert.equal(service.calls.length, 0);
});

test("a device removed from another device's list stays without push", async () => {
  const browser = fakeTransport({ permission: "granted", subscription: { endpoint: "https://push.example.com/send/9", p256dh: "P", auth: "A", key: KEY } });
  const { push, prefs, service, reconnects } = await setup({ browser, prefs: { pushSubscriptionId: "gone", vapidKey: KEY } });
  await push.refresh();
  assert.equal(service.calls.filter((call) => call.method === "PUT").length, 0, "nothing saved again");
  assert.equal(browser.current, null, "the browser's subscription is dropped");
  assert.equal(prefs.get("pushSubscriptionId"), undefined);
  assert.equal(reconnects(), 1);
});

test("a new key of the service subscribes anew, keeps the settings and drops the old row", async () => {
  const service = fakeService({
    publicKey: OTHER_KEY,
    rows: [{ id: "sub7", endpoint: "https://push.example.com/send/old", deviceName: "x", locale: "en", current: true, createdAt: "", lastOkAt: null, settings: { ...DEFAULT_PUSH_SETTINGS, whileActiveElsewhere: "never" } }],
  });
  const browser = fakeTransport({ permission: "granted", subscription: { endpoint: "https://push.example.com/send/old", p256dh: "P", auth: "A", key: KEY } });
  const { push, prefs, reconnects } = await setup({ service, browser, prefs: { pushSubscriptionId: "sub7", vapidKey: KEY } });
  await push.refresh();
  assert.deepEqual(browser.log, ["unsubscribe", `subscribe ${OTHER_KEY}`]);
  assert.deepEqual(service.state.rows.map((row) => row.id), ["sub1"]);
  assert.equal(service.state.rows[0].settings.whileActiveElsewhere, "never");
  assert.equal(prefs.get("pushSubscriptionId"), "sub1");
  assert.equal(prefs.get("vapidKey"), OTHER_KEY);
  assert.equal(reconnects(), 1);
});

test("a setting goes to this device's row only", async () => {
  const service = fakeService({
    rows: [
      { id: "mine", endpoint: "https://push.example.com/send/a", deviceName: "a", locale: "en", current: true, createdAt: "", lastOkAt: null, settings: { ...DEFAULT_PUSH_SETTINGS } },
      { id: "other", endpoint: "https://push.example.com/send/b", deviceName: "b", locale: "en", current: false, createdAt: "", lastOkAt: null, settings: { ...DEFAULT_PUSH_SETTINGS } },
    ],
  });
  const { push } = await setup({ service, prefs: { pushSubscriptionId: "mine" } });
  const settings = await push.update({ preview: "none" });
  assert.equal(settings.preview, "none");
  const patch = service.calls.find((call) => call.method === "PATCH");
  assert.equal(patch.path, "/v1/push/subscriptions/mine");
  assert.deepEqual(patch.body, { settings: { preview: "none" } });
  assert.equal(service.state.rows.find((row) => row.id === "other").settings.preview, "full");
});

test("removing this device stops its push; removing another leaves it", async () => {
  const service = fakeService({
    rows: [
      { id: "mine", endpoint: "https://push.example.com/send/a", deviceName: "a", locale: "en", current: true, createdAt: "", lastOkAt: null, settings: { ...DEFAULT_PUSH_SETTINGS } },
      { id: "other", endpoint: "https://push.example.com/send/b", deviceName: "b", locale: "en", current: false, createdAt: "", lastOkAt: null, settings: { ...DEFAULT_PUSH_SETTINGS } },
    ],
  });
  const browser = fakeTransport({ permission: "granted", subscription: { endpoint: "https://push.example.com/send/a", p256dh: "P", auth: "A", key: KEY } });
  const { push, prefs } = await setup({ service, browser, prefs: { pushSubscriptionId: "mine" } });
  await push.remove("other");
  assert.equal(prefs.get("pushSubscriptionId"), "mine");
  assert.notEqual(browser.current, null);
  await push.remove("mine");
  assert.equal(prefs.get("pushSubscriptionId"), undefined);
  assert.equal(browser.current, null);
  assert.equal(service.state.rows.length, 0);
});

test("the test and the language go to this device's row", async () => {
  const service = fakeService({
    rows: [{ id: "mine", endpoint: "https://push.example.com/send/a", deviceName: "a", locale: "en", current: true, createdAt: "", lastOkAt: null, settings: { ...DEFAULT_PUSH_SETTINGS } }],
  });
  const { push } = await setup({ service, prefs: { pushSubscriptionId: "mine" } });
  await push.test();
  await push.setLocale("de");
  assert.deepEqual(
    service.calls.map((call) => `${call.method} ${call.path}`),
    ["POST /v1/push/subscriptions/mine/test", "PATCH /v1/push/subscriptions/mine"],
  );
  assert.equal(service.state.rows[0].locale, "de");
});

test("the worker's new subscription id is adopted and reconnects the socket", async () => {
  const { push, prefs, reconnects } = await setup({ prefs: { pushSubscriptionId: "old" } });
  let heard = 0;
  push.subscribe(() => {
    heard += 1;
  });
  await push.adopt("new");
  assert.equal(prefs.get("pushSubscriptionId"), "new");
  assert.equal(push.local().subscriptionId, "new");
  assert.equal(reconnects(), 1);
  assert.equal(heard, 1);
  await push.adopt("new");
  assert.equal(reconnects(), 1, "the same id changes nothing");
});

test("the local snapshot keeps its identity until something changes", async () => {
  const { push, prefs } = await setup({ prefs: { pushSubscriptionId: "a" } });
  const first = push.local();
  assert.equal(push.local(), first);
  await prefs.set("pushSubscriptionId", undefined);
  assert.notEqual(push.local(), first);
  assert.equal(push.local().subscriptionId, null);
});
