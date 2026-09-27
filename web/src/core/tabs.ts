/**
 * One active tab per browser.
 *
 * The core holds the socket, the outbox and the drafts, and two tabs running
 * it would send every queued message twice. The Web Locks API gives the
 * `jknet-active` lock to one tab; another tab shows "JKNet is open in another
 * tab" with **Open here**. That button posts `takeover` on the `jknet`
 * broadcast channel: the holder stops its core, lets the lock go and shows
 * the same screen, and the asking tab gets the lock.
 *
 * A browser without `navigator.locks` runs without the gate. Sign-out in one
 * tab posts `signed-out`, and every other tab reloads onto the sign-in.
 */

export const LOCK_NAME = "jknet-active";
export const CHANNEL_NAME = "jknet";

export type TabMessage = { type: "takeover" } | { type: "signed-out" };

export interface TabGate {
  /** Whether this tab holds the lock right now. */
  active(): boolean;
  /**
   * Tries for the lock without waiting; answers whether this tab got it.
   * Calls that overlap share one request and one answer.
   */
  tryAcquire(): Promise<boolean>;
  /** Asks the holder to give the lock up, then waits for it; at once when this tab holds it. */
  takeOver(): Promise<void>;
  /** Tells the other tabs this one signed out. */
  announceSignOut(): void;
  /** `lost`: another tab took over; `signedOut`: another tab signed out. */
  subscribe(listener: (event: "lost" | "signedOut") => void): () => void;
}

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>;
}

export function createTabGate(options: {
  /** `null`: a browser without Web Locks. Absent: `navigator.locks`. */
  locks?: LockManagerLike | null;
  channel?: { postMessage(message: TabMessage): void; addEventListener(type: "message", listener: (event: MessageEvent) => void): void } | null;
  /** Runs before the lock goes: stop the core, flush what is pending. */
  release: () => Promise<void>;
} = { release: async () => {} }): TabGate {
  const locks =
    options.locks === null
      ? undefined
      : (options.locks ??
        (typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManagerLike }).locks : undefined));
  const channel =
    options.channel !== undefined
      ? options.channel
      : typeof BroadcastChannel === "function"
        ? new BroadcastChannel(CHANNEL_NAME)
        : null;
  const listeners = new Set<(event: "lost" | "signedOut") => void>();
  let holding = locks === undefined;
  let letGo: (() => void) | null = null;
  // The request in flight, if any. Overlapping calls share it: React runs an
  // effect twice in development, and two requests from one tab would race
  // each other, the loser gating the tab whose own twin holds the lock.
  let acquiring: Promise<boolean> | null = null;
  let takingOver: Promise<void> | null = null;

  const notify = (event: "lost" | "signedOut") => {
    for (const listener of [...listeners]) listener(event);
  };

  /** Holds the lock until `letGo` runs. */
  const hold = (lock: unknown): Promise<void> | false => {
    if (lock === null) return false;
    holding = true;
    return new Promise<void>((resolve) => {
      letGo = () => {
        holding = false;
        letGo = null;
        resolve();
      };
    });
  };

  channel?.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as TabMessage | undefined;
    if (message?.type === "takeover" && holding && letGo !== null) {
      const release = letGo;
      // A second request arriving while the core stops finds nothing to let go.
      letGo = null;
      void options
        .release()
        .catch((error: unknown) => console.warn("Stopping this tab's core failed", error))
        .finally(() => {
          release();
          notify("lost");
        });
    } else if (message?.type === "signed-out") {
      notify("signedOut");
    }
  });

  /** Asks for the lock without waiting; `true` when this tab got it. */
  const acquire = (lockManager: LockManagerLike) =>
    new Promise<boolean>((resolve) => {
      void lockManager
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          const held = hold(lock);
          resolve(held !== false);
          return held === false ? undefined : held;
        })
        .catch(() => resolve(false));
    });

  /** Queues for the lock, then asks the holder to let it go. */
  const queueAndAsk = async (lockManager: LockManagerLike) => {
    // An acquire still in flight may be granting this tab the lock already.
    if (acquiring !== null) await acquiring;
    if (holding) return;
    await new Promise<void>((resolve) => {
      // Queue for the lock first, then ask the holder to let it go: the
      // lock goes to the first request waiting for it.
      void lockManager.request(LOCK_NAME, {}, (lock) => {
        const held = hold(lock);
        resolve();
        return held === false ? undefined : held;
      });
      channel?.postMessage({ type: "takeover" });
    });
  };

  return {
    active: () => holding,
    tryAcquire: () => {
      if (locks === undefined || holding) return Promise.resolve(true);
      // A takeover in flight ends with this tab holding the lock.
      if (takingOver !== null) return takingOver.then(() => holding);
      acquiring ??= acquire(locks).finally(() => {
        acquiring = null;
      });
      return acquiring;
    },
    takeOver: () => {
      // The holder is this tab: nothing to ask for.
      if (locks === undefined || holding) return Promise.resolve();
      takingOver ??= queueAndAsk(locks).finally(() => {
        takingOver = null;
      });
      return takingOver;
    },
    announceSignOut: () => channel?.postMessage({ type: "signed-out" }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
