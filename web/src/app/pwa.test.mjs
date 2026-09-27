import assert from "node:assert/strict";
import { test } from "node:test";

import { isTooOld } from "./pwa.ts";

test("a build older than minBuiltAt must update", () => {
  assert.equal(isTooOld("2026-10-01T00:00:00Z", "2026-09-27T12:00:00Z"), true);
});

test("a build as new as minBuiltAt or newer runs", () => {
  assert.equal(isTooOld("2026-09-27T12:00:00Z", "2026-09-27T12:00:00Z"), false);
  assert.equal(isTooOld("2026-09-01T00:00:00Z", "2026-09-27T12:00:00Z"), false);
});

test("no policy, or a policy that is not a date, demands nothing", () => {
  assert.equal(isTooOld(null, "2026-09-27T12:00:00Z"), false);
  assert.equal(isTooOld(undefined, "2026-09-27T12:00:00Z"), false);
  assert.equal(isTooOld("soon", "2026-09-27T12:00:00Z"), false);
  assert.equal(isTooOld(20261001, "2026-09-27T12:00:00Z"), false);
});
