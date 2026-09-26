import { createContext, use, useEffect } from "react";

/**
 * --- slice: chat ---
 *
 * The chat layout of a window: whatever mounts the chat surface in it and can
 * show a conversation on request.
 *
 * The main window's layout (the drawer of layout B,
 * `layout/useChatDrawerLayout.ts`) provides it from `AppShell`; the chat
 * window provides its own, which selects the conversation in place.
 * `useOpenChat` is the reader. A window without a layout — a client window,
 * the first-run shell of the main window — opens the separate chat window
 * instead.
 */
export interface ChatLayout {
  /** Whether the surface is on screen now. */
  isOpen: boolean;
  /** Shows the surface on a conversation, or on the list without one. */
  open: (conversationId?: string | null) => void;
  close: () => void;
  toggle: () => void;
  /** The drawer docked beside the page instead of over it. */
  pinned: boolean;
  setPinned: (pinned: boolean) => void;
}

export const ChatLayoutContext = createContext<ChatLayout | null>(null);

/** The layout around this component, or `null` when it has none. */
export function useChatLayout(): ChatLayout | null {
  return use(ChatLayoutContext);
}

/**
 * The layout of this window, for the code that runs above it.
 *
 * `ChatProvider` sits above the router — it has to, to hear notifications on
 * every screen — and the layout lives inside it, in `AppShell`. A toast or a
 * `chat:open` of the core reaches the layout through this one slot per
 * window, which the layout fills while it is mounted.
 */
let registered: ChatLayout | null = null;

export function currentChatLayout(): ChatLayout | null {
  return registered;
}

/** Makes a layout the one of this window while the calling component is mounted. */
export function useRegisterChatLayout(layout: ChatLayout | null): void {
  useEffect(() => {
    if (layout === null) return;
    registered = layout;
    return () => {
      if (registered === layout) registered = null;
    };
  }, [layout]);
}
