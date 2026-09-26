/**
 * Tests for src/lib/chat/drawer.ts: the chat drawer of layout B.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { drawerPinned, drawerReducer, INITIAL_DRAWER } from "./drawer.ts";

function run(...actions) {
  return actions.reduce(drawerReducer, INITIAL_DRAWER);
}

describe("drawerReducer", () => {
  test("starts closed on the list, unpinned by this run", () => {
    assert.deepEqual(INITIAL_DRAWER, { open: false, conversationId: null, openCount: 0, pinnedHere: null });
  });

  test("open shows a conversation and counts the request", () => {
    const state = run({ type: "open", conversationId: "kai" });
    assert.equal(state.open, true);
    assert.equal(state.conversationId, "kai");
    assert.equal(state.openCount, 1);
  });

  test("open without an id shows the list, even over an open thread", () => {
    const state = run({ type: "open", conversationId: "kai" }, { type: "open", conversationId: null });
    assert.equal(state.open, true);
    assert.equal(state.conversationId, null);
    assert.equal(state.openCount, 2);
  });

  test("an open of an open drawer still counts, so the focus moves in again", () => {
    const state = run({ type: "open", conversationId: "kai" }, { type: "open", conversationId: "dana" });
    assert.equal(state.conversationId, "dana");
    assert.equal(state.openCount, 2);
  });

  test("close keeps the level, and the toggle reopens on it", () => {
    const closed = run({ type: "open", conversationId: "kai" }, { type: "close" });
    assert.equal(closed.open, false);
    assert.equal(closed.conversationId, "kai");
    const reopened = drawerReducer(closed, { type: "toggle" });
    assert.equal(reopened.open, true);
    assert.equal(reopened.conversationId, "kai");
    assert.equal(reopened.openCount, 2);
  });

  test("the toggle closes an open drawer without counting a request", () => {
    const state = run({ type: "toggle" }, { type: "toggle" });
    assert.equal(state.open, false);
    assert.equal(state.openCount, 1);
    assert.equal(state.conversationId, null);
  });

  test("close of a closed drawer changes nothing", () => {
    assert.equal(drawerReducer(INITIAL_DRAWER, { type: "close" }), INITIAL_DRAWER);
  });

  test("select moves between the levels without opening or counting", () => {
    const opened = run({ type: "open", conversationId: null });
    const thread = drawerReducer(opened, { type: "select", conversationId: "cup" });
    assert.equal(thread.conversationId, "cup");
    assert.equal(thread.openCount, 1);
    const back = drawerReducer(thread, { type: "select", conversationId: null });
    assert.equal(back.conversationId, null);
    assert.equal(drawerReducer(back, { type: "select", conversationId: null }), back);

    const closed = drawerReducer(INITIAL_DRAWER, { type: "select", conversationId: "cup" });
    assert.equal(closed.open, false);
  });

  test("pin keeps the click of this run and leaves the rest alone", () => {
    const state = run({ type: "open", conversationId: "kai" }, { type: "pin", pinned: true });
    assert.equal(state.pinnedHere, true);
    assert.equal(state.open, true);
    assert.equal(state.conversationId, "kai");
    assert.equal(drawerReducer(state, { type: "pin", pinned: true }), state);
    assert.equal(drawerReducer(state, { type: "pin", pinned: false }).pinnedHere, false);
  });
});

describe("drawerPinned", () => {
  test("follows the setting until the pin is clicked", () => {
    assert.equal(drawerPinned(INITIAL_DRAWER, true), true);
    assert.equal(drawerPinned(INITIAL_DRAWER, false), false);
  });

  test("a missing setting reads as floating", () => {
    assert.equal(drawerPinned(INITIAL_DRAWER, undefined), false);
  });

  test("the click of this run wins over the setting either way", () => {
    const unpinned = drawerReducer(INITIAL_DRAWER, { type: "pin", pinned: false });
    assert.equal(drawerPinned(unpinned, true), false);
    const pinned = drawerReducer(INITIAL_DRAWER, { type: "pin", pinned: true });
    assert.equal(drawerPinned(pinned, false), true);
    assert.equal(drawerPinned(pinned, undefined), true);
  });
});
