/**
 * Tests for src/components/host/hostModel.ts: which card a session calls for,
 * the starting steps, the addresses and the console command, the friends of
 * the Invite friends panel, the clocks and the Setup form.
 *
 * Node strips the TypeScript types itself (Node 22.18 and later), so the
 * module runs without a build step and without a test framework.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  consoleCommand,
  countdown,
  currentStep,
  formFromSettings,
  hostView,
  humanCount,
  inviteGroups,
  isHostLive,
  isInMyGame,
  joinAddress,
  lastInvite,
  nextUtcMidnight,
  pickMap,
  ranForSeconds,
  relayAddress,
  relayDown,
  secondsSince,
  secondsUntil,
  settingsToStart,
  stepRows,
  toggleId,
} from "./hostModel.ts";

const SETTINGS = {
  clientId: "etjk",
  map: "mp/ffa3",
  gametype: 0,
  maxPlayers: 8,
  timeLimit: 0,
  scoreLimit: 20,
  bots: 0,
  serverName: "Quinn's game",
  password: "k7m2q9xa",
  network: "internet_lan",
  joinPolicy: "friends",
  joinUserIds: [],
  inviteUserIds: [],
  joinAfterStart: true,
};

const RELAY_OFF = { status: "off", address: null, region: null, expiresAt: null, error: null, errorCode: null };

/** A running session with the relay up, as the core reports one. */
function session(patch = {}) {
  return {
    id: "5e0b7c1f9a2d4c38",
    status: "running",
    steps: [
      { step: "server", state: "done" },
      { step: "map", state: "done" },
      { step: "relay", state: "done" },
    ],
    settings: SETTINGS,
    game: "ja",
    pid: 100,
    port: 29070,
    localAddress: "127.0.0.1:29070",
    lanAddresses: ["192.168.1.23:29070"],
    relay: {
      status: "active",
      address: "203.0.113.5:29210",
      region: "Europe",
      expiresAt: "2026-09-25T20:42:30Z",
      error: null,
      errorCode: null,
    },
    players: [],
    invited: [],
    joinedCount: 0,
    startedAt: "2026-09-25T17:05:48Z",
    readyAt: "2026-09-25T17:06:00Z",
    emptySince: null,
    autoStopAt: null,
    stoppedAt: null,
    stopReason: null,
    exitCode: null,
    failure: null,
    logTail: [],
    ...patch,
  };
}

function friend(id, name, status, serverAddress = null) {
  return {
    user: { id, displayName: name, avatarUrl: null, provider: "dev", providerName: name, createdAt: "2026-09-10T00:00:00Z" },
    presence: { status, serverAddress, serverName: null, clientName: null, since: "2026-09-25T17:00:00Z" },
    friendsSince: "2026-09-10T00:00:00Z",
  };
}

describe("the session", () => {
  test("starting, running and stopping hold the server; the rest do not", () => {
    assert.equal(isHostLive(null), false);
    assert.equal(isHostLive(undefined), false);
    for (const status of ["starting", "running", "stopping"]) {
      assert.equal(isHostLive(session({ status })), true, status);
    }
    for (const status of ["stopped", "failed"]) {
      assert.equal(isHostLive(session({ status })), false, status);
    }
  });

  test("a stopping server keeps its card: Running once ready, Starting before", () => {
    assert.equal(hostView(null), "setup");
    assert.equal(hostView(session({ status: "starting", readyAt: null })), "starting");
    assert.equal(hostView(session({ status: "stopping" })), "running");
    assert.equal(hostView(session({ status: "stopping", readyAt: null })), "starting");
  });

  test("a crash and a failed start both end on the Failed card", () => {
    assert.equal(hostView(session({ status: "stopped", stopReason: "user" })), "stopped");
    assert.equal(hostView(session({ status: "stopped", stopReason: "empty" })), "stopped");
    assert.equal(hostView(session({ status: "stopped", stopReason: "crashed" })), "failed");
    assert.equal(hostView(session({ status: "stopped", stopReason: "start_failed" })), "failed");
    assert.equal(hostView(session({ status: "failed" })), "failed");
  });

  test("bots are not people", () => {
    assert.equal(
      humanCount([
        { name: "Quinn", score: 1, ping: 5, bot: false },
        { name: "Kai", score: 1, ping: 40, bot: false },
        { name: "Tavion", score: 0, ping: 0, bot: true },
      ]),
      2,
    );
    assert.equal(humanCount([]), 0);
  });
});

describe("the starting steps", () => {
  test("Ready waits, then works, then is done with the session", () => {
    const loading = session({
      status: "starting",
      readyAt: null,
      steps: [
        { step: "server", state: "done" },
        { step: "map", state: "active" },
        { step: "relay", state: "pending" },
      ],
    });
    assert.deepEqual(
      stepRows(loading).map((row) => `${row.id}:${row.state}`),
      ["server:done", "map:active", "relay:pending", "ready:pending"],
    );
    assert.equal(currentStep(loading), "map");

    const lanDone = session({
      status: "starting",
      readyAt: null,
      steps: [
        { step: "server", state: "done" },
        { step: "map", state: "done" },
        { step: "relay", state: "skipped" },
      ],
    });
    assert.equal(stepRows(lanDone)[3].state, "active");
    assert.equal(currentStep(lanDone), "ready");

    assert.equal(stepRows(session())[3].state, "done");
  });

  test("a failed step fails Ready", () => {
    const failed = session({
      status: "failed",
      steps: [
        { step: "server", state: "done" },
        { step: "map", state: "failed" },
        { step: "relay", state: "skipped" },
      ],
    });
    assert.equal(stepRows(failed)[3].state, "failed");
  });

  test("a step the core left out reads as waiting", () => {
    const rows = stepRows(session({ status: "starting", readyAt: null, steps: [] }));
    assert.deepEqual(
      rows.map((row) => row.state),
      ["pending", "pending", "pending", "pending"],
    );
  });
});

describe("addresses", () => {
  test("the relay address counts only while the relay carries the server", () => {
    assert.equal(relayAddress(session()), "203.0.113.5:29210");
    assert.equal(
      relayAddress(session({ relay: { ...session().relay, status: "connecting" } })),
      null,
    );
  });

  test("a player without JKNet gets the relay first, then the network", () => {
    assert.equal(joinAddress(session()), "203.0.113.5:29210");
    assert.equal(joinAddress(session({ relay: RELAY_OFF })), "192.168.1.23:29070");
    assert.equal(joinAddress(session({ relay: RELAY_OFF, lanAddresses: [] })), null);
  });

  test("the console command puts the password before the connect", () => {
    assert.equal(
      consoleCommand("k7m2q9xa", "203.0.113.5:29210"),
      "password k7m2q9xa; connect 203.0.113.5:29210",
    );
    assert.equal(consoleCommand(null, "192.168.1.23:29070"), "connect 192.168.1.23:29070");
    assert.equal(consoleCommand("k7m2q9xa", null), null);
  });

  test("a friend is in my game through the relay or the network, never offline", () => {
    const running = session();
    assert.equal(isInMyGame(friend("a", "Kai", "in_game", "203.0.113.5:29210").presence, running), true);
    assert.equal(isInMyGame(friend("b", "Juno", "in_game", "192.168.1.23:29070").presence, running), true);
    assert.equal(isInMyGame(friend("c", "Dana", "in_game", "198.51.100.7:29070").presence, running), false);
    assert.equal(isInMyGame(friend("d", "Sasha", "offline", "203.0.113.5:29210").presence, running), false);
    assert.equal(isInMyGame(friend("e", "Remy", "online").presence, running), false);
  });

  test("the relay is down only where the network mode wants it", () => {
    const unavailable = { ...RELAY_OFF, status: "unavailable", errorCode: "node_silent" };
    assert.equal(relayDown(session({ relay: unavailable })), true);
    assert.equal(relayDown(session({ relay: { ...unavailable, status: "lost" } })), true);
    assert.equal(
      relayDown(session({ relay: unavailable, settings: { ...SETTINGS, network: "lan" } })),
      false,
    );
    assert.equal(relayDown(session()), false);
  });
});

describe("the Invite friends panel", () => {
  test("in-game friends first, then online, each by name; offline apart", () => {
    const groups = inviteGroups([
      friend("1", "juno", "online"),
      friend("2", "Sasha", "offline"),
      friend("3", "Kai", "in_game", "203.0.113.45:28071"),
      friend("4", "Dana", "online"),
      friend("5", "Abe", "offline"),
    ]);
    assert.deepEqual(groups.active.map((f) => f.user.displayName), ["Kai", "Dana", "juno"]);
    assert.deepEqual(groups.offline.map((f) => f.user.displayName), ["Abe", "Sasha"]);
  });

  test("the last invite of a friend is the latest one", () => {
    const invited = [
      { userId: "a", at: "2026-09-25T17:00:00Z", ok: false },
      { userId: "b", at: "2026-09-25T17:10:00Z", ok: true },
      { userId: "a", at: "2026-09-25T17:20:00Z", ok: true },
    ];
    assert.deepEqual(lastInvite(invited, "a"), invited[2]);
    assert.equal(lastInvite(invited, "c"), undefined);
  });

  test("toggling keeps the order of what stays", () => {
    assert.deepEqual(toggleId(["a", "b"], "c"), ["a", "b", "c"]);
    assert.deepEqual(toggleId(["a", "b", "c"], "b"), ["a", "c"]);
  });
});

describe("clocks", () => {
  const now = Date.parse("2026-09-25T17:30:00Z");

  test("seconds since and until never go below zero", () => {
    assert.equal(secondsSince("2026-09-25T17:06:00Z", now), 24 * 60);
    assert.equal(secondsSince("2026-09-25T18:00:00Z", now), 0);
    assert.equal(secondsSince(null, now), null);
    assert.equal(secondsSince("not a date", now), null);
    assert.equal(secondsUntil("2026-09-25T17:44:32Z", now), 14 * 60 + 32);
    assert.equal(secondsUntil("2026-09-25T17:00:00Z", now), 0);
    assert.equal(secondsUntil(null, now), null);
  });

  test("a countdown reads like a clock", () => {
    assert.equal(countdown(14 * 60 + 32), "14:32");
    assert.equal(countdown(9), "0:09");
    assert.equal(countdown(3600 + 5 * 60), "1:05:00");
    assert.equal(countdown(-3), "0:00");
  });

  test("a run lasts from ready to stop", () => {
    const stopped = session({
      status: "stopped",
      readyAt: "2026-09-25T16:00:00Z",
      stoppedAt: "2026-09-25T17:24:00Z",
    });
    assert.equal(ranForSeconds(stopped), 84 * 60);
    assert.equal(ranForSeconds(session()), null);
  });

  test("the daily relay time comes back at the next midnight UTC", () => {
    assert.equal(nextUtcMidnight(now).toISOString(), "2026-09-26T00:00:00.000Z");
  });
});

describe("the Setup form", () => {
  test("a form keeps the suggested password, or takes a fresh one", () => {
    const form = formFromSettings(SETTINGS, "fresh123");
    assert.equal(form.requirePassword, true);
    assert.equal(form.password, "k7m2q9xa");
    const open = formFromSettings({ ...SETTINGS, password: null }, "fresh123");
    assert.equal(open.requirePassword, false);
    assert.equal(open.password, "fresh123");
  });

  test("a start sends a trimmed name, no password when off, no duplicates", () => {
    const form = {
      settings: {
        ...SETTINGS,
        serverName: "   ",
        joinUserIds: ["a", "a", "b"],
        inviteUserIds: ["c", "c"],
      },
      requirePassword: false,
      password: "k7m2q9xa",
    };
    const settings = settingsToStart(form, "JKNet game", false);
    assert.equal(settings.serverName, "JKNet game");
    assert.equal(settings.password, null);
    assert.deepEqual(settings.joinUserIds, ["a", "b"]);
    assert.deepEqual(settings.inviteUserIds, ["c"]);
    assert.equal(settings.joinAfterStart, false);

    const named = settingsToStart(
      { ...form, settings: { ...form.settings, serverName: " Duels " }, requirePassword: true },
      "JKNet game",
      true,
    );
    assert.equal(named.serverName, "Duels");
    assert.equal(named.password, "k7m2q9xa");
    assert.equal(named.joinAfterStart, true);
  });

  test("a map that left the list gives way to the default, then to the first", () => {
    const names = ["mp/ffa1", "mp/ffa3", "atlantica"];
    assert.equal(pickMap(names, "mp/ffa3", "mp/ffa1"), "mp/ffa3");
    assert.equal(pickMap(names, "mp/duel1", "mp/ffa3"), "mp/ffa3");
    assert.equal(pickMap(names, "mp/duel1", "mp/duel2"), "mp/ffa1");
    assert.equal(pickMap([], "mp/duel1", "mp/ffa3"), "");
  });
});
