import type { Game, ServerConfigDocument } from "./ipc";

export const SERVER_CONFIG_MAX_BYTES = 64 * 1024;
export const SERVER_CONFIG_IMPORT_MAX_BYTES = SERVER_CONFIG_MAX_BYTES + 1024;
export const SERVER_CONFIG_NAME_MAX_BYTES = 240;
export const SERVER_CONFIG_MOD_IDS = ["base", "japlus", "japro", "mbii", "lugormod", "makermod"] as const;
const ENVELOPE_PREFIX = "// JKNet server config: ";

export type ServerConfigImport = Pick<ServerConfigDocument, "game" | "modId" | "name" | "text">;

function windows1251Cyrillic(byte: number): boolean {
  return byte === 0x80 || byte === 0x81 || byte === 0x83 || (byte >= 0x8a && byte <= 0x90) ||
    byte === 0x9a || (byte >= 0x9c && byte <= 0x9f) || (byte >= 0xa1 && byte <= 0xa3) ||
    byte === 0xa5 || byte === 0xa8 || byte === 0xaa || byte === 0xaf ||
    (byte >= 0xb2 && byte <= 0xb4) || byte === 0xb8 || byte === 0xba || byte >= 0xbc;
}

function looksLikeWindows1251(bytes: Uint8Array): boolean {
  let run = 0;
  let longest = 0;
  for (const byte of bytes) {
    if (windows1251Cyrillic(byte)) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return longest >= 3;
}

function decode(bytes: Uint8Array, encoding: string): string | null {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { return null; }
}

/** Decode modern cfg files and the Windows code pages used by legacy tools. */
export function decodeServerConfigBytes(bytes: Uint8Array): string {
  const utf8 = decode(bytes, "utf-8");
  let text = utf8;
  if (text === null && bytes[0] === 0xff && bytes[1] === 0xfe) text = decode(bytes, "utf-16le");
  if (text === null && bytes[0] === 0xfe && bytes[1] === 0xff) text = decode(bytes, "utf-16be");
  if (text === null) {
    const pages = looksLikeWindows1251(bytes)
      ? ["windows-1251", "windows-1252"]
      : ["windows-1252", "windows-1251"];
    for (const page of pages) {
      text = decode(bytes, page);
      if (text !== null) break;
    }
  }
  if (text === null || text.includes("\0")) throw new Error("Unsupported server config encoding");
  return text;
}

/** A drop is deliberately singular: every cfg must be reviewed in the editor. */
export function serverConfigDropProblem(names: readonly string[]): "oneCfg" | null {
  if (names.length !== 1) return "oneCfg";
  const leaf = names[0].split(/[\\/]/).pop() ?? "";
  return /^.+\.cfg$/i.test(leaf) ? null : "oneCfg";
}

/** The initial document name of a picked or dropped cfg on either platform. */
export function serverConfigImportName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? "";
  return leaf.replace(/\.cfg$/i, "");
}

/** Infer only signatures that are unambiguous in a plain cfg without metadata. */
export function detectServerConfigMod(text: string, game: Game): ServerConfigDocument["modId"] {
  if (game !== "ja") return "base";
  const folder = serverConfigValues(text).get("fs_game")?.toLowerCase();
  const folders: Record<string, ServerConfigDocument["modId"]> = {
    japlus: "japlus", japro: "japro", mbii: "mbii", lugormod: "lugormod", makermod: "makermod",
  };
  if (folder && folders[folder]) return folders[folder];
  if (commandSpans(text).some(span => /^\s*m(?:remap|weather)(?:\s|$)/i.test(span.text))) return "makermod";
  return "base";
}

/** A regular cfg with a comment that lets another launcher restore its context. */
export function serverConfigEnvelope(doc: ServerConfigImport): string {
  return `${ENVELOPE_PREFIX}${JSON.stringify({ v: 1, game: doc.game, modId: doc.modId, name: doc.name })}\n${doc.text}`;
}

/** Also recognizes malformed headers so an import cannot downgrade them to plain cfg. */
export function hasServerConfigHeader(text: string): boolean {
  return text.replace(/^\uFEFF/, "").startsWith("// JKNet server config:");
}

/** Only an exact, valid header opts a chat config into the server editor. */
export function parseServerConfigEnvelope(text: string): ServerConfigImport | null {
  text = text.replace(/^\uFEFF/, "");
  const newline = text.indexOf("\n");
  const first = (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/, "");
  if (!first.startsWith(ENVELOPE_PREFIX)) return null;
  try {
    const metadata: unknown = JSON.parse(first.slice(ENVELOPE_PREFIX.length));
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const data = metadata as Record<string, unknown>;
    if (data.v !== 1 || (data.game !== "ja" && data.game !== "jo") || typeof data.modId !== "string" ||
      !(SERVER_CONFIG_MOD_IDS as readonly string[]).includes(data.modId) || (data.game === "jo" && data.modId !== "base") ||
      typeof data.name !== "string" || !data.name.trim() || /[\u0000-\u001f\u007f]/.test(data.name) ||
      new TextEncoder().encode(data.name).length > SERVER_CONFIG_NAME_MAX_BYTES) return null;
    const body = newline < 0 ? "" : text.slice(newline + 1);
    if (new TextEncoder().encode(body).length > SERVER_CONFIG_MAX_BYTES) return null;
    return { game: data.game, modId: data.modId, name: data.name, text: body };
  } catch {
    return null;
  }
}

interface CommandSpan { start: number; end: number; text: string }
interface Assignment extends CommandSpan { name: string; value: string; valueStart: number; valueEnd: number }

/** Comments become spaces so source offsets remain valid for edits. */
function maskComments(text: string): string {
  const out = text.split("");
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    if (text[i] === "\n" || text[i] === "\r") quoted = false;
    if (quoted || text[i] !== "/") continue;
    if (text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") out[i++] = " ";
      i--;
    } else if (text[i + 1] === "*") {
      out[i++] = " "; out[i] = " ";
      while (++i < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") { out[i++] = " "; out[i] = " "; break; }
        if (text[i] !== "\n" && text[i] !== "\r") out[i] = " ";
      }
    }
  }
  return out.join("");
}

/** Split only at engine command boundaries, keeping offsets into the original file. */
function commandSpans(text: string): CommandSpan[] {
  text = maskComments(text);
  const spans: CommandSpan[] = [];
  let start = 0, quoted = false;
  const push = (end: number) => {
    const part = text.slice(start, end).trimEnd();
    if (part.trim()) spans.push({ start, end: start + part.length, text: part });
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    if ((text[i] === ";" && !quoted) || text[i] === "\n" || text[i] === "\r") {
      push(i);
      start = i + 1;
      quoted = false;
    }
  }
  push(text.length);
  return spans;
}

function assignments(text: string): Assignment[] {
  return commandSpans(text).flatMap(span => {
    const match = span.text.match(/^(\s*(?:set[aus]?\s+)?(?:"([\w.]+)"|([\w.]+))\s+)("([^"\r\n]*)"|([^\s";]+))\s*$/i);
    if (!match) return [];
    return [{ ...span, name: (match[2] ?? match[3]).toLowerCase(), value: match[5] ?? match[6],
      valueStart: span.start + match[1].length, valueEnd: span.start + match[1].length + match[4].length }];
  });
}

export function serverConfigValues(text: string): Map<string, string> {
  return new Map(assignments(text).map(entry => [entry.name, entry.value]));
}

/** Update the effective assignment while retaining comments, unknown commands and line endings. */
export function setServerConfigValue(text: string, name: string, value: string): string {
  if (!/^[\w.]+$/.test(name) || /["\r\n\u0000]/.test(value)) throw new Error("Invalid config value");
  const matching = assignments(text).filter(entry => entry.name === name.toLowerCase());
  const last = matching[matching.length - 1];
  if (last) return text.slice(0, last.valueStart) + `"${value}"` + text.slice(last.valueEnd);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return `${text}${text && !/[\r\n]$/.test(text) ? newline : ""}${name === "map" ? "map" : `set ${name}`} "${value}"${newline}`;
}

/** Drop assignments, retaining their surrounding comments and all unrelated commands. */
export function removeServerConfigValue(text: string, name: string): string {
  const masked = maskComments(text);
  return assignments(text).filter(entry => entry.name === name.toLowerCase()).reverse()
    .reduce((result, entry) => {
      const comments = [...text.slice(entry.start, entry.end).matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)]
        .filter(match => masked[entry.start + match.index] === " ").map(match => match[0]).join(" ");
      return result.slice(0, entry.start) + comments + result.slice(entry.end);
    }, text);
}

/** Sharing is refused even if a sensitive assignment is malformed or nested in a script. */
export function serverConfigSensitiveKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const span of commandSpans(text)) {
    for (const match of span.text.matchAll(/\b(?=([\w.]+)"?\s+("[^"\r\n]*"|[^\s;]+|$))/gi)) {
      const key = match[1];
      if (/(?:password|passwd|secret|token|rcon)/i.test(key) && match[2] !== '""') keys.add(key);
    }
  }
  return [...keys];
}

/** Remove every command that contains a detected credential, retaining comments. */
export function removeServerConfigSensitive(text: string): string {
  const masked = maskComments(text);
  return commandSpans(text).filter(span => serverConfigSensitiveKeys(span.text).length > 0).reverse()
    .reduce((result, span) => {
      const comments = [...text.slice(span.start, span.end).matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)]
        .filter(match => masked[span.start + match.index] === " ").map(match => match[0]).join(" ");
      return result.slice(0, span.start) + comments + result.slice(span.end);
    }, text);
}

export function serverConfigFilename(name: string): string {
  const base = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 100);
  return `${base || "server"}${/\.cfg$/i.test(base) ? "" : ".cfg"}`;
}

export function blankServerConfig(game: Game, name = ""): ServerConfigDocument {
  return { id: "", name, game, modId: "base", text: "" };
}
