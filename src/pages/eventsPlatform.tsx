/**
 * The launcher's events platform: the routes `#/events…`, the core's save
 * dialog, the launcher's JKHub index for the editor and the requirements
 * panel that installs and joins. The cover of an event goes up through the
 * community platform's `pickImage`, the core's open dialog.
 * `CommunityPage` gives it to the events of a community page, `EventsPage`
 * and Home to their own screens.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";

import type { Game } from "../components/community";
import { jkhubId } from "../components/community/types";
import type { EventsPlatform, EventsRoute, JkhubPick } from "../components/events";
import { communityEventsIpc, jkhubIpc } from "../lib/ipc";
import { isTauri } from "../lib/runtime";
import { useInvalidateEvents } from "../lib/useCommunityEvents";
import { LauncherRequirements } from "./eventRequirements";

/** The website's pages: what **Share** copies and the calendar file links to. */
export const PUBLIC_PAGE = "https://jknet.app/servers/";

/** The path of a route of the events screens inside the launcher's router. */
export function eventsPath(route: EventsRoute): string {
  switch (route.view) {
    case "calendar":
      return "/events";
    case "event":
      return `/events/${encodeURIComponent(route.id)}`;
    case "edit":
      return `/events/${encodeURIComponent(route.id)}/edit`;
    case "new": {
      const base = `/community/${encodeURIComponent(route.communityId)}/events/new`;
      return route.copyOf ? `${base}?copy=${encodeURIComponent(route.copyOf)}` : base;
    }
  }
}

/** JKHub files for the editor, out of the launcher's index; a number or a link names one file. */
async function searchJkhub(game: Game, query: string): Promise<JkhubPick[]> {
  const picks: JkhubPick[] = [];
  const id = jkhubId(query);
  if (id !== null) {
    try {
      const file = await jkhubIpc.file(id);
      picks.push({ jkhubId: id, title: file.title });
    } catch {
      // Not a file of JKHub after all: the search below still answers.
    }
  }
  const found = await jkhubIpc.search({ game, query, categoryId: null, sort: "mostDownloaded", page: 1, perPage: 8 });
  for (const card of found.cards) {
    if (!picks.some((pick) => pick.jkhubId === card.id)) picks.push({ jkhubId: card.id, title: card.title });
  }
  return picks;
}

/** The launcher's events platform. */
export function useLauncherEventsPlatform(): EventsPlatform {
  const navigate = useNavigate();
  const invalidate = useInvalidateEvents();
  return useMemo<EventsPlatform>(
    () => ({
      href: (route) => `#${eventsPath(route)}`,
      navigate: (route) => navigate(eventsPath(route)),
      eventUrl: (id) => `${PUBLIC_PAGE}?event=${encodeURIComponent(id)}`,
      saveIcs: isTauri() ? (name, text) => communityEventsIpc.saveIcs(name, text) : undefined,
      searchJkhub: isTauri() ? searchJkhub : undefined,
      renderRequirements: (context) => <LauncherRequirements {...context} />,
      onChanged: invalidate,
    }),
    [navigate, invalidate],
  );
}
