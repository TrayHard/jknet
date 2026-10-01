/**
 * The computations of the events screens, free of React and of any host:
 * the month grid of the calendar, time zones, the window in which a player
 * may join, the countdown, the calendar file, the checks of the editor and
 * the lists of the Home card and the sidebar.
 *
 * Everything takes the moment it reasons about as an argument, so the unit
 * tests (`logic.test.mjs`) pin the clock, and every time zone is an IANA
 * name read through `Intl`, so no table of offsets goes stale here.
 */

import type { EventCard, EventDetails, EventPatch, NewEventBody } from "./types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** **Join** opens this long before the start and stays open until the end. */
export const JOIN_OPENS_BEFORE = 30 * MINUTE;

/** The shortest and the longest event the service takes. */
export const MIN_LENGTH = 15 * MINUTE;
export const MAX_LENGTH = 7 * DAY;

/** How far ahead an event may start, as the service counts it. */
export const MAX_AHEAD = 366 * DAY;

/** The most «going» answers an event may cap at; `capacity` is 1–1000. */
export const MAX_CAPACITY = 1000;

/** The longest texts of an event. */
export const MAX_TITLE = 100;
export const MAX_DESCRIPTION = 6000;
export const MAX_INSTRUCTIONS = 2000;
/** The most JKHub files an event may require. */
export const MAX_FILES = 30;

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** The wall clock of a moment somewhere. `weekday` is 0 for Monday, 6 for Sunday. */
export interface WallClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `Intl` knows a time zone by this name. */
export function isTimeZone(value: string): boolean {
  if (value.trim() === "") return false;
  try {
    wallFormatter(value);
    return true;
  } catch {
    return false;
  }
}

/** The time zone of this browser or launcher, `UTC` when it says none. */
export function localTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/** A zone `Intl` can use: the one asked for, or the local one when it is unknown or empty. */
export function zoneOr(timeZone: string | null | undefined, fallback: string = localTimeZone()): string {
  return timeZone && isTimeZone(timeZone) ? timeZone : fallback;
}

/** The wall clock of `instant` in `timeZone`. */
export function wallClock(instant: number | Date, timeZone: string): WallClock {
  const at = typeof instant === "number" ? new Date(instant) : instant;
  const parts: Record<string, string> = {};
  for (const part of wallFormatter(timeZone).formatToParts(at)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some engines write midnight as 24 even with `h23`.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in minutes: 180 for Moscow. */
export function offsetMinutes(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / MINUTE);
}

/** An offset as people write it: `UTC+3`, `UTC+5:30`, `UTC−4`, `UTC`. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "−";
  const whole = Math.abs(minutes);
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return `UTC${sign}${hours}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

/** `YYYY-MM-DD` of a wall clock. */
export function dayKeyOf(wall: Pick<WallClock, "year" | "month" | "day">): string {
  return `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** The day of `instant` in `timeZone`, `YYYY-MM-DD`. */
export function dayKey(instant: number, timeZone: string): string {
  return dayKeyOf(wallClock(instant, timeZone));
}

/** `HH:MM` of `instant` in `timeZone`, 24 hours: the value of the editor's time field. */
export function clockOf(instant: number, timeZone: string): string {
  const wall = wallClock(instant, timeZone);
  return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
}

/** The parts of `YYYY-MM-DD`, or `null` when it is not a real day. */
export function parseDay(key: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Minutes after midnight of `HH:MM` (one or two digits for the hour), or `null`. */
export function parseClock(text: string): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The moment a wall clock names in `timeZone`, in milliseconds, or `null`
 * when the day or the time does not parse.
 *
 * Two passes: the wall clock read as UTC, moved by the offset there, and
 * moved again if that lands on the other side of a change of the clocks. A
 * time the spring change skips comes out an hour later, as clocks show it.
 */
export function zonedToInstant(day: string, clock: string, timeZone: string): number | null {
  const date = parseDay(day);
  const minutes = parseClock(clock);
  if (date === null || minutes === null) return null;
  const guess = Date.UTC(date.year, date.month - 1, date.day, Math.floor(minutes / 60), minutes % 60);
  const first = offsetMinutes(guess, timeZone);
  let instant = guess - first * MINUTE;
  const second = offsetMinutes(instant, timeZone);
  if (second !== first) instant = guess - second * MINUTE;
  return instant;
}

/** The IANA names `Intl` knows, sorted, with `UTC` and the given ones always in. */
export function timeZoneNames(always: string[] = []): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  let names: string[] = [];
  try {
    names = supported ? supported("timeZone") : [];
  } catch {
    names = [];
  }
  const all = new Set(names);
  all.add("UTC");
  for (const name of always) if (name && isTimeZone(name)) all.add(name);
  return [...all].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// The month grid
// ---------------------------------------------------------------------------

/** One cell of the month grid. */
export interface GridDay {
  /** `YYYY-MM-DD`. */
  key: string;
  year: number;
  month: number;
  day: number;
  /** 0 for Monday, 6 for Sunday. */
  weekday: number;
  /** The day belongs to the month shown, not to its neighbours. */
  inMonth: boolean;
}

/** A month: its year and its number, 1–12. */
export interface Month {
  year: number;
  month: number;
}

/** The month `delta` months from `month`. */
export function addMonths(month: Month, delta: number): Month {
  const index = month.year * 12 + (month.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** The month of a day key. */
export function monthOf(key: string): Month {
  const day = parseDay(key);
  return day === null ? { year: 1970, month: 1 } : { year: day.year, month: day.month };
}

/**
 * Six weeks of days that cover a month, Monday first: the days of the month
 * and, around them, the days of the months before and after that share
 * their weeks. Always 42 cells, so the grid does not jump between months.
 */
export function monthGrid({ year, month }: Month): GridDay[] {
  const first = Date.UTC(year, month - 1, 1);
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const days: GridDay[] = [];
  for (let cell = 0; cell < 42; cell += 1) {
    const at = new Date(first + (cell - lead) * DAY);
    const wall = { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
    days.push({
      key: dayKeyOf(wall),
      ...wall,
      weekday: cell % 7,
      inMonth: wall.month === month && wall.year === year,
    });
  }
  return days;
}

/** The day after a day key. */
export function nextDay(key: string): string {
  const day = parseDay(key);
  if (day === null) return key;
  const at = new Date(Date.UTC(day.year, day.month - 1, day.day) + DAY);
  return dayKeyOf({ year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() });
}

/**
 * The range of `GET events` for the grid of a month in `timeZone`: midnight
 * of its first cell to midnight after its last, 42 days, under the 62 the
 * service allows.
 */
export function gridRange(month: Month, timeZone: string): { from: string; to: string } {
  const grid = monthGrid(month);
  const from = zonedToInstant(grid[0].key, "00:00", timeZone) ?? Date.UTC(month.year, month.month - 1, 1);
  const to = zonedToInstant(nextDay(grid[grid.length - 1].key), "00:00", timeZone) ?? from + 42 * DAY;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * The days an event touches in `timeZone`, each `YYYY-MM-DD`, at most eight:
 * an event of 7 days that starts late in the evening. An event that ends at
 * midnight sharp does not touch the day after.
 */
export function eventDays(startsAt: string, endsAt: string, timeZone: string): string[] {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start)) return [];
  const last = dayKey(Number.isFinite(end) && end > start ? end - 1 : start, timeZone);
  const days = [dayKey(start, timeZone)];
  while (days[days.length - 1] < last && days.length < 8) days.push(nextDay(days[days.length - 1]));
  return days;
}

/** The events of each day in `timeZone`, each list in the order of the start. */
export function eventsByDay<T extends Pick<EventCard, "startsAt" | "endsAt" | "id">>(events: T[], timeZone: string): Map<string, T[]> {
  const days = new Map<string, T[]>();
  const sorted = [...events].sort(byStart);
  for (const event of sorted) {
    for (const day of eventDays(event.startsAt, event.endsAt, timeZone)) {
      const list = days.get(day);
      if (list) list.push(event);
      else days.set(day, [event]);
    }
  }
  return days;
}

/** The order of the calendar: the start, then the id, as the service sorts. */
export function byStart(a: Pick<EventCard, "startsAt" | "id">, b: Pick<EventCard, "startsAt" | "id">): number {
  const diff = Date.parse(a.startsAt) - Date.parse(b.startsAt);
  if (diff !== 0 && Number.isFinite(diff)) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The state of an event
// ---------------------------------------------------------------------------

/** Where an event is in time: before, during, after, or off. */
export type EventPhase = "upcoming" | "live" | "ended" | "cancelled";

export function eventPhase(event: Pick<EventCard, "startsAt" | "endsAt" | "status">, now: number): EventPhase {
  if (event.status === "cancelled") return "cancelled";
  const start = Date.parse(event.startsAt);
  const end = Date.parse(event.endsAt);
  if (now >= end) return "ended";
  if (now >= start) return "live";
  return "upcoming";
}

/** Whether **Join** is open: from 30 minutes before the start until the end, never for a cancelled event. */
export type JoinState = "early" | "open" | "ended" | "cancelled";

export function joinState(event: Pick<EventCard, "startsAt" | "endsAt" | "status">, now: number): JoinState {
  if (event.status === "cancelled") return "cancelled";
  const start = Date.parse(event.startsAt);
  const end = Date.parse(event.endsAt);
  if (now >= end) return "ended";
  if (now >= start - JOIN_OPENS_BEFORE) return "open";
  return "early";
}

/** When **Join** opens, in milliseconds. */
export function joinOpensAt(event: Pick<EventCard, "startsAt">): number {
  return Date.parse(event.startsAt) - JOIN_OPENS_BEFORE;
}

/** The time left until a moment, in whole days, hours and minutes; zeros once it has come. */
export function countdown(until: number, now: number): { days: number; hours: number; minutes: number } {
  const left = Math.max(0, until - now);
  return {
    days: Math.floor(left / DAY),
    hours: Math.floor((left % DAY) / HOUR),
    minutes: Math.floor((left % HOUR) / MINUTE),
  };
}

/** Every «going» place is taken. */
export function isFull(event: Pick<EventCard, "capacity" | "counts">): boolean {
  return event.capacity !== null && event.counts.going >= event.capacity;
}

/** The reader may answer «going»: a place is free, or the reader holds one already. */
export function canGo(event: Pick<EventCard, "capacity" | "counts" | "viewer">): boolean {
  return !isFull(event) || event.viewer?.rsvp === "going";
}

/** Answers are open: the event is scheduled and has not ended. */
export function answersOpen(event: Pick<EventCard, "startsAt" | "endsAt" | "status">, now: number): boolean {
  const phase = eventPhase(event, now);
  return phase === "upcoming" || phase === "live";
}

/**
 * The counts after the reader moves from one answer to another, before the
 * service confirms: the button moves at once, and the answer of the service
 * replaces the guess.
 */
export function withAnswer<T extends Pick<EventCard, "counts" | "viewer">>(event: T, answer: "going" | "maybe" | null): T {
  const before = event.viewer?.rsvp ?? null;
  if (before === answer) return event;
  const counts = { ...event.counts };
  if (before === "going") counts.going = Math.max(0, counts.going - 1);
  if (before === "maybe") counts.maybe = Math.max(0, counts.maybe - 1);
  if (answer === "going") counts.going += 1;
  if (answer === "maybe") counts.maybe += 1;
  const viewer = event.viewer ?? { rsvp: null, friendsGoing: [] };
  return { ...event, counts, viewer: { ...viewer, rsvp: answer } };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** The reader's «going» events that start in the next `days` days and have not ended: the sidebar's count. */
export function goingSoon(events: EventCard[], now: number, days = 7): EventCard[] {
  const until = now + days * DAY;
  return events.filter(
    (event) =>
      event.viewer?.rsvp === "going" &&
      event.status === "scheduled" &&
      Date.parse(event.endsAt) > now &&
      Date.parse(event.startsAt) < until,
  );
}

/** Why an event is on the Home card. */
export type HomeReason = "going" | "maybe" | "following";

/**
 * The Home card's events: the reader's «going» and «maybe» answers and the
 * events of the communities they follow, scheduled and not over, the
 * soonest first, without repeats.
 */
export function homeEvents(
  answered: EventCard[],
  followed: EventCard[],
  now: number,
  limit = 3,
): Array<{ event: EventCard; reason: HomeReason }> {
  const seen = new Map<string, { event: EventCard; reason: HomeReason }>();
  const take = (event: EventCard, fallback: HomeReason | null) => {
    if (event.status !== "scheduled" || !(Date.parse(event.endsAt) > now)) return;
    const rsvp = event.viewer?.rsvp ?? null;
    const reason: HomeReason | null = rsvp ?? fallback;
    if (reason === null) return;
    const known = seen.get(event.id);
    // An answer says more than a subscription.
    if (known === undefined || (known.reason === "following" && reason !== "following")) seen.set(event.id, { event, reason });
  };
  for (const event of answered) take(event, null);
  for (const event of followed) take(event, "following");
  return [...seen.values()].sort((a, b) => byStart(a.event, b.event)).slice(0, limit);
}

/** The events of a community page: upcoming and live ones first by start, ended ones last, latest first. */
export function splitByTime<T extends Pick<EventCard, "startsAt" | "endsAt" | "status" | "id">>(
  events: T[],
  now: number,
): { upcoming: T[]; past: T[] } {
  const upcoming = events.filter((event) => Date.parse(event.endsAt) > now).sort(byStart);
  const past = events.filter((event) => !(Date.parse(event.endsAt) > now)).sort((a, b) => byStart(b, a));
  return { upcoming, past };
}

// ---------------------------------------------------------------------------
// The calendar file
// ---------------------------------------------------------------------------

/** A moment as iCalendar writes it in UTC: `20261003T160000Z`. */
export function icsDate(instant: number): string {
  return new Date(Math.floor(instant / 1000) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A TEXT value of RFC 5545 §3.3.11: backslash, semicolon, comma and line breaks escaped. */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/**
 * A content line folded as RFC 5545 §3.1 asks: no line longer than 75
 * octets of UTF-8, each continuation starting with one space. A character is
 * never split between two lines.
 */
export function icsFold(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; a continuation holds 74 after its space.
    const room = out.length === 0 ? 75 : 74;
    if (size + bytes > room) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** What the calendar file of an event says beside the times. */
export interface IcsOptions {
  /** The moment the file is written, for `DTSTAMP`. */
  now: number;
  /** The public page of the event. */
  url?: string;
  /** Where the event is, as the reader's language says it. */
  location?: string;
  /** Plain text for the description: the community, the place, the link. */
  description?: string;
}

/**
 * The calendar file of one event: one `VEVENT` with a stable `UID`, times in
 * UTC, the status and the revision as `SEQUENCE`, so a calendar that imports
 * a newer file of the same event replaces the older one. Lines end with
 * CRLF and are folded at 75 octets.
 */
export function icsText(
  event: Pick<EventCard, "id" | "title" | "startsAt" | "endsAt" | "status" | "revision">,
  options: IcsOptions,
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JKNet//Community events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@events.jknet.app`,
    `DTSTAMP:${icsDate(options.now)}`,
    `DTSTART:${icsDate(Date.parse(event.startsAt))}`,
    `DTEND:${icsDate(Date.parse(event.endsAt))}`,
    `SUMMARY:${icsEscape(event.title)}`,
  ];
  if (options.location) lines.push(`LOCATION:${icsEscape(options.location)}`);
  if (options.description) lines.push(`DESCRIPTION:${icsEscape(options.description)}`);
  if (options.url && /^https:\/\/[^\s"<>\\]+$/.test(options.url)) lines.push(`URL:${options.url}`);
  lines.push(`STATUS:${event.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`);
  lines.push(`SEQUENCE:${Math.max(0, Math.trunc(event.revision) || 0)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
}

/** A file name for the calendar file: the Latin letters and digits of the title, or the day of the event. */
export function icsFileName(event: Pick<EventCard, "title" | "startsAt">): string {
  const slug = event.title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (slug !== "") return `${slug}.ics`;
  const day = Number.isFinite(Date.parse(event.startsAt)) ? new Date(event.startsAt).toISOString().slice(0, 10) : "event";
  return `jknet-event-${day}.ics`;
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/**
 * Whether an address is one the service takes for an event: a literal IPv4
 * with a port from 1024 that is globally routable. The same rule as
 * `public_address` of the service, so the form says so before sending.
 */
export function isPublicAddress(text: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(text.trim());
  if (match === null) return false;
  const [a, b, c, d] = [1, 2, 3, 4].map((at) => Number(match[at]));
  const port = Number(match[5]);
  if ([a, b, c, d].some((octet) => octet > 255) || match.slice(1, 5).some((octet) => octet.length > 1 && octet.startsWith("0"))) return false;
  if (port < 1024 || port > 65535) return false;
  const blocked =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 255 && b === 255 && c === 255 && d === 255);
  return !blocked;
}

/** Where an event takes place, as the editor holds it. */
export type EventPlace = "server" | "address" | "offline";

/** The form of the editor: every field as text, as the inputs hold it. */
export interface EventDraft {
  title: string;
  kind: string;
  /** `YYYY-MM-DD` in the organizer's zone. */
  day: string;
  /** `HH:MM` in the organizer's zone. */
  time: string;
  /** Minutes, or `null` for an end of its own. */
  duration: number | null;
  endDay: string;
  endTime: string;
  timezone: string;
  place: EventPlace;
  serverId: string;
  address: string;
  game: "ja" | "jo";
  description: string;
  instructions: string;
  files: Array<{ jkhubId: number; title: string }>;
  bundleId: string | null;
  /** Digits, or empty for no limit. */
  capacity: string;
  cover: string | null;
  notify: boolean;
}

/** The fields a draft can be wrong in. */
export type DraftField = "title" | "start" | "end" | "length" | "timezone" | "server" | "address" | "capacity" | "description" | "instructions" | "files";

/** What is wrong with a draft, field by field, and the times it names. */
export interface DraftCheck {
  errors: Partial<Record<DraftField, string>>;
  startsAt: number | null;
  endsAt: number | null;
}

/**
 * Checks a draft the way the service will, before it is sent. Each error is
 * a code the screen turns into a sentence: `required`, `format`, `past`,
 * `tooFar`, `beforeStart`, `tooShort`, `tooLong`, `unknown`, `range`.
 *
 * `moved` is false for an edit that keeps the start of an event that has
 * already begun: the service lets such a start lie in the past.
 */
export function checkDraft(draft: EventDraft, now: number, moved = true): DraftCheck {
  const errors: Partial<Record<DraftField, string>> = {};
  const title = draft.title.trim();
  if (title === "") errors.title = "required";
  else if (Array.from(title).length > MAX_TITLE || /[\r\n\t]/.test(title)) errors.title = "tooLong";

  const zone = draft.timezone.trim() === "" ? "UTC" : draft.timezone;
  if (!isTimeZone(zone)) errors.timezone = "unknown";
  const usable = errors.timezone === undefined ? zone : "UTC";

  const startsAt = zonedToInstant(draft.day, draft.time, usable);
  if (startsAt === null) errors.start = "format";
  else if (moved && startsAt < now - 5 * MINUTE) errors.start = "past";
  else if (startsAt > now + MAX_AHEAD) errors.start = "tooFar";

  let endsAt: number | null = null;
  if (draft.duration !== null) {
    endsAt = startsAt === null ? null : startsAt + draft.duration * MINUTE;
  } else {
    endsAt = zonedToInstant(draft.endDay, draft.endTime, usable);
    if (endsAt === null) errors.end = "format";
  }
  if (startsAt !== null && endsAt !== null) {
    const length = endsAt - startsAt;
    if (length <= 0) errors.length = "beforeStart";
    else if (length < MIN_LENGTH) errors.length = "tooShort";
    else if (length > MAX_LENGTH) errors.length = "tooLong";
  }

  if (draft.place === "server" && draft.serverId === "") errors.server = "required";
  if (draft.place === "address" && !isPublicAddress(draft.address)) errors.address = draft.address.trim() === "" ? "required" : "format";

  const capacity = draft.capacity.trim();
  if (capacity !== "") {
    const value = /^\d{1,4}$/.test(capacity) ? Number(capacity) : NaN;
    if (!(value >= 1 && value <= MAX_CAPACITY)) errors.capacity = "range";
  }
  if (Array.from(draft.description).length > MAX_DESCRIPTION) errors.description = "tooLong";
  if (Array.from(draft.instructions).length > MAX_INSTRUCTIONS) errors.instructions = "tooLong";
  if (draft.files.length > MAX_FILES) errors.files = "tooLong";
  return { errors, startsAt, endsAt };
}

/** The body of `POST communities/{id}/events` for a checked draft. */
export function draftBody(draft: EventDraft, startsAt: number, endsAt: number): NewEventBody {
  const capacity = draft.capacity.trim();
  const body: NewEventBody = {
    title: draft.title.trim(),
    kind: draft.kind,
    description: draft.description,
    instructions: draft.instructions,
    startsAt: new Date(startsAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
    endsAt: new Date(endsAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
    timezone: draft.timezone.trim(),
    requirements: { files: draft.files, bundleId: draft.bundleId },
    capacity: capacity === "" ? null : Number(capacity),
    cover: draft.cover,
    notifyFollowers: draft.notify,
  };
  if (draft.place === "server") body.serverId = draft.serverId;
  else if (draft.place === "address") {
    body.address = draft.address.trim();
    body.game = draft.game;
  } else body.game = draft.game;
  return body;
}

/** A draft that starts from an event: its own times, or the same times `shiftDays` later. */
export function draftOf(event: EventDetails, shiftDays = 0, fallbackZone: string = localTimeZone()): EventDraft {
  const zone = zoneOr(event.timezone, fallbackZone);
  const start = Date.parse(event.startsAt) + shiftDays * DAY;
  const end = Date.parse(event.endsAt) + shiftDays * DAY;
  const length = Math.round((end - start) / MINUTE);
  const standard = DURATIONS.includes(length);
  return {
    title: event.title,
    kind: event.kind,
    day: dayKey(start, zone),
    time: clockOf(start, zone),
    duration: standard ? length : null,
    endDay: dayKey(end, zone),
    endTime: clockOf(end, zone),
    timezone: zone,
    place: event.server ? "server" : event.address ? "address" : "offline",
    serverId: event.server?.id ?? "",
    address: event.server ? "" : event.address ?? "",
    game: event.game,
    description: event.description,
    instructions: event.instructions,
    files: event.requirements.files.map((file) => ({ jkhubId: file.jkhubId, title: file.title })),
    bundleId: event.requirements.bundle?.id ?? null,
    capacity: event.capacity === null ? "" : String(event.capacity),
    cover: event.cover,
    notify: true,
  };
}

/** The durations the editor offers, in minutes; anything else is an end of its own. */
export const DURATIONS = [30, 60, 90, 120, 180, 240, 360];

/**
 * The fields of a change that differ from the event as it was: the service
 * checks every field it is sent again, so a field left as it was is left out.
 */
export function draftPatch(event: EventDetails, body: NewEventBody): Omit<EventPatch, "revision"> {
  const patch: Omit<EventPatch, "revision"> = {};
  if (body.title !== event.title) patch.title = body.title;
  if (body.kind !== event.kind) patch.kind = body.kind;
  if ((body.description ?? "") !== event.description) patch.description = body.description ?? "";
  if ((body.instructions ?? "") !== event.instructions) patch.instructions = body.instructions ?? "";
  if (Date.parse(body.startsAt) !== Date.parse(event.startsAt)) patch.startsAt = body.startsAt;
  if (Date.parse(body.endsAt) !== Date.parse(event.endsAt)) patch.endsAt = body.endsAt;
  if ((body.timezone ?? "") !== event.timezone) patch.timezone = body.timezone ?? "";
  if (body.serverId !== undefined) {
    if (body.serverId !== event.server?.id) patch.serverId = body.serverId;
  } else if (body.address !== undefined) {
    if (event.server !== null || body.address !== event.address) patch.address = body.address;
    if (body.game !== undefined && body.game !== event.game) patch.game = body.game;
  } else {
    // Outside the game: neither a server nor an address.
    if (event.server !== null) patch.serverId = null;
    else if (event.address !== null) patch.address = null;
    if (body.game !== undefined && body.game !== event.game) patch.game = body.game;
  }
  const files = body.requirements?.files ?? [];
  const bundleId = body.requirements?.bundleId ?? null;
  const sameFiles =
    files.length === event.requirements.files.length &&
    files.every((file, at) => file.jkhubId === event.requirements.files[at].jkhubId && file.title === event.requirements.files[at].title);
  if (!sameFiles || bundleId !== (event.requirements.bundle?.id ?? null)) patch.requirements = { files, bundleId };
  if ((body.capacity ?? null) !== event.capacity) patch.capacity = body.capacity ?? null;
  if ((body.cover ?? null) !== event.cover) patch.cover = body.cover ?? null;
  return patch;
}
