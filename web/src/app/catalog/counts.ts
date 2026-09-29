/**
 * The sizes of the catalogs the screens have loaded, for the muted counts of
 * the menu and the rail.
 *
 * A catalog screen reports the size of its unfiltered list here when it
 * loads one; `useNavCounters` reads it. No request is ever made for a
 * count, so a section the player has not opened shows none.
 */

import { useSyncExternalStore } from "react";

import type { Game } from "../../../../src/lib/ipc.ts";

/**
 * `community`: the community servers; `bundles:<game>`: the bundles of a
 * game; `servers:<game>`: the servers of a game with players on them.
 */
export type CatalogCountKey = "community" | `bundles:${Game}` | `servers:${Game}`;

const counts = new Map<CatalogCountKey, number>();
const listeners = new Set<() => void>();

/** Records the size of a catalog's unfiltered list. */
export function setCatalogCount(key: CatalogCountKey, value: number): void {
  if (!Number.isFinite(value) || value < 0 || counts.get(key) === value) return;
  counts.set(key, value);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The size last reported for a catalog, `undefined` before its screen loaded it. */
export function useCatalogCount(key: CatalogCountKey): number | undefined {
  const read = () => counts.get(key);
  return useSyncExternalStore(subscribe, read, read);
}
