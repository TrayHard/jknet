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

export const communityIpc = {
  request: <T>(method: string, path: string, body?: unknown) => call<T>("community_request", { method, path, body: body ?? null }),
};

export interface PreviewAsset { name: string; path: string | null; text: string | null }
/**
 * What one object of a preview session is, `PreviewProduct` in
 * `src-tauri/src/file_preview_products.rs`.
 *
 * --- slice: pk3 contents ---
 * The first eight kinds are the objects with a scene or a player. The rest
 * are the contents of the archive by the taxonomy of the pk3 reference:
 * pictures by the folder they sit in, fonts, string packages and the text
 * files the game reads. The optional fields carry what the core read out of
 * the headers, so the list captions an image without decoding it.
 */
export type FilePreviewKind =
  | "map" | "skin" | "hilt" | "weapon" | "npc" | "vehicle" | "music" | "sound"
  | "levelshot" | "splash" | "menuImage" | "hudImage" | "texture" | "icon" | "image"
  | "font" | "strings" | "shader" | "effect" | "menu" | "config" | "data" | "script" | "video" | "other";
export interface FilePreviewEntry {
  id: string;
  archive: number;
  name: string;
  label: string;
  kind: FilePreviewKind;
  model: string | null;
  skins: string[];
  audio: { name: string; label: string }[];
  appearance: PlayerModel | null;
  hiltId: string | null;
  /** Bytes of the entry inside the archive. */
  size?: number;
  /** The header of a picture; `0×0` when the core could not parse it. */
  image?: { width: number; height: number; format: "jpg" | "png" | "tga" };
  /** A file the core can read as text: how many lines and in which code page. */
  text?: { lines: number; encoding: string };
  /** A `strings/<language>/<package>.str` file: the folder, the package and the number of `REFERENCE` keys. */
  strings?: { language: string; package: string; keys: number };
  /** A `.fontdat` with the name of its glyph atlas in the archive, when there is one. */
  font?: { pointSize: number; height: number; atlas: string | null };
  /** On a `levelshot`: the map the picture stands for, as `mp/ffa3`. */
  map?: string;
  /** The subfolder the entry is grouped under inside its kind. */
  group?: string;
}
export interface FilePreview { id: string; archives: string[]; entries: FilePreviewEntry[] }
export interface FilePreviewSource { previewId: string; archive: number }
/**
 * --- slice: preview modes ---
 * What the object list of a preview dialog shows: `simple` is what a player
 * sees in the game, `advanced` is every file of the archive by folder. One
 * setting for every preview dialog, `previewMode` in `settings.rs`.
 */
export type PreviewMode = "simple" | "advanced";
export const PREVIEW_MODES: readonly PreviewMode[] = ["simple", "advanced"];
/** A picture of a preview session, decoded by the core: a PNG data URL for a TGA, the file itself otherwise. */
export interface PreviewImage { dataUrl: string; width: number; height: number }
/** A text file of a preview session, decoded from its code page; `truncated` when the core cut it. */
export interface PreviewText { text: string; encoding: string; truncated: boolean }
export const filePreviewIpc = {
  baseGame: (game: Game) => call<FilePreview>("preview_base_game", { game }),
  installed: (clientId: string, itemId: string) => call<FilePreview>("preview_library_file", { clientId, itemId }),
  jkhub: (id: number, clientId: string | null) => call<FilePreview>("jkhub_preview", { id, clientId }),
  assets: async (source: FilePreviewSource, names: string[]): Promise<PreviewAsset[]> =>
    (await call<PreviewAsset[]>("get_file_preview_assets", { ...source, names })).map(asset => ({ ...asset, path: asset.path ? convertFileSrc(asset.path) : null })),
  /** A picture of the archive; `maxSize` asks for a thumbnail no wider or taller than that. */
  image: (source: FilePreviewSource, name: string, maxSize?: number) =>
    call<PreviewImage>("get_file_preview_image", { ...source, name, maxSize: maxSize ?? null }),
  /** A text file of the archive, decoded by the core. */
  text: (source: FilePreviewSource, name: string) => call<PreviewText>("get_file_preview_text", { ...source, name }),
  release: (previewId: string) => call<void>("release_file_preview", { previewId }),
};
export const modelPreviewIpc = {
  assets: async (clientId: string, names: string[]): Promise<PreviewAsset[]> => (await call<PreviewAsset[]>("get_preview_assets", { clientId, names })).map(asset => ({ ...asset, path: asset.path ? convertFileSrc(asset.path) : null })),
};

export interface MediaOrigin { clientId: string; clientName: string; source: string; createdAt: number; modifiedAt: number; size: number; dateIsModified: boolean }
export interface MediaItem { id: string; name: string; kind: "demos" | "screenshots" | "videos"; game: Game; extension: string; tags: string[]; origins: MediaOrigin[]; size: number; preview: string | null; sourceDemo: string | null }
export interface ConfigDocument { id: string; name: string; game: Game; text: string; sourceClient: string | null; sourceFile: string | null }
export interface ConfigLayer { configId: string; priority: number; enabled: boolean }
export interface ConfigBook { documents: ConfigDocument[]; clients: Record<string, ConfigLayer[]>; defaults: Record<string, string> }
export interface ClientConfigContext { sources: ClientConfigFile[]; unresolved: string[] }
export interface ConfigConflict { key: string; values: { configId: string; configName: string; value: string }[] }
export interface ClientConfigFile { path: string; text: string }
export const mediaIpc = {
  jobs: () => call<VideoJob[]>("list_video_jobs"),
  exportVideo: (demoId: string, clientId: string, settings: VideoSettings) => call<VideoJob>("export_demo_video", { demoId, clientId, settings }),
  videoPreferences: () => call<VideoPreferences>("video_preferences"),
  savePreset: (preset: VideoPreset) => call<VideoPreset>("save_video_preset", { preset }),
  deletePreset: (id: string) => call<void>("delete_video_preset", { id }),
  preparePreview: (id: string) => call<void>("prepare_video_preview", { id }),
  cancelVideo: (id: string) => call<void>("cancel_video_job", { id }),
  list: async (refresh: boolean): Promise<MediaItem[]> => (await call<MediaItem[]>("list_media", { refresh })).map(item => ({ ...item, preview: item.preview ? convertFileSrc(item.preview) : null })),
  update: (id: string, name: string, tags: string[]) => call<void>("update_media", { id, name, tags }),
  remove: (id: string) => call<void>("delete_media", { id }),
  removeBatch: (ids: string[]) => call<void>("delete_media_batch", { ids }),
  openFolder: (id: string) => call<void>("open_media_folder", { id }),
  copy: (id: string) => call<void>("copy_screenshot", { id }),
  play: (id: string, clientId: string) => call<RunningGame>("play_media_demo", { id, clientId }),
};
export interface VideoSettings { format: string; fps: number; fov: number; commands: string }
export interface VideoPreset { id: string; name: string; settings: VideoSettings }
export interface VideoPreferences extends VideoSettings { presets: VideoPreset[] }
export interface VideoProgress { frames: number; capturedSeconds: number; outputBytes: number; encodedSeconds: number; encodingPercent: number | null }
export interface VideoJob { id: string; demoId: string; demoName: string; clientId: string; elapsedSeconds: number; progress: VideoProgress; status: "rendering" | "complete" | "failed" | "cancelled"; error: string | null; videoIds: string[]; phase: "preparing" | "capturing" | "encoding" | "finalizing" }
export const configsIpc = {
  list: () => call<ConfigBook>("list_configs"),
  save: (document: ConfigDocument) => call<ConfigDocument>("save_config", { document }),
  remove: (id: string) => call<void>("delete_config", { id }),
  layers: (clientId: string, layers: ConfigLayer[]) => call<void>("set_config_layers", { clientId, layers }),
  conflicts: (ids: string[]) => call<ConfigConflict[]>("config_conflicts", { ids }),
  merge: (ids: string[], choices: Record<string, string>, name: string) => call<ConfigDocument>("merge_configs", { ids, choices, name }),
  clientFiles: (clientId: string) => call<ClientConfigFile[]>("client_config_files", { clientId }),
  context: (clientId: string) => call<ClientConfigContext>("client_config_context", { clientId }),
  setDefault: (clientId: string, source: string | null) => call<void>("set_default_config", { clientId, source }),
  profileBind: (clientId: string, profileId: string, configId: string | null) => call<string>("profile_bind_command", { clientId, profileId, configId }),
};

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
  // --- slice: player profiles ---
  /** Whether the player picks a saber hilt in this game. False hides the two
   * hilt lists of the profile form: Jedi Outcast ships no hilt data at all. */
  hasSaberHilts: boolean;
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
  libraryConflictNoticeDismissed: boolean;
  /** Absolute path that replaces the default data folder. */
  dataDirOverride: string | null;
  /** Tokens appended to every command line, written as in a shortcut. */
  extraLaunchArgs: string;
  /** Servers starred in the browser, as `ip:port`. */
  favoriteServers: string[];
  /** Servers Connect was pressed on, newest first, capped at 50. */
  serverHistory: ServerHistoryEntry[];
  // --- slice: server actions ---
  /**
   * Servers the player took off the browser, as `ip:port`.
   *
   * The core keeps scanning and caching them; the screen leaves such a row out
   * of every tab but **Hidden** and off the Home screen.
   */
  hiddenServers: string[];
  // --- slice: servers browser ---
  /** The filter row of the Servers screen, as the player left it. */
  serverFilters: StoredServerFilters;
  // --- slice: player profiles ---
  /** Nicknames the player saved, newest first. One list for every client. */
  savedNicknames: string[];
  // --- slice: onboarding ---
  /** False until the player has been through the three first-run steps. */
  onboardingCompleted: boolean;
  // --- slice: preview modes ---
  /** The **Simple** / **Advanced** segment of every preview dialog; `simple` on a fresh install. */
  previewMode: PreviewMode;
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
  // --- slice: play with friends ---
  /**
   * The last settings of the **Play with friends** screen, one entry per game,
   * without the password. `host_start` writes the entry of its game; a patch
   * may write one too. `hostGetOptions` already folds this into its
   * `defaults`, so the screen rarely needs to read it here.
   */
  hostDefaults: Partial<Record<Game, HostDefaults>>;
  /** True once a server was started in a mode with the local network. */
  hostFirewallNoteSeen: boolean;
  // --- slice: chat ---
  /**
   * The chat drawer of the main window docked beside the page instead of
   * floating over it; `false` on a fresh install. Whether the drawer is open
   * is not kept: every launch starts with it closed.
   *
   * Absent from a core that predates the field, which reads as `false`.
   */
  chatDrawerPinned?: boolean;
  /**
   * Pictures of a chat up to this many MiB download by themselves when they
   * are shown; larger ones, and every other file, wait for a click. 0 turns
   * the automatic download off. Absent from a core that predates it: 10.
   */
  chatAutoDownloadMb?: number;
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
  libraryConflictNoticeDismissed?: boolean;
  dataDirOverride?: string | null;
  extraLaunchArgs?: string;
  favoriteServers?: string[];
  serverHistory?: ServerHistoryEntry[];
  // --- slice: server actions ---
  /** The whole list; `setServerHidden` is what edits one address. */
  hiddenServers?: string[];
  // --- slice: servers browser ---
  /** The whole filter row: send the row the screen now shows, not one key. */
  serverFilters?: StoredServerFilters;
  // --- slice: player profiles ---
  /**
   * The whole list of saved nicknames, replaced in one go.
   *
   * The core trims, drops the blanks and keeps the first of each spelling, so
   * a form that prepends the name just typed does not have to.
   */
  savedNicknames?: string[];
  // --- slice: onboarding ---
  onboardingCompleted?: boolean;
  // --- slice: preview modes ---
  previewMode?: PreviewMode;
  // --- slice: account ---
  /** An `http://` or `https://` address; blank returns to the default service. */
  onlineUrl?: string;
  // --- slice: play with friends ---
  /** Merged one game at a time; `null` for a game forgets its entry. */
  hostDefaults?: Partial<Record<Game, HostDefaults | null>>;
  hostFirewallNoteSeen?: boolean;
  // --- slice: chat ---
  chatDrawerPinned?: boolean;
}

/** `src-tauri/src/settings.rs`: one line of `serverHistory`. */
export interface ServerHistoryEntry {
  address: string;
  /** RFC 3339 in UTC. */
  lastConnected: string;
  // --- slice: server actions ---
  /**
   * The client the player reached this server with, or `null`.
   *
   * What **Connect** starts, when a client of that id still exists. `null` on
   * entries written before the field, which fall back to the default client.
   */
  clientId: string | null;
}

// --- slice: servers browser ---
/** What the **Players** dropdown of the Servers screen narrows the list to. */
export type PlayersFilter = "any" | "not-empty" | "not-full";

/**
 * `src-tauri/src/settings.rs`: the filter row of the Servers screen.
 *
 * Dropdowns and switches only. The search box is not stored — a browser that
 * opens on yesterday's search word looks like a browser that lost half the
 * servers — and neither is the open tab.
 */
export interface StoredServerFilters {
  /** `gametype` as text, or `any`. */
  gametype: string;
  /** `fs_game` folder of the server, or `any`. */
  modName: string;
  players: PlayersFilter;
  /** Network protocol as text, or `any`. */
  protocol: string;
  /** Drop the servers where every client is a bot. On by default. */
  hideBotOnly: boolean;
  /** Drop the servers that ask for a password. Off by default. */
  hidePassworded: boolean;
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
  /** The repository as a link, for the About card and the engine page. */
  repoUrl: string;
  /** The page that lists every published build. */
  releasesUrl: string;
  /** The project's own site, when its README names one. */
  homepage: string | null;
  /** Who the project credits for its icon, when it credits anyone. */
  iconCredit: string | null;
  /** Recommended, merely supported, or legacy with a note saying why. */
  status: EngineStatus;
  /** False when the project publishes no archive JKNet can install. */
  installable: boolean;
  /** Why `installable` is false. */
  notInstallableReason: string | null;
  /** Native host system and a translated reason when it is unsupported. */
  system: string;
  compatibilityError: "unsupportedEngineSystem" | null;
  /** Mod folder the build needs as `+set fs_game`. jaMME runs in `mme`. */
  defaultFsGame: string | null;
  // --- slice: bundles ---
  /**
   * The ways this build can start: `multiplayer` always, `single` when the
   * release ships an executable of the single-player game beside it. OpenJK
   * does; the other builds play multiplayer alone.
   */
  modes: LaunchMode[];
  // --- slice: play with friends ---
  /** Whether the release ships a dedicated server, so a client of it can host (jaMME cannot). */
  canHost: boolean;
}

// --- slice: bundles ---
/**
 * `src-tauri/src/engines.rs`: how a client is started.
 *
 * `single` takes the single-player executable of the release and skips the
 * player profile and `+connect`; everything else on the line is the same.
 */
export type LaunchMode = "multiplayer" | "single";

/**
 * The modes a client offers, read off the record with the engine as the fallback.
 *
 * A record written before the field carries none, and the core reads such a
 * list as «every mode of the engine»; the card does the same, so a client made
 * yesterday shows the same buttons as one made today.
 */
export function clientModes(client: Client, engine: Engine | undefined): LaunchMode[] {
  if (client.modes && client.modes.length > 0) return client.modes;
  return engine?.modes ?? ["multiplayer"];
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
  // --- slice: client launch args ---
  /**
   * Command line of this client, written the way a shortcut is written.
   *
   * Handed to the engine after the tokens of `extraLaunchArgs`, so a client
   * that repeats a `+set` of the same cvar is the value the engine keeps.
   */
  launchArgs: string;
  // --- slice: bundles ---
  /**
   * The modes this client starts in. Empty or absent on a record written
   * before the field, which means every mode of the engine: read it through
   * `clientModes`, never directly.
   */
  modes?: LaunchMode[];
  /**
   * The bundle or the draft this client was installed from.
   *
   * Absent or `null` on a client that has nothing to do with a bundle, which
   * is every client written before the field existed.
   */
  bundle?: ClientBundleLink | null;
}

// --- slice: client window ---

/** Payload of `clients:changed`. */
export interface ClientsChanged {
  clientId: string;
}

/**
 * Events the clients module emits.
 *
 * One window edits a client and the other one is showing its card, so a record
 * that changed has to reach a React Query cache that is not the one behind the
 * call. Every window listens; the one that made the change refetches twice and
 * nobody notices.
 */
export const clientEvents = {
  changed: "clients:changed",
} as const;

// --- slice: clients page ---

/** Payload of `settings:default-clients`. */
export interface DefaultClientsChanged {
  defaultClientIds: Partial<Record<Game, string>>;
}

/**
 * Events the settings module emits.
 *
 * The default client of a game is written in one window and drawn in another:
 * the switch lives in the client window, the **DEFAULT** badge on the card of
 * the Clients screen. Each window keeps its own query cache, so the write has
 * to be announced the way `clients:changed` announces a record.
 */
export const settingsEvents = {
  defaultClients: "settings:default-clients",
} as const;

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
   * Changes the name, the mod folder, the launch arguments, or any of them. A
   * field left out keeps its value; an empty `fsGame` clears it back to the
   * default of the engine and an empty `launchArgs` clears the line.
   */
  updateClient: (
    clientId: string,
    changes: { name?: string; fsGame?: string; launchArgs?: string },
  ) =>
    call<Client>("update_client", {
      clientId,
      name: changes.name ?? null,
      fsGame: changes.fsGame ?? null,
      launchArgs: changes.launchArgs ?? null,
    }),
  deleteClient: (id: string) => call<void>("delete_client", { id }),

  // --- slice: clients page ---
  /** The folder of one client, `clients\<slug>\`, for **Open folder**. */
  clientDir: (clientId: string) => call<string>("client_dir", { clientId }),

  // --- slice: client window ---
  /** Opens the `client-<id>` window, or raises the one already open. */
  openClientWindow: (clientId: string) =>
    call<void>("open_client_window", { clientId }),
  /**
   * Reads several cvars out of the launch arguments of one client.
   *
   * A name the line does not carry answers `null`. The last mention wins, as
   * it does in the engine.
   */
  readLaunchCvars: (clientId: string, names: string[]) =>
    call<Record<string, string | null>>("read_launch_cvars", {
      clientId,
      names,
    }),
  /**
   * Writes one cvar into the launch arguments and saves the client.
   *
   * `null` removes it. Every other token of the line stays where it was, which
   * is what lets a dropdown and a hand-written command line share one field.
   */
  writeLaunchCvar: (clientId: string, name: string, value: string | null) =>
    call<Client>("write_launch_cvar", { clientId, name, value }),

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
  mapNames: string[];
  previewPath: string | null;
  thumbnailUrl: string | null;
  /** `<folder>/<file name>`, stable across the enable toggle. */
  id: string;
  /** `base` or the `fs_game` folder the file belongs to. */
  folder: string;
  /** File name with the `.pk3` extension, without `.disabled`. */
  fileName: string;
  displayName: string;
  category: LibraryCategory;
  /**
   * --- slice: pk3 contents ---
   * What else the archive holds beside its category, as codes of the pk3
   * taxonomy: `levelshots`, `splash`, `menu`, `hud`, `textures`, `fonts`,
   * `strings:<language>`, `shaders`, `effects`, `scripts`, `videos`,
   * `configs`, `modules`, then the objects the preview assembles:
   * `characters`, `hilts`, `weapons`, `npcs`, `vehicles`, `maps`, `music`,
   * `sounds`. The card prints them as badges.
   */
  features: string[];
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
  mapNames: string[];
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

/** What kind of content sits at a conflicting internal path. */
export type ConflictKind =
  | "shader"
  | "model"
  | "sound"
  | "texture"
  | "map"
  | "ui"
  | "other";

/** One internal path that more than one enabled archive carries. */
export interface LibraryConflict {
  path: string;
  folder: string;
  /** What the path holds, read by the core out of the path itself. */
  kind: ConflictKind;
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

/**
 * Codes `launch:warning` can carry.
 *
 * One per combination of engine and argument the core knows to be fatal. The
 * code is stable and the sentence behind it lives in the `clients` catalog,
 * under `launchWarning.`, so the warning arrives in the language on screen.
 */
export type LaunchWarningCode = "eternaljk_s_initsound";

/** Payload of `launch:warning`. */
export interface LaunchWarning {
  clientId: string;
  code: LaunchWarningCode;
}

// --- slice: client window ---

/** `src-tauri/src/launch.rs`: the command line of a client, unlaunched. */
export interface LaunchPreview {
  /** One token per argument of the process, in the order they go out. */
  args: string[];
  /** The warning these arguments carry, in the codes of `launch:warning`. */
  warning: LaunchWarningCode | null;
}

/** Event names the launch slice emits. */
export const launchEvents = {
  installProgress: "launch:engine-install-progress",
  gameStarted: "launch:game-started",
  gameExited: "launch:game-exited",
  warning: "launch:warning",
} as const;

export const launchIpc = {
  listEngineReleases: (engineId: string) =>
    call<EngineRelease[]>("list_engine_releases", { engineId }),
  installEngine: (clientId: string, tag?: string) =>
    call<Client>("install_engine", { clientId, tag: tag ?? null }),
  checkEngineUpdate: (clientId: string) =>
    call<EngineUpdate>("check_engine_update", { clientId }),

  /**
   * Starts a client, optionally joining a server straight away.
   *
   * --- slice: player profiles ---
   * `profileId` names the player profile to start with. Leaving it out takes
   * the client's default profile, which is what **Play** and **Connect** send;
   * a client with no profiles starts with no profile tokens at all.
   *
   * --- slice: connect dialog ---
   * `inlineProfile` is a profile of this launch alone, nothing is stored and
   * `profileId` is not read beside it.
   *
   * --- slice: bundles ---
   * `mode` is `multiplayer` when left out. `single` starts the single-player
   * executable of the release and carries neither a profile nor `connect`;
   * the core refuses it for a client that does not offer the mode.
   */
  launchClient: (
    clientId: string,
    connect?: string,
    extraArgs: string[] = [],
    profileId?: string,
    inlineProfile?: InlineProfile,
    mode?: LaunchMode,
  ) =>
    call<RunningGame>("launch_client", {
      clientId,
      connect: connect ?? null,
      extraArgs,
      profileId: profileId ?? null,
      inlineProfile: inlineProfile ?? null,
      mode: mode ?? null,
    }),
  getRunningGame: () => call<RunningGame | null>("get_running_game"),
  stopGame: () => call<void>("stop_game"),

  // --- slice: client window ---
  /**
   * The command line this client would start with, without starting it.
   *
   * The same roots and the same argument order as a real launch. Called with
   * the client alone it is the line behind **Play**: no `+connect` and no
   * tokens of one run.
   *
   * --- slice: player profiles ---
   * `profileId` is the profile to assume; leaving it out takes the client's
   * default one, exactly as **Play** does.
   *
   * --- slice: connect dialog ---
   * `inlineProfile`, `extraArgs` and `connect` are what a single run adds, and
   * the **Connect…** dialog passes all three: the line it prints is the line
   * its own button starts.
   */
  previewLaunchArgs: (
    clientId: string,
    profileId?: string,
    inlineProfile?: InlineProfile,
    extraArgs: string[] = [],
    connect?: string,
    // --- slice: bundles --- the mode the line is built for; `multiplayer`
    // when left out, as for `launchClient`.
    mode?: LaunchMode,
  ) =>
    call<LaunchPreview>("preview_launch_args", {
      clientId,
      profileId: profileId ?? null,
      inlineProfile: inlineProfile ?? null,
      extraArgs,
      connect: connect ?? null,
      mode: mode ?? null,
    }),
};

// ---------------------------------------------------------------------------
// --- slice: player profiles ---
//
// The fourth entity: who the player is inside the game. A profile belongs to a
// client and lives in `clients\<slug>\profiles.json`; the skins and hilts it
// may name come out of the archives that client loads.
// ---------------------------------------------------------------------------

/** `src-tauri/src/profiles.rs`: the tint of the character model. */
export interface CharColor {
  red: number;
  green: number;
  blue: number;
}

/**
 * `src-tauri/src/profiles.rs`: one player profile of one client.
 *
 * Every field but `id` and `name` is optional, and `null` means «this profile
 * has no opinion»: no token goes out and the engine keeps its own value. An
 * empty `id` on the way in asks the core to create a profile.
 */
export interface PlayerProfile {
  id: string;
  /** Name of the profile in the launcher. Not the nickname. */
  name: string;
  /** Value of the cvar `name`, colour codes included. */
  nickname: string | null;
  /** Value of the cvar `model`: `kyle` or `kyle/red`. */
  model: string | null;
  /** Value of the cvar `saber1`: the name of a `.sab` block. */
  saber1: string | null;
  /** Value of the cvar `saber2`. `none` is a second hand left empty. */
  saber2: string | null;
  /** Blade colour of the first hilt, 0 to 5. */
  color1: number | null;
  color2: number | null;
  charColor: CharColor | null;
  // --- slice: profiles polish ---
  /**
   * The whole `+set` line, written by hand, instead of the one the fields
   * build.
   *
   * `null` is the ordinary case: the line is assembled from the fields above.
   * A string is a line the player edited, and it is what the launch carries —
   * the fields are then a record of where the line came from, not of what it
   * says. **Reset to fields** sends `null` and the assembling starts again.
   */
  tokensOverride: string | null;
}

// --- slice: connect dialog ---
/**
 * `src-tauri/src/profiles.rs`: a profile that belongs to one launch.
 *
 * A {@link PlayerProfile} without the `id` and the `name`, which are what a
 * *stored* profile is found and listed by. The **Connect…** dialog fills these
 * fields in, presses **Connect** and is done: nothing reaches `profiles.json`.
 * The core checks them at the same gate a saved profile passes.
 *
 * --- slice: profiles polish ---
 * `tokensOverride` is left out as well: the dialog has fields and no token
 * line of its own, and its **Extra arguments** row is already the place to
 * type a token the fields have no control for.
 */
export type InlineProfile = Omit<
  PlayerProfile,
  "id" | "name" | "tokensOverride"
>;

/** `src-tauri/src/profiles.rs`: `clients\<slug>\profiles.json`. */
export interface ProfileBook {
  profiles: PlayerProfile[];
  /** The profile **Play** and **Connect** use, or `null`. */
  defaultProfileId: string | null;
}

/** `src-tauri/src/appearance.rs`: one skin a profile may name. */
export interface PlayerModel {
  /** What goes into the cvar `model`. */
  value: string;
  /** Folder under `models/players/`. */
  model: string;
  /**
   * What the engine calls the skin name: the suffix of
   * `model_<variant>.skin`, or the three parts joined by `|`.
   */
  variant: string;
  /** Absolute path of the cached icon, or `null` when it could not be read. */
  icon: string | null;
  /**
   * --- slice: assembled skins ---
   * The three rows this model is assembled from, or `null` for an ordinary
   * skin. The presence of this field is the «assembled» flag.
   */
  parts: ModelParts | null;
  // --- slice: skins and hilts ---
  /**
   * Absolute path of the composed picture of {@link value}: the icons of its
   * head, torso and legs stacked on a light ground. `null` for an ordinary
   * skin.
   *
   * The card of a custom character draws this instead of the head icon alone.
   * A combination the player builds afterwards is composed by
   * {@link profilesIpc.assembledSkinPreview}.
   */
  preview: string | null;
  /** The archive the skin was found in. */
  source: string;
}

// --- slice: assembled skins ---

/** `src-tauri/src/appearance.rs`: one head, torso or pair of legs. */
export interface ModelPart {
  /** The name inside the cvar and the `.skin` it names: `head_a1`. */
  id: string;
  /** Absolute path of the cached icon, or `null` when it could not be read. */
  icon: string | null;
}

/** The three rows an assembled model offers, each already sorted by name. */
export interface ModelParts {
  heads: ModelPart[];
  torsos: ModelPart[];
  legs: ModelPart[];
}

/** The three parts of an assembled model, taken out of a `model` value. */
export interface AssembledSkin {
  model: string;
  head: string;
  torso: string;
  legs: string;
}

/**
 * Takes an assembled `model` value apart, or answers `null` for any other.
 *
 * The engine's own reader, `UI_GetCharacterCvars`
 * (`codemp/ui/ui_main.c:5010` and below of OpenJK `1a6a6434`): cut at the
 * **last** `/`, then take the rest apart at two `|`. An ordinary `kyle/red`
 * carries no `|` and is not an assembled skin.
 */
export function parseAssembledSkin(value: string | null): AssembledSkin | null {
  if (value === null) return null;
  const slash = value.lastIndexOf("/");
  if (slash < 0) return null;
  const model = value.slice(0, slash);
  const parts = value.slice(slash + 1).split("|");
  if (parts.length !== 3) return null;
  const [head, torso, legs] = parts;
  if (model === "" || head === "" || torso === "" || legs === "") return null;
  return { model, head, torso, legs };
}

/**
 * Puts an assembled `model` value back together.
 *
 * `UI_UpdateCharacterCvars` (`codemp/ui/ui_main.c:4981`) writes
 * `<model>/<head>|<torso>|<legs>`, and the order is read back by position, so
 * it is not the row prefixes that carry the meaning.
 */
export function assembledSkinValue(skin: AssembledSkin): string {
  return `${skin.model}/${skin.head}|${skin.torso}|${skin.legs}`;
}

/** `src-tauri/src/appearance.rs`: one saber hilt a profile may name. */
export interface SaberHilt {
  /** What goes into `saber1` or `saber2`: the name of the `.sab` block. */
  id: string;
  /** Name for the list, written out of the game's own string table. */
  name: string;
  /** `single`, `staff`, or the shape of a story saber. */
  saberType: string;
  source: string;
}

/** The value of `saber2` that means «no hilt in the second hand». */
export const NO_SECOND_HILT = "none";

/**
 * The six blade colours of the engine, by the number `color1` takes.
 *
 * `saber_colors_t` in `codemp/qcommon/q_shared.h:349-358` of OpenJK
 * `1a6a6434`. The index is the value, so the list cannot drift from what the
 * engine will do with it.
 */
export const SABER_COLORS: readonly string[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
];

// --- slice: skins and hilts ---
/**
 * What each of the six looks like, so the control can wear the colour it
 * names.
 *
 * `CG_RGBForSaberColor` (`codemp/cgame/cg_players.c:5246-5271` of OpenJK
 * `1a6a6434`) in hexadecimal: the engine writes the channels as floats, and
 * `0.2` is `0x33`, `0.5` is `0x80`, `0.1` is `0x1a`, `0.4` is `0x66` and `0.9`
 * is `0xe6`. Indexed by the value of `color1`, like {@link SABER_COLORS}.
 *
 * Not a design token and deliberately so: this is the blade of the game, and a
 * swatch that matched the launcher's palette instead would show the player a
 * colour they will not get.
 */
export const SABER_BLADE_RGB: readonly string[] = [
  "#ff3333",
  "#ff801a",
  "#ffff33",
  "#33ff33",
  "#3366ff",
  "#e633ff",
];

export const profilesIpc = {
  listProfiles: (clientId: string) =>
    call<ProfileBook>("list_profiles", { clientId }),
  /** Creates a profile when `id` is empty, rewrites it otherwise. */
  saveProfile: (clientId: string, profile: PlayerProfile) =>
    call<ProfileBook>("save_profile", { clientId, profile }),
  deleteProfile: (clientId: string, profileId: string) =>
    call<ProfileBook>("delete_profile", { clientId, profileId }),
  setDefaultProfile: (clientId: string, profileId: string | null) =>
    call<ProfileBook>("set_default_profile", { clientId, profileId }),
  /** Every skin this client can offer, read out of the archives it loads. */
  listPlayerModels: (clientId: string) =>
    call<PlayerModel[]>("list_player_models", { clientId }),
  /** Every saber hilt this client can offer. Empty for a game with none. */
  listSaberHilts: (clientId: string) =>
    call<SaberHilt[]>("list_saber_hilts", { clientId }),
  // --- slice: skins and hilts ---
  /**
   * The composed picture of one combination of head, torso and legs.
   *
   * `value` is the whole cvar, `jedi_hm/head_a1|torso_a1|lower_a1`. Answers
   * `null` for a value that is not an assembled skin of this client, and for
   * one whose part icons could none of them be read.
   */
  assembledSkinPreview: (clientId: string, value: string) =>
    call<string | null>("assembled_skin_preview", { clientId, value }),
};

/**
 * Turns a cached skin icon into a URL the webview may load.
 *
 * The same mechanism as `levelshotUrl`: the asset protocol, scoped to
 * `cache\skins\` and to each file the core hands over. Outside Tauri the
 * function would throw, hence the guard — the browser preview draws the text
 * tile instead of a broken image.
 */
export function skinIconUrl(path: string | null): string | null {
  if (path === null || !isTauri()) return null;
  return convertFileSrc(path);
}
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

// --- slice: servers browser ---
/**
 * `src-tauri/src/servers/mod.rs`: which list of the browser one operation
 * fills.
 *
 * The first four are the tabs, because that is what they are: every event of a
 * scan carries its scope, and the screen keeps a loader, a counter and a
 * "refreshed N s ago" line per scope. Two scopes may scan at once; the core
 * refuses a second scan of the same one.
 *
 * --- slice: servers home tweaks ---
 * `one` belongs to no tab. It is the details panel asking about the server it
 * is showing, from its own **Refresh** button or from the **Watch** switch that
 * repeats the question once a minute. A scope of its own is what keeps the
 * loader off the table while one row is being asked about.
 */
export type ServerScope = "all" | "favorites" | "history" | "lan" | "one";

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
  /** Starred by the player. */
  favorite: boolean;
  // --- slice: server actions ---
  /**
   * Taken off the browser by the player.
   *
   * The core still scans the address and still caches the row: a master server
   * cannot be asked for «everything but these». Leaving such a row out is the
   * screen's job — every tab but **Hidden** drops it, and so does Home.
   */
  hidden: boolean;
  // --- slice: servers browser ---
  /**
   * False when the last direct probe of this address got nothing back.
   *
   * Such a row carries whatever the last successful scan knew, so the Favorites
   * and History tabs keep showing a server that is switched off — muted, and
   * with a mark where the ping goes. Every row of the cache is `true`.
   */
  responded: boolean;
  // --- slice: servers robustness ---
  /**
   * Whole **Get new list** scans this address has missed in a row.
   *
   * Zero on every row that answered. The core drops the row at two, so a
   * server that went quiet for one scan is still on the screen, marked
   * offline, and a server that is gone leaves on the next press.
   */
  missedRefreshes: number;
  /**
   * The last player list this address ever gave, bots included.
   *
   * What the details panel shows when the server answers `getinfo` and
   * refuses `getstatus` — a real configuration, not a failure. `null` until
   * one scan has got a list out of it.
   */
  lastPlayers: ServerPlayer[] | null;
  /** When `lastPlayers` was collected, RFC 3339 in UTC. */
  lastPlayersAt: string | null;
  /** RFC 3339 in UTC. */
  lastSeen: string;
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
  // --- slice: servers browser ---
  /** Which tab asked. A `lan` batch holds rows that never enter the master
   * list; every other scope holds rows of it. */
  scope: ServerScope;
  servers: ServerInfo[];
}

/** Payload of the `servers:done` event, emitted once per operation. */
export interface ServersDoneEvent {
  // --- slice: game core ---
  game: Game;
  // --- slice: servers browser ---
  /** Which tab asked, so one tab's indicator is not closed by another's. */
  scope: ServerScope;
  /** Addresses that were asked: what the masters returned, what the caller
   * sent, or — on a LAN sweep — the number that answered. */
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
  /**
   * **Get new list**: the master servers, then a probe of every address they
   * returned. The only call that rewrites the cache document.
   *
   * `masters` overrides the stock master servers of the game.
   */
  refreshServers: (game?: Game, masters?: string[]) =>
    call<ServerInfo[]>("refresh_servers", {
      game: game ?? null,
      masters: masters ?? null,
    }),
  // --- slice: servers browser ---
  /**
   * **Refresh**: probes the addresses the caller already has, no master server
   * involved. Also how the Favorites and History tabs ask about the addresses
   * the player saved.
   *
   * The answers are merged into the cache by address. An address that stays
   * silent comes back all the same, with `responded` false and whatever the
   * last successful scan knew about it.
   */
  refreshAddresses: (addresses: string[], scope: ServerScope, game?: Game) =>
    call<ServerInfo[]>("refresh_addresses", {
      game: game ?? null,
      addresses,
      scope,
    }),
  // --- slice: servers browser ---
  /**
   * The **LAN** tab: one `getinfo` broadcast to four ports of the local
   * network. The rows never reach the cache.
   */
  refreshLan: (game?: Game) =>
    call<ServerInfo[]>("refresh_lan", { game: game ?? null }),
  getServerStatus: (address: string, game?: Game) =>
    call<ServerStatus>("get_server_status", { address, game: game ?? null }),
  setServerFavorite: (address: string, favorite: boolean, game?: Game) =>
    call<Settings>("set_server_favorite", { address, favorite, game: game ?? null }),
  // --- slice: server actions ---
  /** Takes a server off the browser, or puts it back from the Hidden tab. */
  setServerHidden: (address: string, hidden: boolean, game?: Game) =>
    call<Settings>("set_server_hidden", { address, hidden, game: game ?? null }),
  // --- slice: server actions ---
  /**
   * Records a connection. `clientId` is the client about to start, which is
   * what the next **Connect** on that row uses; omitting it keeps whatever the
   * entry already remembered.
   */
  addServerHistory: (address: string, clientId?: string, game?: Game) =>
    call<Settings>("add_server_history", {
      address,
      clientId: clientId ?? null,
      game: game ?? null,
    }),
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
   * Release builds use https://api.jknet.app; debug builds use the local service.
   * The **JKNet Online address** field overrides the default for this machine.
   * A blank effective address disables provider buttons, counters and calls.
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
  // --- slice: bundles ---
  /**
   * Whether the signed-in account is a bundle administrator.
   *
   * The service says so in the `admin` field of `GET /v1/me`. Absent means
   * «not known», and every screen reads it as `false`: the review queue is
   * the only thing behind it, and the service checks the right again.
   */
  isAdmin?: boolean;
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
  // --- slice: play with friends ---
  /**
   * The private server this player hosts, or `null`/absent when there is none.
   * On a friend's presence it is the service's view for me: `canJoin` is set
   * and `password` is there only when I may join without an invite. On my own
   * presence it is the whole object the launcher sends.
   */
  hosting?: HostingInfo | null;
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
  // --- slice: play with friends ---
  /**
   * The private server the invite leads to, `null`/absent for an invite to an
   * ordinary server. It carries the password whatever the join policy: the
   * invite is addressed to me alone. Answer it with `acceptInvite`.
   */
  hosting?: HostingInfo | null;
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
  /**
   * Starts the default client on the server that friend is playing on.
   *
   * --- slice: play with friends ---
   * A friend who hosts a private server is joined the way an invite is: the
   * client of `hosting.game`, the local network first, then the relay, with
   * the password. Refused with `hostInviteOnly` when the host has not opened
   * the server to me.
   */
  joinFriend: (userId: string) => callFriends<JoinResult>("join_friend", { userId }),
  // --- slice: play with friends ---
  /**
   * Answers an invite: joins its private server (`hosting`) or, for an invite
   * to an ordinary server, starts the default client of the game its port
   * names. The invite stays on the service; dismiss it as before.
   */
  acceptInvite: (inviteId: string) => callFriends<JoinResult>("accept_invite", { inviteId }),
};

// ---------------------------------------------------------------------------
// --- slice: play with friends ---
//
// A private server on this PC, `src-tauri/src/hosting/`. The types mirror the
// structures there one to one; the plan is `docs/play-with-friend.md` of the
// workspace, section «Команды IPC и события».
// ---------------------------------------------------------------------------

/** Who can connect: through the relay, on the local network, or both. */
export type HostNetwork = "internet_lan" | "lan" | "internet";

/** Which friends join without an invite and see the password. */
export type HostJoinPolicy = "friends" | "selected" | "invite";

/** What `host_start` is given. */
export interface HostSettings {
  clientId: string;
  /** `mp/ffa3`, the name `host_list_maps` answered with. */
  map: string;
  /** `g_gametype`, one of `HostOptions.gametypes[].index`. */
  gametype: number;
  /** `sv_maxclients`, 2–16. */
  maxPlayers: number;
  /** Minutes, 0 = no limit. */
  timeLimit: number;
  /** The score limit of the mode (frags, captures), 0 = no limit. Ignored by Siege. */
  scoreLimit: number;
  /** `bot_minplayers`, 0 = off. */
  bots: number;
  /** Up to 32 characters of `[A-Za-z0-9 _.'!^-]`; the core cleans the rest out. */
  serverName: string;
  /** 1–24 characters of `[A-Za-z0-9_-]`, or `null` for a server without a password. */
  password: string | null;
  network: HostNetwork;
  joinPolicy: HostJoinPolicy;
  /** Friends who join without an invite when `joinPolicy` is `selected`. */
  joinUserIds: string[];
  /** Invited once the server is ready. */
  inviteUserIds: string[];
  /** **Start and play**: start my own game on the server once it is ready. */
  joinAfterStart: boolean;
}

/**
 * `settings.json`: the last settings of the screen for one game. No password
 * and nothing that belongs to one start (`inviteUserIds`, `joinAfterStart`).
 */
export interface HostDefaults {
  clientId: string | null;
  map: string | null;
  gametype: number;
  maxPlayers: number;
  timeLimit: number;
  scoreLimit: number;
  bots: number;
  serverName: string | null;
  /** Whether the last server asked for a password. */
  usePassword: boolean;
  network: HostNetwork;
  joinPolicy: HostJoinPolicy;
  joinUserIds: string[];
}

/** Why a client of the game cannot host. */
export type HostClientBlock = "no_dedicated_server" | "engine_missing";

/** One client of the game, as the **Client** list of the screen shows it. */
export interface HostClientOption {
  id: string;
  name: string;
  engineId: string;
  canHost: boolean;
  /** `no_dedicated_server`: the engine ships none (jaMME). `engine_missing`: the file is not in `engine\`. */
  reason: HostClientBlock | null;
}

/** One game type the screen offers, out of `HostingSpec` of the game. */
export interface HostGametypeOption {
  /** `g_gametype`. */
  index: number;
  /** The token of the mode in the `type` key of an `.arena` file: `ffa`, `duel`, `ctf`… */
  id: string;
  /** The label of the server browser: `FFA`, `Duel`, `CTF`… */
  label: string;
  /** `fraglimit`, `duel_fraglimit` or `capturelimit`; `null` for Siege, which has no score limit. */
  scoreCvar: string | null;
  defaultScore: number;
}

/** What the relay can do for this launcher right now. */
export interface HostRelayAvailability {
  available: boolean;
  /** `signed_out`: nobody is signed in. `not_configured`: this build has no service. */
  reason: "signed_out" | "not_configured" | null;
}

/** The answer of `host_get_options`. */
export interface HostOptions {
  game: Game;
  clients: HostClientOption[];
  gametypes: HostGametypeOption[];
  /**
   * The form as it should open: the last settings of this game where they
   * still make sense, a fresh password, **{displayName}'s game** or
   * **JKNet game**, and the network mode that fits the account.
   */
  defaults: HostSettings;
  relay: HostRelayAvailability;
  /** The Windows firewall note stands above the buttons until the first start in a mode with the local network. */
  showFirewallNote: boolean;
  /** The ten ports the engine may take, for the «No free port between…» sentence. */
  portFrom: number;
  portTo: number;
}

/** One map of `host_list_maps`. */
export interface HostMap {
  /** `mp/ffa3`, what `+map` takes. */
  name: string;
  /** `longname` of the `.arena` entry. */
  title: string | null;
  /** The arena tokens of the modes the map supports: `ffa`, `team`, `duel`… */
  gametypes: string[];
  /** `game`: a retail archive. `client`: a pk3 of the client, which friends need too. */
  source: "game" | "client";
  /** A path for `levelshotUrl`, or `null` when no picture is cached. */
  levelshot: string | null;
}

export type HostSessionStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export type HostStepId = "server" | "map" | "relay";

export type HostStepState = "pending" | "active" | "done" | "failed" | "skipped";

export interface HostStep {
  step: HostStepId;
  state: HostStepState;
}

export type HostRelayStatus = "off" | "connecting" | "active" | "unavailable" | "lost";

/**
 * Why the relay is not carrying the server, for the sentence of the screen.
 *
 * - `unavailable`: the service answered `503`, the relay is switched off or full;
 * - `node_silent`: the relay node did not answer the tunnel in 10 s;
 * - `quota_active`: this account already holds a relay session;
 * - `quota_daily`: the relay time of the day is used up (it resets at 00:00 UTC);
 * - `rate_limited`: too many relay requests in a minute;
 * - `signed_out`: nobody is signed in;
 * - `network`: the service could not be reached;
 * - `expired`: the ticket ran out and could not be renewed.
 */
export type HostRelayErrorCode =
  | "unavailable"
  | "node_silent"
  | "quota_active"
  | "quota_daily"
  | "rate_limited"
  | "signed_out"
  | "network"
  | "expired";

export interface HostRelay {
  status: HostRelayStatus;
  /** `203.0.113.5:29210`: the address friends outside the network connect to. */
  address: string | null;
  region: string | null;
  /** RFC 3339: when the ticket runs out unless it is renewed. */
  expiresAt: string | null;
  /** An English sentence for the log and the fallback text. */
  error: string | null;
  errorCode: HostRelayErrorCode | null;
}

/** One line of the **Players** block. */
export interface HostPlayer {
  /** With colour codes; the screen draws them. */
  name: string;
  score: number;
  ping: number;
  bot: boolean;
}

/** One invite `host_invite` (or `inviteUserIds`) sent in this session. */
export interface HostInvited {
  userId: string;
  /** RFC 3339. */
  at: string;
  ok: boolean;
}

export type HostStopReason =
  | "user"
  | "empty"
  | "relay_expired"
  | "crashed"
  | "start_failed"
  | "launcher_exit";

/**
 * What went wrong, for the **Failed** state.
 *
 * - `spawn`: the process did not start (`message` says why);
 * - `exited`: it ended during startup, `HostSession.exitCode` says how;
 * - `timeout`: no answer with the session label within 30 s: «The server did not load {map} in 30 seconds.»;
 * - `ports_busy`: every port from `portFrom` to `portTo` is taken;
 * - `map_missing`: the engine did not find the map;
 * - `crashed`: it ended while running.
 */
export type HostFailureCode = "spawn" | "exited" | "timeout" | "ports_busy" | "map_missing" | "crashed";

export interface HostFailure {
  code: HostFailureCode;
  /** An English sentence for the log and the fallback text. */
  message: string;
  portFrom: number | null;
  portTo: number | null;
}

/** The one private server of this launcher: `host:session` carries it whole on every change. */
export interface HostSession {
  /** 16 hex characters, also `jknet_session` in the serverinfo. */
  id: string;
  status: HostSessionStatus;
  /** Always the three steps, in order. */
  steps: HostStep[];
  settings: HostSettings;
  game: Game;
  pid: number | null;
  /** The port the engine took, once it answered. */
  port: number | null;
  /** `127.0.0.1:29070`, for the host's own game only. Never sent to friends. */
  localAddress: string | null;
  /** `192.168.1.23:29070`, at most four, empty in the `internet` mode. */
  lanAddresses: string[];
  relay: HostRelay;
  players: HostPlayer[];
  invited: HostInvited[];
  /** How many different players joined, bots aside: «{count} players joined». */
  joinedCount: number;
  startedAt: string;
  readyAt: string | null;
  /** Since when nobody is on the server; `null` while somebody is. */
  emptySince: string | null;
  /** When the auto-stop fires; `null` while somebody is on the server. */
  autoStopAt: string | null;
  stoppedAt: string | null;
  stopReason: HostStopReason | null;
  exitCode: number | null;
  failure: HostFailure | null;
  /** The last 30 lines of the server console, filled when the session failed. */
  logTail: string[];
}

/**
 * The `hosting` object of a presence or an invite.
 *
 * The launcher of the host sends it whole. Each friend gets their own view from
 * the service: no `joinUserIds`, `canJoin` set, and `password` only where
 * `canJoin` is true. An invite carries the password to its one recipient.
 */
export interface HostingInfo {
  /** The `jknet_session` of the server, not the id of a relay session. */
  sessionId: string;
  game: Game;
  mod: string | null;
  map: string | null;
  gametype: number;
  players: number;
  maxPlayers: number;
  lanAddresses: string[];
  relayAddress: string | null;
  password?: string | null;
  joinPolicy: HostJoinPolicy;
  /** On my own presence only. */
  joinUserIds?: string[];
  /** On a friend's presence only: whether I may join without an invite. */
  canJoin?: boolean;
}

/** How a join reached its server. */
export type JoinPath = "lan" | "relay" | "direct";

/** The answer of `accept_invite` and `join_friend`. */
export interface JoinResult {
  game: RunningGame;
  /** `lan`: an address of the host's network answered. `relay`: through the relay. `direct`: an ordinary server. */
  path: JoinPath;
  /** A server open to the host's network only did not answer here: the toast warns, the game keeps trying. */
  probeFailed: boolean;
}

/** Event names of the hosting slice. */
export const hostEvents = {
  /** The whole `HostSession` on every change. */
  session: "host:session",
  /** No payload: the player closed the main window while the server runs. Ask **Stop your server and quit?** */
  closeRequested: "host:close-requested",
} as const;

/** Characters of a generated password: no `0`, `o`, `1`, `l` or `i`, which are misread aloud. */
export const HOST_PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** What `host_start` accepts as a password of the player's own. */
export const HOST_PASSWORD_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;

/** A fresh eight-character password, for **New password**. The core makes the first one. */
export function newHostPassword(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => HOST_PASSWORD_ALPHABET[byte % HOST_PASSWORD_ALPHABET.length]).join("");
}

/**
 * Calls a host command, or the stand-ins of `devHost.ts` in a browser.
 *
 * The same arrangement as `callFriends`: `import.meta.env.DEV` is a
 * compile-time constant, so the branch and the module leave the production
 * bundle, and inside Tauri nothing changes.
 */
function callHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV && !isTauri()) {
    return import("./devHost").then((module) => module.devHost<T>(command, args));
  }
  return call<T>(command, args);
}

export const hostIpc = {
  /** The clients, modes and defaults of the form. `game` defaults to the active game. */
  getOptions: (game?: Game) => callHost<HostOptions>("host_get_options", { game: game ?? null }),
  /** The maps of one client; with `gametype` only the maps that offer that mode. */
  listMaps: (clientId: string, gametype?: number) =>
    callHost<HostMap[]>("host_list_maps", { clientId, gametype: gametype ?? null }),
  /**
   * Starts the server. Answers at once with the session in `starting`; the
   * rest arrives as `host:session`. Refused with `hostBusy` while one runs.
   */
  start: (settings: HostSettings) => callHost<HostSession>("host_start", { settings }),
  /** Stops the server; a second call is not an error. Resolves once it is down. */
  stop: () => callHost<void>("host_stop"),
  getSession: () => callHost<HostSession | null>("host_get_session"),
  /** **Play**: my own game on my own server, with its password. */
  joinOwn: (profileId?: string) => callHost<RunningGame>("host_join_own", { profileId: profileId ?? null }),
  /** **Change map**: players stay connected. */
  changeMap: (map: string, gametype: number) => callHost<HostSession>("host_change_map", { map, gametype }),
  /** Who joins without an invite, while the server runs; presence follows at once. */
  setJoinPolicy: (joinPolicy: HostJoinPolicy, joinUserIds: string[]) =>
    callHost<HostSession>("host_set_join_policy", { joinPolicy, joinUserIds }),
  /** **Retry** of the relay line. */
  retryRelay: () => callHost<HostSession>("host_retry_relay"),
  /** **Invite**: an invite to this server, with its addresses and password. */
  invite: (toUserId: string, message?: string | null) =>
    callHost<Invite>("host_invite", { toUserId, message: message ?? null }),
  /** **Show log**: `logs\host-server.log` in the system viewer. */
  openLog: () => callHost<void>("host_open_log"),
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
export type SortDirection = "asc" | "desc";

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
  /**
   * Key of the launcher section this node is, for a node of the tree the tab
   * draws; absent for a raw site category.
   *
   * The screen names a section from `sections.<key>` of `jkhub.json`, not from
   * `name`: the eight sections are the launcher's own, and their site
   * spelling is not. The table of site ids behind a key lives in
   * `src-tauri/src/jkhub/sections.rs`.
   */
  section?: string;
  // --- slice: library polish ---
  /**
   * Site category a section node stands for; absent on every other node.
   *
   * A section carries an id of the launcher's own — it can be the parent of
   * the very category the site names it after — and this is the id jkhub.org
   * knows the shelf by. A card of the grid carries a site category, and this
   * is how a card of a section that has no drawers, such as **Audio**, still
   * finds the shelf it came off.
   */
  siteId?: number;
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
  /**
   * The category the card came out of. `null` from a listing page, which
   * prints no category on its cards; the catalogue index fills it in, because
   * a search there crosses categories.
   */
  categoryId: number | null;
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
export interface JkhubComment {
  id: number;
  author: string;
  postedAt: string | null;
  /** Sanitized in the core with the file description allowlist. */
  contentHtml: string;
}

export interface JkhubComments {
  items: JkhubComment[];
  page: number;
  pages: number;
  fetchedAt: string;
  stale: boolean;
}

export interface JkhubFile {
  id: number;
  slug: string;
  title: string;
  url: string;
  game: JkhubGame;
  categoryId: number | null;
  categoryName: string | null;
  author: JkhubAuthor | null;
  /** Plain text from JSON-LD, with its HTML entities resolved. */
  description: string;
  /**
   * --- slice: jkhub details ---
   * The same description with the author's markup, rebuilt by the core out of
   * an allowlist of tags (`src-tauri/src/jkhub/richtext.rs`). The description,
   * like comment content, may go through `dangerouslySetInnerHTML`
   * because no element, attribute or address reaches it that the core did
   * not write itself. Empty when the theme moved the block, and then the plain
   * copy above is what the window prints.
   */
  descriptionHtml: string;
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
  /**
   * --- slice: jkhub details ---
   * The same folder as a path on disk, for **Open folder**. Null only for the
   * outcome that wrote nothing: a record pointing at another site.
   */
  folderPath: string | null;
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
  /**
   * --- slice: jkhub details ---
   * Name of the archive coming down. The progress card names it: the file
   * host sends no `Content-Disposition`, so nothing on this side knows it
   * until the install answers.
   */
  fileName: string;
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

// --- slice: jkhub index ---
//
// The local catalogue index: one document per game, holding the listing card
// of every file of every leaf category. It is what the tab lists and searches
// from, so a file in a category nobody opened is still findable.

/**
 * Where the index that answered came from.
 *
 * `none` is the one state the tab cannot browse in: neither a crawl of this
 * machine nor the copy inside the build.
 */
export type JkhubIndexSource = "cache" | "snapshot" | "none";

/** The answer of `jkhub_search`: one page of results out of the index. */
export interface JkhubSearchResult {
  game: Game;
  /** Files that match, across the whole catalogue of the game. */
  total: number;
  page: number;
  perPage: number;
  pages: number;
  cards: JkhubCardData[];
  /**
   * Matches per category, rolled up the tree: a container carries what its
   * children hold. Covers the categories `categoryId` narrowed away, which is
   * what lets the tree show where else the query has answers.
   */
  categoryCounts: Record<string, number>;
  /** RFC 3339 moment the index was last written. Empty when there is none. */
  indexedAt: string;
  /** True for a copy from the build, one older than a week, or none at all. */
  stale: boolean;
}

/** What the launcher knows about the catalogue index of one game. */
export interface JkhubIndexStatus {
  game: Game;
  /**
   * True when there is something to list and to search: a crawl of this
   * machine or the copy the build shipped, holding at least one file. The rule
   * is `index::browsable` in the core. False is the one state the tab switches
   * its search box off for, and puts the waiting panel where the grid goes.
   */
  available: boolean;
  builtAt: string;
  updatedAt: string;
  /** Seconds since the last write, so the screen needs no date parser. */
  age: number;
  files: number;
  source: JkhubIndexSource;
  stale: boolean;
  /** True while a crawl or a top-up of this game is in flight. */
  building: boolean;
  /**
   * How far that run has got. Answered as well as emitted, so a tab opened
   * halfway through a crawl draws the bar it heard no event for.
   */
  progress: JkhubIndexProgress | null;
}

/** Payload of `jkhub:index-updated`, and the answer of `jkhub_refresh_index`. */
export interface JkhubIndexUpdate {
  game: Game;
  added: number;
  updated: number;
  removed: number;
  files: number;
  /** Requests this refresh made to jkhub.org. */
  requests: number;
  /** True when the whole catalogue was crawled rather than topped up. */
  full: boolean;
  /** True when the index was current and nobody asked, so nothing was spent. */
  skipped: boolean;
  /**
   * True when the player stopped the crawl. The index stays as it was, and the
   * screen offers to start again.
   */
  cancelled: boolean;
}

/** Which half of the work a refresh is doing. */
export type JkhubIndexPhase = "categories" | "files" | "details";

/** Payload of `jkhub:index-progress`, and the `progress` of the status. */
export interface JkhubIndexProgress {
  game: Game;
  done: number;
  /** An estimate: a category of unknown size counts as one page until asked. */
  total: number;
  phase: JkhubIndexPhase;
  /** Requests made to jkhub.org so far. */
  requests: number;
  /** Milliseconds since this run started, which is what an ETA is made of. */
  elapsedMs: number;
}

/** What `jkhub_search` is asked for. */
export interface JkhubSearchQuery {
  game?: Game;
  /** Empty means the full listing of the category, or of the whole game. */
  query: string;
  categoryId: number | null;
  sort: JkhubSort;
  direction?: SortDirection;
  page: number;
  perPage: number;
}

export const jkhubEvents = {
  downloadProgress: "jkhub:download-progress",
  installed: "jkhub:installed",
  categoriesUpdated: "jkhub:categories-updated",
  // --- slice: jkhub index ---
  indexProgress: "jkhub:index-progress",
  indexUpdated: "jkhub:index-updated",
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
  comments: (id: number, page: number, refresh = false) =>
    call<JkhubComments>("jkhub_comments", { id, page, refresh }),
  /** Follows the download button without fetching the archive. */
  resolveDownload: (id: number) =>
    call<JkhubDownload>("jkhub_resolve_download", { id }),
  /** Downloads if needed and installs into a client. */
  install: (id: number, clientId: string, replace = false, allowIdentical = false) =>
    call<JkhubInstallResult>("jkhub_install", { id, clientId, replace, allowIdentical }),
  /** Opens the file page in the system browser. */
  open: (id: number) => call<void>("jkhub_open", { id }),
  clearCache: () => call<void>("jkhub_clear_cache"),

  // --- slice: jkhub index ---
  /**
   * One page of the catalogue of one game, filtered by a query.
   *
   * Answered from the local index and never from the site, so it costs
   * nothing and can run on every keystroke behind a short debounce.
   */
  search: ({ game, query, categoryId, sort, direction, page, perPage }: JkhubSearchQuery) =>
    call<JkhubSearchResult>("jkhub_search", {
      request: { game: game ?? null, query, categoryId, sort, direction, page, perPage },
    }),
  /**
   * What the index of one game holds.
   *
   * Answering also lets the core top the index up behind the answer, at most
   * once a day per game; the result of that arrives as `jkhub:index-updated`.
   */
  indexStatus: (game?: Game) =>
    call<JkhubIndexStatus>("jkhub_index_status", { game: game ?? null }),
  /**
   * Reads jkhub.org and brings the index up to date.
   *
   * One request plus one per file the front page names and the index does not
   * know. `full` crawls every listing page instead — about 150 requests for
   * Jedi Academy — which the core also falls back to on its own.
   */
  refreshIndex: (game?: Game, full = false) =>
    call<JkhubIndexUpdate>("jkhub_refresh_index", { game: game ?? null, full }),
  // --- slice: jkhub index startup ---
  /**
   * Stops the crawl of one game.
   *
   * The run notices between pages and leaves the index exactly as it was, so
   * nothing is half-written. Answers even when nothing was running.
   */
  cancelIndex: (game?: Game) =>
    call<void>("jkhub_cancel_index", { game: game ?? null }),
};


// ---------------------------------------------------------------------------
// --- slice: bundles ---
//
// Bundles: a recipe for a set of clients, published to JKNet Online. A bundle
// is made of components — each an engine of the registry with a release tag,
// files laid over that release, pk3 and cfg files, a mod folder, launch
// arguments and launch modes — plus files and configs every component shares.
// Installing one creates a client per component; publishing takes a draft the
// author put together in the editor of the launcher. The types mirror
// `src-tauri/src/bundles/types.rs`, `manifest.rs` and `draft.rs`, which in
// turn mirror the service contract, so the three stay readable side by side.
// Field names are camelCase on every side.
// ---------------------------------------------------------------------------

/**
 * Calls a bundles command, or the mock service when the page is in a browser.
 *
 * The same arrangement as `callFriends`: outside Tauri a development build
 * reads the catalogue straight from `scripts/mock-online.mjs`, so the tab has
 * cards to draw without the core. Drafts live on the disk of the launcher and
 * installing and publishing need the disk and the token, which a browser has
 * none of, and `devOnline.ts` refuses them with a sentence saying so.
 */
function callBundles<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (import.meta.env.DEV && !isTauri()) {
    return import("./devOnline").then((module) => module.devBundles<T>(command, args));
  }
  return call<T>(command, args);
}

/** How the catalogue is ordered: likes then installs, publication date, installs. */
export type BundleSort = "popular" | "new" | "installs";

/** Where a version of a bundle is in its life. */
export type BundleVersionStatus = "draft" | "pending" | "published" | "rejected";

/** `home` is `clients\<slug>\home\`, `engine` is `clients\<slug>\engine\`. */
export type BundleFileRoot = "home" | "engine";

/**
 * What a file of a bundle is, read off its extension by the service.
 *
 * `exe` and `dll` are what makes a version wait for review: a version with
 * either is `pending` until an administrator approves it.
 */
export type BundleFileKind = "pk3" | "cfg" | "dll" | "exe" | "other";

/**
 * Where a file of a bundle comes from at install time.
 *
 * `jkhub` is a pk3 added from JKHub and left as it was: the launcher
 * downloads it from jkhub.org as the JKHub tab would. `blob` is a file in the
 * store of the service, addressed by its SHA-256.
 */
export type BundleFileSource =
  | {
      kind: "jkhub";
      fileId: number;
      version?: string | null;
      title?: string | null;
      url?: string | null;
    }
  | { kind: "blob" };

/**
 * Where a `blob` file was taken from before the author changed it.
 *
 * Only on a file that came from JKHub and no longer matches the record there:
 * the card says «modified» and links the original, so a player knows what
 * differs from what jkhub.org serves.
 */
export interface BundleFileOrigin {
  kind: "jkhub";
  fileId: number;
  /** The hash of the file as jkhub.org served it. */
  sha256: string;
  modified: boolean;
}

/** The file of the release an overlay file stands in for. */
export interface BundleFileReplaces {
  sha256: string;
  size: number;
}

/** What the manifest says about a pk3 of `home`, for the card of the file. */
export interface BundleLibraryInfo {
  category: LibraryCategory;
  /** The same codes as `LibraryItem.features`; absent on a manifest written before the core counted them. */
  features?: string[];
  displayName: string;
  /** Entries inside the archive. */
  entries: number;
  /** Top-level folder → number of files under it. At most 32 folders. */
  folders: Record<string, number>;
  /** Names of the maps inside, at most 64. */
  maps: string[];
}

/**
 * The table of contents of a pk3, as a file of the store.
 *
 * The core writes it when the archive is added to a draft — every entry
 * with its path and size, sorted by path — and the publish uploads it as an
 * ordinary file. `bundle_file_listing` reads it back by this hash, so the
 * catalogue can list what an archive holds without downloading the archive.
 */
export interface BundleListingRef {
  sha256: string;
  size: number;
}

/** One file of the manifest, in an overlay, a component or the shared part. */
export interface BundleFile {
  root: BundleFileRoot;
  /** Relative, forward slashes, no `..` and no leading slash. */
  path: string;
  size: number;
  /** 64 lowercase hex characters. */
  sha256: string;
  kind: BundleFileKind;
  source: BundleFileSource;
  /** Only on a pk3 of `home`. */
  library?: BundleLibraryInfo | null;
  /** Only on a pk3: the table of contents of the archive in the store. */
  listing?: BundleListingRef | null;
  /**
   * Only on an overlay file that replaces a file of the release: the hash and
   * size of the original. Absent on a file the overlay adds.
   */
  replaces?: BundleFileReplaces | null;
  /** Only on a `blob` that started as a JKHub file and was changed since. */
  origin?: BundleFileOrigin | null;
}

/** One entry of a pk3, as `draft_file_listing` and `bundle_file_listing` list them. */
export interface ListingEntry {
  /** Inside the archive, forward slashes. */
  path: string;
  size: number;
}

/**
 * The table of contents of one pk3: the entries, how many there are and
 * how many bytes they add up to. Folders are not listed on their own; the
 * dialog derives them from the paths.
 */
export interface Listing {
  entries: ListingEntry[];
  total: number;
  bytes: number;
}

/** One config document of the manifest, made a layer of the client on install. */
export interface BundleConfig {
  name: string;
  text: string;
  priority: number;
}

/** The engine a component is built on. */
export interface BundleEngineRef {
  /** An id of the registry in `src-tauri/src/engines.rs`. */
  engineId: string;
  /** A GitHub release tag, or `null` for «the latest at install time». */
  releaseTag: string | null;
}

/** What a component lays over `engine\`: files replaced or added, files removed. */
export interface BundleOverlay {
  /** Files with `root: "engine"`. */
  files: BundleFile[];
  /** Paths of the release the install deletes from `engine\`. */
  remove: string[];
}

/** One component of the manifest: one client after the install. */
export interface BundleComponent {
  /** `[a-z0-9-]{1,32}`, unique in the bundle. */
  id: string;
  /** 1–40 characters, the suffix of the client name. */
  label: string;
  engine: BundleEngineRef;
  /** A non-empty subset of the modes of the engine. */
  modes: LaunchMode[];
  /** The mod folder, or `null` for `base`. */
  fsGame: string | null;
  launchArgs: string;
  overlay: BundleOverlay;
  /** Files with `root: "home"`. */
  files: BundleFile[];
  configs: BundleConfig[];
}

/** What every component gets: files of `home` and configs layered after its own. */
export interface BundleShared {
  files: BundleFile[];
  configs: BundleConfig[];
}

/** The manifest of one version, schema 2. */
export interface BundleManifest {
  schema: 2;
  game: Game;
  /** 1 to 8. */
  components: BundleComponent[];
  shared: BundleShared;
}

/**
 * One component as the service sums it up for the card: the engine, the
 * modes and the size of the overlay. Computed by the service out of the
 * manifest; the card draws the logos and the «Based on …» line from it.
 */
export interface BundleComponentSummary {
  id: string;
  label: string;
  engineId: string;
  releaseTag: string | null;
  modes: LaunchMode[];
  /** Overlay files with `replaces`. */
  replaced: number;
  /** Overlay files without `replaces`. */
  added: number;
  /** Entries of `overlay.remove`. */
  removed: number;
  fileCount: number;
}

/** Who published a bundle, as the catalogue prints it. */
export interface BundleOwner {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * The name, the summary and the description of a bundle in one language
 * other than its default.
 *
 * The catalogue list carries every translation without `description`; the
 * record of a bundle carries it. An empty field means «not translated»: the
 * screen shows the default language for that field.
 */
export interface Translation {
  name: string;
  summary: string;
  description?: string;
}

/** One card of the catalogue. */
export interface BundleCard {
  id: string;
  slug: string;
  /** In `language`. */
  name: string;
  summary: string;
  /** The code of the language of `name`, `summary` and `description`: one of the launcher's, `en` by default. */
  language: string;
  /** The other languages by code; never the code of `language`. Up to seven. */
  translations: Record<string, Translation>;
  game: Game;
  /** The engine of the first component; empty for a bundle without a published version. */
  engineId: string;
  releaseTag: string | null;
  /** The components of the latest published version; empty before the first one. */
  components: BundleComponentSummary[];
  /** `null` when the owner deleted their account: the bundle stays. */
  owner: BundleOwner | null;
  tags: string[];
  /** Bytes the store serves for the latest version: what an install downloads from JKNet. */
  blobBytes: number;
  fileCount: number;
  hasExecutables: boolean;
  featured: boolean;
  likes: number;
  installs: number;
  latestVersionId: string | null;
  latestLabel: string | null;
  /** RFC 3339, `null` while no version is published. */
  publishedAt: string | null;
  updatedAt: string;
  /** Present in answers that carried a token. */
  likedByMe?: boolean;
}

/** A version without its manifest, for the **Versions** list. */
export interface BundleVersionSummary {
  id: string;
  bundleId: string;
  label: string;
  changelog: string;
  /** The engine of the first component. */
  engineId: string;
  releaseTag: string | null;
  components: BundleComponentSummary[];
  fileCount: number;
  blobBytes: number;
  hasExecutables: boolean;
  status: BundleVersionStatus;
  /** What the administrator wrote when rejecting, or `null`. */
  reviewNote: string | null;
  reviewedBy?: string | null;
  reviewedAt: string | null;
  createdAt: string;
  publishedAt: string | null;
}

/** A version with its manifest, the answer of `get_bundle_version`. */
export interface BundleVersion extends BundleVersionSummary {
  manifest: BundleManifest;
}

/** The whole record of a bundle: the card, the description, the versions. */
export interface BundleDetails extends BundleCard {
  /** Markdown, in `language`; the translations of the record carry theirs. */
  description: string;
  website: string | null;
  discord: string | null;
  hidden: boolean;
  /** Sent back with `PUT bundles/{id}`; a stale one answers `409 conflict`. */
  revision: number;
  /** The latest published version with its manifest, or `null` when there is none yet. */
  latest: BundleVersion | null;
  /** Every status for the owner and an administrator, `published` only for the rest. */
  versions: BundleVersionSummary[];
  likedByMe: boolean;
}

/** One client of this machine that came out of a bundle, as `get_bundle` lists it. */
export interface InstalledBundleClient {
  clientId: string;
  versionId: string;
  componentId: string;
  role: "installed";
  /** True while the install of that client is unfinished. */
  pending: boolean;
}

/** What the core adds to `get_bundle`: the clients of this machine that came out of it. */
export interface BundleLocal {
  installedClients: InstalledBundleClient[];
  /**
   * Whether the engine of each component of the latest version is in this
   * build's registry, by component id. A component missing from the map is
   * read as known.
   */
  engineKnown: Record<string, boolean>;
}

/** The answer of `get_bundle`. */
export interface BundleDetailsWithLocal extends BundleDetails {
  local: BundleLocal;
}

/** What `list_bundles` is asked for. */
export interface BundleQuery {
  game: Game;
  sort: BundleSort;
  q?: string;
  engineId?: string | null;
  tag?: string | null;
  /** At most 100. */
  limit?: number;
  offset?: number;
}

/** The answer of `list_bundles`. */
export interface BundleList {
  items: BundleCard[];
  total: number;
}

/** The answer of `like_bundle`. */
export interface BundleLikes {
  likes: number;
  likedByMe: boolean;
}

/** The answer of `my_bundles`. */
export interface MyBundles {
  bundles: BundleDetails[];
  /** Bytes of the distinct files the versions of this account reference. */
  usedBytes: number;
  quotaBytes: number;
}

/** One line of the review queue: a `pending` version with its bundle. */
export interface PendingVersion {
  bundle: BundleCard;
  /** With the manifest: the queue lists the executables and their hashes. */
  version: BundleVersion;
}

/**
 * What `client.json` remembers about the bundle or the draft a client came from.
 *
 * There is no bundle object in the launcher beside the client: the bundle
 * lives on the service, the draft in the data folder, and this is the link.
 */
export interface ClientBundleLink {
  /** `null` on a client installed from a draft that is not published yet. */
  bundleId: string | null;
  bundleSlug: string | null;
  /** The name of the bundle, or of the draft. */
  bundleName: string;
  /** The draft `install_bundle_draft` created the client from, if any. */
  draftId?: string | null;
  /** `null` on a client from a draft. */
  versionId: string | null;
  versionLabel: string | null;
  componentId: string;
  componentLabel: string;
  /** `installed` since this edition: publishing takes a draft, not a client. */
  role: "installed" | "published";
  /**
   * True when the component laid files over `engine\` or removed some. Such
   * a client offers no **Check updates**: a newer release would write over
   * the laid files.
   */
  engineOverlay: boolean;
  /** RFC 3339. */
  linkedAt: string;
  /**
   * True from the start of the install to its end: the core writes the link
   * first and clears the flag last, so a retry can tell which client it may
   * carry on in. Absent from a link written before the flag existed.
   */
  pending?: boolean;
}

// --- drafts ---

/** The scope of a draft file or config that belongs to every component. */
export const SHARED_SCOPE = "shared";

/**
 * Where a file of a draft was taken from.
 *
 * `jkhub` carries the hash of the file as jkhub.org served it: while the
 * current hash matches, the manifest points at JKHub and nothing is uploaded;
 * once it differs the file goes to the store with `origin.modified`. A
 * `client` file with a `provenance` is a JKHub file by the same rule.
 * `release` is the hash of the release file an overlay file replaces.
 */
export type DraftFileOrigin =
  | { kind: "disk"; sourcePath: string }
  | {
      kind: "jkhub";
      fileId: number;
      version?: string | null;
      title?: string | null;
      url?: string | null;
      sha256: string;
    }
  | { kind: "client"; clientId: string; itemId: string; provenance?: JkhubProvenance | null }
  | { kind: "release"; sha256: string };

/** One file of a draft: a manifest file with its origin instead of a source. */
export interface DraftFile {
  root: BundleFileRoot;
  path: string;
  size: number;
  sha256: string;
  kind: BundleFileKind;
  library?: BundleLibraryInfo | null;
  /** Only on a pk3: the table of contents the core wrote when the file was added. */
  listing?: BundleListingRef | null;
  origin: DraftFileOrigin;
}

/**
 * One picture of the description of a draft, `bundles\drafts\<id>\images\`.
 *
 * The description points at it as `![…](blob:<sha256>)`; the publish uploads
 * it to the store first, so the same address works in the catalogue.
 */
export interface DraftImage {
  sha256: string;
  size: number;
  /** `image/png`, `image/jpeg`, `image/gif` or `image/webp`, read off the first bytes. */
  contentType: string;
  /** The name of the file it was added from, for the alt text and the list. */
  fileName: string;
}

/** One config document of a draft; `sourceConfigId` names the Configs document it came from. */
export interface DraftConfig {
  name: string;
  text: string;
  priority: number;
  sourceConfigId?: string | null;
}

/** The overlay of a draft component: replaced and added files, and paths to remove. */
export interface DraftOverlay {
  files: DraftFile[];
  remove: string[];
}

/** One component of a draft. */
export interface DraftComponent {
  id: string;
  label: string;
  engineId: string;
  releaseTag: string | null;
  modes: LaunchMode[];
  fsGame: string | null;
  launchArgs: string;
  overlay: DraftOverlay;
  files: DraftFile[];
  configs: DraftConfig[];
}

/** A translation of a draft: every field present, empty where nothing is translated yet. */
export type DraftTranslation = Translation & { description: string };

/**
 * `bundles\drafts\<draftId>\draft.json`: a bundle being put together.
 *
 * Every edit is a command that rewrites the file and answers with the whole
 * draft, so a screen never merges: it drops the answer into the cache.
 */
export interface Draft {
  id: string;
  game: Game;
  createdAt: string;
  updatedAt: string;
  /** The fields of the bundle, with the same limits as the service. */
  name: string;
  summary: string;
  description: string;
  /**
   * The language of the three fields above: the interface language of the
   * launcher when the draft was made, if it is one the launcher speaks.
   */
  language: string;
  /** The other languages by code; never the code of `language`. Up to seven. */
  translations: Record<string, DraftTranslation>;
  tags: string[];
  website: string | null;
  discord: string | null;
  /** The fields of the version the next publish creates. */
  versionLabel: string;
  changelog: string;
  /** Set when the draft is bound to a published bundle: a publish adds a version to it. */
  bundleId: string | null;
  bundleSlug: string | null;
  lastVersionId: string | null;
  components: DraftComponent[];
  shared: { files: DraftFile[]; configs: DraftConfig[] };
  /**
   * The pictures of the description. Absent from a `draft.json` written
   * before pictures existed, which reads as none.
   */
  images?: DraftImage[];
}

/** One line of `list_bundle_drafts`. */
export interface DraftSummary {
  id: string;
  name: string;
  game: Game;
  componentCount: number;
  fileCount: number;
  /** Bytes a publish would upload. */
  blobBytes: number;
  bundleId: string | null;
  updatedAt: string;
}

/** What `update_bundle_draft` changes. A field left out keeps its value. */
export interface DraftPatch {
  /** 2–64 characters. */
  name?: string;
  /** Up to 200 characters. */
  summary?: string;
  /** Markdown, up to 32 KiB. */
  description?: string;
  /**
   * The new default language. The core swaps the fields: the name, the
   * summary and the description of the draft become the translation of the
   * old language, and the translation of the new one becomes the fields.
   */
  language?: string;
  /** The whole set of translations: what is sent replaces what the draft held. */
  translations?: Record<string, DraftTranslation>;
  /** Up to 10, each `[a-z0-9-]{1,24}`. */
  tags?: string[];
  website?: string | null;
  discord?: string | null;
  /** Up to 32 characters. */
  versionLabel?: string;
  /** Up to 4000 characters. */
  changelog?: string;
}

/** What `draft_add_component` is given; the core builds the id out of the label. */
export interface NewDraftComponent {
  engineId: string;
  releaseTag: string | null;
  label: string;
  modes: LaunchMode[];
}

/** What `draft_update_component` changes. */
export interface DraftComponentPatch {
  label?: string;
  releaseTag?: string | null;
  modes?: LaunchMode[];
  fsGame?: string | null;
  launchArgs?: string;
}

/**
 * The state of one file of the release under the overlay of a component.
 *
 * `release` is untouched, `replaced` has an overlay file over it, `added`
 * exists in the overlay alone, `removed` is deleted on install.
 */
export type ReleaseFileState = "release" | "replaced" | "added" | "removed";

/** One file of `draft_engine_files`. */
export interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
  state: ReleaseFileState;
}

/** The answer of `draft_engine_files`: the release archive as the install would unpack it. */
export interface ReleaseView {
  releaseTag: string | null;
  files: ReleaseFile[];
}

/**
 * Codes of `validate_bundle_draft`: `bundles:editor.issue.<code>`.
 *
 * The core may add one this list does not know, which is why a screen reads
 * the code through `i18n.exists`.
 */
export type DraftIssueCode =
  | "noComponents"
  | "noEngine"
  | "engineUnknown"
  | "noModes"
  | "emptyBundle"
  | "nameInvalid"
  | "tooLarge"
  | "duplicatePath"
  | "executablesPresent"
  | "passwordsStripped"
  | "configTooLong"
  | "summaryTooLong"
  | "descriptionTooLong"
  | "imageMissing"
  | "unusedImages";

/** One error or warning of a draft. Everything but the code is optional. */
export interface DraftIssue {
  code: DraftIssueCode | string;
  /**
   * The part of the draft the issue is about: the id of a component, or
   * `shared` for the shared files and configs. Absent for the draft as a
   * whole: its name, its size, that it has no component.
   */
  scope?: string | null;
  /** The component of `scope`, when it is one. Absent for `shared` and for the draft as a whole. */
  componentId?: string | null;
  /** The file or config the issue names, when it names one. */
  path?: string | null;
  /**
   * The code of the translation the issue is about — a name outside its
   * limits, a picture a translated description refers to. Absent for the
   * default language.
   */
  language?: string | null;
  /**
   * A count the finding carries: the lines `passwordsStripped` removed,
   * the characters of a `summaryTooLong`, the bytes of a `descriptionTooLong`.
   */
  count?: number | null;
  /** An English sentence of the core, the fallback when the code has no key. */
  message?: string | null;
}

/** The answer of `validate_bundle_draft`. */
export interface DraftIssues {
  /** A draft with one of these cannot be published or tested. */
  errors: DraftIssue[];
  warnings: DraftIssue[];
  /** Bytes a publish would upload to the store. */
  blobBytes: number;
  /** Bytes an install would fetch from jkhub.org instead. */
  jkhubBytes: number;
  fileCount: number;
  /** Paths of the exe and dll files, the reason a version waits for review. */
  executables: string[];
}

/** The answer of `publish_bundle_draft`. */
export interface PublishResult {
  bundle: BundleDetails;
  version: BundleVersion;
}

// --- events ---

/** Phase of `bundles:install-progress`. */
export type BundleInstallPhase = "engine" | "files" | "configs" | "done" | "error";

/**
 * Payload of `bundles:install-progress`.
 *
 * An install from the catalogue names `bundleId` and `versionId` and no
 * `draftId`; a test install from a draft the other way round. `componentId`
 * and `clientId` name the component being written at the moment.
 */
export interface BundleInstallProgress {
  bundleId: string | null;
  versionId: string | null;
  draftId: string | null;
  componentId: string | null;
  clientId: string | null;
  phase: BundleInstallPhase;
  /** Counted from 1 while `phase` is `files`. */
  fileIndex: number;
  fileCount: number;
  /** Path of the file being fetched, or `null` between files. */
  currentFile: string | null;
  /** Bytes of the current file received so far. */
  downloaded: number;
  /** Bytes of the current file; zero when unknown. */
  total: number;
  /** One line for the bar; on `error` it names the file that failed. */
  message: string;
  /** Codes the `done` phase carries, `jkhubDiffers` today; empty otherwise. */
  warnings?: string[];
}

/** Phase of `bundles:publish-progress`. */
export type BundlePublishPhase =
  | "hashing"
  | "creating"
  | "uploading"
  | "publishing"
  | "done"
  | "error";

/** Payload of `bundles:publish-progress`. */
export interface BundlePublishProgress {
  draftId: string;
  /** Always `null`: a publish reads the draft, not a client. */
  clientId: string | null;
  phase: BundlePublishPhase;
  fileIndex: number;
  fileCount: number;
  currentFile: string | null;
  uploaded: number;
  total: number;
  message: string;
  /**
   * The bundle the version goes into, from the `creating` phase on: the one
   * the draft is bound to, or the one the core has just created. `null`
   * before the core knows it.
   */
  bundleId?: string | null;
}

/**
 * Payload of `bundles:preview-progress`: a file of the store coming down
 * for **Preview** in the catalogue. A JKHub file reports through
 * `jkhub:download-progress` instead.
 */
export interface BundlePreviewProgress {
  sha256: string;
  downloaded: number;
  /** Bytes of the file; zero when unknown. */
  total: number;
}

/** Event names the bundles slice emits. */
export const bundleEvents = {
  installProgress: "bundles:install-progress",
  publishProgress: "bundles:publish-progress",
  previewProgress: "bundles:preview-progress",
} as const;

/**
 * The bundles commands, `src-tauri/src/bundles/mod.rs`.
 *
 * The three reads of the catalogue go through `callBundles`, so a browser
 * review has cards; everything else needs the launcher.
 */
export const bundlesIpc = {
  // --- catalogue ---
  list: (query: BundleQuery) =>
    callBundles<BundleList>("list_bundles", {
      query: {
        game: query.game,
        sort: query.sort,
        q: query.q ?? "",
        engineId: query.engineId ?? null,
        tag: query.tag ?? null,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      },
    }),
  get: (bundleId: string) =>
    callBundles<BundleDetailsWithLocal>("get_bundle", { bundleId }),
  version: (bundleId: string, versionId: string) =>
    callBundles<BundleVersion>("get_bundle_version", { bundleId, versionId }),
  /**
   * Creates one client per chosen component out of a version, or carries on
   * in the clients of `existingClientIds` after a failed try. Long: the bar
   * is `bundles:install-progress`.
   */
  install: (
    bundleId: string,
    versionId: string,
    baseName: string,
    componentIds: string[],
    existingClientIds?: Record<string, string> | null,
  ) =>
    callBundles<Client[]>("install_bundle", {
      bundleId,
      versionId,
      baseName,
      componentIds,
      existingClientIds: existingClientIds ?? null,
    }),
  like: (bundleId: string, liked: boolean) =>
    callBundles<BundleLikes>("like_bundle", { bundleId, liked }),
  mine: () => callBundles<MyBundles>("my_bundles"),
  remove: (bundleId: string) => callBundles<void>("delete_bundle", { bundleId }),
  pending: () => callBundles<PendingVersion[]>("list_pending_bundle_versions"),
  review: (versionId: string, approve: boolean, note?: string | null) =>
    callBundles<BundleVersion>("review_bundle_version", {
      versionId,
      approve,
      note: note ?? null,
    }),
  setFlags: (bundleId: string, flags: { featured?: boolean; hidden?: boolean }) =>
    callBundles<BundleDetails>("set_bundle_flags", {
      bundleId,
      featured: flags.featured ?? null,
      hidden: flags.hidden ?? null,
    }),

  // --- drafts ---
  listDrafts: () => callBundles<DraftSummary[]>("list_bundle_drafts"),
  /**
   * A draft for one game. With `fromClientId` it opens with one component
   * read off that client: the engine and its tag, the modes, the mod folder
   * and the arguments, the enabled pk3 files with their origins, the config
   * layers and the overlay the client's `engine\` differs from the release by.
   */
  createDraft: (game: Game, name: string, fromClientId?: string | null) =>
    callBundles<Draft>("create_bundle_draft", {
      game,
      name,
      fromClientId: fromClientId ?? null,
    }),
  /** A draft bound to a published bundle, with the files of a version downloaded. */
  createDraftFromBundle: (bundleId: string, versionId?: string | null) =>
    callBundles<Draft>("create_bundle_draft_from_bundle", {
      bundleId,
      versionId: versionId ?? null,
    }),
  getDraft: (draftId: string) => callBundles<Draft>("get_bundle_draft", { draftId }),
  updateDraft: (draftId: string, patch: DraftPatch) =>
    callBundles<Draft>("update_bundle_draft", { draftId, patch }),
  deleteDraft: (draftId: string) => callBundles<void>("delete_bundle_draft", { draftId }),
  addComponent: (draftId: string, component: NewDraftComponent) =>
    callBundles<Draft>("draft_add_component", { draftId, component }),
  updateComponent: (draftId: string, componentId: string, patch: DraftComponentPatch) =>
    callBundles<Draft>("draft_update_component", { draftId, componentId, patch }),
  removeComponent: (draftId: string, componentId: string) =>
    callBundles<Draft>("draft_remove_component", { draftId, componentId }),
  /** `folder` is `base` or a mod folder; `scope` a component id or `shared`. */
  addFilesFromDisk: (draftId: string, scope: string, folder: string, paths: string[]) =>
    callBundles<Draft>("draft_add_files_from_disk", { draftId, scope, folder, paths }),
  /** Downloads the record from jkhub.org; the bar is `jkhub:download-progress`. */
  addFileFromJkhub: (draftId: string, scope: string, folder: string, fileId: number) =>
    callBundles<Draft>("draft_add_file_from_jkhub", { draftId, scope, folder, fileId }),
  /** Copies library files of a client with their origins. */
  addFilesFromClient: (draftId: string, scope: string, clientId: string, itemIds: string[]) =>
    callBundles<Draft>("draft_add_files_from_client", { draftId, scope, clientId, itemIds }),
  removeFile: (draftId: string, scope: string, root: BundleFileRoot, path: string) =>
    callBundles<Draft>("draft_remove_file", { draftId, scope, root, path }),
  /** Replaces the whole list of configs of a scope. */
  setConfigs: (draftId: string, scope: string, configs: DraftConfig[]) =>
    callBundles<Draft>("draft_set_configs", { draftId, scope, configs }),
  /** The release archive is taken from the cache or downloaded: slow the first time. */
  engineFiles: (draftId: string, componentId: string) =>
    callBundles<ReleaseView>("draft_engine_files", { draftId, componentId }),
  replaceEngineFile: (draftId: string, componentId: string, path: string, sourcePath: string) =>
    callBundles<Draft>("draft_replace_engine_file", { draftId, componentId, path, sourcePath }),
  /** `folder` is the path inside `engine\` the files go under; empty for the root. */
  addEngineFiles: (draftId: string, componentId: string, folder: string, paths: string[]) =>
    callBundles<Draft>("draft_add_engine_files", { draftId, componentId, folder, paths }),
  excludeEngineFile: (draftId: string, componentId: string, path: string, excluded: boolean) =>
    callBundles<Draft>("draft_exclude_engine_file", { draftId, componentId, path, excluded }),
  /** Takes a replacement or an addition back; the release file stands again. */
  restoreEngineFile: (draftId: string, componentId: string, path: string) =>
    callBundles<Draft>("draft_restore_engine_file", { draftId, componentId, path }),
  validateDraft: (draftId: string) => callBundles<DraftIssues>("validate_bundle_draft", { draftId }),
  /**
   * Creates one client per chosen component out of the draft, the files
   * copied from its folder. Long: the bar is `bundles:install-progress` with
   * `draftId`. `existingClientIds` carries a failed try on in its clients.
   */
  installDraft: (
    draftId: string,
    baseName: string,
    componentIds: string[],
    existingClientIds?: Record<string, string> | null,
  ) =>
    callBundles<Client[]>("install_bundle_draft", {
      draftId,
      baseName,
      componentIds,
      existingClientIds: existingClientIds ?? null,
    }),
  /** Long: the bar is `bundles:publish-progress`. */
  publishDraft: (draftId: string) =>
    callBundles<PublishResult>("publish_bundle_draft", { draftId }),

  // --- description pictures ---
  /**
   * Copies a picture into the draft and answers with its record. The core
   * refuses a file that is not a PNG, JPEG, GIF or WebP, or is larger than
   * 2 MiB; adding the same picture twice answers with the existing record.
   */
  addImage: (draftId: string, sourcePath: string) =>
    callBundles<DraftImage>("draft_add_image", { draftId, sourcePath }),
  /** Takes a picture out of the draft and answers with the draft, like every other edit. */
  removeImage: (draftId: string, sha256: string) =>
    callBundles<Draft>("draft_remove_image", { draftId, sha256 }),
  /** The absolute path of a picture of the draft, for `convertFileSrc`. */
  imagePath: (draftId: string, sha256: string) =>
    callBundles<string>("draft_image_path", { draftId, sha256 }),

  // --- contents of files ---
  /** The table of contents of a pk3 of the draft, read off its folder. */
  draftFileListing: (draftId: string, scope: string, root: BundleFileRoot, path: string) =>
    callBundles<Listing>("draft_file_listing", { draftId, scope, root, path }),
  /**
   * The table of contents of a pk3 of a published bundle, by the hash of its
   * `listing` file: downloaded from the store the first time, read from
   * `cache\bundles\listings\` after.
   */
  fileListing: (sha256: string) => callBundles<Listing>("bundle_file_listing", { sha256 }),
  /** The text of a cfg file of the draft, up to 64 KiB. */
  draftFileText: (draftId: string, scope: string, root: BundleFileRoot, path: string) =>
    callBundles<string>("draft_file_text", { draftId, scope, root, path }),
  /**
   * The text of a cfg file of a published bundle, by its own hash, up to
   * 64 KiB. `path` is the path the manifest gives the file: the core refuses
   * a pk3, a dll or an exe by it, the way `draft_file_text` does.
   */
  fileText: (sha256: string, path: string) =>
    callBundles<string>("bundle_file_text", { sha256, path }),

  // --- preview of the objects inside a pk3 ---
  /**
   * Opens a preview session on a pk3 of the draft, with the assets of the
   * game and no client. The rest is `filePreviewIpc`: `assets` and `release`.
   */
  previewDraftFile: (draftId: string, scope: string, root: BundleFileRoot, path: string) =>
    callBundles<FilePreview>("preview_draft_file", { draftId, scope, root, path }),
  /**
   * The same on a pk3 of a published version: the core fetches the file
   * first — from the store with `bundles:preview-progress`, or from JKHub
   * with `jkhub:download-progress` — and keeps it in `cache\bundles\preview\`.
   */
  previewBundleFile: (
    bundleId: string,
    versionId: string,
    scope: string,
    root: BundleFileRoot,
    path: string,
  ) =>
    callBundles<FilePreview>("preview_bundle_file", { bundleId, versionId, scope, root, path }),
};

/** The hash a `blob:<sha256>` address of a description points at, or `null` for any other address. */
export function blobSha256(src: string): string | null {
  const match = /^blob:([0-9a-f]{64})$/i.exec(src.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Where the store serves a file: `<service>/v1/blobs/<sha256>`. */
export function blobUrl(onlineUrl: string, sha256: string): string {
  return `${onlineUrl.replace(/\/+$/, "")}/v1/blobs/${sha256}`;
}

/** The VirusTotal page of a file, by its SHA-256. */
export function virusTotalUrl(sha256: string): string {
  return `https://www.virustotal.com/gui/file/${sha256}`;
}

// ---------------------------------------------------------------------------
// --- slice: pk3 editor ---
//
// The editor of one pk3 archive, `src-tauri/src/pk3_editor.rs`. A session is
// opened on the archive of a draft file or of a library file and lives in the
// core until it is closed; every edit is kept beside the archive and answers
// with the whole session, so the dialog never merges: it drops the answer
// into the cache. **Save** rewrites the archive and updates its owner — the
// draft, or the library of the client — which the hooks re-read.
// ---------------------------------------------------------------------------

/**
 * Where the archive the editor opens comes from: a file of a draft, by scope
 * and path, or a file of the library of a client. A JKHub file of the cache
 * and a file of the catalogue are read through the preview only.
 */
export type Pk3EditorTarget =
  | { kind: "draft"; draftId: string; scope: string; root: BundleFileRoot; path: string }
  | { kind: "library"; clientId: string; itemId: string };

/** What an entry of the archive is, read off its path by the core. */
export type Pk3EntryKind = "image" | "text" | "model" | "sound" | "map" | "other";

/**
 * What the session has done to an entry since the archive was opened.
 * `removed` entries stay in the list, crossed out, until **Save** or
 * **Discard**.
 */
export type Pk3EntryState = "unchanged" | "modified" | "added" | "renamed" | "removed";

/** One entry of the archive as the session sees it. */
export interface Pk3EditorEntry {
  /** Inside the archive, forward slashes. */
  path: string;
  size: number;
  kind: Pk3EntryKind;
  state: Pk3EntryState;
  /** The header of a picture, when the core could read it. */
  image?: { width: number; height: number; format: string } | null;
  /** A file the core reads and writes as text: the code page it uses. */
  text?: { encoding: string } | null;
  /** On a `renamed` entry: the path it had when the archive was opened. */
  renamedFrom?: string | null;
}

/** One open archive: the entries with their states and whether anything is unsaved. */
export interface Pk3EditorSession {
  id: string;
  target: Pk3EditorTarget;
  archivePath: string;
  /** An edit is waiting for **Save**. */
  dirty: boolean;
  entries: Pk3EditorEntry[];
  /** Bytes of the archive on disk. */
  bytes: number;
  /** The archive can be read but not written here. */
  readOnly: boolean;
}

/** What `pk3_editor_save` answers with: the archive as written. */
export interface Pk3EditorSaved {
  sha256: string;
  size: number;
  /** How many entries the written archive holds. */
  entries: number;
}

/**
 * The pk3 editor commands. Every edit answers with the session; the reads
 * answer with the same shapes the preview uses, `PreviewText` and
 * `PreviewImage`.
 */
export const pk3EditorIpc = {
  /** Opens a session on the archive of the target, or answers with the one already open on it. */
  open: (target: Pk3EditorTarget) => call<Pk3EditorSession>("pk3_editor_open", { target }),
  state: (sessionId: string) => call<Pk3EditorSession>("pk3_editor_state", { sessionId }),
  /** The text of an entry, up to 512 KiB, decoded by the code page of the entry; an edited entry is read from the session. */
  readText: (sessionId: string, path: string) =>
    call<PreviewText>("pk3_editor_read_text", { sessionId, path }),
  /** A picture of the archive; `maxSize` asks for a thumbnail no wider or taller than that. */
  readImage: (sessionId: string, path: string, maxSize?: number) =>
    call<PreviewImage>("pk3_editor_read_image", { sessionId, path, maxSize: maxSize ?? null }),
  /** Writes the text of an entry in its code page; a path the archive has not got creates the entry. */
  writeText: (sessionId: string, path: string, text: string) =>
    call<Pk3EditorSession>("pk3_editor_write_text", { sessionId, path, text }),
  /** Replaces an entry with a file from the disk; a picture is converted to the format of the entry. */
  replace: (sessionId: string, path: string, sourcePath: string) =>
    call<Pk3EditorSession>("pk3_editor_replace", { sessionId, path, sourcePath }),
  /** Adds files from the disk into `folder` (empty for the root), lowercased; an entry at the same path is replaced. */
  addFiles: (sessionId: string, folder: string, sourcePaths: string[]) =>
    call<Pk3EditorSession>("pk3_editor_add_files", { sessionId, folder, sourcePaths }),
  /** Marks entries for removal; a path with a trailing slash takes a whole folder. */
  remove: (sessionId: string, paths: string[]) =>
    call<Pk3EditorSession>("pk3_editor_remove", { sessionId, paths }),
  /** Renames an entry, or a folder with everything under it when both paths end in a slash. */
  rename: (sessionId: string, from: string, to: string) =>
    call<Pk3EditorSession>("pk3_editor_rename", { sessionId, from, to }),
  /** Writes entries, or whole folders by a trailing slash, into a folder on the disk. */
  extract: (sessionId: string, paths: string[], targetDir: string) =>
    call<{ files: number }>("pk3_editor_extract", { sessionId, paths, targetDir }),
  /** Rewrites the archive and updates its owner; the session stays open on the written archive. */
  save: (sessionId: string) => call<Pk3EditorSaved>("pk3_editor_save", { sessionId }),
  /** Throws every unsaved edit away. */
  discard: (sessionId: string) => call<Pk3EditorSession>("pk3_editor_discard", { sessionId }),
  /** Ends the session and deletes what it kept beside the archive. */
  close: (sessionId: string) => call<void>("pk3_editor_close", { sessionId }),
};

// ---------------------------------------------------------------------------
// --- slice: chat ---
//
// Friends chat, `src-tauri/src/chat/`. The types mirror the wire shapes of the
// service (the `Conversation`, `Message` and friends of `online/types.rs`) and
// the views the core builds on top of them. The core is the only writer: it
// holds the connection, the outbox, the drafts and the read markers, and every
// window only shows what it is told and reports what it looks at. Nothing here
// talks to the service, and no type carries a token or a host's address.
// ---------------------------------------------------------------------------

/** `direct`: two friends. `group`: up to 20 friends. `server`: the chat of a private server. */
export type ChatKind = "direct" | "group" | "server";

/** How a conversation notifies: every message, only mentions and replies, or never. */
export type ChatNotifyLevel = "all" | "mentions" | "mute";

/** One member of a conversation, as the service shows it to me. */
export interface ChatMember {
  user: OnlineUser;
  /** `owner`: the creator of a group or the host of a server chat. */
  role: "owner" | "member";
  joinedAt: string;
  /**
   * The last message this member has read. `null` for another member when
   * either of us hides read receipts; my own is always a number.
   */
  readSeq: number | null;
}

/** What a file of a message is, decided by the service from its bytes and its name. */
export type ChatFileClass =
  | "image"
  | "video"
  | "demo"
  | "config"
  | "archive"
  | "executable"
  | "other";

/** Where an attachment came from: the file picker, the Media screen or the clipboard. */
export type ChatFileOrigin = "media" | "file" | "clipboard";

export interface ChatFileMeta {
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  origin?: ChatFileOrigin | null;
}

/** One file of a message. The bytes stay on the service until the core fetches them. */
export interface ChatFileRef {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  class: ChatFileClass;
  /** An executable, whatever its name says: the save asks first. */
  danger: boolean;
  meta: ChatFileMeta | null;
}

/**
 * The quote of a reply.
 *
 * `missing` when the original is out of my reach: it expired, or it is older
 * than the moment I joined. `senderId: null` is a deleted account.
 */
export interface ChatReplyRef {
  seq: number;
  senderId?: string | null;
  /** Up to 140 characters, mention tokens included. */
  excerpt?: string;
  missing?: boolean;
}

/** Who reacted with one emoji, in the order they did. */
export interface ChatReactionGroup {
  emoji: string;
  userIds: string[];
}

/** What a system line records. The ids may name an account that is gone: `null`. */
export type ChatSystemEvent =
  | "created"
  | "memberAdded"
  | "memberJoined"
  | "memberLeft"
  | "memberRemoved"
  | "renamed"
  | "ownerChanged"
  | "historyForNewMembers"
  | "serverStarted";

export interface ChatSystem {
  event: ChatSystemEvent;
  userId?: string | null;
  by?: string | null;
  title?: string | null;
  /** `historyForNewMembers`: whether it was turned on. */
  on?: boolean | null;
}

/**
 * A card of a message: a server, a bundle, a map, a bind… Each kind has its
 * own fields, validated by the service; `fallbackText` is what a launcher that
 * does not know the kind shows instead.
 */
export interface ChatCard {
  type: string;
  v: number;
  fallbackText: string;
  [field: string]: unknown;
}

/** One message. Immutable once sent: no edits, no deletions. */
export interface ChatMessage {
  conversationId: string;
  /** Gap-free per conversation: the address of the message together with the conversation. */
  seq: number;
  /** `null` on a system line, and on a user message of a deleted account. */
  senderId: string | null;
  /** The id the sending launcher gave it, which is how the outbox recognises its own message. */
  clientId: string | null;
  kind: "user" | "system";
  /** Plain text with `<@id>` mention tokens; `<@deleted>` names a deleted account. */
  body: string;
  cards: ChatCard[];
  files: ChatFileRef[];
  /** Who the message mentions, a reply's author included. */
  mentions: string[];
  replyTo: ChatReplyRef | null;
  reactions: ChatReactionGroup[];
  system: ChatSystem | null;
  createdAt: string;
}

/** The server a server chat belongs to. Nothing about how to reach it. */
export interface ChatServerRef {
  hostId: string;
  sessionId: string;
}

/** One conversation as the service computes it for me. */
export interface Conversation {
  id: string;
  kind: ChatKind;
  /** A group's own name; empty or `null` shows the member names. */
  title: string | null;
  ownerId: string | null;
  members: ChatMember[];
  lastSeq: number;
  lastMessage: ChatMessage | null;
  readSeq: number;
  /** I see only the messages after this one: the history before I joined is hidden. */
  visibleFromSeq: number;
  /** Unread messages of other senders, capped at 100. */
  unread: number;
  unreadMentions: number;
  notify: ChatNotifyLevel;
  /** `false` for a direct chat with somebody who is no longer a friend, or whose account is gone. */
  canSend: boolean;
  /** Whether people who join later see the history. Always `false` for a direct chat. */
  historyForNewMembers: boolean;
  server: ChatServerRef | null;
  createdAt: string;
}

/** An invitation into a group of a player who asks before being added. */
export interface ChatGroupInvite {
  conversationId: string;
  title: string | null;
  invitedBy: OnlineUser;
  memberCount: number;
  createdAt: string;
  expiresAt: string;
}

/** My chat privacy, kept on the service. Both switches work both ways. */
export interface ChatPrivacy {
  shareReadReceipts: boolean;
  shareTyping: boolean;
  /** `ask`: friends invite me into groups instead of adding me. */
  groupAdd: "friends" | "ask";
}

export interface ChatQuota {
  usedBytes: number;
  quotaBytes: number;
  /** When the oldest of my files expires and frees its space. */
  nextFreeAt: string | null;
}

/** Where a message waiting in the outbox is. */
export type ChatOutboxStatus = "queued" | "uploading" | "sending" | "failed";

/** A message the core has not delivered yet. Lives in the core's memory only. */
export interface ChatOutboxEntry {
  clientId: string;
  conversationId: string;
  body: string;
  cards: ChatCard[];
  /** Handles of the staged files that go with it. */
  attachments: string[];
  replySeq: number | null;
  status: ChatOutboxStatus;
  /** Why it failed: the reason code of the service, or a short English line. */
  error: string | null;
  createdAt: string;
}

/** Everything the chat surface draws from, kept by the core and pushed as `chat:state`. */
export interface ChatStateView {
  /** `false` when the service has no chat yet: the surface says so instead of failing. */
  available: boolean;
  signedIn: boolean;
  /** Whether the live socket is up. Messages still queue while it is not. */
  connected: boolean;
  conversations: Conversation[];
  groupInvites: ChatGroupInvite[];
  privacy: ChatPrivacy | null;
  quota: ChatQuota | null;
  /** Unread messages of chats that are not muted. */
  unreadTotal: number;
  /** Unread mentions of every chat, muted ones included. */
  mentionTotal: number;
  outbox: ChatOutboxEntry[];
}

/** One page of a thread, in ascending `seq`. */
export interface ChatMessagePage {
  messages: ChatMessage[];
  hasBefore: boolean;
  hasAfter: boolean;
}

/** Which page of a thread to read. At most one of the three; none reads the newest page. */
export interface ChatPageQuery {
  before?: number;
  after?: number;
  around?: number;
  limit?: number;
}

/** What `chat_send` takes: the text, the cards, the staged files and the quoted message. */
export interface ChatDraft {
  body: string;
  cards: ChatCard[];
  attachments: string[];
  replySeq?: number | null;
}

/** Why the service did not add somebody to a group. */
export type ChatRefusalReason = "not_friend" | "member" | "full" | "cooldown";

export interface ChatRefusal {
  userId: string;
  reason: ChatRefusalReason;
}

/** The answer of `chat_create_group`. */
export interface ChatGroupResult {
  conversation: Conversation;
  added: string[];
  /** Players who ask first: they got an invitation instead. */
  invited: string[];
  refused: ChatRefusal[];
}

/** The answer of `chat_add_members`. */
export interface ChatAddResult {
  added: string[];
  invited: string[];
  refused: ChatRefusal[];
}

/** What a search can be narrowed to besides the words. */
export type ChatSearchHas = "file" | "image" | "video" | "card" | "link";

export interface ChatSearchFilters {
  conversationId?: string | null;
  senderId?: string | null;
  has?: ChatSearchHas | null;
}

export interface ChatSearchPage {
  results: { message: ChatMessage }[];
  nextCursor: string | null;
}

/** A file the core has copied, stripped and hashed, ready to go with the next message. */
export interface ChatStagedFile {
  handle: string;
  name: string;
  size: number;
  classGuess: ChatFileClass;
  width?: number | null;
  height?: number | null;
  origin: ChatFileOrigin;
}

/** Where the bytes of a file are on this machine. */
export interface ChatFileLocal {
  status: "cached" | "downloading" | "remote" | "gone";
  /** The cached copy, for `convertFileSrc`, once `cached`. */
  path?: string | null;
}

/** Where `chat_file_import` puts a file: the demos or the screenshots of a client. */
export interface ChatImportTarget {
  kind: "demo" | "screenshot";
  clientId: string;
}

/**
 * What a dangerous command of a bind or a config does, as `chat_scan_commands`
 * names it. `too_complex` says the scan stopped early: read the whole text.
 */
export type ChatDangerReason =
  | "quit"
  | "exec"
  | "write_config"
  | "rcon"
  | "connect"
  | "reconnect"
  | "unbind_all"
  | "allow_download"
  | "filesystem"
  | "server_cvar"
  | "nested_bind"
  | "too_complex";

/** One line of a config or a bind that would do something the player should see first. */
export interface ChatCommandDanger {
  /** The line of the text, from 1, of the command that leads to it. */
  line: number;
  /** The command that does it, as written. */
  command: string;
  reason: ChatDangerReason | string;
  /**
   * How the line reaches the command, outermost first: `bind KEY` for a key
   * press and `vstr NAME` for a variable it runs. Empty when the line does
   * it itself; absent from a core that predates it.
   */
  via?: string[];
}

/** The answer of `chat_card_to_profile`: a new player profile for the profile form. */
export interface ChatCardProfile {
  /** `id` empty and `name` the nickname without colour codes: the form saves it. */
  profile: PlayerProfile;
  /** Fields of the card the profile rules refused; the form leaves them blank. */
  skipped: string[];
}

/** The answer of `chat_card_to_config`: a new config document for the editor. */
export interface ChatCardConfig {
  /** `id` empty: the editor opens it and the player saves it with `save_config`. */
  document: ConfigDocument;
  /** The lines of its text to read before saving it. */
  dangers: ChatCommandDanger[];
  /** Keys of a bind card no config line can hold; they are not in the text. */
  skipped: string[];
}

/** The labels of the tray menu, in the language on screen: the core has no catalogs. */
export interface TrayLabels {
  open: string;
  chat: string;
  dnd: string;
  quit: string;
  tooltip: string;
}

/** Payload of `chat:read`. */
export interface ChatReadEvent {
  conversationId: string;
  userId: string;
  seq: number;
}

/** Payload of `chat:reaction`. */
export interface ChatReactionEvent {
  conversationId: string;
  seq: number;
  userId: string;
  emoji: string;
  on: boolean;
}

/** Payload of `chat:typing`: who is typing in one conversation now; an empty list clears it. */
export interface ChatTypingEvent {
  conversationId: string;
  userIds: string[];
}

/** Payload of `chat:outbox`: the whole outbox of one conversation. */
export interface ChatOutboxEvent {
  conversationId: string;
  entries: ChatOutboxEntry[];
}

/** Why a conversation went away. */
export type ChatRemovedReason = "left" | "removed" | "ended" | "account_deleted";

/** Payload of `chat:removed`. */
export interface ChatRemovedEvent {
  conversationId: string;
  reason: ChatRemovedReason;
}

/** Payload of `chat:resync`: threads to drop and load again, the service went back in time. */
export interface ChatResyncEvent {
  reset: string[];
}

/** Payload of `chat:draft`: another window edited the draft of a conversation. */
export interface ChatDraftEvent {
  conversationId: string;
  text: string;
}

/** Payload of `chat:notify`, sent to the main window only. */
export interface ChatNotifyEvent {
  conversationId: string;
  seq: number;
  title: string;
  text: string;
  mention: boolean;
}

/** Payload of `chat:open`: show this conversation, or the list when `null`. */
export interface ChatOpenEvent {
  conversationId: string | null;
}

/**
 * --- slice: chat window ---
 * The separate chat window as the core keeps it: the answer of
 * `chat_window_state` and of its three switches, and the payload of
 * `chat:window`.
 */
export interface ChatWindowView {
  /** Whether the chat window exists right now. */
  open: boolean;
  /** The narrow mode over a game, one conversation at a time. */
  compact: boolean;
  /** «Always on top» of the mode the window is in: each mode keeps its own. */
  alwaysOnTop: boolean;
  /** Opacity of the compact mode in percent, 40 to 100. The full mode is always opaque. */
  opacity: number;
}

/** Payload of `chat:upload`, at most every 250 ms per file. */
export interface ChatUploadEvent {
  handle: string;
  sent: number;
  total: number;
}

/**
 * Payload of `chat:download`. `downloading` while the bytes come, with
 * `path` `null`; the last event of a download says how it ended: `cached`
 * with the path, `remote` when it failed and may be asked for again, `gone`
 * when the service no longer has the file.
 */
export interface ChatDownloadEvent {
  fileId: string;
  received: number;
  total: number;
  path?: string | null;
  /** Absent from a core that predates it: a `path` then means `cached`. */
  status?: ChatFileLocal["status"];
}

/** Payload of `chat:files-staged`: files dropped on the window, already staged. */
export interface ChatFilesStagedEvent {
  files: ChatStagedFile[];
}

/** Event names of the chat slice. */
export const chatEvents = {
  state: "chat:state",
  message: "chat:message",
  read: "chat:read",
  reaction: "chat:reaction",
  typing: "chat:typing",
  outbox: "chat:outbox",
  removed: "chat:removed",
  resync: "chat:resync",
  draft: "chat:draft",
  notify: "chat:notify",
  open: "chat:open",
  /** --- slice: chat window --- the mode, the switches or the opacity of the chat window changed. */
  window: "chat:window",
  upload: "chat:upload",
  download: "chat:download",
  filesStaged: "chat:files-staged",
} as const;

/**
 * Calls a chat command, or `devChat.ts` in a browser.
 *
 * The same arrangement as `callFriends`: in a development build outside Tauri
 * the commands go to `scripts/mock-online.mjs` over `fetch`, and
 * `import.meta.env.DEV` keeps both the branch and the module out of a
 * production bundle.
 */
function callChat<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV && !isTauri()) {
    return import("./devChat").then((module) => module.devChat<T>(command, args));
  }
  return call<T>(command, args);
}

export const chatIpc = {
  /** The whole state the core keeps: conversations, invitations, privacy, quota, outbox. */
  getState: () => callChat<ChatStateView>("chat_get_state"),
  /** One page of a thread; the newest page without a cursor. */
  getMessages: (conversationId: string, query: ChatPageQuery = {}) =>
    callChat<ChatMessagePage>("chat_get_messages", {
      conversationId,
      before: query.before ?? null,
      after: query.after ?? null,
      around: query.around ?? null,
      limit: query.limit ?? null,
    }),
  /** The direct chat with a friend, created on the first call. */
  openDirect: (userId: string) => callChat<Conversation>("chat_open_direct", { userId }),
  /** Queues a message and answers with its client id; the rest arrives as `chat:outbox` and `chat:message`. */
  send: (conversationId: string, draft: ChatDraft) =>
    callChat<string>("chat_send", {
      conversationId,
      draft: { ...draft, replySeq: draft.replySeq ?? null },
    }),
  retry: (clientId: string) => callChat<void>("chat_retry", { clientId }),
  discard: (clientId: string) => callChat<void>("chat_discard", { clientId }),
  /**
   * What this window shows: the conversation, whether the window has the
   * focus, whether the thread is scrolled to the bottom and whether a composer
   * is there to take dropped files. The core reads messages as read and holds
   * back notifications by it.
   */
  setViewing: (viewing: {
    conversationId: string | null;
    focused: boolean;
    atBottom: boolean;
    composer: boolean;
  }) => callChat<void>("chat_set_viewing", viewing),
  markRead: (conversationId: string) => callChat<void>("chat_mark_read", { conversationId }),
  /** Throttled by the core, and dropped when I hide my typing. */
  typing: (conversationId: string) => callChat<void>("chat_typing", { conversationId }),
  react: (conversationId: string, seq: number, emoji: string, on: boolean) =>
    callChat<ChatReactionGroup[]>("chat_react", { conversationId, seq, emoji, on }),
  createGroup: (title: string, memberIds: string[]) =>
    callChat<ChatGroupResult>("chat_create_group", { title, memberIds }),
  /** Owner only; anybody else is refused with `owner_only`. */
  renameGroup: (conversationId: string, title: string) =>
    callChat<Conversation>("chat_rename_group", { conversationId, title }),
  /** The owner of a group or the host of a server chat only. */
  setHistoryForNewMembers: (conversationId: string, on: boolean) =>
    callChat<Conversation>("chat_set_history_for_new_members", { conversationId, on }),
  addMembers: (conversationId: string, userIds: string[]) =>
    callChat<ChatAddResult>("chat_add_members", { conversationId, userIds }),
  removeMember: (conversationId: string, userId: string) =>
    callChat<void>("chat_remove_member", { conversationId, userId }),
  leave: (conversationId: string) => callChat<void>("chat_leave", { conversationId }),
  /** Joins the group, or declines: `null` then. */
  answerGroupInvite: (conversationId: string, accept: boolean) =>
    callChat<Conversation | null>("chat_answer_group_invite", { conversationId, accept }),
  setNotify: (conversationId: string, notify: ChatNotifyLevel) =>
    callChat<Conversation>("chat_set_notify", { conversationId, notify }),
  search: (q: string, filters: ChatSearchFilters = {}, cursor?: string | null) =>
    callChat<ChatSearchPage>("chat_search", {
      q,
      conversationId: filters.conversationId ?? null,
      senderId: filters.senderId ?? null,
      has: filters.has ?? null,
      cursor: cursor ?? null,
    }),
  getPrivacy: () => callChat<ChatPrivacy>("chat_get_privacy"),
  /** Only the fields that change. */
  updatePrivacy: (patch: Partial<ChatPrivacy>) =>
    callChat<ChatPrivacy>("chat_update_privacy", { patch }),
  /** The system file dialog, from the core. */
  pickFiles: () => callChat<ChatStagedFile[]>("chat_pick_files"),
  stageMedia: (mediaId: string) => callChat<ChatStagedFile>("chat_stage_media", { mediaId }),
  stageClipboardImage: () => callChat<ChatStagedFile>("chat_stage_clipboard_image"),
  unstage: (handle: string) => callChat<void>("chat_unstage", { handle }),
  /** Where a file is here; `download` starts fetching one that is not. */
  fileLocal: (fileId: string, download: boolean) =>
    callChat<ChatFileLocal>("chat_file_local", { fileId, download }),
  /** The system save dialog; a dangerous file needs `confirmed`. `null`: the dialog was cancelled. */
  fileSave: (fileId: string, confirmed: boolean) =>
    callChat<string | null>("chat_file_save", { fileId, confirmed }),
  fileImport: (fileId: string, target: ChatImportTarget) =>
    callChat<string>("chat_file_import", { fileId, target }),
  scanCommands: (text: string) => callChat<ChatCommandDanger[]>("chat_scan_commands", { text }),
  /**
   * A card exactly as `chat_send` would send it: cleaned, `v` and an English
   * `fallbackText` filled in. Refused with `online`/`card` like the service.
   */
  buildCard: (card: ChatCard) => callChat<ChatCard>("chat_build_card", { card }),
  /**
   * A card of a message, checked before a window acts on it: the fields the
   * launcher knows, their values checked as on the service. Refused with
   * `online`/`card`.
   */
  checkCard: (card: ChatCard) => callChat<ChatCard>("chat_check_card", { card }),
  /** A profile card of a stored player profile. */
  cardFromProfile: (profile: PlayerProfile) =>
    callChat<ChatCard>("chat_card_from_profile", { profile }),
  /** A profile card as a new player profile for the profile form; nothing is saved. */
  cardToProfile: (card: ChatCard) => callChat<ChatCardProfile>("chat_card_to_profile", { card }),
  /** A bind or a config card as a new config document with its dangers; nothing is saved. */
  cardToConfig: (card: ChatCard, game?: Game | null) =>
    callChat<ChatCardConfig>("chat_card_to_config", { card, game: game ?? null }),
  /** Opens an http(s) link from the core; a host other than jknet.app and jkhub.org needs `confirmed`. */
  openLink: (url: string, confirmed: boolean) =>
    callChat<void>("chat_open_link", { url, confirmed }),
  joinHostCard: (hostId: string, sessionId: string) =>
    callChat<JoinResult>("chat_join_host_card", { hostId, sessionId }),
  getDraft: (conversationId: string) => callChat<string>("chat_get_draft", { conversationId }),
  setDraft: (conversationId: string, text: string) =>
    callChat<void>("chat_set_draft", { conversationId, text }),
  /** The separate chat window, raised when it is open already. */
  openWindow: (conversationId?: string | null, compact?: boolean) =>
    callChat<void>("open_chat_window", {
      conversationId: conversationId ?? null,
      compact: compact ?? null,
    }),
  // --- slice: chat window ---
  /** The mode, the switches and the opacity of the chat window. */
  windowState: () => callChat<ChatWindowView>("chat_window_state"),
  /** The compact mode on or off; with no window open, the mode the next one opens in. */
  setWindowCompact: (on: boolean) => callChat<ChatWindowView>("chat_window_set_compact", { on }),
  /** «Always on top» of the mode the window is in. */
  setWindowAlwaysOnTop: (on: boolean) =>
    callChat<ChatWindowView>("chat_window_set_always_on_top", { on }),
  /** The opacity of the compact mode, 40 to 100 percent; anything else is refused. */
  setWindowOpacity: (opacity: number) =>
    callChat<ChatWindowView>("chat_window_set_opacity", { opacity }),
  setTrayLabels: (labels: TrayLabels) => callChat<void>("set_tray_labels", { labels }),
};

/**
 * --- slice: chat cards ---
 * A file of the chat cache as a URL the webview may load: a picture or a
 * video of a message. The core puts the cache folder, and only that, in the
 * scope of the asset protocol. `null` outside Tauri, like `levelshotUrl`.
 */
export function chatFileUrl(path: string): string | null {
  if (!isTauri()) return null;
  return convertFileSrc(path);
}

/** What the close button of the main window does: hide it in the tray, or close it. */
export type AppCloseAction = "hide" | "close";

/** Closing, quitting and starting with Windows: `src-tauri/src/tray.rs` and `lib.rs`. */
export const appLifecycleIpc = {
  closeAction: () => call<AppCloseAction>("app_close_action"),
  /** **Quit** of the tray: the usual close guards still ask. */
  quit: () => call<void>("app_quit"),
  /** A guard dialog was cancelled: the next close hides to the tray again. */
  quitCancelled: () => call<void>("app_quit_cancelled"),
  getAutostart: () => call<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => call<boolean>("set_autostart", { enabled }),
};
