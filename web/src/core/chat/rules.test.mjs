/**
 * The chat rules of the web core against the cases the launcher's Rust core
 * runs too (`src/lib/chat/fixtures/*.json`), and the unit cases of the
 * launcher's `chat/{mod,sync,outbox,frames,links,notify}.rs` tests, ported.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { refusal } from "../http.ts";
import { CoreError, networkError } from "../errors.ts";
import { Book, UNREAD_CAP } from "./book.ts";
import { applyFrame, effectName, parseFrame } from "./frames.ts";
import { checkLink, MAX_LINK_CHARS } from "./links.ts";
import { compose, decide, incomingOf, levelOf, NotifyPace } from "./notify.ts";
import {
  backoff,
  classify,
  entryView,
  fromRecord,
  GIVE_UP_AFTER_MS,
  newClientId,
  newEntry,
  Outbox,
  toRecord,
} from "./outbox.ts";
import { ReadMarks } from "./reads.ts";
import { readConversation, readMessage, readSyncDoc } from "./wire.ts";
import { checkDraft, MAX_ATTACHMENTS, MAX_BODY_CHARS, MAX_CARDS } from "./drafts.ts";

const ME = "01HME000000000000000000000";
const KYLE = "01HKYLE0000000000000000000";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../../../../src/lib/chat/fixtures/${name}`, import.meta.url), "utf8"));
}

function user(id) {
  return { id, displayName: id, avatarUrl: null, provider: "dev", providerName: id, createdAt: "" };
}

function conversation(id, lastSeq, readSeq) {
  return readConversation({
    id,
    kind: "direct",
    members: [
      { user: user(ME), role: "member", joinedAt: "", readSeq },
      { user: user(KYLE), role: "member", joinedAt: "", readSeq: 0 },
    ],
    lastSeq,
    readSeq,
    notify: "all",
    canSend: true,
    createdAt: "2026-09-26T10:00:00Z",
  });
}

function message(conversationId, seq, sender) {
  return readMessage({
    conversationId,
    seq,
    senderId: sender,
    kind: "user",
    body: `message ${seq}`,
    createdAt: `2026-09-26T10:${String(seq % 60).padStart(2, "0")}:00Z`,
  });
}

function bookWith(conversations) {
  const book = new Book();
  book.replace(readSyncDoc({ conversations }));
  return book;
}

function draft(body, extra = {}) {
  return { body, cards: [], attachments: [], replySeq: null, ...extra };
}

describe("book", () => {
  test("a sync document with a lower lastSeq puts that conversation in reset", () => {
    const book = bookWith([conversation("a", 40, 40), conversation("b", 7, 7)]);
    const reset = book.replace(readSyncDoc({ conversations: [conversation("a", 12, 12), conversation("b", 9, 7), conversation("c", 3, 0)] }));
    assert.deepEqual(reset, ["a"]);
    assert.equal(book.get("a").lastSeq, 12);
    assert.equal(book.summaries.size, 3);
    assert.deepEqual(book.privacy, { shareReadReceipts: true, shareTyping: true, groupAdd: "friends" });
    assert.deepEqual(new Book().replace(readSyncDoc({ conversations: [conversation("a", 1, 0)] })), []);
  });

  test("a message of another member counts as unread and a mention as both", () => {
    const book = bookWith([conversation("a", 2, 2)]);
    assert.deepEqual(book.applyMessage(ME, message("a", 3, KYLE), false), { known: true, fresh: true, typingStopped: false });
    assert.deepEqual([book.get("a").lastSeq, book.get("a").unread, book.get("a").unreadMentions], [3, 1, 0]);
    const mention = { ...message("a", 4, KYLE), mentions: [ME] };
    book.applyMessage(ME, mention, false);
    assert.deepEqual([book.get("a").unread, book.get("a").unreadMentions], [2, 1]);
    const again = book.applyMessage(ME, mention, false);
    assert.ok(again.known && !again.fresh);
    assert.equal(book.get("a").unread, 2);
  });

  test("a deleted account's message is unread and never the player's own", () => {
    const book = bookWith([conversation("a", 0, 0)]);
    book.applyMessage(ME, message("a", 1, null), false);
    assert.equal(book.get("a").unread, 1);
  });

  test("an own message reads the conversation and a viewed one stays read", () => {
    const book = bookWith([conversation("a", 5, 3)]);
    book.get("a").unread = 2;
    book.applyMessage(ME, message("a", 6, ME), false);
    assert.deepEqual([book.get("a").readSeq, book.get("a").unread], [6, 0]);
    assert.equal(book.get("a").members[0].readSeq, 6);
    book.applyMessage(ME, message("a", 7, KYLE), true);
    assert.deepEqual([book.get("a").lastSeq, book.get("a").unread], [7, 0]);
  });

  test("system messages and hidden history do not count", () => {
    const book = bookWith([conversation("a", 10, 0)]);
    book.get("a").visibleFromSeq = 20;
    book.applyMessage(ME, { ...message("a", 11, null), kind: "system" }, false);
    assert.equal(book.get("a").unread, 0);
    book.applyMessage(ME, message("a", 12, KYLE), false);
    assert.equal(book.get("a").unread, 0);
  });

  test("unread stops at the cap of the service", () => {
    const book = bookWith([conversation("a", 0, 0)]);
    for (let seq = 1; seq <= 150; seq += 1) book.applyMessage(ME, message("a", seq, KYLE), false);
    assert.equal(book.get("a").unread, UNREAD_CAP);
  });

  test("read markers move forward only", () => {
    const book = bookWith([conversation("a", 10, 4)]);
    book.get("a").unread = 6;
    assert.deepEqual(book.applyRead(ME, { conversationId: "a", userId: KYLE, seq: 8 }), [true, false]);
    assert.equal(book.get("a").members[1].readSeq, 8);
    book.applyRead(ME, { conversationId: "a", userId: KYLE, seq: 5 });
    assert.equal(book.get("a").members[1].readSeq, 8);
    assert.deepEqual(book.applyRead(ME, { conversationId: "a", userId: ME, seq: 7 }), [true, true]);
    assert.deepEqual(book.applyRead(ME, { conversationId: "a", userId: ME, seq: 10 }), [true, false]);
    assert.deepEqual([book.get("a").readSeq, book.get("a").unread], [10, 0]);
  });

  test("totals leave muted unread out but keep its mentions", () => {
    const loud = { ...conversation("a", 3, 0), unread: 3, unreadMentions: 1 };
    const muted = { ...conversation("b", 5, 0), notify: "mute", unread: 5, unreadMentions: 2 };
    assert.deepEqual(bookWith([loud, muted]).totals(), [3, 3]);
  });

  test("the list is newest activity first", () => {
    const quiet = { ...conversation("quiet", 0, 0), createdAt: "2026-09-26T09:00:00Z" };
    const busy = { ...conversation("busy", 1, 0), lastMessage: message("busy", 1, KYLE) };
    const fresh = { ...conversation("fresh", 0, 0), createdAt: "2026-09-26T23:00:00Z" };
    assert.deepEqual(bookWith([quiet, busy, fresh]).conversations().map((c) => c.id), ["fresh", "busy", "quiet"]);
  });

  test("reactions toggle on the last message", () => {
    const book = bookWith([{ ...conversation("a", 1, 1), lastMessage: message("a", 1, KYLE) }]);
    const on = { conversationId: "a", seq: 1, userId: ME, emoji: "👍", on: true };
    assert.ok(book.applyReaction(on));
    assert.ok(!book.applyReaction(on));
    assert.deepEqual(book.get("a").lastMessage.reactions[0].userIds, [ME]);
    assert.ok(book.applyReaction({ ...on, on: false }));
    assert.deepEqual(book.get("a").lastMessage.reactions, []);
    assert.ok(!book.applyReaction({ ...on, seq: 0 }));
  });

  test("typing hints expire and a message ends them", () => {
    const book = bookWith([conversation("a", 0, 0)]);
    book.setTyping("a", KYLE, 6_000);
    assert.deepEqual(book.typingIn("a", 0), [KYLE]);
    assert.deepEqual(book.typingIn("a", 7_000), []);
    book.setTyping("a", KYLE, 6_000);
    assert.ok(book.applyMessage(ME, message("a", 1, KYLE), false).typingStopped);
    assert.deepEqual(book.typingIn("a", 0), []);
  });

  test("a receipts switch that flips asks for a fresh document", () => {
    const book = bookWith([]);
    assert.ok(!book.setPrivacy({ shareReadReceipts: true, shareTyping: true, groupAdd: "friends" }));
    assert.ok(book.setPrivacy({ shareReadReceipts: false, shareTyping: true, groupAdd: "friends" }));
    assert.ok(!book.setPrivacy({ shareReadReceipts: false, shareTyping: false, groupAdd: "friends" }));
    assert.ok(!book.sharesTyping());
  });

  test("a typing hint goes only where the player may write", () => {
    const book = bookWith([conversation("dm", 3, 3), { ...conversation("unfriended", 3, 3), canSend: false }]);
    assert.ok(book.mayType("dm"));
    assert.ok(!book.mayType("unfriended"));
    assert.ok(!book.mayType("unknown"));
    book.setPrivacy({ shareReadReceipts: true, shareTyping: false, groupAdd: "friends" });
    assert.ok(!book.mayType("dm"));
  });

  test("joining a group drops its invite", () => {
    const book = new Book();
    book.upsertInvite({ conversationId: "g", title: null, invitedBy: user(KYLE), memberCount: 2, createdAt: "", expiresAt: "" });
    book.upsert(conversation("g", 1, 0));
    assert.deepEqual(book.invites, []);
  });

  test("the screens get copies, not the book's own objects", () => {
    const book = bookWith([conversation("a", 1, 0)]);
    const copy = book.conversations()[0];
    copy.unread = 42;
    assert.equal(book.get("a").unread, 0);
  });
});

describe("wire", () => {
  test("missing fields take the launcher's defaults", () => {
    const summary = readConversation({ id: "c", kind: "group" });
    assert.equal(summary.notify, "all");
    assert.equal(summary.canSend, false);
    assert.deepEqual(summary.members, []);
    const plain = readMessage({ conversationId: "c", seq: 1 });
    assert.equal(plain.kind, "user");
    assert.deepEqual(plain.cards, []);
    assert.equal(plain.senderId, null);
  });

  test("a document without an id or a seq is unreadable", () => {
    assert.throws(() => readConversation({ kind: "group" }));
    assert.throws(() => readMessage({ conversationId: "c", seq: "x" }));
    assert.throws(() => readMessage({ conversationId: "c", seq: -1 }));
  });

  test("a user keeps only the fields of the contract", () => {
    const summary = readConversation({
      id: "c",
      kind: "group",
      members: [{ user: { ...user(KYLE), email: "kyle@example.com", internal: 7 }, role: "member" }],
    });
    assert.deepEqual(summary.members[0].user, user(KYLE));
  });
});

describe("frames.json", () => {
  const cases = fixture("frames.json");

  test("the shared frame cases hold", () => {
    assert.ok(cases.length >= 20);
    for (const entry of cases) {
      const state = entry.state ?? {};
      assert.ok(state.me === undefined || state.me === ME, entry.name);
      const book = bookWith(
        (state.conversations ?? []).map((row) => {
          const summary = conversation(row.id, row.lastSeq, row.readSeq);
          if (row.unread !== undefined) summary.unread = row.unread;
          summary.lastMessage = row.lastMessageSeq === undefined ? null : message(row.id, row.lastMessageSeq, KYLE);
          return summary;
        }),
      );
      const outbox = new Outbox();
      for (const row of state.outbox ?? []) outbox.push(newEntry(row.clientId, row.conversationId, draft("gg"), ""));
      if (state.privacy !== undefined) book.setPrivacy(state.privacy);
      for (const id of state.invites ?? []) {
        book.upsertInvite({ conversationId: id, title: null, invitedBy: user(KYLE), memberCount: 0, createdAt: "", expiresAt: "" });
      }
      for (const hint of state.typing ?? []) book.setTyping(hint.conversationId, hint.userId, 6_000);
      const reads = new ReadMarks();
      const frameState = {
        book,
        outbox,
        reads,
        dropDraft: () => {},
        isViewed: (id) => state.viewing === id,
      };
      let effects;
      try {
        effects = applyFrame(frameState, state.me ?? null, parseFrame(entry.frame.type, entry.frame.payload), 0);
      } catch {
        effects = [];
      }
      assert.deepEqual(effects.map(effectName).sort(), [...entry.effects].sort(), entry.name);
    }
  });

  test("an own message settles its outbox entry by client id", () => {
    const book = bookWith([conversation("c", 2, 2)]);
    const outbox = new Outbox();
    outbox.push(newEntry("01J0CLIENT", "c", draft("gg"), ""));
    const state = { book, outbox, reads: new ReadMarks(), dropDraft: () => {}, isViewed: () => false };
    applyFrame(state, ME, { kind: "message", message: { ...message("c", 3, ME), clientId: "01J0CLIENT" } }, 0);
    assert.deepEqual(outbox.all(), []);
  });

  test("a removed conversation takes its queue and draft along", () => {
    const book = bookWith([conversation("c", 1, 1)]);
    const outbox = new Outbox();
    outbox.push(newEntry("01J0CLIENT", "c", draft("gg"), ""));
    const dropped = [];
    const state = { book, outbox, reads: new ReadMarks(), dropDraft: (id) => dropped.push(id), isViewed: () => false };
    applyFrame(state, ME, parseFrame("chat.conversation.removed", { conversationId: "c", reason: "ended" }), 0);
    assert.equal(book.get("c"), undefined);
    assert.deepEqual(outbox.all(), []);
    assert.deepEqual(dropped, ["c"]);
  });

  test("typing expires after the hint's ttl, capped at 30 s", () => {
    const book = bookWith([conversation("c", 0, 0)]);
    const state = { book, outbox: new Outbox(), reads: new ReadMarks(), dropDraft: () => {}, isViewed: () => false };
    const effects = applyFrame(state, ME, parseFrame("chat.typing", { conversationId: "c", userId: KYLE, ttlMs: 90_000 }), 0);
    assert.deepEqual(effects.find((effect) => effect.kind === "typingExpires"), { kind: "typingExpires", conversationId: "c", after: 30_000 });
  });
});

describe("outbox", () => {
  const entry = (clientId, conversationId) => newEntry(clientId, conversationId, draft(`text of ${clientId}`), "");
  const network = () => networkError("connection reset");

  test("one head per conversation goes out and the rest wait", () => {
    const outbox = new Outbox();
    outbox.push(entry("a1", "a"));
    outbox.push(entry("a2", "a"));
    outbox.push(entry("b1", "b"));
    assert.deepEqual(outbox.startReady(0, 0), ["a1", "b1"]);
    assert.deepEqual(outbox.startReady(0, 0), []);
    assert.ok(outbox.take("a1"));
    assert.deepEqual(outbox.startReady(0, 0), ["a2"]);
  });

  test("an entry keeps its client id through every retry and a waiting head holds the rest", () => {
    const outbox = new Outbox();
    outbox.push(entry("01J0CLIENT", "a"));
    outbox.push(entry("second", "a"));
    assert.deepEqual(outbox.startReady(0, 0), ["01J0CLIENT"]);
    assert.deepEqual(outbox.retryLater("01J0CLIENT", network(), 0, 0), { kind: "after", wait: 1_000 });
    assert.deepEqual(outbox.startReady(0, 0), []);
    assert.equal(outbox.nextWait(0), 1_000);
    assert.deepEqual(outbox.startReady(1_000, 0), ["01J0CLIENT"]);
  });

  test("the backoff doubles to thirty seconds", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(backoff), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  test("an entry gives up after ten minutes of trying online, and time offline does not count", () => {
    const outbox = new Outbox();
    outbox.push(entry("a1", "a"));
    outbox.startReady(0, 0);
    assert.equal(outbox.retryLater("a1", network(), 0, 0).kind, "after");
    // An hour of wall clock, but only nine minutes online: it keeps trying.
    assert.equal(outbox.retryLater("a1", network(), 3_600_000, 9 * 60_000).kind, "after");
    assert.deepEqual(outbox.retryLater("a1", network(), 3_700_000, GIVE_UP_AFTER_MS), { kind: "gaveUp" });
    assert.deepEqual([outbox.get("a1").status, outbox.get("a1").error], ["failed", "network"]);
  });

  test("a failed entry steps aside and retry starts it afresh", () => {
    const outbox = new Outbox();
    outbox.push(entry("a1", "a"));
    outbox.push(entry("a2", "a"));
    outbox.startReady(0, 0);
    assert.equal(outbox.fail("a1", refusal(403, JSON.stringify({ error: { code: "forbidden", message: "no", details: { reason: "not_friends" } } }), "/v1/chat/conversations/a/messages")), "a");
    assert.equal(outbox.get("a1").error, "not_friends");
    assert.deepEqual(outbox.startReady(0, 0), ["a2"]);
    outbox.take("a2");
    assert.equal(outbox.retry("a1"), "a");
    assert.deepEqual([outbox.get("a1").status, outbox.get("a1").error], ["queued", null]);
    assert.deepEqual(outbox.startReady(0, 0), ["a1"]);
  });

  test("lost files are registered again once", () => {
    const outbox = new Outbox();
    outbox.push(newEntry("a1", "a", draft("", { attachments: ["h1", "h2"] }), ""));
    assert.deepEqual(outbox.startReady(0, 0), ["a1"]);
    assert.equal(outbox.get("a1").status, "uploading");
    outbox.setFileId("a1", 0, "f1");
    outbox.setFileId("a1", 1, "f2");
    assert.ok(outbox.reregister("a1"));
    assert.ok(!outbox.reregister("a1"));
    outbox.push(entry("b1", "b"));
    assert.ok(!outbox.reregister("b1"));
  });

  test("a flush ends every wait", () => {
    const outbox = new Outbox();
    outbox.push(entry("a1", "a"));
    outbox.startReady(0, 0);
    outbox.retryLater("a1", network(), 0, 0);
    outbox.flush();
    assert.deepEqual(outbox.startReady(0, 0), ["a1"]);
  });

  test("an entry survives a reload: queued again, its time online kept", () => {
    const outbox = new Outbox();
    outbox.push(entry("a1", "a"));
    outbox.startReady(0, 1_000);
    const record = toRecord(outbox.get("a1"), 61_000, "2026-09-27T10:00:00Z");
    assert.equal(record.onlineMs, 60_000);
    assert.equal(record.status, "sending");
    const back = fromRecord(structuredClone(record), 5_000);
    assert.equal(back.status, "queued");
    assert.equal(back.firstTry, 5_000 - 60_000);
    assert.equal(back.clientId, "a1");
    const failed = fromRecord({ ...record, status: "failed", error: "too_long" }, 0);
    assert.deepEqual([failed.status, failed.error], ["failed", "too_long"]);
  });

  test("an entry reaches the screens without its bookkeeping", () => {
    const view = entryView(entry("01J0CLIENT", "a"));
    assert.equal(view.clientId, "01J0CLIENT");
    assert.equal(view.status, "queued");
    assert.equal(view.error, null);
    assert.equal(view.attempts, undefined);
    assert.equal(view.fileIds, undefined);
  });

  test("a client id is a ULID", () => {
    const first = newClientId();
    assert.equal(first.length, 26);
    assert.notEqual(first, newClientId());
    assert.match(first, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    // Time-ordered: an id made later never sorts before.
    assert.ok(newClientId(Date.now() + 5).slice(0, 10) >= first.slice(0, 10));
    assert.equal(newClientId(0, new Uint8Array(10)), "0".repeat(26));
  });

  test("the shared failure cases sort into their rows", () => {
    const cases = fixture("outbox-failures.json");
    assert.ok(cases.length >= 10);
    for (const entry of cases) {
      let error;
      if (entry.status === 0) {
        error = networkError("connection reset");
      } else {
        const body =
          entry.code === null
            ? ""
            : JSON.stringify({
                error: {
                  code: entry.code,
                  message: entry.message ?? "refused",
                  details: entry.reason === undefined ? null : { reason: entry.reason },
                },
              });
        error = refusal(entry.status, body, "/v1/chat/conversations/c/messages");
      }
      const verdict = { filesLost: "reregister", transient: "retry", refused: "fail" }[classify(error)];
      assert.equal(verdict, entry.verdict, `${entry.status} ${entry.code} ${entry.reason ?? ""}`);
      assert.ok(error instanceof CoreError);
    }
  });

  test("a service without the chat API says so", () => {
    const error = refusal(404, JSON.stringify({ error: { code: "not_found", message: "No such endpoint" } }), "/v1/chat/conversations");
    assert.equal(error.details.code, "chat_unavailable");
    // Outside the chat API the reason stays in the details.
    const plain = refusal(403, JSON.stringify({ error: { code: "forbidden", message: "no", details: { reason: "x" } } }), "/v1/friends");
    assert.equal(plain.details.code, "forbidden");
  });
});

describe("reads", () => {
  test("a lost read marker waits for the next flush and a refused one goes", () => {
    const marks = new ReadMarks();
    marks.queue("a", 5);
    marks.queue("a", 3);
    marks.queue("b", 2);
    assert.deepEqual(marks.take().sort(), [["a", 5], ["b", 2]]);
    marks.queue("a", 7);
    marks.failed("a", 5);
    marks.refused("b", 2);
    assert.deepEqual(marks.take(), [["a", 7]]);
    marks.failed("a", 7);
    assert.deepEqual(marks.take(), [["a", 7]]);
    marks.sent("a", 7);
    assert.deepEqual(marks.all(), []);
  });

  test("an answer to an older marker leaves the newer one in flight", () => {
    const marks = new ReadMarks();
    marks.queue("a", 4);
    marks.take();
    marks.queue("a", 9);
    marks.take();
    marks.sent("a", 4);
    assert.deepEqual(marks.all(), [["a", 9]]);
    marks.sent("a", 9);
    assert.deepEqual(marks.all(), []);
  });

  test("lost markers go again at the pace of the outbox and stop after its window", () => {
    const marks = new ReadMarks();
    assert.equal(marks.retryAfter(0), 1_000);
    assert.equal(marks.retryAfter(0), 2_000);
    assert.equal(marks.retryAfter(0), 4_000);
    marks.sent("a", 1);
    assert.equal(marks.retryAfter(0), 1_000);
    assert.equal(marks.retryAfter(GIVE_UP_AFTER_MS), null);
    marks.queue("a", 3);
    assert.ok(marks.connectionBack());
    assert.equal(marks.retryAfter(GIVE_UP_AFTER_MS), 1_000);
    marks.take();
    assert.ok(!marks.connectionBack());
  });
});

describe("links.json", () => {
  test("the shared link cases hold", () => {
    const cases = fixture("links.json");
    assert.ok(cases.length >= 30);
    for (const entry of cases) {
      const link = checkLink(entry.input);
      const verdict = link === null ? "refuse" : link.trusted ? "open" : "confirm";
      assert.equal(verdict, entry.verdict, JSON.stringify(entry.input).slice(0, 80));
      if (link === null) continue;
      if (entry.url !== undefined) assert.equal(link.url, entry.url);
      if (entry.host !== undefined) assert.equal(link.host, entry.host);
    }
  });

  test("the length limit counts characters", () => {
    assert.equal(checkLink(`https://jknet.app/${"a".repeat(MAX_LINK_CHARS)}`), null);
    assert.ok(checkLink(`https://jknet.app/${"a".repeat(MAX_LINK_CHARS - 18)}`));
  });
});

describe("notify-decide.json", () => {
  test("the shared notification cases hold, launcher-only ones aside", () => {
    const cases = fixture("notify-decide.json").filter((entry) => entry.launcherOnly !== true);
    assert.ok(cases.length >= 20);
    const defaults = {
      inApp: true,
      os: true,
      sound: true,
      soundName: "default",
      showText: true,
      dnd: false,
      mentionsBreakDnd: false,
      dndInGame: true,
      summaryAfterGame: true,
      quietHours: null,
    };
    for (const entry of cases) {
      const msg = { own: false, system: false, mentioned: false, ...entry.message };
      const [hours, minutes] = entry.context.time.split(":").map(Number);
      const settings = { ...defaults, ...entry.settings };
      const delivery = decide(
        msg,
        { notify: levelOf(entry.notify), viewed: entry.viewing === true },
        settings,
        { minuteOfDay: hours * 60 + minutes, focused: entry.context.focused },
      );
      const verdict =
        !delivery.inApp && !delivery.os && !delivery.sound ? "silent" : delivery.inApp || delivery.os ? "toast" : "sound";
      assert.equal(verdict, entry.expect, entry.name);
      if (verdict === "toast") {
        assert.equal(delivery.inApp, entry.context.focused, entry.name);
        assert.equal(delivery.os, !entry.context.focused, entry.name);
        assert.equal(delivery.sound, settings.sound, entry.name);
      }
    }
  });

  test("a mention or a reply to the player counts as mentioned", () => {
    const plain = message("c", 5, KYLE);
    assert.ok(!incomingOf(plain, ME).mentioned);
    assert.ok(incomingOf({ ...plain, mentions: [ME] }, ME).mentioned);
    assert.ok(incomingOf({ ...plain, replyTo: { seq: 1, senderId: ME, excerpt: "hi" } }, ME).mentioned);
    assert.ok(!incomingOf({ ...plain, mentions: [ME] }, null).mentioned);
  });

  test("notifications keep a pace and mentions skip the queue", () => {
    const pace = new NotifyPace();
    const all = { inApp: false, os: true, sound: true };
    assert.deepEqual(pace.pace("c", false, 0, all), all);
    assert.deepEqual(pace.pace("c", false, 500, all), { inApp: false, os: false, sound: false });
    assert.deepEqual(pace.pace("c", true, 1_500, all), { inApp: false, os: true, sound: true });
    assert.equal(pace.pace("d", false, 1_600, all).os, true);
  });

  test("a direct message is titled with its sender, a group with its title", () => {
    const texts = { newMessage: "New message", deletedAccount: "Deleted account" };
    const direct = { ...conversation("c", 1, 0) };
    direct.members[1].user.displayName = "Kyle";
    const body = { ...message("c", 2, KYLE), body: "hi <@01HME000000000000000000000>\n\tthere" };
    direct.members[0].user.displayName = "Me";
    assert.deepEqual(compose(body, direct, true, texts), { title: "Kyle", text: "hi @Me there" });
    const group = { ...direct, kind: "group", title: "Clan night" };
    assert.deepEqual(compose(body, group, true, texts), { title: "Clan night", text: "Kyle: hi @Me there" });
    assert.deepEqual(compose(body, group, false, texts), { title: "Clan night", text: "New message" });
    assert.deepEqual(compose({ ...body, senderId: null }, direct, true, texts).title, "Deleted account");
    const long = { ...body, body: "x".repeat(300) };
    assert.equal([...compose(long, direct, true, texts).text].length, 200);
    assert.equal(compose({ ...body, body: "‮evil" }, direct, true, texts).text, "evil");
  });
});

describe("drafts", () => {
  test("a draft is checked before it is queued", () => {
    assert.ok(checkDraft({ body: "gg" }));
    assert.throws(() => checkDraft({ body: "   \n" }));
    assert.ok(checkDraft({ body: "a".repeat(MAX_BODY_CHARS) }));
    assert.throws(() => checkDraft({ body: "a".repeat(MAX_BODY_CHARS + 1) }));
    assert.throws(() => checkDraft({ body: "x", cards: Array.from({ length: MAX_CARDS + 1 }, () => ({ type: "map" })) }));
    assert.throws(() => checkDraft({ body: "", attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => "h") }));
    assert.deepEqual(checkDraft({ body: "hi", replySeq: 3 }), { body: "hi", cards: [], attachments: [], replySeq: 3 });
  });
});
