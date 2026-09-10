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
}

/** A named instance of an engine with its own files and settings. */
export interface Client {
  id: string;
  name: string;
  engineId: string;
  engineVersion: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Servers
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

  launchClient: (clientId: string, address?: string) =>
    call<void>("launch_client", { clientId, address: address ?? null }),
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
