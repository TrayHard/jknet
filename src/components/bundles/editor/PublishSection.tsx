import { AlertTriangle, ExternalLink, FlaskConical, ImageMinus, ShieldAlert, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import type { BundlePublishJob } from "../../../lib/bundleJobs";
import { bundlesTabRoute } from "../../../lib/bundleRoutes";
import { languageCode } from "../../../lib/bundleText";
import { SHARED_SCOPE, type Draft, type DraftIssue, type DraftIssues } from "../../../lib/ipc";
import type { DraftActions } from "../../../lib/queries";
import { Button } from "../../ui";
import { BundlePublishBar, Notice, useCodeText } from "../bundleFiles";
import { unusedImages } from "./draftModel";

/**
 * --- slice: bundles ---
 *
 * **Publish**: what stands between the draft and the catalogue, and the two
 * buttons.
 *
 * The errors and the warnings come from `validate_bundle_draft`, re-read
 * after every edit: an error blocks both buttons, a warning is read and
 * ignored — except the one about pictures the description no longer uses,
 * which carries the button that takes them out of the draft. Under them the
 * sums — what goes to the store, what a player gets from jkhub.org, the
 * executables that send the version to review — then **Test locally**,
 * **Publish**, and the bar and the outcome of a publish out of
 * `bundleJobs`, which survive leaving the page.
 */
export function PublishSection({
  draft,
  actions,
  issues,
  loading,
  error,
  job,
  signedIn,
  onTest,
  onPublish,
  onRetry,
  onStartOver,
}: {
  draft: Draft;
  actions: DraftActions;
  issues: DraftIssues | undefined;
  loading: boolean;
  error: unknown;
  job: BundlePublishJob | undefined;
  signedIn: boolean;
  onTest: () => void;
  onPublish: () => void;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  const { t } = useTranslation("bundles");
  const errorText = useErrorText();
  const format = useFormat();
  const issueText = useCodeText("editor.issue");

  // The pictures the description does not refer to go out one command at a
  // time: each answers with the draft, and the checks are read again after
  // the last, which is what makes the warning go away.
  const unused = unusedImages(draft);
  const [removing, setRemoving] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);
  const removeUnused = async () => {
    setRemoving(true);
    setRemoveFailure(null);
    try {
      for (const image of unused) {
        await actions.removeImage.mutateAsync(image.sha256);
      }
    } catch (e) {
      setRemoveFailure(errorText(e));
    } finally {
      setRemoving(false);
    }
  };
  const labelOf = (componentId: string | null | undefined) =>
    draft.components.find((component) => component.id === componentId)?.label ?? null;
  // The part of the draft an issue is about, named the way the navigation
  // names it: the label of its component, **Shared configs** for a config
  // of the shared part, **Shared files** for anything else shared, and
  // nothing for the draft as a whole. The core marks the shared part with
  // `scope` alone — `componentId` is empty there, as it is for the whole
  // draft — so a finding about a shared file needs the scope to be told
  // from one about the whole bundle.
  const placeOf = (issue: DraftIssue): string | null => {
    if (issue.scope === SHARED_SCOPE) {
      return issue.code === "configTooLong" ? t("editor.nav.sharedConfigs") : t("editor.nav.sharedFiles");
    }
    return labelOf(issue.componentId ?? issue.scope);
  };

  const blocked = issues === undefined || issues.errors.length > 0;
  const running = job?.phase === "running";
  const update = draft.bundleId !== null;

  // The sentence of the code, or the English sentence of the core for a
  // code without a key, or the code itself; then the translation, the part
  // of the draft and the path the issue is about, when it is about one.
  const line = (issue: DraftIssue) => {
    const text = issueText(issue.code, { count: issue.count ?? 0 });
    const base = text === issue.code && issue.message ? issue.message : text;
    const where = [issue.language ? languageCode(issue.language) : null, placeOf(issue), issue.path]
      .filter(Boolean)
      .join(" · ");
    return where === "" ? base : `${base} (${where})`;
  };

  return (
    <div className="flex flex-col gap-16">
      {/* Errors and warnings. */}
      {error ? (
        <Notice tone="danger">
          <span>{t("editor.publish.checkFailed")}</span>
          <span className="text-fg-secondary">{errorText(error)}</span>
        </Notice>
      ) : loading && issues === undefined ? (
        <p className="text-body-sm text-fg-muted">{t("editor.publish.checking")}</p>
      ) : issues ? (
        <>
          {issues.errors.length === 0 && issues.warnings.length === 0 ? (
            <Notice tone="success">
              <span>{t("editor.publish.clean")}</span>
            </Notice>
          ) : null}
          {issues.errors.map((issue, index) => (
            <Notice key={`error-${index}`} tone="danger">
              <span className="flex items-start gap-6">
                <AlertTriangle size={14} className="shrink-0 mt-2" aria-hidden />
                {line(issue)}
              </span>
            </Notice>
          ))}
          {issues.warnings.map((issue, index) => (
            <Notice key={`warning-${index}`} tone="warm">
              <span className="flex items-start gap-6">
                <AlertTriangle size={14} className="shrink-0 mt-2" aria-hidden />
                {line(issue)}
              </span>
              {issue.code === "unusedImages" ? (
                <>
                  <Button
                    size="sm"
                    icon={<ImageMinus size={14} />}
                    disabled={removing || running || unused.length === 0}
                    onClick={() => void removeUnused()}
                  >
                    {removing
                      ? t("editor.publish.removingImages")
                      : t("editor.publish.removeImages", { count: unused.length })}
                  </Button>
                  {removeFailure !== null ? (
                    <span className="text-fg-danger">{t("editor.publish.removeImagesFailed", { reason: removeFailure })}</span>
                  ) : null}
                </>
              ) : null}
            </Notice>
          ))}

          {/* The sums. */}
          <div className="flex flex-col gap-4 text-body-sm text-fg-secondary">
            <span>{t("editor.publish.upload", { size: format.bytes(issues.blobBytes) })}</span>
            {issues.jkhubBytes > 0 ? (
              <span>{t("editor.publish.jkhub", { size: format.bytes(issues.jkhubBytes) })}</span>
            ) : null}
            <span>{t("card.files", { count: issues.fileCount })}</span>
          </div>

          {issues.executables.length > 0 ? (
            <div className="flex flex-col gap-4">
              <span className="flex items-center gap-6 text-body-sm text-fg-warm">
                <ShieldAlert size={14} aria-hidden />
                {t("editor.publish.executables")}
              </span>
              <ul className="flex flex-col gap-2 pl-20">
                {issues.executables.map((path) => (
                  <li key={path} className="text-mono-xs text-fg-secondary break-all">
                    {path}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {/* The two buttons. */}
      <div className="flex flex-wrap items-center gap-8">
        <Button icon={<FlaskConical size={16} />} disabled={blocked || running} onClick={onTest}>
          {t("editor.testLocally")}
        </Button>
        <Button
          variant="primary"
          icon={<Upload size={16} />}
          disabled={blocked || running}
          title={signedIn ? undefined : t("publish.signInTitle")}
          onClick={onPublish}
        >
          {running ? t("editor.publish.publishing") : update ? t("editor.publishUpdate") : t("editor.publish.button")}
        </Button>
        {!signedIn ? <span className="text-body-sm text-fg-muted">{t("editor.publish.signInNote")}</span> : null}
      </div>

      {/* The publish, out of the store. */}
      {job ? <PublishOutcome job={job} update={update} onRetry={onRetry} onStartOver={onStartOver} /> : null}
    </div>
  );
}

/** The bar, the outcome or the failure of a publish. */
function PublishOutcome({
  job,
  update,
  onRetry,
  onStartOver,
}: {
  job: BundlePublishJob;
  update: boolean;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  const { t } = useTranslation("bundles");
  const errorText = useErrorText();

  if (job.phase === "running") {
    return <BundlePublishBar progress={job.progress} />;
  }

  if (job.phase === "done" && job.result) {
    const { bundle, version } = job.result;
    const pending = version.status === "pending";
    return (
      <Notice tone={pending ? "warm" : "success"}>
        <span className="text-body-md-medium">
          {pending ? t("publish.upload.pending") : t("publish.upload.published")}
        </span>
        <span className="text-fg-secondary">
          {pending
            ? t("publish.upload.pendingText", { bundle: bundle.name, label: version.label })
            : t("publish.upload.publishedText", { bundle: bundle.name, label: version.label })}
        </span>
        <Link to={bundlesTabRoute(bundle.id)} className="inline-flex items-center gap-4 text-fg-accent hover:underline">
          <ExternalLink size={14} aria-hidden />
          {t("editor.publish.openCard")}
        </Link>
      </Notice>
    );
  }

  const fileLine = job.progress?.phase === "error" ? job.progress.message : null;
  const reason = job.error === null ? null : errorText(job.error);
  // The bundle was created before the try failed: it is on the account as a
  // draft, and a retry adds the version to it. On an update the bundle was
  // there all along, and a draft version left in it is nothing to act on.
  const draftLeft = !update && job.bundleId !== null;
  return (
    <Notice tone="danger">
      <span>
        {t("publish.upload.failed", {
          message: [fileLine, reason].filter(Boolean).join(" ") || t("publish.upload.phase.error"),
        })}
      </span>
      {draftLeft ? <span className="text-fg-secondary">{t("publish.upload.failedDraftRetry")}</span> : null}
      <span className="flex flex-wrap gap-8">
        <Button size="sm" variant="primary" onClick={onRetry}>
          {t("publish.upload.retry")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onStartOver}>
          {t("publish.upload.startOver")}
        </Button>
      </span>
    </Notice>
  );
}
