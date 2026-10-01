/**
 * The launcher's side of the events of communities that lives outside the
 * events screens: the count of **Events** in the sidebar, the frames the
 * core forwards from the live socket, and the words the core needs for its
 * Windows notifications.
 *
 * The events screens read the service through the community platform and
 * keep their reads themselves (`components/events`); the sidebar count is a
 * React Query read, so an answer, a change made by an organizer and a frame
 * of the socket all refresh it by invalidating {@link eventsKeys}.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { eventsPath } from "../components/community/api";
import { DAY, goingSoon, HOUR } from "../components/events/logic";
import type { CommunityPostSummary } from "../components/community/types";
import type { EventCard, EventNotice } from "../components/events/types";
import { hasBackend, listen, type UnlistenFn } from "./backend";
import { communityEventsIpc, communityIpc, type Game } from "./ipc";
import { useAccountState, useActiveGame } from "./queries";
import { isTauri } from "./runtime";

/** Every window: a `community.event` frame arrived (`community_events.rs`). */
export const COMMUNITY_EVENT = "community:event";
/** The launcher window: a click on a Windows notification asks for an event's page. */
export const COMMUNITY_OPEN_EVENT = "community:open-event";
// --- slice: community news ---
/** Every window: a `community.post` frame arrived. */
export const COMMUNITY_POST = "community:post";
/** The launcher window: a click on a Windows notification asks for the news of a community. */
export const COMMUNITY_OPEN_POST = "community:open-post";

/** What the core emits for a `community.post` frame: the post and whether a toast may show it. */
export interface PostNotice {
  post: CommunityPostSummary;
  toast: boolean;
}

export const eventsKeys = {
  all: ["communityEvents"] as const,
  goingSoon: (account: string, game: Game) => ["communityEvents", "goingSoon", account, game] as const,
};

/** The reads of events the launcher keeps in React Query, to read again after a change. */
export function useInvalidateEvents(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: eventsKeys.all });
  }, [queryClient]);
}

/**
 * How many events of the active game the player answered «going» that start
 * in the next 7 days and have not ended: the count beside **Events**.
 * `undefined` while signed out, while it loads, and at zero, so the sidebar
 * draws no counter rather than a zero.
 */
export function useGoingSoonCount(): number | undefined {
  const account = useAccountState().data;
  const signedIn = account?.onlineSignedIn ?? false;
  const accountId = account?.onlineUser?.id ?? "";
  const game = useActiveGame();
  const query = useQuery({
    queryKey: eventsKeys.goingSoon(accountId, game),
    queryFn: async () => {
      const now = Date.now();
      const answer = await communityIpc.request<{ events: EventCard[] }>(
        "GET",
        eventsPath({
          from: new Date(now - HOUR).toISOString(),
          to: new Date(now + 7 * DAY).toISOString(),
          scope: "going",
          game,
        }),
      );
      return goingSoon(answer.events, Date.now()).length;
    },
    enabled: signedIn && hasBackend(),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });
  return signedIn && query.data ? query.data : undefined;
}

/**
 * Hears the core's `community:event` and `community:open-event`: the first
 * refreshes the reads of events and hands the frame on, the second asks for
 * the page of an event. Mount once, in the launcher window.
 */
export function useCommunityEventNotices(onNotice: (notice: EventNotice) => void, onOpen: (eventId: string) => void): void {
  const invalidate = useInvalidateEvents();
  const handlers = useRef({ onNotice, onOpen });
  handlers.current = { onNotice, onOpen };
  useEffect(() => {
    if (!hasBackend()) return;
    let disposed = false;
    const stops: UnlistenFn[] = [];
    const keep = (stop: UnlistenFn) => {
      if (disposed) stop();
      else stops.push(stop);
    };
    void listen<EventNotice>(COMMUNITY_EVENT, (event) => {
      invalidate();
      handlers.current.onNotice(event.payload);
    }).then(keep, () => undefined);
    void listen<string>(COMMUNITY_OPEN_EVENT, (event) => handlers.current.onOpen(event.payload), { target: "own" }).then(keep, () => undefined);
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [invalidate]);
}

/**
 * Hears the core's `community:post` and `community:open-post`: the first
 * hands a post of the news on, the second asks for the news of a
 * community. Mount once, in the launcher window.
 */
export function useCommunityPostNotices(onNotice: (notice: PostNotice) => void, onOpen: (communityId: string) => void): void {
  const handlers = useRef({ onNotice, onOpen });
  handlers.current = { onNotice, onOpen };
  useEffect(() => {
    if (!hasBackend()) return;
    let disposed = false;
    const stops: UnlistenFn[] = [];
    const keep = (stop: UnlistenFn) => {
      if (disposed) stop();
      else stops.push(stop);
    };
    void listen<PostNotice>(COMMUNITY_POST, (event) => handlers.current.onNotice(event.payload)).then(keep, () => undefined);
    void listen<string>(COMMUNITY_OPEN_POST, (event) => handlers.current.onOpen(event.payload), { target: "own" }).then(keep, () => undefined);
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);
}

/**
 * Hands the core the words of its Windows notifications of events and news,
 * in the language on screen, whenever it changes. The slots stay for the
 * core to fill: `{community}`, `{title}`, `{when}`, `{place}`.
 */
export function useCommunityEventLabels(): void {
  const { t, i18n } = useTranslation("events");
  useEffect(() => {
    if (!isTauri()) return;
    const slots = { community: "{community}", title: "{title}", when: "{when}", place: "{place}" };
    void communityEventsIpc
      .setLabels({
        created: t("notify.created", slots),
        createdText: t("notify.createdText", slots),
        changed: t("notify.changed", slots),
        changedText: t("notify.changedText", slots),
        cancelled: t("notify.cancelled", slots),
        cancelledText: t("notify.cancelledText", slots),
        reminder: t("notify.reminder", slots),
        reminderText: t("notify.reminderText", slots),
        offline: t("place.offline"),
        post: t("notify.post", slots),
      })
      .catch((error: unknown) => console.warn("community events: the labels did not reach the core", error));
  }, [t, i18n.language]);
}
