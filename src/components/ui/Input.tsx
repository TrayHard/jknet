import type { InputHTMLAttributes, ReactNode, Ref } from "react";

import { cn } from "../../lib/format";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Icon drawn inside the field, before the text. */
  icon?: ReactNode;
  /** Marks the field as rejected and paints the border red. */
  invalid?: boolean;
  // --- slice: library polish ---
  /**
   * A control drawn inside the field, after the text: a clear button, a unit,
   * a spinner.
   *
   * Inside rather than beside, because the box the player sees is this whole
   * frame and a button next to it would read as a second control. It keeps
   * its size when the text does not fit — the text truncates, the button
   * stays pressable.
   */
  trailing?: ReactNode;
  /**
   * Handle on the `<input>` itself, for a caller that has to put the caret
   * back — clearing the field is the case this was added for.
   */
  ref?: Ref<HTMLInputElement>;
}

export function Input({
  icon,
  invalid = false,
  trailing,
  className,
  ref,
  ...rest
}: InputProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-8 h-36 px-12 rounded-md",
        "bg-input border transition-colors duration-150",
        invalid ? "border-line-danger" : "border-line",
        "focus-within:border-line-focus",
        className,
      )}
    >
      {icon ? <span className="text-fg-muted shrink-0">{icon}</span> : null}
      <input
        ref={ref}
        className={cn(
          "w-full min-w-0 bg-transparent outline-none text-body-md text-fg",
          "placeholder:text-fg-muted disabled:text-fg-disabled",
        )}
        {...rest}
      />
      {trailing ? <span className="shrink-0 flex items-center">{trailing}</span> : null}
    </div>
  );
}
