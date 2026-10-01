/**
 * The wire types of the events of communities (`/v1/community/events…`),
 * one to one with the service's `community/events/wire.rs`.
 *
 * The launcher, the website and the web app read the same shapes through
 * the request of their community platform. Field names are camelCase on
 * the wire; every time is RFC 3339 in UTC to the second.
 */

import type { CommunityBundleRef, CommunityRecommendation, Game } from "../community/types";

/** The kinds of event the service takes, in the order the editor offers them. */
export const EVENT_KINDS = ["tournament", "fun", "training", "clanwar", "rp", "other"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** `cancelled` stays in the calendar; a past event is told by its `endsAt`. */
export type EventStatus = "scheduled" | "cancelled";

/** An answer of a player. «Not going» is the absence of one. */
export type RsvpStatus = "going" | "maybe";

/** The community an event belongs to, as a card names it. */
export interface EventCommunityRef {
  id: string;
  name: string;
  /** SHA-256 of the logo in the store, or `null`. */
  logo: string | null;
}

/** The server of the community an event is on, while the reader may see it. */
export interface EventServerRef {
  id: string;
  label: string;
  game: Game;
  /** `IPv4:port`. */
  address: string;
}

/** An account as an event names it: the author, a friend, an attendee. */
export interface EventPerson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** What the reader is to an event. `null` for a guest. */
export interface EventViewer {
  rsvp: RsvpStatus | null;
  /** Up to 8 friends of the reader who answered «going», the earliest first. */
  friendsGoing: EventPerson[];
  /** On the page of an event only: the reader's role in its community. */
  role?: "owner" | "editor" | null;
  /** On the page of an event only: an administrator of JKNet. */
  isAdmin?: boolean;
}

/** An event in the calendar: `EventCard` of the service. */
export interface EventCard {
  id: string;
  communityId: string;
  community: EventCommunityRef;
  title: string;
  /** One of {@link EVENT_KINDS}; a string, so a kind added later still reads. */
  kind: string;
  startsAt: string;
  endsAt: string;
  /** The organizer's IANA time zone, or `""`. */
  timezone: string;
  game: Game;
  server: EventServerRef | null;
  /** Where to connect: the server's address, the event's own, or `null` outside the game. */
  address: string | null;
  status: EventStatus;
  /** The most «going» answers, or `null` for no limit. */
  capacity: number | null;
  counts: { going: number; maybe: number };
  viewer: EventViewer | null;
  /** SHA-256 of the cover in the store, or `null`. */
  cover: string | null;
  revision: number;
}

/** What an event asks of a player before it starts. */
export interface EventRequirements {
  files: CommunityRecommendation[];
  bundle: CommunityBundleRef | null;
}

/** The page of an event: `Event` of the service. */
export interface EventDetails extends EventCard {
  /** Markdown, up to 6000 characters. */
  description: string;
  /** What to do before the event, Markdown, up to 2000 characters. */
  instructions: string;
  requirements: EventRequirements;
  createdBy: EventPerson | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET events`: the events that cross the range, the earliest first, 500 a
 * page. `next`, passed as `after` with the same range and filters, reads
 * the page after; `null` on the last page. A service from before pages
 * leaves it out.
 */
export interface EventsCalendar {
  events: EventCard[];
  from: string;
  to: string;
  next?: string | null;
}

/** One player who answered, for the organizers. */
export interface EventAttendee {
  user: EventPerson;
  /** When the current answer was given. */
  answeredAt: string;
}

/** `GET events/{id}/attendees`, the earliest answer first. */
export interface EventAttendees {
  going: EventAttendee[];
  maybe: EventAttendee[];
}

/** The requirements a form sends: files and the id of a bundle. */
export interface EventRequirementsBody {
  files: CommunityRecommendation[];
  bundleId: string | null;
}

/** The body of `POST communities/{id}/events`. */
export interface NewEventBody {
  title: string;
  kind: string;
  description?: string;
  instructions?: string;
  startsAt: string;
  endsAt: string;
  timezone?: string;
  /** A server of the community, or… */
  serverId?: string;
  /** …an address of the event's own; neither for an event outside the game. */
  address?: string;
  /** The game of an event without a server. */
  game?: Game;
  requirements?: EventRequirementsBody;
  capacity?: number | null;
  cover?: string | null;
  /** Off: the followers hear nothing of it. On by default. */
  notifyFollowers?: boolean;
}

/**
 * The body of `PUT events/{id}`: a field left out keeps its value, `null`
 * clears it. `status` cancels the event or brings it back.
 */
export interface EventPatch {
  title?: string;
  kind?: string;
  description?: string;
  instructions?: string;
  startsAt?: string;
  endsAt?: string;
  timezone?: string | null;
  serverId?: string | null;
  address?: string | null;
  game?: Game;
  requirements?: EventRequirementsBody | null;
  capacity?: number | null;
  cover?: string | null;
  status?: EventStatus;
  /** The revision the change was made on; another one answers `409`. */
  revision: number;
}

/** Why the service sent a `community.event` frame. */
export type EventFrameKind = "created" | "changed" | "cancelled" | "reminder";

/** The event a frame names. `address` is where to connect, as everyone sees it. */
export interface EventFrameSummary {
  id: string;
  communityId: string;
  communityName: string;
  title: string;
  startsAt: string;
  endsAt: string;
  address: string | null;
}

/**
 * What the launcher's core emits for a `community.event` frame: the frame
 * and whether the launcher window should show a toast of it.
 */
export interface EventNotice {
  kind: EventFrameKind;
  event: EventFrameSummary;
  /** The settings and the window let a toast through. */
  toast: boolean;
}
