import catalog from "./configCatalog.json";
import { configCommands } from "./quakeConfig";
import { GAME_KEYS } from "./gameKeys";

export const SCRIPT_COMMANDS = [
  "set",
  "seta",
  "setu",
  "sets",
  "bind",
  "unbind",
  "unbindall",
  "exec",
  "vstr",
  "echo",
  "wait",
  "toggle",
  "vid_restart",
  "snd_restart",
  "screenshot",
  "screenshotJPEG",
  "record",
  "stoprecord",
  "say",
  "say_team",
  "team",
  "kill",
  "quit",
];
export function configAssignments(text: string) {
  const values = new Map<string, string>();
  for (const command of configCommands(text)) {
    const match = command.match(
      /^(?:set[aus]?\s+)?([\w.]+)\s+(?:"([\s\S]*)"|([^\s]+))$/i,
    );
    if (match && !SCRIPT_COMMANDS.includes(match[1].toLowerCase()))
      values.set(match[1].toLowerCase(), match[2] ?? match[3]);
  }
  return values;
}
export function setConfigValue(text: string, name: string, value: string) {
  if (!/^[\w.]+$/.test(name) || /["\r\n]/.test(value))
    throw new Error("Invalid config value");
  const lines = text.split(/\r?\n/);
  // Replace the last standalone assignment, preserving its comment and command.
  // Compound scripts stay untouched; an override follows them instead.
  const escaped = name.replace(/\./g, "\\.");
  const pattern = new RegExp(
    `^(\\s*(?:set[aus]?\\s+)?${escaped}\\s+)(?:"[^"\\n]*"|[^\\s;]+)(\\s*(?://.*)?)$`,
    "i",
  );
  for (let index = lines.length - 1; index >= 0; index--) {
    if (pattern.test(lines[index])) {
      lines[index] = lines[index].replace(
        pattern,
        (_match, prefix, suffix) => `${prefix}"${value}"${suffix}`,
      );
      return lines.join("\n");
    }
    if (configAssignments(lines[index]).has(name.toLowerCase())) break;
  }
  return `${text.trimEnd()}\nseta ${name} "${value}"\n`;
}
export interface ScriptIssue {
  line: number;
  kind: "quote" | "key" | "vstr" | "duplicate";
  value: string;
}
export function scriptIssues(text: string): ScriptIssue[] {
  const issues: ScriptIssue[] = [],
    defined = new Set([...configAssignments(text).keys()]),
    seen = new Set<string>();
  const keys = new Set(GAME_KEYS.map((k) => k.token));
  text.split(/\r?\n/).forEach((line, i) => {
    let quoted = false;
    for (let at = 0; at < line.length; at++) {
      if (!quoted && line.slice(at, at + 2) === "//") break;
      if (line[at] === '"') quoted = !quoted;
    }
    const quoteCount = quoted ? 1 : 0;
    if (quoteCount % 2) issues.push({ line: i + 1, kind: "quote", value: "" });
    for (const command of configCommands(line)) {
      const bind = command.match(/^bind\s+"?([^"\s]+)"?/i);
      if (bind && !keys.has(bind[1].toUpperCase()))
        issues.push({ line: i + 1, kind: "key", value: bind[1] });
      for (const match of command.matchAll(/\bvstr\s+(\w+)/gi))
        if (!defined.has(match[1].toLowerCase()))
          issues.push({ line: i + 1, kind: "vstr", value: match[1] });
      const assignment = [...configAssignments(command).keys()][0];
      if (assignment && seen.has(assignment))
        issues.push({ line: i + 1, kind: "duplicate", value: assignment });
      if (assignment) seen.add(assignment);
    }
  });
  return issues;
}
export const CONFIG_TEMPLATES: Record<string, string> = {
  network:
    '// Network settings\nseta rate "25000"\nseta snaps "40"\nseta cl_maxpackets "63"\nseta cl_packetdup "1"\n',
  capture:
    '// Clean screenshots\nseta cg_draw2D "0"\nseta cg_drawGun "0"\nbind F12 "screenshot"\n',
  chat: '// Colored chat shortcuts\nbind F5 "say ^2Good fight!"\nbind F6 "say_team ^3Ready"\n',
  cycle:
    '// Two-state toggle with vstr\nset view_on "set cg_drawGun 1; set view_toggle vstr view_off"\nset view_off "set cg_drawGun 0; set view_toggle vstr view_on"\nset view_toggle "vstr view_off"\nbind F7 "vstr view_toggle"\n',
};
export { catalog };
