/**
 * Preferences of this device, in the `prefs` store.
 *
 * Read once when the core starts and kept in memory, so the settings
 * document is answered without a round trip to IndexedDB. A write goes to
 * both.
 *
 * `locale`, `sound` and `installHintHidden` belong to the device, not to
 * the account: they survive sign-out, which wipes the rest of the database
 * with the account's data.
 */

import type { Storage } from "./storage.ts";
import type { ChatNotifications, ChatSoundName, Game } from "../../../src/lib/ipc.ts";
import type { Language } from "../../../src/i18n/languages.ts";

/**
 * The chat sound of this browser: whether a message that notifies plays one,
 * and which of the launcher's sets. The web app's own switch: the launcher's
 * settings never reach it, and it never reaches them.
 */
export interface SoundPref {
  on: boolean;
  name: ChatSoundName;
}

export interface Prefs {
  locale?: Language;
  activeGame?: Game;
  sound?: SoundPref;
  toasts?: boolean;
  /** The chat's switches besides the sound, which `sound` keeps. */
  chatNotifications?: Partial<ChatNotifications>;
  pushSubscriptionId?: string;
  vapidKey?: string;
  /** The install hint of the chat list was put away on this device. */
  installHintHidden?: boolean;
}

export type PrefName = keyof Prefs;

/** The preferences that outlive a sign-out. */
export const DEVICE_PREFS: readonly PrefName[] = ["locale", "sound", "installHintHidden"];

export interface PrefsStore {
  get<K extends PrefName>(name: K): Prefs[K];
  set<K extends PrefName>(name: K, value: Prefs[K] | undefined): Promise<void>;
  /** Everything, for the settings document. */
  all(): Prefs;
  /** Puts back the device preferences after the database was wiped. */
  restoreDevicePrefs(): Promise<void>;
}

export async function loadPrefs(storage: Storage): Promise<PrefsStore> {
  const values: Prefs = {};
  try {
    for (const { key, value } of await storage.entries<unknown>("prefs")) {
      (values as Record<string, unknown>)[key] = value;
    }
  } catch (error) {
    console.warn("Reading the preferences failed", error);
  }

  return {
    get: (name) => values[name],
    set: async (name, value) => {
      if (value === undefined) {
        delete values[name];
        await storage.delete("prefs", name);
      } else {
        values[name] = value;
        await storage.put("prefs", name, value);
      }
    },
    all: () => ({ ...values }),
    restoreDevicePrefs: async () => {
      for (const [name, value] of Object.entries(values)) {
        if (!DEVICE_PREFS.includes(name as PrefName)) {
          delete (values as Record<string, unknown>)[name];
          continue;
        }
        if (value !== undefined) await storage.put("prefs", name, value);
      }
    },
  };
}
