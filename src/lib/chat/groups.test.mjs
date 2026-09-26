/**
 * Tests for src/lib/chat/groups.ts: who may rename, remove, add and change
 * the history setting, what leaving does, the friends a picker offers, the
 * report of an add, and how the host finds the chat of their server.
 *
 * Usage: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  GROUP_MAX_MEMBERS,
  addOutcome,
  addedAnybody,
  canAddMembers,
  canChangeHistory,
  canRemoveMember,
  canRename,
  groupRoom,
  leaveOutcome,
  orderMembers,
  outOfRoom,
  ownsConversation,
  pickCandidates,
  serverChatOf,
} from "./groups.ts";

const ME = "me";

function user(id, displayName = id) {
  return { id, displayName, avatarUrl: null, provider: "dev", providerName: id, createdAt: "2026-09-10T00:00:00Z" };
}

function member(id, joinedAt = "2026-09-10T00:00:00Z", role = "member") {
  return { user: user(id), role, joinedAt, readSeq: 0 };
}

function group(fields = {}) {
  return {
    id: "g",
    kind: "group",
    title: "Duel club",
    ownerId: ME,
    members: [
      member(ME, "2026-09-10T00:00:00Z", "owner"),
      member("kai", "2026-09-11T00:00:00Z"),
      member("dana", "2026-09-10T12:00:00Z"),
    ],
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
    createdAt: "2026-09-10T00:00:00Z",
    ...fields,
  };
}

function serverChat(hostId, sessionId = "0123456789abcdef", fields = {}) {
  return group({
    id: `s-${sessionId}`,
    kind: "server",
    title: null,
    ownerId: hostId,
    server: { hostId, sessionId },
    members: [member(hostId, "2026-09-10T00:00:00Z", "owner"), member(hostId === ME ? "kai" : ME, "2026-09-10T01:00:00Z")],
    ...fields,
  });
}

function friend(id, status = "online", displayName = id) {
  return {
    user: user(id, displayName),
    presence: { status, serverAddress: null, serverName: null, clientName: null, since: "2026-09-20T00:00:00Z" },
    friendsSince: "2026-09-10T00:00:00Z",
  };
}

describe("owner rights (D1, D5)", () => {
  test("the owner of a group renames it and changes the history setting", () => {
    assert.equal(ownsConversation(group(), ME), true);
    assert.equal(canRename(group(), ME), true);
    assert.equal(canChangeHistory(group(), ME), true);
  });

  test("a member does neither", () => {
    const theirs = group({ ownerId: "kai" });
    assert.equal(canRename(theirs, ME), false);
    assert.equal(canChangeHistory(theirs, ME), false);
    assert.equal(canRename(group(), null), false);
  });

  test("a server chat is renamed by nobody, and its switch lives on the host screen", () => {
    const mine = serverChat(ME);
    assert.equal(ownsConversation(mine, ME), true);
    assert.equal(canRename(mine, ME), false);
    assert.equal(canChangeHistory(mine, ME), false);
  });

  test("the host of a server chat is its owner even without ownerId", () => {
    assert.equal(ownsConversation(serverChat(ME, "0123456789abcdef", { ownerId: null }), ME), true);
  });
});

describe("removing members", () => {
  test("the owner removes a member, not themselves", () => {
    assert.equal(canRemoveMember(group(), ME, "kai"), true);
    assert.equal(canRemoveMember(group(), ME, ME), false);
  });

  test("a member removes nobody", () => {
    assert.equal(canRemoveMember(group({ ownerId: "kai" }), ME, "dana"), false);
  });

  test("nobody removes the owner, nor somebody who is not a member", () => {
    assert.equal(canRemoveMember(group(), ME, "stranger"), false);
    assert.equal(canRemoveMember(serverChat(ME), ME, ME), false);
  });

  test("the host removes a guest of the server chat", () => {
    assert.equal(canRemoveMember(serverChat(ME), ME, "kai"), true);
    assert.equal(canRemoveMember(serverChat("kai"), ME, "kai"), false);
  });
});

describe("room in a group", () => {
  test("twenty members, the owner included", () => {
    assert.equal(GROUP_MAX_MEMBERS, 20);
    assert.equal(groupRoom(null), 19);
    assert.equal(groupRoom(group()), 17);
  });

  test("a full group takes nobody", () => {
    const members = Array.from({ length: 20 }, (_, index) => member(`m${index}`));
    assert.equal(groupRoom(group({ members })), 0);
    assert.equal(canAddMembers(group({ members })), false);
    assert.equal(canAddMembers(group()), true);
  });

  test("nobody is added to a server chat or a direct chat", () => {
    assert.equal(canAddMembers(serverChat(ME)), false);
    assert.equal(canAddMembers(group({ kind: "direct" })), false);
  });

  test("the room of a group is only an upper bound: invitations waiting hold seats", () => {
    // 15 members and 5 pending invitations the conversation does not show:
    // the launcher still offers five seats, the service refuses them all.
    const members = Array.from({ length: 15 }, (_, index) => member(`m${index}`));
    assert.equal(groupRoom(group({ members })), 5);
    const answer = addOutcome({
      added: [],
      invited: [],
      refused: ["a", "b", "c", "d", "e"].map((userId) => ({ userId, reason: "full" })),
    });
    assert.equal(addedAnybody(answer), false);
    assert.equal(outOfRoom(answer), true);
  });

  test("only a refusal for want of room says the seats are gone", () => {
    assert.equal(outOfRoom(addOutcome({ added: ["a"], invited: [], refused: [] })), false);
    assert.equal(
      outOfRoom(addOutcome({ added: [], invited: [], refused: [{ userId: "b", reason: "cooldown" }] })),
      false,
    );
    assert.equal(
      outOfRoom(
        addOutcome({
          added: ["a"],
          invited: ["b"],
          refused: [
            { userId: "c", reason: "not_friend" },
            { userId: "d", reason: "full" },
          ],
        }),
      ),
      true,
    );
  });
});

describe("the order of the member list", () => {
  test("the owner first, then by the time they joined", () => {
    const ordered = orderMembers(group({ ownerId: "kai" })).map((m) => m.user.id);
    assert.deepEqual(ordered, ["kai", ME, "dana"]);
  });

  test("the host leads a server chat", () => {
    const ordered = orderMembers(serverChat("kai")).map((m) => m.user.id);
    assert.deepEqual(ordered, ["kai", ME]);
  });
});

describe("leaving (D4, D9)", () => {
  test("the owner hands the group to the member who joined earliest", () => {
    const outcome = leaveOutcome(group(), ME);
    assert.equal(outcome.kind, "handover");
    assert.equal(outcome.next.id, "dana");
  });

  test("a member just leaves", () => {
    assert.deepEqual(leaveOutcome(group({ ownerId: "kai" }), ME), { kind: "leave" });
  });

  test("the last member deletes the group", () => {
    assert.deepEqual(leaveOutcome(group({ members: [member(ME)] }), ME), { kind: "delete" });
  });

  test("a guest leaves a server chat, the host ends it", () => {
    assert.deepEqual(leaveOutcome(serverChat("kai"), ME), { kind: "leave" });
    assert.deepEqual(leaveOutcome(serverChat(ME), ME), { kind: "end" });
  });
});

describe("the friends a picker offers", () => {
  const friends = [
    friend("rosh", "offline", "Rosh"),
    friend("kai", "in_game", "Kai"),
    friend("jan", "online", "Jan"),
    friend("émile", "online", "Émile"),
  ];

  test("members left out, the ones around first, then by name", () => {
    const ids = pickCandidates(friends, new Set(["kai"]), "").map((f) => f.user.id);
    assert.deepEqual(ids, ["émile", "jan", "rosh"]);
  });

  test("the query ignores case and accents", () => {
    assert.deepEqual(pickCandidates(friends, new Set(), "EMI").map((f) => f.user.id), ["émile"]);
    assert.deepEqual(pickCandidates(friends, new Set(), "  ").length, 4);
    assert.deepEqual(pickCandidates(friends, new Set(), "zz"), []);
  });
});

describe("the report of an add", () => {
  test("refusals grouped by reason in a fixed order", () => {
    const outcome = addOutcome({
      added: ["kai"],
      invited: ["rosh"],
      refused: [
        { userId: "a", reason: "member" },
        { userId: "b", reason: "full" },
        { userId: "c", reason: "full" },
        { userId: "d", reason: "cooldown" },
      ],
    });
    assert.deepEqual(outcome.added, ["kai"]);
    assert.deepEqual(outcome.invited, ["rosh"]);
    assert.deepEqual(outcome.refused, [
      { reason: "full", userIds: ["b", "c"] },
      { reason: "cooldown", userIds: ["d"] },
      { reason: "member", userIds: ["a"] },
    ]);
    assert.equal(addedAnybody(outcome), true);
  });

  test("a reason this launcher does not know is kept", () => {
    const outcome = addOutcome({ added: [], invited: [], refused: [{ userId: "x", reason: "banned" }] });
    assert.deepEqual(outcome.refused, [{ reason: "banned", userIds: ["x"] }]);
    assert.equal(addedAnybody(outcome), false);
  });

  test("an invitation alone counts as a change", () => {
    assert.equal(addedAnybody(addOutcome({ added: [], invited: ["rosh"], refused: [] })), true);
  });
});

describe("the chat of a hosted server", () => {
  const conversations = [group(), serverChat("kai", "aaaaaaaaaaaaaaaa"), serverChat(ME, "0123456789abcdef")];

  test("found by the session, whatever its id", () => {
    assert.equal(serverChatOf(conversations, "0123456789abcdef")?.id, "s-0123456789abcdef");
    assert.equal(serverChatOf(conversations, "0123456789ABCDEF", ME)?.id, "s-0123456789abcdef");
  });

  test("the chat of a friend's server is not mine", () => {
    assert.equal(serverChatOf(conversations, "aaaaaaaaaaaaaaaa", ME), null);
    assert.equal(serverChatOf(conversations, "aaaaaaaaaaaaaaaa")?.id, "s-aaaaaaaaaaaaaaaa");
  });

  test("nothing before the core opens it", () => {
    assert.equal(serverChatOf([group()], "0123456789abcdef", ME), null);
  });
});
