/**
 * The danger scan of a config or a bind card: `scan_commands` of the
 * launcher's `src-tauri/src/chat/cards.rs`, the same rules and limits.
 *
 * Nothing on the web runs a command, but **Copy** puts the whole text of a
 * card on the clipboard, and the card shows only its first lines: the
 * player pastes it into the game, where every line runs. So the card names
 * what the text does before it is copied, as it does in the launcher.
 *
 * How the engine reads the text:
 *
 * - `Cbuf_Execute` (codemp/qcommon/cmd.cpp:176) cuts the buffer at `;` and at
 *   line breaks outside quotes. A `//` comment runs to the end of its line, a
 *   block comment keeps its line together.
 * - `vstr` (cmd.cpp:308) runs the value of a variable in place.
 * - `set`, `seta`, `sets` and `setu` (cvar.cpp:1047) join every argument
 *   after the name; `name value` sets a variable that exists (cvar.cpp:939).
 * - `bind` (cl_keys.cpp:1073) stores the arguments after the key, and a press
 *   (cl_keys.cpp:1224) cuts the binding at every `;`, quotes or not.
 *
 * Offsets are UTF-16 indexes here and bytes in Rust; every delimiter is
 * ASCII, so both cut the text at the same places.
 */

import type { ChatCommandDanger, ChatDangerReason } from "../../../../src/lib/ipc.ts";
import { invalidInput } from "../errors.ts";

type DangerReason = ChatDangerReason;

/** Longest text the scan reads; the limit of a config document (the launcher counts bytes). */
export const SCAN_BYTES_MAX = 1024 * 1024;
/** How deep bindings and `vstr` chains are followed. */
const SCAN_DEPTH_MAX = 12;
/** How many commands one scan looks at, nested ones included. */
const SCAN_BUDGET = 200_000;
/** How many values of one variable the scan remembers. */
const VALUES_MAX = 32;
/** How many variables the scan remembers. */
const VARIABLES_MAX = 4096;
/** How many dangers one scan names. */
const DANGERS_MAX = 500;
/** How much of a command a danger quotes. */
const QUOTE_MAX = 256;

const SET_VERBS = new Set(["set", "seta", "sets", "setu"]);
const WRITE_VERBS = new Set(["toggle", "reset", "unset", "cvaradd", "cvarsub", "cvarmult", "cvardiv", "cvarmod"]);
/** Commands the engine and the game register: `name value` sets a variable only when `name` is none of these. */
const COMMANDS = new Set([
  "set",
  "seta",
  "sets",
  "setu",
  "cvaradd",
  "cvarsub",
  "cvarmult",
  "cvardiv",
  "cvarmod",
  "exec",
  "execq",
  "alias",
  "cvar_restart",
  "unset_usercreated",
  "vstr",
  "wait",
  "echo",
  "bind",
  "unbind",
  "unbindall",
  "bindlist",
  "toggle",
  "reset",
  "unset",
  "print",
  "cvarlist",
  "cmdlist",
  "help",
  "writeconfig",
  "say",
  "say_team",
  "tell",
  "team",
  "kill",
  "follow",
  "quit",
  "disconnect",
  "connect",
  "reconnect",
  "record",
  "stoprecord",
  "demo",
  "screenshot",
  "screenshotjpeg",
  "vid_restart",
  "snd_restart",
  "cmd",
  "rcon",
  "toggleconsole",
  "togglemenu",
  "messagemode",
  "messagemode2",
  "messagemode3",
  "messagemode4",
  "clear",
]);

const blank = (code: number) => code <= 32;
const lower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const upper = (text: string) => text.replace(/[a-z]/g, (letter) => letter.toUpperCase());

interface Span {
  start: number;
  end: number;
}

function pushSpan(out: Span[], text: string, start: number, end: number): void {
  while (start < end && blank(text.charCodeAt(start))) start += 1;
  while (end > start && blank(text.charCodeAt(end - 1))) end -= 1;
  if (start < end) out.push({ start, end });
}

/** Splits config text or a variable's value into commands the way `Cbuf_Execute` does. */
export function splitCommands(text: string): Span[] {
  const n = text.length;
  const out: Span[] = [];
  let pos = 0;
  let inStar = false;
  let inSlash = false;
  while (pos < n) {
    let quotes = 0;
    let comment: number | null = null;
    let i = pos;
    while (i < n) {
      const c = text[i];
      if (c === '"') quotes += 1;
      if ((quotes & 1) === 0) {
        if (i + 1 < n) {
          const next = text[i + 1];
          if (!inStar && c === "/" && next === "/") {
            if (!inSlash && comment === null) comment = i;
            inSlash = true;
          } else if (!inSlash && c === "/" && next === "*") {
            if (comment === null) comment = i;
            inStar = true;
          } else if (inStar && c === "*" && next === "/") {
            inStar = false;
            i += 1;
            break;
          }
        }
        if (!inSlash && !inStar && c === ";") break;
      }
      if (!inStar && (c === "\n" || c === "\r")) {
        inSlash = false;
        break;
      }
      i += 1;
    }
    pushSpan(out, text, pos, comment ?? Math.min(i, n));
    pos = i + 1;
  }
  return out;
}

/** Splits a key binding the way a key press does: at every `;`, quotes or not. */
function splitBinding(binding: string): string[] {
  const lines = binding.split(";").join("\n");
  return splitCommands(lines).map((span) => lines.slice(span.start, span.end));
}

/** Splits one command into arguments the way `Cmd_TokenizeString` does. */
export function tokenize(line: string): string[] {
  const n = line.length;
  const out: string[] = [];
  let i = 0;
  for (;;) {
    for (;;) {
      while (i < n && blank(line.charCodeAt(i))) i += 1;
      if (i >= n) return out;
      if (line[i] === "/" && i + 1 < n && line[i + 1] === "/") return out;
      if (line[i] === "/" && i + 1 < n && line[i + 1] === "*") {
        while (i < n && !(line[i] === "*" && i + 1 < n && line[i + 1] === "/")) i += 1;
        if (i >= n) return out;
        i += 2;
      } else {
        break;
      }
    }
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      out.push(line.slice(i + 1, close < 0 ? n : close));
      if (close < 0) return out;
      i = close + 1;
      continue;
    }
    const start = i;
    while (
      i < n &&
      !blank(line.charCodeAt(i)) &&
      line[i] !== '"' &&
      !(line[i] === "/" && i + 1 < n && (line[i + 1] === "/" || line[i + 1] === "*"))
    ) {
      i += 1;
    }
    out.push(line.slice(start, i));
    if (i >= n) return out;
  }
}

/** Where each line starts: a line ends at `\n`, at `\r\n` and at a lone `\r`, as in the config editor. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const c = text[index];
    if (c === "\n" || (c === "\r" && text[index + 1] !== "\n")) starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  // The count of line starts at or before the offset.
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

type Mode = "text" | "binding";

function split(text: string, mode: Mode): string[] {
  return mode === "text" ? splitCommands(text).map((span) => text.slice(span.start, span.end)) : splitBinding(text);
}

/** The variable a command writes when it is one the scan watches. */
function watchedCvar(name: string): DangerReason | null {
  const lowered = lower(name);
  if (lowered === "cl_allowdownload") return "allow_download";
  if (lowered.startsWith("fs_")) return "filesystem";
  if (lowered.startsWith("sv_")) return "server_cvar";
  if (lowered.startsWith("rcon")) return "rcon";
  return null;
}

/** The first `max` characters of a trimmed command, as `clamp` of the launcher. */
function clamp(raw: string, max: number): string {
  const trimmed = raw.trim();
  const chars = [...trimmed];
  if (chars.length <= max) return trimmed;
  return chars.slice(0, max).join("").trimEnd();
}

interface Entry {
  line: number;
  /** Variables this command already ran, so a chain is followed once. */
  expanded: Set<string>;
}

class Scan {
  variables = new Map<string, string[]>();
  dangers: ChatCommandDanger[] = [];
  seen = new Set<string>();
  budget = SCAN_BUDGET;
  cut = false;

  spend(): boolean {
    if (this.budget === 0) {
      this.cut = true;
      return false;
    }
    this.budget -= 1;
    return true;
  }

  remember(name: string, value: string): void {
    const key = lower(name);
    if (this.variables.size >= VARIABLES_MAX && !this.variables.has(key)) {
      this.cut = true;
      return;
    }
    const values = this.variables.get(key) ?? [];
    this.variables.set(key, values);
    if (values.includes(value)) return;
    if (values.length >= VALUES_MAX) {
      this.cut = true;
      return;
    }
    values.push(value);
  }

  /** Learns every value every variable is given. */
  collect(text: string, mode: Mode, depth: number): void {
    for (const command of split(text, mode)) {
      if (!this.spend()) return;
      const words = tokenize(command);
      if (words.length === 0) continue;
      const verb = lower(words[0]);
      let nested: [string, Mode] | null = null;
      if (SET_VERBS.has(verb) && words.length >= 3) {
        const value = words.slice(2).join(" ");
        this.remember(words[1], value);
        nested = [value, "text"];
      } else if (verb === "bind" && words.length >= 3) {
        nested = [words.slice(2).join(" "), "binding"];
      } else if (!COMMANDS.has(verb) && !verb.startsWith("+") && !verb.startsWith("-") && words.length >= 2) {
        const value = words.slice(1).join(" ");
        this.remember(verb, value);
        nested = [value, "text"];
      }
      if (nested !== null) {
        if (depth < SCAN_DEPTH_MAX) this.collect(nested[0], nested[1], depth + 1);
        else this.cut = true;
      }
    }
  }

  flag(entry: Entry, command: string, reason: DangerReason, via: string[]): void {
    const quoted = clamp(command, QUOTE_MAX);
    const key = `${entry.line}\u0000${reason}\u0000${quoted}`;
    if (this.dangers.length >= DANGERS_MAX || this.seen.has(key)) return;
    this.seen.add(key);
    this.dangers.push({ line: entry.line, command: quoted, reason, via: [...via] });
  }

  check(text: string, mode: Mode, entry: Entry, via: string[], depth: number): void {
    for (const command of split(text, mode)) {
      if (this.budget === 0) {
        this.cut = true;
        return;
      }
      this.checkCommand(command, entry, via, depth);
    }
  }

  checkCommand(command: string, entry: Entry, via: string[], depth: number): void {
    if (!this.spend()) return;
    const words = tokenize(command);
    if (words.length === 0) return;
    const verb = lower(words[0]);
    // A leading slash is how a player types a command at the console.
    const name = verb.replace(/^[/\\]+/, "");
    let direct: DangerReason | null = null;
    if (name === "quit") direct = "quit";
    else if (name === "exec" || name === "execq") direct = "exec";
    else if (name === "writeconfig") direct = "write_config";
    else if (name === "connect") direct = "connect";
    else if (name === "reconnect") direct = "reconnect";
    else if (name === "unbindall") direct = "unbind_all";
    else if (name.startsWith("rcon")) direct = "rcon";
    if (direct !== null) this.flag(entry, command, direct, via);

    if (name === "bind" && words.length >= 3) {
      if (via.length > 0) this.flag(entry, command, "nested_bind", via);
      if (depth >= SCAN_DEPTH_MAX) {
        this.cut = true;
        return;
      }
      via.push(`bind ${upper(words[1])}`);
      this.check(words.slice(2).join(" "), "binding", entry, via, depth + 1);
      via.pop();
      return;
    }
    if (name === "vstr" && words.length === 2) {
      const variable = lower(words[1]);
      if (entry.expanded.has(variable)) return;
      entry.expanded.add(variable);
      const values = this.variables.get(variable);
      if (values === undefined) return;
      if (depth >= SCAN_DEPTH_MAX) {
        this.cut = true;
        return;
      }
      via.push(`vstr ${words[1]}`);
      for (const value of [...values]) this.check(value, "text", entry, via, depth + 1);
      via.pop();
      return;
    }
    if (name === "bind" || name === "vstr") return;
    let written: string | null = null;
    if (SET_VERBS.has(name)) written = words.length >= 3 ? words[1] : null;
    else if (WRITE_VERBS.has(name)) written = words.length >= 2 ? words[1] : null;
    else if (!COMMANDS.has(name) && !name.startsWith("+") && !name.startsWith("-")) written = words.length >= 2 ? name : null;
    const reason = written === null ? null : watchedCvar(written);
    if (reason !== null) this.flag(entry, command, reason, via);
  }
}

/**
 * Names every command of a config text, or of a bind as a config line, that
 * the player should read before it runs: the text itself, what its keys run
 * when pressed, and what its `vstr` chains reach. A text the scan cannot
 * follow to the end ends with `too_complex` on its first line.
 */
export function scanCommands(text: string): ChatCommandDanger[] {
  const scan = new Scan();
  scan.collect(text, "text", 0);
  // Learning the variables and checking the lines each get the whole budget.
  scan.budget = SCAN_BUDGET;
  const starts = lineStarts(text);
  const spans = splitCommands(text);
  for (const span of spans) {
    const entry: Entry = { line: lineOf(starts, span.start), expanded: new Set() };
    scan.checkCommand(text.slice(span.start, span.end), entry, [], 0);
    if (scan.budget === 0) {
      scan.cut = true;
      break;
    }
  }
  if (scan.cut) {
    const first = spans[0];
    const line = first === undefined ? 1 : lineOf(starts, first.start);
    const command = first === undefined ? "" : text.slice(first.start, first.end);
    // Past the cap of dangers the note still has to be there.
    scan.dangers.length = Math.min(scan.dangers.length, DANGERS_MAX - 1);
    scan.flag({ line, expanded: new Set() }, command, "too_complex", []);
  }
  return scan.dangers;
}

/** `chat_scan_commands`: the text of a card, checked for its size first. */
export function scanCommandsCommand(text: unknown): ChatCommandDanger[] {
  const value = typeof text === "string" ? text : "";
  if (new TextEncoder().encode(value).length > SCAN_BYTES_MAX) {
    throw invalidInput(`a config to check is at most ${SCAN_BYTES_MAX} bytes`);
  }
  return scanCommands(value);
}
