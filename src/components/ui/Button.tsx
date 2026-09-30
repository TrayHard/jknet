import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/format";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon placed before the label. Pass a lucide icon at `size-16`. */
  icon?: ReactNode;
  /** Stretches the button to the width of its container. */
  block?: boolean;
  /**
   * Lets a long label wrap: the button grows in height instead of in width,
   * and never past its container. For a label that is a sentence in some
   * languages, where a phone is narrower than the one line. A label that
   * fits keeps the size of the design.
   */
  wrap?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-fg-on-accent hover:bg-accent-hover active:bg-accent " +
    "disabled:bg-elevated disabled:text-fg-disabled",
  secondary:
    "bg-surface text-fg border border-line hover:bg-surface-hover " +
    "disabled:text-fg-disabled disabled:border-line-subtle",
  ghost:
    "bg-transparent text-fg-secondary hover:bg-hover-overlay hover:text-fg " +
    "disabled:text-fg-disabled",
  danger:
    "bg-danger text-white hover:brightness-110 " +
    "disabled:bg-elevated disabled:text-fg-disabled",
};

// --- slice: web app --- a finger needs 44 px: on a touch screen every
// size is at least that tall and wide. A mouse never matches.
const SIZES: Record<ButtonSize, string> = {
  sm: "h-28 px-12 gap-6 rounded-sm pointer-coarse:min-h-44 pointer-coarse:min-w-44",
  md: "h-36 px-16 gap-8 rounded-md pointer-coarse:min-h-44 pointer-coarse:min-w-44",
  lg: "h-44 px-20 gap-8 rounded-md pointer-coarse:min-w-44",
};

// The same sizes for a label that may wrap: a floor instead of a height, and
// the padding that makes one line exactly that tall, with or without the
// 1 px border of `secondary`.
const WRAP_SIZES: Record<ButtonSize, string> = {
  sm: "min-h-28 py-4 px-12 gap-6 rounded-sm pointer-coarse:min-h-44 pointer-coarse:min-w-44",
  md: "min-h-36 py-7 px-16 gap-8 rounded-md pointer-coarse:min-h-44 pointer-coarse:min-w-44",
  lg: "min-h-44 py-10 px-20 gap-8 rounded-md pointer-coarse:min-w-44",
};

const TEXT: Record<ButtonSize, string> = {
  sm: "text-body-sm-medium",
  md: "text-body-md-medium",
  lg: "text-body-md-medium",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  block = false,
  wrap = false,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        // --- slice: selection context menu ---
        // `select-none`, because a label is something to press and never
        // something to copy: the page itself is selectable now, and a drag
        // that starts on a button would otherwise paint it blue.
        "inline-flex items-center justify-center select-none",
        // A wrapped label keeps its icon whole beside the lines.
        wrap ? "max-w-full whitespace-normal text-center [&>svg]:shrink-0" : "whitespace-nowrap",
        "transition-colors duration-150 cursor-pointer",
        "disabled:cursor-not-allowed",
        VARIANTS[variant],
        (wrap ? WRAP_SIZES : SIZES)[size],
        TEXT[size],
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
