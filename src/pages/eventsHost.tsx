/**
 * The launcher's community platform for screens outside `#/community` that
 * draw events: the events pages and Home. It repeats the one
 * `CommunityPage` builds, without the seed of a server, the controls of
 * **Play** and what only the management screen asks for; the core's dialog
 * of pictures and the drop of one on its tile stay, for the cover in the
 * editor of an event.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { CommunityPlatformProvider, type CommunityPlatform, type Game } from "../components/community";
import { EventsPlatformProvider } from "../components/events";
import { bundlesTabRoute } from "../lib/bundleRoutes";
import { communityIpc, serversIpc } from "../lib/ipc";
import { useAccountState, useActiveGame, useOnlineUrl } from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { communityPath, liveOf, useLauncherPickImage } from "./CommunityPage";
import { launcherPictureDrops } from "./communityDrops";
import { PUBLIC_PAGE, useLauncherEventsPlatform } from "./eventsPlatform";

const request: CommunityPlatform["request"] = (method, path, body) => communityIpc.request(method, path, body);
const serverStatus = (address: string, game: Game) => serversIpc.getServerStatus(address, game).then(liveOf);

/** The launcher's community platform, for screens outside `#/community`. */
export function useLauncherCommunityPlatform(onExternalError?: (error: unknown) => void): CommunityPlatform {
  const navigate = useNavigate();
  const account = useAccountState();
  const game = useActiveGame();
  const apiBase = useOnlineUrl();
  const signedIn = account.data?.onlineSignedIn ?? false;
  const accountId = account.data?.onlineUser?.id ?? null;
  const pickImage = useLauncherPickImage();
  const openExternal = useCallback(
    (url: string) => {
      if (!isTauri()) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      openUrl(url).catch((error: unknown) => onExternalError?.(error));
    },
    [onExternalError],
  );
  return useMemo<CommunityPlatform>(
    () => ({
      host: "launcher",
      request,
      signedIn,
      accountId,
      apiBase,
      signIn: () => navigate("/settings?section=account"),
      openExternal,
      navigate: (next) => navigate(communityPath(next)),
      href: (next) => `#${communityPath(next)}`,
      canManage: true,
      game,
      pageUrl: (communityId) => `${PUBLIC_PAGE}?id=${encodeURIComponent(communityId)}`,
      serverStatus,
      openBundle: (bundleId) => navigate(bundlesTabRoute(bundleId)),
      openPrivacySettings: () => navigate("/settings?section=regulars"),
      pickImage,
      ...launcherPictureDrops(),
    }),
    [signedIn, accountId, apiBase, navigate, openExternal, game, pickImage],
  );
}

/** The two platforms around launcher screens that draw events outside their pages: Home. */
export function LauncherEventsProviders({ children }: { children: ReactNode }) {
  const community = useLauncherCommunityPlatform();
  const events = useLauncherEventsPlatform();
  return (
    <CommunityPlatformProvider platform={community}>
      <EventsPlatformProvider platform={events}>{children}</EventsPlatformProvider>
    </CommunityPlatformProvider>
  );
}
