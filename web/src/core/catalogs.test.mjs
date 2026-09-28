import assert from "node:assert/strict";
import { test } from "node:test";

import { bundleListPath, communityRead, createCatalogs, MAX_BUNDLE_PAGE } from "./catalogs.ts";
import { NEEDS_LAUNCHER } from "./errors.ts";
import { createHttp } from "./http.ts";

const ID = "01J9Z3M2K4V8Q6R5T7W9X1Y2Z3";

/** A catalogs part over a fake service that answers `body` and records the calls. */
function catalogsAnswering(body, { signedIn = true, activeGame = "ja" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization ?? null });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const http = createHttp({
    apiBase: "https://api.example.com",
    token: () => (signedIn ? "T" : null),
    onUnauthorized: () => {},
    fetchImpl,
  });
  return { calls, catalogs: createCatalogs({ http, signedIn: () => signedIn, activeGame: () => activeGame }) };
}

test("the community bridge takes the four reads of the launcher's bridge", () => {
  assert.deepEqual(communityRead("GET", "servers"), { auth: false });
  assert.deepEqual(communityRead("GET", `servers/${ID}`), { auth: false });
  assert.deepEqual(communityRead("GET", "me"), { auth: true });
  assert.deepEqual(communityRead("GET", "admin/claims"), { auth: true });
});

test("the community bridge refuses writes and paths outside its routes", () => {
  for (const [method, path] of [
    ["POST", "servers"],
    ["PUT", `servers/${ID}`],
    ["POST", `servers/${ID}/claims`],
    ["POST", `claims/${ID}/verify`],
    ["GET", "../me"],
    ["GET", "servers/../../me"],
    ["GET", "servers?token=x"],
    ["GET", "https://example.com"],
    ["GET", "me/extra"],
    ["GET", "servers/short"],
    ["GET", `servers/${ID}/claims`],
    ["DELETE", "servers"],
  ]) {
    assert.equal(communityRead(method, path), null, `${method} ${path}`);
  }
});

test("a community read goes to /v1/community with the token only where the route wants it", async () => {
  const { calls, catalogs } = catalogsAnswering({ servers: [] });
  await catalogs.community("GET", "servers");
  await catalogs.community("GET", "me");
  assert.deepEqual(calls, [
    { url: "https://api.example.com/v1/community/servers", method: "GET", auth: null },
    { url: "https://api.example.com/v1/community/me", method: "GET", auth: "Bearer T" },
  ]);
});

test("a community write is the launcher's, an unknown path is invalid, and neither reaches the service", async () => {
  const { calls, catalogs } = catalogsAnswering({});
  await assert.rejects(catalogs.community("POST", "servers"), (error) => error.code === NEEDS_LAUNCHER);
  await assert.rejects(catalogs.community("GET", "../me"), (error) => error.code === "invalidInput");
  assert.equal(calls.length, 0);
});

test("the catalogue query is the one list_bundles of the launcher builds", () => {
  assert.equal(
    bundleListPath({ game: "jo", sort: "new", q: " duel pack ", engineId: "jk2mv", tag: "voip", limit: 20, offset: 40 }),
    "/v1/bundles?game=jo&sort=new&q=duel%20pack&engine=jk2mv&tag=voip&limit=20&offset=40",
  );
  assert.equal(bundleListPath({}, "jo"), "/v1/bundles?game=jo&sort=popular&limit=50&offset=0");
  assert.equal(bundleListPath({ game: "xx", sort: "hot", q: "", engineId: null }), "/v1/bundles?game=ja&sort=popular&limit=50&offset=0");
  assert.equal(bundleListPath({ q: "a&b=c#d" }), "/v1/bundles?game=ja&sort=popular&q=a%26b%3Dc%23d&limit=50&offset=0");
  assert.equal(bundleListPath({ limit: 1000, offset: -5 }), `/v1/bundles?game=ja&sort=popular&limit=${MAX_BUNDLE_PAGE}&offset=0`);
});

test("a catalogue query without a game takes the active game", async () => {
  const { calls, catalogs } = catalogsAnswering({ items: [], total: 0 }, { activeGame: "jo" });
  await catalogs.bundles({ sort: "popular" });
  assert.equal(calls[0].url, "https://api.example.com/v1/bundles?game=jo&sort=popular&limit=50&offset=0");
  assert.equal(calls[0].auth, "Bearer T");
});

test("a signed-out browser reads the catalogue without a token", async () => {
  const { calls, catalogs } = catalogsAnswering({ items: [], total: 0 }, { signedIn: false });
  await catalogs.bundles({ game: "ja" });
  assert.equal(calls[0].auth, null);
});

test("a bundle record says nothing of it is installed here", async () => {
  const { calls, catalogs } = catalogsAnswering({ id: ID, name: "Clan pack" });
  const record = await catalogs.bundle(` ${ID} `);
  assert.equal(calls[0].url, `https://api.example.com/v1/bundles/${ID}`);
  assert.deepEqual(record.local, { installedClients: [], engineKnown: {} });
  await assert.rejects(catalogs.bundle("  "), (error) => error.code === "invalidInput");
});

test("a version and a like go to their routes, ids escaped", async () => {
  const { calls, catalogs } = catalogsAnswering({ likes: 1, likedByMe: true });
  await catalogs.version(ID, "v/1");
  await catalogs.like(ID, true);
  await catalogs.like(ID, false);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      `GET https://api.example.com/v1/bundles/${ID}/versions/v%2F1`,
      `PUT https://api.example.com/v1/bundles/${ID}/like`,
      `DELETE https://api.example.com/v1/bundles/${ID}/like`,
    ],
  );
});
