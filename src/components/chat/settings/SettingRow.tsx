import { useId, type ReactNode } from "react";

import { cn } from "../../../lib/format";
import { RadioRing } from "../../host/Choice";
import { Toggle } from "../../ui";

/**
 * --- slice: chat notifications ---
 *
 * The rows of the chat cards on the Settings screen: a title and a line of
 * help on the left, the control on the right, a hairline between rows. The
 * cards have many switches each, so a row is small and flat rather than a
 * card of its own; the H-Settings board of the prototype draws them so.
 */

interface SettingsCardProps {
  /** The anchor `#/settings?section=…` scrolls to. */
  id?: string;
  icon: ReactNode;
  title: string;
  text?: ReactNode;
  /** A button on the right of the title. */
  action?: ReactNode;
  children: ReactNode;
}

/** One card of the chat group: an icon, a title, a line under it and its rows. */
export function SettingsCard({ id, icon, title, text, action, children }: SettingsCardProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="rounded-lg border border-line bg-surface p-16 scroll-mt-24 min-w-0"
    >
      <div className="flex items-start gap-12 pb-12">
        <span className="flex items-center justify-center size-36 rounded-md bg-elevated text-fg-secondary shrink-0">
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <h3 id={headingId} className="text-heading-sm text-fg pb-2">
            {title}
          </h3>
          {text ? <p className="text-body-sm text-fg-secondary">{text}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** A few rows of a card that belong together, under a small heading. */
export function RowGroup({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col border-t border-line-subtle pt-12">
      <h4 id={headingId} className="text-label-xs text-fg-muted uppercase pb-8">
        {title}
      </h4>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

interface SettingRowProps {
  title: string;
  hint?: ReactNode;
  /** The switch, the list or the buttons on the right. */
  control?: ReactNode;
  /** Greys the words out too, not only the control. */
  disabled?: boolean;
  /** What goes under the row: the times of quiet hours, a choice. */
  children?: ReactNode;
  className?: string;
}

/** One setting: the words on the left, the control on the right. */
export function SettingRow({ title, hint, control, disabled = false, children, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-8 py-12 border-t border-line-subtle first:border-t-0 first:pt-0",
        className,
      )}
    >
      <div className="flex items-start gap-16">
        <span className={cn("flex-1 min-w-0 flex flex-col gap-2", disabled && "opacity-60")}>
          <span className="text-body-md-medium text-fg">{title}</span>
          {hint ? <span className="text-body-sm text-fg-muted">{hint}</span> : null}
        </span>
        {control ? <span className="shrink-0 flex items-center gap-8 pt-2">{control}</span> : null}
      </div>
      {children}
    </div>
  );
}

interface ToggleRowProps {
  title: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}

/** A setting that is a switch; the switch is named by the row's title. */
export function ToggleRow({ title, hint, checked, onChange, disabled = false, children }: ToggleRowProps) {
  return (
    <SettingRow
      title={title}
      hint={hint}
      disabled={disabled}
      control={<Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />}
    >
      {children}
    </SettingRow>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

interface ChoiceRowProps<T extends string> {
  title: string;
  hint?: ReactNode;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/**
 * A setting that is one of a few words: radios under the title. Real radio
 * inputs, hidden but present, so the group has its arrow keys and its
 * screen reader name for free, as `RadioCard` has.
 */
export function ChoiceRow<T extends string>({
  title,
  hint,
  value,
  options,
  onChange,
  disabled = false,
}: ChoiceRowProps<T>) {
  const name = useId();
  return (
    <SettingRow title={title} hint={hint} disabled={disabled}>
      <div role="radiogroup" aria-label={title} className="flex flex-wrap gap-x-20 gap-y-8">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              // `relative`: the hidden input is absolutely positioned, and
              // without a positioned box of its own it would hang off the
              // app shell outside the scrolling page, stretch it, and a
              // `scrollIntoView` would scroll the title bar away.
              "relative flex items-center gap-8 text-body-md text-fg select-none",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <RadioRing checked={value === option.value} />
            {option.label}
          </label>
        ))}
      </div>
    </SettingRow>
  );
}
