import type { Page, TestInfo } from "@playwright/test";

import { chatText, conversationIdOf, makeFriends, openDirect, send } from "./chat-fixtures.ts";
import { BASE, expect, hideTab, reload, signIn, test, uniqueName, visit } from "./fixtures.ts";
import {
  clickTarget,
  clickWithWindow,
  deviceKeys,
  devicesOf,
  enablePush,
  open,
  preparePush,
  pushApi,
  pushLine,
  shownAfter,
  startPushService,
  tokenOf,
  webText,
  type FakePushService,
} from "./push-fixtures.ts";

/**
 * Push notifications of the web app, Chromium only (Edge wide, Pixel 7 as a
 * phone): the page subscribes through a fake `PushManager` to a push service
 * on loopback, JKNet Online encrypts and sends there, the test opens what it
 * got and hands it to the app's service worker with CDP
 * `ServiceWorker.deliverPushMessage`. The e2e worker records notifications
 * rather than showing them: nothing reaches the desktop, nothing sounds.
 * The iPhone profile checks the Home Screen steps that stand in for push in
 * a Safari tab.
 */

function chromiumOnly(browserName: string) {
  test.skip(browserName !== "chromium", "push through CDP runs in Chromium only");
}

let pushService: FakePushService;

/** A device name nobody else in this run has. */
function deviceId(testInfo: TestInfo, label: string): string {
  return `${testInfo.project.name}-${label}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Radio of a settings group, by its label. */
function radio(page: Page, label: string) {
  return page.getByRole("radio", { name: label, exact: true });
}

test.describe("Chromium", () => {
  test.beforeEach(async ({ browserName }) => {
    chromiumOnly(browserName);
    pushService = await startPushService();
  });
  test.afterEach(async () => {
    await pushService?.close();
  });

  test("a new device subscribes with the final defaults, and both choices stay per device", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const me = deviceId(testInfo, "a");
    await preparePush(page.context(), pushService, me);
    await signIn(page, uniqueName("Ahsoka"));
    await enablePush(page);

    // The user's final decisions: the name and start of the text, a minute's delay at the PC.
    await expect(radio(page, webText("notifications.preview.full"))).toBeChecked();
    await expect(radio(page, webText("notifications.whileActiveElsewhere.delay"))).toBeChecked();
    const token = await tokenOf(page);
    const [mine] = await devicesOf(token);
    expect(mine.current).toBe(true);
    expect(mine.deviceName ?? "").toMatch(/^JKNet web/);
    expect(mine.settings).toMatchObject({ preview: "full", whileActiveElsewhere: "delay", enabled: true });

    // A second device of the account, saved as its browser would.
    const second = deviceKeys();
    const other = await pushApi<{ id: string }>(token, "PUT", "/v1/push/subscriptions", {
      endpoint: pushService.endpoint(deviceId(testInfo, "b")),
      keys: { p256dh: second.p256dh, auth: second.authText },
      deviceName: "E2E second device",
      locale: "en",
    });
    expect(other.status, "the second device's subscription").toBe(201);
    await reload(page);
    const otherRow = page.getByTestId("push-device").filter({ hasText: "E2E second device" });
    await expect(otherRow).toBeVisible();

    // Both groups change for this device alone, and read back after a reload.
    await page.getByText(webText("notifications.preview.sender"), { exact: true }).click();
    await expect(radio(page, webText("notifications.preview.sender"))).toBeChecked();
    await page.getByText(webText("notifications.whileActiveElsewhere.never"), { exact: true }).click();
    await expect(radio(page, webText("notifications.whileActiveElsewhere.never"))).toBeChecked();
    await expect
      .poll(async () => (await devicesOf(token)).find((device) => device.id === mine.id)?.settings.whileActiveElsewhere)
      .toBe("never");
    await reload(page);
    await expect(radio(page, webText("notifications.preview.sender"))).toBeChecked();
    await expect(radio(page, webText("notifications.whileActiveElsewhere.never"))).toBeChecked();
    const devices = await devicesOf(token);
    expect(devices.find((device) => device.id === mine.id)?.settings).toMatchObject({ preview: "sender", whileActiveElsewhere: "never" });
    expect(devices.find((device) => device.id === other.data.id)?.settings).toMatchObject({ preview: "full", whileActiveElsewhere: "delay" });

    // **Remove** takes the other device off the account.
    await otherRow.getByRole("button", { name: webText("notifications.remove"), exact: true }).click();
    await expect(otherRow).toHaveCount(0);
    await expect(page.getByText(webText("notifications.noOtherDevices"))).toBeVisible();
    await expect(page.getByTestId("notifications-screen").getByRole("link", { name: webText("notifications.sessionsLink") })).toHaveAttribute(
      "href",
      "/settings/sessions",
    );
  });

  test("the test notification comes in the language of the app, silent while the app is open", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const me = deviceId(testInfo, "t");
    const keys = await preparePush(page.context(), pushService, me);
    await signIn(page, uniqueName("Luke"));
    await enablePush(page);
    const line = await pushLine(page);

    // The app switches to Russian; the device's notifications follow.
    await visit(page, "/settings");
    await page.getByRole("combobox", { name: "Language" }).click();
    await page.getByRole("option", { name: "Русский" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    const token = await tokenOf(page);
    await expect.poll(async () => (await devicesOf(token))[0]?.locale).toBe("ru");

    await visit(page, "/settings/notifications");
    await page.getByRole("button", { name: webText("notifications.test", "ru"), exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: webText("notifications.testSent", "ru") })).toBeVisible();

    const payload = open(await pushService.next(me), keys);
    expect(payload).toMatchObject({ v: 1, kind: "test", lang: "ru" });
    await line.deliver(payload);
    const shown = await shownAfter(page.context(), 1);
    expect(shown.title).toBe("JKNet");
    expect(shown.options.body).toBe(webText("push.test", "ru"));
    expect(shown.options.tag).toBe("test");
    expect(shown.options.silent, "the open app sounded already").toBe(true);

    // The service noted the delivery; the screen shows its date.
    await expect(page.getByText(new RegExp(webText("notifications.lastDelivery", "ru").replace("{{date}}", ".+")))).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a message's notification opens its thread, with the app open and with it closed", async ({ page, players, isMobile }, testInfo) => {
    test.setTimeout(150_000);
    const me = deviceId(testInfo, "m");
    const keys = await preparePush(page.context(), pushService, me);
    const bName = uniqueName("Rey");
    const aName = uniqueName("Finn");
    await signIn(page, bName);
    const a = await players.open();
    await signIn(a, aName);
    await makeFriends(a, aName, page, bName);
    const id = await openDirect(a, bName);
    await enablePush(page);
    const line = await pushLine(page);

    // The app is open in a tab in the background: the service sends, the
    // worker shows the notification silently, tagged by the conversation.
    await visit(page, "/chats");
    await hideTab(page);
    // The tab's `presence.web` goes out before the message does.
    await page.waitForTimeout(1_000);
    await send(a, "Push while hidden");
    const hiddenPayload = open(await pushService.next(me), keys);
    expect(hiddenPayload).toMatchObject({ kind: "chat.message", conversationId: id, conversationKind: "direct", sender: aName, text: "Push while hidden" });
    expect(hiddenPayload).not.toHaveProperty("title");
    await line.deliver(hiddenPayload);
    const first = await shownAfter(page.context(), 1);
    expect(first).toMatchObject({ title: aName, options: { body: "Push while hidden", tag: `c:${id}`, silent: true, data: { url: `/c/${id}` } } });

    // A click brings the window forward and opens the thread in it.
    expect((await clickTarget(page.context(), first.options.data.url)).action).toBe("focus");
    await clickWithWindow(page.context(), first.options.data.url);
    await expect(page).toHaveURL(`${BASE}/c/${encodeURIComponent(id)}`);
    await expectThread(page, isMobile, id, "Push while hidden");
    if (isMobile) {
      // Back from the thread leads to the chats, not out of the app.
      await page.getByRole("button", { name: chatText("thread.back"), exact: true }).first().click();
      await expect(page).toHaveURL(`${BASE}/chats`);
    }

    // No window of the app: the notification sounds, and a click opens one on the thread.
    await page.goto("about:blank");
    await page.waitForTimeout(1_000);
    await send(a, "Push while closed");
    const closedPayload = open(await pushService.next(me), keys);
    expect(closedPayload).toMatchObject({ kind: "chat.message", conversationId: id, text: "Push while closed" });
    await line.deliver(closedPayload);
    const second = await shownAfter(page.context(), 2);
    expect(second).toMatchObject({ title: aName, options: { body: "Push while closed", tag: `c:${id}`, silent: false } });
    const target = await clickTarget(page.context(), second.options.data.url);
    expect(target).toEqual({ action: "open", url: `/c/${id}` });
    // What `clients.openWindow` does: the app starts on the thread.
    await page.goto(`${BASE}${target.url}`);
    await expectThread(page, isMobile, id, "Push while closed");
    if (isMobile) {
      await page.getByRole("button", { name: chatText("thread.back"), exact: true }).first().click();
      await expect(page).toHaveURL(`${BASE}/chats`);
    }
    expect(conversationIdOf(a)).toBe(id);
  });

  test("the message text shrinks to the sender, then to nothing, as the device chose", async ({ page, players }, testInfo) => {
    test.setTimeout(150_000);
    const me = deviceId(testInfo, "p");
    const keys = await preparePush(page.context(), pushService, me);
    const bName = uniqueName("Mara");
    const aName = uniqueName("Kyle");
    await signIn(page, bName);
    const a = await players.open();
    await signIn(a, aName);
    await makeFriends(a, aName, page, bName);
    const id = await openDirect(a, bName);
    await enablePush(page);
    const line = await pushLine(page);
    await hideTab(page);

    await page.getByText(webText("notifications.preview.sender"), { exact: true }).click();
    await expect(radio(page, webText("notifications.preview.sender"))).toBeChecked();
    await page.waitForTimeout(500);
    await send(a, "Secret plan one");
    const sender = open(await pushService.next(me), keys);
    expect(sender).toMatchObject({ kind: "chat.message", conversationId: id, sender: aName });
    expect(sender).not.toHaveProperty("text");
    await line.deliver(sender);
    const first = await shownAfter(page.context(), 1);
    expect(first.title).toBe(aName);
    expect(first.options.body).toBe(webText("push.newMessage"));
    expect(first.options.body).not.toContain("Secret");

    await page.getByText(webText("notifications.preview.none"), { exact: true }).click();
    await expect(radio(page, webText("notifications.preview.none"))).toBeChecked();
    await page.waitForTimeout(500);
    await send(a, "Secret plan two");
    const none = open(await pushService.next(me), keys);
    expect(Object.keys(none).sort()).toEqual(["badge", "conversationId", "kind", "lang", "silent", "v"]);
    await line.deliver(none);
    const second = await shownAfter(page.context(), 2);
    expect(second.title).toBe("JKNet");
    expect(second.options.body).toBe(webText("push.activity"));
    expect(second.options.tag).toBe(`c:${id}`);
  });

});

/** The thread on screen: full screen on a phone, next to the chat list on a wide screen. */
async function expectThread(page: Page, isMobile: boolean, id: string, text: string): Promise<void> {
  await expect(page.getByRole("log").locator("[data-seq]").filter({ hasText: text })).toBeVisible();
  if (isMobile) {
    await expect(page.locator("[data-layout=phone]")).toBeVisible();
    await expect(page.locator("main[data-pane=detail]")).toBeVisible();
    await expect(page.locator("[data-pane=list]")).toHaveCount(0);
  } else {
    await expect(page.locator("[data-layout=wide]")).toBeVisible();
    await expect(page.locator("[data-pane=list]")).toBeVisible();
    await expect(page.locator("main[data-pane=detail]")).toBeVisible();
  }
  expect(conversationIdOf(page)).toBe(id);
}

test.describe("iPhone in Safari", () => {
  test("the notifications screen shows the Home Screen steps instead of the switch", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone14", "the iPhone profile shows the install steps");
    await signIn(page, uniqueName("Cal"));
    await visit(page, "/settings/notifications");
    const steps = page.getByTestId("ios-install");
    await expect(steps).toBeVisible();
    await expect(steps).toContainText(webText("install.iosPush"));
    await expect(steps).toContainText(webText("install.iosStep2"));
    await expect(page.getByRole("button", { name: webText("notifications.enable"), exact: true })).toHaveCount(0);

    await visit(page, "/settings/install");
    await expect(page.getByTestId("install-screen").getByTestId("ios-install")).toBeVisible();

    // The chat list carries the hint until it is put away, on this device.
    await visit(page, "/chats");
    const hint = page.getByTestId("install-prompt");
    await expect(hint).toContainText(webText("install.bannerIos"));
    await hint.getByRole("button", { name: webText("install.hide") }).click();
    await expect(hint).toHaveCount(0);
    await reload(page);
    await expect(page.getByRole("button", { name: /Open the menu/ })).toBeVisible();
    await expect(page.getByTestId("install-prompt")).toHaveCount(0);
  });
});
