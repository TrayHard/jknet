/**
 * Tests for src/components/events/api.ts: the calendar read page after page
 * with the `next` cursor of the service, and the paths of the reads.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { eventsApi, MAX_CALENDAR_PAGES, readAllPages } from "./api.ts";

const ID = (n) => `01K6EVT${String(n).padStart(19, "0")}`;
const COMMUNITY = "01K6SWJKA00000000000000000";
const cursor = (n) => `2026-10-0${1 + (n % 8)}T16:00:00Z_${ID(n)}`;

function event(n) {
  return { id: ID(n), startsAt: "2026-10-03T16:00:00Z", endsAt: "2026-10-03T19:00:00Z" };
}

/** A calendar of `pages`, each `[ids…]`, the cursor of page `i` naming its last event. */
function service(pages) {
  const calls = [];
  const request = (method, path) => {
    calls.push(`${method} ${path}`);
    const after = new URLSearchParams(path.split("?")[1] ?? "").get("after");
    const index = after === null ? 0 : pages.findIndex((page) => page.length > 0 && cursor(page[page.length - 1]) === after) + 1;
    const page = pages[index] ?? [];
    const last = index < pages.length - 1 ? cursor(page[page.length - 1]) : null;
    return Promise.resolve({ events: page.map(event), from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", next: last });
  };
  return { calls, api: eventsApi(request) };
}

describe("calendar", () => {
  test("reads one page when the service names no next", async () => {
    const { calls, api } = service([[1, 2, 3]]);
    const answer = await api.calendar({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", community: COMMUNITY });
    assert.deepEqual(answer.events.map((item) => item.id), [ID(1), ID(2), ID(3)]);
    assert.equal(answer.next, null);
    assert.equal(calls.length, 1);
  });

  test("follows next with the same range and filters until the last page", async () => {
    const { calls, api } = service([[1, 2], [3, 4], [5]]);
    const answer = await api.calendar({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", scope: "following", game: "ja" });
    assert.deepEqual(answer.events.map((item) => item.id), [1, 2, 3, 4, 5].map(ID));
    assert.equal(calls.length, 3);
    assert.equal(calls[0], "GET events?from=2026-10-01T00%3A00%3A00Z&to=2026-11-01T00%3A00%3A00Z&scope=following&game=ja");
    assert.equal(
      calls[1],
      `GET events?from=2026-10-01T00%3A00%3A00Z&to=2026-11-01T00%3A00%3A00Z&scope=following&game=ja&after=${encodeURIComponent(cursor(2))}`,
    );
  });

  test("keeps an event two pages carry once", async () => {
    const { api } = service([[1, 2], [2, 3]]);
    const answer = await api.calendar({});
    assert.deepEqual(answer.events.map((item) => item.id), [ID(1), ID(2), ID(3)]);
  });
});

describe("readAllPages", () => {
  test("stops at a cursor of another shape, at a cursor that repeats and at the cap", async () => {
    let reads = 0;
    const odd = await readAllPages(async () => {
      reads += 1;
      return { events: [event(reads)], from: "a", to: "b", next: "page-2" };
    });
    assert.equal(reads, 1);
    assert.equal(odd.events.length, 1);

    reads = 0;
    await readAllPages(async () => {
      reads += 1;
      return { events: [event(reads)], from: "a", to: "b", next: cursor(1) };
    });
    assert.equal(reads, 2, "the second page names the same cursor again");

    reads = 0;
    const capped = await readAllPages(async () => {
      reads += 1;
      return { events: [event(reads)], from: "a", to: "b", next: `2026-10-01T00:00:00Z_${ID(reads)}` };
    });
    assert.equal(reads, MAX_CALENDAR_PAGES);
    assert.equal(capped.events.length, MAX_CALENDAR_PAGES);
  });

  test("reads a service from before pages, which names no next", async () => {
    const answer = await readAllPages(async () => ({ events: [event(1)], from: "a", to: "b" }));
    assert.deepEqual(answer, { events: [event(1)], from: "a", to: "b", next: null });
  });
});
