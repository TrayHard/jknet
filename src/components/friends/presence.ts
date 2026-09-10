/**
 * Turning a `Presence` into the line under a friend's name.
 *
 * Pure functions with no React in them, so the Friends screen, the panel and
 * the invite toast all say the same thing about the same friend.
 */

import type { Friend, Presence } from "../../lib/ipc";

/** The three groups the screen sorts friends into, in the order it shows them. */
export const GROUPS = ["in_game", "online", "offline"] as const;

export type Group = (typeof GROUPS)[number];

// --- slice: i18n ---
/**
 * What a status line should say, as a key of the `friends` catalog and the
 * values that fill it.
 *
 * A descriptor rather than a sentence, so this module stays free of English
 * and the decisions in it stay readable without a translation layer. The hook
 * that turns one into words is `useStatusLine` in
 * `src/components/friends/useStatusLine.ts`.
 */
export interface StatusLine {
  key: string;
  values?: Record<string, unknown>;
  /** An RFC 3339 stamp the caller has to format as a date itself. */
  date?: string;
}

/**
 * The status line of a row.
 *
 * A friend in a game is the only interesting case: their line names the
 * server, because that is what the Join button will connect to. A server with
 * no name — nobody has scanned it recently — falls back to its address rather
 * than to "Playing on undefined".
 */
export function statusLine(presence: Presence): StatusLine {
  if (presence.status === "in_game") {
    const { serverName, serverAddress } = presence;
    if (serverName && serverAddress) {
      return {
        key: "status.playingOn",
        values: { server: serverName, address: serverAddress },
      };
    }
    if (serverAddress) {
      return { key: "status.playingOnAddress", values: { address: serverAddress } };
    }
    return { key: "status.inGame" };
  }
  if (presence.status === "online") return { key: "status.online" };
  return lastSeen(presence.since);
}

/**
 * "Last seen 20 minutes ago", down to a date once it stops being useful.
 *
 * The service sends RFC 3339, and a launcher whose clock is behind the service's would
 * otherwise print a time in the future; a difference below a minute reads as
 * "just now" either way.
 */
export function lastSeen(since: string): StatusLine {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return { key: "status.offline" };

  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return { key: "status.lastSeenJustNow" };
  if (minutes < 60) return { key: "status.lastSeenMinutes", values: { count: minutes } };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "status.lastSeenHours", values: { count: hours } };

  const days = Math.floor(hours / 24);
  if (days < 7) return { key: "status.lastSeenDays", values: { count: days } };
  return { key: "status.lastSeenOn", date: since };
}

/** `jkhub:kyle_k`, the second line of the detail panel. */
export function providerHandle(friend: Friend): string {
  const { provider, providerName } = friend.user;
  if (!providerName) return provider;
  return `${provider}:${providerName}`;
}

/**
 * Splits the list into the three groups, each sorted by name.
 *
 * Sorting by name rather than by "most recently seen" on purpose: the list is
 * read by eye, and a group whose order changes on every presence event is
 * unusable with a mouse.
 */
export function groupFriends(friends: Friend[]): Record<Group, Friend[]> {
  const groups: Record<Group, Friend[]> = { in_game: [], online: [], offline: [] };
  for (const friend of friends) {
    // A status the launcher does not know goes to Offline rather than off the
    // end of the record. These three are the contract, but the contract is a
    // document and this value came off a socket.
    const group = groups[friend.presence.status] ?? groups.offline;
    group.push(friend);
  }
  for (const group of GROUPS) {
    groups[group].sort((a, b) =>
      a.user.displayName.localeCompare(b.user.displayName, undefined, {
        sensitivity: "base",
      }),
    );
  }
  return groups;
}

/**
 * Whether the search box matches a friend.
 *
 * The same box adds friends, so it searches everything a query may name: the
 * display name, the provider handle and the server they are on.
 */
export function matchesSearch(friend: Friend, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  return [
    friend.user.displayName,
    friend.user.providerName,
    providerHandle(friend),
    friend.presence.serverName ?? "",
    friend.presence.serverAddress ?? "",
  ].some((field) => field.toLowerCase().includes(needle));
}

/** Whether a friend can be joined right now. */
export function canJoin(friend: Friend): boolean {
  return (
    friend.presence.status === "in_game" &&
    (friend.presence.serverAddress ?? "").trim() !== ""
  );
}

/** The server the player is on, or `null` when they are not on one. */
export function myServer(
  presence: Presence,
): { address: string; name: string | null } | null {
  if (presence.status !== "in_game") return null;
  const address = (presence.serverAddress ?? "").trim();
  if (address === "") return null;
  return { address, name: presence.serverName };
}
