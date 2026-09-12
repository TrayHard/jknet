import { openUrl } from "@tauri-apps/plugin-opener";
import {
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
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type { JkhubFile, JkhubInstallResult } from "../../lib/ipc";
import { isTauri } from "../../lib/runtime";
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
 * --- slice: jkhub details ---
 * The description is rendered as the author wrote it: paragraphs, lists,
 * links, pictures and the still of an embedded video. The markup does not come
 * off the page, it comes out of `jkhub::richtext` in the core, which rebuilds
 * it from an allowlist of tags and refuses every attribute and every address
 * it does not name itself. That is what makes the one
 * `dangerouslySetInnerHTML` of the launcher defensible, and why the string is
 * never touched on this side. A page whose block the theme moved answers with
 * an empty string, and the plain copy below takes over.
 *
 * Every picture here carries `referrerPolicy="no-referrer"`: the site refuses
 * a hotlinked image with `403`, and its own screenshots are the only thing
 * this window loads from another host. The pictures inside a description carry
 * it too, written by the core onto the tag. See `JkhubCard` and `index.html`.
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
  const { t } = useTranslation("jkhub");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();
  const [zoomed, setZoomed] = useState<string | null>(null);
  // Addresses that answered with an error. A picture the site withdrew shows
  // its own placeholder instead of an empty frame, and the thumbnail failing
  // says nothing about the full-size copy, so both are tracked by address.
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const fail = (url: string) =>
    setBroken((current) => new Set(current).add(url));

  // The title of a file page is the author's own, so it is only stood in for
  // while the page has not arrived.
  const title =
    file?.title ??
    (loading ? t("details.loadingTitle") : t("details.fallbackTitle"));
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
              {tCommon("actions.close")}
            </Button>
            <Button icon={<ExternalLink size={16} />} onClick={onOpenSite}>
              {t("details.openOnSite")}
            </Button>
            <Button
              variant="primary"
              icon={<Download size={16} />}
              disabled={busy || file == null}
              onClick={() => onInstall(conflicts != null)}
            >
              {conflicts != null
                ? t("details.replaceAndInstall")
                : t("details.installTo", { client: clientName })}
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
                  {t("card.installed")}
                </Badge>
              ) : null}
              {file.version ? <Badge tone="accent">v{file.version}</Badge> : null}
              {file.categoryName ? (
                <Badge tone="neutral">{file.categoryName}</Badge>
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
                        aria-label={t("details.openScreenshot")}
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
              <Fact
                label={t("details.author")}
                value={file.author?.name ?? t("details.authorUnknown")}
              />
              <Fact label={t("details.updated")} value={format.date(file.updatedAt)} />
              <Fact
                label={t("details.submitted")}
                value={format.date(file.submittedAt)}
              />
              <Fact
                label={t("details.rating")}
                value={
                  file.rating
                    ? t("details.ratingValue", {
                        value: file.rating.value.toFixed(1),
                        count: file.rating.count,
                      })
                    : t("details.notRated")
                }
              />
            </dl>

            <div className="flex items-center gap-16 text-mono-xs text-fg-muted">
              <span className="inline-flex items-center gap-4">
                <ArrowDownCircle size={12} aria-hidden />
                {t("details.downloads", { count: format.number(file.downloads) })}
              </span>
              <span className="inline-flex items-center gap-4">
                <Star size={12} aria-hidden />
                {t("details.views", { count: format.number(file.views) })}
              </span>
              <span className="inline-flex items-center gap-4">
                <MessageSquare size={12} aria-hidden />
                {t("details.comments", { count: format.number(file.comments) })}
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

            {file.descriptionHtml ? (
              <div
                className="jkhub-richtext"
                onClick={openLink}
                // Cleaned in the core, by `jkhub::richtext`. Nothing on this
                // side may put another string here.
                dangerouslySetInnerHTML={{ __html: file.descriptionHtml }}
              />
            ) : (
              <div className="flex flex-col gap-8">
                {paragraphs(file.description).map((line, index) => (
                  <p key={index} className="text-body-sm text-fg-secondary">
                    {line}
                  </p>
                ))}
              </div>
            )}

            {file.changelog.length > 0 ? (
              <div className="flex flex-col gap-4">
                <span className="text-label-xs text-fg-muted">
                  {t("details.versions")}
                </span>
                <span className="text-body-sm text-fg-secondary">
                  {file.changelog.map((entry) => entry.version).join(", ")}
                </span>
              </div>
            ) : null}

            {progress ? (
              <p className="text-body-sm text-fg-secondary">
                {progress.total > 0
                  ? t("details.downloadingOf", {
                      received: format.bytes(progress.received),
                      total: format.bytes(progress.total),
                    })
                  : t("details.downloading", {
                      received: format.bytes(progress.received),
                    })}
              </p>
            ) : null}

            {result ? (
              <Outcome result={result} onRevealArchive={onRevealArchive} />
            ) : null}
          </div>
        ) : loading ? (
          <p className="text-body-sm text-fg-muted pt-16">
            {tCommon("states.loading")}
          </p>
        ) : null}
      </Dialog>

      {zoomed ? (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-overlay p-24"
          role="dialog"
          aria-modal="true"
          aria-label={t("details.screenshot")}
          onClick={() => setZoomed(null)}
        >
          {broken.has(zoomed) ? (
            <p className="flex items-center gap-8 rounded-md border border-line bg-surface p-24 text-body-sm text-fg-muted">
              <ImageOff size={16} />
              {t("details.screenshotMissing")}
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
  const { t } = useTranslation("jkhub");

  if (result.kind === "installed") {
    return (
      <Notice tone="success">
        {t("outcome.installed", {
          files: result.files.join(", "),
          folder: result.folder,
        })}
      </Notice>
    );
  }
  if (result.kind === "conflicts") {
    return (
      <Notice tone="warm">
        {t("outcome.conflicts", {
          count: result.files.length,
          files: result.files.join(", "),
          folder: result.folder,
        })}
      </Notice>
    );
  }
  if (result.kind === "external") {
    return <Notice tone="warm">{t("outcome.external")}</Notice>;
  }
  if (result.kind === "unsupported") {
    // Review finding (Low): the archive is on disk for this outcome exactly as
    // it is for the one below, so the player gets the same way to reach it
    // instead of being sent back to the site to download it a second time.
    const archivePath = result.archivePath;
    return (
      <Notice tone="warm">
        <span>
          {archivePath
            ? t("outcome.unsupportedDownloaded", { format: result.format })
            : t("outcome.unsupported", { format: result.format })}
        </span>
        {archivePath ? (
          <Button
            size="sm"
            icon={<FolderOpen size={14} />}
            onClick={() => onRevealArchive(archivePath)}
          >
            {t("outcome.showArchive")}
          </Button>
        ) : null}
      </Notice>
    );
  }
  return (
    <Notice tone="warm">
      <span>
        {t("outcome.noPk3", {
          entries:
            result.entries.slice(0, 8).join(", ") +
            (result.entries.length > 8 ? "…" : ""),
        })}
      </span>
      <Button
        size="sm"
        icon={<FolderOpen size={14} />}
        onClick={() => onRevealArchive(result.archivePath)}
      >
        {t("outcome.showArchive")}
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

/**
 * --- slice: jkhub details ---
 * Sends a link of the description to the system browser.
 *
 * The window is the launcher, not a browser: following a link inside it would
 * replace the application with a web page and leave no way back. One handler
 * on the container rather than a listener per link, because the markup is
 * inserted as a string and React has no element to hang a prop on.
 *
 * The address is checked a second time here. The core already refused
 * everything that is not `http(s)`, and this costs one regular expression to
 * make the rule true at the point where the address is actually used.
 */
function openLink(event: React.MouseEvent<HTMLDivElement>) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href) || !isTauri()) return;
  void openUrl(href).catch(() => undefined);
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
