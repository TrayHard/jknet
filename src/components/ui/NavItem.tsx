import type { ReactNode } from "react";
import { NavLink } from "react-router";

import { cn } from "../../lib/format";

interface NavItemProps {
  to: string;
  icon: ReactNode;
  label: string;
  /** Counter on the right, for example the number of friends online. */
  count?: number;
  /** Matches the route exactly. The Home route needs it, the rest do not. */
  end?: boolean;
}

export function NavItem({ to, icon, label, count, end = false }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          // --- slice: selection context menu ---
          "flex items-center gap-12 h-36 px-12 rounded-md select-none",
          "text-display-nav transition-colors duration-150",
          isActive
            ? "bg-selected-overlay text-fg"
            : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn("shrink-0", isActive && "text-fg-accent")}>{icon}</span>
          {/* --- slice: i18n --- the column is 232 px wide and the design sets
              that width, so a long label truncates; the tooltip carries the
              rest. */}
          <span className="flex-1 truncate" title={label}>
            {label}
          </span>
          {count === undefined ? null : (
            <span className="text-mono-xs text-fg-muted">{count}</span>
          )}
        </>
      )}
    </NavLink>
  );
}
