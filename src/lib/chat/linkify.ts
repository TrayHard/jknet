/**
 * Finding the links in a chat message.
 *
 * --- slice: chat ---
 *
 * A message is shown as React text nodes and nothing else: no HTML, no
 * Markdown. The only markup the thread adds is the link, and only for
 * `http://` and `https://` — a `javascript:`, `file:` or `steam:` address is
 * printed as the text it is. Opening a link is the core's job
 * (`chat_open_link`), which checks the address again.
 *
 * Pure functions: `linkify.test.mjs` runs them under `node --test`.
 */

/** Longest address the core opens; a longer one stays text. */
export const MAX_LINK_LENGTH = 2048;

/** One run of a text: plain, or a link with the address it opens. */
export type LinkSegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string };

/**
 * A candidate: the scheme, then everything up to white space or a character
 * that never belongs to an address in running text. Angle brackets and quotes
 * end it, so `<https://a.b>` and `"https://a.b"` give the bare address.
 */
const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`«»“”]+/gi;

/** Characters a sentence puts after an address that are not part of it. */
const TRAILING = /[.,;:!?)\]}'*_~-]$/;

/**
 * Trims what the sentence added after the address.
 *
 * A closing bracket is kept while the address holds its opening one: the
 * Wikipedia link `https://en.wikipedia.org/wiki/Jedi_(Star_Wars)` keeps its
 * `)`, the sentence `(see https://jkhub.org)` loses it.
 */
function trimTrailing(candidate: string): string {
  let url = candidate;
  while (TRAILING.test(url)) {
    const last = url[url.length - 1];
    if (last === ")" && count(url, "(") >= count(url, ")")) break;
    if (last === "]" && count(url, "[") >= count(url, "]")) break;
    if (last === "}" && count(url, "{") >= count(url, "}")) break;
    url = url.slice(0, -1);
  }
  return url;
}

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/** Whether a string parses as an http(s) address with a host. */
export function isWebUrl(text: string): boolean {
  if (text.length > MAX_LINK_LENGTH) return false;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Splits a text into plain runs and links, in order. */
export function linkify(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const at = match.index ?? 0;
    const url = trimTrailing(match[0]);
    // A bare scheme — `https://` followed by punctuation — is not a link.
    if (!isWebUrl(url)) continue;
    if (at > last) out.push({ type: "text", text: text.slice(last, at) });
    out.push({ type: "link", text: url, href: url });
    last = at + url.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return merge(out);
}

/** Joins neighbouring text runs, which skipped candidates leave behind. */
function merge(segments: LinkSegment[]): LinkSegment[] {
  const out: LinkSegment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (segment.type === "text" && previous?.type === "text") {
      out[out.length - 1] = { type: "text", text: previous.text + segment.text };
    } else {
      out.push(segment);
    }
  }
  return out;
}

/** Whether a message contains at least one link. */
export function hasLink(text: string): boolean {
  return linkify(text).some((segment) => segment.type === "link");
}

/**
 * Hosts a link opens without asking first: the launcher's own site and
 * JKHub, and their subdomains. Every other host goes through a confirmation,
 * because the text of a link and where it leads are written by another player.
 */
const TRUSTED_HOSTS = ["jknet.app", "jkhub.org"];

export function isTrustedLink(href: string): boolean {
  if (!isWebUrl(href)) return false;
  const host = new URL(href).hostname.toLowerCase().replace(/\.$/, "");
  return TRUSTED_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`));
}

/** The host a confirmation names, lowercased, without `www.`. */
export function linkHost(href: string): string {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return href;
  }
}
