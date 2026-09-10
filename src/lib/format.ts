/**
 * Small formatting helpers shared by the screens.
 *
 * --- slice: i18n ---
 * Everything that produces a number, a date or a size for a player to read
 * takes a locale. A thousands separator, a decimal comma, the order of a date
 * and the name of a unit all differ between the eight languages, and hard-coded
 * `toLocaleString("en-US")` printed `12,345` on a screen whose next line said
 * «12 345».
 *
 * The unit names themselves live in the `common` catalog rather than in
 * `Intl`: `Intl.NumberFormat` with `style: "unit"` renders 512 bytes as
 * «512 byte» in English, which is not what a table column wants. So the number
 * goes through `Intl` and the pattern around it goes through `t`. The binding
 * of the two is `useFormat` in `src/i18n/useFormat.ts`; the functions here are
 * pure and can be read without React.
 */

/** Joins class names and drops the falsy ones. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The four sizes a byte count is printed in. Keys of `common.units.bytes`. */
export type ByteUnit = "b" | "kb" | "mb" | "gb";

/** A byte count split into the number to print and the unit to print it in. */
export interface ByteParts {
  unit: ByteUnit;
  value: number;
  /** Digits after the decimal point: none below a kilobyte or above 100. */
  digits: number;
}

const BYTE_UNITS: ByteUnit[] = ["b", "kb", "mb", "gb"];

/**
 * Splits a byte count the way a download dialog would.
 *
 * `null` for a count that is not there, which is the caller's cue to print the
 * em dash of `common.values.empty` rather than «0 B».
 */
export function splitBytes(bytes: number | null | undefined): ByteParts | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return {
    unit: BYTE_UNITS[unit],
    value,
    digits: unit === 0 || value >= 100 ? 0 : 1,
  };
}

/** The three units an age or a duration is rounded to. */
export type TimeUnit = "seconds" | "minutes" | "hours";

export interface TimeParts {
  unit: TimeUnit;
  value: number;
}

/**
 * Rounds an age down to one unit: seconds, then minutes, then hours.
 *
 * One unit rather than two, because the value stands in a subtitle that is
 * already long: «refreshed 2 h ago» answers the question «is this list stale»
 * as well as «2 h 14 min» does.
 */
export function splitAge(seconds: number): TimeParts {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return { unit: "seconds", value: safe };
  const minutes = Math.floor(safe / 60);
  if (minutes < 60) return { unit: "minutes", value: minutes };
  return { unit: "hours", value: Math.floor(minutes / 60) };
}

/** How long a game has been up: hours and minutes once it passes an hour. */
export interface ElapsedParts {
  hours: number;
  minutes: number;
  seconds: number;
}

/** Splits a running time into the three fields the Home hero prints. */
export function splitElapsed(seconds: number): ElapsedParts {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
    seconds: safe % 60,
  };
}

/** A number in the player's language: `12 345`, `12,345`, `12.345`. */
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** A ratio as a percentage: `42%`, `42 %`. */
export function formatPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(ratio);
}

/**
 * A date in the player's language, or `null` when the string is not one.
 *
 * `medium` on purpose: `2 Sep 2026` is unambiguous in every language the
 * launcher speaks, while a numeric date reads as the wrong month somewhere.
 */
export function formatDate(
  value: string | null | undefined,
  locale: string,
): string | null {
  if (!value) return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(when);
}

/** Shortens a long path so the middle disappears instead of the file name. */
export function shortenPath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const tail = path.slice(-(max - 4));
  return `...${tail}`;
}
