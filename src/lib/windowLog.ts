/**
 * What a window writes about itself into `logs\JKNet.log`.
 *
 * --- slice: client window ---
 * The launcher runs the same bundle in more than one window, and a line that
 * does not say which window wrote it is a line nobody can act on: `main` and
 * `client-<slug>` mount the same components and call the same commands. Every
 * message here carries the label, so a report about one blank window can be
 * followed through the file.
 *
 * The plugin is the only destination. `console.warn` and `console.error` reach
 * the same file through `forwardConsole` in `main.tsx`, but `info` has no such
 * bridge, and the lines below are the ordinary case rather than the failure.
 *
 * Nothing here may cost the caller anything. Outside the Tauri runtime — the
 * browser of `npm run dev` — the calls do nothing, and a plugin that refuses is
 * swallowed: a window must not fail to close because the log did.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";

import { errorMessage } from "./ipc";
import { isTauri } from "./runtime";

/** The label of this window, or `null` when there is no window to ask. */
export function windowLabel(): string | null {
  if (!isTauri()) return null;
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

/** One `info` line about this window. */
export function logWindow(message: string): void {
  write(logInfo, message);
}

/**
 * One `error` line about a window action the core refused.
 *
 * The three buttons of the title bar used to swallow their rejections, on the
 * grounds that a window which will not minimise is not worth an error dialog.
 * That still holds for the player; it never held for the log, where a close
 * button that does nothing is exactly the line a bug report needs.
 */
export function logWindowFailure(action: string, e: unknown): void {
  write(logError, `${action} failed: ${errorMessage(e)}`);
}

/** Sends one line, prefixed with the window, and never throws. */
function write(
  level: (message: string) => Promise<void>,
  message: string,
): void {
  const label = windowLabel();
  if (label === null) return;
  try {
    void level(`window ${label}: ${message}`).catch(() => undefined);
  } catch {
    // A runtime that cannot log is still a runtime.
  }
}
