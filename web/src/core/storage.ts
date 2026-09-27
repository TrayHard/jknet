/**
 * The web app's durable state: IndexedDB `jknet-web`, version 1.
 *
 * | Store           | Key               | Value                                    |
 * | --------------- | ----------------- | ---------------------------------------- |
 * | `session`       | `"current"`       | `{ token, userId, apiBase, createdAt }`  |
 * | `pendingSignIn` | `"current"`       | `{ sessionId, provider, next, createdAt }` |
 * | `outbox`        | `clientId`        | a message waiting to go out              |
 * | `drafts`        | `conversationId`  | `{ text, updatedAt }`                    |
 * | `prefs`         | name              | one preference of this device            |
 * | `files`         | `fileId`          | `{ size, lastUsed }` of the file cache   |
 *
 * Every call is wrapped. A browser that refuses IndexedDB — a private window,
 * a full disk, a store the user wiped — leaves the core working in memory:
 * `durable` is then `false` and nothing survives a reload, the outbox
 * included. The service worker reads the same database for the token.
 */

export const DB_NAME = "jknet-web";
export const DB_VERSION = 1;
export const STORES = ["session", "pendingSignIn", "outbox", "drafts", "prefs", "files"] as const;
export type StoreName = (typeof STORES)[number];

export interface Storage {
  /** Whether writes reach IndexedDB, or only memory. */
  readonly durable: boolean;
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  entries<T>(store: StoreName): Promise<Array<{ key: string; value: T }>>;
  /** Deletes the whole database: sign-out and account switch. */
  wipe(): Promise<void>;
  /** Closes the connection; the next call opens it again. */
  close(): void;
}

/** Opens the database, or answers a store in memory when that fails. */
export async function openStorage(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<Storage> {
  if (factory === undefined) return memoryStorage();
  try {
    const db = await openDatabase(factory);
    return idbStorage(factory, db);
  } catch (error) {
    console.warn("IndexedDB is not available; the web app keeps its state in memory", error);
    return memoryStorage();
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function idbStorage(factory: IDBFactory, first: IDBDatabase): Storage {
  let db: IDBDatabase | null = first;
  // A write that failed once falls back to memory for good: a database that
  // refused one write will refuse the next, and half the state in each place
  // would be worse than all of it in one.
  const fallback = memoryStorage();
  let broken = false;

  const handle = async (): Promise<IDBDatabase> => {
    if (db === null) db = await openDatabase(factory);
    return db;
  };

  // A connection another context asks to close (a deletion, an upgrade) goes.
  const watch = (connection: IDBDatabase) => {
    connection.onversionchange = () => {
      connection.close();
      if (db === connection) db = null;
    };
  };
  watch(first);

  async function run<T>(store: StoreName, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const connection = await handle();
    watch(connection);
    return done(work(connection.transaction(store, mode).objectStore(store)));
  }

  const guard = async <T>(label: string, primary: () => Promise<T>, backup: () => Promise<T>): Promise<T> => {
    if (broken) return backup();
    try {
      return await primary();
    } catch (error) {
      console.warn(`IndexedDB ${label} failed; the web app keeps its state in memory from now on`, error);
      broken = true;
      return backup();
    }
  };

  return {
    get durable() {
      return !broken;
    },
    get: <T>(store: StoreName, key: string) =>
      guard(
        "read",
        () => run<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
        () => fallback.get<T>(store, key),
      ),
    put: (store, key, value) =>
      guard(
        "write",
        async () => {
          await run(store, "readwrite", (s) => s.put(value, key));
        },
        () => fallback.put(store, key, value),
      ),
    delete: (store, key) =>
      guard(
        "delete",
        async () => {
          await run(store, "readwrite", (s) => s.delete(key));
        },
        () => fallback.delete(store, key),
      ),
    entries: <T>(store: StoreName) =>
      guard(
        "read",
        async () => {
          const connection = await handle();
          const objectStore = connection.transaction(store, "readonly").objectStore(store);
          const [keys, values] = await Promise.all([done(objectStore.getAllKeys()), done(objectStore.getAll())]);
          return keys.map((key, index) => ({ key: String(key), value: values[index] as T }));
        },
        () => fallback.entries<T>(store),
      ),
    wipe: async () => {
      await fallback.wipe();
      db?.close();
      db = null;
      broken = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const request = factory.deleteDatabase(DB_NAME);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
          // Another connection holds it; it closes on `versionchange` and
          // the deletion finishes then. Nothing here waits for that.
          request.onblocked = () => resolve();
        });
      } catch (error) {
        console.warn("Deleting the web app's database failed", error);
      }
    },
    close: () => {
      db?.close();
      db = null;
    },
  };
}

/** The same interface over maps, for a browser without IndexedDB. */
export function memoryStorage(): Storage {
  const stores = new Map<StoreName, Map<string, unknown>>();
  const of = (store: StoreName) => {
    let map = stores.get(store);
    if (map === undefined) {
      map = new Map();
      stores.set(store, map);
    }
    return map;
  };
  // Values are copied like IndexedDB copies them, so a caller that mutates
  // what it stored or read does not change the store behind its back.
  const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
  return {
    durable: false,
    get: async <T>(store: StoreName, key: string) => copy(of(store).get(key) as T | undefined),
    put: async (store, key, value) => {
      of(store).set(key, copy(value));
    },
    delete: async (store, key) => {
      of(store).delete(key);
    },
    entries: async <T>(store: StoreName) =>
      [...of(store).entries()].map(([key, value]) => ({ key, value: copy(value) as T })),
    wipe: async () => {
      stores.clear();
    },
    close: () => {},
  };
}
