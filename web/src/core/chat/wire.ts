/**
 * The chat's wire shapes, read the way the launcher's serde types read them
 * (`src-tauri/src/online/types.rs` and the payloads of `chat/frames.rs`).
 *
 * The service is the truth, but it is also newer or older than this build:
 * a field it leaves out takes the default the launcher gives it
 * (`notify: "all"`, `canSend: false`, `kind: "user"` …), and a field the
 * launcher cannot do without — an id, a `seq` — makes the whole document
 * unreadable, exactly where `serde` would refuse it. Every reader answers a
 * fresh object: nothing the service sent is kept by reference.
 */

import type {
  ChatCard,
  ChatFileRef,
  ChatGroupInvite,
  ChatMember,
  ChatMessage,
  ChatPrivacy,
  ChatQuota,
  ChatReactionGroup,
  ChatReplyRef,
  ChatSystem,
  Conversation,
  OnlineUser,
} from "../../../../src/lib/ipc.ts";

/** A payload the launcher would refuse to read. */
export class WireError extends Error {
  constructor(what: string) {
    super(`unreadable ${what}`);
    this.name = "WireError";
  }
}

type Json = Record<string, unknown>;

function object(value: unknown, what: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WireError(what);
  return value as Json;
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A required string. */
export function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new WireError(what);
  return value;
}

/** A required `u64`. */
export function seq(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new WireError(what);
  return value;
}

/** A defaulted string: missing or `null` is the default, anything else must be a string. */
function strOr(value: unknown, fallback: string, what: string): string {
  if (value === undefined || value === null) return fallback;
  return str(value, what);
}

function optStr(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  return str(value, what);
}

function numOr(value: unknown, fallback: number, what: string): number {
  if (value === undefined || value === null) return fallback;
  return seq(value, what);
}

function optNum(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null;
  return seq(value, what);
}

function boolOr(value: unknown, fallback: boolean, what: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new WireError(what);
  return value;
}

function listOf<T>(value: unknown, read: (item: unknown) => T, what: string): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new WireError(what);
  return value.map(read);
}

export function readUser(value: unknown): OnlineUser {
  const raw = object(value, "user");
  return {
    id: str(raw.id, "user.id"),
    displayName: strOr(raw.displayName, "", "user.displayName"),
    avatarUrl: optStr(raw.avatarUrl, "user.avatarUrl"),
    provider: strOr(raw.provider, "", "user.provider"),
    providerName: strOr(raw.providerName, "", "user.providerName"),
    createdAt: strOr(raw.createdAt, "", "user.createdAt"),
  };
}

export function readMember(value: unknown): ChatMember {
  const raw = object(value, "member");
  return {
    user: readUser(raw.user),
    role: strOr(raw.role, "", "member.role") as ChatMember["role"],
    joinedAt: strOr(raw.joinedAt, "", "member.joinedAt"),
    readSeq: optNum(raw.readSeq, "member.readSeq"),
  };
}

function readFile(value: unknown): ChatFileRef {
  const raw = object(value, "file");
  const meta = raw.meta === undefined || raw.meta === null ? null : { ...object(raw.meta, "file.meta") };
  return {
    id: str(raw.id, "file.id"),
    name: str(raw.name, "file.name"),
    size: numOr(raw.size, 0, "file.size"),
    mediaType: strOr(raw.mediaType, "", "file.mediaType"),
    class: strOr(raw.class, "", "file.class") as ChatFileRef["class"],
    danger: boolOr(raw.danger, false, "file.danger"),
    meta: meta as ChatFileRef["meta"],
  };
}

function readReply(value: unknown): ChatReplyRef | null {
  if (value === undefined || value === null) return null;
  const raw = object(value, "replyTo");
  const at = seq(raw.seq, "replyTo.seq");
  if (boolOr(raw.missing, false, "replyTo.missing")) return { seq: at, missing: true };
  return { seq: at, senderId: optStr(raw.senderId, "replyTo.senderId"), excerpt: strOr(raw.excerpt, "", "replyTo.excerpt") };
}

function readReaction(value: unknown): ChatReactionGroup {
  const raw = object(value, "reaction");
  return {
    emoji: str(raw.emoji, "reaction.emoji"),
    userIds: listOf(raw.userIds, (id) => str(id, "reaction.userIds"), "reaction.userIds"),
  };
}

function readSystem(value: unknown): ChatSystem | null {
  if (value === undefined || value === null) return null;
  const raw = object(value, "system");
  const system: ChatSystem = {
    event: str(raw.event, "system.event") as ChatSystem["event"],
    userId: optStr(raw.userId, "system.userId"),
    by: optStr(raw.by, "system.by"),
  };
  if (raw.title !== undefined && raw.title !== null) system.title = str(raw.title, "system.title");
  if (raw.on !== undefined && raw.on !== null) system.on = boolOr(raw.on, false, "system.on");
  return system;
}

export function readMessage(value: unknown): ChatMessage {
  const raw = object(value, "message");
  return {
    conversationId: str(raw.conversationId, "message.conversationId"),
    seq: seq(raw.seq, "message.seq"),
    senderId: optStr(raw.senderId, "message.senderId"),
    clientId: optStr(raw.clientId, "message.clientId"),
    kind: strOr(raw.kind, "user", "message.kind") as ChatMessage["kind"],
    body: strOr(raw.body, "", "message.body"),
    cards: listOf(raw.cards, (card) => structuredClone(card) as ChatCard, "message.cards"),
    files: listOf(raw.files, readFile, "message.files"),
    mentions: listOf(raw.mentions, (id) => str(id, "message.mentions"), "message.mentions"),
    replyTo: readReply(raw.replyTo),
    reactions: listOf(raw.reactions, readReaction, "message.reactions"),
    system: readSystem(raw.system),
    createdAt: strOr(raw.createdAt, "", "message.createdAt"),
  };
}

export function readConversation(value: unknown): Conversation {
  const raw = object(value, "conversation");
  const server = raw.server === undefined || raw.server === null ? null : object(raw.server, "conversation.server");
  return {
    id: str(raw.id, "conversation.id"),
    kind: str(raw.kind, "conversation.kind") as Conversation["kind"],
    title: optStr(raw.title, "conversation.title"),
    ownerId: optStr(raw.ownerId, "conversation.ownerId"),
    members: listOf(raw.members, readMember, "conversation.members"),
    lastSeq: numOr(raw.lastSeq, 0, "conversation.lastSeq"),
    lastMessage: raw.lastMessage === undefined || raw.lastMessage === null ? null : readMessage(raw.lastMessage),
    readSeq: numOr(raw.readSeq, 0, "conversation.readSeq"),
    visibleFromSeq: numOr(raw.visibleFromSeq, 0, "conversation.visibleFromSeq"),
    unread: numOr(raw.unread, 0, "conversation.unread"),
    unreadMentions: numOr(raw.unreadMentions, 0, "conversation.unreadMentions"),
    notify: strOr(raw.notify, "all", "conversation.notify") as Conversation["notify"],
    canSend: boolOr(raw.canSend, false, "conversation.canSend"),
    historyForNewMembers: boolOr(raw.historyForNewMembers, false, "conversation.historyForNewMembers"),
    server:
      server === null
        ? null
        : { hostId: str(server.hostId, "server.hostId"), sessionId: str(server.sessionId, "server.sessionId") },
    createdAt: strOr(raw.createdAt, "", "conversation.createdAt"),
  };
}

export function readInvite(value: unknown): ChatGroupInvite {
  const raw = object(value, "invite");
  return {
    conversationId: str(raw.conversationId, "invite.conversationId"),
    title: optStr(raw.title, "invite.title"),
    invitedBy: readUser(raw.invitedBy),
    memberCount: numOr(raw.memberCount, 0, "invite.memberCount"),
    createdAt: strOr(raw.createdAt, "", "invite.createdAt"),
    expiresAt: strOr(raw.expiresAt, "", "invite.expiresAt"),
  };
}

/** A missing settings row means the defaults, on the service and here. */
export const DEFAULT_PRIVACY: ChatPrivacy = { shareReadReceipts: true, shareTyping: true, groupAdd: "friends" };

export function readPrivacy(value: unknown): ChatPrivacy {
  if (value === undefined || value === null) return { ...DEFAULT_PRIVACY };
  const raw = object(value, "settings");
  return {
    shareReadReceipts: boolOr(raw.shareReadReceipts, true, "settings.shareReadReceipts"),
    shareTyping: boolOr(raw.shareTyping, true, "settings.shareTyping"),
    groupAdd: strOr(raw.groupAdd, "friends", "settings.groupAdd") as ChatPrivacy["groupAdd"],
  };
}

export function readQuota(value: unknown): ChatQuota {
  if (value === undefined || value === null) return { usedBytes: 0, quotaBytes: 0, nextFreeAt: null };
  const raw = object(value, "quota");
  return {
    usedBytes: numOr(raw.usedBytes, 0, "quota.usedBytes"),
    quotaBytes: numOr(raw.quotaBytes, 0, "quota.quotaBytes"),
    nextFreeAt: optStr(raw.nextFreeAt, "quota.nextFreeAt"),
  };
}

/** `GET /v1/chat/conversations`: every conversation, the invites, the settings and the quota. */
export interface SyncDoc {
  conversations: Conversation[];
  groupInvites: ChatGroupInvite[];
  settings: ChatPrivacy;
  quota: ChatQuota;
}

export function readSyncDoc(value: unknown): SyncDoc {
  const raw = isObject(value) ? value : {};
  return {
    conversations: listOf(raw.conversations, readConversation, "conversations"),
    groupInvites: listOf(raw.groupInvites, readInvite, "groupInvites"),
    settings: readPrivacy(raw.settings),
    quota: readQuota(raw.quota),
  };
}

/** A message a player wrote, as opposed to the service. */
export function isUser(message: ChatMessage): boolean {
  return message.kind !== "system";
}

/** Whether `me` wrote it. A deleted account's message has no sender and is never anybody's own. */
export function isFrom(message: ChatMessage, me: string | null): boolean {
  return me !== null && message.senderId === me;
}

/**
 * A list of players as ids, whether the service lists ids, users or members:
 * the three shapes name the same people (`user_ids` of the launcher).
 */
export function readUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string") ids.push(item);
    else if (isObject(item) && typeof item.id === "string") ids.push(item.id);
    else if (isObject(item) && isObject(item.user) && typeof item.user.id === "string") ids.push(item.user.id);
  }
  return ids;
}

/** Why the service did not add somebody to a group. */
export function readRefusals(value: unknown): Array<{ userId: string; reason: string }> {
  return listOf(value, (item) => {
    const raw = object(item, "refusal");
    return { userId: str(raw.userId, "refusal.userId"), reason: str(raw.reason, "refusal.reason") };
  }, "refused");
}
