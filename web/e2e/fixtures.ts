/**
 * What every e2e test shares: the guard that fails a test on a console
 * error, an uncaught exception, a Content-Security-Policy violation, a
 * command the web core refused (`needs_launcher`) or a translation key no
 * catalog has; and the helpers that sign players in and make second and
 * third players in their own browser contexts.
 */

import { readFileSync } from "node:fs";

import {
  devices,
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from "@playwright/test";

export { expect };

export const BASE = "http://127.0.0.1:5175";
export const SERVICE = "http://127.0.0.1:8788";

/** A catalog of the web app, for asserting translated text. */
export function webCatalog(language: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(new URL(`../src/locales/${language}/web.json`, import.meta.url), "utf8"));
}

/** A catalog of the shared launcher strings. */
export function sharedCatalog(language: string, namespace: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(new URL(`../../src/locales/${language}/${namespace}.json`, import.meta.url), "utf8"));
}

/** A display name nobody else in this run has: letters and digits, at most 24. */
export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 12)}${Math.random().toString(36).slice(2, 9)}`;
}

/** What the page-side guard reports. */
interface Findings {
  errors: string[];
  /** Console lines a test expects, such as the network log of an offline page. */
  allowed: RegExp[];
}

/**
 * Runs in every page of every context before the app. Besides the guard's
 * listeners it keeps the run silent in every engine, WebKit included, which
 * has no mute switch: a media element is muted before it loads or plays, and
 * an audio context stays suspended. The app plays no sound; this holds for
 * whatever a later test opens.
 */
const INIT_SCRIPT = `
  {
    const mute = (element) => { element.muted = true; element.volume = 0; };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { mute(this); return play.call(this); };
    for (const type of ["loadstart", "play"]) {
      document.addEventListener(type, (event) => { if (event.target instanceof HTMLMediaElement) mute(event.target); }, true);
    }
    for (const name of ["AudioContext", "webkitAudioContext"]) {
      const Base = window[name];
      if (typeof Base !== "function") continue;
      window[name] = class extends Base {
        constructor(...args) { super(...args); void this.suspend(); }
        resume() { return Promise.resolve(); }
      };
    }
  }
  document.addEventListener("securitypolicyviolation", (event) => {
    console.error("securitypolicyviolation: " + event.violatedDirective + " " + event.blockedURI);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("unhandledrejection: " + (event.reason && event.reason.message ? event.reason.message : String(event.reason)));
  });
`;

/**
 * Browser noise that is not the app's: the network log line a browser prints
 * for an answer the app expected and handled, and the socket a closing page
 * drops. Everything else on the console fails the test.
 */
const BROWSER_NOISE = [
  /^Failed to load resource: the server responded with a status of (400|401|403|404|409|429)/,
  // WebKit does not know this key of the viewport meta yet; the page needs it
  // for the keyboard on Android.
  /^Viewport argument key "interactive-widget" not recognized and ignored./,
  /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:8788\/v1\/ws\?ticket=[0-9a-f]+' failed/,
];

function watchContext(context: BrowserContext, findings: Findings): void {
  void context.addInitScript({ content: INIT_SCRIPT });
  const attach = (page: Page) => {
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if ([...BROWSER_NOISE, ...findings.allowed].some((pattern) => pattern.test(text))) return;
      findings.errors.push(`${page.url()}: console error: ${text}`);
    });
    page.on("pageerror", (error) => findings.errors.push(`${page.url()}: uncaught: ${error.message}`));
  };
  for (const page of context.pages()) attach(page);
  context.on("page", attach);
}

/** Reads the counters of every page of the app still open. */
async function statsOf(context: BrowserContext): Promise<string[]> {
  const problems: string[] = [];
  for (const page of context.pages()) {
    if (page.isClosed() || !page.url().startsWith(BASE)) continue;
    const stats = await page
      .evaluate(() => (window as unknown as { __jknetStats?: Record<string, unknown> }).__jknetStats ?? null)
      .catch(() => null);
    if (stats === null) continue;
    if (stats.refused !== 0) problems.push(`${page.url()}: refused commands ${JSON.stringify(stats.refusedCommands)}`);
    if (stats.missingKeys !== 0) problems.push(`${page.url()}: missing keys ${JSON.stringify(stats.missingKeyList)}`);
  }
  return problems;
}

export interface Players {
  /** A player in a context of its own, `device` deciding what friends read. */
  open(options?: { device?: "phone" | "desktop"; locale?: string; viewport?: { width: number; height: number } }): Promise<Page>;
}

/**
 * The device descriptor of a desktop browser of this engine. Stated in full:
 * a context of the test's browser inherits the project's options, and a
 * phone project would otherwise make every player a phone.
 */
function desktopOptions(browserName: string): BrowserContextOptions {
  const name = browserName === "firefox" ? "Desktop Firefox" : browserName === "webkit" ? "Desktop Safari" : "Desktop Edge";
  const { defaultBrowserType: _, ...desktop } = devices[name];
  return { ...desktop, viewport: { width: 1280, height: 800 } };
}

/** The device descriptor that makes this engine a phone. */
function phoneOptions(browserName: string): BrowserContextOptions {
  if (browserName === "chromium") {
    const { defaultBrowserType: _, ...pixel } = devices["Pixel 7"];
    return pixel;
  }
  if (browserName === "webkit") {
    const { defaultBrowserType: _, ...iphone } = devices["iPhone 14"];
    return iphone;
  }
  // Firefox emulates no mobile device: a small touch screen stands in.
  return { viewport: { width: 412, height: 839 }, hasTouch: true };
}

export const test = base.extend<{ guard: Findings; players: Players }>({
  guard: [
    async ({ context }, use) => {
      const findings: Findings = { errors: [], allowed: [] };
      watchContext(context, findings);
      await use(findings);
      const problems = [...findings.errors, ...(await statsOf(context))];
      expect(problems, "console errors, CSP violations, refused commands or missing keys").toEqual([]);
    },
    { auto: true },
  ],
  players: async ({ browser, browserName, guard }, use, testInfo: TestInfo) => {
    const contexts: BrowserContext[] = [];
    await use({
      open: async (options = {}) => {
        const phone = options.device === "phone";
        const context = await openContext(browser, {
          ...(phone ? phoneOptions(browserName) : desktopOptions(browserName)),
          ...(options.viewport !== undefined ? { viewport: options.viewport } : {}),
          locale: options.locale ?? "en-US",
        });
        if (phone && browserName === "firefox") {
          // No userAgentData and no coarse pointer in desktop Firefox: the
          // phone's own signal, as a mobile Chromium reports it.
          await context.addInitScript({
            content: `Object.defineProperty(navigator, "userAgentData", { value: { mobile: true, platform: "Android", brands: [] } });`,
          });
        }
        watchContext(context, guard);
        contexts.push(context);
        return context.newPage();
      },
    });
    const problems: string[] = [];
    for (const context of contexts) problems.push(...(await statsOf(context)));
    for (const context of contexts) await context.close().catch(() => undefined);
    expect(problems, `${testInfo.title}: refused commands or missing keys in other players' pages`).toEqual([]);
  },
});

async function openContext(browser: Browser, options: BrowserContextOptions): Promise<BrowserContext> {
  return browser.newContext({ baseURL: BASE, serviceWorkers: "allow", ...options });
}

/**
 * Gives the sign-in requests of a context a client address of its own, so
 * the run's many sign-ins do not share the service's per-address limit. The
 * service reads the first entry of `X-Forwarded-For`, which a proxy sets in
 * production.
 */
export async function ownAddress(context: BrowserContext): Promise<void> {
  const address = randomAddress();
  await context.route(`${SERVICE}/v1/auth/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
  );
}

/** A client address of the documentation range for requests the test makes itself. */
export function randomAddress(): string {
  return `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
}

/**
 * Starts a sign-in with the developer provider, from `start` (a path the app
 * sends to `/signin?next=`) or from `/signin`, and waits on the provider's
 * form. The browser holds the session's cookie from here on.
 */
export async function startDevSignIn(page: Page, start = "/signin"): Promise<void> {
  await ownAddress(page.context());
  await page.goto(start);
  await expect(page).toHaveURL(/\/signin(\?|$)/);
  await page.getByRole("button", { name: /Developer sign-in/ }).click();
  await page.waitForURL(`${SERVICE}/v1/auth/dev/start**`);
}

/**
 * Signs a player in with the developer provider, from `start` or from
 * `/signin` (see `startDevSignIn`), and waits until the app is back on its
 * own pages.
 */
export async function signIn(page: Page, name: string, start = "/signin"): Promise<void> {
  await startDevSignIn(page, start);
  await page.locator("#name").fill(name);
  await page.locator("button[type=submit]").click();
  await backFromService(page);
  await page.waitForURL((url) => url.origin === BASE && !url.pathname.startsWith("/signin"), { timeout: 30_000 });
}

/**
 * The service's success page leads back to the app by itself after a
 * second (a meta refresh). A headless Firefox sometimes sits on it, at
 * times without ever reporting it loaded, and then a click on **Return to
 * JKNet** waits for that load forever. So this opens the link's address,
 * the app's `/signin/done`, the way a player's press would; a refresh that
 * fires meanwhile only cuts the navigation short.
 */
export async function backFromService(page: Page): Promise<void> {
  try {
    await page.waitForURL((url) => url.origin === BASE, { timeout: 5_000 });
  } catch {
    if (new URL(page.url()).origin === BASE) return;
    await page.goto(`${BASE}/signin/done`).catch(() => undefined);
  }
}

/**
 * Opens a path of the app once the page on screen has settled, so no request
 * of the page it replaces is cut off mid-flight: Firefox logs every aborted
 * request as an error. The app itself never reloads to navigate; a test
 * does, to reach a screen directly.
 */
export async function visit(page: Page, path: string): Promise<void> {
  await settle(page);
  await page.goto(path);
}

/** Reloads the page once it has settled: see `visit`. */
export async function reload(page: Page): Promise<void> {
  await settle(page);
  await page.reload();
}

/**
 * Waits until the page has no request of its own on the way and its chat
 * nothing waiting — a read marker a second from going out, a message — so
 * a navigation of the test cuts nothing off. Bounded: the live socket keeps
 * a connection open for good.
 */
async function settle(page: Page): Promise<void> {
  if (!page.url().startsWith(BASE)) return;
  await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
  await page
    .waitForFunction(
      () => (window as unknown as { __jknetChat?: { idle(): boolean } }).__jknetChat?.idle() ?? true,
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
}

/** The account id of the signed-in player, read from the web app's database. */
export async function userIdOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open("jknet-web", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const read = open.result.transaction("session", "readonly").objectStore("session").get("current");
          read.onsuccess = () => {
            open.result.close();
            resolve((read.result as { userId?: string } | undefined)?.userId ?? "");
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
}

/** A launcher of the account, as the service sees one: a token of client `launcher`. */
export interface LauncherClient {
  token: string;
  userId: string;
}

/**
 * Signs a launcher in with the developer provider, the way JKNet 0.4.0 to
 * 0.9.0 on a PC does: a login session of client `launcher` without a
 * loopback address, the provider's form, the poll that carries the token.
 * The service takes this old sign-in while `JKNET_ONLINE_LEGACY_SIGNIN` is
 * on, its default. The same name is the same account as the web app's
 * sign-in.
 */
export async function launcherSignIn(name: string): Promise<LauncherClient> {
  const headers = { "content-type": "application/json", "x-forwarded-for": `203.0.113.${1 + Math.floor(Math.random() * 254)}` };
  const created = await fetch(`${SERVICE}/v1/auth/login-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "dev", deviceName: "E2E-LAUNCHER", client: "launcher" }),
  });
  expect(created.status, "a launcher's login session").toBe(201);
  const session = (await created.json()) as { id: string; url: string };
  const form = await (await fetch(session.url, { headers })).text();
  const state = /name="state" value="([^"]+)"/.exec(form)?.[1];
  expect(state, "the developer sign-in form carries its state").toBeTruthy();
  const callback = await fetch(
    `${SERVICE}/v1/auth/dev/callback?state=${encodeURIComponent(state ?? "")}&name=${encodeURIComponent(name)}`,
    { headers, redirect: "manual" },
  );
  expect(callback.status).toBeLessThan(400);
  const done = (await (await fetch(`${SERVICE}/v1/auth/login-sessions/${session.id}`, { headers })).json()) as {
    status: string;
    token?: string;
    user?: { id: string };
  };
  expect(done.status).toBe("done");
  return { token: done.token ?? "", userId: done.user?.id ?? "" };
}

/** One presence heartbeat of a launcher: `online`, or `in_game` with where. */
export async function launcherHeartbeat(
  launcher: LauncherClient,
  beat: { status: "online" | "in_game"; serverName?: string; serverAddress?: string },
): Promise<void> {
  const response = await fetch(`${SERVICE}/v1/presence`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${launcher.token}` },
    body: JSON.stringify(beat),
  });
  expect(response.ok, `a launcher heartbeat (${response.status})`).toBe(true);
}

/** Signs a launcher out: its presence goes at once, the account's web sessions stay. */
export async function launcherSignOut(launcher: LauncherClient): Promise<void> {
  const response = await fetch(`${SERVICE}/v1/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${launcher.token}` },
  });
  expect(response.status).toBe(204);
}

/**
 * Puts a page in the background as far as the app can tell: the document
 * reads `hidden` and says so, as when the player switches tabs or apps. A
 * headless browser never hides a page by itself.
 */
export async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Sends a friend request from the friends screen and waits for the answer. */
export async function requestFriend(page: Page, name: string): Promise<void> {
  await visit(page, "/friends");
  const box = page.getByRole("textbox", { name: /Search, or type a name to add/ });
  await box.fill(name);
  await box.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: name })).toBeVisible();
}

/** Accepts the pending request from `name` on the requests screen. */
export async function acceptFriend(page: Page, name: string): Promise<void> {
  await visit(page, "/friends/requests");
  const row = page.locator("div").filter({ hasText: name }).filter({ has: page.getByRole("button", { name: "Accept" }) }).last();
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
}
