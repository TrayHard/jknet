import type { HostClientOption, HostSettings, ServerConfigDocument } from "./ipc";
import { MOD_CATALOG } from "./serverConfigCatalog.ts";

/** A folder is a compatibility hint, never an instruction to install a mod. */
export function hostConfigCompatible(document: ServerConfigDocument, client: HostClientOption | undefined): boolean {
  if (!client) return false;
  const folder = (client.modFolder ?? "").toLowerCase();
  if (document.modId === "base") return folder === "" || folder === "base";
  return MOD_CATALOG.find((mod) => mod.id === document.modId)?.modFolders.some((alias) => alias.toLowerCase() === folder) ?? false;
}

export function hostModId(client: HostClientOption | undefined): string | null {
  const folder = (client?.modFolder ?? "").toLowerCase();
  if (folder === "" || folder === "base") return "base";
  return MOD_CATALOG.find((mod) => mod.modFolders.some((alias) => alias.toLowerCase() === folder))?.id ?? null;
}

/** The same match inputs, saved without passwords, friends or network policy. */
export function hostConfigText(settings: HostSettings, scoreCvar: string | null, previous = ""): string {
  const values: Record<string, string> = {
    sv_hostname: settings.serverName.replace(/[^A-Za-z0-9 _.'!^-]/g, "").replace(/\s+/g, " ").trim().slice(0, 32) || "JKNet game",
    g_gametype: String(settings.gametype),
    sv_maxclients: String(settings.maxPlayers),
    timelimit: String(settings.timeLimit),
    ...(scoreCvar ? { [scoreCvar]: String(settings.scoreLimit) } : {}),
    bot_minplayers: String(settings.bots),
  };
  // Append final overrides: authored comments and compound lines stay intact.
  // The server compiler reads the last assignment, as the engine does.
  const match = Object.entries(values).map(([name, value]) => `set ${name} "${value}"`).join("\n");
  const map = /^[A-Za-z0-9_/-]+$/.test(settings.map) ? `map ${settings.map}\n` : "";
  return `${previous.trimEnd()}${previous.trim() ? "\n\n" : ""}${match}\n${map}`;
}
