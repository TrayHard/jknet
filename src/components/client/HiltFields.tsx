import type { UseQueryResult } from "@tanstack/react-query";
import { Ban, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import {
  NO_SECOND_HILT,
  SABER_BLADE_RGB,
  SABER_COLORS,
  type SaberHilt,
} from "../../lib/ipc";
import {
  SABER_MODES,
  hasSecondBlade,
  hiltsForMode,
  saberModeOf,
  saberValuesFor,
  type SaberMode,
  type SaberValues,
} from "../../lib/sabers";
import { Button, Select, type SelectOption, type SelectSize } from "../ui";

// --- slice: skins and hilts ---

/**
 * What a player carries into the game: the shape of the saber, the hilts and
 * the colour of each blade.
 *
 * One control and not four fields, because the four are not independent. A
 * `color2` over an empty `saber2` paints nothing; a staff in `saber1` with a
 * second hilt beside it is not a staff any more. The player picks a shape —
 * **Single**, **Staff** or **Duals** — and the shape decides how many hilts
 * there are to name and how many colours there are to pick.
 *
 * The shape itself is not a field of the profile. It is read back out of the
 * four values, exactly as the game's own menu reads it: see the module notes
 * in `src/lib/sabers.ts` for what the engine does and where.
 *
 * The same control stands in the client window and in the **Connect…**
 * dialog; `size` is the only difference between them.
 */
export function HiltFields({
  values,
  hilts,
  hasHilts,
  size,
  onChange,
}: {
  values: SaberValues;
  /** The query itself, so the control draws reading, failed and empty. */
  hilts: UseQueryResult<SaberHilt[]>;
  /**
   * Whether this game has hilt data at all. Jedi Outcast ships no
   * `ext_data/sabers/`, so there is no hilt to name and no shape to pick —
   * but the two blade colours are cvars of that game as well, and the profile
   * still manages them.
   */
  hasHilts: boolean;
  size?: SelectSize;
  onChange: (values: SaberValues) => void;
}) {
  const { t } = useTranslation("clients");
  const found = hilts.data ?? [];

  // The shape is state and not a pure reading of the values, because the two
  // disagree for as long as it takes to pick a hilt: **Staff** with nothing
  // named yet reads as **Single**, and a control that snapped back on the
  // click that set it would be unusable. It is re-seeded until the player
  // touches it — which is what carries a stored staff profile from **Single**
  // to **Staff** the moment the hilt list arrives and its shapes are known.
  const derived = saberModeOf(values, found);
  const [mode, setMode] = useState<SaberMode>(derived);
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    setMode(derived);
  }, [derived]);

  const edit = (next: SaberValues, to: SaberMode = mode) =>
    onChange(saberValuesFor(to, next, found));

  if (!hasHilts) {
    return (
      <div className="flex flex-col gap-8">
        <ColorRow
          label={t("clientWindow.profiles.form.color1")}
          value={values.color1}
          size={size}
          onChange={(color1) => onChange({ ...values, color1 })}
        />
        <ColorRow
          label={t("clientWindow.profiles.form.color2")}
          value={values.color2}
          size={size}
          onChange={(color2) => onChange({ ...values, color2 })}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <ModeSwitch
        mode={mode}
        size={size}
        onSelect={(next) => {
          touched.current = true;
          setMode(next);
          edit(values, next);
        }}
      />

      <HandRow
        hiltLabel={t("clientWindow.profiles.form.saber1")}
        colorLabel={t("clientWindow.profiles.form.color1")}
        hilt={values.saber1}
        hilts={hiltsForMode(mode, found)}
        color={values.color1}
        size={size}
        onHilt={(saber1) => edit({ ...values, saber1 })}
        onColor={(color1) => edit({ ...values, color1 })}
      />

      {/* Two hilts are two hilts, and the engine colours by hilt: a staff has
          two blades of one colour, so there is no second row to draw for it.
          See `CG_AddSaberBlade` in the notes of `src/lib/sabers.ts`. */}
      {hasSecondBlade(mode) ? (
        <HandRow
          hiltLabel={t("clientWindow.profiles.form.saber2")}
          colorLabel={t("clientWindow.profiles.form.color2")}
          hilt={values.saber2}
          hilts={hiltsForMode(mode, found)}
          color={values.color2}
          size={size}
          extra={[
            {
              value: NO_SECOND_HILT,
              label: t("clientWindow.profiles.form.saber2None"),
            },
          ]}
          onHilt={(saber2) => edit({ ...values, saber2 })}
          onColor={(color2) => edit({ ...values, color2 })}
        />
      ) : null}

      <HiltsNotice hilts={hilts} />
    </div>
  );
}

/** The three shapes, as one row of buttons that behaves like a radio group. */
function ModeSwitch({
  mode,
  size,
  onSelect,
}: {
  mode: SaberMode;
  size?: SelectSize;
  onSelect: (mode: SaberMode) => void;
}) {
  const { t } = useTranslation("clients");
  const labels: Record<SaberMode, string> = {
    single: t("clientWindow.profiles.saberModes.single"),
    staff: t("clientWindow.profiles.saberModes.staff"),
    duals: t("clientWindow.profiles.saberModes.duals"),
  };

  return (
    <div
      role="radiogroup"
      aria-label={t("clientWindow.profiles.saberModes.label")}
      className={cn(
        "inline-flex w-fit gap-2 p-2 rounded-md select-none",
        "border border-line bg-input",
      )}
    >
      {SABER_MODES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          role="radio"
          aria-checked={mode === candidate}
          onClick={() => onSelect(candidate)}
          className={cn(
            "px-12 rounded-sm text-body-sm transition-colors duration-150",
            size === "sm" ? "h-24" : "h-28",
            mode === candidate
              ? "bg-accent-subtle text-fg border border-line-accent"
              : "border border-transparent text-fg-secondary hover:bg-hover-overlay",
          )}
        >
          {labels[candidate]}
        </button>
      ))}
    </div>
  );
}

/** One hand: the hilt it holds and the colour of what comes out of it. */
function HandRow({
  hiltLabel,
  colorLabel,
  hilt,
  hilts,
  color,
  size,
  extra,
  onHilt,
  onColor,
}: {
  hiltLabel: string;
  colorLabel: string;
  hilt: string | null;
  hilts: SaberHilt[];
  color: number | null;
  size?: SelectSize;
  extra?: SelectOption[];
  onHilt: (value: string | null) => void;
  onColor: (value: number | null) => void;
}) {
  return (
    <div className="flex items-end gap-8 flex-wrap">
      <div className="flex-1 min-w-160 flex flex-col gap-4">
        <span className="text-label-xs text-fg-muted">{hiltLabel}</span>
        <HiltSelect
          value={hilt}
          hilts={hilts}
          label={hiltLabel}
          size={size}
          extra={extra}
          onChange={onHilt}
        />
      </div>
      <ColorRow label={colorLabel} value={color} size={size} onChange={onColor} />
    </div>
  );
}

/** The caption of a blade colour and its swatches. */
function ColorRow({
  label,
  value,
  size,
  onChange,
}: {
  label: string;
  value: number | null;
  size?: SelectSize;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="shrink-0 flex flex-col gap-4">
      <span className="text-label-xs text-fg-muted">{label}</span>
      <ColorSwatches label={label} value={value} size={size} onChange={onChange} />
    </div>
  );
}

/**
 * The catalog key of each blade colour, by the number the cvar takes.
 *
 * A table of literals rather than a key built at run time, so a renamed key
 * fails `npm run typecheck` instead of printing itself on the screen. The
 * index is the value of `color1`, which is `saber_colors_t` of the engine.
 */
const SABER_COLOR_KEYS = [
  "clientWindow.profiles.saberColors.0",
  "clientWindow.profiles.saberColors.1",
  "clientWindow.profiles.saberColors.2",
  "clientWindow.profiles.saberColors.3",
  "clientWindow.profiles.saberColors.4",
  "clientWindow.profiles.saberColors.5",
] as const;

/**
 * The six blade colours, each wearing the colour it names, plus the way back
 * to «not set».
 *
 * Swatches and not a list, for two reasons. The row sits beside the hilt on
 * one line and a second dropdown there would have been two triggers of the
 * same width saying different kinds of thing; and a colour is the one value
 * that shows itself — `SABER_BLADE_RGB` is the engine's own table, so what the
 * player presses is what the blade will be.
 */
function ColorSwatches({
  label,
  value,
  size,
  onChange,
}: {
  label: string;
  value: number | null;
  size?: SelectSize;
  onChange: (value: number | null) => void;
}) {
  const { t } = useTranslation("clients");
  const box = size === "sm" ? "size-20" : "size-24";
  const none = t("clientWindow.notSet");

  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-4">
      <Swatch
        checked={value === null}
        title={none}
        box={box}
        onSelect={() => onChange(null)}
      >
        <Ban size={size === "sm" ? 10 : 12} className="text-fg-muted" aria-hidden />
      </Swatch>
      {SABER_COLORS.map((_, index) => (
        <Swatch
          key={index}
          checked={value === index}
          title={t(SABER_COLOR_KEYS[index])}
          box={box}
          color={SABER_BLADE_RGB[index]}
          onSelect={() => onChange(index)}
        />
      ))}
    </div>
  );
}

/** One square of the colour row. */
function Swatch({
  checked,
  title,
  box,
  color,
  children,
  onSelect,
}: {
  checked: boolean;
  title: string;
  box: string;
  color?: string;
  children?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={title}
      title={title}
      onClick={onSelect}
      style={color === undefined ? undefined : { backgroundColor: color }}
      className={cn(
        "flex items-center justify-center rounded-sm border transition-colors duration-150",
        box,
        color === undefined ? "bg-input" : undefined,
        // The ring and not a border colour: a border that changed colour would
        // be invisible against the swatch it surrounds.
        checked
          ? "border-line-focus outline-2 outline-offset-1 outline-line-focus"
          : "border-line hover:border-line-strong",
      )}
    >
      {children}
    </button>
  );
}

/**
 * One hilt list, with «Not set» in front and whatever else the caller adds.
 *
 * --- slice: connect dialog ---
 * The list a player learns in the client window is the list they meet again
 * before joining a server.
 */
export function HiltSelect({
  value,
  hilts,
  label,
  extra = [],
  size,
  onChange,
}: {
  value: string | null;
  hilts: SaberHilt[];
  label: string;
  extra?: SelectOption[];
  size?: SelectSize;
  onChange: (value: string | null) => void;
}) {
  const { t } = useTranslation("clients");
  const shape = (hilt: SaberHilt) => {
    if (hilt.saberType === "single") {
      return t("clientWindow.profiles.saberTypes.single");
    }
    if (hilt.saberType === "staff") {
      return t("clientWindow.profiles.saberTypes.staff");
    }
    // The dozen shapes only story sabers use have no word of their own: the
    // value of `saberType` is what the file says and what a mod author reads.
    return hilt.saberType;
  };
  // «Not set» is an option and not only the placeholder: a list whose empty
  // state is unreachable would let a player pick a hilt and never take it
  // back, and the profile would go on writing a cvar they no longer want.
  const options: SelectOption[] = [
    { value: "", label: t("clientWindow.notSet") },
    ...extra,
    ...hilts.map((hilt) => ({
      value: hilt.id,
      label: `${hilt.name} · ${shape(hilt)}`,
    })),
  ];
  // A hilt a mod once provided and no longer does still stands in the profile,
  // so it keeps a place of its own: dropping it would show the list as empty
  // over a cvar that is set, and the next change would silently be a second one.
  if (value !== null && !options.some((option) => option.value === value)) {
    options.push({ value, label: value });
  }

  return (
    <Select
      value={value ?? ""}
      options={options}
      ariaLabel={label}
      size={size}
      placeholder={t("clientWindow.notSet")}
      onChange={(next) => onChange(next === "" ? null : next)}
    />
  );
}

/**
 * What the hilt list is doing, when it is not simply a list.
 *
 * --- slice: profiles polish ---
 * The skin grid owns its query and draws three states of it — reading,
 * failed, and genuinely empty. The hilt lists were handed `hilts.data ?? []`
 * and drew one: two `Select`s holding **Not set** and nothing else. A refused
 * `list_saber_hilts` and an archive with no hilt in it looked exactly alike,
 * and because the query is `retry: false` with `staleTime: Infinity`, the
 * first refusal was the last word until the window was reopened. That is the
 * whole of the report «the skins are there and the hilts are not», the other
 * half being the archive scan that used to give up on its first bad entry.
 *
 * So the same three states, and a way out of the third: **Try again** refetches
 * rather than asking the player to close the window.
 */
export function HiltsNotice({ hilts }: { hilts: UseQueryResult<SaberHilt[]> }) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();

  if (hilts.error) {
    return (
      <div
        role="alert"
        className="flex items-center gap-8 flex-wrap text-body-sm text-fg-danger"
      >
        <span className="break-words">{errorText(hilts.error)}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={14} />}
          disabled={hilts.isFetching}
          onClick={() => void hilts.refetch()}
        >
          {t("clientWindow.profiles.form.saberRetry")}
        </Button>
      </div>
    );
  }
  if (hilts.isLoading) {
    return (
      <p className="flex items-center gap-8 text-body-sm text-fg-muted">
        <Loader2 size={14} className="text-fg-accent animate-spin shrink-0" />
        {t("clientWindow.profiles.form.saberLoading")}
      </p>
    );
  }
  if ((hilts.data ?? []).length === 0) {
    return (
      <p className="text-body-sm text-fg-muted">
        {t("clientWindow.profiles.form.saberEmpty")}
      </p>
    );
  }
  return null;
}
