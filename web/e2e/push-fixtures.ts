/**
 * Helpers of the push spec: a fake push service on loopback, the keys of a
 * browser's subscription, a `PushManager` that subscribes to that fake
 * service instead of the browser's real one, the decryption of what JKNet
 * Online sends (RFC 8291, `aes128gcm`), and the way into the service worker
 * (CDP `ServiceWorker.deliverPushMessage`, and the worker's own exports).
 *
 * No test here reaches a real push service: the page never calls the
 * browser's `pushManager.subscribe`, and the service accepts a loopback
 * endpoint only because the e2e run starts it with the dev provider. The
 * worker of the e2e build records its notifications instead of showing
 * them, so nothing reaches the desktop and nothing sounds.
 */

import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import type { BrowserContext, CDPSession, Page, Worker } from "@playwright/test";

import { BASE, expect, SERVICE, visit, webCatalog } from "./fixtures.ts";

export const WEB_EN = webCatalog("en") as Record<string, Record<string, unknown>>;

/** A string of the web app's `web` namespace, `section.key`. */
export function webText(path: string, language = "en"): string {
  const catalog = language === "en" ? WEB_EN : (webCatalog(language) as Record<string, Record<string, unknown>>);
  const [section, ...rest] = path.split(".");
  let node: unknown = catalog[section];
  for (const part of rest) node = (node as Record<string, unknown>)[part];
  return String(node);
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The keys a browser makes for one subscription: its P-256 pair and the auth secret. */
export interface DeviceKeys {
  ecdh: ECDH;
  auth: Buffer;
  p256dh: string;
  authText: string;
}

export function deviceKeys(): DeviceKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, p256dh: base64url(ecdh.getPublicKey()), authText: base64url(auth) };
}

/** One request that reached the fake push service. */
export interface PushDelivery {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface FakePushService {
  /** A subscription endpoint of its own for one device. */
  endpoint(device: string): string;
  /** Waits for the next delivery to a device that `seen` did not count yet. */
  next(device: string, timeoutMs?: number): Promise<PushDelivery>;
  close(): Promise<void>;
}

/** A push service on 127.0.0.1 that keeps what it gets and answers `201`. */
export async function startPushService(): Promise<FakePushService> {
  const deliveries: PushDelivery[] = [];
  const taken = new Map<string, number>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      deliveries.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const pathOf = (device: string) => `/push/${device}`;
  return {
    endpoint: (device) => `http://127.0.0.1:${port}${pathOf(device)}`,
    next: async (device, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const mine = deliveries.filter((delivery) => delivery.path === pathOf(device));
        const index = taken.get(device) ?? 0;
        if (mine.length > index) {
          taken.set(device, index + 1);
          return mine[index];
        }
        if (Date.now() > deadline) throw new Error(`no push reached ${device} within ${timeoutMs / 1000} s`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Opens one `aes128gcm` record (RFC 8188, RFC 8291) with the device's keys. */
export function decrypt(body: Buffer, keys: DeviceKeys): Record<string, unknown> {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const senderKey = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const secret = keys.ecdh.computeSecret(senderKey);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), keys.ecdh.getPublicKey(), senderKey]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, keys.auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // The last record ends with the delimiter 2 and any padding zeros.
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end -= 1;
  expect(plain[end], "the record's delimiter").toBe(2);
  return JSON.parse(plain.subarray(0, end).toString("utf8")) as Record<string, unknown>;
}

/** Checks what a delivery says about itself, then opens it. */
export function open(delivery: PushDelivery, keys: DeviceKeys): Record<string, unknown> {
  expect(delivery.headers["content-encoding"]).toBe("aes128gcm");
  expect(delivery.headers.authorization ?? "").toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  expect(Number(delivery.headers.ttl)).toBeGreaterThan(0);
  expect(delivery.headers.urgency ?? "").toMatch(/^(high|normal)$/);
  return decrypt(delivery.body, keys);
}

/**
 * A `PushManager` that subscribes to the fake push service with the test's
 * keys, for every page of a context. The subscription lives in the page's
 * `localStorage`, so a reload finds it, as a browser's would.
 */
export async function fakePushManager(context: BrowserContext, endpoint: string, keys: DeviceKeys): Promise<void> {
  const config = JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.authText });
  await context.addInitScript({
    content: `
      (() => {
        if (typeof PushManager === "undefined") return;
        const CONFIG = ${config};
        const STORE = "jknet-e2e-push";
        const bytes = (text) => {
          const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
          return Uint8Array.from(raw, (char) => char.charCodeAt(0)).buffer;
        };
        const text = (buffer) => {
          const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          return btoa(String.fromCharCode(...view)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
        };
        const make = (key) => ({
          endpoint: CONFIG.endpoint,
          expirationTime: null,
          options: { userVisibleOnly: true, applicationServerKey: key === null ? null : bytes(key) },
          getKey: (name) => (name === "p256dh" ? bytes(CONFIG.p256dh) : name === "auth" ? bytes(CONFIG.auth) : null),
          toJSON: () => ({ endpoint: CONFIG.endpoint, expirationTime: null, keys: { p256dh: CONFIG.p256dh, auth: CONFIG.auth } }),
          unsubscribe: async () => {
            localStorage.removeItem(STORE);
            return true;
          },
        });
        PushManager.prototype.subscribe = async function (options) {
          const raw = options && options.applicationServerKey;
          const key = raw ? (typeof raw === "string" ? raw : text(raw)) : null;
          localStorage.setItem(STORE, JSON.stringify({ key }));
          return make(key);
        };
        PushManager.prototype.getSubscription = async function () {
          const saved = localStorage.getItem(STORE);
          return saved === null ? null : make(JSON.parse(saved).key);
        };
      })();
    `,
  });
}

/** Grants notifications and installs the fake `PushManager`: what a player's **Allow** gives. */
export async function preparePush(context: BrowserContext, service: FakePushService, device: string): Promise<DeviceKeys> {
  const keys = deviceKeys();
  await context.grantPermissions(["notifications"], { origin: BASE });
  await fakePushManager(context, service.endpoint(device), keys);
  return keys;
}

/** **Enable notifications** on Settings · Notifications, until this device's settings show. */
export async function enablePush(page: Page, language = "en"): Promise<void> {
  await visit(page, "/settings/notifications");
  await page.getByRole("button", { name: webText("notifications.enable", language), exact: true }).click();
  await expect(page.getByTestId("push-settings")).toBeVisible();
}

/** The token of the signed-in player, read from the web app's database. */
export async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open("jknet-web", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const read = request.result.transaction("session", "readonly").objectStore("session").get("current");
          read.onsuccess = () => {
            request.result.close();
            resolve((read.result as { token?: string } | undefined)?.token ?? "");
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
}

/** The service's own answer to a push route, with the player's token. */
export async function pushApi<T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${SERVICE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text === "" ? undefined : JSON.parse(text)) as T };
}

export interface ServiceDevice {
  id: string;
  deviceName: string | null;
  locale: string;
  current: boolean;
  lastOkAt: string | null;
  settings: Record<string, unknown>;
}

export async function devicesOf(token: string): Promise<ServiceDevice[]> {
  const answer = await pushApi<{ subscriptions: ServiceDevice[] }>(token, "GET", "/v1/push/subscriptions");
  expect(answer.status).toBe(200);
  return answer.data.subscriptions;
}

/** The service worker of a context, once it runs. */
async function workerOf(context: BrowserContext): Promise<Worker> {
  await expect.poll(() => context.serviceWorkers().length, { message: "the app's service worker runs" }).toBeGreaterThan(0);
  const workers = context.serviceWorkers();
  return workers[workers.length - 1];
}

/** A CDP session that delivers pushes to the app's worker in a context. */
export interface PushLine {
  deliver(payload: unknown): Promise<void>;
}

export async function pushLine(page: Page): Promise<PushLine> {
  await page.evaluate(async () => navigator.serviceWorker.ready);
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const registrations = new Map<string, string>();
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event: { registrations: Array<{ registrationId: string; scopeURL: string; isDeleted: boolean }> }) => {
    for (const registration of event.registrations) {
      if (registration.isDeleted) registrations.delete(registration.scopeURL);
      else registrations.set(registration.scopeURL, registration.registrationId);
    }
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrations.get(`${BASE}/`), { message: "the worker's registration" }).toBeTruthy();
  return {
    deliver: async (payload) => {
      await cdp.send("ServiceWorker.deliverPushMessage", {
        origin: BASE,
        registrationId: registrations.get(`${BASE}/`) ?? "",
        data: JSON.stringify(payload),
      });
    },
  };
}

/** A notification the e2e build's worker recorded instead of showing. */
export interface Shown {
  title: string;
  options: { body: string; tag: string; renotify: boolean; silent: boolean; icon: string; data: { url: string } };
}

interface WorkerExports {
  shownNotifications(): Shown[];
  clickTarget(url: unknown): Promise<{ action: "focus" | "open"; url: string }>;
  openFromNotification(url: unknown): Promise<"focused" | "opened">;
}

/** Waits until the worker has recorded `count` notifications and answers the last. */
export async function shownAfter(context: BrowserContext, count: number): Promise<Shown> {
  let last: Shown | undefined;
  await expect
    .poll(
      async () => {
        const worker = await workerOf(context);
        const all = await worker.evaluate(() => (globalThis as unknown as { jknetServiceWorker: WorkerExports }).jknetServiceWorker.shownNotifications());
        last = all[all.length - 1];
        return all.length;
      },
      { message: "the worker shows the notification", timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(count);
  return last as Shown;
}

/** Where a click on a notification would lead: the open window, or a new one. */
export async function clickTarget(context: BrowserContext, url: string): Promise<{ action: "focus" | "open"; url: string }> {
  const worker = await workerOf(context);
  return worker.evaluate((target) => (globalThis as unknown as { jknetServiceWorker: WorkerExports }).jknetServiceWorker.clickTarget(target), url);
}

/**
 * The click itself with a window open: the worker brings it forward and
 * names the address. (A browser lets only a real click focus a window; the
 * address goes either way.)
 */
export async function clickWithWindow(context: BrowserContext, url: string): Promise<void> {
  const worker = await workerOf(context);
  const done = await worker.evaluate(
    (target) => (globalThis as unknown as { jknetServiceWorker: WorkerExports }).jknetServiceWorker.openFromNotification(target),
    url,
  );
  expect(done).toBe("focused");
}
