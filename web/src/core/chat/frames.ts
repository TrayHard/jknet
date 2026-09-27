/**
 * The `chat.*` frames of the live socket: a port of the launcher's
 * `src-tauri/src/chat/frames.rs`.
 *
 * A frame is parsed (`parseFrame`, refusing a payload the launcher's serde
 * types would refuse) and applied to the chat's state (`applyFrame`), which
 * touches no network and no timer and answers what should happen next as a
 * list of effects; the core then carries them out. The split keeps the rules
 * testable without a socket: `frames.test.mjs` runs the shared cases of
 * `src/lib/chat/fixtures/frames.json`, the launcher's Rust tests the same.
 *
 * | Frame                       | What it does                                   | Event          |
 * | --------------------------- | ---------------------------------------------- | -------------- |
 * | `chat.message`              | moves the summary, settles the outbox entry, may notify | `chat:message` |
 * | `chat.read`                 | moves a read marker                            | `chat:read`    |
 * | `chat.typing`               | notes who types, until `ttlMs` runs out        | `chat:typing`  |
 * | `chat.reaction`             | patches the last message of the summary        | `chat:reaction`|
 * | `chat.conversation`         | replaces one summary                           | `chat:state`   |
 * | `chat.conversation.removed` | drops one summary, its queue and its draft     | `chat:removed` |
 * | `chat.groupInvite`          | adds an invite                                 | `chat:state`   |
 * | `chat.groupInvite.removed`  | drops an invite                                | `chat:state`   |
 * | `chat.settings`             | replaces the privacy settings                  | `chat:state`   |
 * | `chat.resync`               | the socket lagged: read the sync document again| `chat:resync`  |
 *
 * A frame of a kind this build does not know is dropped.
 */

import type { ChatGroupInvite, ChatMessage, ChatPrivacy, Conversation } from "../../../../src/lib/ipc.ts";
import type { Book, ReactionChange, ReadMark } from "./book.ts";
import type { Outbox } from "./outbox.ts";
import type { ReadMarks } from "./reads.ts";
import {
  isFrom,
  isUser,
  readConversation,
  readInvite,
  readMessage,
  readPrivacy,
  seq,
  str,
  WireError,
} from "./wire.ts";

/** How long a typing hint lasts when the frame does not say. */
export const DEFAULT_TYPING_TTL_MS = 6_000;
/** The longest a typing hint is believed, whatever the frame says. */
export const MAX_TYPING_TTL_MS = 30_000;

/** The chat events the frames emit, under the names of `lib/ipc.ts`. */
export const CHAT_EVENTS = {
  state: "chat:state",
  message: "chat:message",
  read: "chat:read",
  reaction: "chat:reaction",
  typing: "chat:typing",
  outbox: "chat:outbox",
  removed: "chat:removed",
  resync: "chat:resync",
  draft: "chat:draft",
  notify: "chat:notify",
  open: "chat:open",
  upload: "chat:upload",
  download: "chat:download",
  filesStaged: "chat:files-staged",
} as const;

export interface TypingHint {
  conversationId: string;
  userId: string;
  ttlMs: number | null;
}

export interface Removal {
  conversationId: string;
  reason: string;
}

export type Frame =
  | { kind: "message"; message: ChatMessage }
  | { kind: "read"; mark: ReadMark }
  | { kind: "typing"; hint: TypingHint }
  | { kind: "reaction"; change: ReactionChange }
  | { kind: "conversation"; conversation: Conversation }
  | { kind: "removed"; removal: Removal }
  | { kind: "groupInvite"; invite: ChatGroupInvite }
  | { kind: "groupInviteRemoved"; conversationId: string }
  | { kind: "settings"; privacy: ChatPrivacy }
  | { kind: "resync" }
  | { kind: "unknown"; type: string };

function payloadObject(payload: unknown, what: string): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new WireError(what);
  return payload as Record<string, unknown>;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new WireError(what);
  return value;
}

/** Reads one frame. The payload of an unknown kind is not looked at; a broken known one throws. */
export function parseFrame(type: string, payload: unknown): Frame {
  switch (type) {
    case "chat.message":
      return { kind: "message", message: readMessage(payloadObject(payload, type).message) };
    case "chat.read": {
      const raw = payloadObject(payload, type);
      return {
        kind: "read",
        mark: { conversationId: str(raw.conversationId, type), userId: str(raw.userId, type), seq: seq(raw.seq, type) },
      };
    }
    case "chat.typing": {
      const raw = payloadObject(payload, type);
      return {
        kind: "typing",
        hint: {
          conversationId: str(raw.conversationId, type),
          userId: str(raw.userId, type),
          ttlMs: raw.ttlMs === undefined || raw.ttlMs === null ? null : seq(raw.ttlMs, type),
        },
      };
    }
    case "chat.reaction": {
      const raw = payloadObject(payload, type);
      return {
        kind: "reaction",
        change: {
          conversationId: str(raw.conversationId, type),
          seq: seq(raw.seq, type),
          userId: str(raw.userId, type),
          emoji: str(raw.emoji, type),
          on: flag(raw.on, type),
        },
      };
    }
    case "chat.conversation":
      return { kind: "conversation", conversation: readConversation(payloadObject(payload, type).conversation) };
    case "chat.conversation.removed": {
      const raw = payloadObject(payload, type);
      return {
        kind: "removed",
        removal: {
          conversationId: str(raw.conversationId, type),
          reason: raw.reason === undefined || raw.reason === null ? "" : str(raw.reason, type),
        },
      };
    }
    case "chat.groupInvite":
      return { kind: "groupInvite", invite: readInvite(payloadObject(payload, type).invite) };
    case "chat.groupInvite.removed":
      return { kind: "groupInviteRemoved", conversationId: str(payloadObject(payload, type).conversationId, type) };
    case "chat.settings": {
      const raw = payloadObject(payload, type);
      if (raw.settings === undefined) throw new WireError(type);
      return { kind: "settings", privacy: readPrivacy(payloadObject(raw.settings, type)) };
    }
    case "chat.resync":
      return { kind: "resync" };
    default:
      return { kind: "unknown", type };
  }
}

/** What a frame asks for after it moved the state. */
export type Effect =
  | { kind: "emit"; event: string; payload: unknown }
  /** The summaries moved: `chat:state`, debounced. */
  | { kind: "state" }
  /** The queue of one conversation moved: `chat:outbox`. */
  | { kind: "outbox"; conversationId: string }
  /** The conversation is on screen: read it up to its last message. */
  | { kind: "markRead"; conversationId: string }
  /** Fetch one conversation the book does not know or cannot count. */
  | { kind: "refresh"; conversationId: string }
  /** Read the whole sync document again. */
  | { kind: "resync" }
  /** Emit `chat:typing` again for this conversation once the hint ran out. */
  | { kind: "typingExpires"; conversationId: string; after: number }
  /** A message of somebody else arrived: decide whether it notifies. */
  | { kind: "notify"; message: ChatMessage };

/** The name a fixture gives an effect: the event of an `emit`, the kind of the rest. */
export function effectName(effect: Effect): string {
  return effect.kind === "emit" ? effect.event : effect.kind;
}

/** What `applyFrame` reads and moves. */
export interface FrameState {
  book: Book;
  outbox: Outbox;
  reads: ReadMarks;
  /** Drops the draft of a conversation the player is no longer in. */
  dropDraft(conversationId: string): void;
  /** On screen, in a visible and focused tab, at the bottom of the thread. */
  isViewed(conversationId: string): boolean;
}

/** Applies one frame. `me` is the signed-in account; `now` is the clock the typing hints expire by. */
export function applyFrame(state: FrameState, me: string | null, frame: Frame, now: number): Effect[] {
  const { book, outbox } = state;
  const effects: Effect[] = [];
  switch (frame.kind) {
    case "message": {
      const { message } = frame;
      const id = message.conversationId;
      const viewed = state.isViewed(id);
      const applied = book.applyMessage(me, message, viewed);
      // The service sends a message to every device of its sender, and that
      // is how an entry whose answer was lost still leaves the queue.
      if (isFrom(message, me) && message.clientId !== null && outbox.take(message.clientId) !== undefined) {
        effects.push({ kind: "outbox", conversationId: id });
      }
      if (!applied.known) effects.push({ kind: "refresh", conversationId: id });
      if (applied.fresh) {
        effects.push({ kind: "state" });
        if (viewed && !isFrom(message, me)) effects.push({ kind: "markRead", conversationId: id });
      }
      if (applied.typingStopped) {
        effects.push({ kind: "emit", event: CHAT_EVENTS.typing, payload: { conversationId: id, userIds: book.typingIn(id, now) } });
      }
      effects.unshift({ kind: "emit", event: CHAT_EVENTS.message, payload: message });
      // A new message of somebody else may notify; a replayed or old one,
      // and the player's own, never do.
      if ((applied.fresh || !applied.known) && !isFrom(message, me) && isUser(message)) {
        effects.push({ kind: "notify", message });
      }
      break;
    }
    case "read": {
      const [known, refresh] = book.applyRead(me, frame.mark);
      if (known) effects.push({ kind: "state" });
      if (refresh) effects.push({ kind: "refresh", conversationId: frame.mark.conversationId });
      effects.unshift({ kind: "emit", event: CHAT_EVENTS.read, payload: { ...frame.mark } });
      break;
    }
    case "typing": {
      const { hint } = frame;
      // The service never echoes the player's own hint; a second device of
      // the same account is still the player. A player who hides typing sees
      // nobody typing (D8).
      if (me === hint.userId || !book.sharesTyping()) break;
      const ttl = Math.min(hint.ttlMs ?? DEFAULT_TYPING_TTL_MS, MAX_TYPING_TTL_MS);
      book.setTyping(hint.conversationId, hint.userId, now + ttl);
      const userIds = book.typingIn(hint.conversationId, now);
      effects.push({ kind: "emit", event: CHAT_EVENTS.typing, payload: { conversationId: hint.conversationId, userIds } });
      effects.push({ kind: "typingExpires", conversationId: hint.conversationId, after: ttl });
      break;
    }
    case "reaction": {
      if (book.applyReaction(frame.change)) effects.push({ kind: "state" });
      effects.unshift({ kind: "emit", event: CHAT_EVENTS.reaction, payload: { ...frame.change } });
      break;
    }
    case "conversation":
      book.upsert(frame.conversation);
      effects.push({ kind: "state" });
      break;
    case "removed": {
      const id = frame.removal.conversationId;
      const known = book.remove(id);
      if (outbox.removeConversation(id).length > 0) effects.push({ kind: "outbox", conversationId: id });
      state.dropDraft(id);
      state.reads.remove(id);
      // Told even when the book did not have it: a screen may hold the
      // thread from before the last sync document.
      effects.push({ kind: "emit", event: CHAT_EVENTS.removed, payload: { ...frame.removal } });
      if (known) effects.push({ kind: "state" });
      break;
    }
    case "groupInvite":
      book.upsertInvite(frame.invite);
      effects.push({ kind: "state" });
      break;
    case "groupInviteRemoved":
      if (book.removeInvite(frame.conversationId)) effects.push({ kind: "state" });
      break;
    case "settings":
      if (book.setPrivacy(frame.privacy)) effects.push({ kind: "resync" });
      effects.push({ kind: "state" });
      break;
    case "resync":
      effects.push({ kind: "resync" });
      break;
    case "unknown":
      break;
  }
  return effects;
}
