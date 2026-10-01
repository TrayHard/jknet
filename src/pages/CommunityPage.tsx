import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { useUnsavedGuard } from "../components/client/UnsavedGuard";
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
  type PictureKind,
} from "../components/community";
import { CommunityManage, CommunityNewsComposer } from "../components/community/manage";
import { useErrorText } from "../i18n/errors";
import { bundlesTabRoute } from "../lib/bundleRoutes";
import { hasBackend, listen } from "../lib/backend";
import { bundlesIpc, communityIpc, serversIpc, type ServerStatus } from "../lib/ipc";
import { COMMUNITY_POST, type PostNotice } from "../lib/useCommunityEvents";
import { useAccountState, useActiveGame, useFriendsState, useOnlineUrl } from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { LauncherFiles, LauncherPlay, LauncherPlayProvider } from "./communityPlay";
// --- slice: community events ---
import { EventsPlatformProvider } from "../components/events";
import { useLauncherEventsPlatform } from "./eventsPlatform";

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

/** The posts of the news the core hears on the live socket, by community. */
function subscribePosts(listener: (communityId: string) => void): () => void {
  if (!hasBackend()) return () => undefined;
  let stop: (() => void) | undefined;
  let gone = false;
  void listen<PostNotice>(COMMUNITY_POST, (event) => listener(event.payload.post.communityId)).then(
    (off) => {
      if (gone) off();
      else stop = off;
    },
    () => undefined,
  );
  return () => {
    gone = true;
    stop?.();
  };
}

/** Public bundles of the catalogue for the community's client: the first hundred of a game that match. */
const findBundles = (query: string, game: Game): Promise<CommunityBundleRef[]> =>
  bundlesIpc
    .list({ game, sort: "popular", q: query, limit: 100 })
    .then((list) => list.items.map((bundle) => ({ id: bundle.id, name: bundle.name })));

/**
 * The core's dialog for a picture — a logo or a cover of a community, the
 * cover of an event — with its words in the player's language. Outside
 * Tauri (`npm run dev`) there is none, and the screens offer no upload.
 */
export function useLauncherPickImage(): CommunityPlatform["pickImage"] {
  const { t } = useTranslation("community");
  const title = t("manage.images.dialogTitle");
  const filter = t("manage.images.dialogFilter");
  return useMemo(() => (isTauri() ? (kind: PictureKind) => communityIpc.pickImage(kind, title, filter) : undefined), [title, filter]);
}

/** The path of a route inside the launcher's router; the events pages lead to the community screens by it too. */
export function communityPath(route: CommunityRoute): string {
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
 * catalogue of the launcher name its editors and its client. While it holds
 * edits nobody saved, the guard of the main window asks before a route
 * change, a switch of the game or closing the window loses them.
 *
 * The events of a page — its tab and the block of the overview — get the
 * launcher's events platform; the calendar and the editor of an event are
 * `EventsPage`.
 */
export function CommunityPage({ manage = false }: { manage?: boolean }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const account = useAccountState();
  const game = useActiveGame();
  const apiBase = useOnlineUrl();
  const friendsState = useFriendsState();
  const errorText = useErrorText();
  const [externalError, setExternalError] = useState<string | null>(null);
  // --- slice: community events --- the tab and the block of events on a page.
  const eventsPlatform = useLauncherEventsPlatform();

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
  const pickImage = useLauncherPickImage();
  const guard = useUnsavedGuard();
  const { t } = useTranslation("community");
  const leaveTitle = t("manage.leave.title");
  const leaveBody = t("manage.leave.body");
  const leaveKeep = t("manage.leave.keep");
  const leaveDiscard = t("manage.leave.discard");
  const setUnsaved = useCallback(
    (dirty: boolean) => guard.setDirty(dirty, { title: leaveTitle, body: leaveBody, keep: leaveKeep, discard: leaveDiscard }),
    [guard, leaveTitle, leaveBody, leaveKeep, leaveDiscard],
  );
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
      navigate: (next) => navigate(communityPath(next)),
      href: (next) => `#${communityPath(next)}`,
      canManage: true,
      game,
      pageUrl: (communityId) => `${PUBLIC_PAGE}?id=${encodeURIComponent(communityId)}`,
      renderPlay: (context) => <LauncherPlay {...context} />,
      renderFiles: (community) => <LauncherFiles community={community} />,
      serverStatus,
      openBundle: (bundleId) => navigate(bundlesTabRoute(bundleId)),
      openPrivacySettings: () => navigate(PRIVACY_ROUTE),
      seed: seedAddress ? { address: seedAddress, name: seedName, game: seedGame } : undefined,
      pickImage,
      friends,
      findBundles,
      renderNewsComposer: (props) => <CommunityNewsComposer {...props} />,
      setUnsaved,
      subscribePosts,
    }),
    [signedIn, accountId, apiBase, navigate, openExternal, game, seedAddress, seedName, seedGame, pickImage, friends, setUnsaved],
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
        <EventsPlatformProvider platform={eventsPlatform}>
          <CommunityApp
            platform={platform}
            route={route}
            renderManage={(screen) => <CommunityManage id={screen.id} section={screen.section} />}
          />
        </EventsPlatformProvider>
      </LauncherPlayProvider>
    </div>
  );
}
