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
import { filePreviewIpc, modelPreviewIpc, type FilePreviewSource } from "./ipc";
import { mediaIpc, configsIpc } from "./ipc";

export function useMedia() { return useQuery({ queryKey: ["media"], queryFn: () => mediaIpc.list(true), enabled: isTauri(), staleTime: 15000 }); }
export function useMediaActions() {
  const cache = useQueryClient();
  return {
    preparePreview: useMutation({ mutationFn: mediaIpc.preparePreview, onSuccess: () => cache.invalidateQueries({ queryKey: ["media"] }) }),
    remove: useMutation({ mutationFn: (ids: string[]) => ids.length === 1 ? mediaIpc.remove(ids[0]) : mediaIpc.removeBatch(ids), onSuccess: (_, ids) => {
      const removed = new Set(ids);
      cache.setQueryData(["media"], (items: import("./ipc").MediaItem[] | undefined) => items?.filter(item => !removed.has(item.id)));
      return cache.invalidateQueries({ queryKey: ["media"] });
    } }),
    exportVideo: useMutation({ mutationFn: ({ demoId, clientId, settings }: { demoId: string; clientId: string; settings: import("./ipc").VideoSettings }) => mediaIpc.exportVideo(demoId, clientId, settings), onSuccess: () => { void cache.invalidateQueries({ queryKey: ["video-jobs"] }); void cache.invalidateQueries({ queryKey: ["video-preferences"] }); } }),
    savePreset: useMutation({ mutationFn: mediaIpc.savePreset, onSuccess: () => cache.invalidateQueries({ queryKey: ["video-preferences"] }) }),
    deletePreset: useMutation({ mutationFn: mediaIpc.deletePreset, onSuccess: () => cache.invalidateQueries({ queryKey: ["video-preferences"] }) }),
    cancelVideo: useMutation({ mutationFn: mediaIpc.cancelVideo, onSuccess: () => cache.invalidateQueries({ queryKey: ["video-jobs"] }) }),
    edit: useMutation({ mutationFn: ({ id, name, tags }: { id: string; name: string; tags: string[] }) => mediaIpc.update(id, name, tags), onSuccess: () => cache.invalidateQueries({ queryKey: ["media"] }) }),
    copy: useMutation({ mutationFn: mediaIpc.copy }),
    open: useMutation({ mutationFn: mediaIpc.openFolder }),
    play: useMutation({ mutationFn: ({ id, clientId }: { id: string; clientId: string }) => mediaIpc.play(id, clientId), onSuccess: () => cache.invalidateQueries({ queryKey: ["running-game"] }) }),
  };
}
export function useVideoJobs() {
  const cache = useQueryClient();
  const jobs = useQuery({ queryKey: ["video-jobs"], queryFn: mediaIpc.jobs, enabled: isTauri(), refetchInterval: 1000, refetchIntervalInBackground: true });
  const completed = jobs.data?.filter(j => j.status === "complete").map(j => j.id).join(",");
  useEffect(() => { if (completed) void cache.invalidateQueries({ queryKey: ["media"] }); }, [completed, cache]);
  return jobs;
}
export function useVideoPreferences() { return useQuery({ queryKey: ["video-preferences"], queryFn: mediaIpc.videoPreferences, enabled: isTauri() }); }
export function useConfigs() { return useQuery({ queryKey: ["configs"], queryFn: configsIpc.list, enabled: isTauri() }); }
export function useClientConfigContext(clientId: string) { return useQuery({ queryKey: ["client-config-context", clientId], queryFn: () => configsIpc.context(clientId), enabled: isTauri() && !!clientId, staleTime: 0 }); }
export function useClientConfigFiles(clientId: string) { return useQuery({ queryKey: ["client-config-files", clientId], queryFn: () => configsIpc.clientFiles(clientId), enabled: isTauri() && !!clientId }); }
export function useConfigConflicts(ids: string[]) { return useQuery({ queryKey: ["config-conflicts", ids], queryFn: () => configsIpc.conflicts(ids), enabled: isTauri() && ids.length > 1 }); }
export function useConfigActions() {
  const cache = useQueryClient(); const updated = () => { void cache.invalidateQueries({ queryKey: ["configs"] }); void cache.invalidateQueries({ queryKey: ["config-conflicts"] }); };
  return {
    save: useMutation({ mutationFn: configsIpc.save, onSuccess: updated }),
    remove: useMutation({ mutationFn: configsIpc.remove, onSuccess: updated }),
    layers: useMutation({ mutationFn: ({ clientId, layers }: { clientId: string; layers: import("./ipc").ConfigLayer[] }) => configsIpc.layers(clientId, layers), onSuccess: updated }),
    defaultConfig: useMutation({ mutationFn: ({ clientId, source }: { clientId: string; source: string | null }) => configsIpc.setDefault(clientId, source), onSuccess: updated }),
    merge: useMutation({ mutationFn: ({ ids, choices, name }: { ids: string[]; choices: Record<string, string>; name: string }) => configsIpc.merge(ids, choices, name), onSuccess: updated }),
    bind: useMutation({ mutationFn: ({ clientId, profileId, configId }: { clientId: string; profileId: string; configId: string | null }) => configsIpc.profileBind(clientId, profileId, configId) }),
  };
}
import type { PreviewRequest } from "./modelScene";

export function useModelPreview(clientId: string, request: PreviewRequest, enabled = true, source?: FilePreviewSource) {
  return useQuery({
    queryKey: ["model-preview", clientId, request.kind, request.value, request.skins, request.saber, source],
    queryFn: async () => (await import("./modelScene")).loadModelScene(request,
      names => source ? filePreviewIpc.assets(source, names) : modelPreviewIpc.assets(clientId, names)),
    enabled: enabled && isTauri() && !!request.value, staleTime: 30_000, gcTime: 60_000, retry: false,
  });
}

// --- slice: pk3 contents ---
/**
 * How many pictures the gallery asks the core for at once.
 *
 * A grid of two thousand textures brings its thumbnails in as they scroll
 * into view, and a fast scroll would otherwise queue hundreds of decodes at
 * the core in one go. The rest wait here, in the order they were asked for.
 */
const IMAGE_LANES = 6;
let imageLanes = 0;
const imageQueue: Array<() => void> = [];
function throttleImage<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      imageLanes += 1;
      work().then(resolve, reject).finally(() => {
        imageLanes -= 1;
        imageQueue.shift()?.();
      });
    };
    if (imageLanes < IMAGE_LANES) run();
    else imageQueue.push(run);
  });
}

/**
 * One picture of a preview session, as a data URL.
 *
 * Keyed by the session, so the cache is the dialog's: a thumbnail scrolled
 * out of view and back again is not decoded twice, and the whole set goes
 * a minute after the dialog closes. `maxSize` asks the core for a thumbnail;
 * without it the picture comes at its own size, which is what the enlarged
 * view wants.
 */
export function useFilePreviewImage(source: FilePreviewSource, name: string, maxSize: number | undefined, enabled = true) {
  return useQuery({
    queryKey: ["file-preview-image", source.previewId, source.archive, name, maxSize ?? 0],
    queryFn: () => throttleImage(() => filePreviewIpc.image(source, name, maxSize)),
    enabled: enabled && isTauri(), staleTime: Infinity, gcTime: 60_000, retry: false,
  });
}

/** One text file of a preview session, decoded by the core. */
export function useFilePreviewText(source: FilePreviewSource, name: string, enabled = true) {
  return useQuery({
    queryKey: ["file-preview-text", source.previewId, source.archive, name],
    queryFn: () => filePreviewIpc.text(source, name),
    enabled: enabled && isTauri(), staleTime: Infinity, gcTime: 60_000, retry: false,
  });
}
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
// --- slice: i18n ---
import { useTranslation } from "react-i18next";

import {
  accountIpc,
  ACCOUNT_CHANGED_EVENT,
  // --- slice: bundles ---
  bundlesIpc,
  bundleEvents,
  // --- slice: client window ---
  clientEvents,
  errorMessage,
  friendsEvents,
  friendsIpc,
  onlineErrorCode,
  onlineErrorMessage,
  ipc,
  jkhubEvents,
  jkhubIpc,
  launchIpc,
  levelshotsIpc,
  libraryIpc,
  LIBRARY_CHANGED_EVENT,
  // --- slice: pk3 editor ---
  pk3EditorIpc,
  // --- slice: player profiles ---
  profilesIpc,
  serversIpc,
  settingsEvents,
  type AccountChanged,
  type AccountState,
  // --- slice: bundles ---
  type BundleDetailsWithLocal,
  type BundleFileRoot,
  type BundleList,
  type BundlePreviewProgress,
  type BundleQuery,
  type BundleVersion,
  type Draft,
  type Listing,
  type DraftComponentPatch,
  type DraftConfig,
  type DraftIssues,
  type DraftPatch,
  type DraftSummary,
  type LaunchMode,
  type MyBundles,
  type NewDraftComponent,
  type PendingVersion,
  // --- slice: pk3 editor ---
  type Pk3EditorSession,
  type Pk3EditorTarget,
  type PreviewImage,
  type PreviewText,
  type ReleaseView,
  type Client,
  // --- slice: client window ---
  type ClientsChanged,
  type LaunchPreview,
  type ConflictReport,
  type DataPaths,
  // --- slice: clients page ---
  type DefaultClientsChanged,
  type Engine,
  type EngineRelease,
  type EngineUpdate,
  type FriendsView,
  type DetectedGameFiles,
  type Game,
  type GameInfo,
  // --- slice: connect dialog ---
  type InlineProfile,
  type OnlineProvider,
  type OnlineUser,
  type Invite,
  type JkhubCategories,
  type JkhubCategoriesUpdated,
  type JkhubDownloadProgress,
  type JkhubFile,
  type JkhubComments,
  // --- slice: jkhub index ---
  type JkhubIndexProgress,
  type JkhubIndexStatus,
  type JkhubIndexUpdate,
  type JkhubListing,
  type JkhubSearchResult,
  type JkhubSort,
  type SortDirection,
  type Levelshot,
  type LibraryItem,
  type PlayerModel,
  type PlayerProfile,
  type PresenceUpdated,
  type ProfileBook,
  type RunningGame,
  type SaberHilt,
  type ServerInfo,
  type ServerScope,
  type ServersBatchEvent,
  type ServersDoneEvent,
  type ServerStatus,
  type Settings,
  type SettingsPatch,
} from "./ipc";
// --- slice: bundles ---
import { bundleJobs, draftJobKey, installJobKey } from "./bundleJobs";
// --- slice: jkhub details ---
import { jkhubDownloads } from "./jkhubDownloads";
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
      // --- slice: online gate ---
      // `onlineUrl` decides whether there is a service at all, and the account state
      // is derived from it. Without this an address typed into **JKNet Online address**
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

/** Renames a client, changes its mod folder or its launch arguments. */
export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      clientId,
      name,
      fsGame,
      launchArgs,
    }: {
      clientId: string;
      name?: string;
      fsGame?: string;
      launchArgs?: string;
    }) => ipc.updateClient(clientId, { name, fsGame, launchArgs }),
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

// --- slice: client window ---------------------------------------------------
//
// Every key below starts with `queryKeys.clients`, so the one invalidation the
// mutations already do covers the cvars and the command line preview as well:
// both are derived from the record those mutations write.

export const clientKeys = {
  cvars: (clientId: string, names: string) =>
    [...queryKeys.clients, clientId, "cvars", names] as const,
  // --- slice: player profiles ---
  // The profile is part of the key: the preview of the window shows what
  // **Play** would run, and the one under an open form shows what the profile
  // being edited would run.
  //
  // --- slice: connect dialog ---
  // So is everything a single run adds. The dialog changes those on every
  // keystroke, and two lines that differ by a nickname must not share an answer.
  //
  // --- slice: bundles ---
  // And the mode: the single-player line takes another executable and drops
  // the profile, so the two lines of one client never share an answer.
  preview: (clientId: string, profileId?: string, run?: LaunchRun, mode?: LaunchMode) =>
    [
      ...queryKeys.clients,
      clientId,
      "preview",
      profileId ?? "",
      JSON.stringify(run ?? null),
      mode ?? "multiplayer",
    ] as const,
  // --- slice: clients page ---
  dir: (clientId: string) => [...queryKeys.clients, clientId, "dir"] as const,
};

/** One client out of the list, with the state of the list behind it. */
export function useClient(clientId: string): {
  client: Client | undefined;
  isLoading: boolean;
  error: unknown;
} {
  const clients = useClients();
  return {
    client: clients.data?.find((client) => client.id === clientId),
    isLoading: clients.isLoading,
    error: clients.error,
  };
}

/**
 * The values of several cvars inside the launch arguments of a client.
 *
 * One call for the whole window: the controls all read the same string, and a
 * query each would be a dozen round trips for one field of one file. The
 * answer never goes stale by itself — only a write to the record can change
 * it, and every write invalidates `queryKeys.clients`.
 */
export function useLaunchCvars(
  clientId: string,
  names: readonly string[],
): UseQueryResult<Record<string, string | null>> {
  const key = names.join(",");
  return useQuery({
    queryKey: clientKeys.cvars(clientId, key),
    queryFn: () => ipc.readLaunchCvars(clientId, [...names]),
    staleTime: Infinity,
  });
}

/**
 * Writes one cvar into the launch arguments of a client.
 *
 * `value: null` removes it. The core answers with the whole record, so the
 * **Extra arguments** field sees the line the controls edited.
 */
export function useWriteLaunchCvar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      clientId,
      name,
      value,
    }: {
      clientId: string;
      name: string;
      value: string | null;
    }) => ipc.writeLaunchCvar(clientId, name, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients });
    },
  });
}

// --- slice: connect dialog ---
/** What one launch adds to the line of a client: the three arguments of a run. */
export interface LaunchRun {
  /** A profile filled in by hand. Beside it `profileId` is not read. */
  inlineProfile?: InlineProfile;
  /** Free tokens of the **Launch arguments** field, already split. */
  extraArgs?: string[];
  /** `ip:port` of the server this run joins. */
  connect?: string;
}

/**
 * The command line the client would be started with.
 *
 * `retry: false` because every way this fails is a refusal of the core — no
 * game folder, no such client — and asking twice changes none of them.
 *
 * --- slice: player profiles ---
 * `profileId` names the profile to assume, and it is part of the key, so two
 * profiles of one client never share an answer. `CommandPreview` passes
 * neither argument and reads the line behind **Play**; the token line under an
 * open profile form comes from `profileTokens` on the page instead — a draft
 * nobody saved is not a profile the core could resolve.
 *
 * --- slice: connect dialog ---
 * `run` is what a single launch adds on top: the profile the dialog filled in,
 * the free tokens of its field and the address. The **Connect…** dialog passes
 * all three, so the line under it is the line its own button starts.
 */
export function useLaunchPreview(
  clientId: string,
  profileId?: string,
  run?: LaunchRun,
  enabled = true,
  // --- slice: bundles --- the line of the single-player executable when
  // asked for; the multiplayer line otherwise, as before.
  mode?: LaunchMode,
): UseQueryResult<LaunchPreview> {
  return useQuery({
    queryKey: clientKeys.preview(clientId, profileId, run, mode),
    queryFn: () =>
      launchIpc.previewLaunchArgs(
        clientId,
        profileId,
        run?.inlineProfile,
        run?.extraArgs,
        run?.connect,
        mode,
      ),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

// --- slice: player profiles -------------------------------------------------
//
// Profiles live under `queryKeys.clients` as well, so the invalidation the
// client mutations already do covers them: the core emits `clients:changed`
// after every profile write, and `useClientEvents` turns that into one
// invalidation of the whole prefix.

export const profileKeys = {
  book: (clientId: string) => [...queryKeys.clients, clientId, "profiles"] as const,
};

/**
 * What a client can offer a profile, keyed apart from the client's record.
 *
 * The skins and hilts come out of the pk3 files of a client, not out of its
 * `client.json`, and the two change for different reasons: a volume slider
 * writes a record a dozen times during one drag and moves no archive. Under
 * `queryKeys.clients` every one of those writes would refetch the skin list.
 */
export const appearanceKeys = {
  all: ["appearance"] as const,
  models: (clientId: string) => ["appearance", clientId, "models"] as const,
  hilts: (clientId: string) => ["appearance", clientId, "hilts"] as const,
  // --- slice: skins and hilts ---
  preview: (clientId: string, value: string) =>
    ["appearance", clientId, "preview", value] as const,
};

/**
 * The profiles of one client and which of them is the default.
 *
 * --- slice: connect dialog ---
 * `enabled` is for the caller that may have no client yet: the **Connect…**
 * dialog opens on a game whose client list can be empty, and an id of `""`
 * would be a round trip that can only come back `NotFound`.
 */
export function useProfiles(
  clientId: string,
  enabled = true,
): UseQueryResult<ProfileBook> {
  return useQuery({
    queryKey: profileKeys.book(clientId),
    queryFn: () => profilesIpc.listProfiles(clientId),
    enabled,
    staleTime: Infinity,
  });
}

/**
 * The skins this client can offer, read out of the archives it loads.
 *
 * Idle until the form that needs them is open: the first answer opens the
 * retail archives and extracts two hundred icons, and a window that never
 * shows a profile form must not pay for that.
 */
export function usePlayerModels(
  clientId: string,
  enabled: boolean,
): UseQueryResult<PlayerModel[]> {
  return useQuery({
    queryKey: appearanceKeys.models(clientId),
    queryFn: () => profilesIpc.listPlayerModels(clientId),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/** The saber hilts this client can offer. Empty for a game with none. */
export function useSaberHilts(
  clientId: string,
  enabled: boolean,
): UseQueryResult<SaberHilt[]> {
  return useQuery({
    queryKey: appearanceKeys.hilts(clientId),
    queryFn: () => profilesIpc.listSaberHilts(clientId),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

// --- slice: skins and hilts ---
/**
 * The composed picture of one combination of head, torso and legs.
 *
 * Keyed by the whole value, so every combination the player tries is composed
 * once and comes back from memory afterwards. The core caches the file as
 * well, which is what makes the second launcher run free.
 *
 * `null` — a value that is not an assembled skin — never reaches the core: the
 * query is idle, and the caller draws whatever it drew before.
 */
export function useAssembledPreview(
  clientId: string,
  value: string | null,
): UseQueryResult<string | null> {
  return useQuery({
    queryKey: appearanceKeys.preview(clientId, value ?? ""),
    queryFn: () => profilesIpc.assembledSkinPreview(clientId, value ?? ""),
    enabled: clientId !== "" && value !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Refetches the skins and hilts when any window changes a client's files.
 *
 * The two lists never go stale by themselves — the archives of a client do not
 * move on their own — but the Library screen of the main window installs a pk3
 * and the profile form of the client window is what has to notice. The core
 * drops its own cache on the same event, so the refetch is a memory read
 * unless something really changed.
 */
export function useAppearanceEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let stop: UnlistenFn | undefined;

    void listen(LIBRARY_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: appearanceKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["model-preview"] });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);
}

/**
 * The three writers of a profile document.
 *
 * Each answers with the whole document, which goes straight into the cache:
 * the core is the one that decides which profile is the default after a
 * delete, and a screen that guessed would draw the wrong badge for a moment.
 */
function useProfileWriter<TVariables>(
  clientId: string,
  write: (variables: TVariables) => Promise<ProfileBook>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (book) => {
      queryClient.setQueryData(profileKeys.book(clientId), book);
      queryClient.invalidateQueries({ queryKey: queryKeys.clients });
    },
  });
}

export function useSaveProfile(clientId: string) {
  return useProfileWriter(clientId, (profile: PlayerProfile) =>
    profilesIpc.saveProfile(clientId, profile),
  );
}

export function useDeleteProfile(clientId: string) {
  return useProfileWriter(clientId, (profileId: string) =>
    profilesIpc.deleteProfile(clientId, profileId),
  );
}

export function useSetDefaultProfile(clientId: string) {
  return useProfileWriter(clientId, (profileId: string | null) =>
    profilesIpc.setDefaultProfile(clientId, profileId),
  );
}

/**
 * Refetches the client list when any window changes a record.
 *
 * A React Query cache belongs to one window. The client window writes a cvar
 * and the Clients screen of the main window is showing the same record, so the
 * core says so and both caches drop what they held.
 */
export function useClientEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let stop: UnlistenFn | undefined;

    void listen<ClientsChanged>(clientEvents.changed, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.clients });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);
}

// --- slice: clients page ---

/**
 * The folder of one client on disk, as the core resolves it.
 *
 * Asked of the core rather than joined onto `dataRoot` on the screen:
 * `dataDirOverride` moves that root and the slug is a detail of `paths.rs`.
 * The answer holds until the settings change, which is exactly when
 * `useUpdateSettings` invalidates the whole `clients` prefix.
 */
export function useClientDir(clientId: string | null): UseQueryResult<string> {
  return useQuery({
    queryKey: clientKeys.dir(clientId ?? ""),
    queryFn: () => ipc.clientDir(clientId as string),
    enabled: clientId !== null,
    staleTime: Infinity,
  });
}

/**
 * Refetches the settings when any window moves the default client of a game.
 *
 * The same story as `useClientEvents`, one document over: the switch is in the
 * client window and the **DEFAULT** badge on a card of the main one, and
 * neither window refetches on focus.
 */
export function useDefaultClientEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let stop: UnlistenFn | undefined;

    void listen<DefaultClientsChanged>(settingsEvents.defaultClients, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);
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
      // --- slice: player profiles ---
      // Left out by the Play and Connect buttons, which means the client's
      // default profile. The Connect dialog is what sends one.
      profileId,
      // --- slice: connect dialog ---
      // A profile of this launch alone, filled in by hand. Beside it the core
      // does not read `profileId`.
      inlineProfile,
      // --- slice: bundles ---
      // `single` for **Play single player**; left out by every other button.
      mode,
    }: {
      clientId: string;
      connect?: string;
      extraArgs?: string[];
      profileId?: string;
      inlineProfile?: InlineProfile;
      mode?: LaunchMode;
    }) =>
      launchIpc.launchClient(
        clientId,
        connect,
        extraArgs,
        profileId,
        inlineProfile,
        mode,
      ),
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
 */
export const serverKeys = {
  /** The list `cache\servers-<game>.json` holds, kept fresh by
   * `useServerRefresh`. */
  cached: (game: Game) => ["servers", "cached", game] as const,
  // --- slice: servers browser ---
  /** What the last LAN sweep found. Never written to disk, never merged into
   * the list above: a machine on this network is not a server the master
   * list knows about. */
  lan: (game: Game) => ["servers", "lan", game] as const,
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

// --- slice: servers browser ---
/**
 * What the last LAN sweep found, for the length of this session.
 *
 * There is nothing to fetch: the list exists only after `refresh_lan` answers,
 * and the sweep writes it into this cache itself. The query is here so the LAN
 * rows live where every other list lives, keyed by game and kept out of the
 * master list — and so the tab opens on an empty table with a hint rather than
 * on a scan the player did not ask for.
 */
export function useLanServers(): ServerInfo[] {
  const game = useActiveGame();
  const query = useQuery({
    queryKey: serverKeys.lan(game),
    queryFn: () => [] as ServerInfo[],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return query.data ?? [];
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

// --- slice: server actions ---
/**
 * Takes a server off the browser, or puts it back.
 *
 * The same shape as `useSetServerFavorite` above and for the same reason: the
 * flag lives in the settings, the row carries a copy of it, and repainting the
 * one row beats refetching a thousand.
 */
export function useSetServerHidden() {
  const queryClient = useQueryClient();
  const game = useActiveGame();
  return useMutation({
    mutationFn: ({ address, hidden }: { address: string; hidden: boolean }) =>
      serversIpc.setServerHidden(address, hidden, game),
    onSuccess: (settings, variables) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      // Both lists, because a server on the desk next to the player is hidden
      // by the same press and lives in the sweep's own list: the LAN tab holds
      // rows that never enter the cached one, and a row that stayed put after
      // **Hide** would read as a press that did nothing.
      for (const key of [serverKeys.cached(game), serverKeys.lan(game)]) {
        queryClient.setQueryData<ServerInfo[]>(key, (rows) =>
          rows?.map((row) =>
            row.address === variables.address
              ? { ...row, hidden: variables.hidden }
              : row,
          ),
        );
      }
    },
  });
}

/**
 * Records a connection. The History tab reads `serverHistory` from settings.
 *
 * --- slice: server actions ---
 * `clientId` is the client the caller is about to start: the entry remembers
 * it, and the next **Connect** on that row starts the same one.
 */
export function useAddServerHistory() {
  const queryClient = useQueryClient();
  const game = useActiveGame();
  return useMutation({
    mutationFn: ({ address, clientId, game: targetGame }: { address: string; clientId?: string; game?: Game }) =>
      serversIpc.addServerHistory(address, clientId, targetGame ?? game),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
    },
  });
}

// --- slice: servers browser ---
/** What one tab's own indicator shows. */
export interface ScopeRefresh {
  /** A scan of this tab is in flight. */
  running: boolean;
  /** Message of this tab's last failed scan, cleared when the next starts. */
  error: string | null;
  /** Counts of this tab's last finished scan. */
  progress: ServersDoneEvent | null;
  /** `Date.now()` of this tab's last finished scan, for "refreshed N s ago". */
  refreshedAt: number | null;
}

/** What `useServerRefresh` gives the Servers screen. */
export interface ServerRefresh {
  /** **Get new list**: the master servers, then a probe of their addresses. */
  getNewList: () => void;
  /** **Refresh**: re-probes addresses already on screen, under one tab's scope. */
  refreshAddresses: (scope: ServerScope, addresses: string[]) => void;
  /** The **LAN** tab: one broadcast sweep of the local network. */
  refreshLan: () => void;
  /** The indicator of every tab, keyed by scope. */
  scopes: Record<ServerScope, ScopeRefresh>;
}

/**
 * A tab nothing has scanned yet.
 *
 * --- slice: server actions ---
 * Exported because the **Hidden** tab has no scan at all and never will: it is
 * a view of the cached list, so this is its indicator for good.
 */
export const IDLE_SCOPE: ScopeRefresh = {
  running: false,
  error: null,
  progress: null,
  refreshedAt: null,
};

const IDLE_SCOPES: Record<ServerScope, ScopeRefresh> = {
  all: IDLE_SCOPE,
  favorites: IDLE_SCOPE,
  history: IDLE_SCOPE,
  lan: IDLE_SCOPE,
  // --- slice: servers home tweaks --- the details panel, which has a
  // **Refresh** button and a **Watch** switch of its own and no tab at all.
  one: IDLE_SCOPE,
};

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
 * Runs the three scans of the browser and streams their results into the lists.
 *
 * Nothing starts by itself: every scan is a button the player pressed. The core
 * answers twice — `servers:batch` every 100 ms while a scan runs, and the
 * command's own return value at the end. The batches are what makes the table
 * fill in row by row; the return value is the whole answer of that scan.
 *
 * --- slice: servers browser ---
 * Every event carries the scope that started it, so each tab keeps its own
 * loader, counter and "refreshed N s ago" line, and a scan of Favorites leaves
 * the All tab exactly where it was.
 */
export function useServerRefresh(): ServerRefresh {
  const queryClient = useQueryClient();
  // --- slice: game core ---
  // One refresh belongs to one game. The events carry theirs, so a batch of
  // the other game is dropped rather than merged into the list on screen.
  const game = useActiveGame();
  // A ref, not the state flags: two clicks in the same frame would both read
  // `false` and start two scans of the same list.
  const inFlight = useRef<Set<ServerScope>>(new Set());
  const [scopes, setScopes] =
    useState<Record<ServerScope, ScopeRefresh>>(IDLE_SCOPES);

  const patchScope = useCallback(
    (scope: ServerScope, change: Partial<ScopeRefresh>) =>
      setScopes((before) => ({
        ...before,
        [scope]: { ...before[scope], ...change },
      })),
    [],
  );

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const stops: UnlistenFn[] = [];

    void (async () => {
      const stopBatch = await listen<ServersBatchEvent>(
        "servers:batch",
        (event) => {
          // The payload names its game, so the rows land in that game's list
          // even when the player switched away while the scan ran. A LAN batch
          // lands in the sweep's own list: those rows belong to this network
          // and to this session, not to the master list.
          const forGame = event.payload.game;
          const key =
            event.payload.scope === "lan"
              ? serverKeys.lan(forGame)
              : serverKeys.cached(forGame);
          queryClient.setQueryData<ServerInfo[]>(key, (rows) =>
            mergeServers(rows ?? [], event.payload.servers),
          );
        },
      );
      const stopDone = await listen<ServersDoneEvent>(
        "servers:done",
        (event) => {
          if (event.payload.game !== game) return;
          patchScope(event.payload.scope, { progress: event.payload });
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
  }, [queryClient, game, patchScope]);

  /** Runs one scan under one scope and writes its answer where `apply` says. */
  const run = useCallback(
    (
      scope: ServerScope,
      call: () => Promise<ServerInfo[]>,
      apply: (servers: ServerInfo[]) => void,
    ) => {
      if (inFlight.current.has(scope)) return;
      inFlight.current.add(scope);
      patchScope(scope, { running: true, error: null });
      call()
        .then((servers) => {
          apply(servers);
          patchScope(scope, { refreshedAt: Date.now() });
        })
        .catch((e: unknown) => patchScope(scope, { error: errorMessage(e) }))
        .finally(() => {
          inFlight.current.delete(scope);
          patchScope(scope, { running: false });
        });
    },
    [patchScope],
  );

  const getNewList = useCallback(() => {
    run(
      "all",
      () => serversIpc.refreshServers(game),
      // Wholesale, and this is the only scan that may do it: the masters have
      // just said who is online, so a row they no longer list has left.
      (servers) => queryClient.setQueryData(serverKeys.cached(game), servers),
    );
  }, [run, queryClient, game]);

  const refreshAddresses = useCallback(
    (scope: ServerScope, addresses: string[]) => {
      run(
        scope,
        () => serversIpc.refreshAddresses(addresses, scope, game),
        // Merged by address: this scan knows about the addresses it asked and
        // nothing else, so the rest of the list stays as it was.
        (servers) =>
          queryClient.setQueryData<ServerInfo[]>(serverKeys.cached(game), (rows) =>
            mergeServers(rows ?? [], servers),
          ),
      );
    },
    [run, queryClient, game],
  );

  const refreshLan = useCallback(() => {
    run(
      "lan",
      () => serversIpc.refreshLan(game),
      // Wholesale as well: a sweep sees the whole network at once, so a
      // machine that stopped answering is a machine that is gone.
      (servers) => queryClient.setQueryData(serverKeys.lan(game), servers),
    );
  }, [run, queryClient, game]);

  return { getNewList, refreshAddresses, refreshLan, scopes };
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
// The service account. Every hook here works through `accountIpc`, so the bearer
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
        // screen reads the service address out of it.
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

// --- slice: online gate ---
/**
 * Whether this build has a service, or `undefined` before the core has answered.
 *
 * Three screens switch on it — the Account card, the Friends screen and the
 * third step of the first run — and `useFriendsState` stops calling on it.
 * `undefined` means "not known yet", never "no": outside Tauri the account
 * query fails, and the Friends screen still has the mock service to draw against.
 */
export function useOnlineConfigured(): boolean | undefined {
  return useAccountState().data?.onlineConfigured;
}

/** Where a sign-in has got to. */
export type SignInPhase = "idle" | "starting" | "waiting" | "done" | "error";

/** What `useSignIn` gives a screen. */
export interface SignInFlow {
  phase: SignInPhase;
  /** The provider being signed in with, while one is. */
  provider: OnlineProvider | null;
  /** The account, once the browser has sent the player back. */
  user: OnlineUser | null;
  /** What to print when `phase` is `error`. */
  error: string | null;
  /** The address opened in the browser, for a browser that stayed shut. */
  url: string | null;
  start: (provider: OnlineProvider) => void;
  /** Stops polling. The session on the service expires on its own. */
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
 * player's browser talks to the service, not to the launcher, and a launcher that
 * opened a port to hear about it would need a firewall prompt to sign in.
 */
export function useSignIn(): SignInFlow {
  // --- slice: i18n --- the four sentences this flow produces itself. Every
  // other message it shows comes from the service and is printed as it came.
  const { t } = useTranslation("account");
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [provider, setProvider] = useState<OnlineProvider | null>(null);
  const [user, setUser] = useState<OnlineUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // A poll that has not answered yet must not start a second one: a service that
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
    (chosen: OnlineProvider) => {
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
              setError(t("session.timedOut"));
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
                      ? t("session.expired")
                      : t("session.failed")),
                );
              })
              .catch((e: unknown) => {
                stopPolling();
                setPhase("error");
                setError(onlineErrorMessage(e));
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
            onlineErrorCode(e) === "provider_error"
              ? // A provider that has issued no OAuth client yet is answered by
                // the same catalog key as any other `provider_error`.
                t("providers.notAvailable", {
                  provider: chosen === "discord" ? t("providers.discord") : t("providers.jkhub"),
                })
              : onlineErrorMessage(e),
          );
        });
    },
    [queryClient, stopPolling, t],
  );

  return { phase, provider, user, error, url, start, cancel };
}

/** Invalidates everything that shows an account. */
function useAccountRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: accountKeys.state });
    queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  };
}

/** Forgets the account here and invalidates the token on the service. */
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

/** Deletes the account on the service. Nothing on this machine is touched. */
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
  // --- slice: online gate ---
  // No service, no query: the command would answer an empty document, and the
  // sidebar and the Friends screen have their own state for this. The query
  // starts by itself when the player names a service, because `account:changed`
  // and the settings write invalidate the account state this reads.
  const configured = useOnlineConfigured();
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
 * while nobody is signed in and while the service is switched off. The second case
 * is checked here rather than left to the disabled query: React Query keeps
 * what it fetched, so a player who clears the service address would otherwise keep
 * a counter from the session before.
 */
export function useOnlineFriendCount(): number | undefined {
  const configured = useOnlineConfigured();
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
  // --- slice: online gate ---
  // Nothing emits these while the service is switched off, and the window should
  // not hold three subscriptions waiting for it. They attach by themselves
  // when the player names a service, because this value changes with the account.
  const configured = useOnlineConfigured();

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
  comments: (id: number, page: number) => ["jkhub", "comments", id, page] as const,
  all: ["jkhub"] as const,
  categories: (game: Game) => ["jkhub", "categories", game] as const,
  list: (game: Game, categoryId: number, sort: JkhubSort, page: number) =>
    ["jkhub", "list", game, categoryId, sort, page] as const,
  file: (id: number) => ["jkhub", "file", id] as const,
  // --- slice: jkhub index ---
  search: (
    game: Game,
    query: string,
    categoryId: number | null,
    sort: JkhubSort,
    perPage: number,
    direction: SortDirection,
  ) => ["jkhub", "search", game, query, categoryId, sort, perPage, direction] as const,
  index: (game: Game) => ["jkhub", "index", game] as const,
};

/**
 * The category tree of one game.
 *
 * Never refetched on its own. The core answers from its disk cache — a week
 * long — or from the tree bundled with the build, and walks the site behind
 * the answer; twenty requests are far too many to spend on a window regaining
 * focus. What does refetch it: the `jkhub:categories-updated` this hook
 * listens for, which the walk emits when it found something newer, and
 * [`useRefreshJkhubCategories`] behind the **Update categories** action.
 */
export function useJkhubCategories(
  game: Game,
  enabled = true,
): UseQueryResult<JkhubCategories> {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<JkhubCategoriesUpdated>(
      jkhubEvents.categoriesUpdated,
      (event) => {
        // Only the tree of that game: a walk of Jedi Outcast has no business
        // dropping the listing pages the player is reading in Jedi Academy.
        void queryClient.invalidateQueries({
          queryKey: jkhubKeys.categories(event.payload.game),
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
  }, [queryClient]);

  return useQuery({
    queryKey: jkhubKeys.categories(game),
    queryFn: () => jkhubIpc.categories(game),
    enabled: enabled && isTauri(),
    staleTime: Infinity,
  });
}

/**
 * One page of one category as jkhub.org serves it, 25 cards.
 *
 * --- slice: jkhub index ---
 * No screen calls this any more: the tab lists from the local catalogue index
 * through [`useJkhubSearch`], which answers about every category at once. It
 * stays because `jkhub_list` stays — it is the only path that reads a listing
 * page live, and the only way to see a category the index has not crawled yet.
 */
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

export function useJkhubComments(id: number, page: number): UseQueryResult<JkhubComments> {
  return useQuery({
    queryKey: jkhubKeys.comments(id, page),
    queryFn: () => jkhubIpc.comments(id, page),
    enabled: isTauri(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** What **Refresh** on the tab reads again. */
export interface JkhubRefreshTarget {
  game: Game;
  /** The open category, or `null` while none is picked. */
  categoryId: number | null;
  sort: JkhubSort;
  /** How many pages of the listing are on screen. */
  pages: number;
  /** The file whose panel is open, or `null`. */
  fileId: number | null;
}

/**
 * Reads the listing on screen again, and the open file page with it.
 *
 * Deliberately not the category tree: that costs about twenty requests, it
 * changes a few times a year, and the core refreshes it on its own. **Update
 * categories** in the tree header is the action for it.
 *
 * The pages are fetched with `refresh: true` and written into the cache by
 * hand rather than invalidated. Invalidating would refetch them through the
 * ordinary query function, which lets the core answer out of its own
 * thirty-minute cache — the one thing a player pressing **Refresh** is trying
 * to get past.
 */
export function useRefreshJkhubListing() {
  const queryClient = useQueryClient();
  return useCallback(
    async ({ game, categoryId, sort, pages, fileId }: JkhubRefreshTarget) => {
      const reads: Promise<unknown>[] = [];
      if (categoryId != null) {
        for (let page = 1; page <= pages; page += 1) {
          reads.push(
            jkhubIpc
              .list(categoryId, sort, page, game, true)
              .then((listing) =>
                queryClient.setQueryData(
                  jkhubKeys.list(game, categoryId, sort, page),
                  listing,
                ),
              ),
          );
        }
      }
      if (fileId != null) {
        reads.push(
          jkhubIpc
            .file(fileId, true)
            .then((file) =>
              queryClient.setQueryData(jkhubKeys.file(fileId), file),
            ),
        );
      }
      await Promise.all(reads);
    },
    [queryClient],
  );
}

/**
 * Walks the category tree of one game before answering.
 *
 * The **Update categories** action of the tree header. Costs about twenty
 * requests to jkhub.org, which is why it is a separate, quiet action rather
 * than part of **Refresh**.
 */
export function useRefreshJkhubCategories() {
  const queryClient = useQueryClient();
  return useCallback(
    async (game: Game) => {
      // `refresh: true` is what makes the core ignore its own disk cache and
      // its once-a-day limit on walking the tree.
      const categories = await jkhubIpc.categories(game, true);
      queryClient.setQueryData(jkhubKeys.categories(game), categories);
      return categories;
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
    // --- slice: jkhub details ---
    // Every install goes through this hook, so this is the one place that
    // sees all three moments a progress card needs. Reporting from the screen
    // instead would mean a screen that forgets leaves a card spinning for the
    // rest of the session.
    //
    // The failure travels as it came: this file translates nothing, and the
    // card that shows it already has `useErrorText`.
    onMutate: ({ id }) => {
      const cached = queryClient.getQueryData<JkhubFile>(jkhubKeys.file(id));
      jkhubDownloads.start(id, cached?.title ?? null, clientId);
    },
    onError: (error, { id }) => jkhubDownloads.fail(id, error),
    onSuccess: (result) => {
      jkhubDownloads.finish(result.fileId, result);
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
// --- slice: jkhub index ---

/**
 * One page of the catalogue of one game, filtered by a query.
 *
 * Answered from the local index, so it costs no request and never waits for
 * jkhub.org: `staleTime: Infinity` because the only thing that can change the
 * answer is the index itself, and [`useJkhubIndexStatus`] drops the key when
 * that happens.
 *
 * An empty `query` is the full listing of `categoryId`, or of the whole game
 * when no category is picked. `perPage` grows with **Load more** rather than
 * the page number: stitching pages by hand buys nothing when the whole answer
 * is already in memory on the other side of the call.
 */
export function useJkhubSearch(
  game: Game,
  query: string,
  categoryId: number | null,
  sort: JkhubSort,
  perPage: number,
  direction: SortDirection,
): UseQueryResult<JkhubSearchResult> {
  return useQuery({
    queryKey: jkhubKeys.search(game, query, categoryId, sort, perPage, direction),
    queryFn: () =>
      jkhubIpc.search({ game, query, categoryId, sort, direction, page: 1, perPage }),
    enabled: isTauri(),
    staleTime: Infinity,
    // The previous answer stays on screen while a longer page or a narrower
    // query is fetched, so typing does not blank the grid between keystrokes.
    placeholderData: (previous) => previous,
  });
}

/**
 * What the index of one game holds, and whether a refresh is running.
 *
 * Asking is also what lets the core top the index up behind the answer, at
 * most once a day per game — the same shape as the category tree. The result
 * arrives as `jkhub:index-updated`, and this hook is what turns that event
 * into a refetch of the searches and of the status itself.
 */
export function useJkhubIndexStatus(
  game: Game,
  enabled = true,
): UseQueryResult<JkhubIndexStatus> {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<JkhubIndexUpdate>(jkhubEvents.indexUpdated, (event) => {
      const changed = event.payload;
      void queryClient.invalidateQueries({
        queryKey: jkhubKeys.index(changed.game),
      });
      // Every search of that game, whatever its query and order: the catalogue
      // under all of them just moved.
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "jkhub" &&
          query.queryKey[1] === "search" &&
          query.queryKey[2] === changed.game,
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);

  return useQuery({
    queryKey: jkhubKeys.index(game),
    queryFn: () => jkhubIpc.indexStatus(game),
    enabled: enabled && isTauri(),
    staleTime: 15_000,
    // `building` is the core's own claim on the game, released however the
    // work ends, so it is the one thing worth polling: a crawl takes a minute
    // and a half and the line under the results has to stop saying so when it
    // is over, even if the run ended without changing anything.
    refetchInterval: (query) => (query.state.data?.building ? 2_000 : false),
  });
}

/**
 * How far a crawl of the catalogue has got, per game.
 *
 * One listener for the tab, like the download progress next to it. The entry
 * of a game stays behind after its crawl ends; the screen stops reading it the
 * moment the status says the index is no longer building.
 *
 * The first event of a run — the one with `done: 0` — also drops the status
 * key. A refresh the core started behind an answer is otherwise invisible
 * until the next poll, and the line under the results would keep describing an
 * index that is being rewritten under it.
 */
export function useJkhubIndexProgress(): Map<Game, JkhubIndexProgress> {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<Map<Game, JkhubIndexProgress>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<JkhubIndexProgress>(jkhubEvents.indexProgress, (event) => {
      setProgress((current) => {
        const next = new Map(current);
        next.set(event.payload.game, event.payload);
        return next;
      });
      if (event.payload.done === 0) {
        void queryClient.invalidateQueries({
          queryKey: jkhubKeys.index(event.payload.game),
        });
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);

  return progress;
}

/**
 * Brings the catalogue index of one game up to date, in the foreground.
 *
 * The **Refresh** action of the tab. `full` is the crawl of every listing
 * page — about 150 requests for Jedi Academy — which the core also falls back
 * to on its own when the cheap path cannot do the job.
 *
 * The core emits `jkhub:index-updated` when it changed something, and
 * [`useJkhubIndexStatus`] drops the keys, so nothing is written into the cache
 * here.
 */
export function useRefreshJkhubIndex() {
  return useCallback(
    (game: Game, full = false) => jkhubIpc.refreshIndex(game, full),
    [],
  );
}

// --- slice: jkhub index startup ---

/**
 * Stops the crawl of one game.
 *
 * The **Cancel** action of the blocking panel. The core answers `cancelled`
 * from the call that was running and leaves the index alone; this hook drops
 * the status key so the panel stops saying «indexing» without waiting out the
 * two-second poll.
 */
export function useCancelJkhubIndex() {
  const queryClient = useQueryClient();
  return useCallback(
    async (game: Game) => {
      await jkhubIpc.cancelIndex(game);
      await queryClient.invalidateQueries({ queryKey: jkhubKeys.index(game) });
    },
    [queryClient],
  );
}

// --- slice: library cleanup ---
/**
 * Empties the whole JKHub cache folder: pages, file cards, downloaded
 * archives and the catalogue index of both games.
 *
 * The **Clear JKHub cache** action of the Settings screen. Nothing is lost
 * that the site cannot serve again, and every shipped build carries a snapshot
 * of the catalogue, so the tab still lists after it. Every key of the module
 * is dropped, because the core just deleted what answered them.
 */
export function useClearJkhubCache() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await jkhubIpc.clearCache();
    await queryClient.invalidateQueries({ queryKey: jkhubKeys.all });
  }, [queryClient]);
}

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

// ---------------------------------------------------------------------------
// --- slice: bundles ---
//
// The catalogue of bundles on JKNet Online, the drafts on this disk, and the
// long operations — installing a version or a draft into clients and
// publishing a draft. The reads are ordinary queries under two prefixes; the
// long operations report into `bundleJobs`, the store the dialogs and the
// editor read their bars from, so a dialog that was closed and opened again
// finds the work where it left it.
// ---------------------------------------------------------------------------

export const bundleKeys = {
  all: ["bundles"] as const,
  list: (query: BundleQuery) =>
    [
      "bundles",
      "list",
      query.game,
      query.sort,
      query.q ?? "",
      query.engineId ?? "",
      query.tag ?? "",
      query.limit ?? 50,
      query.offset ?? 0,
    ] as const,
  details: (bundleId: string) => ["bundles", "details", bundleId] as const,
  version: (bundleId: string, versionId: string) =>
    ["bundles", "version", bundleId, versionId] as const,
  /** The bundles of the signed-in account, with the quota. */
  mine: ["bundles", "mine"] as const,
  /** The review queue of an administrator. */
  pending: ["bundles", "pending"] as const,
  /**
   * The drafts, outside the `bundles` prefix on purpose: an invalidation of
   * the catalogue must not re-read the disk under an open editor.
   */
  drafts: ["bundle-drafts"] as const,
  /** One draft in full. Written by every edit, read on the way in. */
  draft: (draftId: string) => ["bundle-drafts", draftId, "record"] as const,
  /** The errors and warnings of one draft, re-read after every edit. */
  draftIssues: (draftId: string) => ["bundle-drafts", draftId, "issues"] as const,
  /** The release archive of one component with the overlay laid over it. */
  draftEngineFiles: (draftId: string, componentId: string) =>
    ["bundle-drafts", draftId, "engine-files", componentId] as const,
  /** The mutation key of every edit of one draft, for the state the header of the editor reads. */
  draftEdits: (draftId: string) => ["bundle-drafts", draftId, "edit"] as const,
  /** The absolute path of one picture of a draft. */
  draftImagePath: (draftId: string, sha256: string) =>
    ["bundle-drafts", draftId, "image", sha256] as const,
  /** The table of contents of one pk3 of a draft. */
  draftFileListing: (draftId: string, scope: string, root: BundleFileRoot, path: string) =>
    ["bundle-drafts", draftId, "listing", scope, root, path] as const,
  /** The text of one cfg of a draft. */
  draftFileText: (draftId: string, scope: string, root: BundleFileRoot, path: string) =>
    ["bundle-drafts", draftId, "text", scope, root, path] as const,
  /** The table of contents of a pk3 of the catalogue, by the hash of its listing file. */
  fileListing: (sha256: string) => ["bundles", "listing", sha256] as const,
  /** The text of a cfg of the catalogue, by its hash and the path the manifest gives it. */
  fileText: (sha256: string, path: string) => ["bundles", "text", sha256, path] as const,
};

/**
 * The address of JKNet Online, for the pictures of a description: the
 * frontend loads them straight from the store, `<service>/v1/blobs/<sha256>`.
 *
 * The core is the one that knows the address; outside Tauri, where the
 * account query cannot answer, a development build reads the same stand-in
 * `devOnline.ts` talks to, so a browser review has pictures too. Empty
 * while nothing is known, which draws the picture as missing.
 */
export function useOnlineUrl(): string {
  const account = useAccountState();
  if (account.data?.onlineUrl) return account.data.onlineUrl;
  if (import.meta.env.DEV && !isTauri()) {
    return new URLSearchParams(window.location.search).get("online") ?? "http://127.0.0.1:8787";
  }
  return "";
}

/**
 * One page of the catalogue.
 *
 * The previous answer stays on screen while a narrower query is fetched, so
 * typing into the search box does not blank the grid between keystrokes.
 * Outside Tauri a development build still asks: the mock service answers.
 */
export function useBundles(query: BundleQuery, enabled = true): UseQueryResult<BundleList> {
  return useQuery({
    queryKey: bundleKeys.list(query),
    queryFn: () => bundlesIpc.list(query),
    enabled,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

/** One bundle in full, with the clients of this machine that came out of it. */
export function useBundle(bundleId: string | null): UseQueryResult<BundleDetailsWithLocal> {
  return useQuery({
    queryKey: bundleKeys.details(bundleId ?? ""),
    queryFn: () => bundlesIpc.get(bundleId as string),
    enabled: bundleId !== null,
    staleTime: 30_000,
  });
}

/** One version with its manifest, for a version other than the latest. */
export function useBundleVersion(
  bundleId: string | null,
  versionId: string | null,
): UseQueryResult<BundleVersion> {
  return useQuery({
    queryKey: bundleKeys.version(bundleId ?? "", versionId ?? ""),
    queryFn: () => bundlesIpc.version(bundleId as string, versionId as string),
    enabled: bundleId !== null && versionId !== null,
    staleTime: Infinity,
  });
}

/** The bundles of the signed-in account, every version and status included. */
export function useMyBundles(enabled = true): UseQueryResult<MyBundles> {
  return useQuery({
    queryKey: bundleKeys.mine,
    queryFn: bundlesIpc.mine,
    enabled: enabled && isTauri(),
    staleTime: 15_000,
  });
}

/** The versions waiting for an administrator. Ask only when the account is one. */
export function usePendingBundleVersions(enabled = true): UseQueryResult<PendingVersion[]> {
  return useQuery({
    queryKey: bundleKeys.pending,
    queryFn: bundlesIpc.pending,
    enabled: enabled && isTauri(),
    staleTime: 15_000,
  });
}

/**
 * Whether the signed-in account may review bundles.
 *
 * `false` until the core says otherwise: the button it hides is the review
 * queue, and the service checks the right again on every call.
 */
export function useIsBundleAdmin(): boolean {
  const account = useAccountState();
  return account.data?.onlineSignedIn === true && account.data.isAdmin === true;
}

/**
 * Installs chosen components of a version into new clients, or carries on
 * in the clients of a failed try.
 *
 * Every install goes through this hook, so it is the one place that reports
 * the three moments the dialog draws: the press, the answer and the failure.
 * The events in between reach the store on their own.
 */
export function useInstallBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      bundleId,
      versionId,
      baseName,
      componentIds,
      existingClientIds,
    }: {
      bundleId: string;
      versionId: string;
      baseName: string;
      componentIds: string[];
      existingClientIds?: Record<string, string> | null;
    }) => bundlesIpc.install(bundleId, versionId, baseName, componentIds, existingClientIds),
    onMutate: ({ bundleId, versionId, baseName, componentIds, existingClientIds }) => {
      bundleJobs.startInstall({
        key: installJobKey(bundleId, versionId),
        bundleId,
        versionId,
        draftId: null,
        baseName,
        componentIds,
        existingClientIds: existingClientIds ?? {},
      });
    },
    onError: (error, { bundleId, versionId }) =>
      bundleJobs.failInstall(installJobKey(bundleId, versionId), error),
    onSuccess: (clients, { bundleId, versionId }) => {
      bundleJobs.finishInstall(installJobKey(bundleId, versionId), clients);
      // New clients on the Clients screen, new lines under `local` of the
      // bundle, and a new install in the counters of the catalogue.
      void queryClient.invalidateQueries({ queryKey: queryKeys.clients });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.details(bundleId) });
      void queryClient.invalidateQueries({ queryKey: [...bundleKeys.all, "list"] });
    },
  });
}

/** Installs chosen components of a draft into new clients: **Test locally**. */
export function useInstallBundleDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      draftId,
      baseName,
      componentIds,
      existingClientIds,
    }: {
      draftId: string;
      baseName: string;
      componentIds: string[];
      existingClientIds?: Record<string, string> | null;
    }) => bundlesIpc.installDraft(draftId, baseName, componentIds, existingClientIds),
    onMutate: ({ draftId, baseName, componentIds, existingClientIds }) => {
      bundleJobs.startInstall({
        key: draftJobKey(draftId),
        bundleId: null,
        versionId: null,
        draftId,
        baseName,
        componentIds,
        existingClientIds: existingClientIds ?? {},
      });
    },
    onError: (error, { draftId }) => bundleJobs.failInstall(draftJobKey(draftId), error),
    onSuccess: (clients, { draftId }) => {
      bundleJobs.finishInstall(draftJobKey(draftId), clients);
      void queryClient.invalidateQueries({ queryKey: queryKeys.clients });
    },
  });
}

/**
 * Publishes a draft as a bundle, or as a new version of the bundle it is
 * bound to. A retry is the same call: the core carries on with the bundle
 * the failed try created, which it wrote into the draft.
 */
export function usePublishBundleDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) => bundlesIpc.publishDraft(draftId),
    onMutate: (draftId) => {
      bundleJobs.startPublish(draftId);
    },
    onError: (error, draftId) => bundleJobs.failPublish(draftId, error),
    onSuccess: (result, draftId) => {
      bundleJobs.finishPublish(draftId, result);
      // The draft now carries `bundleId`, the clients made out of it carry
      // the version, the account has one more bundle or version, and the
      // catalogue may have a new card.
      void queryClient.invalidateQueries({ queryKey: bundleKeys.draft(draftId) });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.drafts });
      void queryClient.invalidateQueries({ queryKey: queryKeys.clients });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.all });
    },
  });
}

/** Likes a bundle, or takes the like back. The answer is dropped into the record. */
export function useLikeBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bundleId, liked }: { bundleId: string; liked: boolean }) =>
      bundlesIpc.like(bundleId, liked),
    onSuccess: (answer, { bundleId }) => {
      queryClient.setQueryData<BundleDetailsWithLocal>(bundleKeys.details(bundleId), (record) =>
        record === undefined ? record : { ...record, likes: answer.likes, likedByMe: answer.likedByMe },
      );
      void queryClient.invalidateQueries({ queryKey: [...bundleKeys.all, "list"] });
    },
  });
}

/** Hides a bundle of the account. The files go to the collector later. */
export function useDeleteBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bundleId: string) => bundlesIpc.remove(bundleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bundleKeys.all });
      // The clients installed from the bundle keep their link, but the
      // record behind it is gone: refetch so a stale answer does not stay.
      void queryClient.invalidateQueries({ queryKey: queryKeys.clients });
    },
  });
}

/** Approves or rejects a version of the review queue. */
export function useReviewBundleVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      versionId,
      approve,
      note,
    }: {
      versionId: string;
      approve: boolean;
      note?: string | null;
    }) => bundlesIpc.review(versionId, approve, note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bundleKeys.all });
    },
  });
}

/** Features or hides a bundle, as an administrator. */
export function useSetBundleFlags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      bundleId,
      featured,
      hidden,
    }: {
      bundleId: string;
      featured?: boolean;
      hidden?: boolean;
    }) => bundlesIpc.setFlags(bundleId, { featured, hidden }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bundleKeys.all });
    },
  });
}

// --- drafts ---

/**
 * The drafts on this disk, for the strip of the Bundles tab.
 *
 * Drafts live in the data folder, so outside Tauri there are none to list
 * and the query stays idle rather than printing a refusal under the strip.
 */
export function useBundleDrafts(): UseQueryResult<DraftSummary[]> {
  return useQuery({
    queryKey: bundleKeys.drafts,
    queryFn: bundlesIpc.listDrafts,
    enabled: isTauri(),
    staleTime: 15_000,
  });
}

/**
 * One draft in full, the record the editor works on.
 *
 * Every edit answers with the whole draft and writes it here, so the record
 * is fresh for as long as the editor is open; `staleTime: Infinity` keeps
 * a remount from re-reading a file nothing else has changed.
 */
export function useBundleDraft(draftId: string | null): UseQueryResult<Draft> {
  return useQuery({
    queryKey: bundleKeys.draft(draftId ?? ""),
    queryFn: () => bundlesIpc.getDraft(draftId as string),
    enabled: draftId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** What stands between a draft and its publication, re-read after every edit. */
export function useDraftIssues(draftId: string | null, enabled = true): UseQueryResult<DraftIssues> {
  return useQuery({
    queryKey: bundleKeys.draftIssues(draftId ?? ""),
    queryFn: () => bundlesIpc.validateDraft(draftId as string),
    enabled: enabled && draftId !== null && isTauri(),
    retry: false,
  });
}

/**
 * The release archive of one component, file by file, with the overlay
 * marked on it. The first read may download the archive, so the tab that
 * asks says so while it waits.
 */
export function useDraftEngineFiles(
  draftId: string | null,
  componentId: string | null,
): UseQueryResult<ReleaseView> {
  return useQuery({
    queryKey: bundleKeys.draftEngineFiles(draftId ?? "", componentId ?? ""),
    queryFn: () => bundlesIpc.engineFiles(draftId as string, componentId as string),
    enabled: draftId !== null && componentId !== null && isTauri(),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The absolute path of one picture of a draft, for the editor of the
 * description: the node of a `blob:` picture shows the file of the draft
 * through the asset protocol. The path of a picture never changes while
 * the draft exists.
 */
export function useDraftImagePath(draftId: string | null, sha256: string | null): UseQueryResult<string> {
  return useQuery({
    queryKey: bundleKeys.draftImagePath(draftId ?? "", sha256 ?? ""),
    queryFn: () => bundlesIpc.imagePath(draftId as string, sha256 as string),
    enabled: draftId !== null && sha256 !== null && isTauri(),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Adds a picture to a draft.
 *
 * The command answers with the picture, not with the draft, so the record
 * is re-read for its `images`; the path of the new picture is written into
 * the cache at once, so the node the editor inserts has it on the first
 * frame. The checks are re-read too: a picture without a link is a warning.
 */
export function useAddDraftImage(draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourcePath: string) => bundlesIpc.addImage(draftId, sourcePath),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bundleKeys.draft(draftId) });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.draftIssues(draftId) });
    },
  });
}

/** The table of contents of a pk3 of a draft, for the **Contents** dialog. */
export function useDraftFileListing(
  draftId: string,
  scope: string,
  root: BundleFileRoot,
  path: string,
  enabled = true,
): UseQueryResult<Listing> {
  return useQuery({
    queryKey: bundleKeys.draftFileListing(draftId, scope, root, path),
    queryFn: () => bundlesIpc.draftFileListing(draftId, scope, root, path),
    enabled: enabled && isTauri(),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The table of contents of a pk3 of the catalogue, by the hash of its
 * listing file. The core keeps the file in its cache, so the second open
 * of the same archive is a read of the disk.
 */
export function useBundleFileListing(sha256: string | null, enabled = true): UseQueryResult<Listing> {
  return useQuery({
    queryKey: bundleKeys.fileListing(sha256 ?? ""),
    queryFn: () => bundlesIpc.fileListing(sha256 as string),
    enabled: enabled && sha256 !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** The text of a cfg of a draft, for the **Contents** dialog. */
export function useDraftFileText(
  draftId: string,
  scope: string,
  root: BundleFileRoot,
  path: string,
  enabled = true,
): UseQueryResult<string> {
  return useQuery({
    queryKey: bundleKeys.draftFileText(draftId, scope, root, path),
    queryFn: () => bundlesIpc.draftFileText(draftId, scope, root, path),
    enabled: enabled && isTauri(),
    staleTime: Infinity,
    retry: false,
  });
}

/** The text of a cfg of the catalogue, by its hash; `path` is what the manifest calls the file. */
export function useBundleFileText(
  sha256: string | null,
  path: string,
  enabled = true,
): UseQueryResult<string> {
  return useQuery({
    queryKey: bundleKeys.fileText(sha256 ?? "", path),
    queryFn: () => bundlesIpc.fileText(sha256 as string, path),
    enabled: enabled && sha256 !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The files of the store coming down for **Preview** in the catalogue, by
 * hash, from `bundles:preview-progress`. The same shape as
 * `useJkhubDownloadProgress`, which covers the JKHub files of a bundle.
 */
export function useBundlePreviewProgress(): Map<string, BundlePreviewProgress> {
  const [progress, setProgress] = useState<Map<string, BundlePreviewProgress>>(() => new Map());

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<BundlePreviewProgress>(bundleEvents.previewProgress, (event) => {
      setProgress((current) => {
        const next = new Map(current);
        next.set(event.payload.sha256, event.payload);
        return next;
      });
    }).then((stop) => {
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

/** Creates a draft, blank or out of a client, and puts it in the cache for the editor. */
export function useCreateBundleDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      game,
      name,
      fromClientId,
    }: {
      game: Game;
      name: string;
      fromClientId?: string | null;
    }) => bundlesIpc.createDraft(game, name, fromClientId),
    onSuccess: (draft) => {
      queryClient.setQueryData(bundleKeys.draft(draft.id), draft);
      void queryClient.invalidateQueries({ queryKey: bundleKeys.drafts });
    },
  });
}

/** Creates a draft bound to a published bundle, with the files of a version. */
export function useCreateBundleDraftFromBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bundleId, versionId }: { bundleId: string; versionId?: string | null }) =>
      bundlesIpc.createDraftFromBundle(bundleId, versionId),
    onSuccess: (draft) => {
      queryClient.setQueryData(bundleKeys.draft(draft.id), draft);
      void queryClient.invalidateQueries({ queryKey: bundleKeys.drafts });
    },
  });
}

/** Deletes a draft and its files. The clients made out of it stay. */
export function useDeleteBundleDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) => bundlesIpc.deleteDraft(draftId),
    onSuccess: (_, draftId) => {
      queryClient.removeQueries({ queryKey: [...bundleKeys.drafts, draftId] });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.drafts });
    },
  });
}

/**
 * The order of the edits of one draft, shared by its fourteen writers.
 *
 * `sent` numbers every edit as it is pressed; `applied` is the number of
 * the edit whose answer the cache holds. Two edits can be in flight at
 * once — a Tab out of one field into the next sends two — and their
 * answers can come back the other way round, so an answer is applied only
 * when it is newer than the one in the cache. The `updatedAt` of the draft
 * cannot tell the two apart: the core stamps it to the second.
 */
interface DraftEditOrder {
  sent: number;
  applied: number;
}

/**
 * The shape of every edit of a draft: the command answers with the whole
 * draft, which replaces the record in the cache unless a later edit already
 * has, and the issues are re-read. A refused edit re-reads the record
 * instead: the disk holds whatever the core left there, and the cache must
 * not guess.
 *
 * `engineFiles` is for an edit that changes what the release looks like
 * under the overlay — a replacement, an addition, an exclusion, a new tag —
 * and drops the file list of the component so the tab re-reads it.
 */
function useDraftWriter<TVariables>(
  draftId: string,
  order: { current: DraftEditOrder },
  write: (variables: TVariables) => Promise<Draft>,
  engineFiles = false,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: bundleKeys.draftEdits(draftId),
    mutationFn: write,
    onMutate: () => ({ seq: ++order.current.sent }),
    onSuccess: (draft, _variables, { seq }) => {
      // An answer to an edit older than the one the cache holds: it lacks
      // the later edit, and the fields would fall back to what they showed
      // before it. Dropped; the later answer carried both.
      if (seq < order.current.applied) return;
      order.current.applied = seq;
      queryClient.setQueryData(bundleKeys.draft(draftId), draft);
      void queryClient.invalidateQueries({ queryKey: bundleKeys.draftIssues(draftId) });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.drafts });
      if (engineFiles) {
        void queryClient.invalidateQueries({
          queryKey: [...bundleKeys.drafts, draftId, "engine-files"],
        });
      }
    },
    onError: async (_error, _variables, context) => {
      // A later edit was pressed after this one: its answer, or its own
      // refusal, brings the record. Otherwise the record is read again —
      // and kept only if no answer landed in the cache while it was read,
      // which would be newer than what the disk held at the time.
      if (context === undefined || context.seq !== order.current.sent) return;
      const applied = order.current.applied;
      try {
        const draft = await bundlesIpc.getDraft(draftId);
        if (order.current.applied === applied) {
          queryClient.setQueryData(bundleKeys.draft(draftId), draft);
        }
      } catch {
        // The editor keeps what it has; the next edit answers with the
        // record or is refused the same way, under the reason in the header.
      }
    },
  });
}

/**
 * Every edit of one draft, as mutations.
 *
 * One hook rather than fourteen imports in the editor; each mutation is its
 * own, so a section can show the pending state of the one it pressed. The
 * order of the edits is one for all of them: an answer is applied only
 * when no later edit has answered already.
 */
export function useDraftActions(draftId: string) {
  const order = useRef<DraftEditOrder>({ sent: 0, applied: 0 });
  return {
    update: useDraftWriter(draftId, order, (patch: DraftPatch) => bundlesIpc.updateDraft(draftId, patch)),
    addComponent: useDraftWriter(
      draftId,
      order,
      (component: NewDraftComponent) => bundlesIpc.addComponent(draftId, component),
      true,
    ),
    updateComponent: useDraftWriter(
      draftId,
      order,
      ({ componentId, patch }: { componentId: string; patch: DraftComponentPatch }) =>
        bundlesIpc.updateComponent(draftId, componentId, patch),
      true,
    ),
    removeComponent: useDraftWriter(
      draftId,
      order,
      (componentId: string) => bundlesIpc.removeComponent(draftId, componentId),
      true,
    ),
    addFilesFromDisk: useDraftWriter(
      draftId,
      order,
      ({ scope, folder, paths }: { scope: string; folder: string; paths: string[] }) =>
        bundlesIpc.addFilesFromDisk(draftId, scope, folder, paths),
    ),
    addFileFromJkhub: useDraftWriter(
      draftId,
      order,
      ({ scope, folder, fileId }: { scope: string; folder: string; fileId: number }) =>
        bundlesIpc.addFileFromJkhub(draftId, scope, folder, fileId),
    ),
    addFilesFromClient: useDraftWriter(
      draftId,
      order,
      ({ scope, clientId, itemIds }: { scope: string; clientId: string; itemIds: string[] }) =>
        bundlesIpc.addFilesFromClient(draftId, scope, clientId, itemIds),
    ),
    removeFile: useDraftWriter(
      draftId,
      order,
      ({ scope, root, path }: { scope: string; root: BundleFileRoot; path: string }) =>
        bundlesIpc.removeFile(draftId, scope, root, path),
      true,
    ),
    setConfigs: useDraftWriter(
      draftId,
      order,
      ({ scope, configs }: { scope: string; configs: DraftConfig[] }) =>
        bundlesIpc.setConfigs(draftId, scope, configs),
    ),
    replaceEngineFile: useDraftWriter(
      draftId,
      order,
      ({ componentId, path, sourcePath }: { componentId: string; path: string; sourcePath: string }) =>
        bundlesIpc.replaceEngineFile(draftId, componentId, path, sourcePath),
      true,
    ),
    addEngineFiles: useDraftWriter(
      draftId,
      order,
      ({ componentId, folder, paths }: { componentId: string; folder: string; paths: string[] }) =>
        bundlesIpc.addEngineFiles(draftId, componentId, folder, paths),
      true,
    ),
    excludeEngineFile: useDraftWriter(
      draftId,
      order,
      ({ componentId, path, excluded }: { componentId: string; path: string; excluded: boolean }) =>
        bundlesIpc.excludeEngineFile(draftId, componentId, path, excluded),
      true,
    ),
    restoreEngineFile: useDraftWriter(
      draftId,
      order,
      ({ componentId, path }: { componentId: string; path: string }) =>
        bundlesIpc.restoreEngineFile(draftId, componentId, path),
      true,
    ),
    /** Takes a picture the description does not use out of the draft. */
    removeImage: useDraftWriter(draftId, order, (sha256: string) => bundlesIpc.removeImage(draftId, sha256)),
  };
}

/** The mutations of `useDraftActions`, for a section that takes them as a prop. */
export type DraftActions = ReturnType<typeof useDraftActions>;

/** What the header of the editor says about the edits of a draft. */
export interface DraftSaveState {
  /** An edit is in flight — any edit, not only the newest press of each kind. */
  saving: boolean;
  /** The newest settled edit went through. False before the first edit. */
  saved: boolean;
  /** The refusal of the newest settled edit, or `null` when it went through. */
  error: unknown;
}

/**
 * The state of the edits of one draft, for the header of the editor.
 *
 * Read off the mutation cache rather than the fourteen hooks of
 * `useDraftActions`: a hook reports its newest press only, so with two
 * presses of one field in flight it would say **Saved** as soon as the
 * second answered, while the first was still on its way. Every edit of the
 * draft is in the cache under one key, in the order pressed: saving while
 * any is in flight, otherwise what the newest settled one answered. Edits
 * of an earlier visit to the editor, still in the cache, are left out: the
 * header opens on the autosave hint, not on the outcome of last time.
 */
export function useDraftSaveState(draftId: string): DraftSaveState {
  const [since] = useState(() => Date.now());
  const edits = useMutationState({
    filters: {
      mutationKey: bundleKeys.draftEdits(draftId),
      predicate: (mutation) => mutation.state.submittedAt >= since,
    },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  });
  const settled = edits.filter((edit) => edit.status === "success" || edit.status === "error");
  const newest = settled[settled.length - 1];
  return {
    saving: edits.some((edit) => edit.status === "pending"),
    saved: newest?.status === "success",
    error: newest?.status === "error" ? newest.error : null,
  };
}

// ---------------------------------------------------------------------------
// --- slice: pk3 editor ---
//
// One open archive in the pk3 editor: the session, the text and the pictures
// of its entries, and the edits. The session is a query keyed by the target,
// so a dialog opened twice on the same file finds the record; every edit
// answers with the session and writes it there. **Save** re-reads the owner
// of the archive — the draft, or the library of the client — the way the
// mutations of those slices do.
// ---------------------------------------------------------------------------

export const pk3EditorKeys = {
  all: ["pk3-editor"] as const,
  /** The session on the archive of one target. */
  session: (target: Pk3EditorTarget) =>
    target.kind === "draft"
      ? (["pk3-editor", "session", "draft", target.draftId, target.scope, target.root, target.path] as const)
      : (["pk3-editor", "session", "library", target.clientId, target.itemId] as const),
  /** Every read of the entries of one session: the prefix an edit invalidates. */
  reads: (sessionId: string) => ["pk3-editor", "reads", sessionId] as const,
  /** The reads of one entry: its text and its picture at every size. */
  entry: (sessionId: string, path: string) => ["pk3-editor", "reads", sessionId, path] as const,
  text: (sessionId: string, path: string) => ["pk3-editor", "reads", sessionId, path, "text"] as const,
  image: (sessionId: string, path: string, maxSize: number | undefined) =>
    ["pk3-editor", "reads", sessionId, path, "image", maxSize ?? 0] as const,
};

/**
 * The session of the editor on the archive of a target, opened on the way
 * in and closed when the dialog goes.
 *
 * The close is the same arrangement as the release of a preview session:
 * the id is remembered while the dialog stands, and the cleanup closes it a
 * microtask later, only if no remount has taken the same id back — which
 * is what a StrictMode double mount does, and what would otherwise close a
 * session the dialog is still using. A session answered after the dialog
 * closed is closed on the spot: nobody is left to do it later.
 */
export function usePk3EditorSession(target: Pk3EditorTarget): UseQueryResult<Pk3EditorSession> {
  const queryClient = useQueryClient();
  const key = pk3EditorKeys.session(target);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const session = await pk3EditorIpc.open(target);
      if (!queryClient.getQueryCache().find({ queryKey: key })?.getObserversCount()) {
        void pk3EditorIpc.close(session.id).catch(() => undefined);
      }
      return session;
    },
    enabled: isTauri(),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const current = useRef<string | undefined>(undefined);
  const id = query.data?.id;
  useEffect(() => {
    current.current = id;
    return () => {
      current.current = undefined;
      queueMicrotask(() => {
        if (id !== undefined && current.current !== id) {
          void pk3EditorIpc.close(id).catch(() => undefined);
          queryClient.removeQueries({ queryKey: pk3EditorKeys.reads(id) });
        }
      });
    };
  }, [id, queryClient]);
  return query;
}

/** The text of one entry of an open session, decoded by the core. */
export function usePk3EditorText(sessionId: string | null, path: string | null): UseQueryResult<PreviewText> {
  return useQuery({
    queryKey: pk3EditorKeys.text(sessionId ?? "", path ?? ""),
    queryFn: () => pk3EditorIpc.readText(sessionId as string, path as string),
    enabled: sessionId !== null && path !== null && isTauri(),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
}

/** One picture of an open session, at its own size or as a thumbnail no larger than `maxSize`. */
export function usePk3EditorImage(
  sessionId: string | null,
  path: string | null,
  maxSize?: number,
): UseQueryResult<PreviewImage> {
  return useQuery({
    queryKey: pk3EditorKeys.image(sessionId ?? "", path ?? "", maxSize),
    queryFn: () => pk3EditorIpc.readImage(sessionId as string, path as string, maxSize),
    enabled: sessionId !== null && path !== null && isTauri(),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
}

/**
 * The edits of one open session, as mutations.
 *
 * Every edit answers with the session and replaces the record; the reads
 * of the entries it touched are dropped, so the panel re-reads a text that
 * was written or a picture that was replaced. **Save** re-reads the session
 * for the states of the entries and the owner of the archive for its size,
 * hash and features. `sessionId` is `null` until the session is open, and
 * every edit refuses until then; the dialog keeps the buttons off as well.
 */
export function usePk3EditorActions(target: Pk3EditorTarget, sessionId: string | null) {
  const queryClient = useQueryClient();
  const sessionKey = pk3EditorKeys.session(target);
  const withSession = <T,>(work: (id: string) => Promise<T>): Promise<T> =>
    sessionId === null ? Promise.reject(new Error("the archive is not open")) : work(sessionId);
  const keep = (session: Pk3EditorSession) => queryClient.setQueryData(sessionKey, session);
  /** Drops the reads of one entry, or of every entry of the session. */
  const dropReads = (path?: string) => {
    if (sessionId === null) return;
    void queryClient.invalidateQueries({
      queryKey: path === undefined ? pk3EditorKeys.reads(sessionId) : pk3EditorKeys.entry(sessionId, path),
    });
  };
  const refreshOwner = () => {
    if (target.kind === "draft") {
      void queryClient.invalidateQueries({ queryKey: bundleKeys.draft(target.draftId) });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.draftIssues(target.draftId) });
      void queryClient.invalidateQueries({ queryKey: bundleKeys.drafts });
      void queryClient.invalidateQueries({
        queryKey: bundleKeys.draftFileListing(target.draftId, target.scope, target.root, target.path),
      });
      if (target.root === "engine") {
        void queryClient.invalidateQueries({ queryKey: [...bundleKeys.drafts, target.draftId, "engine-files"] });
      }
    } else {
      void queryClient.invalidateQueries({ queryKey: libraryKeys.items(target.clientId) });
      void queryClient.invalidateQueries({ queryKey: libraryKeys.conflicts(target.clientId) });
    }
  };

  return {
    writeText: useMutation({
      mutationFn: ({ path, text }: { path: string; text: string }) =>
        withSession((id) => pk3EditorIpc.writeText(id, path, text)),
      onSuccess: (session, { path }) => {
        keep(session);
        dropReads(path);
      },
    }),
    replace: useMutation({
      mutationFn: ({ path, sourcePath }: { path: string; sourcePath: string }) =>
        withSession((id) => pk3EditorIpc.replace(id, path, sourcePath)),
      onSuccess: (session, { path }) => {
        keep(session);
        dropReads(path);
      },
    }),
    addFiles: useMutation({
      mutationFn: ({ folder, sourcePaths }: { folder: string; sourcePaths: string[] }) =>
        withSession((id) => pk3EditorIpc.addFiles(id, folder, sourcePaths)),
      // An added file may stand on the path of an entry already read.
      onSuccess: (session) => {
        keep(session);
        dropReads();
      },
    }),
    remove: useMutation({
      mutationFn: (paths: string[]) => withSession((id) => pk3EditorIpc.remove(id, paths)),
      onSuccess: keep,
    }),
    rename: useMutation({
      mutationFn: ({ from, to }: { from: string; to: string }) =>
        withSession((id) => pk3EditorIpc.rename(id, from, to)),
      onSuccess: (session) => {
        keep(session);
        dropReads();
      },
    }),
    extract: useMutation({
      mutationFn: ({ paths, targetDir }: { paths: string[]; targetDir: string }) =>
        withSession((id) => pk3EditorIpc.extract(id, paths, targetDir)),
    }),
    save: useMutation({
      mutationFn: () =>
        withSession(async (id) => {
          const saved = await pk3EditorIpc.save(id);
          return { saved, session: await pk3EditorIpc.state(id) };
        }),
      onSuccess: ({ session }) => {
        keep(session);
        refreshOwner();
      },
    }),
    discard: useMutation({
      mutationFn: () => withSession((id) => pk3EditorIpc.discard(id)),
      onSuccess: (session) => {
        keep(session);
        dropReads();
      },
    }),
  };
}

/** The mutations of `usePk3EditorActions`, for a panel that takes them as a prop. */
export type Pk3EditorActions = ReturnType<typeof usePk3EditorActions>;
