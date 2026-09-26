/**
 * Tests for src/lib/chat/search.ts: the query lengths of the two scopes and
 * the filters a request carries.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SEARCH_KINDS,
  SEARCH_MAX,
  minQueryLength,
  narrowed,
  scopeConversation,
  searchFilters,
  searchReady,
} from "./search.ts";

describe("query length", () => {
  test("every chat needs three characters", () => {
    assert.equal(minQueryLength(null), 3);
    assert.equal(searchReady("gg", null), false);
    assert.equal(searchReady("ffa", null), true);
    assert.equal(searchReady("  ffa  ", null), true);
  });

  test("one chat takes a single character", () => {
    assert.equal(minQueryLength("c"), 1);
    assert.equal(searchReady("g", "c"), true);
    assert.equal(searchReady("   ", "c"), false);
  });

  test("characters are counted, not UTF-16 units", () => {
    assert.equal(searchReady("🔥🔥🔥", null), true);
    assert.equal(searchReady("🔥", null), false);
  });

  test("the service takes 64 characters at most", () => {
    assert.equal(SEARCH_MAX, 64);
    assert.equal(searchReady("a".repeat(64), null), true);
    assert.equal(searchReady("a".repeat(65), null), false);
  });
});

describe("scope and filters", () => {
  test("this chat searches the one on screen, all chats none", () => {
    assert.equal(scopeConversation("this", "c"), "c");
    assert.equal(scopeConversation("all", "c"), null);
    assert.equal(scopeConversation("this", null), null);
  });

  test("only what is set goes into the filters", () => {
    assert.deepEqual(searchFilters(null, null, null), {});
    assert.deepEqual(searchFilters("c", "image", "kai"), { conversationId: "c", has: "image", senderId: "kai" });
    assert.deepEqual(searchFilters(null, "link", null), { has: "link" });
  });

  test("narrowed by a kind or a sender", () => {
    assert.equal(narrowed(null, null), false);
    assert.equal(narrowed("card", null), true);
    assert.equal(narrowed(null, "kai"), true);
  });

  test("the kinds the service knows", () => {
    assert.deepEqual([...SEARCH_KINDS].sort(), ["card", "file", "image", "link", "video"]);
  });
});
