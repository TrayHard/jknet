/**
 * --- slice: web app ---
 *
 * The rows of the **Devices and sessions** card, without React: which icon a
 * session gets, its tags, its name, the order of the list and how long ago
 * the device was last seen. The launcher's Settings · Account and the web
 * app's sessions screen draw the same card, so they say the same thing.
 */

import type { DeviceSession } from "../../lib/ipc";

/** The icon of a row: a monitor for a launcher, a phone or a globe for the web app. */
export type SessionIcon = "launcher" | "phone" | "desktop";

/** The small tags after a row's name, as keys of `account:devices`. */
export type SessionTag = "thisDevice" | "online" | "pushOn";

/**
 * The icon of a session. A web session without a known kind reads as a
 * phone, like a friend's presence without one; an unknown client as a
 * launcher, the only other thing that signs in.
 */
export function sessionIcon(session: DeviceSession): SessionIcon {
  if (session.client !== "web") return "launcher";
  return session.device === "desktop" ? "desktop" : "phone";
}

/** The tags of a row, in the order they are drawn. */
export function sessionTags(session: DeviceSession): SessionTag[] {
  const tags: SessionTag[] = [];
  if (session.current) tags.push("thisDevice");
  if (session.online) tags.push("online");
  if (session.push) tags.push("pushOn");
  return tags;
}

/** The name the device gave itself, or `null` for "Unnamed device". */
export function sessionName(session: DeviceSession): string | null {
  const name = (session.deviceName ?? "").trim();
  return name === "" ? null : name;
}

/**
 * This device first, then the others as the service ordered them: the most
 * recently used first. A copy; the list of the query stays as it came.
 */
export function orderSessions(sessions: DeviceSession[]): DeviceSession[] {
  return [...sessions.filter((session) => session.current), ...sessions.filter((session) => !session.current)];
}

/** Whether a row has a **Sign out** of its own: every row but this device's. */
export function canSignOut(session: DeviceSession): boolean {
  return !session.current;
}

/** Whether **Sign out of all other devices** has anything to do. */
export function hasOthers(sessions: DeviceSession[]): boolean {
  return sessions.some((session) => !session.current);
}

/** A span of time `Intl.RelativeTimeFormat` can say, rounded down to one unit. */
export interface RelativeAge {
  value: number;
  unit: "minute" | "hour" | "day" | "week" | "month";
}

/**
 * How long ago `at` was, in the largest whole unit: "5 minutes ago",
 * "3 days ago". A time in the future, from a clock ahead of the service's,
 * reads as now; a string that is not a date as `null`.
 */
export function relativeAge(at: string, now: number): RelativeAge | null {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 60) return { value: minutes, unit: "minute" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: "hour" };
  const days = Math.floor(hours / 24);
  if (days < 7) return { value: days, unit: "day" };
  if (days < 30) return { value: Math.floor(days / 7), unit: "week" };
  return { value: Math.floor(days / 30), unit: "month" };
}
