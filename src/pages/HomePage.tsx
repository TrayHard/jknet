import { AlertTriangle, Play, Plus, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { GameFilesNotice } from "../components/GameFilesNotice";
import { MapPreview } from "../components/MapPreview";
import { NewClientDialog } from "../components/NewClientDialog";
import { Page, PageHeader } from "../components/PageHeader";
import { TopServers } from "../components/servers/TopServers";
import { Badge, Button } from "../components/ui";
import { errorMessage } from "../lib/ipc";
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
      { onError: (e) => setError(errorMessage(e)) },
    );
  };

  return (
    <Page>
      <PageHeader
        title="Home"
        subtitle={`${gameName(activeGame)} · jump back in, or pick a server from the browser.`}
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
            {error}{" "}
            <Link to="/clients" className="text-fg-accent underline">
              Open the Clients screen
            </Link>{" "}
            to set the game folder or install the engine.
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
                {running ? "In game" : "Quick play"}
              </span>
              <h2 className="text-display-xl text-fg">
                {running
                  ? `Running: ${runningClient?.name ?? running.clientId}`
                  : (defaultClient?.name ?? `No ${gameName(activeGame)} client yet`)}
              </h2>
              <p className="text-body-md text-fg-secondary max-w-[560px]">
                {running ? (
                  <>
                    Started <Elapsed startedAt={running.startedAt} /> ago, process{" "}
                    {running.pid}. The launcher steps aside while you play.
                  </>
                ) : defaultClient ? (
                  "Start the default client and pick a server from the in-game menu."
                ) : (
                  // --- slice: game switch --- the hero of a game with no
                  // client is the invitation to make one, not a dead button.
                  `A client is an engine build with its own files and settings. Make one and ${gameName(activeGame)} is one press away.`
                )}
              </p>
            </div>

            <div className="flex items-center gap-12">
              {!running && defaultClient === undefined ? (
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Plus size={20} />}
                  onClick={() => setNewClientOpen(true)}
                >
                  Create a {gameName(activeGame)} client
                </Button>
              ) : running ? (
                <Button
                  variant="danger"
                  size="lg"
                  icon={<Square size={20} />}
                  onClick={() =>
                    stopGame.mutate(undefined, {
                      onError: (e) => setError(errorMessage(e)),
                    })
                  }
                >
                  Stop
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Play size={20} />}
                  disabled={!canPlay}
                  onClick={play}
                  title={defaultClient ? undefined : "Mark a client as the default one"}
                >
                  {launchClient.isPending ? "Starting…" : "Play"}
                </Button>
              )}
              <Button
                size="lg"
                icon={<Plus size={20} />}
                onClick={() => void navigate("/clients")}
              >
                Manage clients
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
 * How long the game has been up, refreshed every second.
 *
 * The core reports only the start time: a running clock belongs to the screen
 * that draws it, not to a command that would have to be polled for it.
 */
function Elapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return <span>a moment</span>;

  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const text =
    hours > 0
      ? `${hours} h ${minutes % 60} min`
      : minutes > 0
        ? `${minutes} min`
        : `${seconds} s`;
  return <span className="text-mono-sm text-fg-accent">{text}</span>;
}
