/**
 * What the two screens of the JKHub catalog share: the section a card
 * belongs to, the path of a file's page, and the page's card read from the
 * service for a link.
 *
 * Imported by the lazy screens only, so none of it is part of the first
 * download.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useSectionName } from "../../../../src/components/library/jkhubSections.ts";
import { onlineErrorCode, type Game, type JkhubCardData, type JkhubCategory } from "../../../../src/lib/ipc.ts";
import { useWebCore } from "../CoreContext.tsx";
import { catalogUnavailable } from "./serverList.ts";

/** The path of a file's page. */
export function jkhubPath(game: Game, fileId: number): string {
  return `/jkhub/${game}/${fileId}`;
}

/**
 * The name of the section any id of the tree belongs to, the way the
 * launcher's JKHub tab names it under a card: a node of the rail answers
 * with the root of its branch, and the site category a section stands for
 * answers with that section.
 */
export function useSectionOf(tree: JkhubCategory[]): (id: number | null | undefined) => string | undefined {
  const sectionName = useSectionName();
  const sections = useMemo(() => {
    const byId = new Map<number, JkhubCategory>();
    for (const entry of tree) byId.set(entry.id, entry);
    const rootOf = (entry: JkhubCategory) => {
      let node = entry;
      // The tree is two deep; the guard is against a parent chain a damaged
      // answer could make circular.
      for (let step = 0; step < 8 && node.parentId != null; step += 1) {
        const parent = byId.get(node.parentId);
        if (!parent) break;
        node = parent;
      }
      return node;
    };
    const map = new Map<number, JkhubCategory>();
    for (const entry of tree) {
      map.set(entry.id, rootOf(entry));
      if (entry.siteId != null) map.set(entry.siteId, entry);
    }
    return map;
  }, [tree]);
  return useCallback(
    (id) => {
      if (id === null || id === undefined) return undefined;
      const found = sections.get(id);
      return found ? sectionName(found) : undefined;
    },
    [sections, sectionName],
  );
}

/** One card of the service's index, for a file's page opened from a link. */
export function useJkhubFileCard(game: Game, fileId: number): UseQueryResult<JkhubCardData> {
  const core = useWebCore();
  return useQuery({
    queryKey: ["web", "jkhub", "file", game, fileId],
    queryFn: () => core.jkhub.file(game, fileId),
    enabled: Number.isInteger(fileId) && fileId > 0,
    staleTime: 5 * 60_000,
    retry: (failures, error) => !catalogUnavailable(error) && onlineErrorCode(error) !== "not_found" && failures < 1,
  });
}
