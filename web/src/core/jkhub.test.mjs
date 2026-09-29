import assert from "node:assert/strict";
import { test } from "node:test";

import { createHttp } from "./http.ts";
import { createJkhub, MAX_PER_PAGE, readIndexStatus, searchPath, STALE_AFTER_SECS } from "./jkhub.ts";

test("a search asks the service with the launcher's request, every value inside its limits", () => {
  assert.equal(
    searchPath({ game: "jo", query: " hilt by:\"Circa\" ", categoryId: 1000024, sort: "mostDownloaded", direction: "asc", page: 3, perPage: 25 }, "ja"),
    "/v1/jkhub/search?game=jo&q=hilt%20by%3A%22Circa%22&category=1000024&sort=mostDownloaded&direction=asc&page=3&perPage=25",
  );
  assert.equal(searchPath({ game: null, query: "" }, "jo"), "/v1/jkhub/search?game=jo&q=&sort=recentlyUpdated&page=1&perPage=25");
  assert.equal(
    searchPath({ game: "xx", query: "a&b", categoryId: null, sort: "hot", direction: "up", page: -2, perPage: 1000 }, "ja"),
    `/v1/jkhub/search?game=ja&q=a%26b&sort=recentlyUpdated&page=1&perPage=${MAX_PER_PAGE}`,
  );
  assert.equal(searchPath({ query: "x".repeat(300), perPage: 0 }, "ja"), `/v1/jkhub/search?game=ja&q=${"x".repeat(200)}&sort=recentlyUpdated&page=1&perPage=1`);
  assert.equal(searchPath(null, "ja"), "/v1/jkhub/search?game=ja&q=&sort=recentlyUpdated&page=1&perPage=25");
});

test("the service's status of both games becomes the launcher's status of one", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const raw = {
    games: [
      { game: "ja", files: 30, builtAt: "2026-09-20T12:00:00Z", updatedAt: "2026-09-29T11:00:00Z" },
      { game: "jo", files: 0, builtAt: null, updatedAt: null },
    ],
  };
  assert.deepEqual(readIndexStatus(raw, "ja", now), {
    game: "ja",
    available: true,
    builtAt: "2026-09-20T12:00:00Z",
    updatedAt: "2026-09-29T11:00:00Z",
    age: 3600,
    files: 30,
    source: "cache",
    stale: false,
    building: false,
    progress: null,
  });
  assert.deepEqual(readIndexStatus(raw, "jo", now), {
    game: "jo",
    available: false,
    builtAt: "",
    updatedAt: "",
    age: 0,
    files: 0,
    source: "none",
    stale: true,
    building: false,
    progress: null,
  });
  const old = { games: [{ game: "ja", files: 1, builtAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }] };
  assert.equal(readIndexStatus(old, "ja", Date.parse("2026-09-01T00:00:00Z") + (STALE_AFTER_SECS + 1) * 1000).stale, true);
  assert.equal(readIndexStatus({}, "ja", now).available, false);
});

/** The JKHub part over a fake service that records the calls. */
function jkhubAnswering(body, { activeGame = "ja" } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const http = createHttp({ apiBase: "https://api.example.com", token: () => "T", onUnauthorized: () => {}, fetchImpl });
  return { calls, jkhub: createJkhub({ http, activeGame: () => activeGame, now: () => Date.parse("2026-09-29T12:00:00Z") }) };
}

test("the commands go to the service's routes, a command without a game to the active one", async () => {
  const { calls, jkhub } = jkhubAnswering({ games: [] }, { activeGame: "jo" });
  await jkhub.categories(null);
  await jkhub.categories("ja");
  await jkhub.search({ game: null, query: "duel", categoryId: null, sort: "name", page: 1, perPage: 25 });
  await jkhub.indexStatus(null);
  await jkhub.file("ja", 4234);
  assert.deepEqual(calls, [
    "https://api.example.com/v1/jkhub/categories?game=jo",
    "https://api.example.com/v1/jkhub/categories?game=ja",
    "https://api.example.com/v1/jkhub/search?game=jo&q=duel&sort=name&page=1&perPage=25",
    "https://api.example.com/v1/jkhub/status",
    "https://api.example.com/v1/jkhub/files/4234?game=ja",
  ]);
});

test("a file's id and game are checked before any request", async () => {
  const { calls, jkhub } = jkhubAnswering({});
  await assert.rejects(jkhub.file("ja", 0), (error) => error.code === "invalidInput");
  await assert.rejects(jkhub.file("ja", 1.5), (error) => error.code === "invalidInput");
  await assert.rejects(jkhub.file("q3", 1), (error) => error.code === "invalidInput");
  await assert.rejects(jkhub.categories("q3"), (error) => error.code === "invalidInput");
  assert.equal(calls.length, 0);
});
