import { useSyncExternalStore } from "react";

/** Whether a media query matches, following it live: rotation, a resized window. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** The wide layout from 900 × 560 on; a phone turned sideways stays on the phone layout. */
export const WIDE_QUERY = "(min-width: 900px) and (min-height: 560px)";

/** From 1200 px the details are a fourth column, below that a sheet. */
export const DETAILS_COLUMN_QUERY = "(min-width: 1200px)";
