/**
 * What the page shows, as `chat_set_viewing` reports it: the conversation,
 * whether the window has the focus, whether the thread is at its bottom and
 * whether a composer is there.
 *
 * A conversation is seen — its new messages read the moment they land, and
 * notified by nothing — when the tab is visible, the document focused, the
 * thread at its bottom and the conversation the one on screen. The launcher
 * keeps one such record per window; the web app has one window.
 */

export interface Viewing {
  conversationId: string | null;
  focused: boolean;
  atBottom: boolean;
  composer: boolean;
}

export const NOT_VIEWING: Viewing = Object.freeze({ conversationId: null, focused: false, atBottom: false, composer: false });

/** Reads the arguments of `chat_set_viewing`. */
export function viewingOf(args: Record<string, unknown>): Viewing {
  const id = typeof args.conversationId === "string" && args.conversationId.trim() !== "" ? args.conversationId : null;
  return {
    conversationId: id,
    focused: args.focused === true,
    atBottom: args.atBottom === true,
    composer: args.composer === true,
  };
}

/** Whether this conversation is seen right now, in a tab that is `visible`. */
export function sees(viewing: Viewing, conversationId: string, visible: boolean): boolean {
  return visible && viewing.focused && viewing.atBottom && viewing.conversationId === conversationId;
}
