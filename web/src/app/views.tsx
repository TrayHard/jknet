/**
 * The screens of each route: `RouteView` out of a row of `routeTable.ts` and
 * the route's params. The layouts decide where each pane goes.
 *
 * A screen a later part of the web app brings is `PendingScreen` until then;
 * its route, its panes and its parent are already final.
 */

import type { TFunction } from "i18next";
import type { ReactNode } from "react";

import type { RouteView } from "./layouts/types.ts";
import { parentOf, type RouteSpec, type ScreenId } from "./routeTable.ts";
import { AboutScreen } from "./screens/AboutScreen.tsx";
import { AccountScreen } from "./screens/AccountScreen.tsx";
import { BundleDetailsScreen } from "./screens/BundleDetailsScreen.tsx";
import { BundlesScreen } from "./screens/BundlesScreen.tsx";
import { ChatListScreen } from "./screens/ChatListScreen.tsx";
import { CommunityDetailsScreen } from "./screens/CommunityDetailsScreen.tsx";
import { CommunityScreen } from "./screens/CommunityScreen.tsx";
import { FriendDetailsScreen, FriendTitle } from "./screens/FriendDetailsScreen.tsx";
import { FriendsScreen } from "./screens/FriendsScreen.tsx";
import { GroupInfoScreen } from "./screens/GroupInfoScreen.tsx";
import { InstallScreen } from "./screens/InstallScreen.tsx";
import { NotificationsScreen } from "./screens/NotificationsScreen.tsx";
import { PendingScreen } from "./screens/PendingScreen.tsx";
import { PrivacyScreen } from "./screens/PrivacyScreen.tsx";
import { RequestsScreen } from "./screens/RequestsScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { ThreadScreen } from "./screens/ThreadScreen.tsx";

type Params = Record<string, string | undefined>;

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
    case "friends":
      return (
        <FriendsScreen selectedId={params.userId} requestsOpen={spec.detail === "requests"} />
      );
    case "requests":
      return <RequestsScreen />;
    case "friendDetails":
      return <FriendDetailsScreen key={params.userId} userId={params.userId ?? ""} />;
    case "community":
      return <CommunityScreen selectedId={params.serverId} />;
    case "communityDetails":
      return <CommunityDetailsScreen key={params.serverId} serverId={params.serverId ?? ""} />;
    case "bundles":
      return <BundlesScreen selectedId={params.bundleId} />;
    case "bundleDetails":
      return <BundleDetailsScreen key={params.bundleId} bundleId={params.bundleId ?? ""} />;
    case "settings":
      return <SettingsScreen current={spec.path.split("/")[2]} />;
    case "account":
      return <AccountScreen />;
    case "install":
      return <InstallScreen />;
    case "about":
      return <AboutScreen />;
    default:
      return <PendingScreen />;
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
