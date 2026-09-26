import { ArrowLeft, AtSign, Bell, BellOff, Check, Lock, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { peerOf } from "../../lib/chat/conversation";
import { cn } from "../../lib/format";
import type { ChatNotifyLevel, Conversation } from "../../lib/ipc";
import { useFriendPresence, useSetChatNotify } from "../../lib/queries";
import { useStatusLine } from "../friends/useStatusLine";
import { Menu, type MenuItem } from "../ui";
import { ConversationAvatar } from "./ConversationAvatar";
import { useChatNames } from "./useChatText";

interface ThreadHeaderProps {
  conversation: Conversation;
  /** The back arrow of the stacked and compact layouts. */
  onBack?: () => void;
  /** **Search in this chat**. */
  onSearch?: () => void;
  searching?: boolean;
  /**
   * Buttons of the layout, at the end of the row: **Pop out**, **Pin** and
   * **Close** of the drawer, the compact toggle of the chat window.
   */
  actions?: ReactNode;
  dense?: boolean;
}

/**
 * --- slice: chat ---
 *
 * The top of a thread: back, the picture and the title, a line under it —
 * the friend's status, the member count, or that the chat is read-only — the
 * notification menu, search, and the buttons the layout adds.
 *
 * A direct chat with a deleted account is titled **Deleted account** with a
 * lock: nothing can be sent there.
 */
export function ThreadHeader({ conversation, onBack, onSearch, searching = false, actions, dense = false }: ThreadHeaderProps) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const statusLine = useStatusLine();
  const setNotify = useSetChatNotify();
  const peer = peerOf(conversation, names.meId);
  const presence = useFriendPresence(peer?.id ?? null);
  const title = names.title(conversation);

  const subtitle = !conversation.canSend
    ? conversation.kind === "direct" && peer === null
      ? t("thread.deletedPeer")
      : t("thread.readOnly")
    : conversation.kind === "direct"
      ? presence
        ? statusLine(presence)
        : ""
      : conversation.kind === "server"
        ? t("thread.serverMembers", { count: conversation.members.length })
        : t("thread.members", { count: conversation.members.length });

  const levels: ChatNotifyLevel[] = ["all", "mentions", "mute"];
  // The level in force carries the check; the others their own icon.
  const items: MenuItem[] = levels.map((level) => ({
    id: level,
    label: t(`notify.${level}`),
    title: t(`notify.${level}Hint`),
    icon:
      level === conversation.notify ? (
        <Check size={14} className="text-fg-accent" />
      ) : level === "all" ? (
        <Bell size={14} />
      ) : level === "mentions" ? (
        <AtSign size={14} />
      ) : (
        <BellOff size={14} />
      ),
  }));

  return (
    <header className={cn("flex shrink-0 items-center gap-8 border-b border-line-subtle", dense ? "h-44 px-8" : "h-56 px-12")}>
      {onBack ? (
        <button
          type="button"
          aria-label={t("thread.back")}
          title={t("thread.back")}
          onClick={onBack}
          className="flex size-28 shrink-0 items-center justify-center rounded-sm text-fg-secondary cursor-pointer hover:bg-hover-overlay hover:text-fg"
        >
          <ArrowLeft size={16} />
        </button>
      ) : null}
      <ConversationAvatar conversation={conversation} meId={names.meId} size={dense ? "sm" : "md"} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-6 min-w-0">
          <span className="truncate text-body-md-medium text-fg [unicode-bidi:isolate]">{title}</span>
          {!conversation.canSend ? <Lock size={12} className="shrink-0 text-fg-muted" /> : null}
        </span>
        {subtitle !== "" ? <span className="truncate text-body-sm text-fg-muted">{subtitle}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onSearch ? (
          <button
            type="button"
            aria-label={t("thread.search")}
            title={t("thread.search")}
            aria-pressed={searching}
            onClick={onSearch}
            className={cn(
              "flex size-28 items-center justify-center rounded-sm cursor-pointer hover:bg-hover-overlay hover:text-fg",
              searching ? "bg-selected-overlay text-fg" : "text-fg-secondary",
            )}
          >
            <Search size={14} />
          </button>
        ) : null}
        <Menu
          size="sm"
          dots="vertical"
          ariaLabel={t("notify.menu")}
          items={items}
          onSelect={(id) =>
            setNotify.mutate({ conversationId: conversation.id, notify: id as ChatNotifyLevel })
          }
        />
        {actions}
      </div>
    </header>
  );
}
