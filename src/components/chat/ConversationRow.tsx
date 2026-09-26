import { BellOff, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { lastActivity } from "../../lib/chat/conversation";
import { badgeLabel, rowBadge } from "../../lib/chat/unread";
import { cn } from "../../lib/format";
import type { Conversation } from "../../lib/ipc";
import { useChatPrivacy } from "../../lib/queries";
import { ConversationAvatar } from "./ConversationAvatar";
import { useChatNames, useChatTimes, useMessageSummary } from "./useChatText";
import { useTypingText } from "./TypingLine";

interface ConversationRowProps {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
  /** Who types there now, my own typing left out. */
  typing: readonly string[];
  /** Tighter rows for the compact window. */
  dense?: boolean;
}

/**
 * --- slice: chat ---
 *
 * One line of the conversation list: the picture, the title, the last message
 * or who is typing, and the counters.
 *
 * The counter is the accent badge, or a grey one in a muted chat: the chat
 * still counts, it just does not ask for attention. `@` stands beside it
 * while a mention is unread, in a muted chat too. A chat the player cannot
 * write to any more — a friend removed, an account deleted — carries a lock.
 */
export function ConversationRow({ conversation, selected, onSelect, typing, dense = false }: ConversationRowProps) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const times = useChatTimes();
  const summary = useMessageSummary();
  const privacy = useChatPrivacy();
  const typingText = useTypingText();
  const title = names.title(conversation);
  const badge = rowBadge(conversation);
  const last = conversation.lastMessage;
  const mine = last !== null && last.kind === "user" && last.senderId !== null && last.senderId === names.meId;
  const excerpt = last === null ? t("list.noMessages") : summary(last);
  // My own switch hides typing both ways: nothing to show while it is off.
  const typingLine = privacy?.shareTyping === false ? "" : typingText(typing);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full items-center gap-12 rounded-md text-left cursor-pointer select-none",
        "transition-colors duration-100",
        dense ? "px-8 py-6" : "px-10 py-8",
        selected ? "bg-selected-overlay" : "hover:bg-hover-overlay",
      )}
    >
      <ConversationAvatar conversation={conversation} meId={names.meId} size={dense ? "sm" : "md"} />
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex items-center gap-6 min-w-0">
          <span
            className={cn(
              "truncate text-body-md-medium [unicode-bidi:isolate]",
              badge !== null && !badge.muted ? "text-fg" : "text-fg-secondary",
            )}
          >
            {title}
          </span>
          {!conversation.canSend ? (
            <Lock size={12} className="shrink-0 text-fg-muted" aria-label={t("list.readOnly")} />
          ) : null}
          {conversation.notify === "mute" ? (
            <BellOff size={12} className="shrink-0 text-fg-muted" aria-label={t("notify.muted")} />
          ) : null}
          <span className="ml-auto shrink-0 text-mono-xs text-fg-muted">
            {times.row(lastActivity(conversation))}
          </span>
        </span>
        <span className="flex items-center gap-6 min-w-0">
          {typingLine !== "" ? (
            <span className="truncate text-body-sm text-fg-accent">{typingLine}</span>
          ) : (
            <span className="truncate text-body-sm text-fg-muted [unicode-bidi:isolate]">
              {mine ? t("list.youPrefix", { text: excerpt }) : excerpt}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-4">
            {conversation.unreadMentions > 0 ? (
              <span
                aria-label={t("list.mentionsUnread", { count: conversation.unreadMentions })}
                className="inline-flex size-18 items-center justify-center rounded-full bg-accent text-label-xs text-fg-on-accent"
              >
                @
              </span>
            ) : null}
            {badge !== null ? (
              <span
                aria-label={t("list.unread", { count: badge.count })}
                className={cn(
                  "inline-flex h-18 min-w-18 items-center justify-center rounded-full px-5 text-label-xs",
                  badge.muted ? "bg-elevated text-fg-secondary" : "bg-accent text-fg-on-accent",
                )}
              >
                {badgeLabel(badge.count)}
              </span>
            ) : null}
          </span>
        </span>
      </span>
    </button>
  );
}
