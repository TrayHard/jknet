/**
 * The addresses of the chats. A message a search found opens its thread
 * with `?at=<seq>`, which the thread scrolls to; the address can be pasted
 * like any other.
 */

/** The query parameter of the message a thread opens on. */
export const JUMP_PARAM = "at";

export function threadPath(conversationId: string, seq?: number): string {
  const path = `/c/${encodeURIComponent(conversationId)}`;
  return seq === undefined ? path : `${path}?${JUMP_PARAM}=${seq}`;
}

export function infoPath(conversationId: string, mode?: "rename" | "add"): string {
  const path = `/c/${encodeURIComponent(conversationId)}/info`;
  return mode === undefined ? path : `${path}?mode=${mode}`;
}

/** The `seq` of `?at=`, or `null` for none or anything that is not one. */
export function jumpSeq(search: string): number | null {
  const raw = new URLSearchParams(search).get(JUMP_PARAM);
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}
