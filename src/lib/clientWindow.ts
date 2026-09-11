/**
 * The route and the opener of the client window.
 *
 * The window is a second Tauri window showing the same bundle at
 * `#/client/<id>`; the core builds it and labels it `client-<id>`. Two facts
 * about that route live here so nothing has to spell it twice:
 *
 * - [`clientRoute`] builds it, for the core's URL and for the browser;
 * - [`isClientWindowHash`] recognises it, which is how `App` decides that this
 *   document is a client window and not the launcher.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router";

import { ipc } from "./ipc";
import { isTauri } from "./runtime";

/** The hash route of the client window, without the leading `#`. */
export function clientRoute(clientId: string): string {
  return `/client/${clientId}`;
}

/**
 * True when this document was opened as the window of a client.
 *
 * The initial hash, read once: a client window never navigates anywhere, and
 * the main window never arrives at this route in a way that should strip it of
 * its providers.
 */
export function isClientWindowHash(hash: string): boolean {
  return hash.startsWith("#/client/");
}

/**
 * Opens the editing window of a client.
 *
 * Inside Tauri the core opens the window, or raises the one already open. In a
 * plain browser there are no windows, so the same route opens in the tab: that
 * is how the layout of the window is reviewed under `npm run dev`.
 */
export function useOpenClientWindow(): (clientId: string) => Promise<void> {
  const navigate = useNavigate();

  return useCallback(
    async (clientId: string) => {
      if (!isTauri()) {
        void navigate(clientRoute(clientId));
        return;
      }
      await ipc.openClientWindow(clientId);
    },
    [navigate],
  );
}
