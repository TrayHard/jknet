import type { Page } from "@playwright/test";

import {
  chatText,
  composer,
  conversationIdOf,
  makeFriends,
  messageRow,
  openDirect,
  send,
} from "./chat-fixtures.ts";
import { BASE, expect, hideTab, signIn, test, uniqueName, visit } from "./fixtures.ts";

/** `TYPING_THROTTLE_MS` of the core, and a little more: one typing hint per chat every 3 s. */
const TYPING_THROTTLE_MS = 3_100;

/** Opens a conversation by its address and waits for its composer. */
async function openThread(page: Page, conversationId: string): Promise<void> {
  await visit(page, `/c/${encodeURIComponent(conversationId)}`);
  await expect(composer(page)).toBeVisible();
}

/** Opens the info of the group on screen with the title of the thread's header. */
async function openInfo(page: Page): Promise<void> {
  await page.getByTitle(chatText("info.open"), { exact: true }).click();
  await expect(page).toHaveURL(/\/info$/);
}

/** Picks a choice of a settings card, by its label. */
async function choose(page: Page, label: string): Promise<void> {
  await page.getByText(label, { exact: true }).click();
  await expect(page.getByRole("radio", { name: label })).toBeChecked();
}

test("two friends write, reply, react and see each other type and read", async ({ page, players }) => {
  const kyle = uniqueName("Kyle");
  const jan = uniqueName("Jan");
  await signIn(page, kyle);
  const other = await players.open();
  await signIn(other, jan);
  await makeFriends(page, kyle, other, jan);

  const id = await openDirect(page, jan);
  await expect(page).toHaveURL(`${BASE}/c/${encodeURIComponent(id)}`);
  await send(page, "Hello there");
  await expect(messageRow(page, "Hello there")).toBeVisible();

  // Jan finds the chat in the list with the unread message, and opens it.
  await visit(other, "/chats");
  const row = other.getByRole("button", { name: new RegExp(kyle) }).first();
  await expect(row).toContainText("Hello there");
  await row.click();
  await expect(other).toHaveURL(`${BASE}/c/${encodeURIComponent(id)}`);
  await expect(messageRow(other, "Hello there")).toBeVisible();

  // Kyle sees it read.
  await expect(messageRow(page, "Hello there")).toContainText(chatText("delivery.read"));

  // Typing, both ways. Kyle's last hint went with his message.
  await composer(other).pressSequentially("typing a reply", { delay: 20 });
  await expect(page.getByRole("main").getByText(chatText("typing.one", { name: jan }))).toBeVisible();
  await page.waitForTimeout(TYPING_THROTTLE_MS);
  await composer(page).pressSequentially("me too", { delay: 20 });
  await expect(other.getByRole("main").getByText(chatText("typing.one", { name: kyle }))).toBeVisible();
  await composer(page).fill("");

  // Jan replies to the message.
  await composer(other).fill("");
  await messageRow(other, "Hello there").getByRole("button", { name: chatText("message.reply") }).click();
  await expect(other.getByText(chatText("composer.replyingTo", { name: kyle }))).toBeVisible();
  await send(other, "General Kenobi");
  const reply = messageRow(page, "General Kenobi");
  await expect(reply).toBeVisible();
  await expect(reply).toContainText("Hello there");

  // Kyle reacts to the reply; Jan sees the reaction.
  await reply.getByRole("button", { name: chatText("message.react") }).click();
  await page.getByRole("menu", { name: chatText("reactions.pick") }).getByRole("menuitem").first().click();
  await expect(messageRow(other, "General Kenobi").locator("button[aria-pressed]")).toHaveAttribute("title", new RegExp(kyle));

  // The conversation id is the one both screens show.
  expect(conversationIdOf(other)).toBe(id);
});

test("a group is made, renamed, joined by invitation, loses a member and a leaver", async ({ page, players }) => {
  // Three players and some fifty steps. WebKit takes most of a second to
  // report each click done, so alone the test runs about 40 s there, and a
  // full run of all five browsers slows it past the default minute.
  test.setTimeout(120_000);
  const mara = uniqueName("Mara");
  const bast = uniqueName("Bast");
  const cade = uniqueName("Cade");
  await signIn(page, mara);
  const b = await players.open();
  await signIn(b, bast);
  const c = await players.open();
  await signIn(c, cade);
  await makeFriends(page, mara, b, bast);
  await makeFriends(page, mara, c, cade);

  // Cade asks before being added to groups.
  await visit(c, "/settings/privacy");
  await choose(c, chatText("settings.privacy.groupAddAsk"));

  // Mara makes a group with Bast.
  await visit(page, "/chats");
  await page.getByRole("button", { name: chatText("group.new"), exact: true }).click();
  const create = page.getByRole("dialog", { name: chatText("group.new") });
  await create.getByLabel(chatText("group.name"), { exact: true }).fill("Clan night");
  await create.getByRole("checkbox", { name: new RegExp(bast) }).check();
  await create.getByRole("button", { name: chatText("group.create"), exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/c/"));
  const id = conversationIdOf(page);

  // Bast has it, and a mention of him reaches him with his name.
  await openThread(b, id);
  await expect(b.getByRole("main")).toContainText("Clan night");
  await composer(page).pressSequentially(`@${bast.slice(0, 4)}`);
  await page.getByRole("listbox", { name: chatText("composer.mentionList") }).getByRole("option").first().click();
  await composer(page).pressSequentially("ready?");
  await page.getByRole("button", { name: chatText("composer.send"), exact: true }).click();
  await expect(messageRow(b, "ready?")).toContainText(`@${bast}`);

  // Mara renames it from its info; Bast's header follows.
  await openInfo(page);
  await page.getByRole("button", { name: chatText("info.rename"), exact: true }).click();
  await page.getByRole("textbox", { name: chatText("info.renameLabel") }).fill("Clan nights");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(b.getByRole("main")).toContainText("Clan nights");

  // Mara adds Cade, who asked to be asked: an invitation, which he accepts.
  await page.getByRole("button", { name: chatText("info.add"), exact: true }).click();
  const add = page.getByRole("dialog", { name: chatText("group.addTitle", { title: "Clan nights" }) });
  await add.getByRole("checkbox", { name: new RegExp(cade) }).check();
  await add.getByRole("button", { name: /^Add 1 friend$/ }).click();
  await visit(c, "/chats");
  await c.getByRole("region", { name: chatText("invites.title") }).getByRole("button", { name: chatText("invites.join"), exact: true }).click();
  await c.waitForURL((url) => url.pathname === `/c/${id}`);
  await expect(c.getByRole("main")).toContainText("Clan nights");
  await expect(page.getByRole("button", { name: chatText("info.memberMenu", { name: cade }) })).toBeVisible();

  // Mara removes Cade: his chat goes.
  await page.getByRole("button", { name: chatText("info.memberMenu", { name: cade }) }).click();
  await page.getByRole("menuitem", { name: chatText("info.remove") }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await visit(c, "/chats");
  await expect(c.getByRole("button", { name: /Clan nights/ })).toHaveCount(0);

  // Bast leaves: the group leaves his list, and Mara sees one member fewer.
  await openThread(b, id);
  await openInfo(b);
  await b.getByRole("button", { name: chatText("info.leave"), exact: true }).click();
  await b.getByRole("button", { name: chatText("info.confirmLeave"), exact: true }).click();
  await b.waitForURL((url) => url.pathname === "/chats");
  await expect(b.getByRole("button", { name: /Clan nights/ })).toHaveCount(0);
  await expect(page.getByText(chatText("info.members", { used: 1, max: 20 }))).toBeVisible();
});

test("the chat sound is this browser's own switch, and a test browser never plays it", async ({ page, players }) => {
  // Counts every attempt to play media: under automation the app makes none.
  await page.addInitScript(() => {
    const counter = window as unknown as { __plays: number };
    counter.__plays = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      counter.__plays += 1;
      return play.call(this);
    };
  });
  const plays = () => page.evaluate(() => (window as unknown as { __plays: number }).__plays);
  const ben = uniqueName("Ben");
  const luke = uniqueName("Luke");
  await signIn(page, ben);
  expect(await page.evaluate(() => navigator.webdriver)).toBe(true);

  await visit(page, "/settings/notifications");
  const sound = page.getByRole("switch", { name: chatText("settings.sounds.sound") });
  const set = page.getByRole("combobox", { name: chatText("settings.sounds.pick") });
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await expect(set).toContainText(chatText("settings.sounds.names.default"));

  // Off, and still off after a reload: the choice is kept in this browser.
  await sound.click();
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await expect(set).toBeDisabled();
  await visit(page, "/settings/notifications");
  await expect(sound).toHaveAttribute("aria-checked", "false");

  // On again, with another set, and both previews.
  await sound.click();
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await set.click();
  await page.getByRole("option", { name: chatText("settings.sounds.names.comlink") }).click();
  await expect(set).toContainText(chatText("settings.sounds.names.comlink"));
  await page.getByRole("button", { name: chatText("settings.sounds.previewMessageLabel", { name: chatText("settings.sounds.names.comlink") }) }).click();
  await page.getByRole("button", { name: chatText("settings.sounds.previewMentionLabel", { name: chatText("settings.sounds.names.comlink") }) }).click();
  await visit(page, "/settings/notifications");
  await expect(set).toContainText(chatText("settings.sounds.names.comlink"));

  // A message that would chime, in a tab in the background: still silent here.
  const other = await players.open();
  await signIn(other, luke);
  await makeFriends(page, ben, other, luke);
  await visit(page, "/chats");
  await hideTab(page);
  await openDirect(other, ben);
  await send(other, "can you hear me?");
  await expect(page.getByRole("button", { name: new RegExp(luke) }).first()).toContainText("can you hear me?");
  expect(await plays()).toBe(0);
});

test("search finds a message, and both privacy switches work both ways", async ({ page, players }) => {
  const rey = uniqueName("Rey");
  const finn = uniqueName("Finn");
  await signIn(page, rey);
  const other = await players.open();
  await signIn(other, finn);
  await makeFriends(page, rey, other, finn);
  const id = await openDirect(page, finn);
  await send(page, "the needle is in the haystack");
  await send(page, "unrelated chatter");

  // Finn searches every chat and opens the hit.
  await visit(other, "/chats");
  await other.getByRole("textbox", { name: chatText("list.search") }).fill("needle");
  await other.getByRole("button", { name: /the needle is in the haystack/ }).last().click();
  await expect(other).toHaveURL(new RegExp(`/c/${id}\\?at=\\d+$`));
  await expect(messageRow(other, "the needle is in the haystack")).toBeVisible();

  // Finn hides read receipts: Rey no longer sees Finn read, and Finn sees nobody's.
  await visit(other, "/settings/privacy");
  const receipts = other.getByRole("switch", { name: chatText("settings.privacy.readReceipts") });
  await receipts.click();
  await expect(receipts).toHaveAttribute("aria-checked", "false");
  await openThread(other, id);
  await send(page, "can you see this read?");
  await expect(messageRow(other, "can you see this read?")).toBeVisible();
  await expect(messageRow(page, "can you see this read?")).toContainText(chatText("delivery.sent"));
  await page.waitForTimeout(2_000);
  await expect(messageRow(page, "can you see this read?")).not.toContainText(chatText("delivery.read"));
  await send(other, "and mine?");
  await expect(messageRow(other, "and mine?")).toBeVisible();
  await expect(messageRow(other, "and mine?")).not.toContainText(chatText("delivery.sent"));

  // Finn hides typing: neither sees the other type.
  await visit(other, "/settings/privacy");
  const typing = other.getByRole("switch", { name: chatText("settings.privacy.typing") });
  await typing.click();
  await expect(typing).toHaveAttribute("aria-checked", "false");
  await openThread(other, id);
  await page.waitForTimeout(TYPING_THROTTLE_MS);
  await composer(page).pressSequentially("typing into the void", { delay: 20 });
  await composer(other).pressSequentially("me neither", { delay: 20 });
  await page.waitForTimeout(1_500);
  await expect(other.getByText(chatText("typing.one", { name: rey }))).toHaveCount(0);
  await expect(page.getByText(chatText("typing.one", { name: finn }))).toHaveCount(0);
});
