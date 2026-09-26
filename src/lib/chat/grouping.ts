/**
 * Laying a thread out: day dividers, the unread divider, and runs of messages
 * by one sender.
 *
 * --- slice: chat ---
 *
 * The thread draws a list of items, not a list of messages. Messages of one
 * sender that follow each other within five minutes form one group with one
 * avatar and one name; a new day, the first unread message, a system line or
 * another sender starts a new one. A user message whose `senderId` is `null`
 * belongs to a deleted account, and all such messages count as one sender:
 * two deleted accounts cannot be told apart any more, and the thread says so
 * rather than inventing a difference.
 *
 * Pure functions, no React: `grouping.test.mjs` runs them under `node --test`.
 */

import type { ChatMessage } from "../ipc";

/** Messages of one sender further apart than this start a new group. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export type ThreadItem =
  | { type: "day"; key: string; day: string; at: string }
  | { type: "unread"; key: string }
  | {
      type: "group";
      key: string;
      senderId: string | null;
      mine: boolean;
      messages: ChatMessage[];
    }
  | { type: "system"; key: string; message: ChatMessage };

export interface LayoutOptions {
  /** My account id; `null` when it is not known yet. */
  meId: string | null;
  /**
   * The divider goes before the first message of another sender after this
   * one: the read marker as it was when the thread was opened. `null` draws
   * no divider.
   */
  unreadAfterSeq: number | null;
  /** The calendar day of a timestamp, in the time zone the player sees. */
  dayOf?: (iso: string) => string;
  windowMs?: number;
}

/** `YYYY-MM-DD` of a timestamp in local time. */
export function localDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether two senders are the same for grouping: equal ids, or both deleted. */
export function sameSender(a: string | null, b: string | null): boolean {
  return a === b;
}

/**
 * Where the unread divider goes: the first message after `readSeq` that
 * somebody else wrote, or `null` when there is none.
 *
 * My own messages never count as unread, and a system line does not either,
 * so a thread where the only news is «Kai joined» opens without a divider.
 */
export function unreadDividerSeq(
  messages: ChatMessage[],
  readSeq: number | null,
  meId: string | null,
): number | null {
  if (readSeq === null) return null;
  for (const message of messages) {
    if (message.seq <= readSeq) continue;
    if (message.kind !== "user") continue;
    if (meId !== null && message.senderId === meId) continue;
    return message.seq;
  }
  return null;
}

/** Turns a thread of messages (ascending `seq`) into the items the thread draws. */
export function layoutThread(messages: ChatMessage[], options: LayoutOptions): ThreadItem[] {
  const dayOf = options.dayOf ?? localDay;
  const windowMs = options.windowMs ?? GROUP_WINDOW_MS;
  const dividerSeq = unreadDividerSeq(messages, options.unreadAfterSeq, options.meId);

  const items: ThreadItem[] = [];
  let day: string | null = null;
  let group: Extract<ThreadItem, { type: "group" }> | null = null;

  for (const message of messages) {
    const messageDay = dayOf(message.createdAt);
    if (messageDay !== day) {
      day = messageDay;
      group = null;
      items.push({ type: "day", key: `day:${messageDay}:${message.seq}`, day: messageDay, at: message.createdAt });
    }
    if (message.seq === dividerSeq) {
      group = null;
      items.push({ type: "unread", key: `unread:${message.seq}` });
    }
    if (message.kind === "system") {
      group = null;
      items.push({ type: "system", key: `system:${message.seq}`, message });
      continue;
    }

    const previous = group?.messages[group.messages.length - 1];
    const close =
      previous !== undefined &&
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) <= windowMs;
    if (group !== null && sameSender(group.senderId, message.senderId) && close) {
      group.messages.push(message);
      continue;
    }

    group = {
      type: "group",
      key: `group:${message.seq}`,
      senderId: message.senderId,
      mine: options.meId !== null && message.senderId === options.meId,
      messages: [message],
    };
    items.push(group);
  }

  return items;
}
