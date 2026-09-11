import { Check, Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import type { Client, Engine } from "../../lib/ipc";
import {
  useEngineReleases,
  useEngineUpdate,
  useInstallEngine,
  usePendingInstalls,
} from "../../lib/queries";
import { useGameEventsContext } from "../GameEventsProvider";
import { Badge, Button } from "../ui";
import { InstallProgressBar } from "./InstallProgressBar";

/**
 * The engine of a client, with the one button that changes it.
 *
 * Which build a client runs is fixed when the client is made — the archive the
 * installer fetches comes from it — so this row updates the build and never
 * swaps it. It is the same three commands the Clients screen uses:
 * `list_engine_releases` for the version behind the first install,
 * `check_engine_update` for the button, `install_engine` for the work, and the
 * `launch:engine-install-progress` event for the bar.
 */
export function ClientEngineRow({
  client,
  engine,
}: {
  client: Client;
  engine: Engine | undefined;
}) {
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();

  const installEngine = useInstallEngine();
  const pendingInstalls = usePendingInstalls();
  const { installs, clearInstall } = useGameEventsContext();
  const [checkRequested, setCheckRequested] = useState(false);
  const update = useEngineUpdate(checkRequested ? client.id : null);
  const installed = client.engineVersion !== null;
  const releases = useEngineReleases(installed ? null : client.engineId);
  const [failure, setFailure] = useState<string | null>(null);

  const progress = installs[client.id];
  const showProgress =
    progress !== undefined &&
    (progress.phase === "download" || progress.phase === "extract");
  // The command may be in flight before the first progress event, and both
  // states mean the engine folder is being rewritten.
  const installing = showProgress || pendingInstalls.includes(client.id);
  const engineName = engine?.name ?? client.engineId;
  const latestTag = releases.data?.[0]?.tag;
  const updateAvailable = update.data?.updateAvailable === true;

  const install = () => {
    setFailure(null);
    clearInstall(client.id);
    installEngine.mutate(
      { clientId: client.id },
      { onError: (e) => setFailure(errorText(e)) },
    );
  };

  const check = () => {
    if (checkRequested) void update.refetch();
    else setCheckRequested(true);
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-8 flex-wrap">
        <span className="text-heading-sm text-fg">{engineName}</span>
        <Badge tone={installed ? "neutral" : "warm"}>
          {client.engineVersion ?? t("card.engineNotInstalled")}
        </Badge>
        {installed && client.engineInstalledAt ? (
          <span className="text-mono-xs text-fg-muted">
            {t("card.installedOn", { date: format.date(client.engineInstalledAt) })}
          </span>
        ) : null}
      </div>

      {engine && !engine.installable ? (
        <p className="text-body-sm text-fg-muted">
          {engine.notInstallableReason ?? t("card.manualInstall")}
        </p>
      ) : (
        <div className="flex items-center gap-8 flex-wrap">
          {installed ? (
            <>
              <Button
                size="sm"
                icon={<RefreshCw size={14} />}
                onClick={check}
                disabled={installing || update.isFetching}
              >
                {update.isFetching
                  ? tCommon("states.checking")
                  : t("engine.checkUpdates")}
              </Button>
              {updateAvailable ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Download size={14} />}
                  onClick={install}
                  disabled={installing}
                >
                  {update.data?.latest
                    ? t("engine.updateTo", { version: update.data.latest })
                    : t("engine.updateToNewest")}
                </Button>
              ) : update.data ? (
                <Badge tone="success" icon={<Check size={12} />}>
                  {t("engine.upToDate")}
                </Badge>
              ) : null}
            </>
          ) : (
            <Button
              size="sm"
              icon={<Download size={14} />}
              onClick={install}
              disabled={installing}
            >
              {installing
                ? tCommon("states.installing")
                : latestTag
                  ? t("engine.installVersion", { version: latestTag })
                  : t("engine.install")}
            </Button>
          )}
        </div>
      )}

      {showProgress && progress ? <InstallProgressBar progress={progress} /> : null}
      {progress?.phase === "error" ? (
        <p className="text-body-sm text-fg-danger break-words">{progress.message}</p>
      ) : null}
      {update.error ? (
        <p className="text-body-sm text-fg-danger">{errorText(update.error)}</p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
