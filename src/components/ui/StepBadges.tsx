import { Check } from "lucide-react";

import { cn } from "../../lib/format";

interface StepBadgesProps {
  /** One label per step, in order. */
  steps: string[];
  /** The step being shown, counted from 1. */
  current: number;
  className?: string;
}

/**
 * The progress strip of a short wizard: done, current, upcoming.
 *
 * The state is carried by the tone and by the glyph, not by colour alone: a
 * done step swaps its number for a check mark, so the strip still reads on a
 * monochrome screen.
 */
export function StepBadges({ steps, current, className }: StepBadgesProps) {
  return (
    <ol className={cn("flex items-center gap-8", className)}>
      {steps.map((label, index) => {
        const number = index + 1;
        const done = number < current;
        const active = number === current;

        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-6 h-24 pl-4 pr-10 rounded-full",
              done
                ? "bg-success-subtle text-fg-success"
                : active
                  ? "bg-accent-subtle text-fg-accent"
                  : "bg-elevated text-fg-muted",
            )}
          >
            <span
              className={cn(
                "flex items-center justify-center size-16 rounded-full text-label-xs",
                done
                  ? "bg-success text-white"
                  : active
                    ? "bg-accent text-fg-on-accent"
                    : "bg-surface text-fg-muted",
              )}
            >
              {done ? <Check size={10} strokeWidth={3} /> : number}
            </span>
            <span className="text-label-xs">
              {label}
              <span className="sr-only">
                {done ? " (done)" : active ? " (current step)" : " (not started)"}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
