/**
 * Numbers, sizes, dates and durations in the language on screen.
 *
 * One hook rather than a helper per screen, because every one of these needs
 * two things at once: the active locale, which `Intl` wants, and the `common`
 * catalog, which owns the unit patterns. A component that reached for
 * `Intl` directly would silently keep printing English separators after a
 * language switch — the switch changes `i18n.language`, and nothing re-renders
 * a module-level formatter.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  formatDate,
  formatNumber,
  formatPercent,
  splitAge,
  splitBytes,
  splitElapsed,
} from "../lib/format";
import { FALLBACK_LANGUAGE } from "./languages";

export interface Formatters {
  /** The BCP 47 tag every `Intl` call in the app runs on. */
  locale: string;
  /** `12.4 MB`, `12,4 МБ`. An absent count gives the em dash. */
  bytes: (bytes: number | null | undefined) => string;
  /** A plain number with the language's own separators. */
  number: (value: number) => string;
  /** `42%`, `42 %`. */
  percent: (ratio: number) => string;
  /** A medium date, or the raw string when it is not a date. */
  date: (value: string | null | undefined) => string;
  /** How long ago something happened, rounded to one unit: `12 s`, `3 min`. */
  age: (seconds: number) => string;
  /** How long something has been running: `2 h 14 min`, `45 s`. */
  elapsed: (seconds: number) => string;
  /** A round trip time: `48 ms`. */
  milliseconds: (value: number) => string;
}

/** The active locale, without the rest of the formatters. */
export function useLocale(): string {
  const { i18n } = useTranslation();
  return i18n.language || FALLBACK_LANGUAGE;
}

export function useFormat(): Formatters {
  const { t, i18n } = useTranslation("common");
  const locale = i18n.language || FALLBACK_LANGUAGE;

  return useMemo<Formatters>(
    () => ({
      locale,

      bytes: (bytes) => {
        const parts = splitBytes(bytes);
        if (parts === null) return t("values.empty");
        return t(`units.bytes.${parts.unit}`, {
          value: formatNumber(parts.value, locale, {
            minimumFractionDigits: parts.digits,
            maximumFractionDigits: parts.digits,
          }),
        });
      },

      number: (value) => formatNumber(value, locale),

      percent: (ratio) => formatPercent(ratio, locale),

      date: (value) => formatDate(value, locale) ?? value ?? t("values.unknown"),

      age: (seconds) => {
        const parts = splitAge(seconds);
        return t(`units.${parts.unit}`, {
          value: formatNumber(parts.value, locale),
        });
      },

      elapsed: (seconds) => {
        const parts = splitElapsed(seconds);
        if (parts.hours > 0) {
          return t("units.hoursMinutes", {
            hours: formatNumber(parts.hours, locale),
            minutes: formatNumber(parts.minutes, locale),
          });
        }
        if (parts.minutes > 0) {
          return t("units.minutes", { value: formatNumber(parts.minutes, locale) });
        }
        return t("units.seconds", { value: formatNumber(parts.seconds, locale) });
      },

      milliseconds: (value) =>
        t("units.milliseconds", { value: formatNumber(value, locale) }),
    }),
    [locale, t],
  );
}
