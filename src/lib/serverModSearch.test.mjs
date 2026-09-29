import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { filterServerModCards, mergeJkhubCategoryPages } from "./serverModSearch.ts";

const card = (id, title, slug = title.toLowerCase().replaceAll(" ", "-")) => ({
  id,
  slug,
  title,
  url: `https://jkhub.org/files/file/${id}-${slug}/`,
  categoryId: null,
  author: null,
  thumbnailUrl: null,
  description: "",
  downloads: null,
  date: null,
  dateLabel: null,
  tags: [],
  rating: null,
});

const listing = (page, pages, cards) => ({
  categoryId: 25,
  sort: "recentlyUpdated",
  page,
  pages,
  perPage: 25,
  cards,
  fetchedAt: "2026-09-28T00:00:00Z",
  stale: false,
});

describe("server mod search", () => {
  test("finds JA+ on a different category page", () => {
    const complete = mergeJkhubCategoryPages([
      listing(1, 2, [card(3243, "BaseJKA+ Server")]),
      listing(2, 2, [card(953, "JA+ Server Side", "ja-server-side")]),
    ]);

    assert.deepEqual(filterServerModCards(complete.cards, "ja+").map(({ id }) => id), [953]);
  });

  test("keeps category order and removes duplicate cards", () => {
    const complete = mergeJkhubCategoryPages([
      listing(1, 2, [card(3, "Three"), card(2, "Two")]),
      listing(2, 2, [card(2, "Two"), card(1, "One")]),
    ]);

    assert.equal(complete.pages, 2);
    assert.deepEqual(complete.cards.map(({ id }) => id), [3, 2, 1]);
  });

  test("matches slugs, descriptions, and tags", () => {
    const tagged = {
      ...card(953, "Server package", "ja-server-side"),
      description: "The JAPlus distribution",
      tags: ["admin"],
    };

    assert.deepEqual(filterServerModCards([tagged], "ja-server").map(({ id }) => id), [953]);
    assert.deepEqual(filterServerModCards([tagged], "japlus").map(({ id }) => id), [953]);
    assert.deepEqual(filterServerModCards([tagged], "admin").map(({ id }) => id), [953]);
  });
});
