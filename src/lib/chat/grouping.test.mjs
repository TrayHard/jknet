/**
 * Tests for src/lib/chat/grouping.ts: day dividers, the unread divider and
 * runs of one sender, a deleted account included.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { layoutThread, localDay, sameSender, unreadDividerSeq } from "./grouping.ts";

const ME = "01K5QUINN4Z8M2N6R3T7V9X1Y0";
const KAI = "01K5KAI000000000000000000A";

/** A UTC day, so the tests do not depend on the machine's time zone. */
const utcDay = (iso) => iso.slice(0, 10);

function message(seq, senderId, createdAt, kind = "user") {
  return {
    conversationId: "c1",
    seq,
    senderId: kind === "system" ? null : senderId,
    clientId: null,
    kind,
    body: `m${seq}`,
    cards: [],
    files: [],
    mentions: [],
    replyTo: null,
    reactions: [],
    system: kind === "system" ? { event: "memberJoined", userId: senderId } : null,
    createdAt,
  };
}

function shape(items) {
  return items.map((item) => {
    if (item.type === "group") return `group:${item.senderId ?? "deleted"}:${item.messages.map((m) => m.seq).join(",")}`;
    if (item.type === "day") return `day:${item.day}`;
    if (item.type === "system") return `system:${item.message.seq}`;
    return "unread";
  });
}

describe("layoutThread", () => {
  test("messages of one sender within five minutes form one group", () => {
    const items = layoutThread(
      [
        message(1, KAI, "2026-09-25T17:00:00Z"),
        message(2, KAI, "2026-09-25T17:04:00Z"),
        message(3, KAI, "2026-09-25T17:09:30Z"),
      ],
      { meId: ME, unreadAfterSeq: null, dayOf: utcDay },
    );
    assert.deepEqual(shape(items), ["day:2026-09-25", `group:${KAI}:1,2`, `group:${KAI}:3`]);
  });

  test("another sender starts a new group", () => {
    const items = layoutThread(
      [
        message(1, KAI, "2026-09-25T17:00:00Z"),
        message(2, ME, "2026-09-25T17:00:30Z"),
        message(3, KAI, "2026-09-25T17:01:00Z"),
      ],
      { meId: ME, unreadAfterSeq: null, dayOf: utcDay },
    );
    assert.deepEqual(shape(items), ["day:2026-09-25", `group:${KAI}:1`, `group:${ME}:2`, `group:${KAI}:3`]);
    assert.equal(items[2].mine, true);
    assert.equal(items[1].mine, false);
  });

  test("a new day starts a new group with a divider", () => {
    const items = layoutThread(
      [message(1, KAI, "2026-09-24T23:58:00Z"), message(2, KAI, "2026-09-25T00:01:00Z")],
      { meId: ME, unreadAfterSeq: null, dayOf: utcDay },
    );
    assert.deepEqual(shape(items), ["day:2026-09-24", `group:${KAI}:1`, "day:2026-09-25", `group:${KAI}:2`]);
  });

  test("a system line stands alone and breaks the group", () => {
    const items = layoutThread(
      [
        message(1, KAI, "2026-09-25T17:00:00Z"),
        message(2, KAI, "2026-09-25T17:00:10Z", "system"),
        message(3, KAI, "2026-09-25T17:00:20Z"),
      ],
      { meId: ME, unreadAfterSeq: null, dayOf: utcDay },
    );
    assert.deepEqual(shape(items), ["day:2026-09-25", `group:${KAI}:1`, "system:2", `group:${KAI}:3`]);
  });

  test("the unread divider goes before the first unread message of somebody else and splits the group", () => {
    const items = layoutThread(
      [
        message(1, KAI, "2026-09-25T17:00:00Z"),
        message(2, ME, "2026-09-25T17:00:10Z"),
        message(3, KAI, "2026-09-25T17:00:20Z"),
        message(4, KAI, "2026-09-25T17:00:30Z"),
      ],
      { meId: ME, unreadAfterSeq: 1, dayOf: utcDay },
    );
    // Seq 2 is mine: it is not unread. The divider sits before 3.
    assert.deepEqual(shape(items), [
      "day:2026-09-25",
      `group:${KAI}:1`,
      `group:${ME}:2`,
      "unread",
      `group:${KAI}:3,4`,
    ]);
  });

  test("messages of a deleted account (senderId null) group together as one sender", () => {
    const items = layoutThread(
      [
        message(1, null, "2026-09-25T17:00:00Z"),
        message(2, null, "2026-09-25T17:01:00Z"),
        message(3, KAI, "2026-09-25T17:02:00Z"),
        message(4, null, "2026-09-25T17:03:00Z"),
      ],
      { meId: ME, unreadAfterSeq: null, dayOf: utcDay },
    );
    assert.deepEqual(shape(items), ["day:2026-09-25", "group:deleted:1,2", `group:${KAI}:3`, "group:deleted:4"]);
    assert.equal(items[1].mine, false);
  });

  test("a deleted account's messages are never mine, even before my id is known", () => {
    const items = layoutThread([message(1, null, "2026-09-25T17:00:00Z")], {
      meId: null,
      unreadAfterSeq: null,
      dayOf: utcDay,
    });
    assert.equal(items[1].mine, false);
  });

  test("keys are unique", () => {
    const messages = [];
    for (let seq = 1; seq <= 40; seq += 1) {
      messages.push(message(seq, seq % 3 === 0 ? ME : KAI, new Date(Date.UTC(2026, 8, 20 + (seq % 4), 12, seq)).toISOString(), seq % 7 === 0 ? "system" : "user"));
    }
    messages.sort((a, b) => a.seq - b.seq);
    const items = layoutThread(messages, { meId: ME, unreadAfterSeq: 10, dayOf: utcDay });
    assert.equal(new Set(items.map((item) => item.key)).size, items.length);
  });
});

describe("unreadDividerSeq", () => {
  const thread = [
    message(1, KAI, "2026-09-25T17:00:00Z"),
    message(2, KAI, "2026-09-25T17:00:10Z", "system"),
    message(3, ME, "2026-09-25T17:00:20Z"),
    message(4, null, "2026-09-25T17:00:30Z"),
  ];

  test("skips system lines and my own messages; a deleted account's message counts", () => {
    assert.equal(unreadDividerSeq(thread, 1, ME), 4);
  });

  test("nothing after the marker: no divider", () => {
    assert.equal(unreadDividerSeq(thread, 4, ME), null);
  });

  test("no marker: no divider", () => {
    assert.equal(unreadDividerSeq(thread, null, ME), null);
  });
});

describe("helpers", () => {
  test("sameSender treats two deleted accounts as one", () => {
    assert.equal(sameSender(null, null), true);
    assert.equal(sameSender(null, KAI), false);
    assert.equal(sameSender(KAI, KAI), true);
  });

  test("localDay formats a local date and survives garbage", () => {
    assert.match(localDay("2026-09-25T12:00:00Z"), /^2026-09-2[456]$/);
    assert.equal(localDay("not a date"), "");
  });
});
