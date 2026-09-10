import {
  AlertTriangle,
  ArrowDownCircle,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  ImageOff,
  MessageSquare,
  Star,
} from "lucide-react";
import { useState } from "react";

import { cn, formatBytes } from "../../lib/format";
import type { JkhubFile, JkhubInstallResult } from "../../lib/ipc";
import { Badge, Button, Dialog } from "../ui";

interface JkhubDetailsProps {
  file: JkhubFile | undefined;
  loading: boolean;
  error: string | null;
  /** Name of the client Install writes into. */
  clientName: string;
  installed: boolean;
  busy: boolean;
  /** Bytes received while this file's archive comes down. */
  progress?: { received: number; total: number } | null;
  /** What the last install attempt answered, when it was not "installed". */
  result: JkhubInstallResult | null;
  onClose: () => void;
  onInstall: (replace: boolean) => void;
  onOpenSite: () => void;
  onRevealArchive: (path: string) => void;
}

/**
 * One file of JKHub, in full.
 *
 * A dialog rather than a third column: the window is 1280 px wide with a
 * 232 px sidebar, and a category tree plus a card grid plus a details panel
 * would leave every one of them too narrow to read.
 *
 * The description is rendered as plain paragraphs, never as markup. It comes
 * from the JSON-LD copy, which the site already stripped of HTML, and the
 * launcher carries no sanitizer: putting a remote string through
 * `dangerouslySetInnerHTML` would hand jkhub.org a script in this window.
 *
 * Every picture here carries `referrerPolicy="no-referrer"`: the site refuses
 * a hotlinked image with `403`, and its own screenshots are the only thing
 * this window loads from another host. See `JkhubCard` and `index.html`.
 */
export function JkhubDetails({
  file,
  loading,
  error,
  clientName,
  installed,
  busy,
  progress,
  result,
  onClose,
  onInstall,
  onOpenSite,
  onRevealArchive,
}: JkhubDetailsProps) {
  const [zoomed, setZoomed] = useState<string | null>(null);
  // Addresses that answered with an error. A picture the site withdrew shows
  // its own placeholder instead of an empty frame, and the thumbnail failing
  // says nothing about the full-size copy, so both are tracked by address.
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const fail = (url: string) =>
    setBroken((current) => new Set(current).add(url));

  const title = file?.title ?? (loading ? "Loading…" : "File");
  const conflicts = result?.kind === "conflicts" ? result.files : null;

  return (
    <>
      <Dialog
        title={title}
        wide
        onClose={onClose}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button icon={<ExternalLink size={16} />} onClick={onOpenSite}>
              Open on JKHub
            </Button>
            <Button
              variant="primary"
              icon={<Download size={16} />}
              disabled={busy || file == null}
              onClick={() => onInstall(conflicts != null)}
            >
              {conflicts != null
                ? "Replace and install"
                : `Install to ${clientName}`}
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="text-body-sm text-fg-danger pt-12">
            {error}
          </p>
        ) : null}

        {file ? (
          <div className="flex flex-col gap-16 pt-16 max-h-[60vh] overflow-y-auto pr-4">
            <div className="flex flex-wrap items-center gap-8">
              {installed ? (
                <Badge tone="success" icon={<Check size={12} />}>
                  Installed
                </Badge>
              ) : null}
              {file.version ? <Badge tone="accent">v{file.version}</Badge> : null}
              {file.categoryName ? (
                <Badge tone="neutral">{file.categoryName}</Badge>
              ) : null}
              {file.stale ? (
                <Badge tone="warm" icon={<AlertTriangle size={12} />}>
                  From cache
                </Badge>
              ) : null}
            </div>

            {file.screenshots.length > 0 ? (
              <ul className="flex gap-8 overflow-x-auto pb-4">
                {file.screenshots.map((shot) => {
                  const preview = shot.thumbnailUrl ?? shot.url;
                  return (
                    <li key={shot.url} className="shrink-0">
                      <button
                        type="button"
                        onClick={() => setZoomed(shot.url)}
                        aria-label="Open the screenshot"
                        className="block h-120 w-200 overflow-hidden rounded-md border border-line cursor-pointer"
                      >
                        {broken.has(preview) ? (
                          <span className="flex size-full items-center justify-center bg-elevated text-fg-muted">
                            <ImageOff size={20} />
                          </span>
                        ) : (
                          <img
                            src={preview}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            onError={() => fail(preview)}
                            className="size-full object-cover"
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-24 gap-y-8">
              <Fact label="Author" value={file.author?.name ?? "Unknown"} />
              <Fact label="Updated" value={date(file.updatedAt)} />
              <Fact label="Submitted" value={date(file.submittedAt)} />
              <Fact
                label="Rating"
                value={
                  file.rating
                    ? `${file.rating.value.toFixed(1)} of 5 · ${file.rating.count} reviews`
                    : "Not rated"
                }
              />
            </dl>

            <div className="flex items-center gap-16 text-mono-xs text-fg-muted">
              <span className="inline-flex items-center gap-4">
                <ArrowDownCircle size={12} aria-hidden />
                {file.downloads.toLocaleString("en-US")} downloads
              </span>
              <span className="inline-flex items-center gap-4">
                <Star size={12} aria-hidden />
                {file.views.toLocaleString("en-US")} views
              </span>
              <span className="inline-flex items-center gap-4">
                <MessageSquare size={12} aria-hidden />
                {file.comments.toLocaleString("en-US")} comments
              </span>
            </div>

            {file.tags.length > 0 ? (
              <div className="flex flex-wrap gap-6">
                {file.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}

            <div className="flex flex-col gap-8">
              {paragraphs(file.description).map((line, index) => (
                <p key={index} className="text-body-sm text-fg-secondary">
                  {line}
                </p>
              ))}
            </div>

            {file.changelog.length > 0 ? (
              <div className="flex flex-col gap-4">
                <span className="text-label-xs text-fg-muted">Versions</span>
                <span className="text-body-sm text-fg-secondary">
                  {file.changelog.map((entry) => entry.version).join(", ")}
                </span>
              </div>
            ) : null}

            {progress ? (
              <p className="text-body-sm text-fg-secondary">
                Downloading… {formatBytes(progress.received)}
                {progress.total > 0 ? ` of ${formatBytes(progress.total)}` : ""}
              </p>
            ) : null}

            {result ? (
              <Outcome result={result} onRevealArchive={onRevealArchive} />
            ) : null}
          </div>
        ) : loading ? (
          <p className="text-body-sm text-fg-muted pt-16">Loading…</p>
        ) : null}
      </Dialog>

      {zoomed ? (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-overlay p-24"
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot"
          onClick={() => setZoomed(null)}
        >
          {broken.has(zoomed) ? (
            <p className="flex items-center gap-8 rounded-md border border-line bg-surface p-24 text-body-sm text-fg-muted">
              <ImageOff size={16} />
              JKHub did not serve this screenshot.
            </p>
          ) : (
            <img
              src={zoomed}
              alt=""
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => fail(zoomed)}
              className="max-h-full max-w-full rounded-md border border-line"
            />
          )}
        </div>
      ) : null}
    </>
  );
}

interface OutcomeProps {
  result: JkhubInstallResult;
  onRevealArchive: (path: string) => void;
}

/** The sentence and the action that go with an install that did not install. */
function Outcome({ result, onRevealArchive }: OutcomeProps) {
  if (result.kind === "installed") {
    return (
      <Notice tone="success">
        Installed {result.files.join(", ")} into {result.folder}.
      </Notice>
    );
  }
  if (result.kind === "conflicts") {
    return (
      <Notice tone="warm">
        {result.files.join(", ")} already {result.files.length === 1 ? "is" : "are"}{" "}
        in {result.folder}. Press Replace and install to overwrite.
      </Notice>
    );
  }
  if (result.kind === "external") {
    return (
      <Notice tone="warm">
        This entry links to another site rather than an archive, so there is
        nothing to install. Open it on JKHub to follow the link.
      </Notice>
    );
  }
  if (result.kind === "unsupported") {
    return (
      <Notice tone="warm">
        The archive is a .{result.format}, which JKNet cannot open yet. Open the
        file on JKHub and unpack it by hand.
      </Notice>
    );
  }
  return (
    <Notice tone="warm">
      <span>
        The archive holds no pk3 file, so there is nothing to install into a
        client. Inside it: {result.entries.slice(0, 8).join(", ")}
        {result.entries.length > 8 ? "…" : ""}
      </span>
      <Button
        size="sm"
        icon={<FolderOpen size={14} />}
        onClick={() => onRevealArchive(result.archivePath)}
      >
        Show the archive
      </Button>
    </Notice>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "success" | "warm";
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-start gap-8 rounded-md border p-12 text-body-sm text-fg",
        tone === "success"
          ? "border-line-success bg-success-subtle"
          : "border-line-warm bg-warm-subtle",
      )}
    >
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2">
      <dt className="text-label-xs text-fg-muted">{label}</dt>
      <dd className="text-body-sm text-fg">{value}</dd>
    </div>
  );
}

function date(value: string | null): string {
  if (!value) return "Unknown";
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return value;
  return when.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Splits the description into readable chunks.
 *
 * JSON-LD gives one long line with the markup stripped, so the paragraph
 * breaks the author typed are gone. What is left of them is a run of
 * non-breaking spaces, which is what the site leaves where an empty
 * paragraph used to be, or three or more ordinary spaces.
 */
function paragraphs(text: string): string[] {
  const chunks = text
    .split(/[\u00a0]+|\s{3,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  return chunks.length > 0 ? chunks : [text];
}
