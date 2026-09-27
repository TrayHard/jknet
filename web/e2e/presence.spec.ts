import { makeFriends } from "./chat-fixtures.ts";
import {
  expect,
  hideTab,
  launcherHeartbeat,
  launcherSignIn,
  launcherSignOut,
  sharedCatalog,
  signIn,
  test,
  uniqueName,
  visit,
} from "./fixtures.ts";

const STATUS = sharedCatalog("en", "friends").status as Record<string, string>;

/** How long the service takes to notice a hidden tab: a 5 s grace and a 2 s sweep in the e2e run. */
const HIDDEN_EXPIRY_MS = 15_000;

test("a friend reads where a web player is, a launcher wins, and a hidden tab goes offline", async ({ page, players }) => {
  const ana = uniqueName("Ana");
  const vic = uniqueName("Vic");
  await signIn(page, ana);
  const phone = await players.open({ device: "phone" });
  await signIn(phone, vic);
  await makeFriends(page, ana, phone, vic);

  await visit(page, "/friends");
  const row = page.getByRole("row").filter({ hasText: vic });
  await expect(row).toContainText(STATUS.onlineFromPhone);

  // The same account in a desktop browser as well: the browser label wins.
  const desktop = await players.open({ device: "desktop" });
  await signIn(desktop, vic);
  await expect(row).toContainText(STATUS.onlineInBrowser);

  // JKNet on a PC of the account, in a game: the launcher wins over both.
  const launcher = await launcherSignIn(vic);
  await launcherHeartbeat(launcher, { status: "in_game", serverName: "Jedi Temple", serverAddress: "203.0.113.7:29070" });
  await expect(row).toContainText(
    STATUS.playingOn.replace("{{server}}", "Jedi Temple").replace("{{address}}", "203.0.113.7:29070"),
  );

  // The launcher stops: the web label comes back.
  await launcherSignOut(launcher);
  await expect(row).toContainText(STATUS.onlineInBrowser);

  // The desktop tab goes into the background and stays there past the
  // grace: only the phone is left.
  await hideTab(desktop);
  await expect(row).toContainText(STATUS.onlineFromPhone, { timeout: HIDDEN_EXPIRY_MS });

  // The phone goes into the background too: the player is offline.
  await hideTab(phone);
  await expect(row).not.toContainText(STATUS.onlineFromPhone, { timeout: HIDDEN_EXPIRY_MS });
  await expect(row).toContainText(STATUS.lastSeenJustNow);
});
