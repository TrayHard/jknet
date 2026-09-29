/**
 * Where a click on a notification leads.
 *
 * A window of the app is open: it comes to the front and is told the
 * address (`{type: "open", url}`), which the layout navigates to; the chat
 * list, a draft or a half-read thread stay where they were. No window: a
 * new one opens on the address and the app starts right there.
 *
 * Only a path of the app is ever opened: an address the payload could bend
 * elsewhere falls back to the chats. Pure, so `click.test.mjs` checks it.
 */

/** The window-client fields the choice reads. */
export interface WindowInfo {
  focused: boolean;
  visibilityState: DocumentVisibilityState;
  /** It answered that the app runs in it: not a frozen page, not the one-tab gate. */
  live?: boolean;
}

export type ClickPlan = { action: "focus"; index: number; url: string } | { action: "open"; url: string };

/** Where every notification without a usable address leads. */
export const FALLBACK_URL = "/chats";

/**
 * A path of this app, or `null`: a single leading `/`, no scheme, no
 * protocol-relative `//`, no backslash a browser would read as one.
 */
export function appPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}

/**
 * The window to bring forward: among the windows that run the app (all of
 * them when none answered), a focused one, else a visible one, else the most
 * recent. A tab showing "open in another tab" has no layout to open the
 * address in.
 */
export function clickPlan(windows: readonly WindowInfo[], rawUrl: unknown): ClickPlan {
  const url = appPath(rawUrl) ?? FALLBACK_URL;
  if (windows.length === 0) return { action: "open", url };
  const anyLive = windows.some((window) => window.live === true);
  const indexes = windows.flatMap((window, index) => (!anyLive || window.live === true ? [index] : []));
  let index = indexes.find((at) => windows[at].focused);
  index ??= indexes.find((at) => windows[at].visibilityState === "visible");
  index ??= indexes[0];
  return { action: "focus", index, url };
}
