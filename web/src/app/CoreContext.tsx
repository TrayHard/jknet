import { createContext, use, useSyncExternalStore, type ReactNode } from "react";

import type { WebCore } from "../core/index.ts";
import type { SignInStatus } from "../core/session.ts";
import type { SocketStatus } from "../core/socket.ts";

/**
 * The web core for the web app's own screens.
 *
 * The shared screens reach the core only through `lib/backend.ts`, as they
 * reach the Rust core in the launcher. The screens of this folder need a few
 * things the launcher has no command for — the sign-in that leaves the tab,
 * the socket's state for the offline bar — and read them here.
 */
const CoreContext = createContext<WebCore | null>(null);

export function CoreProvider({ core, children }: { core: WebCore; children: ReactNode }) {
  return <CoreContext value={core}>{children}</CoreContext>;
}

export function useWebCore(): WebCore {
  const core = use(CoreContext);
  if (core === null) throw new Error("useWebCore outside CoreProvider");
  return core;
}

/** Where this tab's sign-in stands, re-rendering on every change. */
export function useSignInStatus(): SignInStatus {
  const core = useWebCore();
  return useSyncExternalStore(core.session.subscribe, core.session.status, core.session.status);
}

/** The live socket's state. */
export function useSocketStatus(): SocketStatus {
  const core = useWebCore();
  return useSyncExternalStore(core.subscribeSocket, core.socketStatus, core.socketStatus);
}
