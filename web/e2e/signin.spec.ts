import { execFileSync } from "node:child_process";

import {
  acceptFriend,
  backFromService,
  BASE,
  expect,
  ownAddress,
  randomAddress,
  requestFriend,
  SERVICE,
  sharedCatalog,
  signIn,
  startDevSignIn,
  test,
  uniqueName,
  userIdOf,
  visit,
  webCatalog,
} from "./fixtures.ts";

const LANGUAGES = ["en", "ru", "uk", "de", "fr", "es", "pl", "hu"];

/** The heading of the service's page for a browser without the sign-in's cookie. */
const OTHER_BROWSER_HEADING = "Sign-in started in another browser";

/** The web app's own sign-in strings in English. */
function signinText(key: string): string {
  return (webCatalog("en").signin as Record<string, string>)[key];
}

/**
 * A web login session made outside any browser, the way somebody after
 * another player's token would make one: the maker keeps the cookie of the
 * answer, and `url` is the link they would pass on. `headers` give the
 * maker's own requests a client address of their own.
 */
async function sessionMadeElsewhere(): Promise<{ id: string; url: string; cookie: string; headers: Record<string, string> }> {
  const headers = { "content-type": "application/json", "x-forwarded-for": randomAddress() };
  const response = await fetch(`${SERVICE}/v1/auth/login-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "dev",
      deviceName: "Somebody else",
      device: "desktop",
      client: "web",
      returnTo: `${BASE}/signin/done`,
    }),
  });
  expect(response.status).toBe(201);
  const session = (await response.json()) as { id: string; url: string };
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0].trim())
    .find((pair) => pair.startsWith("jknet_signin="));
  expect(cookie, "the service ties the session to its maker with a cookie").toBeDefined();
  return { ...session, cookie: cookie ?? "", headers };
}

/** The maker's poll of `made`, with its cookie. */
async function makersPoll(made: { id: string; cookie: string; headers: Record<string, string> }) {
  const response = await fetch(`${SERVICE}/v1/auth/login-sessions/${made.id}`, {
    headers: { ...made.headers, cookie: made.cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; token?: string; user?: unknown };
}

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

test("a sign-in link made outside this browser stops before the provider", async ({ page }) => {
  const made = await sessionMadeElsewhere();
  await ownAddress(page.context());
  await page.goto(made.url);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(OTHER_BROWSER_HEADING);
  // The provider's form never shows: the browser is not sent on.
  await expect(page.locator("#name")).toHaveCount(0);

  // The page leads back to the web app, which has no sign-in of its own to finish.
  await page.getByRole("link", { name: "Return to JKNet" }).click();
  await expect(page.getByTestId("signin-elsewhere")).toContainText(signinText("doneElsewhere"));

  // Nobody signed in, so its maker still waits and gets nothing.
  const poll = await makersPoll(made);
  expect(poll.status).toBe("pending");
  expect(poll.token).toBeUndefined();
});

test("a provider page passed on from another browser signs nobody in", async ({ page }) => {
  const made = await sessionMadeElsewhere();
  // The maker opens the provider's page with its own cookie and passes on
  // the address it leads to.
  const form = await (await fetch(made.url, { headers: { ...made.headers, cookie: made.cookie } })).text();
  const state = /name="state" value="([^"]+)"/.exec(form)?.[1] ?? "";
  expect(state, "the developer sign-in form carries its state").not.toBe("");

  await ownAddress(page.context());
  await page.goto(`${SERVICE}/v1/auth/dev/callback?state=${encodeURIComponent(state)}&name=${uniqueName("Victim")}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(OTHER_BROWSER_HEADING);

  // The session ended without a token; its maker learns only that.
  const poll = await makersPoll(made);
  expect(poll.status).toBe("error");
  expect(poll.token).toBeUndefined();
  expect(poll.user).toBeUndefined();
  // And a poll without the maker's cookie is refused outright.
  const bare = await fetch(`${SERVICE}/v1/auth/login-sessions/${made.id}`, { headers: made.headers });
  expect(bare.status).toBe(403);
});

test("a sign-in finished in another browser says so where it started", async ({ page, players }) => {
  await startDevSignIn(page);
  const state = await page.locator("input[name=state]").inputValue();

  // The provider's page reaches another browser, the way the Discord app
  // opens its answer in the default browser.
  const other = await players.open();
  await ownAddress(other.context());
  await other.goto(`${SERVICE}/v1/auth/dev/callback?state=${encodeURIComponent(state)}&name=${uniqueName("Else")}`);
  await expect(other.getByRole("heading", { level: 1 })).toHaveText(OTHER_BROWSER_HEADING);

  await page.goto("/signin/done");
  await expect(page.getByTestId("signin-failed")).toHaveText(signinText("otherBrowser"));
  await page.getByRole("link", { name: signinText("retry") }).click();
  await expect(page).toHaveURL(`${BASE}/signin`);
  await expect(page.getByRole("button", { name: /Developer sign-in/ })).toBeVisible();
});

test("a browser that lost the sign-in cookie is told why", async ({ page }) => {
  await startDevSignIn(page);
  await page.context().clearCookies();
  await page.goto("/signin/done");
  await expect(page.getByTestId("signin-failed")).toHaveText(signinText("cookieRefused"));
});
