/**
 * Answers to read-only launcher commands that are simply empty in a browser.
 *
 * Shared components ask for the clients, the profiles, the running game or
 * the private server whatever platform they run on, and the true answer on
 * the web is "none". These commands answer that instead of a refusal, and the
 * core counts them in `stats.neutral`, not as failures. A command joins this
 * list only when it reads and its empty answer is true on the web; an action
 * never does. The two registries of the launcher, the games and the engines,
 * answer the same static tables on every platform.
 */

import type { DetectedGameFiles, Engine, GameInfo, ProfileBook } from "../../../src/lib/ipc.ts";

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

/**
 * The engine registry of `src-tauri/src/engines.rs` (`ENGINES`), without
 * what needs a machine: a bundle card and a bundle record name the engines
 * of their components by it. `system` is the web's own word, and no engine
 * is refused for it: the web app runs none.
 */
export const ENGINES: Engine[] = [
  {
    id: "openjk",
    game: "ja",
    name: "OpenJK",
    description: "The community reference build. Stable, closest to the original game.",
    executable: "openjk.x86.exe",
    repo: "JACoders/OpenJK",
    repoUrl: "https://github.com/JACoders/OpenJK",
    releasesUrl: "https://github.com/JACoders/OpenJK/releases",
    homepage: null,
    iconCredit: null,
    status: { kind: "recommended" },
    installable: true,
    notInstallableReason: null,
    system: "web",
    compatibilityError: null,
    defaultFsGame: null,
    modes: ["multiplayer", "single"],
    canHost: true,
  },
  {
    id: "eternaljk",
    game: "ja",
    name: "EternalJK",
    description: "OpenJK with the modern multiplayer patches most servers expect.",
    executable: "eternaljk.x86.exe",
    repo: "eternalcodes/EternalJK",
    repoUrl: "https://github.com/eternalcodes/EternalJK",
    releasesUrl: "https://github.com/eternalcodes/EternalJK/releases",
    homepage: "https://playja.pro",
    iconCredit: null,
    status: { kind: "supported" },
    installable: true,
    notInstallableReason: null,
    system: "web",
    compatibilityError: null,
    defaultFsGame: null,
    modes: ["multiplayer"],
    canHost: true,
  },
  {
    id: "taystjk",
    game: "ja",
    name: "TaystJK",
    description: "Fork focused on competitive play and quality of life fixes.",
    executable: "taystjk.x86.exe",
    repo: "taysta/TaystJK",
    repoUrl: "https://github.com/taysta/TaystJK",
    releasesUrl: "https://github.com/taysta/TaystJK/releases",
    homepage: "https://taysta.github.io/TaystJK/",
    iconCredit: null,
    status: { kind: "supported" },
    installable: true,
    notInstallableReason: null,
    system: "web",
    compatibilityError: null,
    defaultFsGame: null,
    modes: ["multiplayer"],
    canHost: true,
  },
  {
    id: "jamme",
    game: "ja",
    name: "jaMME",
    description: "Movie maker edition: demo playback, camera work and capture.",
    executable: "jamme.exe",
    repo: "entdark/jaMME",
    repoUrl: "https://github.com/entdark/jaMME",
    releasesUrl: "https://github.com/entdark/jaMME/releases",
    homepage: null,
    iconCredit: null,
    status: { kind: "supported" },
    installable: true,
    notInstallableReason: null,
    system: "web",
    compatibilityError: null,
    defaultFsGame: "mme",
    modes: ["multiplayer"],
    canHost: false,
  },
  {
    id: "jk2mv",
    game: "jo",
    name: "JK2MV",
    description: "The Jedi Outcast multiplayer client. Plays 1.02, 1.03 and 1.04.",
    executable: "jk2mvmp.exe",
    repo: "mvdevs/jk2mv",
    repoUrl: "https://github.com/mvdevs/jk2mv",
    releasesUrl: "https://github.com/mvdevs/jk2mv/releases",
    homepage: "https://jk2mv.org",
    iconCredit: "Thoroughbred-Of-Sin",
    status: { kind: "recommended" },
    installable: true,
    notInstallableReason: null,
    system: "web",
    compatibilityError: null,
    defaultFsGame: null,
    modes: ["multiplayer"],
    canHost: true,
  },
];

const NO_GAME_FILES: DetectedGameFiles = { ja: [], jo: [] };
const NO_PROFILES: ProfileBook = { profiles: [], defaultProfileId: null };

/** The neutral answer of a command, or `undefined` when it has none. */
export function neutralAnswer(command: string, args: Record<string, unknown> = {}): { value: unknown } | undefined {
  switch (command) {
    case "list_games":
      return { value: GAMES.map((game) => ({ ...game, requiredAssets: [...game.requiredAssets], gametypes: [...game.gametypes] })) };
    case "list_engines": {
      const game = args.game === "ja" || args.game === "jo" ? args.game : null;
      return { value: structuredClone(ENGINES.filter((engine) => game === null || engine.game === game)) };
    }
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
    default:
      return undefined;
  }
}
