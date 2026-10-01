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
 * | `serverStatus` | UDP `getstatus` of the core, the service's poll when it fails | the service's poll | the service's poll |
 * | `canManage` | yes | yes | no: read and follow |
 * | pictures: a page's logo and cover, an event's cover | `pickImage`: the core's dialog and upload | `putBlob` after a file input | — |
 * | `friends`, `findBundles` | the friends list, the bundle catalogue | `GET /v1/friends`, `GET /v1/bundles` | — |
 * | `manageUrl` | — | — | the website's management screen |
 * | `renderNewsComposer` | the composer of the news | the same | — |
 * | `openExternalLater` | — | a tab opened on the click, filled when the link comes | — |
 * | `setUnsaved` | the launcher's guard: a route change and closing the window ask | `beforeunload` and the site's own routes ask | — |
 * | `subscribePosts` | `community:post` of the live socket | — | — |
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { communityApi, type CommunityApi } from "./api";
import type {
  Community,
  CommunityBundleRef,
  CommunityLiveStatus,
  CommunityPerson,
  CommunityPost,
  CommunityRequest,
  CommunityServer,
  Game,
} from "./types";

export type CommunityHost = "launcher" | "website" | "web";

/** The tabs of the catalogue screen. */
export type CatalogTab = "catalog" | "mine" | "following";

/** The tabs of a community page. `manage` is the organizers'. */
export type PageTab = "overview" | "servers" | "events" | "players" | "news" | "manage";

export const CATALOG_TABS: readonly CatalogTab[] = ["catalog", "mine", "following"];
export const PAGE_TABS: readonly PageTab[] = ["overview", "servers", "events", "players", "news", "manage"];

/** The sections of the management screen, in the order of its navigation. */
export const MANAGE_SECTIONS = ["profile", "images", "links", "tags", "files", "bundle", "servers", "team", "bot", "admin"] as const;

export type ManageSection = (typeof MANAGE_SECTIONS)[number];

/**
 * Where the community screens are: the catalogue on a tab, a page on a tab,
 * or the management screen of a page, scrolled to a section.
 */
export type CommunityRoute =
  | { view: "catalog"; tab: CatalogTab }
  | { view: "community"; id: string; tab: PageTab }
  | { view: "manage"; id: string; section?: ManageSection };

/** A section of the management screen out of a query value, or none. */
export function manageSection(value: string | null | undefined): ManageSection | undefined {
  return (MANAGE_SECTIONS as readonly string[]).includes(value ?? "") ? (value as ManageSection) : undefined;
}

/** The two pictures of a community. `banner` is the cover of its page. */
export type CommunityImageKind = "logo" | "banner";

/**
 * A picture the screens put in the store: one of a community, or the cover
 * of an event, which the service takes on the terms of a page's cover.
 */
export type PictureKind = CommunityImageKind | "cover";

/** A picture the host put in the store of the service, ready to bind to a community or an event. */
export interface UploadedImage {
  /** Lowercase hex: the address of the picture in the store. */
  sha256: string;
  /** Bytes, as stored. */
  size: number;
  /** The name of the file the organizer picked, for the screen to show. */
  fileName: string;
  width: number | null;
  height: number | null;
}

/** Why a picture was not taken before it was uploaded. */
export type ImageRefusal = { reason: "tooBig"; fileName: string; maxBytes: number } | { reason: "notPicture"; fileName: string };

/** What the launcher's dialog came back with: nothing, a refusal, or a picture in the store. */
export type PickedImage = { outcome: "cancelled" } | ({ outcome: "refused" } & ImageRefusal) | ({ outcome: "uploaded" } & UploadedImage);

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

/** What the composer of the news is given by the **News** tab. */
export interface NewsComposerProps {
  community: Community;
  /** The post being changed, or `null` for a new one. */
  editing: CommunityPost | null;
  /** How many posts the community pins now: it pins three at most. */
  pinned: number;
  /** A post went out or a change of one was saved. */
  onSaved: (post: CommunityPost, created: boolean) => void;
  /** **Cancel** of a change: the composer goes back to a new post. */
  onCancel: () => void;
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
  /**
   * The launcher's way to a picture — a logo or a cover of a community, the
   * cover of an event: the system dialog of the core, which checks the file,
   * strips what a photo records of its taking and uploads it. A host without
   * it gets a file input and `putBlob` (`usePictureUpload`).
   */
  pickImage?: (kind: PictureKind) => Promise<PickedImage>;
  /** Puts bytes in the store of the service under their SHA-256: `PUT /v1/blobs/{sha256}`. */
  putBlob?: (sha256: string, file: Blob) => Promise<void>;
  /**
   * The reader's JKNet friends, for naming editors and handing a community
   * over. `null` while the host is still asking; `undefined` where it cannot.
   */
  friends?: CommunityPerson[] | null;
  /** Public bundles of JKNet Online for one game, matching `query`, for the community's client. */
  findBundles?: (query: string, game: Game) => Promise<CommunityBundleRef[]>;
  /** The address of the management screen on another host, for a host that only reads. */
  manageUrl?: (id: string) => string;
  /**
   * The composer of the news, with the Markdown editor of the management
   * screen: a host that manages imports it from `./manage`, so a host that
   * only reads never bundles the editor.
   */
  renderNewsComposer?: (props: NewsComposerProps) => ReactNode;
  /**
   * Opens a tab at once, during the click, and fills it when the address
   * comes: a browser lets a page open a tab only while the click lasts, and
   * the address of the JKNet bot comes from the service after it. `null`
   * closes the tab. A host that opens links outside the page leaves it out.
   */
  openExternalLater?: () => (url: string | null) => void;
  /**
   * The management screen holds edits nobody saved (`true`) or none any
   * more (`false`): the host asks before a route change or closing the
   * window loses them.
   */
  setUnsaved?: (dirty: boolean) => void;
  /**
   * Hears the posts of the news as they come out — the launcher's
   * `community:post`, from the live socket — so an open page reads its news
   * again. Answers the function that stops listening.
   */
  subscribePosts?: (listener: (communityId: string) => void) => () => void;
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
