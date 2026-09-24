import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Gamepad2, Users } from "lucide-react";
import { useEffect, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { i18next } from "../../i18n";
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type {
  BundleComponentSummary,
  BundleFileKind,
  BundleFileRoot,
  BundleFileSource,
  BundleInstallProgress,
  BundleLibraryInfo,
  BundleOverlay,
  BundlePublishProgress,
  DraftFile,
  DraftFileOrigin,
  LaunchMode,
} from "../../lib/ipc";
import { isTauri } from "../../lib/runtime";
import { useEngines } from "../../lib/queries";
import { Badge, type BadgeTone } from "../ui";
import { categoryInfo } from "../library/categories";

/**
 * --- slice: bundles ---
 *
 * What the bundle screens share when they print a file, a component or a
 * running job: the badge of a file's kind, the badge of its source or its
 * origin, the badges of the launch modes, the grouping by folder, the link
 * that leaves the launcher and the two bars of the long operations. Kept
 * out of the screens so that a pk3 is spelled the same way in the record of
 * a bundle, in the editor and in the review queue.
 */

/** The badge tone of each kind: executables stand out, the rest are quiet. */
const KIND_TONES: Record<BundleFileKind, BadgeTone> = {
  pk3: "accent",
  cfg: "neutral",
  dll: "warm",
  exe: "warm",
  other: "neutral",
};

/** True for the two kinds that put a version in front of an administrator. */
export function isExecutable(kind: BundleFileKind): boolean {
  return kind === "exe" || kind === "dll";
}

/** The size of an overlay of a manifest, counted the way the service sums it up for the card. */
export type OverlaySummary = Pick<BundleComponentSummary, "replaced" | "added" | "removed">;

/**
 * The «Replaced 5 · Added 2 · Removed 1» of an overlay: a file with
 * `replaces` stands in for one of the release, a file without is new, and
 * `remove` lists what the install deletes. One count for the record of a
 * bundle and the review queue, so the two never disagree.
 */
export function overlaySummary(overlay: BundleOverlay): OverlaySummary {
  const replaced = overlay.files.filter((file) => file.replaces).length;
  return { replaced, added: overlay.files.length - replaced, removed: overlay.remove.length };
}

/** The least a file needs to get its kind badge: a manifest file or a draft file. */
export interface KindOf {
  kind: BundleFileKind;
  library?: BundleLibraryInfo | null;
}

/** The kind of a file, with the library category of a pk3 when it is known. */
export function FileKindBadge({ file }: { file: KindOf }) {
  const { t } = useTranslation("bundles");
  const { t: tLibrary } = useTranslation("library");
  if (file.kind === "pk3" && file.library) {
    const info = categoryInfo(file.library.category);
    const Icon = info.icon;
    return (
      <Badge tone={info.tone} icon={<Icon size={12} />} className="shrink-0">
        {tLibrary(`categoryOne.${file.library.category}`)}
      </Badge>
    );
  }
  return (
    <Badge tone={KIND_TONES[file.kind] ?? "neutral"} className="shrink-0">
      {t(`details.kind.${file.kind}`, { defaultValue: file.kind })}
    </Badge>
  );
}

/**
 * Where an install gets the file: JKHub, as a link to the record, or JKNet.
 *
 * The JKHub badge is a link rather than a badge with a button beside it: the
 * row of a file is narrow, and the record is the one place the badge could
 * lead to.
 */
export function FileSourceBadge({ source }: { source: BundleFileSource }) {
  const { t } = useTranslation("bundles");
  if (source.kind === "jkhub") {
    const label = t("details.source.jkhub");
    if (source.url) {
      return (
        <ExternalAnchor
          href={source.url}
          title={t("details.openOnJkhub", { title: source.title ?? label })}
          className="shrink-0"
        >
          <Badge tone="purple" icon={<ExternalLink size={10} />}>
            {label}
          </Badge>
        </ExternalAnchor>
      );
    }
    return (
      <Badge tone="purple" className="shrink-0">
        {label}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" className="shrink-0">
      {t("details.source.blob")}
    </Badge>
  );
}

/**
 * Where a draft file was taken from: JKHub, the disk, a client, or the
 * release it replaces — and **Modified** on a JKHub file whose bytes no
 * longer match the record, because that is the one that goes to the store
 * instead of jkhub.org.
 */
export function FileOriginBadge({ file }: { file: DraftFile }) {
  const { t } = useTranslation("bundles");
  const origin = file.origin;
  if (origin.kind === "jkhub" || (origin.kind === "client" && origin.provenance)) {
    const modified = origin.kind === "jkhub" && origin.sha256 !== file.sha256;
    return (
      <>
        <Badge tone="purple" className="shrink-0">
          {t("details.source.jkhub")}
        </Badge>
        {modified ? (
          <Badge tone="warm" className="shrink-0" title={t("details.modifiedHint")}>
            {t("details.modified")}
          </Badge>
        ) : null}
      </>
    );
  }
  if (origin.kind === "client") {
    return (
      <Badge tone="neutral" className="shrink-0">
        {t("editor.origin.client")}
      </Badge>
    );
  }
  if (origin.kind === "release") {
    return (
      <Badge tone="accent" className="shrink-0">
        {t("editor.origin.release")}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" className="shrink-0" title={origin.sourcePath}>
      {t("editor.origin.disk")}
    </Badge>
  );
}

/** True when a draft file will be a JKHub link in the manifest rather than an upload. */
export function isJkhubLink(origin: DraftFileOrigin, sha256: string): boolean {
  if (origin.kind === "jkhub") return origin.sha256 === sha256;
  return origin.kind === "client" && origin.provenance != null;
}

/** The two modes as badges: **Multiplayer**, **Single player**. */
export function ModeBadges({ modes, className }: { modes: LaunchMode[]; className?: string }) {
  const { t } = useTranslation("bundles");
  return (
    <>
      {modes.map((mode) => (
        <Badge
          key={mode}
          tone={mode === "single" ? "purple" : "accent"}
          icon={mode === "single" ? <Gamepad2 size={12} /> : <Users size={12} />}
          className={cn("shrink-0", className)}
        >
          {t(`modes.${mode}`)}
        </Badge>
      ))}
    </>
  );
}

/** The name of an engine out of the registry; the id stands in until it arrives. */
export function useEngineName(): (engineId: string) => string {
  const engines = useEngines();
  return (engineId) => engines.data?.find((engine) => engine.id === engineId)?.name ?? engineId;
}

/**
 * «EternalJK v1.6.3 · OpenJK · jaMME»: the engines of the components, each
 * once, with its tag when the component pins one.
 */
export function useBasedOnLine(): (components: readonly BundleComponentSummary[]) => string {
  const engineName = useEngineName();
  return (components) => {
    const parts: string[] = [];
    for (const component of components) {
      const part = component.releaseTag
        ? `${engineName(component.engineId)} ${component.releaseTag}`
        : engineName(component.engineId);
      if (!parts.includes(part)) parts.push(part);
    }
    return parts.join(" · ");
  };
}

/** The least a file needs to be grouped and named: a root and a path. */
export interface Pathed {
  root: BundleFileRoot;
  path: string;
}

/** One folder of files, in the order the list gives them. */
export interface FileGroup<T extends Pathed> {
  /** `engine`, or `home/<folder>`. */
  key: string;
  root: BundleFileRoot;
  /** The mod folder of a `home` group; empty for the engine folder. */
  folder: string;
  files: T[];
}

/**
 * Splits the files by folder: the engine folder, then one group per mod
 * folder of `home\`, in order of first appearance.
 *
 * A file of `home` sits under `base\` or under a mod folder, and the folder
 * is the first segment of its path. The rest of the path stays on the row, so
 * a dll two folders deep still says where it goes.
 */
export function groupFiles<T extends Pathed>(files: readonly T[]): FileGroup<T>[] {
  const groups = new Map<string, FileGroup<T>>();
  for (const file of files) {
    const folder = file.root === "engine" ? "" : file.path.split("/")[0] ?? "";
    const key = file.root === "engine" ? "engine" : `home/${folder}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, root: file.root, folder, files: [] };
      groups.set(key, group);
    }
    group.files.push(file);
  }
  return [...groups.values()].sort((a, b) =>
    a.root === b.root ? 0 : a.root === "engine" ? -1 : 1,
  );
}

/** The name of a file inside its group: the path without the folder segment. */
export function fileNameInGroup(file: Pathed): string {
  if (file.root === "engine") return file.path;
  const slash = file.path.indexOf("/");
  return slash < 0 ? file.path : file.path.slice(slash + 1);
}

/** The heading of one group, in the language on screen. */
export function useGroupLabel(): (group: FileGroup<Pathed>) => string {
  const { t } = useTranslation("bundles");
  return (group) =>
    group.root === "engine"
      ? t("details.folderEngine")
      : t("details.folderHome", { folder: group.folder });
}

/**
 * Escape closes this dialog and nothing behind it.
 *
 * Every `Dialog` listens for Escape on the window, so a dialog opened over
 * another — the contents of a file over the record of the bundle, the
 * enlarged picture over the description — would take the one under it
 * along. A capture listener runs first and stops the key there; the same
 * arrangement as the preview frame of the Library screen.
 */
export function useEscapeFirst(onClose: () => void): void {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);
}

/** One titled block of a bundle screen: the label above, the content below. */
export function Section({
  heading,
  actions,
  children,
}: {
  heading: string;
  /** Buttons on the heading line, right aligned. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center gap-8">
        <h3 className="text-label-xs text-fg-muted flex-1">{heading}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * A link that leaves the launcher.
 *
 * The same mechanism as the links inside a JKHub description: inside Tauri
 * the click is taken over and the address goes to the system browser through
 * the opener plugin; in a plain browser the anchor works as anchors do.
 */
export function ExternalAnchor({
  href,
  title,
  className,
  children,
}: {
  href: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return;
    event.preventDefault();
    if (!/^https?:\/\//i.test(href)) return;
    void openUrl(href).catch(() => undefined);
  };
  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className={cn("inline-flex items-center gap-4 cursor-pointer hover:underline", className)}
    >
      {children}
    </a>
  );
}

/**
 * A bar with a line above it, for the two long operations.
 *
 * `ratio: null` draws a full bar: a phase with no numbers of its own, such as
 * the engine being unpacked or the version being created, is still moving.
 */
export function JobBar({
  ratio,
  label,
  value,
}: {
  ratio: number | null;
  label: string;
  value?: string;
}) {
  const percent = ratio === null ? null : Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-8">
        <span className="text-body-sm text-fg-secondary truncate">{label}</span>
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

/**
 * The bar of a running install, from its last event.
 *
 * Bytes only in the `files` phase: the engine phase reports through
 * `launch:engine-install-progress` and has a bar of its own on the client
 * card, and the configs are written in one go. The component being written
 * stands over the line when the install has more than one.
 */
export function BundleInstallBar({
  progress,
  componentLabel,
}: {
  progress: BundleInstallProgress | null;
  /** The label of the component under the bar, when the caller knows it. */
  componentLabel?: string | null;
}) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  if (progress === null) {
    return <JobBar ratio={null} label={t("details.install.starting")} />;
  }
  const ratio =
    progress.phase === "files" && progress.total > 0
      ? progress.downloaded / progress.total
      : null;
  const line =
    progress.phase === "files"
      ? progress.currentFile
        ? t("details.install.phase.files", {
            index: progress.fileIndex,
            count: progress.fileCount,
            file: progress.currentFile,
          })
        : t("details.install.phase.filesPlain")
      : progress.phase === "engine"
        ? t("details.install.phase.engine")
        : progress.phase === "configs"
          ? t("details.install.phase.configs")
          : progress.message || t("details.install.phase.done");
  const label = componentLabel ? `${componentLabel} · ${line}` : line;
  return (
    <JobBar
      ratio={ratio}
      label={label}
      value={ratio === null ? undefined : format.percent(ratio)}
    />
  );
}

/** The bar of a running publish, from its last event: the phase, the file, the bytes. */
export function BundlePublishBar({ progress }: { progress: BundlePublishProgress | null }) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  if (progress === null) {
    return <JobBar ratio={null} label={t("publish.upload.starting")} />;
  }
  const uploading = progress.phase === "uploading";
  const ratio = uploading && progress.total > 0 ? progress.uploaded / progress.total : null;
  const label = uploading
    ? progress.currentFile
      ? t("publish.upload.phase.uploading", { file: progress.currentFile })
      : t("publish.upload.phase.uploadingPlain")
    : progress.phase === "hashing"
      ? t("publish.upload.phase.hashing")
      : progress.phase === "creating"
        ? t("publish.upload.phase.creating")
        : progress.phase === "publishing"
          ? t("publish.upload.phase.publishing")
          : progress.message || t("publish.upload.phase.done");
  return (
    <div className="flex flex-col gap-8">
      <JobBar
        ratio={ratio}
        label={label}
        value={
          uploading && progress.fileCount > 0
            ? t("publish.upload.file", { index: progress.fileIndex, count: progress.fileCount })
            : undefined
        }
      />
      {uploading && progress.total > 0 ? (
        <span className="text-mono-xs text-fg-muted">
          {format.bytes(progress.uploaded)} / {format.bytes(progress.total)}
        </span>
      ) : null}
    </div>
  );
}

/** A notice under a form: success, a warning or a failure. */
export function Notice({
  tone,
  children,
}: {
  tone: "success" | "warm" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex flex-col items-start gap-8 rounded-md border p-12 text-body-sm text-fg",
        // No success border token exists; the subtle fill carries the tone.
        tone === "success"
          ? "border-line bg-success-subtle"
          : tone === "warm"
            ? "border-line-warm bg-warm-subtle"
            : "border-line-danger bg-danger-subtle",
      )}
    >
      {children}
    </div>
  );
}

/**
 * A code of the core as a sentence, or the code itself when no key exists.
 *
 * The draft check and the install name their issues and warnings by code,
 * and the core may add one before its key does. The dynamic key is confined
 * here, behind `exists`, the way `src/i18n/errors.ts` confines the error
 * codes.
 */
export function useCodeText(
  prefix: "editor.issue" | "details.install.warning",
): (code: string, values?: Record<string, unknown>) => string {
  const { t } = useTranslation("bundles");
  const loose = t as unknown as (key: string, values?: Record<string, unknown>) => string;
  return (code, values) => {
    const key = `${prefix}.${code}`;
    // The values go to `exists` as well: a key with plural forms alone is
    // found only when a count is there to pick one.
    return i18next.exists(key, { ns: "bundles", ...values }) ? loose(key, values) : code;
  };
}
