/**
 * The JKHub catalog (spec 1.13, 3.15): the snapshot JKNet Online keeps of
 * jkhub.org, read with the launcher's commands.
 *
 * | Command              | Route                                  |
 * | -------------------- | -------------------------------------- |
 * | `jkhub_categories`   | `GET /v1/jkhub/categories?game=`       |
 * | `jkhub_search`       | `GET /v1/jkhub/search?game=&q=&…`      |
 * | `jkhub_index_status` | `GET /v1/jkhub/status`                 |
 *
 * The categories and the search answer in the launcher's shapes
 * (`JkhubCategories`, `JkhubSearchResult`), so the launcher's tree, cards and
 * chat picker read them unchanged. The status is the service's list of both
 * games, turned into the launcher's `JkhubIndexStatus` of one: the service's
 * index is the only one there is, so it is the `cache`, nothing is ever
 * building on this side and nothing reports progress.
 *
 * A file's page of the web app opens from a link as well, so `file` reads
 * one card by its id (`GET /v1/jkhub/files/{id}?game=`); the launcher has no
 * command for that and the web app's screen calls it directly.
 *
 * The service answers `503 catalog_disabled` while the catalog is switched
 * off and `503 catalog_not_ready` while a game has no index yet; both reach
 * the screens as refusals, which say the catalog is not available yet.
 * Nothing here ever talks to jkhub.org.
 */

import type {
  Game,
  JkhubCardData,
  JkhubCategories,
  JkhubIndexStatus,
  JkhubSearchResult,
  JkhubSort,
  SortDirection,
} from "../../../src/lib/ipc.ts";
import { invalidInput } from "./errors.ts";
import type { Http } from "./http.ts";
import { gameOf, isGame } from "./servers.ts";

/** Cards of one page when the query names none, the launcher's `RESULTS_PER_PAGE`. */
export const PER_PAGE = 25;
/** The most cards one page may hold, the launcher's `MAX_RESULTS_PER_PAGE`. */
export const MAX_PER_PAGE = 100;
/** The longest query the service reads. */
export const MAX_QUERY = 200;
/** An index this old is stale, as the launcher and the service count it. */
export const STALE_AFTER_SECS = 7 * 24 * 60 * 60;

export const SORTS: readonly JkhubSort[] = ["recentlyUpdated", "newest", "mostDownloaded", "topRated", "name"];

export interface JkhubDeps {
  http: Http;
  /** The game of a command that names none: the settings' `activeGame`. */
  activeGame(): Game;
  now?: () => number;
}

export interface JkhubCore {
  /** `jkhub_categories`: the eight sections of one game with their categories. */
  categories(game: unknown): Promise<JkhubCategories>;
  /** `jkhub_search`: one page of the catalogue of one game. */
  search(request: unknown): Promise<JkhubSearchResult>;
  /** `jkhub_index_status`: what the service's index of one game holds. */
  indexStatus(game: unknown): Promise<JkhubIndexStatus>;
  /** One card by its id, for a file's page opened from a link. */
  file(game: Game, id: number): Promise<JkhubCardData>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * The query string of `GET /v1/jkhub/search` for a `jkhub_search` request,
 * every value inside the service's limits: the query trimmed to 200
 * characters, a known order and direction, a category only when it is a
 * number, a page from 1 and 1 to 100 cards on it.
 */
export function searchPath(request: unknown, fallbackGame: Game): string {
  const r = isObject(request) ? request : {};
  const game = r.game === null || r.game === undefined ? fallbackGame : isGame(r.game) ? r.game : fallbackGame;
  const query = typeof r.query === "string" ? r.query.trim().slice(0, MAX_QUERY) : "";
  const params = [`game=${game}`, `q=${encodeURIComponent(query)}`];
  const category = whole(r.categoryId);
  if (category !== null && category >= 0) params.push(`category=${category}`);
  const sort = SORTS.includes(r.sort as JkhubSort) ? (r.sort as JkhubSort) : "recentlyUpdated";
  params.push(`sort=${sort}`);
  if (r.direction === "asc" || r.direction === "desc") params.push(`direction=${r.direction as SortDirection}`);
  const page = Math.max(whole(r.page) ?? 1, 1);
  const perPage = Math.min(Math.max(whole(r.perPage) ?? PER_PAGE, 1), MAX_PER_PAGE);
  params.push(`page=${page}`, `perPage=${perPage}`);
  return `/v1/jkhub/search?${params.join("&")}`;
}

/**
 * One game of `GET /v1/jkhub/status` as the launcher's `JkhubIndexStatus`:
 * available while the index holds a file, its age counted from its last
 * write, stale after a week.
 */
export function readIndexStatus(raw: unknown, game: Game, now: number): JkhubIndexStatus {
  const games = isObject(raw) && Array.isArray(raw.games) ? raw.games : [];
  const entry = games.find((one): one is Record<string, unknown> => isObject(one) && one.game === game) ?? {};
  const files = Math.max(whole(entry.files) ?? 0, 0);
  const builtAt = typeof entry.builtAt === "string" ? entry.builtAt : "";
  const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : builtAt;
  const written = Date.parse(updatedAt);
  const age = Number.isNaN(written) ? 0 : Math.max(Math.floor((now - written) / 1000), 0);
  const available = files > 0;
  return {
    game,
    available,
    builtAt,
    updatedAt,
    age,
    files,
    source: available ? "cache" : "none",
    stale: !available || age > STALE_AFTER_SECS,
    building: false,
    progress: null,
  };
}

export function createJkhub(deps: JkhubDeps): JkhubCore {
  const { http } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    async categories(game) {
      const which = gameOf(game, deps.activeGame());
      return http.request<JkhubCategories>("GET", `/v1/jkhub/categories?game=${which}`);
    },
    async search(request) {
      return http.request<JkhubSearchResult>("GET", searchPath(request, deps.activeGame()));
    },
    async indexStatus(game) {
      const which = gameOf(game, deps.activeGame());
      return readIndexStatus(await http.request<unknown>("GET", "/v1/jkhub/status"), which, now());
    },
    async file(game, id) {
      if (!isGame(game)) throw invalidInput(`unknown game ${String(game)}`);
      if (!Number.isInteger(id) || id <= 0) throw invalidInput(`a JKHub file id must be a positive number, not ${id}`);
      return http.request<JkhubCardData>("GET", `/v1/jkhub/files/${id}?game=${game}`);
    },
  };
}
