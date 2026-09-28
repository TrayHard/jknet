import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useActiveGame } from "../../../src/lib/game.ts";
import { chatIpc, type ChatStateView } from "../../../src/lib/ipc.ts";
import { chatKeys, useFriendsState } from "../../../src/lib/queries.ts";
import { useCatalogCount } from "./catalog/counts.ts";
import type { Section } from "./routeTable.ts";

export interface NavCounter {
  /** Asks for attention. */
  badge?: number | "@";
  /** Only informs. */
  count?: number;
}

export interface NavCounters {
  bySection: Partial<Record<Section, NavCounter>>;
  /** Conversations with unread messages: the tab title and the app badge. */
  unreadChats: number;
  /** Whether chats or friends ask for attention: the dot on the phone's menu button. */
  attention: boolean;
}

/**
 * The counters of the menu and the rail, out of what the app already holds.
 *
 * A badge asks for attention: chats with unread messages (`@` when one of
 * them mentions me), incoming friend requests and live server invites. A
 * muted count only informs: friends online, the community servers, the
 * bundles of the active game. A catalog's count appears once its screen has
 * loaded the list (`catalog/counts.ts`): no request is ever made for a
 * counter.
 *
 * The chat state is read from the query cache and never fetched here: the
 * chat's own provider loads and keeps it.
 */
export function useNavCounters(): NavCounters {
  const chat = useQuery<ChatStateView>({
    queryKey: chatKeys.state,
    queryFn: chatIpc.getState,
    enabled: false,
  }).data;
  const friends = useFriendsState().data;
  const game = useActiveGame();
  const community = useCatalogCount("community");
  const bundles = useCatalogCount(`bundles:${game}`);

  return useMemo(() => {
    const bySection: Partial<Record<Section, NavCounter>> = {};

    let unreadChats = 0;
    let mention = false;
    if (chat !== undefined && chat.signedIn && chat.available) {
      for (const conversation of chat.conversations) {
        if (conversation.unreadMentions > 0) mention = true;
        if (conversation.unread > 0 && conversation.notify !== "mute") unreadChats += 1;
      }
    }
    if (mention) bySection.chats = { badge: "@" };
    else if (unreadChats > 0) bySection.chats = { badge: unreadChats };

    if (friends !== undefined && friends.signedIn) {
      const now = Date.now();
      const invites = friends.invites.filter((invite) => {
        const expires = Date.parse(invite.expiresAt);
        return Number.isNaN(expires) || expires > now;
      }).length;
      const asks = friends.incoming.length + invites;
      const online = friends.friends.filter((friend) => friend.presence.status !== "offline").length;
      bySection.friends = asks > 0 ? { badge: asks } : { count: online };
    }

    if (community !== undefined) bySection.community = { count: community };
    if (bundles !== undefined) bySection.bundles = { count: bundles };

    return {
      bySection,
      unreadChats,
      attention: bySection.chats?.badge !== undefined || bySection.friends?.badge !== undefined,
    };
  }, [chat, friends, community, bundles]);
}

/**
 * `(3) JKNet` in the tab while three conversations have unread messages, and
 * the same number on the installed app's icon where the browser allows it.
 */
export function useUnreadTitle(unreadChats: number): void {
  useEffect(() => {
    document.title = unreadChats > 0 ? `(${unreadChats}) JKNet` : "JKNet";
    const badge = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    try {
      if (unreadChats > 0) void badge.setAppBadge?.(unreadChats)?.catch(() => undefined);
      else void badge.clearAppBadge?.()?.catch(() => undefined);
    } catch {
      // A browser that has the method but refuses it outside an installed app.
    }
  }, [unreadChats]);
}
