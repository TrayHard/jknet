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

const INIT_SCRIPT = `
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
async function ownAddress(context: BrowserContext): Promise<void> {
  const address = `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
  await context.route(`${SERVICE}/v1/auth/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
  );
}

/**
 * Signs a player in with the developer provider, from `start` (a path the app
 * sends to `/signin?next=`) or from `/signin`, and waits until the app is
 * back on its own pages.
 */
export async function signIn(page: Page, name: string, start = "/signin"): Promise<void> {
  await ownAddress(page.context());
  await page.goto(start);
  await expect(page).toHaveURL(/\/signin(\?|$)/);
  await page.getByRole("button", { name: /Developer sign-in/ }).click();
  await page.waitForURL(`${SERVICE}/v1/auth/dev/start**`);
  await page.locator("#name").fill(name);
  await page.locator("button[type=submit]").click();
  await backFromService(page);
  await page.waitForURL((url) => url.origin === BASE && !url.pathname.startsWith("/signin"), { timeout: 30_000 });
}

/**
 * The service's success page leads back to the app by itself after a
 * second (a meta refresh). A headless Firefox sometimes sits on it; a player
 * would press **Return to JKNet**, and so does this.
 */
export async function backFromService(page: Page): Promise<void> {
  try {
    await page.waitForURL((url) => url.origin === BASE, { timeout: 5_000 });
  } catch {
    const back = page.getByRole("link", { name: "Return to JKNet" });
    if (await back.isVisible()) await back.click();
  }
}

/**
 * Opens a path of the app once the page on screen has settled, so no request
 * of the page it replaces is cut off mid-flight: Firefox logs every aborted
 * request as an error. The app itself never reloads to navigate; a test
 * does, to reach a screen directly.
 */
export async function visit(page: Page, path: string): Promise<void> {
  // Bounded: the live socket keeps a connection open for good.
  if (page.url().startsWith(BASE)) await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
  await page.goto(path);
}

/** Reloads the page once it has settled: see `visit`. */
export async function reload(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
  await page.reload();
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
