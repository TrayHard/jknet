import { ChevronDown } from "lucide-react";

import { cn } from "../../lib/format";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  /** Read out by a screen reader; the control carries no visible label. */
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The Select of the design: a native `select` under a styled shell.
 *
 * Native keeps the keyboard behaviour and the platform popup, which a short
 * list of clients or sort orders has no reason to reimplement. The UI kit has
 * no Select yet and three branches are open at once, so it lives here until
 * they meet.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: SelectProps) {
  return (
    <div
      className={cn(
        "relative inline-flex items-center h-36 rounded-md",
        "bg-input border border-line focus-within:border-line-focus",
        "transition-colors duration-150",
        className,
      )}
    >
      <select
        aria-label={label}
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "appearance-none bg-transparent outline-none cursor-pointer",
          "h-36 pl-12 pr-32 w-full text-body-md-medium text-fg",
          "disabled:cursor-not-allowed disabled:text-fg-disabled",
        )}
      >
        {options.length === 0 ? <option value="">Nothing to choose</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-surface text-fg">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        aria-hidden
        className="pointer-events-none absolute right-12 text-fg-muted"
      />
    </div>
  );
}
