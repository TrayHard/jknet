/**
 * Tests for src/lib/chat/emojiText.ts: emoji-only messages and reaction values.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emojiOnlyCount, isLargeEmoji, isReactionEmoji } from "./emojiText.ts";

describe("emojiOnlyCount", () => {
  test("counts clusters, not code points", () => {
    assert.equal(emojiOnlyCount("👍"), 1);
    assert.equal(emojiOnlyCount("👍🏽"), 1, "skin tone");
    assert.equal(emojiOnlyCount("👨‍👩‍👧"), 1, "family");
    assert.equal(emojiOnlyCount("🇷🇺🇩🇪"), 2, "flags");
    assert.equal(emojiOnlyCount("1️⃣"), 1, "keycap");
    assert.equal(emojiOnlyCount("⚔️ 🔥"), 2, "variation selector and a space");
  });

  test("any text makes it zero", () => {
    assert.equal(emojiOnlyCount("gg 👍"), 0);
    assert.equal(emojiOnlyCount("123"), 0);
    assert.equal(emojiOnlyCount(""), 0);
    assert.equal(emojiOnlyCount("   "), 0);
  });

  test("large for one to six emoji", () => {
    assert.equal(isLargeEmoji("🔥"), true);
    assert.equal(isLargeEmoji("🔥🔥🔥🔥🔥🔥"), true);
    assert.equal(isLargeEmoji("🔥🔥🔥🔥🔥🔥🔥"), false);
    assert.equal(isLargeEmoji("ok"), false);
  });
});

describe("isReactionEmoji", () => {
  test("accepts single emoji", () => {
    for (const value of ["👍", "👍🏽", "⚔️", "🇺🇦", "#️⃣", "❤️"]) {
      assert.equal(isReactionEmoji(value), true, value);
    }
  });

  test("refuses text, several emoji and control characters", () => {
    for (const value of ["", "a", "ok", "👍👍", "👍 ", "‮👍", "#", "\u0007"]) {
      assert.equal(isReactionEmoji(value), false, JSON.stringify(value));
    }
  });
});
