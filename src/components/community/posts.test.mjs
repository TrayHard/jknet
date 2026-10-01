/**
 * Tests for src/components/community/posts.ts: the order of the posts, the
 * pages put together, the posts of the overview, the line of a post and the
 * checks of the composer.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { cut, headline, mergePosts, orderPosts, overviewPosts, pinnedCount, plainText, postProblems } from "./posts.ts";

let serial = 0;
function post(patch = {}) {
  serial += 1;
  return {
    id: `01K6POST${String(serial).padStart(18, "0")}`,
    communityId: "01K6SWJKA00000000000000000",
    title: "",
    body: "Text",
    pinned: false,
    author: null,
    createdAt: "2026-09-28T12:00:00Z",
    updatedAt: "2026-09-28T12:00:00Z",
    revision: 1,
    viewer: null,
    ...patch,
  };
}

describe("order", () => {
  test("pins first, the newest first in each group", () => {
    const old = post({ createdAt: "2026-09-20T10:00:00Z" });
    const pinnedOld = post({ pinned: true, createdAt: "2026-09-21T10:00:00Z" });
    const fresh = post({ createdAt: "2026-09-29T10:00:00Z" });
    const pinnedFresh = post({ pinned: true, createdAt: "2026-09-25T10:00:00Z" });
    assert.deepEqual(
      orderPosts([old, pinnedOld, fresh, pinnedFresh]).map((item) => item.id),
      [pinnedFresh.id, pinnedOld.id, fresh.id, old.id],
    );
  });

  test("two posts of the same second go by their ids, the latest first", () => {
    const a = post({ id: "01K6POSTA00000000000000000", createdAt: "2026-09-28T12:00:00Z" });
    const b = post({ id: "01K6POSTB00000000000000000", createdAt: "2026-09-28T12:00:00Z" });
    assert.deepEqual(orderPosts([a, b]).map((item) => item.id), [b.id, a.id]);
  });

  test("a page after the first joins the list once, and a newer form of a post wins", () => {
    const one = post({ createdAt: "2026-09-29T10:00:00Z" });
    const two = post({ createdAt: "2026-09-28T10:00:00Z" });
    const three = post({ createdAt: "2026-09-27T10:00:00Z" });
    const changed = { ...one, title: "Changed", revision: 2 };
    const merged = mergePosts([changed, two], [two, three, one]);
    assert.deepEqual(merged.map((item) => item.id), [one.id, two.id, three.id]);
    assert.equal(merged[0].title, "Changed", "the older form from a later page does not undo a change");
  });
});

describe("overviewPosts", () => {
  test("shows the newest pinned post and the two newest others", () => {
    const pins = [post({ pinned: true, createdAt: "2026-09-29T09:00:00Z" }), post({ pinned: true, createdAt: "2026-09-26T09:00:00Z" })];
    const others = [
      post({ createdAt: "2026-09-28T09:00:00Z" }),
      post({ createdAt: "2026-09-27T09:00:00Z" }),
      post({ createdAt: "2026-09-20T09:00:00Z" }),
    ];
    assert.deepEqual(overviewPosts([...others, ...pins]).map((item) => item.id), [pins[0].id, others[0].id, others[1].id]);
  });

  test("without a pinned post shows the two newest", () => {
    const list = [post({ createdAt: "2026-09-21T09:00:00Z" }), post({ createdAt: "2026-09-23T09:00:00Z" }), post({ createdAt: "2026-09-22T09:00:00Z" })];
    assert.deepEqual(overviewPosts(list).map((item) => item.createdAt), ["2026-09-23T09:00:00Z", "2026-09-22T09:00:00Z"]);
    assert.deepEqual(overviewPosts([]), []);
  });

  test("counts the pins", () => {
    assert.equal(pinnedCount([post({ pinned: true }), post(), post({ pinned: true })]), 2);
  });
});

describe("plainText and headline", () => {
  test("drops the marks of Markdown and keeps the words", () => {
    assert.equal(plainText("## Ladder\n\nThe ladder opens on **Friday** at [the arena](https://example.org/arena)."), "Ladder The ladder opens on Friday at the arena.");
    assert.equal(plainText("> Quote\n- one\n- two\n1. three"), "Quote one two three");
    assert.equal(plainText("Use `/bow` first, _then_ fight ~~now~~"), "Use /bow first, then fight now");
    assert.equal(plainText("![map](https://example.org/a.png) mp_ffa3"), "map mp_ffa3");
    assert.equal(plainText("```\ncode\n```"), "code");
  });

  test("names a post by its title, else by the start of its text", () => {
    assert.equal(headline({ title: "  Season two ", body: "x" }), "Season two");
    assert.equal(headline({ title: "", body: "**Map rotation** changed: mp/duel7 and mp/duel9 are in." }), "Map rotation changed: mp/duel7 and mp/duel9 are in.");
    const long = headline({ title: "", body: "word ".repeat(40) });
    assert.ok(Array.from(long).length <= 90);
    assert.ok(long.endsWith("…"));
  });

  test("cut keeps a short text and cuts a long one to its length", () => {
    assert.equal(cut("short", 10), "short");
    assert.equal(cut("ёёёёёёёёёёёё", 5), "ёёёё…");
  });
});

describe("postProblems", () => {
  test("a text is required, a title is not", () => {
    assert.deepEqual(postProblems("", "Ladder"), {});
    assert.deepEqual(postProblems("Season two", "  "), { body: "required" });
  });

  test("holds the title to one line of 100 characters and the text to 4000", () => {
    assert.deepEqual(postProblems("a\nb", "x"), { title: "oneLine" });
    assert.deepEqual(postProblems("я".repeat(101), "x"), { title: "tooLong" });
    assert.deepEqual(postProblems("я".repeat(100), "x"), {});
    assert.deepEqual(postProblems("", "ё".repeat(4001)), { body: "tooLong" });
    assert.deepEqual(postProblems("", "ё".repeat(4000)), {});
  });
});
