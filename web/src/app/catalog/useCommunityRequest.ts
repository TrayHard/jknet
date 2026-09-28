import { useCallback, useEffect, useRef } from "react";

import type { CommunityRequest } from "../../../../src/components/community/types.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { communityIpc } from "../../../../src/lib/ipc.ts";
import { setCatalogCount } from "./counts.ts";

/**
 * The `request` a `CommunityBrowser` of the web app talks through: the web
 * core's `community_request`, which reads the catalog with the player's
 * token where the route wants one.
 *
 * The browser prints a failure's message as it is, so a refusal is turned
 * into the sentence the rest of the app shows for it. The function keeps its
 * identity for the life of the screen: the browser loads again whenever it
 * changes. The size of the public list feeds the menu's count.
 */
export function useCommunityRequest(): CommunityRequest {
  const errorText = useErrorText();
  const text = useRef(errorText);
  useEffect(() => {
    text.current = errorText;
  }, [errorText]);

  return useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    let answer: T;
    try {
      answer = await communityIpc.request<T>(method, path, body);
    } catch (error) {
      throw new Error(text.current(error));
    }
    if (method === "GET" && path === "servers") {
      const servers = (answer as { servers?: unknown }).servers;
      if (Array.isArray(servers)) setCatalogCount("community", servers.length);
    }
    return answer;
  }, []) as CommunityRequest;
}
