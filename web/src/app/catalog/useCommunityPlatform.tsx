import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { CommunityPlatform, CommunityRoute } from "../../../../src/components/community/index.ts";
import type { Community } from "../../../../src/components/community/types.ts";
import { backend, hasBackend } from "../../../../src/lib/backend.ts";
import { useAccountState, useOnlineUrl } from "../../../../src/lib/queries.ts";
import { PlatformNote } from "./PlatformNote.tsx";
import { useCommunityRequest } from "./useCommunityRequest.ts";

/** The website's page of a community: what **Share** copies. */
const PUBLIC_PAGE = "https://jknet.app/servers/";

/** The path of a route in the web app: `/community?tab=…` and `/community/:id?tab=…`. */
export function communityRoutePath(route: CommunityRoute): string {
  if (route.view === "catalog") return route.tab === "catalog" ? "/community" : `/community?tab=${route.tab}`;
  const base = `/community/${encodeURIComponent(route.id)}`;
  return route.tab === "overview" ? base : `${base}?tab=${route.tab}`;
}

/**
 * The web app as a host of the community screens: the web core's bridge,
 * the web session, a new tab for a link, the routes of the web app. It
 * reads and follows; creating, claiming and editing stay with the launcher
 * and the website, and so do the client, install and join of **Play**,
 * which a note names instead.
 */
export function useWebCommunityPlatform(share?: { run: (community: Community) => void; label: string }): CommunityPlatform {
  const request = useCommunityRequest();
  const account = useAccountState().data;
  const navigate = useNavigate();
  const apiBase = useOnlineUrl();
  const { t: tWeb } = useTranslation("web");
  const signedIn = account?.onlineSignedIn ?? false;
  const accountId = account?.onlineUser?.id ?? null;
  const shareRun = share?.run;
  const shareLabel = share?.label;

  return useMemo<CommunityPlatform>(
    () => ({
      host: "web",
      request,
      signedIn,
      accountId,
      apiBase,
      signIn: () => void navigate("/settings/account"),
      openExternal: (url) => {
        if (hasBackend()) void backend().openExternal(url).catch(() => undefined);
        else window.open(url, "_blank", "noopener,noreferrer");
      },
      navigate: (route) => void navigate(communityRoutePath(route)),
      href: communityRoutePath,
      canManage: false,
      pageUrl: (id) => `${PUBLIC_PAGE}?id=${encodeURIComponent(id)}`,
      share: shareRun,
      shareLabel,
      openBundle: (bundleId) => void navigate(`/bundles/${encodeURIComponent(bundleId)}`),
      playNote: <PlatformNote text={tWeb("catalog.playNote")} />,
      embedded: true,
    }),
    [request, signedIn, accountId, apiBase, navigate, shareRun, shareLabel, tWeb],
  );
}
