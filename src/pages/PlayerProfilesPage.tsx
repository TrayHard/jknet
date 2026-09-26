import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { PlayerProfilesCard } from "../components/client/PlayerProfilesCard";
import { useUnsavedGuard } from "../components/client/UnsavedGuard";
import { Page, PageHeader } from "../components/PageHeader";
import { Button, Select } from "../components/ui";
import { useErrorText } from "../i18n/errors";
import { clientsOfGame, useActiveGame, useDefaultClient, useGameNames } from "../lib/game";
import { useClients } from "../lib/queries";

/** Profiles stay owned by a client; only their editing destination changes. */
export function PlayerProfilesPage() {
  const { t } = useTranslation("clients");
  const navigate = useNavigate();
  const guard = useUnsavedGuard();
  const errorText = useErrorText();
  const clients = useClients();
  const game = useActiveGame();
  const { label } = useGameNames();
  const defaultClient = useDefaultClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const gameClients = clientsOfGame(clients.data, game);
  const client = gameClients.find((item) => item.id === selectedId)
    ?? gameClients.find((item) => item.id === defaultClient?.id)
    ?? gameClients[0];

  // Pin the initial choice so a default changed in another window cannot
  // replace a client whose profile is being edited here.
  const clientId = client?.id;
  useEffect(() => {
    if (clientId !== undefined) setSelectedId(clientId);
  }, [clientId]);

  return (
    <Page>
      <PageHeader title={t("playerProfiles.title")} subtitle={t("playerProfiles.subtitle")} />
      {clients.error ? <p role="alert" className="text-body-sm text-fg-danger">{errorText(clients.error)}</p> : null}
      {clients.isPending ? <p role="status" className="text-body-sm text-fg-muted">{t("clientWindow.loading")}</p> : null}
      {client ? (
        <div className="flex flex-col gap-16">
          <Select
            value={client.id}
            options={gameClients.map((item) => ({ value: item.id, label: item.name }))}
            label={t("playerProfiles.client")}
            ariaLabel={t("playerProfiles.client")}
            onChange={(id) => { if (id !== client.id) guard.ask(() => setSelectedId(id)); }}
            className="w-full max-w-400"
          />
          <section className="rounded-lg border border-line bg-surface p-16">
            <PlayerProfilesCard key={client.id} client={client} shareable />
          </section>
        </div>
      ) : clients.isSuccess ? (
        <div className="flex flex-col items-start gap-12">
          <p className="text-body-md text-fg-secondary">{t("playerProfiles.empty", { game: label(game) })}</p>
          <Button variant="secondary" onClick={() => void navigate("/clients")}>{t("playerProfiles.manageClients")}</Button>
        </div>
      ) : null}
    </Page>
  );
}
