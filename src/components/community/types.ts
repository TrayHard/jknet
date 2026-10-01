/**
 * The wire types of the communities contract of JKNet Online
 * (`/v1/community/…`), one to one with the service's `community/wire.rs`,
 * `community/discord.rs` and the routes of before.
 *
 * The launcher, the website and the web app read the same shapes: the
 * launcher through the `community_request` bridge of the core, the other two
 * over HTTP. Field names are camelCase on the wire.
 *
 * Events, news, the live status of servers, their activity and the week's
 * ranking are not served yet. Their shapes below are provisional and marked
 * `TODO(S4)`, `TODO(S5)` and `TODO(S6)`: the screens read them defensively
 * and draw nothing of a part the service does not answer.
 */

export type Game = "ja" | "jo";

/** A JKHub file the community recommends. */
export interface CommunityRecommendation {
  jkhubId: number;
  title: string;
}

/** The kinds of link a community may list, each held to its own hosts. */
export type CommunityLinkKind = "youtube" | "twitch" | "telegram" | "vk" | "steam" | "github" | "other";

export interface CommunityLink {
  /** One of {@link CommunityLinkKind}; a string so a kind added later still reads. */
  kind: string;
  url: string;
}

/** An account as a community names it: the owner, an editor, a regular. */
export interface CommunityPerson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * TODO(S6): the last `getstatus` answer of a server, which the service will
 * poll every 5 minutes. Provisional: the launcher asks the server itself over
 * UDP and fills the same shape from its own answer.
 */
export interface CommunityLiveStatus {
  /** `sv_hostname` with its colour codes, when the answer carried it. */
  hostnameRaw?: string;
  hostnameClean?: string;
  map: string;
  /** The `g_gametype` number, or `null` when the server does not say. */
  gametype: number | null;
  /** Real players, bots left out. */
  players: number;
  bots: number;
  maxPlayers: number;
  password: boolean;
  /** When the server answered, RFC 3339 in UTC. */
  at: string;
  /** The names, when the answer carried them. */
  names?: CommunityLivePlayer[];
}

/** One player of a live answer. */
export interface CommunityLivePlayer {
  /** The name with its colour codes. */
  nameRaw: string;
  nameClean: string;
  score: number;
  ping: number;
  bot: boolean;
}

/** A game server of a community: `Server` in the contract. */
export interface CommunityServer {
  id: string;
  game: Game;
  /** `IPv4:port`. */
  address: string;
  /** What the community calls it: «Duel», «RP». Empty when it has no label. */
  label: string;
  position: number;
  /** Proven by a code in `sv_hostname` or approved by an administrator. */
  verified: boolean;
  verifiedAt: string | null;
  /** TODO(S6): the service's last live answer. */
  status?: CommunityLiveStatus | null;
}

/** The numbers every card and page carries. */
export interface CommunityCounts {
  followers: number;
  /** Players with 3 days of 10 minutes or more in the last 30 days. */
  regulars: number;
  upcomingEvents: number;
  /** TODO(S6): people on the community's servers now. */
  online?: number | null;
  /** TODO(S6): the sum of people over the week's samples, in hours. */
  playerHours?: number | null;
  /** TODO(S6): the place in the week's top, from 1. */
  rank?: number | null;
}

/** What the reader is to the page. `null` for a guest. */
export interface CommunityViewer {
  role: "owner" | "editor" | null;
  isAdmin: boolean;
  following: boolean;
  /** Notifications of the subscription; `false` while not following. */
  notify: boolean;
}

/** A bundle the community recommends as its client, while everyone can see it. */
export interface CommunityBundleRef {
  id: string;
  name: string;
}

/** An entry of the catalogue: `Card` in the contract. */
export interface CommunityCard {
  id: string;
  name: string;
  tagline: string;
  website: string;
  discord: string;
  links: CommunityLink[];
  tags: string[];
  languages: string[];
  region: string | null;
  bundle: CommunityBundleRef | null;
  /** SHA-256 of the picture in the store of the service, or `null`. */
  logo: string | null;
  banner: string | null;
  ownerId: string | null;
  owner: CommunityPerson | null;
  /** The **JKNet community** mark an administrator sets. */
  featured: boolean;
  /** In the catalogue without an owner, by an administrator's decision. */
  listed: boolean;
  /** The community has an owner. */
  verified: boolean;
  /** The games of the servers the reader can see, sorted. */
  games: Game[];
  servers: CommunityServer[];
  counts: CommunityCounts;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** A community page: `Community` in the contract. */
export interface Community extends CommunityCard {
  /** Markdown. */
  description: string;
  /** Markdown. */
  rules: string;
  recommendations: CommunityRecommendation[];
  editors: CommunityPerson[];
  viewer: CommunityViewer | null;
}

/** `GET communities`. */
export interface CommunityCatalog {
  communities: CommunityCard[];
  total: number;
}

/** A claim of a server: a code for `sv_hostname`, or a request to an administrator. */
export interface CommunityClaim {
  id: string;
  serverId: string;
  communityId: string;
  userId: string;
  code: string;
  expiresAt: string;
  manual: boolean;
  status: "pending" | "approved" | "rejected";
}

/** `POST communities`: `created` is false when the address already had a community. */
export interface CommunityCreated {
  community: Community;
  server: CommunityServer;
  created: boolean;
}

/** `POST communities/{id}/servers`. `claim` is `null` for an administrator. */
export interface CommunityServerAdded {
  community: Community;
  server: CommunityServer;
  claim: CommunityClaim | null;
}

/**
 * `POST claims/{id}/verify`: the community the server ended up in, with the
 * `game` and `address` of the page of before for JKNet 0.10.0.
 */
export type CommunityVerified = Community & { game: Game; address: string };

/** A community of `GET me`, with what the player is to it. */
export interface MyCommunity extends CommunityCard {
  role: "owner" | "editor" | null;
}

/** `GET me`. */
export interface CommunityMe {
  isAdmin: boolean;
  userId: string;
  /** The pages of before; kept by the service for JKNet 0.10.0. */
  servers: LegacyPage[];
  /** The claims of before, `serverId` naming the community. */
  claims: LegacyClaim[];
  communities: MyCommunity[];
  /** The claims of this contract, `serverId` naming the server. */
  serverClaims: CommunityClaim[];
}

/** A manual claim awaiting an administrator: an item of `GET admin/claims`. */
export interface CommunityReview {
  claim: CommunityClaim;
  server: LegacyPage;
  community: CommunityCard;
  communityServer: CommunityServer;
  user: CommunityPerson & { provider: string; providerName: string; createdAt: string };
}

/** An entry of `GET following`. */
export interface FollowedCommunity extends CommunityCard {
  notify: boolean;
  followedAt: string;
}

/**
 * A regular player of `GET communities/{id}/players`.
 *
 * The window is 30 complete days in UTC that end yesterday: today's play
 * never shows, and `lastPlayed` is yesterday at the latest. Only verified
 * servers count, and the founding server of a community an administrator
 * listed.
 */
export interface CommunityRegular {
  user: CommunityPerson;
  /** Days of the window with 10 minutes or more. */
  days: number;
  /**
   * Whole hours of the window on the community's servers, rounded down.
   * Optional until the service that sends it is deployed.
   */
  hours?: number;
  /** The last day of play, `YYYY-MM-DD` in UTC; yesterday at the latest. */
  lastPlayed: string;
  /** A friend of the reader; always `false` for a guest. */
  friend: boolean;
}

/** `GET communities/{id}/players`. */
export interface CommunityRegulars {
  regulars: CommunityRegular[];
  total: number;
  windowDays: number;
  minDays: number;
  minMinutesPerDay: number;
}

/** The Discord server an invite leads to. */
export interface DiscordInvite {
  code: string;
  guildId: string;
  name: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  splashUrl: string | null;
  description: string | null;
  members: number | null;
  online: number | null;
  expiresAt: string | null;
}

export interface DiscordMember {
  name: string;
  avatarUrl: string | null;
  status: "online" | "idle" | "dnd" | string;
  activity?: string | null;
}

export interface DiscordChannel {
  id: string;
  name: string;
  position: number;
  members: DiscordMember[];
}

/** The public widget of the Discord server; `{ enabled: false }` when the owner keeps it off. */
export type DiscordWidget =
  | { enabled: false }
  | {
      enabled: true;
      online: number;
      instantInvite: string | null;
      channels: DiscordChannel[];
      members: DiscordMember[];
      membersTotal: number;
    };

/** `GET communities/{id}/discord`. */
export interface CommunityDiscord {
  inviteStatus: "ok" | "invalid" | "unavailable" | "none";
  invite: DiscordInvite | null;
  widget: DiscordWidget | null;
  fetchedAt: string;
}

/** TODO(S6): a place of `GET ranking`, the week's top by player-hours. */
export interface CommunityRankingEntry {
  rank: number;
  community: CommunityCard;
  playerHours: number;
}

/** TODO(S6): `GET communities/{id}/activity`. */
export interface CommunityActivity {
  /** 168 hours of the week in UTC, Monday 00:00 first: the average of people. */
  heatmap: number[];
  peak: { players: number; at: string } | null;
  playerHours: number;
  online: number;
}

/** TODO(S4): an event of `GET events` and `GET events/{id}`. */
export interface CommunityEvent {
  id: string;
  communityId: string;
  title: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "cancelled";
  going: number;
  maybe: number;
  capacity: number | null;
}

/** TODO(S5): a post of `GET communities/{id}/posts`. */
export interface CommunityPost {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  author: CommunityPerson;
  createdAt: string;
}

/** A page of the routes of before: the community as JKNet 0.10.0 reads it. */
export interface LegacyPage {
  id: string;
  game: Game;
  address: string;
  name: string;
  description: string;
  website: string;
  discord: string;
  rules: string;
  recommendations: CommunityRecommendation[];
  ownerId: string | null;
  featured: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** A claim of the routes of before, `serverId` naming the community. */
export type LegacyClaim = Omit<CommunityClaim, "communityId">;

/**
 * One call of the contract: a method, a path under `/v1/community/` and an
 * optional body. The launcher answers it through its core, the website and
 * the web app over HTTP.
 */
export type CommunityRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** A JKHub file id out of a link or a bare number, or `null` when it is neither. */
export function jkhubId(value: string): number | null {
  const trimmed = value.trim();
  if (/^[1-9]\d{0,8}$/.test(trimmed)) return Number(trimmed);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "jkhub.org" || url.username || url.password) return null;
    const match = /^\/files\/file\/([1-9]\d{0,8})(?:-[^/]+)?\/?$/.exec(url.pathname);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
