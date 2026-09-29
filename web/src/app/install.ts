/**
 * Installing the web app on this device.
 *
 * - Chromium (Android, desktop) offers the install with `beforeinstallprompt`;
 *   the page keeps the event and **Install** of the settings replays it.
 * - iPhone and iPad have no such event: the player adds the app from the
 *   Share menu. Push reaches an iPhone only in the app on the Home Screen,
 *   iOS 16.4 or later, so a Safari tab shows the steps instead of the
 *   notifications switch.
 * - Installed, the app runs in its own window (`display-mode: standalone`).
 */

/** The event Chromium fires when the app may be installed. Not in the DOM types. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallState {
  /** The app runs from the home screen or its own window. */
  standalone: boolean;
  /** iPhone or iPad. */
  ios: boolean;
  /** The browser offered the install: **Install** works. */
  canPrompt: boolean;
  /** The browser said the app was installed during this visit. */
  installed: boolean;
}

/** What tells the platform apart; pure, so `install.test.mjs` checks it. */
export interface PlatformSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
}

/**
 * Whether a device is an iPhone or an iPad. An iPad asks for the desktop
 * site by default and names itself a Mac; the touch screen gives it away.
 */
export function isIos(signals: PlatformSignals): boolean {
  if (/iPhone|iPad|iPod/.test(signals.userAgent)) return true;
  return signals.platform === "MacIntel" && signals.maxTouchPoints > 1;
}

/** An iPhone or iPad in a browser tab: push needs the app on the Home Screen first. */
export function needsHomeScreen(state: Pick<InstallState, "ios" | "standalone">): boolean {
  return state.ios && !state.standalone;
}

function signals(): PlatformSignals {
  if (typeof navigator === "undefined") return { userAgent: "", platform: "", maxTouchPoints: 0, standalone: false };
  const standaloneMedia = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  const safariStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: standaloneMedia || safariStandalone,
  };
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let state: InstallState | null = null;
const listeners = new Set<() => void>();
let watching = false;

function changed(): void {
  state = null;
  for (const listener of [...listeners]) listener();
}

/** Starts listening for the browser's offer. Called once, at boot. */
export function watchInstall(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    // The browser's own banner stays away; **Install** of the settings asks.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    changed();
  });
}

export function installState(): InstallState {
  if (state === null) {
    const now = signals();
    state = { standalone: now.standalone, ios: isIos(now), canPrompt: deferred !== null, installed };
  }
  return state;
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** **Install**: the browser's own dialog. The offer is spent either way. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const offer = deferred;
  if (offer === null) return "unavailable";
  deferred = null;
  changed();
  await offer.prompt();
  const choice = await offer.userChoice;
  return choice.outcome;
}
