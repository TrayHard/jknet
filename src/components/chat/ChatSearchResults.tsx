import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { fold } from "../../lib/chat/conversation";
import { searchFilters, searchReady } from "../../lib/chat/search";
import { useChatConversation, useChatSearch } from "../../lib/queries";
import type { ChatMessage, ChatSearchHas } from "../../lib/ipc";
import { Avatar, Badge, Button } from "../ui";
import { useChatNames, useChatTimes } from "./useChatText";

interface ChatSearchResultsProps {
  query: string;
  /** Only this conversation; every chat when left out. */
  conversationId?: string | null;
  /** --- slice: chat groups --- only messages that carry this. */
  has?: ChatSearchHas | null;
  /** --- slice: chat groups --- only messages of this account. */
  senderId?: string | null;
  onOpenMessage: (conversationId: string, seq: number) => void;
  /** --- slice: chat groups --- **Search all chats**, offered when a search of one chat found nothing. */
  onWiden?: () => void;
  /** --- slice: chat groups --- **Show everything**, offered when a filter narrowed the search to nothing. */
  onClearFilters?: () => void;
}

/**
 * --- slice: chat ---
 *
 * The messages that match a search, newest first, under the list.
 *
 * The service finds them; the words are highlighted here. A hit of a deleted
 * account carries **Deleted account** like the thread does.
 *
 * --- slice: chat groups --- A search narrowed by a kind or a sender, and
 * one that found nothing, which says so and offers to look wider.
 */
/**
 * How long the words rest before they are searched. The service allows twenty
 * searches a minute: one per key would spend them on a single query.
 */
const SEARCH_DEBOUNCE_MS = 350;

export function ChatSearchResults({
  query,
  conversationId = null,
  has = null,
  senderId = null,
  onOpenMessage,
  onWiden,
  onClearFilters,
}: ChatSearchResultsProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const search = useChatSearch(settled, searchFilters(conversationId, has, senderId));
  const hits = search.data?.pages.flatMap((page) => page.results.map((result) => result.message)) ?? [];
  const waiting = search.isLoading || settled !== query;
  const nothing = !waiting && !search.error && searchReady(settled, conversationId) && search.isSuccess && hits.length === 0;

  return (
    <section aria-label={t("search.title")} className="flex flex-col gap-2 pt-12">
      <h3 className="px-8 pb-4 text-label-xs text-fg-muted">
        {waiting ? t("search.searching") : t("search.count", { count: hits.length })}
      </h3>
      {search.error ? (
        <p role="alert" className="px-8 text-body-sm text-fg-danger">{errorText(search.error)}</p>
      ) : null}
      {hits.map((message) => (
        <SearchHit
          key={`${message.conversationId}:${message.seq}`}
          message={message}
          query={settled}
          onOpen={() => onOpenMessage(message.conversationId, message.seq)}
        />
      ))}
      {nothing ? (
        <div className="flex flex-col items-start gap-8 px-8 py-8">
          <p className="text-body-md text-fg">{t("search.none")}</p>
          {onWiden !== undefined || onClearFilters !== undefined ? (
            <span className="flex flex-wrap items-center gap-6">
              {onWiden !== undefined ? (
                <Button size="sm" onClick={onWiden}>
                  {t("search.widen")}
                </Button>
              ) : null}
              {onClearFilters !== undefined ? (
                <Button size="sm" variant="ghost" onClick={onClearFilters}>
                  {t("search.clearFilters")}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {search.hasNextPage ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={search.isFetchingNextPage}
          onClick={() => void search.fetchNextPage()}
        >
          {t("search.more")}
        </Button>
      ) : null}
      <p className="px-8 pt-8 text-body-sm text-fg-muted">{t("search.retention")}</p>
    </section>
  );
}

/** What a hit carries besides its words, as one short mark. */
function hitKind(message: ChatMessage): "image" | "video" | "file" | "card" | null {
  if (message.files.some((file) => file.class === "image")) return "image";
  if (message.files.some((file) => file.class === "video")) return "video";
  if (message.files.length > 0) return "file";
  if (message.cards.length > 0) return "card";
  return null;
}

function SearchHit({ message, query, onOpen }: { message: ChatMessage; query: string; onOpen: () => void }) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const times = useChatTimes();
  const conversation = useChatConversation(message.conversationId);
  const sender = names.person(message.senderId);
  const body = names.excerpt(message.body, 160);
  // A hit on a file name or a card has no words of its own: the file or the
  // card speaks for it, which is what the service matched.
  const text =
    body !== ""
      ? body
      : message.files.length > 0
        ? message.files.map((file) => file.name).join(", ")
        : (message.cards[0]?.fallbackText ?? "");
  // A direct chat is named after the sender already: its title adds nothing.
  const where = conversation !== null && conversation.kind !== "direct" ? names.title(conversation) : null;
  const kind = hitKind(message);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-10 rounded-md px-10 py-8 text-left hover:bg-hover-overlay cursor-pointer"
    >
      <Avatar name={message.senderId === null ? null : (sender?.displayName ?? names.personName(message.senderId))} src={sender?.avatarUrl} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex items-center gap-6 min-w-0">
          <span
            className={
              "truncate text-body-sm-medium [unicode-bidi:isolate] " +
              (message.senderId === null ? "text-fg-muted" : "text-fg")
            }
          >
            {names.personName(message.senderId)}
          </span>
          {where !== null ? <span className="truncate text-body-sm text-fg-muted [unicode-bidi:isolate]">{where}</span> : null}
          {kind !== null ? (
            <Badge className="shrink-0">
              {kind === "card" ? t("summary.card") : kind === "file" ? t("files.class.other") : t(`files.class.${kind}`)}
            </Badge>
          ) : null}
          <span className="ml-auto shrink-0 text-mono-xs text-fg-muted">{times.row(message.createdAt)}</span>
        </span>
        <span className="line-clamp-2 text-body-sm text-fg-secondary [unicode-bidi:isolate] [overflow-wrap:anywhere]">
          <Highlighted text={text} query={query} />
        </span>
      </span>
    </button>
  );
}

/**
 * The text with every occurrence of the query marked, compared the way the
 * service compares: case and accents ignored. Positions are found in the
 * folded text, which keeps the length of plain Latin and Cyrillic; a text
 * whose folding changes its length is shown unmarked rather than misaligned.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = fold(query.trim());
  const haystack = fold(text);
  if (needle === "" || haystack.length !== text.length) return <>{text}</>;
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (;;) {
    const found = haystack.indexOf(needle, at);
    if (found < 0) break;
    if (found > at) parts.push({ text: text.slice(at, found), hit: false });
    parts.push({ text: text.slice(found, found + needle.length), hit: true });
    at = found + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-xs bg-accent-subtle px-1 text-fg-accent">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
