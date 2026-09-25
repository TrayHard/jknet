import { Check } from "lucide-react";

import { cn } from "../../lib/format";

/**
 * The 16 px box and ring of the Checkbox and the radio of the Figma kit.
 *
 * Both are drawn next to a real `input` that is hidden but present, as
 * `RadioCard` does: the input gives the keyboard, the screen reader and the
 * form semantics, and the drawing follows it through `peer-*` utilities. The
 * input therefore has to come right before the drawing, inside one `<label>`.
 */

const FOCUS =
  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-line-focus";

/** The Checkbox of the design: off on the input fill, on in accent with a check. */
export function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center size-16 shrink-0 rounded-xs",
        checked ? "bg-accent text-fg-on-accent" : "bg-input border border-line-strong",
        FOCUS,
      )}
    >
      {checked ? <Check size={12} strokeWidth={3} /> : null}
    </span>
  );
}

/** A radio ring: accent with a dot when chosen, the strong border otherwise. */
export function RadioRing({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center size-16 shrink-0 rounded-full border",
        checked ? "border-line-accent" : "border-line-strong",
        FOCUS,
      )}
    >
      {checked ? <span className="size-8 rounded-full bg-accent" /> : null}
    </span>
  );
}
