/**
 * --- slice: chat cards ---
 *
 * Cards of messages, without React: building the card a window sends, and
 * reading the card a message brought.
 *
 * **Building.** A card draft carries the fields of its type, `v: 1` and an
 * English `fallbackText` — what a launcher that cannot draw the card prints
 * instead, and what the search of the service reads. The core cleans every
 * draft again before it queues a message (`chat_send`, `chat_build_card`) and
 * refuses what the service would refuse; the drafts here only have to be
 * right, not to be the last word. A private-server invite carries the session
 * and the server name alone: the service fills in the host, the game, the
 * mod, the map and the game type from the live hosting, and it never carries
 * a password or an address.
 *
 * **Reading.** A card of a message is read leniently: a field of the wrong
 * shape reads as absent, and a card missing a field its component needs reads
 * as `null`, which the thread draws as the card's `fallbackText`. The core
 * checks a card again (`chat_check_card`) before any button of it acts.
 *
 * The fallback lines mirror `fallback_for` of `src-tauri/src/chat/cards.rs`.
 */

import type { ChatCard, Game, JkhubGame, PlayerProfile } from "../ipc";

/** The only card version this launcher writes and reads. */
export const CARD_VERSION = 1;
/** At most this many cards go with one message. */
export const CARDS_MAX = 5;
/** At most this many binds go in one bind card. */
export const BINDS_MAX = 50;

const FALLBACK_MAX = 200;
const NAME_MAX = 64;
const TITLE_MAX = 128;
const CONFIG_NAME_MAX = 120;
/** A config card holds at most 32 KiB of text. */
export const CONFIG_TEXT_MAX_BYTES = 32 * 1024;

/** The engine's blade colour of a profile that leaves it to the engine. */
const DEFAULT_COLOR1 = "4";
/** The engine's first hilt of a profile that leaves it to the engine. */
const DEFAULT_SABER1 = "Kyle";
/** `saber2` of a profile with its second hand empty. */
const NO_SECOND_HILT = "none";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ServerCardFields {
  address: string;
  /** The host name, colour codes included. */
  name: string;
  game: Game;
  map: string | null;
  gametype: number | null;
  mod: string | null;
}

export interface HostInviteCardFields {
  /** The `jknet_session` of the private server, 16 hex characters. */
  sessionId: string;
  name: string | null;
  /** Filled in by the service: the account that hosts the server. */
  hostId: string | null;
  game: Game | null;
  mod: string | null;
  map: string | null;
  gametype: number | null;
}

export interface BundleCardFields {
  bundleId: string;
  slug: string;
  name: string;
  game: Game;
}

export interface JkhubModCardFields {
  fileId: number;
  slug: string;
  title: string;
  game: Game;
}

export interface MapCardFields {
  game: Game;
  /** The name inside the game: `mp/ffa3`. */
  name: string;
  title: string | null;
}

/** Every value is the text of the cvar it stands for. */
export interface ProfileCardFields {
  nickname: string;
  model: string;
  saber1: string;
  saber2: string | null;
  /** `0` to `5`. */
  color1: string;
  color2: string | null;
  /** `"R G B"`, three numbers of 0 to 255. */
  charColor: string | null;
}

export interface BindEntry {
  key: string;
  command: string;
}

export interface BindCardFields {
  binds: BindEntry[];
}

export interface ConfigCardFields {
  name: string;
  text: string;
}

/** A card of this release, read into its fields. */
export type ParsedCard =
  | { type: "server"; fields: ServerCardFields }
  | { type: "hostInvite"; fields: HostInviteCardFields }
  | { type: "bundle"; fields: BundleCardFields }
  | { type: "jkhubMod"; fields: JkhubModCardFields }
  | { type: "map"; fields: MapCardFields }
  | { type: "profile"; fields: ProfileCardFields }
  | { type: "bind"; fields: BindCardFields }
  | { type: "config"; fields: ConfigCardFields };

export type CardType = ParsedCard["type"];

/** The fields of one card type. */
export type FieldsOf<T extends CardType> = Extract<ParsedCard, { type: T }>["fields"];

/** The card types of this release, in the order the attach menu lists them. */
export const CARD_TYPES: readonly CardType[] = [
  "server",
  "hostInvite",
  "bundle",
  "jkhubMod",
  "map",
  "profile",
  "bind",
  "config",
];

export function isCardType(type: string): type is CardType {
  return (CARD_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/**
 * A name without its colour codes: the engine's `Q_IsColorString`, `^`
 * followed by a digit, the rule `colorSpans` of the server list draws by.
 */
export function stripColors(raw: string): string {
  return raw.replace(/\^[0-9]/g, "");
}

/** At most `max` characters, by code points, so a surrogate pair is never cut in two. */
export function clampChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Trimmed, control and bidi characters out: what the core does to every shown text. */
function cleanText(raw: string, max: number): string {
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");
  return clampChars(stripped.trim(), max);
}

function fallback(line: string): string {
  return cleanText(line, FALLBACK_MAX);
}

function isGame(value: unknown): value is Game {
  return value === "ja" || value === "jo";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** What a server card is built from: a row of the server browser. */
export interface ServerSource {
  address: string;
  hostnameRaw: string;
  hostnameClean: string;
  game: Game;
  map: string;
  gametype: number;
  /** `fs_game`; `base` for a server without a mod. */
  modName: string;
}

/** A server anyone can join by its address. */
export function serverCard(server: ServerSource): ChatCard {
  const raw = cleanText(server.hostnameRaw, NAME_MAX);
  const name = stripColors(raw).trim() === "" ? server.address : raw;
  const plain = stripColors(server.hostnameClean || name).trim() || server.address;
  const card: ChatCard = {
    type: "server",
    v: CARD_VERSION,
    fallbackText: fallback(`Server: ${plain} (${server.address})`),
    address: server.address,
    name,
    game: server.game,
  };
  if (server.map.trim() !== "") card.map = server.map.trim();
  if (Number.isInteger(server.gametype) && server.gametype >= 0) card.gametype = server.gametype;
  const mod = server.modName.trim();
  if (mod !== "" && mod.toLowerCase() !== "base") card.mod = mod;
  return card;
}

/**
 * The private server I host now: the session and the name my launcher shows.
 * The service fills in the rest from my live hosting.
 */
export function hostInviteCard(sessionId: string, name?: string | null): ChatCard {
  const shown = name == null ? "" : cleanText(name, NAME_MAX);
  const card: ChatCard = {
    type: "hostInvite",
    v: CARD_VERSION,
    fallbackText: fallback(shown === "" ? "Join my private server" : `Join my server: ${stripColors(shown)}`),
    sessionId: sessionId.trim().toLowerCase(),
  };
  if (shown !== "") card.name = shown;
  return card;
}

/** What a bundle card is built from: a card or a record of the catalogue. */
export interface BundleSource {
  id: string;
  slug: string;
  name: string;
  game: Game;
}

export function bundleCard(bundle: BundleSource): ChatCard {
  const name = cleanText(bundle.name, NAME_MAX);
  return {
    type: "bundle",
    v: CARD_VERSION,
    fallbackText: fallback(`Bundle: ${name}`),
    bundleId: bundle.id,
    slug: bundle.slug,
    name,
    game: bundle.game,
  };
}

/** What a JKHub card is built from: a file page or a row of the catalogue. */
export interface JkhubSource {
  id: number;
  slug: string;
  title: string;
  game: JkhubGame;
}

/**
 * A file of JKHub. A file JKHub files under both games takes `game`, the game
 * the player shares it from.
 */
export function jkhubModCard(file: JkhubSource, game: Game): ChatCard {
  const title = cleanText(file.title, TITLE_MAX);
  return {
    type: "jkhubMod",
    v: CARD_VERSION,
    fallbackText: fallback(`JKHub: ${title}`),
    fileId: file.id,
    slug: file.slug,
    title,
    game: isGame(file.game) ? file.game : game,
  };
}

/** A map by its name inside the game. */
export function mapCard(map: { name: string; title?: string | null }, game: Game): ChatCard {
  const name = map.name.trim();
  const title = map.title == null ? "" : cleanText(map.title, NAME_MAX);
  const card: ChatCard = {
    type: "map",
    v: CARD_VERSION,
    fallbackText: fallback(title === "" ? `Map: ${name}` : `Map: ${title} (${name})`),
    game,
    name,
  };
  if (title !== "") card.title = title;
  return card;
}

/**
 * A player profile as a card, or `null` for one without a nickname or a
 * model: the service requires both. A hilt and a colour left to the engine
 * are written as the engine's defaults, which the service requires too.
 *
 * The core's `chat_card_from_profile` is the one that reads a profile's
 * hand-written token line; this is the card of its fields.
 */
export function profileCard(profile: PlayerProfile): ChatCard | null {
  const nickname = profile.nickname?.trim() ?? "";
  const model = profile.model?.trim() ?? "";
  if (stripColors(nickname).trim() === "" || model === "") return null;
  const card: ChatCard = {
    type: "profile",
    v: CARD_VERSION,
    fallbackText: fallback(`Player profile: ${stripColors(nickname).trim()}`),
    nickname,
    model,
    saber1: profile.saber1?.trim() || DEFAULT_SABER1,
    color1: profile.color1 == null ? DEFAULT_COLOR1 : String(profile.color1),
  };
  const saber2 = profile.saber2?.trim() ?? "";
  if (saber2 !== "" && saber2.toLowerCase() !== NO_SECOND_HILT) card.saber2 = saber2;
  if (profile.color2 != null) card.color2 = String(profile.color2);
  if (profile.charColor != null) {
    const { red, green, blue } = profile.charColor;
    card.charColor = `${red} ${green} ${blue}`;
  }
  return card;
}

/** The fallback line of a bind card, as the core writes it. */
function bindFallback(binds: BindEntry[]): string {
  if (binds.length === 1) {
    const [bind] = binds;
    return bind.command === "" ? `Unbind ${bind.key}` : `Bind ${bind.key}: ${bind.command}`;
  }
  return `${binds.length} key binds: ${binds.map((bind) => bind.key).join(", ")}`;
}

/** Key binds, at most 50, keys in upper case as `bind` writes them. */
export function bindCard(binds: BindEntry[]): ChatCard {
  const list = binds
    .slice(0, BINDS_MAX)
    .map((bind) => ({ key: bind.key.trim().toUpperCase(), command: bind.command.trim() }));
  return {
    type: "bind",
    v: CARD_VERSION,
    fallbackText: fallback(bindFallback(list)),
    binds: list,
  };
}

/** A config document as a card. */
export function configCard(document: { name: string; text: string }): ChatCard {
  const name = cleanText(document.name, CONFIG_NAME_MAX) || "config.cfg";
  return {
    type: "config",
    v: CARD_VERSION,
    fallbackText: fallback(`Config: ${name}`),
    name,
    text: document.text.trim(),
  };
}

/** Whether a text fits a config card: 32 KiB of UTF-8. */
export function fitsConfigCard(textOf: string): boolean {
  return new TextEncoder().encode(textOf.trim()).length <= CONFIG_TEXT_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A card of a message read into its fields, or `null` for a type this
 * launcher does not draw, a version it does not know, or a card that lacks
 * a field its component needs.
 */
export function readCard(card: ChatCard): ParsedCard | null {
  if (typeof card !== "object" || card === null) return null;
  if (card.v !== undefined && card.v !== CARD_VERSION) return null;
  const c = card as Record<string, unknown>;
  switch (card.type) {
    case "server": {
      const address = text(c.address);
      if (address === null || !isGame(c.game)) return null;
      return {
        type: "server",
        fields: {
          address,
          name: text(c.name) ?? address,
          game: c.game,
          map: text(c.map),
          gametype: count(c.gametype),
          mod: text(c.mod),
        },
      };
    }
    case "hostInvite": {
      const sessionId = text(c.sessionId);
      if (sessionId === null) return null;
      return {
        type: "hostInvite",
        fields: {
          sessionId,
          name: text(c.name),
          hostId: text(c.hostId),
          game: isGame(c.game) ? c.game : null,
          mod: text(c.mod),
          map: text(c.map),
          gametype: count(c.gametype),
        },
      };
    }
    case "bundle": {
      const bundleId = text(c.bundleId);
      if (bundleId === null || !isGame(c.game)) return null;
      return {
        type: "bundle",
        fields: { bundleId, slug: text(c.slug) ?? "", name: text(c.name) ?? bundleId, game: c.game },
      };
    }
    case "jkhubMod": {
      const fileId = count(c.fileId);
      if (fileId === null || fileId === 0 || !isGame(c.game)) return null;
      return {
        type: "jkhubMod",
        fields: { fileId, slug: text(c.slug) ?? "", title: text(c.title) ?? String(fileId), game: c.game },
      };
    }
    case "map": {
      const name = text(c.name);
      if (name === null || !isGame(c.game)) return null;
      return { type: "map", fields: { game: c.game, name, title: text(c.title) } };
    }
    case "profile": {
      const nickname = text(c.nickname);
      const model = text(c.model);
      if (nickname === null || model === null) return null;
      return {
        type: "profile",
        fields: {
          nickname,
          model,
          saber1: text(c.saber1) ?? DEFAULT_SABER1,
          saber2: text(c.saber2),
          color1: text(c.color1) ?? DEFAULT_COLOR1,
          color2: text(c.color2),
          charColor: text(c.charColor),
        },
      };
    }
    case "bind": {
      if (!Array.isArray(c.binds)) return null;
      const binds: BindEntry[] = [];
      for (const entry of c.binds as unknown[]) {
        if (typeof entry !== "object" || entry === null) continue;
        const bind = entry as Record<string, unknown>;
        const key = text(bind.key);
        if (key === null) continue;
        binds.push({ key, command: typeof bind.command === "string" ? bind.command : "" });
      }
      if (binds.length === 0) return null;
      return { type: "bind", fields: { binds } };
    }
    case "config": {
      if (typeof c.text !== "string") return null;
      return { type: "config", fields: { name: text(c.name) ?? "config.cfg", text: c.text } };
    }
    default:
      return null;
  }
}

/** The title of a card as a one-line label: its name, without colour codes. */
export function cardTitle(card: ParsedCard): string {
  switch (card.type) {
    case "server":
      return stripColors(card.fields.name).trim() || card.fields.address;
    case "hostInvite":
      return card.fields.name === null ? "" : stripColors(card.fields.name).trim();
    case "bundle":
      return card.fields.name;
    case "jkhubMod":
      return card.fields.title;
    case "map":
      return card.fields.title ?? card.fields.name;
    case "profile":
      return stripColors(card.fields.nickname).trim();
    case "bind":
      return card.fields.binds.map((bind) => bind.key).join(", ");
    case "config":
      return card.fields.name;
  }
}

/** A second line that tells cards of one type apart, or `null`. */
export function cardDetail(card: ParsedCard): string | null {
  switch (card.type) {
    case "server":
      return card.fields.address;
    case "map":
      return card.fields.title === null ? null : card.fields.name;
    case "profile":
      return card.fields.model;
    case "bind":
      return card.fields.binds.length === 1 ? card.fields.binds[0].command : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Binds and configs
// ---------------------------------------------------------------------------

/**
 * Binds as config lines, one per bind in their order: `bind "KEY" "command"`,
 * or `unbind "KEY"` for an empty command. Quotes inside a command are dropped,
 * as the core does when it turns a bind card into a config document: a line
 * the game reads cannot hold them.
 */
export function bindLines(binds: BindEntry[]): string {
  return binds
    .map((bind) => {
      const key = bind.key.trim().toUpperCase();
      const command = bind.command.replace(/"/g, "").trim();
      return command === "" ? `unbind "${key}"` : `bind "${key}" "${command}"`;
    })
    .join("\n");
}

/** How many lines a config text has, blank ones included; an empty text has none. */
export function lineCount(textOf: string): number {
  if (textOf === "") return 0;
  return textOf.split(/\r\n|\r|\n/).length;
}

/** The first `lines` lines of a text that are not blank, for a preview. */
export function previewLines(textOf: string, lines: number): string[] {
  return textOf
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(0, lines);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** The final extension of a file name, lower case, without the dot; `""` for none. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const at = base.lastIndexOf(".");
  return at <= 0 || at === base.length - 1 ? "" : base.slice(at + 1).toLowerCase();
}

/**
 * The game a demo was recorded in, by its extension: `dm_25` and `dm_26` are
 * Jedi Academy, `dm_15` and `dm_16` Jedi Outcast. `null` for anything else.
 */
export function demoGame(name: string): Game | null {
  switch (fileExtension(name)) {
    case "dm_25":
    case "dm_26":
      return "ja";
    case "dm_15":
    case "dm_16":
      return "jo";
    default:
      return null;
  }
}

/** Whether the Media screen can take a picture: the engine writes PNG and JPEG. */
export function isScreenshotName(name: string): boolean {
  return ["png", "jpg", "jpeg"].includes(fileExtension(name));
}

/** The address of a file page of JKHub, for **Open on JKHub**. */
export function jkhubFileUrl(fileId: number, slug: string): string {
  const tail = slug.trim() === "" ? `${fileId}` : `${fileId}-${encodeURIComponent(slug.trim())}`;
  return `https://jkhub.org/files/file/${tail}/`;
}

/** `"R G B"` as three channels, or `null` when it is not three numbers of 0 to 255. */
export function parseCharColor(value: string | null): { red: number; green: number; blue: number } | null {
  if (value === null) return null;
  const parts = value.split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return { red: parts[0], green: parts[1], blue: parts[2] };
}
