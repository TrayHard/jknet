/**
 * The chat sounds, played by the page: the launcher's three sets
 * (`src-tauri/resources/sounds/<name>/{message,mention}.wav`), which the
 * build config (`web/vite.config.ts`) copies to
 * `web/public/sounds/<name>-<kind>.wav` and the service worker caches with
 * the shell.
 *
 * The page plays them whenever the app is open — a visible tab, a tab in the
 * background, a minimized browser — unless this browser's sound is off
 * (`prefs.sound`, the web app's own setting). A browser plays a sound only
 * after the player has touched the page once; a refusal is quiet. A browser
 * driven by automation (tests, screenshots) never plays one.
 */

import { isChatSound } from "../../../../src/lib/chat/notifySettings.ts";

/** Where the sound of a set lies, the default set for a name this build does not know. */
export function soundUrl(name: string, mentioned: boolean): string {
  const set = isChatSound(name) ? name : "default";
  return `/sounds/${set}-${mentioned ? "mention" : "message"}.wav`;
}

/** Whether this page may make a sound at all: not under automation, not without audio. */
export function maySound(): boolean {
  if (typeof Audio === "undefined") return false;
  return !(typeof navigator !== "undefined" && navigator.webdriver);
}

/** Plays a chat sound, if the page may. */
export function playSound(name: string, mentioned: boolean): void {
  if (!maySound()) return;
  try {
    const audio = new Audio(soundUrl(name, mentioned));
    void audio.play().catch(() => undefined);
  } catch {
    // No audio on this device.
  }
}
