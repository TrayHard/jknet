import { AlertTriangle, Play, Plus, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

// --- slice: home client block ---
import { EngineLogo } from "../components/EngineLogo";
import { GameFilesNotice } from "../components/GameFilesNotice";
import { MapPreview } from "../components/MapPreview";
// --- slice: server actions ---
import { useMissingClientToast } from "../components/MissingClientToast";
import { NewClientDialog } from "../components/NewClientDialog";
// --- slice: home client block ---
import { OtherClientsMenu } from "../components/OtherClientsMenu";
import { Page, PageHeader } from "../components/PageHeader";
import { realPlayers, visibleServers } from "../components/servers/filter";
import { ServerListBlock } from "../components/servers/ServerListBlock";
import { ServerMenu } from "../components/servers/ServerMenu";
import { TopServers } from "../components/servers/TopServers";
import { Badge, Button } from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
import { cn } from "../lib/format";
// --- slice: game switch ---
import {
  clientsOfGame,
  useActiveGame,
  useConnectClient,
  useDefaultClient,
  useGameNames,
} from "../lib/game";
import type { Client, Game, ServerInfo } from "../lib/ipc";
import {
  useAddServerHistory,
  useCachedServers,
  useClients,
  useEnginesOfGame,
  useLaunchClient,
  useRunningGame,
  useServerRefresh,
  useSettings,
  useStopGame,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";

/**
 * How many rows the Favorites and History blocks show.
 *
 * Home is a shortcut, not a second server browser: past five rows the player
 * is better served by the Servers screen, where the list can be searched and
 * sorted.
 */
const BLOCK_COUNT = 5;

/**
 * Home: one hero block with the Play button, then the server shortcuts.
 *
 * Play starts the default client. While the game runs the hero says so and
 * offers Stop instead, because the launcher may be hidden and come back to a
 * game the player forgot about.
 */
export function HomePage() {
  const { t } = useTranslation("home");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const settings = useSettings();
  const clients = useClients();
  const launchClient = useLaunchClient();
  const addHistory = useAddServerHistory();
  const stopGame = useStopGame();
  const runningGame = useRunningGame();

  const [error, setError] = useState<string | null>(null);
  // --- slice: game switch ---
  const [newClientOpen, setNewClientOpen] = useState(false);

  // --- slice: game switch ---
  // The hero belongs to the game the switcher is on. A player who owns both
  // games has two Play buttons, one behind each segment, and the one on screen
  // is the one that can reach the servers listed under it.
  const activeGame = useActiveGame();
  const { label: gameName } = useGameNames();
  const defaultClient = useDefaultClient();
  // --- slice: server actions ---
  // Connect is a quick connect: the client the player reached that very server
  // with, and the default client only when there is no such record.
  const connectClient = useConnectClient();
  const missingClientToast = useMissingClientToast();
  // --- slice: server actions --- «2 h ago» under a row of the History block.
  const format = useFormat();
  // Home draws server rows from the cache alone: no refresh of its own, no
  // command of its own. Both pools below are the cached list read two ways.
  const cachedServers = useCachedServers();
  // --- slice: servers robustness ---
  // The one thing Home does ask the network for, once, and only when the cache
  // has nothing in it: see `useFirstServerList`. The hook also puts this screen
  // on the `servers:batch` events, which is what fills the blocks below while
  // that scan runs instead of after the player walks to Servers and back.
  const servers = useServerRefresh();

  /** Starred servers, the busiest first. */
  const favorites = useMemo(
    () =>
      // --- slice: server actions --- a hidden row is off Home as it is off
      // every tab of the browser but the one that undoes it.
      visibleServers(cachedServers.data ?? [])
        .filter((row) => row.favorite)
        .sort((a, b) => realPlayers(b) - realPlayers(a))
        .slice(0, BLOCK_COUNT),
    [cachedServers.data],
  );

  /**
   * Where the player has been, newest first.
   *
   * The order is the history's, not the players': this block answers «take me
   * back», and the answer is the server, not its population. An address the
   * browser has no row for is skipped rather than drawn half empty — the row
   * needs a map, a mode and a ping, and history stores none of that.
   *
   * --- slice: game switch ---
   * The cached list holds one game, so matching against it also drops the
   * Jedi Outcast entries from the Jedi Academy screen and back.
   */
  const history = useMemo(() => {
    const rows = visibleServers(cachedServers.data ?? []);
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    const picked: ServerInfo[] = [];
    // --- slice: server actions ---
    // When the player was last on each of them, kept beside the rows rather
    // than folded into them: a row is a `ServerInfo`, and the last time this
    // player was somewhere is not something a server publishes.
    const at = new Map<string, string>();
    for (const entry of settings.data?.serverHistory ?? []) {
      const row = byAddress.get(entry.address);
      if (row !== undefined) {
        picked.push(row);
        at.set(row.address, entry.lastConnected);
      }
      if (picked.length === BLOCK_COUNT) break;
    }
    return { rows: picked, at };
  }, [cachedServers.data, settings.data?.serverHistory]);

  // --- slice: maps ---
  // The server Connect was last pressed on, when the browser still has that
  // row: the head of the history block, by the same rule. Written out because
  // an index into an empty array is `undefined` and the type does not say so.
  const lastServer: ServerInfo | undefined = history.rows[0];
  const running = runningGame.data ?? null;
  const runningClient = clients.data?.find((client) => client.id === running?.clientId);
  const canPlay =
    defaultClient !== undefined && running === null && !launchClient.isPending;

  // --- slice: home client block ---
  // The registry name of an engine, the way a client card of the Clients
  // screen prints it: «EternalJK», not `eternaljk`. The id is the fallback, and
  // it is the whole answer for a client built on a build the registry dropped.
  const engines = useEnginesOfGame(activeGame);
  const engineName = (engineId: string) =>
    engines.find((engine) => engine.id === engineId)?.name ?? engineId;

  /**
   * The client the hero's own buttons already start.
   *
   * **Play** starts the default client, and while a game is up the hero names
   * the client that is running. Everything else of this game is what the menu
   * offers, so a line of the menu is never the button standing beside it.
   */
  const heroClient = running !== null ? runningClient : defaultClient;
  const otherClients = clientsOfGame(clients.data, activeGame).filter(
    (client) => client.id !== heroClient?.id,
  );

  /**
   * Which of the hero's ways in the player took, while it is starting.
   *
   * Connect, Play and every line of the **Other clients…** menu share one
   * mutation, so `isPending` alone cannot tell them apart, and the launch in
   * flight would put «Starting…» on whichever button the code asked first. The
   * arguments say it instead: only Connect passes an address, and only Play
   * passes the default client. Every button still goes inactive together — the
   * client starts once.
   */
  const startingConnect =
    launchClient.isPending && launchClient.variables?.connect !== undefined;
  const startingPlay =
    launchClient.isPending &&
    launchClient.variables?.connect === undefined &&
    launchClient.variables?.clientId === defaultClient?.id;

  /**
   * The server the hero offers to go back to, or nothing.
   *
   * It takes a client to connect, so a player who has none keeps the hero that
   * offers to make one. A running game keeps its own hero: the question there
   * is how long it has been up, not where to go next.
   */
  const continueServer =
    running === null && defaultClient !== undefined ? lastServer : undefined;

  // --- slice: server actions ---
  // The client that hero's Connect actually starts, which is what the line
  // under it names. Defined whenever `continueServer` is: the rule falls back
  // to the default client, and the hero is Continue only while there is one.
  const continueClient =
    continueServer === undefined ? undefined : connectClient(continueServer.address);

  /**
   * The server whose map the hero draws, or nothing.
   *
   * Either the hero names that server — Continue — or a game is running and
   * the picture is where the player just was. A hero that says «Quick play»
   * shows no map: an unnamed screenshot of somebody's server is the very
   * thing that made the old block unreadable.
   */
  const heroServer = running !== null ? lastServer : continueServer;

  // --- slice: servers robustness ---
  // The one exception to «nothing refreshes by itself»: a cache with no rows
  // in it at all. See `useFirstServerList`.
  useFirstServerList(activeGame, cachedServers, servers.getNewList);

  // --- slice: home client block ---
  /**
   * Starts one client, with no server behind it.
   *
   * One function for **Play** and for every line of the **Other clients…**
   * menu: a client started from the menu has to arrive in the game exactly
   * where **Play** arrives — on the client's own menu, without `+connect` —
   * and two call sites of the same mutation would be two places for that to
   * drift. Joining a server with another client is a different question, and
   * the **Connect…** dialog is where it is asked.
   */
  const launch = (client: Client) => {
    if (running !== null || launchClient.isPending) return;
    setError(null);
    launchClient.mutate(
      { clientId: client.id },
      { onError: (e) => setError(errorText(e)) },
    );
  };

  const play = () => {
    if (!defaultClient) return;
    launch(defaultClient);
  };

  /**
   * Starts a client on one server.
   *
   * The same two steps as **Connect** on the Servers screen, in the same
   * order: the address is recorded first and on its own, so the row keeps its
   * place in the history even when the launch fails on a missing engine. The
   * entry carries the client, so the next press reaches the same one.
   */
  const connect = (server: ServerInfo) => {
    const client = connectClient(server.address);
    // --- slice: server actions ---
    // A row of this game with no client of this game: the press was reasonable
    // and the answer is the step that fixes it, the same toast the Servers
    // screen shows.
    if (!client) {
      missingClientToast(activeGame);
      return;
    }
    if (launchClient.isPending) return;
    setError(null);
    addHistory.mutate({ address: server.address, clientId: client.id });
    launchClient.mutate(
      { clientId: client.id, connect: server.address },
      { onError: (e) => setError(errorText(e)) },
    );
  };

  // --- slice: server actions ---
  /**
   * Connect and the menu, drawn on every row of all three blocks.
   *
   * They are the row's only press targets, so a player who can see a server
   * can join it or star it from where they are. A server that did not answer
   * the last scan keeps both, exactly as the details panel does: the press is
   * how a player finds out whether it is back.
   */
  const rowActions = (server: ServerInfo) => (
    <>
      <Button
        size="sm"
        variant="primary"
        icon={<Zap size={14} />}
        disabled={running !== null || launchClient.isPending}
        onClick={() => connect(server)}
      >
        {startingConnect && launchClient.variables?.connect === server.address
          ? tCommon("states.starting")
          : t("topServers.connect")}
      </Button>
      <ServerMenu server={server} size="sm" />
    </>
  );

  // --- slice: servers home tweaks ---
  /**
   * Opens one server on the Servers screen, with its details panel showing.
   *
   * Home tells the player where they can go; who is on that server, on what
   * map and how the last scan found it is the panel's answer, and walking to
   * the browser to find the row by hand was the step between the two. The
   * address travels in the query string rather than in the navigation state,
   * because `HashRouter` keeps `#/servers?select=…` across a window reload
   * while state does not survive one.
   */
  const openOnServers = (server: ServerInfo) => {
    void navigate(`/servers?select=${encodeURIComponent(server.address)}`);
  };

  // --- slice: server actions ---
  /**
   * How long ago the player was last on one server of the History block.
   *
   * The block answers «take me back», and «yesterday» is half of that answer:
   * a server the player left ten minutes ago and one they played on in March
   * are two different offers, and the order alone does not say which is which.
   *
   * `null` for a row with no entry and for a timestamp that does not parse: a
   * caption cannot say «some unknown time ago», so the row goes without one
   * rather than with a wrong one.
   */
  const lastConnected = (server: ServerInfo) => {
    const at = history.at.get(server.address);
    if (at === undefined) return null;
    const when = Date.parse(at);
    if (Number.isNaN(when)) return null;
    return t("topServers.lastConnected", {
      age: format.age(Math.max(0, Math.floor((Date.now() - when) / 1_000))),
    });
  };

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { game: gameName(activeGame) })}
      />

      {/* --- slice: game switch --- a game with no folder is a setup step, not
          a failure: the notice says where to point the launcher and the rest of
          the screen keeps working. */}
      <GameFilesNotice className="mb-16" />

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">
            <Trans
              t={t}
              i18nKey="launchError"
              values={{ message: error }}
              components={[
                <Link to="/clients" className="text-fg-accent underline" />,
              ]}
            />
          </span>
        </div>
      ) : null}

      <section className="relative overflow-hidden rounded-xl border border-line bg-surface p-32 shadow-card">
        <div
          aria-hidden="true"
          className="absolute -top-40 -right-24 size-240 rounded-full bg-accent-glow blur-3xl"
        />
        <div className="relative flex items-start gap-24">
          <div className="flex flex-col gap-24 flex-1 min-w-0">
            {/* The label says what the hero is showing. Three answers, and
                every one of them names the thing under it: the game that is
                running, the server to go back to, or the client that Play
                starts. «Quick play» over the picture of somebody's server was
                none of the three. */}
            <div className="flex flex-col gap-8">
              <span className="text-label-xs text-fg-muted">
                {running
                  ? t("hero.inGame")
                  : continueServer
                    ? t("hero.continue")
                    : t("hero.quickPlay")}
              </span>
              <h2
                className={cn(
                  "text-display-xl text-fg",
                  // A server name is data and can run to 64 characters, where
                  // a client name is something the player typed. Only the
                  // first needs cutting off.
                  continueServer !== undefined && "truncate",
                )}
              >
                {running
                  ? t("hero.running", {
                      client: runningClient?.name ?? running.clientId,
                    })
                  : continueServer
                    ? // The plain name, not the coloured one: at display size
                      // the `^1` palette of a server name fights the picture
                      // beside it, and the row blocks below already show the
                      // colours the operator chose.
                      (continueServer.hostnameClean || continueServer.address)
                    : (defaultClient?.name ??
                      t("hero.noClient", { game: gameName(activeGame) }))}
              </h2>
              {/* --- slice: home client block ---
                  The engine of the client the heading names, under the name
                  and with the engine's own mark. It is the one fact that
                  separates two clients of the same player, and it belongs to
                  the name rather than to the row of buttons, where it used to
                  stand. Only the Quick play hero carries it: the Continue
                  heading is a server name, and a badge under it would name the
                  engine of a client the heading does not mention. */}
              {!running && continueServer === undefined && defaultClient ? (
                <Badge
                  tone="accent"
                  className="self-start"
                  icon={
                    <EngineLogo
                      engineId={defaultClient.engineId}
                      name={engineName(defaultClient.engineId)}
                      size={14}
                    />
                  }
                >
                  {engineName(defaultClient.engineId)}
                </Badge>
              ) : null}
              {/* The line under the heading answers «what is this», and the
                  Quick play hero has no question left: the heading is the
                  client, the badge is its engine and the button says Play.
                  The two states that do keep a line say something the block
                  cannot show — how long the game has been up, and what the two
                  buttons of the Continue hero each do. */}
              {running || (continueServer && continueClient) ? (
                <p className="text-body-md text-fg-secondary max-w-[560px]">
                  {running ? (
                    <RunningLine startedAt={running.startedAt} pid={running.pid} />
                  ) : (
                    t("hero.continueText", { client: continueClient?.name })
                  )}
                </p>
              ) : null}
            </div>

            {/* --- slice: i18n --- the row wraps: «Create a Jedi Outcast
                client» beside «Other clients…» already fills the hero at the
                1100 px minimum, and a language a third longer would be clipped
                by the hero's own `overflow-hidden`. */}
            <div className="flex flex-wrap items-center gap-12">
              {!running && defaultClient === undefined ? (
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Plus size={20} />}
                  onClick={() => setNewClientOpen(true)}
                >
                  {t("hero.createClient", { game: gameName(activeGame) })}
                </Button>
              ) : running ? (
                <Button
                  variant="danger"
                  size="lg"
                  icon={<Square size={20} />}
                  onClick={() =>
                    stopGame.mutate(undefined, {
                      onError: (e) => setError(errorText(e)),
                    })
                  }
                >
                  {t("hero.stop")}
                </Button>
              ) : (
                <>
                  {/* Two ways in, and the hero says which is which. Connect
                      goes back to the last server, Play opens the client on
                      its own menu — the press Home has always answered. */}
                  {continueServer ? (
                    <Button
                      variant="primary"
                      size="lg"
                      icon={<Zap size={20} />}
                      disabled={!canPlay}
                      onClick={() => connect(continueServer)}
                    >
                      {startingConnect
                        ? tCommon("states.starting")
                        : t("hero.connect")}
                    </Button>
                  ) : null}
                  <Button
                    variant={continueServer ? "secondary" : "primary"}
                    size="lg"
                    icon={<Play size={20} />}
                    disabled={!canPlay}
                    onClick={play}
                    title={defaultClient ? undefined : t("hero.playHint")}
                  >
                    {startingPlay ? tCommon("states.starting") : t("hero.play")}
                  </Button>
                </>
              )}
              {/* --- slice: home client block ---
                  The other clients of this game, each one press from the
                  hero. The button used to lead to the Clients screen and
                  nothing else; the screen is still a line of the menu away,
                  and the walk there is no longer the price of starting the
                  second client. */}
              <OtherClientsMenu
                clients={otherClients}
                engineName={engineName}
                onLaunch={launch}
                onNewClient={() => void navigate("/clients")}
                launchDisabled={running !== null || launchClient.isPending}
              />
            </div>
          </div>

          {/* --- slice: maps ---
              The caption says what the picture is. Under the Continue hero the
              heading is already the server name, so the band carries «Last
              server» instead of repeating it; in every other state the name is
              what tells the player whose map this is. */}
          {heroServer ? (
            <MapPreview
              map={heroServer.map}
              game={heroServer.game}
              serverName={
                continueServer ? t("hero.lastServer") : heroServer.hostnameClean
              }
              className="w-240 h-140 shrink-0"
            />
          ) : null}
        </div>
      </section>

      {/* The player's own servers come before the crowd's: Favorites is a list
          they built by hand, History is where they actually played, and
          «Busiest» is a suggestion from people they have never met. Each block
          hides when it has no rows, so a player with neither favourites nor
          history keeps the screen they had before. */}
      <div className="flex flex-col gap-24 pt-24">
        <ServerListBlock
          title={t("topServers.favorites")}
          servers={favorites}
          actions={rowActions}
          onOpen={openOnServers}
        />
        <ServerListBlock
          title={t("topServers.history")}
          servers={history.rows}
          actions={rowActions}
          caption={lastConnected}
          onOpen={openOnServers}
        />
        <TopServers actions={rowActions} onOpen={openOnServers} />
      </div>

      {/* --- slice: game switch --- the dialog already opens on the active
          game, so the button above needs to do nothing but open it. */}
      {newClientOpen ? (
        <NewClientDialog
          onClose={() => setNewClientOpen(false)}
          onError={setError}
        />
      ) : null}
    </Page>
  );
}

/**
 * The line under the hero while a game runs: how long, and which process.
 *
 * The core reports only the start time, so the clock belongs to the screen that
 * draws it rather than to a command that would have to be polled. The whole
 * sentence is one message with the clock in a slot: the words around a duration
 * change with the language, and «Запущено 3 мин назад» puts them on both sides.
 */
// --- slice: servers robustness ---
/**
 * Asks the master servers once, and only when there is nothing to show.
 *
 * The launcher does not refresh the server list by itself — one scan is around
 * 230 datagrams and two to four seconds, and doing that behind the player at
 * every screen they open is what the rule in the architecture document
 * forbids. An empty cache is the one case the rule does not cover: there is
 * nothing to protect, the Servers screen would open on a blank table, and the
 * player who just finished the first run has no reason to know a button has to
 * be pressed before the launcher knows about any servers.
 *
 * Once means once. The ref remembers the games already asked for the life of
 * this screen, and the core refuses a second scan of a scope it is already
 * running, so neither a re-render nor a walk back to Home starts another one.
 * A cache with a single row in it starts nothing at all.
 */
function useFirstServerList(
  game: Game,
  cached: ReturnType<typeof useCachedServers>,
  getNewList: () => void,
) {
  const asked = useRef<Set<Game>>(new Set());

  useEffect(() => {
    if (!isTauri()) return;
    // Not `data === undefined`: a cache that is still being read is not an
    // empty one, and a read that failed is a reason to show the error rather
    // than to put two hundred datagrams on the wire.
    if (!cached.isSuccess || cached.data.length > 0) return;
    if (asked.current.has(game)) return;
    asked.current.add(game);
    getNewList();
  }, [game, cached.isSuccess, cached.data, getNewList]);
}

function RunningLine({ startedAt, pid }: { startedAt: string; pid: number }) {
  const { t } = useTranslation("home");
  const format = useFormat();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const started = Date.parse(startedAt);
  const age = Number.isNaN(started)
    ? t("hero.aMoment")
    : format.elapsed(Math.max(0, Math.floor((now - started) / 1000)));

  return (
    <Trans
      t={t}
      i18nKey="hero.runningText"
      values={{ age, pid }}
      components={[<span className="text-mono-sm text-fg-accent" />]}
    />
  );
}
