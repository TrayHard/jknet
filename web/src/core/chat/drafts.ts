/**
 * What the composer hands the core, checked; and the unsent text of each
 * conversation, kept across reloads.
 *
 * `checkDraft` is `check_draft` of the launcher's `chat/mod.rs`: the
 * refusals a send would meet on the service, answered before the message is
 * queued. The limits are the launcher's.
 *
 * `Drafts` keeps the text the player has not sent, one per conversation, in
 * memory for the screens and in the `drafts` store of IndexedDB for the next
 * visit: a write goes out after a short pause, and at once when the tab goes
 * into the background. Empty text removes a draft; a sent message spends it.
 */

import type { ChatCard } from "../../../../src/lib/ipc.ts";
import { invalidInput } from "../errors.ts";
import type { Storage } from "../storage.ts";
import type { SendDraft } from "./outbox.ts";

/** The longest body the service takes; refusing here spares a request that would come back `too_long`. */
export const MAX_BODY_CHARS = 4000;
/** Cards one message may carry, as the service counts them. */
export const MAX_CARDS = 5;
/** Files one message may carry. */
export const MAX_ATTACHMENTS = 10;
/** A draft longer than this is a paste accident, not a message. */
export const MAX_DRAFT_CHARS = 16_000;
/** How long the text rests before it is written to IndexedDB. */
export const DRAFT_WRITE_MS = 400;

function length(text: string): number {
  return [...text].length;
}

/**
 * A send draft out of the arguments of `chat_send`, or the refusal the
 * service would answer. `prepareCards` cleans and completes the cards the
 * way the service reads them; the cards of the chat bring it.
 */
export function checkDraft(
  raw: { body?: unknown; cards?: unknown; attachments?: unknown; replySeq?: unknown },
  prepareCards: (cards: ChatCard[]) => ChatCard[] = (cards) => cards,
): SendDraft {
  const body = typeof raw.body === "string" ? raw.body : "";
  const cards = Array.isArray(raw.cards) ? (raw.cards as ChatCard[]) : [];
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.filter((item): item is string => typeof item === "string") : [];
  const replySeq = typeof raw.replySeq === "number" && Number.isInteger(raw.replySeq) && raw.replySeq >= 0 ? raw.replySeq : null;
  if (body.trim() === "" && cards.length === 0 && attachments.length === 0) throw invalidInput("an empty message");
  const chars = length(body);
  if (chars > MAX_BODY_CHARS) throw invalidInput(`a message is at most ${MAX_BODY_CHARS} characters, this one is ${chars}`);
  if (cards.length > MAX_CARDS) throw invalidInput(`a message carries at most ${MAX_CARDS} cards`);
  if (attachments.length > MAX_ATTACHMENTS) throw invalidInput(`a message carries at most ${MAX_ATTACHMENTS} files`);
  return { body, cards: prepareCards(cards), attachments, replySeq };
}

interface DraftRow {
  text: string;
  updatedAt: string;
}

export class Drafts {
  private readonly storage: Storage;
  private readonly texts = new Map<string, string>();
  /** Conversations whose text changed since the last write. */
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Reads the drafts of the last visit. */
  async load(): Promise<void> {
    try {
      for (const { key, value } of await this.storage.entries<DraftRow>("drafts")) {
        if (typeof value?.text === "string" && value.text !== "" && !this.texts.has(key)) this.texts.set(key, value.text);
      }
    } catch (error) {
      console.warn("Reading the chat drafts failed", error);
    }
  }

  get(conversationId: string): string {
    return this.texts.get(conversationId) ?? "";
  }

  /** Keeps the text of one conversation; empty text removes it. Answers whether it changed. */
  set(conversationId: string, text: string): boolean {
    if (length(text) > MAX_DRAFT_CHARS) throw invalidInput(`a draft is at most ${MAX_DRAFT_CHARS} characters`);
    const before = this.texts.get(conversationId) ?? "";
    if (before === text) return false;
    if (text === "") this.texts.delete(conversationId);
    else this.texts.set(conversationId, text);
    this.dirty.add(conversationId);
    this.schedule();
    return true;
  }

  /** Drops the draft of a conversation: sent, left or gone. Answers whether there was one. */
  remove(conversationId: string): boolean {
    return this.set(conversationId, "");
  }

  /** Writes what changed now: the tab is going into the background. */
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // What to write is taken now: the memory may be forgotten before the
    // writes are done.
    const batch = [...this.dirty].map((id) => [id, this.texts.get(id)] as const);
    this.dirty.clear();
    for (const [id, text] of batch) {
      try {
        if (text === undefined) await this.storage.delete("drafts", id);
        else await this.storage.put("drafts", id, { text, updatedAt: new Date().toISOString() } satisfies DraftRow);
      } catch (error) {
        console.warn("Writing a chat draft failed", error);
      }
    }
  }

  /**
   * Forgets the drafts in memory and keeps the database: another tab took
   * over and writes it, and the next `load` reads it back as it is then.
   */
  forgetMemory(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.texts.clear();
    this.dirty.clear();
  }

  /** Forgets every draft of the account; the database goes with the sign-out. */
  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.texts.clear();
    this.dirty.clear();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DRAFT_WRITE_MS);
  }
}
