import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  Download,
  FolderOpen,
  HardDrive,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { ClientSettingsDialog } from "../components/ClientSettingsDialog";
import { useGameEventsContext } from "../components/GameEventsProvider";
// --- slice: game switch ---
import { NEW_CLIENT_PARAM } from "../components/MissingClientToast";
import { NewClientDialog } from "../components/NewClientDialog";
import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, EmptyState } from "../components/ui";
import {
  errorMessage,
  ipc,
  type Client,
  type Engine,
  type EngineInstallProgress,
  type RunningGame,
  type SettingsPatch,
} from "../lib/ipc";
import { formatBytes, shortenPath } from "../lib/format";
// --- slice: game switch ---
import {
  clientsOfGame,
  defaultClientPatch,
  otherGame,
  resolveDefaultClientId,
  useActiveGame,
  useGameNames,
} from "../lib/game";
import {
  useClients,
  useDeleteClient,
  useEngineReleases,
  useEnginesOfGame,
  useEngineUpdate,
  useGameFiles,
  useGameInfo,
  useInstallEngine,
  useLaunchClient,
  usePendingInstalls,
  useRunningGame,
  useSettings,
  useStopGame,
  useUpdateSettings,
} from "../lib/queries";

/**
 * Clients: the only screen of the skeleton that is fully wired to the core.
 *
 * Two blocks, as in the design: the game files card on top, the list of
 * clients below it, and the engine row with New client at the bottom.
 */
export function ClientsPage() {
  const settings = useSettings();
  const clients = useClients();
  // --- slice: game core ---
  const activeGame = useActiveGame();
  const gameInfo = useGameInfo(activeGame);
  // --- slice: game switch ---
  // Everything on this screen is the active game: its folder, its clients, the
  // builds that play it. The other game is one press of the switcher away, and
  // the line under the list says how many clients are waiting there.
  const engines = useEnginesOfGame(activeGame);
  const { label: gameName } = useGameNames();
  const gameFiles = useGameFiles();
  const updateSettings = useUpdateSettings();
  const deleteClient = useDeleteClient();
  const installEngine = useInstallEngine();
  const launchClient = useLaunchClient();
  const stopGame = useStopGame();
  const runningGame = useRunningGame();
  // Two sources, because neither covers the whole install on its own: the
  // mutation knows about the call from the click until the core answers, the
  // event knows about the download and the unpacking after that.
  const pendingInstalls = usePendingInstalls();
  const { installs, clearInstall } = useGameEventsContext();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- slice: game switch ---
  // A toast elsewhere sent the player here to make a client. The parameter is
  // dropped as the dialog opens, so closing it and reloading does not reopen.
  const [search, setSearch] = useSearchParams();
  const askedForNew = search.get(NEW_CLIENT_PARAM) !== null;
  useEffect(() => {
    if (!askedForNew) return;
    setDialogOpen(true);
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(NEW_CLIENT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [askedForNew, setSearch]);

  // Only the changed fields go to the core: the cached document would carry
  // back stale values for everything else and overwrite `settings.json`.
  const patchSettings = (patch: SettingsPatch) => {
    setError(null);
    updateSettings.mutate(patch, {
      onError: (e) => setError(errorMessage(e)),
    });
  };

  /** Opens the folder picker and saves the folder when it holds the assets. */
  const chooseGameFolder = async () => {
    setError(null);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Select the GameData folder",
      });
      if (typeof picked !== "string") return;
      // --- slice: game core --- checked against the game this card shows.
      const candidate = await ipc.validateGameData(activeGame, picked);
      if (!candidate.valid) {
        const missing = candidate.assets
          .filter((asset) => asset.required && !asset.present)
          .map((asset) => asset.name)
          .join(", ");
        setError(`No game files in ${candidate.path}. Missing: ${missing}.`);
        return;
      }
      patchSettings({ gameDataPaths: { [activeGame]: candidate.path } });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // A command that never answered is as much of a failure as one that said
  // no, and outside the Tauri runtime it is the only thing to report.
  const queryError = settings.error ?? clients.error ?? gameFiles.error ?? null;
  const failure = error ?? (queryError ? errorMessage(queryError) : null);

  // --- slice: game core ---
  // The card shows the folder of the active game. Both games get a row of
  // their own on the Settings screen; the sidebar switcher of the next slice
  // is what makes this card follow the player.
  const configuredPath = settings.data?.gameDataPaths[activeGame] ?? null;
  const detected = gameFiles.data?.[activeGame] ?? [];
  const activeCandidate =
    detected.find((candidate) => candidate.path === configuredPath) ??
    detected.find((candidate) => candidate.valid) ??
    null;
  const assetRange = gameInfo
    ? `${gameInfo.requiredAssets[0]}–${gameInfo.requiredAssets[gameInfo.requiredAssets.length - 1]}`
    : "assets0.pk3–assets3.pk3";
  // --- slice: game switch ---
  // No game badge on a card any more: every card in the list below plays the
  // game named in the switcher, so the badge would repeat the sidebar on every
  // row. The count of the other game's clients carries that news instead.
  const gameClients = clientsOfGame(clients.data, activeGame);
  const otherCount = clientsOfGame(clients.data, otherGame(activeGame)).length;
  const defaultClientId = resolveDefaultClientId(settings.data, activeGame);

  return (
    <Page>
      <PageHeader
        title="Clients"
        subtitle="A client is an engine build with its own files and settings. Name it and it is yours."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => setDialogOpen(true)}
          >
            New client
          </Button>
        }
      />

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      {/* Game files ------------------------------------------------------ */}
      <section className="rounded-lg border border-line bg-surface p-16 mb-24">
        <div className="flex items-start gap-12">
          <span className="flex items-center justify-center size-36 rounded-md bg-elevated text-fg-secondary shrink-0">
            <HardDrive size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-8">
              <h2 className="text-heading-sm text-fg">
                {gameInfo ? `${gameInfo.displayName} files` : "Game files"}
              </h2>
              {configuredPath ? (
                <Badge tone="success" icon={<Check size={12} />}>
                  Ready
                </Badge>
              ) : (
                <Badge tone="warm">Not set</Badge>
              )}
            </div>
            <p className="text-body-sm text-fg-secondary pt-4">
              JKNet reads <span className="text-mono-sm">{assetRange}</span> from
              this folder and never writes into it.
            </p>
            <p className="text-mono-sm text-fg-accent pt-8 break-all">
              {configuredPath ??
                activeCandidate?.path ??
                (gameFiles.isLoading ? "Looking for Steam and GOG copies…" : "No copy found")}
            </p>
            {activeCandidate && !configuredPath ? (
              <p className="text-body-sm text-fg-muted pt-4">
                Found through {sourceName(activeCandidate.source)}. Confirm it to
                start using it.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-8 shrink-0">
            <Button icon={<FolderOpen size={16} />} onClick={() => void chooseGameFolder()}>
              Change folder
            </Button>
            {activeCandidate && activeCandidate.path !== configuredPath ? (
              <Button
                variant="primary"
                onClick={() =>
                  patchSettings({
                    gameDataPaths: { [activeGame]: activeCandidate.path },
                  })
                }
              >
                Use this folder
              </Button>
            ) : null}
          </div>
        </div>

        {detected.length > 1 ? (
          <ul className="flex flex-col gap-4 pt-16">
            {detected.map((candidate) => (
              <li
                key={candidate.path}
                className="flex items-center gap-8 text-body-sm text-fg-muted"
              >
                <Badge tone={candidate.valid ? "neutral" : "danger"}>
                  {sourceName(candidate.source)}
                </Badge>
                <span className="text-mono-xs truncate" title={candidate.path}>
                  {shortenPath(candidate.path, 64)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* Clients --------------------------------------------------------- */}
      <section className="flex flex-col gap-12">
        <h2 className="text-label-xs text-fg-muted">Your clients</h2>

        {clients.isLoading ? (
          <p className="text-body-sm text-fg-muted">Loading…</p>
        ) : gameClients.length > 0 ? (
          <ul className="grid grid-cols-1 xl:grid-cols-2 gap-12">
            {gameClients.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                engine={engines.find((engine) => engine.id === client.engineId)}
                isDefault={client.id === defaultClientId}
                install={installs[client.id]}
                installPending={pendingInstalls.includes(client.id)}
                running={runningGame.data ?? null}
                // --- slice: game switch --- the default belongs to the game
                // of the client, so Jedi Outcast cannot take the Play button
                // away from a Jedi Academy one.
                onMakeDefault={() => patchSettings(defaultClientPatch(client))}
                onEdit={() => setEditing(client)}
                onDelete={() =>
                  deleteClient.mutate(client.id, {
                    onError: (e) => setError(errorMessage(e)),
                  })
                }
                onInstall={() => {
                  setError(null);
                  clearInstall(client.id);
                  installEngine.mutate(
                    { clientId: client.id },
                    { onError: (e) => setError(errorMessage(e)) },
                  );
                }}
                onLaunch={() => {
                  setError(null);
                  launchClient.mutate(
                    { clientId: client.id },
                    { onError: (e) => setError(errorMessage(e)) },
                  );
                }}
                onStop={() =>
                  stopGame.mutate(undefined, {
                    onError: (e) => setError(errorMessage(e)),
                  })
                }
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Plus size={24} />}
            title={`No ${gameName(activeGame)} clients yet`}
            text="A client is a named engine build with its own mods and settings. Create one and it shows up here."
            action={
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                New client
              </Button>
            }
          />
        )}

        {/* --- slice: game switch --- the other game is not empty, it is just
            not on screen. Saying so is what stops a player from thinking the
            launcher lost their clients. */}
        {otherCount > 0 ? (
          <p className="text-body-sm text-fg-muted">
            {otherCount} {gameName(otherGame(activeGame))}{" "}
            {otherCount === 1 ? "client" : "clients"} — switch game in the
            sidebar to see {otherCount === 1 ? "it" : "them"}.
          </p>
        ) : null}
      </section>

      {/* Engines --------------------------------------------------------- */}
      <section className="flex flex-col gap-12 pt-24">
        {/* --- slice: game switch --- the builds that play the active game.
            An engine of the other game cannot be picked in the dialog below
            anyway, so listing it here would only be a card to be puzzled by. */}
        <h2 className="text-label-xs text-fg-muted">
          {gameName(activeGame)} engines
        </h2>
        <ul className="grid grid-cols-1 xl:grid-cols-2 gap-12">
          {engines.map((engine) => (
            <li
              key={engine.id}
              className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-16"
            >
              <div className="flex items-center gap-8">
                <span className="text-heading-sm text-fg">{engine.name}</span>
                {engine.recommended ? <Badge tone="accent">Recommended</Badge> : null}
              </div>
              <p className="text-body-sm text-fg-secondary">{engine.description}</p>
              <p className="text-mono-xs text-fg-muted">{engine.repo}</p>
            </li>
          ))}
        </ul>
      </section>

      {dialogOpen ? (
        <NewClientDialog
          onClose={() => setDialogOpen(false)}
          onError={(message) => setError(message)}
        />
      ) : null}

      {editing ? (
        <ClientSettingsDialog
          client={editing}
          engine={engines.find((engine) => engine.id === editing.engineId)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  );
}

interface ClientCardProps {
  client: Client;
  engine: Engine | undefined;
  isDefault: boolean;
  /** Progress of the install of this client, when one is running. */
  install: EngineInstallProgress | undefined;
  /** True between the click on Install and the first progress event. */
  installPending: boolean;
  /** The game JKNet started, whichever client it belongs to. */
  running: RunningGame | null;
  onMakeDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onInstall: () => void;
  onLaunch: () => void;
  onStop: () => void;
}

function ClientCard({
  client,
  engine,
  isDefault,
  install,
  installPending,
  running,
  onMakeDefault,
  onEdit,
  onDelete,
  onInstall,
  onLaunch,
  onStop,
}: ClientCardProps) {
  const engineName = engine?.name ?? client.engineId;
  const showProgress =
    install !== undefined && (install.phase === "download" || install.phase === "extract");
  // What the buttons go by: the command may be in flight before the first
  // progress event, and both states mean the engine folder is being rewritten.
  const installing = showProgress || installPending;
  const installed = client.engineVersion !== null;
  const isRunning = running?.clientId === client.id;
  const otherIsRunning = running !== null && !isRunning;

  return (
    <li className="flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
      <div className="flex items-start gap-12">
        <span className="flex items-center justify-center size-44 rounded-md bg-elevated text-fg-accent text-display-md shrink-0">
          {engineName.slice(0, 2).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <div className="flex items-center gap-8">
            <span className="text-heading-sm text-fg truncate">{client.name}</span>
            {isDefault ? <Badge tone="accent">Default</Badge> : null}
            {isRunning ? <Badge tone="success">Running</Badge> : null}
          </div>
          <div className="flex items-center gap-8 flex-wrap">
            <Badge tone={installed ? "neutral" : "warm"}>
              {engineName}
              {client.engineVersion ? ` ${client.engineVersion}` : ""}
            </Badge>
            {installed ? null : (
              <span className="text-body-sm text-fg-muted">Engine not installed</span>
            )}
          </div>
          <span className="text-mono-xs text-fg-muted">
            {client.id} · created {client.createdAt.slice(0, 10)}
            {client.fsGame ? ` · fs_game ${client.fsGame}` : ""}
          </span>
        </div>
        <div className="flex flex-col gap-8 shrink-0">
          <Button size="sm" onClick={onMakeDefault} disabled={isDefault}>
            {isDefault ? "Default" : "Make default"}
          </Button>
          <div className="flex items-center gap-4">
            <Button
              size="sm"
              variant="ghost"
              icon={<SettingsIcon size={14} />}
              onClick={onEdit}
              aria-label={`Settings of ${client.name}`}
              title="Name and mod folder"
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={14} />}
              onClick={onDelete}
              disabled={isRunning || installing}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Engine state: install, progress, or launch ---------------------- */}
      {showProgress && install ? (
        <InstallProgressBar progress={install} />
      ) : install?.phase === "error" ? (
        <p className="text-body-sm text-fg-danger break-words">{install.message}</p>
      ) : null}

      {engine && !engine.installable ? (
        <p className="text-body-sm text-fg-muted">
          {engine.notInstallableReason ?? "This build has to be installed by hand."}
        </p>
      ) : (
        <EngineControls
          client={client}
          installed={installed}
          installing={installing}
          isRunning={isRunning}
          otherIsRunning={otherIsRunning}
          onInstall={onInstall}
          onLaunch={onLaunch}
          onStop={onStop}
        />
      )}
    </li>
  );
}

interface EngineControlsProps {
  client: Client;
  installed: boolean;
  installing: boolean;
  isRunning: boolean;
  otherIsRunning: boolean;
  onInstall: () => void;
  onLaunch: () => void;
  onStop: () => void;
}

/**
 * The row of buttons that turns an engine into a running game.
 *
 * The update check is a button, not a page load: it costs a request to GitHub,
 * and a player who opens the screen to rename a client has not asked for one.
 * The release list behind **Install engine** is different — without it the
 * button cannot say which version it is about to fetch.
 */
function EngineControls({
  client,
  installed,
  installing,
  isRunning,
  otherIsRunning,
  onInstall,
  onLaunch,
  onStop,
}: EngineControlsProps) {
  const releases = useEngineReleases(installed ? null : client.engineId);
  const [checkRequested, setCheckRequested] = useState(false);
  const update = useEngineUpdate(checkRequested ? client.id : null);

  const check = () => {
    if (checkRequested) void update.refetch();
    else setCheckRequested(true);
  };

  const latestTag = releases.data?.[0]?.tag;
  const updateAvailable = update.data?.updateAvailable === true;

  return (
    <div className="flex items-center gap-8 flex-wrap">
      {isRunning ? (
        <Button size="sm" variant="danger" icon={<Square size={14} />} onClick={onStop}>
          Stop
        </Button>
      ) : (
        <Button
          size="sm"
          variant="primary"
          icon={<Play size={14} />}
          onClick={onLaunch}
          disabled={!installed || installing || otherIsRunning}
          title={
            otherIsRunning
              ? "Another client is already running"
              : installed
                ? undefined
                : "Install the engine first"
          }
        >
          Launch
        </Button>
      )}

      {installed ? (
        <>
          <Button
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={check}
            disabled={installing || isRunning || update.isFetching}
          >
            {update.isFetching ? "Checking…" : "Check updates"}
          </Button>
          {updateAvailable ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={14} />}
              onClick={onInstall}
              disabled={installing || isRunning}
            >
              Update to {update.data?.latest ?? "the newest build"}
            </Button>
          ) : update.data ? (
            <Badge tone="success" icon={<Check size={12} />}>
              Up to date
            </Badge>
          ) : null}
          {update.error ? (
            <span className="text-body-sm text-fg-danger">
              {errorMessage(update.error)}
            </span>
          ) : null}
        </>
      ) : (
        <Button
          size="sm"
          icon={<Download size={14} />}
          onClick={onInstall}
          disabled={installing}
        >
          {installing
            ? "Installing…"
            : latestTag
              ? `Install engine ${latestTag}`
              : "Install engine"}
        </Button>
      )}

      {installed && client.engineInstalledAt ? (
        <span className="text-mono-xs text-fg-muted">
          installed {client.engineInstalledAt.slice(0, 10)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The bar under a card while an engine downloads and unpacks.
 *
 * A download without a content length gets an indeterminate bar rather than a
 * fake percentage: GitHub always sends one, mirrors do not always.
 */
function InstallProgressBar({ progress }: { progress: EngineInstallProgress }) {
  const ratio =
    progress.total > 0 ? Math.min(1, progress.downloaded / progress.total) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-8">
        <span className="text-body-sm text-fg-secondary truncate">
          {progress.message}
        </span>
        <span className="text-mono-xs text-fg-muted shrink-0">
          {ratio === null
            ? formatBytes(progress.downloaded)
            : `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`}
        </span>
      </div>
      <div
        className="h-6 rounded-full bg-elevated overflow-hidden"
        role="progressbar"
        aria-label={progress.message}
        aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: ratio === null ? "100%" : `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Human name of a detection source, for the game files card. */
function sourceName(source: string): string {
  switch (source) {
    case "steam":
      return "Steam";
    case "gog":
      return "GOG";
    case "manual":
      return "Chosen by hand";
    default:
      return "Saved";
  }
}
