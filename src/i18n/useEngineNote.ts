/**
 * The sentence behind an engine's status, in the language on screen.
 *
 * A `legacy` engine carries a catalog key rather than English text, so the
 * warning arrives translated. The key comes from the registry in the core, so
 * the types cannot check it: this is the fourth place in the project where a
 * key is computed at runtime, and like the other three it asks `i18n.exists`
 * before it asks `t`.
 *
 * A note may offer a way out, and the offer lives under the same key with
 * `Action` appended — `engines.notes.eternaljk` holds the warning,
 * `engines.notes.eternaljkAction` the label of the button next to it. The
 * offer is optional: a note with nothing to suggest simply has no sibling key,
 * and the caller draws no button.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { EngineStatus } from "../lib/ipc";

/** A key computed at runtime cannot be one of the typed literals. */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export interface EngineNote {
  /** What is wrong with this build and what to use instead. */
  text: string;
  /** Label of the button that offers the way out, or `null` for no button. */
  action: string | null;
}

/** Reads the note of one engine status, or `null` when there is nothing to say. */
export function useEngineNote(): (status: EngineStatus) => EngineNote | null {
  const { t, i18n } = useTranslation("clients");

  return useCallback(
    (status: EngineStatus): EngineNote | null => {
      if (status.kind !== "legacy") return null;
      const loose = t as unknown as LooseT;
      // A key the catalog has never heard of would reach the player as the key
      // itself, which is worse than saying nothing at all.
      if (!i18n.exists(status.noteKey, { ns: "clients" })) return null;
      const actionKey = `${status.noteKey}Action`;
      return {
        text: loose(status.noteKey),
        action: i18n.exists(actionKey, { ns: "clients" }) ? loose(actionKey) : null,
      };
    },
    [t, i18n],
  );
}
