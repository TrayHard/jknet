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
 * | chat            | `chat/`        |
 * | chat files      | `chat/files.ts`, `chat/exif.ts` |
 * | cards           | `chat/cards.ts` |
 * | friends' server chats | `chat/serverChats.ts` |
 * | catalogs        | `catalogs.ts`  |
 * | push notifications | `push.ts`   |
 * | one active tab  | `tabs.ts`      |
 */

import type { Backend, BackendEvent, ListenOptions, PlatformCaps } from "../../../src/lib/backend.ts";
import type { AccountChangeReason, ChatMessage, WebDevice } from "../../../src/lib/ipc.ts";
import { createCatalogs } from "./catalogs.ts";
import { prepareCards } from "./chat/cards.ts";
import { createChatFiles, FILE_CACHE, type WebChatFiles } from "./chat/files.ts";
import { CHAT_EVENTS } from "./chat/frames.ts";
import { createChat, type ChatCore } from "./chat/index.ts";
import type { NotifyTexts } from "./chat/notify.ts";
import { createServerChats, type ServerChats } from "./chat/serverChats.ts";
import { playSound } from "./chat/sounds.ts";
import { statusOf } from "./errors.ts";
import { EventBus } from "./events.ts";
import { createFriends, type FriendsCore } from "./friends.ts";
import { createHttp, type Http } from "./http.ts";
import { attachLifecycle, visibleNow } from "./lifecycle.ts";
import type { PrefsStore } from "./prefs.ts";
import { createPush, webPushTransport, type PushCore, type PushTransport } from "./push.ts";
import { createRouter, createStats, type CommandRouter, type CoreStats } from "./router.ts";
import { createSession, type Session } from "./session.ts";
import { createSettings, DEFAULT_CHAT_NOTIFICATIONS, type SettingsCore } from "./settings.ts";
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

/**
 * The file caches of chat downloads, every version of `FILE_CACHE` of
 * `chat/files.ts`: a sign-out deletes them all.
 */
export const FILE_CACHE_PREFIX = FILE_CACHE.slice(0, FILE_CACHE.lastIndexOf("-") + 1);

export interface WebCoreOptions {
  apiBase: string;
  storage: Storage;
  prefs: PrefsStore;
  device: { kind(): WebDevice; name(): string };
  /** `location.origin`: sign-in comes back to `/signin/done` on it. */
  origin: string;
  /** The words of the chat's notifications in the language on screen; English without it. */
  texts?: () => NotifyTexts;
  /** The language on screen, which push notifications are written in; English without it. */
  locale?: () => string;
  /** The push channel; Web Push through the service worker without it. */
  pushTransport?: PushTransport;
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
  readonly chat: ChatCore;
  readonly files: WebChatFiles;
  readonly serverChats: ServerChats;
  readonly push: PushCore;
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

  // What the last ticket told the service about the tab: a tab hidden or
  // shown between the ticket and the open says so once the socket is up.
  let ticketVisible = true;
  const socket = createSocket({
    apiBase: http.apiBase,
    requestTicket: async () => {
      const body: Record<string, unknown> = {
        features: ["chat"],
        device: device.kind(),
        visible: visibleNow(),
      };
      ticketVisible = body.visible === true;
      const pushSubscriptionId = prefs.get("pushSubscriptionId");
      if (typeof pushSubscriptionId === "string" && pushSubscriptionId !== "") {
        body.pushSubscriptionId = pushSubscriptionId;
      }
      try {
        const answer = await http.request<{ ticket: string }>("POST", "/v1/ws/tickets", { body });
        return answer.ticket;
      } catch (error) {
        // The service refuses a ticket naming a subscription it no longer
        // keeps for this token (removed on another device, dropped by the
        // push service). The page forgets the id and connects without it.
        if (body.pushSubscriptionId === undefined || statusOf(error) !== 400) throw error;
        await prefs.set("pushSubscriptionId", undefined);
        delete body.pushSubscriptionId;
        const answer = await http.request<{ ticket: string }>("POST", "/v1/ws/tickets", { body });
        return answer.ticket;
      }
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
      if (serverChats.handleFrame(frame)) return;
      for (const handler of frameHandlers) {
        if (handler(frame)) return;
      }
      chat.handleFrame(frame);
    },
    onOpen: () => {
      const visible = visibleNow();
      if (visible !== ticketVisible) socket.send({ type: "presence.web", payload: { visible } });
      friends.connected();
      chat.connected();
      serverChats.connected();
    },
    onStatus: (status) => {
      friends.setLive(status === "open");
      chat.setLive(status === "open");
      for (const listener of [...socketListeners]) listener();
    },
    onSignedOut: () => void sessionRef?.expire(),
  });

  const tabs = createTabGate({ release: () => stop() });

  const wipe = async (reason: AccountChangeReason) => {
    socket.stop();
    friends.stop();
    chat.forget();
    files.forget();
    serverChats.stop();
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
      if (!started) return;
      socket.start();
      void chat.start();
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

  // The chat below uploads through the files, and the files ask the chat
  // which staged file a queued message still holds.
  const files = createChatFiles({
    http,
    events,
    storage,
    token: () => session.token(),
    onUnauthorized: () => void session.expire(),
    held: (handle) => chat.holdsAttachment(handle),
  });
  // A save names the file and warns by what the service said about it.
  events.on(CHAT_EVENTS.message, (message) => files.remember([message as ChatMessage]));

  const chat: ChatCore = createChat({
    http,
    events,
    storage,
    me: () => session.user()?.id ?? null,
    signedIn: () => session.signedIn(),
    live: () => socket.status() === "open",
    sendFrame: (frame) => socket.send(frame),
    notifications: () => settings.get().chatNotifications ?? defaultNotifications(),
    pushSubscribed: () => {
      const id = prefs.get("pushSubscriptionId");
      return typeof id === "string" && id !== "";
    },
    texts: options.texts ?? (() => ENGLISH_TEXTS),
    openExternal: (url) => backend.openExternal(url),
    files,
    prepareCards,
    page: {
      visible: visibleNow,
      online: () => typeof navigator === "undefined" || navigator.onLine !== false,
      playSound,
      showNotification: (title, notification) => void showPageNotification(title, notification),
    },
  });

  const serverChats = createServerChats({
    http,
    events,
    signedIn: () => session.signedIn(),
    keep: (conversation) => chat.keep(conversation),
  });

  const catalogs = createCatalogs({
    http,
    signedIn: () => session.signedIn(),
    activeGame: () => settings.get().activeGame,
  });

  const push = createPush({
    http,
    prefs,
    transport: options.pushTransport ?? webPushTransport(),
    signedIn: () => session.signedIn(),
    locale: options.locale ?? (() => "en"),
    deviceName: () => device.name(),
    // A running socket reconnects, so its ticket names the subscription.
    reconnect: () => {
      if (socket.status() === "idle") return;
      socket.stop();
      socket.start();
    },
  });
  let detachWorker: (() => void) | null = null;

  const invoke = createRouter({
    apiBase: http.apiBase,
    session,
    settings,
    friends,
    chat,
    files,
    serverChats,
    catalogs,
    stats,
  });

  // Answers and events leave the core as copies, the way the launcher's
  // core serializes them: a screen that keeps an answer in its cache must
  // never hold an object the core goes on changing, or a later update that
  // equals it would be taken for no change at all.
  const backend: Backend = {
    kind: "web",
    invoke: async <T>(command: string, args?: Record<string, unknown>) => detach(await invoke(command, args)) as T,
    listen: async <T>(event: string, handler: (event: BackendEvent<T>) => void, _options?: ListenOptions) =>
      events.on(event, (payload) => handler({ payload: detach(payload) as T })),
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
    detachWorker?.();
    detachWorker = null;
    socket.stop();
    friends.stop();
    chat.stop();
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
    chat,
    files,
    serverChats,
    push,
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
          chat.hidden();
          for (const listener of [...hiddenListeners]) listener();
        },
        resumed: () => {
          chat.resumed();
          for (const listener of [...resumeListeners]) listener();
        },
      });
      await chat.start();
      detachWorker = watchWorker(push);
      if (session.signedIn()) {
        socket.start();
        void session.refreshMe().catch(() => undefined);
        void push.refresh().catch((error: unknown) => console.warn("Refreshing the push subscription failed", error));
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

/** A copy of an answer or an event, as a serialized one would be. */
export function detach<T>(value: T): T {
  return value === undefined || value === null || typeof value !== "object" ? value : structuredClone(value);
}

/** The notification words before the interface language is known. */
const ENGLISH_TEXTS: NotifyTexts = { newMessage: "New message", deletedAccount: "Deleted account" };

function defaultNotifications() {
  return { ...DEFAULT_CHAT_NOTIFICATIONS };
}

/**
 * A system notification of a chat message, shown by the page: only for a
 * device without a push subscription (push is otherwise the one system
 * notification) and only once the player allowed notifications. The tag is
 * the one push uses, so the two never pile up for one conversation.
 */
async function showPageNotification(title: string, notification: { body: string; tag: string; url: string }): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // A browser driven by automation shows none: a system notification may
    // come with a sound, and a test run never makes one.
    if (typeof navigator !== "undefined" && navigator.webdriver) return;
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration === undefined) return;
    await registration.showNotification(title, {
      body: notification.body,
      tag: notification.tag,
      icon: "/icons/icon-192.png",
      data: { url: notification.url },
    });
  } catch (error) {
    console.warn("Showing a chat notification failed", error);
  }
}

/**
 * Hears the service worker: after `pushsubscriptionchange` it saved the
 * browser's new subscription on the service and names its id here.
 */
function watchWorker(push: PushCore): () => void {
  const workers = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (workers === undefined) return () => {};
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown } | null;
    if (data?.type !== "push-subscription" || typeof data.id !== "string") return;
    void push.adopt(data.id);
  };
  workers.addEventListener("message", onMessage);
  return () => workers.removeEventListener("message", onMessage);
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
