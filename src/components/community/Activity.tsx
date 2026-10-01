import { Info } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { useNow } from "../events/bits";
import { useEventFormat } from "../events/format";
import { offsetMinutes } from "../events/logic";
import { busiestHours, busiestValue, fewDays, levelOf, LEVELS, rotateHeatmap, type HourRun } from "./heatmap";
import { Panel, PanelHead } from "./bits";
import { formatCount } from "./format";
import type { CommunityActivity } from "./types";
import type { Remote } from "./useRemote";

/** The shades of a cell, empty first: the accent at the opacities of the design's B3. */
const SHADES = ["bg-accent/5", "bg-accent/15", "bg-accent/30", "bg-accent/55", "bg-accent/80", "bg-accent"] as const;

/** The hours the axis names. */
const AXIS = [0, 6, 12, 18];

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A wall clock in the reader's language, read off a moment in UTC: the hours of the map are already the reader's. */
function clock(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (found === undefined) {
    try {
      found = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    } catch {
      found = new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" });
    }
    formatters.set(key, found);
  }
  return found;
}

/** 5 January 2026 is a Monday: the hour `hour` of the day `day` of a week from it. */
function wall(day: number, hour: number): Date {
  return new Date(Date.UTC(2026, 0, 5 + day, hour));
}

/**
 * `19:00–23:00`, `7:00 – 11:00 PM`: a run of hours in the reader's clock.
 * A run within one day is the language's own range; one that ends at
 * midnight or past it is its two ends joined by `join`, since a range
 * across two days would name both dates.
 */
function runText(locale: string, run: HourRun, join: (from: string, to: string) => string): string {
  const start = wall(0, run.from);
  const end = new Date(start.getTime() + run.hours * 3_600_000);
  const format = clock(locale, { hour: "numeric", minute: "2-digit" }) as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
  if (run.from + run.hours < 24 && typeof format.formatRange === "function") {
    try {
      return format.formatRange(start, end);
    } catch {
      // An engine without ranges: the two ends.
    }
  }
  return join(format.format(start), format.format(end));
}

/**
 * **When people play here** of the overview: the busiest hours and the peak
 * of the last four weeks above a map of the week — seven rows from Monday,
 * 24 hours each, in the reader's own time — shaded by the average people on
 * the community's servers, with the legend under it.
 *
 * The service counts in UTC; the map is turned into the reader's zone
 * (`rotateHeatmap`). While the service has sampled fewer than seven days
 * the card says the map knows little yet, and before the first sample it
 * says so instead of drawing an empty map.
 */
export function ActivityPanel({ remote }: { remote: Remote<CommunityActivity | null> }) {
  const { t } = useTranslation("community");
  const { t: tEvents } = useTranslation("events");
  const join = (from: string, to: string) => tEvents("format.hours", { from, to });
  const format = useEventFormat();
  const now = useNow(60_000);
  const activity = remote.data;
  const offset = offsetMinutes(now, format.zone);
  const rows = useMemo(() => (activity ? rotateHeatmap(activity.heatmap, offset) : []), [activity, offset]);
  if (!activity) return null;

  const locale = format.locale;
  const most = busiestValue(rows);
  const run = busiestHours(rows);
  const days = activity.days;
  const empty = days <= 0 || most <= 0;
  const peakAt = activity.peak ? Date.parse(activity.peak.at) : Number.NaN;
  const peakWhen = Number.isFinite(peakAt)
    ? clock(locale, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(peakAt + offsetMinutes(peakAt, format.zone) * 60_000))
    : null;
  const dayName = (day: number) => clock(locale, { weekday: "short" }).format(wall(day, 12));
  const hourName = (hour: number) => clock(locale, { hour: "numeric" }).format(wall(0, hour));
  const cellTitle = (day: number, hour: number, value: number) =>
    t("activity.cell", {
      day: dayName(day),
      hours: runText(locale, { from: hour, to: (hour + 1) % 24, hours: 1 }, join),
      people: value > 0 ? t("activity.people", { count: Math.max(1, Math.round(value)), value: formatCount(Math.round(value * 10) / 10, locale) }) : t("activity.nobody"),
    });
  const summary = [
    run ? t("activity.ariaBusiest", { hours: runText(locale, run, join) }) : null,
    activity.peak && peakWhen ? t("activity.ariaPeak", { count: activity.peak.humans, when: peakWhen }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return (
    <Panel labelledBy="community-activity">
      <PanelHead
        id="community-activity"
        title={t("activity.title")}
        end={<span className="text-body-sm text-fg-secondary">{t("activity.note", { offset: format.offset(now) })}</span>}
      />
      {run || (activity.peak && peakWhen) ? (
        <dl className="flex flex-wrap items-baseline gap-x-24 gap-y-4">
          {run ? <Figure value={runText(locale, run, join)} label={t("activity.busiest")} /> : null}
          {activity.peak && peakWhen ? (
            <Figure value={formatCount(activity.peak.humans, locale)} label={t("activity.peak", { when: peakWhen })} />
          ) : null}
        </dl>
      ) : null}

      {fewDays(days) ? (
        <p className="flex items-start gap-8 text-body-sm text-fg-secondary">
          <Info size={16} className="mt-1 shrink-0 text-fg-muted" aria-hidden="true" />
          <span>{days <= 0 ? t("activity.noData") : t("activity.fewDays", { count: days })}</span>
        </p>
      ) : null}

      {empty ? null : (
        <div className="flex flex-col gap-3" role="img" aria-label={t("activity.aria", { summary })}>
          {rows.map((row, day) => (
            <div key={day} className="grid grid-cols-[28px_repeat(24,minmax(0,1fr))] items-center gap-3" aria-hidden="true">
              <span className="truncate text-[11px] leading-[14px] font-medium text-fg-secondary">{dayName(day)}</span>
              {row.map((value, hour) => (
                <span key={hour} title={cellTitle(day, hour, value)} className={cn("h-14 rounded-[3px]", SHADES[levelOf(value, most)])} />
              ))}
            </div>
          ))}
          <div className="grid grid-cols-[28px_repeat(24,minmax(0,1fr))] items-start gap-3" aria-hidden="true">
            <span />
            {AXIS.map((hour) => (
              <span key={hour} className="col-span-6 text-mono-xs whitespace-nowrap text-fg-secondary">
                {hourName(hour)}
              </span>
            ))}
            {run ? <BusiestMark run={run} /> : null}
          </div>
        </div>
      )}

      {empty ? null : (
        <div className="flex flex-wrap items-center gap-6 text-body-sm text-fg-secondary" aria-hidden="true">
          <span>{t("activity.less")}</span>
          {Array.from({ length: LEVELS }, (_, index) => (
            <span key={index} className={cn("size-14 rounded-[3px]", SHADES[index + 1])} />
          ))}
          <span>{t("activity.more")}</span>
          {run ? (
            <span className="ml-auto inline-flex items-center gap-6 font-medium text-fg">
              <span className="h-2 w-14 rounded-full bg-accent" />
              {t("activity.busiestLegend", { hours: runText(locale, run, join) })}
            </span>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** A number of the summary with what it counts after it. */
function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="inline-flex min-w-0 flex-row-reverse items-baseline gap-6">
      <dt className="text-body-sm text-fg-secondary">{label}</dt>
      <dd className="font-display text-[16px] leading-[20px] font-semibold tabular-nums text-fg">{value}</dd>
    </div>
  );
}

/** The bar under the axis that marks the busiest hours; a run across midnight draws two. */
function BusiestMark({ run }: { run: HourRun }) {
  const parts = run.from + run.hours <= 24 ? [[run.from, run.hours]] : [[run.from, 24 - run.from], [0, run.from + run.hours - 24]];
  return (
    <>
      {parts.map(([from, length]) => (
        <span
          key={from}
          className="row-start-2 h-2 self-center rounded-full bg-accent"
          style={{ gridColumn: `${from + 2} / span ${length}` }}
        />
      ))}
    </>
  );
}
