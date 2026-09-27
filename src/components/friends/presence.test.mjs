/**
 * Tests for src/components/friends/presence.ts: the status line of a friend,
 * and the two labels of a friend who is online only in the web app.
 *
 * Node strips the TypeScript types itself (Node 22.18 and later), so the
 * module runs without a build step and without a test framework.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { groupFriends, statusLine, webDevice } from "./presence.ts";

const SINCE = "2026-09-27T10:00:00Z";

function presence(patch = {}) {
  return {
    status: "online",
    serverAddress: null,
    serverName: null,
    clientName: null,
    since: SINCE,
    ...patch,
  };
}

function friend(id, patch) {
  return {
    user: { id, displayName: id, avatarUrl: null, provider: "dev", providerName: id, createdAt: SINCE },
    presence: presence(patch),
    friendsSince: SINCE,
  };
}

describe("a friend online only in the web app", () => {
  test("says Online from phone on a phone", () => {
    const phone = presence({ via: "web", device: "phone" });
    assert.deepEqual(statusLine(phone), { key: "status.onlineFromPhone" });
    assert.equal(webDevice(phone), "phone");
  });

  test("says Online in browser in a desktop browser", () => {
    const desktop = presence({ via: "web", device: "desktop" });
    assert.deepEqual(statusLine(desktop), { key: "status.onlineInBrowser" });
    assert.equal(webDevice(desktop), "desktop");
  });

  test("reads a missing or unknown device as a phone", () => {
    for (const device of [undefined, null, "tablet"]) {
      const web = presence({ via: "web", device });
      assert.deepEqual(statusLine(web), { key: "status.onlineFromPhone" }, String(device));
      assert.equal(webDevice(web), "phone");
    }
  });

  test("stays in the Online group", () => {
    const groups = groupFriends([
      friend("phone", { via: "web", device: "phone" }),
      friend("browser", { via: "web", device: "desktop" }),
      friend("pc", {}),
    ]);
    assert.deepEqual(
      groups.online.map((row) => row.user.id),
      ["browser", "pc", "phone"],
    );
    assert.equal(groups.in_game.length, 0);
    assert.equal(groups.offline.length, 0);
  });
});

describe("a launcher's presence", () => {
  test("keeps its status lines", () => {
    assert.deepEqual(statusLine(presence()), { key: "status.online" });
    assert.equal(webDevice(presence()), null);
    assert.deepEqual(statusLine(presence({ status: "in_game" })), { key: "status.inGame" });
    assert.deepEqual(
      statusLine(presence({ status: "in_game", serverAddress: "203.0.113.10:29070", serverName: "EU FFA" })),
      { key: "status.playingOn", values: { server: "EU FFA", address: "203.0.113.10:29070" } },
    );
    assert.deepEqual(
      statusLine(presence({ status: "in_game", serverAddress: "203.0.113.10:29070" })),
      { key: "status.playingOnAddress", values: { address: "203.0.113.10:29070" } },
    );
  });

  test("is never labelled by a stray web field", () => {
    // Only `via: "web"` names the web app; a device alone does not, and
    // neither does a player in a game or offline.
    assert.deepEqual(statusLine(presence({ device: "phone" })), { key: "status.online" });
    assert.equal(webDevice(presence({ status: "in_game", via: "web", device: "phone" })), null);
    assert.equal(webDevice(presence({ status: "offline", via: "web", device: "desktop" })), null);
    assert.equal(statusLine(presence({ status: "offline", via: "web", since: "not a date" })).key, "status.offline");
  });

  test("says it hosts a private server first", () => {
    const line = statusLine(
      presence({
        hosting: { sessionId: "5e0b7c1f9a2d4c38", game: "ja", mod: null, map: "mp/ffa3", gametype: 0,
          players: 2, maxPlayers: 8, lanAddresses: [], relayAddress: null, joinPolicy: "friends" },
      }),
    );
    assert.equal(line.key, "host:friends.hosting");
    assert.deepEqual(line.values, { map: "mp/ffa3", players: 2, max: 8 });
  });
});
