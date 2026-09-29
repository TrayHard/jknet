/// <reference lib="webworker" />
/**
 * The web app's service worker: a classic script, no Workbox.
 *
 * - `install`: caches the shell of this build (`shell-<build>`): the page,
 *   the entry chunk with its static imports and styles, the fonts, the
 *   manifest, the icons and the chat sounds. It waits; the page decides
 *   when the new version takes over.
 * - `activate`: drops the shells of other builds and takes the open pages.
 * - `fetch`: a navigation goes to the network and falls back to the cached
 *   page offline; `/assets/*` comes from the cache first, a chunk of a later
 *   route is added on its first load. Nothing else is touched: the API, the
 *   chat files and the pictures of other hosts go straight to the network.
 * - `message`: `SKIP_WAITING` is the **Update** button.
 * - `push`: every push becomes a notification (`content.ts`), in the
 *   subscription's language (`strings.ts`), silent while a window of the app
 *   is open — the page has played the chat's sound — and with the system's
 *   sound otherwise; the app icon's badge follows the unread count.
 * - `notificationclick`: brings an open window forward and names the address
 *   (`{type: "open", url}`), or opens a new window on it (`click.ts`).
 * - `pushsubscriptionchange`: saves the browser's new subscription on the
 *   service (`resubscribe.ts`).
 *
 * The e2e build (`__E2E__`) keeps its notifications in a list the tests read
 * (`shownNotifications`) instead of handing them to the system: a system
 * notification may sound, and a test run makes no sound.
 */

import { clickPlan, type ClickPlan } from "./click.ts";
import { notificationOf, type NotificationPlan } from "./content.ts";
import { readPref, readSession, writePref } from "./idb.ts";
import { resubscribe, type SubscriptionJson } from "./resubscribe.ts";
import { stringsFor } from "./strings.ts";

declare const self: ServiceWorkerGlobalScope;
/** The shell of this build, as JSON: `define` flattens an array literal into a string. */
declare const __PRECACHE__: string;
declare const __BUILD__: string;
/** The build of the e2e run: notifications are recorded, never shown. */
declare const __E2E__: boolean;

const SHELL_PREFIX = "shell-";
const SHELL = `${SHELL_PREFIX}${__BUILD__}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(JSON.parse(__PRECACHE__) as string[])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(SHELL_PREFIX) && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = (await caches.match("/index.html")) ?? (await caches.match("/"));
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        // The file names carry their content hash, so a cached file is the
        // right one whatever headers the request came with: a font asks in
        // CORS mode, the precache did not.
        const cached = await caches.match(request, { ignoreVary: true });
        if (cached !== undefined) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) {
            const copy = response.clone();
            void caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        } catch {
          // Offline, or the page that asked went away.
          return Response.error();
        }
      })(),
    );
  }
});

self.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type === "SKIP_WAITING") void self.skipWaiting();
});

// -- Push ------------------------------------------------------------------------

/** What the e2e build showed, oldest first. */
const shown: Array<{ title: string; options: NotificationPlan["options"] }> = [];

/** The notifications the e2e build recorded; always empty in production. */
export function shownNotifications(): Array<{ title: string; options: NotificationPlan["options"] }> {
  return shown.map((entry) => ({ title: entry.title, options: { ...entry.options, data: { ...entry.options.data } } }));
}

async function display(plan: NotificationPlan): Promise<void> {
  if (__E2E__) {
    shown.push({ title: plan.title, options: plan.options });
    return;
  }
  // `renotify` is part of the standard but missing from the DOM types.
  await self.registration.showNotification(plan.title, plan.options as NotificationOptions);
}

/** Every window of the app, the most recently focused first. */
function appWindows(): Promise<readonly WindowClient[]> {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

async function setBadge(count: number | null): Promise<void> {
  if (count === null) return;
  const navigator = self.navigator as WorkerNavigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) await navigator.setAppBadge?.(count);
    else await navigator.clearAppBadge?.();
  } catch {
    // No badge on this platform, or not for an app that is not installed.
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload: unknown = null;
      try {
        payload = event.data?.json() ?? null;
      } catch {
        // Not JSON: the generic notification still shows, as a push must.
      }
      const windowOpen = (await appWindows()).length > 0;
      const plan = notificationOf(payload, stringsFor, windowOpen);
      await display(plan);
      await setBadge(plan.badge);
    })(),
  );
});

/**
 * Where a click on a notification whose address is `url` would lead now.
 * Exported for the e2e run: only a real click may open a window.
 */
export async function clickTarget(url: unknown): Promise<ClickPlan> {
  return clickPlan(await appWindows(), url);
}

/**
 * The click of a notification whose address is `url`: an open window comes
 * forward and navigates, or a new one opens. Exported for the e2e run, which
 * cannot click a notification.
 */
export async function openFromNotification(url: unknown): Promise<"focused" | "opened"> {
  const windows = await appWindows();
  const plan = clickPlan(windows, url);
  if (plan.action === "open") {
    await self.clients.openWindow(plan.url);
    return "opened";
  }
  const target = windows[plan.index];
  try {
    await target.focus();
  } catch {
    // Only a click may bring a window forward; the address still goes.
  }
  target.postMessage({ type: "open", url: plan.url });
  return "focused";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  event.waitUntil(openFromNotification(data?.url));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  const json = (subscription: PushSubscription | null | undefined): SubscriptionJson | null => {
    const keys = subscription?.toJSON().keys;
    if (!subscription || keys?.p256dh === undefined || keys.auth === undefined) return null;
    return { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  };
  event.waitUntil(
    resubscribe({
      readSession,
      readPref,
      writePref,
      newSubscription: json(event.newSubscription),
      subscribe: async (publicKey) => {
        const raw = publicKey.replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
        return json(await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
      },
      fetch: (input, init) => fetch(input, init),
      tellPages: async (id) => {
        for (const client of await appWindows()) client.postMessage({ type: "push-subscription", id });
      },
    }).catch((error: unknown) => console.warn("Saving the new push subscription failed", error)),
  );
});
