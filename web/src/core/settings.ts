/**
 * `get_settings` and `update_settings` of the web core.
 *
 * The shared screens read the launcher's settings document: the active game,
 * the language, the chat notification switches. The web app answers with the
 * launcher's defaults (`src-tauri/src/settings.rs`, `impl Default for
 * Settings`) and three fields of its own preferences on top. A write may touch
 * only those three; anything else is a launcher setting, and asking the web
 * app to change it is a gating bug of the screen that asked.
 */

import { needsLauncher } from "./errors.ts";
import { EVENTS, type EventBus } from "./events.ts";
import type { PrefsStore } from "./prefs.ts";
import type { ChatNotifications, Game, Settings } from "../../../src/lib/ipc.ts";
import type { Language, LanguageSetting } from "../../../src/i18n/languages.ts";

/** `ChatNotifications::default()` of the launcher. */
export const DEFAULT_CHAT_NOTIFICATIONS: ChatNotifications = {
  inApp: true,
  os: true,
  sound: true,
  soundName: "default",
  showText: true,
  dnd: false,
  mentionsBreakDnd: false,
  dndInGame: true,
  summaryAfterGame: true,
  quietHours: null,
};

/** The settings document of a fresh launcher, for the service at `apiBase`. */
export function launcherDefaults(apiBase: string): Settings {
  return {
    gameDataPaths: {},
    activeGame: "ja",
    language: "system",
    defaultClientId: null,
    defaultClientIds: {},
    closeOnLaunch: false,
    libraryConflictNoticeDismissed: false,
    dataDirOverride: null,
    extraLaunchArgs: "",
    favoriteServers: [],
    serverHistory: [],
    hiddenServers: [],
    serverFilters: {
      gametype: "any",
      modName: "any",
      players: "any",
      protocol: "any",
      hideBotOnly: true,
      hidePassworded: false,
    },
    savedNicknames: [],
    onboardingCompleted: true,
    previewMode: "simple",
    onlineUrl: apiBase,
    onlineUser: null,
    hostDefaults: {},
    hostFirewallNoteSeen: false,
    chatDrawerPinned: false,
    chatAutoDownloadMb: 10,
    chatNotifications: { ...DEFAULT_CHAT_NOTIFICATIONS },
    closeToTray: false,
    closeToTrayHintSeen: true,
    startMinimized: false,
    chatOpenIn: "main",
  };
}

/** The fields `update_settings` accepts on the web. */
export const WEB_SETTINGS = ["language", "activeGame", "chatNotifications"] as const;

const LANGUAGES: readonly string[] = ["en", "ru", "uk", "de", "fr", "es", "pl", "hu"];

function isGame(value: unknown): value is Game {
  return value === "ja" || value === "jo";
}

function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === "system" || (typeof value === "string" && LANGUAGES.includes(value));
}

export interface SettingsCore {
  get(): Settings;
  /** Applies a patch of the three web fields and answers the new document. */
  update(patch: Record<string, unknown>): Promise<Settings>;
}

export function createSettings(options: {
  apiBase: string;
  prefs: PrefsStore;
  events: EventBus;
  /** The signed-in account, for `onlineUser`. */
  user: () => Settings["onlineUser"];
}): SettingsCore {
  const { apiBase, prefs, events } = options;

  const get = (): Settings => {
    const settings = launcherDefaults(apiBase);
    const locale = prefs.get("locale");
    if (locale !== undefined) settings.language = locale;
    const game = prefs.get("activeGame");
    if (isGame(game)) settings.activeGame = game;
    const chat = prefs.get("chatNotifications");
    if (chat !== undefined) settings.chatNotifications = { ...DEFAULT_CHAT_NOTIFICATIONS, ...chat };
    settings.onlineUser = options.user();
    return settings;
  };

  const update = async (patch: Record<string, unknown>): Promise<Settings> => {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    const foreign = fields.find(([name]) => !(WEB_SETTINGS as readonly string[]).includes(name));
    if (foreign !== undefined) throw needsLauncher(`update_settings.${foreign[0]}`);

    let chatChanged = false;
    for (const [name, value] of fields) {
      if (name === "language") {
        if (!isLanguageSetting(value)) throw needsLauncher("update_settings.language");
        await prefs.set("locale", value === "system" ? undefined : (value as Language));
      } else if (name === "activeGame") {
        if (!isGame(value)) throw needsLauncher("update_settings.activeGame");
        await prefs.set("activeGame", value);
      } else if (name === "chatNotifications") {
        const current = get().chatNotifications ?? DEFAULT_CHAT_NOTIFICATIONS;
        const next = { ...current, ...(value as Partial<ChatNotifications>) };
        chatChanged = JSON.stringify(next) !== JSON.stringify(current);
        await prefs.set("chatNotifications", next);
      }
    }

    const settings = get();
    if (chatChanged) {
      events.emit(EVENTS.chatNotifications, { chatNotifications: settings.chatNotifications });
    }
    return settings;
  };

  return { get, update };
}
