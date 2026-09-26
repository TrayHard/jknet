/**
 * Tests for src/lib/chatWindow.ts: the route and the rules of the chat window.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  chatRoute,
  clampOpacity,
  conversationOfPath,
  DEFAULT_CHAT_WINDOW,
  isChatWindowHash,
  nextSelection,
  OPACITY_MAX,
  OPACITY_MIN,
  rootOpacity,
  seeThrough,
} from "./chatWindow.ts";

const ULID = "01J8Z3QK7M4V2X9C6B5N0A1S2D";

describe("chatRoute", () => {
  test("the list without a conversation", () => {
    assert.equal(chatRoute(), "/chat");
    assert.equal(chatRoute(null), "/chat");
  });

  test("one conversation by its id", () => {
    assert.equal(chatRoute(ULID), `/chat/${ULID}`);
    assert.equal(chatRoute("dm-kai_1"), "/chat/dm-kai_1");
  });

  test("an id the core would refuse falls back to the list", () => {
    assert.equal(chatRoute(""), "/chat");
    assert.equal(chatRoute("a/b"), "/chat");
    assert.equal(chatRoute("x".repeat(65)), "/chat");
    assert.equal(chatRoute("<script>"), "/chat");
  });
});

describe("isChatWindowHash", () => {
  test("the two addresses the core opens", () => {
    assert.equal(isChatWindowHash("#/chat"), true);
    assert.equal(isChatWindowHash(`#/chat/${ULID}`), true);
    assert.equal(isChatWindowHash("#/chat?compact=1"), true);
  });

  test("the launcher and the client window are not the chat window", () => {
    assert.equal(isChatWindowHash(""), false);
    assert.equal(isChatWindowHash("#/"), false);
    assert.equal(isChatWindowHash("#/friends"), false);
    assert.equal(isChatWindowHash("#/client/openjk"), false);
    assert.equal(isChatWindowHash("#/chats"), false);
    assert.equal(isChatWindowHash("#/chatroom/1"), false);
  });

  test("a route built by chatRoute is recognised", () => {
    assert.equal(isChatWindowHash(`#${chatRoute()}`), true);
    assert.equal(isChatWindowHash(`#${chatRoute(ULID)}`), true);
  });
});

describe("conversationOfPath", () => {
  test("reads the id back", () => {
    assert.equal(conversationOfPath(`/chat/${ULID}`), ULID);
    assert.equal(conversationOfPath(`/chat/${ULID}/`), ULID);
    assert.equal(conversationOfPath(chatRoute("dm-kai_1")), "dm-kai_1");
  });

  test("the list and other routes name no conversation", () => {
    assert.equal(conversationOfPath("/chat"), null);
    assert.equal(conversationOfPath("/chat/"), null);
    assert.equal(conversationOfPath("/"), null);
    assert.equal(conversationOfPath("/client/openjk"), null);
    assert.equal(conversationOfPath(`/chat/${ULID}/extra`), null);
  });

  test("an id that is not one is dropped", () => {
    assert.equal(conversationOfPath("/chat/%3Cscript%3E"), null);
    assert.equal(conversationOfPath("/chat/%E0%A4%A"), null);
    assert.equal(conversationOfPath(`/chat/${"x".repeat(65)}`), null);
  });
});

describe("nextSelection", () => {
  test("a conversation is shown in either mode", () => {
    assert.equal(nextSelection(null, "kai", false), "kai");
    assert.equal(nextSelection("dana", "kai", false), "kai");
    assert.equal(nextSelection("dana", "kai", true), "kai");
  });

  test("the list keeps the thread beside it in the full mode", () => {
    assert.equal(nextSelection("dana", null, false), "dana");
    assert.equal(nextSelection(null, null, false), null);
  });

  test("the list replaces the thread in the compact mode", () => {
    assert.equal(nextSelection("dana", null, true), null);
  });
});

describe("opacity", () => {
  test("clampOpacity holds the slider's range and steps", () => {
    assert.equal(clampOpacity(90), 90);
    assert.equal(clampOpacity(92), 90);
    assert.equal(clampOpacity(93), 95);
    assert.equal(clampOpacity(0), OPACITY_MIN);
    assert.equal(clampOpacity(250), OPACITY_MAX);
    assert.equal(clampOpacity(Number.NaN), OPACITY_MAX);
  });

  test("only the compact mode below 100 % is see-through", () => {
    assert.equal(seeThrough({ compact: true, opacity: 90 }), true);
    assert.equal(seeThrough({ compact: true, opacity: 100 }), false);
    assert.equal(seeThrough({ compact: false, opacity: 40 }), false);
  });

  test("rootOpacity follows the compact opacity and is 1 otherwise", () => {
    assert.equal(rootOpacity({ compact: true, opacity: 40 }), 0.4);
    assert.equal(rootOpacity({ compact: true, opacity: 75 }), 0.75);
    assert.equal(rootOpacity({ compact: true, opacity: 100 }), 1);
    assert.equal(rootOpacity({ compact: false, opacity: 40 }), 1);
  });

  test("the page assumes an opaque full window until the core answers", () => {
    assert.equal(DEFAULT_CHAT_WINDOW.compact, false);
    assert.equal(seeThrough(DEFAULT_CHAT_WINDOW), false);
    assert.equal(rootOpacity(DEFAULT_CHAT_WINDOW), 1);
  });
});
