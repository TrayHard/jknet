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
  /** Servers starred in the browser, as `ip:port`. */
  favoriteServers: string[];
  /** Servers Connect was pressed on, newest first, capped at 50. */
  serverHistory: ServerHistoryEntry[];
}

/** `src-tauri/src/settings.rs`: one line of `serverHistory`. */
export interface ServerHistoryEntry {
  address: string;
  /** RFC 3339 in UTC. */
  lastConnected: string;
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
// Library
// ---------------------------------------------------------------------------

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

  launchClient: (clientId: string, address?: string) =>
    call<void>("launch_client", { clientId, address: address ?? null }),

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
// --- slice: servers ---
// ---------------------------------------------------------------------------

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
  /** Players the server counts, bots included. */
  clients: number;
  /** `g_humanplayers`: the same count without bots, when the server sends it. */
  humans: number | null;
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

/**
 * TEMPORARY. Starts a client, optionally connecting it to a server.
 *
 * The launch slice owns `launch_client` and is being written in parallel, so
 * this branch has the signature but not the command: the call rejects at
 * runtime until the two branches are merged. Delete this wrapper then and
 * point the Connect button at the real one — the signature is already the
 * agreed shape, so nothing else has to change.
 */
export function launchClient(args: {
  clientId: string;
  connect?: string;
  extraArgs?: string[];
}): Promise<void> {
  return call<void>("launch_client", {
    clientId: args.clientId,
    connect: args.connect ?? null,
    extraArgs: args.extraArgs ?? null,
  });
}
