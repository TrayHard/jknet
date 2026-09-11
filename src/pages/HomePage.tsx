import { AlertTriangle, Play, Plus, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { GameFilesNotice } from "../components/GameFilesNotice";
import { MapPreview } from "../components/MapPreview";
import { NewClientDialog } from "../components/NewClientDialog";
import { Page, PageHeader } from "../components/PageHeader";
import { realPlayers } from "../components/servers/filter";
import { ServerListBlock } from "../components/servers/ServerListBlock";
import { TopServers } from "../components/servers/TopServers";
import { Badge, Button } from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
import { cn } from "../lib/format";
// --- slice: game switch ---
import { useActiveGame, useDefaultClient, useGameNames } from "../lib/game";
import type { ServerInfo } from "../lib/ipc";
import {
  useAddServerHistory,
  useCachedServers,
  useClients,
  useLaunchClient,
  useRunningGame,
  useSettings,
  useStopGame,
} from "../lib/queries";

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
  // Home draws server rows from the cache alone: no refresh of its own, no
  // command of its own. Both pools below are the cached list read two ways.
  const cachedServers = useCachedServers();

  /** Starred servers, the busiest first. */
  const favorites = useMemo(
    () =>
      (cachedServers.data ?? [])
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
    const rows = cachedServers.data ?? [];
    if (rows.length === 0) return [];
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    const picked: ServerInfo[] = [];
    for (const entry of settings.data?.serverHistory ?? []) {
      const row = byAddress.get(entry.address);
      if (row !== undefined) picked.push(row);
      if (picked.length === BLOCK_COUNT) break;
    }
    return picked;
  }, [cachedServers.data, settings.data?.serverHistory]);

  // --- slice: maps ---
  // The server Connect was last pressed on, when the browser still has that
  // row: the head of the history block, by the same rule. Written out because
  // an index into an empty array is `undefined` and the type does not say so.
  const lastServer: ServerInfo | undefined = history[0];
  const running = runningGame.data ?? null;
  const runningClient = clients.data?.find((client) => client.id === running?.clientId);
  const canPlay =
    defaultClient !== undefined && running === null && !launchClient.isPending;

  /**
   * The server the hero offers to go back to, or nothing.
   *
   * It takes a client to connect, so a player who has none keeps the hero that
   * offers to make one. A running game keeps its own hero: the question there
   * is how long it has been up, not where to go next.
   */
  const continueServer =
    running === null && defaultClient !== undefined ? lastServer : undefined;

  /**
   * The server whose map the hero draws, or nothing.
   *
   * Either the hero names that server — Continue — or a game is running and
   * the picture is where the player just was. A hero that says «Quick play»
   * shows no map: an unnamed screenshot of somebody's server is the very
   * thing that made the old block unreadable.
   */
  const heroServer = running !== null ? lastServer : continueServer;

  const play = () => {
    if (!defaultClient) return;
    setError(null);
    launchClient.mutate(
      { clientId: defaultClient.id },
      { onError: (e) => setError(errorText(e)) },
    );
  };

  /**
   * Starts the default client on the last server.
   *
   * The same two steps as **Connect** on the Servers screen, in the same
   * order: the address is recorded first and on its own, so the row keeps its
   * place in the history even when the launch fails on a missing engine.
   */
  const connect = (server: ServerInfo) => {
    if (!defaultClient) return;
    if (launchClient.isPending) return;
    setError(null);
    addHistory.mutate(server.address);
    launchClient.mutate(
      { clientId: defaultClient.id, connect: server.address },
      { onError: (e) => setError(errorText(e)) },
    );
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
              <p className="text-body-md text-fg-secondary max-w-[560px]">
                {running ? (
                  <RunningLine startedAt={running.startedAt} pid={running.pid} />
                ) : continueServer && defaultClient ? (
                  t("hero.continueText", { client: defaultClient.name })
                ) : defaultClient ? (
                  t("hero.readyText")
                ) : (
                  // --- slice: game switch --- the hero of a game with no
                  // client is the invitation to make one, not a dead button.
                  t("hero.noClientText", { game: gameName(activeGame) })
                )}
              </p>
            </div>

            {/* --- slice: i18n --- the row wraps: «Create a Jedi Outcast
                client» beside «Manage clients» already fills the hero at the
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
                      {launchClient.isPending
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
                    {launchClient.isPending && continueServer === undefined
                      ? tCommon("states.starting")
                      : t("hero.play")}
                  </Button>
                </>
              )}
              <Button
                size="lg"
                icon={<Plus size={20} />}
                onClick={() => void navigate("/clients")}
              >
                {t("hero.manageClients")}
              </Button>
              {defaultClient ? (
                <Badge tone="accent">{defaultClient.engineId}</Badge>
              ) : null}
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
        <ServerListBlock title={t("topServers.favorites")} servers={favorites} />
        <ServerListBlock title={t("topServers.history")} servers={history} />
        <TopServers />
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
