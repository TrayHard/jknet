/**
 * Tests for src/components/community/api.ts and format.ts: the paths the
 * client builds for the bridges of the three hosts, how it reads a refusal
 * of any transport, the week's top and the activity, and the small computations
 * the community screens share.
 *
 * Node strips the TypeScript types itself (Node 22.18 and later), so the
 * modules run without a build step and without a test framework.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  blobUrl,
  catalogPath,
  communityApi,
  eventsPath,
  failureOf,
  isCommunityId,
  isNotFound,
  isTimeCursor,
  MAX_SEARCH,
  postsPath,
  readActivity,
  readRanking,
} from "./api.ts";
import { communityHue, daysSince, hostOf, isHttps, monogram, orderedServers, serverName } from "./format.ts";

const ID = `01J${"A".repeat(23)}`;
const OTHER = `01K${"B".repeat(23)}`;

function card(patch = {}) {
  return {
    id: ID,
    name: "Holocron Duel Club",
    tagline: "",
    website: "",
    discord: "",
    links: [],
    tags: [],
    languages: [],
    region: null,
    bundle: null,
    logo: null,
    banner: null,
    ownerId: null,
    owner: null,
    featured: false,
    listed: false,
    verified: true,
    games: ["ja"],
    servers: [],
    counts: { followers: 0, regulars: 0, upcomingEvents: 0 },
    revision: 1,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...patch,
  };
}

function server(patch = {}) {
  return {
    id: OTHER,
    game: "ja",
    address: "203.0.113.15:29070",
    label: "",
    position: 0,
    verified: true,
    verifiedAt: null,
    ...patch,
  };
}

/** A transport that records every call and answers what the test says. */
function recorder(answer = () => Promise.resolve(null)) {
  const calls = [];
  const request = (method, path, body) => {
    calls.push({ method, path, body });
    return answer(method, path, body);
  };
  return { calls, api: communityApi(request) };
}

describe("isCommunityId", () => {
  test("takes the 26 letters and digits of a ULID", () => {
    assert.equal(isCommunityId(ID), true);
    assert.equal(isCommunityId(ID.toLowerCase()), true);
  });

  test("refuses every other shape", () => {
    for (const value of [ID.slice(1), `${ID}A`, `${ID.slice(1)}-`, "example-server", "", null, undefined]) {
      assert.equal(isCommunityId(value), false, String(value));
    }
  });
});

describe("catalogPath", () => {
  test("without filters asks for the plain catalogue", () => {
    assert.equal(catalogPath(), "communities");
    assert.equal(catalogPath({ sort: "featured", offset: 0 }), "communities");
  });

  test("puts the known filters in a fixed order", () => {
    assert.equal(
      catalogPath({ sort: "followers", region: "eu", language: "ru", tag: "duel", game: "jo", limit: 24, offset: 48 }),
      "communities?game=jo&tag=duel&language=ru&region=eu&sort=followers&limit=24&offset=48",
    );
  });

  test("drops what the bridges would refuse", () => {
    assert.equal(
      catalogPath({ game: "jk3", tag: "pvp", language: "xx", region: "mars", sort: "random", limit: Number.NaN, offset: -5 }),
      "communities",
    );
  });

  test("keeps limit and offset inside the bridges' bounds", () => {
    assert.equal(catalogPath({ limit: 0 }), "communities?limit=1");
    assert.equal(catalogPath({ limit: 9000 }), "communities?limit=500");
    assert.equal(catalogPath({ offset: 1_000_000 }), "communities?offset=99999");
    assert.equal(catalogPath({ limit: 12.7 }), "communities?limit=12");
  });

  test("escapes the search, turns control characters into spaces and cuts it at the limit", () => {
    assert.equal(catalogPath({ q: "  Duel & RP  " }), "communities?q=Duel%20%26%20RP");
    assert.equal(catalogPath({ q: "a\u0000b\nc" }), "communities?q=a%20b%20c");
    assert.equal(catalogPath({ q: " \t " }), "communities");
    const long = "я".repeat(MAX_SEARCH + 20);
    const query = decodeURIComponent(catalogPath({ q: long }).slice("communities?q=".length));
    assert.equal(Array.from(query).length, MAX_SEARCH);
  });
});

describe("eventsPath", () => {
  test("without filters asks for the plain calendar", () => {
    assert.equal(eventsPath(), "events");
  });

  test("keeps moments, the scope, the game and a valid community", () => {
    assert.equal(
      eventsPath({ from: "2026-10-01T00:00:00Z", to: "2026-10-08", scope: "following", game: "ja", community: ID }),
      `events?from=2026-10-01T00%3A00%3A00Z&to=2026-10-08&scope=following&game=ja&community=${ID}`,
    );
  });

  test("drops values of another shape", () => {
    assert.equal(eventsPath({ from: "tomorrow", scope: "mine", game: "jk3", community: "example-server", after: "page2" }), "events");
  });

  test("carries the cursor of the page before last", () => {
    assert.equal(
      eventsPath({ from: "2026-10-01T00:00:00Z", community: ID, after: `2026-10-03T16:00:00Z_${OTHER}` }),
      `events?from=2026-10-01T00%3A00%3A00Z&community=${ID}&after=2026-10-03T16%3A00%3A00Z_${OTHER}`,
    );
  });
});

describe("readRanking", () => {
  test("is null when the answer holds no place", () => {
    for (const answer of [null, undefined, 3, "top", {}, { communities: [] }, { communities: [{ rank: 1 }] }, { period: "week" }]) {
      assert.equal(readRanking(answer), null, JSON.stringify(answer));
    }
  });

  test("reads the places of the service: a card with its rank and player-hours", () => {
    const answer = {
      period: "week",
      communities: [
        { ...card({ counts: { followers: 0, regulars: 0, upcomingEvents: 0, online: 0, playerHoursWeek: 540 } }), rank: 1, playerHoursWeek: 540 },
        { ...card({ id: OTHER }), rank: 2, playerHoursWeek: 312.5 },
      ],
    };
    assert.deepEqual(
      readRanking(answer).map((entry) => [entry.rank, entry.community.id, entry.playerHoursWeek]),
      [
        [1, ID, 540],
        [2, OTHER, 312.5],
      ],
    );
  });

  test("falls back on the counts of the card and on the order given", () => {
    const answer = { communities: [card({ counts: { followers: 0, regulars: 0, upcomingEvents: 0, playerHoursWeek: 90 } }), card({ id: OTHER })] };
    assert.deepEqual(
      readRanking(answer).map((entry) => [entry.rank, entry.community.id, entry.playerHoursWeek]),
      [
        [1, ID, 90],
        [2, OTHER, 0],
      ],
    );
  });

  test("skips a place without a valid card", () => {
    const answer = { communities: [{ id: "bad", name: "Bad", rank: 1 }, { ...card(), rank: 2, playerHoursWeek: 4 }] };
    assert.deepEqual(
      readRanking(answer).map((entry) => [entry.rank, entry.community.id]),
      [[2, ID]],
    );
  });
});

describe("isTimeCursor", () => {
  test("takes a time in UTC to the second and an id", () => {
    assert.equal(isTimeCursor(`2026-09-30T23:07:40Z_${ID}`), true);
  });

  test("refuses every other shape", () => {
    for (const value of [
      "",
      ID,
      "2026-09-30T23:07:40Z",
      `2026-09-30T23:07:40.123Z_${ID}`,
      `2026-09-30T23:07:40+03:00_${ID}`,
      `2026-09-30T23:07:40Z_${ID}x`,
      `2026-09-30T23:07:40Z_../me`,
      null,
      undefined,
    ]) {
      assert.equal(isTimeCursor(value), false, String(value));
    }
  });
});

describe("postsPath", () => {
  test("without a page asks for the first one", () => {
    assert.equal(postsPath(ID), `communities/${ID}/posts`);
  });

  test("keeps the limit within 1 to 50 and a cursor of the service", () => {
    const cursor = `2026-09-30T23:07:40Z_${OTHER}`;
    assert.equal(postsPath(ID, { limit: 10, before: cursor }), `communities/${ID}/posts?limit=10&before=2026-09-30T23%3A07%3A40Z_${OTHER}`);
    assert.equal(postsPath(ID, { limit: 0 }), `communities/${ID}/posts?limit=1`);
    assert.equal(postsPath(ID, { limit: 500 }), `communities/${ID}/posts?limit=50`);
  });

  test("drops a cursor of another shape and refuses an id of another shape", () => {
    assert.equal(postsPath(ID, { before: "yesterday" }), `communities/${ID}/posts`);
    assert.throws(() => postsPath("example-server"), (error) => isNotFound(error));
  });
});

describe("readActivity", () => {
  const heatmap = Array.from({ length: 168 }, (_, index) => (index === 19 ? 12.5 : 0));

  test("reads the activity of the service", () => {
    const activity = readActivity({ heatmap, peak: { humans: 26, at: "2026-09-25T18:00:00Z" }, playerHoursWeek: 312.5, onlineNow: 14, days: 28 });
    assert.equal(activity.heatmap.length, 168);
    assert.equal(activity.heatmap[19], 12.5);
    assert.deepEqual(activity.peak, { humans: 26, at: "2026-09-25T18:00:00Z" });
    assert.equal(activity.playerHoursWeek, 312.5);
    assert.equal(activity.onlineNow, 14);
    assert.equal(activity.days, 28);
  });

  test("reads an empty community as no peak and zeros", () => {
    const activity = readActivity({ heatmap: Array(168).fill(0), peak: null, playerHoursWeek: 0, onlineNow: 0, days: 0 });
    assert.equal(activity.peak, null);
    assert.equal(activity.days, 0);
  });

  test("is null without a heat map of 168 hours, and keeps the numbers finite", () => {
    for (const answer of [null, {}, { heatmap: [] }, { heatmap: Array(167).fill(1) }, "x"]) {
      assert.equal(readActivity(answer), null, JSON.stringify(answer));
    }
    const odd = readActivity({ heatmap: [...Array(167).fill(1), "x"], peak: { humans: "a", at: "t" }, playerHoursWeek: Number.NaN });
    assert.equal(odd.heatmap[167], 0);
    assert.equal(odd.peak, null);
    assert.equal(odd.playerHoursWeek, 0);
  });
});

describe("failureOf", () => {
  test("reads the envelope of the launcher and of the web core", () => {
    assert.deepEqual(failureOf({ code: "online", message: "outer", details: { code: "limit", message: "Too many servers" } }), {
      code: "limit",
      message: "Too many servers",
    });
    assert.deepEqual(failureOf({ code: "online", message: "outer", details: { code: "conflict" } }), {
      code: "conflict",
      message: "outer",
    });
  });

  test("reads the website's network error and a coded error", () => {
    assert.deepEqual(failureOf(Object.assign(new Error("offline"), { code: "network" })), { code: "network", message: "offline" });
    assert.deepEqual(failureOf({ code: "invalidInput", message: "bad" }), { code: "invalidInput", message: "bad" });
  });

  test("reads the text form of a refusal and anything else", () => {
    assert.deepEqual(failureOf("online not_found: No such community"), { code: "not_found", message: "No such community" });
    assert.deepEqual(failureOf("something broke"), { code: "", message: "something broke" });
    assert.deepEqual(failureOf(new Error("plain")), { code: "", message: "plain" });
    assert.deepEqual(failureOf(undefined), { code: "", message: "" });
  });

  test("isNotFound takes both spellings of the code", () => {
    assert.equal(isNotFound({ code: "online", details: { code: "not_found" } }), true);
    assert.equal(isNotFound({ code: "notFound" }), true);
    assert.equal(isNotFound({ code: "online", details: { code: "forbidden" } }), false);
  });
});

describe("blobUrl", () => {
  const sha = "a".repeat(64);

  test("points into the store of the service", () => {
    assert.equal(blobUrl("https://api.example.com/", sha), `https://api.example.com/v1/blobs/${sha}`);
  });

  test("is null without a picture or a service", () => {
    assert.equal(blobUrl("https://api.example.com", null), null);
    assert.equal(blobUrl("https://api.example.com", "A".repeat(64)), null);
    assert.equal(blobUrl("https://api.example.com", "../../etc"), null);
    assert.equal(blobUrl("", sha), null);
  });
});

describe("communityApi", () => {
  test("builds the path of every read of a page", async () => {
    const { calls, api } = recorder();
    await api.get(ID);
    await api.players(ID);
    await api.discord(ID);
    await api.me();
    await api.following();
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      [`GET communities/${ID}`, `GET communities/${ID}/players`, `GET communities/${ID}/discord`, "GET me", "GET following"],
    );
  });

  test("follows with the notifications as a body and unfollows without one", async () => {
    const { calls, api } = recorder();
    await api.follow(ID, false);
    await api.follow(ID);
    await api.unfollow(ID);
    assert.deepEqual(calls, [
      { method: "PUT", path: `communities/${ID}/follow`, body: { notify: false } },
      { method: "PUT", path: `communities/${ID}/follow`, body: undefined },
      { method: "DELETE", path: `communities/${ID}/follow`, body: undefined },
    ]);
  });

  test("names the server and the claim in their own segments", async () => {
    const { calls, api } = recorder();
    await api.claim(OTHER, true);
    await api.verify(OTHER);
    await api.review(OTHER, true, true);
    await api.updateServer(ID, OTHER, { label: "Duel" });
    assert.deepEqual(
      calls.map((call) => [call.method, call.path, call.body]),
      [
        ["POST", `servers/${OTHER}/claims`, { manual: true }],
        ["POST", `claims/${OTHER}/verify`, undefined],
        ["POST", `admin/claims/${OTHER}`, { approve: true, featured: true }],
        ["PUT", `communities/${ID}/servers/${OTHER}`, { label: "Duel" }],
      ],
    );
  });

  test("refuses an id of another shape before any request, as not found", () => {
    const { calls, api } = recorder();
    assert.throws(
      () => api.get("example-server"),
      (error) => isNotFound(error),
    );
    assert.throws(() => api.follow(`${ID}/../admin`), (error) => isNotFound(error));
    assert.equal(calls.length, 0);
  });

  test("reads a missing ranking as none and passes other refusals on", async () => {
    const missing = recorder(() => Promise.reject({ code: "online", details: { code: "not_found" } }));
    assert.equal(await missing.api.ranking(), null);
    const broken = recorder(() => Promise.reject({ code: "online", details: { code: "internal" } }));
    await assert.rejects(broken.api.ranking(), (error) => failureOf(error).code === "internal");
    const ranked = recorder(() => Promise.resolve({ period: "week", communities: [{ ...card(), rank: 1, playerHoursWeek: 7 }] }));
    assert.equal((await ranked.api.ranking())[0].playerHoursWeek, 7);
    const empty = recorder(() => Promise.resolve({ period: "week", communities: [] }));
    assert.equal(await empty.api.ranking(), null);
  });

  test("reads a missing activity as none", async () => {
    const missing = recorder(() => Promise.reject({ code: "online", details: { code: "not_found" } }));
    assert.equal(await missing.api.activity(ID), null);
    const { calls, api } = recorder(() => Promise.resolve({ heatmap: Array(168).fill(0), peak: null, playerHoursWeek: 0, onlineNow: 0, days: 0 }));
    assert.equal((await api.activity(ID)).days, 0);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [`GET communities/${ID}/activity`]);
  });

  test("reads missing news as none and passes other refusals on", async () => {
    const missing = recorder(() => Promise.reject({ code: "online", details: { code: "not_found" } }));
    assert.deepEqual(await missing.api.posts(ID), { posts: [], next: null });
    await assert.rejects(missing.api.posts("example-server"), (error) => isNotFound(error));
    assert.equal(missing.calls.length, 1);
    const broken = recorder(() => Promise.reject({ code: "online", details: { code: "internal" } }));
    await assert.rejects(broken.api.posts(ID), (error) => failureOf(error).code === "internal");
  });

  test("builds the routes of the news", async () => {
    const { calls, api } = recorder();
    const cursor = `2026-09-30T23:07:40Z_${OTHER}`;
    await api.posts(ID);
    await api.posts(ID, { before: cursor });
    await api.createPost(ID, { title: "Season two", body: "Ladder", pinned: true, notifyFollowers: false });
    await api.updatePost(OTHER, { pinned: false, revision: 3 });
    await api.removePost(OTHER);
    assert.deepEqual(
      calls.map((call) => [call.method, call.path, call.body]),
      [
        ["GET", `communities/${ID}/posts`, undefined],
        ["GET", `communities/${ID}/posts?before=2026-09-30T23%3A07%3A40Z_${OTHER}`, undefined],
        ["POST", `communities/${ID}/posts`, { title: "Season two", body: "Ladder", pinned: true, notifyFollowers: false }],
        ["PUT", `posts/${OTHER}`, { pinned: false, revision: 3 }],
        ["DELETE", `posts/${OTHER}`, undefined],
      ],
    );
    assert.throws(() => api.removePost("../me"), (error) => isNotFound(error));
  });

  test("builds the routes of the JKNet bot", async () => {
    const { calls, api } = recorder();
    await api.discordBotLink(ID);
    await api.discordBot(ID, { announcementsChannelId: "1187291503468114003" });
    await api.discordBot(ID, { showChannels: false });
    await api.unlinkDiscordBot(ID);
    assert.deepEqual(
      calls.map((call) => [call.method, call.path, call.body]),
      [
        ["POST", `communities/${ID}/discord/bot/link`, undefined],
        ["PUT", `communities/${ID}/discord/bot`, { announcementsChannelId: "1187291503468114003" }],
        ["PUT", `communities/${ID}/discord/bot`, { showChannels: false }],
        ["DELETE", `communities/${ID}/discord/bot`, undefined],
      ],
    );
  });
});

describe("format", () => {
  test("monogram takes the first letters of the first two words", () => {
    assert.equal(monogram("Holocron Duel Club"), "HD");
    assert.equal(monogram("SWJKA | Russian Public"), "SR");
    assert.equal(monogram("сибирский джедай"), "СД");
    assert.equal(monogram("kyber"), "KY");
    assert.equal(monogram(" | "), "?");
  });

  test("hostOf drops www. and a trailing slash", () => {
    assert.equal(hostOf("https://www.example.com/clan/"), "example.com/clan");
    assert.equal(hostOf("not a link"), "not a link");
  });

  test("isHttps opens https only", () => {
    assert.equal(isHttps("https://discord.gg/example"), true);
    assert.equal(isHttps("http://example.com"), false);
    assert.equal(isHttps("javascript:alert(1)"), false);
    assert.equal(isHttps(""), false);
  });

  test("daysSince counts whole UTC days and never goes below zero", () => {
    const now = new Date("2026-09-25T17:30:00Z");
    assert.equal(daysSince("2026-09-24", now), 1);
    assert.equal(daysSince("2026-08-26", now), 30);
    assert.equal(daysSince("2026-09-26", now), 0);
    assert.equal(daysSince("yesterday", now), null);
  });

  test("servers keep the order of the page and are named by label or address", () => {
    const ffa = server({ id: "a", label: "FFA", position: 1 });
    const duel = server({ id: "b", label: " ", position: 0, address: "203.0.113.15:29071" });
    assert.deepEqual(
      orderedServers(card({ servers: [ffa, duel] })).map((item) => item.id),
      ["b", "a"],
    );
    assert.equal(serverName(ffa), "FFA");
    assert.equal(serverName(duel), "203.0.113.15:29071");
  });

  test("communityHue is a stable hue", () => {
    assert.equal(communityHue(ID), communityHue(ID));
    for (const id of [ID, OTHER, "", "x"]) {
      const hue = communityHue(id);
      assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${id}: ${hue}`);
    }
  });
});
