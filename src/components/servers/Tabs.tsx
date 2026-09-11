import { cn } from "../../lib/format";

export interface TabDefinition<Id extends string> {
  id: Id;
  label: string;
  /** Number after the label. Omit to show none. */
  count?: number;
  /** What this tab holds, shown on hover. */
  title?: string;
}

interface TabsProps<Id extends string> {
  tabs: TabDefinition<Id>[];
  value: Id;
  onChange: (value: Id) => void;
  className?: string;
}

/**
 * The tab strip over the server table: All, Favorites, History and LAN.
 *
 * --- slice: servers browser ---
 * Every tab is live. The strip had a disabled state while LAN discovery was a
 * placeholder; a tab nobody can press is not something to keep on a screen.
 */
export function Tabs<Id extends string>({
  tabs,
  value,
  onChange,
  className,
}: TabsProps<Id>) {
  return (
    <div
      role="tablist"
      className={cn("flex items-center gap-4 border-b border-line", className)}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={tab.title}
            onClick={() => onChange(tab.id)}
            className={cn(
              "inline-flex items-center gap-6 h-36 px-12 -mb-1 border-b-2",
              "text-body-sm-medium transition-colors duration-150 cursor-pointer",
              active
                ? "border-line-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg-secondary",
            )}
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span
                className={cn(
                  "text-mono-xs tabular-nums",
                  active ? "text-fg-accent" : "text-fg-disabled",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
