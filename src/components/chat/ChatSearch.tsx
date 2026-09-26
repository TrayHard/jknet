import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  SEARCH_KINDS,
  SEARCH_MAX,
  minQueryLength,
  narrowed,
  scopeConversation,
  searchReady,
  type ChatSearchScope,
} from "../../lib/chat/search";
import { cn } from "../../lib/format";
import type { ChatSearchHas, OnlineUser } from "../../lib/ipc";
import { useChatConversation, useChatState, useFriendsState } from "../../lib/queries";
import { Input, Select, type SelectOption } from "../ui";
import { ChatSearchResults } from "./ChatSearchResults";
import { useChatNames } from "./useChatText";

interface ChatSearchProps {
  /**
   * The chat on screen: the search starts in it and offers **All chats**
   * beside it. `null` searches every chat and offers no scope.
   */
  conversationId: string | null;
  /** A hit: its conversation and the message to jump to. */
  onOpenMessage: (conversationId: string, seq: number) => void;
  /** The close button of the field. */
  onClose?: () => void;
  dense?: boolean;
}

/**
 * --- slice: chat groups ---
 *
 * The search of the chat: the words, where to look — **This chat** or **All
 * chats** — what the messages carry — links, pictures, videos, files, cards —
 * and who sent them.
 *
 * Across every chat the words need three characters, inside one a single
 * one; the service keeps the last 90 days and finds only what the player can
 * see, so a search that finds nothing says how far it looked and offers to
 * look wider. A deleted account cannot be picked as a sender: its messages
 * still turn up, under **Deleted account**.
 */
export function ChatSearch({ conversationId, onOpenMessage, onClose, dense = false }: ChatSearchProps) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const conversation = useChatConversation(conversationId);
  const state = useChatState().data;
  const friends = useFriendsState().data?.friends;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ChatSearchScope>(conversationId === null ? "all" : "this");
  const [has, setHas] = useState<ChatSearchHas | null>(null);
  const [senderId, setSenderId] = useState<string | null>(null);
  const within = scopeConversation(scope, conversationId);

  // The senders a scope can name: the members of this chat, or everybody
  // this launcher knows by name — the members of every chat and the friends.
  const senders = useMemo<OnlineUser[]>(() => {
    const people = new Map<string, OnlineUser>();
    if (within !== null) {
      for (const member of conversation?.members ?? []) people.set(member.user.id, member.user);
    } else {
      for (const other of state?.conversations ?? []) {
        for (const member of other.members) people.set(member.user.id, member.user);
      }
      for (const friend of friends ?? []) people.set(friend.user.id, friend.user);
    }
    if (names.meId !== null) people.delete(names.meId);
    return [...people.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
    );
  }, [within, conversation, state, friends, names.meId]);

  const senderOptions: SelectOption[] = [
    { value: "", label: t("search.fromAnyone") },
    ...(names.meId === null ? [] : [{ value: names.meId, label: t("search.fromYou") }]),
    ...senders.map((user) => ({ value: user.id, label: user.displayName })),
  ];

  const pickScope = (next: ChatSearchScope) => {
    setScope(next);
    // A sender of another chat is nobody here.
    if (next === "this" && senderId !== null && senderId !== names.meId) {
      const member = conversation?.members.some((m) => m.user.id === senderId) ?? false;
      if (!member) setSenderId(null);
    }
  };

  const title = conversation === null ? null : names.title(conversation);
  const ready = searchReady(query, within);
  const typed = query.trim() !== "";
  const placeholder = within !== null && title !== null ? t("thread.searchPlaceholder", { name: title }) : t("search.placeholderAll");

  return (
    <div className="flex min-h-0 flex-col">
      <div className={cn("flex flex-col gap-8", dense ? "p-6" : "p-8")}>
        <Input
          autoFocus
          icon={<Search size={14} />}
          value={query}
          maxLength={SEARCH_MAX}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && onClose !== undefined) {
              // The search answers Escape itself: the drawer around stays open.
              event.preventDefault();
              event.stopPropagation();
              if (query !== "") setQuery("");
              else onClose();
            }
          }}
          placeholder={placeholder}
          aria-label={t("thread.search")}
          className="h-32"
          trailing={
            onClose !== undefined ? (
              <button
                type="button"
                aria-label={t("thread.closeSearch")}
                title={t("thread.closeSearch")}
                onClick={onClose}
                className="flex size-20 items-center justify-center rounded-xs text-fg-muted cursor-pointer hover:text-fg"
              >
                <X size={12} />
              </button>
            ) : null
          }
        />
        {conversationId !== null ? (
          <div role="radiogroup" aria-label={t("search.scope")} className="flex items-center gap-4">
            {(["this", "all"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={scope === entry}
                onClick={() => pickScope(entry)}
                className={cn(
                  "h-24 px-10 rounded-sm text-body-sm-medium select-none cursor-pointer transition-colors duration-150",
                  scope === entry
                    ? "bg-selected-overlay text-fg"
                    : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
                )}
              >
                {entry === "this" ? t("search.scopeThis") : t("search.scopeAll")}
              </button>
            ))}
          </div>
        ) : null}
        <SearchKindChips value={has} onChange={setHas} />
        <Select
          size="sm"
          label={t("search.from")}
          ariaLabel={t("search.from")}
          value={senderId ?? ""}
          onChange={(value) => setSenderId(value === "" ? null : value)}
          options={senderOptions}
          className="self-start"
        />
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto pb-8", dense ? "px-2" : "px-4")}>
        {!typed ? (
          <p className="px-8 py-4 text-body-sm text-fg-muted">
            {within !== null ? t("search.startThis") : t("search.startAll", { count: minQueryLength(null) })}
          </p>
        ) : !ready ? (
          <p className="px-8 py-4 text-body-sm text-fg-muted">
            {t("search.short", { count: minQueryLength(within) })}
          </p>
        ) : (
          <ChatSearchResults
            query={query}
            conversationId={within}
            has={has}
            senderId={senderId}
            onOpenMessage={onOpenMessage}
            onWiden={within !== null ? () => pickScope("all") : undefined}
            onClearFilters={
              narrowed(has, senderId)
                ? () => {
                    setHas(null);
                    setSenderId(null);
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

interface SearchKindChipsProps {
  value: ChatSearchHas | null;
  onChange: (value: ChatSearchHas | null) => void;
}

/** The chips that narrow a search to what the messages carry: **All**, **Links**, **Images**… */
export function SearchKindChips({ value, onChange }: SearchKindChipsProps) {
  const { t } = useTranslation("chat");
  const chips: Array<ChatSearchHas | null> = [null, ...SEARCH_KINDS];
  return (
    <div role="radiogroup" aria-label={t("search.kinds")} className="flex flex-wrap items-center gap-4">
      {chips.map((kind) => {
        const on = kind === value;
        return (
          <button
            key={kind ?? "any"}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(kind)}
            className={cn(
              "h-24 px-8 rounded-full border text-body-sm select-none cursor-pointer transition-colors duration-150",
              on
                ? "border-line-accent bg-accent-subtle text-fg-accent"
                : "border-line text-fg-secondary hover:bg-hover-overlay hover:text-fg",
            )}
          >
            {kind === null ? t("search.kind.any") : t(`search.kind.${kind}`)}
          </button>
        );
      })}
    </div>
  );
}
