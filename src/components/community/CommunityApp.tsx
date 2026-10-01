import type { ReactNode } from "react";

import { cn } from "../../lib/format";
import { CommunityCatalog } from "./CommunityCatalog";
import { CommunityView } from "./CommunityView";
import { CommunityPlatformProvider, type CommunityPlatform, type CommunityRoute } from "./platform";
import "./community.css";

/**
 * The box every community screen is drawn in: its own container for the
 * layout steps, so the screens fold by the width they are given — the
 * launcher's page with or without the chat drawer, a pane of the web app, a
 * phone — and not by the width of the window.
 *
 * `jk-community` is what the website's stylesheet shields from the site's
 * own rules for bare elements.
 */
export function CommunityFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("jk-community @container/community min-w-0 text-body-md text-fg", className)}>{children}</div>;
}

/**
 * The community screens of a host: the catalogue or a page, as the route
 * says. The launcher and the website draw this; the web app puts the
 * catalogue and the page in two panes of its own.
 *
 * The management screen comes from the host through `renderManage`, so a
 * host that never shows it — the web app — never bundles its editors either.
 * Without it, the route of the screen opens the page.
 */
export function CommunityApp({
  platform,
  route,
  renderManage,
}: {
  platform: CommunityPlatform;
  route: CommunityRoute;
  renderManage?: (route: Extract<CommunityRoute, { view: "manage" }>) => ReactNode;
}) {
  return (
    <CommunityPlatformProvider platform={platform}>
      <CommunityFrame className="p-24 @max-[560px]/community:p-16">
        {route.view === "catalog" ? (
          <CommunityCatalog tab={route.tab} />
        ) : route.view === "manage" && renderManage ? (
          renderManage(route)
        ) : (
          <CommunityView key={route.id} id={route.id} tab={route.view === "community" ? route.tab : "overview"} />
        )}
      </CommunityFrame>
    </CommunityPlatformProvider>
  );
}
