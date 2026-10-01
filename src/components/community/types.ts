/**
 * The wire types of the communities contract of JKNet Online
 * (`/v1/community/…`), one to one with the service's `community/wire.rs`,
 * `community/discord.rs` and the routes of before.
 *
 * The launcher, the website and the web app read the same shapes: the
 * launcher through the `community_request` bridge of the core, the other two
 * over HTTP. Field names are camelCase on the wire.
 *
 * The fields of the news, the live status, the activity, the top communities
 * and the JKNet bot came with later slices of the service: a service from
 * before them leaves them out, so they are optional here and the screens
 * draw nothing of a part the service does not answer. Events have their own
 * types in `components/events/types.ts`.
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
 * What the screens draw of a server now: its last `getstatus` answer. The
 * launcher fills it from its own UDP answer, every host from the service's
 * {@link CommunityServerStatus} (`liveOfService` in `ServerBlock.tsx`).
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

/** A player of the service's live status: `LivePlayer` in the contract. */
export interface CommunityServerPlayer {
  /** The name as the server sent it, colour codes included. */
  name: string;
  /** The name without its colour codes `^0` to `^9`. */
  cleanName: string;
  score: number;
  ping: number;
  /** A bot: the engine gives a bot ping 0. */
  bot: boolean;
}

/**
 * The service's last poll of a server, every 5 minutes: `ServerStatus` in
 * the contract. A server that stopped answering keeps the name, map, mode,
 * slots and password of its last answer, with no players.
 */
export interface CommunityServerStatus {
  /** The server answered the last poll. */
  online: boolean;
  /** `sv_hostname` with its colour codes; `null` until it answered once. */
  hostname: string | null;
  cleanHostname: string | null;
  /** Lowercased: `mp/ffa3`. */
  map: string | null;
  gametype: number | null;
  /** Players with a ping above 0, at most the slots; 0 while it does not answer. */
  humans: number;
  bots: number;
  /** Public slots: `sv_maxclients` less `sv_privateClients`. */
  maxClients: number | null;
  needPass: boolean | null;
  /** The players of the last answer, the highest score first. */
  players: CommunityServerPlayer[];
  /** When the poll asked, RFC 3339. */
  checkedAt: string;
  /** When the server last answered; `null` while it has not since the service started. */
  lastOnlineAt: string | null;
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
  /**
   * The service's last poll, on a page only: a list leaves the key out. `null`
   * until the poller read the server, and always for a server whose control
   * is not established.
   */
  status?: CommunityServerStatus | null;
}

/** The numbers every card and page carries. */
export interface CommunityCounts {
  followers: number;
  /** The regular players, by the service's rule. */
  regulars: number;
  upcomingEvents: number;
  /** Humans on the established servers at the service's last poll. */
  online?: number | null;
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
  /** The place in the top communities, from 1; `null` outside it. */
  rank?: number | null;
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
 * A regular player of `GET communities/{id}/players`: a JKNet player the
 * service counts as a regular of the community's servers, by its own rule.
 * The list comes in the service's order.
 */
export interface CommunityRegular {
  user: CommunityPerson;
  /** The last day of play, `YYYY-MM-DD` in UTC. */
  lastPlayed: string;
  /** A friend of the reader; always `false` for a guest. */
  friend: boolean;
}

/** `GET communities/{id}/players`. */
export interface CommunityRegulars {
  regulars: CommunityRegular[];
  total: number;
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

/** A channel of the linked Discord server that everyone in it can see. */
export interface DiscordBotChannel {
  id: string;
  name: string;
  /** `text` or `announcement`; a string, so a kind added later still reads. */
  kind: string;
  /** The category the channel sits in, or `null`. */
  category: string | null;
  /** The channel in Discord. */
  url: string;
}

/** A message of the announcements channel, as plain text with names for mentions. */
export interface DiscordBotMessage {
  id: string;
  /** The display name of the author, else the user name. */
  author: string;
  content: string;
  /** RFC 3339 in UTC. */
  postedAt: string;
  /** The message in Discord. */
  url: string;
  /** Files attached to the message. */
  attachments: number;
}

/** The latest messages of the announcements channel, the newest first. */
export interface DiscordBotAnnouncements {
  channelId: string;
  channelName: string;
  url: string;
  messages: DiscordBotMessage[];
}

/**
 * What the JKNet bot read in the Discord server linked to the community:
 * `bot` of the Discord card. `{ linked: false }` reaches an organizer while
 * the bot is on and not linked yet.
 */
export interface DiscordBot {
  linked: boolean;
  /** `null` until the bot has read the server. */
  guildName?: string | null;
  /** The channels the page lists, while the organizers show them. */
  channels?: DiscordBotChannel[];
  announcements?: DiscordBotAnnouncements | null;
  /** When the bot read the server; `null` until it has. */
  syncedAt?: string | null;
  // What only the organizers see.
  guildId?: string;
  showChannels?: boolean;
  announcementsChannelId?: string | null;
  /** Every channel the announcements may come from, listed or not. */
  availableChannels?: DiscordBotChannel[];
  /** `no_access`, `announcements_hidden`, `announcements_denied`, `bot_token`, `unavailable`, or `null`. */
  error?: string | null;
  /** The community's invite leads to another Discord server. */
  inviteGuildMismatch?: boolean;
  linkedAt?: string;
}

/** `GET communities/{id}/discord`. */
export interface CommunityDiscord {
  inviteStatus: "ok" | "invalid" | "unavailable" | "none";
  invite: DiscordInvite | null;
  widget: DiscordWidget | null;
  fetchedAt: string;
  /**
   * The JKNet bot: `null` while the bot is off on the service, and for a
   * reader who is not an organizer while it has nothing to show. A service
   * from before the bot leaves the key out.
   */
  bot?: DiscordBot | null;
}

/** `POST communities/{id}/discord/bot/link`: Discord's page that adds the bot. */
export interface DiscordBotLink {
  url: string;
  /** When the link stops working, RFC 3339. */
  expiresAt: string;
}

/** A place of the top communities, as the screens read `GET ranking`. */
export interface CommunityRankingEntry {
  /** From 1. */
  rank: number;
  community: CommunityCard;
  /** The community's followers. */
  followers: number;
}

/** `GET communities/{id}/activity`: how busy the established servers are. */
export interface CommunityActivity {
  /**
   * 168 numbers: the average humans in each UTC hour of the week, Monday
   * 00:00 first, over the hours of the last 28 days that have samples.
   */
  heatmap: number[];
  /** The most humans in one hour of the last 28 days and the start of that hour; `null` while nobody played. */
  peak: { humans: number; at: string } | null;
  onlineNow: number;
  /** UTC days of the last 28 with samples: how much the heat map knows. */
  days: number;
}

/** A post of the news of a community: `Post` in the contract. */
export interface CommunityPost {
  id: string;
  communityId: string;
  /** One line of at most 100 characters, or empty. */
  title: string;
  /** Markdown, 1 to 4000 characters. */
  body: string;
  /** Pinned posts come first; a community pins at most 3. */
  pinned: boolean;
  /** The organizer who wrote it, while the account exists. */
  author: CommunityPerson | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** What a signed-in reader may do with it; `null` for a guest. */
  viewer: { canEdit: boolean } | null;
}

/** `GET communities/{id}/posts`: a page of the news and the cursor of the next one. */
export interface CommunityPosts {
  posts: CommunityPost[];
  /** Passed as `before`, it asks for the older posts that are not pinned; `null` after the last page. */
  next: string | null;
}

/** The body of `POST communities/{id}/posts`. */
export interface NewPostBody {
  title?: string;
  body: string;
  pinned?: boolean;
  /** Off: the followers hear nothing of it. On by default. */
  notifyFollowers?: boolean;
}

/** The body of `PUT posts/{id}`: a field left out keeps its value. */
export interface PostPatch {
  title?: string | null;
  body?: string;
  pinned?: boolean;
  /** The revision of the post the change was made on; another one answers `409`. */
  revision: number;
}

/** The post a `community.post` frame names: enough for a toast. */
export interface CommunityPostSummary {
  id: string;
  communityId: string;
  communityName: string;
  title: string;
  /** The first 140 characters of the body as plain text. */
  excerpt: string;
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
