import { useFormat } from "../../i18n/useFormat";
import type { EngineInstallProgress } from "../../lib/ipc";

/**
 * The bar shown while an engine downloads and unpacks.
 *
 * A download without a content length gets an indeterminate bar rather than a
 * fake percentage: GitHub always sends one, mirrors do not always.
 *
 * --- slice: client window ---
 * Two places draw it — the card on the Clients screen and the engine block of
 * the client window — and both are fed by the same
 * `launch:engine-install-progress` event.
 */
export function InstallProgressBar({
  progress,
}: {
  progress: EngineInstallProgress;
}) {
  const format = useFormat();
  const ratio =
    progress.total > 0 ? Math.min(1, progress.downloaded / progress.total) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-8">
        <span className="text-body-sm text-fg-secondary truncate">
          {progress.message}
        </span>
        <span className="text-mono-xs text-fg-muted shrink-0">
          {ratio === null
            ? format.bytes(progress.downloaded)
            : `${format.bytes(progress.downloaded)} / ${format.bytes(progress.total)}`}
        </span>
      </div>
      <div
        className="h-6 rounded-full bg-elevated overflow-hidden"
        role="progressbar"
        aria-label={progress.message}
        aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: ratio === null ? "100%" : `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
