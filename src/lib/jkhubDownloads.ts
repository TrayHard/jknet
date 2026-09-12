import { useSyncExternalStore } from "react";

import type { JkhubInstallResult } from "./ipc";

/**
 * --- slice: jkhub details ---
 *
 * What every install of a JKHub file is doing right now, for the card in the
 * toast column.
 *
 * A store outside React rather than state inside a component, for one reason:
 * the install is started on the Library screen and the card belongs to the
 * column that floats over every screen. Lifting the state to a provider would
 * mean the screen pushing its progress up through props it does not own, and
 * the download outlives the screen anyway — the player presses **Install** and
 * walks off to the server browser while a 217 MB map comes down.
 *
 * The writer is [`useJkhubInstall`] in `queries.ts`, which every caller of an
 * install already goes through, so no screen has to remember to report. The
 * reader is `JkhubDownloadToasts`.
 */

/** How far one install has got. */
export type JkhubInstallPhase = "running" | "done" | "failed";

export interface JkhubInstallEntry {
  fileId: number;
  /**
   * Title of the entry on JKHub, when the tab already had it in its cache.
   * Null falls back to the name of the archive, which the progress event
   * carries once the download starts.
   */
  title: string | null;
  /** Client the file is being written into. Null while none was picked. */
  clientId: string | null;
  phase: JkhubInstallPhase;
  /** The answer of the core, once it answered. */
  result: JkhubInstallResult | null;
  /**
   * The failure exactly as the call threw it. Untranslated on purpose: the
   * card that shows it has `useErrorText`, and this store has no i18n.
   */
  error: unknown;
  /** Ticks up every time an install of the same file is started again. */
  attempt: number;
}

type Listener = () => void;

let entries: readonly JkhubInstallEntry[] = [];
const listeners = new Set<Listener>();

function publish(next: readonly JkhubInstallEntry[]) {
  entries = next;
  for (const listener of listeners) listener();
}

function replace(
  fileId: number,
  change: (previous: JkhubInstallEntry | undefined) => JkhubInstallEntry | null,
) {
  const previous = entries.find((entry) => entry.fileId === fileId);
  const without = entries.filter((entry) => entry.fileId !== fileId);
  const next = change(previous);
  // A second install of the same file replaces the first card instead of
  // stacking a second one: it is the same file and the same question.
  publish(next === null ? without : [...without, next]);
}

export const jkhubDownloads = {
  /** An install has been asked for. Replaces whatever that file said before. */
  start(fileId: number, title: string | null, clientId: string | null) {
    replace(fileId, (previous) => ({
      fileId,
      title,
      clientId,
      phase: "running",
      result: null,
      error: null,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
  },
  /** The core answered. Not always «installed»: four of the five are not. */
  finish(fileId: number, result: JkhubInstallResult) {
    replace(fileId, (previous) =>
      previous == null
        ? null
        : { ...previous, phase: "done", result, error: null },
    );
  },
  /** The call failed outright. */
  fail(fileId: number, error: unknown) {
    replace(fileId, (previous) =>
      previous == null ? null : { ...previous, phase: "failed", error },
    );
  },
  /** The player closed the card, or it timed out after a success. */
  forget(fileId: number) {
    replace(fileId, () => null);
  },
};

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly JkhubInstallEntry[] {
  return entries;
}

/** Every install the launcher has been asked for, oldest first. */
export function useJkhubInstalls(): readonly JkhubInstallEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
