import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";

import { AccountProvider } from "../../../src/components/AccountProvider.tsx";
import { ToastsProvider } from "../../../src/components/ToastsProvider.tsx";
import { listen } from "../../../src/lib/backend.ts";
import { ACCOUNT_CHANGED_EVENT, type AccountChanged } from "../../../src/lib/ipc.ts";
import { useFriendsEvents } from "../../../src/lib/queries.ts";
import type { WebCore } from "../core/index.ts";
import { CoreProvider } from "./CoreContext.tsx";
import { OneTabGate } from "./OneTabGate.tsx";
import { routes } from "./routes.tsx";

/** The one subscription to the `friends:*` events, above the router. */
function FriendsEvents() {
  useFriendsEvents();
  return null;
}

/**
 * Another account, or none: nothing the previous one saw stays in the cache.
 * A rename keeps the cache; `useAccountState` refetches the account itself.
 */
function AccountSwitch() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<AccountChanged>(ACCOUNT_CHANGED_EVENT, (event) => {
      if (event.payload.reason === "renamed") return;
      void queryClient.resetQueries();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [queryClient]);
  return null;
}

/**
 * The web app: the core's gate first, then the providers the shared
 * components expect — queries, toasts, the account — and the router.
 */
export function App({ core }: { core: WebCore }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  const [router] = useState(() => createBrowserRouter(routes));

  return (
    <CoreProvider core={core}>
      <OneTabGate core={core}>
        <QueryClientProvider client={queryClient}>
          <ToastsProvider>
            <AccountProvider>
              <AccountSwitch />
              <FriendsEvents />
              <RouterProvider router={router} />
            </AccountProvider>
          </ToastsProvider>
        </QueryClientProvider>
      </OneTabGate>
    </CoreProvider>
  );
}
