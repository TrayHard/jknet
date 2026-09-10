import { Check } from "lucide-react";

import { cn } from "../../lib/format";

/** One step of the strip: its label, plus what a screen reader adds to it. */
export interface StepBadge {
  label: string;
  /** Read after the label of a step already behind the player. */
  done: string;
  /** Read after the label of the step on screen. */
  current: string;
  /** Read after the label of a step still ahead. */
  upcoming: string;
}

interface StepBadgesProps {
  /** One entry per step, in order. */
  steps: StepBadge[];
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
      {steps.map((step, index) => {
        const number = index + 1;
        const done = number < current;
        const active = number === current;

        return (
          <li
            key={step.label}
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
              {step.label}
              <span className="sr-only">
                {done ? step.done : active ? step.current : step.upcoming}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
