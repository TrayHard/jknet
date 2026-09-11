/**
 * Filtering, tabs and sorting for the server table.
 *
 * Pure functions on purpose: the screen holds the state and this module holds
 * the rules, so a wrong row on screen can be reasoned about without React.
 */

import type { ServerInfo, ServerScope } from "../../lib/ipc";

// --- slice: servers browser ---
/**
 * The tabs of the browser, which are also the scopes the core scans under.
 *
 * One name for both on purpose: every tab has its own scan and its own loader,
 * and a tab the core has never heard of would have no way to fill itself.
 */
export type ServerTab = ServerScope;

export type PlayersFilter = "any" | "not-empty" | "not-full";

export interface ServerFilters {
  /** Matched against the name, the map and the address. */
  search: string;
  /** `gametype` as text, or `any`. */
  gametype: string;
  // --- slice: game core ---
  /** `fs_game` value, or `any`. Called `game` until 0.3, when that name went
   * to the game the server plays. This one is the mod. */
  modName: string;
  players: PlayersFilter;
  /** Network protocol as text, or `any`. */
  protocol: string;
  /** Drops the servers where every client is a bot. On by default. */
  hideBotOnly: boolean;
}

/**
 * The state the screen opens in and **Reset filters** returns to.
 *
 * `hideBotOnly` starts on: a list where two thirds of the "players" are bots
 * is a list nobody can read, and the option is one click away in the filter
 * row for anyone who wants those servers back.
 */
export const DEFAULT_FILTERS: ServerFilters = {
  search: "",
  gametype: "any",
  modName: "any",
  players: "any",
  protocol: "any",
  hideBotOnly: true,
};

/** True when every filter is where it started, which disables **Reset filters**. */
export function filtersAreDefault(filters: ServerFilters): boolean {
  return (
    filters.search.trim() === "" &&
    filters.gametype === "any" &&
    filters.modName === "any" &&
    filters.players === "any" &&
    filters.protocol === "any" &&
    filters.hideBotOnly === DEFAULT_FILTERS.hideBotOnly
  );
}

/**
 * Players the browser counts on one row: people, never bots.
 *
 * `humans` is `null` only while `playersSource` is `unknown` — a server that
 * publishes no `g_humanplayers` and did not answer `getstatus` either. There
 * the server's own total is the best guess there is, and the row shows it
 * without a bot suffix rather than claiming an empty server.
 */
export function realPlayers(server: ServerInfo): number {
  return server.humans ?? server.clients;
}

/** Bots on one row, and zero while the split is unknown. */
export function botCount(server: ServerInfo): number {
  return server.bots ?? 0;
}

/** True when the server has clients and every one of them is a bot. */
export function isBotOnly(server: ServerInfo): boolean {
  return server.clients > 0 && server.humans === 0;
}

/** Real players over a whole list, for the count in the header. */
export function totalRealPlayers(servers: ServerInfo[]): number {
  return servers.reduce((sum, server) => sum + realPlayers(server), 0);
}

/** Bots over a whole list, for the "K bots hidden from counts" tail. */
export function totalBots(servers: ServerInfo[]): number {
  return servers.reduce((sum, server) => sum + botCount(server), 0);
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
    server.modName.toLowerCase().includes(needle)
  );
}

/**
 * True when the row survives the players dropdown.
 *
 * "Not empty" means a person is on the server, not a client of any kind: a
 * lobby of eight bots is exactly what the player picking this option wants to
 * skip. "Not full" counts every client, bots included, because a bot occupies
 * a slot as firmly as a person does.
 */
export function matchesPlayers(
  server: ServerInfo,
  filter: PlayersFilter,
): boolean {
  switch (filter) {
    case "not-empty":
      return realPlayers(server) > 0;
    case "not-full":
      // A server with no slot count published cannot be full.
      return server.maxClients === 0 || server.clients < server.maxClients;
    default:
      return true;
  }
}

/** True when the row survives the **Hide bot-only servers** switch. */
export function matchesBotOnly(server: ServerInfo, hide: boolean): boolean {
  return !hide || !isBotOnly(server);
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
      matchesBotOnly(server, filters.hideBotOnly) &&
      (filters.gametype === "any" ||
        String(server.gametype) === filters.gametype) &&
      (filters.modName === "any" || server.modName === filters.modName) &&
      (filters.protocol === "any" ||
        String(server.protocol) === filters.protocol),
  );
}

/**
 * Narrows the list to one tab.
 *
 * History keeps the order of `historyAddresses`, newest first, because the
 * point of that tab is "where was I yesterday" and not "who is busiest".
 *
 * --- slice: servers browser ---
 * The LAN tab narrows nothing: its rows come from a broadcast sweep and live in
 * a list of their own, so the caller hands that list in and every row of it
 * belongs on the tab.
 */
export function applyTab(
  servers: ServerInfo[],
  tab: ServerTab,
  historyAddresses: string[],
): ServerInfo[] {
  switch (tab) {
    case "favorites":
      return servers.filter((server) => server.favorite);
    case "history": {
      const byAddress = new Map(servers.map((row) => [row.address, row]));
      return historyAddresses
        .map((address) => byAddress.get(address))
        .filter((row): row is ServerInfo => row !== undefined);
    }
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
      // Real players first, bots only as a tiebreak: of two servers with one
      // person on each, the busier lobby is the one with more bots in it.
      return (
        realPlayers(a) - realPlayers(b) || botCount(a) - botCount(b)
      );
    case "ping":
      return a.pingMs - b.pingMs;
    case "mod":
      return a.modName.localeCompare(b.modName);
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
