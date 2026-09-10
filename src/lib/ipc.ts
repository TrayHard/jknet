/**
 * Typed wrappers over the Rust commands.
 *
 * Every type here mirrors a `serde` structure in `src-tauri/src`. The Rust
 * side renames fields to camelCase, so the names match one to one. Change a
 * command signature in Rust and change it here in the same edit: this file is
 * the only place the frontend is allowed to name a command.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

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
// Settings
// ---------------------------------------------------------------------------

/** `src-tauri/src/settings.rs`. */
export interface Settings {
  /** Folder with `base\assets0.pk3`..`assets3.pk3`, confirmed by the user. */
  gameDataPath: string | null;
  /** Client the Play button starts. */
  defaultClientId: string | null;
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
  /** The JKNet hub this launcher talks to, without a trailing slash. */
  hubUrl: string;
  /** The signed-in account as the hub last described it, or `null`. */
  hubUser: HubUser | null;
  /**
   * Always `null` here. The token lives in `settings.json` and on the
   * `Authorization` header the core builds; `get_settings` strips it, so it
   * never reaches this cache. Ask `getAccountState` whether one exists.
   */
  hubToken?: null;
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
  gameDataPath?: string | null;
  defaultClientId?: string | null;
  closeOnLaunch?: boolean;
  dataDirOverride?: string | null;
  extraLaunchArgs?: string;
  favoriteServers?: string[];
  serverHistory?: ServerHistoryEntry[];
  // --- slice: onboarding ---
  onboardingCompleted?: boolean;
  // --- slice: account ---
  /** An `http://` or `https://` address; blank returns to the default hub. */
  hubUrl?: string;
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
}

export interface GameFilesCandidate {
  path: string;
  source: GameFilesSource;
  assets: AssetFile[];
  /** True when all four asset archives are in place. */
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Engines and clients
// ---------------------------------------------------------------------------

/** A community build of the game client. */
export interface Engine {
  id: string;
  name: string;
  description: string;
  executable: string;
  repo: string;
  recommended: boolean;
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

  detectGameFiles: () => call<GameFilesCandidate[]>("detect_game_files"),
  inspectGameFiles: (path: string) =>
    call<GameFilesCandidate>("inspect_game_files", { path }),

  listEngines: () => call<Engine[]>("list_engines"),

  listClients: () => call<Client[]>("list_clients"),
  createClient: (name: string, engineId: string) =>
    call<Client>("create_client", { name, engineId }),
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

/**
 * Turns whatever a rejected command threw into a line for the user.
 *
 * `AppError` reaches the frontend as a plain string, so the common case is the
 * first branch; the rest is defence against a panic or a transport failure.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
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
  /** `local` for a file added from disk, a JKHub reference later. */
  source: string | null;
  sha1: string | null;
  notes: string | null;
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
  /** `fs_game`, `base` when the server runs no mod. */
  game: string;
  /** 26 is Jedi Academy 1.01. */
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
  servers: ServerInfo[];
}

/** Payload of the `servers:done` event, emitted once per refresh. */
export interface ServersDoneEvent {
  /** Addresses the masters returned. */
  total: number;
  /** How many of them answered `getinfo`. */
  responded: number;
  elapsedMs: number;
}

export const serversIpc = {
  getCachedServers: () => call<ServerInfo[]>("get_cached_servers"),
  /** `masters` overrides the two stock master servers. */
  refreshServers: (masters?: string[]) =>
    call<ServerInfo[]>("refresh_servers", { masters: masters ?? null }),
  getServerStatus: (address: string) =>
    call<ServerStatus>("get_server_status", { address }),
  listTrustedServers: () => call<TrustedServer[]>("list_trusted_servers"),
  setServerFavorite: (address: string, favorite: boolean) =>
    call<Settings>("set_server_favorite", { address, favorite }),
  addServerHistory: (address: string) =>
    call<Settings>("add_server_history", { address }),
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
  /** `null` when nothing the player owns has a picture of this map. */
  getLevelshot: (map: string) =>
    call<Levelshot | null>("get_levelshot", { map }),
  rebuildLevelshots: () => call<LevelshotStats>("rebuild_levelshots"),
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
// Signing in to the JKNet hub, `src-tauri/src/account.rs` and
// `src-tauri/src/hub/`. The bearer token is deliberately absent from every
// type here: it is written into `settings.json` by the core and put on the
// requests by the core, and the frontend is only ever told whether one exists.
// ---------------------------------------------------------------------------

/** `src-tauri/src/hub/types.rs`: an account on the hub. */
export interface HubUser {
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
export type HubProvider = "jkhub" | "discord" | "dev";

/** `src-tauri/src/account.rs`: what the frontend knows about the account. */
export interface AccountState {
  /**
   * Whether a token is on file. It does not promise the hub still accepts it:
   * finding that out costs a request, and the sidebar paints before one could
   * answer.
   */
  hubSignedIn: boolean;
  hubUser: HubUser | null;
  hubUrl: string;
  /** Whether the hub runs on this machine, which is what shows the Developer
   *  sign-in button. */
  localHub: boolean;
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
  user: HubUser | null;
  /** Set on `error`. */
  error: string | null;
}

/** Payload of `account:changed`. */
export interface AccountChanged {
  signedIn: boolean;
}

/** Emitted by the core after every sign-in, sign-out and rename. */
export const ACCOUNT_CHANGED_EVENT = "account:changed";

export const accountIpc = {
  getAccountState: () => call<AccountState>("get_account_state"),
  /** Opens a session and sends the player to the browser. */
  beginSignIn: (provider: HubProvider) =>
    call<SignInStart>("begin_sign_in", { provider }),
  /** Reads a session once. On `done` the core has already stored the token. */
  pollSignIn: (sessionId: string) =>
    call<SignInPoll>("poll_sign_in", { sessionId }),
  signOut: () => call<void>("sign_out"),
  updateDisplayName: (displayName: string) =>
    call<HubUser>("update_display_name", { displayName }),
  deleteAccount: () => call<void>("delete_account"),
};

/**
 * The contract's error code inside a refusal from the hub, or `null`.
 *
 * `AppError` reaches the frontend as one rendered string, and the hub variant
 * renders as `hub <code>: <message>`. The screens need the code — a
 * `provider_error` keeps the guest button and a `conflict` asks for another
 * name — so this reads it back out rather than every screen matching on the
 * wording of a message the hub wrote.
 */
export function hubErrorCode(error: unknown): string | null {
  const match = /^hub ([a-z_]+): /.exec(errorMessage(error));
  return match ? match[1] : null;
}

/** The same message without the `hub <code>:` prefix, for printing. */
export function hubErrorMessage(error: unknown): string {
  return errorMessage(error).replace(/^hub [a-z_]+: /, "");
}
