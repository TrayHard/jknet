import { execFileSync } from "node:child_process";

import {
  acceptFriend,
  backFromService,
  BASE,
  expect,
  requestFriend,
  sharedCatalog,
  signIn,
  test,
  uniqueName,
  userIdOf,
  visit,
  webCatalog,
} from "./fixtures.ts";

const LANGUAGES = ["en", "ru", "uk", "de", "fr", "es", "pl", "hu"];

test("the developer sign-in opens the app on the chats", async ({ page }) => {
  const name = uniqueName("Kyle");
  await signIn(page, name);
  await expect(page).toHaveURL(`${BASE}/chats`);
  await visit(page, "/settings/account");
  await expect(page.getByTestId("account-name")).toHaveText(name);
});

test("an iPhone outside the installed app is asked to install first", async ({ page }, testInfo) => {
  await visit(page, "/signin");
  const hint = page.getByTestId("install-first");
  if (testInfo.project.name === "iphone14") await expect(hint).toHaveText((webCatalog("en").signin as Record<string, string>).installFirst);
  else await expect(hint).toHaveCount(0);
});

test("a deep link opened signed out lands on its screen after the sign-in", async ({ page }) => {
  await visit(page, "/c/01TESTCONVERSATION");
  await expect(page).toHaveURL(`${BASE}/signin?next=${encodeURIComponent("/c/01TESTCONVERSATION")}`);
  await signIn(page, uniqueName("Jan"), "/c/01TESTCONVERSATION");
  await expect(page).toHaveURL(`${BASE}/c/01TESTCONVERSATION`);
});

test("a next that leaves the app is dropped", async ({ page }) => {
  await signIn(page, uniqueName("Mara"), "/signin?next=//evil.example.com/");
  await expect(page).toHaveURL(`${BASE}/chats`);
});

test("the owner of developer accounts picks one in the chooser", async ({ page, players }) => {
  const owner = uniqueName("Owner");
  await signIn(page, owner);
  const ownerId = await userIdOf(page);
  expect(ownerId).not.toBe("");

  const developer = uniqueName("Dev");
  const service = JSON.parse(process.env.JKNET_E2E_SERVICE ?? "{}") as { bin: string; dir: string; env: Record<string, string> };
  execFileSync(service.bin, ["dev-account", "create", "--owner", ownerId, "--name", developer], {
    cwd: service.dir,
    env: service.env,
    windowsHide: true,
  });

  const second = await players.open();
  await second.context().route("http://127.0.0.1:8788/v1/auth/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": "203.0.113.200" } }),
  );
  await visit(second, "/signin");
  await second.getByRole("button", { name: /Developer sign-in/ }).click();
  await second.locator("#name").fill(owner);
  await second.locator("button[type=submit]").click();
  // The service's chooser: the owner and each developer account.
  const pick = second.getByRole("button", { name: new RegExp(developer) });
  await expect(pick).toBeVisible();
  await expect(second.getByRole("button", { name: new RegExp(owner) })).toBeVisible();
  await pick.click();
  await backFromService(second);
  await second.waitForURL(`${BASE}/chats`, { timeout: 30_000 });
  await visit(second, "/settings/account");
  await expect(second.getByTestId("account-name")).toHaveText(developer);
});

test("friend requests travel between two browsers and both web labels show", async ({ page, players }) => {
  const friends = sharedCatalog("en", "friends").status as Record<string, string>;
  const me = uniqueName("Ana");
  await signIn(page, me);

  const phone = await players.open({ device: "phone" });
  const phoneName = uniqueName("Phone");
  await signIn(phone, phoneName);

  const desktop = await players.open({ device: "desktop" });
  const desktopName = uniqueName("Desk");
  await signIn(desktop, desktopName);

  // Both wait on their friends list; the requests reach them live.
  await visit(phone, "/friends");
  await visit(desktop, "/friends");
  await requestFriend(page, phoneName);
  await requestFriend(page, desktopName);
  await expect(phone.getByTestId("requests-row").getByTestId("nav-badge")).toHaveText("1");
  await expect(desktop.getByTestId("requests-row").getByTestId("nav-badge")).toHaveText("1");
  await acceptFriend(phone, me);
  await acceptFriend(desktop, me);

  await visit(page, "/friends");
  const phoneRow = page.getByRole("row").filter({ hasText: phoneName });
  const desktopRow = page.getByRole("row").filter({ hasText: desktopName });
  await expect(phoneRow).toContainText(friends.onlineFromPhone);
  await expect(desktopRow).toContainText(friends.onlineInBrowser);

  // The same label on the friend's own page.
  await phoneRow.click();
  await expect(page.getByTestId("friend-status")).toHaveText(friends.onlineFromPhone);
});

test("every language renders the sign-in", async ({ players }) => {
  for (const language of LANGUAGES) {
    const page = await players.open({ locale: language === "en" ? "en-US" : language });
    const catalog = webCatalog(language);
    await visit(page, "/signin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText((catalog.signin as Record<string, string>).title);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
  }
});
