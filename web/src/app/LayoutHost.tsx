import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useMatches, useNavigate } from "react-router";

import { ChatLayoutContext, useRegisterChatLayout, type ChatLayout } from "../../../src/components/chat/ChatLayoutContext.ts";
import { useAccountState, useChatConversation } from "../../../src/lib/queries.ts";
import { safeNext } from "../core/session.ts";
import { useWebCore } from "./CoreContext.tsx";
import { deviceKind } from "./device.ts";
import { InstallPrompt } from "./InstallPrompt.tsx";
import { layouts } from "./layouts/index.ts";
import { LayoutActionsContext, type LayoutActions } from "./layouts/LayoutActions.ts";
import { overlayOf } from "./layouts/history.ts";
import { useHistoryModel, useUp } from "./layouts/overlays.ts";
import type { LayoutMe } from "./layouts/types.ts";
import { NAV_SECTIONS, type NavItem } from "./nav.ts";
import { OfflineBar } from "./OfflineBar.tsx";
import { SECTION_ROOTS, type RouteSpec } from "./routeTable.ts";
import { UpdateBar } from "./UpdateBar.tsx";
import { useNavCounters, useUnreadTitle } from "./useNavCounters.ts";
import { useMedia, WIDE_QUERY } from "./useMedia.ts";
import { viewOf } from "./views.tsx";

/** What each route of the layout carries in its `handle`. */
export interface RouteHandle {
  spec: RouteSpec;
}

function isRouteHandle(handle: unknown): handle is RouteHandle {
  return handle !== null && typeof handle === "object" && "spec" in handle;
}

/**
 * The layout container: picks the phone layout (P3) or the wide one (W1) by
 * the window's size, live, and hands it the panes of the route.
 *
 * It also stands in for the launcher's chat window: `useOpenChat` of the
 * shared components navigates to `/c/<id>` through the `ChatLayout` this
 * registers, and a notification click the service worker forwards arrives
 * here as a navigation.
 */
export function LayoutHost() {
  const { t } = useTranslation("web");
  const { t: tFriends } = useTranslation("friends");
  const { t: tChat } = useTranslation("chat");
  const matches = useMatches();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const wide = useMedia(WIDE_QUERY);
  const account = useAccountState().data;
  const counters = useNavCounters();
  useUnreadTitle(counters.unreadChats);

  // A finished sign-in has been followed to its `next` by now; the next
  // visit to /signin must not follow it again.
  const core = useWebCore();
  useEffect(() => core.session.settle(), [core]);

  const match = [...matches].reverse().find((entry) => isRouteHandle(entry.handle));
  const spec = (match?.handle as RouteHandle | undefined)?.spec;
  const params = match?.params ?? {};
  const paramsKey = JSON.stringify(params);
  // The details column of a chat is its info: a group's, or a server chat's.
  const infoOf = useChatConversation(spec?.aside === "groupInfo" ? (params.conversationId ?? null) : null);
  const asideTitle = infoOf?.kind === "server" ? tChat("info.titleServer") : tChat("info.title");

  const view = useMemo(
    () => (spec === undefined ? null : viewOf(spec, params, t, { asideTitle })),
    // `params` is a new object each render; its content is what counts.
    [spec, paramsKey, t, asideTitle],
  );

  const history = useHistoryModel();
  const up = useUp(history, view?.parent);
  const actions = useMemo<LayoutActions>(() => ({ up: wide ? null : up, wide }), [up, wide]);

  const navigate = useCallback(
    (path: string, options?: { replace?: boolean }) => void routerNavigate(path, { replace: options?.replace }),
    [routerNavigate],
  );

  // The chat opens as a route, never as a window.
  const chatLayout = useMemo<ChatLayout>(
    () => ({
      isOpen: true,
      open: (conversationId) => navigate(conversationId ? `/c/${encodeURIComponent(conversationId)}` : "/chats"),
      close: () => {},
      toggle: () => {},
      pinned: false,
      setPinned: () => {},
    }),
    [navigate],
  );
  useRegisterChatLayout(chatLayout);

  // A notification clicked while the app is open: the service worker focuses
  // this window and names the address.
  useEffect(() => {
    const worker = navigator.serviceWorker;
    if (worker === undefined) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== "open" || typeof data.url !== "string") return;
      const target = safeNext(data.url);
      if (target !== null) navigate(target);
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, [navigate]);

  // Switching layouts keeps the route and closes the phone's overlays: their
  // history entries would reopen them on the way back.
  const previousWide = useRef(wide);
  useEffect(() => {
    if (previousWide.current === wide) return;
    previousWide.current = wide;
    const overlay = overlayOf(location.state);
    if (overlay.drawer === true || overlay.sheet !== undefined) void routerNavigate(-1);
  }, [wide, location.state, routerNavigate]);

  const device = useMemo(() => deviceKind(), []);
  const me: LayoutMe = {
    name: account?.onlineUser?.displayName ?? "",
    avatarUrl: account?.onlineUser?.avatarUrl ?? null,
    statusLabel: tFriends(device === "phone" ? "status.onlineFromPhone" : "status.onlineInBrowser"),
    device,
  };

  const nav: NavItem[] = NAV_SECTIONS.map((item) => ({
    ...item,
    label: t(`nav.sections.${item.section}`),
    railLabel: t(`nav.rail.${item.section}`),
    active: item.section === spec?.section,
    ...counters.bySection[item.section],
  }));

  if (view === null) return null;

  const Layout = wide ? layouts.wide : layouts.phone;
  return (
    <ChatLayoutContext value={chatLayout}>
      <LayoutActionsContext value={actions}>
      <Layout
        view={view}
        nav={nav}
        me={me}
        attention={counters.attention}
        navigate={navigate}
        up={up}
        banners={
          <>
            <OfflineBar />
            <UpdateBar />
            {spec?.path === SECTION_ROOTS.chats ? <InstallPrompt /> : null}
          </>
        }
      />
      </LayoutActionsContext>
    </ChatLayoutContext>
  );
}
