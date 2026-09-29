/**
 * The server list and the JKHub mods in the web app (spec 3.15), read only,
 * with **Share to chat**, against the e2e service with both catalogs on:
 * the server list polls the fake masters and game servers and the JKHub
 * catalog serves the seeded index of `catalog-fakes.ts`, all on 127.0.0.1.
 *
 * The player browses in the project's device — the wide layout on the
 * desktop engines, the phone layout on Pixel 7 and iPhone 14 — and shares
 * to a friend in a second browser, whose launcher reads the same cards back
 * from the service. The chat's attach menu offers the catalogs' pickers and
 * none of the game's files. A catalog the service switches off, or has not
 * built yet, says it is not available.
 *
 * The fake game servers listen on 127.0.0.1, and a server card refuses a
 * loopback address; the two tests that share a server read the service's
 * list with each address moved to the documentation range
 * (`publicAddresses`). The page opened from a link reads it untouched.
 */

import type { Page, Route } from "@playwright/test";

import { catalogFakes, SEED_FILES, type FakeServer } from "./catalog-fakes.ts";
import { expectNoGameControls, friends, launcherCards, shareWith, wideLayout } from "./catalog-fixtures.ts";
import { chatText, conversationIdOf, escape, openDirect, openFromList, send } from "./chat-fixtures.ts";
import {
  expect,
  launcherHeartbeat,
  launcherSignIn,
  SERVICE,
  sharedCatalog,
  signIn,
  test,
  uniqueName,
  visit,
  webCatalog,
} from "./fixtures.ts";

// Some tests rewrite or refuse the service's answers with `page.route`, which
// WebKit does not apply to the requests of a page a service worker controls.
// Nothing here needs the worker; `pwa.spec.ts` covers it.
test.use({ serviceWorkers: "block" });

const WEB = webCatalog("en") as Record<string, Record<string, unknown>>;
const SERVERS = sharedCatalog("en", "servers") as Record<string, Record<string, string>>;
const SEARCH_SERVERS = sharedCatalog("en", "servers").searchPlaceholder as unknown as string;
const JKHUB = sharedCatalog("en", "jkhub") as Record<string, Record<string, string>>;

/** A string of the web app's catalog, `section.key`, with `{{name}}` filled in. */
function webText(path: string, values: Record<string, string | number> = {}): string {
  let node: unknown = WEB;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  let text = String(node);
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, String(value));
  return text;
}

/** A string of the launcher's `jkhub` catalog, with `{{name}}` filled in. */
function jkhubText(section: string, key: string, values: Record<string, string | number> = {}): string {
  let text = JKHUB[section][key];
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, String(value));
  return text;
}

function fake(key: FakeServer["key"]): FakeServer {
  const server = catalogFakes().servers.find((entry) => entry.key === key);
  if (server === undefined) throw new Error(`no fake server ${key}`);
  return server;
}

/** The rows of the server list on screen. */
function serverRow(page: Page, name: string) {
  return page.getByTestId("server-list").getByTestId("server-row").filter({ hasText: name });
}

/**
 * The service's list with the fakes' loopback addresses turned into public
 * ones, for a test that shares a server. The fakes must listen on
 * 127.0.0.1 — the service scans nothing else, and loopback only in dev mode
 * — while a server card never carries a loopback address (`chat/cards.rs`
 * of the service, `core/chat/cards.ts` of the web app), because no player
 * could join it. The answer is the service's own, rows, counts and order
 * untouched; only the address of each row changes, to one of the
 * documentation range. Answers the address a fake's row then carries.
 */
async function publicAddresses(page: Page): Promise<(fake: FakeServer) => string> {
  const rewrite = (address: string) => address.replace(/^127\.0\.0\.1:/, "203.0.113.1:");
  await page.route(
    (url) => url.origin === SERVICE && url.pathname === "/v1/servers",
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { servers?: Array<{ address: string }> };
      for (const row of body.servers ?? []) row.address = rewrite(row.address);
      return route.fulfill({ response, json: body });
    },
  );
  return (server) => rewrite(server.address);
}

/**
 * Records what the page puts on the clipboard in `window.__copied`: the
 * engines disagree on a headless clipboard, and the test wants the text,
 * not the permission.
 */
async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript({
    content: `
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (text) => { window.__copied = text; return Promise.resolve(); } },
      });
    `,
  });
}

test("server list: rows, filters, colours, friends on a server, a server's page, and the server shared to a friend's chat", async ({
  page,
  players,
}) => {
  const { kyle, jan, other } = await friends(page, players);
  const addressOf = await publicAddresses(page);
  const duel = { ...fake("duel"), address: addressOf(fake("duel")) };
  // Jan's launcher plays on the duel server.
  const launcher = await launcherSignIn(jan);
  await launcherHeartbeat(launcher, { status: "in_game", serverName: duel.clean, serverAddress: duel.address });
  await recordClipboard(page);

  await visit(page, "/servers?game=ja");
  const list = page.getByTestId("server-list");
  await expect(list).toContainText(webText("serverList.lead"));
  // The first read after an idle spell may be the service's stale list; the
  // screen asks again a few seconds later.
  const duelRow = serverRow(page, duel.clean);
  await expect(duelRow).toBeVisible({ timeout: 30_000 });
  await expect(serverRow(page, fake("vanilla").clean)).toBeVisible();
  await expect(serverRow(page, fake("empty").clean)).toBeVisible();
  // Bot-only servers are hidden, as in the launcher.
  await expect(serverRow(page, fake("bots").clean)).toHaveCount(0);

  // The name in the game's colours, the lock, people over slots with the bots apart, the friend.
  await expect(duelRow.locator(`span[title="${duel.clean}"] > span`).first()).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(duelRow.getByRole("img", { name: SERVERS.row.passwordRequired })).toBeVisible();
  await expect(duelRow.getByTestId("server-players")).toContainText("3/24");
  await expect(duelRow.getByTestId("server-players")).toContainText("+2 bots");
  await expect(duelRow).toContainText("mp/duel1 · Duel · japlus");
  await expect(duelRow.getByTestId("server-friends")).toContainText(webText("serverList.friendHere", { name: jan }), { timeout: 20_000 });
  const vanillaRow = serverRow(page, fake("vanilla").clean);
  await expect(vanillaRow.getByTestId("server-players")).toContainText("2/16");
  await expect(vanillaRow.getByTestId("server-players")).toContainText("+1 bot");
  await expect(vanillaRow.getByTestId("server-friends")).toHaveCount(0);
  await expectNoGameControls(page);

  // -- Filters, search and the game, all in the address ---------------------
  await list.getByRole("button", { name: webText("serverList.filters"), exact: true }).click();
  await list.getByRole("switch", { name: SERVERS.filters.hideBotOnly }).click();
  await expect(page).toHaveURL(/[?&]bots=show/);
  await expect(serverRow(page, fake("bots").clean)).toBeVisible();
  await list.getByRole("combobox", { name: SERVERS.filters.players }).click();
  await page.getByRole("option", { name: SERVERS.filters.playersNotEmpty }).click();
  await expect(page).toHaveURL(/[?&]players=not-empty/);
  await expect(serverRow(page, fake("empty").clean)).toHaveCount(0);
  await expect(serverRow(page, fake("bots").clean)).toHaveCount(0);
  await list.getByRole("button", { name: SERVERS.filters.reset }).click();
  await expect(page).not.toHaveURL(/[?&](bots|players)=/);
  await expect(serverRow(page, fake("empty").clean)).toBeVisible();

  const search = list.getByRole("textbox", { name: SEARCH_SERVERS });
  await search.fill("tavern");
  await expect(serverRow(page, fake("vanilla").clean)).toBeVisible();
  await expect(duelRow).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]q=tavern/);
  await search.fill("");
  await expect(duelRow).toBeVisible();

  await list.getByRole("radio", { name: "Jedi Outcast" }).click();
  await expect(page).toHaveURL(/[?&]game=jo/);
  await expect(serverRow(page, fake("outcast").clean)).toBeVisible({ timeout: 30_000 });
  await expect(duelRow).toHaveCount(0);
  await list.getByRole("radio", { name: "Jedi Academy" }).click();
  await expect(duelRow).toBeVisible();

  if (!(await wideLayout(page))) {
    // The phone's menu counts the servers of the game somebody plays on:
    // the duel hall and the tavern. The rail shows badges only.
    await page.getByRole("button", { name: webText("nav.openMenu") }).click();
    const drawer = page.getByRole("dialog", { name: webText("nav.label") });
    await expect(drawer.locator("[data-section=servers]").getByTestId("nav-count")).toHaveText("2");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  }

  // -- A server's page ------------------------------------------------------
  await duelRow.click();
  await expect(page).toHaveURL(new RegExp(`/servers/ja/${escape(encodeURIComponent(duel.address))}`));
  const details = page.getByTestId("server-details");
  await expect(details.getByRole("heading", { level: 1 })).toHaveText(duel.clean);
  await expect(details.getByTestId("server-address")).toHaveText(duel.address);
  const facts = details.getByTestId("server-facts");
  await expect(facts).toContainText("mp/duel1");
  await expect(facts).toContainText("Duel");
  await expect(facts).toContainText("3 +2 bots");
  await expect(facts).toContainText("japlus");
  await expect(facts).toContainText(webText("serverList.passwordYes"));
  await expect(details.getByTestId("server-friends-here")).toContainText(jan);
  await expect(details.getByTestId("platform-note")).toHaveText(webText("catalog.playNote"));
  await expectNoGameControls(page);
  if (await wideLayout(page)) {
    await expect(page.locator("[data-pane=list]").getByTestId("server-row").filter({ hasText: duel.clean })).toHaveAttribute(
      "aria-current",
      "true",
    );
  }

  await details.getByRole("button", { name: SERVERS.details.copyAddress }).click();
  await expect(details.getByRole("button", { name: SERVERS.details.copyAddress })).toContainText(webText("serverList.copied"));
  expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(duel.address);

  await shareWith(page, jan);

  // Jan receives the server as a card with its map and mode.
  await openFromList(other, kyle);
  const received = other.getByRole("log").getByRole("group", {
    name: chatText("cards.label", { kind: chatText("cards.kinds.server"), title: duel.address }),
  });
  await expect(received).toBeVisible({ timeout: 30_000 });
  await expect(received).toContainText(duel.clean);
  await expect(received).toContainText("mp/duel1");
  await expect(received).toContainText("Duel");
  const cards = await launcherCards(launcher, conversationIdOf(other));
  expect(cards).toContainEqual(
    expect.objectContaining({ type: "server", address: duel.address, game: "ja", map: "mp/duel1", gametype: 3, mod: "japlus" }),
  );
});

test("a server's page opens from a link, and one the list does not name says so", async ({ page }) => {
  const outcast = fake("outcast");
  await signIn(page, uniqueName("Kyle"));
  await visit(page, `/servers/jo/${encodeURIComponent(outcast.address)}`);
  const details = page.getByTestId("server-details");
  await expect(details.getByRole("heading", { level: 1 })).toHaveText(outcast.clean, { timeout: 30_000 });
  await expect(details.getByTestId("server-facts")).toContainText("ffa_bespin");

  await visit(page, `/servers/ja/${encodeURIComponent("203.0.113.9:29070")}`);
  await expect(page.getByTestId("server-details").getByRole("alert")).toContainText(webText("serverList.notListedTitle"), {
    timeout: 30_000,
  });
  await expect(page.getByTestId("server-details").getByTestId("server-address")).toHaveText("203.0.113.9:29070");
  await expectNoGameControls(page);
});

test("JKHub mods: search, sections, pages, a file's page, Open on JKHub, and the file shared to a friend's chat", async ({
  page,
  players,
}) => {
  const { jkhubBase } = catalogFakes();
  const { kyle, jan, other } = await friends(page, players);
  const hilts = SEED_FILES.find((file) => file.id === 5001)!;
  const temple = SEED_FILES.find((file) => file.id === 5002)!;

  await visit(page, "/jkhub?game=ja");
  const list = page.getByTestId("jkhub-list");
  await expect(list).toContainText(webText("jkhub.lead"));
  const results = list.getByRole("list", { name: webText("jkhub.results") });
  await expect(list.getByRole("status")).toContainText(jkhubText("search", "results_other", { count: SEED_FILES.length, game: "Jedi Academy" }));
  await expect(results.getByRole("listitem")).toHaveCount(25);
  await expect(list.getByTestId("jkhub-page")).toHaveText(webText("jkhub.page", { page: 1, pages: 2 }));
  await list.getByRole("button", { name: webText("jkhub.next"), exact: true }).click();
  await expect(page).toHaveURL(/[?&]page=2/);
  await expect(results.getByRole("listitem")).toHaveCount(SEED_FILES.length - 25);
  await expect(list.getByTestId("jkhub-page")).toHaveText(webText("jkhub.page", { page: 2, pages: 2 }));
  await list.getByRole("button", { name: webText("jkhub.previous"), exact: true }).click();
  await expect(results.getByRole("listitem")).toHaveCount(25);
  // Every card opens the file on JKHub; none installs.
  await expect(results.getByRole("button", { name: jkhubText("details", "openOnSite") })).toHaveCount(25);
  await expectNoGameControls(page);

  // -- The search and the sections -------------------------------------------
  await list.getByRole("textbox", { name: webText("jkhub.search") }).fill("kyber");
  await expect(page).toHaveURL(/[?&]q=kyber/);
  await expect(page).not.toHaveURL(/[?&]page=/);
  await expect(results.getByRole("listitem")).toHaveCount(2);
  await list.getByRole("button", { name: webText("jkhub.categoryLine", { name: webText("jkhub.allCategories") }) }).click();
  const tree = list.getByTestId("jkhub-tree");
  // With a query the tree keeps the sections that answer it.
  await expect(tree.getByRole("button", { name: new RegExp(`^${JKHUB.sections.maps}`) })).toBeVisible();
  await expect(tree.getByRole("button", { name: new RegExp(`^${JKHUB.sections.audio}`) })).toHaveCount(0);
  await tree.getByRole("button", { name: new RegExp(`^${JKHUB.sections.sabers}`) }).click();
  await expect(page).toHaveURL(/[?&]category=1000024/);
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await expect(results).toContainText(hilts.title);
  await expect(results).toContainText(`${hilts.author} · ${JKHUB.sections.sabers}`);

  // -- A file's page ------------------------------------------------------------
  await results.getByRole("button", { name: jkhubText("card", "open", { title: hilts.title }) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/jkhub/ja/${hilts.id}\\?`));
  const details = page.getByTestId("jkhub-details");
  await expect(details.getByRole("heading", { level: 1 })).toHaveText(hilts.title);
  await expect(details).toContainText(hilts.author);
  await expect(details).toContainText(JKHUB.sections.sabers);
  await expect(details.getByTestId("jkhub-description")).toHaveText(hilts.description);
  await expect(details).toContainText("hilts");
  await expect(details.getByTestId("platform-note")).toHaveText(webText("catalog.installNote"));
  await expect(details.getByRole("button", { name: jkhubText("details", "openOnSite") })).toBeVisible();
  await expectNoGameControls(page);
  if (!(await wideLayout(page))) {
    // Up leads back to the list as it was left.
    await page.getByRole("button", { name: webText("nav.back") }).click();
    await expect(page).toHaveURL(/\/jkhub\?.*q=kyber/);
    await expect(page.getByTestId("jkhub-list").getByRole("list", { name: webText("jkhub.results") }).getByRole("listitem")).toHaveCount(1);
    await page.getByTestId("jkhub-list").getByRole("button", { name: jkhubText("card", "open", { title: hilts.title }) }).first().click();
    await expect(details.getByRole("heading", { level: 1 })).toHaveText(hilts.title);
  }

  await shareWith(page, jan);
  await openFromList(other, kyle);
  const received = other.getByRole("log").getByRole("group", {
    name: chatText("cards.label", { kind: chatText("cards.kinds.jkhubMod"), title: hilts.title }),
  });
  await expect(received).toBeVisible({ timeout: 30_000 });
  const launcher = await launcherSignIn(jan);
  expect(await launcherCards(launcher, conversationIdOf(other))).toContainEqual(
    expect.objectContaining({ type: "jkhubMod", fileId: hilts.id, slug: hilts.slug, title: hilts.title, game: "ja" }),
  );

  // -- A file's page from a link, and Open on JKHub in a new tab -------------
  await visit(page, `/jkhub/ja/${temple.id}`);
  await expect(details.getByRole("heading", { level: 1 })).toHaveText(temple.title, { timeout: 15_000 });
  const opened = page.context().waitForEvent("page");
  await details.getByRole("button", { name: jkhubText("details", "openOnSite") }).click();
  const site = await opened;
  await site.waitForLoadState();
  expect(site.url()).toBe(`${jkhubBase}/files/file/${temple.id}-${temple.slug}/`);
  await expect(site.getByRole("heading", { level: 1 })).toHaveText(`JKHub file ${temple.id}`);
  await site.close();

  // A file the catalog does not have says so.
  await visit(page, "/jkhub/ja/5999");
  await expect(details.getByRole("alert")).toContainText(webText("jkhub.notFoundTitle"), { timeout: 15_000 });
});

test("the chat's attach menu offers the catalogs' pickers and none of the game's files", async ({ page, players }) => {
  const hilts = SEED_FILES.find((file) => file.id === 5001)!;
  const { kyle, jan, other } = await friends(page, players);
  const addressOf = await publicAddresses(page);
  const duel = { ...fake("duel"), address: addressOf(fake("duel")) };
  await openDirect(page, jan);

  const attach = async () => {
    await page.getByRole("button", { name: chatText("attach.open") }).click();
    return page.getByRole("menu");
  };
  const menu = await attach();
  for (const kind of ["file", "photo", "server", "bundle", "jkhubMod"]) {
    await expect(menu.getByRole("menuitem", { name: chatText(`attach.kinds.${kind}`), exact: true })).toBeVisible();
  }
  for (const kind of ["clipboard", "media", "map", "profile", "bind", "config"]) {
    await expect(menu.getByRole("menuitem", { name: chatText(`attach.kinds.${kind}`), exact: true })).toHaveCount(0);
  }
  await expect(menu.getByRole("menuitem")).toHaveCount(5);

  // A server of the service's list.
  await menu.getByRole("menuitem", { name: chatText("attach.kinds.server"), exact: true }).click();
  const servers = page.getByRole("dialog", { name: chatText("pickers.server.title") });
  await expect(servers).toBeVisible();
  await servers.getByRole("button").filter({ hasText: duel.clean }).click({ timeout: 30_000 });
  await expect(servers).toBeHidden();
  await send(page, "The duel hall tonight");

  // A file of the JKHub catalog.
  await (await attach()).getByRole("menuitem", { name: chatText("attach.kinds.jkhubMod"), exact: true }).click();
  const mods = page.getByRole("dialog", { name: chatText("pickers.jkhubMod.title") });
  await mods.getByRole("textbox", { name: chatText("pickers.jkhubMod.search") }).fill("kyber");
  await mods.getByRole("button").filter({ hasText: hilts.title }).click();
  await expect(mods).toBeHidden();
  await send(page, "And these hilts");

  // The bundles open too.
  await (await attach()).getByRole("menuitem", { name: chatText("attach.kinds.bundle"), exact: true }).click();
  const bundles = page.getByRole("dialog", { name: chatText("pickers.bundle.title") });
  await expect(bundles).toBeVisible();
  await bundles.getByRole("button", { name: sharedCatalog("en", "common").actions.cancel as unknown as string, exact: true }).click();
  await expect(bundles).toBeHidden();

  await openFromList(other, kyle);
  const log = other.getByRole("log");
  const server = log.getByRole("group", { name: chatText("cards.label", { kind: chatText("cards.kinds.server"), title: duel.address }) });
  await expect(server).toBeVisible({ timeout: 30_000 });
  await expect(server).toContainText("mp/duel1");
  await expect(log.getByRole("group", { name: chatText("cards.label", { kind: chatText("cards.kinds.jkhubMod"), title: hilts.title }) })).toBeVisible();
  await expectNoGameControls(other);
});

/**
 * Answers every read of one catalog route with the service's refusal, the
 * way a service with the catalog switched off does. A CORS preflight still
 * goes to the service, which allows the app's origin.
 */
async function refuse(page: Page, path: string, code: string): Promise<void> {
  await page.route(
    (url) => url.origin === SERVICE && url.pathname.startsWith(path),
    (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "access-control-allow-origin": new URL(page.url()).origin },
        body: JSON.stringify({ error: { code, message: "The catalog is off on this service" } }),
      });
    },
  );
}

test("catalogs the service does not serve yet say so", async ({ page, guard }) => {
  // The refusals the browser logs as failed loads are the point of this test.
  guard.allowed.push(/^Failed to load resource: the server responded with a status of 503/);
  await signIn(page, uniqueName("Kyle"));

  // Jedi Outcast has no JKHub index on the e2e service yet.
  await visit(page, "/jkhub?game=jo");
  const jkhub = page.getByTestId("jkhub-list");
  await expect(jkhub).toContainText(webText("jkhub.unavailableTitle"), { timeout: 15_000 });
  await expect(jkhub.getByRole("textbox", { name: webText("jkhub.search") })).toBeDisabled();

  // A service with the catalogs switched off.
  await refuse(page, "/v1/servers", "catalog_disabled");
  await refuse(page, "/v1/jkhub/", "catalog_disabled");
  await visit(page, "/servers?game=ja");
  await expect(page.getByTestId("server-list")).toContainText(webText("serverList.unavailable"), { timeout: 15_000 });
  await visit(page, "/jkhub?game=ja");
  await expect(page.getByTestId("jkhub-list")).toContainText(webText("jkhub.unavailableTitle"), { timeout: 15_000 });
  await expectNoGameControls(page);
});
