import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Check,
  Download,
  FolderOpen,
  Gamepad2,
  Package,
  PackagePlus,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { engineUnavailableReason } from "../lib/engines";

// --- slice: bundles ---
import { BundlesTab } from "../components/bundles/BundlesTab";
import { BundleInstallBar } from "../components/bundles/bundleFiles";
import { Tabs } from "../components/servers/Tabs";
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
// --- slice: selection context menu ---
import {
  Badge,
  Button,
  EmptyState,
  useContextMenu,
  type MenuItem,
} from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useEngineNote } from "../i18n/useEngineNote";
import { useFormat } from "../i18n/useFormat";
import {
  clientModes,
  type Client,
  type Engine,
  type EngineInstallProgress,
  type Game,
  type LaunchMode,
  type RunningGame,
} from "../lib/ipc";
// --- slice: bundles ---
import { useBundleInstallOfClient } from "../lib/bundleJobs";
import { CLIENTS_TAB_PARAM, draftRoute } from "../lib/bundleRoutes";
// --- slice: client window ---
import { useOpenClientWindow } from "../lib/clientWindow";
// --- slice: clients page ---
import { engineRoute } from "../lib/engines";
// --- slice: game switch ---
import {
  clientsOfGame,
  // --- slice: selection context menu ---
  defaultClientPatch,
  isGame,
  otherGame,
  resolveDefaultClientId,
  useActiveGame,
  useGameNames,
} from "../lib/game";
import {
  useClientDir,
  useClients,
  // --- slice: bundles ---
  useCreateBundleDraft,
  useDeleteClient,
  useEngineReleases,
  useEnginesOfGame,
  useEngineUpdate,
  useInstallBundle,
  useInstallBundleDraft,
  useInstallEngine,
  useLaunchClient,
  usePendingInstalls,
  useRunningGame,
  useSettings,
  useStopGame,
  // --- slice: selection context menu ---
  useUpdateSettings,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";

// --- slice: bundles ---
type ClientsTab = "clients" | "bundles";

/**
 * One row of the list: a client on its own, or the clients of one bundle
 * under a heading.
 *
 * A group stands where its first client stood, so installing a bundle of
 * three components does not shuffle the rest of the list.
 */
type ClientRow =
  | { kind: "client"; client: Client }
  | { kind: "group"; key: string; name: string; clients: Client[] };

/**
 * Groups the clients that came out of one bundle or one draft.
 *
 * Two or more clients with the same link make a group; a client that is the
 * only one of its bundle stays on its own with its badge, because a heading
 * over one card would say what the badge already says.
 */
export function groupClients(clients: Client[]): ClientRow[] {
  const keyOf = (client: Client): string | null => {
    const link = client.bundle;
    if (!link || link.role !== "installed") return null;
    if (link.bundleId) return `bundle:${link.bundleId}`;
    if (link.draftId) return `draft:${link.draftId}`;
    return null;
  };
  const counts = new Map<string, number>();
  for (const client of clients) {
    const key = keyOf(client);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows: ClientRow[] = [];
  const placed = new Map<string, ClientRow & { kind: "group" }>();
  for (const client of clients) {
    const key = keyOf(client);
    if (key === null || (counts.get(key) ?? 0) < 2) {
      rows.push({ kind: "client", client });
      continue;
    }
    let group = placed.get(key);
    if (group === undefined) {
      group = { kind: "group", key, name: client.bundle?.bundleName ?? "", clients: [] };
      placed.set(key, group);
      rows.push(group);
    }
    group.clients.push(client);
  }
  return rows;
}

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
  // --- slice: bundles ---
  const { t: tBundles } = useTranslation("bundles");
  const navigate = useNavigate();
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
  // --- slice: selection context menu ---
  // **Make default** is a line of the card's context menu and of nothing
  // else: the card itself sends the player to the client window for it.
  const updateSettings = useUpdateSettings();
  const runningGame = useRunningGame();
  // Two sources, because neither covers the whole install on its own: the
  // mutation knows about the call from the click until the core answers, the
  // event knows about the download and the unpacking after that.
  const pendingInstalls = usePendingInstalls();
  const { installs, clearInstall } = useGameEventsContext();
  // --- slice: bundles ---
  // **Create bundle from client** makes a draft with one component read off
  // the client and opens the editor on it.
  const createDraft = useCreateBundleDraft();
  // **Resume install** carries an unfinished bundle install on in the client
  // of the card: the same two calls the bundle dialog and the editor make,
  // told which client to write. Their refusal goes to the bar at the top of
  // the screen, as every other refusal of a card does; the store only keeps
  // the record for the dialog of the bundle.
  const resumeInstall = useInstallBundle();
  const resumeDraftInstall = useInstallBundleDraft();
  // The two mutations serve the whole list, so the card whose press is in
  // flight is the one whose client the call named.
  const isResuming = (client: Client) =>
    [resumeInstall, resumeDraftInstall].some(
      (mutation) =>
        mutation.isPending &&
        Object.values(mutation.variables?.existingClientIds ?? {}).includes(client.id),
    );

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
  // --- slice: bundles ---
  // The tab lives in the route, so `#/clients?tab=bundles` opens on the
  // catalogue and a reload keeps it. Anything but `bundles` is the list.
  const tab: ClientsTab = search.get(CLIENTS_TAB_PARAM) === "bundles" ? "bundles" : "clients";
  const setTab = (next: ClientsTab) =>
    setSearch(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === "bundles") params.set(CLIENTS_TAB_PARAM, next);
        else params.delete(CLIENTS_TAB_PARAM);
        return params;
      },
      { replace: true },
    );
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
  // --- slice: bundles ---
  const rows = groupClients(gameClients);

  const card = (client: Client) => (
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
      onLaunch={(mode) => {
        setError(null);
        launchClient.mutate(
          { clientId: client.id, mode },
          { onError: (e) => setError(errorText(e)) },
        );
      }}
      onNewClient={() => setDialogOpen(true)}
      // --- slice: selection context menu ---
      onMakeDefault={() => {
        setError(null);
        updateSettings.mutate(defaultClientPatch(client), {
          onError: (e) => setError(errorText(e)),
        });
      }}
      onStop={() =>
        stopGame.mutate(undefined, {
          onError: (e) => setError(errorText(e)),
        })
      }
      // --- slice: bundles ---
      onCreateBundle={() => {
        setError(null);
        createDraft.mutate(
          { game: client.game, name: client.name, fromClientId: client.id },
          {
            onSuccess: (draft) => void navigate(draftRoute(draft.id)),
            onError: (e) => setError(errorText(e)),
          },
        );
      }}
      creatingBundle={createDraft.isPending && createDraft.variables?.fromClientId === client.id}
      onResumeInstall={() => {
        const link = client.bundle;
        if (!link) return;
        setError(null);
        const existingClientIds = { [link.componentId]: client.id };
        if (link.bundleId && link.versionId) {
          resumeInstall.mutate(
            {
              bundleId: link.bundleId,
              versionId: link.versionId,
              baseName: client.name,
              componentIds: [link.componentId],
              existingClientIds,
            },
            { onError: (e) => setError(errorText(e)) },
          );
        } else if (link.draftId) {
          resumeDraftInstall.mutate(
            {
              draftId: link.draftId,
              baseName: client.name,
              componentIds: [link.componentId],
              existingClientIds,
            },
            { onError: (e) => setError(errorText(e)) },
          );
        }
      }}
      resuming={isResuming(client)}
    />
  );

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          // --- slice: bundles --- **New client** belongs to the list of
          // clients; the catalogue tab has its own buttons in its bar.
          tab === "clients" ? (
            <Button
              variant="primary"
              icon={<Plus size={16} />}
              onClick={() => setDialogOpen(true)}
            >
              {t("newClient")}
            </Button>
          ) : undefined
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

      {/* --- slice: bundles ---
          Two tabs: the clients of this machine, and the drafts and the
          catalogue of bundles. The strip is the one the Servers screen uses,
          with the count of clients after the first label. */}
      <Tabs<ClientsTab>
        className="mb-16"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "clients", label: tBundles("tabs.clients"), count: gameClients.length },
          { id: "bundles", label: tBundles("tabs.bundles"), title: tBundles("tabs.bundlesHint") },
        ]}
      />

      {tab === "bundles" ? (
        <BundlesTab />
      ) : (
        /* Clients --------------------------------------------------------- */
        <section className="flex flex-col gap-12">
          <h2 className="text-label-xs text-fg-muted">{t("list.heading")}</h2>

          {clients.isLoading ? (
            <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
          ) : gameClients.length > 0 ? (
            // One card per row, the full width of the list. A second column
            // halves the card, and the row of small buttons no longer fits on
            // one line — which is the whole shape of the card.
            //
            // --- slice: bundles ---
            // The clients of one bundle stand together under its name, with
            // the labels of their components: three cards that say «From
            // bundle» on their own do not say they are one thing.
            <ul className="flex flex-col gap-12">
              {rows.map((row) =>
                row.kind === "client" ? (
                  card(row.client)
                ) : (
                  <li key={row.key} className="flex flex-col gap-8">
                    <div className="flex items-center gap-8 pt-4 min-w-0">
                      <Package size={14} className="text-fg-muted shrink-0" aria-hidden />
                      <span className="text-body-sm-medium text-fg-secondary truncate">
                        {tBundles("clientCard.groupHeading", { bundle: row.name })}
                      </span>
                      <span className="text-body-sm text-fg-muted truncate">
                        {row.clients
                          .map((client) => client.bundle?.componentLabel ?? "")
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <ul className="flex flex-col gap-12 border-l-2 border-line-subtle pl-12">
                      {row.clients.map(card)}
                    </ul>
                  </li>
                ),
              )}
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
      )}

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
  /** Starts the client in one of its modes. */
  onLaunch: (mode: LaunchMode) => void;
  onStop: () => void;
  /** Opens the New client dialog, for the way out of a legacy engine. */
  onNewClient: () => void;
  // --- slice: selection context menu ---
  /** Makes this client the one **Play** and **Connect** start. */
  onMakeDefault: () => void;
  // --- slice: bundles ---
  /** Makes a bundle draft out of this client and opens the editor on it. */
  onCreateBundle: () => void;
  /** True while the draft of this client is being made. */
  creatingBundle: boolean;
  /** Carries the unfinished bundle install of this client on, in this client. */
  onResumeInstall: () => void;
  /** True between the press of **Resume install** and the first event of the core. */
  resuming: boolean;
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
 * --- slice: bundles ---
 * A client that also plays single player has a second large button beside
 * **Launch**; a client that plays single player alone has that button in its
 * place. Which of the two a client has comes from its modes.
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
  onMakeDefault,
  onCreateBundle,
  creatingBundle,
  onResumeInstall,
  resuming,
}: ClientCardProps) {
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  // --- slice: bundles ---
  const { t: tBundles } = useTranslation("bundles");
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
  // --- slice: bundles ---
  // The bundle install that holds this client, if one is running: it writes
  // files and the record after the engine phase, and the core holds every
  // client of the install until the last component is done. The engine event
  // above knows nothing of it — the install carries on after the engine is
  // unpacked, and a delete would pull the folder from under the files being
  // written.
  const bundleInstall = useBundleInstallOfClient(client.id);
  const bundleBusy = bundleInstall !== undefined;
  const busyHint = bundleBusy ? tBundles("clientCard.busyInstall") : null;
  // What the buttons go by: the command may be in flight before the first
  // progress event, and both states mean the engine folder is being
  // rewritten. A bundle job holds the client the same way, for longer.
  const installing = showProgress || installPending || bundleBusy;
  const installed = client.engineVersion !== null;
  const isRunning = running?.clientId === client.id;
  const otherIsRunning = running !== null && !isRunning;
  // --- slice: bundles ---
  // The bundle or the draft the client came out of.
  const bundle = client.bundle ?? null;
  // An install the core did not finish: the link is written first with
  // `pending` and rewritten without it last, so after a failure or a
  // restart the card is the one place left to carry on from.
  const pendingInstall = bundle?.role === "installed" && bundle.pending === true;
  // The modes the client starts in: both large buttons, or the single-player
  // one in place of **Launch**.
  const modes = clientModes(client, engine);
  const single = modes.includes("single");
  const multiplayer = modes.includes("multiplayer");

  // `revealItemInDir` and not `openPath`: the permission of the latter is
  // scoped to `$APPLOCALDATA`, and `dataDirOverride` can put the client folder
  // anywhere on the disk. The price is that the file manager opens `clients\`
  // with the folder selected rather than inside it.
  const openFolder = () => {
    if (!isTauri() || clientDir.data === undefined) return;
    void revealItemInDir(clientDir.data).catch(() => undefined);
  };

  // --- slice: selection context menu ---
  // A right click on the card, with the things the card itself offers —
  // its large buttons, its small ones and the badge that says which client
  // is the default. Every line runs the handler of the control it stands
  // for, and a line the card would draw dead is dead here too.
  const menu = useContextMenu<Client>({
    ariaLabel: t("card.actions"),
    items: (): MenuItem[] => [
      // The card swaps its large button by `isRunning`, and the first line
      // swaps with it: **Stop** while the game runs, **Launch** otherwise.
      // Without the swap the line stood dead over a client the player came to
      // stop. The line is not marked `danger`: stopping takes nothing away,
      // and red in this menu belongs to **Delete** alone.
      ...(isRunning
        ? [
            {
              id: "stop",
              label: t("engine.stop"),
              icon: <Square size={14} />,
            },
          ]
        : [
            ...(multiplayer
              ? [
                  {
                    id: "launch",
                    label: t("engine.launch"),
                    icon: <Play size={14} />,
                    disabled: !installed || installing || otherIsRunning,
                  },
                ]
              : []),
            // --- slice: bundles ---
            ...(single
              ? [
                  {
                    id: "single",
                    label: tBundles("clientCard.playSingle"),
                    icon: <Gamepad2 size={14} />,
                    disabled: !installed || installing || otherIsRunning,
                  },
                ]
              : []),
          ]),
      // --- slice: bundles ---
      // The window edits the record a bundle install is writing, so the way
      // to it is dead while one runs. An engine install alone does not close
      // it: the window draws that bar itself and touches no engine file.
      {
        id: "edit",
        label: t("card.settings"),
        icon: <SettingsIcon size={14} />,
        disabled: bundleBusy,
      },
      // The same line as the **Create bundle from client** button of the row.
      // Dead while the engine is being rewritten, because the draft reads
      // that folder, and while a bundle job holds the client.
      {
        id: "bundle",
        label: tBundles("clientCard.createBundleMenu"),
        icon: <PackagePlus size={14} />,
        disabled: !installed || installing || creatingBundle,
      },
      {
        id: "folder",
        label: t("card.openFolder"),
        icon: <FolderOpen size={14} />,
        disabled: clientDir.data === undefined,
      },
      {
        id: "default",
        label: t("card.makeDefault"),
        icon: <Check size={14} />,
        disabled: isDefault,
      },
      {
        id: "delete",
        label: t("card.delete"),
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: isRunning || installing,
      },
    ],
    onSelect: (id) => {
      if (id === "launch") onLaunch("multiplayer");
      else if (id === "single") onLaunch("single");
      else if (id === "stop") onStop();
      else if (id === "edit") onEdit();
      else if (id === "bundle") onCreateBundle();
      else if (id === "folder") openFolder();
      else if (id === "default") onMakeDefault();
      else onDelete();
    },
  });

  const launchDisabled = !installed || installing || otherIsRunning;
  const launchTitle = otherIsRunning
    ? t("engine.otherRunning")
    : busyHint !== null
      ? busyHint
      : installed
        ? undefined
        : t("engine.installFirst");

  return (
    // One row of three parts: the mark, everything the card says, and the one
    // button the player came to press. Nothing is stacked under the row, so
    // **Launch** sits against the middle of the card at any height.
    <li
      className="flex items-center gap-12 rounded-lg border border-line bg-surface p-16"
      // --- slice: selection context menu ---
      onContextMenu={(event) => menu.open(event, client)}
    >
      {menu.menu}
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
          {/* --- slice: bundles --- where the client came from. The name of
              the bundle, the component and the version are in the tooltip:
              the first line of the card is one line, and a bundle name is as
              long as its author made it. */}
          {bundle ? (
            <Badge
              tone="neutral"
              icon={<Package size={12} />}
              className="shrink-0"
              title={
                bundle.versionLabel
                  ? tBundles("clientCard.linkHint", {
                      bundle: bundle.bundleName,
                      component: bundle.componentLabel,
                      version: bundle.versionLabel,
                    })
                  : tBundles("clientCard.linkHintDraft", {
                      bundle: bundle.bundleName,
                      component: bundle.componentLabel,
                    })
              }
            >
              {bundle.bundleId ? tBundles("clientCard.fromBundle") : tBundles("clientCard.fromDraft")}
            </Badge>
          ) : null}
          {pendingInstall ? (
            <Badge
              tone="warm"
              icon={<AlertTriangle size={12} />}
              className="shrink-0"
              title={tBundles("clientCard.incompleteHint")}
            >
              {tBundles("clientCard.incomplete")}
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
          {!engine?.installable ? (
            <p className="text-body-sm text-fg-muted" title={engine ? (engineUnavailableReason(engine, errorText) ?? undefined) : undefined}>
              {engine ? (engineUnavailableReason(engine, errorText) ?? t("card.manualInstall")) : tCommon("states.loading")}
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
          {/* --- slice: bundles --- dead while a bundle job holds the
              client, for the reason the menu line gives. */}
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            icon={<SettingsIcon size={14} />}
            onClick={onEdit}
            disabled={bundleBusy}
            aria-label={t("card.settingsOf", { client: client.name })}
            title={busyHint ?? t("card.settingsHint")}
          />
          {/* --- slice: bundles --- carries an unfinished install on in this
              same client: the core skips the files already in place. */}
          {pendingInstall ? (
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              icon={<RefreshCw size={14} />}
              onClick={onResumeInstall}
              disabled={isRunning || installing || resuming}
              title={busyHint ?? tBundles("clientCard.resumeHint")}
            >
              {tBundles("clientCard.resume")}
            </Button>
          ) : null}
          {/* --- slice: bundles --- the way to the editor: a draft with this
              client as its one component. Dead until the engine is on disk:
              the draft reads the engine folder for the overlay. */}
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            icon={<PackagePlus size={14} />}
            onClick={onCreateBundle}
            disabled={!installed || installing || creatingBundle}
            title={busyHint ?? tBundles("clientCard.createBundleHint")}
          >
            {creatingBundle ? tCommon("states.creating") : tBundles("clientCard.createBundle")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            icon={<Trash2 size={14} />}
            onClick={onDelete}
            disabled={isRunning || installing}
            title={busyHint ?? undefined}
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
            onClick={openFolder}
            disabled={clientDir.data === undefined}
            title={clientDir.data ?? undefined}
          >
            <span className="truncate">{t("card.openFolder")}</span>
          </Button>
        </div>

        {/* Engine state: the progress of an install, or why it stopped. Under
            the row of buttons, where the button that started it is.
            --- slice: bundles ---
            A bundle install draws the engine bar through its engine phase,
            then its own for the files and the configs, with the component
            the bar is about. It is the bar of the dialog, so the card and the
            dialog say the same file. */}
        {showProgress && install ? (
          <InstallProgressBar progress={install} />
        ) : bundleInstall !== undefined ? (
          <BundleInstallBar
            progress={bundleInstall.progress}
            componentLabel={bundleInstall.componentIds.length > 1 ? bundle?.componentLabel ?? null : null}
          />
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
        <LaunchButtons
          multiplayer={multiplayer}
          single={single}
          disabled={launchDisabled}
          title={launchTitle}
          onLaunch={onLaunch}
        />
      )}
    </li>
  );
}

/**
 * The large button of the card, or two of them.
 *
 * --- slice: bundles ---
 * **Launch** for a multiplayer client, **Play single player** beside it when
 * the client also plays single player, and in its place when the client
 * plays nothing else. The multiplayer button is the primary one; a client
 * with the single-player mode alone gives that mode the primary colour, since
 * it is the one thing the card starts.
 */
function LaunchButtons({
  multiplayer,
  single,
  disabled,
  title,
  onLaunch,
}: {
  multiplayer: boolean;
  single: boolean;
  disabled: boolean;
  title: string | undefined;
  onLaunch: (mode: LaunchMode) => void;
}): ReactNode {
  const { t } = useTranslation("clients");
  const { t: tBundles } = useTranslation("bundles");
  return (
    <div className="flex items-center gap-8 shrink-0">
      {multiplayer ? (
        <Button
          size="lg"
          variant="primary"
          icon={<Play size={16} />}
          className="shrink-0"
          onClick={() => onLaunch("multiplayer")}
          disabled={disabled}
          title={title}
        >
          {t("engine.launch")}
        </Button>
      ) : null}
      {single ? (
        <Button
          size="lg"
          variant={multiplayer ? "secondary" : "primary"}
          icon={<Gamepad2 size={16} />}
          className="shrink-0"
          onClick={() => onLaunch("single")}
          disabled={disabled}
          title={title ?? tBundles("clientCard.playSingleHint")}
        >
          {tBundles("clientCard.playSingle")}
        </Button>
      ) : null}
    </div>
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
  // --- slice: bundles ---
  const { t: tBundles } = useTranslation("bundles");
  const errorText = useErrorText();
  const releases = useEngineReleases(installed ? null : client.engineId);
  const [checkRequested, setCheckRequested] = useState(false);
  // --- slice: bundles ---
  // A bundle that laid files over the engine folder made the build its own:
  // a release update would write over those files, so the card says so and
  // offers no check.
  const customBuild = client.bundle?.engineOverlay === true;
  const update = useEngineUpdate(checkRequested && !customBuild ? client.id : null);

  const check = () => {
    if (checkRequested) void update.refetch();
    else setCheckRequested(true);
  };

  const latestTag = releases.data?.[0]?.tag;
  const updateAvailable = update.data?.updateAvailable === true;

  return (
    <>
      {installed && customBuild ? (
        <Badge
          tone="purple"
          icon={<Wrench size={12} />}
          className="shrink-0"
          title={tBundles("clientCard.customBuildHint")}
        >
          {tBundles("clientCard.customBuild")}
        </Badge>
      ) : installed ? (
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
        <>
          <Button
            size="sm"
            className="shrink-0"
            icon={<Download size={14} />}
            onClick={onInstall}
            disabled={installing || !latestTag}
          >
            {installing
              ? tCommon("states.installing")
              : latestTag
                ? t("engine.installVersion", { version: latestTag })
                : t("engine.install")}
          </Button>
          {releases.error ? (
            <span className="text-body-sm text-fg-danger">{errorText(releases.error)}</span>
          ) : releases.isSuccess && !latestTag ? (
            <span className="text-body-sm text-fg-muted">{t("enginePage.versionsEmpty")}</span>
          ) : null}
        </>
      )}
    </>
  );
}
