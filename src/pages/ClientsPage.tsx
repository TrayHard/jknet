import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Check,
  Download,
  FolderOpen,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

// --- slice: client window ---
import { InstallProgressBar } from "../components/client/InstallProgressBar";
// --- slice: clients page ---
import { DeleteClientDialog } from "../components/DeleteClientDialog";
import { EngineLogo } from "../components/EngineLogo";
import { GameFilesNotice } from "../components/GameFilesNotice";
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
  type Client,
  type Engine,
  type EngineInstallProgress,
  type Game,
  type RunningGame,
} from "../lib/ipc";
// --- slice: client window ---
import { useOpenClientWindow } from "../lib/clientWindow";
// --- slice: clients page ---
import { engineRoute } from "../lib/engines";
// --- slice: game switch ---
import {
  clientsOfGame,
  isGame,
  otherGame,
  resolveDefaultClientId,
  useActiveGame,
  useGameNames,
} from "../lib/game";
import {
  useClientDir,
  useClients,
  useDeleteClient,
  useEngineReleases,
  useEnginesOfGame,
  useEngineUpdate,
  useInstallEngine,
  useLaunchClient,
  usePendingInstalls,
  useRunningGame,
  useSettings,
  useStopGame,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";

/**
 * Clients: the clients of the active game, and nothing else.
 *
 * The game folder is asked for once during the first run and lives on the
 * Settings screen afterwards, so all that is left of it here is the one line
 * that says it is missing — the same notice, and the same button, as on Home.
 * A player whose Launch button does nothing still has somewhere to look.
 *
 * The registry of engines that used to close the screen is gone too. A build
 * has a page of its own at `#/engines/<id>`, which the New client dialog and
 * every client card link to.
 */
export function ClientsPage() {
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const settings = useSettings();
  const clients = useClients();
  // --- slice: game core ---
  const activeGame = useActiveGame();
  // --- slice: game switch ---
  // Everything on this screen is the active game: its clients and the builds
  // that play it. The other game is one press of the switcher away, and the
  // line under the list says how many clients are waiting there.
  const engines = useEnginesOfGame(activeGame);
  const { label: gameName } = useGameNames();
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

  // --- slice: client window ---
  // The gear opens a window of its own now. The dialog it replaced could hold
  // three fields; the window holds everything a client has.
  const openClientWindow = useOpenClientWindow();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // --- slice: clients page ---
  // The client **Delete** was pressed about, until the question is answered.
  // Held here rather than on the card so that the folder the dialog names
  // comes out of the same cached query the card's **Open folder** uses.
  const [pendingDelete, setPendingDelete] = useState<Client | null>(null);
  const pendingDir = useClientDir(pendingDelete?.id ?? null);
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

  // A command that never answered is as much of a failure as one that said
  // no, and outside the Tauri runtime it is the only thing to report.
  const queryError = settings.error ?? clients.error ?? null;
  const failure = error ?? (queryError ? errorText(queryError) : null);

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

      {/* The folder of the game is a Settings row and a first-run step, not a
          card of this screen. What stays here is the one line that says it is
          missing — without it a player whose Launch button does nothing has
          nowhere to look. The same notice, the same button, as on Home. */}
      <GameFilesNotice className="mb-24" />

      {/* Clients --------------------------------------------------------- */}
      <section className="flex flex-col gap-12">
        <h2 className="text-label-xs text-fg-muted">{t("list.heading")}</h2>

        {clients.isLoading ? (
          <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
        ) : gameClients.length > 0 ? (
          // One card per row, the full width of the list. A second column
          // halves the card, and the row of small buttons no longer fits on
          // one line — which is the whole shape of the card.
          <ul className="flex flex-col gap-12">
            {gameClients.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                engine={engines.find((engine) => engine.id === client.engineId)}
                isDefault={client.id === defaultClientId}
                install={installs[client.id]}
                installPending={pendingInstalls.includes(client.id)}
                running={runningGame.data ?? null}
                onEdit={() => {
                  setError(null);
                  openClientWindow(client.id).catch((e: unknown) =>
                    setError(errorText(e)),
                  );
                }}
                onDelete={() => {
                  setError(null);
                  setPendingDelete(client);
                }}
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

      {/* --- slice: clients page --- */}
      {pendingDelete !== null ? (
        <DeleteClientDialog
          client={pendingDelete}
          engineName={
            pendingDelete.engineVersion === null
              ? null
              : (engines.find((engine) => engine.id === pendingDelete.engineId)
                  ?.name ?? pendingDelete.engineId)
          }
          folder={pendingDir.data ?? null}
          busy={deleteClient.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() =>
            deleteClient.mutate(pendingDelete.id, {
              onError: (e) => setError(errorText(e)),
              // Closed either way: the card is gone on success, and on a
              // failure the bar at the top of the screen carries the reason.
              onSettled: () => setPendingDelete(null),
            })
          }
        />
      ) : null}
    </Page>
  );
}

// --- slice: i18n ---
// `sourceName` is gone: the four detection sources are `games.sources.*` in the
// catalogs, and both this screen and the first run read them from there.

/**
 * What joins the facts on the second line of a card.
 *
 * Punctuation in the code, not a word in a catalog: the parts around it are
 * whole messages of their own, which is the same arrangement the subtitle of
 * the Servers screen uses.
 */
const DOT = "·";

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
  onEdit: () => void;
  onDelete: () => void;
  onInstall: () => void;
  onLaunch: () => void;
  onStop: () => void;
  /** Opens the New client dialog, for the way out of a legacy engine. */
  onNewClient: () => void;
}

/**
 * One client, as the design's «Regular ETJK» card has it.
 *
 * One row across the full width of the list: the mark of the build on the
 * left, one large **Launch** on the right, and between them three lines — the
 * name with its badges, the build and the date, and the row of small buttons.
 * Everything else — the update check, the settings window, **Delete**, the
 * folder — is one of those small buttons, so the card has exactly one thing
 * that looks like the thing a player came to press.
 *
 * The row of buttons never wraps, and the list never puts two cards side by
 * side. Both rules hold the shape: a half-width card breaks the row of buttons
 * into two lines, and the card stops reading as one row.
 *
 * **Make default** is not here any more. It is a property of the client and
 * lives in the client's own window, next to its name and its mod folder; the
 * badge on this card is what says where it went.
 */
function ClientCard({
  client,
  engine,
  isDefault,
  install,
  installPending,
  running,
  onEdit,
  onDelete,
  onInstall,
  onLaunch,
  onStop,
  onNewClient,
}: ClientCardProps) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const format = useFormat();
  const engineNote = useEngineNote();
  // Asked for every card rather than on the click: the command reads one small
  // file, and a button that has to wait for an answer before it can open a
  // folder feels like a button that did not work.
  const clientDir = useClientDir(client.id);
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
    // One row of three parts: the mark, everything the card says, and the one
    // button the player came to press. Nothing is stacked under the row, so
    // **Launch** sits against the middle of the card at any height.
    <li className="flex items-center gap-12 rounded-lg border border-line bg-surface p-16">
      <EngineLogo engineId={client.engineId} name={engineName} size={44} />
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="flex items-center gap-8">
          <span className="text-heading-sm text-fg truncate">{client.name}</span>
          {isDefault ? (
            <Badge tone="accent" className="shrink-0">
              {t("card.default")}
            </Badge>
          ) : null}
          {isRunning ? (
            <Badge tone="success" className="shrink-0">
              {t("card.running")}
            </Badge>
          ) : null}
        </div>
        {/* Four facts joined with a middle dot, the way the Servers subtitle
            is: each is a finished message of its own, and the dot is
            punctuation in the code rather than a word to translate. The id
            of the client is not among them — it is a folder name, the player
            never types it, and the client window says it where it matters.
            One line, never two: a long build name gives up its tail so that
            the date and the mod folder keep their place. */}
        <p className="flex items-center gap-6 overflow-hidden text-body-sm text-fg-muted">
          <Link
            to={engineRoute(client.engineId)}
            title={t("card.engineDetails", { engine: engineName })}
            className="truncate text-fg-secondary hover:text-fg-accent hover:underline"
          >
            {engineName}
          </Link>
          {installed ? (
            <span className="text-mono-xs shrink-0">{client.engineVersion}</span>
          ) : (
            <span className="text-fg-warm shrink-0">{t("card.engineNotInstalled")}</span>
          )}
          <span aria-hidden="true" className="shrink-0">
            {DOT}
          </span>
          <span className="shrink-0">
            {t("card.created", { date: format.date(client.createdAt) })}
          </span>
          {client.fsGame ? (
            <>
              <span aria-hidden="true" className="shrink-0">
                {DOT}
              </span>
              <span className="text-mono-xs truncate">
                {t("card.modFolder", { mod: client.fsGame })}
              </span>
            </>
          ) : null}
        </p>

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

        {/* One row of small buttons, never two, in the order a player reaches
            for them: what the build is doing, what the client is set to, the
            one that destroys it, and the way to its files. `overflow-hidden`
            keeps a row too wide for the card — a long locale on the minimum
            window of 1100 px — inside it instead of spilling under Launch. */}
        <div className="flex items-center gap-8 flex-nowrap pt-4 min-w-0 overflow-hidden">
          {engine && !engine.installable ? (
            <p className="text-body-sm text-fg-muted truncate">
              {engine.notInstallableReason ?? t("card.manualInstall")}
            </p>
          ) : (
            <EngineControls
              client={client}
              installed={installed}
              installing={installing}
              isRunning={isRunning}
              onInstall={onInstall}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            icon={<SettingsIcon size={14} />}
            onClick={onEdit}
            aria-label={t("card.settingsOf", { client: client.name })}
            title={t("card.settingsHint")}
          />
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            icon={<Trash2 size={14} />}
            onClick={onDelete}
            disabled={isRunning || installing}
          >
            {t("card.delete")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            // The only button of the row allowed to shrink: it sits at the
            // periphery, so a row short of space clips this label instead of
            // pushing the whole tail of the row out of the card.
            className="min-w-0"
            icon={<FolderOpen size={14} className="shrink-0" />}
            // `revealItemInDir` and not `openPath`: the permission of the
            // latter is scoped to `$APPLOCALDATA`, and `dataDirOverride` can
            // put the client folder anywhere on the disk. The price is that
            // the file manager opens `clients\` with the folder selected
            // rather than inside it.
            onClick={() => {
              if (!isTauri() || clientDir.data === undefined) return;
              void revealItemInDir(clientDir.data).catch(() => undefined);
            }}
            disabled={clientDir.data === undefined}
            title={clientDir.data ?? undefined}
          >
            <span className="truncate">{t("card.openFolder")}</span>
          </Button>
        </div>

        {/* Engine state: the progress of an install, or why it stopped. Under
            the row of buttons, where the button that started it is. */}
        {showProgress && install ? (
          <InstallProgressBar progress={install} />
        ) : install?.phase === "error" ? (
          <p className="text-body-sm text-fg-danger break-words">{install.message}</p>
        ) : null}
        {clientDir.error ? (
          <p className="text-body-sm text-fg-danger">{errorText(clientDir.error)}</p>
        ) : null}
      </div>
      {isRunning ? (
        <Button
          size="lg"
          variant="danger"
          icon={<Square size={16} />}
          className="shrink-0"
          onClick={onStop}
        >
          {t("engine.stop")}
        </Button>
      ) : (
        <Button
          size="lg"
          variant="primary"
          icon={<Play size={16} />}
          className="shrink-0"
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
    </li>
  );
}

interface EngineControlsProps {
  client: Client;
  installed: boolean;
  installing: boolean;
  isRunning: boolean;
  onInstall: () => void;
}

/**
 * What the card says about the engine build itself.
 *
 * **Launch** lives on the right of the card, where it is the one large button.
 * What is left here is the update check and the install, which are about the
 * files under the client rather than about starting a game.
 *
 * The update check is a button, not a page load: it costs a request to GitHub,
 * and a player who opens the screen to rename a client has not asked for one.
 * The release list behind **Install engine** is different — without it the
 * button cannot say which version it is about to fetch.
 *
 * The date the build was installed on is not here. It is a fact about the
 * engine folder, not about a button, and the engine block of the client window
 * says it where the rest of the build's facts are.
 */
function EngineControls({
  client,
  installed,
  installing,
  isRunning,
  onInstall,
}: EngineControlsProps) {
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
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
    <>
      {installed ? (
        <>
          <Button
            size="sm"
            className="shrink-0"
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
              className="shrink-0"
              icon={<Download size={14} />}
              onClick={onInstall}
              disabled={installing || isRunning}
            >
              {update.data?.latest
                ? t("engine.updateTo", { version: update.data.latest })
                : t("engine.updateToNewest")}
            </Button>
          ) : update.data ? (
            <Badge tone="success" icon={<Check size={12} />} className="shrink-0">
              {t("engine.upToDate")}
            </Badge>
          ) : null}
          {/* Truncated rather than wrapped: the row of buttons is one line,
              and the whole reason lives in the tooltip. */}
          {update.error ? (
            <span
              className="text-body-sm text-fg-danger truncate"
              title={errorText(update.error)}
            >
              {errorText(update.error)}
            </span>
          ) : null}
        </>
      ) : (
        <Button
          size="sm"
          className="shrink-0"
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
    </>
  );
}
