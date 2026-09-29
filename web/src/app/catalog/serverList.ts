/**
 * What the two screens of the server list share: the list of one game as
 * JKNet Online polled it, the friends playing on each server, the path of a
 * server's page, and which refusals mean the catalog has nothing to serve.
 *
 * Imported by the lazy screens only, so none of it is part of the first
 * download.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";

import { onlineErrorCode, type Friend, type Game } from "../../../../src/lib/ipc.ts";
import { useFriendsState } from "../../../../src/lib/queries.ts";
import { STALE_RETRY_MS, type ServerListAnswer } from "../../core/servers.ts";
import { useWebCore } from "../CoreContext.tsx";

/** How often the list is asked again while it is on screen. */
export const REFRESH_MS = 60_000;

export const webServerKeys = {
  list: (game: Game) => ["web", "servers", game] as const,
};

/**
 * A refusal that says the catalog has nothing to serve: switched off on the
 * service (`catalog_disabled`), or not built yet (`catalog_not_ready`).
 * Asking again at once changes neither.
 */
export function catalogUnavailable(error: unknown): boolean {
  const code = onlineErrorCode(error);
  return code === "catalog_disabled" || code === "catalog_not_ready";
}

/**
 * The server list of one game, as the service's last scan left it.
 *
 * Asked again once a minute while the screen is on screen and the page
 * visible — React Query holds the timer while the tab is hidden — and five
 * seconds after a stale answer, which means a newer scan is on its way.
 * A list switched off is not asked for again until the player says so.
 */
export function useServerList(game: Game): UseQueryResult<ServerListAnswer> {
  const core = useWebCore();
  return useQuery({
    queryKey: webServerKeys.list(game),
    queryFn: () => core.servers.load(game),
    staleTime: 30_000,
    refetchInterval: (query) => {
      if (query.state.error !== null && catalogUnavailable(query.state.error)) return false;
      return query.state.data?.stale ? STALE_RETRY_MS : REFRESH_MS;
    },
    retry: (failures, error) => !catalogUnavailable(error) && failures < 1,
  });
}

/** The path of a server's page: the address is one URL-encoded segment. */
export function serverPath(game: Game, address: string): string {
  return `/servers/${game}/${encodeURIComponent(address)}`;
}

/** The address as the list compares it: a presence may spell it in another case. */
function key(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Friends in a game, by the address of the server their presence names. A
 * friend who is only online, or plays on a server JKNet did not start, is
 * on no server.
 */
export function useFriendsOnServers(): Map<string, Friend[]> {
  const friends = useFriendsState().data;
  return useMemo(() => {
    const map = new Map<string, Friend[]>();
    for (const friend of friends?.friends ?? []) {
      const address = friend.presence.status === "in_game" ? friend.presence.serverAddress : null;
      if (address === null || address.trim() === "") continue;
      const list = map.get(key(address)) ?? [];
      list.push(friend);
      map.set(key(address), list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.user.displayName.localeCompare(b.user.displayName, undefined, { sensitivity: "base" }));
    }
    return map;
  }, [friends]);
}

/** The friends on one server. */
export function friendsOn(map: Map<string, Friend[]>, address: string): Friend[] {
  return map.get(key(address)) ?? [];
}
