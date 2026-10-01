/**
 * The screens of each route: `RouteView` out of a row of `routeTable.ts` and
 * the route's params. The layouts decide where each pane goes.
 *
 * The server list, the JKHub catalog and the communities load on first use,
 * each screen in a chunk of its own with the launcher's filters, tree, cards
 * and Markdown it draws, so the first download of the app does not carry them.
 */

import type { TFunction } from "i18next";
import { lazy, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Game } from "../../../src/lib/ipc.ts";
import type { RouteView } from "./layouts/types.ts";
import { parentOf, type RouteSpec, type ScreenId } from "./routeTable.ts";
import { AboutScreen } from "./screens/AboutScreen.tsx";
import { AccountScreen } from "./screens/AccountScreen.tsx";
import { BundleDetailsScreen } from "./screens/BundleDetailsScreen.tsx";
import { BundlesScreen } from "./screens/BundlesScreen.tsx";
import { ChatListScreen } from "./screens/ChatListScreen.tsx";
import { FriendDetailsScreen, FriendTitle } from "./screens/FriendDetailsScreen.tsx";
import { FriendsScreen } from "./screens/FriendsScreen.tsx";
import { GroupInfoScreen } from "./screens/GroupInfoScreen.tsx";
import { InstallScreen } from "./screens/InstallScreen.tsx";
import { NotificationsScreen } from "./screens/NotificationsScreen.tsx";
import { PrivacyScreen } from "./screens/PrivacyScreen.tsx";
import { RequestsScreen } from "./screens/RequestsScreen.tsx";
import { SessionsScreen } from "./screens/SessionsScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { ThreadScreen } from "./screens/ThreadScreen.tsx";

const ServerListScreen = lazy(() =>
  import("./screens/ServerListScreen.tsx").then((module) => ({ default: module.ServerListScreen })),
);
const ServerDetailsScreen = lazy(() =>
  import("./screens/ServerDetailsScreen.tsx").then((module) => ({ default: module.ServerDetailsScreen })),
);
const CommunityScreen = lazy(() =>
  import("./screens/CommunityScreen.tsx").then((module) => ({ default: module.CommunityScreen })),
);
const CommunityDetailsScreen = lazy(() =>
  import("./screens/CommunityDetailsScreen.tsx").then((module) => ({ default: module.CommunityDetailsScreen })),
);
const JkhubScreen = lazy(() => import("./screens/JkhubScreen.tsx").then((module) => ({ default: module.JkhubScreen })));
const JkhubDetailsScreen = lazy(() =>
  import("./screens/JkhubDetailsScreen.tsx").then((module) => ({ default: module.JkhubDetailsScreen })),
);

/** What a pane shows while the chunk of its screen is on the way. */
function Loading() {
  const { t } = useTranslation("common");
  return (
    <p role="status" className="px-16 py-12 text-body-sm text-fg-muted">
      {t("states.loading")}
    </p>
  );
}

/** A screen of its own chunk. */
function Deferred({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

type Params = Record<string, string | undefined>;

/** `ja` or `jo` of a route's param; anything else names no game, and the page is not found. */
function gameParam(value: string | undefined): Game | null {
  return value === "ja" || value === "jo" ? value : null;
}

/** The page of a server or a file under a game the app does not know. */
function UnknownGame({ kind }: { kind: "server" | "jkhub" }) {
  const { t } = useTranslation("web");
  return (
    <div className="flex flex-col gap-16 px-16 py-20 sm:px-32 sm:py-24" data-testid="unknown-game">
      <div role="alert" className="flex flex-col gap-4">
        <h1 className="text-heading-md text-fg">{t(kind === "server" ? "serverList.notListedTitle" : "jkhub.notFoundTitle")}</h1>
        <p className="text-body-sm text-fg-secondary">
          {t(kind === "server" ? "serverList.notListedText" : "jkhub.notFoundText")}
        </p>
      </div>
    </div>
  );
}

function screen(id: ScreenId, spec: RouteSpec, params: Params): ReactNode {
  switch (id) {
    case "chatList":
      return <ChatListScreen selectedId={params.conversationId ?? null} />;
    case "thread":
      return <ThreadScreen key={params.conversationId} conversationId={params.conversationId ?? ""} />;
    case "groupInfo":
      return <GroupInfoScreen key={params.conversationId} conversationId={params.conversationId ?? ""} />;
    case "notifications":
      return <NotificationsScreen />;
    case "privacy":
      return <PrivacyScreen />;
    case "sessions":
      return <SessionsScreen />;
    case "friends":
      return (
        <FriendsScreen selectedId={params.userId} requestsOpen={spec.detail === "requests"} />
      );
    case "requests":
      return <RequestsScreen />;
    case "friendDetails":
      return <FriendDetailsScreen key={params.userId} userId={params.userId ?? ""} />;
    case "community":
      return (
        <Deferred>
          <CommunityScreen selectedId={params.serverId} />
        </Deferred>
      );
    case "communityDetails":
      return (
        <Deferred>
          <CommunityDetailsScreen key={params.serverId} serverId={params.serverId ?? ""} />
        </Deferred>
      );
    case "bundles":
      return <BundlesScreen selectedId={params.bundleId} />;
    case "bundleDetails":
      return <BundleDetailsScreen key={params.bundleId} bundleId={params.bundleId ?? ""} />;
    case "serverList":
      return (
        <Deferred>
          <ServerListScreen selectedAddress={params.address} />
        </Deferred>
      );
    case "serverDetails": {
      const game = gameParam(params.game);
      if (game === null) return <UnknownGame kind="server" />;
      return (
        <Deferred>
          <ServerDetailsScreen key={`${game}/${params.address}`} game={game} address={params.address ?? ""} />
        </Deferred>
      );
    }
    case "jkhub":
      return (
        <Deferred>
          <JkhubScreen />
        </Deferred>
      );
    case "jkhubDetails": {
      const game = gameParam(params.game);
      if (game === null) return <UnknownGame kind="jkhub" />;
      return (
        <Deferred>
          <JkhubDetailsScreen key={`${game}/${params.fileId}`} game={game} fileId={Number(params.fileId ?? "")} />
        </Deferred>
      );
    }
    case "settings":
      return <SettingsScreen current={spec.path.split("/")[2]} />;
    case "account":
      return <AccountScreen />;
    case "install":
      return <InstallScreen />;
    case "about":
      return <AboutScreen />;
    default:
      return null;
  }
}

/** The title of a detail route; the section's name for the rest. */
function titleOf(spec: RouteSpec, t: TFunction<"web">): string {
  switch (spec.detail) {
    case "requests":
      return t("friendsScreen.requests");
    case "account":
    case "notifications":
    case "privacy":
    case "sessions":
    case "install":
    case "about":
      return t(`settings.${spec.detail}`);
    default:
      return t(`nav.sections.${spec.section}`);
  }
}

/** What the layout host knows that a route does not: the details column's title. */
export interface ViewExtras {
  asideTitle?: string;
}

export function viewOf(spec: RouteSpec, params: Params, t: TFunction<"web">, extras: ViewExtras = {}): RouteView {
  return {
    section: spec.section,
    title: titleOf(spec, t),
    list: screen(spec.list, spec, params),
    detail: spec.detail === undefined ? undefined : screen(spec.detail, spec, params),
    aside: spec.aside === undefined ? undefined : screen(spec.aside, spec, params),
    asideTitle: spec.aside === undefined ? undefined : (extras.asideTitle ?? t("nav.sections.chats")),
    parent: parentOf(spec, params),
    defaultDetail: spec.defaultDetail,
    detailHeader:
      spec.detail === "friendDetails" && params.userId !== undefined ? <FriendTitle userId={params.userId} /> : undefined,
    ownHeader: spec.detail === "thread",
  };
}
