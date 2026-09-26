/**
 * Recognising a message that is nothing but emoji.
 *
 * --- slice: chat ---
 *
 * A message of one to six emoji and nothing else is drawn larger, the way
 * every messenger does. The check runs on grapheme-like clusters built from
 * the emoji building blocks, so a family, a flag, a keycap or a skin tone
 * counts as one emoji rather than as five code points.
 *
 * Pure functions: `emojiText.test.mjs` runs them under `node --test`.
 */

/** The most emoji a message may have and still be drawn large. */
export const LARGE_EMOJI_LIMIT = 6;

/**
 * One emoji: a pictograph with its modifiers and joined parts, a flag of two
 * regional indicators, or a keycap.
 */
const EMOJI =
  /(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*)/gu;

/** How many emoji the text holds when it holds nothing else, or `0`. */
export function emojiOnlyCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const found = trimmed.match(EMOJI) ?? [];
  if (found.length === 0) return 0;
  const rest = trimmed.replace(EMOJI, "").replace(/[\s️‍]/g, "");
  return rest === "" ? found.length : 0;
}

/** Whether the message is drawn with large emoji. */
export function isLargeEmoji(text: string): boolean {
  const n = emojiOnlyCount(text);
  return n > 0 && n <= LARGE_EMOJI_LIMIT;
}

/**
 * Whether a string is acceptable as a reaction, by the service's rule: at
 * most 32 bytes and 10 code points, no white space or control characters, and
 * ASCII only as a keycap.
 */
export function isReactionEmoji(value: string): boolean {
  if (value === "") return false;
  if (new TextEncoder().encode(value).length > 32) return false;
  const points = Array.from(value);
  if (points.length > 10) return false;
  if (/[\s\p{Cc}‪-‮⁦-⁩]/u.test(value)) return false;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point.charCodeAt(0) < 0x80) {
      if (!/[0-9#*]/.test(point)) return false;
      const next = points[i + 1];
      if (next !== "️" && next !== "⃣") return false;
    }
  }
  return emojiOnlyCount(value) === 1;
}
