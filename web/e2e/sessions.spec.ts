/**
 * Devices and sessions (spec 1.8, 3.12): one account signed in in two
 * browsers — the project's own device and one of the other kind — and in a
 * launcher, a token of client `launcher` with a live socket, the way JKNet
 * on a PC keeps one. The list names all three with their icons and tags;
 * **Sign out** ends the other browser's session, which closes its socket
 * and sends it to the sign-in with the reason; **Sign out of all other
 * devices** leaves only this one, and the launcher's next request is
 * refused.
 */

import type { Page } from "@playwright/test";

import {
  expect,
  launcherSignIn,
  SERVICE,
  sharedCatalog,
  signIn,
  test,
  uniqueName,
  visit,
  type LauncherClient,
} from "./fixtures.ts";
import { deviceKeys, webText } from "./push-fixtures.ts";

const DEVICES = sharedCatalog("en", "account").devices as Record<string, string>;

/** The token of the signed-in player of a page, read from the web app's database. */
async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open("jknet-web", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const read = open.result.transaction("session", "readonly").objectStore("session").get("current");
          read.onsuccess = () => {
            open.result.close();
            resolve((read.result as { token?: string } | undefined)?.token ?? "");
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
}

/** A launcher's live socket, as JKNet on a PC keeps one, and the code it closes with. */
async function launcherSocket(launcher: LauncherClient): Promise<{ closed: Promise<number>; close(): void }> {
  const socket = new WebSocket(`${SERVICE.replace(/^http/, "ws")}/v1/ws?token=${encodeURIComponent(launcher.token)}`);
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  // The service's pings want an answer, as a launcher gives one.
  socket.addEventListener("message", (event) => {
    try {
      if ((JSON.parse(String(event.data)) as { type?: string }).type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    } catch {
      // Not a frame this test reads.
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the launcher's socket did not open")), { once: true });
  });
  return { closed, close: () => socket.close() };
}

/**
 * A push subscription of a browser's session, saved the way the web app
 * saves one. The endpoint is a loopback address nothing listens on: this
 * test sends no push, it only needs the session's "Push on".
 */
async function subscribePush(token: string): Promise<void> {
  const keys = deviceKeys();
  const response = await fetch(`${SERVICE}/v1/push/subscriptions`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      endpoint: `http://127.0.0.1:9/push/${Math.random().toString(36).slice(2)}`,
      keys: { p256dh: keys.p256dh, auth: keys.authText },
      deviceName: "E2E",
      locale: "en",
    }),
  });
  expect(response.status, await response.text()).toBe(201);
}

test("three devices of one account: one signed out, then every other one", async ({ page, players, isMobile }) => {
  const name = uniqueName("Rey");
  const mine = isMobile ? "phone" : "desktop";
  const theirs = isMobile ? "desktop" : "phone";

  await signIn(page, name);
  const other = await players.open({ device: theirs });
  await signIn(other, name);
  await subscribePush(await tokenOf(other));
  const launcher = await launcherSignIn(name);
  const socket = await launcherSocket(launcher);

  await visit(page, "/settings/sessions");
  const card = page.locator("#settings-devices");
  const rows = card.getByRole("listitem");
  await expect(rows).toHaveCount(3);

  // This device first: its own icon, "This device", and no button of its own.
  const own = rows.first();
  await expect(own).toContainText(DEVICES.thisDevice);
  await expect(own).toContainText(DEVICES.online);
  await expect(own.locator("[data-icon]")).toHaveAttribute("data-icon", mine);
  await expect(own.getByRole("button")).toHaveCount(0);

  // The launcher: a monitor, online by its socket.
  const pc = rows.filter({ hasText: "E2E-LAUNCHER" });
  await expect(pc.locator("[data-icon]")).toHaveAttribute("data-icon", "launcher");
  await expect(pc).toContainText(DEVICES.online);
  await expect(pc).not.toContainText(DEVICES.pushOn);

  // The other browser: its kind, online, and receiving push.
  const browser = rows.filter({ hasNotText: DEVICES.thisDevice }).filter({ hasNotText: "E2E-LAUNCHER" });
  await expect(browser).toHaveCount(1);
  await expect(browser.locator("[data-icon]")).toHaveAttribute("data-icon", theirs);
  await expect(browser).toContainText(DEVICES.online);
  await expect(browser).toContainText(DEVICES.pushOn);
  await expect(browser).toContainText(/JKNet web · /);

  // **Sign out** of the other browser, confirmed: its socket closes and it
  // lands on the sign-in, which says why.
  await browser.getByRole("button", { name: DEVICES.signOut, exact: true }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: DEVICES.signOut, exact: true }).click();
  await expect(rows).toHaveCount(2);
  await other.waitForURL((url) => url.pathname === "/signin", { timeout: 20_000 });
  await expect(other.getByTestId("signed-out-elsewhere")).toHaveText(webText("sessions.signedOut"));

  // **Sign out of all other devices**: only this one is left.
  await card.getByRole("button", { name: DEVICES.signOutOthers, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: DEVICES.signOutOthers, exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(DEVICES.thisDevice);
  await expect(card.getByRole("button", { name: DEVICES.signOutOthers, exact: true })).toBeDisabled();

  // The launcher: its socket closed as signed out, and its next request is refused.
  expect(await socket.closed).toBe(4401);
  const me = await fetch(`${SERVICE}/v1/me`, { headers: { authorization: `Bearer ${launcher.token}` } });
  expect(me.status).toBe(401);

  // This browser stays signed in.
  await expect(page).toHaveURL(/\/settings\/sessions$/);
});
