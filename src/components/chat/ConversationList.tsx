import { MessageCircle, Search, WifiOff, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  matchesFilter,
  matchesQuery,
  sortConversations,
  type ConversationFilter,
} from "../../lib/chat/conversation";
import { cn } from "../../lib/format";
import type { ChatStateView } from "../../lib/ipc";
import { useChatTypingMap } from "../../lib/queries";
import { Input } from "../ui";
import { ChatSearchResults } from "./ChatSearchResults";
import { ConversationRow } from "./ConversationRow";
import { GroupInviteRow } from "./GroupInviteRow";
import { useChatNames } from "./useChatText";

interface ConversationListProps {
  state: ChatStateView;
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  /** A search hit: the conversation, and the message to jump to. */
  onOpenMessage: (conversationId: string, seq: number) => void;
  dense?: boolean;
  className?: string;
}

const FILTERS: ConversationFilter[] = ["all", "direct", "group", "server"];

/**
 * --- slice: chat ---
 *
 * The first level of the chat: a search field, the filter, the invitations
 * into groups and the conversations, the server chat first and the rest by
 * their last message.
 *
 * The field filters the list by name as the player types and, from three
 * characters on, searches the messages of every chat as well; the hits go
 * under the list.
 */
export function ConversationList({
  state,
  selectedId,
  onSelect,
  onOpenMessage,
  dense = false,
  className,
}: ConversationListProps) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const typing = useChatTypingMap();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>("all");

  // The title as printed joins the names the query is matched against: it is
  // what the player reads, «Deleted account» and «Kai's server» included.
  const visible = useMemo(
    () =>
      sortConversations(state.conversations).filter(
        (conversation) =>
          matchesFilter(conversation, filter) &&
          matchesQuery(conversation, query, names.meId, [names.title(conversation)]),
      ),
    [state.conversations, filter, query, names],
  );
  const searching = query.trim().length >= 3;
  const hasServer = state.conversations.some((conversation) => conversation.kind === "server");

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className={cn("flex flex-col gap-8", dense ? "p-8" : "px-12 pt-12 pb-8")}>
        <Input
          icon={<Search size={14} />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("list.search")}
          aria-label={t("list.search")}
          className={dense ? "h-32" : undefined}
          trailing={
            query !== "" ? (
              <button
                type="button"
                aria-label={t("list.clearSearch")}
                title={t("list.clearSearch")}
                onClick={() => setQuery("")}
                className="flex size-20 items-center justify-center rounded-xs text-fg-muted hover:text-fg cursor-pointer"
              >
                <X size={12} />
              </button>
            ) : null
          }
        />
        <div role="tablist" aria-label={t("list.filter")} className="flex items-center gap-4">
          {FILTERS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={entry === filter}
              onClick={() => setFilter(entry)}
              className={cn(
                "h-24 px-10 rounded-sm text-body-sm-medium select-none cursor-pointer transition-colors duration-150",
                entry === filter
                  ? "bg-selected-overlay text-fg"
                  : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
              )}
            >
              {t(`list.filters.${entry}`)}
            </button>
          ))}
        </div>
        {!state.connected ? (
          <p className="flex items-center gap-6 rounded-sm bg-warm-subtle px-8 py-4 text-body-sm text-fg-warm">
            <WifiOff size={12} className="shrink-0" />
            {t("list.offline")}
          </p>
        ) : null}
      </div>

      <div className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto", dense ? "px-4 pb-8" : "px-8 pb-12")}>
        {state.groupInvites.length > 0 && filter !== "direct" && filter !== "server" ? (
          <section aria-label={t("invites.title")} className="flex flex-col gap-4 pb-8">
            <h3 className="px-8 pt-4 text-label-xs text-fg-muted">{t("invites.title")}</h3>
            {state.groupInvites.map((invite) => (
              <GroupInviteRow key={invite.conversationId} invite={invite} onJoined={onSelect} />
            ))}
          </section>
        ) : null}

        {visible.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={conversation.id === selectedId}
            onSelect={() => onSelect(conversation.id)}
            typing={typing[conversation.id]?.userIds ?? []}
            dense={dense}
          />
        ))}

        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-8 px-16 py-32 text-center">
            <MessageCircle size={24} className="text-fg-muted" />
            <p className="text-body-sm text-fg-muted">
              {query.trim() !== ""
                ? t("list.noMatch", { query: query.trim() })
                : filter === "server" && !hasServer
                  ? t("list.noServerChat")
                  : state.conversations.length === 0
                    ? t("list.empty")
                    : t("list.emptyFilter")}
            </p>
          </div>
        ) : null}

        {searching ? <ChatSearchResults query={query} onOpenMessage={onOpenMessage} /> : null}
      </div>
    </div>
  );
}
