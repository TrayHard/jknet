/**
 * A typed client of the communities contract over whichever transport the
 * host gives: the launcher's `community_request` bridge, or HTTP on the
 * website and in the web app.
 *
 * Every path is built here, never on a screen, so the ids and the query
 * strings the bridges check come out in one shape. The closed lists of tags,
 * languages and regions are the service's (`community/pages.rs`), and a value
 * outside them is dropped before it reaches a query.
 *
 * Events, news, the activity of servers and the top communities are
 * provisional (`TODO(S4)`–`TODO(S6)`): the service does not serve them yet,
 * and the helpers read whatever arrives defensively.
 */

import type {
  Community,
  CommunityActivity,
  CommunityCard,
  CommunityCatalog,
  CommunityClaim,
  CommunityCreated,
  CommunityDiscord,
  CommunityEvent,
  CommunityMe,
  CommunityPost,
  CommunityRankingEntry,
  CommunityRegulars,
  CommunityRequest,
  CommunityReview,
  CommunityServerAdded,
  CommunityVerified,
  CommunityLink,
  CommunityRecommendation,
  FollowedCommunity,
  Game,
} from "./types";

/** The tags of the service's closed list, in the order the chips show them. */
export const COMMUNITY_TAGS = [
  "ffa",
  "duel",
  "power-duel",
  "team-ffa",
  "ctf",
  "cty",
  "siege",
  "rp",
  "mb2",
  "racing",
  "makermod",
  "clan",
  "training",
  "newbie-friendly",
  "competitive",
  "casual",
] as const;

export type CommunityTag = (typeof COMMUNITY_TAGS)[number];

/** The languages of the service's closed list, ISO 639-1. */
export const COMMUNITY_LANGUAGES = [
  "en",
  "ru",
  "uk",
  "de",
  "fr",
  "es",
  "pt",
  "pl",
  "hu",
  "it",
  "tr",
  "cs",
  "nl",
  "sv",
  "fi",
] as const;

export type CommunityLanguage = (typeof COMMUNITY_LANGUAGES)[number];

/** The regions of the service's closed list. */
export const COMMUNITY_REGIONS = ["eu", "na", "sa", "cis", "asia", "oce", "africa", "me"] as const;

export type CommunityRegion = (typeof COMMUNITY_REGIONS)[number];

/** The orders of the catalogue the screens offer: the ones the service knows now. */
export const CATALOG_SORTS = ["featured", "followers", "regulars", "new", "name"] as const;

export type CatalogSort = (typeof CATALOG_SORTS)[number];

/**
 * Every order a catalogue query may carry: the offered ones and the two
 * the live status adds (`players`, `online`, TODO(S6)). The service sorts
 * a key it does not know as `featured`. The bridges of the launcher and
 * the web app let exactly these through.
 */
export const CATALOG_SORT_KEYS = [...CATALOG_SORTS, "players", "online"] as const;

/** The filters of `GET communities`. An empty or unknown value filters nothing. */
export interface CatalogQuery {
  game?: Game | null;
  tag?: string | null;
  language?: string | null;
  region?: string | null;
  q?: string | null;
  sort?: string | null;
  limit?: number | null;
  offset?: number | null;
}

/** A ULID of the service: 26 letters and digits, as the bridges check it. */
export function isCommunityId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{26}$/.test(value);
}

/**
 * The id as a path segment, or a refusal before any request. No page of the
 * service has an id of another shape, so the refusal reads as "not found":
 * a link with a broken `?id=` shows the page that says so.
 */
function segment(value: string): string {
  if (!isCommunityId(value)) {
    throw Object.assign(new Error(`Invalid community id: ${JSON.stringify(value)}`), { code: "notFound" });
  }
  return value;
}

function member<T extends string>(list: readonly T[], value: string | null | undefined): T | null {
  return value != null && (list as readonly string[]).includes(value) ? (value as T) : null;
}

/** The longest search the bridges let through, in characters. */
export const MAX_SEARCH = 100;

/**
 * The path of `GET communities` for a set of filters: known values only,
 * each escaped, in a fixed order.
 */
export function catalogPath(query: CatalogQuery = {}): string {
  const params: string[] = [];
  const game = query.game === "ja" || query.game === "jo" ? query.game : null;
  if (game) params.push(`game=${game}`);
  const tag = member(COMMUNITY_TAGS, query.tag);
  if (tag) params.push(`tag=${tag}`);
  const language = member(COMMUNITY_LANGUAGES, query.language);
  if (language) params.push(`language=${language}`);
  const region = member(COMMUNITY_REGIONS, query.region);
  if (region) params.push(`region=${region}`);
  // The search keeps its letters; control characters would be refused whole.
  const q = Array.from((query.q ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, MAX_SEARCH).join("");
  if (q !== "") params.push(`q=${encodeURIComponent(q)}`);
  const sort = member(CATALOG_SORT_KEYS, query.sort);
  if (sort && sort !== "featured") params.push(`sort=${sort}`);
  const limit = whole(query.limit);
  if (limit !== null) params.push(`limit=${Math.min(Math.max(limit, 1), 500)}`);
  const offset = whole(query.offset);
  if (offset !== null && offset > 0) params.push(`offset=${Math.min(offset, 99999)}`);
  return params.length === 0 ? "communities" : `communities?${params.join("&")}`;
}

function whole(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** TODO(S4): the filters of `GET events`. */
export interface EventsQuery {
  from?: string | null;
  to?: string | null;
  scope?: "all" | "following" | "going" | null;
  game?: Game | null;
  community?: string | null;
}

/** TODO(S4): the path of `GET events`, keys and values as the bridges check them. */
export function eventsPath(query: EventsQuery = {}): string {
  const params: string[] = [];
  const moment = (value: string | null | undefined) =>
    value != null && /^[0-9TZ:.+-]{10,35}$/.test(value) ? value : null;
  const from = moment(query.from);
  if (from) params.push(`from=${encodeURIComponent(from)}`);
  const to = moment(query.to);
  if (to) params.push(`to=${encodeURIComponent(to)}`);
  if (query.scope === "all" || query.scope === "following" || query.scope === "going") params.push(`scope=${query.scope}`);
  if (query.game === "ja" || query.game === "jo") params.push(`game=${query.game}`);
  if (isCommunityId(query.community)) params.push(`community=${query.community}`);
  return params.length === 0 ? "events" : `events?${params.join("&")}`;
}

/** The fields `PUT communities/{id}` takes. A field left out keeps its value; `null` clears it. */
export interface CommunityPatch {
  name?: string;
  tagline?: string;
  description?: string;
  rules?: string;
  website?: string;
  discord?: string;
  links?: CommunityLink[];
  tags?: string[];
  languages?: string[];
  region?: string | null;
  recommendations?: CommunityRecommendation[];
  bundleId?: string | null;
  /** The revision the edit was made on; another one answers `409`. */
  revision: number;
}

/** The address of a picture of the store: the logo, the cover. */
export function blobUrl(apiBase: string, sha256: string | null | undefined): string | null {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || apiBase === "") return null;
  return `${apiBase.replace(/\/+$/, "")}/v1/blobs/${sha256}`;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [];
}

function isCard(value: unknown): value is CommunityCard {
  if (value === null || typeof value !== "object") return false;
  const card = value as Partial<CommunityCard>;
  return isCommunityId(card.id) && typeof card.name === "string";
}

/**
 * TODO(S6): the top communities out of whatever `GET ranking` answered, or
 * `null` when the answer is not a ranking. Two shapes are read: a list of
 * cards with their `followers`, and a list of `{ rank, community,
 * followers }`, in the order given.
 */
export function readRanking(answer: unknown): CommunityRankingEntry[] | null {
  if (answer === null || typeof answer !== "object") return null;
  const body = answer as Record<string, unknown>;
  const list = records(body.ranking ?? body.communities ?? body.top);
  const entries: CommunityRankingEntry[] = [];
  for (const item of list) {
    const community = isCard(item.community) ? item.community : isCard(item) ? item : null;
    if (community === null) continue;
    const followers = [item.followers, community.counts?.followers].find(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    entries.push({
      rank: typeof item.rank === "number" ? item.rank : entries.length + 1,
      community,
      followers: followers ?? 0,
    });
  }
  return entries.length > 0 ? entries : null;
}

/** A refusal read out of any of the three transports. */
export interface CommunityFailure {
  /** The contract's code — `not_found`, `limit`, `rate_limited` — `network`, or `""`. */
  code: string;
  message: string;
}

/**
 * What went wrong, whichever transport said it: the launcher's envelope
 * `{ code: "online", details: { code } }`, the web core's `CoreError` of the
 * same shape, or an `Error` the website's fetch threw.
 */
export function failureOf(error: unknown): CommunityFailure {
  if (error !== null && typeof error === "object") {
    const shape = error as { code?: unknown; message?: unknown; details?: unknown };
    const message = typeof shape.message === "string" ? shape.message : "";
    const details =
      shape.details !== null && typeof shape.details === "object"
        ? (shape.details as { code?: unknown; message?: unknown })
        : {};
    if (shape.code === "online" && typeof details.code === "string") {
      return { code: details.code, message: typeof details.message === "string" ? details.message : message };
    }
    if (shape.code === "network") return { code: "network", message };
    if (typeof shape.code === "string") return { code: shape.code, message };
    return { code: "", message };
  }
  if (typeof error === "string") {
    const service = /^online ([a-z_]+): (.*)$/s.exec(error);
    if (service) return { code: service[1], message: service[2] };
    return { code: "", message: error };
  }
  return { code: "", message: "" };
}

/** Whether a failure says the route or the thing is not there. */
export function isNotFound(error: unknown): boolean {
  const failure = failureOf(error);
  return failure.code === "not_found" || failure.code === "notFound";
}

/** The client: one function per route of the contract. */
export function communityApi(request: CommunityRequest) {
  const community = (id: string) => `communities/${segment(id)}`;
  return {
    // --- the catalogue and the player's lists
    catalog: (query?: CatalogQuery) => request<CommunityCatalog>("GET", catalogPath(query)),
    /** TODO(S6): `null` when the service has no ranking yet. */
    ranking: async (): Promise<CommunityRankingEntry[] | null> => {
      try {
        return readRanking(await request<unknown>("GET", "ranking"));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    me: () => request<CommunityMe>("GET", "me"),
    following: () => request<{ communities: FollowedCommunity[] }>("GET", "following"),
    // --- one community
    get: (id: string) => request<Community>("GET", community(id)),
    create: (body: { name: string; game: Game; address: string; label?: string }) =>
      request<CommunityCreated>("POST", "communities", body),
    update: (id: string, patch: CommunityPatch) => request<Community>("PUT", community(id), patch),
    images: (id: string, body: { logo?: string | null; banner?: string | null }) =>
      request<Community>("PUT", `${community(id)}/images`, body),
    admin: (id: string, body: { ownerId?: string | null; featured?: boolean; listed?: boolean }) =>
      request<Community>("PUT", `${community(id)}/admin`, body),
    remove: (id: string) => request<null>("DELETE", community(id)),
    // --- servers and claims
    addServer: (id: string, body: { game: Game; address: string; label?: string }) =>
      request<CommunityServerAdded>("POST", `${community(id)}/servers`, body),
    updateServer: (id: string, serverId: string, body: { label?: string | null; position?: number }) =>
      request<Community>("PUT", `${community(id)}/servers/${segment(serverId)}`, body),
    removeServer: (id: string, serverId: string) =>
      request<Community>("DELETE", `${community(id)}/servers/${segment(serverId)}`),
    claim: (serverId: string, manual: boolean) =>
      request<CommunityClaim>("POST", `servers/${segment(serverId)}/claims`, { manual }),
    verify: (claimId: string) => request<CommunityVerified>("POST", `claims/${segment(claimId)}/verify`),
    reviews: () => request<{ claims: CommunityReview[] }>("GET", "admin/claims"),
    review: (claimId: string, approve: boolean, featured?: boolean) =>
      request<{ ok: boolean; communityId?: string }>(
        "POST",
        `admin/claims/${segment(claimId)}`,
        featured === undefined ? { approve } : { approve, featured },
      ),
    // --- editors and ownership
    addEditor: (id: string, userId: string) => request<Community>("PUT", `${community(id)}/editors/${segment(userId)}`),
    removeEditor: (id: string, userId: string) =>
      request<Community>("DELETE", `${community(id)}/editors/${segment(userId)}`),
    transfer: (id: string, userId: string) => request<Community>("POST", `${community(id)}/transfer`, { userId }),
    // --- following and players
    /** Follows, or changes `notify` of a subscription; without it a new one notifies. */
    follow: (id: string, notify?: boolean) =>
      request<Community>("PUT", `${community(id)}/follow`, notify === undefined ? undefined : { notify }),
    unfollow: (id: string) => request<null>("DELETE", `${community(id)}/follow`),
    players: (id: string) => request<CommunityRegulars>("GET", `${community(id)}/players`),
    discord: (id: string) => request<CommunityDiscord>("GET", `${community(id)}/discord`),
    // --- TODO(S4)–TODO(S6): provisional routes
    activity: (id: string) => request<CommunityActivity>("GET", `${community(id)}/activity`),
    events: (query?: EventsQuery) => request<{ events: CommunityEvent[] }>("GET", eventsPath(query)),
    event: (eventId: string) => request<CommunityEvent>("GET", `events/${segment(eventId)}`),
    posts: (id: string) => request<{ posts: CommunityPost[] }>("GET", `${community(id)}/posts`),
  };
}

export type CommunityApi = ReturnType<typeof communityApi>;
