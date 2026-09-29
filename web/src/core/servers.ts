/**
 * The general server list (spec 1.12, 3.15): what the master servers name
 * and the game servers answer, polled by JKNet Online, which a browser
 * cannot do over UDP itself.
 *
 * `GET /v1/servers?game=ja|jo` answers
 * `{game, scannedAt, stale, servers: [...]}`. A row is a subset of the
 * launcher's `ServerInfo` under the same names; the web app completes it
 * with what only the launcher knows — no ping, no star, nothing hidden, a
 * row that answered, no remembered players — so the launcher's filters,
 * sorting and components read it unchanged.
 *
 * Two readers:
 *
 * - the server list screen (`load`) asks the service each time, once a
 *   minute while it is on screen and five seconds after a `stale` answer;
 * - `get_cached_servers` of the shared chat pickers (`cached`) answers from
 *   memory for 30 s per game. A stale answer — the service's first scan
 *   after an idle spell has not finished — is asked again five seconds
 *   later, so a picker that opened on it fills in.
 *
 * Every answer the core gets is announced as `servers:updated` with its game
 * and rows, which the web app writes into the pickers' cached list. A
 * service with the list switched off answers `503 catalog_disabled`: the
 * screen says the list is not available, and the pickers read no servers.
 */

import type { Game, PlayersSource, ServerInfo } from "../../../src/lib/ipc.ts";
import { invalidInput, serviceCode } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { Http } from "./http.ts";

/** The web app's own event: `{ game, servers }` after every answer of the service. */
export const SERVERS_UPDATED_EVENT = "servers:updated";

/** How long `get_cached_servers` answers from memory. */
export const CACHE_MS = 30_000;

/** How long after a stale answer the list is asked for again. */
export const STALE_RETRY_MS = 5_000;
/** Reads after a stale answer while the scan is still running: a minute in all. */
export const STALE_RETRIES = 12;

/** The service's code of a list that is switched off. */
export const CATALOG_DISABLED = "catalog_disabled";

/** The service's code of a catalog that has nothing to serve yet. */
export const CATALOG_NOT_READY = "catalog_not_ready";

export interface ServerListAnswer {
  game: Game;
  /** RFC 3339 moment of the scan the rows come from, `null` before the first one. */
  scannedAt: string | null;
  /** True before the first scan and when the last one is old: a newer list is on its way. */
  stale: boolean;
  servers: ServerInfo[];
}

/** `servers:updated`. */
export interface ServersUpdated {
  game: Game;
  servers: ServerInfo[];
}

export interface ServerListTimers {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ServerListDeps {
  http: Http;
  events: EventBus;
  signedIn(): boolean;
  timers?: ServerListTimers;
}

export interface ServerList {
  /** The screen's read: asks the service. Rejects with its refusal, `catalog_disabled` included. */
  load(game: Game): Promise<ServerListAnswer>;
  /** `get_cached_servers`: the rows of one game, from memory while they are fresh. */
  cached(game: Game): Promise<ServerInfo[]>;
  /** Forgets every list and stops the timers: the account went, or another tab took over. */
  forget(): void;
}

const TIMERS: ServerListTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function isGame(value: unknown): value is Game {
  return value === "ja" || value === "jo";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function whole(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function playersSource(value: unknown): PlayersSource {
  return value === "info" || value === "status" ? value : "unknown";
}

/**
 * One row of the service as the launcher's `ServerInfo`, or `null` for a
 * row without an address. What the service leaves out on purpose — the ping,
 * the player lists — is the launcher's empty value, and the counts keep the
 * launcher's rule: `humans` and `bots` are both known or both `null`.
 */
export function toServerInfo(raw: unknown, game: Game): ServerInfo | null {
  if (!isObject(raw)) return null;
  const address = text(raw.address).trim();
  if (address === "") return null;
  const humans = count(raw.humans);
  const bots = count(raw.bots);
  const known = humans !== null && bots !== null;
  const hostnameRaw = text(raw.hostnameRaw);
  const hostnameClean = text(raw.hostnameClean).trim() || address;
  return {
    game: isGame(raw.game) ? raw.game : game,
    address,
    hostnameRaw,
    hostnameClean,
    map: text(raw.map),
    gametype: whole(raw.gametype),
    gametypeLabel: text(raw.gametypeLabel),
    clients: whole(raw.clients),
    humans: known ? humans : null,
    bots: known ? bots : null,
    playersSource: known ? playersSource(raw.playersSource) : "unknown",
    maxClients: whole(raw.maxClients),
    needpass: raw.needpass === true,
    modName: text(raw.modName) || "base",
    protocol: whole(raw.protocol),
    pingMs: 0,
    favorite: false,
    hidden: false,
    responded: true,
    missedRefreshes: 0,
    lastPlayers: null,
    lastPlayersAt: null,
    lastSeen: text(raw.lastSeen),
  };
}

/** The whole answer of `GET /v1/servers`, read leniently: a broken row is left out. */
export function readServerList(raw: unknown, game: Game): ServerListAnswer {
  const body = isObject(raw) ? raw : {};
  const rows = Array.isArray(body.servers) ? body.servers : [];
  const servers: ServerInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const server = toServerInfo(row, game);
    if (server === null || seen.has(server.address)) continue;
    seen.add(server.address);
    servers.push(server);
  }
  return {
    game,
    scannedAt: typeof body.scannedAt === "string" ? body.scannedAt : null,
    stale: body.stale === true || typeof body.scannedAt !== "string",
    servers,
  };
}

/** Whether a failure is the service saying the list is switched off. */
export function isCatalogDisabled(error: unknown): boolean {
  return serviceCode(error) === CATALOG_DISABLED;
}

function copy(answer: ServerListAnswer): ServerListAnswer {
  return structuredClone(answer);
}

export function createServerList(deps: ServerListDeps): ServerList {
  const { http, events } = deps;
  const timers = deps.timers ?? TIMERS;
  const kept = new Map<Game, { answer: ServerListAnswer; at: number }>();
  const retries = new Map<Game, unknown>();
  // Answers of a list asked before a sign-out must not land after it.
  let generation = 0;

  const load = async (game: Game): Promise<ServerListAnswer> => {
    if (!isGame(game)) throw invalidInput(`unknown game ${String(game)}`);
    const started = generation;
    const raw = await http.request<unknown>("GET", `/v1/servers?game=${game}`);
    const answer = readServerList(raw, game);
    if (started !== generation) return copy(answer);
    kept.set(game, { answer, at: timers.now() });
    events.emit(SERVERS_UPDATED_EVENT, { game, servers: structuredClone(answer.servers) } satisfies ServersUpdated);
    return copy(answer);
  };

  /**
   * Another read a few seconds after a stale answer, for whoever holds the
   * rows, and again while the answer stays stale: a scan may take longer
   * than one wait. At most `STALE_RETRIES` in a row.
   */
  const retryLater = (game: Game, attempt = 1) => {
    if (retries.has(game)) return;
    const started = generation;
    retries.set(
      game,
      timers.setTimeout(() => {
        retries.delete(game);
        if (started !== generation || !deps.signedIn()) return;
        void load(game)
          .then((answer) => {
            if (answer.stale && attempt < STALE_RETRIES && started === generation) retryLater(game, attempt + 1);
          })
          .catch(() => undefined);
      }, STALE_RETRY_MS),
    );
  };

  return {
    load,
    async cached(game) {
      if (!isGame(game)) throw invalidInput(`unknown game ${String(game)}`);
      const entry = kept.get(game);
      if (entry !== undefined && timers.now() - entry.at < CACHE_MS && !entry.answer.stale) {
        return structuredClone(entry.answer.servers);
      }
      const answer = await load(game);
      if (answer.stale) retryLater(game);
      return answer.servers;
    },
    forget() {
      generation += 1;
      kept.clear();
      for (const handle of retries.values()) timers.clearTimeout(handle);
      retries.clear();
    },
  };
}

/** The game a command names, or the fallback for `null` (the active game, as in the launcher). */
export function gameOf(value: unknown, fallback: Game): Game {
  if (value === null || value === undefined || value === "") return fallback;
  if (!isGame(value)) throw invalidInput(`unknown game ${String(value)}`);
  return value;
}
