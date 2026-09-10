import type { ReactNode } from "react";

import { cn } from "../../lib/format";

interface RadioCardProps {
  /** Groups the cards. Every card of one choice needs the same name. */
  name: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  /** First line of the card, in the weight of a label. */
  title: ReactNode;
  /** Pinned to the right of the title: a badge, a version, a size. */
  aside?: ReactNode;
  /** Anything under the title, indented past the radio dot. */
  children?: ReactNode;
  className?: string;
}

/**
 * A card the player picks one of.
 *
 * The radio is a real `input`, hidden but present: that is what gives the
 * group its arrow-key navigation, its screen reader announcement and its form
 * semantics for free. A `div` with `role="radio"` would need all three written
 * by hand, and onboarding is the one screen a new player cannot skip.
 */
export function RadioCard({
  name,
  selected,
  onSelect,
  disabled = false,
  title,
  aside,
  children,
  className,
}: RadioCardProps) {
  return (
    <label
      className={cn(
        "flex flex-col gap-4 rounded-md border p-12 transition-colors duration-150",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
        "has-[:focus-visible]:outline-line-focus",
        disabled
          ? "border-line-subtle bg-input opacity-60 cursor-not-allowed"
          : "cursor-pointer",
        !disabled && selected
          ? "border-line-accent bg-accent-subtle"
          : !disabled
            ? "border-line bg-input hover:bg-surface-hover"
            : "",
        className,
      )}
    >
      <span className="flex items-center gap-8">
        <input
          type="radio"
          name={name}
          checked={selected}
          disabled={disabled}
          onChange={onSelect}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center size-16 shrink-0 rounded-full border",
            selected ? "border-line-accent" : "border-line-strong",
          )}
        >
          {selected ? <span className="size-8 rounded-full bg-accent" /> : null}
        </span>
        <span className="flex-1 min-w-0 text-body-md-medium text-fg">{title}</span>
        {aside ? <span className="flex items-center gap-8 shrink-0">{aside}</span> : null}
      </span>
      {children ? <span className="block pl-24">{children}</span> : null}
    </label>
  );
}
