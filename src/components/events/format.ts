/**
 * Dates, times and durations of events in the reader's language and time
 * zone.
 *
 * Every string goes through `Intl` with the language of the `events`
 * catalog, so the order of the day and the month, the names of weekdays and
 * the 12- or 24-hour clock are the language's own. The words around them —
 * «in 3 days 2 hours», «today» — come from the `events` catalog, the one
 * namespace the three hosts load for these screens.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { countdown, DAY, formatOffset, offsetMinutes, parseDay, wallClock, type Month } from "./logic";
import { useTimeZone } from "./platform";

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (found === undefined) {
    try {
      found = new Intl.DateTimeFormat(locale, options);
    } catch {
      found = new Intl.DateTimeFormat("en", options);
    }
    cache.set(key, found);
  }
  return found;
}

/** The first letter up, as a heading or a day of the panel starts: «Суббота, 3 октября». */
export function capitalize(text: string, locale: string): string {
  if (text === "") return text;
  const first = Array.from(text)[0];
  return first.toLocaleUpperCase(locale) + text.slice(first.length);
}

/** Noon of a calendar day in UTC: a day key formats the same in every zone from it. */
export function noonOf(key: string): number {
  const day = parseDay(key);
  return day === null ? 0 : Date.UTC(day.year, day.month - 1, day.day, 12);
}

export interface EventFormat {
  locale: string;
  /** The reader's time zone. */
  zone: string;
  /** `Sat, October 3`. */
  day: (instant: number) => string;
  /** `Saturday, October 3`, capitalized: the title of the day panel. */
  dayLong: (instant: number) => string;
  /** A day of the grid by its key, `Saturday, October 3`. */
  dayOfKey: (key: string) => string;
  /** `19:00`, `7:00 PM`; in `zone` when given. */
  time: (instant: number, zone?: string) => string;
  /** `Sat, October 3, 19:00`. */
  dayTime: (instant: number) => string;
  /** `Sat, October 3 · 19:00–22:00`; the day of the end too when it differs. */
  range: (startsAt: string, endsAt: string) => string;
  /** `19:00–22:00`. */
  hours: (startsAt: string, endsAt: string) => string;
  /** `October 2026`. */
  month: (month: Month) => string;
  /** `Mon` … `Sun`. */
  weekdays: string[];
  /** `Sat` of a moment. */
  weekday: (instant: number) => string;
  /** `Oct` of a moment. */
  monthShort: (instant: number) => string;
  /** The number of the day of a moment. */
  dayNumber: (instant: number) => number;
  /** `today`, `tomorrow`, `in 3 days`, `2 days ago`. */
  relativeDay: (instant: number, now: number) => string;
  /** The same between two day keys of the calendar, `YYYY-MM-DD`. */
  relativeKey: (key: string, today: string) => string;
  /** `3 days 2 hours`, `1 hour 30 minutes`, `5 minutes`. */
  duration: (milliseconds: number) => string;
  /** `UTC+3` of a zone at a moment. */
  offset: (instant: number, zone?: string) => string;
  /** A number with the language's separators. */
  number: (value: number) => string;
}

/** The formatters of the events screens in the language and the zone of the reader. */
export function useEventFormat(): EventFormat {
  const { t, i18n } = useTranslation("events");
  const locale = i18n.language || "en";
  const zone = useTimeZone();

  return useMemo<EventFormat>(() => {
    const at = (instant: number) => new Date(instant);
    const dayFormat = formatter(locale, { timeZone: zone, weekday: "short", day: "numeric", month: "long" });
    const dayLongFormat = formatter(locale, { timeZone: zone, weekday: "long", day: "numeric", month: "long" });
    const keyFormat = formatter(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
    const timeOf = (instant: number, inZone = zone) => formatter(locale, { timeZone: inZone, hour: "numeric", minute: "2-digit" }).format(at(instant));
    // `formatRange` writes the shared half once: `7:00 – 10:00 PM`, `19:00–22:00`.
    const timeRange = (start: number, end: number) => {
      const clock = formatter(locale, { timeZone: zone, hour: "numeric", minute: "2-digit" }) as Intl.DateTimeFormat & {
        formatRange?: (from: Date, to: Date) => string;
      };
      if (typeof clock.formatRange === "function") {
        try {
          return clock.formatRange(at(start), at(end));
        } catch {
          // An engine without ranges: the template below.
        }
      }
      return t("format.hours", { from: timeOf(start), to: timeOf(end) });
    };
    const sameDay = (a: number, b: number) => {
      const x = wallClock(a, zone);
      const y = wallClock(b - 1, zone);
      return x.year === y.year && x.month === y.month && x.day === y.day;
    };
    const weekdayFormat = formatter(locale, { timeZone: "UTC", weekday: "short" });
    // 5 January 2026 is a Monday.
    const weekdays = Array.from({ length: 7 }, (_, index) => weekdayFormat.format(new Date(Date.UTC(2026, 0, 5 + index, 12))));
    const unit = (count: number, key: "days" | "hours" | "minutes") =>
      t(`duration.${key}`, { count, value: new Intl.NumberFormat(locale).format(count) });

    return {
      locale,
      zone,
      day: (instant) => dayFormat.format(at(instant)),
      dayLong: (instant) => capitalize(dayLongFormat.format(at(instant)), locale),
      dayOfKey: (key) => capitalize(keyFormat.format(new Date(noonOf(key))), locale),
      time: timeOf,
      dayTime: (instant) => t("format.dayTime", { day: dayFormat.format(at(instant)), time: timeOf(instant) }),
      range: (startsAt, endsAt) => {
        const start = Date.parse(startsAt);
        const end = Date.parse(endsAt);
        if (sameDay(start, end)) return t("format.range", { day: dayFormat.format(at(start)), hours: timeRange(start, end) });
        return t("format.rangeDays", { day: dayFormat.format(at(start)), from: timeOf(start), endDay: dayFormat.format(at(end)), to: timeOf(end) });
      },
      hours: (startsAt, endsAt) => timeRange(Date.parse(startsAt), Date.parse(endsAt)),
      month: ({ year, month }) =>
        capitalize(formatter(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 15))), locale),
      weekdays,
      weekday: (instant) => formatter(locale, { timeZone: zone, weekday: "short" }).format(at(instant)),
      monthShort: (instant) => formatter(locale, { timeZone: zone, month: "short" }).format(at(instant)).replace(/\.$/, ""),
      dayNumber: (instant) => wallClock(instant, zone).day,
      relativeDay: (instant, now) => {
        const day = (value: number) => {
          const wall = wallClock(value, zone);
          return Date.UTC(wall.year, wall.month - 1, wall.day);
        };
        const diff = Math.round((day(instant) - day(now)) / DAY);
        try {
          return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(diff, "day");
        } catch {
          return String(diff);
        }
      },
      relativeKey: (key, todayKey) => {
        const diff = Math.round((noonOf(key) - noonOf(todayKey)) / DAY);
        try {
          return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(diff, "day");
        } catch {
          return String(diff);
        }
      },
      duration: (milliseconds) => {
        const left = countdown(milliseconds, 0);
        if (left.days > 0) return left.hours > 0 ? t("duration.pair", { first: unit(left.days, "days"), second: unit(left.hours, "hours") }) : unit(left.days, "days");
        if (left.hours > 0) return left.minutes > 0 ? t("duration.pair", { first: unit(left.hours, "hours"), second: unit(left.minutes, "minutes") }) : unit(left.hours, "hours");
        return unit(Math.max(1, left.minutes), "minutes");
      },
      offset: (instant, inZone = zone) => formatOffset(offsetMinutes(instant, inZone)),
      number: (value) => new Intl.NumberFormat(locale).format(value),
    };
  }, [locale, zone, t]);
}
