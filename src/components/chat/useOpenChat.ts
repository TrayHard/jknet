import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useOpenChatWindow, useOpenDirectChat } from "../../lib/queries";
import { useToasts } from "../ToastsProvider";
import { currentChatLayout, useChatLayout } from "./ChatLayoutContext";

/**
 * --- slice: chat ---
 *
 * Shows a conversation, or the list without one, wherever this window shows
 * chats.
 *
 * The one layout-aware hook of the chat: every **Message** button, toast and
 * banner calls it and never asks where the chat lives. The layout around the
 * caller opens it; above the layout — a toast of `ChatProvider` — the layout
 * the window registered does; with no layout at all the separate chat
 * window opens on it.
 */
export function useOpenChat(): (conversationId?: string | null) => void {
  const layout = useChatLayout();
  const openWindow = useChatWindowOpener();
  return useCallback(
    (conversationId?: string | null) => {
      const target = layout ?? currentChatLayout();
      if (target !== null) target.open(conversationId ?? null);
      else openWindow({ conversationId: conversationId ?? null });
    },
    [layout, openWindow],
  );
}

/**
 * Opens the separate chat window, or raises it. A refusal of the core becomes
 * a toast: **Pop out**, a toast or a notification that asked has nowhere to
 * print it, and the drawer that asked is closed by then.
 */
export function useChatWindowOpener(): (request: { conversationId?: string | null; compact?: boolean }) => void {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const { show } = useToasts();
  const onError = useCallback(
    (error: unknown) =>
      show("chat-window-failed", { variant: "error", title: t("window.openFailed"), text: errorText(error) }),
    [show, t, errorText],
  );
  return useOpenChatWindow(onError).mutate;
}

/**
 * **Message** of a friend: the direct chat with them, created on first use,
 * then shown by `useOpenChat`. A refusal becomes a toast: the button that
 * asked has nowhere to print it.
 */
export function useMessageFriend(): { open: (userId: string) => void; pending: boolean } {
  const openChat = useOpenChat();
  const direct = useOpenDirectChat();
  const toasts = useToasts();
  const errorText = useErrorText();
  const { mutateAsync, isPending } = direct;
  const { show } = toasts;

  const open = useCallback(
    (userId: string) => {
      void mutateAsync(userId)
        .then((conversation) => openChat(conversation.id))
        .catch((error: unknown) =>
          show(`chat-open-failed:${userId}`, { variant: "error", title: errorText(error) }),
        );
    },
    [mutateAsync, openChat, show, errorText],
  );

  return { open, pending: isPending };
}
