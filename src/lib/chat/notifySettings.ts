/**
 * The chat switches of the Settings screen, read and written.
 *
 * --- slice: chat notifications ---
 *
 * The core keeps them in `settings.json` (`src-tauri/src/settings.rs`) and
 * decides alone what a message does with them (`chat::notify::decide`). The
 * screen only shows them and sends a patch of the switch that moved, so this
 * module is what it needs to do that well:
 *
 * - the defaults a fresh launcher ships, for a document written by a core
 *   that predates a field ([`chatNotificationsOf`] and its siblings);
 * - the clock of quiet hours, parsed the way the core parses it
 *   ([`parseClock`], [`normalizeClock`]) and described ([`quietHoursShape`],
 *   [`isQuietAt`]);
 * - the optimistic copy of a patch ([`applyChatPatch`]), so a switch moves
 *   under the pointer instead of one round trip later;
 * - the options of **Download pictures automatically** and the list of the
 *   chats whose level is not **All messages** ([`mutedChats`]).
 *
 * No React and no Tauri: `notifySettings.test.mjs` runs it under `node --test`.
 */

import type {
  ChatNotifications,
  ChatOpenIn,
  ChatSoundName,
  Conversation,
  QuietHours,
  Settings,
  SettingsPatch,
} from "../ipc";

/** The three sets of `src-tauri/resources/sounds/`, in the order the picker lists them. */
export const CHAT_SOUNDS: readonly ChatSoundName[] = ["default", "saber", "comlink"];

/** What the quiet-hours switch offers when it goes on, as the core's `QuietHours::default`. */
export const DEFAULT_QUIET_HOURS: QuietHours = { from: "23:00", to: "08:00" };

/** The switches of a fresh install, as `ChatNotifications::default` in the core. */
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

/** The close button hides into the tray on a fresh install (D6). */
export const DEFAULT_CLOSE_TO_TRAY = true;
/** A launcher Windows started stays in the tray on a fresh install. */
export const DEFAULT_START_MINIMIZED = true;
/** Chats open in the launcher window unless the player picks the separate one. */
export const DEFAULT_CHAT_OPEN_IN: ChatOpenIn = "main";
/** Pictures up to this many MiB download by themselves until the player moves it. */
export const DEFAULT_AUTO_DOWNLOAD_MB = 10;
/** The largest file a chat carries, and the most the core accepts. */
export const MAX_AUTO_DOWNLOAD_MB = 25;
/** The steps of **Download pictures automatically**; 0 turns it off. */
export const AUTO_DOWNLOAD_STEPS: readonly number[] = [0, 1, 5, 10, 25];

export function isChatSound(value: unknown): value is ChatSoundName {
  return typeof value === "string" && (CHAT_SOUNDS as readonly string[]).includes(value);
}

/**
 * The notification switches of a settings document, every one of them set.
 *
 * A block missing a switch, or missing altogether, reads as the defaults,
 * as it does in the core (`#[serde(default)]`); a sound this build does not
 * ship reads as the one the core then plays, the default.
 */
export function chatNotificationsOf(settings: Settings | undefined | null): ChatNotifications {
  const stored = settings?.chatNotifications;
  const merged: ChatNotifications = { ...DEFAULT_CHAT_NOTIFICATIONS, ...(stored ?? {}) };
  if (!isChatSound(merged.soundName)) merged.soundName = DEFAULT_CHAT_NOTIFICATIONS.soundName;
  if (merged.quietHours === undefined) merged.quietHours = null;
  return merged;
}

/** The close button: `true` hides into the tray. */
export function closeToTrayOf(settings: Settings | undefined | null): boolean {
  return settings?.closeToTray ?? DEFAULT_CLOSE_TO_TRAY;
}

/** Whether a start with Windows stays in the tray. */
export function startMinimizedOf(settings: Settings | undefined | null): boolean {
  return settings?.startMinimized ?? DEFAULT_START_MINIMIZED;
}

/** Where chats open from the tray; an unknown value reads as `main`, as in the core. */
export function chatOpenInOf(settings: Settings | undefined | null): ChatOpenIn {
  return settings?.chatOpenIn === "window" ? "window" : DEFAULT_CHAT_OPEN_IN;
}

/** The size up to which pictures download by themselves, in MiB. */
export function autoDownloadOf(settings: Settings | undefined | null): number {
  const value = settings?.chatAutoDownloadMb;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), MAX_AUTO_DOWNLOAD_MB)
    : DEFAULT_AUTO_DOWNLOAD_MB;
}

/**
 * The steps of the picker with the value in force among them: a value
 * written by hand, 3 MiB say, is listed rather than shown as a blank.
 */
export function autoDownloadOptions(current: number): number[] {
  const steps = new Set(AUTO_DOWNLOAD_STEPS);
  steps.add(current);
  return [...steps].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The clock of quiet hours
// ---------------------------------------------------------------------------

const MINUTES_PER_DAY = 24 * 60;

/**
 * `H:MM` or `HH:MM` of a 24-hour clock as minutes since midnight, `null`
 * for anything else: the rule of the core's `parse_clock`, so the screen
 * refuses what `update_settings` would refuse.
 */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since midnight as `HH:MM`. */
export function formatClock(minutes: number): string {
  const within = ((Math.floor(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(within / 60);
  const rest = within % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** A time as the core stores it, `HH:MM`, or `null` when it is not a time. */
export function normalizeClock(text: string): string | null {
  const minutes = parseClock(text);
  return minutes === null ? null : formatClock(minutes);
}

/**
 * A stored time as the language on screen writes it: `8:00 AM` in English,
 * `08:00` in Russian. What is not a time comes back as it is.
 */
export function clockLabel(text: string, locale: string): string {
  const minutes = parseClock(text);
  if (minutes === null) return text;
  const moment = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(moment);
}

/**
 * What a range of quiet hours is: `empty` when its ends are equal (never
 * quiet), `overnight` when it runs across midnight, `sameDay` otherwise, and
 * `invalid` when an end is not a time (the core then keeps no quiet hours).
 */
export type QuietHoursShape = "empty" | "sameDay" | "overnight" | "invalid";

export function quietHoursShape(range: QuietHours): QuietHoursShape {
  const from = parseClock(range.from);
  const to = parseClock(range.to);
  if (from === null || to === null) return "invalid";
  if (from === to) return "empty";
  return to < from ? "overnight" : "sameDay";
}

/**
 * Whether a moment of the day, in minutes since midnight, is inside the
 * range: from its start up to, not including, its end.
 */
export function isQuietAt(range: QuietHours | null, minutes: number): boolean {
  if (range === null) return false;
  const from = parseClock(range.from);
  const to = parseClock(range.to);
  if (from === null || to === null || from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** Minutes since local midnight of a date. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Why notifications are silent at this moment, if they are: the switch,
 * the clock, or both. The card says it at the top, since the tray flips
 * **Do not disturb** without opening the screen.
 */
export type Silence = "none" | "dnd" | "quiet" | "both";

export function silenceAt(notifications: ChatNotifications, minutes: number): Silence {
  const quiet = isQuietAt(notifications.quietHours, minutes);
  if (notifications.dnd && quiet) return "both";
  if (notifications.dnd) return "dnd";
  return quiet ? "quiet" : "none";
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/**
 * The document as it will be once the core applied the patch, for the
 * optimistic copy in the query cache. Only what the chat cards send is
 * merged the way the core merges it (the notification block one switch at
 * a time); every other field of the patch is copied as it is.
 */
export function applyChatPatch(settings: Settings, patch: SettingsPatch): Settings {
  const { chatNotifications, ...rest } = patch;
  const next = { ...settings, ...(rest as Partial<Settings>) };
  if (chatNotifications !== undefined) {
    next.chatNotifications = { ...chatNotificationsOf(settings), ...chatNotifications };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Chats with their own level
// ---------------------------------------------------------------------------

/**
 * The chats whose notification level is not **All messages**: muted ones
 * first, then those that notify about mentions only, each by title in the
 * order of the language on screen.
 */
export function mutedChats(
  conversations: readonly Conversation[],
  title: (conversation: Conversation) => string,
  locale?: string,
): Conversation[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  const rank = (conversation: Conversation) => (conversation.notify === "mute" ? 0 : 1);
  return conversations
    .filter((conversation) => conversation.notify !== "all")
    .map((conversation) => ({ conversation, title: title(conversation) }))
    .sort((a, b) => rank(a.conversation) - rank(b.conversation) || collator.compare(a.title, b.title))
    .map((entry) => entry.conversation);
}
