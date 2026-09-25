/**
 * Bind systems built on `vstr`: a sandbox of the engine's command buffer that
 * replays config sources, simulates key presses and edits the chains as
 * config text.
 *
 * A config can hold a whole system of binds. A key runs a variable with
 * `vstr`, the variable runs others, sets them and rebinds keys, so what the
 * next press does depends on the presses before it: menus, submenus, modes
 * and toggles. The sandbox follows the engine closely enough to draw that
 * system as a graph of states and to rewrite it, and it names what it cannot
 * follow instead of guessing.
 *
 * Engine behaviour copied here, OpenJK `1a6a6434`:
 * - `Cbuf_Execute` (codemp/qcommon/cmd.cpp:176) cuts the buffer at `;` and at
 *   line breaks outside quotes. A `//` comment runs to the end of its line, a
 *   block comment keeps its line together, and the loop runs until the buffer
 *   is empty.
 * - `vstr` (cmd.cpp:308) inserts the variable's current value in front of the
 *   buffer, so an expansion runs in place and depth first. Nothing stops a
 *   variable that runs itself: without `wait` the frame never ends.
 * - `wait` (cmd.cpp:56) leaves the rest of the buffer to later frames.
 * - `set`, `seta`, `sets` and `setu` (cvar.cpp:1047) join every argument after
 *   the name. `name value` sets a variable only when it exists (cvar.cpp:939).
 * - `bind` (cl_keys.cpp:1073) stores the arguments after the key. A press
 *   (cl_keys.cpp:1224) splits the binding at every `;`, runs `+` commands with
 *   a matching `-` on release and everything else on press only.
 *
 * The module is pure: no React, no strings for the screen.
 */
import type { BindSource } from "./quakeConfig";

// ================================================================= parsing

/** One command of a text, with its offsets so an edit can replace it in place. */
export interface CommandSpan {
  /** The command without its comment, trimmed. */
  text: string;
  start: number;
  end: number;
}

function blank(code: number): boolean {
  return code <= 32;
}

function pushSpan(out: CommandSpan[], text: string, start: number, end: number): void {
  while (start < end && blank(text.charCodeAt(start))) start++;
  while (end > start && blank(text.charCodeAt(end - 1))) end--;
  if (start < end) out.push({ text: text.slice(start, end), start, end });
}

/**
 * Splits config text or a variable's value into commands the way
 * `Cbuf_Execute` does. Blank lines and comments yield no command.
 */
export function splitCommands(text: string): CommandSpan[] {
  const out: CommandSpan[] = [];
  const n = text.length;
  let pos = 0;
  let inStar = false;
  let inSlash = false;
  while (pos < n) {
    let quotes = 0;
    let comment = -1;
    let i = pos;
    for (; i < n; i++) {
      const c = text[i];
      if (c === '"') quotes++;
      if (!(quotes & 1)) {
        if (i < n - 1) {
          const next = text[i + 1];
          if (!inStar && c === "/" && next === "/") {
            if (!inSlash && comment < 0) comment = i;
            inSlash = true;
          } else if (!inSlash && c === "/" && next === "*") {
            if (comment < 0) comment = i;
            inStar = true;
          } else if (inStar && c === "*" && next === "/") {
            inStar = false;
            i++;
            break;
          }
        }
        if (!inSlash && !inStar && c === ";") break;
      }
      if (!inStar && (c === "\n" || c === "\r")) {
        inSlash = false;
        break;
      }
    }
    pushSpan(out, text, pos, comment >= 0 ? comment : Math.min(i, n));
    pos = i + 1;
  }
  return out;
}

/**
 * Splits a key binding the way a key press does. `CL_ParseBinding`
 * (cl_keys.cpp:1224) cuts it at every `;`, quotes or not, and appends each
 * part to the buffer with a line break of its own, which `Cbuf_Execute` then
 * splits like config text: a `//` comment ends with its part, a block comment
 * ends a command right after its `*\/`, and a block comment left open runs
 * over the following parts, since a line break does not end it (cmd.cpp:225).
 * Turning every `;` into a line break is that buffer, offset for offset.
 */
export function splitBinding(binding: string): CommandSpan[] {
  return splitCommands(binding.replace(/;/g, "\n")).map((span) => ({
    ...span,
    text: binding.slice(span.start, span.end),
  }));
}

/**
 * The `+` commands of a binding as a press sees them: a part that starts with
 * `+` once its leading spaces are skipped. On release the engine runs the
 * matching `-` command for each of them.
 */
function buttonCommands(binding: string): { index: number; word: string }[] {
  return binding.split(";").flatMap((part, index) => {
    const word = part.trimStart().startsWith("+") ? tokenizeCommand(part)[0] : undefined;
    return word?.startsWith("+") ? [{ index, word }] : [];
  });
}

/** Splits one command into arguments the way `Cmd_TokenizeString` does. */
export function tokenizeCommand(line: string): string[] {
  const out: string[] = [];
  const n = line.length;
  let i = 0;
  for (;;) {
    for (;;) {
      while (i < n && blank(line.charCodeAt(i))) i++;
      if (i >= n) return out;
      if (line[i] === "/" && line[i + 1] === "/") return out;
      if (line[i] === "/" && line[i + 1] === "*") {
        while (i < n && !(line[i] === "*" && line[i + 1] === "/")) i++;
        if (i >= n) return out;
        i += 2;
      } else break;
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
      !(line[i] === "/" && (line[i + 1] === "/" || line[i + 1] === "*"))
    )
      i++;
    out.push(line.slice(start, i));
    if (i >= n) return out;
  }
}

// ================================================================ commands

const SET_VERBS = new Set(["set", "seta", "sets", "setu"]);
const MATH_VERBS = new Set(["cvaradd", "cvarsub", "cvarmult", "cvardiv", "cvarmod"]);
/** Commands whose effect on bindings and variables the sandbox cannot see. */
const OPAQUE_VERBS = new Set(["exec", "execq", "alias", "cvar_restart", "unset_usercreated"]);
/**
 * Commands the engine and the game register. `name value` sets a variable
 * only when `name` is none of these: `Cmd_ExecuteString` (cmd.cpp:822) looks
 * for a command before it looks for a variable.
 */
const COMMANDS = new Set([
  ...SET_VERBS,
  ...MATH_VERBS,
  ...OPAQUE_VERBS,
  "vstr", "wait", "echo", "bind", "unbind", "unbindall", "bindlist", "toggle", "reset", "unset",
  "print", "cvarlist", "cmdlist", "help", "writeconfig", "say", "say_team", "tell", "team", "kill",
  "follow", "quit", "disconnect", "connect", "reconnect", "record", "stoprecord", "demo",
  "screenshot", "screenshotjpeg", "vid_restart", "snd_restart", "cmd", "rcon", "toggleconsole",
  "togglemenu", "messagemode", "messagemode2", "messagemode3", "messagemode4", "clear",
]);

/**
 * What a command means to the chain:
 * - `effect`: something the player sees or the game does, including setting a
 *   variable no chain runs;
 * - `call`: `vstr`, which runs a variable in place;
 * - `link`: sets a variable some chain runs, or rebinds the pressed key, so the
 *   next press goes elsewhere;
 * - `branch`: rebinds another key, which opens a branch for that key;
 * - `wait`: defers the rest to a later frame;
 * - `opaque`: `exec` and the like, whose effect the sandbox cannot follow.
 */
export type CommandRole = "effect" | "call" | "link" | "branch" | "wait" | "opaque";
const VISIBLE_ROLES = new Set<CommandRole>(["effect", "wait", "opaque"]);

/** Key tokens as `bind` accepts them; the same rule as `appendBind`. */
const KEY_PATTERN = /^[A-Za-z0-9_+\-[\]\\/.,=']+$/;

export function normalizeKey(key: string): string {
  return key.toUpperCase();
}

/** The variable a command assigns, lower case, or null. */
function assignmentTarget(words: readonly string[], exists: (name: string) => boolean): string | null {
  const verb = words[0].toLowerCase();
  if (SET_VERBS.has(verb)) return words.length >= 3 ? words[1].toLowerCase() : null;
  if (verb === "toggle") return words.length === 2 || words.length >= 4 ? words[1].toLowerCase() : null;
  if (MATH_VERBS.has(verb)) return words.length === 3 ? words[1].toLowerCase() : null;
  if (verb === "reset" || verb === "unset") return words.length === 2 ? words[1].toLowerCase() : null;
  if (!COMMANDS.has(verb) && words.length >= 2 && exists(verb)) return verb;
  return null;
}

/** The key a `bind` or `unbind` command writes, upper case, or null. */
function keyWritten(words: readonly string[]): string | null {
  const verb = words[0]?.toLowerCase();
  if ((verb === "bind" && words.length >= 3) || (verb === "unbind" && words.length === 2))
    return normalizeKey(words[1]);
  return null;
}

/** The binding a `bind` or `unbind` command writes: "" for `unbind`. */
function bindingWritten(words: readonly string[]): string {
  return words[0].toLowerCase() === "bind" ? words.slice(2).join(" ") : "";
}

function roleOf(
  words: readonly string[],
  pressed: string | null,
  chainVariables: ReadonlySet<string>,
  exists: (name: string) => boolean,
): CommandRole {
  const verb = words[0].toLowerCase();
  if (verb === "vstr") return "call";
  if (verb === "wait") return "wait";
  if (OPAQUE_VERBS.has(verb)) return "opaque";
  const key = keyWritten(words);
  if (key !== null) return key === pressed ? "link" : "branch";
  if (verb === "unbindall") return "branch";
  const target = assignmentTarget(words, exists);
  return target !== null && chainVariables.has(target) ? "link" : "effect";
}

/** Text an argument list carries as commands: a bound command or a variable value. */
function nestedText(words: readonly string[]): { text: string; mode: TextMode } | null {
  const verb = words[0].toLowerCase();
  if (verb === "bind" && words.length >= 3) return { text: words.slice(2).join(" "), mode: "binding" };
  if (SET_VERBS.has(verb) && words.length >= 3) return { text: words.slice(2).join(" "), mode: "text" };
  if (!COMMANDS.has(verb) && !/^[+-]/.test(verb) && words.length >= 2)
    return { text: words.slice(1).join(" "), mode: "text" };
  return null;
}

type TextMode = "text" | "binding";

function splitText(text: string, mode: TextMode): CommandSpan[] {
  return mode === "binding" ? splitBinding(text) : splitCommands(text);
}

/** Collects, lower case, every variable some text can run with `vstr`, nested arguments included. */
function collectCalls(text: string, mode: TextMode, into: Set<string>): void {
  for (const span of splitText(text, mode)) {
    const words = tokenizeCommand(span.text);
    if (!words.length) continue;
    if (words[0].toLowerCase() === "vstr" && words.length === 2) into.add(words[1].toLowerCase());
    const nested = nestedText(words);
    if (nested) collectCalls(nested.text, nested.mode, into);
  }
}

/** True when a binding or value runs `vstr` as one of its own commands. */
export function runsVstr(command: string, mode: TextMode = "binding"): boolean {
  return splitText(command, mode).some((span) => tokenizeCommand(span.text)[0]?.toLowerCase() === "vstr");
}

function callTarget(command: string): string | null {
  const words = tokenizeCommand(command);
  return words.length === 2 && words[0].toLowerCase() === "vstr" ? words[1] : null;
}

function isCallOf(command: string, name: string): boolean {
  return callTarget(command)?.toLowerCase() === name.toLowerCase();
}

function atof(value: string): number {
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function atoi(value: string): number {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** `Cvar_SetValue` prints whole numbers with `%i` and the rest with `%f`. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value === 0 ? 0 : value) : value.toFixed(6);
}

// =================================================================== state

export interface TextSpan {
  start: number;
  end: number;
}

/** Where a binding or a variable got its value. */
export interface Origin {
  /** Index into the analysed sources, or -1 when a simulated press set it. */
  sourceIndex: number;
  /** The top-level command of that source that set it; null when a `vstr` it ran or a press did. */
  span: TextSpan | null;
  /** The command word that set it, lower case: `set`, `seta`, `bind`, `unbind`, `toggle`, `direct`… */
  verb: string;
}

export interface BindingRecord {
  /** Upper case. */
  key: string;
  /** "" once unbound. */
  command: string;
  origin: Origin;
}

export interface VariableRecord {
  /** Spelling of the command that created it. */
  name: string;
  value: string;
  /** Value at creation: what `reset` restores. */
  reset: string;
  origin: Origin;
}

export interface ChainLayer {
  readonly bindings: ReadonlyMap<string, BindingRecord>;
  /** Lower-case name to record; null once `unset`. */
  readonly variables: ReadonlyMap<string, VariableRecord | null>;
  /** `unbindall` ran, so the layer below holds no bindings. */
  readonly cleared: boolean;
}

export interface ChainSourceInfo {
  source: string;
  kind: BindSource["kind"];
}

export interface ChainState {
  readonly sources: readonly ChainSourceInfo[];
  /** Index of the edited source, or -1. */
  readonly editedIndex: number;
  /** Lower-case names some text runs with `vstr`: the variables a chain branches on. */
  readonly chainVariables: ReadonlySet<string>;
  /** Problems met while the sources ran, top-level `vstr` included. */
  readonly loadDiagnostics: readonly ChainDiagnostic[];
  /** An `exec` or another command the sandbox cannot follow ran while the sources loaded. */
  readonly loadOpaque: boolean;
  /** Bindings and variables as the sources leave them: the start state. */
  readonly start: ChainLayer;
  /** What simulated presses changed on top of `start`. */
  readonly layer: ChainLayer;
}

const EMPTY_LAYER: ChainLayer = { bindings: new Map(), variables: new Map(), cleared: false };

function bindingRecord(state: ChainState, key: string): BindingRecord | undefined {
  const own = state.layer.bindings.get(key);
  if (own) return own;
  return state.layer.cleared ? undefined : state.start.bindings.get(key);
}

/** The key's binding in this state, "" when unbound. */
export function bindingOf(state: ChainState, key: string): string {
  return bindingRecord(state, normalizeKey(key))?.command ?? "";
}

/** The key's binding in the start state, "" when unbound. */
export function startBindingOf(state: ChainState, key: string): string {
  return state.start.bindings.get(normalizeKey(key))?.command ?? "";
}

export function variableOf(state: ChainState, name: string): VariableRecord | undefined {
  const lower = name.toLowerCase();
  if (state.layer.variables.has(lower)) return state.layer.variables.get(lower) ?? undefined;
  return state.start.variables.get(lower) ?? undefined;
}

// ============================================================= diagnostics

/**
 * - `missing`: `vstr` of a variable no source defines, so it runs nothing;
 * - `immediateLoop`: a chain runs a variable again without a `wait` and with
 *   nothing changed, so the frame never ends and the game hangs;
 * - `frameLoop`: the same after a `wait`: the chain repeats every frame;
 * - `opaque`: `exec` or another command the sandbox cannot follow;
 * - `usage`: a `vstr` without exactly one variable, which only prints its usage;
 * - `limit`: a cap stopped the simulation (`subject` names it).
 */
export type ChainDiagnosticKind = "missing" | "immediateLoop" | "frameLoop" | "opaque" | "usage" | "limit";

/** Where a command is written. */
export type CommandContainer =
  | { kind: "binding"; key: string }
  | { kind: "variable"; name: string }
  | { kind: "source"; index: number };

export interface ChainDiagnostic {
  kind: ChainDiagnosticKind;
  /** Variable name, command text, or the cap: `commands`, `depth`, `nodes`, `presses`. */
  subject: string;
  container: CommandContainer;
  /** Position of the command among the commands of its container. */
  index: number;
  /** Presses from the start state that lead to it; null while the sources load. */
  path: string[] | null;
  /** `missing` only: an `exec` or the like ran before and may have defined it. */
  afterOpaque?: boolean;
}

export interface ChainOptions {
  /** Commands one press, or one top-level command of a source, may run. */
  maxCommands?: number;
  /** Nested `vstr` one press may run. */
  maxDepth?: number;
  /** States a graph may hold. */
  maxNodes?: number;
  /** Presses one path or one cycle may hold. */
  maxPresses?: number;
}

type Limits = Required<ChainOptions>;
const DEFAULT_LIMITS: Limits = { maxCommands: 4000, maxDepth: 64, maxNodes: 64, maxPresses: 24 };

function limitsOf(options?: ChainOptions): Limits {
  return { ...DEFAULT_LIMITS, ...options };
}

// ================================================================= machine

export interface ChainCommand {
  /** The command as written in its container, without comment. */
  text: string;
  role: CommandRole;
  container: CommandContainer;
  /** Position among the commands of the container. */
  index: number;
  /** Frames after the press the command runs in: 0 is the frame of the press. */
  frame: number;
  /** `call`: the variable run. Assignments: the variable set. `bind`, `unbind`: the key. */
  target?: string;
  /** New value of the variable or new binding of the key; "" once unbound. */
  value?: string;
  /** `call`: the commands of the variable, run in place. */
  children?: ChainCommand[];
  /** `call`: no source defines the variable, so it runs nothing. */
  missing?: boolean;
  /**
   * `call`: the variable is already running and nothing it branches on changed:
   * `immediate` hangs the game, `frame` repeats every frame.
   */
  loop?: "immediate" | "frame";
}

export type StepOutcome = "done" | "immediateLoop" | "frameLoop" | "limit";

interface Machine {
  readonly limits: Limits;
  readonly start: ChainLayer;
  bindings: Map<string, BindingRecord>;
  variables: Map<string, VariableRecord | null>;
  cleared: boolean;
  readonly chainVariables: ReadonlySet<string>;
  readonly pressed: string | null;
  readonly path: string[] | null;
  sourceIndex: number;
  top: TextSpan | null;
  log: { name: string; before: string | undefined }[];
  stack: { name: string; log: number; waits: number }[];
  commands: number;
  frame: number;
  waits: number;
  stopped: StepOutcome | null;
  opaque: boolean;
  diagnostics: ChainDiagnostic[];
  touchedKeys: Set<string>;
  touchedVariables: Set<string>;
}

function machine(
  limits: Limits,
  start: ChainLayer,
  layer: ChainLayer,
  chainVariables: ReadonlySet<string>,
  pressed: string | null,
  path: string[] | null,
  opaque: boolean,
): Machine {
  return {
    limits,
    start,
    bindings: new Map(layer.bindings),
    variables: new Map(layer.variables),
    cleared: layer.cleared,
    chainVariables,
    pressed,
    path,
    sourceIndex: -1,
    top: null,
    log: [],
    stack: [],
    commands: 0,
    frame: 0,
    waits: 0,
    stopped: null,
    opaque,
    diagnostics: [],
    touchedKeys: new Set(),
    touchedVariables: new Set(),
  };
}

function readBinding(m: Machine, key: string): BindingRecord | undefined {
  return m.bindings.get(key) ?? (m.cleared ? undefined : m.start.bindings.get(key));
}

function readVariable(m: Machine, name: string): VariableRecord | undefined {
  if (m.variables.has(name)) return m.variables.get(name) ?? undefined;
  return m.start.variables.get(name) ?? undefined;
}

function originOf(m: Machine, depth: number, verb: string): Origin {
  return { sourceIndex: m.sourceIndex, span: depth === 0 ? m.top : null, verb };
}

function report(m: Machine, kind: ChainDiagnosticKind, subject: string, container: CommandContainer, index: number): void {
  const diagnostic: ChainDiagnostic = { kind, subject, container, index, path: m.path };
  if (kind === "missing" && m.opaque) diagnostic.afterOpaque = true;
  m.diagnostics.push(diagnostic);
}

function stop(
  m: Machine,
  outcome: Exclude<StepOutcome, "done">,
  subject: string,
  container: CommandContainer,
  index: number,
): void {
  m.stopped = outcome;
  report(m, outcome, subject, container, index);
}

/** True when a variable some chain runs differs from its value at log position `from`. */
function changedSince(m: Machine, from: number): boolean {
  const first = new Map<string, string | undefined>();
  for (let i = from; i < m.log.length; i++) if (!first.has(m.log[i].name)) first.set(m.log[i].name, m.log[i].before);
  for (const [name, before] of first)
    if (m.chainVariables.has(name) && readVariable(m, name)?.value !== before) return true;
  return false;
}

function runText(m: Machine, text: string, container: CommandContainer, mode: TextMode, depth: number): ChainCommand[] {
  const nodes: ChainCommand[] = [];
  const spans = splitText(text, mode);
  for (let index = 0; index < spans.length && !m.stopped; index++) {
    const node = run(m, spans[index].text, container, index, depth);
    if (node) nodes.push(node);
  }
  return nodes;
}

function run(m: Machine, text: string, container: CommandContainer, index: number, depth: number): ChainCommand | null {
  const words = tokenizeCommand(text);
  if (!words.length) return null;
  if (++m.commands > m.limits.maxCommands) {
    stop(m, "limit", "commands", container, index);
    return null;
  }
  const verb = words[0].toLowerCase();
  const node: ChainCommand = { text, role: "effect", container, index, frame: m.frame };
  if (verb === "vstr") return call(m, node, words, depth);
  if (verb === "wait") {
    node.role = "wait";
    const frames = words.length === 2 ? (atoi(words[1]) < 0 ? 1 : atoi(words[1])) : 1;
    m.frame += frames;
    if (frames > 0) m.waits++;
    return node;
  }
  if (OPAQUE_VERBS.has(verb)) {
    node.role = "opaque";
    m.opaque = true;
    report(m, "opaque", text, container, index);
    return node;
  }
  const key = keyWritten(words);
  if (key !== null) {
    const command = bindingWritten(words);
    m.bindings.set(key, { key, command, origin: originOf(m, depth, verb) });
    m.touchedKeys.add(key);
    node.role = key === m.pressed ? "link" : "branch";
    node.target = key;
    node.value = command;
    return node;
  }
  if (verb === "unbindall") {
    for (const bound of m.bindings.keys()) m.touchedKeys.add(bound);
    if (!m.cleared) for (const bound of m.start.bindings.keys()) m.touchedKeys.add(bound);
    m.bindings.clear();
    m.cleared = true;
    node.role = "branch";
    return node;
  }
  const target = assignmentTarget(words, (name) => readVariable(m, name) !== undefined);
  if (target !== null) assign(m, node, words, target, depth);
  return node;
}

function call(m: Machine, node: ChainCommand, words: string[], depth: number): ChainCommand {
  node.role = "call";
  if (words.length !== 2) {
    report(m, "usage", node.text, node.container, node.index);
    return node;
  }
  const lower = words[1].toLowerCase();
  const variable = readVariable(m, lower);
  node.target = variable?.name ?? words[1];
  if (!variable) {
    node.missing = true;
    report(m, "missing", node.target, node.container, node.index);
    return node;
  }
  for (let i = m.stack.length - 1; i >= 0; i--) {
    const running = m.stack[i];
    if (running.name !== lower || changedSince(m, running.log)) continue;
    node.loop = m.waits > running.waits ? "frame" : "immediate";
    stop(m, node.loop === "frame" ? "frameLoop" : "immediateLoop", variable.name, node.container, node.index);
    return node;
  }
  if (depth >= m.limits.maxDepth) {
    stop(m, "limit", "depth", node.container, node.index);
    return node;
  }
  m.stack.push({ name: lower, log: m.log.length, waits: m.waits });
  node.children = runText(m, variable.value, { kind: "variable", name: variable.name }, "text", depth + 1);
  m.stack.pop();
  return node;
}

function toggled(current: string, words: readonly string[]): string {
  if (words.length === 2) return atof(current) ? "0" : "1";
  for (let i = 2; i + 1 < words.length; i++) if (current === words[i]) return words[i + 1];
  return words[2];
}

function arithmetic(verb: string, current: string, argument: string): string | undefined {
  const a = Math.fround(atof(current));
  const b = Math.fround(atof(argument));
  if (verb === "cvaradd") return formatValue(Math.fround(a + b));
  if (verb === "cvarsub") return formatValue(Math.fround(a - b));
  if (verb === "cvarmult") return formatValue(Math.fround(a * b));
  if (verb === "cvardiv") return b === 0 ? undefined : formatValue(Math.fround(a / b));
  const divisor = atoi(argument);
  return divisor === 0 ? undefined : formatValue(atoi(current) % divisor);
}

function assign(m: Machine, node: ChainCommand, words: string[], target: string, depth: number): void {
  const verb = words[0].toLowerCase();
  const current = readVariable(m, target);
  let value: string | null | undefined;
  let how = verb;
  if (SET_VERBS.has(verb)) value = words.slice(2).join(" ");
  else if (verb === "toggle") value = toggled(current?.value ?? "", words);
  else if (MATH_VERBS.has(verb)) value = arithmetic(verb, current?.value ?? "", words[2]);
  else if (verb === "reset") value = current?.reset;
  else if (verb === "unset") value = current ? null : undefined;
  else {
    how = "direct";
    value = words[1] === "!" ? (atof(current?.value ?? "") ? "0" : "1") : words.slice(1).join(" ");
  }
  if (value === undefined) return;
  const spelling = how === "direct" ? words[0] : words[1];
  m.log.push({ name: target, before: current?.value });
  m.touchedVariables.add(target);
  m.variables.set(
    target,
    value === null
      ? null
      : { name: current?.name ?? spelling, value, reset: current?.reset ?? value, origin: originOf(m, depth, how) },
  );
  node.role = m.chainVariables.has(target) ? "link" : "effect";
  node.target = current?.name ?? spelling;
  node.value = value ?? "";
}

// ==================================================================== load

/**
 * Runs the sources in order, top-level `vstr` included, and returns the
 * start state. Later sources win, as in `effectiveBinds`. A loop met while a
 * source loads stops that command only; the next command still runs.
 */
export function loadChainState(sources: readonly BindSource[], options?: ChainOptions): ChainState {
  const limits = limitsOf(options);
  const chainVariables = new Set<string>();
  for (const source of sources) collectCalls(source.text, "text", chainVariables);
  const m = machine(limits, EMPTY_LAYER, EMPTY_LAYER, chainVariables, null, null, false);
  sources.forEach((source, sourceIndex) => {
    m.sourceIndex = sourceIndex;
    const container: CommandContainer = { kind: "source", index: sourceIndex };
    splitCommands(source.text).forEach((span, index) => {
      m.top = { start: span.start, end: span.end };
      m.commands = 0;
      m.frame = 0;
      m.waits = 0;
      m.stopped = null;
      m.stack = [];
      m.log = [];
      run(m, span.text, container, index, 0);
    });
  });
  const variables = new Map<string, VariableRecord | null>();
  for (const [name, record] of m.variables) if (record) variables.set(name, record);
  return {
    sources: sources.map(({ source, kind }) => ({ source, kind })),
    editedIndex: sources.findIndex((source) => source.kind === "edited"),
    chainVariables,
    loadDiagnostics: m.diagnostics,
    loadOpaque: m.opaque,
    start: { bindings: m.bindings, variables, cleared: false },
    layer: EMPTY_LAYER,
  };
}

/**
 * The same state with the key bound to `command` from the start: a preview
 * of a command typed in the editor but not written to the config yet.
 */
export function withStartBinding(state: ChainState, key: string, command: string): ChainState {
  const upper = normalizeKey(key);
  const bindings = new Map(state.start.bindings);
  bindings.set(upper, { key: upper, command, origin: { sourceIndex: -1, span: null, verb: "bind" } });
  const chainVariables = new Set(state.chainVariables);
  collectCalls(command, "binding", chainVariables);
  return { ...state, chainVariables, start: { ...state.start, bindings } };
}

// =================================================================== press

export interface KeyChange {
  key: string;
  /** The binding after the press, "" when unbound. */
  command: string;
  /** The key is back to its binding in the start state. */
  restore: boolean;
}

export interface VariableChange {
  name: string;
  /** null once `unset`. */
  value: string | null;
}

/** One press of one key: what runs, what it changes, the state after it. */
export interface ChainStep {
  key: string;
  /** The key's binding when pressed, "" when unbound. */
  binding: string;
  /** The binding's commands, with `vstr` expansions nested. */
  commands: ChainCommand[];
  /** `-` halves of the `+` commands the key's binding holds after the press, run on release. */
  release: ChainCommand[];
  /**
   * Where the commands of this press are written: the first variable that does
   * more than forward to another one with `vstr`, or the binding itself. Null
   * when the key is unbound or the chain ends in a missing variable.
   */
  body: CommandContainer | null;
  /** The commands of `body` as they ran. */
  bodyCommands: ChainCommand[];
  /** Variables between the binding and the body that only forward with `vstr`. */
  pointers: string[];
  /** The missing variable the chain ends in, or null. */
  missing: string | null;
  /** `bodyCommands` a player sees: effects, waits and opaque commands. */
  visible: ChainCommand[];
  /** Variables `body` runs with `vstr`, in order. */
  calls: string[];
  /** Keys whose binding differs after the press, in the order they were first written. */
  rebinds: KeyChange[];
  /** Variables some chain runs whose value differs after the press. */
  assignments: VariableChange[];
  /** Frames the press spans: the frames all its `wait` add up to. */
  frames: number;
  outcome: StepOutcome;
  diagnostics: ChainDiagnostic[];
  state: ChainState;
}

function press(state: ChainState, key: string, limits: Limits, path: string[] | null): ChainStep {
  const upper = normalizeKey(key);
  const m = machine(limits, state.start, state.layer, state.chainVariables, upper, path, state.loadOpaque);
  const binding = readBinding(m, upper)?.command ?? "";
  const container: CommandContainer = { kind: "binding", key: upper };
  const commands = binding ? runText(m, binding, container, "binding", 0) : [];
  const release: ChainCommand[] = [];
  if (m.stopped !== "immediateLoop" && m.stopped !== "limit")
    for (const { index, word } of buttonCommands(readBinding(m, upper)?.command ?? ""))
      release.push({ text: `-${word.slice(1)}`, role: "effect", container, index, frame: m.frame });
  const after: ChainState = {
    ...state,
    layer: { bindings: m.bindings, variables: m.variables, cleared: m.cleared },
  };
  let body: CommandContainer | null = binding ? container : null;
  let bodyCommands = commands;
  let missing: string | null = null;
  const pointers: string[] = [];
  while (body && bodyCommands.length === 1 && bodyCommands[0].role === "call") {
    const only = bodyCommands[0];
    if (only.missing) {
      missing = only.target ?? null;
      body = null;
      bodyCommands = [];
      break;
    }
    if (!only.children || only.loop || !only.target) break;
    if (body.kind === "variable") pointers.push(body.name);
    body = { kind: "variable", name: only.target };
    bodyCommands = only.children;
  }
  const rebinds: KeyChange[] = [];
  for (const touched of m.touchedKeys) {
    const now = bindingOf(after, touched);
    if (now !== bindingOf(state, touched))
      rebinds.push({ key: touched, command: now, restore: now === startBindingOf(state, touched) });
  }
  const assignments: VariableChange[] = [];
  for (const name of m.touchedVariables) {
    if (!state.chainVariables.has(name)) continue;
    const now = variableOf(after, name);
    const was = variableOf(state, name);
    if (now?.value !== was?.value) assignments.push({ name: now?.name ?? was?.name ?? name, value: now?.value ?? null });
  }
  return {
    key: upper,
    binding,
    commands,
    release,
    body,
    bodyCommands,
    pointers,
    missing,
    visible: bodyCommands.filter((command) => VISIBLE_ROLES.has(command.role)),
    calls: bodyCommands.flatMap((command) => (command.role === "call" && command.target ? [command.target] : [])),
    rebinds,
    assignments,
    frames: m.frame,
    outcome: m.stopped ?? "done",
    diagnostics: m.diagnostics,
    state: after,
  };
}

/** Presses the key once in this state. */
export function pressKey(state: ChainState, key: string, options?: ChainOptions): ChainStep {
  return press(state, key, limitsOf(options), [normalizeKey(key)]);
}

/** Presses the keys in order from this state; the last step is returned with the state before it. */
export function replayPresses(
  state: ChainState,
  path: readonly string[],
  options?: ChainOptions,
): { before: ChainState; step: ChainStep } {
  if (!path.length) throw new ChainEditError("unsupported", "No key press given");
  const limits = limitsOf(options);
  const keys = path.map(normalizeKey);
  let before = state;
  let step = press(before, keys[0], limits, keys.slice(0, 1));
  for (let i = 1; i < keys.length; i++) {
    before = step.state;
    step = press(before, keys[i], limits, keys.slice(0, i + 1));
  }
  return { before, step };
}

// ================================================================= systems

/** Keys and variables that act on each other: a bind system. */
export interface ChainSystem {
  /** Keys whose binding runs the system, in source order. */
  roots: string[];
  /** Every key the system presses or rebinds, roots first. */
  keys: string[];
  /** Variables, lower case, the system runs or sets. */
  variables: string[];
}

interface Footprint {
  key: string;
  vars: Set<string>;
  keys: Set<string>;
  writes: Set<string>;
  assigned: Set<string>;
  order: string[];
}

/** Everything a key's binding can reach: variables it runs, keys it rebinds, variables it sets. */
function footprint(state: ChainState, key: string): Footprint {
  const print: Footprint = { key, vars: new Set(), keys: new Set([key]), writes: new Set(), assigned: new Set(), order: [] };
  const queue: [string, TextMode][] = [[bindingOf(state, key), "binding"]];
  const exists = (name: string) => variableOf(state, name) !== undefined;
  const visit = (text: string, mode: TextMode): void => {
    for (const span of splitText(text, mode)) {
      const words = tokenizeCommand(span.text);
      if (!words.length) continue;
      if (words[0].toLowerCase() === "vstr" && words.length === 2) {
        const name = words[1].toLowerCase();
        if (!print.vars.has(name)) {
          print.vars.add(name);
          print.order.push(name);
          const record = variableOf(state, name);
          if (record) queue.push([record.value, "text"]);
        }
      }
      const written = keyWritten(words);
      if (written !== null) {
        print.writes.add(written);
        if (!print.keys.has(written)) {
          print.keys.add(written);
          queue.push([bindingOf(state, written), "binding"]);
        }
      }
      const target = assignmentTarget(words, exists);
      if (target !== null && state.chainVariables.has(target)) {
        print.assigned.add(target);
        if (!print.vars.has(target) && !print.order.includes(target)) print.order.push(target);
      }
      const nested = nestedText(words);
      if (nested) visit(nested.text, nested.mode);
    }
  };
  for (let item = queue.shift(); item; item = queue.shift()) visit(item[0], item[1]);
  return print;
}

function interact(a: Footprint, b: Footprint): boolean {
  for (const name of a.assigned) if (b.vars.has(name) || b.assigned.has(name)) return true;
  for (const name of b.assigned) if (a.vars.has(name)) return true;
  for (const key of a.keys) if (b.keys.has(key)) return true;
  return false;
}

function boundKeys(state: ChainState): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (!seen.has(key) && bindingOf(state, key)) {
      seen.add(key);
      keys.push(key);
    }
  };
  if (!state.layer.cleared) for (const key of state.start.bindings.keys()) add(key);
  for (const key of state.layer.bindings.keys()) add(key);
  return keys;
}

/**
 * Groups the keys of this state into bind systems. Keys belong together when
 * one sets a variable the other runs or sets, or when both touch the same key.
 * A helper variable two keys only run does not join them.
 */
export function chainSystems(state: ChainState): ChainSystem[] {
  const prints = boundKeys(state)
    .map((key) => footprint(state, key))
    .filter((print) => print.vars.size > 0 || print.writes.size > 0);
  const parent = prints.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < prints.length; i++)
    for (let j = i + 1; j < prints.length; j++) if (interact(prints[i], prints[j])) parent[find(j)] = find(i);
  const groups = new Map<number, Footprint[]>();
  prints.forEach((print, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), print]);
  });
  return [...groups.values()].map((group) => {
    const roots = group.map((print) => print.key);
    const keys = [...roots];
    const variables: string[] = [];
    for (const print of group) {
      for (const key of print.keys) if (!keys.includes(key)) keys.push(key);
      for (const name of print.order) if (!variables.includes(name)) variables.push(name);
    }
    return { roots, keys, variables };
  });
}

/** The bind system a key runs or is rebound by, or null for a plain key. */
export function systemOf(state: ChainState, key: string): ChainSystem | null {
  const upper = normalizeKey(key);
  return chainSystems(state).find((system) => system.keys.includes(upper)) ?? null;
}

function systemFor(state: ChainState, key: string): ChainSystem {
  const upper = normalizeKey(key);
  const system = systemOf(state, upper);
  if (system) return system;
  const print = footprint(state, upper);
  return { roots: [upper], keys: [...print.keys], variables: print.order };
}

function snapshot(state: ChainState, system: ChainSystem): string {
  return JSON.stringify([
    system.keys.map((key) => bindingOf(state, key)),
    system.variables.map((name) => variableOf(state, name)?.value ?? null),
  ]);
}

// ============================================================ provenance

export interface ChainVariableInfo {
  name: string;
  /** Value in the start state, null when no source defines it. */
  value: string | null;
  /** `source` of the config that defines it, null when none does. */
  source: string | null;
  kind: BindSource["kind"] | null;
  /** Edits write it in the edited config and take effect. */
  editable: boolean;
  /** Read-only here, but a definition appended to the edited config would win. */
  overridable: boolean;
}

export interface ChainKeyInfo {
  key: string;
  /** Binding in the start state, "" when unbound. */
  command: string;
  source: string | null;
  kind: BindSource["kind"] | null;
  editable: boolean;
  overridable: boolean;
}

function provenance(state: ChainState, origin: Origin | undefined) {
  const edited = state.editedIndex;
  if (!origin) return { source: null, kind: null, editable: edited >= 0, overridable: false };
  const source = state.sources[origin.sourceIndex];
  return {
    source: source?.source ?? null,
    kind: source?.kind ?? null,
    editable: edited >= 0 && origin.sourceIndex === edited,
    overridable: edited >= 0 && origin.sourceIndex >= 0 && origin.sourceIndex < edited,
  };
}

export function variableInfo(state: ChainState, name: string): ChainVariableInfo {
  const record = state.start.variables.get(name.toLowerCase());
  return { name: record?.name ?? name, value: record?.value ?? null, ...provenance(state, record?.origin) };
}

export function keyInfo(state: ChainState, key: string): ChainKeyInfo {
  const upper = normalizeKey(key);
  const record = state.start.bindings.get(upper);
  return { key: upper, command: record?.command ?? "", ...provenance(state, record?.origin) };
}

// =================================================================== graph

/**
 * - `branch`: the press leads to a state seen for the first time, a node of its own;
 * - `link`: it leads back to a state already in the graph;
 * - `leaf`: nothing the system branches on changes, or the game hangs;
 * - `cut`: a new state a cap kept out of the graph.
 */
export type PressKind = "branch" | "link" | "leaf" | "cut";

export interface ChainPress {
  key: string;
  /** Presses from the start state, this one last. */
  path: string[];
  kind: PressKind;
  from: number;
  /** Node reached; null for `cut` and for a press that hangs the game. */
  to: number | null;
  step: ChainStep;
}

export interface ChainNode {
  id: number;
  /** Presses from the start state. */
  depth: number;
  path: string[];
  state: ChainState;
  /** Presses from this state: its branches, links and leaves. */
  presses: ChainPress[];
}

export interface ChainGraph {
  /** The key the graph starts with. */
  key: string;
  system: ChainSystem;
  /** `nodes[0]` is the start state: its only press is `key`. */
  nodes: ChainNode[];
  /** Load and press diagnostics of the system, without repeats. */
  diagnostics: ChainDiagnostic[];
  /** A cap kept some states out. */
  truncated: boolean;
  variables: ChainVariableInfo[];
  keys: ChainKeyInfo[];
}

function diagnosticKey(diagnostic: ChainDiagnostic): string {
  const where = diagnostic.container;
  const at = where.kind === "binding" ? where.key : where.kind === "variable" ? where.name.toLowerCase() : where.index;
  return `${diagnostic.kind}|${diagnostic.subject.toLowerCase()}|${where.kind}|${at}|${diagnostic.index}`;
}

function mentions(diagnostic: ChainDiagnostic, system: ChainSystem): boolean {
  const where = diagnostic.container;
  if (where.kind === "variable" && system.variables.includes(where.name.toLowerCase())) return true;
  if (where.kind === "binding" && system.keys.includes(where.key)) return true;
  return system.variables.includes(diagnostic.subject.toLowerCase());
}

/**
 * Explores what pressing `key` leads to: a breadth-first graph of states over
 * every key of its bind system. From the start state only `key` is pressed.
 * From every later state, each key of the system is pressed whose binding runs
 * a variable, differs from the start, or changes the state. A press into a
 * state already seen is a link, not a subtree.
 */
export function exploreChain(state: ChainState, key: string, options?: ChainOptions): ChainGraph {
  const limits = limitsOf(options);
  const root = normalizeKey(key);
  const system = systemFor(state, root);
  const order = [root, ...system.keys.filter((other) => other !== root)];
  const nodes: ChainNode[] = [{ id: 0, depth: 0, path: [], state, presses: [] }];
  const snapshots = [snapshot(state, system)];
  const seen = new Map([[snapshots[0], 0]]);
  const found = new Map<string, ChainDiagnostic>();
  const note = (diagnostic: ChainDiagnostic) => {
    const id = diagnosticKey(diagnostic);
    if (!found.has(id)) found.set(id, diagnostic);
  };
  for (const diagnostic of state.loadDiagnostics) if (mentions(diagnostic, system)) note(diagnostic);
  let truncated = false;
  for (let queue = [0], id = queue.shift(); id !== undefined; id = queue.shift()) {
    const node = nodes[id];
    for (const pressed of id === 0 ? [root] : order) {
      const current = bindingOf(node.state, pressed);
      const initial = startBindingOf(state, pressed);
      if (!current && !initial) continue;
      const path = [...node.path, pressed];
      const step = press(node.state, pressed, limits, path);
      const after = snapshot(step.state, system);
      const changed = after !== snapshots[id];
      if (id !== 0 && !changed && current === initial && !runsVstr(current)) continue;
      step.diagnostics.forEach(note);
      let kind: PressKind;
      let to: number | null;
      if (step.outcome === "immediateLoop" || step.outcome === "limit") {
        kind = "leaf";
        to = null;
      } else if (!changed) {
        kind = "leaf";
        to = id;
      } else if (seen.has(after)) {
        kind = "link";
        to = seen.get(after) ?? null;
      } else if (nodes.length >= limits.maxNodes || node.depth + 1 >= limits.maxPresses) {
        kind = "cut";
        to = null;
        truncated = true;
        note({
          kind: "limit",
          subject: nodes.length >= limits.maxNodes ? "nodes" : "presses",
          container: { kind: "binding", key: pressed },
          index: 0,
          path,
        });
      } else {
        kind = "branch";
        to = nodes.length;
        nodes.push({ id: to, depth: node.depth + 1, path, state: step.state, presses: [] });
        snapshots.push(after);
        seen.set(after, to);
        queue.push(to);
      }
      node.presses.push({ key: pressed, path, kind, from: id, to, step });
    }
  }
  return {
    key: root,
    system,
    nodes,
    diagnostics: [...found.values()],
    truncated,
    variables: system.variables.map((name) => variableInfo(state, name)),
    keys: system.keys.map((systemKey) => keyInfo(state, systemKey)),
  };
}

/** Presses of one key from a state until the state repeats: a toggle or a cycle. */
export interface KeyCycle {
  key: string;
  steps: ChainStep[];
  /** Step the next press repeats, 0 for a clean cycle; null when a hang or a cap stopped it. */
  loopsTo: number | null;
}

export function keyCycle(state: ChainState, key: string, options?: ChainOptions): KeyCycle {
  const limits = limitsOf(options);
  const upper = normalizeKey(key);
  const system = systemFor(state, upper);
  const seen = [snapshot(state, system)];
  const steps: ChainStep[] = [];
  let current = state;
  for (let i = 0; i < limits.maxPresses; i++) {
    const step = press(current, upper, limits, Array.from({ length: i + 1 }, () => upper));
    steps.push(step);
    if (step.outcome === "immediateLoop" || step.outcome === "limit") break;
    const after = snapshot(step.state, system);
    const at = seen.indexOf(after);
    if (at >= 0) return { key: upper, steps, loopsTo: at };
    seen.push(after);
    current = step.state;
  }
  return { key: upper, steps, loopsTo: null };
}

// =================================================================== edits

export type ChainEditCode =
  | "syntax"
  | "noEditedSource"
  | "notEditable"
  | "shadowed"
  | "unsupported"
  | "branchExists"
  | "noBranch"
  | "lastStep"
  | "restore";

/** An edit the model refuses. `syntax` keeps the message of `appendBind`. */
export class ChainEditError extends Error {
  readonly code: ChainEditCode;
  constructor(code: ChainEditCode, message: string) {
    super(message);
    this.name = "ChainEditError";
    this.code = code;
  }
}

function syntaxError(): ChainEditError {
  return new ChainEditError("syntax", "Invalid bind syntax");
}

function checkKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw syntaxError();
  return normalizeKey(key);
}

function checkName(name: string): void {
  if (!/^[\w.]+$/.test(name)) throw syntaxError();
}

/** One command for a binding or, with `inValue`, for a variable, where `//` would hide the rest. */
function cleanCommands(commands: readonly string[], inValue: boolean): string[] {
  const list = commands.map((command) => command.trim().replace(/[\s;]+$/, "")).filter(Boolean);
  for (const command of list)
    if (/["\r\n]/.test(command) || (inValue && /\/[/*]/.test(command))) throw syntaxError();
  return list;
}

function separatorOf(value: string): string {
  return /;[ \t]/.test(value) || !value.includes(";") ? "; " : ";";
}

interface Plan {
  variables: Map<string, { name: string; value: string }>;
  bindings: Map<string, string>;
  removeVariables: Set<string>;
  removeBindings: Set<string>;
  raw: { start: number; end: number; text: string }[];
}

function newPlan(): Plan {
  return { variables: new Map(), bindings: new Map(), removeVariables: new Set(), removeBindings: new Set(), raw: [] };
}

/** Top-level `set` commands of the text that define the variable. */
function definitionsIn(text: string, lower: string): CommandSpan[] {
  return splitCommands(text).filter((span) => {
    const words = tokenizeCommand(span.text);
    return words.length >= 3 && SET_VERBS.has(words[0].toLowerCase()) && words[1].toLowerCase() === lower;
  });
}

/** Removes a command; a line it owned alone goes with its line break. */
function removeRange(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = text.length;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (/^[\s;]*$/.test(before) && /^[\s;]*(\/\/[^\n]*)?$/.test(after)) {
    if (lineEnd < text.length) return text.slice(0, lineStart) + text.slice(lineEnd + 1);
    return text.slice(0, Math.max(0, lineStart - 1)) + text.slice(lineEnd);
  }
  const next = /^[ \t]*;[ \t]*/.exec(after);
  if (next) return text.slice(0, start) + text.slice(end + next[0].length);
  const previous = /[ \t]*;[ \t]*$/.exec(before);
  if (previous) return text.slice(0, start - previous[0].length) + text.slice(end);
  return text.slice(0, start) + text.slice(end);
}

function appendLines(text: string, lines: readonly string[]): string {
  if (!lines.length) return text;
  const body = text.trimEnd();
  return `${body ? `${body}\n` : ""}${lines.join("\n")}\n`;
}

function editedText(sources: readonly BindSource[], state: ChainState): string {
  if (state.editedIndex < 0) throw new ChainEditError("noEditedSource", "No config is being edited");
  return sources[state.editedIndex].text;
}

/**
 * Writes a plan into the edited source. A definition that source owns at top
 * level changes in place; anything else is appended, so it runs after the
 * definition it overrides. Unrelated lines stay as they are.
 */
function commit(sources: readonly BindSource[], state: ChainState, plan: Plan): string {
  const text = editedText(sources, state);
  const edited = state.editedIndex;
  const edits: { start: number; end: number; text: string; remove: boolean }[] = plan.raw.map((raw) => ({
    ...raw,
    remove: false,
  }));
  const appendedVariables: string[] = [];
  const appendedBindings: string[] = [];
  for (const [lower, write] of plan.variables) {
    checkName(write.name);
    if (/["\r\n]/.test(write.value)) throw syntaxError();
    const record = state.start.variables.get(lower);
    if (record && record.origin.sourceIndex > edited)
      throw new ChainEditError("shadowed", `${record.name} is defined by a later config`);
    const span = record && record.origin.sourceIndex === edited ? record.origin.span : null;
    const words = span ? tokenizeCommand(text.slice(span.start, span.end)) : [];
    if (record && span && SET_VERBS.has(words[0]?.toLowerCase()) && words.length >= 2) {
      if (record.value !== write.value) edits.push({ ...span, text: `${words[0]} ${words[1]} "${write.value}"`, remove: false });
    } else if (record && span && record.origin.verb === "direct") {
      if (record.value !== write.value) edits.push({ ...span, text: `${words[0]} "${write.value}"`, remove: false });
    } else {
      const verb = record && SET_VERBS.has(record.origin.verb) ? record.origin.verb : "set";
      appendedVariables.push(`${verb} ${record?.name ?? write.name} "${write.value}"`);
    }
  }
  for (const [key, command] of plan.bindings) {
    checkKey(key);
    if (/["\r\n]/.test(command)) throw syntaxError();
    const record = state.start.bindings.get(key);
    if (record && record.origin.sourceIndex > edited)
      throw new ChainEditError("shadowed", `${key} is bound by a later config`);
    const span = record && record.origin.sourceIndex === edited ? record.origin.span : null;
    const spelling = span ? (tokenizeCommand(text.slice(span.start, span.end))[1] ?? key) : key;
    const line = command ? `bind ${spelling} "${command}"` : `unbind ${spelling}`;
    if (record && span) {
      if (record.command !== command) edits.push({ ...span, text: line, remove: false });
    } else appendedBindings.push(line);
  }
  for (const lower of plan.removeVariables)
    for (const span of definitionsIn(text, lower)) edits.push({ start: span.start, end: span.end, text: "", remove: true });
  for (const key of plan.removeBindings) {
    const record = state.start.bindings.get(key);
    if (record?.origin.sourceIndex === edited && record.origin.span)
      edits.push({ ...record.origin.span, text: "", remove: true });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits)
    out = edit.remove ? removeRange(out, edit.start, edit.end) : out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return appendLines(out, [...appendedVariables, ...appendedBindings]);
}

function withEdited(sources: readonly BindSource[], index: number, text: string): BindSource[] {
  return sources.map((source, i) => (i === index ? { ...source, text } : source));
}

/** Drops top-level definitions of variables nothing runs any more from the edited text. */
function dropUnused(sources: readonly BindSource[], editedIndex: number, text: string, names: readonly string[]): string {
  if (!names.length) return text;
  const next = withEdited(sources, editedIndex, text);
  const state = loadChainState(next);
  const plan = newPlan();
  for (const name of names) if (!state.chainVariables.has(name.toLowerCase())) plan.removeVariables.add(name.toLowerCase());
  return plan.removeVariables.size ? commit(next, state, plan) : text;
}

/** The start record of a variable a step runs; refused when the chain itself rewrote it. */
function startVariable(state: ChainState, before: ChainState, name: string): VariableRecord {
  const lower = name.toLowerCase();
  const initial = state.start.variables.get(lower);
  if (!initial || variableOf(before, lower)?.value !== initial.value)
    throw new ChainEditError("notEditable", `${name} is written by the chain itself`);
  return initial;
}

function taken(state: ChainState, plan: Plan, name: string): boolean {
  const lower = name.toLowerCase();
  return state.start.variables.has(lower) || state.chainVariables.has(lower) || plan.variables.has(lower);
}

function uniqueName(state: ChainState, plan: Plan, stem: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? stem : `${stem}_${n}`;
    if (!taken(state, plan, name)) return name;
  }
}

/** A stem whose derived names `${stem}_${suffix}` are all free. */
function freeStem(state: ChainState, plan: Plan, stem: string, suffixes: readonly string[]): string {
  for (let n = 1; ; n++) {
    const base = n === 1 ? stem : `${stem}${n}`;
    if (!taken(state, plan, base) && !suffixes.some((suffix) => taken(state, plan, `${base}_${suffix}`))) return base;
  }
}

/** A variable-name fragment for a key: `f7`, `kp_ins`, `k91` for `[`. */
export function keyIdent(key: string): string {
  const lower = key.toLowerCase();
  return /^[a-z0-9_]+$/.test(lower) ? lower : [...lower].map((c) => (/[a-z0-9_]/.test(c) ? c : `k${c.charCodeAt(0)}`)).join("");
}

/** Keeps the structure of a body (calls, links, branches) and swaps what a player sees. */
function withVisible(value: string, mode: TextMode, commands: readonly string[], key: string, state: ChainState): string {
  const exists = (name: string) => variableOf(state, name) !== undefined;
  const parts = splitText(value, mode).map((span) => ({
    text: span.text,
    visible: VISIBLE_ROLES.has(roleOf(tokenizeCommand(span.text), key, state.chainVariables, exists)),
  }));
  const first = parts.findIndex((part) => part.visible);
  const lead = first < 0 ? [] : parts.slice(0, first).map((part) => part.text);
  const rest = parts.slice(Math.max(first, 0)).filter((part) => !part.visible).map((part) => part.text);
  return [...lead, ...commands, ...rest].join(separatorOf(value));
}

/**
 * Replaces the commands a player sees in the step that pressing `path` ends
 * with. The chain's own commands (`vstr` calls, links, branches) stay. A step
 * that ends in a missing variable defines it.
 */
export function setStepCommands(sources: readonly BindSource[], path: readonly string[], commands: readonly string[]): string {
  const state = loadChainState(sources);
  const { before, step } = replayPresses(state, path);
  const plan = newPlan();
  if (step.missing) {
    plan.variables.set(step.missing.toLowerCase(), { name: step.missing, value: cleanCommands(commands, true).join("; ") });
    return commit(sources, state, plan);
  }
  if (step.body?.kind === "variable") {
    const record = startVariable(state, before, step.body.name);
    const value = withVisible(record.value, "text", cleanCommands(commands, true), step.key, before);
    plan.variables.set(record.name.toLowerCase(), { name: record.name, value });
  } else if (step.body?.kind === "binding" && bindingOf(before, step.key) === startBindingOf(state, step.key)) {
    const value = withVisible(step.binding, "binding", cleanCommands(commands, false), step.key, before);
    plan.bindings.set(step.key, value);
  } else throw new ChainEditError("notEditable", "The chain itself writes this binding");
  return commit(sources, state, plan);
}

/** The value with `command` inserted before its command `index`, or appended. */
function insertAt(value: string, index: number, command: string): string {
  const spans = splitCommands(value);
  const separator = separatorOf(value);
  if (index >= spans.length) return value.trim() ? `${value.trimEnd()}${separator}${command}` : command;
  return value.slice(0, spans[index].start) + command + separator + value.slice(spans[index].start);
}

function restoreCommand(state: ChainState, key: string): string {
  const initial = startBindingOf(state, key);
  if (/[;"]|\/[/*]/.test(initial))
    throw new ChainEditError("restore", `The binding of ${key} cannot be restored from inside a variable`);
  return initial ? `bind ${key} ${initial}` : `unbind ${key}`;
}

/** Variables of the system that put one of `keys` back to its start binding. */
function restoreSites(state: ChainState, system: ChainSystem | null, keys: ReadonlySet<string>, skip: string) {
  const sites: { record: VariableRecord; last: number }[] = [];
  for (const lower of system?.variables ?? []) {
    const record = state.start.variables.get(lower);
    if (!record || lower === skip) continue;
    let last = -1;
    splitCommands(record.value).forEach((span, index) => {
      const words = tokenizeCommand(span.text);
      const key = keyWritten(words);
      if (key !== null && keys.has(key) && bindingWritten(words) === startBindingOf(state, key)) last = index;
    });
    if (last >= 0) sites.push({ record, last });
  }
  return sites;
}

/**
 * Adds a branch to the step that pressing `path` ends with: the step rebinds
 * `key` to a new variable holding `commands`. When the step's other branches
 * all end with the same `vstr`, such as `vstr menu_close`, the new one ends
 * with it too, and every variable that puts those keys back also puts `key`
 * back.
 */
export function addBranch(sources: readonly BindSource[], path: readonly string[], key: string, commands: readonly string[]): string {
  const branchKey = checkKey(key);
  const state = loadChainState(sources);
  const { before, step } = replayPresses(state, path);
  if (step.body?.kind !== "variable")
    throw new ChainEditError("unsupported", "Only a step that runs a variable can branch");
  if (branchKey === step.key) throw new ChainEditError("unsupported", "A step cannot branch on its own key");
  const body = startVariable(state, before, step.body.name);
  const spans = splitCommands(body.value);
  const words = spans.map((span) => tokenizeCommand(span.text));
  if (words.some((w) => keyWritten(w) === branchKey))
    throw new ChainEditError("branchExists", `${branchKey} already has a branch here`);
  const list = cleanCommands(commands, true);
  const branchKeys = new Set<string>();
  const closings: (string | null)[] = [];
  for (const w of words) {
    const written = keyWritten(w);
    if (written === null || written === step.key) continue;
    branchKeys.add(written);
    const target = callTarget(bindingWritten(w));
    const value = target ? variableOf(before, target)?.value : undefined;
    const spansOf = value === undefined ? [] : splitCommands(value);
    closings.push(spansOf.length ? callTarget(spansOf[spansOf.length - 1].text) : null);
  }
  // Siblings without a closing call (a submenu, the close item itself) do not vote.
  const calls = closings.filter((c): c is string => c !== null);
  const closing = calls.length && calls.every((c) => c.toLowerCase() === calls[0].toLowerCase()) ? calls[0] : null;
  if (closing && !list.some((command) => isCallOf(command, closing))) list.push(`vstr ${closing}`);
  const plan = newPlan();
  const name = uniqueName(state, plan, `${body.name}_${keyIdent(branchKey)}`);
  plan.variables.set(name.toLowerCase(), { name, value: list.join("; ") });
  const exists = (n: string) => variableOf(before, n) !== undefined;
  const roles = words.map((w) => roleOf(w, step.key, state.chainVariables, exists));
  const lastBranch = roles.lastIndexOf("branch");
  const firstLink = roles.findIndex((role) => role === "link" || role === "call");
  const at = lastBranch >= 0 ? lastBranch + 1 : firstLink >= 0 ? firstLink : spans.length;
  plan.variables.set(body.name.toLowerCase(), { name: body.name, value: insertAt(body.value, at, `bind ${branchKey} vstr ${name}`) });
  const sites = restoreSites(state, systemOf(state, path[0]), branchKeys, body.name.toLowerCase());
  if (sites.length) {
    const restore = restoreCommand(state, branchKey);
    for (const site of sites) {
      const siteWords = splitCommands(site.record.value).map((span) => tokenizeCommand(span.text));
      if (siteWords.some((w) => keyWritten(w) === branchKey)) continue;
      plan.variables.set(site.record.name.toLowerCase(), {
        name: site.record.name,
        value: insertAt(site.record.value, site.last + 1, restore),
      });
    }
  }
  return commit(sources, state, plan);
}

/**
 * Removes the branch for `key` from the step that pressing `path` ends with.
 * The variable the branch ran goes too when nothing else runs it, and so do
 * the commands that put `key` back when no other step of the system moves it.
 */
export function removeBranch(sources: readonly BindSource[], path: readonly string[], key: string): string {
  const target = normalizeKey(key);
  const state = loadChainState(sources);
  const { before, step } = replayPresses(state, path);
  if (step.body?.kind !== "variable" || target === step.key)
    throw new ChainEditError("noBranch", `There is no branch for ${target} here`);
  const body = startVariable(state, before, step.body.name);
  const spans = splitCommands(body.value);
  const drop = spans.map((span) => keyWritten(tokenizeCommand(span.text)) === target);
  if (!drop.includes(true)) throw new ChainEditError("noBranch", `There is no branch for ${target} here`);
  const orphans = spans.flatMap((span, i) => {
    const called = drop[i] ? callTarget(bindingWritten(tokenizeCommand(span.text))) : null;
    return called ? [called] : [];
  });
  const plan = newPlan();
  const kept = spans.filter((_, i) => !drop[i]).map((span) => span.text).join(separatorOf(body.value));
  plan.variables.set(body.name.toLowerCase(), { name: body.name, value: kept });
  const system = systemOf(state, path[0]);
  const initial = startBindingOf(state, target);
  const valueOf = (lower: string) => (lower === body.name.toLowerCase() ? kept : state.start.variables.get(lower)?.value);
  const moves = (system?.variables ?? []).some((lower) =>
    splitCommands(valueOf(lower) ?? "").some((span) => {
      const words = tokenizeCommand(span.text);
      return keyWritten(words) === target && bindingWritten(words) !== initial;
    }),
  );
  if (!moves)
    for (const lower of system?.variables ?? []) {
      const record = state.start.variables.get(lower);
      if (!record || lower === body.name.toLowerCase()) continue;
      const siteSpans = splitCommands(record.value);
      const keep = siteSpans.filter((span) => {
        const words = tokenizeCommand(span.text);
        return !(keyWritten(words) === target && bindingWritten(words) === initial);
      });
      if (keep.length !== siteSpans.length)
        plan.variables.set(lower, { name: record.name, value: keep.map((span) => span.text).join(separatorOf(record.value)) });
    }
  return dropUnused(sources, state.editedIndex, commit(sources, state, plan), orphans);
}

interface Link {
  /** Variable the command is written in. */
  container: string;
  index: number;
  /** Words before `vstr`: `set view_toggle`, `bind PGUP`, `view_toggle`. */
  prefix: string[];
}

interface Wiring {
  key: string;
  bodies: string[];
  links: Link[];
  entry: { kind: "variable"; name: string } | { kind: "binding"; key: string };
}

function lastNode(nodes: readonly ChainCommand[], match: (node: ChainCommand) => boolean): ChainCommand | null {
  let found: ChainCommand | null = null;
  const walk = (list: readonly ChainCommand[]) => {
    for (const node of list) {
      if (match(node)) found = node;
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/**
 * How a same-key cycle is wired: each step runs a variable of its own, which
 * points the next press at the next step, through a pointer variable (the
 * template idiom) or by rebinding the key (the RUJKA idiom).
 */
function cycleWiring(state: ChainState, from: ChainState, key: string): Wiring {
  const upper = normalizeKey(key);
  const cycle = keyCycle(from, upper);
  const unsupported = (why: string) => new ChainEditError("unsupported", why);
  if (cycle.loopsTo !== 0) throw unsupported("The key does not come back to its first step");
  const steps = cycle.steps;
  const bodies = steps.map((step) => {
    if (step.body?.kind !== "variable") throw unsupported("A step does not run a variable of its own");
    return step.body.name;
  });
  if (new Set(bodies.map((name) => name.toLowerCase())).size !== bodies.length)
    throw unsupported("Two steps run the same variable");
  steps.forEach((_, i) => startVariable(state, i === 0 ? from : steps[i - 1].state, bodies[i]));
  const links = steps.map((step, i) => {
    const next = steps[(i + 1) % steps.length];
    const pointer = next.pointers.length ? next.pointers[next.pointers.length - 1].toLowerCase() : null;
    const target = bodies[(i + 1) % steps.length];
    const node = lastNode(step.commands, (candidate) => {
      if (candidate.role !== "link" || candidate.container.kind !== "variable") return false;
      const words = tokenizeCommand(candidate.text);
      const written = keyWritten(words);
      const matches = pointer ? written === null && candidate.target?.toLowerCase() === pointer : written === upper;
      return matches && isCallOf(candidate.value ?? "", target);
    });
    if (!node || node.container.kind !== "variable") throw unsupported("A step does not point at the next one");
    const words = tokenizeCommand(node.text);
    const cut = words.findIndex((word, index) => index > 0 && word.toLowerCase() === "vstr");
    return { container: node.container.name, index: node.index, prefix: words.slice(0, cut) };
  });
  const first = steps[0];
  let entry: Wiring["entry"];
  if (first.pointers.length) {
    const name = first.pointers[first.pointers.length - 1];
    const record = startVariable(state, from, name);
    if (!isCallOf(record.value, bodies[0])) throw unsupported("The first step is not reached directly");
    entry = { kind: "variable", name: record.name };
  } else {
    if (bindingOf(from, upper) !== startBindingOf(state, upper) || !isCallOf(bindingOf(from, upper), bodies[0]))
      throw unsupported("The first step is not reached directly");
    entry = { kind: "binding", key: upper };
  }
  if (entry.kind === "variable" && links.some((link) => link.container.toLowerCase() === entry.name.toLowerCase()))
    throw unsupported("The pointer also holds a step");
  return { key: upper, bodies, links, entry };
}

/** Points step `i` at `next(i)` and the key's first press at `first`, rewriting only what changes. */
function rewire(state: ChainState, plan: Plan, wiring: Wiring, next: (step: number) => string, first: string): void {
  const byContainer = new Map<string, { index: number; text: string }[]>();
  wiring.links.forEach((link, i) => {
    const target = next(i);
    if (target === wiring.bodies[(i + 1) % wiring.bodies.length]) return;
    const lower = link.container.toLowerCase();
    byContainer.set(lower, [...(byContainer.get(lower) ?? []), { index: link.index, text: `${link.prefix.join(" ")} vstr ${target}` }]);
  });
  for (const [lower, edits] of byContainer) {
    const record = state.start.variables.get(lower);
    if (!record) continue;
    const spans = splitCommands(record.value);
    let value = record.value;
    for (const edit of [...edits].sort((a, b) => b.index - a.index))
      value = value.slice(0, spans[edit.index].start) + edit.text + value.slice(spans[edit.index].end);
    plan.variables.set(lower, { name: record.name, value });
  }
  if (first === wiring.bodies[0]) return;
  if (wiring.entry.kind === "variable")
    plan.variables.set(wiring.entry.name.toLowerCase(), { name: wiring.entry.name, value: `vstr ${first}` });
  else plan.bindings.set(wiring.entry.key, `vstr ${first}`);
}

function cycleStart(state: ChainState, path: readonly string[]): ChainState {
  return path.length ? replayPresses(state, path).step.state : state;
}

/**
 * True when the key's cycle can be reordered, grown and shrunk from this
 * state in the edited config itself: every variable the rewiring writes is
 * defined there. A variable from another source has to be overridden first.
 */
export function cycleEditable(sources: readonly BindSource[], key: string, path: readonly string[] = []): boolean {
  try {
    const state = loadChainState(sources);
    const wiring = cycleWiring(state, cycleStart(state, path), key);
    const written = [...wiring.bodies, ...wiring.links.map((link) => link.container)];
    if (wiring.entry.kind === "variable") written.push(wiring.entry.name);
    const variablesHere = written.every((name) => variableInfo(state, name).editable);
    // A binding entry is written the way Set binding writes it: appended when another source owns it.
    const binding = keyInfo(state, key);
    return variablesHere && (wiring.entry.kind === "variable" || binding.editable || binding.overridable);
  } catch {
    return false;
  }
}

/**
 * Reorders the states of a same-key cycle: position `j` of the new order runs
 * old step `order[j]`. The cycle starts from the state `path` leads to.
 */
export function reorderCycle(sources: readonly BindSource[], key: string, order: readonly number[], path: readonly string[] = []): string {
  const state = loadChainState(sources);
  const wiring = cycleWiring(state, cycleStart(state, path), key);
  const n = wiring.bodies.length;
  if (order.length !== n || new Set(order).size !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n))
    throw new ChainEditError("unsupported", "The order is not a permutation of the steps");
  const target = new Map<number, string>();
  order.forEach((step, j) => target.set(step, wiring.bodies[order[(j + 1) % n]]));
  const plan = newPlan();
  rewire(state, plan, wiring, (i) => target.get(i) ?? wiring.bodies[(i + 1) % n], wiring.bodies[order[0]]);
  return commit(sources, state, plan);
}

/** The words step names share: `view` for `view_on` and `view_off`. */
function stemOf(names: readonly string[], key: string): string {
  const words = names.map((name) => name.split(/[_.]/));
  const shared: string[] = [];
  for (let i = 0; words.every((w) => i < w.length - 1 && w[i].toLowerCase() === words[0][i].toLowerCase()); i++)
    shared.push(words[0][i]);
  return shared.length ? shared.join("_") : `${keyIdent(key)}_step`;
}

/** Turns a key without a cycle into a toggle between what it does and `commands`. */
function toggleFromKey(sources: readonly BindSource[], state: ChainState, key: string, index: number, commands: string[]): string {
  const step = press(state, key, limitsOf(), [key]);
  const existing = cleanCommands(
    step.bodyCommands.filter((command) => command.role !== "link").map((command) => command.text),
    true,
  );
  const plan = togglePlan(state, key, index === 0 ? [commands, existing] : [existing, commands]);
  return commit(sources, state, plan);
}

/**
 * Inserts a step into a same-key cycle at position `index` (0 runs it on the
 * next press). A key whose presses do not cycle yet becomes a toggle between
 * what it does and the new step.
 */
export function insertCycleStep(
  sources: readonly BindSource[],
  key: string,
  index: number,
  commands: readonly string[],
  path: readonly string[] = [],
): string {
  const upper = checkKey(key);
  const state = loadChainState(sources);
  const list = cleanCommands(commands, true);
  let wiring: Wiring;
  try {
    wiring = cycleWiring(state, cycleStart(state, path), upper);
  } catch (error) {
    if (!(error instanceof ChainEditError) || path.length || keyCycle(state, upper).steps.length !== 1) throw error;
    return toggleFromKey(sources, state, upper, index, list);
  }
  const n = wiring.bodies.length;
  if (!Number.isInteger(index) || index < 0 || index > n) throw new ChainEditError("unsupported", "No such position");
  const plan = newPlan();
  const name = uniqueName(state, plan, `${stemOf(wiring.bodies, upper)}_${n + 1}`);
  const follower = wiring.bodies[index % n];
  plan.variables.set(name.toLowerCase(), {
    name,
    value: [...list, `${wiring.links[0].prefix.join(" ")} vstr ${follower}`].join("; "),
  });
  const previous = (index - 1 + n) % n;
  rewire(state, plan, wiring, (i) => (i === previous ? name : wiring.bodies[(i + 1) % n]), index === 0 ? name : wiring.bodies[0]);
  return commit(sources, state, plan);
}

/** Removes step `index` from a same-key cycle and joins its neighbours. */
export function removeCycleStep(sources: readonly BindSource[], key: string, index: number, path: readonly string[] = []): string {
  const state = loadChainState(sources);
  const wiring = cycleWiring(state, cycleStart(state, path), key);
  const n = wiring.bodies.length;
  if (n < 2) throw new ChainEditError("lastStep", "A cycle keeps at least one step");
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new ChainEditError("unsupported", "No such step");
  const previous = (index - 1 + n) % n;
  const following = wiring.bodies[(index + 1) % n];
  const plan = newPlan();
  rewire(state, plan, wiring, (i) => (i === previous ? following : wiring.bodies[(i + 1) % n]), index === 0 ? following : wiring.bodies[0]);
  return dropUnused(sources, state.editedIndex, commit(sources, state, plan), [wiring.bodies[index]]);
}

/**
 * Moves a key: every `bind` and `unbind` of `oldKey` in its bind system now
 * writes `newKey`. A key that starts the system also moves its own binding.
 * A key the system only borrows, like a menu item, keeps its binding, and the
 * commands that gave it back now give `newKey` its own binding back.
 */
export function changeKey(sources: readonly BindSource[], oldKey: string, newKey: string): string {
  const to = checkKey(newKey);
  const from = normalizeKey(oldKey);
  const state = loadChainState(sources);
  const text = editedText(sources, state);
  if (from === to) return text;
  const system = systemOf(state, from);
  const root = !system || system.roots.includes(from);
  const initial = startBindingOf(state, from);
  const plan = newPlan();
  for (const lower of system?.variables ?? []) {
    const record = state.start.variables.get(lower);
    if (!record) continue;
    const spans = splitCommands(record.value);
    let value = record.value;
    for (let i = spans.length - 1; i >= 0; i--) {
      const words = tokenizeCommand(spans[i].text);
      if (keyWritten(words) !== from) continue;
      const replacement =
        !root && bindingWritten(words) === initial
          ? restoreCommand(state, to)
          : [words[0], to, ...words.slice(2)].join(" ");
      value = value.slice(0, spans[i].start) + replacement + value.slice(spans[i].end);
    }
    if (value !== record.value) plan.variables.set(lower, { name: record.name, value });
  }
  if (root && initial) {
    const fromRecord = state.start.bindings.get(from);
    const toRecord = state.start.bindings.get(to);
    const fromHere = fromRecord?.origin.sourceIndex === state.editedIndex && fromRecord.origin.span;
    const toHere = toRecord?.origin.sourceIndex === state.editedIndex && toRecord.origin.span;
    if (fromHere && fromRecord?.origin.span && !toHere) {
      plan.raw.push({ ...fromRecord.origin.span, text: `bind ${to} "${initial}"` });
    } else {
      plan.bindings.set(to, initial);
      if (fromHere) plan.removeBindings.add(from);
      else plan.bindings.set(from, "");
    }
  }
  return commit(sources, state, plan);
}

function togglePlan(state: ChainState, key: string, steps: readonly (readonly string[])[], name?: string): Plan {
  const plan = newPlan();
  if (name !== undefined) checkName(name);
  const base = freeStem(state, plan, name ?? `${keyIdent(key)}_toggle`, steps.map((_, i) => String(i + 1)));
  steps.forEach((commands, i) => {
    const step = `${base}_${i + 1}`;
    plan.variables.set(step.toLowerCase(), {
      name: step,
      value: [...commands, `set ${base} vstr ${base}_${((i + 1) % steps.length) + 1}`].join("; "),
    });
  });
  plan.variables.set(base.toLowerCase(), { name: base, value: `vstr ${base}_1` });
  plan.bindings.set(key, `vstr ${base}`);
  return plan;
}

/**
 * Creates a toggle or a cycle on `key`: step `i` runs `steps[i]`, and each
 * press moves a pointer variable to the next step, as the template does.
 */
export function createToggle(sources: readonly BindSource[], key: string, steps: readonly (readonly string[])[], name?: string): string {
  const upper = checkKey(key);
  if (!steps.length) throw new ChainEditError("unsupported", "A toggle needs a step");
  const state = loadChainState(sources);
  return commit(sources, state, togglePlan(state, upper, steps.map((step) => cleanCommands(step, true)), name));
}

export interface MenuSpec {
  /** Commands the opening press runs before it rebinds the item keys, such as an `echo` of the items. */
  open?: readonly string[];
  items: readonly { key: string; commands: readonly string[] }[];
  /** Commands the closing step runs before it gives the keys back. */
  close?: readonly string[];
  name?: string;
}

/**
 * Creates a menu on `key`: the first press rebinds the item keys, an item runs
 * its commands and closes the menu, and closing gives every key its binding
 * back. A second press of `key` closes the menu too.
 */
export function createMenu(sources: readonly BindSource[], key: string, menu: MenuSpec): string {
  const upper = checkKey(key);
  const items = menu.items.map((item) => ({ key: checkKey(item.key), commands: cleanCommands(item.commands, true) }));
  if (!items.length) throw new ChainEditError("unsupported", "A menu needs an item");
  if (new Set(items.map((item) => item.key)).size !== items.length || items.some((item) => item.key === upper))
    throw new ChainEditError("unsupported", "Every item needs a key of its own");
  if (menu.name !== undefined) checkName(menu.name);
  const state = loadChainState(sources);
  const plan = newPlan();
  const idents = items.map((item) => keyIdent(item.key));
  const base = freeStem(state, plan, menu.name ?? `${keyIdent(upper)}_menu`, ["open", "close", ...idents]);
  const restores = items.map((item) => restoreCommand(state, item.key));
  const set = (name: string, commands: readonly string[]) =>
    plan.variables.set(name.toLowerCase(), { name, value: commands.join("; ") });
  set(`${base}_open`, [
    ...cleanCommands(menu.open ?? [], true),
    ...items.map((item, i) => `bind ${item.key} vstr ${base}_${idents[i]}`),
    `bind ${upper} vstr ${base}_close`,
  ]);
  set(`${base}_close`, [...cleanCommands(menu.close ?? [], true), ...restores, `bind ${upper} vstr ${base}_open`]);
  items.forEach((item, i) => set(`${base}_${idents[i]}`, [...item.commands, `vstr ${base}_close`]));
  plan.bindings.set(upper, `vstr ${base}_open`);
  return commit(sources, state, plan);
}

/**
 * Copies a variable into the edited config so it can be edited there, with
 * its current value or `value`. A variable the edited config defines already
 * changes in place.
 */
export function overrideVariable(sources: readonly BindSource[], name: string, value?: string): string {
  const state = loadChainState(sources);
  const lower = name.toLowerCase();
  const record = state.start.variables.get(lower);
  const plan = newPlan();
  const next = value ?? record?.value ?? "";
  if (record && record.origin.sourceIndex !== state.editedIndex) {
    checkName(record.name);
    if (/["\r\n]/.test(next)) throw syntaxError();
    if (record.origin.sourceIndex > state.editedIndex)
      throw new ChainEditError("shadowed", `${record.name} is defined by a later config`);
    const verb = SET_VERBS.has(record.origin.verb) ? record.origin.verb : "set";
    return appendLines(editedText(sources, state), [`${verb} ${record.name} "${next}"`]);
  }
  plan.variables.set(lower, { name: record?.name ?? name, value: next });
  return commit(sources, state, plan);
}

/** Copies a key's binding into the edited config, like `overrideVariable`. */
export function overrideBinding(sources: readonly BindSource[], key: string, command?: string): string {
  const upper = checkKey(key);
  const state = loadChainState(sources);
  const record = state.start.bindings.get(upper);
  const next = command ?? record?.command ?? "";
  if (record && record.origin.sourceIndex !== state.editedIndex) {
    if (/["\r\n]/.test(next)) throw syntaxError();
    if (record.origin.sourceIndex > state.editedIndex)
      throw new ChainEditError("shadowed", `${upper} is bound by a later config`);
    return appendLines(editedText(sources, state), [next ? `bind ${upper} "${next}"` : `unbind ${upper}`]);
  }
  const plan = newPlan();
  plan.bindings.set(upper, next);
  return commit(sources, state, plan);
}
