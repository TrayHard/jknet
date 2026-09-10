import type { ReactNode } from "react";

import { cn } from "../../lib/format";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  /** One sentence saying what to do next, not what went wrong. */
  text: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, text, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-12",
        "rounded-lg border border-dashed border-line px-24 py-48 text-center",
        className,
      )}
    >
      <span className="flex items-center justify-center size-48 rounded-full bg-surface text-fg-muted">
        {icon}
      </span>
      <div className="flex flex-col gap-4">
        <h3 className="text-heading-sm text-fg">{title}</h3>
        <p className="text-body-sm text-fg-muted max-w-[420px]">{text}</p>
      </div>
      {action}
    </div>
  );
}
