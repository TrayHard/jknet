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
  /** Servers starred in the browser, as `ip:port`. */
  favoriteServers: string[];
  /** Servers Connect was pressed on, newest first, capped at 50. */
  serverHistory: ServerHistoryEntry[];
  // --- slice: onboarding ---
  /** False until the player has been through the three first-run steps. */
  onboardingCompleted: boolean;
  // --- slice: friends (temporary, replaced by hub module at merge) ---
  /** Base address of the JKNet hub. `null` uses the development default. */
  hubUrl: string | null;
  /** Bearer token of the signed-in player. `null` means signed out. */
  hubToken: string | null;
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
  // --- slice: friends (temporary, replaced by hub module at merge) ---
  hubUrl?: string | null;
  hubToken?: string | null;
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

// ---------------------------------------------------------------------------
// --- slice: friends ---
//
// The JKNet hub: friends, presence and invites. Every type here mirrors a
// structure of `src-tauri/src/friends/types.rs`, which in turn mirrors the
// `## Types` table of the hub contract, so the three stay readable side by
// side. The launcher never talks to the hub from the frontend: a token in a
// webview is a token in the devtools network tab.
// ---------------------------------------------------------------------------

/**
 * Calls a friends command, or the mock hub when the page is in a browser.
 *
 * The Friends screen is nothing but commands, so outside Tauri it would be one
 * error line and no layout at all. In a development build the call goes to
 * `scripts/mock-hub.mjs` over `fetch` instead; `import.meta.env.DEV` is a
 * compile-time constant, so both the branch and `devHub.ts` behind it are gone
 * from a production bundle. Inside Tauri nothing changes.
 */
function callFriends<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (import.meta.env.DEV && !isTauri()) {
    return import("./devHub").then((module) => module.devFriends<T>(command, args));
  }
  return call<T>(command, args);
}

/** A person on the hub. */
export interface HubUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** `jkhub`, `discord` or `dev`. */
  provider: string;
  /** Their name at that provider, for example `kyle_k`. */
  providerName: string;
  createdAt: string;
}

/** Where a player is. `offline` is derived by the hub from a missed heartbeat. */
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
  user: HubUser;
  presence: Presence;
  friendsSince: string;
}

/** A friend request; which list it is in says whether it is mine to accept. */
export interface FriendRequest {
  id: string;
  from: HubUser;
  to: HubUser;
  createdAt: string;
}

export interface Invite {
  id: string;
  from: HubUser;
  serverAddress: string;
  serverName: string | null;
  message: string | null;
  createdAt: string;
  /** The hub drops an invite ten minutes after it was made. */
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
export interface SendRequestResult {
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
    callFriends<SendRequestResult>("send_friend_request", { query }),
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
