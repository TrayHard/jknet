import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { isGame, useActiveGame } from "../../../../src/lib/game.ts";
import type { Game } from "../../../../src/lib/ipc.ts";
import { useUpdateSettings } from "../../../../src/lib/queries.ts";

/**
 * The query string the address holds now.
 *
 * A writer below may run from a timer — the search box writes a moment after
 * the typing stops — after another writer changed the address and before
 * React rendered again. `useSearchParams` hands every writer the query string
 * of the render that made it, so a writer that started from that one would
 * put back what the other just changed (a game switched in that moment).
 * The browser's own address is always the latest.
 */
function liveParams(fallback: URLSearchParams): URLSearchParams {
  return typeof window === "undefined" ? new URLSearchParams(fallback) : new URLSearchParams(window.location.search);
}

/** `changes` applied to a query string, `""` removing a value. */
function apply(params: URLSearchParams, changes: Record<string, string>): URLSearchParams {
  for (const [name, value] of Object.entries(changes)) {
    if (value === "") params.delete(name);
    else params.set(name, value);
  }
  return params;
}

/**
 * The game a catalog screen shows, and the switch between the two.
 *
 * The address wins: `?game=jo` on a link pasted into a chat opens the Jedi
 * Outcast view whatever this browser last chose. Without it the screen
 * follows the settings' `activeGame`, which the web keeps on this device. A
 * press of the switch writes both: the address, so the view can be shared
 * again, and the setting, so the next catalog opens on the same game.
 * `changes` are other values of the address to write in the same entry,
 * `""` removing one: the category of one game means nothing in the other.
 */
export function useCatalogGame(): { game: Game; setGame: (game: Game, changes?: Record<string, string>) => void } {
  const [params, setParams] = useSearchParams();
  const active = useActiveGame();
  const update = useUpdateSettings();
  const mutate = update.mutate;
  const asked = params.get("game");
  const game = isGame(asked) ? asked : active;

  const setGame = useCallback(
    (next: Game, changes: Record<string, string> = {}) => {
      setParams((current) => apply(liveParams(current), { ...changes, game: next }), { replace: true });
      // Written on every press, not only when it differs from the setting
      // this render saw: a quick switch there and back would otherwise
      // leave the first press's game in the setting.
      mutate({ activeGame: next });
    },
    [mutate, setParams],
  );

  return { game, setGame };
}

/**
 * One value of the query string, and a writer that replaces the entry: the
 * search box and the order of a catalog live in the address.
 */
export function useQueryValue(name: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) ?? "";
  const set = useCallback(
    (next: string) => {
      setParams((current) => apply(liveParams(current), { [name]: next }), { replace: true });
    },
    [name, setParams],
  );
  return [value, set];
}

/**
 * Several values of the query string at once, in one replaced entry, `""`
 * removing one: a new search, category or order that starts over on the
 * first page, or **Reset filters**.
 */
export function useQueryWriter(): (changes: Record<string, string>) => void {
  const [, setParams] = useSearchParams();
  return useCallback(
    (changes) => {
      setParams((current) => apply(liveParams(current), changes), { replace: true });
    },
    [setParams],
  );
}
