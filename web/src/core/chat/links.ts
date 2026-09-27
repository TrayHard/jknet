/**
 * Links of messages: which open at once, which ask first. A port of
 * `check_link` of the launcher's `src-tauri/src/chat/links.rs`.
 *
 * A message is text another player wrote, and so is the address behind a
 * link in it. The core checks the address again rather than trust the
 * screen:
 *
 * - `http` and `https` only, at most 2048 characters, with a host, and
 *   without white space, control characters or bidirectional overrides,
 *   which a URL parser would quietly drop;
 * - `jknet.app`, `jkhub.org` and their subdomains open at once; any other
 *   host and an IP address need `confirmed`, which the screen sets after
 *   `LinkConfirmDialog` named the host;
 * - what opens is the address the parser wrote back, so the browser gets
 *   exactly what was checked.
 *
 * `src/lib/chat/fixtures/links.json` holds the cases both cores answer.
 */

/** The code of the refusal of a link that has to be confirmed first. */
export const CONFIRM_LINK = "confirm_link";

/** The longest address that opens, the limit of the thread too. */
export const MAX_LINK_CHARS = 2048;

/** Hosts a link opens without asking first. */
const TRUSTED_HOSTS = ["jknet.app", "jkhub.org"];

export interface Link {
  /** The address as the parser writes it back: what opens. */
  url: string;
  /** The host, lower case, as a confirmation names it. */
  host: string;
  /** Opens without asking. */
  trusted: boolean;
}

/** `is_bidi_control` of the launcher's cards. */
function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Unicode `White_Space`, as Rust's `char::is_whitespace` reads it. */
function isWhiteSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** The `Cc` category, as Rust's `char::is_control` reads it. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Whether a host is an IP address: the launcher's `domain()` is `None` for those. */
function isIpHost(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

/** Checks an address of a message; `null` for one that never opens, confirmed or not. */
export function checkLink(raw: string): Link | null {
  const chars = [...raw];
  if (chars.length > MAX_LINK_CHARS || chars.length === 0) return null;
  for (const char of chars) {
    const code = char.codePointAt(0) ?? 0;
    if (isWhiteSpace(code) || isControl(code) || isBidiControl(code)) return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/\.+$/, "").toLowerCase();
  if (host === "") return null;
  const trusted =
    !isIpHost(url.hostname) && TRUSTED_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  return { url: url.href, host, trusted };
}
