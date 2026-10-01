/**
 * The computations of «When people play here», free of React and of any
 * host: the heat map of the service turned into the reader's week, the
 * busiest hours of a day, and the shade of a cell.
 *
 * The service sends 168 numbers, the average humans in each hour of the
 * week in UTC, Monday 00:00 first (`GET communities/{id}/activity`). The
 * reader's week starts on their own Monday at their own midnight, so the
 * map is turned by the reader's offset from UTC before it is drawn. The
 * offset is an argument: the unit tests (`heatmap.test.mjs`) pin it, and
 * the screen takes it from the reader's time zone at the moment it draws.
 * The card that draws it is `Activity.tsx`.
 */

/** The hours of a week: 7 days of 24. */
export const HOURS_OF_WEEK = 168;

/** The shades a cell takes besides empty: the legend's five steps. */
export const LEVELS = 5;

/** Fewer days of samples than this, and the map says it knows little yet. */
export const FEW_DAYS = 7;

/** The longest run of hours the summary calls the busiest. */
export const BUSIEST_MAX_HOURS = 6;

/** How close to the busiest hour an hour must come to join its run. */
export const BUSIEST_SHARE = 0.6;

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/**
 * The heat map as the reader's week: seven rows, Monday first, of 24 hours
 * from the reader's midnight. `offsetMinutes` is the reader's offset from
 * UTC: 180 for Moscow, -300 for New York in winter. An offset that is not a
 * whole number of hours — 330 for India — spreads each local hour over the
 * two UTC hours it touches, by the minutes it shares with each.
 *
 * A heat map of another length reads as a week without anyone in it.
 */
export function rotateHeatmap(heatmap: readonly number[], offsetMinutes: number): number[][] {
  const rows = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  if (heatmap.length !== HOURS_OF_WEEK) return rows;
  const value = (hour: number) => {
    const found = heatmap[wrap(hour, HOURS_OF_WEEK)];
    return typeof found === "number" && Number.isFinite(found) && found > 0 ? found : 0;
  };
  const offset = Number.isFinite(offsetMinutes) ? Math.round(offsetMinutes) : 0;
  for (let local = 0; local < HOURS_OF_WEEK; local += 1) {
    // The local hour starts this many minutes after Monday 00:00 UTC.
    const start = local * 60 - offset;
    const first = Math.floor(start / 60);
    const share = (start - first * 60) / 60;
    rows[Math.floor(local / 24)][local % 24] = share === 0 ? value(first) : value(first) * (1 - share) + value(first + 1) * share;
  }
  return rows;
}

/** The average of each hour of the day over the seven days of a week. */
export function dayProfile(rows: readonly (readonly number[])[]): number[] {
  const profile = new Array<number>(24).fill(0);
  if (rows.length === 0) return profile;
  for (const row of rows) {
    for (let hour = 0; hour < 24; hour += 1) profile[hour] += row[hour] ?? 0;
  }
  return profile.map((sum) => sum / rows.length);
}

/** A run of hours of the day: `from` is the first hour, `to` the hour after the last, both 0–23. */
export interface HourRun {
  from: number;
  to: number;
  hours: number;
}

/**
 * The busiest hours of the reader's day: the busiest hour on average over
 * the week, and the hours around it that come within {@link BUSIEST_SHARE}
 * of it, the busier neighbour first, at most {@link BUSIEST_MAX_HOURS}. The
 * run may cross midnight: 22:00–02:00. `null` while nobody played.
 */
export function busiestHours(rows: readonly (readonly number[])[]): HourRun | null {
  const profile = dayProfile(rows);
  const most = Math.max(...profile);
  if (!(most > 0)) return null;
  const peak = profile.indexOf(most);
  let start = peak;
  let length = 1;
  const floor = most * BUSIEST_SHARE;
  while (length < BUSIEST_MAX_HOURS) {
    const before = profile[wrap(start - 1, 24)];
    const after = profile[wrap(start + length, 24)];
    const takeAfter = after >= floor && after >= before;
    const takeBefore = !takeAfter && before >= floor;
    if (takeAfter) length += 1;
    else if (takeBefore) {
      start = wrap(start - 1, 24);
      length += 1;
    } else break;
  }
  return { from: start, to: wrap(start + length, 24), hours: length };
}

/** The busiest cell of the reader's week. */
export function busiestValue(rows: readonly (readonly number[])[]): number {
  let most = 0;
  for (const row of rows) for (const value of row) if (value > most) most = value;
  return most;
}

/**
 * The shade of a cell: 0 for an hour without anyone, then 1 to
 * {@link LEVELS} by its share of the busiest cell of the week. A cell with
 * anyone at all is never drawn empty.
 */
export function levelOf(value: number, most: number): number {
  if (!(value > 0) || !(most > 0)) return 0;
  return Math.min(LEVELS, Math.max(1, Math.ceil((value / most) * LEVELS)));
}

/** Whether the map has seen too few days to be trusted. */
export function fewDays(days: number): boolean {
  return days < FEW_DAYS;
}
