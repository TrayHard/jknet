import { ArrowLeft, AtSign, Bell, BellOff, Check, Info, Lock, Pencil, Search, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { peerOf } from "../../lib/chat/conversation";
import { canAddMembers, canRename } from "../../lib/chat/groups";
import { cn } from "../../lib/format";
import type { ChatNotifyLevel, Conversation } from "../../lib/ipc";
import { useFriendPresence, useSetChatNotify } from "../../lib/queries";
import { useStatusLine } from "../friends/useStatusLine";
import { Badge, Menu, type MenuItem } from "../ui";
import { ConversationAvatar } from "./ConversationAvatar";
import { useChatNames } from "./useChatText";

/** What the info of a group opens on: the info, the name field, or **Add friends**. */
export type ThreadInfoMode = "view" | "rename" | "add";

interface ThreadHeaderProps {
  conversation: Conversation;
  /** The back arrow of the stacked and compact layouts. */
  onBack?: () => void;
  /** **Search in this chat**. */
  onSearch?: () => void;
  searching?: boolean;
  /**
   * --- slice: chat groups --- the info of a group or a server chat: a
   * press on the title, or an item of the menu.
   */
  onInfo?: (mode: ThreadInfoMode) => void;
  infoOpen?: boolean;
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
 *
 * --- slice: chat groups --- The title of a group or a server chat opens its
 * info; the menu adds **Group info**, **Add friends** and — for the owner
 * only (D5) — **Rename group** before the notification levels. A server chat
 * carries **Live** while it exists: it goes when the server stops.
 */
export function ThreadHeader({
  conversation,
  onBack,
  onSearch,
  searching = false,
  onInfo,
  infoOpen = false,
  actions,
  dense = false,
}: ThreadHeaderProps) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const statusLine = useStatusLine();
  const setNotify = useSetChatNotify();
  const peer = peerOf(conversation, names.meId);
  const presence = useFriendPresence(peer?.id ?? null);
  const title = names.title(conversation);
  const server = conversation.kind === "server";
  const hasInfo = conversation.kind !== "direct" && onInfo !== undefined;

  const subtitle = !conversation.canSend
    ? conversation.kind === "direct" && peer === null
      ? t("thread.deletedPeer")
      : t("thread.readOnly")
    : conversation.kind === "direct"
      ? presence
        ? statusLine(presence)
        : ""
      : server
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
  if (hasInfo) {
    const group: MenuItem[] = [
      { id: "info", label: server ? t("info.openServer") : t("info.open"), icon: <Info size={14} /> },
    ];
    if (conversation.kind === "group") {
      group.push({
        id: "add",
        label: t("info.add"),
        icon: <UserPlus size={14} />,
        disabled: !canAddMembers(conversation),
      });
    }
    if (canRename(conversation, names.meId)) {
      group.push({ id: "rename", label: t("info.rename"), icon: <Pencil size={14} /> });
    }
    items.unshift(...group);
  }

  const identity = (
    <>
      <ConversationAvatar conversation={conversation} meId={names.meId} size={dense ? "sm" : "md"} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="flex items-center gap-6 min-w-0">
          <span className="truncate text-body-md-medium text-fg [unicode-bidi:isolate]">{title}</span>
          {!conversation.canSend ? <Lock size={12} className="shrink-0 text-fg-muted" /> : null}
        </span>
        {/* The badge goes under the title: in the 380 px drawer the title
            needs the whole first line. */}
        {server || subtitle !== "" ? (
          <span className="flex min-w-0 items-center gap-6">
            {server ? (
              <Badge tone="success" className="shrink-0">
                {t("list.live")}
              </Badge>
            ) : null}
            {subtitle !== "" ? <span className="truncate text-body-sm text-fg-muted">{subtitle}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );

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
      {hasInfo ? (
        <button
          type="button"
          onClick={() => onInfo?.("view")}
          aria-expanded={infoOpen}
          title={server ? t("info.openServer") : t("info.open")}
          className={cn(
            "-mx-4 flex min-w-0 flex-1 items-center gap-8 rounded-md px-4 py-2 cursor-pointer select-none",
            "transition-colors duration-100 hover:bg-hover-overlay",
            infoOpen && "bg-selected-overlay",
          )}
        >
          {identity}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-8">{identity}</div>
      )}
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
          ariaLabel={hasInfo ? t("thread.menu") : t("notify.menu")}
          items={items}
          onSelect={(id) => {
            if (id === "info") onInfo?.("view");
            else if (id === "add") onInfo?.("add");
            else if (id === "rename") onInfo?.("rename");
            else setNotify.mutate({ conversationId: conversation.id, notify: id as ChatNotifyLevel });
          }}
        />
        {actions}
      </div>
    </header>
  );
}
