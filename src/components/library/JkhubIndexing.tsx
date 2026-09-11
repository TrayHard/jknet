import { Database, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import type { JkhubIndexProgress } from "../../lib/ipc";
import { Button, EmptyState } from "../ui";

interface JkhubIndexingProps {
  /** True while a crawl or a top-up of this game is in flight. */
  building: boolean;
  /** How far it has got, from the events or from the status. */
  step: JkhubIndexProgress | null;
  /** Stops the crawl. */
  onCancel: () => void;
  /** Starts it again after a stop. */
  onRetry: () => void;
  /** True while either of those calls is in flight. */
  busy: boolean;
}

/**
 * What the **Browse JKHub** tab shows while it has no catalogue to browse.
 *
 * The tab lists and searches from a local copy of the catalogue, so with
 * neither a crawl of this machine nor the copy inside the build there is
 * nothing to draw — the grid used to sit empty while a crawl ran behind it,
 * which read as a broken screen rather than as a wait. This panel stands where
 * the grid would be: one thing happening, one thing to look at, and one button
 * to stop it.
 *
 * The bar above it stays, with its search box switched off. What is missing is
 * the catalogue, not the tab, and a box that accepted words it could not answer
 * would be the broken screen all over again.
 *
 * It is a safety net rather than the normal path. Every build ships a snapshot
 * of both catalogues and the launcher warms the index a few seconds after it
 * starts, so a player normally browses immediately and the refresh behind that
 * is the quiet status line under the results.
 *
 * The estimate comes from the run's own rate — pages done over milliseconds
 * elapsed — rather than from a number invented here: a crawl on a slow
 * connection would make any fixed guess a lie.
 */
export function JkhubIndexing({
  building,
  step,
  onCancel,
  onRetry,
  busy,
}: JkhubIndexingProps) {
  const { t } = useTranslation("jkhub");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();

  if (!building) {
    return (
      <EmptyState
        icon={<Database size={24} />}
        title={t("index.stoppedTitle")}
        text={t("index.stoppedText")}
        action={
          <Button
            icon={<RefreshCw size={16} />}
            disabled={busy}
            onClick={onRetry}
          >
            {tCommon("actions.tryAgain")}
          </Button>
        }
      />
    );
  }

  const done = step?.done ?? 0;
  const total = Math.max(step?.total ?? 0, done);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // A rate needs at least one finished page and a moment to have passed.
  const rate = step && step.elapsedMs > 0 && done > 0 ? done / step.elapsedMs : 0;
  const left = rate > 0 && total > done ? Math.round((total - done) / rate / 1000) : null;

  return (
    <div className="flex flex-col items-center justify-center gap-16 rounded-lg border border-line bg-surface px-24 py-48 text-center">
      <span className="flex items-center justify-center size-48 rounded-full bg-elevated text-fg-accent">
        <RefreshCw size={24} className="animate-spin" />
      </span>

      <div className="flex flex-col gap-4">
        <h3 className="text-heading-sm text-fg">{t("index.blockedTitle")}</h3>
        <p className="text-body-sm text-fg-muted max-w-[420px]">
          {t("index.blockedText")}
        </p>
      </div>

      <div className="flex flex-col gap-8 w-full max-w-[420px]">
        <div
          role="progressbar"
          aria-label={t("index.blockedTitle")}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-4 rounded-full bg-elevated overflow-hidden"
        >
          <div
            className="h-full bg-accent transition-[width] duration-150"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-mono-xs text-fg-muted">
          {t("index.blockedPages", { done, total })}
          {" · "}
          {t("index.blockedRequests", { count: step?.requests ?? 0 })}
          {left !== null ? ` · ${t("index.blockedLeft", { time: format.elapsed(left) })}` : ""}
        </span>
      </div>

      <Button variant="ghost" disabled={busy} onClick={onCancel}>
        {tCommon("actions.cancel")}
      </Button>
    </div>
  );
}
