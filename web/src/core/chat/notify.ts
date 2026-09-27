/**
 * What a chat message deserves: a port of `decide`, the pace and the words
 * of the launcher's `src-tauri/src/chat/notify.rs`, without what only a
 * launcher knows (a game running, the summary after it, other windows).
 *
 * `decide` is pure; `notify.test.mjs` runs every case of
 * `src/lib/chat/fixtures/notify-decide.json` not marked `launcherOnly`. In
 * order, the first rule that matches wins:
 *
 * 1. The player's own message, or a system message: nothing.
 * 2. A muted conversation, or one set to mentions only, and no mention:
 *    nothing. A mention, or a reply to the player, is "mentioned".
 * 3. The conversation is on screen at its bottom: nothing, it is read.
 * 4. **Do not disturb** or quiet hours (local time, across midnight):
 *    nothing, unless it mentions the player and **Mentions break through**
 *    is on (D7).
 * 5. Otherwise a toast on the page while the tab is on screen, a system
 *    notification while it is not, and a sound.
 *
 * How the page carries it out lives in the core (`chat/index.ts`): the
 * toast is `chat:notify`; the sound plays whenever the app is open, the tab
 * visible or not, unless this browser's sound is off (`prefs.sound`); the
 * system notification is shown by the page only when this device has no
 * push subscription; with one, push is the only system notification.
 */

import type { ChatMessage, ChatNotifications, Conversation } from "../../../../src/lib/ipc.ts";
import { isQuietAt } from "../../../../src/lib/chat/notifySettings.ts";
import { isFrom, isUser } from "./wire.ts";

/** One conversation raises at most one system notification this often, unless it mentions the player. */
export const OS_PACE_MS = 3_000;
/** Sounds do not overlap: a burst of messages is one chime. */
export const SOUND_PACE_MS = 1_000;
/** The longest text a toast carries. */
export const MAX_TEXT_CHARS = 200;

export interface Incoming {
  own: boolean;
  system: boolean;
  /** It mentions the player or replies to a message of the player. */
  mentioned: boolean;
}

export function incomingOf(message: ChatMessage, me: string | null): Incoming {
  const mentioned =
    me !== null &&
    (message.mentions.includes(me) || (message.replyTo !== null && message.replyTo.senderId === me));
  return { own: isFrom(message, me), system: !isUser(message), mentioned };
}

export type Level = "all" | "mentions" | "mute";

/** A value a newer service sends notifies like `all`: a missed message is worse than one toast too many. */
export function levelOf(notify: string): Level {
  return notify === "mute" ? "mute" : notify === "mentions" ? "mentions" : "all";
}

export interface ConvCtx {
  notify: Level;
  /** On screen, at its bottom, in a visible tab. */
  viewed: boolean;
}

export interface NotifyCtx {
  /** Minutes since local midnight. */
  minuteOfDay: number;
  /** The tab is on screen. */
  focused: boolean;
}

export interface Delivery {
  /** A toast on the page. */
  inApp: boolean;
  /** A system notification. */
  os: boolean;
  sound: boolean;
}

export const SILENT: Delivery = Object.freeze({ inApp: false, os: false, sound: false });

export function isSilent(delivery: Delivery): boolean {
  return !delivery.inApp && !delivery.os && !delivery.sound;
}

export function decide(msg: Incoming, conv: ConvCtx, s: ChatNotifications, ctx: NotifyCtx): Delivery {
  if (msg.own || msg.system) return SILENT;
  if ((conv.notify === "mute" || conv.notify === "mentions") && !msg.mentioned) return SILENT;
  if (conv.viewed) return SILENT;
  const quiet = s.dnd || isQuietAt(s.quietHours ?? null, ctx.minuteOfDay);
  if (quiet && !(msg.mentioned && s.mentionsBreakDnd)) return SILENT;
  return { inApp: s.inApp && ctx.focused, os: s.os && !ctx.focused, sound: s.sound };
}

/** The pace of system notifications and sounds, per core. */
export class NotifyPace {
  private readonly lastOs = new Map<string, number>();
  private lastSound: number | null = null;

  /** Thins a delivery out: a system notification per conversation every 3 s unless it mentions, a sound every 1 s. */
  pace(conversationId: string, mentioned: boolean, now: number, delivery: Delivery): Delivery {
    const out = { ...delivery };
    if (out.os) {
      const at = this.lastOs.get(conversationId);
      if (at !== undefined && now - at < OS_PACE_MS && !mentioned) out.os = false;
      else this.lastOs.set(conversationId, now);
    }
    if (out.sound) {
      if (this.lastSound !== null && now - this.lastSound < SOUND_PACE_MS) out.sound = false;
      else this.lastSound = now;
    }
    return out;
  }

  clear(): void {
    this.lastOs.clear();
    this.lastSound = null;
  }
}

/** The words a notification is made of, in the language on screen. */
export interface NotifyTexts {
  newMessage: string;
  deletedAccount: string;
}

function collapse(text: string): string {
  return text.split(/\s+/u).filter((part) => part !== "").join(" ");
}

function isBidi(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** One printable line: white space collapsed, control characters and bidirectional overrides dropped. */
function line(text: string): string {
  return [...collapse(text)]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f)) && !isBidi(code);
    })
    .join("");
}

function cut(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function nameOf(userId: string | null, conversation: Conversation | undefined, texts: NotifyTexts): string {
  if (userId === null) return texts.deletedAccount;
  const name = conversation?.members.find((member) => member.user.id === userId)?.user.displayName.trim() ?? "";
  return name !== "" ? name : "JKNet";
}

/** Replaces `<@id>` and `<@deleted>` with the names of the members. */
function namesForMentions(body: string, conversation: Conversation | undefined, texts: NotifyTexts): string {
  return body.replace(/<@([^>\s]{1,64})>/g, (_, id: string) =>
    `@${id === "deleted" ? texts.deletedAccount : nameOf(id, conversation, texts)}`,
  );
}

function preview(message: ChatMessage, conversation: Conversation | undefined, texts: NotifyTexts): string {
  let text = collapse(namesForMentions(message.body, conversation, texts));
  if (text === "") {
    for (const card of message.cards) {
      const fallback = typeof card.fallbackText === "string" ? collapse(card.fallbackText) : "";
      if (fallback !== "") {
        text = fallback;
        break;
      }
    }
  }
  if (text === "" && message.files.length > 0) text = collapse(message.files.map((file) => file.name).join(", "));
  if (text === "") text = texts.newMessage;
  return cut(text, MAX_TEXT_CHARS);
}

/**
 * The title and the text of a notification. A direct chat is titled with the
 * sender; a group or a server chat with its title, the sender in front of
 * the text. `showText` off, the text only says that a message came.
 */
export function compose(
  message: ChatMessage,
  conversation: Conversation | undefined,
  showText: boolean,
  texts: NotifyTexts,
): { title: string; text: string } {
  const sender = nameOf(message.senderId, conversation, texts);
  const own = conversation !== undefined && conversation.kind !== "direct" ? (conversation.title ?? "").trim() : "";
  const text = showText ? preview(message, conversation, texts) : texts.newMessage;
  if (own !== "") return { title: line(own), text: line(showText ? `${sender}: ${text}` : text) };
  return { title: line(sender), text: line(text) };
}
