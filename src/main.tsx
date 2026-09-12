import {
  attachConsole,
  error as logError,
  warn as logWarn,
} from "@tauri-apps/plugin-log";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
// --- slice: i18n ---
import { bootstrapI18n } from "./i18n";
import { readSystemLocale } from "./i18n/useSystemLocale";
import { errorMessage, ipc } from "./lib/ipc";
import { isTauri } from "./lib/runtime";
// --- slice: selection context menu ---
import { blockNativeContextMenu } from "./lib/selection";
// --- slice: client window ---
import { logWindow } from "./lib/windowLog";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing the #root element");

if (isTauri()) void startLogging().catch(() => undefined);

// --- slice: client window ---
// Before anything decides which tree to render: which window this document is
// and what route it got. See `logDocument`.
logDocument();

// --- slice: selection context menu ---
// Every window of the launcher runs this same bundle, so one call here takes
// the webview's own context menu off the main window and off every client
// window. It is bound before React mounts, because a right click that lands
// during the first frame must not open **View page source** either.
blockNativeContextMenu();

// A rejection that got this far is a window with nothing in it, so it says so
// rather than ending as an unhandled promise nobody sees.
void start().catch((e: unknown) => {
  console.error(`The interface did not start: ${errorMessage(e)}`);
});

/**
 * Brings up the launcher, in the player's language from the first frame.
 *
 * --- slice: i18n ---
 * The catalog is loaded before React mounts. Rendering English first and
 * correcting it a moment later would be both a flash and a layout jump: a
 * sidebar item is «Settings» in one language and «Настройки» in another, and
 * the second is wider.
 *
 * Two reads stand between the window opening and the first paint, and neither
 * may block it. `get_settings` reads one local file and `locale()` reads one
 * registry value; both are swallowed on failure, which leaves the launcher on
 * the system language and, failing that, on English.
 *
 * --- slice: client window ---
 * Nothing before `render` may throw. A rejection here used to leave the
 * document empty for good, and an empty document draws no title bar — which in
 * a window with `decorations: false` is a window with no way to close it. The
 * language is the part worth losing: English is already in the bundle, so a
 * catalog that fails to load costs a translation, not the window.
 */
async function start(): Promise<void> {
  try {
    const [setting, systemLocale] = await Promise.all([
      readLanguageSetting(),
      readSystemLocale(),
    ]);
    await bootstrapI18n(setting, systemLocale);
  } catch (e) {
    console.error(`Starting the interface language failed: ${errorMessage(e)}`);
  }

  ReactDOM.createRoot(root!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

/**
 * Says which window this document is and what route it was opened at.
 *
 * --- slice: client window ---
 * The launcher has more than one window, and every one of them runs this same
 * bundle: `main` on `#/`, a client window on `#/client/<slug>`. A window that
 * comes up blank or shows the wrong screen is two different defects — the core
 * built the wrong address, or the frontend did the wrong thing with the right
 * one — and nothing in the log used to tell them apart. This line does, and it
 * is written before `App` reads the hash, so it holds the route as it arrived.
 */
function logDocument(): void {
  logWindow(`document at ${window.location.href}`);
}

/** The stored language, or `system` when there is nothing to read it from. */
async function readLanguageSetting(): Promise<string> {
  if (!isTauri()) return "system";
  try {
    return (await ipc.getSettings()).language;
  } catch (e) {
    console.warn(`Reading the language setting failed: ${errorMessage(e)}`);
    return "system";
  }
}

/**
 * Puts the frontend console into the launcher log file.
 *
 * A player reports a bug with one file, so a React error has to land in
 * `logs\jknet.log` next to the Rust lines. `forwardConsole` copies the two
 * levels worth keeping; `attachConsole` covers the opposite direction and
 * prints whatever the core sends to the `Webview` log target. `lib.rs`
 * registers no such target, which is what keeps the two from feeding each
 * other in a loop.
 */
async function startLogging(): Promise<void> {
  forwardConsole("warn", logWarn);
  forwardConsole("error", logError);
  await attachConsole();
}

/** Keeps the original console call and sends the same line to the plugin. */
function forwardConsole(
  level: "warn" | "error",
  write: (message: string) => Promise<void>,
): void {
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    original(...args);
    void write(args.map(asText).join(" ")).catch(() => undefined);
  };
}

/** One line for the log file, whatever the caller passed to `console`. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
