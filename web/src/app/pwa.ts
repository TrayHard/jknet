/**
 * The service worker and the update flow of the installed app.
 *
 * A new build installs its worker next to the running one and waits. The
 * page shows **Update**; a click tells the waiting worker to take over and
 * reloads once it has. A hidden tab with nothing to lose — an empty outbox,
 * no staged files — takes the update by itself. `version.json` may demand a
 * newer build (`minBuiltAt`): the app then blocks on an update screen. A
 * chunk that fails to load after a deployment reloads the page once.
 */

export interface UpdateState {
  /** A new version is installed and waits for the page. */
  waiting: boolean;
  /** This build is older than the service allows. */
  required: boolean;
}

/** How often the page looks for a new build while it is on screen. */
export const CHECK_EVERY_MS = 30 * 60_000;
const PRELOAD_RELOAD_KEY = "jknet-preload-reload";

let state: UpdateState = { waiting: false, required: false };
const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | null = null;
let applying = false;

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

export function updateState(): UpdateState {
  return state;
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether `minBuiltAt` of `version.json` is newer than this build. */
export function isTooOld(minBuiltAt: unknown, builtAt: string): boolean {
  if (typeof minBuiltAt !== "string") return false;
  const minimum = Date.parse(minBuiltAt);
  const built = Date.parse(builtAt);
  return !Number.isNaN(minimum) && !Number.isNaN(built) && minimum > built;
}

async function checkVersion(): Promise<void> {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return;
    const version = (await response.json()) as { minBuiltAt?: unknown };
    if (isTooOld(version.minBuiltAt, __BUILD_AT__)) set({ required: true });
  } catch {
    // Offline: the next check asks again.
  }
}

/** Takes the waiting version: the page reloads once the new worker controls it. */
export function applyUpdate(): void {
  applying = true;
  const waiting = registration?.waiting;
  if (waiting) {
    waiting.postMessage({ type: "SKIP_WAITING" });
    return;
  }
  // No worker waits (a browser without service workers, a required update
  // found before its worker): a reload fetches the new shell.
  window.location.reload();
}

/**
 * Registers `/sw.js` and watches for updates. Runs after the first render;
 * `canAutoApply` answers whether nothing would be lost by a reload now.
 */
export async function startPwa(canAutoApply: () => boolean): Promise<void> {
  window.addEventListener("vite:preloadError", (event) => {
    try {
      if (sessionStorage.getItem(PRELOAD_RELOAD_KEY) !== null) return;
      sessionStorage.setItem(PRELOAD_RELOAD_KEY, "1");
    } catch {
      return;
    }
    event.preventDefault();
    window.location.reload();
  });
  // A page that loaded fine clears the guard for the next deployment.
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
    } catch {
      // Storage refused: the guard simply stays.
    }
  }, 10_000);

  void checkVersion();
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void checkVersion();
    void registration?.update().catch(() => undefined);
  }, CHECK_EVERY_MS);

  const workers = navigator.serviceWorker;
  if (workers === undefined) return;

  workers.addEventListener("controllerchange", () => {
    if (!applying) return;
    applying = false;
    window.location.reload();
  });

  try {
    registration = await workers.register("/sw.js", { scope: "/" });
  } catch (error) {
    console.warn("The service worker did not register", error);
    return;
  }

  const noteWaiting = () => {
    if (registration?.waiting && workers.controller) set({ waiting: true });
  };
  noteWaiting();
  registration.addEventListener("updatefound", () => {
    const installing = registration?.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed") noteWaiting();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.waiting && canAutoApply()) applyUpdate();
  });
}
