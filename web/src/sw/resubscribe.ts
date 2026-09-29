/**
 * `pushsubscriptionchange`: the browser replaced this device's subscription
 * (it expired, or the push service rotated it) while the app may be closed.
 *
 * The worker does what a start of the app does (`core/push.ts`, `refresh`):
 * with the token of the stored sign-in it reads the device's row, saves the
 * new subscription with that row's name, language and settings, removes the
 * old row, keeps the new id in `prefs` and tells the open pages. A device
 * whose row is gone — removed from another device's list — stays without
 * push. Without a sign-in, nothing happens.
 *
 * Everything the worker reaches comes in through `ResubscribeDeps`, so
 * `resubscribe.test.mjs` runs it under `node --test`.
 */

export interface SubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface ResubscribeDeps {
  /** The stored sign-in (`session` of IndexedDB `jknet-web`), or `null`. */
  readSession(): Promise<{ token: string; apiBase: string } | null>;
  readPref(name: "pushSubscriptionId" | "vapidKey" | "locale"): Promise<unknown>;
  writePref(name: "pushSubscriptionId" | "vapidKey", value: string): Promise<void>;
  /** The subscription the browser handed with the event, if it did. */
  newSubscription: SubscriptionJson | null;
  /** Subscribes anew with the key the old subscription was made with. */
  subscribe(publicKey: string): Promise<SubscriptionJson | null>;
  fetch: typeof fetch;
  /** Tells the open pages the new id: their socket's ticket names it. */
  tellPages(id: string): Promise<void>;
}

interface DeviceRow {
  id: string;
  deviceName: string | null;
  locale: string;
  settings: unknown;
}

/** Answers the new subscription's id, or `null` when nothing was saved. */
export async function resubscribe(deps: ResubscribeDeps): Promise<string | null> {
  const session = await deps.readSession();
  if (session === null) return null;
  const oldId = await deps.readPref("pushSubscriptionId");
  if (typeof oldId !== "string" || oldId === "") return null;

  let subscription = deps.newSubscription;
  if (subscription === null) {
    const key = await deps.readPref("vapidKey");
    if (typeof key !== "string" || key === "") return null;
    subscription = await deps.subscribe(key);
  }
  if (subscription === null) return null;

  const api = session.apiBase.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  const call = (method: string, path: string, body?: unknown) =>
    deps.fetch(`${api}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });

  const listed = await call("GET", "/v1/push/subscriptions");
  if (!listed.ok) return null;
  const rows = ((await listed.json()) as { subscriptions?: DeviceRow[] }).subscriptions ?? [];
  const old = rows.find((row) => row.id === oldId);
  if (old === undefined) return null;

  const saved = await call("PUT", "/v1/push/subscriptions", {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    ...(old.deviceName === null ? {} : { deviceName: old.deviceName }),
    locale: old.locale,
    settings: old.settings,
  });
  if (!saved.ok) return null;
  const answer = (await saved.json()) as { id?: unknown; publicKey?: unknown };
  if (typeof answer.id !== "string") return null;

  if (answer.id !== old.id) await call("DELETE", `/v1/push/subscriptions/${encodeURIComponent(old.id)}`).catch(() => undefined);
  await deps.writePref("pushSubscriptionId", answer.id);
  if (typeof answer.publicKey === "string") await deps.writePref("vapidKey", answer.publicKey);
  await deps.tellPages(answer.id);
  return answer.id;
}
