/**
 * The question the service worker asks every window before a push, and the
 * answer of a page whose app runs with its live connection. A window that
 * answers has played the chat's sound itself, so the notification stays
 * silent; any other — frozen, gated, gone quiet — does not answer, and the
 * notification sounds.
 */

export const ALIVE_QUESTION = { type: "alive?" } as const;

export function isAliveQuestion(data: unknown): boolean {
  return data !== null && typeof data === "object" && (data as { type?: unknown }).type === ALIVE_QUESTION.type;
}

export function isAliveAnswer(data: unknown): boolean {
  return data !== null && typeof data === "object" && (data as { alive?: unknown }).alive === true;
}
