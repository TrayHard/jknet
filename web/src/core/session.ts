/**
 * The account of this browser: signing in, the token, signing out.
 *
 * Signing in is the launcher's login session with three differences. The
 * session names the web client, its device kind and `returnTo`, the address
 * of `/signin/done` the service's success page leads back to. The tab itself
 * goes to the provider (`location.assign`), so what to do after the sign-in —
 * the path the player was opening, `next` — waits in IndexedDB. And polling
 * runs from any start of the app that finds a fresh pending sign-in, so a
 * provider that finished in another tab or in the Discord app still hands
 * over the token.
 *
 * The token is kept in IndexedDB and in memory and leaves only in the
 * `Authorization` header. Signing out, a `401` on any call and the socket's
 * close code 4401 all end in `wipe`: the database, the file cache, the shown
 * notifications and the push subscription go with the account.
 */

import { CoreError, onlineError, statusOf } from "./errors.ts";
import { EVENTS, type EventBus } from "./events.ts";
import type { Http } from "./http.ts";
import { segment } from "./http.ts";
import type { Storage } from "./storage.ts";
import type {
  AccountChangeReason,
  AccountChanged,
  AccountState,
  OnlineProvider,
  OnlineUser,
  SignInPoll,
  SignInStart,
} from "../../../src/lib/ipc.ts";

/** What the `session` store keeps. */
export interface SessionRecord {
  token: string;
  userId: string;
  /** The service the token belongs to; a record of another service is dropped. */
  apiBase: string;
  createdAt: string;
  /** The account as last read, so the first frame paints a name. */
  user?: OnlineUser | null;
  admin?: boolean;
}

/** What the `pendingSignIn` store keeps while the provider's pages are open. */
export interface PendingSignIn {
  sessionId: string;
  provider: string;
  /** The path to open after the sign-in; always passed through `safeNext`. */
  next: string | null;
  createdAt: string;
}

/** A pending sign-in older than this is forgotten: the service expires it too. */
export const PENDING_TTL_MS = 10 * 60_000;
/** How often a pending sign-in is read. */
export const POLL_EVERY_MS = 2_000;
/** Where the app goes after a sign-in without `next`. */
export const DEFAULT_NEXT = "/chats";

/**
 * A `next` that stays inside the app, or `null`.
 *
 * Only a path: one leading `/`, not `//` or `/\` (both read as another host),
 * no scheme, no control characters. Anything else would let a link send a
 * freshly signed-in player to another site.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.length > 2048) return null;
  // `/signin` would loop straight back to the sign-in screen.
  if (raw === "/signin" || raw.startsWith("/signin?") || raw.startsWith("/signin/")) return null;
  return raw;
}

/** Whether a pending sign-in is young enough to poll. */
export function isFresh(pending: PendingSignIn | undefined, now: number): pending is PendingSignIn {
  if (pending === undefined) return false;
  const at = Date.parse(pending.createdAt);
  return !Number.isNaN(at) && now - at >= 0 && now - at < PENDING_TTL_MS;
}

/** Whether the service runs on this machine: the Developer sign-in shows then. */
export function isLocalService(apiBase: string): boolean {
  try {
    const host = new URL(apiBase).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export type SignInPhase = "idle" | "waiting" | "done" | "expired" | "error";

/** Where the sign-in of this tab stands, for `/signin` and `/signin/done`. */
export interface SignInStatus {
  phase: SignInPhase;
  /** Where to go once `done`. */
  next: string | null;
  /** The service's own words on `error`. */
  error: string | null;
}

interface LoginSessionWire {
  id: string;
  provider: string;
  url: string;
  status: "pending" | "done" | "error" | "expired";
  token?: string;
  user?: OnlineUser;
  error?: string;
}

interface MeWire {
  user: OnlineUser;
  admin?: boolean;
}

export interface SessionDeps {
  http: Http;
  storage: Storage;
  events: EventBus;
  apiBase: string;
  /** `https://online.jknet.app`: `returnTo` is `/signin/done` on it. */
  origin: string;
  device: { kind(): "phone" | "desktop"; name(): string };
  /** Everything else sign-out clears: socket, caches, notifications, push, other tabs. */
  wipe(reason: AccountChangeReason): Promise<void>;
  /** A token arrived: the socket and the friends start. */
  signedIn(): void;
  now?: () => number;
}

export interface Session {
  load(): Promise<void>;
  token(): string | null;
  user(): OnlineUser | null;
  signedIn(): boolean;
  accountState(): AccountState;
  beginSignIn(provider: OnlineProvider, next: string | null): Promise<SignInStart>;
  poll(sessionId: string): Promise<SignInPoll>;
  /** Starts polling when a fresh pending sign-in is stored. */
  watchPending(): Promise<void>;
  status(): SignInStatus;
  subscribe(listener: () => void): () => void;
  /** Forgets a finished sign-in's status once its screen navigated. */
  settle(): void;
  /** Gives up on a pending sign-in: **Try again** starts over. */
  cancel(): Promise<void>;
  signOut(): Promise<void>;
  /** The token was refused: a `401` or the socket's 4401. */
  expire(): Promise<void>;
  refreshMe(): Promise<void>;
  updateDisplayName(displayName: string): Promise<OnlineUser>;
  deleteAccount(): Promise<void>;
  setUser(user: OnlineUser): void;
  stop(): void;
}

export function createSession(deps: SessionDeps): Session {
  const { http, storage, events, apiBase } = deps;
  const now = deps.now ?? (() => Date.now());
  let record: SessionRecord | null = null;
  let status: SignInStatus = { phase: "idle", next: null, error: null };
  const listeners = new Set<() => void>();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let wiping: Promise<void> | null = null;
  let detachWake: (() => void) | null = null;

  const setStatus = (next: SignInStatus) => {
    status = next;
    for (const listener of [...listeners]) listener();
  };

  const emit = (payload: AccountChanged) => events.emit(EVENTS.accountChanged, payload);

  const save = async () => {
    if (record === null) await storage.delete("session", "current");
    else await storage.put("session", "current", record);
  };

  const stopPolling = () => {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    detachWake?.();
    detachWake = null;
  };

  /** Stores the token of a finished sign-in. */
  const adopt = async (token: string, user: OnlineUser | undefined) => {
    record = {
      token,
      userId: user?.id ?? "",
      apiBase,
      createdAt: new Date(now()).toISOString(),
      user: user ?? null,
    };
    await save();
    await storage.delete("pendingSignIn", "current");
    // Not awaited: Firefox asks the player and leaves the promise pending
    // until they answer, and the sign-in must not wait for that. A refusal
    // changes nothing today; the browser only evicts the data under pressure.
    try {
      void navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      // A browser without the Storage API.
    }
    deps.signedIn();
    emit({ signedIn: true, reason: "signedIn" });
    void refreshMe().catch(() => undefined);
  };

  const readSession = (sessionId: string) =>
    http.request<LoginSessionWire>("GET", `/v1/auth/login-sessions/${segment(sessionId)}`, { auth: false });

  const poll = async (sessionId: string): Promise<SignInPoll> => {
    const answer = await readSession(sessionId);
    if (answer.status === "done" && answer.token !== undefined) {
      await adopt(answer.token, answer.user);
      return { status: "done", user: answer.user ?? null, error: null };
    }
    if (answer.status === "done") {
      // The token went to another poll of this session: another tab of this
      // browser, which signed in already or will in a moment.
      return { status: "error", user: null, error: answer.error ?? null };
    }
    return { status: answer.status, user: null, error: answer.error ?? null };
  };

  /** One read of the pending sign-in, then the next one in two seconds. */
  const tick = async () => {
    if (polling) return;
    const pending = await storage.get<PendingSignIn>("pendingSignIn", "current");
    if (!isFresh(pending, now())) {
      stopPolling();
      await storage.delete("pendingSignIn", "current");
      if (status.phase === "waiting") setStatus({ phase: "expired", next: status.next, error: null });
      return;
    }
    polling = true;
    try {
      const answer = await poll(pending.sessionId);
      if (answer.status === "pending") {
        schedule();
        return;
      }
      stopPolling();
      if (answer.status === "done") {
        setStatus({ phase: "done", next: pending.next, error: null });
        return;
      }
      await storage.delete("pendingSignIn", "current");
      setStatus({
        phase: answer.status === "expired" ? "expired" : "error",
        next: pending.next,
        error: answer.error,
      });
    } catch (error) {
      const code = statusOf(error);
      if (code === 404 || code === 400) {
        stopPolling();
        await storage.delete("pendingSignIn", "current");
        setStatus({ phase: "error", next: pending.next, error: null });
        return;
      }
      // Offline or the service restarting: the session waits on the service
      // for ten minutes, so the poll keeps going until then.
      schedule();
    } finally {
      polling = false;
    }
  };

  const schedule = () => {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void tick();
    }, POLL_EVERY_MS);
  };

  const watchPending = async () => {
    if (record !== null) return;
    const pending = await storage.get<PendingSignIn>("pendingSignIn", "current");
    if (!isFresh(pending, now())) {
      if (pending !== undefined) await storage.delete("pendingSignIn", "current");
      return;
    }
    setStatus({ phase: "waiting", next: pending.next, error: null });
    if (detachWake === null && typeof window !== "undefined") {
      // Coming back from the provider's tab or app is the moment the answer
      // is most likely there.
      const wake = () => {
        if (document.visibilityState === "visible") void tick();
      };
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", wake);
      detachWake = () => {
        window.removeEventListener("focus", wake);
        document.removeEventListener("visibilitychange", wake);
      };
    }
    void tick();
  };

  const beginSignIn = async (provider: OnlineProvider, next: string | null): Promise<SignInStart> => {
    const session = await http.request<LoginSessionWire>("POST", "/v1/auth/login-sessions", {
      auth: false,
      body: {
        provider,
        deviceName: deps.device.name(),
        device: deps.device.kind(),
        client: "web",
        returnTo: `${deps.origin}/signin/done`,
      },
    });
    const pending: PendingSignIn = {
      sessionId: session.id,
      provider,
      next: safeNext(next),
      createdAt: new Date(now()).toISOString(),
    };
    await storage.put("pendingSignIn", "current", pending);
    setStatus({ phase: "waiting", next: pending.next, error: null });
    return { sessionId: session.id, url: session.url };
  };

  const wipe = (reason: AccountChangeReason): Promise<void> => {
    if (wiping !== null) return wiping;
    wiping = (async () => {
      const had = record !== null;
      record = null;
      stopPolling();
      try {
        await deps.wipe(reason);
      } catch (error) {
        console.warn("Clearing the account's data failed", error);
      }
      if (had || reason !== "expired") emit({ signedIn: false, reason });
    })().finally(() => {
      wiping = null;
    });
    return wiping;
  };

  const refreshMe = async () => {
    if (record === null) return;
    const me = await http.request<MeWire>("GET", "/v1/me");
    if (record === null) return;
    const renamed = record.user?.displayName !== undefined && record.user.displayName !== me.user.displayName;
    record = { ...record, userId: me.user.id, user: me.user, admin: me.admin === true };
    await save();
    if (renamed) emit({ signedIn: true, reason: "renamed" });
  };

  return {
    load: async () => {
      const stored = await storage.get<SessionRecord>("session", "current");
      if (stored !== undefined && stored.apiBase === apiBase && typeof stored.token === "string" && stored.token !== "") {
        record = stored;
      } else if (stored !== undefined) {
        // A token of another service, or a damaged row: never sent anywhere.
        await storage.delete("session", "current");
      }
    },
    token: () => record?.token ?? null,
    user: () => record?.user ?? null,
    signedIn: () => record !== null,
    accountState: () => ({
      onlineConfigured: true,
      onlineSignedIn: record !== null,
      onlineUser: record?.user ?? null,
      onlineUrl: apiBase,
      localOnline: isLocalService(apiBase),
      isAdmin: record?.admin === true,
    }),
    beginSignIn,
    poll,
    watchPending,
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle: () => {
      if (status.phase !== "waiting") setStatus({ phase: "idle", next: null, error: null });
    },
    cancel: async () => {
      stopPolling();
      await storage.delete("pendingSignIn", "current");
      setStatus({ phase: "idle", next: null, error: null });
    },
    signOut: async () => {
      if (record !== null) {
        try {
          await http.request("POST", "/v1/auth/logout");
        } catch (error) {
          // The token is forgotten here either way; a service that did not
          // hear the logout lets it expire.
          if (!(error instanceof CoreError)) throw error;
        }
      }
      await wipe("signedOut");
    },
    expire: () => wipe("expired"),
    refreshMe,
    updateDisplayName: async (displayName: string) => {
      if (record === null) throw onlineError("unauthorized", "Sign in to JKNet first", 401);
      const user = await http.request<OnlineUser>("PATCH", "/v1/me", { body: { displayName } });
      if (record !== null) {
        record = { ...record, user };
        await save();
      }
      emit({ signedIn: true, reason: "renamed" });
      return user;
    },
    deleteAccount: async () => {
      await http.request("DELETE", "/v1/me");
      await wipe("deleted");
    },
    setUser: (user: OnlineUser) => {
      if (record === null) return;
      const renamed = record.user?.displayName !== user.displayName;
      record = { ...record, user };
      void save();
      if (renamed) emit({ signedIn: true, reason: "renamed" });
    },
    stop: stopPolling,
  };
}
