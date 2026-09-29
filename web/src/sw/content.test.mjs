import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { notificationOf, payloadOf, targetOf } from "./content.ts";

const catalog = (lang) => JSON.parse(readFileSync(new URL(`../locales/${lang}/web.json`, import.meta.url), "utf8")).push;
const stringsFor = (lang) => ({ ...catalog("en"), ...(lang === "ru" ? catalog("ru") : {}) });
const EN = catalog("en");
const RU = catalog("ru");

const message = {
  v: 1,
  kind: "chat.message",
  lang: "en",
  conversationId: "01J9Z3NDEKTSV4RRFFQ69G5FAV",
  conversationKind: "group",
  seq: 812,
  title: "Clan night",
  sender: "Kyle",
  text: "See you on ffa3 @Jan",
  files: 0,
  cards: [],
  mention: true,
  badge: 3,
  silent: false,
};

test("a full preview shows the sender, the group and the text, tagged by conversation", () => {
  const plan = notificationOf(message, stringsFor, false);
  assert.equal(plan.title, "Kyle · Clan night");
  assert.equal(plan.options.body, "See you on ffa3 @Jan");
  assert.equal(plan.options.tag, "c:01J9Z3NDEKTSV4RRFFQ69G5FAV");
  assert.deepEqual(plan.options.data, { url: "/c/01J9Z3NDEKTSV4RRFFQ69G5FAV" });
  assert.equal(plan.options.renotify, true, "a mention alerts again");
  assert.equal(plan.options.silent, false);
  assert.equal(plan.badge, 3);
});

test("a direct message is titled by its sender alone", () => {
  const { title: _, conversationKind: __, ...direct } = message;
  const plan = notificationOf({ ...direct, conversationKind: "direct", mention: false }, stringsFor, false);
  assert.equal(plan.title, "Kyle");
  assert.equal(plan.options.renotify, false);
});

test("an open window makes the notification silent: the page sounded already", () => {
  assert.equal(notificationOf(message, stringsFor, true).options.silent, true);
  assert.equal(notificationOf({ ...message, silent: true }, stringsFor, false).options.silent, true, "the device's own silent switch");
});

test("a sender preview shows no text", () => {
  const { text: _, ...sender } = message;
  const plan = notificationOf(sender, stringsFor, false);
  assert.equal(plan.title, "Kyle · Clan night");
  assert.equal(plan.options.body, EN.newMessage);
});

test("no preview shows the generic words and still opens the conversation", () => {
  const plan = notificationOf({ v: 1, kind: "chat.message", lang: "ru", conversationId: "C1", badge: 1, silent: false }, stringsFor, false);
  assert.equal(plan.title, "JKNet");
  assert.equal(plan.options.body, RU.activity);
  assert.equal(plan.options.tag, "c:C1");
  assert.equal(plan.options.data.url, "/c/C1");
});

test("a message without text says what it carried", () => {
  const { text: _, ...bare } = message;
  assert.equal(notificationOf({ ...bare, files: 2 }, stringsFor, false).options.body, EN.sentFiles);
  assert.equal(notificationOf({ ...bare, cards: ["server"] }, stringsFor, false).options.body, EN.sharedCard);
});

test("the language of the subscription writes the words", () => {
  const plan = notificationOf({ v: 1, kind: "test", lang: "ru", badge: 0, silent: false }, stringsFor, false);
  assert.equal(plan.options.body, RU.test);
  assert.equal(plan.options.tag, "test");
  assert.equal(plan.options.data.url, "/settings/notifications");
  assert.equal(plan.badge, 0);
});

test("every kind has its tag and its address", () => {
  const cases = [
    [{ kind: "chat.reaction", conversationId: "C2", sender: "Jan", emoji: "👍" }, "c:C2", "/c/C2", "Jan", EN.reaction.replace("{{emoji}}", "👍")],
    [{ kind: "chat.reaction", conversationId: "C2", sender: "Jan" }, "c:C2", "/c/C2", "Jan", EN.reactionPlain],
    [{ kind: "chat.groupInvite", conversationId: "C3", sender: "Mara", title: "Duel club" }, "c:C3", "/c/C3", "Mara", EN.groupInvite.replace("{{title}}", "Duel club")],
    [{ kind: "chat.groupInvite", conversationId: "C3", sender: "Mara" }, "c:C3", "/c/C3", "Mara", EN.groupInvitePlain],
    [{ kind: "friend.request", sender: "Bast" }, "friends:requests", "/friends/requests", "Bast", EN.friendRequest],
    [{ kind: "friend.accepted", sender: "Bast" }, "friends:accepted", "/friends", "Bast", EN.friendAccepted],
    [{ kind: "invite", sender: "Cade", inviteId: "I9" }, "invite:I9", "/friends/requests", "Cade", EN.invite],
    [{ kind: "friend.request" }, "friends:requests", "/friends/requests", "JKNet", EN.activity],
    [{ kind: "something.new" }, "jknet", "/chats", "JKNet", EN.activity],
  ];
  for (const [payload, tag, url, title, body] of cases) {
    const plan = notificationOf({ v: 1, lang: "en", badge: 0, silent: false, ...payload }, stringsFor, false);
    assert.equal(plan.options.tag, tag, payload.kind);
    assert.equal(plan.options.data.url, url, payload.kind);
    assert.equal(plan.title, title, payload.kind);
    assert.equal(plan.options.body, body, payload.kind);
  }
});

test("a broken payload still gives a notification: a push must show one", () => {
  for (const raw of [null, "text", 42, { kind: 7, badge: "x" }]) {
    const plan = notificationOf(raw, stringsFor, false);
    assert.equal(plan.title, "JKNet");
    assert.equal(plan.options.body, EN.activity);
    assert.equal(plan.badge, null);
  }
});

test("an id with characters of its own is encoded in the address", () => {
  assert.equal(targetOf(payloadOf({ kind: "chat.message", conversationId: "a/b?c" })).url, "/c/a%2Fb%3Fc");
});

test("every language has every word of the push section", () => {
  const keys = Object.keys(EN).sort();
  for (const lang of ["ru", "de", "es", "fr", "hu", "pl", "uk"]) {
    assert.deepEqual(Object.keys(catalog(lang)).sort(), keys, lang);
  }
});
