/**
 * What the core knows about the conversations of the account: a port of
 * `Book` of the launcher's `src-tauri/src/chat/mod.rs`, with the same rules
 * and the same constants.
 *
 * Pure data with the rules that move it, so `book.test.mjs` tests them
 * without a socket. The summaries live here and nowhere else; what the
 * screens get is a copy (`conversations()`), so a later change of the book
 * never reaches into a document React already holds.
 */

import type {
  ChatGroupInvite,
  ChatMessage,
  ChatPrivacy,
  ChatQuota,
  ChatReactionGroup,
  Conversation,
} from "../../../../src/lib/ipc.ts";
import { isFrom, isUser, type SyncDoc } from "./wire.ts";

/**
 * The service caps `unread` here; the local count follows the same rule so
 * a badge never jumps down when the next sync document arrives.
 */
export const UNREAD_CAP = 100;

/** `chat.read`, and the `chat:read` event it becomes. */
export interface ReadMark {
  conversationId: string;
  userId: string;
  seq: number;
}

/** `chat.reaction`, and the `chat:reaction` event it becomes. */
export interface ReactionChange {
  conversationId: string;
  seq: number;
  userId: string;
  emoji: string;
  on: boolean;
}

/** What a message did to the book. */
export interface MessageApplied {
  /** The conversation is in the book; a message of an unknown one means a conversation to fetch. */
  known: boolean;
  /** The message is newer than the summary; a replayed or old one moves nothing. */
  fresh: boolean;
  /** Its sender was typing there, and is not any more. */
  typingStopped: boolean;
}

/** When a conversation last moved, for the order of the list. */
function activity(conversation: Conversation): string {
  const at = conversation.lastMessage?.createdAt ?? "";
  return at !== "" ? at : conversation.createdAt;
}

/** Moves the marker of one member forward. */
function setMemberRead(summary: Conversation, userId: string | null, seq: number): void {
  if (userId === null) return;
  const member = summary.members.find((entry) => entry.user.id === userId);
  if (member !== undefined) member.readSeq = Math.max(member.readSeq ?? 0, seq);
}

/** Adds or takes back one user's emoji. Answers whether anything changed. */
export function toggleReaction(groups: ChatReactionGroup[], userId: string, emoji: string, on: boolean): boolean {
  const index = groups.findIndex((group) => group.emoji === emoji);
  if (on) {
    if (index < 0) {
      groups.push({ emoji, userIds: [userId] });
      return true;
    }
    if (groups[index].userIds.includes(userId)) return false;
    groups[index].userIds.push(userId);
    return true;
  }
  if (index < 0) return false;
  const before = groups[index].userIds.length;
  groups[index].userIds = groups[index].userIds.filter((id) => id !== userId);
  const changed = before !== groups[index].userIds.length;
  if (groups[index].userIds.length === 0) groups.splice(index, 1);
  return changed;
}

export class Book {
  summaries = new Map<string, Conversation>();
  invites: ChatGroupInvite[] = [];
  /** `null` until the first sync document. */
  privacy: ChatPrivacy | null = null;
  quota: ChatQuota | null = null;
  /** Who is typing in which conversation, until when (ms of the core's clock). */
  private readonly typing = new Map<string, Map<string, number>>();

  /**
   * Replaces everything with a fresh sync document, and answers the
   * conversations whose `lastSeq` went back: the service database was
   * restored, and the screens must drop what they hold of those threads.
   */
  replace(doc: SyncDoc): string[] {
    const reset: string[] = [];
    const summaries = new Map<string, Conversation>();
    for (const conversation of doc.conversations) {
      const previous = this.summaries.get(conversation.id);
      if (previous !== undefined && conversation.lastSeq < previous.lastSeq) reset.push(conversation.id);
      summaries.set(conversation.id, conversation);
    }
    for (const id of [...this.typing.keys()]) {
      if (!summaries.has(id)) this.typing.delete(id);
    }
    this.summaries = summaries;
    this.invites = doc.groupInvites;
    this.privacy = doc.settings;
    this.quota = doc.quota;
    return reset;
  }

  get(id: string): Conversation | undefined {
    return this.summaries.get(id);
  }

  /** Takes a conversation the service answered or pushed. */
  upsert(conversation: Conversation): void {
    this.invites = this.invites.filter((invite) => invite.conversationId !== conversation.id);
    this.summaries.set(conversation.id, conversation);
  }

  /** Drops a conversation. Answers whether it was there. */
  remove(id: string): boolean {
    this.typing.delete(id);
    return this.summaries.delete(id);
  }

  /**
   * Moves a summary for a message that arrived or was sent.
   *
   * `viewed` means the conversation is on screen at its bottom, so the
   * message is read rather than unread. A message of `me` moves the read
   * marker to itself, as the service does for the sender. A deleted
   * account's message has no sender and counts as unread like any other.
   */
  applyMessage(me: string | null, message: ChatMessage, viewed: boolean): MessageApplied {
    const applied: MessageApplied = { known: false, fresh: false, typingStopped: false };
    if (message.senderId !== null) applied.typingStopped = this.stopTyping(message.conversationId, message.senderId);
    const summary = this.summaries.get(message.conversationId);
    if (summary === undefined) return applied;
    applied.known = true;
    if (message.seq <= summary.lastSeq) return applied;
    applied.fresh = true;
    summary.lastSeq = message.seq;
    summary.lastMessage = structuredClone(message);

    if (isFrom(message, me)) {
      summary.readSeq = Math.max(summary.readSeq, message.seq);
      summary.unread = 0;
      summary.unreadMentions = 0;
      setMemberRead(summary, me, message.seq);
    } else if (!viewed && isUser(message) && message.seq > Math.max(summary.readSeq, summary.visibleFromSeq)) {
      summary.unread = Math.min(summary.unread + 1, UNREAD_CAP);
      if (me !== null && message.mentions.includes(me)) {
        summary.unreadMentions = Math.min(summary.unreadMentions + 1, UNREAD_CAP);
      }
    }
    return applied;
  }

  /**
   * Moves a read marker. Answers `[known, refresh]`: `refresh` when the
   * player's own marker moved short of the last message, which leaves the
   * unread count unknown until the conversation is fetched again.
   */
  applyRead(me: string | null, mark: ReadMark): [boolean, boolean] {
    const summary = this.summaries.get(mark.conversationId);
    if (summary === undefined) return [false, false];
    if (me !== null && me === mark.userId) {
      summary.readSeq = Math.max(summary.readSeq, mark.seq);
      setMemberRead(summary, me, summary.readSeq);
      if (summary.readSeq >= summary.lastSeq) {
        summary.unread = 0;
        summary.unreadMentions = 0;
        return [true, false];
      }
      return [true, summary.unread > 0 || summary.unreadMentions > 0];
    }
    setMemberRead(summary, mark.userId, mark.seq);
    return [true, false];
  }

  /** Marks a conversation read up to `seq` on this side, ahead of the service's answer. */
  readLocally(me: string | null, conversationId: string, seq: number): boolean {
    const summary = this.summaries.get(conversationId);
    if (summary === undefined) return false;
    if (seq <= summary.readSeq && summary.unread === 0 && summary.unreadMentions === 0) return false;
    summary.readSeq = Math.max(summary.readSeq, seq);
    setMemberRead(summary, me, summary.readSeq);
    if (summary.readSeq >= summary.lastSeq) {
      summary.unread = 0;
      summary.unreadMentions = 0;
    }
    return true;
  }

  /** Applies one reaction to the last message of a summary, when that is the message it is about. */
  applyReaction(change: ReactionChange): boolean {
    const message = this.summaries.get(change.conversationId)?.lastMessage;
    if (message === null || message === undefined || message.seq !== change.seq) return false;
    return toggleReaction(message.reactions, change.userId, change.emoji, change.on);
  }

  /** Puts the reactions a command answered on the last message, when that is the one they belong to. */
  setReactions(conversationId: string, seq: number, reactions: ChatReactionGroup[]): void {
    const message = this.summaries.get(conversationId)?.lastMessage;
    if (message !== null && message !== undefined && message.seq === seq) message.reactions = structuredClone(reactions);
  }

  setTyping(conversationId: string, userId: string, until: number): void {
    let users = this.typing.get(conversationId);
    if (users === undefined) {
      users = new Map();
      this.typing.set(conversationId, users);
    }
    users.set(userId, until);
  }

  private stopTyping(conversationId: string, userId: string): boolean {
    return this.typing.get(conversationId)?.delete(userId) ?? false;
  }

  /** Who is typing in a conversation at `now`, the expired hints dropped, sorted. */
  typingIn(conversationId: string, now: number): string[] {
    const users = this.typing.get(conversationId);
    if (users === undefined) return [];
    for (const [id, until] of [...users]) {
      if (until <= now) users.delete(id);
    }
    const ids = [...users.keys()].sort();
    if (users.size === 0) this.typing.delete(conversationId);
    return ids;
  }

  upsertInvite(invite: ChatGroupInvite): void {
    this.invites = this.invites.filter((known) => known.conversationId !== invite.conversationId);
    this.invites.push(invite);
    this.invites.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  removeInvite(conversationId: string): boolean {
    const before = this.invites.length;
    this.invites = this.invites.filter((invite) => invite.conversationId !== conversationId);
    return before !== this.invites.length;
  }

  /**
   * Takes the settings the service answered. Answers whether the read
   * receipts switch flipped: other members' markers then appear or
   * disappear, and only a fresh sync document carries them (D8).
   */
  setPrivacy(privacy: ChatPrivacy): boolean {
    const flipped = this.privacy !== null && this.privacy.shareReadReceipts !== privacy.shareReadReceipts;
    this.privacy = privacy;
    return flipped;
  }

  /** Whether typing hints may go out. Unknown settings read as the defaults, which share. */
  sharesTyping(): boolean {
    return this.privacy === null || this.privacy.shareTyping;
  }

  /** Whether a typing hint for this conversation may go out: the player shares typing and may write there. */
  mayType(conversationId: string): boolean {
    return this.sharesTyping() && this.summaries.get(conversationId)?.canSend === true;
  }

  /** The summaries, newest activity first, as copies. */
  conversations(): Conversation[] {
    const list = [...this.summaries.values()].sort((a, b) => {
      const left = activity(a);
      const right = activity(b);
      if (left !== right) return left < right ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return structuredClone(list);
  }

  /** `[unread, mentions]`: unread without the muted conversations, mentions of every one. */
  totals(): [number, number] {
    let unread = 0;
    let mentions = 0;
    for (const summary of this.summaries.values()) {
      if (summary.notify !== "mute") unread += summary.unread;
      mentions += summary.unreadMentions;
    }
    return [unread, mentions];
  }

  /** The conversations the book knew, for a sign-out; the book is empty afterwards. */
  clear(): string[] {
    const known = [...this.summaries.keys()].sort();
    this.summaries = new Map();
    this.invites = [];
    this.privacy = null;
    this.quota = null;
    this.typing.clear();
    return known;
  }
}
