import { useCallback } from "react";

import type { CommunityRequest } from "../../../../src/components/community/types.ts";
import { communityIpc } from "../../../../src/lib/ipc.ts";
import { setCatalogCount } from "./counts.ts";

/** The filters that make a catalogue answer smaller than the whole catalogue. */
const FILTERS = ["q=", "tag=", "language=", "region=", "game="];

/**
 * The `request` the community screens of the web app talk through: the web
 * core's `community_request`, which reads the contract with the player's
 * token where there is one and follows a community with it.
 *
 * A failure reaches the screens as the core threw it — the launcher's
 * envelope of a code, a message and details — and the screens print it in
 * the words of the `community` catalog. The function keeps its identity for
 * the life of the app: the screens read again whenever it changes. The size
 * of the unfiltered catalogue feeds the menu's count.
 */
export function useCommunityRequest(): CommunityRequest {
  return useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const answer = await communityIpc.request<T>(method, path, body);
    if (method === "GET" && (path === "communities" || path.startsWith("communities?")) && !FILTERS.some((filter) => path.includes(filter))) {
      const total = (answer as { total?: unknown }).total;
      if (typeof total === "number") setCatalogCount("community", total);
    }
    return answer;
  }, []) as CommunityRequest;
}
