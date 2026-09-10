import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";

import { ACCOUNT_CHANGED_EVENT, type AccountChanged } from "../lib/ipc";
import { accountKeys, friendsKeys, queryKeys } from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { useToasts } from "./ToastsProvider";

/** One message, however many refusals the core answered. */
const EXPIRED_TOAST = "account:expired";

/**
 * Says out loud when the hub ends the session by itself.
 *
 * Every other move of the account answers something the player just did, and
 * the screen they did it on shows the result. An expired or revoked token is
 * the exception: the core forgets it after a `401` on a call nobody was
 * watching — a heartbeat, a refresh of the friends list — and the sidebar would
 * otherwise go from a name to **Guest** with nothing said.
 *
 * Mounted once and above the router, because the refusal that starts this can
 * land while any screen is open.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const { show } = toasts;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: UnlistenFn | undefined;

    void (async () => {
      const unlisten = await listen<AccountChanged>(
        ACCOUNT_CHANGED_EVENT,
        (event) => {
          if (event.payload.reason !== "expired") return;
          // The lists behind the Friends screen belong to the session that
          // just ended. `useAccountState` invalidates the account and the
          // settings on the same event.
          void queryClient.invalidateQueries({ queryKey: friendsKeys.state });
          void queryClient.invalidateQueries({ queryKey: accountKeys.state });
          void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
          show(EXPIRED_TOAST, {
            variant: "error",
            title: "Signed out: the session expired",
            text: "Sign in again on the Settings screen to see your friends.",
          });
        },
      );
      if (disposed) {
        unlisten();
        return;
      }
      stop = unlisten;
    })();

    return () => {
      disposed = true;
      stop?.();
    };
  }, [queryClient, show]);

  return <>{children}</>;
}
