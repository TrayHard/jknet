/**
 * The chat of the web core: the TypeScript port of the launcher's
 * `src-tauri/src/chat/` that answers the chat commands of `lib/ipc.ts` and
 * sends the same `chat:*` events, over the JKNet Online API.
 *
 * The service is the truth. On this device the core is the only writer: it
 * keeps a summary of every conversation, queues and retries what the player
 * sends, moves read markers, and decides what a frame of the live socket
 * means. The screens display what the core emits and report what they show.
 *
 * | Part                                   | File         | Launcher source |
 * | -------------------------------------- | ------------ | --------------- |
 * | the summaries and their rules          | `book.ts`    | `chat/mod.rs`   |
 * | the sync document, resync              | `sync.ts`    | `chat/sync.rs`  |
 * | read markers                           | `reads.ts`   | `chat/sync.rs`  |
 * | the send queue, persisted              | `outbox.ts`  | `chat/outbox.rs`|
 * | the `chat.*` frames                    | `frames.ts`  | `chat/frames.rs`|
 * | typing hints, drafts, what is on screen| `typing.ts`, `drafts.ts`, `viewing.ts` | `chat/mod.rs` |
 * | links                                  | `links.ts`   | `chat/links.rs` |
 * | what notifies, and how                 | `notify.ts`, `sounds.ts` | `chat/notify.rs` |
 * | search                                 | `search.ts`  | `chat/mod.rs`   |
 * | the wire shapes                        | `wire.ts`    | `online/types.rs` |
 *
 * Message history stays in memory, as in the launcher: the service holds
 * it, and a reload reads the sync document again. What must survive a
 * reload — the queue and the drafts — lives in IndexedDB.
 *
 * Files and cards join through `ChatFiles` and `prepareCards`; the chat of
 * a friend's private server through the router.
 */

import type {
  ChatCard,
  ChatMessage,
  ChatMessagePage,
  ChatNotifications,
  ChatPrivacy,
  ChatReactionGroup,
  ChatSearchPage,
  ChatStateView,
  Conversation,
} from "../../../../src/lib/ipc.ts";
import { isChatSound, minutesOfDay } from "../../../../src/lib/chat/notifySettings.ts";
import { invalidInput, notFound, onlineError, serviceCode, signedOut } from "../errors.ts";
import type { EventBus } from "../events.ts";
import { CHAT_UNAVAILABLE_CODE, segment, type Http } from "../http.ts";
import type { Frame as SocketFrame } from "../socket.ts";
import type { Storage } from "../storage.ts";
import { Book } from "./book.ts";
import { checkDraft, Drafts } from "./drafts.ts";
import { applyFrame, CHAT_EVENTS, parseFrame, type Effect } from "./frames.ts";
import { checkLink, CONFIRM_LINK } from "./links.ts";
import { compose, decide, incomingOf, isSilent, levelOf, NotifyPace, type NotifyTexts } from "./notify.ts";
import {
  classify,
  fromRecord,
  newClientId,
  newEntry,
  Outbox,
  toRecord,
  type OutboxRecord,
} from "./outbox.ts";
import { READ_DEBOUNCE_MS, ReadMarks } from "./reads.ts";
import { searchPath } from "./search.ts";
import { FIRST_SYNC_DELAY_MS, keepReads, OFFLINE_REFRESH_MS, STATE_DEBOUNCE_MS } from "./sync.ts";
import { TypingThrottle, typingFrame } from "./typing.ts";
import { NOT_VIEWING, sees, viewingOf, type Viewing } from "./viewing.ts";
import {
  readConversation,
  readMessage,
  readPrivacy,
  readRefusals,
  readSyncDoc,
  readUserIds,
} from "./wire.ts";

export { CHAT_EVENTS } from "./frames.ts";

/** The files of the chat: staging, upload and the cache. The files of the web app bring it. */
export interface ChatFiles {
  /** Registers and uploads one staged file for a conversation; answers its file id. */
  upload(conversationId: string, handle: string): Promise<string>;
  /** A message went out with these files, as `[handle, fileId]`. */
  settleSent(uploaded: Array<[string, string]>): void;
  /** The staged files of a message the player dropped. */
  drop(handles: string[]): void;
  /** The serializable part of the staged files, for the outbox row. */
  records?(handles: string[]): unknown[];
}

/** The page around the core: what it shows, and the two outputs besides events. */
export interface ChatPage {
  /** The tab is on screen. */
  visible(): boolean;
  /** The browser believes it is online. */
  online(): boolean;
  playSound(name: string, mentioned: boolean): void;
  /** A system notification shown by the page, for a device without push. */
  showNotification(title: string, options: { body: string; tag: string; url: string }): void;
}

export interface ChatClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ChatDeps {
  http: Http;
  events: EventBus;
  storage: Storage;
  /** The signed-in account's id, or `null`. */
  me(): string | null;
  signedIn(): boolean;
  /** The live socket is up. */
  live(): boolean;
  /** Sends a frame on the live socket; answers whether it went. */
  sendFrame(frame: SocketFrame): boolean;
  /** The chat switches of this device. */
  notifications(): ChatNotifications;
  /** This device has a push subscription: push is then its only system notification. */
  pushSubscribed(): boolean;
  /** The words of a notification, in the language on screen. */
  texts(): NotifyTexts;
  openExternal(url: string): Promise<void>;
  page: ChatPage;
  clock?: ChatClock;
  files?: ChatFiles;
  /** Cleans and completes the cards of a draft as the service reads them. */
  prepareCards?: (cards: ChatCard[]) => ChatCard[];
}

export interface ChatCore {
  /** The document of `chat_get_state` and `chat:state`. */
  view(): ChatStateView;
  /** Takes a `chat.*` frame; answers whether it was one. */
  handleFrame(frame: SocketFrame): boolean;
  /** The core started with an account, or an account signed in: restore the queue, sync soon. */
  start(): Promise<void>;
  /** The live socket opened: frames sent while it was down are not replayed. */
  connected(): void;
  /** The live socket went up or down. */
  setLive(live: boolean): void;
  /** The tab went into the background: write down what is pending. */
  hidden(): void;
  /** The tab is back with its socket up: catch up. */
  resumed(): void;
  /** The account is gone: forget everything of it. */
  forget(): void;
  /** Stops every timer: another tab took over. */
  stop(): void;
  /** Whether a message waits to go out: an update waits for it. */
  busy(): boolean;
  /** Nothing waits and nothing is on its way: no message, no read marker, no request. */
  idle(): boolean;
  /** Whether a sync document of this account arrived since it signed in. */
  synced(): boolean;
  subscribe(listener: () => void): () => void;
  // The commands, by the names of `lib/ipc.ts`.
  getMessages(args: Record<string, unknown>): Promise<ChatMessagePage>;
  openDirect(userId: string): Promise<Conversation>;
  send(conversationId: string, draft: Record<string, unknown>): Promise<string>;
  retry(clientId: string): Promise<void>;
  discard(clientId: string): Promise<void>;
  setViewing(args: Record<string, unknown>): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  typing(conversationId: string): Promise<void>;
  react(conversationId: string, seq: number, emoji: string, on: boolean): Promise<ChatReactionGroup[]>;
  createGroup(title: unknown, memberIds: unknown): Promise<unknown>;
  renameGroup(conversationId: string, title: string): Promise<Conversation>;
  setHistoryForNewMembers(conversationId: string, on: boolean): Promise<Conversation>;
  addMembers(conversationId: string, userIds: unknown): Promise<unknown>;
  removeMember(conversationId: string, userId: string): Promise<void>;
  leave(conversationId: string): Promise<void>;
  answerGroupInvite(conversationId: string, accept: boolean): Promise<Conversation | null>;
  setNotify(conversationId: string, notify: string): Promise<Conversation>;
  search(args: Record<string, unknown>): Promise<ChatSearchPage>;
  getPrivacy(): Promise<ChatPrivacy>;
  updatePrivacy(patch: unknown): Promise<ChatPrivacy>;
  getDraft(conversationId: string): Promise<string>;
  setDraft(conversationId: string, text: string): Promise<void>;
  openLink(url: string, confirmed: boolean): Promise<void>;
  previewSound(soundName: unknown, mention: unknown): Promise<void>;
  /** Takes a conversation another part of the core answered, such as a joined server chat. */
  keep(conversation: Conversation): void;
}

const browserClock: ChatClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** An id that can never climb out of its route: `path_segment` of the launcher. */
function id(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") throw invalidInput("an empty id");
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw invalidInput(`id ${JSON.stringify(trimmed)}`);
  return trimmed;
}

function page(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const at = (name: string) => {
    const value = query[name];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  };
  // `around` wins over `before`, and `before` over `after`; none of them is the newest page.
  const around = at("around");
  const before = at("before");
  const after = at("after");
  if (around !== null) params.set("around", String(around));
  else if (before !== null) params.set("before", String(before));
  else if (after !== null) params.set("after", String(after));
  const limit = at("limit");
  if (limit !== null) params.set("limit", String(Math.min(Math.max(limit, 1), 200)));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export function createChat(deps: ChatDeps): ChatCore {
  const { http, events, storage } = deps;
  const clock = deps.clock ?? browserClock;
  const book = new Book();
  const outbox = new Outbox();
  const reads = new ReadMarks();
  const drafts = new Drafts(storage);
  const typingThrottle = new TypingThrottle();
  const pace = new NotifyPace();
  const listeners = new Set<() => void>();

  let viewing: Viewing = NOT_VIEWING;
  let available = true;
  let syncedOnce = false;
  let syncedAt: number | null = null;
  /** Bumped when the account goes: an answer for the account before is dropped. */
  let generation = 0;
  let running = false;
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let stateTimer: unknown = null;
  let readTimer: unknown = null;
  let firstSyncTimer: unknown = null;
  let offlineTimer: unknown = null;
  const waits = new Set<unknown>();

  // -- The online clock: time the browser has been online, for giving up --
  let onlineBank = 0;
  let onlineSince: number | null = deps.page.online() ? clock.now() : null;
  const onlineClock = () => onlineBank + (onlineSince === null ? 0 : clock.now() - onlineSince);
  const onlineChanged = () => {
    const online = deps.page.online();
    if (online && onlineSince === null) onlineSince = clock.now();
    if (!online && onlineSince !== null) {
      onlineBank += clock.now() - onlineSince;
      onlineSince = null;
    }
    if (online) {
      outbox.flush();
      kick();
    }
  };

  // -- Small shared pieces ------------------------------------------------

  const tell = () => {
    for (const listener of [...listeners]) listener();
  };

  const emit = (event: string, payload: unknown) => events.emit(event, payload);

  const account = () => {
    if (!deps.signedIn()) throw signedOut();
  };

  const view = (): ChatStateView => {
    const [unreadTotal, mentionTotal] = book.totals();
    return {
      available,
      signedIn: deps.signedIn(),
      connected: deps.live(),
      conversations: book.conversations(),
      groupInvites: structuredClone(book.invites),
      privacy: book.privacy === null ? null : { ...book.privacy },
      quota: book.quota === null ? null : { ...book.quota },
      unreadTotal,
      mentionTotal,
      outbox: outbox.all(),
    };
  };

  const emitStateNow = () => {
    if (stateTimer !== null) clock.clearTimeout(stateTimer);
    stateTimer = null;
    emit(CHAT_EVENTS.state, view());
  };

  const scheduleState = () => {
    if (stateTimer !== null) return;
    stateTimer = clock.setTimeout(() => {
      stateTimer = null;
      emit(CHAT_EVENTS.state, view());
    }, STATE_DEBOUNCE_MS);
  };

  const emitOutbox = (conversationId: string) => {
    emit(CHAT_EVENTS.outbox, { conversationId, entries: outbox.entriesOf(conversationId) });
  };

  /** Passes the answer of a chat call through, noting whether the service has a chat API. */
  async function noted<T>(call: Promise<T>): Promise<T> {
    try {
      const answer = await call;
      if (!available) {
        available = true;
        scheduleState();
      }
      return answer;
    } catch (error) {
      if (serviceCode(error) === CHAT_UNAVAILABLE_CODE && available) {
        available = false;
        scheduleState();
      }
      throw error;
    }
  }

  let inFlight = 0;
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    inFlight += 1;
    try {
      return await noted(http.request<T>(method, path, body === undefined ? {} : { body }));
    } finally {
      inFlight -= 1;
    }
  };

  const keep = (conversation: Conversation) => {
    book.upsert(conversation);
    scheduleState();
  };

  const isViewed = (conversationId: string) => sees(viewing, conversationId, deps.page.visible());

  // -- The outbox in IndexedDB ------------------------------------------

  /** Rows written, by client id, and when each entry first went out. */
  const stored = new Set<string>();
  const firstTryAt = new Map<string, string>();
  let persistChain: Promise<void> = Promise.resolve();

  const persist = () => {
    const mine = generation;
    const rows = outbox.entries.map((entry) => {
      if (entry.firstTry !== null && !firstTryAt.has(entry.clientId)) {
        firstTryAt.set(entry.clientId, new Date(clock.now()).toISOString());
      }
      return toRecord(
        entry,
        onlineClock(),
        firstTryAt.get(entry.clientId) ?? null,
        deps.files?.records?.(entry.attachments) ?? [],
      );
    });
    persistChain = persistChain.then(async () => {
      if (mine !== generation) return;
      const alive = new Set(rows.map((row) => row.clientId));
      try {
        for (const row of rows) {
          if (mine !== generation) return;
          await storage.put("outbox", row.clientId, row);
          stored.add(row.clientId);
        }
        for (const clientId of [...stored]) {
          if (alive.has(clientId) || mine !== generation) continue;
          await storage.delete("outbox", clientId);
          stored.delete(clientId);
          firstTryAt.delete(clientId);
        }
      } catch (error) {
        console.warn("Writing the chat outbox failed", error);
      }
    });
  };

  // -- The outbox driver --------------------------------------------------

  const kick = () => {
    if (!running || !deps.signedIn()) return;
    const started = outbox.startReady(clock.now(), onlineClock());
    if (started.length === 0) return;
    persist();
    for (const clientId of started) {
      const entry = outbox.get(clientId);
      if (entry !== undefined) emitOutbox(entry.conversationId);
      void run(clientId).finally(kick);
    }
  };

  const wait = (ms: number, then: () => void) => {
    const handle = clock.setTimeout(() => {
      waits.delete(handle);
      then();
    }, ms);
    waits.add(handle);
  };

  async function attempt(clientId: string): Promise<{ message: ChatMessage; uploaded: Array<[string, string]> }> {
    account();
    const entry = outbox.get(clientId);
    if (entry === undefined) throw notFound(`queued message ${clientId}`);
    for (let index = 0; index < entry.attachments.length; index += 1) {
      if (entry.fileIds[index] !== null) continue;
      const handle = entry.attachments[index];
      if (deps.files === undefined) throw invalidInput(`the attachment ${handle} is no longer staged`);
      const fileId = await deps.files.upload(entry.conversationId, handle);
      outbox.setFileId(clientId, index, fileId);
    }
    const current = outbox.get(clientId) ?? entry;
    const uploaded: Array<[string, string]> = [];
    current.attachments.forEach((handle, index) => {
      const fileId = current.fileIds[index];
      if (fileId !== null) uploaded.push([handle, fileId]);
    });
    outbox.setStatus(clientId, "sending");
    emitOutbox(entry.conversationId);
    const body: Record<string, unknown> = { clientId: entry.clientId, body: entry.body };
    if (entry.cards.length > 0) body.cards = entry.cards;
    if (uploaded.length > 0) body.fileIds = uploaded.map(([, fileId]) => fileId);
    if (entry.replySeq !== null) body.replySeq = entry.replySeq;
    const answer = await request<unknown>("POST", `/v1/chat/conversations/${segment(entry.conversationId)}/messages`, body);
    return { message: readMessage(answer), uploaded };
  }

  async function run(clientId: string): Promise<void> {
    const mine = generation;
    let result: { message: ChatMessage; uploaded: Array<[string, string]> } | null = null;
    let failure: unknown = null;
    try {
      result = await attempt(clientId);
    } catch (error) {
      failure = error;
    }
    if (mine !== generation) return;

    if (result !== null) {
      const entry = outbox.take(clientId);
      deps.files?.settleSent(result.uploaded);
      // The frame of the message may be late or never come: the socket may
      // be down. The answer is the same message.
      const { message } = result;
      book.applyMessage(deps.me(), message, isViewed(message.conversationId));
      emit(CHAT_EVENTS.message, message);
      if (entry !== undefined) emitOutbox(entry.conversationId);
      scheduleState();
      persist();
      return;
    }

    const entry = outbox.get(clientId);
    if (entry === undefined) return;
    const kind = classify(failure);
    if (kind === "filesLost" && outbox.reregister(clientId)) {
      console.info(`chat: the files of ${clientId} are gone on the service, uploading again`);
    } else if (kind === "transient") {
      const retry = outbox.retryLater(clientId, failure, clock.now(), onlineClock());
      if (retry.kind === "after") wait(retry.wait, kick);
      else if (retry.kind === "gaveUp") console.warn(`chat: gave up sending ${clientId}`, failure);
    } else {
      console.warn(`chat: sending ${clientId} was refused`, failure);
      outbox.fail(clientId, failure);
    }
    emitOutbox(entry.conversationId);
    scheduleState();
    persist();
  }

  async function restoreOutbox(): Promise<void> {
    let rows: Array<{ key: string; value: OutboxRecord }> = [];
    try {
      rows = await storage.entries<OutboxRecord>("outbox");
    } catch (error) {
      console.warn("Reading the chat outbox failed", error);
      return;
    }
    rows.sort((a, b) => (a.value?.createdAt ?? "").localeCompare(b.value?.createdAt ?? "") || a.key.localeCompare(b.key));
    const conversations = new Set<string>();
    for (const { key, value } of rows) {
      stored.add(key);
      if (outbox.get(key) !== undefined) continue;
      const entry = fromRecord(value, onlineClock());
      if (entry === null) continue;
      if (typeof value.firstTryAt === "string") firstTryAt.set(entry.clientId, value.firstTryAt);
      outbox.push(entry);
      conversations.add(entry.conversationId);
    }
    for (const conversationId of conversations) emitOutbox(conversationId);
    if (conversations.size > 0) scheduleState();
  }

  // -- Sync ---------------------------------------------------------------

  async function syncOnce(): Promise<void> {
    if (!deps.signedIn()) return;
    const mine = generation;
    let raw: unknown;
    try {
      raw = await request<unknown>("GET", "/v1/chat/conversations");
    } catch (error) {
      if (serviceCode(error) === CHAT_UNAVAILABLE_CODE) console.info("chat: this JKNet Online service has no chat API");
      return;
    }
    if (mine !== generation) return;
    let doc;
    try {
      doc = readSyncDoc(raw);
    } catch (error) {
      console.warn("chat: the sync document does not read", error);
      return;
    }
    const reset = book.replace(doc);
    syncedAt = clock.now();
    if (reset.length > 0) console.warn(`chat: ${reset.length} conversation(s) went back in history, the service was restored`);
    for (const conversationId of reset) reads.remove(conversationId);
    const marks = reads.all();
    const waiting = reads.connectionBack();
    keepReads(book, deps.me(), marks);
    const first = !syncedOnce;
    syncedOnce = true;
    emitStateNow();
    emit(CHAT_EVENTS.resync, { reset });
    if (first) tell();
    outbox.flush();
    kick();
    if (waiting) void flushReads();
    // A conversation on screen whose messages came while the tab slept.
    if (viewing.conversationId !== null && isViewed(viewing.conversationId)) queueRead(viewing.conversationId);
  }

  /** Reads the sync document; a call while one is out asks for one more afterwards. */
  function resync(): Promise<void> {
    if (syncing !== null) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        await syncOnce();
      } while (syncAgain);
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  /** Fetches one conversation the book does not know, or cannot count. */
  async function refreshConversation(conversationId: string): Promise<void> {
    if (!deps.signedIn()) return;
    const mine = generation;
    try {
      const raw = await request<unknown>("GET", `/v1/chat/conversations/${segment(conversationId)}`);
      if (mine !== generation) return;
      keep(readConversation(raw));
    } catch (error) {
      if (mine !== generation) return;
      // Not a member any more, and the frame that said so was missed.
      if (serviceCode(error) === "not_found") dropConversation(conversationId, "removed");
    }
  }

  /** Drops a conversation the player left or lost, and tells the screens. */
  function dropConversation(conversationId: string, reason: string): void {
    const known = book.remove(conversationId);
    const queued = outbox.removeConversation(conversationId);
    drafts.remove(conversationId);
    reads.remove(conversationId);
    if (queued.length > 0) {
      deps.files?.drop(queued.flatMap((entry) => entry.attachments));
      emitOutbox(conversationId);
      persist();
    }
    if (known) {
      emit(CHAT_EVENTS.removed, { conversationId, reason });
      scheduleState();
    }
  }

  // -- Read markers -------------------------------------------------------

  function queueRead(conversationId: string): void {
    const seq = book.get(conversationId)?.lastSeq ?? 0;
    if (seq === 0 || !book.readLocally(deps.me(), conversationId, seq)) return;
    reads.queue(conversationId, seq);
    scheduleState();
    scheduleReads(READ_DEBOUNCE_MS);
  }

  function scheduleReads(ms: number): void {
    if (readTimer !== null) return;
    readTimer = clock.setTimeout(() => {
      readTimer = null;
      void flushReads();
    }, ms);
  }

  async function flushReads(): Promise<void> {
    if (readTimer !== null) clock.clearTimeout(readTimer);
    readTimer = null;
    if (!deps.signedIn()) return;
    const batch = reads.take();
    if (batch.length === 0) return;
    const mine = generation;
    let retry = false;
    for (const [conversationId, seq] of batch) {
      try {
        const answer = await request<{ readSeq?: unknown }>(
          "POST",
          `/v1/chat/conversations/${segment(conversationId)}/read`,
          { seq },
        );
        if (mine !== generation) return;
        reads.sent(conversationId, seq);
        const readSeq = typeof answer?.readSeq === "number" ? answer.readSeq : seq;
        if (book.readLocally(deps.me(), conversationId, readSeq)) scheduleState();
      } catch (error) {
        if (mine !== generation) return;
        if (classify(error) === "transient") {
          reads.failed(conversationId, seq);
          retry = true;
        } else {
          reads.refused(conversationId, seq);
        }
      }
    }
    if (!retry) return;
    const next = reads.retryAfter(onlineClock());
    if (next === null) console.warn("chat: read markers keep failing, they wait for the next sync");
    else scheduleReads(next);
  }

  // -- Notifications ------------------------------------------------------

  function incoming(message: ChatMessage): void {
    let settings: ChatNotifications;
    try {
      settings = deps.notifications();
    } catch {
      return;
    }
    const conversation = book.get(message.conversationId);
    const msg = incomingOf(message, deps.me());
    const visible = deps.page.visible();
    const decided = decide(
      msg,
      { notify: levelOf(conversation?.notify ?? "all"), viewed: isViewed(message.conversationId) },
      settings,
      { minuteOfDay: minutesOfDay(new Date(clock.now())), focused: visible },
    );
    if (isSilent(decided)) return;
    const delivery = pace.pace(message.conversationId, msg.mentioned, clock.now(), decided);
    const { title, text } = compose(message, conversation, settings.showText, deps.texts());
    if (delivery.inApp) {
      emit(CHAT_EVENTS.notify, { conversationId: message.conversationId, seq: message.seq, title, text, mention: msg.mentioned });
    }
    if (delivery.os && !deps.pushSubscribed()) {
      deps.page.showNotification(title, {
        body: text,
        tag: `c:${message.conversationId}`,
        url: `/c/${encodeURIComponent(message.conversationId)}`,
      });
    }
    // The sound plays whenever the app is open: a visible tab, a tab in the
    // background, a minimized browser. A push that reaches an open app comes
    // silent, so the player hears one chime, not two.
    if (delivery.sound) deps.page.playSound(settings.soundName, msg.mentioned);
  }

  // -- Frames -------------------------------------------------------------

  function runEffects(effects: Effect[]): void {
    const refreshing = new Set(effects.flatMap((effect) => (effect.kind === "refresh" ? [effect.conversationId] : [])));
    const afterRefresh: ChatMessage[] = [];
    let outboxMoved = false;
    for (const effect of effects) {
      switch (effect.kind) {
        case "emit":
          emit(effect.event, effect.payload);
          break;
        case "state":
          scheduleState();
          break;
        case "outbox":
          outboxMoved = true;
          emitOutbox(effect.conversationId);
          break;
        case "markRead":
          queueRead(effect.conversationId);
          break;
        case "resync":
          void resync();
          break;
        case "typingExpires": {
          const { conversationId, after } = effect;
          // A little past the hint, so the entry has expired by the time it is looked at.
          wait(after + 50, () =>
            emit(CHAT_EVENTS.typing, { conversationId, userIds: book.typingIn(conversationId, clock.now()) }),
          );
          break;
        }
        case "notify":
          // A message of a conversation the core does not know yet notifies
          // once the conversation is in: its name and level are what it needs.
          if (refreshing.has(effect.message.conversationId)) afterRefresh.push(effect.message);
          else incoming(effect.message);
          break;
        case "refresh": {
          const { conversationId } = effect;
          void refreshConversation(conversationId).then(() => {
            for (const message of afterRefresh.filter((entry) => entry.conversationId === conversationId)) incoming(message);
          });
          break;
        }
      }
    }
    if (outboxMoved) persist();
  }

  const frameState = {
    book,
    outbox,
    reads,
    dropDraft: (conversationId: string) => {
      drafts.remove(conversationId);
    },
    isViewed,
  };

  // -- Privacy ------------------------------------------------------------

  const takePrivacy = (privacy: ChatPrivacy) => {
    if (book.setPrivacy(privacy)) void resync();
    scheduleState();
  };

  const offlineCheck = () => {
    if (!running || !deps.signedIn() || deps.live()) return;
    if (syncedAt === null || clock.now() - syncedAt >= OFFLINE_REFRESH_MS) void resync();
  };

  const onlineListener = () => onlineChanged();

  return {
    view,
    keep,

    handleFrame(frame) {
      if (typeof frame.type !== "string" || !frame.type.startsWith("chat.")) return false;
      let parsed;
      try {
        parsed = parseFrame(frame.type, frame.payload ?? {});
      } catch (error) {
        console.debug(`unreadable ${frame.type}`, error);
        return true;
      }
      runEffects(applyFrame(frameState, deps.me(), parsed, clock.now()));
      return true;
    },

    async start() {
      if (!running) {
        running = true;
        if (typeof window !== "undefined") {
          window.addEventListener("online", onlineListener);
          window.addEventListener("offline", onlineListener);
        }
        offlineTimer = clock.setInterval(offlineCheck, OFFLINE_REFRESH_MS);
      }
      if (!deps.signedIn()) return;
      await drafts.load();
      await restoreOutbox();
      kick();
      if (firstSyncTimer !== null) clock.clearTimeout(firstSyncTimer);
      firstSyncTimer = clock.setTimeout(() => {
        firstSyncTimer = null;
        if (!syncedOnce) void resync();
      }, FIRST_SYNC_DELAY_MS);
    },

    connected() {
      void resync();
    },

    setLive() {
      scheduleState();
    },

    hidden() {
      void flushReads();
      void drafts.flush();
    },

    resumed() {
      if (!deps.signedIn()) return;
      void resync();
    },

    forget() {
      generation += 1;
      const known = book.clear();
      outbox.clear();
      drafts.clear();
      reads.clear();
      typingThrottle.clear();
      pace.clear();
      stored.clear();
      firstTryAt.clear();
      viewing = NOT_VIEWING;
      available = true;
      syncedAt = null;
      syncedOnce = false;
      for (const handle of waits) clock.clearTimeout(handle);
      waits.clear();
      if (readTimer !== null) clock.clearTimeout(readTimer);
      readTimer = null;
      if (firstSyncTimer !== null) clock.clearTimeout(firstSyncTimer);
      firstSyncTimer = null;
      emitStateNow();
      if (known.length > 0) emit(CHAT_EVENTS.resync, { reset: known });
      tell();
    },

    stop() {
      running = false;
      void drafts.flush();
      for (const handle of waits) clock.clearTimeout(handle);
      waits.clear();
      for (const handle of [stateTimer, readTimer, firstSyncTimer]) if (handle !== null) clock.clearTimeout(handle);
      stateTimer = readTimer = firstSyncTimer = null;
      if (offlineTimer !== null) clock.clearInterval(offlineTimer);
      offlineTimer = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onlineListener);
        window.removeEventListener("offline", onlineListener);
      }
    },

    busy: () => outbox.busy(),
    idle: () =>
      inFlight === 0 && readTimer === null && reads.waiting.size === 0 && reads.sending.size === 0 && !outbox.busy(),
    synced: () => syncedOnce,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // -- Commands ---------------------------------------------------------

    async getMessages(args) {
      account();
      const conversationId = id(args.conversationId);
      const raw = await request<{ messages?: unknown; hasBefore?: unknown; hasAfter?: unknown }>(
        "GET",
        `/v1/chat/conversations/${segment(conversationId)}/messages${page(args)}`,
      );
      return {
        messages: Array.isArray(raw?.messages) ? raw.messages.map(readMessage) : [],
        hasBefore: raw?.hasBefore === true,
        hasAfter: raw?.hasAfter === true,
      };
    },

    async openDirect(userId) {
      account();
      const conversation = readConversation(await request<unknown>("PUT", `/v1/chat/direct/${segment(id(userId))}`));
      keep(conversation);
      return conversation;
    },

    async send(conversationId, raw) {
      account();
      const target = id(conversationId);
      const draft = checkDraft(raw ?? {}, deps.prepareCards);
      const clientId = newClientId(clock.now());
      outbox.push(newEntry(clientId, target, draft, new Date(clock.now()).toISOString()));
      // The text is on its way, so the draft of the conversation is spent.
      if (drafts.remove(target)) emit(CHAT_EVENTS.draft, { conversationId: target, text: "" });
      emitOutbox(target);
      scheduleState();
      persist();
      kick();
      return clientId;
    },

    async retry(clientId) {
      const conversationId = outbox.retry(clientId);
      if (conversationId === null) throw notFound(`queued message ${clientId}`);
      emitOutbox(conversationId);
      scheduleState();
      persist();
      kick();
    },

    async discard(clientId) {
      const entry = outbox.take(clientId);
      if (entry === undefined) return;
      deps.files?.drop(entry.attachments);
      emitOutbox(entry.conversationId);
      scheduleState();
      persist();
    },

    async setViewing(args) {
      viewing = viewingOf(args);
      if (viewing.conversationId !== null && isViewed(viewing.conversationId)) queueRead(viewing.conversationId);
    },

    async markRead(conversationId) {
      queueRead(conversationId);
    },

    async typing(conversationId) {
      const target = id(conversationId);
      if (!book.mayType(target)) return;
      if (!typingThrottle.take(target, clock.now())) return;
      deps.sendFrame(typingFrame(target));
    },

    async react(conversationId, seq, emoji, on) {
      account();
      const target = id(conversationId);
      const answer = await request<{ reactions?: unknown }>(
        "PUT",
        `/v1/chat/conversations/${segment(target)}/reactions`,
        { seq, emoji, on },
      );
      const reactions: ChatReactionGroup[] = Array.isArray(answer?.reactions)
        ? (answer.reactions as ChatReactionGroup[]).map((group) => ({ emoji: group.emoji, userIds: [...(group.userIds ?? [])] }))
        : [];
      book.setReactions(target, seq, reactions);
      scheduleState();
      return reactions;
    },

    async createGroup(title, memberIds) {
      account();
      const name = typeof title === "string" ? title.trim() : "";
      const body: Record<string, unknown> = {
        clientId: newClientId(clock.now()),
        memberIds: Array.isArray(memberIds) ? memberIds.filter((item) => typeof item === "string") : [],
      };
      if (name !== "") body.title = name;
      const raw = await request<{ conversation?: unknown; added?: unknown; invited?: unknown; refused?: unknown }>(
        "POST",
        "/v1/chat/groups",
        body,
      );
      const conversation = readConversation(raw?.conversation);
      keep(conversation);
      return { conversation, added: readUserIds(raw?.added), invited: readUserIds(raw?.invited), refused: readRefusals(raw?.refused) };
    },

    async renameGroup(conversationId, title) {
      account();
      const conversation = readConversation(
        await request<unknown>("PATCH", `/v1/chat/groups/${segment(id(conversationId))}`, { title: title.trim() }),
      );
      keep(conversation);
      return conversation;
    },

    async setHistoryForNewMembers(conversationId, on) {
      account();
      const target = id(conversationId);
      const summary =
        book.get(target) ?? readConversation(await request<unknown>("GET", `/v1/chat/conversations/${segment(target)}`));
      let raw: unknown;
      if (summary.kind === "group") {
        raw = await request<unknown>("PATCH", `/v1/chat/groups/${segment(target)}`, { historyForNewMembers: on });
      } else if (summary.kind === "server" && summary.server !== null) {
        const me = deps.me();
        if (me !== null && me !== summary.server.hostId) {
          throw onlineError("owner_only", "only the host changes the chat of the server", 403);
        }
        raw = await request<unknown>("PATCH", `/v1/chat/servers/${segment(summary.server.sessionId)}`, { historyForNewMembers: on });
      } else {
        throw invalidInput("only a group or a server chat has a history setting");
      }
      const conversation = readConversation(raw);
      keep(conversation);
      return conversation;
    },

    async addMembers(conversationId, userIds) {
      account();
      const raw = await request<{ added?: unknown; invited?: unknown; refused?: unknown }>(
        "POST",
        `/v1/chat/groups/${segment(id(conversationId))}/members`,
        { userIds: Array.isArray(userIds) ? userIds.filter((item) => typeof item === "string") : [] },
      );
      return { added: readUserIds(raw?.added), invited: readUserIds(raw?.invited), refused: readRefusals(raw?.refused) };
    },

    async removeMember(conversationId, userId) {
      account();
      await request("DELETE", `/v1/chat/conversations/${segment(id(conversationId))}/members/${segment(id(userId))}`);
    },

    async leave(conversationId) {
      account();
      const me = deps.me();
      if (me === null) throw signedOut();
      const target = id(conversationId);
      await request("DELETE", `/v1/chat/conversations/${segment(target)}/members/${segment(me)}`);
      dropConversation(target, "left");
    },

    async answerGroupInvite(conversationId, accept) {
      account();
      const target = id(conversationId);
      let answer: Conversation | null = null;
      if (accept) {
        answer = readConversation(await request<unknown>("POST", `/v1/chat/groups/${segment(target)}/join`));
        keep(answer);
      } else {
        const me = deps.me();
        if (me === null) throw signedOut();
        await request("DELETE", `/v1/chat/groups/${segment(target)}/invites/${segment(me)}`);
      }
      if (book.removeInvite(target)) scheduleState();
      return answer;
    },

    async setNotify(conversationId, notify) {
      account();
      if (notify !== "all" && notify !== "mentions" && notify !== "mute") {
        throw invalidInput(`notify is all, mentions or mute, not ${JSON.stringify(notify)}`);
      }
      const conversation = readConversation(
        await request<unknown>("PUT", `/v1/chat/conversations/${segment(id(conversationId))}/notify`, { notify }),
      );
      keep(conversation);
      return conversation;
    },

    async search(args) {
      account();
      const raw = await request<{ results?: unknown; nextCursor?: unknown }>("GET", searchPath(args));
      const results = Array.isArray(raw?.results)
        ? raw.results.map((hit) => ({ message: readMessage((hit as { message?: unknown })?.message) }))
        : [];
      return { results, nextCursor: typeof raw?.nextCursor === "string" ? raw.nextCursor : null };
    },

    async getPrivacy() {
      account();
      const privacy = readPrivacy(await request<unknown>("GET", "/v1/chat/settings"));
      takePrivacy(privacy);
      return privacy;
    },

    async updatePrivacy(patch) {
      account();
      const raw = patch !== null && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
      const body: Record<string, unknown> = {};
      if (typeof raw.shareReadReceipts === "boolean") body.shareReadReceipts = raw.shareReadReceipts;
      if (typeof raw.shareTyping === "boolean") body.shareTyping = raw.shareTyping;
      if (raw.groupAdd !== undefined && raw.groupAdd !== null) {
        if (raw.groupAdd !== "friends" && raw.groupAdd !== "ask") {
          throw invalidInput(`groupAdd is friends or ask, not ${JSON.stringify(raw.groupAdd)}`);
        }
        body.groupAdd = raw.groupAdd;
      }
      const privacy = readPrivacy(await request<unknown>("PATCH", "/v1/chat/settings", body));
      takePrivacy(privacy);
      return privacy;
    },

    async getDraft(conversationId) {
      return drafts.get(conversationId);
    },

    async setDraft(conversationId, text) {
      const target = id(conversationId);
      if (drafts.set(target, text)) emit(CHAT_EVENTS.draft, { conversationId: target, text });
    },

    async openLink(url, confirmed) {
      const link = checkLink(url);
      if (link === null) throw invalidInput("a link opens only as an http or https address with a host and no spaces");
      if (!link.trusted && !confirmed) throw onlineError(CONFIRM_LINK, link.host);
      await deps.openExternal(link.url);
    },

    async previewSound(soundName, mention) {
      if (!isChatSound(soundName)) throw invalidInput(`${JSON.stringify(soundName)} is not a chat sound`);
      deps.page.playSound(soundName, mention === true);
    },
  };
}
