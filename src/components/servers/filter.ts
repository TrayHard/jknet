/**
 * Filtering, tabs and sorting for the server table.
 *
 * Pure functions on purpose: the screen holds the state and this module holds
 * the rules, so a wrong row on screen can be reasoned about without React.
 */

import type { ServerInfo } from "../../lib/ipc";

export type ServerTab = "all" | "trusted" | "favorites" | "history" | "lan";

export type PlayersFilter = "any" | "not-empty" | "not-full";

export interface ServerFilters {
  /** Matched against the name, the map and the address. */
  search: string;
  /** `gametype` as text, or `any`. */
  gametype: string;
  /** `fs_game` value, or `any`. */
  game: string;
  players: PlayersFilter;
  /** Network protocol as text, or `any`. */
  protocol: string;
}

export const NO_FILTERS: ServerFilters = {
  search: "",
  gametype: "any",
  game: "any",
  players: "any",
  protocol: "any",
};

/** True when nothing is filtered, which is what disables **Reset filters**. */
export function filtersAreEmpty(filters: ServerFilters): boolean {
  return (
    filters.search.trim() === "" &&
    filters.gametype === "any" &&
    filters.game === "any" &&
    filters.players === "any" &&
    filters.protocol === "any"
  );
}

/**
 * One row against the search box.
 *
 * The clean name is searched, not the raw one: a player typing `blue` means
 * the name they see, not `^4blue`. The address is searched too, because
 * pasting `81.19.210.136:29070` from a Discord message is how half the
 * connections start.
 */
export function matchesSearch(server: ServerInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    server.hostnameClean.toLowerCase().includes(needle) ||
    server.map.toLowerCase().includes(needle) ||
    server.address.toLowerCase().includes(needle) ||
    server.game.toLowerCase().includes(needle)
  );
}

/** True when the row survives the players dropdown. */
export function matchesPlayers(
  server: ServerInfo,
  filter: PlayersFilter,
): boolean {
  switch (filter) {
    case "not-empty":
      return server.clients > 0;
    case "not-full":
      // A server with no slot count published cannot be full.
      return server.maxClients === 0 || server.clients < server.maxClients;
    default:
      return true;
  }
}

/** Applies every dropdown and the search box. */
export function applyFilters(
  servers: ServerInfo[],
  filters: ServerFilters,
): ServerInfo[] {
  return servers.filter(
    (server) =>
      matchesSearch(server, filters.search) &&
      matchesPlayers(server, filters.players) &&
      (filters.gametype === "any" ||
        String(server.gametype) === filters.gametype) &&
      (filters.game === "any" || server.game === filters.game) &&
      (filters.protocol === "any" ||
        String(server.protocol) === filters.protocol),
  );
}

/**
 * Narrows the list to one tab.
 *
 * History keeps the order of `historyAddresses`, newest first, because the
 * point of that tab is "where was I yesterday" and not "who is busiest".
 */
export function applyTab(
  servers: ServerInfo[],
  tab: ServerTab,
  historyAddresses: string[],
): ServerInfo[] {
  switch (tab) {
    case "trusted":
      return servers.filter((server) => server.trusted);
    case "favorites":
      return servers.filter((server) => server.favorite);
    case "history": {
      const byAddress = new Map(servers.map((row) => [row.address, row]));
      return historyAddresses
        .map((address) => byAddress.get(address))
        .filter((row): row is ServerInfo => row !== undefined);
    }
    case "lan":
      return [];
    default:
      return servers;
  }
}

export type SortColumn = "name" | "map" | "mode" | "players" | "ping" | "mod";
export type SortDirection = "asc" | "desc";

/** How a column sorts when it is clicked for the first time. */
export const DEFAULT_DIRECTION: Record<SortColumn, SortDirection> = {
  name: "asc",
  map: "asc",
  mode: "asc",
  players: "desc",
  ping: "asc",
  mod: "asc",
};

function compareBy(
  column: SortColumn,
  a: ServerInfo,
  b: ServerInfo,
): number {
  switch (column) {
    case "name":
      return a.hostnameClean.localeCompare(b.hostnameClean, undefined, {
        sensitivity: "base",
      });
    case "map":
      return a.map.localeCompare(b.map, undefined, { sensitivity: "base" });
    case "mode":
      return a.gametypeLabel.localeCompare(b.gametypeLabel);
    case "players":
      return a.clients - b.clients;
    case "ping":
      return a.pingMs - b.pingMs;
    case "mod":
      return a.game.localeCompare(b.game);
  }
}

/**
 * Sorts a copy of the list.
 *
 * The address breaks every tie, so two identical rows never swap places
 * between two refreshes and the selection stays where the player left it.
 */
export function sortServers(
  servers: ServerInfo[],
  column: SortColumn,
  direction: SortDirection,
): ServerInfo[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...servers].sort((a, b) => {
    const primary = compareBy(column, a, b);
    if (primary !== 0) return primary * sign;
    return a.address.localeCompare(b.address);
  });
}

/** The distinct values of one key, for a dropdown. */
export function distinctValues<Key extends keyof ServerInfo>(
  servers: ServerInfo[],
  key: Key,
): string[] {
  const seen = new Set<string>();
  for (const server of servers) seen.add(String(server[key]));
  return [...seen].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}
