import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * --- slice: chat cards ---
 *
 * Draws a dialog of the chat into `document.body` instead of where it is
 * asked for.
 *
 * A message group of the thread carries `content-visibility: auto`, which
 * contains its paint: a `position: fixed` dialog drawn inside a card would be
 * placed and clipped by the group, not by the window. Every dialog a card or
 * the composer opens goes through here. React still delivers its events to
 * the component that opened it; the drawer's `Escape`, which checks where
 * the key came from in the page, leaves them alone.
 */
export function Layer({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === false) return null;
  return createPortal(children, document.body);
}
