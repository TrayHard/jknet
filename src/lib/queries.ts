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
  errorMessage,
  friendsEvents,
  friendsIpc,
  ipc,
  launchIpc,
  libraryIpc,
  serversIpc,
  type Client,
  type ConflictReport,
  type DataPaths,
  type Engine,
  type EngineRelease,
  type EngineUpdate,
  type FriendsView,
  type GameFilesCandidate,
  type Invite,
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
  return useQuery({
    queryKey: friendsKeys.state,
    queryFn: friendsIpc.getFriendsState,
    staleTime: 15_000,
  });
}

/** How many friends are online or in a game, for the sidebar badge. */
export function useOnlineFriendCount(): number | undefined {
  const friends = useFriendsState();
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

  useEffect(() => {
    if (!isTauri()) return;
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
  }, [queryClient]);
}
