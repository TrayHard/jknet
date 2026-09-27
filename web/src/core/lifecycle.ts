/**
 * The page's life, turned into what the socket and the chat need.
 *
 * | Event                    | Action                                              |
 * | ------------------------ | --------------------------------------------------- |
 * | tab hidden               | `presence.web {visible:false}`, flush reads, drafts |
 * | tab visible              | `presence.web {visible:true}`, probe, then resync   |
 * | `online`                 | reconnect at once                                   |
 * | `pagehide`, `freeze`     | close the socket, so the page may be cached         |
 * | `pageshow` from cache, `resume` | reconnect, then resync                       |
 *
 * A hidden tab still counts as online for two minutes (the service's grace),
 * so switching apps for a moment does not flicker the player offline.
 */

import type { LiveSocket } from "./socket.ts";

export interface LifecycleHooks {
  /** The tab went into the background: write down what is pending. */
  hidden?(): void;
  /** The tab is back and the socket is known to be up: catch up. */
  resumed?(): void;
}

export function visibleNow(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** Wires the page events to the socket; answers the function that unwires them. */
export function attachLifecycle(socket: LiveSocket, hooks: LifecycleHooks = {}): () => void {
  const report = (visible: boolean) => {
    socket.send({ type: "presence.web", payload: { visible } });
  };

  const onVisibility = () => {
    if (visibleNow()) {
      report(true);
      void socket.probe().then(() => hooks.resumed?.());
    } else {
      report(false);
      hooks.hidden?.();
    }
  };
  const onOnline = () => socket.reconnectNow();
  const onPageHide = () => socket.suspend();
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    socket.resume();
    hooks.resumed?.();
  };
  const onResume = () => {
    socket.resume();
    hooks.resumed?.();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("freeze", onPageHide);
  document.addEventListener("resume", onResume);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("freeze", onPageHide);
    document.removeEventListener("resume", onResume);
  };
}
