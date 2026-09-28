/**
 * The catalogs of JKNet Online in the web app: community servers and
 * bundles, read only, with **Share to chat**.
 *
 * Each test publishes what it browses through the service's own API: a
 * community server page (its owner is set in the test database, as an
 * administrator's approval would, since the service verifies ownership by
 * asking the game server) and a bundle with one file. The player browses in
 * the project's device — the wide layout on the desktop engines, the phone
 * layout on Pixel 7 and iPhone 14 — and shares to a friend in a second
 * browser, whose launcher, a token of client `launcher` on the same
 * account, reads the same card back from the service.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { Page } from "@playwright/test";

import { chatText, conversationIdOf, escape, makeFriends, openFromList } from "./chat-fixtures.ts";
import {
  expect,
  launcherSignIn,
  SERVICE,
  sharedCatalog,
  signIn,
  test,
  uniqueName,
  userIdOf,
  visit,
  webCatalog,
  type LauncherClient,
} from "./fixtures.ts";

const WEB = webCatalog("en") as Record<string, Record<string, string>>;
const COMMUNITY = (sharedCatalog("en", "servers") as Record<string, Record<string, string>>).community;
const BUNDLES = sharedCatalog("en", "bundles") as Record<string, Record<string, unknown>>;

/** A string of the `bundles` namespace, `section.key`, with `{{name}}` filled in. */
function bundlesText(path: string, values: Record<string, string> = {}): string {
  let node: unknown = BUNDLES;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  let text = String(node);
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, value);
  return text;
}

/** The token of the signed-in player, read from the web app's database. */
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

/** One call to the e2e service with a player's token; answers the JSON body. */
async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${SERVICE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `${method} ${path}: ${response.status} ${text}`).toBe(true);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** The database file of the e2e service, from the environment `global-setup.ts` hands the workers. */
function serviceDatabase(): string {
  const service = JSON.parse(process.env.JKNET_E2E_SERVICE ?? "{}") as { env?: Record<string, string> };
  const url = service.env?.JKNET_ONLINE_DATABASE_URL ?? "";
  expect(url, "the e2e service's database").toMatch(/^sqlite:\/\//);
  return url.slice("sqlite://".length).replace(/\?.*$/, "");
}

interface CommunityServerRow {
  id: string;
  address: string;
  revision: number;
}

/**
 * A community server page with an owner, a description, rules and one
 * recommended JKHub file. The address is public, as the service demands of a
 * page, and never contacted: a random port of 1.1.1.1.
 */
async function publishCommunityServer(token: string, ownerId: string, name: string): Promise<CommunityServerRow> {
  const address = `1.1.1.1:${20_000 + Math.floor(Math.random() * 40_000)}`;
  const created = await api<CommunityServerRow>(token, "POST", "/v1/community/servers", { name, address, game: "ja" });
  const database = new DatabaseSync(serviceDatabase());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.prepare("UPDATE community_servers SET owner_id = ? WHERE id = ?").run(ownerId, created.id);
  } finally {
    database.close();
  }
  const page = await api<CommunityServerRow>(token, "PUT", `/v1/community/servers/${created.id}`, {
    name,
    description: `Duels every evening on ${name}.`,
    website: "",
    discord: "",
    rules: "Bow before a duel.",
    recommendations: [{ title: "Hilt pack", jkhubId: 4321 }],
    revision: created.revision,
  });
  return page;
}

/** A published bundle of Jedi Academy with one cfg file of its own. */
async function publishBundle(token: string, name: string): Promise<string> {
  const file = Buffer.from(`// ${name}\nseta cg_fov 97\n`);
  const sha256 = createHash("sha256").update(file).digest("hex");
  const bundle = await api<{ id: string }>(token, "POST", "/v1/bundles", {
    name,
    summary: `${name} for duels`,
    description: `The **${name}** bundle: one client for duels.`,
    game: "ja",
    tags: ["duel"],
  });
  const manifest = {
    schema: 2,
    game: "ja",
    components: [
      {
        id: "mp",
        label: "Multiplayer",
        engine: { engineId: "eternaljk", releaseTag: null },
        modes: ["multiplayer"],
        fsGame: null,
        launchArgs: "",
        overlay: { files: [], remove: [] },
        files: [{ root: "home", path: "base/autoexec_duel.cfg", size: file.length, sha256, source: { kind: "blob" } }],
        configs: [{ name: "Binds", text: "bind x say hi\n", priority: 0 }],
      },
    ],
    shared: { files: [], configs: [] },
  };
  const created = await api<{ version: { id: string } }>(token, "POST", `/v1/bundles/${bundle.id}/versions`, {
    label: "1.0",
    changelog: "First",
    manifest,
  });
  const upload = await fetch(`${SERVICE}/v1/blobs/${sha256}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-length": String(file.length) },
    body: file,
  });
  expect(upload.ok, `the bundle's file (${upload.status})`).toBe(true);
  await api(token, "POST", `/v1/bundles/${bundle.id}/versions/${created.version.id}/publish`, {});
  return bundle.id;
}

/** Two signed-in friends: the player in the test's page, the friend in a browser of their own. */
async function friends(page: Page, players: { open(): Promise<Page> }) {
  const kyle = uniqueName("Kyle");
  const jan = uniqueName("Jan");
  await signIn(page, kyle);
  const other = await players.open();
  await signIn(other, jan);
  await makeFriends(page, kyle, other, jan);
  return { kyle, jan, other };
}

async function wideLayout(page: Page): Promise<boolean> {
  return (await page.locator("[data-layout]").first().getAttribute("data-layout")) === "wide";
}

/** Shares what is on screen with a friend through the share dialog. */
async function shareWith(page: Page, friend: string): Promise<void> {
  await page.getByRole("button", { name: chatText("share.action"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: chatText("share.title") });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("option").filter({ hasText: friend }).getByRole("button").click();
  await dialog.getByRole("button", { name: chatText("share.send"), exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(chatText("share.sent", { name: friend }))).toBeVisible();
}

/** The cards of the newest messages of a conversation, as a launcher reads them. */
async function launcherCards(launcher: LauncherClient, conversationId: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${SERVICE}/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    headers: { authorization: `Bearer ${launcher.token}` },
  });
  expect(response.status).toBe(200);
  const page = (await response.json()) as { messages: Array<{ cards?: Array<Record<string, unknown>> }> };
  return page.messages.flatMap((message) => message.cards ?? []);
}

/** No control of the game anywhere on screen: no join, no play, no connect, no install. */
async function expectNoGameControls(page: Page): Promise<void> {
  const game = /^(Join|Play|Connect|Install)\b/i;
  await expect(page.getByRole("button", { name: game })).toHaveCount(0);
  await expect(page.getByRole("link", { name: game })).toHaveCount(0);
}

test("community servers: the list, a server's page, and the server shared to a friend's chat", async ({ page, players }) => {
  const { kyle, jan, other } = await friends(page, players);
  const token = await tokenOf(page);
  const ownerId = await userIdOf(page);
  const name = uniqueName("Clan");
  const server = await publishCommunityServer(token, ownerId, name);

  await visit(page, "/community");
  const list = page.getByTestId("community-list");
  await expect(list).toContainText(WEB.catalog.communityLead);
  await list.getByRole("textbox", { name: COMMUNITY.search }).fill(name);
  const card = list.getByRole("button").filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(list.getByRole("button", { name: COMMUNITY.add })).toHaveCount(0);
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/community/${server.id}$`));

  const details = page.getByTestId("community-details");
  await expect(details.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(details).toContainText(server.address);
  await expect(details).toContainText(`Duels every evening on ${name}.`);
  await expect(details).toContainText("Bow before a duel.");
  await expect(details).toContainText("Hilt pack");
  await expect(details.getByTestId("platform-note")).toHaveText(WEB.catalog.playNote);
  await expect(details.getByRole("button", { name: COMMUNITY.copyAddress })).toBeVisible();
  // Read only: no page edits, no claims, no way back of its own.
  await expect(details.getByRole("button", { name: COMMUNITY.edit })).toHaveCount(0);
  await expect(details.getByRole("button", { name: COMMUNITY.getCode })).toHaveCount(0);
  await expect(details.getByRole("button", { name: COMMUNITY.back })).toHaveCount(0);
  await expectNoGameControls(page);

  if (await wideLayout(page)) {
    // The list stays beside the page, the open server marked on it.
    await expect(page.locator("[data-pane=list]").getByRole("button").filter({ hasText: name })).toHaveAttribute("aria-current", "true");
  }

  await shareWith(page, jan);

  // The friend receives the server as a card, with its address to copy.
  await openFromList(other, kyle);
  const thread = other.getByRole("log");
  const received = thread.getByRole("group", {
    name: chatText("cards.label", { kind: chatText("cards.kinds.server"), title: server.address }),
  });
  await expect(received).toBeVisible({ timeout: 30_000 });
  await expect(received).toContainText(name);
  await expect(received.getByRole("button", { name: chatText("cards.server.copy") })).toBeVisible();
  await expect(received).toContainText(chatText("cards.openInLauncher"));

  // So does the friend's launcher.
  const launcher = await launcherSignIn(jan);
  const cards = await launcherCards(launcher, conversationIdOf(other));
  expect(cards).toContainEqual(expect.objectContaining({ type: "server", address: server.address, name, game: "ja" }));
});

test("bundles: the list with its search and game, a bundle's page, and the bundle shared to a friend's chat", async ({ page, players }) => {
  const { kyle, jan, other } = await friends(page, players);
  const token = await tokenOf(page);
  const name = uniqueName("Duelpack");
  const bundleId = await publishBundle(token, name);

  await visit(page, "/bundles");
  const list = page.getByTestId("bundles-list");
  await expect(list).toContainText(WEB.catalog.bundlesLead);
  await list.getByRole("textbox", { name: bundlesText("toolbar.search") }).fill(name);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${escape(name)}`));
  const card = list.getByRole("button", { name: bundlesText("card.open", { name }) });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // The other game's catalogue has no such bundle; the address says which game is on screen.
  await list.getByRole("radio", { name: "Jedi Outcast" }).click();
  await expect(page).toHaveURL(/[?&]game=jo/);
  await expect(list.getByRole("radio", { name: "Jedi Outcast" })).toHaveAttribute("aria-checked", "true");
  await expect(card).toHaveCount(0);
  await list.getByRole("radio", { name: "Jedi Academy" }).click();
  await expect(page).toHaveURL(/[?&]game=ja/);
  await expect(card).toBeVisible();

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/bundles/${bundleId}\\?`));
  const details = page.getByTestId("bundle-details");
  await expect(details.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(details).toContainText(kyle);
  await expect(details).toContainText("one client for duels");
  await expect(details).toContainText("autoexec_duel.cfg");
  await expect(details.getByTestId("platform-note")).toHaveText(WEB.catalog.installNote);
  // The manifest is to read: no install, no look inside a file, no client window.
  await expect(details.getByRole("heading", { name: bundlesText("details.install.heading") })).toHaveCount(0);
  await expect(details.getByRole("button", { name: /^Contents of / })).toHaveCount(0);
  await expectNoGameControls(page);

  if (await wideLayout(page)) {
    await expect(page.locator("[data-pane=list]").getByRole("button", { name: bundlesText("card.open", { name }) })).toHaveAttribute(
      "aria-current",
      "true",
    );
  } else {
    // Up leads back to the list as it was left.
    await page.getByRole("button", { name: WEB.nav.back }).click();
    await expect(page).toHaveURL(new RegExp(`/bundles\\?.*q=${escape(name)}`));
    await expect(page.getByTestId("bundles-list").getByRole("textbox", { name: bundlesText("toolbar.search") })).toHaveValue(name);
    await page.getByTestId("bundles-list").getByRole("button", { name: bundlesText("card.open", { name }) }).click();
    await expect(page.getByTestId("bundle-details").getByRole("heading", { name, level: 1 })).toBeVisible();
  }

  await shareWith(page, jan);

  // The friend receives the bundle as a card and reads the record from it.
  await openFromList(other, kyle);
  const thread = other.getByRole("log");
  const received = thread.getByRole("group", {
    name: chatText("cards.label", { kind: chatText("cards.kinds.bundle"), title: name }),
  });
  await expect(received).toBeVisible({ timeout: 30_000 });
  await received.getByRole("button", { name: chatText("cards.bundle.viewOnly"), exact: true }).click();
  const record = other.getByRole("dialog", { name });
  await expect(record).toContainText("autoexec_duel.cfg");
  await expect(record.getByRole("heading", { name: bundlesText("details.install.heading") })).toHaveCount(0);
  await record.getByRole("button", { name: sharedCatalog("en", "common").actions.close as unknown as string, exact: true }).click();
  await expect(record).toBeHidden();

  // So does the friend's launcher.
  const launcher = await launcherSignIn(jan);
  const cards = await launcherCards(launcher, conversationIdOf(other));
  expect(cards).toContainEqual(expect.objectContaining({ type: "bundle", bundleId, name, game: "ja" }));
});

test("a bundle's page opens from a link, and the menu counts what the catalogs hold", async ({ page }) => {
  const kyle = uniqueName("Kyle");
  await signIn(page, kyle);
  const token = await tokenOf(page);
  const name = uniqueName("Linkpack");
  const bundleId = await publishBundle(token, name);

  await visit(page, `/bundles/${bundleId}`);
  await expect(page.getByTestId("bundle-details").getByRole("heading", { name, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expectNoGameControls(page);

  if (await wideLayout(page)) {
    // The list loads beside the page; the rail names the section.
    await expect(page.locator("[data-pane=list]").getByTestId("bundles-list")).toBeVisible();
    await expect(page.getByTestId("rail").locator("[data-section=bundles]")).toHaveAttribute("aria-current", "page");
  } else {
    // Opened from a link, up replaces the page with the list.
    await page.getByRole("button", { name: WEB.nav.back }).click();
    await expect(page).toHaveURL(/\/bundles$/);
    await expect(page.getByTestId("bundles-list")).toBeVisible();
    // The phone's menu counts the bundles the list loaded.
    await page.getByRole("button", { name: WEB.nav.openMenu }).click();
    const drawer = page.getByRole("dialog", { name: WEB.nav.label });
    await expect(drawer.locator("[data-section=bundles]").getByTestId("nav-count")).toHaveText(/^\d+$/);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  }
});

test("a page of the community catalog that is not there says so", async ({ page }) => {
  await signIn(page, uniqueName("Kyle"));
  await visit(page, "/community/01J9Z3M2K4V8Q6R5T7W9X1Y2Z3");
  await expect(page.getByTestId("community-details").getByRole("alert")).toBeVisible({ timeout: 15_000 });
  await expectNoGameControls(page);
});
