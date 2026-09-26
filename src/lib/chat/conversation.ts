/**
 * What a conversation is called and where it goes in the list.
 *
 * --- slice: chat ---
 *
 * A direct chat is named after the other player; one whose account was
 * deleted has only me left in `members`, and is named «Deleted account». A
 * group has its own title or, without one, the names of its members. A server
 * chat is named after the host. This module decides which of those applies
 * and leaves the words to the component, so it stays free of any language.
 *
 * Pure functions: `conversation.test.mjs` runs them under `node --test`.
 */

import type { ChatKind, Conversation, OnlineUser } from "../ipc";

/** How a conversation is named, before translation. */
export type ConversationName =
  | { kind: "peer"; user: OnlineUser }
  | { kind: "deleted" }
  | { kind: "group"; title: string }
  | { kind: "members"; names: string[]; more: number }
  | { kind: "server"; host: OnlineUser | null };

/** How many member names an untitled group shows before «and N more». */
export const NAMES_SHOWN = 3;

/** The other player of a direct chat, or `null` when their account is gone. */
export function peerOf(conversation: Conversation, meId: string | null): OnlineUser | null {
  if (conversation.kind !== "direct") return null;
  const other = conversation.members.find((member) => member.user.id !== meId);
  return other?.user ?? null;
}

/** Whether a direct chat is with an account that no longer exists. */
export function isDeletedPeer(conversation: Conversation, meId: string | null): boolean {
  return conversation.kind === "direct" && peerOf(conversation, meId) === null;
}

export function conversationName(
  conversation: Conversation,
  meId: string | null,
): ConversationName {
  if (conversation.kind === "direct") {
    const peer = peerOf(conversation, meId);
    return peer === null ? { kind: "deleted" } : { kind: "peer", user: peer };
  }
  if (conversation.kind === "server") {
    const hostId = conversation.server?.hostId ?? conversation.ownerId;
    const host = conversation.members.find((member) => member.user.id === hostId)?.user ?? null;
    return { kind: "server", host };
  }
  const title = conversation.title?.trim() ?? "";
  if (title !== "") return { kind: "group", title };
  const others = conversation.members
    .filter((member) => member.user.id !== meId)
    .map((member) => member.user.displayName);
  return {
    kind: "members",
    names: others.slice(0, NAMES_SHOWN),
    more: Math.max(0, others.length - NAMES_SHOWN),
  };
}

/** When a conversation last moved: its last message, or when it was made. */
export function lastActivity(conversation: Conversation): string {
  return conversation.lastMessage?.createdAt ?? conversation.createdAt;
}

/**
 * The order of the list: the server chat first while it lives, then the
 * newest activity first. The id breaks a tie so the order never flickers.
 */
export function sortConversations(conversations: Conversation[]): Conversation[] {
  return conversations.slice().sort((a, b) => {
    if (a.kind === "server" && b.kind !== "server") return -1;
    if (b.kind === "server" && a.kind !== "server") return 1;
    const byTime = Date.parse(lastActivity(b)) - Date.parse(lastActivity(a));
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The segments of the filter above the list. */
export type ConversationFilter = "all" | "direct" | "group" | "server";

export function matchesFilter(conversation: Conversation, filter: ConversationFilter): boolean {
  return filter === "all" || conversation.kind === (filter as ChatKind);
}

/**
 * Whether the words typed in the search field name this conversation: its
 * title, or any member but me. Case and accents are ignored.
 */
export function matchesQuery(
  conversation: Conversation,
  query: string,
  meId: string | null,
  extraNames: string[] = [],
): boolean {
  const needle = fold(query.trim());
  if (needle === "") return true;
  const names = [
    conversation.title ?? "",
    ...conversation.members
      .filter((member) => member.user.id !== meId)
      .map((member) => member.user.displayName),
    ...extraNames,
  ];
  return names.some((name) => fold(name).includes(needle));
}

/** Lowercase without diacritics, for comparing names. */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Whether I own the conversation: the creator of a group, the host of a server chat. */
export function isOwner(conversation: Conversation, meId: string | null): boolean {
  return meId !== null && conversation.ownerId === meId;
}
