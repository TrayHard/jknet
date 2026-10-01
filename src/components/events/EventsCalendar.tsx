/**
 * **Events**: the calendar of the design's D1. A month on a grid, Monday
 * first, or the same month as an agenda; the filters **All**, **Following**
 * and **I'm going**; the selected day's events beside the grid, each with
 * its answer and **Open event**.
 *
 * The events of a community wear the community's hue, and the reader's
 * «going» events a warm outline and a check. The launcher shows the events
 * of the game of its switch; the website and the web app show both games.
 *
 * One month is three reads of the calendar while the reader is signed in —
 * every event of the catalogue, the communities they follow and their
 * «going» answers — so the counts of the filters are exact; a guest reads
 * the first only.
 */

import { CalendarDays, Check, ChevronLeft, ChevronRight, List, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Button, Menu } from "../ui";
import { Failure, hueStyle } from "../community/bits";
import { communityApi } from "../community/api";
import { useCommunityPlatform } from "../community/platform";
import { useRemote } from "../community/useRemote";
import { useNow } from "./bits";
import { DayPanelCard, EventRow } from "./EventItems";
import { useEventFormat } from "./format";
import {
  addMonths,
  byStart,
  dayKey,
  eventDays,
  eventsByDay,
  gridRange,
  monthGrid,
  monthOf,
  type Month,
} from "./logic";
import { useEventsApi, useEventsPlatform } from "./platform";
import type { EventCard } from "./types";
import { useAnswer } from "./useAnswer";

export type CalendarScope = "all" | "following" | "going";
export type CalendarView = "month" | "list";

const SCOPES: CalendarScope[] = ["all", "following", "going"];

/** The three reads of a month, merged: every event once, and which lists hold it. */
interface MonthEvents {
  events: EventCard[];
  following: Set<string>;
  going: Set<string>;
}

export function EventsCalendar({
  compact = false,
  initialView = "month",
}: {
  /** A pane of the web app: the agenda only, without the grid. */
  compact?: boolean;
  initialView?: CalendarView;
}) {
  const { t } = useTranslation("events");
  const platform = useCommunityPlatform();
  const events = useEventsPlatform();
  const api = useEventsApi();
  const format = useEventFormat();
  const now = useNow(60_000);
  const zone = format.zone;
  const signedIn = platform.signedIn;
  const account = signedIn ? platform.accountId ?? "account" : "guest";
  const game = platform.game;

  const today = dayKey(now, zone);
  const [month, setMonth] = useState<Month>(() => monthOf(today));
  const [view, setView] = useState<CalendarView>(compact ? "list" : initialView);
  const [scope, setScope] = useState<CalendarScope>("all");
  const [selected, setSelected] = useState<string | null>(today);
  const range = gridRange(month, zone);
  const shownScope: CalendarScope = signedIn ? scope : "all";

  const remote = useRemote<MonthEvents>(`events:${account}:${game ?? "*"}:${range.from}:${range.to}`, async () => {
    const base = { from: range.from, to: range.to, game: game ?? null };
    if (!signedIn) {
      const all = await api.calendar({ ...base, scope: "all" });
      return { events: all.events, following: new Set(), going: new Set() };
    }
    const [all, following, going] = await Promise.all([
      api.calendar({ ...base, scope: "all" }),
      api.calendar({ ...base, scope: "following" }),
      api.calendar({ ...base, scope: "going" }),
    ]);
    const byId = new Map<string, EventCard>();
    for (const event of [...all.events, ...following.events, ...going.events]) byId.set(event.id, event);
    return {
      events: [...byId.values()].sort(byStart),
      following: new Set(following.events.map((event) => event.id)),
      going: new Set(going.events.map((event) => event.id)),
    };
  });

  const { busyId, error, answer } = useAnswer((next) =>
    remote.set((current) => {
      if (!current) return current;
      const going = new Set(current.going);
      if (next.viewer?.rsvp === "going") going.add(next.id);
      else going.delete(next.id);
      return { ...current, events: current.events.map((event) => (event.id === next.id ? next : event)), going };
    }),
  );

  // Organizers create events from here: the communities the reader runs.
  const me = useRemote(signedIn && platform.canManage ? `events-me:${account}` : null, () => communityApi(platform.request).me());
  const organized = (me.data?.communities ?? []).filter((community) => community.role !== null);

  const grid = useMemo(() => monthGrid(month), [month]);
  const monthPrefix = `${month.year}-${String(month.month).padStart(2, "0")}`;
  const data = remote.data;
  const inScope = (event: EventCard, which: CalendarScope) =>
    which === "all" ? true : which === "following" ? data?.following.has(event.id) ?? false : data?.going.has(event.id) ?? false;
  const inMonth = (event: EventCard) => eventDays(event.startsAt, event.endsAt, zone).some((day) => day.startsWith(monthPrefix));
  const monthEvents = (data?.events ?? []).filter(inMonth);
  const shown = monthEvents.filter((event) => inScope(event, shownScope));
  // The grid shows the days of the months around too, with their events: the read covers all 42 days.
  const gridShown = (data?.events ?? []).filter((event) => inScope(event, shownScope));
  const byDay = useMemo(() => eventsByDay(gridShown, zone), [gridShown, zone]);
  const countOf = (which: CalendarScope) => monthEvents.filter((event) => inScope(event, which)).length;

  // A month opened without its selected day picks today, or its first day with events.
  useEffect(() => {
    if (!data) return;
    if (selected !== null && selected.startsWith(monthPrefix)) return;
    if (today.startsWith(monthPrefix)) {
      setSelected(today);
      return;
    }
    const first = [...byDay.keys()].filter((day) => day.startsWith(monthPrefix)).sort()[0] ?? null;
    setSelected(first);
    // `byDay` follows `data`; a new month or a new filter is what asks again.
  }, [data, monthPrefix]);

  const go = (delta: number) => {
    setMonth((current) => addMonths(current, delta));
    setSelected(null);
  };
  const goToday = () => {
    setMonth(monthOf(today));
    setSelected(today);
  };

  const selectedEvents = selected ? byDay.get(selected) ?? [] : [];
  const next = gridShown.filter((event) => Date.parse(event.endsAt) > now && (selected === null || dayKey(Date.parse(event.startsAt), zone) > selected)).sort(byStart)[0] ?? null;
  const monthEmpty = data !== undefined && monthEvents.length === 0;
  const filterEmpty = data !== undefined && !monthEmpty && shown.length === 0;
  const monthName = format.month(month);

  const empty = monthEmpty || filterEmpty ? (
    <div role="status" className="flex flex-col items-center gap-8 px-24 py-20 text-center">
      <span className="flex size-40 items-center justify-center rounded-full bg-surface text-fg-secondary" aria-hidden="true">
        <CalendarDays size={20} />
      </span>
      <p className="text-heading-sm text-fg">
        {monthEmpty ? t("calendar.emptyMonthTitle", { month: monthName }) : t(shownScope === "going" ? "calendar.emptyGoingTitle" : "calendar.emptyFollowingTitle", { month: monthName })}
      </p>
      <p className="max-w-[44ch] text-body-sm text-fg-secondary">
        {monthEmpty ? t("calendar.emptyMonthText") : t(shownScope === "going" ? "calendar.emptyGoingText" : "calendar.emptyFollowingText")}
      </p>
      {filterEmpty ? (
        <Button size="sm" wrap onClick={() => setScope("all")}>
          {t("calendar.showAll")}
        </Button>
      ) : (
        <Button size="sm" wrap onClick={() => platform.navigate({ view: "catalog", tab: "catalog" })}>
          {t("calendar.openCatalog")}
        </Button>
      )}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-16">
      {compact || platform.embedded ? null : (
        <div className="flex flex-wrap items-end justify-between gap-16">
          <div className="flex min-w-0 flex-col gap-4">
            <h1 className="text-display-lg text-fg">{t("title")}</h1>
            <p className="text-body-md text-fg-secondary">
              {t("subtitle", { zone, offset: format.offset(now) })}
            </p>
          </div>
          {organized.length === 1 ? (
            <Button variant="primary" wrap icon={<Plus size={16} />} onClick={() => events.navigate({ view: "new", communityId: organized[0].id })}>
              {t("calendar.create")}
            </Button>
          ) : organized.length > 1 ? (
            <div className="flex items-center gap-8">
              <span className="text-body-sm-medium text-fg-secondary">{t("calendar.create")}</span>
              <Menu
                ariaLabel={t("calendar.createIn")}
                items={organized.map((community) => ({ id: community.id, label: community.name }))}
                onSelect={(id) => events.navigate({ view: "new", communityId: id })}
              />
            </div>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-16 gap-y-12">
        {/* On a phone **Today** goes under the month rather than past the edge. */}
        <div className="flex flex-wrap items-center gap-8">
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label={t("calendar.previous")}
            title={t("calendar.previous")}
            className="flex size-32 cursor-pointer items-center justify-center rounded-sm border border-line bg-surface text-fg-secondary select-none hover:bg-surface-hover hover:text-fg pointer-coarse:size-44"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label={t("calendar.next")}
            title={t("calendar.next")}
            className="flex size-32 cursor-pointer items-center justify-center rounded-sm border border-line bg-surface text-fg-secondary select-none hover:bg-surface-hover hover:text-fg pointer-coarse:size-44"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <h2 aria-live="polite" className="min-w-[148px] px-8 text-heading-md text-fg">
            {monthName}
          </h2>
          <Button size="sm" wrap onClick={goToday}>
            {t("calendar.today")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-12">
          <Segmented
            label={t("filters.label")}
            options={SCOPES.map((id) => ({
              id,
              label: t(`filters.${id}`),
              count: data && (signedIn || id === "all") ? countOf(id) : undefined,
              disabled: !signedIn && id !== "all",
              title: !signedIn && id !== "all" ? t("filters.signInHint") : undefined,
            }))}
            value={shownScope}
            onChange={setScope}
          />
          {compact ? null : (
            <Segmented
              label={t("views.label")}
              options={[
                { id: "month" as const, label: t("views.month"), icon: <CalendarDays size={14} aria-hidden="true" /> },
                { id: "list" as const, label: t("views.list"), icon: <List size={14} aria-hidden="true" /> },
              ]}
              value={view}
              onChange={setView}
            />
          )}
        </div>
      </div>

      {remote.error && !data ? <Failure error={remote.error} onRetry={remote.reload} /> : null}

      {view === "month" ? (
        <div className="flex items-start gap-16 @max-[900px]/community:flex-col @max-[900px]/community:items-stretch">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface" aria-busy={remote.loading || undefined}>
            <div className="grid grid-cols-7 border-b border-line" aria-hidden="true">
              {format.weekdays.map((name, index) => (
                <span key={name} className={cn("px-8 py-6 text-label-xs", index >= 5 ? "text-fg-muted" : "text-fg-secondary")}>
                  {name}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7" role="group" aria-label={monthName}>
              {grid.map((day, index) => {
                const list = byDay.get(day.key) ?? [];
                const isToday = day.key === today;
                const isSelected = day.key === selected;
                const extra = list.length - 2;
                return (
                  <button
                    key={day.key}
                    type="button"
                    onClick={() => setSelected(day.key)}
                    aria-pressed={isSelected}
                    aria-label={
                      list.length > 0
                        ? t("calendar.dayEvents", { day: format.dayOfKey(day.key), count: list.length })
                        : isToday
                          ? t("calendar.dayToday", { day: format.dayOfKey(day.key) })
                          : format.dayOfKey(day.key)
                    }
                    className={cn(
                      "relative flex min-h-[96px] min-w-0 cursor-pointer flex-col items-stretch gap-4 overflow-hidden p-6 text-left transition-colors select-none",
                      index % 7 !== 6 && "border-r border-line-subtle",
                      index < 35 && "border-b border-line-subtle",
                      day.inMonth ? "hover:bg-hover-overlay" : "bg-input hover:bg-surface-hover",
                      isSelected && "jke-selected",
                    )}
                  >
                    <span className="flex min-h-24 items-center gap-6">
                      <span
                        className={cn(
                          "inline-flex h-24 min-w-24 items-center justify-center rounded-full px-4 text-mono-xs tabular-nums",
                          isToday ? "bg-accent font-semibold text-fg-on-accent" : day.inMonth ? "text-fg" : "text-fg-muted",
                        )}
                      >
                        {day.day}
                      </span>
                      {isToday ? <span className="truncate text-label-xs normal-case text-fg-accent">{t("calendar.todayTag")}</span> : null}
                    </span>
                    {list.slice(0, 2).map((event) => {
                      const going = event.viewer?.rsvp === "going";
                      const quiet = event.status === "cancelled" || Date.parse(event.endsAt) <= now;
                      return (
                        <span
                          key={event.id}
                          style={hueStyle(event.communityId)}
                          className={cn("jke-chip flex min-w-0 flex-col rounded-sm px-6 pt-2 pb-4", going && !quiet && "jke-going", quiet && "jke-quiet")}
                        >
                          <span className="jke-chip-time flex items-center gap-4 text-mono-xs">
                            {format.time(Date.parse(event.startsAt))}
                            {going && !quiet ? <Check size={12} strokeWidth={3} className="ml-auto text-fg-warm" aria-label={t("calendar.goingMark")} role="img" /> : null}
                          </span>
                          <span className={cn("line-clamp-2 text-body-sm-medium [overflow-wrap:anywhere]", quiet ? "text-fg-secondary" : "text-fg", event.status === "cancelled" && "line-through")}>
                            {event.title}
                          </span>
                        </span>
                      );
                    })}
                    {extra > 0 ? <span className="px-6 text-body-sm text-fg-secondary">{t("calendar.more", { count: extra })}</span> : null}
                  </button>
                );
              })}
            </div>
            {empty ? (
              <div className="absolute top-1/2 left-1/2 w-[360px] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-elevated shadow-card">
                {empty}
              </div>
            ) : null}
          </div>

          <aside aria-label={t("calendar.dayPanel")} className="flex w-[320px] shrink-0 flex-col gap-12 @max-[900px]/community:w-full">
            <div className="flex flex-col gap-2 px-4">
              <h2 className="text-heading-md text-fg">{selected ? format.dayOfKey(selected) : monthName}</h2>
              <p className="text-body-sm text-fg-secondary">
                {selected
                  ? selected === today
                    ? t("calendar.today")
                    : capitalizeFirst(format.relativeKey(selected, today), format.locale)
                  : t("calendar.chooseDay")}
              </p>
            </div>
            {selectedEvents.map((event) => (
              <DayPanelCard
                key={event.id}
                event={event}
                now={now}
                busy={busyId === event.id}
                error={error?.id === event.id ? error.text : null}
                onAnswer={(value) => answer(event, value)}
              />
            ))}
            {data && selectedEvents.length === 0 ? (
              <div className="flex flex-col items-start gap-12 rounded-lg border border-dashed border-line p-16">
                <p className="text-body-sm text-fg-secondary">
                  {selected === null ? t("calendar.noEventsMonth", { month: monthName }) : shownScope === "all" ? t("calendar.noEventsDay") : t("calendar.noEventsDayFilter")}
                </p>
                {next ? (
                  <Button
                    size="sm"
                    wrap
                    onClick={() => {
                      const key = dayKey(Date.parse(next.startsAt), zone);
                      setMonth(monthOf(key));
                      setSelected(key);
                    }}
                  >
                    {t("calendar.nextEvent", { day: format.day(Date.parse(next.startsAt)), title: next.title })}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <Agenda
          events={shown}
          monthPrefix={monthPrefix}
          now={now}
          today={today}
          busyId={busyId}
          error={error}
          onAnswer={answer}
          empty={empty}
          loading={remote.loading && !data}
        />
      )}
    </div>
  );
}

function capitalizeFirst(text: string, locale: string): string {
  return text === "" ? text : text[0].toLocaleUpperCase(locale) + text.slice(1);
}

/** The month as a list, grouped by day: the tile of the day, then its events. */
function Agenda({
  events,
  monthPrefix,
  now,
  today,
  busyId,
  error,
  onAnswer,
  empty,
  loading,
}: {
  events: EventCard[];
  monthPrefix: string;
  now: number;
  today: string;
  busyId: string | null;
  error: { id: string; text: string } | null;
  onAnswer: (event: EventCard, value: "going" | "maybe" | null) => void;
  empty: ReactNode;
  loading: boolean;
}) {
  const { t } = useTranslation("events");
  const format = useEventFormat();
  const groups = useMemo(() => {
    const days = new Map<string, EventCard[]>();
    for (const event of [...events].sort(byStart)) {
      const key = dayKey(Date.parse(event.startsAt), format.zone);
      if (!key.startsWith(monthPrefix)) {
        // An event that began in the month before still belongs to its first day of this month.
        const first = eventDays(event.startsAt, event.endsAt, format.zone).find((day) => day.startsWith(monthPrefix));
        if (first === undefined) continue;
        days.set(first, [...(days.get(first) ?? []), event]);
        continue;
      }
      days.set(key, [...(days.get(key) ?? []), event]);
    }
    return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [events, monthPrefix, format.zone]);

  if (loading) {
    return (
      <p role="status" className="text-body-sm text-fg-muted">
        {t("common.loading")}
      </p>
    );
  }
  if (groups.length === 0) {
    return <div className="rounded-lg border border-dashed border-line">{empty}</div>;
  }
  return (
    <div role="list" className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface">
      {groups.map(([key, list]) => {
        const noon = Date.parse(`${key}T12:00:00Z`);
        return (
          <section
            key={key}
            role="listitem"
            aria-label={format.dayOfKey(key)}
            className="grid grid-cols-[72px_minmax(0,1fr)] border-t border-line-subtle first:border-t-0 @max-[560px]/community:grid-cols-[56px_minmax(0,1fr)]"
          >
            <div className={cn("flex flex-col items-center border-r border-line-subtle px-4 py-12 text-center", key === today && "bg-accent-subtle")}>
              <span className={cn("text-label-xs", key === today ? "text-fg-accent" : "text-fg-secondary")}>
                {format.weekdays[(new Date(noon).getUTCDay() + 6) % 7]}
              </span>
              <span className={cn("font-display text-[22px] leading-[28px] font-semibold", key === today ? "text-fg-accent" : "text-fg")}>
                {Number(key.slice(8))}
              </span>
              <span className="text-[11px] leading-[14px] text-fg-secondary">{format.relativeKey(key, today)}</span>
            </div>
            <div className="flex min-w-0 flex-col divide-y divide-line-subtle">
              {list.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  now={now}
                  busy={busyId === event.id}
                  error={error?.id === event.id ? error.text : null}
                  onAnswer={(value) => onAnswer(event, value)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A row of choices in one box: the filters and the views of the calendar. */
export function Segmented<Id extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: Id; label: string; count?: number; disabled?: boolean; title?: string; icon?: ReactNode }>;
  value: Id;
  onChange: (value: Id) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex min-h-32 items-center gap-2 rounded-sm border border-line bg-input p-2">
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
            className={cn(
              "inline-flex min-h-26 cursor-pointer items-center gap-6 rounded-xs px-10 py-2 text-body-sm-medium whitespace-nowrap select-none transition-colors pointer-coarse:min-h-44",
              on ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
              "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-fg-disabled",
            )}
          >
            {option.icon}
            {option.label}
            {option.count !== undefined ? (
              <span className={cn("text-mono-xs tabular-nums", on ? "text-fg-accent" : "text-fg-secondary", option.disabled && "text-fg-disabled")}>{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
