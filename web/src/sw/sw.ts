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
 */

declare const self: ServiceWorkerGlobalScope;
/** The shell of this build, as JSON: `define` flattens an array literal into a string. */
declare const __PRECACHE__: string;
declare const __BUILD__: string;

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

export {};
