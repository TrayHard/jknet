import { ChevronDown } from "lucide-react";

import { cn } from "../../lib/format";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  /** Word in front of the value: `Mode`, `Mod`, `Players`. */
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
}

/**
 * The filter dropdown of the Servers screen.
 *
 * A native `<select>` under a styled shell: the popup then comes from the
 * operating system, which keeps keyboard behaviour and long lists working
 * without a popover of our own. `color-scheme: dark` is what stops WebView2
 * from drawing that popup white.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  className,
}: SelectProps) {
  const selected = options.find((option) => option.value === value);

  return (
    <label
      className={cn(
        "relative inline-flex items-center gap-8 h-36 pl-12 pr-32 rounded-md",
        "bg-input border border-line cursor-pointer",
        "transition-colors duration-150 hover:border-line-strong",
        "focus-within:border-line-focus",
        className,
      )}
    >
      <span className="text-label-xs text-fg-muted shrink-0">{label}</span>
      <span className="text-body-sm-medium text-fg truncate">
        {selected?.label ?? value}
      </span>
      <ChevronDown
        size={14}
        className="absolute right-10 text-fg-muted pointer-events-none"
      />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 w-full opacity-0 cursor-pointer [color-scheme:dark]"
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
