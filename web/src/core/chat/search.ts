/**
 * `chat_search`: the messages of the player's conversations that hold some
 * words, newest first, a page at a time. The address is built the way
 * `chat_search` of the launcher's `online/client.rs` builds it; the service
 * does the searching.
 */

import { invalidInput } from "../errors.ts";

/** What a search can be narrowed to besides the words. */
const HAS = ["file", "image", "video", "card", "link"];

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The path and query of `GET /v1/chat/search`, or the refusal of an empty search. */
export function searchPath(args: Record<string, unknown>): string {
  const q = typeof args.q === "string" ? args.q.trim() : "";
  if (q === "") throw invalidInput("an empty search");
  const params = new URLSearchParams({ q });
  const conversationId = text(args.conversationId);
  if (conversationId !== null) params.set("conversationId", conversationId);
  const senderId = text(args.senderId);
  if (senderId !== null) params.set("senderId", senderId);
  const has = text(args.has);
  if (has !== null) {
    if (!HAS.includes(has)) throw invalidInput(`has is one of ${HAS.join(", ")}, not ${has}`);
    params.set("has", has);
  }
  const cursor = text(args.cursor);
  if (cursor !== null) params.set("before", cursor);
  return `/v1/chat/search?${params.toString()}`;
}
