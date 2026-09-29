import assert from "node:assert/strict";
import { test } from "node:test";

import { appPath, clickPlan, FALLBACK_URL } from "./click.ts";

const hidden = { focused: false, visibilityState: "hidden" };
const visible = { focused: false, visibilityState: "visible" };
const focused = { focused: true, visibilityState: "visible" };

test("no window of the app: a new one opens on the address", () => {
  assert.deepEqual(clickPlan([], "/c/C1"), { action: "open", url: "/c/C1" });
});

test("an open window comes forward and is told the address", () => {
  assert.deepEqual(clickPlan([hidden], "/friends/requests"), { action: "focus", index: 0, url: "/friends/requests" });
});

test("the focused window wins, then a visible one, then the most recent", () => {
  assert.equal(clickPlan([hidden, visible, focused], "/c/C1").index, 2);
  assert.equal(clickPlan([hidden, visible], "/c/C1").index, 1);
  assert.equal(clickPlan([hidden, hidden], "/c/C1").index, 0);
});

test("only a path of the app is opened", () => {
  for (const bad of ["https://evil.example.com/", "//evil.example.com/x", "/\\evil.example.com", "javascript:alert(1)", "", null, 5]) {
    assert.equal(appPath(bad), null, String(bad));
    assert.equal(clickPlan([], bad).url, FALLBACK_URL);
  }
  assert.equal(appPath("/c/abc"), "/c/abc");
});

test("a window that runs the app wins over the one-tab gate or a frozen page, whatever their focus", () => {
  const gate = { ...focused, live: false };
  const app = { ...hidden, live: true };
  assert.equal(clickPlan([gate, app], "/c/C1").index, 1);
  assert.equal(clickPlan([app, { ...visible, live: true }], "/c/C1").index, 1, "among live windows the visible one");
  // No window answered: the choice is the one of before.
  assert.equal(clickPlan([{ ...hidden, live: false }, { ...focused, live: false }], "/c/C1").index, 1);
});
