import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/format";
import type { JkhubCategory } from "../../lib/ipc";
import { Badge } from "../ui";

interface JkhubTreeProps {
  categories: JkhubCategory[];
  selected: number | null;
  onSelect: (category: JkhubCategory) => void;
}

/**
 * The category tree of one game.
 *
 * Two levels are expandable: JKHub nests Maps and Code Mods one deeper, and a
 * container such as Maps holds no files of its own — clicking it would give an
 * empty listing, so it expands instead of selecting.
 *
 * `Contest Entries` never reaches this component: the core drops the root, as
 * it is a temporary category that is usually empty (research report,
 * section 2).
 */
export function JkhubTree({ categories, selected, onSelect }: JkhubTreeProps) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  const children = useMemo(() => {
    const map = new Map<number | null, JkhubCategory[]>();
    for (const category of categories) {
      const list = map.get(category.parentId) ?? [];
      list.push(category);
      map.set(category.parentId, list);
    }
    return map;
  }, [categories]);

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
    const expanded = open.has(category.id) || depth === 0;
    return (
      <li key={category.id}>
        <div className="flex items-center">
          {expandable && depth > 0 ? (
            <button
              type="button"
              aria-label={expanded ? `Collapse ${category.name}` : `Expand ${category.name}`}
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
            {category.fileCount != null ? (
              <Badge tone={selected === category.id ? "accent" : "neutral"}>
                {category.fileCount}
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

  if (roots.length === 0) {
    return <p className="text-body-sm text-fg-muted">No categories yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">{roots.map((root) => render(root, 0))}</ul>
  );
}
