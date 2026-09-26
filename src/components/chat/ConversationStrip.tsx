import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { sortConversations } from "../../lib/chat/conversation";
import { badgeLabel, rowBadge } from "../../lib/chat/unread";
import { cn } from "../../lib/format";
import type { Conversation } from "../../lib/ipc";
import { ConversationAvatar } from "./ConversationAvatar";
import { useChatNames } from "./useChatText";

/** Room kept beside the open chat when the row scrolls to it, in pixels. */
const EDGE = 8;

interface ConversationStripProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
}

/**
 * --- slice: chat window ---
 *
 * One row of pictures above the thread of the compact chat window: every
 * chat in the order of the list, each with its counter — `@` while a mention
 * waits, grey in a muted chat — and the open one underlined. A player over a
 * game switches chats here without going back to the list, which the back
 * arrow of the thread still opens, with its search and filters.
 *
 * The row scrolls sideways, by the wheel as well: a mouse has no other way
 * to move it. It keeps the open chat in view.
 */
export function ConversationStrip({ conversations, selectedId, onSelect }: ConversationStripProps) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const sorted = useMemo(() => sortConversations(conversations), [conversations]);
  const row = useRef<HTMLElement>(null);
  const selected = useRef<HTMLButtonElement>(null);

  // Only the row scrolls: `scrollIntoView` would move every container
  // around it as well, the window's clipped root included.
  useEffect(() => {
    const strip = row.current;
    const button = selected.current;
    if (strip === null || button === null) return;
    const start = button.offsetLeft - EDGE;
    const end = button.offsetLeft + button.offsetWidth + EDGE;
    if (start < strip.scrollLeft) strip.scrollLeft = start;
    else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = end - strip.clientWidth;
  }, [selectedId]);

  // One chat is the one on screen: a row of it says nothing.
  if (sorted.length < 2) return null;

  return (
    <nav
      ref={row}
      aria-label={t("window.strip")}
      onWheel={(event) => {
        const strip = event.currentTarget;
        if (event.deltaY !== 0 && strip.scrollWidth > strip.clientWidth) strip.scrollLeft += event.deltaY;
      }}
      className="relative flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line-subtle px-8 py-6 [scrollbar-width:none]"
    >
      {sorted.map((conversation) => {
        const current = conversation.id === selectedId;
        const title = names.title(conversation);
        const badge = rowBadge(conversation);
        const mentions = conversation.unreadMentions;
        const label = [
          title,
          badge === null ? null : t("list.unread", { count: badge.count }),
          mentions > 0 ? t("list.mentionsUnread", { count: mentions }) : null,
          conversation.notify === "mute" ? t("notify.muted") : null,
        ]
          .filter((part): part is string => part !== null)
          .join(", ");
        return (
          <button
            key={conversation.id}
            ref={current ? selected : undefined}
            type="button"
            aria-label={label}
            title={title}
            aria-current={current ? "true" : undefined}
            onClick={() => onSelect(conversation.id)}
            className={cn(
              "relative flex h-40 w-36 shrink-0 items-center justify-center rounded-md cursor-pointer select-none",
              "transition-colors duration-150",
              current ? "bg-selected-overlay" : "hover:bg-hover-overlay",
            )}
          >
            <ConversationAvatar conversation={conversation} meId={names.meId} />
            {current ? (
              <span aria-hidden="true" className="absolute inset-x-8 bottom-0 h-2 rounded-full bg-accent" />
            ) : null}
            {mentions > 0 ? (
              <span
                aria-hidden="true"
                className="absolute top-0 -right-1 inline-flex size-16 items-center justify-center rounded-full bg-accent text-[10px] leading-none font-semibold text-fg-on-accent ring-2 ring-surface"
              >
                @
              </span>
            ) : badge !== null ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-0 -right-1 inline-flex h-16 min-w-16 items-center justify-center rounded-full px-4",
                  "text-[10px] leading-none font-semibold ring-2 ring-surface",
                  badge.muted ? "bg-elevated text-fg-secondary" : "bg-accent text-fg-on-accent",
                )}
              >
                {badgeLabel(badge.count)}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
