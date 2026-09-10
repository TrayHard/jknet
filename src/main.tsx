import {
  attachConsole,
  error as logError,
  warn as logWarn,
} from "@tauri-apps/plugin-log";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { isTauri } from "./lib/runtime";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing the #root element");

if (isTauri()) void startLogging().catch(() => undefined);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

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
