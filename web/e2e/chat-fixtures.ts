/**
 * Helpers of the chat specs: friendships, the direct chat of two friends,
 * the composer and the thread, by the names the shared components give them.
 */

import type { Page } from "@playwright/test";

import { acceptFriend, BASE, expect, requestFriend, sharedCatalog, visit } from "./fixtures.ts";

export const CHAT = sharedCatalog("en", "chat") as Record<string, Record<string, unknown>>;

/** A string of the `chat` namespace, `section.key`, with `{{name}}` filled in. */
export function chatText(path: string, values: Record<string, string | number> = {}): string {
  const [section, ...rest] = path.split(".");
  let node: unknown = CHAT[section];
  for (const part of rest) node = (node as Record<string, unknown>)[part];
  let text = String(node);
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, String(value));
  return text;
}

/** Makes two signed-in players friends: `a` asks, `b` accepts. */
export async function makeFriends(a: Page, aName: string, b: Page, bName: string): Promise<void> {
  await requestFriend(a, bName);
  await acceptFriend(b, aName);
}

/** The id of the conversation on screen, from the address. */
export function conversationIdOf(page: Page): string {
  const match = /\/c\/([^/?#]+)/.exec(new URL(page.url()).pathname);
  if (match === null) throw new Error(`not on a thread: ${page.url()}`);
  return decodeURIComponent(match[1]);
}

/** Opens the direct chat with a friend from the friend's page, **Message**. */
export async function openDirect(page: Page, friendName: string): Promise<string> {
  await visit(page, "/friends");
  await page.getByRole("row").filter({ hasText: friendName }).click();
  await expect(page).toHaveURL(/\/friends\/[^/]+$/);
  await page.getByTestId("friend-details").getByRole("button", { name: "Message", exact: true }).click();
  await page.waitForURL((url) => url.origin === BASE && url.pathname.startsWith("/c/"));
  return conversationIdOf(page);
}

/** Opens a conversation from the chat list by its title. */
export async function openFromList(page: Page, title: string): Promise<void> {
  await visit(page, "/chats");
  await page.getByRole("button", { name: new RegExp(escape(title)) }).first().click();
  await page.waitForURL((url) => url.pathname.startsWith("/c/"));
}

export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The composer of the thread on screen. */
export function composer(page: Page) {
  return page.getByRole("textbox", { name: /^Message / });
}

/** The messages of the thread on screen. */
export function messages(page: Page) {
  return page.getByRole("log");
}

/** The part of the chat core's state that `window.__jknetChat` of `main.tsx` shows the e2e build. */
interface ChatProbe {
  outbox: Array<{ conversationId: string; body: string }>;
  conversations: Array<{ id: string; lastMessage: { seq: number; body: string } | null }>;
}

/** Where a text stands in the core: queued in the outbox, and the conversation's last message. */
async function probe(page: Page, conversationId: string, text: string): Promise<{ queued: boolean; lastSeq: number; lastBody: string | null }> {
  return page.evaluate(
    ({ conversationId, text }) => {
      const view = (window as unknown as { __jknetChat?: { view(): ChatProbe } }).__jknetChat?.view();
      const last = view?.conversations.find((conversation) => conversation.id === conversationId)?.lastMessage ?? null;
      return {
        queued: view?.outbox.some((entry) => entry.conversationId === conversationId && entry.body === text) ?? false,
        lastSeq: last?.seq ?? 0,
        lastBody: last?.body ?? null,
      };
    },
    { conversationId, text },
  );
}

/**
 * Types and sends a message with the **Send** button. A composer that has
 * just opened puts the stored draft into its field once the core answers,
 * which on a slow browser can come after the text was typed and after
 * **Send** lit up: the text is typed again until a press goes through.
 *
 * A press can also reach the button and still fail in Playwright: WebKit
 * takes most of a second to report a click done. So an attempt first asks
 * whether the text already left: queued in the outbox, the conversation's
 * newest message, or a row more in the thread than before. Only a text that
 * did not leave is pressed again, so nothing is sent twice.
 */
export async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  const button = page.getByRole("button", { name: chatText("composer.send"), exact: true });
  const conversationId = conversationIdOf(page);
  const rows = messageRow(page, text);
  const rowsBefore = await rows.count();
  const { lastSeq: seqBefore } = await probe(page, conversationId, text);
  const wentOut = async (): Promise<boolean> => {
    const now = await probe(page, conversationId, text);
    if (now.queued || (now.lastSeq > seqBefore && now.lastBody === text)) return true;
    return (await rows.count()) > rowsBefore;
  };
  await expect(async () => {
    if (await wentOut()) return;
    if ((await box.inputValue()) !== text) await box.fill(text);
    await expect(button).toBeEnabled({ timeout: 2_000 });
    try {
      await button.click({ timeout: 10_000 });
    } catch (error) {
      if (await wentOut()) return;
      throw error;
    }
  }).toPass({ timeout: 30_000 });
  await expect(box).toHaveValue("");
}

/** One message of the thread, by its text. */
export function messageRow(page: Page, text: string) {
  return messages(page).locator("[data-seq]").filter({ hasText: text });
}
