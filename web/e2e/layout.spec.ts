import { acceptFriend, BASE, expect, requestFriend, sharedCatalog, signIn, test, uniqueName, visit } from "./fixtures.ts";

const friendsStatus = sharedCatalog("en", "friends").status as Record<string, string>;

/** The phone projects run P3's tests, the wide ones W1's. */
function phoneOnly(isMobile: boolean) {
  test.skip(!isMobile, "the phone layout runs in the phone profiles");
}
function wideOnly(isMobile: boolean) {
  test.skip(isMobile, "the wide layout runs in the desktop projects");
}

test.describe("phone: P3", () => {
  test("the drawer opens by button and edge swipe and closes five ways", async ({ page, isMobile }) => {
    phoneOnly(isMobile);
    await signIn(page, uniqueName("Rey"));
    await expect(page.locator("[data-layout=phone]")).toBeVisible();
    const drawer = page.getByTestId("drawer");
    const menu = page.getByRole("button", { name: "Open the menu" });

    // Button, closed by the scrim.
    await menu.click();
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("online.jknet.app");
    await expect(drawer.getByTestId("drawer-me")).toContainText(friendsStatus.onlineFromPhone);
    await page.getByTestId("drawer-scrim").click({ position: { x: 380, y: 400 } });
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();

    // Escape.
    await menu.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // The system back.
    await menu.click();
    await expect(drawer).toBeVisible();
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(`${BASE}/chats`);

    // A swipe from the left edge, closed by a swipe to the left.
    await page.mouse.move(4, 400);
    await page.mouse.down();
    await page.mouse.move(60, 405, { steps: 4 });
    await page.mouse.move(140, 410, { steps: 4 });
    await page.mouse.up();
    await expect(drawer).toBeVisible();
    await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    await page.mouse.move(250, 400);
    await page.mouse.down();
    await page.mouse.move(180, 402, { steps: 4 });
    await page.mouse.move(100, 404, { steps: 4 });
    await page.mouse.up();
    await expect(drawer).toBeHidden();

    // An item.
    await menu.click();
    await drawer.getByRole("link", { name: /Friends/ }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(`${BASE}/friends`);
  });

  test("back from a section chosen in the drawer returns to where the drawer opened", async ({ page, isMobile }) => {
    phoneOnly(isMobile);
    await signIn(page, uniqueName("Finn"));
    await visit(page, "/friends");
    await page.getByRole("button", { name: "Open the menu" }).click();
    await page.getByTestId("drawer").getByRole("link", { name: /Settings/ }).click();
    await expect(page).toHaveURL(`${BASE}/settings`);
    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/friends`);
    await expect(page.getByTestId("drawer")).toBeHidden();
  });

  test("the top bar's back goes up to the parent", async ({ page, isMobile }) => {
    phoneOnly(isMobile);
    await signIn(page, uniqueName("Poe"));

    // Pushed from the list: back through history, forward still leads in.
    await visit(page, "/friends");
    await page.getByTestId("requests-row").click();
    await expect(page).toHaveURL(`${BASE}/friends/requests`);
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page).toHaveURL(`${BASE}/friends`);
    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/friends/requests`);

    // A deep link: the parent replaces the entry, the app is not left.
    await visit(page, "/settings/about");
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page).toHaveURL(`${BASE}/settings`);
    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/friends/requests`);
  });

  test("a dialog opens as a sheet and the system back closes it", async ({ page, isMobile }) => {
    phoneOnly(isMobile);
    await signIn(page, uniqueName("Leia"));
    await visit(page, "/settings/account");
    await page.getByRole("button", { name: "Delete account data" }).click();
    const sheet = page.getByRole("dialog", { name: "Delete your JKNet account?" });
    await expect(sheet).toBeVisible();
    // Measured once the panel has slid up.
    const panel = sheet.locator("> div");
    await panel.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(viewport?.height);
    expect(Math.round(box?.width ?? 0)).toBe(viewport?.width);
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(`${BASE}/settings/account`);
    await expect(page.getByTestId("account-name")).toBeVisible();
  });

  test("a phone turned sideways keeps the phone layout", async ({ page, isMobile }) => {
    phoneOnly(isMobile);
    await signIn(page, uniqueName("Cal"));
    const size = page.viewportSize() ?? { width: 412, height: 839 };
    await page.setViewportSize({ width: Math.max(size.height, 915), height: size.width });
    await expect(page.locator("[data-layout=phone]")).toBeVisible();
  });

  test("the drawer and the menu button carry the counters", async ({ page, players, isMobile }) => {
    phoneOnly(isMobile);
    const me = uniqueName("Ahsoka");
    await signIn(page, me);
    await visit(page, "/chats");
    const other = await players.open();
    await signIn(other, uniqueName("Rex"));
    await requestFriend(other, me);
    await expect(page.getByTestId("menu-dot")).toBeVisible();
    await page.getByRole("button", { name: "Open the menu" }).click();
    await expect(page.getByTestId("drawer").locator("[data-section=friends]").getByTestId("nav-badge")).toHaveText("1");
  });
});

test.describe("wide: W1", () => {
  test("rail, list and content; empty panes; settings opens on the account", async ({ page, isMobile }) => {
    wideOnly(isMobile);
    await signIn(page, uniqueName("Obi"));
    await visit(page, "/friends");
    await expect(page.locator("[data-layout=wide]")).toBeVisible();
    const rail = page.getByTestId("rail");
    await expect(rail.getByRole("link")).toHaveCount(8);
    await expect(rail.locator("[aria-current=page]")).toHaveAttribute("data-section", "friends");
    await expect(page.locator("[data-pane=list]")).toBeVisible();
    await expect(page.getByTestId("empty-pane")).toHaveText("Pick a friend");
    await rail.locator("[data-section=chats]").click();
    await expect(page.getByTestId("empty-pane")).toHaveText("Pick a chat");
    await rail.locator("[data-section=settings]").click();
    await expect(page).toHaveURL(`${BASE}/settings/account`);
    await expect(page.getByTestId("account-name")).toBeVisible();
    await expect(rail.getByTestId("rail-me")).toHaveAttribute("aria-label", new RegExp(friendsStatus.onlineInBrowser));
  });

  test("group details are a fourth column when wide and a sheet below 1200 px", async ({ page, isMobile }) => {
    wideOnly(isMobile);
    await signIn(page, uniqueName("Qui"));
    await visit(page, "/c/01TESTGROUP/info");
    await expect(page.getByTestId("details-column")).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.getByTestId("details-sheet")).toBeVisible();
    await expect(page.getByTestId("details-column")).toBeHidden();
    await page.getByRole("button", { name: "Close details" }).click();
    await expect(page).toHaveURL(`${BASE}/c/01TESTGROUP`);
    // Closing added no history entry: Back does not open the details again.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/info$/);
  });

  test("resizing across 900 px keeps the route", async ({ page, isMobile }) => {
    wideOnly(isMobile);
    await signIn(page, uniqueName("Din"));
    await visit(page, "/friends/requests");
    await expect(page.locator("[data-layout=wide]")).toBeVisible();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.locator("[data-layout=phone]")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}/friends/requests`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("[data-layout=wide]")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}/friends/requests`);
  });

  test("the rail counts requests, and friends online once there are none", async ({ page, players, isMobile }) => {
    wideOnly(isMobile);
    const me = uniqueName("Bo");
    await signIn(page, me);
    await visit(page, "/chats");
    const other = await players.open();
    const otherName = uniqueName("Cara");
    await signIn(other, otherName);
    await requestFriend(other, me);
    const friends = page.getByTestId("rail").locator("[data-section=friends]");
    await expect(friends.getByTestId("nav-badge")).toHaveText("1");
    await acceptFriend(page, otherName);
    await expect(friends.getByTestId("nav-badge")).toHaveCount(0);
  });
});
