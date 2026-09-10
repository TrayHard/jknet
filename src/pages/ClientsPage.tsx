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
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { useGameEventsContext } from "../components/GameEventsProvider";
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
  type Settings,
} from "../lib/ipc";
import { formatBytes, shortenPath } from "../lib/format";
import {
  useClients,
  useDeleteClient,
  useEngineReleases,
  useEngines,
  useEngineUpdate,
  useGameFiles,
  useInstallEngine,
  useLaunchClient,
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
  const engines = useEngines();
  const gameFiles = useGameFiles();
  const updateSettings = useUpdateSettings();
  const deleteClient = useDeleteClient();
  const installEngine = useInstallEngine();
  const launchClient = useLaunchClient();
  const stopGame = useStopGame();
  const runningGame = useRunningGame();
  const { installs, clearInstall } = useGameEventsContext();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchSettings = (patch: Partial<Settings>) => {
    if (!settings.data) return;
    setError(null);
    updateSettings.mutate({ ...settings.data, ...patch }, {
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
      const candidate = await ipc.inspectGameFiles(picked);
      if (!candidate.valid) {
        const missing = candidate.assets
          .filter((asset) => !asset.present)
          .map((asset) => asset.name)
          .join(", ");
        setError(`No game files in ${candidate.path}. Missing: ${missing}.`);
        return;
      }
      patchSettings({ gameDataPath: candidate.path });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // A command that never answered is as much of a failure as one that said
  // no, and outside the Tauri runtime it is the only thing to report.
  const queryError =
    settings.error ?? clients.error ?? engines.error ?? gameFiles.error ?? null;
  const failure = error ?? (queryError ? errorMessage(queryError) : null);

  const configuredPath = settings.data?.gameDataPath ?? null;
  const detected = gameFiles.data ?? [];
  const activeCandidate =
    detected.find((candidate) => candidate.path === configuredPath) ??
    detected.find((candidate) => candidate.valid) ??
    null;

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
              <h2 className="text-heading-sm text-fg">Game files</h2>
              {configuredPath ? (
                <Badge tone="success" icon={<Check size={12} />}>
                  Ready
                </Badge>
              ) : (
                <Badge tone="warm">Not set</Badge>
              )}
            </div>
            <p className="text-body-sm text-fg-secondary pt-4">
              JKNet reads <span className="text-mono-sm">assets0.pk3</span>–
              <span className="text-mono-sm">assets3.pk3</span> from this folder
              and never writes into it.
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
                onClick={() => patchSettings({ gameDataPath: activeCandidate.path })}
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
        ) : clients.data && clients.data.length > 0 ? (
          <ul className="grid grid-cols-1 xl:grid-cols-2 gap-12">
            {clients.data.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                engine={engines.data?.find((engine) => engine.id === client.engineId)}
                isDefault={client.id === settings.data?.defaultClientId}
                install={installs[client.id]}
                running={runningGame.data ?? null}
                onMakeDefault={() => patchSettings({ defaultClientId: client.id })}
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
            title="No clients yet"
            text="A client is a named engine build with its own mods and settings. Create one and it shows up here."
            action={
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                New client
              </Button>
            }
          />
        )}
      </section>

      {/* Engines --------------------------------------------------------- */}
      <section className="flex flex-col gap-12 pt-24">
        <h2 className="text-label-xs text-fg-muted">Engines</h2>
        <ul className="grid grid-cols-1 xl:grid-cols-2 gap-12">
          {(engines.data ?? []).map((engine) => (
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
    </Page>
  );
}

interface ClientCardProps {
  client: Client;
  engine: Engine | undefined;
  isDefault: boolean;
  /** Progress of the install of this client, when one is running. */
  install: EngineInstallProgress | undefined;
  /** The game JKNet started, whichever client it belongs to. */
  running: RunningGame | null;
  onMakeDefault: () => void;
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
  running,
  onMakeDefault,
  onDelete,
  onInstall,
  onLaunch,
  onStop,
}: ClientCardProps) {
  const engineName = engine?.name ?? client.engineId;
  const installing =
    install !== undefined && (install.phase === "download" || install.phase === "extract");
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
          </span>
        </div>
        <div className="flex flex-col gap-8 shrink-0">
          <Button size="sm" onClick={onMakeDefault} disabled={isDefault}>
            {isDefault ? "Default" : "Make default"}
          </Button>
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

      {/* Engine state: install, progress, or launch ---------------------- */}
      {installing && install ? (
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
