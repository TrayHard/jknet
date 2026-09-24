import type { FilePreviewEntry } from "./ipc";

/**
 * Whether an object of a preview session answers a search: by its label, or
 * by its path inside the archive. The path is what a player types when the
 * label is a translated title — `ffa3` for Tatooine City — and what tells
 * `textures/yavin/wall.jpg` from `textures/hoth/wall.jpg`; backslashes are
 * read as slashes, as the game reads them.
 */
export function matchesPreviewSearch(entry: Pick<FilePreviewEntry, "kind" | "label" | "name">, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (query === "") return true;
  return entry.label.toLocaleLowerCase().includes(query)
    || entry.name.toLocaleLowerCase().replace(/\\/g, "/").includes(query.replace(/\\/g, "/"));
}
