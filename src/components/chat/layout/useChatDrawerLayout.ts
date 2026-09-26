import { useCallback, useMemo, useReducer } from "react";

import { drawerPinned, drawerReducer, INITIAL_DRAWER } from "../../../lib/chat/drawer";
import { useSetChatDrawerPinned, useSettings } from "../../../lib/queries";
import { useRegisterChatLayout, type ChatLayout } from "../ChatLayoutContext";

/** The drawer's own state beyond what every chat layout exposes. */
export interface ChatDrawerLayout extends ChatLayout {
  /** The conversation of the thread level, or `null` for the list. */
  conversationId: string | null;
  /** Shows a conversation, or the list with `null`, without opening or closing. */
  select: (conversationId: string | null) => void;
  /** Grows by one on every request to show the drawer: the drawer moves the focus in. */
  openCount: number;
}

/**
 * --- slice: chat ---
 *
 * The chat layout of the main window (layout B): the drawer on the right,
 * floating over the page or pinned beside it.
 *
 * Whether it is open and what it shows live here, in `AppShell`, so moving
 * between screens keeps the drawer as it was, and a close followed by the
 * title-bar button reopens it on the same thread. Neither survives a
 * restart: the launcher always starts with the drawer closed. The rules are
 * the reducer of `lib/chat/drawer.ts`.
 *
 * **Pin** is kept in `settings.json` as `chatDrawerPinned`. The drawer
 * follows the click at once and the setting is written behind it; a core
 * that refuses the field keeps the pin for this run and says so in the log.
 *
 * `enabled` is false in the first-run shell, which has no chat: the hook
 * then provides no layout, and `useOpenChat` falls back to the chat window.
 */
export function useChatDrawerLayout(enabled: boolean): ChatDrawerLayout | null {
  const saved = useSettings().data?.chatDrawerPinned;
  const savePinned = useSetChatDrawerPinned().mutate;
  const [state, dispatch] = useReducer(drawerReducer, INITIAL_DRAWER);
  const pinned = drawerPinned(state, saved);

  const open = useCallback(
    (conversationId?: string | null) => dispatch({ type: "open", conversationId: conversationId ?? null }),
    [],
  );
  const close = useCallback(() => dispatch({ type: "close" }), []);
  const toggle = useCallback(() => dispatch({ type: "toggle" }), []);
  const select = useCallback(
    (conversationId: string | null) => dispatch({ type: "select", conversationId }),
    [],
  );
  const setPinned = useCallback(
    (next: boolean) => {
      dispatch({ type: "pin", pinned: next });
      savePinned(next, {
        onError: (error: unknown) =>
          console.warn(
            `Chat drawer: the pin was not saved: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
          ),
      });
    },
    [savePinned],
  );

  const layout = useMemo<ChatDrawerLayout | null>(
    () =>
      enabled
        ? {
            isOpen: state.open,
            open,
            close,
            toggle,
            pinned,
            setPinned,
            conversationId: state.conversationId,
            select,
            openCount: state.openCount,
          }
        : null,
    [enabled, state, open, close, toggle, pinned, setPinned, select],
  );

  useRegisterChatLayout(layout);
  return layout;
}
