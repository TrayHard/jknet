import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button, Input, Select, type SelectOption } from "../ui";
import { MAX_NICKNAME_BYTES, NicknameEditor, nicknameBytes } from "./NicknameEditor";
import { Slider } from "./Slider";

/**
 * The controls of the client window, each bound to one cvar.
 *
 * Three rules they share:
 *
 * - **A control writes when the player is done, not while they type.** Every
 *   write saves `client.json` and rebuilds the command line preview, so a
 *   field commits on blur and on Enter and a slider commits when it is let go.
 * - **Empty means the cvar is not there.** Clearing a field removes the token
 *   instead of writing an empty value, and the engine keeps whatever its own
 *   configuration says.
 * - **The value can change under the control.** Another control writes, the
 *   whole line comes back, and every control re-reads it. A field the player
 *   is typing in keeps what they typed.
 */

interface SettingRowProps {
  label: string;
  /** Id of the control, so the label points at it. */
  htmlFor?: string;
  /** One line under the control. */
  hint?: ReactNode;
  children: ReactNode;
  /**
   * Removes the cvar from the line. Pass it only when the cvar is there: the
   * button is how a control that has no empty state — a list, a slider — gets
   * back to «the client does not set this».
   */
  onClear?: () => void;
  /** Accessible name of that button. */
  clearLabel?: string;
}

export function SettingRow({
  label,
  htmlFor,
  hint,
  children,
  onClear,
  clearLabel,
}: SettingRowProps) {
  return (
    <div className="flex items-start gap-12 py-6">
      <label
        htmlFor={htmlFor}
        className="w-152 shrink-0 pt-8 text-body-sm text-fg-secondary"
      >
        {label}
      </label>
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="flex items-center gap-8">
          <div className="flex-1 min-w-0">{children}</div>
          {onClear ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={14} />}
              onClick={onClear}
              aria-label={clearLabel}
              title={clearLabel}
            />
          ) : null}
        </div>
        {hint ? <p className="text-body-sm text-fg-muted">{hint}</p> : null}
      </div>
    </div>
  );
}

interface CvarFieldProps {
  id: string;
  /** The value on the line, or `null` when the line does not carry the cvar. */
  value: string | null;
  placeholder?: string;
  /** Draws the numeric keyboard and the spinner. */
  numeric?: boolean;
  maxLength?: number;
  disabled?: boolean;
  /**
   * Puts the old value back instead of committing an empty field.
   *
   * For the client name, which is not a cvar and has no «not set» state: the
   * core refuses a blank name, and a field left blank on screen over a record
   * that still has one is worse than a field that simply springs back.
   */
  revertOnEmpty?: boolean;
  /** Called with the trimmed value, or `null` for an empty field. */
  onCommit: (value: string | null) => void;
}

/**
 * The draft of a field that writes when the player is done with it.
 *
 * The three rules of the file live here: the draft is what the field shows,
 * the write happens on blur and on Enter, and an empty field removes the cvar
 * unless the caller asked for the old value back. Both text fields of the
 * window share it, the plain one and the coloured name.
 */
function useCommittedDraft(
  value: string | null,
  revertOnEmpty: boolean,
  onCommit: (value: string | null) => void,
  /**
   * Holds a write back while the draft is one the core would refuse. The
   * draft stays on the field with whatever the control says about it, so the
   * player edits their own text instead of watching it spring back.
   */
  canCommit: (value: string) => boolean = () => true,
) {
  const [draft, setDraft] = useState(value ?? "");
  // Focus through a ref rather than through state: the effect below must run
  // when the value changes and never because the field lost focus, which is
  // the moment the old value is still what the cache holds.
  const focused = useRef(false);
  // What was last sent. Enter and the blur that follows it are two commits of
  // one edit, and the value of the query has not come back between them.
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (focused.current) return;
    sent.current = null;
    setDraft(value ?? "");
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "" && revertOnEmpty) {
      setDraft(value ?? "");
      return;
    }
    if (trimmed === (value ?? "") || trimmed === sent.current) return;
    if (!canCommit(trimmed)) return;
    sent.current = trimmed;
    onCommit(trimmed === "" ? null : trimmed);
  };

  return {
    draft,
    setDraft,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") commit();
    },
  };
}

/** A text or number field bound to one cvar. */
export function CvarField({
  id,
  value,
  placeholder,
  numeric = false,
  maxLength,
  disabled = false,
  revertOnEmpty = false,
  onCommit,
}: CvarFieldProps) {
  const { draft, setDraft, onFocus, onBlur, onKeyDown } = useCommittedDraft(
    value,
    revertOnEmpty,
    onCommit,
  );

  return (
    <Input
      id={id}
      type={numeric ? "number" : "text"}
      inputMode={numeric ? "numeric" : undefined}
      min={numeric ? 0 : undefined}
      value={draft}
      maxLength={maxLength}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}

interface CvarNameFieldProps {
  id: string;
  /** The value on the line, or `null` when the line does not carry `name`. */
  value: string | null;
  placeholder: string;
  onCommit: (value: string | null) => void;
}

/**
 * The `name` cvar, in the control that shows the name the way the game will.
 *
 * The same {@link NicknameEditor} the nickname of a player profile is written
 * in: the letters carry their colour codes, the preview reads the name
 * without its markup, and the counter measures it in the bytes the engine
 * measures. The two names end up on the same command line one after the
 * other, and a player who sees one of them coloured and the other plain would
 * have every reason to think they are different kinds of name.
 *
 * What stays the way every other control of the window behaves: the write
 * happens on blur and on Enter, and clearing the field removes the cvar
 * instead of writing an empty name.
 *
 * A name over {@link MAX_NICKNAME_BYTES} is not written at all. The core
 * refuses it — `validate_value` in `src-tauri/src/launch_tokens.rs` holds the
 * same limit the nickname of a profile goes by — so the field holds the write
 * back and leaves the player with the counter and the warning the editor
 * already draws, rather than a toast about a name they can see is too long.
 */
export function CvarNameField({ id, value, placeholder, onCommit }: CvarNameFieldProps) {
  const { draft, setDraft, onFocus, onBlur, onKeyDown } = useCommittedDraft(
    value,
    false,
    onCommit,
    (next) => nicknameBytes(next) <= MAX_NICKNAME_BYTES,
  );

  return (
    <NicknameEditor
      id={id}
      value={draft}
      placeholder={placeholder}
      onChange={setDraft}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}

interface CvarSelectProps {
  value: string | null;
  options: SelectOption[];
  ariaLabel: string;
  /** Drawn when the line does not carry the cvar. */
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

/** A list bound to one cvar, empty when the line does not carry it. */
export function CvarSelect({
  value,
  options,
  ariaLabel,
  placeholder,
  disabled = false,
  onChange,
}: CvarSelectProps) {
  return (
    <Select
      value={value ?? ""}
      options={options}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

interface CvarSliderProps {
  id: string;
  value: string | null;
  ariaLabel: string;
  /** Written when the player lets the slider go. */
  onCommit: (value: string) => void;
}

/** Step of the volume sliders: ten positions is what a volume needs. */
const VOLUME_STEP = 0.1;

/**
 * A 0 to 1 slider bound to one cvar.
 *
 * The number is written when the slider is let go, not while it moves: every
 * write is a file and a round trip, and a drag across the track would be ten
 * of both.
 */
export function CvarSlider({ id, value, ariaLabel, onCommit }: CvarSliderProps) {
  const [draft, setDraft] = useState(value ?? "");
  const dragging = useRef(false);
  // Letting go of the thumb and losing focus are two commits of one drag.
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (dragging.current) return;
    sent.current = null;
    setDraft(value ?? "");
  }, [value]);

  const position = Number.parseFloat(draft);
  const number = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0;

  const commit = () => {
    dragging.current = false;
    if (draft === (value ?? "") || draft === sent.current) return;
    sent.current = draft;
    onCommit(draft);
  };

  return (
    <div className="flex items-center gap-12">
      <Slider
        id={id}
        className="flex-1 min-w-0"
        min={0}
        max={1}
        step={VOLUME_STEP}
        value={number}
        aria-label={ariaLabel}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onChange={(event) => {
          dragging.current = true;
          setDraft(event.target.value);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-32 shrink-0 text-mono-xs text-fg-secondary text-right tabular-nums">
        {value === null ? "—" : value}
      </span>
    </div>
  );
}
