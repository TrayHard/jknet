import { cn } from "../../lib/format";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Read out by a screen reader, because the switch carries no text. */
  label: string;
  className?: string;
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  className,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex items-center w-40 h-24 shrink-0 rounded-full",
        "transition-colors duration-150 cursor-pointer",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-elevated",
        className,
      )}
    >
      <span
        className={cn(
          "absolute size-20 rounded-full bg-white transition-all duration-150",
          checked ? "left-18" : "left-2",
        )}
      />
    </button>
  );
}
