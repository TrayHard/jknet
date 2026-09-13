/** Keep raw commands intact while editing a named key's effective binding. */
export function configCommands(text: string): string[] {
  const out: string[] = [];
  let part = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      part += ch;
    } else if (!quoted && ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (part.trim()) out.push(part.trim());
      part = "";
    } else if (!quoted && /[;\n\r]/.test(ch)) {
      if (part.trim()) out.push(part.trim());
      part = "";
    } else part += ch;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}
export function configBinds(text: string): { key: string; command: string }[] {
  const entries = new Map<string, string>();
  for (const line of configCommands(text)) {
    const match = line.match(
      /^bind\s+(?:"([^"]+)"|(\S+))\s+(?:"([\s\S]*)"|([\s\S]*))$/i,
    );
    if (match) {
      const key = (match[1] ?? match[2]).toUpperCase(),
        command = match[3] ?? match[4];
      if (command) entries.set(key, command);
      else entries.delete(key);
    }
    const unbind = line.match(/^unbind\s+"?([^"\s]+)"?$/i);
    if (unbind) entries.delete(unbind[1].toUpperCase());
    if (/^unbindall$/i.test(line)) entries.clear();
  }
  return [...entries].map(([key, command]) => ({ key, command }));
}
export function appendBind(text: string, key: string, command: string): string {
  if (
    !/^[A-Za-z0-9_+\-\[\]\\\/.,=']+$/.test(key) ||
    command.includes('"') ||
    /[\r\n]/.test(command)
  )
    throw new Error("Invalid bind syntax");
  return `${text.trimEnd()}\n${command ? `bind ${key.toUpperCase()} "${command}"` : `unbind ${key.toUpperCase()}`}\n`;
}

export interface BindSource { text: string; source: string; kind: "inherited" | "layer" | "edited" }
export interface EffectiveBind { key: string; command: string; source: string; kind: BindSource["kind"] }
/** Replay in execution order, including removals that mask an earlier source. */
export function effectiveBinds(sources: BindSource[]): EffectiveBind[] {
  const result = new Map<string, EffectiveBind>();
  for (const source of sources) {
    for (const command of configCommands(source.text)) {
      if (/^unbindall$/i.test(command)) result.clear();
      const unbind = command.match(/^unbind\s+"?([^"\s]+)"?$/i);
      const bind = command.match(/^bind\s+(?:"([^"]+)"|(\S+))\s+(?:"([\s\S]*)"|([\s\S]*))$/i);
      if (unbind) result.delete(unbind[1].toUpperCase());
      if (bind) {
        const key = (bind[1] ?? bind[2]).toUpperCase(), value = bind[3] ?? bind[4];
        if (value) result.set(key, { key, command: value, source: source.source, kind: source.kind });
        else result.delete(key);
      }
    }
  }
  return [...result.values()];
}
