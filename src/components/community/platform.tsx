/**
 * What the host of the community screens gives them.
 *
 * One code base draws the catalogue and the pages of communities in three
 * places: the launcher, the website `jknet.app/servers/` and the web app.
 * Everything that differs between them — how a request reaches the service,
 * who is signed in, where a link opens, how a route is written, whether the
 * game can be installed and joined from here — comes through this object,
 * which the host builds once and hands down through {@link CommunityPlatformProvider}.
 *
 * | | launcher | website | web app |
 * | --- | --- | --- | --- |
 * | `request` | `community_request` of the core | `fetch` with the session token | the web core |
 * | `navigate` | `#/community/:id?tab=` | `/servers/?id=&tab=` | `/community/:id?tab=` |
 * | `renderPlay`, `renderFiles` | client, install, join | — | — |
 * | `serverStatus` | UDP `getstatus` of the core | — | — |
 * | `canManage` | yes | yes | no: read and follow |
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { communityApi, type CommunityApi } from "./api";
import type { Community, CommunityLiveStatus, CommunityRequest, CommunityServer, Game } from "./types";

export type CommunityHost = "launcher" | "website" | "web";

/** The tabs of the catalogue screen. */
export type CatalogTab = "catalog" | "mine" | "following";

/** The tabs of a community page. `manage` is the organizers'. */
export type PageTab = "overview" | "servers" | "players" | "manage";

export const CATALOG_TABS: readonly CatalogTab[] = ["catalog", "mine", "following"];
export const PAGE_TABS: readonly PageTab[] = ["overview", "servers", "players", "manage"];

/** Where the community screens are: the catalogue on a tab, or a page on a tab. */
export type CommunityRoute =
  | { view: "catalog"; tab: CatalogTab }
  | { view: "community"; id: string; tab: PageTab };

/** A tab of the catalogue out of a query value, the catalogue itself by default. */
export function catalogTab(value: string | null | undefined): CatalogTab {
  return (CATALOG_TABS as readonly string[]).includes(value ?? "") ? (value as CatalogTab) : "catalog";
}

/** A tab of a page out of a query value, the overview by default. */
export function pageTab(value: string | null | undefined): PageTab {
  return (PAGE_TABS as readonly string[]).includes(value ?? "") ? (value as PageTab) : "overview";
}

/** What the launcher's play controls are given: the page and the server picked in **Play**. */
export interface PlayContext {
  community: Community;
  /** The server the buttons join; `null` when the community shows none. */
  server: CommunityServer | null;
}

/** A server to create a community for, from the launcher's server panel. */
export interface CommunitySeed {
  address: string;
  name: string;
  game: Game;
}

export interface CommunityPlatform {
  host: CommunityHost;
  /** One call of the contract, `/v1/community/` implied. */
  request: CommunityRequest;
  signedIn: boolean;
  /** The account id while signed in; `null` for a guest. */
  accountId: string | null;
  /** The service's origin, for pictures of its store: `https://api.jknet.app`. */
  apiBase: string;
  /** Starts a sign-in: the launcher's account card, the website's dialog. */
  signIn: () => void;
  /** Opens an address outside: the system browser, a new tab. */
  openExternal: (url: string) => void;
  navigate: (route: CommunityRoute) => void;
  /** The address of a route, for a real link: a middle click opens it in a new tab. */
  href: (route: CommunityRoute) => string;
  /** Creating communities, claiming servers and editing pages. The web app only reads and follows. */
  canManage: boolean;
  /**
   * The game the catalogue shows: the launcher's switch in the sidebar.
   * `undefined` where the host has none, and the catalogue offers both.
   */
  game?: Game;
  /** The address of a community's public page, for **Share**. */
  pageUrl: (id: string) => string;
  /** The launcher's controls of **Play**: the client, installing and joining. */
  renderPlay?: (context: PlayContext) => ReactNode;
  /** The launcher's list of recommended files, with what the chosen client already has. */
  renderFiles?: (community: Community) => ReactNode;
  /** What a server says of itself now; the launcher asks it over UDP. */
  serverStatus?: (address: string, game: Game) => Promise<CommunityLiveStatus>;
  /** Shares a page some other way than copying its address: the web app's chat. */
  share?: (community: Community) => void;
  /** The label of that other way, when there is one. */
  shareLabel?: string;
  /** Opens a bundle of JKNet Online: the launcher's Bundles tab, the web app's page of it. */
  openBundle?: (bundleId: string) => void;
  /** Opens the setting that hides the player from the regular players. */
  openPrivacySettings?: () => void;
  /** What a host says instead of **Play** when it cannot start the game. */
  playNote?: ReactNode;
  /** A server to create a community for, from the launcher's server panel. */
  seed?: CommunitySeed;
  /** Drawn in a pane of a layout that names the section: no heading of its own. */
  embedded?: boolean;
}

const PlatformContext = createContext<CommunityPlatform | null>(null);

export function CommunityPlatformProvider({ platform, children }: { platform: CommunityPlatform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

/** The host of the screen. Every community component sits under a provider. */
export function useCommunityPlatform(): CommunityPlatform {
  const platform = useContext(PlatformContext);
  if (platform === null) throw new Error("Community screens need a CommunityPlatformProvider");
  return platform;
}

/** The client of the contract over the host's transport. */
export function useCommunityApi(): CommunityApi {
  const { request } = useCommunityPlatform();
  return useMemo(() => communityApi(request), [request]);
}
