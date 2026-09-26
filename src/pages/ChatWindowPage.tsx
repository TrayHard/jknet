import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Monitor } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import {
  ChatLayoutContext,
  useRegisterChatLayout,
  type ChatLayout,
} from "../components/chat/ChatLayoutContext";
import { ChatSurface } from "../components/chat/ChatSurface";
import { ChatWindowBar } from "../components/chat/window/ChatWindowBar";
import { Button } from "../components/ui";
import {
  chatRoute,
  conversationOfPath,
  DEFAULT_CHAT_WINDOW,
  nextSelection,
  rootOpacity,
  seeThrough,
} from "../lib/chatWindow";
import { cn } from "../lib/format";
import {
  useChatUnread,
  useChatWindowView,
  useFriendsState,
  useOnlineConfigured,
  useOpenChatInLauncher,
  useSetChatWindowCompact,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { logWindow, logWindowFailure } from "../lib/windowLog";

/** How many frames the page looks for the composer to focus: about half a second. */
const FOCUS_TRIES = 30;

/**
 * --- slice: chat window ---
 *
 * The separate chat window (layout E), at `#/chat` or `#/chat/<id>`.
 *
 * Full, it is the chat surface split in two: the list of chats on the left,
 * the open thread beside it, as E1 draws it. Compact, it is one thread in a
 * narrow window over a game with a row of every chat above it, as E2 draws
 * it; the back arrow of the thread shows the list. The core owns the window
 * — its size, its place, whether it stays on top, how see-through it is —
 * and the page follows `chat:window`.
 *
 * Which conversation is open lives in the route, so a reload of the window
 * keeps it. The page is this window's chat layout: a **Message** button
 * inside it, a search hit, and the core's `chat:open` when a notification
 * or the tray asks for a conversation all select it here, in place.
 *
 * In the compact mode below 100 % the core makes the webview background
 * transparent; the page then clears the background of the document and
 * paints its root at the opacity the player chose, and the game shows
 * through. Everything the chat opens over it — dialogs, menus, the emoji
 * picker — stays opaque, because it is drawn outside the root.
 */
export function ChatWindowPage() {
  const { t } = useTranslation("chat");
  const location = useLocation();
  const navigate = useNavigate();
  const conversationId = conversationOfPath(location.pathname);
  const windowView = useChatWindowView();
  // Until the core answers, nothing is drawn: the bar of the wrong mode for
  // a frame is a jump. A core that cannot answer gets the full mode.
  const view = windowView.data ?? (windowView.isError ? DEFAULT_CHAT_WINDOW : undefined);
  const compact = view?.compact ?? false;
  const setCompact = useSetChatWindowCompact().mutate;
  const openInLauncher = useOpenChatInLauncher().mutate;
  const subtitle = useWindowSubtitle(view?.alwaysOnTop ?? false);
  const main = useRef<HTMLElement>(null);
  // Grows on every request to show a conversation; a window opened on one
  // counts as the first.
  const [focusKey, setFocusKey] = useState(() => (conversationId === null ? 0 : 1));

  const select = useCallback(
    (id: string | null) => {
      void navigate(chatRoute(id), { replace: true });
    },
    [navigate],
  );

  // What the layout reads when it is asked from outside the render: the
  // core's `chat:open` arrives through `ChatProvider`, above this page.
  const where = useRef({ conversationId, compact });
  where.current = { conversationId, compact };

  const layout = useMemo<ChatLayout>(
    () => ({
      isOpen: true,
      open: (id) => {
        select(nextSelection(where.current.conversationId, id ?? null, where.current.compact));
        setFocusKey((key) => key + 1);
      },
      close: closeWindow,
      toggle: () => undefined,
      pinned: false,
      setPinned: () => undefined,
    }),
    [select],
  );
  useRegisterChatLayout(layout);

  // A conversation asked for from outside — **Pop out**, a notification, a
  // **Message** button — gets the keyboard: the core has raised the window,
  // and the player came to write. Nothing is drawn before the mode is known,
  // so the first request waits for it, and the composer comes with the chat
  // state, which may still be on its way: a few frames of looking, then
  // nothing.
  const drawn = view !== undefined;
  useEffect(() => {
    if (focusKey === 0 || !drawn) return;
    let frame = 0;
    let tries = FOCUS_TRIES;
    const look = () => {
      const field = main.current?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)");
      if (field) field.focus({ preventScroll: true });
      else if (--tries > 0) frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [focusKey, drawn]);

  const clear = view !== undefined && seeThrough(view);
  useSeeThroughDocument(clear);

  // --- diagnostics --- the same three lines as the client window: whether
  // the page mounted, in which mode, and what the core said instead.
  const route = location.pathname;
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    logWindow(`chat window mounted at #${route}`);
  }, [route]);
  const mode = view === undefined ? null : compact ? "compact" : "full";
  useEffect(() => {
    if (mode !== null) logWindow(`chat window in the ${mode} mode`);
  }, [mode]);
  useEffect(() => {
    if (windowView.error != null) logWindowFailure("reading the chat window state", windowView.error);
  }, [windowView.error]);

  const toLauncher = () =>
    openInLauncher(conversationId, {
      // The chat moves into the launcher, as **Pop out** moves it out.
      onSuccess: () => closeWindow(),
    });

  return (
    <ChatLayoutContext value={layout}>
      <div
        data-chat-window={mode ?? "loading"}
        className={cn(
          "flex h-full min-h-0 flex-col border border-line-strong text-fg",
          compact ? "bg-surface" : "bg-app",
        )}
        style={view !== undefined && clear ? { opacity: rootOpacity(view) } : undefined}
      >
        {view === undefined ? null : (
          <ChatWindowBar view={view} subtitle={subtitle} onOpenInLauncher={toLauncher} />
        )}
        <main ref={main} className="min-h-0 flex-1">
          {view === undefined ? null : (
            <ChatSurface
              variant={compact ? "compact" : "split"}
              conversationId={conversationId}
              onSelect={select}
              listHeader={
                compact ? undefined : (
                  <div className="flex shrink-0 items-center px-12 pt-12">
                    <Button size="sm" variant="ghost" icon={<Monitor size={14} />} onClick={toLauncher}>
                      {t("window.openInLauncher")}
                    </Button>
                  </div>
                )
              }
              threadActions={
                compact ? (
                  <ThreadButton label={t("window.full")} onClick={() => setCompact(false)}>
                    <Maximize2 size={14} />
                  </ThreadButton>
                ) : undefined
              }
              className="h-full"
            />
          )}
        </main>
      </div>
    </ChatLayoutContext>
  );
}

/**
 * The line after the title of the full bar: the unread messages, else how
 * many friends are online, and that the window stays on top.
 */
function useWindowSubtitle(alwaysOnTop: boolean): string {
  const { t } = useTranslation("chat");
  const configured = useOnlineConfigured();
  const { unread } = useChatUnread();
  const friends = useFriendsState().data?.friends;
  const online =
    configured === false || friends === undefined
      ? null
      : friends.filter((friend) => friend.presence.status === "online" || friend.presence.status === "in_game")
          .length;
  const line =
    unread > 0
      ? t("list.unread", { count: unread })
      : online !== null
        ? t("window.friendsOnline", { count: online })
        : "";
  if (!alwaysOnTop) return line;
  return line === "" ? t("window.alwaysOnTop") : t("window.withOnTop", { line });
}

/**
 * Clears the background of `html` and `body` while the window is
 * see-through, and gives the old one back after.
 *
 * `index.html` paints both with the launcher's colour inline, so the first
 * frame of every window is dark; a see-through window needs that paint gone,
 * or the page covers the desktop with it whatever its root's opacity.
 */
function useSeeThroughDocument(clear: boolean): void {
  useLayoutEffect(() => {
    if (!clear) return;
    const html = document.documentElement.style;
    const body = document.body.style;
    const before = { html: html.backgroundColor, body: body.backgroundColor };
    html.backgroundColor = "transparent";
    body.backgroundColor = "transparent";
    return () => {
      html.backgroundColor = before.html;
      body.backgroundColor = before.body;
    };
  }, [clear]);
}

/** Closes this window; the core writes where it stood. Nothing in a plain browser. */
function closeWindow(): void {
  if (!isTauri()) return;
  getCurrentWindow()
    .close()
    .catch((e: unknown) => logWindowFailure("close", e));
}

/** A button of the compact thread's header, the size of the header's own. */
function ThreadButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-28 shrink-0 items-center justify-center rounded-sm cursor-pointer select-none",
        "text-fg-secondary transition-colors duration-150 hover:bg-hover-overlay hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
