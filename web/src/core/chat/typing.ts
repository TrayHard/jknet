/**
 * Typing hints this device sends: one frame per conversation every 3 s at
 * most, as `chat_typing` of the launcher sends them. Whether a hint may go
 * at all (the player shares typing and may write there) is the book's call;
 * a hint with no socket to carry it is dropped.
 */

/** How often a typing hint for one conversation goes out. */
export const TYPING_THROTTLE_MS = 3_000;

/** The frame of a typing hint, as the socket carries it to the service. */
export function typingFrame(conversationId: string): { type: string; payload: { conversationId: string } } {
  return { type: "chat.typing", payload: { conversationId } };
}

export class TypingThrottle {
  private readonly sent = new Map<string, number>();

  /** Whether a hint for this conversation may go now; notes it when it may. */
  take(conversationId: string, now: number): boolean {
    const at = this.sent.get(conversationId);
    if (at !== undefined && now - at < TYPING_THROTTLE_MS) return false;
    this.sent.set(conversationId, now);
    return true;
  }

  clear(): void {
    this.sent.clear();
  }
}
