import type { ReactNode } from "react";

import { cn } from "../../lib/format";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "warm"
  | "success"
  | "danger"
  | "purple";

interface BadgeProps {
  tone?: BadgeTone;
  icon?: ReactNode;
  // --- slice: servers home tweaks ---
  /**
   * Centres the label in a pill at least 56 px wide.
   *
   * For a badge that stands in a column with others under it: the mode of a
   * server row, on the table of the Servers screen and in the rows of Home.
   * The labels run from `JM` to `SIEGE`, so pills sized to their own text sat
   * under one another with the text starting in four different places, which
   * reads as a column that failed to line up. 56 px is the widest short label
   * plus the padding below, so the floor squeezes nothing and the 60 px
   * column of the table still holds it.
   *
   * A badge that stands on its own — **DEFAULT** beside a client name, the
   * lock of a passworded server — takes the width of its own text and leaves
   * this off.
   */
  centered?: boolean;
  className?: string;
  children: ReactNode;
}

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-elevated text-fg-secondary",
  accent: "bg-accent-subtle text-fg-accent",
  warm: "bg-warm-subtle text-fg-warm",
  success: "bg-success-subtle text-fg-success",
  danger: "bg-danger-subtle text-fg-danger",
  purple: "bg-purple-subtle text-fg-purple",
};

export function Badge({
  tone = "neutral",
  icon,
  centered = false,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={cn(
        // --- slice: selection context menu ---
        // A badge is a mark on a row, not a word to copy out of it.
        "inline-flex items-center gap-4 h-20 px-8 rounded-full select-none",
        "text-label-xs",
        TONES[tone],
        centered && "min-w-56 justify-center text-center",
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
