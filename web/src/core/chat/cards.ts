/**
 * Cards of messages in the web app: the port of the launcher's
 * `src-tauri/src/chat/cards.rs` for what a browser builds and checks.
 *
 * Every card names its `type` and its version `v`, which is 1, and carries a
 * `fallbackText`: what a client that cannot draw the card shows, and what the
 * search of the service reads. The service checks every card of a message
 * and is the one that refuses (`400 card`); this module holds the same rules
 * on this side, so a card the service would refuse is refused before the
 * message is queued, with the same code.
 *
 * The web app builds three kinds from its catalogs — `server`, `bundle` and
 * `jkhubMod` — and runs the service's field rules on exactly those three.
 * The other five (`hostInvite`, `map`, `profile`, `bind`, `config`) belong
 * to the game on a PC: the web app never builds one, and a card of those
 * kinds that passes through here keeps the fields its type has, `v` and a
 * clean `fallbackText`, and meets the size limits; its fields are the
 * service's to judge. Nothing on the web acts on a card's fields besides
 * showing them.
 *
 * | Job          | Command            | Direction |
 * | ------------ | ------------------ | --------- |
 * | building     | `chat_build_card`, `chat_send` (`prepareCards`) | out: unknown fields refused, `v` and an English `fallbackText` filled in |
 * | checking     | `chat_check_card`  | in: read leniently, checked as strictly |
 */

import type { ChatCard } from "../../../../src/lib/ipc.ts";
import { stripColors } from "../../../../src/lib/chat/cardDrafts.ts";
import { onlineError, type CoreError } from "../errors.ts";

/** The code of a card refusal: `details.code` of an `online` error, as the service answers `400`. */
export const CARD = "card";

const VERSION = 1;

/** The most cards one message carries. */
export const CARDS_MAX = 5;
/** The largest card, serialized, except a config. */
export const CARD_BYTES_MAX = 8 * 1024;
/** The longest config text, in bytes. */
const CONFIG_TEXT_MAX = 32 * 1024;
/** The largest config card, serialized: its text and 8 KiB for the rest. */
const CONFIG_CARD_BYTES_MAX = CONFIG_TEXT_MAX + 8 * 1024;
/** The largest sum of the cards of one message, serialized. */
export const CARDS_BYTES_MAX = 48 * 1024;

const FALLBACK_MAX = 200;
const NAME_MAX = 64;
const ADDRESS_MAX = 64;
const TITLE_MAX = 128;
const SLUG_MAX = 64;
const JKHUB_SLUG_MAX = 128;

/** The kinds the web app builds and checks field by field. */
export const WEB_CARD_KINDS = ["server", "bundle", "jkhubMod"] as const;

/**
 * The fields each type has, `type` included. A card on its way out may carry
 * nothing else, as on the service; a card that came in is read with the
 * fields it knows and the rest ignored.
 */
const KNOWN_FIELDS: Record<string, readonly string[]> = {
  server: ["type", "v", "fallbackText", "address", "name", "game", "map", "gametype", "mod"],
  hostInvite: ["type", "v", "fallbackText", "sessionId", "name", "hostId", "game", "mod", "map", "gametype"],
  bundle: ["type", "v", "fallbackText", "bundleId", "slug", "name", "game"],
  jkhubMod: ["type", "v", "fallbackText", "fileId", "slug", "title", "game"],
  map: ["type", "v", "fallbackText", "game", "name", "title"],
  profile: ["type", "v", "fallbackText", "nickname", "model", "saber1", "saber2", "color1", "color2", "charColor"],
  bind: ["type", "v", "fallbackText", "binds"],
  config: ["type", "v", "fallbackText", "name", "text"],
};

const BIND_FIELDS = ["key", "command"];

type Direction = "out" | "in";
type Json = Record<string, unknown>;

/** A card that breaks a rule, as the service refuses it. */
function refusal(reason: string): CoreError {
  return onlineError(CARD, reason);
}

class Refused extends Error {}

function refuse(reason: string): never {
  throw new Refused(reason);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Rust's `char::is_whitespace`: the Unicode `White_Space` property. */
const WHITE_SPACE_CODES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];

function isWhite(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return WHITE_SPACE_CODES.includes(code) || (code >= 0x2000 && code <= 0x200a);
}

/** Rust's `str::trim`. */
function trim(text: string): string {
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && isWhite(chars[start])) start += 1;
  while (end > start && isWhite(chars[end - 1])) end -= 1;
  return chars.slice(start, end).join("");
}

function trimEnd(text: string): string {
  const chars = [...text];
  let end = chars.length;
  while (end > 0 && isWhite(chars[end - 1])) end -= 1;
  return chars.slice(0, end).join("");
}

/** The bidirectional overrides and isolates a text must not carry. */
function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** `raw` without control and bidi characters, trimmed. */
function stripped(raw: string): string {
  const kept = [...raw].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return !(isControl(code) || isBidiControl(code));
  });
  return trim(kept.join(""));
}

/** A text of at most `max` characters, trimmed again after the cut. */
function clamp(raw: string, max: number): string {
  const trimmed = trim(raw);
  const chars = [...trimmed];
  if (chars.length <= max) return trimmed;
  return trimEnd(chars.slice(0, max).join(""));
}

/** A text a client only shows: cleaned and cut to `max` characters. */
function shown(raw: string, max: number): string {
  return clamp(stripped(raw), max);
}

/** An optional shown text; empty counts as absent. */
function shownOpt(raw: string | undefined, max: number): string | undefined {
  if (raw === undefined) return undefined;
  const value = shown(raw, max);
  return value === "" ? undefined : value;
}

function required(value: string, field: string): string {
  if (value === "") refuse(`${field} is empty`);
  return value;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// The service's field rules
// ---------------------------------------------------------------------------

function game(raw: string): string {
  const value = trim(raw);
  if (value !== "ja" && value !== "jo") refuse("game must be 'ja' or 'jo'");
  return value;
}

/** Rust's `Ipv4Addr::from_str`: four decimal octets, no leading zeros. */
function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * A DNS host name: dot-separated labels of letters, digits and inner
 * hyphens, not an address with a wrong number in it, and not `localhost`.
 */
function validHostName(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "" || lower.length > 253 || lower === "localhost" || lower.endsWith(".localhost")) return false;
  const labels = lower.split(".");
  const wellFormed = labels.every(
    (label) => label !== "" && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-") && /^[a-z0-9-]+$/.test(label),
  );
  // A last label of digits only is a mistyped IPv4 address, not a name.
  const numericTail = /^[0-9]*$/.test(labels[labels.length - 1] ?? "");
  return wellFormed && !numericTail;
}

/**
 * A server address a player may be sent to: `host:port` with an IPv4
 * address or a host name, and never this machine, a link-local or multicast
 * address or `0.0.0.0`.
 */
export function serverAddress(raw: string): string {
  const address = stripped(raw);
  const refused = () => refuse(`'${address}' is not a server address`);
  if (address === "" || byteLength(address) > ADDRESS_MAX) refused();
  const at = address.lastIndexOf(":");
  if (at < 0) refused();
  const host = address.slice(0, at);
  const port = address.slice(at + 1);
  if (!/^[0-9]+$/.test(port)) refused();
  const number = Number(port);
  if (!(number > 0 && number <= 65_535)) refused();
  const ip = ipv4(host);
  if (ip !== null) {
    const [a, b] = ip;
    const loopback = a === 127;
    const linkLocal = a === 169 && b === 254;
    const multicast = a >= 224 && a <= 239;
    const unspecified = ip.every((octet) => octet === 0);
    const broadcast = ip.every((octet) => octet === 255);
    if (loopback || linkLocal || multicast || unspecified || broadcast) refused();
    return address;
  }
  if (!validHostName(host)) refused();
  return address;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID in its canonical upper-case form. */
function ulid(raw: string): string {
  const id = trim(raw).toUpperCase();
  if (id.length !== 26 || ![...id].every((char) => CROCKFORD.includes(char)) || id[0] > "7") {
    refuse("bundleId must be a ULID");
  }
  return id;
}

/** A bundle slug: lower-case letters, digits and hyphens. */
function bundleSlug(raw: string): string {
  const slug = trim(raw);
  if (slug === "" || byteLength(slug) > SLUG_MAX || !/^[a-z0-9-]+$/.test(slug)) {
    refuse("slug must be lower-case letters, digits and hyphens");
  }
  return slug;
}

/** A JKHub slug: printable, no spaces and no slashes. */
function jkhubSlug(raw: string): string {
  const slug = trim(raw);
  const chars = [...slug];
  const bad = chars.some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return isWhite(char) || isControl(code) || isBidiControl(code) || char === "/" || char === "\\";
  });
  if (chars.length === 0 || chars.length > JKHUB_SLUG_MAX || bad) refuse("slug is not a JKHub slug");
  return slug;
}

// ---------------------------------------------------------------------------
// Reading: the shapes serde would read
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(card: Json, kind: string, field: string): string {
  const value = card[field];
  if (typeof value !== "string") refuse(`A ${kind} card is not valid: ${field} is missing or not a text`);
  return value;
}

function optionalString(card: Json, kind: string, field: string): string | undefined {
  const value = card[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") refuse(`A ${kind} card is not valid: ${field} is not a text`);
  return value;
}

function unsigned(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** Reads one card: the fields of its type, `null` left out as absent. */
function parse(value: unknown, direction: Direction): { kind: string; card: Json } {
  if (!isObject(value)) refuse("A card is not an object");
  const kind = value.type;
  if (typeof kind !== "string") refuse("A card has no type");
  const fields = KNOWN_FIELDS[kind];
  if (fields === undefined) refuse(`This client does not know cards of type ${JSON.stringify(kind)}`);
  const card: Json = {};
  for (const [key, field] of Object.entries(value)) {
    // `null` is the same as leaving the field out.
    if (field === null) continue;
    if (fields.includes(key)) card[key] = field;
    else if (direction === "out") refuse(`A ${kind} card has no field ${JSON.stringify(key)}`);
  }
  if (card.v !== undefined && !unsigned(card.v, 255)) refuse(`A ${kind} card is not valid: v is not a number`);
  if (card.fallbackText !== undefined && typeof card.fallbackText !== "string") {
    refuse(`A ${kind} card is not valid: fallbackText is not a text`);
  }
  if (kind === "bind" && Array.isArray(card.binds)) {
    card.binds = card.binds.map((bind) => {
      if (!isObject(bind)) return bind;
      if (direction === "out") {
        const extra = Object.keys(bind).find((key) => !BIND_FIELDS.includes(key));
        if (extra !== undefined) refuse(`A bind has no field ${JSON.stringify(extra)}`);
      }
      return Object.fromEntries(Object.entries(bind).filter(([key]) => BIND_FIELDS.includes(key)));
    });
  }
  return { kind, card };
}

/** The English line a card carries when the window gave none: `fallback_for` of the launcher. */
function fallbackFor(kind: string, card: Json): string {
  const text = (field: string) => (typeof card[field] === "string" ? (card[field] as string) : "");
  switch (kind) {
    case "server":
      return `Server: ${text("name")} (${text("address")})`;
    case "hostInvite":
      return text("name") !== "" ? `Join my server: ${text("name")}` : "Join my private server";
    case "bundle":
      return `Bundle: ${text("name")}`;
    case "jkhubMod":
      return `JKHub: ${text("title")}`;
    case "map":
      return text("title") !== "" ? `Map: ${text("title")} (${text("name")})` : `Map: ${text("name")}`;
    case "profile":
      return `Player profile: ${trim(stripColors(text("nickname")))}`;
    case "bind": {
      const binds = Array.isArray(card.binds) ? (card.binds as Array<{ key?: unknown; command?: unknown }>) : [];
      if (binds.length === 1) {
        const key = String(binds[0].key ?? "");
        const command = String(binds[0].command ?? "");
        return command === "" ? `Unbind ${key}` : `Bind ${key}: ${command}`;
      }
      return `${binds.length} key binds: ${binds.map((bind) => String(bind.key ?? "")).join(", ")}`;
    }
    case "config":
      return `Config: ${text("name")}`;
    default:
      return "";
  }
}

/** Checks one card and cleans its strings, by the rules of the service. */
function normalize(kind: string, raw: Json, direction: Direction): ChatCard {
  const v = raw.v === undefined ? VERSION : raw.v;
  if (v !== VERSION) refuse(`This client knows card version ${VERSION} only`);
  const fallbackText = shown(typeof raw.fallbackText === "string" ? raw.fallbackText : "", FALLBACK_MAX);
  let card: ChatCard;
  switch (kind) {
    case "server": {
      const map = shownOpt(optionalString(raw, kind, "map"), NAME_MAX);
      const mod = shownOpt(optionalString(raw, kind, "mod"), NAME_MAX);
      if (raw.gametype !== undefined && !unsigned(raw.gametype, 0xffff_ffff)) {
        refuse(`A ${kind} card is not valid: gametype is not a number`);
      }
      card = {
        type: kind,
        v: VERSION,
        fallbackText,
        address: serverAddress(stringField(raw, kind, "address")),
        name: required(shown(stringField(raw, kind, "name"), NAME_MAX), "name"),
        game: game(stringField(raw, kind, "game")),
      };
      if (map !== undefined) card.map = map;
      if (raw.gametype !== undefined) card.gametype = raw.gametype;
      if (mod !== undefined) card.mod = mod;
      break;
    }
    case "bundle":
      card = {
        type: kind,
        v: VERSION,
        fallbackText,
        bundleId: ulid(stringField(raw, kind, "bundleId")),
        slug: bundleSlug(stringField(raw, kind, "slug")),
        name: required(shown(stringField(raw, kind, "name"), NAME_MAX), "name"),
        game: game(stringField(raw, kind, "game")),
      };
      break;
    case "jkhubMod": {
      // JKHub numbers its files well inside 32 bits; a larger number names no file.
      if (!unsigned(raw.fileId, Number.MAX_SAFE_INTEGER)) refuse(`A ${kind} card is not valid: fileId is not a number`);
      const fileId = raw.fileId as number;
      if (fileId === 0 || fileId > 0xffff_ffff) refuse("fileId must be the number of a JKHub file");
      card = {
        type: kind,
        v: VERSION,
        fallbackText,
        fileId,
        slug: jkhubSlug(stringField(raw, kind, "slug")),
        title: required(shown(stringField(raw, kind, "title"), TITLE_MAX), "title"),
        game: game(stringField(raw, kind, "game")),
      };
      break;
    }
    default:
      // A kind of the PC: its fields as they came, for the service to judge.
      card = { ...raw, type: kind, v: VERSION, fallbackText };
      break;
  }
  if (direction === "out" && card.fallbackText === "") {
    card.fallbackText = shown(fallbackFor(kind, card as unknown as Json), FALLBACK_MAX);
  }
  return card;
}

function run<T>(job: () => T): T {
  try {
    return job();
  } catch (error) {
    if (error instanceof Refused) throw refusal(error.message);
    throw error;
  }
}

/** The size limits of the service: 8 KiB a card (40 KiB a config), 48 KiB in all. */
function sized(cards: ChatCard[]): void {
  let total = 0;
  for (const card of cards) {
    const bytes = byteLength(JSON.stringify(card));
    const max = card.type === "config" ? CONFIG_CARD_BYTES_MAX : CARD_BYTES_MAX;
    if (bytes > max) refuse(`A card is larger than ${max} bytes`);
    total += bytes;
    if (total > CARDS_BYTES_MAX) refuse(`The cards of a message are larger than ${CARDS_BYTES_MAX} bytes`);
  }
}

/**
 * Cleans the cards of a message about to be sent, fills in what the window
 * left out, and refuses what the service would refuse: the rules of the
 * web's three kinds, five cards at most, the size limits.
 */
export function prepareCards(raw: unknown[]): ChatCard[] {
  return run(() => {
    if (raw.length > CARDS_MAX) refuse(`A message carries at most ${CARDS_MAX} cards`);
    const cards = raw.map((value) => {
      const { kind, card } = parse(value, "out");
      return normalize(kind, card, "out");
    });
    sized(cards);
    return cards;
  });
}

/**
 * `chat_build_card`: one card exactly as `chat_send` would send it. The web
 * app builds only the kinds of its catalogs.
 */
export function buildCard(raw: unknown): ChatCard {
  const kind = isObject(raw) ? raw.type : undefined;
  if (typeof kind !== "string" || !(WEB_CARD_KINDS as readonly string[]).includes(kind)) {
    throw refusal(`The web app builds server, bundle and JKHub mod cards only, not ${JSON.stringify(kind ?? null)}`);
  }
  return prepareCards([raw])[0];
}

/**
 * `chat_check_card`: a card of a message, read with the fields its type has
 * and checked by the service's rules before anything acts on it.
 */
export function checkCard(raw: unknown): ChatCard {
  return run(() => {
    const { kind, card } = parse(raw, "in");
    const clean = normalize(kind, card, "in");
    sized([clean]);
    return clean;
  });
}
