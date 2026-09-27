import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

// WebKit and Firefox live inside node_modules (`PLAYWRIGHT_BROWSERS_PATH=0
// npx playwright install webkit firefox`); Chromium is the installed Edge.
// The workers inherit this from the runner, which starts them after reading
// the config.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const WIDE = { width: 1440, height: 900 };
const MUTE_EDGE = ["--mute-audio"];
const MUTE_FIREFOX = { "media.volume_scale": "0.0" };

/**
 * The web app's end-to-end run: the e2e build under the production
 * Content-Security-Policy (`vite preview` on 127.0.0.1:5175) against a local
 * JKNet Online on 127.0.0.1:8788 that `global-setup.ts` starts from
 * `JKNET_ONLINE_BIN` in a temporary folder. Nothing here reaches a real
 * service.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./dist/test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 4,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:5175",
    // No window on the desktop, ever: the run stays headless even when a
    // project forgets to say so.
    headless: true,
    trace: "retain-on-failure",
    serviceWorkers: "allow",
  },
  webServer: {
    command: "npx vite preview --config web/vite.config.ts --mode e2e --outDir e2e/dist",
    cwd: repo,
    url: "http://127.0.0.1:5175/manifest.webmanifest",
    reuseExistingServer: false,
    timeout: 60_000,
  },
  // Test browsers never make a sound: Edge and Firefox are muted here, every
  // page of every engine, WebKit included, gets the muting init script of
  // `fixtures.ts`, and the app itself plays no audio.
  projects: [
    { name: "edge", use: { ...devices["Desktop Edge"], channel: "msedge", viewport: WIDE, launchOptions: { args: MUTE_EDGE } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: WIDE, launchOptions: { firefoxUserPrefs: MUTE_FIREFOX } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: WIDE } },
    { name: "pixel7", use: { ...devices["Pixel 7"], channel: "msedge", launchOptions: { args: MUTE_EDGE } } },
    { name: "iphone14", use: { ...devices["iPhone 14"] } },
  ],
});
