/**
 * The route and the rules of the chat window.
 *
 * --- slice: chat window ---
 *
 * The chat window is a second Tauri window showing the same bundle at
 * `#/chat` or `#/chat/<conversationId>`; the core builds it and labels it
 * `chat` (`src-tauri/src/chat/window.rs`). What there is to know about that
 * route and about the window's two modes lives here, with no React and no
 * Tauri in it, so the rules can be tested on their own:
 *
 * - [`chatRoute`] builds the route: the window keeps the conversation it
 *   shows in its address, so a reload opens it again;
 * - [`isChatWindowHash`] recognises it, which is how `App` decides that this
 *   document is the chat window and not the launcher;
 * - [`conversationOfPath`] reads the conversation back out of it;
 * - [`nextSelection`] is what a request to show a conversation does in each
 *   mode;
 * - [`seeThrough`] and [`rootOpacity`] say when the page paints itself
 *   translucent, and how much.
 */

import type { ChatWindowView } from "./ipc";

/** The label of the chat window, as the core builds it and the capability names it. */
export const CHAT_WINDOW_LABEL = "chat";

/**
 * A conversation id fit for the route: the letters of a ULID and the two
 * marks the core also lets through, at most 64 of them. The core refuses
 * anything else before it builds the window, so a route that does not match
 * was typed by hand.
 */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The hash route of the chat window, without the leading `#`. */
export function chatRoute(conversationId: string | null = null): string {
  return conversationId !== null && CONVERSATION_ID.test(conversationId)
    ? `/chat/${conversationId}`
    : "/chat";
}

/**
 * True when this document was opened as the chat window.
 *
 * The initial hash, read once, as for the client window: `#/chat` for the
 * list, `#/chat/<id>` for one conversation. `#/chats` or any other screen of
 * the launcher is not it.
 */
export function isChatWindowHash(hash: string): boolean {
  return hash === "#/chat" || hash.startsWith("#/chat/") || hash.startsWith("#/chat?");
}

/** The conversation a route of the chat window names, or `null` for the list. */
export function conversationOfPath(pathname: string): string | null {
  const match = /^\/chat\/([^/?#]+)\/?$/.exec(pathname);
  if (match === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return CONVERSATION_ID.test(id) ? id : null;
}

/**
 * What the window shows after a request to show `requested`: a **Message**
 * button, a search hit, or the core's `chat:open`.
 *
 * A conversation is shown in either mode. A request for the list — the tray's
 * **Open chats**, say — clears the thread only in the compact mode, where the
 * list and the thread take turns. In the full mode the list is on screen
 * beside the thread already, and the thread the player was reading stays.
 */
export function nextSelection(
  current: string | null,
  requested: string | null,
  compact: boolean,
): string | null {
  if (requested !== null) return requested;
  return compact ? null : current;
}

/** The opacity slider of the compact mode, in percent, as the core accepts it. */
export const OPACITY_MIN = 40;
export const OPACITY_MAX = 100;
export const OPACITY_STEP = 5;

/**
 * A value of the slider as the core takes it: on a step, within the range.
 * Anything that is not a number is fully opaque.
 */
export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return OPACITY_MAX;
  const stepped = Math.round(value / OPACITY_STEP) * OPACITY_STEP;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, stepped));
}

/**
 * Whether the desktop shows through the window: the compact mode below
 * 100 %. The core then makes the webview background transparent, and the page
 * has to paint `html` and `body` transparent too, or nothing shows through.
 */
export function seeThrough(view: Pick<ChatWindowView, "compact" | "opacity">): boolean {
  return view.compact && clampOpacity(view.opacity) < OPACITY_MAX;
}

/** The CSS opacity of the page's root: 1 unless the window is see-through. */
export function rootOpacity(view: Pick<ChatWindowView, "compact" | "opacity">): number {
  return seeThrough(view) ? clampOpacity(view.opacity) / 100 : 1;
}

/**
 * The window as the page assumes it until the core answers: the full mode,
 * opaque, where it stays when the core cannot be asked at all.
 */
export const DEFAULT_CHAT_WINDOW: ChatWindowView = {
  open: true,
  compact: false,
  alwaysOnTop: false,
  opacity: 90,
};
