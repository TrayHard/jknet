import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { Notice } from "../components/community/bits";
import {
  CommunityApp,
  catalogTab,
  manageSection,
  pageTab,
  type CommunityBundleRef,
  type CommunityLiveStatus,
  type CommunityPerson,
  type CommunityPlatform,
  type CommunityRequest,
  type CommunityRoute,
  type Game,
} from "../components/community";
import { CommunityManage } from "../components/community/manage";
import { useErrorText } from "../i18n/errors";
import { bundlesTabRoute } from "../lib/bundleRoutes";
import { bundlesIpc, communityIpc, serversIpc, type ServerStatus } from "../lib/ipc";
import { useAccountState, useActiveGame, useFriendsState, useOnlineUrl } from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { LauncherFiles, LauncherPlay, LauncherPlayProvider } from "./communityPlay";

/** The website's page of a community: what **Share** copies. */
const PUBLIC_PAGE = "https://jknet.app/servers/";

/** The anchor of the setting on the Settings screen: `#/settings?section=regulars`. */
const PRIVACY_ROUTE = "/settings?section=regulars";

const request: CommunityRequest = (method, path, body) => communityIpc.request(method, path, body);

/** What a server said to `getstatus`, as the community screens read it. */
export function liveOf(status: ServerStatus): CommunityLiveStatus {
  const number = (key: string) => {
    const value = Number.parseInt(status.info[key] ?? "", 10);
    return Number.isFinite(value) ? value : null;
  };
  const bots = status.players.filter((player) => player.isBot).length;
  const hostname = status.info.sv_hostname ?? "";
  return {
    hostnameRaw: hostname,
    hostnameClean: hostname.replace(/\^\d/g, "").trim(),
    map: status.info.mapname ?? "",
    gametype: number("g_gametype"),
    players: status.players.length - bots,
    bots,
    maxPlayers: number("sv_maxclients") ?? 0,
    password: status.info.g_needpass === "1",
    at: new Date().toISOString(),
    names: status.players.map((player) => ({
      nameRaw: player.nameRaw,
      nameClean: player.nameClean,
      score: player.score,
      ping: player.ping,
      bot: player.isBot,
    })),
  };
}

const serverStatus = (address: string, game: Game) => serversIpc.getServerStatus(address, game).then(liveOf);

/** Public bundles of the catalogue for the community's client: the first hundred of a game that match. */
const findBundles = (query: string, game: Game): Promise<CommunityBundleRef[]> =>
  bundlesIpc
    .list({ game, sort: "popular", q: query, limit: 100 })
    .then((list) => list.items.map((bundle) => ({ id: bundle.id, name: bundle.name })));

/** The path of a route inside the launcher's router. */
function pathOf(route: CommunityRoute): string {
  if (route.view === "catalog") return route.tab === "catalog" ? "/community" : `/community?tab=${route.tab}`;
  const base = `/community/${encodeURIComponent(route.id)}`;
  if (route.view === "manage") return route.section ? `${base}/manage?section=${route.section}` : `${base}/manage`;
  return route.tab === "overview" ? base : `${base}?tab=${route.tab}`;
}

/**
 * **Community**: the catalogue at `#/community` and a page at
 * `#/community/:id`, each with `?tab=` for its tabs. The screens are the
 * shared ones of `components/community`; this page gives them the launcher —
 * the core's bridge to the service, the account, the system browser, the
 * active game of the sidebar, the UDP status of the servers and the client,
 * install and join of **Play**.
 *
 * `?address=&name=&game=` on the catalogue comes from the Servers screen: the
 * community of that server opens, or the dialog that creates one.
 *
 * `#/community/:id/manage?section=` is the management screen of a page: the
 * core's dialog uploads its pictures, and the friends list and the bundle
 * catalogue of the launcher name its editors and its client.
 */
export function CommunityPage({ manage = false }: { manage?: boolean }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation("community");
  const account = useAccountState();
  const game = useActiveGame();
  const apiBase = useOnlineUrl();
  const friendsState = useFriendsState();
  const errorText = useErrorText();
  const [externalError, setExternalError] = useState<string | null>(null);

  const signedIn = account.data?.onlineSignedIn ?? false;
  const accountId = account.data?.onlineUser?.id ?? null;
  const route: CommunityRoute = !id
    ? { view: "catalog", tab: catalogTab(params.get("tab")) }
    : manage
      ? { view: "manage", id, section: manageSection(params.get("section")) }
      : { view: "community", id, tab: pageTab(params.get("tab")) };
  const friendsData = friendsState.data;
  // The friends name editors and the next owner; while the list is asked for
  // the pickers wait, and a list that failed leaves the account id to type.
  const friends = useMemo<CommunityPerson[] | null | undefined>(
    () =>
      friendsData?.signedIn
        ? friendsData.friends.map((friend) => ({ id: friend.user.id, displayName: friend.user.displayName, avatarUrl: friend.user.avatarUrl }))
        : friendsState.isError
          ? undefined
          : null,
    [friendsData, friendsState.isError],
  );
  const dialogTitle = t("manage.images.dialogTitle");
  const dialogFilter = t("manage.images.dialogFilter");
  const seedAddress = id ? null : params.get("address");
  const seedName = params.get("name") ?? "";
  const seedGame: Game = params.get("game") === "jo" ? "jo" : "ja";

  const openExternal = useCallback(
    (url: string) => {
      setExternalError(null);
      if (!isTauri()) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      openUrl(url).catch((error: unknown) => setExternalError(errorText(error)));
    },
    [errorText],
  );

  const platform = useMemo<CommunityPlatform>(
    () => ({
      host: "launcher",
      request,
      signedIn,
      accountId,
      apiBase,
      signIn: () => navigate("/settings?section=account"),
      openExternal,
      navigate: (next) => navigate(pathOf(next)),
      href: (next) => `#${pathOf(next)}`,
      canManage: true,
      game,
      pageUrl: (communityId) => `${PUBLIC_PAGE}?id=${encodeURIComponent(communityId)}`,
      renderPlay: (context) => <LauncherPlay {...context} />,
      renderFiles: (community) => <LauncherFiles community={community} />,
      serverStatus,
      openBundle: (bundleId) => navigate(bundlesTabRoute(bundleId)),
      openPrivacySettings: () => navigate(PRIVACY_ROUTE),
      seed: seedAddress ? { address: seedAddress, name: seedName, game: seedGame } : undefined,
      // The core's dialog: outside Tauri (`npm run dev`) the screen offers no upload.
      pickImage: isTauri() ? (kind) => communityIpc.pickImage(kind, dialogTitle, dialogFilter) : undefined,
      friends,
      findBundles,
    }),
    [signedIn, accountId, apiBase, navigate, openExternal, game, seedAddress, seedName, seedGame, dialogTitle, dialogFilter, friends],
  );

  // No scroll box of its own: the shell's <main> scrolls, and the sticky
  // navigation and save bar of the management screen hold to it.
  return (
    <div className="min-h-full">
      {externalError ? (
        <div className="px-24 pt-16">
          <Notice tone="danger">{externalError}</Notice>
        </div>
      ) : null}
      <LauncherPlayProvider>
        <CommunityApp
          platform={platform}
          route={route}
          renderManage={(screen) => <CommunityManage id={screen.id} section={screen.section} />}
        />
      </LauncherPlayProvider>
    </div>
  );
}
