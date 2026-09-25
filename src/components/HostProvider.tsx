import { useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../i18n/errors";
import type { HostSession } from "../lib/ipc";
import {
  hostKeys,
  useHostCloseRequested,
  useHostEvents,
  useHostSession,
  useStopHost,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { humanCount } from "./host/hostModel";
import { approveQuit, revokeQuit } from "./host/quit";
import { Button, Dialog } from "./ui";

/**
 * Holds the private server for the whole main window.
 *
 * --- slice: play with friends ---
 * Above the router, next to `FriendsProvider`: the session moves on every
 * screen — the sidebar counter and the Home card read it — so the one
 * subscription to `host:session` lives here, and so does the question the
 * core asks when the window closes over a running server.
 */
export function HostProvider({ children }: { children: ReactNode }) {
  useHostEvents();
  // Read once at start, so the counter, the Home card and the quit guard know
  // about a server this window did not start — a reload in development.
  const session = useHostSession().data ?? null;
  const [quitting, setQuitting] = useState(false);
  useHostCloseRequested(() => setQuitting(true));
  useDevHostBridge();

  return (
    <>
      {children}
      {quitting ? <QuitDialog session={session} onClose={() => setQuitting(false)} /> : null}
    </>
  );
}

/**
 * **Stop your server and quit?**
 *
 * **Stop and quit** waits for the server to go down before it closes the
 * window: a window gone first would take the tunnel with it while the server
 * still had people on it, and the core would be left to kill a process it
 * meant to stop.
 */
function QuitDialog({ session, onClose }: { session: HostSession | null; onClose: () => void }) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const stop = useStopHost();
  const [error, setError] = useState<string | null>(null);
  const players = session === null ? 0 : humanCount(session.players);

  const stopAndQuit = async () => {
    setError(null);
    try {
      await stop.mutateAsync();
      approveQuit();
      if (isTauri()) await getCurrentWindow().close();
    } catch (e) {
      // The window stays: the approval must not outlive the close it was for.
      revokeQuit();
      setError(errorText(e));
    }
  };

  return (
    <Dialog
      title={t("quit.title")}
      body={players > 0 ? t("quit.text", { count: players }) : t("quit.textEmpty")}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button variant="danger" disabled={stop.isPending} onClick={() => void stopAndQuit()}>
            {stop.isPending ? t("quit.stopping") : t("quit.confirm")}
          </Button>
        </>
      }
    >
      {error ? <p className="text-body-sm text-fg-danger pt-12">{error}</p> : null}
    </Dialog>
  );
}

/**
 * The stand-ins of `devHost.ts` push their session here, in `npm run dev`.
 *
 * A browser has no `host:session` event, so the fake core of that module
 * calls back instead, and the start, the steps and the stop move on screen
 * the way the real core moves them. Gone from a production bundle: the
 * condition is a compile-time constant.
 */
function useDevHostBridge(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!import.meta.env.DEV || isTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void import("../lib/devHost").then((module) => {
      if (disposed) return;
      off = module.subscribeDevHost({
        session: (next) => queryClient.setQueryData(hostKeys.session, next),
        reset: () => void queryClient.invalidateQueries({ queryKey: hostKeys.all }),
      });
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [queryClient]);
}
