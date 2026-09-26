import { createContext, use } from "react";

import type { ChatMessage, Conversation } from "../../lib/ipc";

/**
 * --- slice: chat ---
 *
 * What every message of an open thread may need from the thread around it:
 * the conversation, my id, and the three things a message can ask the thread
 * to do — quote it in the composer, scroll to another message, open a link.
 * A context rather than props through four layers of groups and items.
 */
export interface ThreadActions {
  conversation: Conversation;
  meId: string | null;
  /** **Reply**: the message goes into the reply bar of the composer. */
  onReply: (message: ChatMessage) => void;
  /** A click on a quote: scroll to the original, loading it when needed. */
  onJump: (seq: number) => void;
  /** A click on a link of a message. */
  onLink: (href: string) => void;
  /** The message a jump landed on, drawn highlighted for a moment. */
  highlightSeq: number | null;
  /** My newest message, the one that carries the read marks. */
  readMarkSeq: number | null;
}

export const ThreadContext = createContext<ThreadActions | null>(null);

export function useThread(): ThreadActions {
  const actions = use(ThreadContext);
  if (actions === null) throw new Error("a message is drawn outside a thread");
  return actions;
}
