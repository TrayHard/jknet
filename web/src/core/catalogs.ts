/**
 * The read-only catalogs of JKNet Online that the reused components ask the
 * web core for: community servers and bundles.
 *
 * Community servers go through `community_request`, the bridge the
 * launcher's `CommunityBrowser` talks to (`src-tauri/src/community.rs`).
 * The web app only reads the catalog, so the bridge takes the four reads of
 * that module and nothing else: the list, one page, the player's own pages
 * and claims, and an administrator's queue. Adding a page, claiming one and
 * editing it stay with the launcher and the website.
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
import { invalidInput, needsLauncher } from "./errors.ts";
import { segment, type Http } from "./http.ts";

export interface CatalogsDeps {
  http: Http;
  signedIn(): boolean;
  /** The game of a catalogue query that names none: the settings' `activeGame`, as in the launcher. */
  activeGame(): Game;
}

export interface Catalogs {
  /** `community_request`: one read of the community catalog. */
  community(method: string, path: string): Promise<unknown>;
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

/** A page id of the community catalog: 26 letters and digits, as `route` of `community.rs` checks. */
function communityId(value: string): boolean {
  return value.length === 26 && /^[A-Za-z0-9]+$/.test(value);
}

/**
 * The reads of the community bridge, with whether each needs the token: the
 * public list and pages go without it, as the launcher sends them.
 * `null` for anything else — a write, a path of another route, a path that
 * climbs out of `/v1/community/`.
 */
export function communityRead(method: string, path: string): { auth: boolean } | null {
  if (method !== "GET") return null;
  const parts = path.split("/");
  if (parts.length === 1 && parts[0] === "servers") return { auth: false };
  if (parts.length === 2 && parts[0] === "servers" && communityId(parts[1])) return { auth: false };
  if (parts.length === 1 && parts[0] === "me") return { auth: true };
  if (parts.length === 2 && parts[0] === "admin" && parts[1] === "claims") return { auth: true };
  return null;
}

/** The community operations the launcher's bridge also allows: the ones the web leaves to it. */
function communityWrite(method: string, path: string): boolean {
  const parts = path.split("/");
  const id = (value: string | undefined) => value !== undefined && communityId(value);
  if (method === "POST" && parts.length === 1 && parts[0] === "servers") return true;
  if (method === "PUT" && parts.length === 2 && parts[0] === "servers" && id(parts[1])) return true;
  if (method === "POST" && parts.length === 3 && parts[0] === "servers" && id(parts[1]) && parts[2] === "claims") return true;
  if (method === "POST" && parts.length === 3 && parts[0] === "claims" && id(parts[1]) && parts[2] === "verify") return true;
  if (method === "POST" && parts.length === 3 && parts[0] === "admin" && parts[1] === "claims" && id(parts[2])) return true;
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
    async community(method, path) {
      const read = communityRead(method, path);
      if (read === null) {
        if (communityWrite(method, path)) throw needsLauncher(`community_request.${method}`);
        throw invalidInput("unknown community operation");
      }
      return http.request<unknown>("GET", `/v1/community/${path}`, { auth: read.auth });
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
