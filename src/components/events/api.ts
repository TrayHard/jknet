/**
 * A typed client of the events of communities over the transport of the
 * community platform: the launcher's `community_request` bridge, or HTTP on
 * the website and in the web app.
 *
 * Every path is built here, never on a screen. The calendar's query is the
 * one `eventsPath` of the communities client writes, which is the shape the
 * bridges of the launcher and the web app check key by key.
 */

// Runtime imports carry their extension: `node --test` loads this module as it is.
import { eventsPath, failureOf, isCommunityId, type EventsQuery } from "../community/api.ts";
import type { CommunityRequest } from "../community/types";
import type { EventAttendees, EventDetails, EventPatch, EventsCalendar, NewEventBody, RsvpStatus } from "./types";

export type { EventsQuery };

/** An id as a path segment, or a refusal before any request: no event has an id of another shape. */
function segment(value: string): string {
  if (!isCommunityId(value)) {
    throw Object.assign(new Error(`Invalid event id: ${JSON.stringify(value)}`), { code: "notFound" });
  }
  return value;
}

/** The client: one function per route of the events contract. */
export function eventsApi(request: CommunityRequest) {
  const one = (id: string) => `events/${segment(id)}`;
  return {
    /** `GET events`: the events that cross `from`–`to`, at most 62 days. */
    calendar: (query: EventsQuery) => request<EventsCalendar>("GET", eventsPath(query)),
    get: (id: string) => request<EventDetails>("GET", one(id)),
    create: (communityId: string, body: NewEventBody) =>
      request<EventDetails>("POST", `communities/${segment(communityId)}/events`, body),
    update: (id: string, patch: EventPatch) => request<EventDetails>("PUT", one(id), patch),
    remove: (id: string) => request<null>("DELETE", one(id)),
    /** «Going» or «maybe»; the page as the reader now sees it. */
    rsvp: (id: string, status: RsvpStatus) => request<EventDetails>("PUT", `${one(id)}/rsvp`, { status }),
    /** «Not going»: takes the answer back. Always `204`. */
    unrsvp: (id: string) => request<null>("DELETE", `${one(id)}/rsvp`),
    /** The names of who answered, for the organizers. */
    attendees: (id: string) => request<EventAttendees>("GET", `${one(id)}/attendees`),
  };
}

export type EventsApi = ReturnType<typeof eventsApi>;

/** The codes of the contract an events screen tells apart. */
export type EventFailureKind =
  | "full"
  | "cancelled"
  | "over"
  | "changed"
  | "limit"
  | "startsInPast"
  | "tooFar"
  | "length"
  | "server"
  | "address"
  | "relay"
  | "capacity"
  | "timezone"
  | "cover"
  | "text"
  | "files"
  | "other";

/**
 * What a refusal of the events contract means, out of its code and the
 * English message the service wrote. The service names no field, so the
 * editor maps the messages of `community/events/mod.rs` it knows to a field
 * and a sentence of its own; anything else stays `other`.
 */
export function eventFailureKind(error: unknown): EventFailureKind {
  const { code, message } = failureOf(error);
  if (code === "full") return "full";
  if (code === "limit") return "limit";
  if (code === "conflict") {
    if (/cancelled/i.test(message)) return "cancelled";
    if (/is over/i.test(message)) return "over";
    return "changed";
  }
  if (code !== "invalid" && code !== "invalidInput") return "other";
  if (/starts in the future/i.test(message)) return "startsInPast";
  if (/year ahead/i.test(message)) return "tooFar";
  if (/15 minutes to 7 days/i.test(message)) return "length";
  if (/relay/i.test(message)) return "relay";
  if (/server of this community|server of the community|game of its server/i.test(message)) return "server";
  if (/IPv4|address/i.test(message)) return "address";
  if (/capacity/i.test(message)) return "capacity";
  if (/timezone|time zone/i.test(message)) return "timezone";
  if (/picture|cover|MiB/i.test(message)) return "cover";
  if (/JKHub|bundle/i.test(message)) return "files";
  if (/characters|one line|Text must/i.test(message)) return "text";
  return "other";
}
