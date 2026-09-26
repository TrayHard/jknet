/**
 * Closing and quitting the launcher, from the frontend.
 *
 * --- slice: chat notifications ---
 *
 * The close button of the launcher window hides it into the tray (D6) unless
 * the player turned that off or chose **Quit** in the tray. The core decides
 * which (`src-tauri/src/tray.rs`) and has already hidden the window by the
 * time the frontend hears of the close; the frontend's own guards — an
 * unsaved player profile, a running private server — ask only when the close
 * is a real one, and report a **Cancel** so the **Quit** that led there
 * lapses.
 */

import { appLifecycleIpc, type AppCloseAction } from "./ipc";
import { isTauri } from "./runtime";
import { logWindowFailure } from "./windowLog";

/**
 * What the close of this window does: `hide` into the tray, or `close`. A
 * core that cannot answer — one that predates the tray — closes, which is
 * what the window did before.
 */
export async function closeAction(): Promise<AppCloseAction> {
  if (!isTauri()) return "close";
  try {
    return await appLifecycleIpc.closeAction();
  } catch (error) {
    logWindowFailure("app_close_action", error);
    return "close";
  }
}

/** A question on the way out was answered **Cancel**: the launcher stays. */
export function cancelQuit(): void {
  if (!isTauri()) return;
  void appLifecycleIpc
    .quitCancelled()
    .catch((error: unknown) => logWindowFailure("app_quit_cancelled", error));
}
