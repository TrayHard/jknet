import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import type { HostSession } from "../../lib/ipc";
import { Button } from "../ui";
import { ranForSeconds, secondsSince } from "./hostModel";

/**
 * The **Stopped** state: why the server stopped, how long it ran, and the way
 * back — **Start again** with the same settings and password, or **Change
 * settings** to the form.
 */
export function HostStopped({
  session,
  onStartAgain,
  onChangeSettings,
  starting,
  error,
}: {
  session: HostSession;
  onStartAgain: () => void;
  onChangeSettings: () => void;
  starting: boolean;
  error: string | null;
}) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();

  // How long the server stood empty: since the last player left, or since it
  // was ready when nobody ever came.
  const emptyFor = secondsSince(
    session.emptySince ?? session.readyAt ?? session.startedAt,
    Date.parse(session.stoppedAt ?? "") || Date.now(),
  );
  const reason = (() => {
    switch (session.stopReason) {
      case "user":
        return t("stopped.reason.user");
      case "empty":
        return t("stopped.reason.empty", {
          minutes: Math.max(1, Math.round((emptyFor ?? 0) / 60)),
        });
      case "relay_expired":
        return t("stopped.reason.relay_expired");
      case "launcher_exit":
        return t("stopped.reason.launcher_exit");
      default:
        return t("stopped.reason.other");
    }
  })();
  const ran = ranForSeconds(session);

  return (
    <section className="flex flex-col gap-16 rounded-lg border border-line bg-surface p-20">
      <div className="flex flex-col gap-4">
        <h2 className="text-heading-md text-fg">{t("stopped.title")}</h2>
        <p className="text-body-md text-fg-secondary">{reason}</p>
        {ran !== null ? (
          <p className="text-body-sm text-fg-muted">
            {t("stopped.summary", { duration: format.elapsed(ran), count: session.joinedCount })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-8">
        <Button
          variant="primary"
          icon={<RefreshCw size={16} />}
          disabled={starting}
          onClick={onStartAgain}
        >
          {starting ? tCommon("states.starting") : t("stopped.startAgain")}
        </Button>
        <Button icon={<SlidersHorizontal size={16} />} onClick={onChangeSettings}>
          {t("stopped.changeSettings")}
        </Button>
      </div>
      {error ? <p className="text-body-sm text-fg-danger">{error}</p> : null}
    </section>
  );
}
