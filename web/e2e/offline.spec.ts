import type { BrowserContext, Page } from "@playwright/test";

import { chatText, makeFriends, messageRow, messages, openDirect, send } from "./chat-fixtures.ts";
import { expect, SERVICE, signIn, test, uniqueName, visit } from "./fixtures.ts";

/** What a browser logs for calls the app expected to fail and handled: offline, cut off. */
const OFFLINE_NOISE = [
  /net::ERR_(FAILED|INTERNET_DISCONNECTED|CONNECTION_RESET|CONNECTION_REFUSED)/,
  /NetworkError/,
  /Failed to fetch/,
  /Load failed/,
  /WebSocket connection to .* failed/,
  /Could not connect to the server/,
  /The network connection was lost/,
  // Firefox: a call cut off before any answer, and a socket closed mid-handshake.
  /CORS request did not succeed/,
  /can’t establish a connection to the server at ws:/,
  /was interrupted while the page was loading/,
];

// The service worker stays on in Chromium, whose offline reload it serves.
// Firefox and WebKit go without it: WebKit does not show the test the calls
// of a page a worker controls, so their failures could not be staged.
test.use({
  serviceWorkers: async ({ browserName }, use) => use(browserName === "chromium" ? "allow" : "block"),
});

/** The texts of the messages of the thread on screen, in the order shown. */
async function texts(page: Page, candidates: string[]): Promise<string[]> {
  const rows = await messages(page).locator("[data-seq]").allInnerTexts();
  return rows.flatMap((row) => candidates.filter((text) => row.includes(text)));
}

/**
 * Cuts a page off the service. Chromium goes properly offline and opens the
 * app's shell from the service worker on reload; Firefox and WebKit take an
 * emulated offline page off the network before its worker sees the
 * navigation, so there the service's calls fail instead and the shell still
 * loads: the same for the queue, which only meets failed calls.
 */
async function cutOff(context: BrowserContext, browserName: string): Promise<() => Promise<void>> {
  if (browserName === "chromium") {
    await context.setOffline(true);
    return () => context.setOffline(false);
  }
  const pattern = `${SERVICE}/**`;
  await context.route(pattern, (route) => route.abort("internetdisconnected"));
  return () => context.unroute(pattern);
}

test("messages written offline survive a reload and arrive once, in order", async ({ page, context, players, guard, browserName }) => {
  test.setTimeout(120_000);
  guard.allowed.push(...OFFLINE_NOISE);
  const kyle = uniqueName("Kyle");
  const jan = uniqueName("Jan");
  await signIn(page, kyle);
  const other = await players.open();
  await signIn(other, jan);
  await makeFriends(page, kyle, other, jan);
  const id = await openDirect(page, jan);
  await visit(other, `/c/${encodeURIComponent(id)}`);
  if (browserName === "chromium") {
    // The reload below comes from the worker's cache.
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  }

  const reconnect = await cutOff(context, browserName);
  const written = ["offline one", "offline two", "offline three"];
  for (const text of written) await send(page, text);
  await expect(page.getByRole("main").getByText(chatText("outbox.sending"))).toHaveCount(3);

  // The queue is in IndexedDB: a reload finds it.
  await page.reload();
  await page.waitForFunction(
    () => ((window as unknown as { __jknetChat?: { view(): { outbox: unknown[] } } }).__jknetChat?.view().outbox.length ?? 0) === 3,
  );
  await expect(messageRow(other, "offline one")).toHaveCount(0);

  await reconnect();
  await expect(messageRow(other, "offline three")).toBeVisible({ timeout: 45_000 });
  for (const text of written) await expect(messageRow(other, text)).toHaveCount(1);
  expect(await texts(other, written)).toEqual(written);
  await page.waitForFunction(
    () => ((window as unknown as { __jknetChat?: { view(): { outbox: unknown[] } } }).__jknetChat?.view().outbox.length ?? -1) === 0,
  );
  for (const text of written) await expect(messageRow(page, text)).toHaveCount(1);
});

test("a message that arrives while its thread's first page is on its way still shows", async ({ page, players }) => {
  const kyle = uniqueName("Kyle");
  const jan = uniqueName("Jan");
  await signIn(page, jan);
  const other = await players.open();
  await signIn(other, kyle);
  await makeFriends(other, kyle, page, jan);
  const id = await openDirect(other, jan);
  await send(other, "before the load");

  // Jan's first read of the thread is taken from the service at once and
  // handed to the page only after the next message came by the socket:
  // the page then holds a first page older than that message. (Jan is the
  // test's own page: WebKit shows `route` no call of a page a worker
  // controls, and this file keeps the worker off there.)
  let taken = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${SERVICE}/v1/chat/conversations/*/messages*`, async (route) => {
    if (route.request().method() !== "GET" || taken) return route.fallback();
    taken = true;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await visit(page, `/c/${encodeURIComponent(id)}`);
  await expect.poll(() => taken, { message: "the thread asks for its first page" }).toBe(true);

  await send(other, "during the load");
  await page.waitForFunction(
    (conversationId) =>
      (
        window as unknown as { __jknetChat?: { view(): { conversations: Array<{ id: string; lastMessage: { body: string } | null }> } } }
      ).__jknetChat
        ?.view()
        .conversations.find((conversation) => conversation.id === conversationId)?.lastMessage?.body === "during the load",
    id,
  );
  release();

  await expect(messageRow(page, "during the load")).toHaveCount(1);
  await expect(messageRow(page, "before the load")).toHaveCount(1);
});

test("a message whose answer was lost when the service went away is stored once", async ({ page, players, guard }) => {
  guard.allowed.push(...OFFLINE_NOISE);
  const mara = uniqueName("Mara");
  const bast = uniqueName("Bast");
  await signIn(page, mara);
  const other = await players.open();
  await signIn(other, bast);
  await makeFriends(page, mara, other, bast);
  const id = await openDirect(page, bast);
  await visit(other, `/c/${encodeURIComponent(id)}`);

  // The service stores the first send, then the connection drops before its
  // answer comes back — what a restart in the middle of a send does. The
  // entry settles by the message's own frame on the socket, or by a second
  // send with the same client id, which the service answers with the stored
  // message; either way there is one message.
  const route = `${SERVICE}/v1/chat/conversations/*/messages`;
  let posts = 0;
  await page.route(route, async (intercepted) => {
    if (intercepted.request().method() !== "POST") return intercepted.fallback();
    posts += 1;
    if (posts > 1) return intercepted.fallback();
    await intercepted.fetch();
    await intercepted.abort("connectionreset");
  });

  await send(page, "only once");
  await expect(messageRow(other, "only once")).toBeVisible();
  expect(posts).toBeGreaterThanOrEqual(1);
  await page.waitForFunction(
    () => ((window as unknown as { __jknetChat?: { view(): { outbox: unknown[] } } }).__jknetChat?.view().outbox.length ?? -1) === 0,
  );
  await page.unroute(route);
  await expect(messageRow(page, "only once")).toHaveCount(1);
  await expect(messageRow(other, "only once")).toHaveCount(1);

  // Seen from a fresh load of the thread too: one message, no failed copy.
  await visit(other, `/c/${encodeURIComponent(id)}`);
  await expect(messageRow(other, "only once")).toHaveCount(1);
  await expect(page.getByText(chatText("outbox.failed"))).toHaveCount(0);
});
