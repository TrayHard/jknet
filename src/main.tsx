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
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing the #root element");

if (isTauri()) void startLogging().catch(() => undefined);

void start();

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
 */
async function start(): Promise<void> {
  const [setting, systemLocale] = await Promise.all([
    readLanguageSetting(),
    readSystemLocale(),
  ]);
  await bootstrapI18n(setting, systemLocale);

  ReactDOM.createRoot(root!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
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
