/**
 * Answers to read-only launcher commands that are simply empty in a browser.
 *
 * Shared components ask for the clients, the profiles, the running game or
 * the private server whatever platform they run on, and the true answer on
 * the web is "none". These commands answer that instead of a refusal, and the
 * core counts them in `stats.neutral`, not as failures. A command joins this
 * list only when it reads and its empty answer is true on the web; an action
 * never does.
 */

import type { DetectedGameFiles, GameInfo, ProfileBook } from "../../../src/lib/ipc.ts";

/** `GameSpec` of `src-tauri/src/game.rs`, without what needs an install. */
export const GAMES: GameInfo[] = [
  {
    id: "ja",
    displayName: "Jedi Academy",
    shortName: "JA",
    requiredAssets: ["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3"],
    wantedVersion: null,
    steamAppId: 6020,
    serverPort: 29070,
    gametypes: ["FFA", "Holocron", "Jedi Master", "Duel", "Power Duel", "Single Player", "Team FFA", "Siege", "CTF", "CTY"],
    hasSaberHilts: true,
  },
  {
    id: "jo",
    displayName: "Jedi Outcast",
    shortName: "JO",
    requiredAssets: ["assets0.pk3", "assets1.pk3"],
    wantedVersion: "1.04",
    steamAppId: 6030,
    serverPort: 28070,
    gametypes: ["FFA", "Holocron", "Jedi Master", "Duel", "Single Player", "Team FFA", "Saga", "CTF", "CTY"],
    hasSaberHilts: false,
  },
];

const NO_GAME_FILES: DetectedGameFiles = { ja: [], jo: [] };
const NO_PROFILES: ProfileBook = { profiles: [], defaultProfileId: null };

/** The neutral answer of a command, or `undefined` when it has none. */
export function neutralAnswer(command: string): { value: unknown } | undefined {
  switch (command) {
    case "list_games":
      return { value: GAMES.map((game) => ({ ...game, requiredAssets: [...game.requiredAssets], gametypes: [...game.gametypes] })) };
    case "list_clients":
      return { value: [] };
    case "detect_game_files":
      return { value: { ja: [...NO_GAME_FILES.ja], jo: [...NO_GAME_FILES.jo] } };
    case "list_profiles":
      return { value: { ...NO_PROFILES, profiles: [] } };
    case "get_running_game":
    case "host_get_session":
    case "get_levelshot":
      return { value: null };
    case "chat_scan_commands":
      return { value: [] };
    default:
      return undefined;
  }
}
