/**
 * Mention tokens of a chat message body.
 *
 * --- slice: chat ---
 *
 * On the wire a mention is a token, `<@ULID>`, and never a name: a name
 * changes, an id does not, and the service rewrites a token that names no
 * member into plain text before it stores the message. A token of an account
 * that has since been deleted comes out of the service as `<@deleted>`.
 *
 * The composer is a plain text field, so it cannot hold a token the player
 * would read. It shows `@Name` and keeps, beside the text, the list of the
 * mentions the player picked from the popover; `encodeMentions` turns the pair
 * back into a body just before it is sent, and `decodeMentions` does the
 * opposite for a draft that comes back from the core.
 *
 * Pure functions, no React: `mentions.test.mjs` runs them under `node --test`.
 */

/** What stands for an account that no longer exists. */
export const DELETED_MENTION = "deleted";

/**
 * A mention token.
 *
 * Lenient on purpose: the service only ever writes 26-character ULIDs, but the
 * reader should not decide what an id looks like — a token it fails to match
 * would be printed to the player as `<@…>` markup.
 */
const TOKEN = /<@([0-9A-Za-z]{26}|deleted)>/g;

/** One run of a body: text as it is, or a mention of an account (`null`: a deleted one). */
export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string | null };

/** Splits a body into text and mentions, in order. Adjacent text is never split. */
export function splitMentions(body: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: "text", text: body.slice(last, at) });
    out.push({ type: "mention", userId: match[1] === DELETED_MENTION ? null : match[1] });
    last = at + match[0].length;
  }
  if (last < body.length) out.push({ type: "text", text: body.slice(last) });
  return out;
}

/** The ids a body mentions, each once, deleted accounts left out. */
export function mentionedIds(body: string): string[] {
  const ids = new Set<string>();
  for (const segment of splitMentions(body)) {
    if (segment.type === "mention" && segment.userId !== null) ids.add(segment.userId);
  }
  return [...ids];
}

/** A mention the player picked in the composer: who, and the name the text shows. */
export interface MentionPick {
  id: string;
  name: string;
}

/**
 * Whether the character is part of a word, which is what decides where a name
 * ends: `@Kai` in `@Kai,` is a mention, in `@Kaiden` it is not.
 */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/**
 * Turns the composer text into a body: every `@Name` of a picked mention
 * becomes its token.
 *
 * Longer names go first, so `@Kai Katarn` is not eaten by a pick called
 * `Kai`. A name has to start at the beginning of the text or after a character
 * that is not part of a word, and end before one, which keeps an e-mail
 * address or `@Kaiden` intact. Any `<@…>` the player typed by hand passes
 * through: the service keeps a token only when it names a member.
 */
export function encodeMentions(text: string, picks: MentionPick[]): string {
  const unique = new Map<string, MentionPick>();
  for (const pick of picks) {
    if (pick.name.trim() !== "") unique.set(pick.name, pick);
  }
  const ordered = [...unique.values()].sort((a, b) => b.name.length - a.name.length);
  if (ordered.length === 0) return text;

  let out = "";
  let at = 0;
  while (at < text.length) {
    if (text[at] === "@" && !isWordChar(text[at - 1])) {
      const rest = text.slice(at + 1);
      const pick = ordered.find(
        (candidate) => rest.startsWith(candidate.name) && !isWordChar(rest[candidate.name.length]),
      );
      if (pick) {
        out += `<@${pick.id}>`;
        at += 1 + pick.name.length;
        continue;
      }
    }
    out += text[at];
    at += 1;
  }
  return out;
}

/**
 * The opposite of `encodeMentions`, for a draft the core kept: tokens become
 * `@Name` again and come back as picks.
 *
 * `nameOf` answers the display name of an id, or `null` when it is not known;
 * such a token, and a deleted account's, become `@` plus `unknownName`
 * without a pick, so the text reads naturally and is sent as plain text.
 */
export function decodeMentions(
  body: string,
  nameOf: (id: string) => string | null,
  unknownName: string,
): { text: string; picks: MentionPick[] } {
  const picks = new Map<string, MentionPick>();
  let text = "";
  for (const segment of splitMentions(body)) {
    if (segment.type === "text") {
      text += segment.text;
      continue;
    }
    const name = segment.userId === null ? null : nameOf(segment.userId);
    if (segment.userId !== null && name !== null) {
      picks.set(segment.userId, { id: segment.userId, name });
      text += `@${name}`;
    } else {
      text += `@${unknownName}`;
    }
  }
  return { text, picks: [...picks.values()] };
}

/** The `@partial` the caret stands after, which is what opens the mention popover. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** What was typed after it, without the `@`. */
  query: string;
}

/** Longest name the popover still searches for; a longer run is not a mention. */
const MAX_QUERY = 32;

/**
 * The mention being typed at `caret`, or `null`.
 *
 * The `@` has to start the text or follow white space or an opening bracket,
 * and nothing between it and the caret may be white space: `mail@host` and a
 * finished `@Kai ` open nothing.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const before = upto[at - 1];
  if (before !== undefined && !/[\s([{"'«]/.test(before)) return null;
  const query = upto.slice(at + 1);
  if (query.length > MAX_QUERY || /\s/.test(query)) return null;
  return { start: at, query };
}

/**
 * Replaces the mention being typed with the picked name and a space.
 *
 * Answers the new text and where the caret goes, so the player keeps typing
 * after the name.
 */
export function insertMention(
  text: string,
  query: MentionQuery,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  const next = text.slice(0, query.start) + inserted + text.slice(caret);
  return { text: next, caret: query.start + inserted.length };
}

/**
 * The body as one line of plain text, for a list row or a reply quote.
 *
 * Tokens become `@Name`, white space runs collapse into one space, and the
 * result is cut to `max` characters with an ellipsis. `nameOf` answers `null`
 * for an id it does not know and the deleted-account label for `null`.
 */
export function plainText(
  body: string,
  nameOf: (id: string | null) => string,
  max = 140,
): string {
  let text = "";
  for (const segment of splitMentions(body)) {
    text += segment.type === "text" ? segment.text : `@${nameOf(segment.userId)}`;
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${Array.from(flat).slice(0, max - 1).join("").trimEnd()}…`;
}
