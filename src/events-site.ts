/**
 * The website as a host of the events screens, beside its community screens
 * (`community-site.tsx`): the routes in the address bar and the JKHub
 * catalogue of JKNet Online for the editor. The browser downloads the
 * calendar file itself, and the cover of an event goes up through the
 * community platform's `putBlob`, as the pictures of a page do.
 *
 * | Route | Address |
 * | --- | --- |
 * | the calendar | `/servers/?events` |
 * | an event | `/servers/?event=ID` |
 * | its editor | `/servers/?event=ID&edit` |
 * | a new event of a community | `/servers/?id=COMMUNITY&new-event`, `&copy=ID` for a copy a week later |
 */

import type { Game } from "./components/community/types";
import type { EventsPlatform, EventsRoute, JkhubPick } from "./components/events/platform";

/** The route of the events screens the address names, or `null` for a community screen. */
export function eventsRouteOfSearch(search: string): EventsRoute | null {
  const params = new URLSearchParams(search);
  const event = params.get("event");
  if (event !== null) return params.has("edit") ? { view: "edit", id: event } : { view: "event", id: event };
  const community = params.get("id");
  if (community !== null && params.has("new-event")) {
    const copy = params.get("copy");
    return { view: "new", communityId: community, copyOf: copy ?? undefined };
  }
  if (params.has("events")) return { view: "calendar" };
  return null;
}

/** The query of an events route, relative to the page. */
export function searchOfEvents(route: EventsRoute): string {
  switch (route.view) {
    case "calendar":
      return "?events";
    case "event":
      return `?event=${encodeURIComponent(route.id)}`;
    case "edit":
      return `?event=${encodeURIComponent(route.id)}&edit`;
    case "new":
      return `?id=${encodeURIComponent(route.communityId)}&new-event${route.copyOf ? `&copy=${encodeURIComponent(route.copyOf)}` : ""}`;
  }
}

/** A refusal in the envelope the screens read: code `online`, the contract's code in `details`. */
function refusal(code: string, message: string) {
  return Object.assign(new Error(message), { code: "online", details: { code, message } });
}

export interface SiteEventsDeps {
  /** The service, `https://api.jknet.app`. */
  api: string;
  /** Moves to a route: the address bar and the screen. */
  navigate: (route: EventsRoute) => void;
}

/** The website's events platform. */
export function siteEventsPlatform({ api, navigate }: SiteEventsDeps): EventsPlatform {
  return {
    href: searchOfEvents,
    navigate,
    eventUrl: (id) => `${location.origin}${location.pathname}?event=${encodeURIComponent(id)}`,
    searchJkhub: async (game: Game, query: string): Promise<JkhubPick[]> => {
      const response = await fetch(
        `${api}/v1/jkhub/search?game=${game}&q=${encodeURIComponent(query.trim().slice(0, 200))}&sort=mostDownloaded&page=1&perPage=8`,
        { credentials: "omit" },
      );
      if (!response.ok) throw refusal(response.status === 503 ? "provider_error" : "internal", `HTTP ${response.status}`);
      const body = (await response.json()) as { cards?: Array<{ id?: unknown; title?: unknown }> };
      return (body.cards ?? [])
        .filter((card): card is { id: number; title: string } => typeof card.id === "number" && typeof card.title === "string")
        .map((card) => ({ jkhubId: card.id, title: card.title }));
    },
  };
}
