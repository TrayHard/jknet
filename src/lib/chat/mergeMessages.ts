/**
 * Keeping a loaded thread in step with messages that arrive live.
 *
 * --- slice: chat ---
 *
 * A thread is loaded in pages (ascending `seq`), and the newest page is the
 * last one. A live `chat:message` is a hint, not the truth: it is appended
 * only when it directly follows what is loaded, a message already there is
 * ignored, and a message that leaves a hole asks for the missing ones instead
 * of being placed after the hole. `seq` is gap-free per conversation, which is
 * what makes «directly follows» a comparison of two numbers.
 *
 * Pure functions, no React and no React Query: `mergeMessages.test.mjs` runs
 * them under `node --test`, and `lib/queries.ts` applies them to the cache.
 */

import type { ChatMessage, ChatMessagePage, ChatReactionGroup } from "../ipc";

/** What happened to a live message. */
export type IncomingOutcome =
  /** Placed after the last loaded message. */
  | "appended"
  /** Placed inside the loaded range, where a hole was. */
  | "inserted"
  /** Already loaded: nothing changed. */
  | "duplicate"
  /** Newer than the next expected one: fetch what lies between. */
  | "gap"
  /** Outside what is loaded, older, or beyond a page not loaded yet: ignore it. */
  | "outside";

/** Merges two ascending lists into one, each `seq` once; `b` wins a tie. */
export function mergeSorted(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (right === undefined || (left !== undefined && left.seq < right.seq)) {
      out.push(left);
      i += 1;
    } else if (left === undefined || right.seq < left.seq) {
      out.push(right);
      j += 1;
    } else {
      out.push(right);
      i += 1;
      j += 1;
    }
  }
  return out;
}

/** The newest loaded `seq`, or `null` when nothing is loaded. */
export function lastLoadedSeq(pages: ChatMessagePage[]): number | null {
  for (let p = pages.length - 1; p >= 0; p -= 1) {
    const messages = pages[p].messages;
    if (messages.length > 0) return messages[messages.length - 1].seq;
  }
  return null;
}

/** The oldest loaded `seq`, or `null`. */
export function firstLoadedSeq(pages: ChatMessagePage[]): number | null {
  for (const page of pages) {
    if (page.messages.length > 0) return page.messages[0].seq;
  }
  return null;
}

/** Every loaded message, in order. */
export function flattenPages(pages: ChatMessagePage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const page of pages) out.push(...page.messages);
  return out;
}

/**
 * Places a live message into the pages, or says why it did not.
 *
 * The pages are never mutated: an unchanged outcome answers the same array.
 */
export function placeIncoming(
  pages: ChatMessagePage[],
  message: ChatMessage,
): { pages: ChatMessagePage[]; outcome: IncomingOutcome } {
  if (pages.length === 0) return { pages, outcome: "outside" };
  const lastPage = pages[pages.length - 1];
  const last = lastLoadedSeq(pages);
  const first = firstLoadedSeq(pages);

  // Nothing loaded yet: an empty thread that is open takes its first message.
  if (last === null || first === null) {
    if (lastPage.hasAfter) return { pages, outcome: "outside" };
    return { pages: withLast(pages, { ...lastPage, messages: [message] }), outcome: "appended" };
  }

  if (message.seq > last) {
    // The newest page is not loaded: the message is found when it is.
    if (lastPage.hasAfter) return { pages, outcome: "outside" };
    if (message.seq === last + 1) {
      return {
        pages: withLast(pages, { ...lastPage, messages: [...lastPage.messages, message] }),
        outcome: "appended",
      };
    }
    return { pages, outcome: "gap" };
  }

  if (message.seq < first) return { pages, outcome: "outside" };

  for (let p = 0; p < pages.length; p += 1) {
    if (pages[p].messages.some((m) => m.seq === message.seq)) return { pages, outcome: "duplicate" };
  }

  // A hole inside the loaded range: rare, but a lost frame must not leave it.
  const index = pages.findIndex((page) => {
    const tail = page.messages[page.messages.length - 1];
    return tail !== undefined && tail.seq > message.seq;
  });
  const target = index < 0 ? pages.length - 1 : index;
  const next = pages.slice();
  next[target] = { ...pages[target], messages: mergeSorted(pages[target].messages, [message]) };
  return { pages: next, outcome: "inserted" };
}

/**
 * Adds a page read with `after` to the newest page.
 *
 * `hasAfter` of the result is the answer's: `true` means there are still
 * newer messages than what is loaded now.
 */
export function appendAfter(pages: ChatMessagePage[], page: ChatMessagePage): ChatMessagePage[] {
  if (pages.length === 0) return [page];
  const lastPage = pages[pages.length - 1];
  return withLast(pages, {
    ...lastPage,
    messages: mergeSorted(lastPage.messages, page.messages),
    hasAfter: page.hasAfter,
  });
}

/** Changes the one message with `seq`, wherever it is loaded. */
export function patchMessage(
  pages: ChatMessagePage[],
  seq: number,
  patch: (message: ChatMessage) => ChatMessage,
): ChatMessagePage[] {
  let changed = false;
  const next = pages.map((page) => {
    const index = page.messages.findIndex((m) => m.seq === seq);
    if (index < 0) return page;
    changed = true;
    const messages = page.messages.slice();
    messages[index] = patch(messages[index]);
    return { ...page, messages };
  });
  return changed ? next : pages;
}

/**
 * One reaction of one player switched on or off.
 *
 * A new emoji goes last, the order the service keeps; a group whose last
 * player took their reaction back disappears.
 */
export function applyReaction(
  reactions: ChatReactionGroup[],
  userId: string,
  emoji: string,
  on: boolean,
): ChatReactionGroup[] {
  const index = reactions.findIndex((group) => group.emoji === emoji);
  if (on) {
    if (index < 0) return [...reactions, { emoji, userIds: [userId] }];
    const group = reactions[index];
    if (group.userIds.includes(userId)) return reactions;
    const next = reactions.slice();
    next[index] = { ...group, userIds: [...group.userIds, userId] };
    return next;
  }
  if (index < 0) return reactions;
  const group = reactions[index];
  if (!group.userIds.includes(userId)) return reactions;
  const userIds = group.userIds.filter((id) => id !== userId);
  if (userIds.length === 0) return reactions.filter((_, i) => i !== index);
  const next = reactions.slice();
  next[index] = { ...group, userIds };
  return next;
}

/** How many reactions one player has on a message: the service allows three. */
export function reactionsBy(reactions: ChatReactionGroup[], userId: string): number {
  return reactions.filter((group) => group.userIds.includes(userId)).length;
}

function withLast(pages: ChatMessagePage[], last: ChatMessagePage): ChatMessagePage[] {
  const next = pages.slice();
  next[next.length - 1] = last;
  return next;
}
