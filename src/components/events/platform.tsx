/**
 * What the host of the events screens gives them, beside the community
 * platform they already sit under.
 *
 * The events screens are drawn by the same three hosts as the community
 * screens — the launcher, the website and the web app — and talk to the
 * service through the community platform's `request`. This second context
 * carries what only events need: their routes, saving a calendar file,
 * uploading a cover, searching JKHub for the editor and the launcher's
 * preparation of a client. A host that leaves a capability out gets the
 * plain fallback: a download of the browser, no editor, links to JKHub.
 *
 * | | launcher | website | web app |
 * | --- | --- | --- | --- |
 * | routes | `#/events`, `#/events/:id`, `…/edit`, `#/community/:id/events/new` | `?events`, `?event=`, `&edit`, `?id=&new-event` | `/events`, `/events/:id` |
 * | `saveIcs` | the core's save dialog | a download | a download |
 * | `pickCover` | the core's open dialog and `PUT /v1/blobs` | a file input and `PUT /v1/blobs` | — |
 * | `searchJkhub` | the launcher's index | `GET /v1/jkhub/search` | — |
 * | `renderRequirements` | client, install, join | — | — |
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { Game } from "../community/types";
import { useCommunityPlatform } from "../community/platform";
import { eventsApi, type EventsApi } from "./api";
import { localTimeZone } from "./logic";
import type { EventDetails } from "./types";

/** Where the events screens are. */
export type EventsRoute =
  | { view: "calendar" }
  | { view: "event"; id: string }
  | { view: "edit"; id: string }
  /** The editor of a new event; `copyOf` fills it from an event a week later. */
  | { view: "new"; communityId: string; copyOf?: string };

/** A file of JKHub the editor found. */
export interface JkhubPick {
  jkhubId: number;
  title: string;
  /** The category, as JKHub names it. */
  category?: string;
}

/** What the launcher's requirements panel is given. */
export interface RequirementsContext {
  event: EventDetails;
  /** The moment the page reasons about: **Join** opens 30 minutes before the start. */
  now: number;
  /** What to do before the event, drawn by the page; the panel puts it above its buttons. */
  instructions: ReactNode;
}

export interface EventsPlatform {
  href: (route: EventsRoute) => string;
  navigate: (route: EventsRoute) => void;
  /** The public page of an event, for **Share** and the calendar file. */
  eventUrl: (id: string) => string;
  /**
   * Saves a calendar file. Answers the name it was saved under, or `null`
   * when the player cancelled. Without it the browser downloads the file.
   */
  saveIcs?: (fileName: string, text: string) => Promise<string | null>;
  /** Picks a picture and uploads it: its SHA-256, or `null` when the player cancelled. */
  pickCover?: () => Promise<string | null>;
  /** Finds JKHub files for the editor's requirements. */
  searchJkhub?: (game: Game, query: string) => Promise<JkhubPick[]>;
  /** The launcher's client, files, **Prepare client** and **Join**. */
  renderRequirements?: (context: RequirementsContext) => ReactNode;
  /** An answer or an organizer's change went through: the launcher refreshes its sidebar. */
  onChanged?: () => void;
  /** The reader's time zone; the browser's when the host says none. */
  timeZone?: string;
}

const EventsContext = createContext<EventsPlatform | null>(null);

export function EventsPlatformProvider({ platform, children }: { platform: EventsPlatform; children: ReactNode }) {
  return <EventsContext.Provider value={platform}>{children}</EventsContext.Provider>;
}

/** The events host, or `null` where a host has none: a community page then draws no events. */
export function useOptionalEventsPlatform(): EventsPlatform | null {
  return useContext(EventsContext);
}

/** The events host. Every events screen sits under an {@link EventsPlatformProvider}. */
export function useEventsPlatform(): EventsPlatform {
  const platform = useContext(EventsContext);
  if (platform === null) throw new Error("Events screens need an EventsPlatformProvider");
  return platform;
}

/** The events client over the community platform's transport. */
export function useEventsApi(): EventsApi {
  const { request } = useCommunityPlatform();
  return useMemo(() => eventsApi(request), [request]);
}

/** The reader's time zone. */
export function useTimeZone(): string {
  const platform = useOptionalEventsPlatform();
  return platform?.timeZone ?? localTimeZone();
}
