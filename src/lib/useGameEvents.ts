/**
 * The bridge between the `launch:*` events and the rest of the interface.
 *
 * Four things happen here and nowhere else:
 *
 * - install progress is collected per client, so a card can draw a bar
 *   without every card subscribing to the same event;
 * - the React Query caches that the events invalidate are invalidated once;
 * - the window hides while the game runs, when the player asked for that;
 * - a warning about the command line is held for the provider to show.
 *
 * Mount it once, at the top of the tree. Outside the Tauri runtime it does
 * nothing at all: `npm run dev` in a browser has no event system to listen to.
 */

import { useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  launchEvents,
  type EngineInstallProgress,
  type GameExited,
  type GameStarted,
  type LaunchWarning,
} from "./ipc";
import { launchKeys, queryKeys } from "./queries";
import { isTauri } from "./runtime";

/** Install progress of every client that has any, keyed by client id. */
export type InstallProgressMap = Record<string, EngineInstallProgress>;

export interface GameEvents {
  /** Progress of the installs that are running or just finished. */
  installs: InstallProgressMap;
  /** Forgets the entry of one client, for a dismissed error. */
  clearInstall: (clientId: string) => void;
  /**
   * The last thing the core had to say about a command line it started.
   *
   * A fresh object on every event, even for the same client and the same code,
   * so that a second launch with the same mistake in it shows the message
   * again. `GameEventsProvider` turns it into a toast: the column lives in a
   * component and the subscription lives here.
   */
  warning: LaunchWarning | null;
}

/**
 * Subscribes to the launch events for the lifetime of the component.
 *
 * `closeOnLaunch` is read through a ref rather than through the dependency
 * list: a settings change must not tear the listeners down and rebuild them.
 */
export function useGameEvents(closeOnLaunch: boolean): GameEvents {
  const queryClient = useQueryClient();
  const [installs, setInstalls] = useState<InstallProgressMap>({});
  const [warning, setWarning] = useState<LaunchWarning | null>(null);
  const hideOnLaunch = useRef(closeOnLaunch);
  hideOnLaunch.current = closeOnLaunch;

  const clearInstall = useCallback((clientId: string) => {
    setInstalls((current) => {
      if (!(clientId in current)) return current;
      const next = { ...current };
      delete next[clientId];
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const track = (pending: Promise<UnlistenFn>) => {
      void pending.then((unlisten) => {
        // The component may have unmounted while `listen` was in flight.
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });
    };

    track(
      listen<EngineInstallProgress>(launchEvents.installProgress, (event) => {
        const progress = event.payload;
        setInstalls((current) => ({ ...current, [progress.clientId]: progress }));
        if (progress.phase === "done") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.clients });
          void queryClient.invalidateQueries({
            queryKey: launchKeys.engineUpdate(progress.clientId),
          });
        }
      }),
    );

    track(
      listen<GameStarted>(launchEvents.gameStarted, (event) => {
        void queryClient.invalidateQueries({ queryKey: launchKeys.runningGame });
        if (hideOnLaunch.current) {
          void getCurrentWindow()
            .hide()
            .catch((e: unknown) => console.warn("cannot hide the window", e));
        }
        console.info(`game started for ${event.payload.clientId}`);
      }),
    );

    track(
      listen<GameExited>(launchEvents.gameExited, (event) => {
        void queryClient.invalidateQueries({ queryKey: launchKeys.runningGame });
        if (hideOnLaunch.current) void showWindow();
        console.info(
          `game exited for ${event.payload.clientId} with ${event.payload.exitCode ?? "no code"}`,
        );
      }),
    );

    track(
      listen<LaunchWarning>(launchEvents.warning, (event) => {
        // Copied rather than stored as it arrives: the same client starting
        // twice with the same argument would otherwise be the same object, and
        // a message shown once for a mistake made twice is a message missed.
        setWarning({ ...event.payload });
        console.warn(
          `launch warning ${event.payload.code} for ${event.payload.clientId}`,
        );
      }),
    );

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [queryClient]);

  return { installs, clearInstall, warning };
}

/**
 * Brings the launcher back after the game closed.
 *
 * A hidden window may also have been minimised before it was hidden, so all
 * three calls are needed; `setFocus` last, because the other two can steal it.
 *
 * --- slice: client window ---
 * Every window runs this, its own: the client windows step aside with the main
 * one and come back with it. Only `main` takes the focus, because two windows
 * asking for it at once is a flicker and the player left from the main one.
 */
async function showWindow(): Promise<void> {
  try {
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    if (window.label === "main") await window.setFocus();
  } catch (e) {
    console.warn("cannot show the window", e);
  }
}
