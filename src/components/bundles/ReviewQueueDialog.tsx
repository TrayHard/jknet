import { Check, ChevronDown, ChevronRight, ClipboardCheck, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { virusTotalUrl, type BundleFile, type BundleManifest, type PendingVersion } from "../../lib/ipc";
import { useBundle, usePendingBundleVersions, useReviewBundleVersion } from "../../lib/queries";
import { EngineLogo } from "../EngineLogo";
import { Avatar, Badge, Button, Dialog, EmptyState, Input } from "../ui";
import { MarkdownView } from "./MarkdownView";
import { ExternalAnchor, FileKindBadge, ModeBadges, isExecutable, overlaySummary, useEngineName } from "./bundleFiles";

interface ReviewQueueDialogProps {
  onClose: () => void;
}

/** One executable of a version and the part of the manifest it sits in. */
interface Executable {
  file: BundleFile;
  /** The label of the component, or `null` for the shared part. */
  component: string | null;
}

/** Every exe and dll of a manifest, overlay and `home\` alike, with where it sits. */
function executablesOf(manifest: BundleManifest): Executable[] {
  const found: Executable[] = [];
  for (const component of manifest.components) {
    for (const file of [...component.overlay.files, ...component.files]) {
      if (isExecutable(file.kind)) found.push({ file, component: component.label });
    }
  }
  for (const file of manifest.shared.files) {
    if (isExecutable(file.kind)) found.push({ file, component: null });
  }
  return found;
}

/**
 * --- slice: bundles ---
 *
 * The versions waiting for an administrator: every one carries an exe or a
 * dll, and the queue prints each of them with its hash, its component and a
 * VirusTotal link, because that is what the decision is made on. The
 * components stand above the files: which engines the version builds on and
 * how much it lays over each. The description opens on demand: the queue
 * carries the card of the bundle, and the description is on its record.
 * **Approve** publishes the version; **Reject** needs a reason, which the
 * author reads on their list.
 */
export function ReviewQueueDialog({ onClose }: ReviewQueueDialogProps) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const pending = usePendingBundleVersions();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <Dialog
      title={t("review.title")}
      wide
      onClose={onClose}
      actions={
        <Button variant="ghost" onClick={onClose}>
          {tCommon("actions.close")}
        </Button>
      }
    >
      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger pt-12">
          {failure}
        </p>
      ) : null}
      {pending.error ? (
        <p role="alert" className="text-body-sm text-fg-danger pt-12">
          {errorText(pending.error)}
        </p>
      ) : null}

      {pending.data ? (
        <div className="flex flex-col gap-12 pt-16 max-h-[60vh] overflow-y-auto pr-4">
          {pending.data.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck size={24} />}
              title={t("review.title")}
              text={t("review.empty")}
            />
          ) : (
            <ul className="flex flex-col gap-12">
              {pending.data.map((entry) => (
                <PendingRow key={entry.version.id} entry={entry} onFailure={setFailure} />
              ))}
            </ul>
          )}
        </div>
      ) : pending.isLoading ? (
        <p className="text-body-sm text-fg-muted pt-16">{tCommon("states.loading")}</p>
      ) : null}
    </Dialog>
  );
}

function PendingRow({
  entry,
  onFailure,
}: {
  entry: PendingVersion;
  onFailure: (message: string | null) => void;
}) {
  const { t } = useTranslation("bundles");
  const errorText = useErrorText();
  const format = useFormat();
  const engineName = useEngineName();
  const review = useReviewBundleVersion();
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);

  const { bundle, version } = entry;
  const executables = executablesOf(version.manifest);

  const decide = (approve: boolean) => {
    if (!approve && note.trim() === "") {
      setNoteMissing(true);
      return;
    }
    setNoteMissing(false);
    onFailure(null);
    review.mutate(
      { versionId: version.id, approve, note: approve ? null : note.trim() },
      { onError: (e) => onFailure(errorText(e)) },
    );
  };

  return (
    <li className="flex flex-col gap-8 rounded-lg border border-line bg-surface p-12">
      <div className="flex items-center gap-12">
        <EngineLogo engineId={version.engineId} name={engineName(version.engineId)} size={32} />
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-body-md-medium text-fg truncate">
            {bundle.name}
            <span className="text-fg-muted"> · {t("details.version", { label: version.label })}</span>
          </span>
          <span className="flex items-center gap-6 text-body-sm text-fg-muted truncate">
            <Avatar name={bundle.owner?.displayName ?? null} src={bundle.owner?.avatarUrl} size="sm" />
            {bundle.owner
              ? t("review.by", { author: bundle.owner.displayName })
              : t("card.ownerUnknown")}
            {" · "}
            {format.date(version.createdAt)}
            {" · "}
            {t("details.versionSize", { size: format.bytes(version.blobBytes), count: version.fileCount })}
          </span>
        </div>
        <Badge tone="warm">{t("details.status.pending")}</Badge>
      </div>

      {version.changelog.trim() !== "" ? (
        <p className="text-body-sm text-fg-secondary whitespace-pre-line">{version.changelog}</p>
      ) : null}

      <PendingDescription bundleId={bundle.id} />

      {/* The components: engine, tag, modes, and the size of the overlay. */}
      <div className="flex flex-col gap-4">
        <span className="text-label-xs text-fg-muted">{t("review.components")}</span>
        <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
          {version.manifest.components.map((component) => {
            const { replaced, added, removed } = overlaySummary(component.overlay);
            return (
              <li key={component.id} className="flex items-center gap-8 px-12 py-6 min-w-0">
                <EngineLogo engineId={component.engine.engineId} name={engineName(component.engine.engineId)} size={24} />
                <span className="text-body-sm-medium text-fg truncate">{component.label}</span>
                <span className="text-body-sm text-fg-muted truncate">
                  {engineName(component.engine.engineId)}
                  {component.engine.releaseTag ? ` ${component.engine.releaseTag}` : ""}
                </span>
                <ModeBadges modes={component.modes} />
                <span className="ml-auto text-mono-xs text-fg-muted shrink-0">
                  {[
                    t("details.overlay.replaced", { count: replaced }),
                    t("details.overlay.added", { count: added }),
                    t("details.overlay.removed", { count: removed }),
                  ].join(" · ")}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-4">
        <span className="text-label-xs text-fg-muted">{t("review.executables")}</span>
        <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
          {executables.map(({ file, component }) => (
            <li key={`${component ?? ""}/${file.root}/${file.path}`} className="flex flex-col gap-4 px-12 py-8">
              <div className="flex items-center gap-8 min-w-0">
                <span className="text-mono-sm text-fg truncate flex-1 min-w-0" title={file.path}>
                  {file.root === "engine" ? file.path : `${file.root}/${file.path}`}
                </span>
                <Badge tone="neutral" className="shrink-0">
                  {component ?? t("review.sharedPart")}
                </Badge>
                <FileKindBadge file={file} />
                <span className="text-mono-xs text-fg-muted shrink-0">{format.bytes(file.size)}</span>
              </div>
              <span className="flex flex-wrap items-center gap-8 text-mono-xs text-fg-muted">
                <span className="break-all text-fg-secondary">{file.sha256}</span>
                <ExternalAnchor href={virusTotalUrl(file.sha256)} className="text-fg-accent shrink-0">
                  <ExternalLink size={12} aria-hidden />
                  {t("details.virusTotal")}
                </ExternalAnchor>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-8">
        <Input
          value={note}
          placeholder={t("review.notePlaceholder")}
          aria-label={t("review.note")}
          invalid={noteMissing}
          maxLength={1000}
          onChange={(event) => {
            setNote(event.target.value);
            if (noteMissing && event.target.value.trim() !== "") setNoteMissing(false);
          }}
          className="flex-1 min-w-200"
        />
        <Button
          size="sm"
          variant="danger"
          icon={<X size={14} />}
          disabled={review.isPending}
          onClick={() => decide(false)}
        >
          {t("review.reject")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Check size={14} />}
          disabled={review.isPending}
          onClick={() => decide(true)}
        >
          {t("review.approve")}
        </Button>
      </div>
      {noteMissing ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {t("review.noteRequired")}
        </p>
      ) : null}
    </li>
  );
}

/** The description of the bundle, read from its record when opened. */
function PendingDescription({ bundleId }: { bundleId: string }) {
  const { t } = useTranslation("bundles");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-6 text-body-sm text-fg-secondary hover:text-fg cursor-pointer select-none self-start"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{t("review.description")}</span>
      </button>
      {open ? <PendingDescriptionBody bundleId={bundleId} /> : null}
    </div>
  );
}

/** The record of the bundle, for its description; mounted only while the description is open. */
function PendingDescriptionBody({ bundleId }: { bundleId: string }) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const record = useBundle(bundleId);
  if (record.error) {
    return (
      <p role="alert" className="text-body-sm text-fg-danger">
        {errorText(record.error)}
      </p>
    );
  }
  if (!record.data) {
    return <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>;
  }
  return (
    <div className="rounded-md border border-line-subtle p-12">
      <MarkdownView
        markdown={record.data.description}
        empty={<p className="text-body-sm text-fg-muted">{t("details.noDescription")}</p>}
      />
    </div>
  );
}
