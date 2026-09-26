/**
 * Tests for src/lib/chat/conversation.ts: names, order and filters of the
 * conversation list, a deleted account's direct chat included.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  conversationName,
  fold,
  isDeletedPeer,
  isOwner,
  matchesFilter,
  matchesQuery,
  peerOf,
  sortConversations,
} from "./conversation.ts";

const ME = "me";

function user(id, displayName = id) {
  return { id, displayName, avatarUrl: null, provider: "dev", providerName: id, createdAt: "2026-09-10T00:00:00Z" };
}

function member(id, name) {
  return { user: user(id, name), role: "member", joinedAt: "2026-09-10T00:00:00Z", readSeq: 0 };
}

function conversation(fields = {}) {
  return {
    id: "c",
    kind: "direct",
    title: null,
    ownerId: null,
    members: [member(ME, "Quinn"), member("kai", "Kai")],
    lastSeq: 0,
    lastMessage: null,
    readSeq: 0,
    visibleFromSeq: 0,
    unread: 0,
    unreadMentions: 0,
    notify: "all",
    canSend: true,
    historyForNewMembers: false,
    server: null,
    createdAt: "2026-09-20T00:00:00Z",
    ...fields,
  };
}

describe("direct chats", () => {
  test("named after the other player", () => {
    const name = conversationName(conversation(), ME);
    assert.equal(name.kind, "peer");
    assert.equal(name.user.displayName, "Kai");
    assert.equal(peerOf(conversation(), ME).id, "kai");
  });

  test("a direct chat with only me left belongs to a deleted account", () => {
    const deleted = conversation({ members: [member(ME, "Quinn")], canSend: false });
    assert.deepEqual(conversationName(deleted, ME), { kind: "deleted" });
    assert.equal(isDeletedPeer(deleted, ME), true);
    assert.equal(isDeletedPeer(conversation(), ME), false);
  });
});

describe("groups", () => {
  test("a title wins", () => {
    assert.deepEqual(conversationName(conversation({ kind: "group", title: " Saturday cup " }), ME), {
      kind: "group",
      title: "Saturday cup",
    });
  });

  test("without a title: the other members, three at most", () => {
    const group = conversation({
      kind: "group",
      title: "",
      members: [member(ME, "Quinn"), member("a", "Kai"), member("b", "Dana"), member("c", "Noam"), member("d", "Juno")],
    });
    assert.deepEqual(conversationName(group, ME), { kind: "members", names: ["Kai", "Dana", "Noam"], more: 1 });
  });
});

describe("server chats", () => {
  test("named after the host", () => {
    const server = conversation({
      kind: "server",
      ownerId: "kai",
      server: { hostId: "kai", sessionId: "9c41d27a0b3e5f18" },
    });
    const name = conversationName(server, ME);
    assert.equal(name.kind, "server");
    assert.equal(name.host.displayName, "Kai");
  });

  test("a host missing from the members gives no name", () => {
    const server = conversation({ kind: "server", ownerId: "gone", server: { hostId: "gone", sessionId: "x" } });
    assert.deepEqual(conversationName(server, ME), { kind: "server", host: null });
  });
});

describe("order and filters", () => {
  const at = (iso) => ({ ...conversation().lastMessage, createdAt: iso });

  test("the server chat first, then the newest activity", () => {
    const list = [
      conversation({ id: "old", lastMessage: at("2026-09-24T10:00:00Z") }),
      conversation({ id: "new", lastMessage: at("2026-09-25T10:00:00Z") }),
      conversation({ id: "srv", kind: "server", createdAt: "2026-09-01T00:00:00Z" }),
      conversation({ id: "empty", createdAt: "2026-09-25T12:00:00Z" }),
    ];
    assert.deepEqual(sortConversations(list).map((c) => c.id), ["srv", "empty", "new", "old"]);
  });

  test("filters by kind", () => {
    assert.equal(matchesFilter(conversation(), "all"), true);
    assert.equal(matchesFilter(conversation(), "direct"), true);
    assert.equal(matchesFilter(conversation(), "group"), false);
  });

  test("the query matches member names, not mine, ignoring case and accents", () => {
    assert.equal(matchesQuery(conversation(), "KA", ME), true);
    assert.equal(matchesQuery(conversation(), "quinn", ME), false);
    const accented = conversation({ members: [member(ME, "Quinn"), member("z", "Zoë")] });
    assert.equal(matchesQuery(accented, "zoe", ME), true);
    assert.equal(matchesQuery(conversation(), "   ", ME), true);
    assert.equal(matchesQuery(conversation({ members: [member(ME, "Quinn")] }), "deleted", ME, ["Deleted account"]), true);
  });

  test("fold and isOwner", () => {
    assert.equal(fold("ÉLAN"), "elan");
    assert.equal(isOwner(conversation({ ownerId: ME }), ME), true);
    assert.equal(isOwner(conversation({ ownerId: ME }), null), false);
  });
});
