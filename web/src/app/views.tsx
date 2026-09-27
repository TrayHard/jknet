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
import { FriendDetailsScreen, FriendTitle } from "./screens/FriendDetailsScreen.tsx";
import { FriendsScreen } from "./screens/FriendsScreen.tsx";
import { PendingScreen } from "./screens/PendingScreen.tsx";
import { RequestsScreen } from "./screens/RequestsScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";

type Params = Record<string, string | undefined>;

function screen(id: ScreenId, spec: RouteSpec, params: Params): ReactNode {
  switch (id) {
    case "friends":
      return (
        <FriendsScreen selectedId={params.userId} requestsOpen={spec.detail === "requests"} />
      );
    case "requests":
      return <RequestsScreen />;
    case "friendDetails":
      return <FriendDetailsScreen key={params.userId} userId={params.userId ?? ""} />;
    case "settings":
      return <SettingsScreen current={spec.path.split("/")[2]} />;
    case "account":
      return <AccountScreen />;
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

export function viewOf(spec: RouteSpec, params: Params, t: TFunction<"web">): RouteView {
  return {
    section: spec.section,
    title: titleOf(spec, t),
    list: screen(spec.list, spec, params),
    detail: spec.detail === undefined ? undefined : screen(spec.detail, spec, params),
    aside: spec.aside === undefined ? undefined : screen(spec.aside, spec, params),
    asideTitle: spec.aside === undefined ? undefined : t("nav.sections.chats"),
    parent: parentOf(spec, params),
    defaultDetail: spec.defaultDetail,
    detailHeader:
      spec.detail === "friendDetails" && params.userId !== undefined ? <FriendTitle userId={params.userId} /> : undefined,
  };
}
