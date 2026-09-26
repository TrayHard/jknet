/**
 * Unread counters and read markers.
 *
 * --- slice: chat ---
 *
 * The service counts, the launcher only adds up and patches: `unread` of a
 * conversation comes from the service (capped at 100), and a `chat:read`
 * event moves one marker until the next state arrives from the core.
 *
 * The rule of the badge: muted chats stay out of the unread total, but their
 * mentions still count — a mention is the one thing a muted chat still
 * notifies about, so it would be odd for the badge to hide it.
 *
 * Pure functions: `unread.test.mjs` runs them under `node --test`.
 */

import type { ChatMember, Conversation } from "../ipc";

/** The service stops counting here; the badge says `99+` from this on. */
export const UNREAD_CAP = 100;

export interface UnreadTotals {
  /** Unread messages of every chat that is not muted. */
  unread: number;
  /** Unread mentions and replies to me, muted chats included. */
  mentions: number;
}

export function unreadTotals(conversations: Conversation[]): UnreadTotals {
  let unread = 0;
  let mentions = 0;
  for (const conversation of conversations) {
    if (conversation.notify !== "mute") unread += conversation.unread;
    mentions += conversation.unreadMentions;
  }
  return { unread, mentions };
}

/** The text of a counter: the number, `99+` above 99, nothing at zero. */
export function badgeLabel(count: number, format: (n: number) => string = String): string {
  if (count <= 0) return "";
  if (count > 99) return `${format(99)}+`;
  return format(count);
}

/**
 * How a row shows its counter: an accent badge, a grey one for a muted chat,
 * or none.
 */
export function rowBadge(conversation: Conversation): { count: number; muted: boolean } | null {
  if (conversation.unread <= 0) return null;
  return { count: conversation.unread, muted: conversation.notify === "mute" };
}

/**
 * Applies a `chat:read` to a conversation.
 *
 * My own marker clears the counters once it reaches the last message (another
 * window of mine read it); a marker that stops short leaves them for the next
 * state, which carries the service's count. Another member's marker only moves
 * forward; one that was hidden (`null`) shows up, since the service sent it.
 */
export function applyRead(
  conversation: Conversation,
  userId: string,
  seq: number,
  meId: string | null,
): Conversation {
  if (meId !== null && userId === meId) {
    const readSeq = Math.max(conversation.readSeq, seq);
    const caughtUp = readSeq >= conversation.lastSeq;
    return {
      ...conversation,
      readSeq,
      unread: caughtUp ? 0 : conversation.unread,
      unreadMentions: caughtUp ? 0 : conversation.unreadMentions,
      members: conversation.members.map((member) =>
        member.user.id === userId ? { ...member, readSeq } : member,
      ),
    };
  }
  let changed = false;
  const members = conversation.members.map((member) => {
    if (member.user.id !== userId) return member;
    const next = member.readSeq === null ? seq : Math.max(member.readSeq, seq);
    if (next === member.readSeq) return member;
    changed = true;
    return { ...member, readSeq: next };
  });
  return changed ? { ...conversation, members } : conversation;
}

/**
 * The other members who have read up to `seq`, for the marks under my message.
 * A member whose marker is hidden (`null`) is left out: nothing is known.
 */
export function readersOf(
  members: ChatMember[],
  seq: number,
  meId: string | null,
): ChatMember[] {
  return members.filter(
    (member) => member.user.id !== meId && member.readSeq !== null && member.readSeq >= seq,
  );
}

/** Where reading starts: after my marker, or after the moment I joined. */
export function firstUnreadSeq(conversation: Conversation): number {
  return Math.max(conversation.readSeq, conversation.visibleFromSeq) + 1;
}
