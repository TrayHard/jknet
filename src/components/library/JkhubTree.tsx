import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { JkhubCategory } from "../../lib/ipc";
import { Badge } from "../ui";

interface JkhubTreeProps {
  categories: JkhubCategory[];
  selected: number | null;
  onSelect: (category: JkhubCategory) => void;
  /**
   * Matches per category while a query is active, `null` while none is.
   *
   * Comes from `jkhub_search` already rolled up the tree, so a container
   * carries what its children hold.
   */
  counts: Record<string, number> | null;
}

/**
 * Whether a pruned tree still shows a category.
 *
 * One rule, because the core did the hard half: a category with matches
 * anywhere below it already has a count of its own, so keeping every category
 * with a count keeps the ancestors of every match too. Without a query nothing
 * is pruned at all.
 *
 * ```ts
 * shows(null)(anything)                 // true
 * shows({ "13": 4 })({ id: 13, ... })   // true
 * shows({ "13": 4 })({ id: 28, ... })   // false
 * ```
 */
export function shows(
  counts: Record<string, number> | null,
): (category: JkhubCategory) => boolean {
  return (category) =>
    counts == null || (counts[String(category.id)] ?? 0) > 0;
}

/**
 * The category tree of one game.
 *
 * Two levels are expandable: JKHub nests Maps and Code Mods one deeper, and a
 * container such as Maps holds no files of its own — clicking it would give an
 * empty listing, so it expands instead of selecting.
 *
 * With a query typed, the tree shrinks to the categories that answer it and
 * every badge switches from the file count of the category to the number of
 * matches inside it. Nothing collapses in that state: a branch the player
 * never opened is exactly where the file they cannot find tends to be.
 *
 * `Contest Entries` never reaches this component: the core drops the root, as
 * it is a temporary category that is usually empty (research report,
 * section 2).
 *
 * --- slice: library cleanup ---
 * The header is a heading and nothing else. Walking the tree again costs about
 * twenty requests to jkhub.org and the tree changes a few times a year, so the
 * action for it sits on the Settings screen, next to the other caches, rather
 * than above a list the player reads every visit.
 */
export function JkhubTree({ categories, selected, onSelect, counts }: JkhubTreeProps) {
  const { t } = useTranslation("jkhub");
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  const visible = useMemo(
    () => categories.filter(shows(counts)),
    [categories, counts],
  );

  const children = useMemo(() => {
    const map = new Map<number | null, JkhubCategory[]>();
    for (const category of visible) {
      const list = map.get(category.parentId) ?? [];
      list.push(category);
      map.set(category.parentId, list);
    }
    return map;
  }, [visible]);

  const roots = children.get(null) ?? [];

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const render = (category: JkhubCategory, depth: number) => {
    const below = children.get(category.id) ?? [];
    const expandable = below.length > 0;
    // A pruned tree is a short one, and every branch left in it holds an
    // answer, so it opens itself.
    const expanded = counts != null || open.has(category.id) || depth === 0;
    const badge = counts
      ? counts[String(category.id)]
      : (category.fileCount ?? undefined);
    return (
      <li key={category.id}>
        <div className="flex items-center">
          {expandable && depth > 0 && counts == null ? (
            <button
              type="button"
              aria-label={
                expanded
                  ? t("tree.collapse", { category: category.name })
                  : t("tree.expand", { category: category.name })
              }
              onClick={() => toggle(category.id)}
              className="inline-flex size-20 items-center justify-center rounded-sm text-fg-muted hover:text-fg cursor-pointer shrink-0"
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span className="size-20 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            // A container has no listing of its own, so it opens instead.
            onClick={() =>
              category.hasFiles ? onSelect(category) : toggle(category.id)
            }
            className={cn(
              "flex flex-1 min-w-0 items-center gap-8 h-32 px-8 rounded-md cursor-pointer",
              "transition-colors duration-150",
              depth === 0 ? "text-body-md-medium" : "text-body-sm",
              selected === category.id
                ? "bg-selected-overlay text-fg"
                : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
            )}
          >
            <span className="flex-1 text-left truncate" title={category.name}>
              {category.name}
            </span>
            {badge != null ? (
              <Badge
                tone={
                  counts
                    ? "accent"
                    : selected === category.id
                      ? "accent"
                      : "neutral"
                }
              >
                {badge}
              </Badge>
            ) : null}
          </button>
        </div>
        {expandable && expanded ? (
          <ul className="pl-12 flex flex-col gap-1">
            {below.map((child) => render(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  const header = (
    <div className="flex items-center gap-8 pb-8">
      <span className="text-label-xs text-fg-muted flex-1">{t("tree.heading")}</span>
    </div>
  );

  return (
    <>
      {header}
      {roots.length === 0 ? (
        <p className="text-body-sm text-fg-muted">
          {counts ? t("tree.noMatches") : t("tree.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {roots.map((root) => render(root, 0))}
        </ul>
      )}
    </>
  );
}
