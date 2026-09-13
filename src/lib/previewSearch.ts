import type { FilePreviewEntry } from "./ipc";

export function matchesPreviewSearch(entry: Pick<FilePreviewEntry, "kind" | "label" | "name">, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  return entry.label.toLocaleLowerCase().includes(query)
    || (entry.kind === "map" && entry.name.toLocaleLowerCase().includes(query.replace(/\\/g, "/")));
}
