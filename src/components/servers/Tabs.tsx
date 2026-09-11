import { cn } from "../../lib/format";

export interface TabDefinition<Id extends string> {
  id: Id;
  label: string;
  /** Number after the label. Omit to show none. */
  count?: number;
  /** A tab that exists in the design but has nothing behind it yet. */
  disabled?: boolean;
  /** Why the tab is disabled, shown on hover. */
  title?: string;
}

interface TabsProps<Id extends string> {
  tabs: TabDefinition<Id>[];
  value: Id;
  onChange: (value: Id) => void;
  className?: string;
}

/** The tab strip over the server table: All, Favorites, History. */
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
            disabled={tab.disabled}
            title={tab.title}
            onClick={() => onChange(tab.id)}
            className={cn(
              "inline-flex items-center gap-6 h-36 px-12 -mb-1 border-b-2",
              "text-body-sm-medium transition-colors duration-150 cursor-pointer",
              active
                ? "border-line-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg-secondary",
              tab.disabled &&
                "text-fg-disabled hover:text-fg-disabled cursor-not-allowed",
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
