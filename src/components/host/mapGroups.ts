import type { HostMap } from "../../lib/ipc";

export interface HostMapMode {
  id: string;
  label: string;
}

export interface GroupedHostMap {
  map: HostMap;
  group: string | null;
  modeLabels: string[];
}

interface GroupedMapSortKey extends GroupedHostMap {
  groupRank: number;
  unknownGroup: boolean;
  index: number;
}

function tokenKey(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * Gives every discovered map a display group without treating arena metadata
 * as a filter. A map belongs to the first mode token its arena advertises.
 */
export function groupHostMaps(
  maps: HostMap[],
  modes: Array<{ id: string; label: string }>,
): Array<{ map: HostMap; group: string | null; modeLabels: string[] }> {
  const known = new Map<string, { label: string; index: number }>();
  for (const [index, mode] of modes.entries()) {
    const key = tokenKey(mode.id);
    if (key && !known.has(key)) known.set(key, { label: mode.label, index });
  }
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const grouped: GroupedMapSortKey[] = maps.map((map, index) => {
    const seen = new Set<string>();
    const tokens = map.gametypes.flatMap((token) => {
      const key = tokenKey(token);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [key];
    });
    const first = tokens[0];
    const firstKnown = first ? known.get(first) : undefined;
    const modeLabels = tokens.map((token) => known.get(token)?.label ?? token.toUpperCase());
    return {
      map,
      group: modeLabels[0] ?? null,
      modeLabels,
      groupRank: firstKnown?.index ?? (first ? modes.length : modes.length + 1),
      unknownGroup: !!first && firstKnown === undefined,
      index,
    };
  });

  grouped.sort((left, right) => {
    if (left.groupRank !== right.groupRank) return left.groupRank - right.groupRank;
    if (left.unknownGroup && right.unknownGroup && left.group !== right.group) {
      return collator.compare(left.group ?? "", right.group ?? "");
    }
    const byName = collator.compare(left.map.name, right.map.name);
    if (byName !== 0) return byName;
    return left.index - right.index;
  });

  return grouped.map(({ map, group, modeLabels }) => ({ map, group, modeLabels }));
}
