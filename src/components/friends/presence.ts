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

export const GROUP_TITLES: Record<Group, string> = {
  in_game: "In game",
  online: "Online",
  offline: "Offline",
};

/**
 * The status line of a row.
 *
 * A friend in a game is the only interesting case: their line names the
 * server, because that is what the Join button will connect to. A server with
 * no name — nobody has scanned it recently — falls back to its address rather
 * than to "Playing on undefined".
 */
export function statusLine(presence: Presence): string {
  if (presence.status === "in_game") {
    const { serverName, serverAddress } = presence;
    if (serverName && serverAddress) return `Playing on ${serverName} · ${serverAddress}`;
    if (serverAddress) return `Playing on ${serverAddress}`;
    return "In game";
  }
  if (presence.status === "online") return "Online";
  return lastSeen(presence.since);
}

/**
 * "Last seen 20 minutes ago", down to a date once it stops being useful.
 *
 * The service sends RFC 3339, and a launcher whose clock is behind the service's would
 * otherwise print a time in the future; a difference below a minute reads as
 * "just now" either way.
 */
export function lastSeen(since: string): string {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return "Offline";

  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "Last seen just now";
  if (minutes < 60) return `Last seen ${plural(minutes, "minute")} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${plural(hours, "hour")} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `Last seen ${plural(days, "day")} ago`;
  return `Last seen on ${new Date(at).toLocaleDateString()}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
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
