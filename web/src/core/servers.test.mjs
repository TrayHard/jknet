import assert from "node:assert/strict";
import { test } from "node:test";

import { onlineError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { createHttp } from "./http.ts";
import {
  CACHE_MS,
  createServerList,
  gameOf,
  isCatalogDisabled,
  readServerList,
  SERVERS_UPDATED_EVENT,
  STALE_RETRY_MS,
  toServerInfo,
} from "./servers.ts";

/** A row of `GET /v1/servers` as the service writes it. */
const DUEL = {
  game: "ja",
  address: "203.0.113.10:29070",
  hostnameRaw: "^1JK^7Net Duel",
  hostnameClean: "JKNet Duel",
  map: "mp/duel1",
  gametype: 3,
  gametypeLabel: "Duel",
  clients: 5,
  humans: 3,
  bots: 2,
  playersSource: "info",
  maxClients: 24,
  needpass: true,
  modName: "japlus",
  protocol: 26,
  lastSeen: "2026-09-29T10:00:00Z",
};

test("a row of the service becomes the launcher's ServerInfo with the launcher's empty values", () => {
  assert.deepEqual(toServerInfo(DUEL, "ja"), {
    ...DUEL,
    pingMs: 0,
    favorite: false,
    hidden: false,
    responded: true,
    missedRefreshes: 0,
    lastPlayers: null,
    lastPlayersAt: null,
  });
});

test("a row is read leniently: no address is no row, half-known counts are unknown", () => {
  assert.equal(toServerInfo({ ...DUEL, address: " " }, "ja"), null);
  assert.equal(toServerInfo("nonsense", "ja"), null);
  const half = toServerInfo({ ...DUEL, bots: null }, "jo");
  assert.equal(half.humans, null);
  assert.equal(half.bots, null);
  assert.equal(half.playersSource, "unknown");
  const bare = toServerInfo({ address: "203.0.113.11:28070" }, "jo");
  assert.equal(bare.game, "jo");
  assert.equal(bare.hostnameClean, "203.0.113.11:28070");
  assert.equal(bare.modName, "base");
  assert.equal(bare.needpass, false);
  assert.equal(bare.maxClients, 0);
});

test("the answer keeps its scan and staleness, and a list without a scan is stale", () => {
  const answer = readServerList({ game: "ja", scannedAt: "2026-09-29T10:00:00Z", stale: false, servers: [DUEL, DUEL, { nope: 1 }] }, "ja");
  assert.equal(answer.scannedAt, "2026-09-29T10:00:00Z");
  assert.equal(answer.stale, false);
  assert.equal(answer.servers.length, 1, "a duplicate and a broken row are left out");
  assert.deepEqual(readServerList({ game: "ja", scannedAt: null, stale: false, servers: [] }, "ja"), {
    game: "ja",
    scannedAt: null,
    stale: true,
    servers: [],
  });
});

test("a command's game: null is the active game, an unknown one is refused", () => {
  assert.equal(gameOf(null, "jo"), "jo");
  assert.equal(gameOf(undefined, "ja"), "ja");
  assert.equal(gameOf("jo", "ja"), "jo");
  assert.throws(() => gameOf("q3", "ja"), (error) => error.code === "invalidInput");
});

test("catalog_disabled is told apart from other refusals", () => {
  assert.equal(isCatalogDisabled(onlineError("catalog_disabled", "off", 503)), true);
  assert.equal(isCatalogDisabled(onlineError("catalog_not_ready", "later", 503)), false);
  assert.equal(isCatalogDisabled(new Error("catalog_disabled")), false);
});

/** A fake clock and timers. */
function clock() {
  let now = 1_000_000;
  const pending = [];
  return {
    timers: {
      now: () => now,
      setTimeout: (handler, ms) => {
        const entry = { at: now + ms, handler };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (entry) => {
        const at = pending.indexOf(entry);
        if (at >= 0) pending.splice(at, 1);
      },
    },
    advance(ms) {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.at <= now) {
          pending.splice(pending.indexOf(entry), 1);
          entry.handler();
        }
      }
    },
    pending: () => pending.length,
  };
}

/** A server list over a fake service answering `bodies` in turn. */
function listAnswering(bodies, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = bodies.length > 1 ? bodies.shift() : bodies[0];
    return new Response(JSON.stringify(body), { status });
  };
  const http = createHttp({ apiBase: "https://api.example.com", token: () => "T", onUnauthorized: () => {}, fetchImpl });
  const events = new EventBus();
  const heard = [];
  events.on(SERVERS_UPDATED_EVENT, (payload) => heard.push(payload));
  const time = clock();
  const list = createServerList({ http, events, signedIn: () => true, timers: time.timers });
  return { calls, heard, time, list };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the screen's read always asks, and every answer is announced with its rows", async () => {
  const { calls, heard, list } = listAnswering([{ game: "jo", scannedAt: "2026-09-29T10:00:00Z", stale: false, servers: [] }]);
  const first = await list.load("jo");
  await list.load("jo");
  assert.deepEqual(calls, ["https://api.example.com/v1/servers?game=jo", "https://api.example.com/v1/servers?game=jo"]);
  assert.equal(first.stale, false);
  assert.deepEqual(heard, [
    { game: "jo", servers: [] },
    { game: "jo", servers: [] },
  ]);
});

test("the pickers' list comes from memory for 30 s, then from the service", async () => {
  const { calls, list, time } = listAnswering([{ game: "ja", scannedAt: "2026-09-29T10:00:00Z", stale: false, servers: [DUEL] }]);
  const rows = await list.cached("ja");
  assert.equal(rows[0].address, DUEL.address);
  rows[0].address = "changed by a screen";
  time.advance(CACHE_MS - 1);
  assert.equal((await list.cached("ja"))[0].address, DUEL.address, "a caller never holds the kept rows");
  assert.equal(calls.length, 1);
  time.advance(1);
  await list.cached("ja");
  assert.equal(calls.length, 2);
});

test("a stale answer is asked again five seconds later, once", async () => {
  const fresh = { game: "ja", scannedAt: "2026-09-29T10:00:00Z", stale: false, servers: [DUEL] };
  const { calls, heard, list, time } = listAnswering([{ game: "ja", scannedAt: null, stale: true, servers: [] }, fresh]);
  assert.deepEqual(await list.cached("ja"), []);
  await list.cached("ja");
  assert.equal(calls.length, 2, "a stale answer is not kept");
  time.advance(STALE_RETRY_MS);
  await settle();
  assert.equal(calls.length, 3, "one retry for both stale reads");
  assert.deepEqual(heard.at(-1), { game: "ja", servers: [toServerInfo(DUEL, "ja")] });
  assert.deepEqual(await list.cached("ja"), [toServerInfo(DUEL, "ja")]);
  assert.equal(calls.length, 3);
});

test("a sign-out forgets the rows and stops the retry", async () => {
  const { calls, list, time } = listAnswering([{ game: "ja", scannedAt: null, stale: true, servers: [] }]);
  await list.cached("ja");
  assert.equal(time.pending(), 1);
  list.forget();
  assert.equal(time.pending(), 0);
  time.advance(STALE_RETRY_MS);
  await settle();
  assert.equal(calls.length, 1);
});

test("a list switched off is the service's refusal, for the screen to say so", async () => {
  const { list } = listAnswering([{ error: { code: "catalog_disabled", message: "The server list is off" } }], { status: 503 });
  await assert.rejects(list.load("ja"), (error) => isCatalogDisabled(error));
  await assert.rejects(list.cached("ja"), (error) => isCatalogDisabled(error));
  await assert.rejects(list.load("xx"), (error) => error.code === "invalidInput");
});
