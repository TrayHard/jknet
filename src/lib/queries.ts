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
  hubErrorCode,
  hubErrorMessage,
  ipc,
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
  type GameFilesCandidate,
  type HubProvider,
  type HubUser,
  type Levelshot,
  type LibraryItem,
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
};

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ queryKey: queryKeys.settings, queryFn: ipc.getSettings });
}

/** The resolved data folders. `dataDirOverride` moves them, so a settings write invalidates this key. */
export function useDataPaths(): UseQueryResult<DataPaths> {
  return useQuery({ queryKey: queryKeys.dataPaths, queryFn: ipc.getDataPaths });
}

/** The engine registry is static, so it never goes stale. */
export function useEngines(): UseQueryResult<Engine[]> {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: ipc.listEngines,
    staleTime: Infinity,
  });
}

export function useClients(): UseQueryResult<Client[]> {
  return useQuery({ queryKey: queryKeys.clients, queryFn: ipc.listClients });
}

/** Scanning Steam and GOG touches the disk, so the result is kept a while. */
export function useGameFiles(): UseQueryResult<GameFilesCandidate[]> {
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
    },
  });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, engineId }: { name: string; engineId: string }) =>
      ipc.createClient(name, engineId),
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

export const serverKeys = {
  /** The list `cache\servers.json` holds, kept fresh by `useServerRefresh`. */
  cached: ["servers", "cached"] as const,
  trusted: ["servers", "trusted"] as const,
  status: (address: string) => ["servers", "status", address] as const,
};

/**
 * The cached server list.
 *
 * `staleTime: Infinity` on purpose: nothing but a refresh changes this list,
 * and a refresh writes the answer into the cache itself. Refetching on a
 * window focus would replace live rows with the ones on disk.
 */
export function useCachedServers(): UseQueryResult<ServerInfo[]> {
  return useQuery({
    queryKey: serverKeys.cached,
    queryFn: serversIpc.getCachedServers,
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
  return useQuery({
    queryKey: serverKeys.status(address ?? ""),
    queryFn: () => serversIpc.getServerStatus(address ?? ""),
    enabled: address !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useSetServerFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ address, favorite }: { address: string; favorite: boolean }) =>
      serversIpc.setServerFavorite(address, favorite),
    onSuccess: (settings, variables) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      // Repaint the one star instead of refetching a thousand rows.
      queryClient.setQueryData<ServerInfo[]>(serverKeys.cached, (rows) =>
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
  return useMutation({
    mutationFn: (address: string) => serversIpc.addServerHistory(address),
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
          queryClient.setQueryData<ServerInfo[]>(serverKeys.cached, (rows) =>
            mergeServers(rows ?? [], event.payload.servers),
          );
        },
      );
      const stopDone = await listen<ServersDoneEvent>(
        "servers:done",
        (event) => setProgress(event.payload),
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
  }, [queryClient]);

  const refresh = useCallback(() => {
    // A ref, not the state flag: two clicks in the same frame would both see
    // `false` and start two scans of the whole internet.
    if (running.current) return;
    running.current = true;
    setRunning(true);
    setError(null);
    serversIpc
      .refreshServers()
      .then((servers) => {
        queryClient.setQueryData(serverKeys.cached, servers);
        setRefreshedAt(Date.now());
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        running.current = false;
        setRunning(false);
      });
  }, [queryClient]);

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
  /** One picture, keyed by the lowercase map name. */
  shot: (map: string) => ["levelshots", "shot", map] as const,
  /** Every map the launcher has a picture for. */
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
export function useLevelshot(
  map: string | null | undefined,
): UseQueryResult<Levelshot | null> {
  const key = (map ?? "").trim().toLowerCase();
  return useQuery({
    queryKey: levelshotKeys.shot(key),
    queryFn: () => levelshotsIpc.getLevelshot(key),
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
