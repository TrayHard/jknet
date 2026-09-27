/**
 * Read markers on their way to the service: a port of `ReadMarks` of the
 * launcher's `src-tauri/src/chat/sync.rs`.
 *
 * A conversation read on screen is marked read at once on this side, and the
 * service hears about it after a second of quiet, one request per
 * conversation, the highest `seq` winning. A marker the network or a busy
 * service lost waits and goes again at the pace of the outbox, for as long
 * as the outbox tries (counted on the same online clock); after that it
 * waits for the next sync document, which sends it at once. A marker the
 * service refused goes.
 */

import { backoff, GIVE_UP_AFTER_MS } from "./outbox.ts";

/** How long read markers gather before they go out. */
export const READ_DEBOUNCE_MS = 1_000;

function raise(marks: Map<string, number>, conversationId: string, seq: number): void {
  marks.set(conversationId, Math.max(marks.get(conversationId) ?? 0, seq));
}

export class ReadMarks {
  /** Waiting for the next flush, by conversation. */
  waiting = new Map<string, number>();
  /** Sent and not answered yet, by conversation. */
  sending = new Map<string, number>();
  /** Flushes in a row that lost a marker. */
  failures = 0;
  /** The online clock at the first of those flushes. */
  failingSince: number | null = null;

  /** Queues a marker. The higher one of a conversation wins. */
  queue(conversationId: string, seq: number): void {
    raise(this.waiting, conversationId, seq);
  }

  /** Takes every waiting marker for one flush. */
  take(): Array<[string, number]> {
    const batch = [...this.waiting.entries()];
    this.waiting = new Map();
    for (const [conversationId, seq] of batch) raise(this.sending, conversationId, seq);
    return batch;
  }

  /** The service took a marker: the network works again. */
  sent(conversationId: string, seq: number): void {
    this.settle(conversationId, seq);
    this.failures = 0;
    this.failingSince = null;
  }

  /** The service refused a marker, and would refuse it again. */
  refused(conversationId: string, seq: number): void {
    this.settle(conversationId, seq);
  }

  /** A marker was lost on the way: it waits for the next flush. */
  failed(conversationId: string, seq: number): void {
    this.settle(conversationId, seq);
    raise(this.waiting, conversationId, seq);
  }

  /** Drops the answered marker, unless a later flush sent a higher one. */
  private settle(conversationId: string, seq: number): void {
    const sent = this.sending.get(conversationId);
    if (sent !== undefined && sent <= seq) this.sending.delete(conversationId);
  }

  /**
   * Counts a flush that lost markers and answers when the next one goes:
   * the wait of the outbox, or `null` once markers failed for as long as the
   * outbox tries. They keep waiting then, for the next sync document or the
   * next conversation read.
   */
  retryAfter(online: number): number | null {
    this.failures += 1;
    this.failingSince ??= online;
    return online - this.failingSince < GIVE_UP_AFTER_MS ? backoff(this.failures) : null;
  }

  /**
   * A sync document came: the connection works, so the count of failures
   * starts again. Answers whether markers wait to go out.
   */
  connectionBack(): boolean {
    this.failures = 0;
    this.failingSince = null;
    return this.waiting.size > 0;
  }

  /** Every marker waiting or in flight, the higher one of a conversation. */
  all(): Array<[string, number]> {
    const all = new Map(this.sending);
    for (const [conversationId, seq] of this.waiting) raise(all, conversationId, seq);
    return [...all.entries()];
  }

  /** Forgets the markers of a conversation the player left, or whose history went back. */
  remove(conversationId: string): void {
    this.waiting.delete(conversationId);
    this.sending.delete(conversationId);
  }

  /** Forgets everything: the account changed. */
  clear(): void {
    this.waiting = new Map();
    this.sending = new Map();
    this.failures = 0;
    this.failingSince = null;
  }
}
