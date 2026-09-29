/**
 * Helpers of the catalog specs: two friends in their own browsers, the
 * layout on screen, **Share to chat** with a friend, the cards a launcher
 * reads back, and the check that no control of the game is on screen.
 */

import type { Page } from "@playwright/test";

import { chatText, makeFriends } from "./chat-fixtures.ts";
import { expect, SERVICE, signIn, uniqueName, type LauncherClient } from "./fixtures.ts";

/** Two signed-in friends: the player in the test's page, the friend in a browser of their own. */
export async function friends(page: Page, players: { open(): Promise<Page> }): Promise<{ kyle: string; jan: string; other: Page }> {
  const kyle = uniqueName("Kyle");
  const jan = uniqueName("Jan");
  await signIn(page, kyle);
  const other = await players.open();
  await signIn(other, jan);
  await makeFriends(page, kyle, other, jan);
  return { kyle, jan, other };
}

/** Whether the page shows the wide layout (W1) rather than the phone's (P3). */
export async function wideLayout(page: Page): Promise<boolean> {
  return (await page.locator("[data-layout]").first().getAttribute("data-layout")) === "wide";
}

/** Shares what is on screen with a friend through the share dialog. */
export async function shareWith(page: Page, friend: string): Promise<void> {
  await page.getByRole("button", { name: chatText("share.action"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: chatText("share.title") });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("option").filter({ hasText: friend }).getByRole("button").click();
  await dialog.getByRole("button", { name: chatText("share.send"), exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(chatText("share.sent", { name: friend }))).toBeVisible();
}

/** The cards of the newest messages of a conversation, as a launcher reads them. */
export async function launcherCards(launcher: LauncherClient, conversationId: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${SERVICE}/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    headers: { authorization: `Bearer ${launcher.token}` },
  });
  expect(response.status).toBe(200);
  const page = (await response.json()) as { messages: Array<{ cards?: Array<Record<string, unknown>> }> };
  return page.messages.flatMap((message) => message.cards ?? []);
}

/** No control of the game anywhere on screen: no join, no play, no connect, no install. */
export async function expectNoGameControls(page: Page): Promise<void> {
  const game = /^(Join|Play|Connect|Install)\b/i;
  await expect(page.getByRole("button", { name: game })).toHaveCount(0);
  await expect(page.getByRole("link", { name: game })).toHaveCount(0);
}
