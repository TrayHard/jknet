import assert from "node:assert/strict";
import { test } from "node:test";

import { bundleListPath, catalogueQuery, communityRoute, createCatalogs, eventsQuery, MAX_BUNDLE_PAGE, postsQuery } from "./catalogs.ts";
import { NEEDS_LAUNCHER } from "./errors.ts";
import { createHttp } from "./http.ts";

const ID = "01J9Z3M2K4V8Q6R5T7W9X1Y2Z3";

/** A catalogs part over a fake service that answers `body` and records the calls. */
function catalogsAnswering(body, { signedIn = true, activeGame = "ja" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization ?? null, body: init.body ?? null });
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

test("the community bridge takes every read of the contract", () => {
  for (const [path, auth] of [
    ["communities", "optional"],
    ["ranking", "optional"],
    ["events", "optional"],
    ["servers", "optional"],
    [`communities/${ID}`, "optional"],
    [`communities/${ID}/players`, "optional"],
    [`communities/${ID}/discord`, "optional"],
    [`communities/${ID}/activity`, "optional"],
    [`communities/${ID}/events`, "optional"],
    [`communities/${ID}/posts`, "optional"],
    [`servers/${ID}`, "optional"],
    [`events/${ID}`, "optional"],
    ["me", "required"],
    ["following", "required"],
    ["admin/claims", "required"],
    [`events/${ID}/attendees`, "required"],
  ]) {
    assert.deepEqual(communityRoute("GET", path), { path, auth, body: false }, path);
  }
});

test("the web app answers an event with the token, and takes the answer back", () => {
  assert.deepEqual(communityRoute("PUT", `events/${ID}/rsvp`), { path: `events/${ID}/rsvp`, auth: "required", body: true });
  assert.deepEqual(communityRoute("DELETE", `events/${ID}/rsvp`), { path: `events/${ID}/rsvp`, auth: "required", body: false });
  assert.equal(communityRoute("POST", `events/${ID}/rsvp`), null);
  assert.equal(communityRoute("GET", `events/${ID}/rsvp`), null);
});

test("the web app follows a community and answers events, and makes no other write", () => {
  assert.deepEqual(communityRoute("PUT", `communities/${ID}/follow`), { path: `communities/${ID}/follow`, auth: "required", body: true });
  assert.deepEqual(communityRoute("DELETE", `communities/${ID}/follow`), { path: `communities/${ID}/follow`, auth: "required", body: false });
  for (const [method, path] of [
    ["POST", "communities"],
    ["PUT", `communities/${ID}`],
    ["POST", `communities/${ID}/servers`],
    ["POST", "servers"],
    ["PUT", `servers/${ID}`],
    ["POST", `servers/${ID}/claims`],
    ["POST", `claims/${ID}/verify`],
    ["POST", `communities/${ID}/events`],
    ["PUT", `events/${ID}`],
    ["DELETE", `events/${ID}`],
    ["PUT", `events/${ID}/rsvp?x=1`],
    ["PUT", `events/short/rsvp`],
    ["POST", `communities/${ID}/posts`],
    ["PUT", `posts/${ID}`],
    ["DELETE", `posts/${ID}`],
    ["POST", `communities/${ID}/discord/bot/link`],
    ["PUT", `communities/${ID}/discord/bot`],
    ["DELETE", `communities/${ID}/discord/bot`],
    ["GET", "../me"],
    ["GET", "servers/../../me"],
    ["GET", "servers?token=x"],
    ["GET", "https://example.com"],
    ["GET", "me/extra"],
    ["GET", "servers/short"],
    ["GET", `servers/${ID}/claims`],
    ["GET", `communities/${ID}/follow`],
    ["GET", `communities/${ID}?tab=servers`],
    ["DELETE", "servers"],
  ]) {
    assert.equal(communityRoute(method, path), null, `${method} ${path}`);
  }
});

test("the catalogue query keeps to its keys and lists and is written back", () => {
  assert.equal(
    catalogueQuery("game=jo&tag=power-duel&language=ru&region=cis&sort=followers&limit=50&offset=0"),
    "communities?game=jo&tag=power-duel&language=ru&region=cis&sort=followers&limit=50",
  );
  assert.equal(catalogueQuery("q=%D0%94%D1%83%D1%8D%D0%BB%D0%B8+%26+FFA"), "communities?q=%D0%94%D1%83%D1%8D%D0%BB%D0%B8%20%26%20FFA");
  assert.equal(catalogueQuery("tag=&q="), "communities");
  for (const query of ["tag=pvp", "language=xx", "region=mars", "game=jk3", "sort=random", "limit=-1", "offset=abc", "token=x", "tag=duel&tag=ffa", "q", "q=%FF", "q=a%0Ab"]) {
    assert.equal(catalogueQuery(query), null, query);
  }
  assert.equal(catalogueQuery(`q=${"a".repeat(101)}`), null);
  assert.deepEqual(communityRoute("GET", "communities?sort=new&q=duel"), { path: "communities?q=duel&sort=new", auth: "optional", body: false });
  assert.equal(communityRoute("GET", "communities?sort=random"), null);
});

test("the calendar query keeps to its keys", () => {
  assert.equal(
    eventsQuery(`from=2026-10-01T00:00:00Z&to=2026-11-01&scope=following&game=jo&community=${ID}`),
    `events?from=2026-10-01T00%3A00%3A00Z&to=2026-11-01&scope=following&game=jo&community=${ID}`,
  );
  for (const query of ["scope=mine", "from=yesterday", "community=../me", "limit=10", "after=page2", `after=2026-10-03T16:00:00Z_${ID}x`]) {
    assert.equal(eventsQuery(query), null, query);
  }
  // The `next` of a page reads the page after, written back escaped.
  assert.equal(
    eventsQuery(`from=2026-10-01T00:00:00Z&after=2026-10-03T16%3A00%3A00Z_${ID}`),
    `events?from=2026-10-01T00%3A00%3A00Z&after=2026-10-03T16%3A00%3A00Z_${ID}`,
  );
});

test("a page of the news keeps to its limit and its cursor", () => {
  assert.equal(postsQuery(ID, `limit=20&before=2026-09-30T23%3A07%3A40Z_${ID}`), `communities/${ID}/posts?limit=20&before=2026-09-30T23%3A07%3A40Z_${ID}`);
  assert.equal(postsQuery(ID, "limit="), `communities/${ID}/posts`);
  for (const query of ["limit=-1", "limit=abc", "before=yesterday", "before=2026-09-30T23:07:40Z", "after=x", "limit=1&limit=2"]) {
    assert.equal(postsQuery(ID, query), null, query);
  }
  assert.equal(postsQuery("short", "limit=1"), null);
  assert.deepEqual(communityRoute("GET", `communities/${ID}/posts?limit=5`), { path: `communities/${ID}/posts?limit=5`, auth: "optional", body: false });
  assert.equal(communityRoute("GET", `communities/${ID}/players?limit=5`), null);
  assert.equal(communityRoute("POST", `communities/${ID}/posts?limit=5`), null);
});

test("a community read carries the token while there is one, and a guest reads without it", async () => {
  const signedIn = catalogsAnswering({ communities: [], total: 0 });
  await signedIn.catalogs.community("GET", "communities?sort=new");
  await signedIn.catalogs.community("GET", "me");
  assert.deepEqual(signedIn.calls, [
    { url: "https://api.example.com/v1/community/communities?sort=new", method: "GET", auth: "Bearer T", body: null },
    { url: "https://api.example.com/v1/community/me", method: "GET", auth: "Bearer T", body: null },
  ]);
  const guest = catalogsAnswering({ communities: [], total: 0 }, { signedIn: false });
  await guest.catalogs.community("GET", `communities/${ID}`);
  assert.equal(guest.calls[0].auth, null);
  await assert.rejects(guest.catalogs.community("GET", "following"), (error) => error.code === "online");
  assert.equal(guest.calls.length, 1);
});

test("following sends its body with the token, unfollowing none", async () => {
  const { calls, catalogs } = catalogsAnswering({ id: ID });
  await catalogs.community("PUT", `communities/${ID}/follow`, { notify: false });
  await catalogs.community("PUT", `communities/${ID}/follow`);
  await catalogs.community("DELETE", `communities/${ID}/follow`, { notify: true });
  assert.deepEqual(calls, [
    { url: `https://api.example.com/v1/community/communities/${ID}/follow`, method: "PUT", auth: "Bearer T", body: "{\"notify\":false}" },
    { url: `https://api.example.com/v1/community/communities/${ID}/follow`, method: "PUT", auth: "Bearer T", body: null },
    { url: `https://api.example.com/v1/community/communities/${ID}/follow`, method: "DELETE", auth: "Bearer T", body: null },
  ]);
});

test("a community write is the launcher's, an unknown path is invalid, and neither reaches the service", async () => {
  const { calls, catalogs } = catalogsAnswering({});
  await assert.rejects(catalogs.community("POST", "communities"), (error) => error.code === NEEDS_LAUNCHER);
  await assert.rejects(catalogs.community("POST", "servers"), (error) => error.code === NEEDS_LAUNCHER);
  await assert.rejects(catalogs.community("PUT", `communities/${ID}`), (error) => error.code === NEEDS_LAUNCHER);
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
