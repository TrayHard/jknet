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

export function Badge({ tone = "neutral", icon, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-4 h-20 px-8 rounded-full",
        "text-label-xs",
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
