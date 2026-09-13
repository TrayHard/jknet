import { Film, LoaderCircle, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VideoJob } from "../lib/ipc";
import { Button } from "./ui";

function duration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
export function VideoJobCard({ job, onCancel, onShow, cancelling }: {
  job: VideoJob; onCancel: () => void; onShow: () => void; cancelling: boolean;
}) {
  const { t, i18n } = useTranslation("common");
  const active = job.status === "rendering";
  const phases = ["preparing", "capturing", "encoding", "finalizing"] as const;
  const current = phases.indexOf(job.phase);
  const progress = job.progress;
  const percent = job.phase === "encoding" ? progress.encodingPercent : job.status === "complete" ? 100 : null;
  const label = t(active ? `media.phase_${job.phase}` : `media.export_${job.status}`);
  return <section className="flex flex-col gap-12 rounded-lg border border-line bg-surface p-16" aria-label={`${t("media.exportVideo")}: ${job.demoName}`}>
    <div className="flex items-center gap-12">
      <div className="rounded-md bg-accent-subtle p-8 text-accent"><Film size={20} /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-md text-fg" title={job.demoName}>{job.demoName}</p>
        <p role="status" className="flex items-center gap-8 text-body-sm text-fg-secondary">
          {active ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : job.status === "complete" ? <Check size={14} /> : <X size={14} />}
          {label}{active && percent != null ? ` ${Math.floor(percent)} %` : ""}
        </p>
      </div>
      {active ? <Button variant="ghost" size="sm" disabled={cancelling} onClick={onCancel}>{t("media.cancelExport")}</Button> : job.status === "complete" ? <Button size="sm" onClick={onShow}>{t("media.showVideo")}</Button> : null}
    </div>
    <div className="grid grid-cols-4 gap-8 text-body-xs">
      {phases.map((phase, index) => <span key={phase} className={`border-t-2 pt-8 ${job.status === "complete" || index <= current ? "border-line-focus text-fg" : "border-line text-fg-muted"}`}>{t(`media.step_${phase}`)}</span>)}
    </div>
    {active || job.status === "complete" ? <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent == null ? label : `${Math.floor(percent)} %`} className="h-4 overflow-hidden rounded-full bg-input">
      <div className={`h-full rounded-full bg-accent ${percent == null ? "w-1/3 animate-pulse motion-reduce:animate-none" : "transition-[width]"}`} style={percent != null ? { width: `${percent}%` } : undefined} />
    </div> : null}
    <div className="flex flex-wrap gap-x-20 gap-y-4 text-body-xs text-fg-secondary tabular-nums">
      <span>{t("media.elapsed", { time: duration(job.elapsedSeconds) })}</span>
      {progress.frames > 0 ? <>
        <span>{t("media.captured", { time: duration(progress.capturedSeconds), frames: progress.frames.toLocaleString(i18n.language) })}</span>
        <span>{t("media.captureSize", { size: (progress.outputBytes / 1048576).toLocaleString(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>
      </> : null}
      {job.phase === "encoding" ? <span>{t("media.encoded", { time: duration(progress.encodedSeconds), total: duration(progress.capturedSeconds) })}</span> : null}
    </div>
    {active ? <p className="text-body-xs text-fg-muted">{t(job.phase === "capturing" ? "media.captureProgressHint" : "media.backgroundRender")}</p> : null}
    {job.error ? <p role="alert" className="break-words text-body-sm text-fg-danger">{job.error}</p> : null}
  </section>;
}
