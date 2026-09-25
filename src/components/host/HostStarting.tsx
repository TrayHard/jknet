import { useTranslation } from "react-i18next";

import { useGametypeLabels } from "../../i18n/useGameLabels";
import type { HostSession } from "../../lib/ipc";
import { Button } from "../ui";
import { stepRows } from "./hostModel";
import { StepList } from "./StepList";

/**
 * The **Starting** state: the steps of the start, and **Cancel**.
 *
 * The summary under the title repeats what was asked for — name, map, mode
 * and who can connect — because the form it came from is gone from the
 * screen, and a wrong choice is cheapest to notice before the server is up.
 */
export function HostStarting({
  session,
  onCancel,
  cancelling,
}: {
  session: HostSession;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  const labels = useGametypeLabels();
  const { settings } = session;
  const stopping = cancelling || session.status === "stopping";

  const summary = [
    settings.serverName,
    settings.map,
    labels.label(session.game, settings.gametype),
    t(`setup.network.${settings.network}.title`),
  ].join(" · ");

  return (
    <section className="flex flex-col gap-16 rounded-lg border border-line bg-surface p-20">
      <div className="flex flex-col gap-4 min-w-0">
        <h2 className="text-heading-md text-fg">{t("starting.title")}</h2>
        <p className="text-body-sm text-fg-muted truncate" title={summary}>
          {summary}
        </p>
      </div>
      <StepList rows={stepRows(session)} map={settings.map} />
      <Button className="self-start" disabled={stopping} onClick={onCancel}>
        {stopping ? t("starting.stopping") : tCommon("actions.cancel")}
      </Button>
    </section>
  );
}
