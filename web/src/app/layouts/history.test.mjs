import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialHistory,
  overlayOf,
  pathOnly,
  sheetsClosedBy,
  track,
  upAction,
} from "./history.ts";

test("a push after going back drops the entries ahead", () => {
  let model = initialHistory("a", "/chats");
  model = track(model, "PUSH", "b", "/c/1");
  model = track(model, "PUSH", "c", "/c/1/info");
  model = track(model, "POP", "a", "/chats");
  model = track(model, "PUSH", "d", "/friends");
  assert.deepEqual(model.entries.map((entry) => entry.key), ["a", "d"]);
  assert.equal(model.index, 1);
});

test("a replace changes the current entry only", () => {
  let model = initialHistory("a", "/chats");
  model = track(model, "PUSH", "b", "/friends");
  model = track(model, "REPLACE", "c", "/friends/requests");
  assert.deepEqual(model.entries, [
    { key: "a", path: "/chats" },
    { key: "c", path: "/friends/requests" },
  ]);
});

test("a pop to an entry from before a reload starts the list over", () => {
  let model = initialHistory("a", "/chats");
  model = track(model, "POP", "zz", "/friends");
  assert.deepEqual(model, { entries: [{ key: "zz", path: "/friends" }], index: 0 });
});

test("up goes back when the entry before is the parent the app pushed", () => {
  let model = initialHistory("a", "/chats");
  model = track(model, "PUSH", "b", "/c/1");
  assert.deepEqual(upAction(model, "/chats"), { kind: "back" });
});

test("up replaces with the parent after a deep link", () => {
  const model = initialHistory("a", "/c/1");
  assert.deepEqual(upAction(model, "/chats"), { kind: "replace", path: "/chats" });
});

test("up replaces when the entry before is another place", () => {
  let model = initialHistory("a", "/friends");
  model = track(model, "PUSH", "b", "/c/1");
  assert.deepEqual(upAction(model, "/chats"), { kind: "replace", path: "/chats" });
});

test("up compares paths without the query string", () => {
  let model = initialHistory("a", "/servers?game=jo&q=duel");
  model = track(model, "PUSH", "b", "/servers/jo/203.0.113.5%3A28070");
  assert.deepEqual(upAction(model, "/servers"), { kind: "back" });
  assert.equal(pathOnly("/servers?game=jo"), "/servers");
});

test("the overlay state is read out of whatever the router keeps", () => {
  assert.deepEqual(overlayOf(null), {});
  assert.deepEqual(overlayOf({ drawer: true }), { drawer: true });
  assert.deepEqual(overlayOf({ sheet: "s1", other: 1 }), { sheet: "s1" });
  assert.deepEqual(overlayOf({ drawer: "yes" }), {});
});

test("going back closes the sheets above the current entry", () => {
  const stack = [
    { token: "s1", pushed: true },
    { token: "s2", pushed: true },
  ];
  assert.deepEqual(sheetsClosedBy(stack, "s1"), ["s2"]);
  assert.deepEqual(sheetsClosedBy(stack, undefined), ["s1", "s2"]);
  assert.deepEqual(sheetsClosedBy(stack, "s2"), []);
});

test("a sheet whose entry is not pushed yet stays open", () => {
  assert.deepEqual(sheetsClosedBy([{ token: "s1", pushed: false }], undefined), []);
});
