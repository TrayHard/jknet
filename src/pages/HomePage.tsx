import { AlertTriangle, Play, Plus, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, EmptyState } from "../components/ui";
import { errorMessage } from "../lib/ipc";
import {
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

  const defaultClient = clients.data?.find(
    (client) => client.id === settings.data?.defaultClientId,
  );
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
        subtitle="Jump back in, or pick a server from the browser."
      />

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
        <div className="relative flex flex-col gap-24">
          <div className="flex flex-col gap-8">
            <span className="text-label-xs text-fg-muted">
              {running ? "In game" : "Quick play"}
            </span>
            <h2 className="text-display-xl text-fg">
              {running
                ? `Running: ${runningClient?.name ?? running.clientId}`
                : (defaultClient?.name ?? "No default client")}
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
                "Create a client on the Clients screen, then mark it as the default one."
              )}
            </p>
          </div>

          <div className="flex items-center gap-12">
            {running ? (
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
      </section>

      <section className="pt-24">
        <EmptyState
          icon={<Play size={24} />}
          title="Trusted servers show up here"
          text="The server browser lands in a later task. It will list community servers with ping, map and player count."
        />
      </section>
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
