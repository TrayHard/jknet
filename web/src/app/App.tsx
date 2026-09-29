import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";

import { AccountProvider } from "../../../src/components/AccountProvider.tsx";
import { ChatProvider } from "../../../src/components/chat/ChatProvider.tsx";
import { ToastsProvider } from "../../../src/components/ToastsProvider.tsx";
import { listen } from "../../../src/lib/backend.ts";
import { ACCOUNT_CHANGED_EVENT, type AccountChanged, type ServerInfo } from "../../../src/lib/ipc.ts";
import { serverKeys, useFriendsEvents } from "../../../src/lib/queries.ts";
import type { WebCore } from "../core/index.ts";
import { SERVERS_UPDATED_EVENT, type ServersUpdated } from "../core/servers.ts";
import { CoreProvider } from "./CoreContext.tsx";
import { OneTabGate } from "./OneTabGate.tsx";
import { routes } from "./routes.tsx";

/** The one subscription to the `friends:*` events, above the router. */
function FriendsEvents() {
  useFriendsEvents();
  return null;
}

/**
 * Every answer of the service's server list, from the screen's refresh or a
 * picker's retry, goes into the list the chat's server picker reads
 * (`get_cached_servers`), which never refetches on its own.
 */
function ServerListSync({ core }: { core: WebCore }) {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      core.events.on(SERVERS_UPDATED_EVENT, (payload) => {
        const { game, servers } = payload as ServersUpdated;
        queryClient.setQueryData<ServerInfo[]>(serverKeys.cached(game), servers);
      }),
    [core, queryClient],
  );
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
 * components expect — queries, toasts, the account, the chat's one
 * subscription to the `chat:*` events — and the router.
 */
export function App({ core }: { core: WebCore }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // The commands go to the core in this page, which answers offline
        // too: a message written offline goes into its queue. React Query
        // would hold every call while the browser says it is offline.
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, networkMode: "always" },
          mutations: { networkMode: "always" },
        },
      }),
  );
  const [router] = useState(() => createBrowserRouter(routes));

  return (
    <CoreProvider core={core}>
      <OneTabGate core={core}>
        <QueryClientProvider client={queryClient}>
          <ToastsProvider>
            <AccountProvider expiredToast={false}>
              <AccountSwitch />
              <FriendsEvents />
              <ServerListSync core={core} />
              <ChatProvider role="main">
                <RouterProvider router={router} />
              </ChatProvider>
            </AccountProvider>
          </ToastsProvider>
        </QueryClientProvider>
      </OneTabGate>
    </CoreProvider>
  );
}
