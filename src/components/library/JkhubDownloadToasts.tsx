import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import type { JkhubDownloadProgress, JkhubInstallResult } from "../../lib/ipc";
import {
  jkhubDownloads,
  useJkhubInstalls,
  type JkhubInstallEntry,
} from "../../lib/jkhubDownloads";
import { useClients, useJkhubDownloadProgress } from "../../lib/queries";
import { isTauri } from "../../lib/runtime";
import { ToastSlot, useToasts } from "../ToastsProvider";
import { Button, Toast } from "../ui";

/**
 * --- slice: jkhub details ---
 *
 * What a press of **Install** on the JKHub tab looks like while it works.
 *
 * The install used to report only its result, as one toast at the end: a
 * 217 MB map came down behind a button that had turned into a percentage on a
 * card the player may have scrolled away from. Now every install gets a card
 * in the toast column for the whole of its life — bytes, then unpacking, then
 * either the folder it landed in or the reason it did not.
 *
 * Mounted once, next to the other providers, and not on the Library screen:
 * the download outlives the screen, and a player who walks off to the server
 * browser mid-download should still see it finish.
 *
 * The cards are rendered into the column through [`ToastSlot`] rather than
 * pushed with `useToasts`, because their content changes several times a
 * second and a push per progress event would rebuild the whole column each
 * time. The one thing that is pushed is a dismissal: the Library screen still
 * shows a plain toast of its own under the id `jkhub:<file>`, and this takes
 * it away in the same commit, so one install is one card. That call goes when
 * the tab stops pushing it.
 */
export function JkhubDownloadToasts() {
  const entries = useJkhubInstalls();
  const progress = useJkhubDownloadProgress();
  const toasts = useToasts();
  const clients = useClients();

  const { dismiss } = toasts;
  useEffect(() => {
    for (const entry of entries) dismiss(`jkhub:${entry.fileId}`);
  }, [entries, dismiss]);

  if (entries.length === 0) return null;

  return (
    <ToastSlot>
      {entries.map((entry) => (
        <InstallCard
          key={entry.fileId}
          entry={entry}
          progress={progress.get(entry.fileId) ?? null}
          clientName={
            clients.data?.find((client) => client.id === entry.clientId)?.name ??
            entry.clientId ??
            ""
          }
        />
      ))}
    </ToastSlot>
  );
}

/** How long a finished install stays on screen before it takes itself away. */
const KEEP_AFTER_SUCCESS_MS = 10_000;

interface InstallCardProps {
  entry: JkhubInstallEntry;
  progress: JkhubDownloadProgress | null;
  clientName: string;
}

function InstallCard({ entry, progress, clientName }: InstallCardProps) {
  const { t } = useTranslation("jkhub");
  const format = useFormat();
  const errorText = useErrorText();
  const result = entry.result;
  const installed = result?.kind === "installed" ? result : null;

  // Only a plain success goes away on its own. Every other answer is a
  // question the player has not answered yet, and a card that took the
  // question away with it would leave nothing to press.
  useEffect(() => {
    if (installed === null) return;
    const timer = setTimeout(
      () => jkhubDownloads.forget(entry.fileId),
      KEEP_AFTER_SUCCESS_MS,
    );
    return () => clearTimeout(timer);
    // `attempt` re-arms the timer when the same file is installed again.
  }, [installed, entry.fileId, entry.attempt]);

  const title = entry.title ?? progress?.fileName ?? t("download.fallbackTitle");

  return (
    <Toast
      variant={
        entry.phase === "failed" ? "error" : installed ? "success" : "info"
      }
      title={title}
      text={
        entry.phase === "failed" ? (
          errorText(entry.error)
        ) : result ? (
          <Answer result={result} clientName={clientName} />
        ) : (
          <Running progress={progress} format={format} t={t} />
        )
      }
      action={
        installed && installed.files.length > 0 && result?.folderPath ? (
          <Button
            size="sm"
            icon={<FolderOpen size={14} />}
            onClick={() => reveal(result.folderPath, installed.files[0])}
          >
            {t("download.openFolder")}
          </Button>
        ) : undefined
      }
      onDismiss={() => jkhubDownloads.forget(entry.fileId)}
    />
  );
}

/** The bytes, the share of them and the bar, while the archive comes down. */
function Running({
  progress,
  format,
  t,
}: {
  progress: JkhubDownloadProgress | null;
  format: ReturnType<typeof useFormat>;
  t: ReturnType<typeof useTranslation<"jkhub">>["t"];
}) {
  if (progress === null) {
    return <Bar ratio={null} label={t("download.starting")} />;
  }
  // The core sends one last event with everything received; what happens
  // after it is the unpacking, which has no numbers of its own.
  const done = progress.total > 0 && progress.received >= progress.total;
  if (done) {
    return <Bar ratio={1} label={t("download.unpacking")} />;
  }
  const ratio = progress.total > 0 ? progress.received / progress.total : null;
  const label =
    progress.total > 0
      ? t("details.downloadingOf", {
          received: format.bytes(progress.received),
          total: format.bytes(progress.total),
        })
      : t("details.downloading", { received: format.bytes(progress.received) });
  return (
    <Bar
      ratio={ratio}
      label={label}
      value={ratio === null ? undefined : format.percent(ratio)}
    />
  );
}

/**
 * A bar with a line above it. An unknown length draws a full bar rather than
 * a fake share: the file host sends a length, a mirror in front of it may not.
 */
function Bar({
  ratio,
  label,
  value,
}: {
  ratio: number | null;
  label: string;
  value?: string;
}) {
  const percent = ratio === null ? null : Math.round(Math.min(1, ratio) * 100);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-8">
        <span className="truncate">{label}</span>
        {value ? (
          <span className="text-mono-xs text-fg-muted shrink-0">{value}</span>
        ) : null}
      </div>
      <div
        className="h-6 rounded-full bg-elevated overflow-hidden"
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: `${percent ?? 100}%` }}
        />
      </div>
    </div>
  );
}

/** What the core answered, in one line. */
function Answer({
  result,
  clientName,
}: {
  result: JkhubInstallResult;
  clientName: string;
}) {
  const { t } = useTranslation("jkhub");
  if (result.kind === "installed") {
    return (
      <span className="flex flex-col gap-2">
        <span>
          {t("download.installedInto", {
            client: clientName,
            folder: result.folder,
          })}
        </span>
        <span className="text-mono-xs text-fg-muted break-all">
          {result.files.join(", ")}
        </span>
      </span>
    );
  }
  // The four other answers all need a decision, and the buttons for it are in
  // the file's own window, which the tab opens at the same moment.
  return <span>{t("download.answered")}</span>;
}

/**
 * Shows the installed file in the file manager.
 *
 * The path is the folder the core answered with plus the first name it wrote,
 * and `revealItemInDir` opens the folder with that file selected — better than
 * opening a `base\` of two hundred archives and leaving the player to look.
 */
function reveal(folderPath: string | null, fileName: string | undefined) {
  if (!isTauri() || folderPath === null || fileName === undefined) return;
  const separator = folderPath.includes("\\") ? "\\" : "/";
  void revealItemInDir(`${folderPath}${separator}${fileName}`).catch(
    () => undefined,
  );
}
