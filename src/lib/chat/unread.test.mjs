/**
 * Tests for src/lib/chat/unread.ts: totals, badges and read markers.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyRead, badgeLabel, firstUnreadSeq, readersOf, rowBadge, unreadTotals } from "./unread.ts";

const ME = "me";

function member(id, readSeq) {
  return {
    user: { id, displayName: id, avatarUrl: null, provider: "dev", providerName: id, createdAt: "2026-09-10T00:00:00Z" },
    role: "member",
    joinedAt: "2026-09-10T00:00:00Z",
    readSeq,
  };
}

function conversation(fields = {}) {
  return {
    id: "c1",
    kind: "group",
    title: "Cup",
    ownerId: ME,
    members: [member(ME, 10), member("kai", 8), member("dana", null)],
    lastSeq: 12,
    lastMessage: null,
    readSeq: 10,
    visibleFromSeq: 0,
    unread: 2,
    unreadMentions: 1,
    notify: "all",
    canSend: true,
    historyForNewMembers: false,
    server: null,
    createdAt: "2026-09-10T00:00:00Z",
    ...fields,
  };
}

describe("unreadTotals", () => {
  test("muted chats stay out of the unread total, their mentions do not", () => {
    const totals = unreadTotals([
      conversation({ id: "a", unread: 3, unreadMentions: 0 }),
      conversation({ id: "b", unread: 5, unreadMentions: 1, notify: "mute" }),
      conversation({ id: "c", unread: 2, unreadMentions: 2, notify: "mentions" }),
    ]);
    assert.deepEqual(totals, { unread: 5, mentions: 3 });
  });

  test("no conversations", () => {
    assert.deepEqual(unreadTotals([]), { unread: 0, mentions: 0 });
  });
});

describe("badges", () => {
  test("badgeLabel caps at 99+ and hides zero", () => {
    assert.equal(badgeLabel(0), "");
    assert.equal(badgeLabel(7), "7");
    assert.equal(badgeLabel(99), "99");
    assert.equal(badgeLabel(100), "99+");
    assert.equal(badgeLabel(1234, (n) => `#${n}`), "#99+");
  });

  test("rowBadge is grey for a muted chat and absent without unread", () => {
    assert.deepEqual(rowBadge(conversation({ unread: 4 })), { count: 4, muted: false });
    assert.deepEqual(rowBadge(conversation({ unread: 4, notify: "mute" })), { count: 4, muted: true });
    assert.equal(rowBadge(conversation({ unread: 0 })), null);
  });
});

describe("applyRead", () => {
  test("my marker reaching the end clears both counters", () => {
    const next = applyRead(conversation(), ME, 12, ME);
    assert.equal(next.readSeq, 12);
    assert.equal(next.unread, 0);
    assert.equal(next.unreadMentions, 0);
    assert.equal(next.members[0].readSeq, 12);
  });

  test("my marker stopping short keeps the service's counters", () => {
    const next = applyRead(conversation(), ME, 11, ME);
    assert.equal(next.readSeq, 11);
    assert.equal(next.unread, 2);
  });

  test("my marker never moves back", () => {
    assert.equal(applyRead(conversation(), ME, 3, ME).readSeq, 10);
  });

  test("another member's marker only moves forward", () => {
    const forward = applyRead(conversation(), "kai", 11, ME);
    assert.equal(forward.members[1].readSeq, 11);
    const back = applyRead(conversation(), "kai", 5, ME);
    assert.equal(back.members[1].readSeq, 8);
  });

  test("a hidden marker shows up when the service sends it", () => {
    assert.equal(applyRead(conversation(), "dana", 9, ME).members[2].readSeq, 9);
  });

  test("an unknown member changes nothing", () => {
    const c = conversation();
    assert.equal(applyRead(c, "ghost", 9, ME), c);
  });
});

describe("readers and reading", () => {
  test("readersOf leaves me and hidden markers out", () => {
    const readers = readersOf(conversation().members, 8, ME).map((m) => m.user.id);
    assert.deepEqual(readers, ["kai"]);
    assert.deepEqual(readersOf(conversation().members, 9, ME), []);
  });

  test("firstUnreadSeq starts after the marker or after joining", () => {
    assert.equal(firstUnreadSeq(conversation({ readSeq: 4, visibleFromSeq: 0 })), 5);
    assert.equal(firstUnreadSeq(conversation({ readSeq: 0, visibleFromSeq: 20 })), 21);
  });
});
