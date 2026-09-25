import { ChevronLeft, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { HostSession } from "../../lib/ipc";
import { Button } from "../ui";
import { Notice } from "./Notice";

/**
 * The sentence of a failed start or a crash, out of `failure`.
 *
 * The core says what went wrong as a code and the values of the sentence;
 * `message` is its English line for the log, and it reaches the screen only
 * for a process that did not start at all, where it is the whole story.
 */
export function useFailureText(): (session: HostSession) => string {
  const { t } = useTranslation("host");
  return (session: HostSession) => {
    const failure = session.failure;
    const code = session.exitCode ?? "?";
    if (failure === null) {
      return session.exitCode !== null ? t("failed.crashed", { code }) : t("failed.other");
    }
    switch (failure.code) {
      case "exited":
        return t("failed.exited", { code });
      case "timeout":
        return t("failed.timeout", { map: session.settings.map });
      case "ports_busy":
        return t("failed.portsBusy", {
          from: failure.portFrom ?? "?",
          to: failure.portTo ?? "?",
        });
      case "map_missing":
        return t("failed.mapMissing", { map: session.settings.map });
      case "crashed":
        return t("failed.crashed", { code });
      case "spawn":
        return t("failed.spawn", { message: failure.message });
      default:
        return session.exitCode !== null ? t("failed.crashed", { code }) : t("failed.other");
    }
  };
}

/**
 * The **Failed** state: what went wrong, the last lines the server printed,
 * **Show log** for the whole file, and **Back to settings**.
 *
 * The tail is the player's to copy into a bug report, so it keeps its line
 * breaks and stays selectable.
 */
export function HostFailed({
  session,
  onShowLog,
  onBack,
}: {
  session: HostSession;
  onShowLog: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation("host");
  const failureText = useFailureText();

  return (
    <>
      <Notice
        tone="danger"
        action={
          <Button size="sm" icon={<FileText size={14} />} onClick={onShowLog}>
            {t("failed.showLog")}
          </Button>
        }
      >
        {failureText(session)}
      </Notice>
      <div
        role="log"
        aria-label={t("failed.logLabel")}
        className="flex-1 min-h-0 max-h-[506px] overflow-auto rounded-md border border-line bg-input p-12"
      >
        {session.logTail.length === 0 ? (
          <p className="text-body-sm text-fg-muted">{t("failed.logEmpty")}</p>
        ) : (
          <pre className="text-mono-xs text-fg-secondary whitespace-pre-wrap break-all">
            {session.logTail.join("\n")}
          </pre>
        )}
      </div>
      <Button className="self-start" icon={<ChevronLeft size={16} />} onClick={onBack}>
        {t("failed.back")}
      </Button>
    </>
  );
}
