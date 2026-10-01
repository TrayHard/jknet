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
 * A service from before the news, the activity, the top communities and the
 * bot answers `404` to their routes: the readers of the top and of the
 * activity take that as "nothing to show". Events have their own client,
 * `components/events/api.ts`, over the path {@link eventsPath} builds here.
 */

import type {
  Community,
  CommunityActivity,
  CommunityCard,
  CommunityCatalog,
  CommunityClaim,
  CommunityCreated,
  CommunityDiscord,
  CommunityMe,
  CommunityPost,
  CommunityPosts,
  CommunityRankingEntry,
  CommunityRegulars,
  CommunityRequest,
  CommunityReview,
  CommunityServerAdded,
  CommunityVerified,
  CommunityLink,
  CommunityRecommendation,
  DiscordBotLink,
  FollowedCommunity,
  Game,
  NewPostBody,
  PostPatch,
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

/**
 * The orders the catalogue offers: recommended, followers, regular players,
 * humans online now (`online`), the newest, and the name.
 */
export const CATALOG_SORTS = ["featured", "followers", "regulars", "online", "new", "name"] as const;

export type CatalogSort = (typeof CATALOG_SORTS)[number];

/**
 * Every order a catalogue query may carry: the ones the catalogue offers,
 * and `players`, one it no longer offers that the service still takes. How
 * each order ranks is the service's, and it sorts a key it does not know as
 * `featured`; the bridges of the launcher and the web app let exactly these
 * through.
 */
export const CATALOG_SORT_KEYS = ["featured", "followers", "players", "regulars", "online", "new", "name"] as const;

/**
 * A cursor of a list that pages in time order, as the service writes it:
 * the time of the last item in UTC to the second, `_`, and its id. The
 * calendar's `next` and the news' `next` are both of this shape.
 */
export function isTimeCursor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z_[A-Za-z0-9]{26}$/.test(value);
}

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

/** The filters of `GET events`. */
export interface EventsQuery {
  from?: string | null;
  to?: string | null;
  scope?: "all" | "following" | "going" | null;
  game?: Game | null;
  community?: string | null;
  /** The `next` of the page before: the same range, the page after it. */
  after?: string | null;
}

/** The path of `GET events`, keys and values as the bridges check them. */
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
  if (isTimeCursor(query.after)) params.push(`after=${encodeURIComponent(query.after)}`);
  return params.length === 0 ? "events" : `events?${params.join("&")}`;
}

/** The most posts one page of the news holds, besides the pinned ones. */
export const MAX_POSTS_PAGE = 50;

/** The page of the news `GET communities/{id}/posts` reads. */
export interface PostsQuery {
  /** Posts that are not pinned on the page: 20 when not given, 1 to 50. */
  limit?: number | null;
  /** The `next` of the page before. */
  before?: string | null;
}

/** The path of `GET communities/{id}/posts`, keys and values as the bridges check them. */
export function postsPath(id: string, query: PostsQuery = {}): string {
  const params: string[] = [];
  const limit = whole(query.limit);
  if (limit !== null) params.push(`limit=${Math.min(Math.max(limit, 1), MAX_POSTS_PAGE)}`);
  if (isTimeCursor(query.before)) params.push(`before=${encodeURIComponent(query.before)}`);
  const path = `communities/${segment(id)}/posts`;
  return params.length === 0 ? path : `${path}?${params.join("&")}`;
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
 * The top communities out of what `GET ranking` answered — `{ communities }`,
 * each a card with its `rank` and its `followers` — or `null` when the
 * answer holds no place. A place of another shape is skipped; one without
 * its number takes the next place in the order given, and one without its
 * followers takes those of its card.
 */
export function readRanking(answer: unknown): CommunityRankingEntry[] | null {
  if (answer === null || typeof answer !== "object") return null;
  const body = answer as Record<string, unknown>;
  const list = records(body.communities);
  const entries: CommunityRankingEntry[] = [];
  for (const item of list) {
    if (!isCard(item)) continue;
    const community = item as unknown as CommunityCard;
    const followers = [item.followers, community.counts?.followers].find(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    entries.push({
      rank: typeof item.rank === "number" && Number.isFinite(item.rank) ? item.rank : entries.length + 1,
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
    /** The top communities; `null` when it is empty or the service has no ranking yet. */
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
    // --- the JKNet bot of the community's Discord server
    /** Discord's page that adds the bot; the organizer opens it in a browser. */
    discordBotLink: (id: string) => request<DiscordBotLink>("POST", `${community(id)}/discord/bot/link`),
    /** The announcements channel (`null`: none) and whether the page lists the channels; the Discord card after it. */
    discordBot: (id: string, body: { announcementsChannelId?: string | null; showChannels?: boolean }) =>
      request<CommunityDiscord>("PUT", `${community(id)}/discord/bot`, body),
    unlinkDiscordBot: (id: string) => request<null>("DELETE", `${community(id)}/discord/bot`),
    // --- activity and news
    /** The heat map and the peak; `null` when the service has no activity yet. */
    activity: async (id: string): Promise<CommunityActivity | null> => {
      try {
        return readActivity(await request<unknown>("GET", `${community(id)}/activity`));
      } catch (error) {
        if (isNotFound(error) && isCommunityId(id)) return null;
        throw error;
      }
    },
    /** A page of the news; an empty one when the service has no news yet. */
    posts: async (id: string, query?: PostsQuery): Promise<CommunityPosts> => {
      try {
        return await request<CommunityPosts>("GET", postsPath(id, query));
      } catch (error) {
        if (isNotFound(error) && isCommunityId(id)) return { posts: [], next: null };
        throw error;
      }
    },
    createPost: (id: string, body: NewPostBody) => request<CommunityPost>("POST", `${community(id)}/posts`, body),
    updatePost: (postId: string, patch: PostPatch) => request<CommunityPost>("PUT", `posts/${segment(postId)}`, patch),
    removePost: (postId: string) => request<null>("DELETE", `posts/${segment(postId)}`),
  };
}

/**
 * The activity out of what `GET communities/{id}/activity` answered, or
 * `null` when it is not one: a heat map of 168 finite numbers at least.
 */
export function readActivity(answer: unknown): CommunityActivity | null {
  if (answer === null || typeof answer !== "object") return null;
  const body = answer as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  if (!Array.isArray(body.heatmap) || body.heatmap.length !== 168) return null;
  const heatmap = body.heatmap.map((value) => Math.max(0, number(value)));
  const peak =
    body.peak !== null && typeof body.peak === "object" && typeof (body.peak as { at?: unknown }).at === "string"
      ? { humans: number((body.peak as { humans?: unknown }).humans), at: (body.peak as { at: string }).at }
      : null;
  return {
    heatmap,
    peak: peak !== null && peak.humans > 0 ? peak : null,
    onlineNow: number(body.onlineNow),
    days: number(body.days),
  };
}

export type CommunityApi = ReturnType<typeof communityApi>;
