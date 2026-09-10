import { Play, Plus } from "lucide-react";
import { useNavigate } from "react-router";

import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, EmptyState } from "../components/ui";
import { useClients, useSettings } from "../lib/queries";

/**
 * Home: one hero block with the Play button.
 *
 * Play stays disabled until a default client exists, because starting a
 * client is a later task and a button that does nothing is worse than a
 * button that says why.
 */
export function HomePage() {
  const navigate = useNavigate();
  const settings = useSettings();
  const clients = useClients();

  const defaultClient = clients.data?.find(
    (client) => client.id === settings.data?.defaultClientId,
  );
  const canPlay = defaultClient !== undefined;

  return (
    <Page>
      <PageHeader
        title="Home"
        subtitle="Jump back in, or pick a server from the browser."
      />

      <section className="relative overflow-hidden rounded-xl border border-line bg-surface p-32 shadow-card">
        <div
          aria-hidden="true"
          className="absolute -top-40 -right-24 size-240 rounded-full bg-accent-glow blur-3xl"
        />
        <div className="relative flex flex-col gap-24">
          <div className="flex flex-col gap-8">
            <span className="text-label-xs text-fg-muted">Quick play</span>
            <h2 className="text-display-xl text-fg">
              {defaultClient ? defaultClient.name : "No default client"}
            </h2>
            <p className="text-body-md text-fg-secondary max-w-[560px]">
              {defaultClient
                ? "Start the default client and pick a server from the in-game menu."
                : "Create a client on the Clients screen, then mark it as the default one."}
            </p>
          </div>

          <div className="flex items-center gap-12">
            <Button
              variant="primary"
              size="lg"
              icon={<Play size={20} />}
              disabled={!canPlay}
              title={canPlay ? "Launching arrives in a later task" : undefined}
            >
              Play
            </Button>
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
