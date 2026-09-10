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

const SIZES: Record<ButtonSize, string> = {
  sm: "h-28 px-12 gap-6 rounded-sm",
  md: "h-36 px-16 gap-8 rounded-md",
  lg: "h-44 px-20 gap-8 rounded-md",
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
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap",
        "transition-colors duration-150 cursor-pointer",
        "disabled:cursor-not-allowed",
        VARIANTS[variant],
        SIZES[size],
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
