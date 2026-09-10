import { AlertTriangle, Play, Plus, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { GameFilesNotice } from "../components/GameFilesNotice";
import { MapPreview } from "../components/MapPreview";
import { NewClientDialog } from "../components/NewClientDialog";
import { Page, PageHeader } from "../components/PageHeader";
import { TopServers } from "../components/servers/TopServers";
import { Badge, Button } from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
// --- slice: game switch ---
import { useActiveGame, useDefaultClient, useGameNames } from "../lib/game";
import {
  useCachedServers,
  useClients,
  useLaunchClient,
  useRunningGame,
  useSettings,
  useStopGame,
} from "../lib/queries";

/**
 * Home: one hero block with the Play button.
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
  // --- slice: maps ---
  // The map of the server Connect was last pressed on, when the browser still
  // has that row. History is the launcher's, not the client's, so this follows
  // the last connection of any client. Nothing is fetched for it: both the
  // history and the cached list are already on screen elsewhere.
  //
  // --- slice: game switch ---
  // The newest entry that belongs to the active game, not simply the newest:
  // the cached list holds one game, so a Jedi Outcast connection at the top of
  // the history must not blank the picture on the Jedi Academy screen.
  const cachedServers = useCachedServers();
  const lastServer = useMemo(() => {
    const rows = cachedServers.data ?? [];
    if (rows.length === 0) return undefined;
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    for (const entry of settings.data?.serverHistory ?? []) {
      const row = byAddress.get(entry.address);
      if (row !== undefined) return row;
    }
    return undefined;
  }, [cachedServers.data, settings.data?.serverHistory]);
  const running = runningGame.data ?? null;
  const runningClient = clients.data?.find((client) => client.id === running?.clientId);
  const canPlay =
    defaultClient !== undefined && running === null && !launchClient.isPending;

  const play = () => {
    if (!defaultClient) return;
    setError(null);
    launchClient.mutate(
      { clientId: defaultClient.id },
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
            <div className="flex flex-col gap-8">
              <span className="text-label-xs text-fg-muted">
                {running ? t("hero.inGame") : t("hero.quickPlay")}
              </span>
              <h2 className="text-display-xl text-fg">
                {running
                  ? t("hero.running", {
                      client: runningClient?.name ?? running.clientId,
                    })
                  : (defaultClient?.name ??
                    t("hero.noClient", { game: gameName(activeGame) }))}
              </h2>
              <p className="text-body-md text-fg-secondary max-w-[560px]">
                {running ? (
                  <RunningLine startedAt={running.startedAt} pid={running.pid} />
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
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Play size={20} />}
                  disabled={!canPlay}
                  onClick={play}
                  title={defaultClient ? undefined : t("hero.playHint")}
                >
                  {launchClient.isPending ? tCommon("states.starting") : t("hero.play")}
                </Button>
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

          {/* --- slice: maps --- */}
          {lastServer ? (
            <MapPreview
              map={lastServer.map}
              game={lastServer.game}
              serverName={lastServer.hostnameClean}
              className="w-240 h-140 shrink-0"
            />
          ) : null}
        </div>
      </section>

      <section className="pt-24">
        <TopServers />
      </section>

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
