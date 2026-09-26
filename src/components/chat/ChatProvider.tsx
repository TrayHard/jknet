import { AtSign, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ChatNotifyEvent, ChatRemovedEvent, Conversation } from "../../lib/ipc";
import {
  useAnswerGroupInvite,
  useChatEvents,
  useChatState,
  useChatUnread,
  useOnlineConfigured,
  useSetTrayLabels,
} from "../../lib/queries";
import { isTauri } from "../../lib/runtime";
import { useToasts } from "../ToastsProvider";
import { Button } from "../ui";
import { useOpenChat } from "./useOpenChat";
import { useChatNames } from "./useChatText";

/** How long a toast of a new message stays: a notification, not a task. */
const NOTIFY_TOAST_MS = 6_000;

interface ChatProviderProps {
  /**
   * `main`: the launcher window. It shows the toasts of new messages and of
   * group invitations and keeps the tray menu in the language on screen.
   * `window`: the chat window, which only listens.
   */
  role: "main" | "window";
  children: ReactNode;
}

/**
 * --- slice: chat ---
 *
 * Holds the one subscription of a window to the `chat:*` events, above the
 * router, next to `FriendsProvider`.
 *
 * In the main window it also turns `chat:notify` into a toast — the core has
 * already decided that this message deserves one — shows a toast for a group
 * invitation and for a chat that went away, and hands the tray its labels:
 * the core has no catalogs.
 */
export function ChatProvider({ role, children }: ChatProviderProps) {
  const { t } = useTranslation("chat");
  const toasts = useToasts();
  const openChat = useOpenChat();
  const names = useChatNames();
  const { show, dismiss } = toasts;
  const main = role === "main";

  const onNotify = useCallback(
    (event: ChatNotifyEvent) => {
      if (!main) return;
      const id = `chat:${event.conversationId}`;
      show(id, {
        title: event.title,
        text: event.text,
        action: (
          <Button
            size="sm"
            variant="primary"
            icon={event.mention ? <AtSign size={14} /> : <MessageCircle size={14} />}
            onClick={() => {
              dismiss(id);
              openChat(event.conversationId);
            }}
          >
            {t("toast.open")}
          </Button>
        ),
      });
      window.setTimeout(() => dismiss(id), NOTIFY_TOAST_MS);
    },
    [main, show, dismiss, openChat, t],
  );

  const onRemoved = useCallback(
    (event: ChatRemovedEvent, conversation: Conversation | null) => {
      // Leaving is the player's own act: it needs no news.
      if (!main || event.reason === "left") return;
      const title = conversation === null ? t("toast.aChat") : names.title(conversation);
      show(`chat-removed:${event.conversationId}`, {
        variant: "info",
        title: t(`toast.removed.${event.reason}`, { title }),
      });
    },
    [main, show, t, names],
  );

  useChatEvents({ onNotify, onRemoved, onOpen: (event) => openChat(event.conversationId) });

  return (
    <>
      {main ? <GroupInviteToasts /> : null}
      {main ? <TrayLabels /> : null}
      {children}
    </>
  );
}

/**
 * A toast for every group invitation, drawn from the invitations of the
 * state like the invites of `FriendsProvider`: one that was answered or
 * expired elsewhere takes its toast with it.
 */
function GroupInviteToasts() {
  const { t } = useTranslation("chat");
  const configured = useOnlineConfigured();
  const state = useChatState().data;
  const answer = useAnswerGroupInvite();
  const openChat = useOpenChat();
  const { show, dismiss } = useToasts();
  const shown = useRef(new Set<string>());
  const invites = configured === false ? undefined : state?.groupInvites;
  const reply = answer.mutate;

  useEffect(() => {
    const alive = new Set((invites ?? []).map((invite) => invite.conversationId));
    for (const id of shown.current) {
      if (!alive.has(id)) {
        dismiss(`chat-invite:${id}`);
        shown.current.delete(id);
      }
    }
    for (const invite of invites ?? []) {
      if (shown.current.has(invite.conversationId)) continue;
      shown.current.add(invite.conversationId);
      const id = `chat-invite:${invite.conversationId}`;
      show(id, {
        title: t("invites.toast", {
          name: invite.invitedBy.displayName,
          title: invite.title?.trim() || t("invites.untitled"),
        }),
        text: t("invites.members", { count: invite.memberCount }),
        onDismiss: () => dismiss(id),
        action: (
          <span className="flex items-center gap-6">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                dismiss(id);
                reply(
                  { conversationId: invite.conversationId, accept: true },
                  { onSuccess: (conversation) => conversation && openChat(conversation.id) },
                );
              }}
            >
              {t("invites.join")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                dismiss(id);
                reply({ conversationId: invite.conversationId, accept: false });
              }}
            >
              {t("invites.decline")}
            </Button>
          </span>
        ),
      });
    }
  }, [invites, show, dismiss, reply, openChat, t]);

  return null;
}

/**
 * The tray menu in the language on screen, with the unread count in
 * **Open chats (N)** and in the tooltip. Sent again when either changes. A
 * core that has no tray yet refuses the call, which changes nothing.
 */
function TrayLabels() {
  const { t, i18n } = useTranslation("chat");
  const { unread } = useChatUnread();
  const send = useSetTrayLabels().mutate;

  useEffect(() => {
    if (!isTauri()) return;
    const timer = window.setTimeout(() => {
      send({
        open: t("tray.open"),
        chat: unread > 0 ? t("tray.chatCount", { count: unread }) : t("tray.chat"),
        dnd: t("tray.dnd"),
        quit: t("tray.quit"),
        tooltip: unread > 0 ? t("tray.tooltipUnread", { count: unread }) : t("tray.tooltip"),
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [t, i18n.language, unread, send]);

  return null;
}
