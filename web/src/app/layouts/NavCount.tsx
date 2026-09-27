import { cn } from "../../../../src/lib/format.ts";

/**
 * The counter of a section: an accent badge that asks for attention, or a
 * grey number that only informs. `99+` past 99, `@` for a mention.
 */
export function NavCount({
  badge,
  count,
  compact = false,
}: {
  badge?: number | "@";
  count?: number;
  compact?: boolean;
}) {
  if (badge !== undefined && badge !== 0) {
    const text = badge === "@" ? "@" : badge > 99 ? "99+" : String(badge);
    return (
      <span
        data-testid="nav-badge"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-sans font-semibold text-fg-on-accent select-none",
          compact ? "h-18 min-w-18 px-5 text-[11px] leading-[16px]" : "h-22 min-w-22 px-7 text-[12px] leading-[16px]",
        )}
      >
        {text}
      </span>
    );
  }
  if (count !== undefined && !compact) {
    return (
      <span data-testid="nav-count" className="shrink-0 text-mono-xs text-fg-secondary">
        {count > 999 ? "999+" : String(count)}
      </span>
    );
  }
  return null;
}
