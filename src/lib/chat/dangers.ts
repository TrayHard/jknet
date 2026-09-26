/**
 * --- slice: chat cards ---
 *
 * The dangerous commands of a bind or a config card, as the core's
 * `chat_scan_commands` names them, turned into what a window shows: one
 * catalog key per reason, and one mark per line of the editor.
 */

import type { ChatCommandDanger } from "../ipc";

/** The reasons the catalog words, by their camelCase key under `chat:dangers.reasons`. */
export const DANGER_REASONS = [
  "quit",
  "exec",
  "writeConfig",
  "rcon",
  "connect",
  "reconnect",
  "unbindAll",
  "allowDownload",
  "filesystem",
  "serverCvar",
  "nestedBind",
  "tooComplex",
] as const;

export type DangerReasonKey = (typeof DANGER_REASONS)[number] | "other";

/** The catalog key of a reason; a reason a newer core added reads as `other`. */
export function dangerReasonKey(reason: string): DangerReasonKey {
  const camel = reason.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return (DANGER_REASONS as readonly string[]).includes(camel) ? (camel as DangerReasonKey) : "other";
}

/** One line of the text and everything dangerous it leads to, in the order of the lines. */
export interface DangerLine {
  line: number;
  dangers: ChatCommandDanger[];
}

/** The dangers grouped by the line that leads to them, lines ascending. */
export function dangersByLine(dangers: ChatCommandDanger[]): DangerLine[] {
  const lines = new Map<number, ChatCommandDanger[]>();
  for (const danger of dangers) {
    const list = lines.get(danger.line) ?? [];
    list.push(danger);
    lines.set(danger.line, list);
  }
  return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([line, list]) => ({ line, dangers: list }));
}

/** Whether the scan stopped early: the player has to read the whole text. */
export function scanIncomplete(dangers: ChatCommandDanger[]): boolean {
  return dangers.some((danger) => danger.reason === "too_complex");
}

/** How a line reaches its command, as one short phrase: `bind F → vstr e1`. */
export function dangerPath(danger: ChatCommandDanger): string {
  return [...(danger.via ?? []), danger.command].join(" → ");
}
