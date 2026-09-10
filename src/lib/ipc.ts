/**
 * Typed wrappers over the Rust commands.
 *
 * Every type here mirrors a `serde` structure in `src-tauri/src`. The Rust
 * side renames fields to camelCase, so the names match one to one. Change a
 * command signature in Rust and change it here in the same edit: this file is
 * the only place the frontend is allowed to name a command.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

// --- slice: i18n ---
import type { LanguageSetting } from "../i18n/languages";
import { isTauri, NO_RUNTIME_MESSAGE } from "./runtime";

/**
 * Calls a command, or fails with one readable line outside Tauri.
 *
 * `invoke` reaches into `window.__TAURI_INTERNALS__` and throws a `TypeError`
 * when the page runs in a plain browser. The guard turns that into a rejected
 * promise with a message a screen can print, so `npm run dev` shows the error
 * and empty states instead of a blank page.
 */
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(NO_RUNTIME_MESSAGE));
  return invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// --- slice: game core ---
// The `game` dimension. JKNet launches two games, and every entity that
// differs between them carries this attribute. The entity model is unchanged:
// engine, client, library file.
// ---------------------------------------------------------------------------

/** `src-tauri/src/game.rs`: `ja` is Jedi Academy, `jo` is Jedi Outcast. */
export type Game = "ja" | "jo";

/** Both games, in the order the interface lists them. */
export const GAMES: readonly Game[] = ["ja", "jo"];

/** `src-tauri/src/game.rs`: one game with the names the interface prints. */
export interface GameInfo {
  id: Game;
  /** «Jedi Academy», for a heading or a settings row. */
  displayName: string;
  /** `JA`, for a badge. */
  shortName: string;
  /** The archives `<GameData>\base` must hold. */
  requiredAssets: string[];
  /** The patch the servers run, `null` when every install is equally good. */
  wantedVersion: string | null;
  steamAppId: number;
  serverPort: number;
  // --- slice: game switch ---
  /** `gametype_t` labels in the order of this game's own `bg_public.h`, so the
   * index is the number a server publishes. The **Mode** filter builds its
   * options from this: Jedi Outcast has no Siege and no Power Duel. */
  gametypes: string[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `src-tauri/src/settings.rs`. */
export interface Settings {
  // --- slice: game core ---
  /**
   * The `GameData` folder of each game, confirmed by the user. A game with no
   * entry has not been set up.
   *
   * Replaces the single `gameDataPath` of 0.2, whose value the core files
   * under `ja` the first time it reads an older document.
   */
  gameDataPaths: Partial<Record<Game, string>>;
  /** The game every screen works in. The sidebar switcher writes it next. */
  activeGame: Game;
  // --- slice: i18n ---
  /** `system`, or one of the eight ids in `src/i18n/languages.ts`. */
  language: LanguageSetting;
  /** Client the Play button starts. Not scoped by game yet. */
  defaultClientId: string | null;
  /** The default client of each game, what the switcher slice will read. */
  defaultClientIds: Partial<Record<Game, string>>;
  /** Hide the launcher while the game runs. */
  closeOnLaunch: boolean;
  /** Absolute path that replaces the default data folder. */
  dataDirOverride: string | null;
  /** Tokens appended to every command line, written as in a shortcut. */
  extraLaunchArgs: string;
  /** Servers starred in the browser, as `ip:port`. */
  favoriteServers: string[];
  /** Servers Connect was pressed on, newest first, capped at 50. */
  serverHistory: ServerHistoryEntry[];
  // --- slice: onboarding ---
  /** False until the player has been through the three first-run steps. */
  onboardingCompleted: boolean;
  // --- slice: account ---
  /** JKNet Online, without a trailing slash. */
  onlineUrl: string;
  /** The signed-in account as the service last described it, or `null`. */
  onlineUser: OnlineUser | null;
  /**
   * Always `null` here. The token lives in `settings.json` and on the
   * `Authorization` header the core builds; `get_settings` strips it, so it
   * never reaches this cache. Ask `getAccountState` whether one exists.
   */
  onlineToken?: null;
}

/**
 * `src-tauri/src/settings.rs`: a partial update of the settings.
 *
 * Send the fields you changed and nothing else. A field left out keeps its
 * value on disk, which is what stops the launcher from writing its own cached
 * copy over a `settings.json` edited elsewhere. An explicit `null` clears one
 * of the three nullable fields.
 */
export interface SettingsPatch {
  // --- slice: game core ---
  /**
   * Per-game folders, merged one game at a time. A game the object does not
   * mention keeps its folder; a game mapped to `null` loses it. Send the row
   * that changed, never the whole object.
   */
  gameDataPaths?: Partial<Record<Game, string | null>>;
  activeGame?: Game;
  // --- slice: i18n ---
  /** The core refuses a value that is not `system` or a shipped language. */
  language?: LanguageSetting;
  /** The 0.2 field, still accepted: it writes the `ja` entry above. */
  gameDataPath?: string | null;
  defaultClientId?: string | null;
  /** Per-game default clients, merged the same way as the folders. */
  defaultClientIds?: Partial<Record<Game, string | null>>;
  closeOnLaunch?: boolean;
  dataDirOverride?: string | null;
  extraLaunchArgs?: string;
  favoriteServers?: string[];
  serverHistory?: ServerHistoryEntry[];
  // --- slice: onboarding ---
  onboardingCompleted?: boolean;
  // --- slice: account ---
  /** An `http://` or `https://` address; blank returns to the default service. */
  onlineUrl?: string;
}

/** `src-tauri/src/settings.rs`: one line of `serverHistory`. */
export interface ServerHistoryEntry {
  address: string;
  /** RFC 3339 in UTC. */
  lastConnected: string;
}

/** `src-tauri/src/paths.rs`: the folders JKNet writes into. */
export interface DataPaths {
  /** `%LOCALAPPDATA%\org.jknet.launcher`, the folder with `settings.json`. */
  configRoot: string;
  /** Root of `clients\`, `library\`, `cache\` and `logs\`. */
  dataRoot: string;
}

// ---------------------------------------------------------------------------
// Game files
// ---------------------------------------------------------------------------

export type GameFilesSource = "configured" | "steam" | "gog" | "manual";

export interface AssetFile {
  name: string;
  present: boolean;
  size: number | null;
  // --- slice: game core ---
  /** False for an archive a patch adds; its absence costs a version, not
   * validity. */
  required: boolean;
}

export interface GameFilesCandidate {
  // --- slice: game core ---
  /** The game this folder was checked against. */
  game: Game;
  path: string;
  source: GameFilesSource;
  assets: AssetFile[];
  /** True when every required archive is in place. */
  valid: boolean;
  // --- slice: game core ---
  /** Patch level read off the archives: `1.04`. `null` for Jedi Academy,
   * whose builds carry the same four files. */
  version: string | null;
  /** One sentence about a copy that works but is not what the servers run —
   * a Jedi Outcast install without the 1.04 patch. */
  warning: string | null;
}

// --- slice: game core ---
/** What `detect_game_files` answers with: the candidates of both games. */
export interface DetectedGameFiles {
  ja: GameFilesCandidate[];
  jo: GameFilesCandidate[];
}

// ---------------------------------------------------------------------------
// Engines and clients
// ---------------------------------------------------------------------------

/**
 * How much of a bet an engine is, and why.
 *
 * One build of each game is `recommended` and the New client dialog preselects
 * it; the rest are `supported`. A `legacy` build is one nobody maintains any
 * more: it stays in the list and stays installable, because a server may still
 * ask for it, and it carries the catalog key of a sentence saying what the
 * player is in for. The key is a key and not English text so that the warning
 * arrives in the language of the interface.
 */
export type EngineStatus =
  | { kind: "recommended" }
  | { kind: "supported" }
  | { kind: "legacy"; noteKey: string };

/** A community build of the game client. */
export interface Engine {
  id: string;
  // --- slice: game core ---
  /** The game this build plays. An engine belongs to exactly one. */
  game: Game;
  name: string;
  description: string;
  executable: string;
  repo: string;
  /** Recommended, merely supported, or legacy with a note saying why. */
  status: EngineStatus;
  /** False when the project publishes no archive JKNet can install. */
  installable: boolean;
  /** Why `installable` is false. */
  notInstallableReason: string | null;
  /** Mod folder the build needs as `+set fs_game`. jaMME runs in `mme`. */
  defaultFsGame: string | null;
}

/** A named instance of an engine with its own files and settings. */
export interface Client {
  id: string;
  name: string;
  engineId: string;
  // --- slice: game core ---
  /** The game this client plays, always the game of its engine. */
  game: Game;
  engineVersion: string | null;
  createdAt: string;
  /** RFC 3339 time the engine was unpacked. */
  engineInstalledAt: string | null;
  /** RFC 3339 publication time of the installed release. */
  enginePublishedAt: string | null;
  /** Mod folder the client starts in, `+set fs_game`. */
  fsGame: string | null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const ipc = {
  getSettings: () => call<Settings>("get_settings"),
  /** Applies a patch and answers with the whole document as it landed. */
  updateSettings: (patch: SettingsPatch) =>
    call<Settings>("update_settings", { patch }),
  getDataPaths: () => call<DataPaths>("get_data_paths"),

  // --- slice: game core ---
  /** Both games with the names the interface prints. Static, ask once. */
  listGames: () => call<GameInfo[]>("list_games"),

  /** Candidates of both games at once, best first within each. */
  detectGameFiles: () => call<DetectedGameFiles>("detect_game_files"),
  /**
   * Checks one folder against one game.
   *
   * Called `inspect_game_files` until 0.3, when it gained the game: a Jedi
   * Outcast folder and a Jedi Academy folder look alike from the outside, and
   * a check that guessed would call the wrong copy broken.
   */
  validateGameData: (game: Game, path: string) =>
    call<GameFilesCandidate>("validate_game_data", { game, path }),

  /** Every engine, or the engines of one game. The registry is static, so the
   * screens ask once without a game and filter the answer themselves. */
  listEngines: (game?: Game) => call<Engine[]>("list_engines", { game: game ?? null }),

  listClients: () => call<Client[]>("list_clients"),
  createClient: (name: string, engineId: string, game: Game) =>
    call<Client>("create_client", { name, engineId, game }),
  /**
   * Changes the name, the mod folder, or both. A field left out keeps its
   * value; an empty `fsGame` clears it back to the default of the engine.
   */
  updateClient: (
    clientId: string,
    changes: { name?: string; fsGame?: string },
  ) =>
    call<Client>("update_client", {
      clientId,
      name: changes.name ?? null,
      fsGame: changes.fsGame ?? null,
    }),
  deleteClient: (id: string) => call<void>("delete_client", { id }),

  // `launchClient` moved to `launchIpc` below when it stopped being a stub.
  // The library commands live in `libraryIpc` and the server browser in
  // `serversIpc` below, for the same reason.
};

// --- slice: i18n ---
/**
 * A refusal from the core, as `src-tauri/src/error.rs` serializes it.
 *
 * `message` is the rendered English sentence and is always safe to print.
 * `code` names a key of the `errors` namespace and `details` fills its
 * placeholders, which is what `translateError` in `src/i18n/errors.ts` needs.
 */
export interface AppErrorEnvelope {
  /** The `AppError` variant, in camelCase. Empty when the throw was not one. */
  code: string;
  /** The rendered English sentence. Empty only for a throw with no message. */
  message: string;
  /** The values the message interpolates. Empty object when there are none. */
  details: Record<string, unknown>;
}

/** Reads the envelope out of whatever a rejected promise threw. */
export function errorEnvelope(error: unknown): AppErrorEnvelope {
  if (error !== null && typeof error === "object") {
    const shape = error as Partial<AppErrorEnvelope>;
    if (typeof shape.code === "string" && typeof shape.message === "string") {
      const details =
        shape.details !== null && typeof shape.details === "object"
          ? (shape.details as Record<string, unknown>)
          : {};
      return { code: shape.code, message: shape.message, details };
    }
    if (error instanceof Error) {
      return { code: "", message: error.message, details: {} };
    }
  }
  // A plain string is what the core answered before 0.4 and what a hand-written
  // `reject` in the mock service still answers, so it stays readable.
  if (typeof error === "string") {
    const service = /^online ([a-z_]+): (.*)$/s.exec(error);
    if (service) {
      return {
        code: "online",
        message: error,
        details: { code: service[1], message: service[2] },
      };
    }
    return { code: "", message: error, details: {} };
  }
  return { code: "", message: "", details: {} };
}

/**
 * Turns whatever a rejected command threw into an English line.
 *
 * This is the line for the console and the log file, and the fallback the
 * translation layer prints when a code has no catalog key. A screen shows
 * `useErrorText` from `src/i18n/errors.ts` instead.
 */
export function errorMessage(error: unknown): string {
  const { message } = errorEnvelope(error);
  return message === "" ? "Unexpected error" : message;
}

// --- slice: library ---------------------------------------------------------
//
// The pk3 files of one client, `src-tauri/src/library.rs`. Everything here is
// scoped to a client id: a library file lives in `clients\<slug>\home\`, so
// there is no launcher-wide list to ask for.

/** What kind of content a pk3 holds. */
export type LibraryCategory =
  | "skin"
  | "hilt"
  | "map"
  | "mod"
  | "hud"
  | "sound"
  | "other";

/** One pk3 in the home folder of one client. */
export interface LibraryItem {
  /** `<folder>/<file name>`, stable across the enable toggle. */
  id: string;
  /** `base` or the `fs_game` folder the file belongs to. */
  folder: string;
  /** File name with the `.pk3` extension, without `.disabled`. */
  fileName: string;
  displayName: string;
  category: LibraryCategory;
  size: number;
  enabled: boolean;
  addedAt: string;
  /** `local` for a file added from disk, `jkhub` for one installed here. */
  source: string | null;
  sha1: string | null;
  notes: string | null;
  // --- slice: jkhub ---
  /** What the JKHub tab wrote down when it installed the file. */
  provenance?: JkhubProvenance | null;
}

/** What `inspect_pk3` reads out of an archive without installing it. */
export interface Pk3Report {
  path: string;
  fileName: string;
  category: LibraryCategory;
  entryCount: number;
  notableEntries: string[];
  size: number;
  sha1: string;
  topLevel: string[];
}

/** A file `add_library_files` refused, with the reason to print. */
export interface SkippedFile {
  path: string;
  fileName: string;
  reason: string;
  /** Free file name to retry with, set when the name was taken. */
  suggestedName: string | null;
  /** Id of the item that already holds the same bytes. */
  existingId: string | null;
}

export interface AddResult {
  added: LibraryItem[];
  skipped: SkippedFile[];
}

/** One internal path that more than one enabled archive carries. */
export interface LibraryConflict {
  path: string;
  folder: string;
  /** Item ids in the engine's load order. */
  files: string[];
  /** The item the engine actually reads: the last one loaded. */
  winner: string;
}

export interface ConflictReport {
  conflicts: LibraryConflict[];
  total: number;
  truncated: boolean;
  /** Ids of every item taking part in a conflict. */
  files: string[];
}

/** Payload of the `library:changed` event. */
export interface LibraryChanged {
  clientId: string;
}

/** Emitted by the core after every change to a client's library. */
export const LIBRARY_CHANGED_EVENT = "library:changed";

export const libraryIpc = {
  listLibrary: (clientId: string) =>
    call<LibraryItem[]>("list_library", { clientId }),
  inspectPk3: (path: string) => call<Pk3Report>("inspect_pk3", { path }),
  addLibraryFiles: (clientId: string, paths: string[], folder?: string) =>
    call<AddResult>("add_library_files", {
      clientId,
      paths,
      folder: folder ?? null,
    }),
  setLibraryItemEnabled: (clientId: string, id: string, enabled: boolean) =>
    call<LibraryItem>("set_library_item_enabled", { clientId, id, enabled }),
  removeLibraryItem: (clientId: string, id: string) =>
    call<void>("remove_library_item", { clientId, id }),
  renameLibraryItem: (clientId: string, id: string, displayName: string) =>
    call<LibraryItem>("rename_library_item", { clientId, id, displayName }),
  findLibraryConflicts: (clientId: string) =>
    call<ConflictReport>("find_library_conflicts", { clientId }),
};

// ---------------------------------------------------------------------------
// --- slice: launch ---
//
// Installing an engine and starting a game. These live in their own object
// rather than inside `ipc` so that two branches adding commands at the same
// time do not collide on the same closing brace.
// ---------------------------------------------------------------------------

/** `src-tauri/src/engines.rs`: one release reduced to its Windows archive. */
export interface EngineRelease {
  /** Git tag, written into `client.json` as the installed version. */
  tag: string;
  name: string;
  /** RFC 3339, empty when GitHub reports none. */
  publishedAt: string;
  prerelease: boolean;
  assetName: string;
  assetSize: number;
  assetUrl: string;
}

/** `src-tauri/src/engines.rs`: the answer of `check_engine_update`. */
export interface EngineUpdate {
  installed: string | null;
  latest: string | null;
  latestPublishedAt: string | null;
  updateAvailable: boolean;
}

/** `src-tauri/src/launch.rs`: the one game JKNet started. */
export interface RunningGame {
  clientId: string;
  pid: number;
  /** RFC 3339 start time. */
  startedAt: string;
}

/** Phase of `launch:engine-install-progress`. */
export type InstallPhase = "download" | "extract" | "done" | "error";

/** Payload of `launch:engine-install-progress`. */
export interface EngineInstallProgress {
  clientId: string;
  phase: InstallPhase;
  downloaded: number;
  /** Zero when the server sent no content length. */
  total: number;
  message: string;
}

/** Payload of `launch:game-started`. */
export interface GameStarted {
  clientId: string;
  pid: number;
  // --- slice: friends ---
  /** The `+connect` address, or `null` when the game opened on its menu. */
  connect: string | null;
}

/** Payload of `launch:game-exited`. */
export interface GameExited {
  clientId: string;
  exitCode: number | null;
}

/** Event names the launch slice emits. */
export const launchEvents = {
  installProgress: "launch:engine-install-progress",
  gameStarted: "launch:game-started",
  gameExited: "launch:game-exited",
} as const;

export const launchIpc = {
  listEngineReleases: (engineId: string) =>
    call<EngineRelease[]>("list_engine_releases", { engineId }),
  installEngine: (clientId: string, tag?: string) =>
    call<Client>("install_engine", { clientId, tag: tag ?? null }),
  checkEngineUpdate: (clientId: string) =>
    call<EngineUpdate>("check_engine_update", { clientId }),

  launchClient: (clientId: string, connect?: string, extraArgs: string[] = []) =>
    call<RunningGame>("launch_client", {
      clientId,
      connect: connect ?? null,
      extraArgs,
    }),
  getRunningGame: () => call<RunningGame | null>("get_running_game"),
  stopGame: () => call<void>("stop_game"),
};
// ---------------------------------------------------------------------------
// --- slice: servers ---
// ---------------------------------------------------------------------------

/**
 * Where the human and bot counts of a row came from.
 *
 * - `info` — `g_humanplayers` of the `getinfo`, or a server with no clients.
 * - `status` — the extra `getstatus` of a refresh, where a bot has ping 0.
 * - `unknown` — the server answered neither question; `clients` is all there
 *   is, and it still contains the bots.
 */
export type PlayersSource = "info" | "status" | "unknown";

/** `src-tauri/src/servers/mod.rs`: one row of the browser. */
export interface ServerInfo {
  // --- slice: game core ---
  /** Which game this server runs. A row comes from the master list of one
   * game, so it is never in doubt. */
  game: Game;
  /** `ip:port`, the key of the row everywhere in the launcher. */
  address: string;
  /** Host name as the server sent it, `^1`-style colour codes included. */
  hostnameRaw: string;
  /** The same name with the colour codes removed. */
  hostnameClean: string;
  map: string;
  gametype: number;
  /** Label of `gametype`, or `Mode <n>` for a number a mod invented. */
  gametypeLabel: string;
  /** Players the server counts, bots included. Not what the browser shows. */
  clients: number;
  /**
   * Real players: what every count, filter and sort means by "players".
   * `null` while `playersSource` is `unknown`.
   */
  humans: number | null;
  /** Bots among the `clients`. `null` alongside an unknown `humans`. */
  bots: number | null;
  /** How `humans` and `bots` were established. */
  playersSource: PlayersSource;
  maxClients: number;
  needpass: boolean;
  // --- slice: game core ---
  /** `fs_game`, `base` when the server runs no mod. Called `game` until 0.3,
   * when that name went to the field above. */
  modName: string;
  /** 26 is Jedi Academy 1.01; 15 and 16 are Jedi Outcast 1.02/1.03 and 1.04. */
  protocol: number;
  pingMs: number;
  /** Listed in the bundled `trusted_servers.json`. */
  trusted: boolean;
  /** Starred by the player. */
  favorite: boolean;
  /** RFC 3339 in UTC. */
  lastSeen: string;
}

/** `src-tauri/src/servers/mod.rs`: a vouched-for community server. */
export interface TrustedServer {
  address: string;
  name: string;
  community: string;
  url: string;
}

/** One player of a `getstatus` answer. */
export interface ServerPlayer {
  nameRaw: string;
  nameClean: string;
  score: number;
  /** Ping the server measures, which is the player's, not the launcher's. */
  ping: number;
  /** Ping 0, which the engine writes for bots and for nothing else. */
  isBot: boolean;
}

/** The answer of `get_server_status`. */
export interface ServerStatus {
  address: string;
  /** The server's whole `serverinfo`, keys lowercased. */
  info: Record<string, string>;
  players: ServerPlayer[];
}

/** Payload of the `servers:batch` event. */
export interface ServersBatchEvent {
  // --- slice: game core ---
  /** The game being refreshed: the event names stayed, the payload says
   * whose rows these are. */
  game: Game;
  servers: ServerInfo[];
}

/** Payload of the `servers:done` event, emitted once per refresh. */
export interface ServersDoneEvent {
  // --- slice: game core ---
  game: Game;
  /** Addresses the masters returned. */
  total: number;
  /** How many of them answered `getinfo`. */
  responded: number;
  elapsedMs: number;
}

/**
 * The server browser.
 *
 * --- slice: game core ---
 * Every call takes an optional `game`. Leaving it out means the active game,
 * which the core reads from the settings, so a screen that has not been scoped
 * yet keeps working.
 */
export const serversIpc = {
  getCachedServers: (game?: Game) =>
    call<ServerInfo[]>("get_cached_servers", { game: game ?? null }),
  /** `masters` overrides the stock master servers of the game. */
  refreshServers: (game?: Game, masters?: string[]) =>
    call<ServerInfo[]>("refresh_servers", {
      game: game ?? null,
      masters: masters ?? null,
    }),
  getServerStatus: (address: string, game?: Game) =>
    call<ServerStatus>("get_server_status", { address, game: game ?? null }),
  listTrustedServers: () => call<TrustedServer[]>("list_trusted_servers"),
  setServerFavorite: (address: string, favorite: boolean, game?: Game) =>
    call<Settings>("set_server_favorite", { address, favorite, game: game ?? null }),
  addServerHistory: (address: string, game?: Game) =>
    call<Settings>("add_server_history", { address, game: game ?? null }),
};

// ---------------------------------------------------------------------------
// --- slice: maps ---
// ---------------------------------------------------------------------------

/** `src-tauri/src/levelshots.rs`: the picture of one map. */
export interface Levelshot {
  /** Absolute path inside `cache\levelshots\`. Turn it into a URL with
   * `levelshotUrl` before putting it in an `<img>`. */
  path: string;
  width: number;
  height: number;
}

/** `src-tauri/src/levelshots.rs`: what one rebuild of the index did. */
export interface LevelshotStats {
  /** Pictures in the index afterwards. */
  maps: number;
  /** pk3 files and loose pictures that were read. */
  sources: number;
  elapsedMs: number;
}

export const levelshotsIpc = {
  /**
   * `null` when nothing the player owns has a picture of this map.
   *
   * --- slice: game core ---
   * `game` says whose map it is; leaving it out means the active game. The
   * same name is a different picture in the two games — `ffa_bespin` exists in
   * both — so the index keys on `<game>/<map>` and so does this call.
   */
  getLevelshot: (map: string, game?: Game) =>
    call<Levelshot | null>("get_levelshot", { map, game: game ?? null }),
  rebuildLevelshots: () => call<LevelshotStats>("rebuild_levelshots"),
  /** Every indexed map, as `<game>/<map>` keys. */
  listLevelshots: () => call<string[]>("list_levelshots"),
};

/**
 * Turns a cached picture into a URL the webview may load.
 *
 * `convertFileSrc` answers `http://asset.localhost/<path>` on Windows and
 * `asset://localhost/<path>` elsewhere. The protocol is enabled in
 * `tauri.conf.json` and scoped to `cache\levelshots\` alone, so no other file
 * on the disk can be addressed this way. Outside Tauri the function reaches
 * into `window.__TAURI_INTERNALS__` and throws, hence the guard: the browser
 * preview shows the placeholder instead of a broken image.
 */
export function levelshotUrl(path: string): string | null {
  if (!isTauri()) return null;
  return convertFileSrc(path);
}

// ---------------------------------------------------------------------------
// --- slice: account ---
//
// Signing in to JKNet Online, `src-tauri/src/account.rs` and
// `src-tauri/src/online/`. The bearer token is deliberately absent from every
// type here: it is written into `settings.json` by the core and put on the
// requests by the core, and the frontend is only ever told whether one exists.
// ---------------------------------------------------------------------------

/** `src-tauri/src/online/types.rs`: an account on the service. */
export interface OnlineUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** `jkhub`, `discord` or `dev`. */
  provider: string;
  /** The name the provider knows the player by, such as a JKHub login. */
  providerName: string;
  /** RFC 3339 in UTC. */
  createdAt: string;
}

/** The sign-in providers the contract has. */
export type OnlineProvider = "jkhub" | "discord" | "dev";

/** `src-tauri/src/account.rs`: what the frontend knows about the account. */
export interface AccountState {
  /**
   * Whether this build has a service to talk to at all.
   *
   * False in a release build until the JKNet Online service is deployed and
   * `RELEASE_ONLINE_URL` in `src-tauri/src/online/client.rs` names its origin. While
   * it is false the account and friends interface is one sentence saying so:
   * no provider buttons, no counters, no calls. The **JKNet Online address** field on
   * the Settings screen turns it on for this machine.
   */
  onlineConfigured: boolean;
  /**
   * Whether a token is on file. It does not promise the service still accepts it:
   * finding that out costs a request, and the sidebar paints before one could
   * answer. Always false while `onlineConfigured` is false.
   */
  onlineSignedIn: boolean;
  onlineUser: OnlineUser | null;
  /** The service the launcher talks to, or an empty string when there is none. */
  onlineUrl: string;
  /** Whether the service runs on this machine, which is what shows the Developer
   *  sign-in button. */
  localOnline: boolean;
}

/** `src-tauri/src/account.rs`: the session `begin_sign_in` opened. */
export interface SignInStart {
  sessionId: string;
  /** Already opened in the system browser by the command; kept so a player
   *  whose browser stayed shut can be told where to go. */
  url: string;
}

/** One read of a sign-in session. */
export interface SignInPoll {
  status: "pending" | "done" | "error" | "expired";
  /** Set on `done`, when the core has stored the token. */
  user: OnlineUser | null;
  /** Set on `error`. */
  error: string | null;
}

/**
 * Why the account changed.
 *
 * `expired` is the only one nobody asked for: the service answered `401` to a call
 * that carried the stored token, so the core forgot it. That is the one worth a
 * message on screen — the others are the answer to something the player just
 * did.
 */
export type AccountChangeReason =
  | "signedIn"
  | "signedOut"
  | "renamed"
  | "deleted"
  | "expired";

/** Payload of `account:changed`. */
export interface AccountChanged {
  signedIn: boolean;
  reason: AccountChangeReason;
}

/** Emitted by the core after every sign-in, sign-out and rename. */
export const ACCOUNT_CHANGED_EVENT = "account:changed";

export const accountIpc = {
  getAccountState: () => call<AccountState>("get_account_state"),
  /** Opens a session and sends the player to the browser. */
  beginSignIn: (provider: OnlineProvider) =>
    call<SignInStart>("begin_sign_in", { provider }),
  /** Reads a session once. On `done` the core has already stored the token. */
  pollSignIn: (sessionId: string) =>
    call<SignInPoll>("poll_sign_in", { sessionId }),
  signOut: () => call<void>("sign_out"),
  updateDisplayName: (displayName: string) =>
    call<OnlineUser>("update_display_name", { displayName }),
  deleteAccount: () => call<void>("delete_account"),
};

/**
 * The contract's error code inside a refusal from the service, or `null`.
 *
 * `AppError` reaches the frontend as one rendered string, and the service variant
 * renders as `online <code>: <message>`. The screens need the code — a
 * `provider_error` keeps the guest button and a `conflict` asks for another
 * name — so this reads it back out rather than every screen matching on the
 * wording of a message the service wrote.
 */
export function onlineErrorCode(error: unknown): string | null {
  // --- slice: i18n --- the envelope carries the contract code in `details`;
  // the prefix of the rendered message is the fallback for a throw that never
  // went through `AppError`.
  const envelope = errorEnvelope(error);
  if (envelope.code === "online" && typeof envelope.details.code === "string") {
    return envelope.details.code;
  }
  const match = /^online ([a-z_]+): /.exec(envelope.message);
  return match ? match[1] : null;
}

/** The same message without the `online <code>:` prefix, for printing. */
export function onlineErrorMessage(error: unknown): string {
  return errorMessage(error).replace(/^online [a-z_]+: /, "");
}

// --- slice: online gate ---

/**
 * The code `AppError::OnlineNotConfigured` carries.
 *
 * Not one of the contract's own codes: it never leaves the launcher. The core
 * answers it instead of opening a socket when this build has no service address.
 */
export const ONLINE_NOT_CONFIGURED = "online_not_configured";

/**
 * Whether a refusal means "this build has no service" rather than a failure.
 *
 * Read `onlineConfigured` from `getAccountState` to decide what to draw; this is
 * for the calls that were already in flight when the answer changed, so a
 * screen prints the same sentence instead of a network error.
 */
export function isOnlineNotConfigured(error: unknown): boolean {
  return onlineErrorCode(error) === ONLINE_NOT_CONFIGURED;
}

// --- slice: i18n ---
// The sentence itself moved to `account.notConfigured` in the catalogs. It
// appears on the Account card, the Friends screen and the third step of the
// first run, and all three read that one key.

// ---------------------------------------------------------------------------
// --- slice: friends ---
//
// Friends, presence and invites, `src-tauri/src/friends/`. The types below
// mirror `src-tauri/src/online/types.rs`, which in turn mirrors the `## Types`
// table of the service contract, so the three stay readable side by side. The
// launcher never talks to the service from the frontend: a token in a webview is a
// token in the devtools network tab.
// ---------------------------------------------------------------------------

/**
 * Calls a friends command, or the mock service when the page is in a browser.
 *
 * The Friends screen is nothing but commands, so outside Tauri it would be one
 * error line and no layout at all. In a development build the call goes to
 * `scripts/mock-online.mjs` over `fetch` instead; `import.meta.env.DEV` is a
 * compile-time constant, so both the branch and `devOnline.ts` behind it are gone
 * from a production bundle. Inside Tauri nothing changes.
 */
function callFriends<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (import.meta.env.DEV && !isTauri()) {
    return import("./devOnline").then((module) => module.devFriends<T>(command, args));
  }
  return call<T>(command, args);
}

/** Where a player is. `offline` is derived by the service from a missed heartbeat. */
export type PresenceStatus = "online" | "in_game" | "offline";

export interface Presence {
  status: PresenceStatus;
  /** `ip:port` of the server, when the player joined one from JKNet. */
  serverAddress: string | null;
  /** Host name of that server, colour codes removed. */
  serverName: string | null;
  /** Name of the JKNet client they started. */
  clientName: string | null;
  /** RFC 3339 time the status last changed. */
  since: string;
}

export interface Friend {
  user: OnlineUser;
  presence: Presence;
  friendsSince: string;
}

/** A friend request; which list it is in says whether it is mine to accept. */
export interface FriendRequest {
  id: string;
  from: OnlineUser;
  to: OnlineUser;
  createdAt: string;
}

export interface Invite {
  id: string;
  from: OnlineUser;
  serverAddress: string;
  serverName: string | null;
  message: string | null;
  createdAt: string;
  /** The service drops an invite ten minutes after it was made. */
  expiresAt: string;
}

/** `src-tauri/src/friends/mod.rs`: everything the Friends screen renders. */
export interface FriendsView {
  /** False while nobody is signed in. The lists are then empty, not absent. */
  signedIn: boolean;
  /** Whether the live socket is up; false means updates arrive on a timer. */
  live: boolean;
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  /** Invites addressed to me, newest first. */
  invites: Invite[];
  /** What the launcher reports about me. */
  presence: Presence;
}

/** The answer of `send_friend_request`. */
export interface RequestSent {
  /** `requested`, or `accepted` when they had already asked me. */
  outcome: "requested" | "accepted";
  displayName: string;
  state: FriendsView;
}

/** Payload of `friends:presence`. */
export interface PresenceUpdated {
  userId: string;
  presence: Presence;
}

/** Event names the friends slice emits. */
export const friendsEvents = {
  /** A nudge with no payload: read the lists again. */
  changed: "friends:changed",
  /** One friend moved: patch one row. */
  presence: "friends:presence",
  /** An `Invite` arrived. */
  invite: "friends:invite",
} as const;

export const friendsIpc = {
  getFriendsState: () => callFriends<FriendsView>("get_friends_state"),
  /** `query` is a display name, `provider:name` or a user id. */
  sendFriendRequest: (query: string) =>
    callFriends<RequestSent>("send_friend_request", { query }),
  acceptFriendRequest: (id: string) =>
    callFriends<FriendsView>("accept_friend_request", { id }),
  /** Declines a request sent to me, or cancels one I sent. */
  declineFriendRequest: (id: string) =>
    callFriends<FriendsView>("decline_friend_request", { id }),
  removeFriend: (userId: string) => callFriends<FriendsView>("remove_friend", { userId }),
  sendInvite: (
    toUserId: string,
    serverAddress: string,
    serverName?: string | null,
    message?: string | null,
  ) =>
    callFriends<Invite>("send_invite", {
      toUserId,
      serverAddress,
      serverName: serverName ?? null,
      message: message ?? null,
    }),
  dismissInvite: (id: string) => callFriends<FriendsView>("dismiss_invite", { id }),
  /** Starts the default client on the server that friend is playing on. */
  joinFriend: (userId: string) => callFriends<RunningGame>("join_friend", { userId }),
};

// --- slice: jkhub -----------------------------------------------------------
//
// Browsing jkhub.org from inside the launcher. Types mirror
// `src-tauri/src/jkhub/types.rs` one to one.

/**
 * Which game a category or a file on JKHub belongs to.
 *
 * Not the game the player browses in — that one is a `Game`, and every JKHub
 * call takes it as one. This says whose shelf a category or a file sits on,
 * and the site has a third answer for that: `Both Games/Other` is a root of
 * its own, and what is under it belongs to both games. The first two ids are
 * the ids of `Game`.
 */
export type JkhubGame = Game | "both";

/** How a listing is ordered. Maps to the `sortby` parameter of the site. */
export type JkhubSort =
  | "recentlyUpdated"
  | "newest"
  | "mostDownloaded"
  | "topRated"
  | "name";

export interface JkhubCategory {
  id: number;
  slug: string;
  name: string;
  /** `null` for a root of the tree. */
  parentId: number | null;
  game: JkhubGame;
  /** Files in the category, `null` when the site printed no count. */
  fileCount: number | null;
  /** False for a container such as Maps, which holds only children. */
  hasFiles: boolean;
  url: string;
}

export interface JkhubCategories {
  /** The game the tree was walked for: one of the launcher's two. */
  game: Game;
  /** Depth first: a root, then its children, then theirs. */
  categories: JkhubCategory[];
  fetchedAt: string;
  /** True when the site was unreachable and this came out of the cache. */
  stale: boolean;
}

export interface JkhubAuthor {
  name: string;
  url: string | null;
  avatarUrl: string | null;
}

export interface JkhubRating {
  value: number;
  count: number;
}

export interface JkhubScreenshot {
  url: string;
  thumbnailUrl: string | null;
}

export interface JkhubChangelogEntry {
  version: string;
  url: string | null;
}

/** One card of a listing. A card carries less than a file page. */
export interface JkhubCardData {
  id: number;
  slug: string;
  title: string;
  url: string;
  author: JkhubAuthor | null;
  thumbnailUrl: string | null;
  description: string;
  downloads: number | null;
  date: string | null;
  /** `Updated` or `Submitted`: which date the card printed. */
  dateLabel: string | null;
  tags: string[];
  rating: JkhubRating | null;
}

export interface JkhubListing {
  categoryId: number;
  sort: JkhubSort;
  page: number;
  pages: number;
  perPage: number;
  cards: JkhubCardData[];
  fetchedAt: string;
  stale: boolean;
}

/** Everything a file page carries. `jkhub_file` adds `fetchedAt` and `stale`. */
export interface JkhubFile {
  id: number;
  slug: string;
  title: string;
  url: string;
  game: JkhubGame;
  categoryId: number | null;
  categoryName: string | null;
  author: JkhubAuthor | null;
  /** Plain text from JSON-LD. Never render it as HTML: there is no sanitizer. */
  description: string;
  submittedAt: string | null;
  updatedAt: string | null;
  version: string | null;
  views: number;
  downloads: number;
  comments: number;
  reviews: number;
  rating: JkhubRating | null;
  screenshots: JkhubScreenshot[];
  tags: string[];
  changelog: JkhubChangelogEntry[];
  fetchedAt: string;
  stale: boolean;
}

/** Where the download button of a file leads. */
export type JkhubDownload =
  | {
      kind: "hosted";
      url: string;
      fileName: string;
      size: number | null;
      contentType: string | null;
    }
  | { kind: "external"; url: string };

/**
 * What became of an install.
 *
 * Four of the five are answers rather than failures: the player decides what
 * happens next, and a list of names does not fit into an error string.
 */
export type JkhubInstallOutcome =
  | { kind: "installed"; files: string[] }
  | { kind: "conflicts"; files: string[] }
  | { kind: "noPk3Files"; entries: string[]; archivePath: string }
  | { kind: "external"; url: string }
  | {
      kind: "unsupported";
      format: string;
      archivePath: string | null;
      url: string;
    };

export type JkhubInstallResult = JkhubInstallOutcome & {
  fileId: number;
  clientId: string;
  /** Folder inside `home\` the files went to. */
  folder: string;
};

/** What `provenance.json` remembers about one installed file. */
export interface JkhubProvenance {
  source: string;
  fileId: number;
  version: string | null;
  updatedAt: string | null;
  installedAt: string;
  title: string;
  url: string;
}

/** Payload of `jkhub:download-progress`. */
export interface JkhubDownloadProgress {
  fileId: number;
  received: number;
  /** Zero when the server sent no length. */
  total: number;
}

/** Payload of `jkhub:installed`. */
export interface JkhubInstalled {
  fileId: number;
  clientId: string;
  files: string[];
}

/**
 * Payload of `jkhub:categories-updated`.
 *
 * Sent when the walk the core started behind an answer produced a newer tree.
 * Carries the game and nothing else: the screen refetches that one tree.
 */
export interface JkhubCategoriesUpdated {
  game: Game;
}

export const jkhubEvents = {
  downloadProgress: "jkhub:download-progress",
  installed: "jkhub:installed",
  categoriesUpdated: "jkhub:categories-updated",
} as const;

/**
 * The JKHub catalogue.
 *
 * --- slice: game core ---
 * The two calls that depend on a game take an optional one, the way the server
 * browser and the map pictures do: leaving it out means the active game, which
 * the core reads from the settings.
 */
export const jkhubIpc = {
  /**
   * The category tree of one game.
   *
   * Answers from the disk cache or from the tree bundled with the build and
   * walks the site behind the answer, which arrives as
   * `jkhub:categories-updated`. `refresh` is **Update categories**: it walks
   * before answering and takes about twenty requests.
   */
  categories: (game?: Game, refresh = false) =>
    call<JkhubCategories>("jkhub_categories", { game: game ?? null, refresh }),
  /** `game` names the tree the category's slug is read from. */
  list: (
    categoryId: number,
    sort: JkhubSort,
    page: number,
    game?: Game,
    refresh = false,
  ) =>
    call<JkhubListing>("jkhub_list", {
      game: game ?? null,
      categoryId,
      sort,
      page,
      refresh,
    }),
  file: (id: number, refresh = false) =>
    call<JkhubFile>("jkhub_file", { id, refresh }),
  /** Follows the download button without fetching the archive. */
  resolveDownload: (id: number) =>
    call<JkhubDownload>("jkhub_resolve_download", { id }),
  /** Downloads if needed and installs into a client. */
  install: (id: number, clientId: string, replace = false) =>
    call<JkhubInstallResult>("jkhub_install", { id, clientId, replace }),
  /** Opens the file page in the system browser. */
  open: (id: number) => call<void>("jkhub_open", { id }),
  clearCache: () => call<void>("jkhub_clear_cache"),
};
