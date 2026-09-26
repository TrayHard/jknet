/**
 * The rules of the chat search, before any request goes out.
 *
 * --- slice: chat groups ---
 *
 * The service searches the messages of the last 90 days that the player can
 * see. A query is 1 to 64 characters after trimming; across every chat it
 * needs three at least, since a one- or two-letter match over everything is
 * noise, and inside one chat a single character is enough. Besides the
 * words, a search narrows to one sender and to messages that carry a link, a
 * picture, a video, any file or a card.
 *
 * Pure functions: `search.test.mjs` runs them under `node --test`.
 */

import type { ChatSearchFilters, ChatSearchHas } from "../ipc";

/** Where a search looks: the chat on screen, or every chat. */
export type ChatSearchScope = "this" | "all";

/** Characters a search of every chat needs at least. */
export const SEARCH_MIN_ALL = 3;
/** Characters a search of one chat needs at least. */
export const SEARCH_MIN_ONE = 1;
/** The longest query the service takes. */
export const SEARCH_MAX = 64;

/** The kinds a search narrows to, in the order the chips stand. */
export const SEARCH_KINDS: readonly ChatSearchHas[] = ["link", "image", "video", "file", "card"];

/** The chat a scope searches: the one on screen for `this`, none for `all`. */
export function scopeConversation(scope: ChatSearchScope, conversationId: string | null): string | null {
  return scope === "this" ? conversationId : null;
}

/** How many characters the query of a scope needs. */
export function minQueryLength(conversationId: string | null): number {
  return conversationId === null ? SEARCH_MIN_ALL : SEARCH_MIN_ONE;
}

/** Whether a query is ready to go to the service. */
export function searchReady(query: string, conversationId: string | null): boolean {
  const length = [...query.trim()].length;
  return length >= minQueryLength(conversationId) && length <= SEARCH_MAX;
}

/** The filters of a request: only what is set, so two equal searches share a cache entry. */
export function searchFilters(
  conversationId: string | null,
  has: ChatSearchHas | null,
  senderId: string | null,
): ChatSearchFilters {
  const filters: ChatSearchFilters = {};
  if (conversationId !== null) filters.conversationId = conversationId;
  if (has !== null) filters.has = has;
  if (senderId !== null) filters.senderId = senderId;
  return filters;
}

/** Whether anything besides the words narrows the search. */
export function narrowed(has: ChatSearchHas | null, senderId: string | null): boolean {
  return has !== null || senderId !== null;
}
