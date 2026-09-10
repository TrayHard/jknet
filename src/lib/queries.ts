/**
 * React Query bindings for the commands in `ipc.ts`.
 *
 * Query keys live here so a mutation can invalidate exactly what it changed.
 * Components never call `invoke` and never build a key by hand.
 */

import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  accountIpc,
  ACCOUNT_CHANGED_EVENT,
  errorMessage,
  friendsEvents,
  friendsIpc,
  hubErrorCode,
  hubErrorMessage,
  ipc,
  jkhubEvents,
  jkhubIpc,
  launchIpc,
  levelshotsIpc,
  libraryIpc,
  serversIpc,
  type AccountChanged,
  type AccountState,
  type Client,
  type ConflictReport,
  type DataPaths,
  type Engine,
  type EngineRelease,
  type EngineUpdate,
  type FriendsView,
  type DetectedGameFiles,
  type Game,
  type GameInfo,
  type HubProvider,
  type HubUser,
  type Invite,
  type JkhubCategories,
  type JkhubDownloadProgress,
  type JkhubFile,
  type JkhubListing,
  type JkhubSort,
  type Levelshot,
  type LibraryItem,
  type PresenceUpdated,
  type RunningGame,
  type ServerInfo,
  type ServersBatchEvent,
  type ServersDoneEvent,
  type ServerStatus,
  type Settings,
  type SettingsPatch,
  type TrustedServer,
} from "./ipc";
import { isTauri } from "./runtime";

export const queryKeys = {
  settings: ["settings"] as const,
  dataPaths: ["data-paths"] as const,
  engines: ["engines"] as const,
  clients: ["clients"] as const,
  gameFiles: ["game-files"] as const,
  servers: ["servers"] as const,
  library: ["library"] as const,
  // --- slice: game core ---
  games: ["games"] as const,
};

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ queryKey: queryKeys.settings, queryFn: ipc.getSettings });
}

// --- slice: game core ---

/**
 * The game every screen works in, with Jedi Academy while the settings load.
 *
 * A plain value and not a query of its own: it comes out of the settings, and
 * a second source for it would be a second thing to keep in step. The sidebar
 * switcher of the next slice writes it with `useUpdateSettings`, which puts the
 * new document straight into this cache, so every reader follows in one render.
 */
export function useActiveGame(): Game {
  return useSettings().data?.activeGame ?? "ja";
}

/**
 * Both games with the names the interface prints.
 *
 * The table lives in the core so that «Jedi Outcast» is spelled in one place.
 * It never changes within a build, hence `staleTime: Infinity`.
 */
export function useGames(): UseQueryResult<GameInfo[]> {
  return useQuery({
    queryKey: queryKeys.games,
    queryFn: ipc.listGames,
    staleTime: Infinity,
  });
}

/** The names of one game, or `undefined` until the table arrives. */
export function useGameInfo(game: Game): GameInfo | undefined {
  return useGames().data?.find((entry) => entry.id === game);
}

/** The resolved data folders. `dataDirOverride` moves them, so a settings write invalidates this key. */
export function useDataPaths(): UseQueryResult<DataPaths> {
  return useQuery({ queryKey: queryKeys.dataPaths, queryFn: ipc.getDataPaths });
}

/**
 * The engine registry is static, so it never goes stale.
 *
 * --- slice: game core ---
 * Every engine, both games. A screen that wants one game's engines filters
 * this list: refetching a constant every time a radio button moves would be a
 * round trip for nothing.
 */
export function useEngines(): UseQueryResult<Engine[]> {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: () => ipc.listEngines(),
    staleTime: Infinity,
  });
}

// --- slice: game core ---
/** The engines of one game, out of the same static list. */
export function useEnginesOfGame(game: Game): Engine[] {
  return (useEngines().data ?? []).filter((engine) => engine.game === game);
}

export function useClients(): UseQueryResult<Client[]> {
  return useQuery({ queryKey: queryKeys.clients, queryFn: ipc.listClients });
}

/**
 * Scanning Steam and GOG touches the disk, so the result is kept a while.
 *
 * --- slice: game core ---
 * One scan finds both games, so the screens that show them side by side make
 * one call rather than two.
 */
export function useGameFiles(): UseQueryResult<DetectedGameFiles> {
  return useQuery({
    queryKey: queryKeys.gameFiles,
    queryFn: ipc.detectGameFiles,
    staleTime: 60_000,
  });
}

/**
 * Saves the fields that changed.
 *
 * Pass a patch, never the whole cached document: the file on disk may hold a
 * field the launcher has not read back, and sending everything would erase it.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => ipc.updateSettings(patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      // The data folder may have moved and the game folder may have changed.
      queryClient.invalidateQueries({ queryKey: queryKeys.dataPaths });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients });
      queryClient.invalidateQueries({ queryKey: queryKeys.gameFiles });
      // --- slice: hub gate ---
      // `hubUrl` decides whether there is a hub at all, and the account state
      // is derived from it. Without this an address typed into **Hub address**
      // would leave the Account card, the sidebar and the Friends screen
      // showing the switched-off state until the window was reloaded.
      queryClient.invalidateQueries({ queryKey: accountKeys.state });
      queryClient.invalidateQueries({ queryKey: friendsKeys.state });
    },
  });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    // --- slice: game core --- the game is required and must match the engine.
    mutationFn: ({
      name,
      engineId,
      game,
    }: {
      name: string;
      engineId: string;
      game: Game;
    }) => ipc.createClient(name, engineId, game),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients });
    },
  });
}

/** Renames a client, changes its mod folder, or both. */
export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      clientId,
      name,
      fsGame,
    }: {
      clientId: string;
      name?: string;
      fsGame?: string;
    }) => ipc.updateClient(clientId, { name, fsGame }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients });
    },
  });
}

export function useDeleteClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.deleteClient(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

// --- slice: library ---------------------------------------------------------
//
// Every key starts with `queryKeys.library`, so one invalidation of that
// prefix refreshes the list and the conflicts of every client at once.

export const libraryKeys = {
  items: (clientId: string) => [...queryKeys.library, clientId, "items"] as const,
  conflicts: (clientId: string) =>
    [...queryKeys.library, clientId, "conflicts"] as const,
};

/** The pk3 files of one client. Idle until a client is selected. */
export function useLibrary(clientId: string | null): UseQueryResult<LibraryItem[]> {
  return useQuery({
    queryKey: libraryKeys.items(clientId ?? ""),
    queryFn: () => libraryIpc.listLibrary(clientId as string),
    enabled: clientId != null,
  });
}

/**
 * Internal paths carried by more than one enabled archive.
 *
 * The core opens every archive to answer, and caches the result per file set,
 * so the cost lands once per change rather than once per render.
 */
export function useLibraryConflicts(
  clientId: string | null,
): UseQueryResult<ConflictReport> {
  return useQuery({
    queryKey: libraryKeys.conflicts(clientId ?? ""),
    queryFn: () => libraryIpc.findLibraryConflicts(clientId as string),
    enabled: clientId != null,
  });
}

/** Invalidates both library keys of one client after a write. */
function useLibraryRefresh(clientId: string | null) {
  const queryClient = useQueryClient();
  return () => {
    if (clientId == null) return;
    queryClient.invalidateQueries({ queryKey: libraryKeys.items(clientId) });
    queryClient.invalidateQueries({ queryKey: libraryKeys.conflicts(clientId) });
  };
}

export function useAddLibraryFiles(clientId: string | null) {
  const refresh = useLibraryRefresh(clientId);
  return useMutation({
    mutationFn: (paths: string[]) =>
      libraryIpc.addLibraryFiles(clientId as string, paths),
    onSuccess: refresh,
  });
}

export function useSetLibraryItemEnabled(clientId: string | null) {
  const refresh = useLibraryRefresh(clientId);
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      libraryIpc.setLibraryItemEnabled(clientId as string, id, enabled),
    onSuccess: refresh,
  });
}

export function useRemoveLibraryItem(clientId: string | null) {
  const refresh = useLibraryRefresh(clientId);
  return useMutation({
    mutationFn: (id: string) =>
      libraryIpc.removeLibraryItem(clientId as string, id),
    onSuccess: refresh,
  });
}

export function useRenameLibraryItem(clientId: string | null) {
  const refresh = useLibraryRefresh(clientId);
  return useMutation({
    mutationFn: ({ id, displayName }: { id: string; displayName: string }) =>
      libraryIpc.renameLibraryItem(clientId as string, id, displayName),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// --- slice: launch ---
//
// Engine releases, engine installs and the running game. Keys live in their
// own object for the same reason the wrappers do: no shared closing brace.
// ---------------------------------------------------------------------------

export const launchKeys = {
  /** Releases of one engine. Invalidated by nothing: the core caches them. */
  releases: (engineId: string) => ["engine-releases", engineId] as const,
  /** Shared by every `install_engine` mutation, whichever screen started it. */
  installEngine: ["install-engine"] as const,
  /** Update check of one client. */
  engineUpdate: (clientId: string) => ["engine-update", clientId] as const,
  /** The one game JKNet started, or `null`. */
  runningGame: ["running-game"] as const,
};

/**
 * Releases of an engine, newest first.
 *
 * The core answers from a ten-minute cache, so a component may ask freely;
 * `staleTime` mirrors that window to spare even the IPC hop.
 */
export function useEngineReleases(
  engineId: string | null,
): UseQueryResult<EngineRelease[]> {
  return useQuery({
    queryKey: launchKeys.releases(engineId ?? ""),
    queryFn: () => launchIpc.listEngineReleases(engineId as string),
    enabled: engineId !== null,
    staleTime: 10 * 60_000,
  });
}

/** Whether a newer build than the installed one exists. Asked on demand. */
export function useEngineUpdate(
  clientId: string | null,
): UseQueryResult<EngineUpdate> {
  return useQuery({
    queryKey: launchKeys.engineUpdate(clientId ?? ""),
    queryFn: () => launchIpc.checkEngineUpdate(clientId as string),
    enabled: clientId !== null,
    staleTime: 10 * 60_000,
  });
}

/**
 * The running game.
 *
 * Kept current by the `launch:*` events rather than by polling, so the query
 * itself never refetches on its own.
 */
export function useRunningGame(): UseQueryResult<RunningGame | null> {
  return useQuery({
    queryKey: launchKeys.runningGame,
    queryFn: launchIpc.getRunningGame,
    staleTime: Infinity,
  });
}

/**
 * Downloads and unpacks an engine into a client.
 *
 * The command answers only when the archive is on disk; the progress bar on
 * the card is fed by `launch:engine-install-progress` in the meantime.
 */
export function useInstallEngine() {
  const queryClient = useQueryClient();
  return useMutation({
    // The shared key is what lets any screen see that an install is in
    // flight; see `usePendingInstalls`.
    mutationKey: launchKeys.installEngine,
    mutationFn: ({ clientId, tag }: { clientId: string; tag?: string }) =>
      launchIpc.installEngine(clientId, tag),
    onSuccess: (client) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients });
      queryClient.invalidateQueries({
        queryKey: launchKeys.engineUpdate(client.id),
      });
    },
  });
}

/**
 * Clients with an `install_engine` call in flight.
 *
 * The progress event only starts once the core answers, so a card that goes
 * by the event alone leaves its buttons live for the seconds in between — long
 * enough for a second click to reach the core. The mutation cache covers that
 * window, and it covers the install the New client dialog started as well: the
 * dialog closes before the first event arrives.
 */
export function usePendingInstalls(): string[] {
  return useMutationState({
    filters: { mutationKey: launchKeys.installEngine, status: "pending" },
    select: (mutation) =>
      (mutation.state.variables as { clientId: string } | undefined)?.clientId,
  }).filter((clientId): clientId is string => clientId !== undefined);
}

export function useLaunchClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      clientId,
      connect,
      extraArgs,
    }: {
      clientId: string;
      connect?: string;
      extraArgs?: string[];
    }) => launchIpc.launchClient(clientId, connect, extraArgs),
    onSuccess: (running) => {
      queryClient.setQueryData(launchKeys.runningGame, running);
    },
  });
}

export function useStopGame() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => launchIpc.stopGame(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: launchKeys.runningGame });
    },
  });
}

// ---------------------------------------------------------------------------
// --- slice: servers ---
// ---------------------------------------------------------------------------

/**
 * --- slice: game core ---
 * Every key that names a list carries the game: the two games have separate
 * master lists and separate cache documents, and one key for both would show
 * Jedi Academy rows on a Jedi Outcast screen for a frame after every switch.
 * The trusted list is bundled with the build and is not scoped.
 */
export const serverKeys = {
  /** The list `cache\servers-<game>.json` holds, kept fresh by
   * `useServerRefresh`. */
  cached: (game: Game) => ["servers", "cached", game] as const,
  trusted: ["servers", "trusted"] as const,
  status: (game: Game, address: string) =>
    ["servers", "status", game, address] as const,
};

/**
 * The cached server list.
 *
 * `staleTime: Infinity` on purpose: nothing but a refresh changes this list,
 * and a refresh writes the answer into the cache itself. Refetching on a
 * window focus would replace live rows with the ones on disk.
 */
export function useCachedServers(): UseQueryResult<ServerInfo[]> {
  const game = useActiveGame();
  return useQuery({
    queryKey: serverKeys.cached(game),
    queryFn: () => serversIpc.getCachedServers(game),
    staleTime: Infinity,
  });
}

/** The bundled trusted list. It ships with the build, so it never goes stale. */
export function useTrustedServers(): UseQueryResult<TrustedServer[]> {
  return useQuery({
    queryKey: serverKeys.trusted,
    queryFn: serversIpc.listTrustedServers,
    staleTime: Infinity,
  });
}

/**
 * The player list of one server, fetched when a row is selected.
 *
 * No retry: a server that ignored one `getstatus` will ignore the next one
 * within the same second, and the panel says so instead of hanging.
 */
export function useServerStatus(
  address: string | null,
): UseQueryResult<ServerStatus> {
  const game = useActiveGame();
  return useQuery({
    queryKey: serverKeys.status(game, address ?? ""),
    queryFn: () => serversIpc.getServerStatus(address ?? "", game),
    enabled: address !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useSetServerFavorite() {
  const queryClient = useQueryClient();
  const game = useActiveGame();
  return useMutation({
    mutationFn: ({ address, favorite }: { address: string; favorite: boolean }) =>
      serversIpc.setServerFavorite(address, favorite, game),
    onSuccess: (settings, variables) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      // Repaint the one star instead of refetching a thousand rows.
      queryClient.setQueryData<ServerInfo[]>(serverKeys.cached(game), (rows) =>
        rows?.map((row) =>
          row.address === variables.address
            ? { ...row, favorite: variables.favorite }
            : row,
        ),
      );
    },
  });
}

/** Records a connection. The History tab reads `serverHistory` from settings. */
export function useAddServerHistory() {
  const queryClient = useQueryClient();
  const game = useActiveGame();
  return useMutation({
    mutationFn: (address: string) => serversIpc.addServerHistory(address, game),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
    },
  });
}

/** What `useServerRefresh` gives the Servers screen. */
export interface ServerRefresh {
  /** Starts a refresh, or does nothing while one runs. */
  refresh: () => void;
  running: boolean;
  /** Message of the last failed refresh, cleared when the next one starts. */
  error: string | null;
  /** Counts of the last finished refresh. */
  progress: ServersDoneEvent | null;
  /** `Date.now()` of the last finished refresh, for "refreshed N s ago". */
  refreshedAt: number | null;
}

/** Adds or replaces rows by address, keeping the rest of the list intact. */
function mergeServers(
  existing: ServerInfo[],
  incoming: ServerInfo[],
): ServerInfo[] {
  const byAddress = new Map(existing.map((row) => [row.address, row]));
  for (const row of incoming) byAddress.set(row.address, row);
  return [...byAddress.values()];
}

/**
 * Runs a refresh and streams its results into the cached-list query.
 *
 * The core answers twice: `servers:batch` every 100 ms while the scan runs,
 * and the command's own return value at the end. The batches are what makes
 * the table fill in row by row instead of appearing after four seconds; the
 * return value then replaces the list wholesale, which is what removes the
 * servers that went offline since the previous refresh.
 */
export function useServerRefresh(): ServerRefresh {
  const queryClient = useQueryClient();
  // --- slice: game core ---
  // One refresh belongs to one game. The events carry theirs, so a batch of
  // the other game is dropped rather than merged into the list on screen.
  const game = useActiveGame();
  const running = useRef(false);
  const [isRunning, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ServersDoneEvent | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const stops: UnlistenFn[] = [];

    void (async () => {
      const stopBatch = await listen<ServersBatchEvent>(
        "servers:batch",
        (event) => {
          // The payload names its game, so the rows land in that game's list
          // even when the player switched away while the scan ran.
          const forGame = event.payload.game;
          queryClient.setQueryData<ServerInfo[]>(
            serverKeys.cached(forGame),
            (rows) => mergeServers(rows ?? [], event.payload.servers),
          );
        },
      );
      const stopDone = await listen<ServersDoneEvent>(
        "servers:done",
        (event) => {
          if (event.payload.game !== game) return;
          setProgress(event.payload);
        },
      );
      // The effect may have been torn down while the two promises resolved.
      if (disposed) {
        stopBatch();
        stopDone();
        return;
      }
      stops.push(stopBatch, stopDone);
    })();

    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [queryClient, game]);

  const refresh = useCallback(() => {
    // A ref, not the state flag: two clicks in the same frame would both see
    // `false` and start two scans of the whole internet.
    if (running.current) return;
    running.current = true;
    setRunning(true);
    setError(null);
    serversIpc
      .refreshServers(game)
      .then((servers) => {
        queryClient.setQueryData(serverKeys.cached(game), servers);
        setRefreshedAt(Date.now());
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        running.current = false;
        setRunning(false);
      });
  }, [queryClient, game]);

  return { refresh, running: isRunning, error, progress, refreshedAt };
}

// ---------------------------------------------------------------------------
// --- slice: onboarding ---
// ---------------------------------------------------------------------------

export const onboardingKeys = {
  /** Newest tag of every engine, asked once on the second step. */
  engineVersions: (engineIds: string[]) =>
    ["onboarding", "engine-versions", engineIds.join(",")] as const,
};

/** What the second onboarding step prints on an engine card. */
export interface EngineVersion {
  /** Git tag of the newest release. */
  tag: string;
  /** Size of the Windows archive, for the "about 12 MB" line. */
  assetSize: number;
}

/** How long the step waits for GitHub before it settles for "latest". */
const VERSION_BUDGET_MS = 3_000;

/**
 * Newest tag and archive size of several engines at once.
 *
 * Four cards need four answers from GitHub, and a player on a bad connection
 * must not watch four spinners before naming a client. The query resolves
 * after `VERSION_BUDGET_MS` with whatever arrived; the cards that got nothing
 * print "latest", which is the truth for three of the four projects anyway.
 * Nothing here blocks the Continue button.
 */
export function useEngineVersions(
  engineIds: string[],
): UseQueryResult<Record<string, EngineVersion>> {
  return useQuery({
    queryKey: onboardingKeys.engineVersions(engineIds),
    queryFn: () => collectEngineVersions(engineIds),
    enabled: engineIds.length > 0,
    // The core caches releases for ten minutes; mirror that instead of
    // re-asking every time the player steps back and forth.
    staleTime: 10 * 60_000,
    // A retry would spend the budget twice over and still show "latest".
    retry: false,
  });
}

/** Asks every engine at once and gives up on the stragglers. */
async function collectEngineVersions(
  engineIds: string[],
): Promise<Record<string, EngineVersion>> {
  const found: Record<string, EngineVersion> = {};

  const asked = Promise.allSettled(
    engineIds.map(async (engineId) => {
      const releases = await launchIpc.listEngineReleases(engineId);
      const newest = releases[0];
      if (newest) found[engineId] = { tag: newest.tag, assetSize: newest.assetSize };
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, VERSION_BUDGET_MS);
  });
  await Promise.race([asked, budget]);
  clearTimeout(timer);

  // A copy, not the accumulator: a late answer must not edit the object React
  // Query already handed to a component that will not re-render for it.
  return { ...found };
}

// ---------------------------------------------------------------------------
// --- slice: maps ---
// ---------------------------------------------------------------------------

export const levelshotKeys = {
  /** One picture, keyed by the game and the lowercase map name. `ffa_bespin`
   * is a map in both games and a different picture in each. */
  shot: (game: Game, map: string) => ["levelshots", "shot", game, map] as const,
  /** Every map the launcher has a picture for, as `<game>/<map>`. */
  list: ["levelshots", "list"] as const,
};

/**
 * The picture of one map, or `null` when the player owns no pk3 with one.
 *
 * The core keeps the cache and decides when to rebuild it, so the answer is
 * cheap after the first call and never goes stale on its own: a rebuild tells
 * the window through `levelshots:changed`, which is what `useLevelshotEvents`
 * listens for. `null` is a valid answer and must not be retried.
 */
/**
 * --- slice: game core ---
 * `game` names whose map it is. Left out it means the active game, which is
 * right for a Home screen or a Settings card; a server row passes its own,
 * because a list may outlive a switch.
 */
export function useLevelshot(
  map: string | null | undefined,
  game?: Game,
): UseQueryResult<Levelshot | null> {
  const active = useActiveGame();
  const forGame = game ?? active;
  const key = (map ?? "").trim().toLowerCase();
  return useQuery({
    queryKey: levelshotKeys.shot(forGame, key),
    queryFn: () => levelshotsIpc.getLevelshot(key, forGame),
    enabled: key.length > 0,
    staleTime: Infinity,
    retry: false,
  });
}

/** Every indexed map, which is what the Settings card counts. */
export function useLevelshots(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: levelshotKeys.list,
    queryFn: levelshotsIpc.listLevelshots,
    staleTime: 5 * 60_000,
  });
}

/** Reads every pk3 again. The **Rebuild** button of the Settings card. */
export function useRebuildLevelshots() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: levelshotsIpc.rebuildLevelshots,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["levelshots"] });
    },
  });
}

/**
 * Repaints the map pictures after the core rebuilt its index.
 *
 * A rebuild happens on demand — a new pk3 in a client folder, the game folder
 * pointed somewhere else — and it may add a picture for a map that answered
 * `null` a minute ago. Mounted once, next to the other app-wide listeners.
 */
export function useLevelshotEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: UnlistenFn | undefined;

    void listen("levelshots:changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["levelshots"] });
    }).then((unlisten) => {
      // The effect may have been torn down while the promise resolved.
      if (disposed) unlisten();
      else stop = unlisten;
    });

    return () => {
      disposed = true;
      stop?.();
    };
  }, [queryClient]);
}

// ---------------------------------------------------------------------------
// --- slice: account ---
//
// The hub account. Every hook here works through `accountIpc`, so the bearer
// token stays in the core: the frontend asks whether one exists and who it
// belongs to, never what it is.
// ---------------------------------------------------------------------------

export const accountKeys = {
  /** Whether a token is on file, and the account it belongs to. */
  state: ["account", "state"] as const,
};

/**
 * The account as the core sees it.
 *
 * The query is local — the core answers from `settings.json` without touching
 * the network — so the sidebar paints a name on the first frame. The listener
 * keeps every mounted copy in step with a sign-out done on another screen.
 */
export function useAccountState(): UseQueryResult<AccountState> {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: UnlistenFn | undefined;

    void (async () => {
      const unlisten = await listen<AccountChanged>(ACCOUNT_CHANGED_EVENT, () => {
        queryClient.invalidateQueries({ queryKey: accountKeys.state });
        // The account is cached in the settings document too, and the Settings
        // screen reads the hub address out of it.
        queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      });
      if (disposed) {
        unlisten();
        return;
      }
      stop = unlisten;
    })();

    return () => {
      disposed = true;
      stop?.();
    };
  }, [queryClient]);

  return useQuery({
    queryKey: accountKeys.state,
    queryFn: accountIpc.getAccountState,
    staleTime: Infinity,
  });
}

// --- slice: hub gate ---
/**
 * Whether this build has a hub, or `undefined` before the core has answered.
 *
 * Three screens switch on it — the Account card, the Friends screen and the
 * third step of the first run — and `useFriendsState` stops calling on it.
 * `undefined` means "not known yet", never "no": outside Tauri the account
 * query fails, and the Friends screen still has the mock hub to draw against.
 */
export function useHubConfigured(): boolean | undefined {
  return useAccountState().data?.hubConfigured;
}

/** Where a sign-in has got to. */
export type SignInPhase = "idle" | "starting" | "waiting" | "done" | "error";

/** What `useSignIn` gives a screen. */
export interface SignInFlow {
  phase: SignInPhase;
  /** The provider being signed in with, while one is. */
  provider: HubProvider | null;
  /** The account, once the browser has sent the player back. */
  user: HubUser | null;
  /** What to print when `phase` is `error`. */
  error: string | null;
  /** The address opened in the browser, for a browser that stayed shut. */
  url: string | null;
  start: (provider: HubProvider) => void;
  /** Stops polling. The session on the hub expires on its own. */
  cancel: () => void;
}

/** How often the session is read while the browser tab is open. */
const POLL_EVERY_MS = 2_000;
/** The contract expires a session after ten minutes; polling stops with it. */
const POLL_BUDGET_MS = 10 * 60_000;

/**
 * Runs one browser sign-in from the launcher's side.
 *
 * The core opens the browser and stores the token; this hook does the waiting.
 * It polls rather than listens because there is nothing to listen to: the
 * player's browser talks to the hub, not to the launcher, and a launcher that
 * opened a port to hear about it would need a firewall prompt to sign in.
 */
export function useSignIn(): SignInFlow {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [provider, setProvider] = useState<HubProvider | null>(null);
  const [user, setUser] = useState<HubUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // A poll that has not answered yet must not start a second one: a hub that
  // takes three seconds would otherwise collect a queue of them.
  const polling = useRef(false);

  const stopPolling = useCallback(() => {
    if (timer.current !== undefined) clearInterval(timer.current);
    timer.current = undefined;
    polling.current = false;
  }, []);

  // A screen left mid-sign-in must not leave an interval calling a command.
  useEffect(() => stopPolling, [stopPolling]);

  const cancel = useCallback(() => {
    stopPolling();
    setPhase("idle");
    setProvider(null);
    setError(null);
    setUrl(null);
  }, [stopPolling]);

  const start = useCallback(
    (chosen: HubProvider) => {
      stopPolling();
      setPhase("starting");
      setProvider(chosen);
      setUser(null);
      setError(null);
      setUrl(null);

      accountIpc
        .beginSignIn(chosen)
        .then((session) => {
          setUrl(session.url);
          setPhase("waiting");

          const deadline = Date.now() + POLL_BUDGET_MS;
          timer.current = setInterval(() => {
            if (Date.now() > deadline) {
              stopPolling();
              setPhase("error");
              setError("The sign-in took too long. Try again.");
              return;
            }
            if (polling.current) return;
            polling.current = true;

            accountIpc
              .pollSignIn(session.sessionId)
              .then((answer) => {
                if (answer.status === "pending") return;
                stopPolling();
                if (answer.status === "done" && answer.user) {
                  setUser(answer.user);
                  setPhase("done");
                  queryClient.invalidateQueries({ queryKey: accountKeys.state });
                  queryClient.invalidateQueries({ queryKey: queryKeys.settings });
                  return;
                }
                setPhase("error");
                setError(
                  answer.error ??
                    (answer.status === "expired"
                      ? "The sign-in expired. Try again."
                      : "The sign-in did not finish."),
                );
              })
              .catch((e: unknown) => {
                stopPolling();
                setPhase("error");
                setError(hubErrorMessage(e));
              })
              .finally(() => {
                polling.current = false;
              });
          }, POLL_EVERY_MS);
        })
        .catch((e: unknown) => {
          setPhase("error");
          // A provider that has issued no OAuth client yet is the expected
          // answer rather than a failure, so it reads as one.
          setError(
            hubErrorCode(e) === "provider_error"
              ? providerUnavailable(chosen)
              : hubErrorMessage(e),
          );
        });
    },
    [queryClient, stopPolling],
  );

  return { phase, provider, user, error, url, start, cancel };
}

/** What a provider without an OAuth client yet reads as. */
function providerUnavailable(provider: HubProvider): string {
  const name = provider === "discord" ? "Discord" : "JKHub";
  return `${name} sign-in is not available yet.`;
}

/** Invalidates everything that shows an account. */
function useAccountRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: accountKeys.state });
    queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  };
}

/** Forgets the account here and invalidates the token on the hub. */
export function useSignOut() {
  const refresh = useAccountRefresh();
  return useMutation({
    mutationFn: () => accountIpc.signOut(),
    onSuccess: refresh,
  });
}

/** Renames the account. A taken name comes back as a `conflict`. */
export function useUpdateDisplayName() {
  const refresh = useAccountRefresh();
  return useMutation({
    mutationFn: (displayName: string) => accountIpc.updateDisplayName(displayName),
    onSuccess: refresh,
  });
}

/** Deletes the account on the hub. Nothing on this machine is touched. */
export function useDeleteAccount() {
  const refresh = useAccountRefresh();
  return useMutation({
    mutationFn: () => accountIpc.deleteAccount(),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// --- slice: friends ---
//
// One query holds the whole screen: `get_friends_state` answers with the four
// lists and the player's own presence in one document. The core is the only
// writer, so every mutation answers with the new document and drops it into
// the cache, and the three `friends:*` events either patch one row or ask for
// a refetch.
// ---------------------------------------------------------------------------

export const friendsKeys = {
  /** The one document the Friends screen and the sidebar badge read. */
  state: ["friends", "state"] as const,
};

/**
 * Friends, requests, invites and my presence.
 *
 * No polling of its own. The core pushes `friends:changed` when anything
 * moves — and, while the live socket is down, every 30 s regardless — so a
 * timer here would only duplicate that. Mount `FriendsProvider` above the
 * router for the events to arrive.
 */
export function useFriendsState(): UseQueryResult<FriendsView> {
  // --- slice: hub gate ---
  // No hub, no query: the command would answer an empty document, and the
  // sidebar and the Friends screen have their own state for this. The query
  // starts by itself when the player names a hub, because `account:changed`
  // and the settings write invalidate the account state this reads.
  const configured = useHubConfigured();
  return useQuery({
    queryKey: friendsKeys.state,
    queryFn: friendsIpc.getFriendsState,
    staleTime: 15_000,
    enabled: configured !== false,
  });
}

/**
 * How many friends are online or in a game, for the sidebar badge.
 *
 * `undefined` leaves the counter off the sidebar entirely, which is the answer
 * while nobody is signed in and while the hub is switched off. The second case
 * is checked here rather than left to the disabled query: React Query keeps
 * what it fetched, so a player who clears the hub address would otherwise keep
 * a counter from the session before.
 */
export function useOnlineFriendCount(): number | undefined {
  const configured = useHubConfigured();
  const friends = useFriendsState();
  if (configured === false) return undefined;
  if (friends.data === undefined || !friends.data.signedIn) return undefined;
  return friends.data.friends.filter(
    (friend) => friend.presence.status !== "offline",
  ).length;
}

/** Drops the answer of a mutation straight into the query cache. */
function useFriendsWriter<TArgs>(
  mutationFn: (args: TArgs) => Promise<FriendsView>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (view) => queryClient.setQueryData(friendsKeys.state, view),
  });
}

export function useSendFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (query: string) => friendsIpc.sendFriendRequest(query),
    // The result carries the refreshed lists next to the outcome, so the
    // screen never shows "Request sent" over a list that does not have it yet.
    onSuccess: (result) =>
      queryClient.setQueryData(friendsKeys.state, result.state),
  });
}

export function useAcceptFriendRequest() {
  return useFriendsWriter((id: string) => friendsIpc.acceptFriendRequest(id));
}

/** Declines a request sent to me, or cancels one I sent. */
export function useDeclineFriendRequest() {
  return useFriendsWriter((id: string) => friendsIpc.declineFriendRequest(id));
}

export function useRemoveFriend() {
  return useFriendsWriter((userId: string) => friendsIpc.removeFriend(userId));
}

export function useDismissInvite() {
  return useFriendsWriter((id: string) => friendsIpc.dismissInvite(id));
}

export function useSendInvite() {
  return useMutation({
    mutationFn: ({
      toUserId,
      serverAddress,
      serverName,
    }: {
      toUserId: string;
      serverAddress: string;
      serverName?: string | null;
    }) => friendsIpc.sendInvite(toUserId, serverAddress, serverName),
  });
}

/** Starts the default client on the server a friend is playing on. */
export function useJoinFriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => friendsIpc.joinFriend(userId),
    onSuccess: (running) => {
      queryClient.setQueryData(launchKeys.runningGame, running);
    },
  });
}

/**
 * Subscribes to the three `friends:*` events for the whole window.
 *
 * Mounted once, by `FriendsProvider`. `friends:presence` patches the one row
 * it names rather than refetching, because it arrives every time any friend
 * changes server; the other two ask for the document again, because they can
 * move any of the four lists at once.
 */
export function useFriendsEvents(): void {
  const queryClient = useQueryClient();
  // --- slice: hub gate ---
  // Nothing emits these while the hub is switched off, and the window should
  // not hold three subscriptions waiting for it. They attach by themselves
  // when the player names a hub, because this value changes with the account.
  const configured = useHubConfigured();

  useEffect(() => {
    if (!isTauri() || configured === false) return;
    let disposed = false;
    const stops: UnlistenFn[] = [];

    void (async () => {
      const stopChanged = await listen(friendsEvents.changed, () => {
        void queryClient.invalidateQueries({ queryKey: friendsKeys.state });
      });
      const stopPresence = await listen<PresenceUpdated>(
        friendsEvents.presence,
        (event) => {
          queryClient.setQueryData<FriendsView>(friendsKeys.state, (view) =>
            view === undefined
              ? view
              : {
                  ...view,
                  friends: view.friends.map((friend) =>
                    friend.user.id === event.payload.userId
                      ? { ...friend, presence: event.payload.presence }
                      : friend,
                  ),
                },
          );
        },
      );
      const stopInvite = await listen<Invite>(friendsEvents.invite, (event) => {
        // The toast is drawn from the invite list, so the arrival only has to
        // put the invite in it. The core sends `friends:changed` as well, and
        // adding it here means the toast appears without waiting for a fetch.
        queryClient.setQueryData<FriendsView>(friendsKeys.state, (view) =>
          view === undefined || view.invites.some((i) => i.id === event.payload.id)
            ? view
            : { ...view, invites: [event.payload, ...view.invites] },
        );
      });

      // The effect may have been torn down while the three promises resolved.
      if (disposed) {
        stopChanged();
        stopPresence();
        stopInvite();
        return;
      }
      stops.push(stopChanged, stopPresence, stopInvite);
    })();

    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [queryClient, configured]);
}

// --- slice: jkhub -----------------------------------------------------------
//
// Browsing jkhub.org. Keys live under one prefix so the Refresh action can
// invalidate the whole tab at once, and the listing is paged by hand rather
// than with `useInfiniteQuery`: the screen loads one page at a time and keeps
// what it has, which is also what the client-side filter searches over.

export const jkhubKeys = {
  all: ["jkhub"] as const,
  categories: (game: Game) => ["jkhub", "categories", game] as const,
  list: (game: Game, categoryId: number, sort: JkhubSort, page: number) =>
    ["jkhub", "list", game, categoryId, sort, page] as const,
  file: (id: number) => ["jkhub", "file", id] as const,
};

/** The category tree of one game. Cached on disk by the core for a day. */
export function useJkhubCategories(
  game: Game,
  enabled = true,
): UseQueryResult<JkhubCategories> {
  return useQuery({
    queryKey: jkhubKeys.categories(game),
    queryFn: () => jkhubIpc.categories(game),
    enabled: enabled && isTauri(),
    // The core answers from its own cache, so a refetch on every focus would
    // be wasted work rather than a fresh tree.
    staleTime: 60 * 60_000,
  });
}

/** One page of one category, 25 cards. Idle until a category is picked. */
export function useJkhubListing(
  game: Game,
  categoryId: number | null,
  sort: JkhubSort,
  page: number,
): UseQueryResult<JkhubListing> {
  return useQuery({
    queryKey: jkhubKeys.list(game, categoryId ?? 0, sort, page),
    queryFn: () => jkhubIpc.list(categoryId as number, sort, page, game),
    enabled: categoryId != null && isTauri(),
    staleTime: 5 * 60_000,
  });
}

/** One file page. Idle until a card is opened. */
export function useJkhubFile(id: number | null): UseQueryResult<JkhubFile> {
  return useQuery({
    queryKey: jkhubKeys.file(id ?? 0),
    queryFn: () => jkhubIpc.file(id as number),
    enabled: id != null && isTauri(),
    staleTime: 5 * 60_000,
  });
}

/** Drops every cached JKHub answer, so the next render asks the site again. */
export function useRefreshJkhub() {
  const queryClient = useQueryClient();
  return useCallback(
    async (game: Game) => {
      // `refresh: true` is what makes the core ignore its own disk cache; the
      // invalidation below is what makes React Query ask for it.
      await jkhubIpc.categories(game, true);
      await queryClient.invalidateQueries({ queryKey: jkhubKeys.all });
    },
    [queryClient],
  );
}

/**
 * Installs one file into one client.
 *
 * The answer is not always "installed": a name collision, an archive with no
 * pk3, a record that links to another site and a format JKNet cannot open all
 * come back in the success path, and the screen decides what to offer next.
 */
export function useJkhubInstall(clientId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, replace }: { id: number; replace?: boolean }) =>
      jkhubIpc.install(id, clientId as string, replace ?? false),
    onSuccess: (result) => {
      if (result.kind !== "installed") return;
      queryClient.invalidateQueries({
        queryKey: libraryKeys.items(result.clientId),
      });
      queryClient.invalidateQueries({
        queryKey: libraryKeys.conflicts(result.clientId),
      });
    },
  });
}

/**
 * Bytes received while an archive comes down, per file id.
 *
 * One listener for the whole tab: a card and the details panel both need the
 * number, and a listener per card would mean twenty-five subscriptions.
 */
export function useJkhubDownloadProgress(): Map<number, JkhubDownloadProgress> {
  const [progress, setProgress] = useState<Map<number, JkhubDownloadProgress>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<JkhubDownloadProgress>(
      jkhubEvents.downloadProgress,
      (event) => {
        setProgress((current) => {
          const next = new Map(current);
          next.set(event.payload.fileId, event.payload);
          return next;
        });
      },
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return progress;
}
