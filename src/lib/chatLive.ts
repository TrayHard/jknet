import { useSyncExternalStore } from "react";

import type { ChatDownloadEvent, ChatStagedFile, ChatUploadEvent } from "./ipc";

/**
 * --- slice: chat ---
 *
 * The short-lived chat state of one window: who is typing, how far each
 * upload has got, and files dropped on the window that wait for a composer.
 *
 * A store outside React Query on purpose. None of this is a read of the core
 * that could be refetched: it only exists as a stream of events, it expires by
 * itself, and a cache entry that never has a query function behind it would
 * be refetched into nothing by the first `invalidateQueries({ queryKey:
 * ["chat"] })`. The writer is `useChatEvents` in `queries.ts`; the readers
 * are the hooks of the same file.
 */

type Listener = () => void;

/** How long a typing line stays without a fresh event: the service's `ttlMs`. */
export const TYPING_TTL_MS = 6_000;

interface TypingEntry {
  userIds: string[];
  until: number;
}

let typing: Readonly<Record<string, TypingEntry>> = {};
let uploads: Readonly<Record<string, ChatUploadEvent>> = {};
// --- slice: chat cards --- how far each download has got, by file id.
let downloads: Readonly<Record<string, ChatDownloadEvent>> = {};
let dropped: readonly ChatStagedFile[] = [];
// --- slice: chat groups --- sessions whose server chat the host ended.
let endedSessions: ReadonlySet<string> = new Set();
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function publish() {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const NOBODY: readonly string[] = [];

export const chatLive = {
  /** Who types in a conversation now; an empty list clears the line at once. */
  setTyping(conversationId: string, userIds: string[]) {
    const timer = timers.get(conversationId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(conversationId);
    const next = { ...typing };
    if (userIds.length === 0) {
      delete next[conversationId];
    } else {
      next[conversationId] = { userIds, until: Date.now() + TYPING_TTL_MS };
      // The core sends the list again while somebody keeps typing; a line
      // nobody refreshes goes away by itself, like the service's own ttl.
      timers.set(
        conversationId,
        setTimeout(() => chatLive.setTyping(conversationId, []), TYPING_TTL_MS),
      );
    }
    typing = next;
    publish();
  },

  /** A message from a typist ends their line before the timer does. */
  stopTyping(conversationId: string, userId: string | null) {
    const entry = typing[conversationId];
    if (entry === undefined || userId === null || !entry.userIds.includes(userId)) return;
    chatLive.setTyping(
      conversationId,
      entry.userIds.filter((id) => id !== userId),
    );
  },

  typingIn(conversationId: string | null): readonly string[] {
    if (conversationId === null) return NOBODY;
    return typing[conversationId]?.userIds ?? NOBODY;
  },

  typingMap(): Readonly<Record<string, TypingEntry>> {
    return typing;
  },

  setUpload(event: ChatUploadEvent) {
    uploads = { ...uploads, [event.handle]: event };
    publish();
  },

  clearUpload(handle: string) {
    if (!(handle in uploads)) return;
    const next = { ...uploads };
    delete next[handle];
    uploads = next;
    publish();
  },

  upload(handle: string): ChatUploadEvent | undefined {
    return uploads[handle];
  },

  // --- slice: chat cards ---
  /** The progress of a download; the last event of it ends the entry. */
  setDownload(event: ChatDownloadEvent) {
    const next = { ...downloads };
    if (event.status === undefined || event.status === "downloading") next[event.fileId] = event;
    else delete next[event.fileId];
    downloads = next;
    publish();
  },

  download(fileId: string): ChatDownloadEvent | undefined {
    return downloads[fileId];
  },

  /** Files the core staged from a drop on this window, for the composer to take. */
  addDropped(files: ChatStagedFile[]) {
    if (files.length === 0) return;
    dropped = [...dropped, ...files];
    publish();
  },

  /** Hands the dropped files to a composer and forgets them. */
  takeDropped(): ChatStagedFile[] {
    const taken = [...dropped];
    if (taken.length > 0) {
      dropped = [];
      publish();
    }
    return taken;
  },

  droppedCount(): number {
    return dropped.length;
  },

  /**
   * --- slice: chat groups --- the host ended the chat of this server: the
   * core does not open it again while the same server runs, and the Play
   * with friends screen says so instead of waiting for it.
   */
  markServerChatEnded(sessionId: string) {
    const key = sessionId.toLowerCase();
    if (endedSessions.has(key)) return;
    endedSessions = new Set([...endedSessions, key]);
    publish();
  },

  serverChatEnded(sessionId: string): boolean {
    return endedSessions.has(sessionId.toLowerCase());
  },

  /** Everything goes on sign-out: nothing of one account may show for the next. */
  reset() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    typing = {};
    uploads = {};
    downloads = {};
    dropped = [];
    endedSessions = new Set();
    publish();
  },
};

/** Who is typing in one conversation, as a stable list. */
export function useTypingIn(conversationId: string | null): readonly string[] {
  return useSyncExternalStore(subscribe, () => chatLive.typingIn(conversationId));
}

/** Every conversation somebody types in, for the list rows. */
export function useTypingMap(): Readonly<Record<string, TypingEntry>> {
  return useSyncExternalStore(subscribe, () => chatLive.typingMap());
}

/** The progress of one staged file on its way up, or `undefined`. */
export function useUploadProgress(handle: string): ChatUploadEvent | undefined {
  return useSyncExternalStore(subscribe, () => chatLive.upload(handle));
}

/** The progress of one file on its way down, or `undefined` while none comes. */
export function useDownloadProgress(fileId: string): ChatDownloadEvent | undefined {
  return useSyncExternalStore(subscribe, () => chatLive.download(fileId));
}

/** How many dropped files wait for a composer. */
export function useDroppedCount(): number {
  return useSyncExternalStore(subscribe, () => chatLive.droppedCount());
}

/** --- slice: chat groups --- whether the host ended the chat of this server. */
export function useServerChatEnded(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => chatLive.serverChatEnded(sessionId));
}
