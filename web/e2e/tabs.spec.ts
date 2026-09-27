import { BASE, expect, sharedCatalog, signIn, test, uniqueName, webCatalog } from "./fixtures.ts";

const TABS = webCatalog("en").tabs as Record<string, string>;
const SIGN_OUT = (sharedCatalog("en", "account").danger as Record<string, string>).signOut;

test("a second tab waits, takes over, and a sign-out reaches the other tab", async ({ page, context, guard }) => {
  // A tab that steps aside closes its socket at once, even one still
  // connecting; Firefox logs that as an error.
  guard.allowed.push(/can’t establish a connection to the server at ws:/, /was interrupted while the page was loading/);
  await signIn(page, uniqueName("Ahsoka"));
  await expect(page).toHaveURL(`${BASE}/chats`);

  // A second tab of the same browser: the first holds the connection.
  const second = await context.newPage();
  await second.goto("/settings/account");
  const gate = second.getByTestId("tab-gate");
  await expect(gate).toBeVisible();
  await expect(gate.getByRole("heading", { level: 1 })).toHaveText(TABS.title);
  await expect(page.getByTestId("tab-gate")).toHaveCount(0);

  // **Open here**: the second tab runs the app, the first steps aside.
  await gate.getByRole("button", { name: TABS.takeOver }).click();
  await expect(page.getByTestId("tab-gate")).toBeVisible();
  await expect(second.getByTestId("tab-gate")).toHaveCount(0);
  await expect(second.getByTestId("account-name")).toBeVisible();

  // And back: the first takes over again, the second waits.
  await page.getByTestId("tab-gate").getByRole("button", { name: TABS.takeOver }).click();
  await expect(second.getByTestId("tab-gate")).toBeVisible();
  await expect(page.getByTestId("tab-gate")).toHaveCount(0);
  await second.getByTestId("tab-gate").getByRole("button", { name: TABS.takeOver }).click();
  await expect(second.getByTestId("account-name")).toBeVisible();
  await expect(page.getByTestId("tab-gate")).toBeVisible();

  // The second tab signs out; the first starts over.
  const reloaded = page.waitForEvent("load");
  await second.getByRole("button", { name: SIGN_OUT, exact: true }).click();
  await second.waitForURL((url) => url.pathname === "/signin");
  await reloaded;
  // The first tab is still gated after its reload; taking over shows it signed out.
  await page.getByTestId("tab-gate").getByRole("button", { name: TABS.takeOver }).click();
  await page.waitForURL((url) => url.pathname === "/signin");
  await expect(second.getByTestId("tab-gate")).toBeVisible();
});
