/**
 * The game dimension on the frontend.
 *
 * JKNet launches two games, and every screen works in one of them at a time.
 * The choice lives in `settings.activeGame`, the sidebar switcher writes it and
 * everything else reads it from here: names, the default client of a game, the
 * clients of a game, and the rule that reads a game off a server port.
 *
 * Nothing in this file spells a game's name or a port number by hand. Both come
 * from `list_games`, which reads the `GameSpec` table in `src-tauri/src/game.rs`
 * — the one place a game constant is allowed to live. What a function here
 * cannot get from that table it derives from the id (`ja` → `JA`) rather than
 * keeping a second copy of the truth.
 *
 * The pure functions take their inputs as arguments so that a wrong answer on
 * screen can be reasoned about without React: the hooks below are thin wrappers
 * that fetch those inputs.
 */

import { useCallback } from "react";

import { GAMES } from "./ipc";
import type { Client, Game, GameInfo, Settings } from "./ipc";
import {
  useActiveGame,
  useClients,
  useGames,
  useSettings,
  useUpdateSettings,
} from "./queries";

// The switcher and every screen import the active game from here, so that the
// game plumbing is one import away wherever it is needed. The hook itself stays
// in `queries.ts`: a dozen hooks there call it, and moving it would make this
// module and that one import each other.
export { useActiveGame };

/**
 * How many ports above a game's `PORT_SERVER` still count as that game.
 *
 * Mirrors `PORT_SPAN` in `src-tauri/src/game.rs`, which carries the reasoning
 * and the test. The bases are not mirrored: they come from `GameInfo.serverPort`.
 */
export const PORT_SPAN = 10;

/** The other of the two games. */
export function otherGame(game: Game): Game {
  return game === "ja" ? "jo" : "ja";
}

/**
 * Whether a string from outside the code names a game.
 *
 * A route parameter is written by whoever typed the address, so it is checked
 * against the two ids rather than cast into `Game` and believed.
 */
export function isGame(value: string | null | undefined): value is Game {
  return value != null && (GAMES as readonly string[]).includes(value);
}

/**
 * Full title of a game: «Jedi Academy».
 *
 * Falls back to the short form while `list_games` is in flight — one frame, the
 * command answers from a static table — and outside Tauri, where no command
 * answers at all. `JA` is a truthful stand-in derived from the id; a hardcoded
 * «Jedi Academy» here would be a second place for the name to drift.
 */
export function gameLabel(game: Game, games?: GameInfo[]): string {
  return games?.find((entry) => entry.id === game)?.displayName ?? gameShort(game);
}

/** Two letters for a badge or a narrow segment: `JA`, `JO`. */
export function gameShort(game: Game, games?: GameInfo[]): string {
  return games?.find((entry) => entry.id === game)?.shortName ?? game.toUpperCase();
}

/** Both name functions bound to the loaded table. */
export function useGameNames(): {
  label: (game: Game) => string;
  short: (game: Game) => string;
} {
  const games = useGames().data;
  return {
    label: (game) => gameLabel(game, games),
    short: (game) => gameShort(game, games),
  };
}

/**
 * Switches the game every screen works in.
 *
 * One field, one patch. The answer replaces the settings document in the query
 * cache, `useActiveGame` follows it in the same render, and every query keyed by
 * the game — the server list, the map pictures, the server status — re-keys and
 * fetches the new game's data by itself. The route is untouched: a player who
 * switches games while reading the server browser keeps reading the server
 * browser.
 */
export function useSetActiveGame(): {
  game: Game;
  setGame: (game: Game) => void;
  pending: boolean;
} {
  const game = useActiveGame();
  const updateSettings = useUpdateSettings();
  const mutate = updateSettings.mutate;

  const setGame = useCallback(
    (next: Game) => {
      if (next === game) return;
      mutate({ activeGame: next });
    },
    [game, mutate],
  );

  return { game, setGame, pending: updateSettings.isPending };
}

// ---------------------------------------------------------------------------
// Clients of a game
// ---------------------------------------------------------------------------

/** The clients that play one game, in the order the core listed them. */
export function clientsOfGame(
  clients: Client[] | undefined,
  game: Game,
): Client[] {
  return (clients ?? []).filter((client) => client.game === game);
}

/**
 * The id of the client the Play button of one game starts, or `null`.
 *
 * The per-game map is the answer. The single `defaultClientId` of 0.2 still
 * stands in for Jedi Academy, so a launcher whose map has not been written yet
 * keeps the client it always had; for Jedi Outcast there is nothing to fall
 * back on, because that field never named a Jedi Outcast client.
 *
 * The same rule lives in `default_client` in `src-tauri/src/friends/mod.rs`,
 * which is what a **Join game** goes through.
 */
export function resolveDefaultClientId(
  settings: Settings | undefined,
  game: Game,
): string | null {
  const mapped = settings?.defaultClientIds[game];
  if (mapped !== undefined && mapped.trim() !== "") return mapped;
  if (game !== "ja") return null;
  const legacy = settings?.defaultClientId;
  return legacy !== null && legacy !== undefined && legacy.trim() !== ""
    ? legacy
    : null;
}

/**
 * The default client of one game, and `undefined` when it has none.
 *
 * A stored id that names a client of the other game is no answer: settings and
 * the client folder are two documents, and a client deleted outside the
 * launcher would otherwise leave the Play button pointing at nothing.
 */
export function findDefaultClient(
  clients: Client[] | undefined,
  settings: Settings | undefined,
  game: Game,
): Client | undefined {
  const id = resolveDefaultClientId(settings, game);
  if (id === null) return undefined;
  return (clients ?? []).find(
    (client) => client.id === id && client.game === game,
  );
}

/** The default client of the active game, or of the game named. */
export function useDefaultClient(game?: Game): Client | undefined {
  const active = useActiveGame();
  const clients = useClients();
  const settings = useSettings();
  return findDefaultClient(clients.data, settings.data, game ?? active);
}

/**
 * The patch that makes one client the default one of its game.
 *
 * Both fields for Jedi Academy: the map is what every screen reads now, and the
 * 0.2 field is what an older build and the migration still read. Jedi Outcast
 * writes the map alone — a Jedi Outcast client in `defaultClientId` would be
 * started by anything that has not been scoped yet.
 */
export function defaultClientPatch(client: Client) {
  return client.game === "ja"
    ? { defaultClientId: client.id, defaultClientIds: { ja: client.id } }
    : { defaultClientIds: { [client.game]: client.id } };
}

// ---------------------------------------------------------------------------
// Game files
// ---------------------------------------------------------------------------

/** Whether the player has told the launcher where this game's archives are. */
export function hasGameFiles(
  settings: Settings | undefined,
  game: Game,
): boolean {
  const path = settings?.gameDataPaths[game];
  return path !== undefined && path.trim() !== "";
}

// ---------------------------------------------------------------------------
// Reading a game off a server address
// ---------------------------------------------------------------------------

/**
 * The game a server port belongs to.
 *
 * Presence on the service names the server a friend is on but not the game they
 * are playing, so the port has to answer for it. The windows start at each
 * game's `PORT_SERVER`, which arrives in `GameInfo.serverPort`, and run
 * [`PORT_SPAN`] ports up to cover a machine hosting several servers. Anything
 * else is Jedi Academy: the game the launcher shipped with and the longer list.
 *
 * The rule is `Game::from_server_port` in `src-tauri/src/game.rs`, where it has
 * a test; this is the same rule where the interface needs it before a command
 * is called. A `game` field in the service's presence document would retire both.
 */
export function gameFromServerPort(
  port: number,
  games: GameInfo[] | undefined,
): Game {
  const match = (games ?? []).find(
    (entry) => port >= entry.serverPort && port < entry.serverPort + PORT_SPAN,
  );
  return match?.id ?? "ja";
}

/** The same rule applied to an `ip:port` string. */
export function gameFromServerAddress(
  address: string | null | undefined,
  games: GameInfo[] | undefined,
): Game {
  const colon = (address ?? "").trim().lastIndexOf(":");
  if (colon < 0) return "ja";
  const port = Number.parseInt((address ?? "").trim().slice(colon + 1), 10);
  if (!Number.isFinite(port)) return "ja";
  return gameFromServerPort(port, games);
}

// ---------------------------------------------------------------------------
// Map pictures
// ---------------------------------------------------------------------------

/**
 * Splits the `<game>/<map>` keys of `list_levelshots` into a count per game.
 *
 * A key with no game in front of it belongs to no game and is left out of both
 * counts rather than added to Jedi Academy: the index is rebuilt from scratch
 * when its version changes, so such a key would be a bug worth seeing as a gap.
 */
export function levelshotCounts(keys: string[] | undefined): Record<Game, number> {
  const counts: Record<Game, number> = { ja: 0, jo: 0 };
  for (const key of keys ?? []) {
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const game = key.slice(0, slash);
    if (game === "ja" || game === "jo") counts[game] += 1;
  }
  return counts;
}
