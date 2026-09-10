/**
 * React Query bindings for the commands in `ipc.ts`.
 *
 * Query keys live here so a mutation can invalidate exactly what it changed.
 * Components never call `invoke` and never build a key by hand.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  errorMessage,
  ipc,
  serversIpc,
  type Client,
  type DataPaths,
  type Engine,
  type GameFilesCandidate,
  type ServerInfo,
  type ServersBatchEvent,
  type ServersDoneEvent,
  type ServerStatus,
  type Settings,
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

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Settings) => ipc.updateSettings(settings),
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
