/**
 * The one place a status descriptor becomes a sentence.
 *
 * `presence.ts` decides what a friend's line should say and this turns that
 * decision into words: the row, the panel and any later caller therefore say
 * the same thing about the same friend in every language.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import type { Presence } from "../../lib/ipc";
import { statusLine, type StatusLine } from "./presence";

/** A key computed at runtime cannot be one of the typed literals. */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export function useStatusLine(): (presence: Presence) => string {
  const { t } = useTranslation("friends");
  const format = useFormat();

  return useCallback(
    (presence: Presence) => {
      const line: StatusLine = statusLine(presence);
      const values = { ...line.values };
      // A date old enough to be printed as a date goes through `Intl`, so the
      // order of day and month follows the language rather than the code.
      if (line.date !== undefined) values.date = format.date(line.date);
      return (t as unknown as LooseT)(line.key, values);
    },
    [t, format],
  );
}
