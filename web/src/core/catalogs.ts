/**
 * The read-only catalogs of JKNet Online that the reused components ask the
 * web core for: community servers and bundles.
 *
 * Communities go through `community_request`, the bridge the shared
 * community screens talk to (`src-tauri/src/community.rs` in the launcher).
 * The web app reads every page of the contract — the catalogue, a
 * community, its players and its Discord, the top communities, the player's own
 * lists — and follows a community with the web session; creating a
 * community, claiming a server and editing a page stay with the launcher and
 * the website. The two queries the screens build, the catalogue and the
 * calendar, are checked key by key and written back, as the launcher's
 * bridge does.
 *
 * Bundles come from the catalogue the launcher reads (`GET /v1/bundles…`),
 * with the same query `list_bundles` builds (`src-tauri/src/bundles/mod.rs`,
 * `catalogue_path`). A record of a bundle is what the bundle's page and a
 * bundle card of the chat draw; the half the launcher's core adds — which
 * clients of this machine came out of the bundle — is empty in a browser,
 * which installs nothing. A like is the account's, as in the launcher.
 */

import type {
  BundleDetails,
  BundleDetailsWithLocal,
  BundleLikes,
  BundleList,
  BundleVersion,
  Game,
} from "../../../src/lib/ipc.ts";
import {
  CATALOG_SORT_KEYS,
  catalogPath,
  COMMUNITY_LANGUAGES,
  COMMUNITY_REGIONS,
  COMMUNITY_TAGS,
  eventsPath,
} from "../../../src/components/community/api.ts";
import { invalidInput, needsLauncher } from "./errors.ts";
import { segment, type Http } from "./http.ts";

export interface CatalogsDeps {
  http: Http;
  signedIn(): boolean;
  /** The game of a catalogue query that names none: the settings' `activeGame`, as in the launcher. */
  activeGame(): Game;
}

export interface Catalogs {
  /** `community_request`: one read of the communities contract, or following a community. */
  community(method: string, path: string, body?: unknown): Promise<unknown>;
  /** `list_bundles`: one page of the catalogue of one game. */
  bundles(query: unknown): Promise<BundleList>;
  /** `get_bundle`: one record of the catalogue, with nothing of it installed here. */
  bundle(bundleId: string): Promise<BundleDetailsWithLocal>;
  /** `get_bundle_version`: one version with its manifest. */
  version(bundleId: string, versionId: string): Promise<BundleVersion>;
  /** `like_bundle`: likes or unlikes a bundle for the account. */
  like(bundleId: string, liked: boolean): Promise<BundleLikes>;
}

/** Most cards one page of the catalogue holds, `MAX_PAGE` of the launcher. */
export const MAX_BUNDLE_PAGE = 100;

/** A ULID of the service: 26 letters and digits, as `route` of `community.rs` checks. */
function communityId(value: string | undefined): boolean {
  return value !== undefined && value.length === 26 && /^[A-Za-z0-9]+$/.test(value);
}

/** The largest search the bridges let through, in characters. */
const MAX_SEARCH = 100;

/**
 * The pairs of a query, decoded; `null` for a pair without `=`, a key
 * given twice or an escape that is not UTF-8.
 */
function queryPairs(query: string): Map<string, string> | null {
  const pairs = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    if (at < 0) return null;
    const key = pair.slice(0, at);
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, " "));
    } catch {
      return null;
    }
    if (pairs.has(key)) return null;
    pairs.set(key, value);
  }
  return pairs;
}

const count = (value: string) => /^\d{1,5}$/.test(value);
/** A control character, which no search of a player holds. */
const CONTROL = /[\u0000-\u001f\u007f]/;
const listed = (list: readonly string[], value: string) => list.includes(value);

/**
 * The query of `GET communities`, checked key by key the way the launcher's
 * bridge checks it and written back by `catalogPath`; `null` when a key or
 * a value is not one the service takes.
 */
export function catalogueQuery(query: string): string | null {
  const pairs = queryPairs(query);
  if (pairs === null) return null;
  for (const [key, value] of pairs) {
    if (value === "") continue;
    const fits =
      key === "game" ? value === "ja" || value === "jo"
      : key === "tag" ? listed(COMMUNITY_TAGS, value)
      : key === "language" ? listed(COMMUNITY_LANGUAGES, value)
      : key === "region" ? listed(COMMUNITY_REGIONS, value)
      : key === "sort" ? listed(CATALOG_SORT_KEYS, value)
      : key === "q" ? Array.from(value).length <= MAX_SEARCH && !CONTROL.test(value)
      : key === "limit" || key === "offset" ? count(value)
      : false;
    if (!fits) return null;
  }
  const number = (key: string) => (pairs.get(key) ? Number(pairs.get(key)) : null);
  return catalogPath({
    game: (pairs.get("game") || null) as "ja" | "jo" | null,
    tag: pairs.get("tag") || null,
    language: pairs.get("language") || null,
    region: pairs.get("region") || null,
    q: pairs.get("q") || null,
    sort: pairs.get("sort") || null,
    limit: number("limit"),
    offset: number("offset"),
  });
}

/** The query of `GET events` (TODO(S4)), checked the same way. */
export function eventsQuery(query: string): string | null {
  const pairs = queryPairs(query);
  if (pairs === null) return null;
  const moment = (value: string) => /^[0-9TZ:.+-]{10,35}$/.test(value);
  for (const [key, value] of pairs) {
    if (value === "") continue;
    const fits =
      key === "from" || key === "to" ? moment(value)
      : key === "scope" ? value === "all" || value === "following" || value === "going"
      : key === "game" ? value === "ja" || value === "jo"
      : key === "community" ? communityId(value)
      : false;
    if (!fits) return null;
  }
  const scope = pairs.get("scope");
  return eventsPath({
    from: pairs.get("from") || null,
    to: pairs.get("to") || null,
    scope: scope === "all" || scope === "following" || scope === "going" ? scope : null,
    game: (pairs.get("game") || null) as "ja" | "jo" | null,
    community: pairs.get("community") || null,
  });
}

/** What the web core does with one call of the community bridge. */
export interface CommunityRoute {
  /** The path under `/v1/community/` to send, its query rebuilt. */
  path: string;
  /** `optional`: the token goes along while there is one. `required`: a guest is refused before the request. */
  auth: "optional" | "required";
  /** The call carries its body: following and its notifications. */
  body: boolean;
}

/**
 * The calls of the community bridge the web app makes: every read of the
 * contract — the catalogue, a page, its players, its Discord, the top communities,
 * the calendar and its events, the player's own lists — following a
 * community and answering an event, with the web session's token. `null`
 * for anything else: a write the launcher and the website make, a path of
 * another route, a path that climbs out of `/v1/community/`, a query with
 * a key or a value the service does not take.
 */
export function communityRoute(method: string, path: string): CommunityRoute | null {
  const at = path.indexOf("?");
  const bare = at < 0 ? path : path.slice(0, at);
  const query = at < 0 ? null : path.slice(at + 1);
  const parts = bare.split("/");
  const [a, b, c] = parts;
  const read = (auth: "optional" | "required" = "optional"): CommunityRoute => ({ path: bare, auth, body: false });

  if (method === "GET") {
    if (query !== null) {
      if (parts.length === 1 && a === "communities") {
        const rebuilt = catalogueQuery(query);
        return rebuilt === null ? null : { path: rebuilt, auth: "optional", body: false };
      }
      if (parts.length === 1 && a === "events") {
        const rebuilt = eventsQuery(query);
        return rebuilt === null ? null : { path: rebuilt, auth: "optional", body: false };
      }
      return null;
    }
    if (parts.length === 1) {
      if (a === "communities" || a === "ranking" || a === "events" || a === "servers") return read();
      if (a === "me" || a === "following") return read("required");
      return null;
    }
    if (parts.length === 2) {
      if ((a === "communities" || a === "servers" || a === "events") && communityId(b)) return read();
      if (a === "admin" && b === "claims") return read("required");
      return null;
    }
    if (parts.length === 3 && a === "communities" && communityId(b)) {
      if (c === "players" || c === "discord" || c === "activity" || c === "events" || c === "posts") return read();
      return null;
    }
    if (parts.length === 3 && a === "events" && communityId(b) && c === "attendees") return read("required");
    return null;
  }
  if ((method === "PUT" || method === "DELETE") && query === null && parts.length === 3 && a === "communities" && communityId(b) && c === "follow") {
    return { path: bare, auth: "required", body: method === "PUT" };
  }
  // --- slice: community events --- answering an event: «going», «maybe», or taking it back.
  if ((method === "PUT" || method === "DELETE") && query === null && parts.length === 3 && a === "events" && communityId(b) && c === "rsvp") {
    return { path: bare, auth: "required", body: method === "PUT" };
  }
  return null;
}

/**
 * The writes of the community bridge the launcher and the website make and
 * the web app leaves to them: creating a community, claiming a server,
 * editing a page, the organizers' and the administrators' tools, creating
 * and changing events.
 */
function communityWrite(method: string, path: string): boolean {
  if (method !== "POST" && method !== "PUT" && method !== "DELETE") return false;
  const parts = path.split("?")[0].split("/");
  const [a, b] = parts;
  if (a === "communities" || a === "servers" || a === "claims" || a === "admin" || a === "events" || a === "posts") {
    return parts.length === 1 || communityId(b) || (a === "admin" && b === "claims");
  }
  return false;
}

function isGame(value: unknown): value is Game {
  return value === "ja" || value === "jo";
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function whole(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * The query string of `GET /v1/bundles`, every value escaped: the game, the
 * order (`popular` unless the query names another known one), the search,
 * the engine, the tag, and a page of 1 to 100 cards from `offset`.
 */
export function bundleListPath(query: unknown, fallbackGame: Game = "ja"): string {
  const q = query !== null && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const game = isGame(q.game) ? q.game : fallbackGame;
  const sortWanted = trimmed(q.sort);
  const sort = sortWanted === "popular" || sortWanted === "new" || sortWanted === "installs" ? sortWanted : "popular";
  const params = [`game=${game}`, `sort=${sort}`];
  const search = trimmed(q.q);
  if (search !== "") params.push(`q=${encodeURIComponent(search)}`);
  const engine = trimmed(q.engineId);
  if (engine !== "") params.push(`engine=${encodeURIComponent(engine)}`);
  const tag = trimmed(q.tag);
  if (tag !== "") params.push(`tag=${encodeURIComponent(tag)}`);
  const limit = Math.min(Math.max(whole(q.limit, 50), 1), MAX_BUNDLE_PAGE);
  const offset = Math.max(whole(q.offset, 0), 0);
  params.push(`limit=${limit}`, `offset=${offset}`);
  return `/v1/bundles?${params.join("&")}`;
}

function idOf(value: string, what: string): string {
  const id = value.trim();
  if (id === "") throw invalidInput(`an empty ${what}`);
  return segment(id);
}

export function createCatalogs(deps: CatalogsDeps): Catalogs {
  const { http } = deps;
  // The catalogue is public; a signed-in player's token adds what they liked.
  const optional = () => ({ auth: deps.signedIn() });

  return {
    async community(method, path, body) {
      const route = communityRoute(method, path);
      if (route === null) {
        if (communityWrite(method, path)) throw needsLauncher(`community_request.${method}`);
        throw invalidInput("unknown community operation");
      }
      const auth = route.auth === "required" || deps.signedIn();
      const payload = route.body && body !== null && body !== undefined ? { body } : {};
      return http.request<unknown>(method, `/v1/community/${route.path}`, { auth, ...payload });
    },
    async bundles(query) {
      return http.request<BundleList>("GET", bundleListPath(query, deps.activeGame()), optional());
    },
    async bundle(bundleId) {
      const details = await http.request<BundleDetails>("GET", `/v1/bundles/${idOf(bundleId, "bundle id")}`, optional());
      return { ...details, local: { installedClients: [], engineKnown: {} } };
    },
    async version(bundleId, versionId) {
      return http.request<BundleVersion>(
        "GET",
        `/v1/bundles/${idOf(bundleId, "bundle id")}/versions/${idOf(versionId, "version id")}`,
        optional(),
      );
    },
    async like(bundleId, liked) {
      return http.request<BundleLikes>(liked ? "PUT" : "DELETE", `/v1/bundles/${idOf(bundleId, "bundle id")}/like`);
    },
  };
}
