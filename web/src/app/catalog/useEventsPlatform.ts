import { useMemo } from "react";
import { useNavigate } from "react-router";

import type { EventsPlatform, EventsRoute } from "../../../../src/components/events/platform.tsx";

/** The website's page of an event: what **Share** copies and the calendar file links to. */
const PUBLIC_EVENT_PAGE = "https://jknet.app/servers/";

/**
 * The path of a route of the events screens in the web app: `/events` and
 * `/events/:eventId`. The web app creates and edits nothing, so the editor's
 * routes lead to the event, or to the events tab of its community.
 */
export function eventRoutePath(route: EventsRoute): string {
  switch (route.view) {
    case "calendar":
      return "/events";
    case "event":
    case "edit":
      return `/events/${encodeURIComponent(route.id)}`;
    case "new":
      return `/community/${encodeURIComponent(route.communityId)}?tab=events`;
  }
}

/**
 * The web app as a host of the events screens: its routes, the browser's
 * download for the calendar file, and nothing to install or join: the page
 * of an event lists the files with their JKHub links and says that JKNet on
 * the PC prepares the game.
 */
export function useWebEventsPlatform(): EventsPlatform {
  const navigate = useNavigate();
  return useMemo<EventsPlatform>(
    () => ({
      href: eventRoutePath,
      navigate: (route) => void navigate(eventRoutePath(route)),
      eventUrl: (id) => `${PUBLIC_EVENT_PAGE}?event=${encodeURIComponent(id)}`,
    }),
    [navigate],
  );
}
