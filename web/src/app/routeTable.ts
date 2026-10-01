/**
 * The routes of the web app as data: which section, which panes, where "up"
 * leads. `routes.tsx` puts the screens on them; the layouts read the panes
 * and the parent. Pure, so `routeTable.test.mjs` checks the table under
 * `node --test`.
 *
 * | Path                        | Panes                 | Parent               |
 * | --------------------------- | --------------------- | -------------------- |
 * | `/chats`                    | list                  | —                    |
 * | `/c/:conversationId`        | list, detail          | `/chats`             |
 * | `/c/:conversationId/info`   | list, detail, aside   | `/c/:conversationId` |
 * | `/friends`                  | list                  | —                    |
 * | `/friends/requests`         | list, detail          | `/friends`           |
 * | `/friends/:userId`          | list, detail          | `/friends`           |
 * | `/community`, `/events`, `/servers`, `/bundles`, `/jkhub` | list | —        |
 * | their details               | list, detail          | the section root     |
 *
 * A bundle's page is `/bundles/:bundleId`: the service reads a bundle by its
 * id, not by its slug.
 * | `/settings`                 | list (wide: `/settings/account`) | —         |
 * | `/settings/<page>`          | list, detail          | `/settings`          |
 */

export type Section = "chats" | "friends" | "community" | "events" | "servers" | "bundles" | "jkhub" | "settings";

export const SECTIONS: readonly Section[] = ["chats", "friends", "community", "events", "servers", "bundles", "jkhub", "settings"];

/** The root path of each section. */
export const SECTION_ROOTS: Record<Section, string> = {
  chats: "/chats",
  friends: "/friends",
  community: "/community",
  events: "/events",
  servers: "/servers",
  bundles: "/bundles",
  jkhub: "/jkhub",
  settings: "/settings",
};

/** The screens a route can put in a pane. */
export type ScreenId =
  | "chatList"
  | "thread"
  | "groupInfo"
  | "friends"
  | "requests"
  | "friendDetails"
  | "community"
  | "communityDetails"
  // --- slice: community events ---
  | "events"
  | "eventDetails"
  | "serverList"
  | "serverDetails"
  | "bundles"
  | "bundleDetails"
  | "jkhub"
  | "jkhubDetails"
  | "settings"
  | "account"
  | "notifications"
  | "privacy"
  | "sessions"
  | "install"
  | "about";

export interface RouteSpec {
  path: string;
  section: Section;
  list: ScreenId;
  detail?: ScreenId;
  aside?: ScreenId;
  /** The "up" target, a pattern with the params of `path`. */
  parent?: string;
  /** The wide layout replaces this root with it: it has no empty pane. */
  defaultDetail?: string;
}

export const ROUTES: readonly RouteSpec[] = [
  { path: "/chats", section: "chats", list: "chatList" },
  { path: "/c/:conversationId", section: "chats", list: "chatList", detail: "thread", parent: "/chats" },
  {
    path: "/c/:conversationId/info",
    section: "chats",
    list: "chatList",
    detail: "thread",
    aside: "groupInfo",
    parent: "/c/:conversationId",
  },
  { path: "/friends", section: "friends", list: "friends" },
  { path: "/friends/requests", section: "friends", list: "friends", detail: "requests", parent: "/friends" },
  { path: "/friends/:userId", section: "friends", list: "friends", detail: "friendDetails", parent: "/friends" },
  { path: "/community", section: "community", list: "community" },
  { path: "/community/:serverId", section: "community", list: "community", detail: "communityDetails", parent: "/community" },
  // --- slice: community events --- the calendar of every community, and one event.
  { path: "/events", section: "events", list: "events" },
  { path: "/events/:eventId", section: "events", list: "events", detail: "eventDetails", parent: "/events" },
  { path: "/servers", section: "servers", list: "serverList" },
  { path: "/servers/:game/:address", section: "servers", list: "serverList", detail: "serverDetails", parent: "/servers" },
  { path: "/bundles", section: "bundles", list: "bundles" },
  { path: "/bundles/:bundleId", section: "bundles", list: "bundles", detail: "bundleDetails", parent: "/bundles" },
  { path: "/jkhub", section: "jkhub", list: "jkhub" },
  { path: "/jkhub/:game/:fileId", section: "jkhub", list: "jkhub", detail: "jkhubDetails", parent: "/jkhub" },
  { path: "/settings", section: "settings", list: "settings", defaultDetail: "/settings/account" },
  { path: "/settings/account", section: "settings", list: "settings", detail: "account", parent: "/settings" },
  { path: "/settings/notifications", section: "settings", list: "settings", detail: "notifications", parent: "/settings" },
  { path: "/settings/privacy", section: "settings", list: "settings", detail: "privacy", parent: "/settings" },
  { path: "/settings/sessions", section: "settings", list: "settings", detail: "sessions", parent: "/settings" },
  { path: "/settings/install", section: "settings", list: "settings", detail: "install", parent: "/settings" },
  { path: "/settings/about", section: "settings", list: "settings", detail: "about", parent: "/settings" },
];

/** Where `/` and every unknown path go. */
export const HOME = "/chats";

/** The paths outside the layout, drawn full page. */
export const SIGN_IN = "/signin";
export const SIGN_IN_DONE = "/signin/done";

/** A pattern with its params filled in, each one URL-encoded. */
export function fillPath(pattern: string, params: Record<string, string | undefined>): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ""));
}

/** The params of a path under a pattern, or `null` when it does not match. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter((part) => part !== "");
  const have = pathname.split("/").filter((part) => part !== "");
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(":")) {
      try {
        params[want[i].slice(1)] = decodeURIComponent(have[i]);
      } catch {
        return null;
      }
    } else if (want[i] !== have[i]) {
      return null;
    }
  }
  return params;
}

/**
 * The route a path belongs to. Static segments win over params, as in
 * `react-router`: `/friends/requests` is the requests, not a friend.
 */
export function findRoute(pathname: string): { spec: RouteSpec; params: Record<string, string> } | null {
  let best: { spec: RouteSpec; params: Record<string, string>; score: number } | null = null;
  for (const spec of ROUTES) {
    const params = matchPath(spec.path, pathname);
    if (params === null) continue;
    const score = spec.path.split("/").filter((part) => part !== "" && !part.startsWith(":")).length;
    if (best === null || score > best.score) best = { spec, params, score };
  }
  return best === null ? null : { spec: best.spec, params: best.params };
}

/** The "up" path of a route with its params, or `undefined` on a root. */
export function parentOf(spec: RouteSpec, params: Record<string, string | undefined>): string | undefined {
  return spec.parent === undefined ? undefined : fillPath(spec.parent, params);
}
