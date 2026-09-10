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
import { Trans, useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import { ClientSettingsDialog } from "../components/ClientSettingsDialog";
import { useGameEventsContext } from "../components/GameEventsProvider";
// --- slice: game switch ---
import {
  NEW_CLIENT_GAME_PARAM,
  NEW_CLIENT_PARAM,
} from "../components/MissingClientToast";
import { NewClientDialog } from "../components/NewClientDialog";
import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, EmptyState } from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useEngineNote } from "../i18n/useEngineNote";
import { useFormat } from "../i18n/useFormat";
import {
  ipc,
  type Client,
  type Engine,
  type EngineInstallProgress,
  type EngineStatus,
  type Game,
  type RunningGame,
  type SettingsPatch,
} from "../lib/ipc";
import { shortenPath } from "../lib/format";
// --- slice: game switch ---
import {
  clientsOfGame,
  defaultClientPatch,
  isGame,
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
  const { t } = useTranslation("clients");
  const { t: tGames } = useTranslation("games");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
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
  // Review finding (Low): the game the toast came about, when it named one.
  // Kept in state because the effect below drops the parameter it arrived in.
  const [newClientGame, setNewClientGame] = useState<Game | undefined>(undefined);

  // --- slice: game switch ---
  // A toast elsewhere sent the player here to make a client. The parameters are
  // dropped as the dialog opens, so closing it and reloading does not reopen.
  const [search, setSearch] = useSearchParams();
  const askedForNew = search.get(NEW_CLIENT_PARAM) !== null;
  const askedForGame = search.get(NEW_CLIENT_GAME_PARAM);
  useEffect(() => {
    if (!askedForNew) return;
    setNewClientGame(isGame(askedForGame) ? askedForGame : undefined);
    setDialogOpen(true);
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(NEW_CLIENT_PARAM);
        next.delete(NEW_CLIENT_GAME_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [askedForNew, askedForGame, setSearch]);

  // Only the changed fields go to the core: the cached document would carry
  // back stale values for everything else and overwrite `settings.json`.
  const patchSettings = (patch: SettingsPatch) => {
    setError(null);
    updateSettings.mutate(patch, {
      onError: (e) => setError(errorText(e)),
    });
  };

  /** Opens the folder picker and saves the folder when it holds the assets. */
  const chooseGameFolder = async () => {
    setError(null);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: t("gameFiles.pickTitle"),
      });
      if (typeof picked !== "string") return;
      // --- slice: game core --- checked against the game this card shows.
      const candidate = await ipc.validateGameData(activeGame, picked);
      if (!candidate.valid) {
        const missing = candidate.assets
          .filter((asset) => asset.required && !asset.present)
          .map((asset) => asset.name)
          .join(", ");
        setError(t("gameFiles.invalid", { path: candidate.path, missing }));
        return;
      }
      patchSettings({ gameDataPaths: { [activeGame]: candidate.path } });
    } catch (e) {
      setError(errorText(e));
    }
  };

  // A command that never answered is as much of a failure as one that said
  // no, and outside the Tauri runtime it is the only thing to report.
  const queryError = settings.error ?? clients.error ?? gameFiles.error ?? null;
  const failure = error ?? (queryError ? errorText(queryError) : null);

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
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => setDialogOpen(true)}
          >
            {t("newClient")}
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
                {gameInfo
                  ? t("gameFiles.title", { game: gameInfo.displayName })
                  : t("gameFiles.titleFallback")}
              </h2>
              {configuredPath ? (
                <Badge tone="success" icon={<Check size={12} />}>
                  {t("gameFiles.ready")}
                </Badge>
              ) : (
                <Badge tone="warm">{t("gameFiles.notSet")}</Badge>
              )}
            </div>
            <p className="text-body-sm text-fg-secondary pt-4">
              <Trans
                t={t}
                i18nKey="gameFiles.text"
                values={{ range: assetRange }}
                components={[<span className="text-mono-sm" />]}
              />
            </p>
            <p className="text-mono-sm text-fg-accent pt-8 break-all">
              {configuredPath ??
                activeCandidate?.path ??
                (gameFiles.isLoading
                  ? t("gameFiles.searching")
                  : t("gameFiles.noCopy"))}
            </p>
            {activeCandidate && !configuredPath ? (
              <p className="text-body-sm text-fg-muted pt-4">
                {t("gameFiles.foundThrough", {
                  source: tGames(`sources.${activeCandidate.source}`),
                })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-8 shrink-0">
            <Button icon={<FolderOpen size={16} />} onClick={() => void chooseGameFolder()}>
              {t("gameFiles.changeFolder")}
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
                {t("gameFiles.useThisFolder")}
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
                  {tGames(`sources.${candidate.source}`)}
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
        <h2 className="text-label-xs text-fg-muted">{t("list.heading")}</h2>

        {clients.isLoading ? (
          <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
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
                    onError: (e) => setError(errorText(e)),
                  })
                }
                onInstall={() => {
                  setError(null);
                  clearInstall(client.id);
                  installEngine.mutate(
                    { clientId: client.id },
                    { onError: (e) => setError(errorText(e)) },
                  );
                }}
                onLaunch={() => {
                  setError(null);
                  launchClient.mutate(
                    { clientId: client.id },
                    { onError: (e) => setError(errorText(e)) },
                  );
                }}
                onNewClient={() => setDialogOpen(true)}
                onStop={() =>
                  stopGame.mutate(undefined, {
                    onError: (e) => setError(errorText(e)),
                  })
                }
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Plus size={24} />}
            title={t("list.emptyTitle", { game: gameName(activeGame) })}
            text={t("list.emptyText")}
            action={
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                {t("newClient")}
              </Button>
            }
          />
        )}

        {/* --- slice: game switch --- the other game is not empty, it is just
            not on screen. Saying so is what stops a player from thinking the
            launcher lost their clients. */}
        {otherCount > 0 ? (
          <p className="text-body-sm text-fg-muted">
            {t("list.otherGame", {
              count: otherCount,
              game: gameName(otherGame(activeGame)),
            })}
          </p>
        ) : null}
      </section>

      {/* Engines --------------------------------------------------------- */}
      <section className="flex flex-col gap-12 pt-24">
        {/* --- slice: game switch --- the builds that play the active game.
            An engine of the other game cannot be picked in the dialog below
            anyway, so listing it here would only be a card to be puzzled by. */}
        <h2 className="text-label-xs text-fg-muted">
          {t("engines.heading", { game: gameName(activeGame) })}
        </h2>
        <ul className="grid grid-cols-1 xl:grid-cols-2 gap-12">
          {engines.map((engine) => (
            <li
              key={engine.id}
              className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-16"
            >
              <div className="flex items-center gap-8">
                <span className="text-heading-sm text-fg">{engine.name}</span>
                {engine.status.kind === "recommended" ? (
                  <Badge tone="accent">{t("engines.recommended")}</Badge>
                ) : null}
                {engine.status.kind === "legacy" ? (
                  <Badge tone="warm">{t("engines.legacy")}</Badge>
                ) : null}
              </div>
              {/* The engine name and its one-line description come from the
                  registry in the core and name a project: data, not copy. The
                  note is the opposite: the registry names a catalog key and
                  the sentence itself is translated. */}
              <p className="text-body-sm text-fg-secondary">{engine.description}</p>
              <EngineNoteText status={engine.status} />
              <p className="text-mono-xs text-fg-muted">{engine.repo}</p>
            </li>
          ))}
        </ul>
      </section>

      {dialogOpen ? (
        <NewClientDialog
          game={newClientGame}
          onClose={() => {
            setDialogOpen(false);
            setNewClientGame(undefined);
          }}
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

// --- slice: i18n ---
// `sourceName` is gone: the four detection sources are `games.sources.*` in the
// catalogs, and both this screen and the first run read them from there.

/**
 * The warning a legacy build carries, or nothing at all.
 *
 * The registry card in the section above states the fact and stops there: the
 * offer to make a client on the successor belongs on a client's own card,
 * where the player has one to replace.
 */
function EngineNoteText({ status }: { status: EngineStatus }) {
  const note = useEngineNote()(status);
  if (note === null) return null;
  return <p className="text-body-sm text-fg-muted">{note.text}</p>;
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
  /** Opens the New client dialog, for the way out of a legacy engine. */
  onNewClient: () => void;
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
  onNewClient,
}: ClientCardProps) {
  const { t } = useTranslation("clients");
  const format = useFormat();
  const engineNote = useEngineNote();
  // A client built on a build nobody maintains says so once, under the card
  // head, and offers the successor the note names. It is a sentence and a
  // link, not a dialog: the client still works, and a player who keeps it for
  // one server should not have to argue with the launcher about it.
  const legacyNote = engine ? engineNote(engine.status) : null;
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
            {isDefault ? <Badge tone="accent">{t("card.default")}</Badge> : null}
            {isRunning ? <Badge tone="success">{t("card.running")}</Badge> : null}
          </div>
          <div className="flex items-center gap-8 flex-wrap">
            <Badge tone={installed ? "neutral" : "warm"}>
              {engineName}
              {client.engineVersion ? ` ${client.engineVersion}` : ""}
            </Badge>
            {installed ? null : (
              <span className="text-body-sm text-fg-muted">
                {t("card.engineNotInstalled")}
              </span>
            )}
          </div>
          <span className="text-mono-xs text-fg-muted">
            {client.fsGame
              ? t("card.metaWithMod", {
                  id: client.id,
                  date: format.date(client.createdAt),
                  mod: client.fsGame,
                })
              : t("card.meta", {
                  id: client.id,
                  date: format.date(client.createdAt),
                })}
          </span>
        </div>
        <div className="flex flex-col gap-8 shrink-0">
          <Button size="sm" onClick={onMakeDefault} disabled={isDefault}>
            {isDefault ? t("card.default") : t("card.makeDefault")}
          </Button>
          <div className="flex items-center gap-4">
            <Button
              size="sm"
              variant="ghost"
              icon={<SettingsIcon size={14} />}
              onClick={onEdit}
              aria-label={t("card.settingsOf", { client: client.name })}
              title={t("card.settingsHint")}
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={14} />}
              onClick={onDelete}
              disabled={isRunning || installing}
            >
              {t("card.delete")}
            </Button>
          </div>
        </div>
      </div>

      {legacyNote !== null ? (
        <p className="text-body-sm text-fg-muted">
          {legacyNote.text}
          {legacyNote.action !== null ? (
            <>
              {" "}
              <button
                type="button"
                onClick={onNewClient}
                className="text-fg-accent cursor-pointer hover:underline"
              >
                {legacyNote.action}
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {/* Engine state: install, progress, or launch ---------------------- */}
      {showProgress && install ? (
        <InstallProgressBar progress={install} />
      ) : install?.phase === "error" ? (
        <p className="text-body-sm text-fg-danger break-words">{install.message}</p>
      ) : null}

      {engine && !engine.installable ? (
        <p className="text-body-sm text-fg-muted">
          {engine.notInstallableReason ?? t("card.manualInstall")}
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
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
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
          {t("engine.stop")}
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
              ? t("engine.otherRunning")
              : installed
                ? undefined
                : t("engine.installFirst")
          }
        >
          {t("engine.launch")}
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
            {update.isFetching ? tCommon("states.checking") : t("engine.checkUpdates")}
          </Button>
          {updateAvailable ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={14} />}
              onClick={onInstall}
              disabled={installing || isRunning}
            >
              {update.data?.latest
                ? t("engine.updateTo", { version: update.data.latest })
                : t("engine.updateToNewest")}
            </Button>
          ) : update.data ? (
            <Badge tone="success" icon={<Check size={12} />}>
              {t("engine.upToDate")}
            </Badge>
          ) : null}
          {update.error ? (
            <span className="text-body-sm text-fg-danger">
              {errorText(update.error)}
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
            ? tCommon("states.installing")
            : latestTag
              ? t("engine.installVersion", { version: latestTag })
              : t("engine.install")}
        </Button>
      )}

      {installed && client.engineInstalledAt ? (
        <span className="text-mono-xs text-fg-muted">
          {t("card.installedOn", { date: format.date(client.engineInstalledAt) })}
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
  const format = useFormat();
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
            ? format.bytes(progress.downloaded)
            : `${format.bytes(progress.downloaded)} / ${format.bytes(progress.total)}`}
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
