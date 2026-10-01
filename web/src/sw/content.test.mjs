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

test("every notification carries the monochrome badge of the status bar", () => {
  const plan = notificationOf({ v: 1, kind: "test", lang: "en" }, stringsFor, false);
  assert.equal(plan.options.badge, "/icons/badge-96.png");
  assert.ok(readFileSync(new URL("../../public/icons/badge-96.png", import.meta.url)).length > 0, "the file is there");
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

// --- slice: community events ---
const event = {
  v: 1,
  kind: "community.event",
  lang: "en",
  title: "Duel Cup",
  eventId: "01M3T9GBRRNNGKAZY47BXH205Q",
  eventKind: "created",
  community: "Duel Masters",
  startsAt: "2026-09-30T23:23:29Z",
  badge: 0,
  silent: false,
};

test("a new event names its community and opens the event, one notification per event", () => {
  const plan = notificationOf(event, stringsFor, false);
  assert.equal(plan.title, EN.eventCreated.replace("{{community}}", "Duel Masters"));
  assert.equal(plan.options.body, "Duel Cup");
  assert.equal(plan.options.tag, "e:01M3T9GBRRNNGKAZY47BXH205Q");
  assert.deepEqual(plan.options.data, { url: "/events/01M3T9GBRRNNGKAZY47BXH205Q" });
  assert.equal(plan.options.renotify, false);
  assert.deepEqual(targetOf(payloadOf(event)), { tag: "e:01M3T9GBRRNNGKAZY47BXH205Q", url: "/events/01M3T9GBRRNNGKAZY47BXH205Q" });
});

test("a change, a cancellation and a reminder are titled by the event, and the reminder alerts again", () => {
  for (const [eventKind, body] of [
    ["changed", EN.eventChanged],
    ["cancelled", EN.eventCancelled],
    ["reminder", EN.eventReminder],
  ]) {
    const plan = notificationOf({ ...event, eventKind }, stringsFor, false);
    assert.equal(plan.title, "Duel Cup", eventKind);
    assert.equal(plan.options.body, body, eventKind);
    assert.equal(plan.options.tag, "e:01M3T9GBRRNNGKAZY47BXH205Q", eventKind);
    assert.equal(plan.options.renotify, eventKind === "reminder", eventKind);
  }
  const ru = notificationOf({ ...event, eventKind: "reminder", lang: "ru" }, stringsFor, false);
  assert.equal(ru.options.body, RU.eventReminder);
  assert.notEqual(RU.eventReminder, EN.eventReminder);
});

test("an event without its title says only that something happened, and still opens the event", () => {
  const { title: _, community: __, ...bare } = event;
  const plan = notificationOf(bare, stringsFor, false);
  assert.equal(plan.title, "JKNet");
  assert.equal(plan.options.body, EN.activity);
  assert.deepEqual(plan.options.data, { url: "/events/01M3T9GBRRNNGKAZY47BXH205Q" });
  const { eventId: ___, ...nothing } = bare;
  assert.deepEqual(notificationOf(nothing, stringsFor, false).options.data, { url: "/events" });
});

// --- slice: community news ---
/** The payload of the service's test `news_reaches_the_devices_that_want_it`. */
const post = {
  badge: 0,
  community: "Duel Masters",
  communityId: "01M3TEKN2NNV2Y3V5H8J2Y0MW5",
  kind: "community.post",
  lang: "en",
  postId: "01M3TEKN349007DM8KQAKEW9Q6",
  silent: false,
  text: "The ladder opens on Friday.",
  title: "Season two",
  v: 1,
};

test("a post names its community, its title and its text, and opens the news, one notification per community", () => {
  const plan = notificationOf(post, stringsFor, false);
  assert.equal(plan.title, EN.newsPosted.replace("{{community}}", "Duel Masters"));
  assert.equal(plan.options.body, "Season two · The ladder opens on Friday.");
  assert.equal(plan.options.tag, "n:01M3TEKN2NNV2Y3V5H8J2Y0MW5");
  assert.deepEqual(plan.options.data, { url: "/community/01M3TEKN2NNV2Y3V5H8J2Y0MW5?tab=news" });
  assert.equal(plan.options.renotify, false);
  const ru = notificationOf({ ...post, lang: "ru" }, stringsFor, false);
  assert.equal(ru.title, RU.newsPosted.replace("{{community}}", "Duel Masters"));
});

test("a post without a title, or without its text under the sender preview, says what is left", () => {
  const { title: _, ...untitled } = post;
  assert.equal(notificationOf(untitled, stringsFor, false).options.body, "The ladder opens on Friday.");
  const { text: __, ...sender } = post;
  assert.equal(notificationOf(sender, stringsFor, false).options.body, "Season two");
  const { text: ___, title: ____, ...bare } = post;
  assert.equal(notificationOf(bare, stringsFor, false).options.body, EN.newsPlain);
});

test("a post under the none preview says only that something happened, and still opens the news", () => {
  const plan = notificationOf({ badge: 0, communityId: post.communityId, kind: "community.post", lang: "en", postId: post.postId, silent: false, v: 1 }, stringsFor, false);
  assert.equal(plan.title, "JKNet");
  assert.equal(plan.options.body, EN.activity);
  assert.deepEqual(plan.options.data, { url: "/community/01M3TEKN2NNV2Y3V5H8J2Y0MW5?tab=news" });
  assert.deepEqual(targetOf(payloadOf({ kind: "community.post" })), { tag: "news", url: "/community?tab=following" });
});
