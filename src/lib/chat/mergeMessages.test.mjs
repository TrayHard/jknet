/**
 * Tests for src/lib/chat/mergeMessages.ts: live messages against loaded pages.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  appendAfter,
  applyReaction,
  firstLoadedSeq,
  flattenPages,
  lastLoadedSeq,
  mergeSorted,
  patchMessage,
  placeIncoming,
  reactionsBy,
} from "./mergeMessages.ts";

function message(seq, body = `m${seq}`) {
  return {
    conversationId: "c1",
    seq,
    senderId: "u1",
    clientId: null,
    kind: "user",
    body,
    cards: [],
    files: [],
    mentions: [],
    replyTo: null,
    reactions: [],
    system: null,
    createdAt: "2026-09-25T17:00:00Z",
  };
}

function page(seqs, { hasBefore = false, hasAfter = false } = {}) {
  return { messages: seqs.map((seq) => message(seq)), hasBefore, hasAfter };
}

const seqsOf = (pages) => flattenPages(pages).map((m) => m.seq);

describe("mergeSorted", () => {
  test("interleaves and drops duplicates, the second list winning", () => {
    const merged = mergeSorted([message(1), message(3, "old")], [message(2), message(3, "new"), message(4)]);
    assert.deepEqual(merged.map((m) => m.seq), [1, 2, 3, 4]);
    assert.equal(merged[2].body, "new");
  });

  test("empty lists", () => {
    assert.deepEqual(mergeSorted([], []), []);
    assert.deepEqual(mergeSorted([message(1)], []).map((m) => m.seq), [1]);
  });
});

describe("placeIncoming", () => {
  test("the next seq is appended to the newest page", () => {
    const pages = [page([1, 2], { hasBefore: true }), page([3, 4])];
    const { pages: next, outcome } = placeIncoming(pages, message(5));
    assert.equal(outcome, "appended");
    assert.deepEqual(seqsOf(next), [1, 2, 3, 4, 5]);
    assert.deepEqual(seqsOf(pages), [1, 2, 3, 4], "the input is not mutated");
  });

  test("a message already loaded is a duplicate and changes nothing", () => {
    const pages = [page([3, 4])];
    const result = placeIncoming(pages, message(4));
    assert.equal(result.outcome, "duplicate");
    assert.equal(result.pages, pages);
  });

  test("a message after a hole asks for a fetch", () => {
    const pages = [page([3, 4])];
    const result = placeIncoming(pages, message(7));
    assert.equal(result.outcome, "gap");
    assert.equal(result.pages, pages);
  });

  test("while the newest page is not loaded, a new message is left for the fetch", () => {
    const pages = [page([10, 11], { hasBefore: true, hasAfter: true })];
    assert.equal(placeIncoming(pages, message(12)).outcome, "outside");
    assert.equal(placeIncoming(pages, message(40)).outcome, "outside");
  });

  test("an older message than anything loaded is ignored", () => {
    assert.equal(placeIncoming([page([10, 11], { hasBefore: true })], message(3)).outcome, "outside");
  });

  test("a hole inside the loaded range is filled", () => {
    const pages = [page([1, 2, 4])];
    const { pages: next, outcome } = placeIncoming(pages, message(3));
    assert.equal(outcome, "inserted");
    assert.deepEqual(seqsOf(next), [1, 2, 3, 4]);
  });

  test("an open empty thread takes its first message", () => {
    const { pages, outcome } = placeIncoming([page([])], message(1));
    assert.equal(outcome, "appended");
    assert.deepEqual(seqsOf(pages), [1]);
  });

  test("a thread that is not loaded at all takes nothing", () => {
    assert.equal(placeIncoming([], message(1)).outcome, "outside");
  });
});

describe("appendAfter", () => {
  test("merges into the newest page and takes over hasAfter", () => {
    const pages = [page([1, 2]), page([3])];
    const next = appendAfter(pages, page([4, 5, 6], { hasAfter: true }));
    assert.deepEqual(seqsOf(next), [1, 2, 3, 4, 5, 6]);
    assert.equal(next[1].hasAfter, true);
    const done = appendAfter(next, page([6, 7], { hasAfter: false }));
    assert.deepEqual(seqsOf(done), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(done[1].hasAfter, false);
  });

  test("no pages yet: the page itself", () => {
    const only = page([1]);
    assert.deepEqual(appendAfter([], only), [only]);
  });

  test("first and last loaded seq skip empty pages", () => {
    const pages = [page([]), page([5, 6]), page([])];
    assert.equal(firstLoadedSeq(pages), 5);
    assert.equal(lastLoadedSeq(pages), 6);
    assert.equal(lastLoadedSeq([page([])]), null);
  });
});

describe("reactions", () => {
  test("switching on adds the player, a new emoji goes last", () => {
    let reactions = [];
    reactions = applyReaction(reactions, "a", "👍", true);
    reactions = applyReaction(reactions, "b", "👍", true);
    reactions = applyReaction(reactions, "a", "🔥", true);
    assert.deepEqual(reactions, [
      { emoji: "👍", userIds: ["a", "b"] },
      { emoji: "🔥", userIds: ["a"] },
    ]);
  });

  test("switching on twice changes nothing", () => {
    const reactions = [{ emoji: "👍", userIds: ["a"] }];
    assert.equal(applyReaction(reactions, "a", "👍", true), reactions);
  });

  test("switching off removes the player and an empty group", () => {
    const reactions = [
      { emoji: "👍", userIds: ["a", "b"] },
      { emoji: "🔥", userIds: ["a"] },
    ];
    assert.deepEqual(applyReaction(reactions, "a", "🔥", false), [{ emoji: "👍", userIds: ["a", "b"] }]);
    assert.deepEqual(applyReaction(reactions, "a", "👍", false)[0], { emoji: "👍", userIds: ["b"] });
    assert.equal(applyReaction(reactions, "c", "👍", false), reactions);
  });

  test("patchMessage changes one message and keeps the rest", () => {
    const pages = [page([1, 2]), page([3])];
    const next = patchMessage(pages, 2, (m) => ({ ...m, reactions: applyReaction(m.reactions, "a", "👍", true) }));
    assert.deepEqual(flattenPages(next)[1].reactions, [{ emoji: "👍", userIds: ["a"] }]);
    assert.equal(next[1], pages[1]);
    assert.equal(patchMessage(pages, 99, (m) => m), pages);
  });

  test("reactionsBy counts the groups a player is in", () => {
    assert.equal(
      reactionsBy(
        [
          { emoji: "👍", userIds: ["a", "b"] },
          { emoji: "🔥", userIds: ["a"] },
          { emoji: "😂", userIds: ["b"] },
        ],
        "a",
      ),
      2,
    );
  });
});
