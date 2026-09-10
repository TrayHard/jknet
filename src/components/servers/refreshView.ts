/**
 * What the Servers screen shows while a refresh is in flight.
 *
 * A refresh streams its answers in: `servers:batch` lands every 100 ms and
 * merges new rows into the cached list, so without help the table grows,
 * re-sorts and shifts under the cursor for the four seconds a scan takes. The
 * screen therefore holds the rows it had when the scan started and covers them
 * with a loader until the scan hands back its full list.
 *
 * Everything here is a pure function of the two lists and the scan flag: the
 * page keeps the one ref it needs and reads the decisions from this module.
 */

import type { ServerInfo, ServersDoneEvent } from "../../lib/ipc";

/** What every part of the screen renders for one frame. */
export interface ScanView {
  /** The rows: live between scans, held still during one. */
  rows: ServerInfo[];
  /** The rows are held still, so the loader covers the table. */
  frozen: boolean;
  /** Nothing to hold still yet: the first scan draws skeleton rows. */
  skeleton: boolean;
}

/**
 * The rows to hold for the length of one scan, or `null` for "do not hold".
 *
 * Called only when the scan flag flips. A scan that starts on an empty table
 * has nothing to hold: the very first one on a fresh install fills the screen
 * from nothing, and watching it fill is the point.
 */
export function rowsToHold(
  live: ServerInfo[],
  scanning: boolean,
): ServerInfo[] | null {
  return scanning && live.length > 0 ? live : null;
}

/**
 * Picks between the live list, the held one and the skeleton.
 *
 * Holding nothing leaves the screen as it always was: skeleton rows until the
 * first batch lands, then the table filling in. That is the right answer for
 * the one scan that has nothing to protect — the first one on a fresh install,
 * where a filling table is the whole show.
 */
export function scanView(
  live: ServerInfo[],
  held: ServerInfo[] | null,
  scanning: boolean,
): ScanView {
  if (!scanning) return { rows: live, frozen: false, skeleton: false };
  if (held === null) {
    return { rows: live, frozen: false, skeleton: live.length === 0 };
  }
  return { rows: held, frozen: true, skeleton: false };
}

/**
 * How many servers have answered the scan in flight.
 *
 * Every row of one refresh carries the same `lastSeen`, stamped in the core
 * before the first probe goes out, so a row newer than anything the held list
 * knows about is a row this scan brought in. The stamp has whole-second
 * resolution; two scans cannot share a second, because one takes about four
 * and the Refresh button is dead while it runs.
 */
export function respondedSoFar(
  live: ServerInfo[],
  held: ServerInfo[] | null,
): number {
  const before = newestSeen(held ?? []);
  return live.filter((row) => row.lastSeen > before).length;
}

/**
 * What the line under the spinner should say, as a decision rather than a
 * sentence.
 *
 * The core counts its addresses only when a scan ends (`servers:done`), so the
 * scan in flight has no total to print and the last one's stands in as an
 * estimate — said as an estimate, because the masters answer with a different
 * list every time.
 *
 * --- slice: i18n ---
 * The three shapes are three keys of the `servers` catalog. Returning the
 * decision instead of the words keeps this module free of English and testable
 * without a translation layer.
 */
export interface ScanProgress {
  /** `label`, `found` or `ofAbout`: which key of `servers.scan` to print. */
  kind: "label" | "found" | "ofAbout";
  /** Servers that have answered this scan. */
  count: number;
  /** The previous scan's total, when it is worth printing as an estimate. */
  total: number;
}

export function scanLabel(
  responded: number,
  previous: ServersDoneEvent | null,
): ScanProgress {
  if (responded <= 0) return { kind: "label", count: 0, total: 0 };
  if (previous === null || previous.total < responded) {
    return { kind: "found", count: responded, total: 0 };
  }
  return { kind: "ofAbout", count: responded, total: previous.total };
}

/** The newest RFC 3339 stamp in a list, or `""` for an empty one. */
function newestSeen(rows: ServerInfo[]): string {
  let newest = "";
  for (const row of rows) {
    // Fixed width, whole seconds, always UTC: `2026-09-10T12:00:00Z`. The
    // format sorts as text, so this needs no date parser.
    if (row.lastSeen > newest) newest = row.lastSeen;
  }
  return newest;
}
