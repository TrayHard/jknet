import type { InputHTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/format";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Icon drawn inside the field, before the text. */
  icon?: ReactNode;
  /** Marks the field as rejected and paints the border red. */
  invalid?: boolean;
}

export function Input({ icon, invalid = false, className, ...rest }: InputProps) {
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
        className={cn(
          "w-full bg-transparent outline-none text-body-md text-fg",
          "placeholder:text-fg-muted disabled:text-fg-disabled",
        )}
        {...rest}
      />
    </div>
  );
}
