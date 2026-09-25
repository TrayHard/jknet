/**
 * Closing the main window while a private server runs.
 *
 * Two handlers see the close. The core's `on_window_event` keeps the window
 * open and sends `host:close-requested`, which opens **Stop your server and
 * quit?**; the window's own `onCloseRequested` of the unsaved-draft guard
 * would `destroy()` it regardless, and the core cannot stop a destroy that
 * comes from the frontend. So the guard asks here first and stands aside while
 * the server lives.
 *
 * **Stop and quit** stops the server, approves the quit and closes the window
 * again: the second close finds no live session and goes through the guard as
 * any close does.
 */

import type { QueryClient } from "@tanstack/react-query";

import type { HostSession } from "../../lib/ipc";
import { hostKeys } from "../../lib/queries";
import { isHostLive } from "./hostModel";

/** Set by **Stop and quit**: the close that follows is the player's answer. */
let quitApproved = false;

/** Lets the next close of the window through, whatever the session says. */
export function approveQuit(): void {
  quitApproved = true;
}

/**
 * Takes an approval back when the close it was for did not happen, so a
 * server started later in this run is asked about again.
 */
export function revokeQuit(): void {
  quitApproved = false;
}

/**
 * Whether the private server holds the window open.
 *
 * The session is read again before the answer: the cached copy follows the
 * `host:session` events, and a close that races the last of them must not
 * leave the window unclosable. A read that fails falls back on the cache.
 */
export async function hostHoldsWindow(queryClient: QueryClient): Promise<boolean> {
  // One approval, one close: a close the draft guard then cancels must not
  // leave the next server of this run unguarded.
  if (quitApproved) {
    quitApproved = false;
    return false;
  }
  const cached = queryClient.getQueryData<HostSession | null>(hostKeys.session);
  // `undefined` is «not read yet», not «no server»: that one is asked for.
  if (cached !== undefined && !isHostLive(cached)) return false;
  try {
    await queryClient.refetchQueries({ queryKey: hostKeys.session, exact: true });
  } catch {
    // The cache stays the answer.
  }
  return isHostLive(queryClient.getQueryData<HostSession | null>(hostKeys.session));
}
