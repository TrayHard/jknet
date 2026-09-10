/**
 * The names of a game's modes, in the language on screen.
 *
 * The number is the truth and it comes from the server: `gametype` 7 is Siege
 * in Jedi Academy and Capture the Flag in Jedi Outcast, which is why every key
 * here carries the game as well as the number. The core keeps its own table in
 * `GameSpec` and answers with the English label; that label is the fallback,
 * so a mode a catalog has not caught up with still reads as a word rather than
 * as a key.
 *
 * Everything else a server publishes is data, not interface: the host name, the
 * map and the mod folder are what the operator typed and are never translated.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { Game } from "../lib/ipc";

/** A key computed at runtime cannot be one of the typed literals. */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export interface GametypeLabels {
  /** The full name, for a badge in the details panel or a filter option. */
  label: (game: Game, gametype: number, fallback?: string) => string;
  /** The short name the 60 px column of the server table holds. */
  short: (game: Game, gametype: number) => string;
}

export function useGametypeLabels(): GametypeLabels {
  const { t, i18n } = useTranslation("games");

  const read = useCallback(
    (key: string): string | null =>
      i18n.exists(key, { ns: "games" }) ? (t as unknown as LooseT)(key) : null,
    [t, i18n],
  );

  const label = useCallback(
    (game: Game, gametype: number, fallback?: string) =>
      read(`gametypes.${game}.${gametype}`) ??
      // The core's own label first: a mod that invented number 42 gets
      // «Mode 42» from `GameSpec`, and repeating that guess here would only be
      // a second place for it to drift.
      fallback ??
      t("unknownGametype", { number: gametype }),
    [read, t],
  );

  const short = useCallback(
    (game: Game, gametype: number) =>
      read(`gametypesShort.${game}.${gametype}`) ?? String(gametype),
    [read],
  );

  return { label, short };
}
