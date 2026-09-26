/**
 * The chat commands against `scripts/mock-online.mjs`, from a plain browser.
 *
 * --- slice: chat ---
 *
 * `npm run dev` opens the frontend outside Tauri, where every command rejects.
 * This module stands in for the chat commands the way `devOnline.ts` does for
 * the friends: it calls the chat routes of the mock service over `fetch` and
 * answers in the shapes of `ipc.ts`, so the chat surface can be reviewed
 * without building the core.
 *
 * It is development scaffolding, not a feature:
 *
 * - `callChat` reaches it only when `isTauri()` is false **and**
 *   `import.meta.env.DEV` is true; the second is a compile-time constant, so
 *   the module leaves the production bundle.
 * - It plays the core's part in a small way. The outbox is a list in memory,
 *   sends go straight to the service, and the core's events come from a local
 *   bus (`devListen`). A browser cannot open the live socket with the chat
 *   header, so instead of `chat.*` frames the state is read again every few
 *   seconds and a thread that moved asks for what it missed.
 * - Files, the clipboard, links and the windows need the launcher: those
 *   commands refuse, like `join_friend` does in `devOnline.ts`.
 *
 * Start the mock first: `node scripts/mock-online.mjs`.
 */

import type {
  ChatDraft,
  ChatGroupInvite,
  ChatMessage,
  ChatMessagePage,
  ChatOutboxEntry,
  ChatPrivacy,
  ChatQuota,
  ChatReactionGroup,
  ChatStateView,
  Conversation,
  OnlineUser,
} from "./ipc";
import { unreadTotals } from "./chat/unread";

/** Where the stand-in listens; `?online=` points elsewhere, as in `devOnline.ts`. */
const ONLINE =
  new URLSearchParams(window.location.search).get("online") ?? "http://127.0.0.1:8787";

/** How often the state is read again: the stand-in for the live socket. */
const POLL_MS = 4_000;

// ---------------------------------------------------------------------------
// The bus that stands in for the core's events
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void;
const bus = new Map<string, Set<Handler>>();

/** Subscribes to one of the `chat:*` events this module emits. */
export function devListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const set = bus.get(event) ?? new Set<Handler>();
  bus.set(event, set);
  const wrapped = handler as Handler;
  set.add(wrapped);
  ensurePolling();
  return Promise.resolve(() => {
    set.delete(wrapped);
  });
}

function emit(event: string, payload: unknown): void {
  for (const handler of bus.get(event) ?? []) handler(payload);
}

// ---------------------------------------------------------------------------
// The mock service
// ---------------------------------------------------------------------------

/** The dev session of the mock, fetched once: its token and who it signs in as. */
let session: Promise<{ token: string; user: OnlineUser }> | null = null;

function dev(): Promise<{ token: string; user: OnlineUser }> {
  session ??= fetch(`${ONLINE}/v1/dev/token`, { method: "POST" })
    .then((response) => response.json() as Promise<{ token: string; user: OnlineUser }>)
    .then((answer) => {
      if (typeof answer.token !== "string" || answer.token === "") {
        throw new Error("the service has no dev token endpoint");
      }
      return answer;
    })
    .catch((e: unknown) => {
      session = null;
      throw e instanceof Error ? e : new Error(String(e));
    });
  return session;
}

/** My account id, for the hooks that tell my messages apart. */
export async function devMe(): Promise<string | null> {
  return (await dev()).user.id;
}

/** A refusal of the mock, with the contract's code where it sent one. */
class DevError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly reason: string | null,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { token } = await dev();
  const response = await fetch(`${ONLINE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    const detail = parsed as {
      error?: { code?: string; message?: string; details?: { reason?: string } };
    } | null;
    throw new DevError(
      detail?.error?.message ?? `the mock service answered ${response.status}`,
      response.status,
      detail?.error?.code ?? null,
      detail?.error?.details?.reason ?? null,
    );
  }
  return parsed as T;
}

/** The mock predates the chat routes: its catch-all answers this. */
function isMissingRoute(error: unknown): boolean {
  return error instanceof DevError && error.status === 404 && /No such endpoint/i.test(error.message);
}

// ---------------------------------------------------------------------------
// The part of the core this module plays
// ---------------------------------------------------------------------------

interface SyncDoc {
  conversations: Conversation[];
  groupInvites: ChatGroupInvite[];
  settings: ChatPrivacy;
  quota: ChatQuota;
}

let outbox: ChatOutboxEntry[] = [];
const drafts = new Map<string, string>();
/** The last `lastSeq` of each conversation, to tell which thread moved. */
const seen = new Map<string, number>();
let polling: ReturnType<typeof setInterval> | null = null;
let viewing: { conversationId: string | null; focused: boolean; atBottom: boolean } = {
  conversationId: null,
  focused: false,
  atBottom: false,
};

async function readState(): Promise<ChatStateView> {
  let doc: SyncDoc;
  try {
    doc = await call<SyncDoc>("GET", "/v1/chat/conversations");
  } catch (e) {
    if (!isMissingRoute(e)) throw e;
    return {
      available: false,
      signedIn: true,
      connected: false,
      conversations: [],
      groupInvites: [],
      privacy: null,
      quota: null,
      unreadTotal: 0,
      mentionTotal: 0,
      outbox,
    };
  }
  const totals = unreadTotals(doc.conversations);
  return {
    available: true,
    signedIn: true,
    // There is no live socket here, only the poll below.
    connected: true,
    conversations: doc.conversations,
    groupInvites: doc.groupInvites,
    privacy: doc.settings,
    quota: doc.quota,
    unreadTotal: totals.unread,
    mentionTotal: totals.mentions,
    outbox,
  };
}

/** Reads the state again, publishes it, and sends every thread that moved after what it missed. */
async function refresh(): Promise<ChatStateView> {
  const state = await readState();
  const moved: string[] = [];
  for (const conversation of state.conversations) {
    const before = seen.get(conversation.id);
    if (before !== undefined && conversation.lastSeq > before) moved.push(conversation.id);
    seen.set(conversation.id, conversation.lastSeq);
  }
  emit("chat:state", state);
  if (moved.length > 0) emit("chat:resync", { reset: [] });
  void markViewedRead(state);
  return state;
}

function ensurePolling(): void {
  if (polling !== null) return;
  polling = setInterval(() => {
    refresh().catch(() => undefined);
  }, POLL_MS);
}

/** What the core does with `chat_set_viewing`: a thread at the bottom of a focused window is read. */
async function markViewedRead(state?: ChatStateView): Promise<void> {
  const id = viewing.conversationId;
  if (id === null || !viewing.focused || !viewing.atBottom) return;
  const conversation = (state ?? (await readState())).conversations.find((c) => c.id === id);
  if (conversation === undefined || conversation.readSeq >= conversation.lastSeq) return;
  await call("POST", `/v1/chat/conversations/${id}/read`, { seq: conversation.lastSeq });
  emit("chat:read", { conversationId: id, userId: await devMe(), seq: conversation.lastSeq });
}

/** A client id of the same shape as the core's: time first, then randomness. */
function clientId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now();
  let head = "";
  for (let i = 0; i < 10; i += 1) {
    head = alphabet[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return head + Array.from(bytes, (byte) => alphabet[byte % 32]).join("");
}

function emitOutbox(conversationId: string): void {
  emit("chat:outbox", {
    conversationId,
    entries: outbox.filter((entry) => entry.conversationId === conversationId),
  });
}

/** Sends one outbox entry, as the core's outbox would. */
async function deliver(entry: ChatOutboxEntry): Promise<void> {
  entry.status = "sending";
  entry.error = null;
  emitOutbox(entry.conversationId);
  try {
    const message = await call<ChatMessage>(
      "POST",
      `/v1/chat/conversations/${entry.conversationId}/messages`,
      {
        clientId: entry.clientId,
        body: entry.body,
        cards: entry.cards,
        fileIds: [],
        replySeq: entry.replySeq,
      },
    );
    outbox = outbox.filter((other) => other.clientId !== entry.clientId);
    emitOutbox(entry.conversationId);
    emit("chat:message", message);
  } catch (e) {
    entry.status = "failed";
    entry.error = e instanceof DevError ? (e.reason ?? e.code ?? e.message) : String(e);
    emitOutbox(entry.conversationId);
  }
}

function needsLauncher(command: string): never {
  throw new Error(`${command} needs the launcher; a browser cannot run it`);
}

/** Runs one chat command against the mock service. */
export async function devChat<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const id = String(args.conversationId ?? "");
  switch (command) {
    case "chat_get_state":
      return (await refresh()) as T;
    case "chat_get_messages": {
      const search = new URLSearchParams();
      for (const key of ["before", "after", "around", "limit"]) {
        const value = args[key];
        if (typeof value === "number") search.set(key, String(value));
      }
      const query = search.toString();
      return (await call<ChatMessagePage>(
        "GET",
        `/v1/chat/conversations/${id}/messages${query === "" ? "" : `?${query}`}`,
      )) as T;
    }
    case "chat_open_direct":
      return (await call<Conversation>("PUT", `/v1/chat/direct/${String(args.userId)}`)) as T;
    case "chat_send": {
      const draft = args.draft as ChatDraft;
      if (draft.attachments.length > 0) needsLauncher("sending files");
      const entry: ChatOutboxEntry = {
        clientId: clientId(),
        conversationId: id,
        body: draft.body,
        cards: draft.cards,
        attachments: [],
        replySeq: draft.replySeq ?? null,
        status: "queued",
        error: null,
        createdAt: new Date().toISOString(),
      };
      outbox = [...outbox, entry];
      emitOutbox(id);
      void deliver(entry);
      return entry.clientId as T;
    }
    case "chat_retry": {
      const entry = outbox.find((other) => other.clientId === args.clientId);
      if (entry) void deliver(entry);
      return undefined as T;
    }
    case "chat_discard": {
      const entry = outbox.find((other) => other.clientId === args.clientId);
      outbox = outbox.filter((other) => other.clientId !== args.clientId);
      if (entry) emitOutbox(entry.conversationId);
      return undefined as T;
    }
    case "chat_set_viewing":
      viewing = {
        conversationId: (args.conversationId as string | null) ?? null,
        focused: Boolean(args.focused),
        atBottom: Boolean(args.atBottom),
      };
      void markViewedRead().catch(() => undefined);
      return undefined as T;
    case "chat_mark_read": {
      const state = await readState();
      const conversation = state.conversations.find((c) => c.id === id);
      if (conversation) {
        await call("POST", `/v1/chat/conversations/${id}/read`, { seq: conversation.lastSeq });
      }
      return undefined as T;
    }
    case "chat_typing":
      // The typing frame goes over the live socket, which a browser does not have.
      return undefined as T;
    case "chat_react": {
      const answer = await call<{ seq: number; reactions: ChatReactionGroup[] }>(
        "PUT",
        `/v1/chat/conversations/${id}/reactions`,
        { seq: args.seq, emoji: args.emoji, on: args.on },
      );
      return answer.reactions as T;
    }
    case "chat_create_group":
      return (await call("POST", "/v1/chat/groups", {
        clientId: clientId(),
        title: args.title,
        memberIds: args.memberIds,
      })) as T;
    case "chat_rename_group":
      return (await call("PATCH", `/v1/chat/groups/${id}`, { title: args.title })) as T;
    case "chat_set_history_for_new_members": {
      const state = await readState();
      const conversation = state.conversations.find((c) => c.id === id);
      if (conversation?.kind === "server" && conversation.server) {
        return (await call("PATCH", `/v1/chat/servers/${conversation.server.sessionId}`, {
          historyForNewMembers: args.on,
        })) as T;
      }
      return (await call("PATCH", `/v1/chat/groups/${id}`, { historyForNewMembers: args.on })) as T;
    }
    case "chat_add_members":
      return (await call("POST", `/v1/chat/groups/${id}/members`, { userIds: args.userIds })) as T;
    case "chat_remove_member":
      await call("DELETE", `/v1/chat/conversations/${id}/members/${String(args.userId)}`);
      return undefined as T;
    case "chat_leave":
      await call("DELETE", `/v1/chat/conversations/${id}/members/${await devMe()}`);
      return undefined as T;
    case "chat_answer_group_invite":
      if (args.accept) return (await call<Conversation>("POST", `/v1/chat/groups/${id}/join`)) as T;
      await call("DELETE", `/v1/chat/groups/${id}/invites/${await devMe()}`);
      return null as T;
    case "chat_set_notify":
      return (await call("PUT", `/v1/chat/conversations/${id}/notify`, { notify: args.notify })) as T;
    case "chat_search": {
      const search = new URLSearchParams({ q: String(args.q ?? "") });
      for (const key of ["conversationId", "senderId", "has"]) {
        const value = args[key];
        if (typeof value === "string" && value !== "") search.set(key, value);
      }
      if (typeof args.cursor === "string") search.set("before", args.cursor);
      return (await call("GET", `/v1/chat/search?${search.toString()}`)) as T;
    }
    case "chat_get_privacy":
      return (await call("GET", "/v1/chat/settings")) as T;
    case "chat_update_privacy":
      return (await call("PATCH", "/v1/chat/settings", args.patch)) as T;
    case "chat_get_draft":
      return (drafts.get(id) ?? "") as T;
    case "chat_set_draft":
      drafts.set(id, String(args.text ?? ""));
      emit("chat:draft", { conversationId: id, text: String(args.text ?? "") });
      return undefined as T;
    case "chat_file_local":
      // The bytes need the token, which only the core puts on a request.
      return { status: "remote", path: null } as T;
    case "chat_scan_commands":
      return [] as T;
    case "set_tray_labels":
    case "chat_window_set_compact":
      return undefined as T;
    default:
      // The files, the clipboard, links, the chat window and the host card:
      // each of them needs something only the launcher has.
      return needsLauncher(command);
  }
}
