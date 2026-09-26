import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { fold } from "../../lib/chat/conversation";
import { useChatConversation, useChatSearch } from "../../lib/queries";
import type { ChatMessage } from "../../lib/ipc";
import { Avatar, Button } from "../ui";
import { useChatNames, useChatTimes } from "./useChatText";

interface ChatSearchResultsProps {
  query: string;
  /** Only this conversation; every chat when left out. */
  conversationId?: string | null;
  onOpenMessage: (conversationId: string, seq: number) => void;
}

/**
 * --- slice: chat ---
 *
 * The messages that match a search, newest first, under the list.
 *
 * The service finds them; the words are highlighted here. A hit of a deleted
 * account carries **Deleted account** like the thread does.
 */
/**
 * How long the words rest before they are searched. The service allows twenty
 * searches a minute: one per key would spend them on a single query.
 */
const SEARCH_DEBOUNCE_MS = 350;

export function ChatSearchResults({ query, conversationId = null, onOpenMessage }: ChatSearchResultsProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const search = useChatSearch(settled, { conversationId });
  const hits = search.data?.pages.flatMap((page) => page.results.map((result) => result.message)) ?? [];

  return (
    <section aria-label={t("search.title")} className="flex flex-col gap-2 pt-12">
      <h3 className="px-8 pb-4 text-label-xs text-fg-muted">
        {search.isLoading || settled !== query ? t("search.searching") : t("search.count", { count: hits.length })}
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
    </section>
  );
}

function SearchHit({ message, query, onOpen }: { message: ChatMessage; query: string; onOpen: () => void }) {
  const names = useChatNames();
  const times = useChatTimes();
  const conversation = useChatConversation(message.conversationId);
  const sender = names.person(message.senderId);
  const text = names.excerpt(message.body, 160);
  // A direct chat is named after the sender already: its title adds nothing.
  const where = conversation !== null && conversation.kind !== "direct" ? names.title(conversation) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-10 rounded-md px-10 py-8 text-left hover:bg-hover-overlay cursor-pointer"
    >
      <Avatar name={message.senderId === null ? null : (sender?.displayName ?? names.personName(message.senderId))} src={sender?.avatarUrl} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex items-center gap-6 min-w-0">
          <span className="truncate text-body-sm-medium text-fg">{names.personName(message.senderId)}</span>
          {where !== null ? <span className="truncate text-body-sm text-fg-muted">{where}</span> : null}
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
