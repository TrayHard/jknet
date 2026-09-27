/**
 * The send queue: a port of `src-tauri/src/chat/outbox.rs`, same constants.
 *
 * `chat_send` answers with a client id at once and leaves the message here.
 * The queue is first in, first out per conversation: the first entry of a
 * conversation that has not failed goes out, and the ones behind it wait, so
 * two messages never arrive in the other order. An entry uploads its
 * attachments, then sends the message with the same client id on every
 * attempt, so a send whose answer was lost is stored once.
 *
 * | Failure                         | What the entry does                        |
 * | ------------------------------- | ------------------------------------------ |
 * | the network, `429`, a `5xx`     | waits 1 s, 2 s, 4 s … up to 30 s, and gives up after 10 minutes of trying online |
 * | `file_gone`, `file_not_ready`   | registers and uploads its files again, once |
 * | any other refusal               | `failed` with the reason, until **Retry** or **Discard** |
 *
 * One difference from the launcher: a phone goes offline for long spells,
 * so the ten minutes count only while the browser is online. The queue
 * reads two clocks: `now` for the waits between attempts, and `online`, the
 * milliseconds the browser has been online, for giving up. Entries survive
 * a reload in IndexedDB (`toRecord`, `fromRecord`).
 */

import type { ChatCard, ChatOutboxEntry, ChatOutboxStatus } from "../../../../src/lib/ipc.ts";
import { CoreError, serviceCode } from "../errors.ts";

/** The first wait after a failed attempt. */
export const MIN_BACKOFF_MS = 1_000;
/** The longest wait between two attempts. */
export const MAX_BACKOFF_MS = 30_000;
/** How long an entry keeps trying before it is `failed`. Read markers keep the same pace. */
export const GIVE_UP_AFTER_MS = 10 * 60_000;

/** The wait after `attempts` failures in a row: 1 s, 2 s, 4 s … up to 30 s. */
export function backoff(attempts: number): number {
  const doubled = MIN_BACKOFF_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 5);
  return Math.min(doubled, MAX_BACKOFF_MS);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A new client id: a ULID, 48 bits of milliseconds and 80 random bits in
 * Crockford's base 32, the form the service expects.
 */
export function newClientId(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  let value = BigInt(Math.max(0, Math.floor(now))) & ((1n << 48n) - 1n);
  for (const byte of random.slice(0, 10)) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    const shift = BigInt(125 - 5 * index);
    out += CROCKFORD[Number((value >> shift) & 31n)];
  }
  return out;
}

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** What the composer hands the core, checked and completed by `checkDraft`. */
export interface SendDraft {
  body: string;
  cards: ChatCard[];
  /** Handles of staged files. */
  attachments: string[];
  replySeq: number | null;
}

/** One message on its way, with the queue's bookkeeping. */
export interface OutboxEntry {
  clientId: string;
  conversationId: string;
  body: string;
  cards: ChatCard[];
  attachments: string[];
  replySeq: number | null;
  status: ChatOutboxStatus;
  /** Set on a `failed` entry: the service's reason code, or the core's own (`network`). */
  error: string | null;
  /** RFC 3339: when the player pressed Send. */
  createdAt: string;
  /** The online clock at the first attempt. */
  firstTry: number | null;
  attempts: number;
  /** The `now` clock before which the entry does not start again. */
  notBefore: number | null;
  /** The file id each attachment got, once it is up. */
  fileIds: Array<string | null>;
  /** Whether the files were registered a second time after `file_gone`. */
  reregistered: boolean;
}

export function newEntry(clientId: string, conversationId: string, draft: SendDraft, createdAt: string): OutboxEntry {
  return {
    clientId,
    conversationId,
    body: draft.body,
    cards: structuredClone(draft.cards),
    attachments: [...draft.attachments],
    replySeq: draft.replySeq,
    status: "queued",
    error: null,
    createdAt,
    firstTry: null,
    attempts: 0,
    notBefore: null,
    fileIds: draft.attachments.map(() => null),
    reregistered: false,
  };
}

/** An entry as the screens read it: without the bookkeeping. */
export function entryView(entry: OutboxEntry): ChatOutboxEntry {
  return {
    clientId: entry.clientId,
    conversationId: entry.conversationId,
    body: entry.body,
    cards: structuredClone(entry.cards),
    attachments: [...entry.attachments],
    replySeq: entry.replySeq,
    status: entry.status,
    error: entry.error,
    createdAt: entry.createdAt,
  };
}

/** The row of `outbox` in IndexedDB. Files join it with the files of the chat. */
export interface OutboxRecord {
  clientId: string;
  conversationId: string;
  draft: SendDraft;
  files: unknown[];
  status: ChatOutboxStatus;
  attempts: number;
  /** Wall clock of the first attempt, for the record. */
  firstTryAt: string | null;
  /** How long it has tried while online. */
  onlineMs: number;
  error?: string | null;
  createdAt: string;
  fileIds?: Array<string | null>;
  reregistered?: boolean;
}

export function toRecord(entry: OutboxEntry, online: number, firstTryAt: string | null, files: unknown[] = []): OutboxRecord {
  return {
    clientId: entry.clientId,
    conversationId: entry.conversationId,
    draft: { body: entry.body, cards: structuredClone(entry.cards), attachments: [...entry.attachments], replySeq: entry.replySeq },
    files,
    status: entry.status,
    attempts: entry.attempts,
    firstTryAt,
    onlineMs: entry.firstTry === null ? 0 : Math.max(0, online - entry.firstTry),
    error: entry.error,
    createdAt: entry.createdAt,
    fileIds: [...entry.fileIds],
    reregistered: entry.reregistered,
  };
}

/**
 * An entry read back after a reload. One that was on its way is queued
 * again: whether its answer came is unknown, and the client id makes a
 * second send of a stored message harmless. Its time online so far counts.
 */
export function fromRecord(record: OutboxRecord, online: number): OutboxEntry | null {
  if (typeof record?.clientId !== "string" || typeof record.conversationId !== "string") return null;
  const draft = record.draft ?? { body: "", cards: [], attachments: [], replySeq: null };
  const entry = newEntry(
    record.clientId,
    record.conversationId,
    {
      body: typeof draft.body === "string" ? draft.body : "",
      cards: Array.isArray(draft.cards) ? draft.cards : [],
      attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
      replySeq: typeof draft.replySeq === "number" ? draft.replySeq : null,
    },
    typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
  );
  entry.attempts = typeof record.attempts === "number" ? record.attempts : 0;
  if (record.status === "failed") {
    entry.status = "failed";
    entry.error = typeof record.error === "string" ? record.error : null;
  }
  if (record.firstTryAt !== null && record.firstTryAt !== undefined) {
    entry.firstTry = online - Math.max(0, typeof record.onlineMs === "number" ? record.onlineMs : 0);
  }
  if (Array.isArray(record.fileIds) && record.fileIds.length === entry.attachments.length) {
    entry.fileIds = record.fileIds.map((id) => (typeof id === "string" ? id : null));
  }
  entry.reregistered = record.reregistered === true;
  return entry;
}

/** What a failed attempt turned into. */
export type Retry = { kind: "after"; wait: number } | { kind: "gaveUp" } | { kind: "gone" };

/**
 * What kind of failure an attempt met, before the entry's own history (a
 * second loss of its files, its ten minutes) has a say. The rows of the
 * table above; `src/lib/chat/fixtures/outbox-failures.json` holds the cases
 * the launcher and the web app answer the same way.
 */
export type Failure = "filesLost" | "transient" | "refused";

/** Whether a failure is worth another attempt of the same request: `is_retryable` of the launcher. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof CoreError && error.code === "network") return true;
  const code = serviceCode(error);
  return code === "rate_limited" || code === "internal" || code === "provider_error";
}

export function classify(error: unknown): Failure {
  const code = serviceCode(error);
  if (code === "file_gone" || code === "file_not_ready") return "filesLost";
  if (isRetryable(error)) return "transient";
  return "refused";
}

/** The code a failed entry carries: the service's reason, or the core's own code. */
export function failureCode(error: unknown): string {
  const code = serviceCode(error);
  if (code !== null) return code;
  if (error instanceof CoreError) return error.code;
  return "internal";
}

/** The queue, in the order the player wrote. */
export class Outbox {
  entries: OutboxEntry[] = [];

  push(entry: OutboxEntry): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries = [];
  }

  all(): ChatOutboxEntry[] {
    return this.entries.map(entryView);
  }

  entriesOf(conversationId: string): ChatOutboxEntry[] {
    return this.entries.filter((entry) => entry.conversationId === conversationId).map(entryView);
  }

  get(clientId: string): OutboxEntry | undefined {
    return this.entries.find((entry) => entry.clientId === clientId);
  }

  /**
   * Starts every entry whose turn it is and whose wait is over, and answers
   * their client ids. The first entry of a conversation that has not failed
   * is its head; a head in flight or waiting holds the rest.
   */
  startReady(now: number, online: number): string[] {
    const heads = new Set<string>();
    const started: string[] = [];
    for (const entry of this.entries) {
      if (entry.status === "failed") continue;
      if (heads.has(entry.conversationId)) continue;
      heads.add(entry.conversationId);
      if (entry.status !== "queued") continue;
      if (entry.notBefore !== null && entry.notBefore > now) continue;
      entry.status = entry.fileIds.some((id) => id === null) ? "uploading" : "sending";
      entry.firstTry ??= online;
      entry.notBefore = null;
      started.push(entry.clientId);
    }
    return started;
  }

  /** How long until the next waiting head may start, if one waits. */
  nextWait(now: number): number | null {
    let best: number | null = null;
    for (const entry of this.entries) {
      if (entry.status !== "queued" || entry.notBefore === null) continue;
      const wait = Math.max(0, entry.notBefore - now);
      if (best === null || wait < best) best = wait;
    }
    return best;
  }

  setStatus(clientId: string, status: ChatOutboxStatus): void {
    const entry = this.get(clientId);
    if (entry !== undefined) entry.status = status;
  }

  setFileId(clientId: string, index: number, fileId: string): void {
    const entry = this.get(clientId);
    if (entry !== undefined && index >= 0 && index < entry.fileIds.length) entry.fileIds[index] = fileId;
  }

  /** The message went out, by its answer or by its frame. Answers the entry. */
  take(clientId: string): OutboxEntry | undefined {
    const index = this.entries.findIndex((entry) => entry.clientId === clientId);
    if (index < 0) return undefined;
    return this.entries.splice(index, 1)[0];
  }

  /**
   * An attempt failed in a way that may pass: schedules the next one, or
   * gives up once the entry has tried for `GIVE_UP_AFTER_MS` online.
   */
  retryLater(clientId: string, error: unknown, now: number, online: number): Retry {
    const entry = this.get(clientId);
    if (entry === undefined) return { kind: "gone" };
    entry.attempts += 1;
    entry.firstTry ??= online;
    if (online - entry.firstTry >= GIVE_UP_AFTER_MS) {
      entry.status = "failed";
      entry.error = failureCode(error);
      entry.notBefore = null;
      return { kind: "gaveUp" };
    }
    const wait = backoff(entry.attempts);
    entry.status = "queued";
    entry.notBefore = now + wait;
    return { kind: "after", wait };
  }

  /** An attempt was refused for good. Answers the entry's conversation. */
  fail(clientId: string, error: unknown): string | null {
    const entry = this.get(clientId);
    if (entry === undefined) return null;
    entry.status = "failed";
    entry.error = failureCode(error);
    entry.notBefore = null;
    return entry.conversationId;
  }

  /** The service lost the files of an entry: registers them again, once. */
  reregister(clientId: string): boolean {
    const entry = this.get(clientId);
    if (entry === undefined || entry.reregistered || entry.attachments.length === 0) return false;
    entry.reregistered = true;
    entry.fileIds = entry.attachments.map(() => null);
    entry.status = "queued";
    entry.notBefore = null;
    return true;
  }

  /** **Retry** on a failed entry: a fresh start, with the same client id. */
  retry(clientId: string): string | null {
    const entry = this.get(clientId);
    if (entry === undefined) return null;
    if (entry.status !== "failed") return entry.conversationId;
    entry.status = "queued";
    entry.error = null;
    entry.attempts = 0;
    entry.firstTry = null;
    entry.notBefore = null;
    entry.reregistered = false;
    return entry.conversationId;
  }

  /** The connection is back: every waiting entry may go now. */
  flush(): void {
    for (const entry of this.entries) {
      if (entry.status === "queued") entry.notBefore = null;
    }
  }

  /** Whether an entry still carries this staged file. */
  holdsAttachment(handle: string): boolean {
    return this.entries.some((entry) => entry.attachments.includes(handle));
  }

  /** Drops the entries of a conversation the player is no longer in. Answers the dropped ones. */
  removeConversation(conversationId: string): OutboxEntry[] {
    const gone = this.entries.filter((entry) => entry.conversationId === conversationId);
    this.entries = this.entries.filter((entry) => entry.conversationId !== conversationId);
    return gone;
  }

  /** Whether anything waits or is on its way: the update waits for it. */
  busy(): boolean {
    return this.entries.some((entry) => entry.status !== "failed");
  }
}
