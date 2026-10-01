/**
 * Tests for src/components/community/heatmap.ts: the heat map of the
 * service turned from UTC into the reader's week, the busiest hours and the
 * shades of the cells.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { busiestHours, busiestValue, dayProfile, fewDays, levelOf, LEVELS, rotateHeatmap } from "./heatmap.ts";

/** A heat map of the service with `value` in the UTC hours named, Monday 00:00 = 0. */
function heatmap(cells) {
  const map = new Array(168).fill(0);
  for (const [hour, value] of Object.entries(cells)) map[Number(hour)] = value;
  return map;
}

/** The UTC hour of the week of a day (0 = Monday) and an hour. */
const utc = (day, hour) => day * 24 + hour;

describe("rotateHeatmap", () => {
  test("keeps the week as it is in UTC", () => {
    const rows = rotateHeatmap(heatmap({ [utc(0, 0)]: 3, [utc(4, 21)]: 26, [utc(6, 23)]: 1 }), 0);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.length === 24));
    assert.equal(rows[0][0], 3);
    assert.equal(rows[4][21], 26);
    assert.equal(rows[6][23], 1);
  });

  test("moves the hours forward for a zone east of UTC: Moscow, UTC+3", () => {
    // Friday 18:00 UTC is Friday 21:00 in Moscow.
    const rows = rotateHeatmap(heatmap({ [utc(4, 18)]: 26 }), 180);
    assert.equal(rows[4][21], 26);
    assert.equal(rows[4][18], 0);
  });

  test("carries the last hours of Sunday in UTC into Monday east of UTC", () => {
    // Sunday 22:00 UTC is Monday 01:00 in Moscow: the first row of the reader's week.
    const rows = rotateHeatmap(heatmap({ [utc(6, 22)]: 7 }), 180);
    assert.equal(rows[0][1], 7);
    assert.equal(rows[6][22], 0);
  });

  test("moves the hours back for a zone west of UTC, across midnight: New York, UTC-5", () => {
    // Monday 02:00 UTC is Sunday 21:00 in New York, the last row of the week.
    const rows = rotateHeatmap(heatmap({ [utc(0, 2)]: 9, [utc(3, 23)]: 4 }), -300);
    assert.equal(rows[6][21], 9);
    assert.equal(rows[3][18], 4);
  });

  test("spreads an hour over two for a zone of half hours: India, UTC+5:30", () => {
    // 06:00–07:00 in India is 00:30–01:30 UTC: half of each UTC hour.
    const rows = rotateHeatmap(heatmap({ [utc(0, 0)]: 10, [utc(0, 1)]: 20 }), 330);
    assert.equal(rows[0][6], 15);
    assert.equal(rows[0][5], 5, "05:00–06:00 holds the second half of 23:30–00:30");
    assert.equal(rows[0][7], 10, "07:00–08:00 holds the second half of 01:00–02:00");
  });

  test("keeps the sum of the week whatever the offset", () => {
    const map = heatmap({ 5: 2, 40: 7.5, 100: 1.25, 167: 3 });
    const total = map.reduce((sum, value) => sum + value, 0);
    for (const offset of [0, 60, 180, -300, 330, 345, -570, 840, -720]) {
      const sum = rotateHeatmap(map, offset).flat().reduce((acc, value) => acc + value, 0);
      assert.ok(Math.abs(sum - total) < 1e-9, `offset ${offset}: ${sum} != ${total}`);
    }
  });

  test("reads a map of another length, and values that are not numbers, as nobody", () => {
    assert.deepEqual(rotateHeatmap([1, 2, 3], 0).flat(), new Array(168).fill(0));
    const odd = heatmap({ 1: Number.NaN, 2: -4 });
    odd[3] = "x";
    assert.equal(rotateHeatmap(odd, 0).flat().reduce((acc, value) => acc + value, 0), 0);
  });
});

describe("busiestHours", () => {
  /** A week whose every day is busy from 19:00 to 23:00 in the reader's time, Moscow. */
  function evenings() {
    const cells = {};
    for (let day = 0; day < 7; day += 1) {
      for (const [hour, value] of [[16, 10], [17, 14], [18, 16], [19, 12], [20, 4], [11, 2], [12, 3]]) cells[utc(day, hour)] = value;
    }
    return rotateHeatmap(heatmap(cells), 180);
  }

  test("finds the evening of the design: 19:00–23:00", () => {
    assert.deepEqual(busiestHours(evenings()), { from: 19, to: 23, hours: 4 });
  });

  test("crosses midnight", () => {
    const cells = {};
    for (let day = 0; day < 7; day += 1) for (const hour of [22, 23, 0, 1]) cells[utc(day, hour)] = 8;
    const run = busiestHours(rotateHeatmap(heatmap(cells), 0));
    assert.deepEqual(run, { from: 22, to: 2, hours: 4 });
  });

  test("stops at six hours of a flat day", () => {
    const run = busiestHours(rotateHeatmap(new Array(168).fill(5), 0));
    assert.equal(run.hours, 6);
  });

  test("is null while nobody played", () => {
    assert.equal(busiestHours(rotateHeatmap(new Array(168).fill(0), 180)), null);
  });
});

describe("levels", () => {
  test("an empty hour is empty, any other takes one of five shades by its share of the busiest", () => {
    assert.equal(levelOf(0, 10), 0);
    assert.equal(levelOf(0.01, 10), 1);
    assert.equal(levelOf(2, 10), 1);
    assert.equal(levelOf(2.1, 10), 2);
    assert.equal(levelOf(10, 10), LEVELS);
    assert.equal(levelOf(5, 0), 0);
    assert.equal(levelOf(Number.NaN, 10), 0);
  });

  test("the busiest cell and the profile of a day", () => {
    const rows = rotateHeatmap(heatmap({ [utc(2, 20)]: 14, [utc(5, 20)]: 7 }), 0);
    assert.equal(busiestValue(rows), 14);
    assert.equal(dayProfile(rows)[20], 3);
  });

  test("fewer than seven days of samples is too few", () => {
    assert.equal(fewDays(0), true);
    assert.equal(fewDays(6), true);
    assert.equal(fewDays(7), false);
    assert.equal(fewDays(28), false);
  });
});
