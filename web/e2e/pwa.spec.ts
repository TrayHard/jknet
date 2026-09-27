import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import { BASE, expect, reload, signIn, test, uniqueName, visit } from "./fixtures.ts";

test("the manifest names the app, its start and its icons", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "JKNet",
    short_name: "JKNet",
    start_url: "/chats?source=pwa",
    scope: "/",
    display: "standalone",
  });
  const sizes = manifest.icons.map((icon: { sizes: string; purpose?: string }) => `${icon.sizes}${icon.purpose ? ` ${icon.purpose}` : ""}`);
  expect(sizes).toEqual(["192x192", "512x512", "512x512 maskable"]);
  for (const icon of manifest.icons as Array<{ src: string }>) {
    expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  }
  const version = await (await request.get("/version.json")).json();
  expect(typeof version.commit).toBe("string");
  expect(version).toHaveProperty("minBuiltAt");
});

test("the page is served under the production security policy", async ({ request }) => {
  const response = await request.get("/signin");
  const policy = response.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("style-src 'self'");
  expect(policy).toContain("connect-src 'self' http://127.0.0.1:8788 ws://127.0.0.1:8788");
  expect(policy).not.toContain("unsafe-inline");
});

test("the service worker caches the shell, and the shell opens offline", async ({ page, context, guard, browserName }) => {
  // Offline, every call to the service fails, and the browser logs each one.
  guard.allowed.push(/net::ERR_(FAILED|INTERNET_DISCONNECTED)/, /NetworkError/, /Failed to fetch/);
  await signIn(page, uniqueName("Ezra"));
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(`${BASE}/`);
  // Once the worker controls the page, the shell comes from its cache.
  await reload(page);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  const shell = await page.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.startsWith("shell-"));
    if (name === undefined) return [];
    return (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname);
  });
  expect(shell).toContain("/index.html");
  expect(shell).toContain("/manifest.webmanifest");
  expect(shell.some((path) => /^\/assets\/index-[\w-]+\.js$/.test(path))).toBe(true);
  expect(shell.some((path) => path.endsWith(".woff2"))).toBe(true);

  // Firefox and WebKit take an emulated offline page off the network before
  // its service worker sees the navigation; Chromium hands it over.
  if (browserName !== "chromium") {
    test.info().annotations.push({ type: "note", description: "offline navigation checked in Chromium only" });
    return;
  }
  await context.setOffline(true);
  await visit(page, "/settings/about");
  await expect(page.getByTestId("build")).toBeVisible();
  await expect(page.getByTestId("offline-bar")).toBeVisible();
  await context.setOffline(false);
});

test("the browser finds the app installable", async ({ browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "installability is Chromium's to judge");
  // Installability is never granted to an incognito profile, which every
  // Playwright context is: this one gets a profile of its own.
  const profile = mkdtempSync(join(tmpdir(), "jknet-web-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: testInfo.project.use.channel,
    headless: true,
    baseURL: BASE,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await visit(page, "/signin");
    await page.evaluate(async () => navigator.serviceWorker.ready);
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as {
      installabilityErrors: Array<{ errorId: string }>;
    };
    expect(installabilityErrors.map((error) => error.errorId)).toEqual([]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
