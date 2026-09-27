/**
 * Keeping the summaries in step with the service: the rules of the
 * launcher's `src-tauri/src/chat/sync.rs`, the constants the same.
 *
 * The core reads the sync document, `GET /v1/chat/conversations`, whenever
 * what it holds may be stale:
 *
 * - the live socket opened again: frames sent while it was down are not
 *   replayed;
 * - a frame asked for it (`chat.resync` after the socket lagged, or read
 *   receipts switched on or off);
 * - the account changed: everything of the previous one is forgotten first;
 * - the socket is down: then at most once a minute, so the badges still move;
 * - the tab came back to the screen after a while in the background.
 *
 * Each answer replaces the book, goes out as `chat:state` and then as
 * `chat:resync` with the conversations whose `lastSeq` went back, and lets
 * the outbox and the read markers try at once whatever was waiting.
 */

import type { Book } from "./book.ts";

/** How long after the start the first sync document is read when the socket has not opened by then. */
export const FIRST_SYNC_DELAY_MS = 2_000;
/** How often the sync document is read while the socket is down. */
export const OFFLINE_REFRESH_MS = 60_000;
/** How long `chat:state` waits for more changes before it goes out: a burst of frames is one repaint. */
export const STATE_DEBOUNCE_MS = 100;

/**
 * Puts the markers still on their way back on a book a sync document just
 * replaced: the document may be older than they are.
 */
export function keepReads(book: Book, me: string | null, marks: Array<[string, number]>): void {
  for (const [conversationId, seq] of marks) book.readLocally(me, conversationId, seq);
}
