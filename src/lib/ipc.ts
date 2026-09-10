/**
 * Typed wrappers over the Rust commands.
 *
 * Every type here mirrors a `serde` structure in `src-tauri/src`. The Rust
 * side renames fields to camelCase, so the names match one to one. Change a
 * command signature in Rust and change it here in the same edit: this file is
 * the only place the frontend is allowed to name a command.
 */

import { invoke } from "@tauri-apps/api/core";

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
}

/** `src-tauri/src/paths.rs`: the folders JKNet writes into. */
export interface DataPaths {
  /** `%LOCALAPPDATA%\JKNet`, the folder with `settings.json`. */
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
// Servers and library
// ---------------------------------------------------------------------------

export interface Server {
  address: string;
  name: string;
  map: string;
  mode: string;
  gameMod: string;
  players: number;
  maxPlayers: number;
  ping: number | null;
  passwordProtected: boolean;
  trusted: boolean;
}

export type LibraryCategory = "skin" | "saber" | "map" | "mod" | "other";

export interface LibraryFile {
  id: string;
  title: string;
  fileName: string;
  category: LibraryCategory;
  size: number;
  author: string | null;
  installedIn: string[];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const ipc = {
  getSettings: () => call<Settings>("get_settings"),
  updateSettings: (settings: Settings) =>
    call<Settings>("update_settings", { settings }),
  getDataPaths: () => call<DataPaths>("get_data_paths"),

  detectGameFiles: () => call<GameFilesCandidate[]>("detect_game_files"),
  inspectGameFiles: (path: string) =>
    call<GameFilesCandidate>("inspect_game_files", { path }),

  listEngines: () => call<Engine[]>("list_engines"),

  listClients: () => call<Client[]>("list_clients"),
  createClient: (name: string, engineId: string) =>
    call<Client>("create_client", { name, engineId }),
  renameClient: (id: string, name: string) =>
    call<Client>("rename_client", { id, name }),
  deleteClient: (id: string) => call<void>("delete_client", { id }),

  listServers: () => call<Server[]>("list_servers"),
  refreshServers: () => call<Server[]>("refresh_servers"),

  // `launchClient` moved to `launchIpc` below when it stopped being a stub.

  listLibraryFiles: () => call<LibraryFile[]>("list_library_files"),
  installLibraryFile: (fileId: string, clientId: string) =>
    call<void>("install_library_file", { fileId, clientId }),
  removeLibraryFile: (fileId: string, clientId: string) =>
    call<void>("remove_library_file", { fileId, clientId }),
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
