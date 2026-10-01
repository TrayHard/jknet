/**
 * Push notifications of this device: the browser's subscription and its
 * settings on JKNet Online.
 *
 * | Step                   | What happens                                              |
 * | ---------------------- | --------------------------------------------------------- |
 * | **Enable** (a click)   | permission, `pushManager.subscribe` with the service's key, `PUT /v1/push/subscriptions` |
 * | every start            | the browser's subscription saved again: fresh `updated_at` and language; a new key subscribes anew |
 * | a setting              | `PATCH /v1/push/subscriptions/{id}`, this device only     |
 * | **Send test notification** | `POST /v1/push/subscriptions/{id}/test`               |
 * | **Remove** of a device | `DELETE /v1/push/subscriptions/{id}`                      |
 *
 * The subscription's id and the key it was made with live in `prefs`
 * (`pushSubscriptionId`, `vapidKey`). The socket's ticket names the id, so
 * the service knows which subscription belongs to a page on screen and holds
 * its pushes back; a new id restarts the socket. A sign-out drops the
 * browser's subscription (`index.ts`) and the service drops its row with the
 * token.
 *
 * The browser's side sits behind `PushTransport`: `webPushTransport` is Web
 * Push through the service worker; a native transport of a wrapped app would
 * be another implementation (the service's `kind` column).
 */

import { CoreError, onlineError, signedOut, statusOf } from "./errors.ts";
import { segment, type Http } from "./http.ts";
import type { PrefsStore } from "./prefs.ts";

// -- The settings of a device, as the service keeps them ------------------------

export type PushLevel = "all" | "mentions" | "off";
export type PushPreview = "full" | "sender" | "none";
export type ActiveElsewhere = "delay" | "always" | "never";

export interface PushQuietHours {
  /** `HH:MM`, the first quiet minute. */
  from: string;
  /** `HH:MM`, the first minute that is not quiet any more. */
  to: string;
  /** An IANA time zone: the browser's own. */
  timeZone: string;
}

/** `push/settings.rs` of the service, field for field. */
export interface PushSettings {
  enabled: boolean;
  /** RFC 3339, or `null`. */
  pausedUntil: string | null;
  direct: boolean;
  groups: PushLevel;
  serverChats: PushLevel;
  reactions: boolean;
  friendRequests: boolean;
  friendAccepted: boolean;
  groupInvites: boolean;
  serverInvites: boolean;
  // --- slice: community events --- a new event, a change, a reminder. Absent from a service before S4: on.
  communityEvents: boolean;
  // --- slice: community news --- a post of a followed community. Absent from a service before S5: on.
  communityNews?: boolean;
  preview: PushPreview;
  silent: boolean;
  quietHours: PushQuietHours | null;
  mentionsBreakQuiet: boolean;
  whileActiveElsewhere: ActiveElsewhere;
}

/** The service's defaults, the user's final decisions: the full preview, and a minute's delay at the PC. */
export const DEFAULT_PUSH_SETTINGS: Readonly<PushSettings> = Object.freeze({
  enabled: true,
  pausedUntil: null,
  direct: true,
  groups: "all",
  serverChats: "mentions",
  reactions: false,
  friendRequests: true,
  friendAccepted: true,
  groupInvites: true,
  serverInvites: true,
  communityEvents: true,
  communityNews: true,
  preview: "full",
  silent: false,
  quietHours: null,
  mentionsBreakQuiet: false,
  whileActiveElsewhere: "delay",
});

/** One subscription of the account, as `GET /v1/push/subscriptions` lists it. */
export interface PushDevice {
  id: string;
  deviceName: string | null;
  locale: string;
  /** Saved with this browser's token. */
  current: boolean;
  createdAt: string;
  lastOkAt: string | null;
  settings: PushSettings;
}

export interface PushConfig {
  enabled: boolean;
  /** The service's VAPID key, base64url; `null` while push is off. */
  publicKey: string | null;
}

interface SavedWire {
  id: string;
  settings: PushSettings;
  publicKey: string;
}

// -- The browser's side ----------------------------------------------------------

export type PushPermission = NotificationPermission | "unsupported";

/** What the service needs of a browser's subscription. */
export interface SubscriptionInfo {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The key the subscription was made with, base64url; `null` when the browser does not say. */
  key: string | null;
}

/** The push channel of a platform: Web Push here, a native one in a wrapped app. */
export interface PushTransport {
  /** Whether this browser can receive push at all. */
  supported(): boolean;
  permission(): PushPermission;
  /** Asks the player. Called straight from a click: browsers ask only then. */
  requestPermission(): Promise<PushPermission>;
  current(): Promise<SubscriptionInfo | null>;
  subscribe(publicKey: string): Promise<SubscriptionInfo>;
  unsubscribe(): Promise<void>;
}

/** How long a subscription waits for the service worker to become active. */
const WORKER_WAIT_MS = 15_000;

export function toBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function infoOf(subscription: PushSubscription): SubscriptionInfo {
  const json = subscription.toJSON();
  const key = subscription.options?.applicationServerKey ?? null;
  return {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
    key: key === null ? null : toBase64url(key),
  };
}

/** Web Push through the page's service worker. */
export function webPushTransport(): PushTransport {
  const registration = async (): Promise<ServiceWorkerRegistration> => {
    const workers = navigator.serviceWorker;
    if (workers === undefined) throw unsupported();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        workers.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unsupported()), WORKER_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    supported: () =>
      typeof window !== "undefined" &&
      typeof Notification !== "undefined" &&
      "PushManager" in window &&
      navigator.serviceWorker !== undefined,
    permission: () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    requestPermission: async () => (typeof Notification === "undefined" ? "unsupported" : Notification.requestPermission()),
    current: async () => {
      const found = await navigator.serviceWorker?.getRegistration?.();
      const subscription = await found?.pushManager?.getSubscription();
      return subscription ? infoOf(subscription) : null;
    },
    subscribe: async (publicKey) => {
      const ready = await registration();
      const subscription = await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64url(publicKey),
      });
      return infoOf(subscription);
    },
    unsubscribe: async () => {
      const found = await navigator.serviceWorker?.getRegistration?.();
      const subscription = await found?.pushManager?.getSubscription();
      await subscription?.unsubscribe();
    },
  };
}

/** This browser has no push: no service worker, no `PushManager`, no notifications. */
export function unsupported(): CoreError {
  return new CoreError("pushUnsupported", "This browser cannot receive push notifications");
}

/** The player said no, now or before: only the browser's site settings can undo it. */
export function blocked(): CoreError {
  return new CoreError("pushBlocked", "Notifications are blocked in this browser");
}

// -- The core --------------------------------------------------------------------

export interface PushDeps {
  http: Http;
  prefs: PrefsStore;
  transport: PushTransport;
  signedIn(): boolean;
  /** The language notifications are written in: the app's. */
  locale(): string;
  /** `JKNet web · Android · Chrome`: what the list of devices shows. */
  deviceName(): string;
  /** The socket's ticket names the subscription: a new id reconnects it. */
  reconnect(): void;
}

/** What the notifications screen reads of this browser. */
export interface PushLocal {
  supported: boolean;
  permission: PushPermission;
  /** The id of this device's subscription, `null` while it has none. */
  subscriptionId: string | null;
}

export interface PushCore {
  /** `GET /v1/push/config`, asked once per page unless `force`. */
  config(force?: boolean): Promise<PushConfig>;
  local(): PushLocal;
  /** Re-renders the screen after anything of `local()` changed. */
  subscribe(listener: () => void): () => void;
  /** **Enable notifications**: call it straight from the click. */
  enable(): Promise<PushDevice | null>;
  /** Saves this browser's subscription again at start; see the file comment. */
  refresh(): Promise<void>;
  /** The account's subscriptions. */
  devices(): Promise<PushDevice[]>;
  /** Changes this device's settings; the answer is what the service kept. */
  update(patch: Partial<PushSettings>): Promise<PushSettings>;
  /** Removes a subscription of the account; this device's own stops its push too. */
  remove(id: string): Promise<void>;
  /** Sends a test notification to this device. */
  test(): Promise<void>;
  /** The app's language changed: notifications follow it. */
  setLocale(locale: string): Promise<void>;
  /** The service worker replaced the subscription (`pushsubscriptionchange`). */
  adopt(id: string): Promise<void>;
}

export function createPush(deps: PushDeps): PushCore {
  const { http, prefs, transport } = deps;
  let configAnswer: Promise<PushConfig> | null = null;
  let snapshot: PushLocal | null = null;
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of [...listeners]) listener();
  };

  const localId = (): string | null => {
    const id = prefs.get("pushSubscriptionId");
    return typeof id === "string" && id !== "" ? id : null;
  };

  const forget = async () => {
    await prefs.set("pushSubscriptionId", undefined);
    await prefs.set("vapidKey", undefined);
    changed();
  };

  const adoptId = async (id: string, key: string) => {
    const before = localId();
    await prefs.set("pushSubscriptionId", id);
    await prefs.set("vapidKey", key);
    changed();
    if (before !== id) deps.reconnect();
  };

  const config = (force = false): Promise<PushConfig> => {
    if (force || configAnswer === null) {
      const asked = http.request<PushConfig>("GET", "/v1/push/config", { auth: false });
      configAnswer = asked;
      // A failed read is asked again next time.
      asked.catch(() => {
        if (configAnswer === asked) configAnswer = null;
      });
    }
    return configAnswer;
  };

  const put = (info: SubscriptionInfo, settings?: PushSettings) =>
    http.send<SavedWire>("PUT", "/v1/push/subscriptions", {
      body: {
        endpoint: info.endpoint,
        keys: { p256dh: info.p256dh, auth: info.auth },
        deviceName: deps.deviceName(),
        locale: deps.locale(),
        ...(settings === undefined ? {} : { settings }),
      },
    });

  const devices = async (): Promise<PushDevice[]> => {
    const answer = await http.request<{ subscriptions: PushDevice[] }>("GET", "/v1/push/subscriptions");
    return answer.subscriptions;
  };

  const dropRow = async (id: string) => {
    try {
      await http.request("DELETE", `/v1/push/subscriptions/${segment(id)}`);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  };

  const liveKey = async (): Promise<string> => {
    const answer = await config();
    if (!answer.enabled || answer.publicKey === null) {
      throw onlineError("push_disabled", "Push notifications are off on this service", 503);
    }
    return answer.publicKey;
  };

  return {
    config,
    // The same object while nothing changed: a React store snapshot. It is
    // read afresh each time, so a sign-out that wiped the id, or a
    // permission changed in the browser's settings, shows on the next render.
    local: () => {
      const now: PushLocal = { supported: transport.supported(), permission: transport.permission(), subscriptionId: localId() };
      if (
        snapshot === null ||
        snapshot.supported !== now.supported ||
        snapshot.permission !== now.permission ||
        snapshot.subscriptionId !== now.subscriptionId
      ) {
        snapshot = now;
      }
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    enable: async () => {
      if (!deps.signedIn()) throw signedOut();
      if (!transport.supported()) throw unsupported();
      // First, before anything is awaited: a browser asks only inside the click.
      const asked = transport.permission() === "granted" ? Promise.resolve<PushPermission>("granted") : transport.requestPermission();
      const permission = await asked;
      changed();
      if (permission !== "granted") throw blocked();
      const publicKey = await liveKey();
      let info = await transport.current();
      if (info !== null && info.key !== null && info.key !== publicKey) {
        await transport.unsubscribe();
        info = null;
      }
      info ??= await transport.subscribe(publicKey);
      const saved = await put(info);
      await adoptId(saved.data.id, saved.data.publicKey);
      return (await devices()).find((device) => device.id === saved.data.id) ?? null;
    },

    refresh: async () => {
      if (!deps.signedIn() || !transport.supported() || transport.permission() !== "granted") return;
      const had = localId();
      let info = await transport.current();
      if (info === null) {
        if (had !== null) await forget();
        return;
      }
      const answer = await config();
      if (!answer.enabled || answer.publicKey === null) return;

      // The row this device saved. Gone means removed from another device's
      // list, or dropped after the push service refused it: that stays so,
      // and **Enable notifications** starts over.
      let old: PushDevice | undefined;
      if (had !== null) {
        old = (await devices()).find((device) => device.id === had);
        if (old === undefined) {
          await transport.unsubscribe().catch(() => undefined);
          await forget();
          deps.reconnect();
          return;
        }
      }

      // A new key of the service: the old subscription cannot be sent to any
      // more. Subscribe anew.
      if (info.key !== null && info.key !== answer.publicKey) {
        await transport.unsubscribe();
        info = await transport.subscribe(answer.publicKey);
      }

      // A new endpoint makes a new row: the settings travel along, and the
      // row of the old endpoint goes.
      const saved = await put(info, old?.settings);
      if (had !== null && had !== saved.data.id) await dropRow(had).catch(() => undefined);
      await adoptId(saved.data.id, saved.data.publicKey);
    },

    devices,

    update: async (patch) => {
      const id = localId();
      if (id === null) throw onlineError("not_found", "This device has no push subscription", 404);
      try {
        const answer = await http.request<{ id: string; settings: PushSettings }>(
          "PATCH",
          `/v1/push/subscriptions/${segment(id)}`,
          { body: { settings: patch } },
        );
        return answer.settings;
      } catch (error) {
        if (statusOf(error) === 404) {
          await transport.unsubscribe().catch(() => undefined);
          await forget();
          deps.reconnect();
        }
        throw error;
      }
    },

    remove: async (id) => {
      await dropRow(id);
      if (id !== localId()) return;
      await transport.unsubscribe().catch(() => undefined);
      await forget();
      deps.reconnect();
    },

    test: async () => {
      const id = localId();
      if (id === null) throw onlineError("not_found", "This device has no push subscription", 404);
      await http.request("POST", `/v1/push/subscriptions/${segment(id)}/test`);
    },

    setLocale: async (locale) => {
      const id = localId();
      if (id === null || !deps.signedIn()) return;
      try {
        await http.request("PATCH", `/v1/push/subscriptions/${segment(id)}`, { body: { locale } });
      } catch (error) {
        console.warn("The notifications did not switch their language", error);
      }
    },

    adopt: async (id) => {
      if (id === "" || id === localId()) return;
      await prefs.set("pushSubscriptionId", id);
      changed();
      deps.reconnect();
    },
  };
}
