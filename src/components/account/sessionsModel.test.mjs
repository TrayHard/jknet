/**
 * Tests for src/components/account/sessionsModel.ts: the icon, the tags, the
 * name and the order of the rows of the Devices and sessions card, and how
 * long ago a device was last active.
 *
 * Node strips the TypeScript types itself (Node 22.18 and later), so the
 * module runs without a build step and without a test framework.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  canSignOut,
  hasOthers,
  orderSessions,
  relativeAge,
  sessionIcon,
  sessionName,
  sessionTags,
} from "./sessionsModel.ts";

function session(patch = {}) {
  return {
    id: "01JPC",
    client: "launcher",
    device: null,
    deviceName: "QUINN-PC",
    createdAt: "2026-09-20T10:00:00Z",
    lastUsedAt: "2026-09-27T10:00:00Z",
    expiresAt: "2026-12-19T10:00:00Z",
    current: false,
    online: false,
    push: false,
    ...patch,
  };
}

describe("a row of the devices card", () => {
  test("shows a monitor for a launcher and a phone or a globe for the web app", () => {
    assert.equal(sessionIcon(session()), "launcher");
    assert.equal(sessionIcon(session({ client: "web", device: "phone" })), "phone");
    assert.equal(sessionIcon(session({ client: "web", device: "desktop" })), "desktop");
    // A web session of unknown kind reads as a phone, like a friend's presence.
    assert.equal(sessionIcon(session({ client: "web", device: null })), "phone");
    // A client the card does not know is the other thing that signs in.
    assert.equal(sessionIcon(session({ client: "tv" })), "launcher");
  });

  test("tags this device, a live socket and push, in that order", () => {
    assert.deepEqual(sessionTags(session()), []);
    assert.deepEqual(sessionTags(session({ current: true, online: true, push: true })), [
      "thisDevice",
      "online",
      "pushOn",
    ]);
    assert.deepEqual(sessionTags(session({ push: true })), ["pushOn"]);
  });

  test("falls back to Unnamed device for a missing or blank name", () => {
    assert.equal(sessionName(session()), "QUINN-PC");
    assert.equal(sessionName(session({ deviceName: "  JKNet web · Android · Chrome " })), "JKNet web · Android · Chrome");
    assert.equal(sessionName(session({ deviceName: null })), null);
    assert.equal(sessionName(session({ deviceName: "   " })), null);
  });

  test("has a Sign out on every row but this device's", () => {
    assert.equal(canSignOut(session({ current: true })), false);
    assert.equal(canSignOut(session()), true);
  });
});

describe("the list", () => {
  test("puts this device first and keeps the service's order for the rest", () => {
    const list = [
      session({ id: "phone", client: "web", device: "phone" }),
      session({ id: "pc", current: true }),
      session({ id: "laptop" }),
    ];
    assert.deepEqual(
      orderSessions(list).map((row) => row.id),
      ["pc", "phone", "laptop"],
    );
    assert.deepEqual(list.map((row) => row.id), ["phone", "pc", "laptop"], "the query's list is not touched");
  });

  test("offers Sign out of all other devices only when there are others", () => {
    assert.equal(hasOthers([session({ current: true })]), false);
    assert.equal(hasOthers([]), false);
    assert.equal(hasOthers([session({ current: true }), session({ id: "phone" })]), true);
  });
});

describe("last active", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");

  test("rounds down to the largest whole unit", () => {
    assert.deepEqual(relativeAge("2026-09-27T11:59:30Z", now), { value: 0, unit: "minute" });
    assert.deepEqual(relativeAge("2026-09-27T11:15:00Z", now), { value: 45, unit: "minute" });
    assert.deepEqual(relativeAge("2026-09-27T09:00:00Z", now), { value: 3, unit: "hour" });
    assert.deepEqual(relativeAge("2026-09-25T12:00:00Z", now), { value: 2, unit: "day" });
    assert.deepEqual(relativeAge("2026-09-13T12:00:00Z", now), { value: 2, unit: "week" });
    assert.deepEqual(relativeAge("2026-07-27T12:00:00Z", now), { value: 2, unit: "month" });
  });

  test("reads a time ahead of this clock as now and a non-date as nothing", () => {
    assert.deepEqual(relativeAge("2026-09-27T12:05:00Z", now), { value: 0, unit: "minute" });
    assert.equal(relativeAge("yesterday", now), null);
  });
});
