/**
 * --- slice: web app ---
 *
 * Whether the main pointer is a finger: a phone or a tablet. A touch screen
 * has no hover, so controls the launcher shows on hover are shown or
 * revealed by a tap there instead. The launcher's mouse never matches.
 */

import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

/** The answer right now, for an event handler. */
export function isCoarsePointer(): boolean {
  return media()?.matches ?? false;
}

function subscribe(listener: () => void): () => void {
  const list = media();
  if (list === null) return () => {};
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

/** The answer as React state: a tablet that gains a mouse re-renders. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, isCoarsePointer, () => false);
}
