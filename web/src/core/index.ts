/**
 * The web core: the TypeScript backend of the web app.
 *
 * The launcher's screens reach their backend through `lib/backend.ts`; in the
 * launcher the Rust core answers, here this module does, over the JKNet
 * Online API. `createWebCore` wires the parts and hands out a `Backend` of
 * kind `web` whose capabilities are all off: no game, no local files, no
 * native dialogs, no tray, one window, no UDP.
 *
 * | Part            | File           |
 * | --------------- | -------------- |
 * | commands        | `router.ts`    |
 * | events          | `events.ts`    |
 * | requests        | `http.ts`      |
 * | the account     | `session.ts`   |
 * | IndexedDB       | `storage.ts`, `prefs.ts` |
 * | settings        | `settings.ts`  |
 * | live socket     | `socket.ts`, `lifecycle.ts` |
 * | friends         | `friends.ts`   |
 * | one active tab  | `tabs.ts`      |
 */

import type { Backend, BackendEvent, ListenOptions, PlatformCaps } from "../../../src/lib/backend.ts";
import type { AccountChangeReason, WebDevice } from "../../../src/lib/ipc.ts";
import { statusOf } from "./errors.ts";
import { EventBus } from "./events.ts";
import { createFriends, type FriendsCore } from "./friends.ts";
import { createHttp, type Http } from "./http.ts";
import { attachLifecycle, visibleNow } from "./lifecycle.ts";
import type { PrefsStore } from "./prefs.ts";
import { createRouter, createStats, type CommandRouter, type CoreStats } from "./router.ts";
import { createSession, type Session } from "./session.ts";
import { createSettings, type SettingsCore } from "./settings.ts";
import { createSocket, type Frame, type LiveSocket, type SocketStatus } from "./socket.ts";
import type { Storage } from "./storage.ts";
import { createTabGate, type TabGate } from "./tabs.ts";

/** Nothing the web app can do that needs the PC. */
export const WEB_CAPS: PlatformCaps = Object.freeze({
  game: false,
  localFiles: false,
  nativeDialogs: false,
  tray: false,
  windows: false,
  serverQuery: false,
});

/** The file cache of chat downloads; the name carries its version. */
export const FILE_CACHE_PREFIX = "jknet-files-";

export interface WebCoreOptions {
  apiBase: string;
  storage: Storage;
  prefs: PrefsStore;
  device: { kind(): WebDevice; name(): string };
  /** `location.origin`: sign-in comes back to `/signin/done` on it. */
  origin: string;
}

export type FrameHandler = (frame: Frame) => boolean;

export interface WebCore {
  readonly apiBase: string;
  readonly backend: Backend;
  readonly events: EventBus;
  readonly http: Http;
  readonly session: Session;
  readonly settings: SettingsCore;
  readonly friends: FriendsCore;
  readonly socket: LiveSocket;
  readonly prefs: PrefsStore;
  readonly storage: Storage;
  readonly stats: CoreStats;
  readonly tabs: TabGate;
  readonly invoke: CommandRouter;
  /** Loads the session and, when signed in, opens the socket. */
  start(): Promise<void>;
  /** Closes the socket and stops the timers: another tab took over. */
  stop(): Promise<void>;
  socketStatus(): SocketStatus;
  subscribeSocket(listener: () => void): () => void;
  /** A later part of the core takes the frames it knows; the first to say `true` wins. */
  addFrameHandler(handler: FrameHandler): () => void;
  /** Runs when a hidden tab comes back with its socket up. */
  onResume(listener: () => void): () => void;
  /** Runs when the tab goes into the background. */
  onHidden(listener: () => void): () => void;
}

export function createWebCore(options: WebCoreOptions): WebCore {
  const { apiBase, storage, prefs, device } = options;
  const events = new EventBus();
  const stats = createStats();
  const frameHandlers: FrameHandler[] = [];
  const socketListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  const hiddenListeners = new Set<() => void>();
  let detachLifecycle: (() => void) | null = null;
  let started = false;

  // `session` is created below and the HTTP client needs its token: the two
  // reach each other through these closures.
  let sessionRef: Session | null = null;
  const http = createHttp({
    apiBase,
    token: () => sessionRef?.token() ?? null,
    onUnauthorized: () => void sessionRef?.expire(),
  });

  const socket = createSocket({
    apiBase: http.apiBase,
    requestTicket: async () => {
      const body: Record<string, unknown> = {
        features: ["chat"],
        device: device.kind(),
        visible: visibleNow(),
      };
      const pushSubscriptionId = prefs.get("pushSubscriptionId");
      if (typeof pushSubscriptionId === "string" && pushSubscriptionId !== "") {
        body.pushSubscriptionId = pushSubscriptionId;
      }
      const answer = await http.request<{ ticket: string }>("POST", "/v1/ws/tickets", { body });
      return answer.ticket;
    },
    isUnauthorized: (error) => statusOf(error) === 401,
    open: (url) => new WebSocket(url),
    timers: {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    random: Math.random,
    onFrame: (frame) => {
      if (friends.handleFrame(frame)) return;
      for (const handler of frameHandlers) {
        if (handler(frame)) return;
      }
    },
    onOpen: () => friends.connected(),
    onStatus: (status) => {
      friends.setLive(status === "open");
      for (const listener of [...socketListeners]) listener();
    },
    onSignedOut: () => void sessionRef?.expire(),
  });

  const tabs = createTabGate({ release: () => stop() });

  const wipe = async (reason: AccountChangeReason) => {
    socket.stop();
    friends.stop();
    await storage.wipe();
    await prefs.restoreDevicePrefs();
    await clearBrowserState();
    if (reason !== "expired" || started) tabs.announceSignOut();
  };

  const session = createSession({
    http,
    storage,
    events,
    apiBase: http.apiBase,
    origin: options.origin,
    device,
    wipe,
    signedIn: () => {
      if (started) socket.start();
    },
  });
  sessionRef = session;

  const friends = createFriends({
    http,
    events,
    signedIn: () => session.signedIn(),
    device: () => device.kind(),
    live: () => socket.status() === "open",
    meUpdated: (user) => session.setUser(user),
  });

  const settings = createSettings({ apiBase: http.apiBase, prefs, events, user: () => session.user() });
  const invoke = createRouter({ apiBase: http.apiBase, session, settings, friends, stats });

  const backend: Backend = {
    kind: "web",
    invoke: <T>(command: string, args?: Record<string, unknown>) => invoke(command, args) as Promise<T>,
    listen: async <T>(event: string, handler: (event: BackendEvent<T>) => void, _options?: ListenOptions) =>
      events.on(event, (payload) => handler({ payload: payload as T })),
    emitTo: async (_target, event, payload) => events.emit(event, payload),
    // Only `blob:` addresses of files the core fetched ever reach this.
    convertFileSrc: (path) => path,
    openExternal: async (url) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    },
    caps: WEB_CAPS,
  };

  async function stop() {
    started = false;
    detachLifecycle?.();
    detachLifecycle = null;
    socket.stop();
    friends.stop();
    session.stop();
    storage.close();
  }

  return {
    apiBase: http.apiBase,
    backend,
    events,
    http,
    session,
    settings,
    friends,
    socket,
    prefs,
    storage,
    stats,
    tabs,
    invoke,
    start: async () => {
      if (started) return;
      started = true;
      await session.load();
      detachLifecycle = attachLifecycle(socket, {
        hidden: () => {
          for (const listener of [...hiddenListeners]) listener();
        },
        resumed: () => {
          for (const listener of [...resumeListeners]) listener();
        },
      });
      if (session.signedIn()) {
        socket.start();
        void session.refreshMe().catch(() => undefined);
      } else {
        await session.watchPending();
      }
    },
    stop,
    socketStatus: () => socket.status(),
    subscribeSocket: (listener) => {
      socketListeners.add(listener);
      return () => socketListeners.delete(listener);
    },
    addFrameHandler: (handler) => {
      frameHandlers.push(handler);
      return () => {
        const at = frameHandlers.indexOf(handler);
        if (at >= 0) frameHandlers.splice(at, 1);
      };
    },
    onResume: (listener) => {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    onHidden: (listener) => {
      hiddenListeners.add(listener);
      return () => hiddenListeners.delete(listener);
    },
  };
}

/**
 * What a signed-out browser must not keep: the downloaded chat files, the
 * notifications on screen and the push subscription. The service drops the
 * subscription's row with the token; this drops the browser's side.
 */
async function clearBrowserState(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      for (const name of await caches.keys()) {
        if (name.startsWith(FILE_CACHE_PREFIX)) await caches.delete(name);
      }
    }
  } catch (error) {
    console.warn("Clearing the file cache failed", error);
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration !== undefined) {
      for (const notification of await registration.getNotifications()) notification.close();
      const subscription = await registration.pushManager?.getSubscription();
      await subscription?.unsubscribe();
    }
  } catch (error) {
    console.warn("Clearing the notifications failed", error);
  }
}
