/**
 * The service worker's reads and writes of the page's database, IndexedDB
 * `jknet-web` (`core/storage.ts`): the stored sign-in and a few preferences.
 *
 * The worker never creates the database: opened before the page ever made
 * it, the open is aborted in `upgradeneeded`, so the page's first open still
 * creates its stores.
 */

const DB_NAME = "jknet-web";
const DB_VERSION = 1;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (db === null) return undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      let request: IDBRequest<T>;
      try {
        request = work(db.transaction(store, mode).objectStore(store));
      } catch {
        resolve(undefined);
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  } finally {
    db.close();
  }
}

/** The stored sign-in: its token and the service it belongs to. */
export async function readSession(): Promise<{ token: string; apiBase: string } | null> {
  const record = (await run("session", "readonly", (s) => s.get("current"))) as { token?: unknown; apiBase?: unknown } | undefined;
  if (typeof record?.token !== "string" || record.token === "" || typeof record.apiBase !== "string") return null;
  return { token: record.token, apiBase: record.apiBase };
}

export async function readPref(name: string): Promise<unknown> {
  return run("prefs", "readonly", (s) => s.get(name));
}

export async function writePref(name: string, value: unknown): Promise<void> {
  await run("prefs", "readwrite", (s) => s.put(value, name));
}
