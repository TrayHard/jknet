import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { isGame, useActiveGame } from "../../../../src/lib/game.ts";
import type { Game } from "../../../../src/lib/ipc.ts";
import { useUpdateSettings } from "../../../../src/lib/queries.ts";

/**
 * The game a catalog screen shows, and the switch between the two.
 *
 * The address wins: `?game=jo` on a link pasted into a chat opens the Jedi
 * Outcast view whatever this browser last chose. Without it the screen
 * follows the settings' `activeGame`, which the web keeps on this device. A
 * press of the switch writes both: the address, so the view can be shared
 * again, and the setting, so the next catalog opens on the same game.
 */
export function useCatalogGame(): { game: Game; setGame: (game: Game) => void } {
  const [params, setParams] = useSearchParams();
  const active = useActiveGame();
  const update = useUpdateSettings();
  const mutate = update.mutate;
  const asked = params.get("game");
  const game = isGame(asked) ? asked : active;

  const setGame = useCallback(
    (next: Game) => {
      setParams(
        (current) => {
          const changed = new URLSearchParams(current);
          changed.set("game", next);
          return changed;
        },
        { replace: true },
      );
      if (next !== active) mutate({ activeGame: next });
    },
    [active, mutate, setParams],
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
      setParams(
        (current) => {
          const changed = new URLSearchParams(current);
          if (next === "") changed.delete(name);
          else changed.set(name, next);
          return changed;
        },
        { replace: true },
      );
    },
    [name, setParams],
  );
  return [value, set];
}
