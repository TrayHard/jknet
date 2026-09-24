import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import {
  virusTotalUrl,
  type BundleComponent,
  type BundleConfig,
  type BundleFile,
  type BundleManifest,
} from "../../lib/ipc";
import { EngineLogo } from "../EngineLogo";
import { FeatureBadges } from "../library/FeatureBadges";
import { Badge } from "../ui";
import { FileActions, type FileActionsOrigin } from "./FileActions";
import {
  ExternalAnchor,
  FileKindBadge,
  FileSourceBadge,
  ModeBadges,
  Notice,
  Section,
  fileNameInGroup,
  groupFiles,
  isExecutable,
  overlaySummary,
  useEngineName,
  useGroupLabel,
} from "./bundleFiles";

/**
 * Where the files of the manifest can be looked into: a published version,
 * or the draft the manifest was built from. Without it the rows offer no
 * **Contents** and no **Preview**.
 */
export type ManifestSource =
  | { kind: "bundle"; bundleId: string; versionId: string }
  | { kind: "draft"; draftId: string };

/** The origin of the rows of one scope, out of the source of the manifest. */
function originOf(source: ManifestSource | undefined, scope: string): FileActionsOrigin | null {
  if (source === undefined) return null;
  return source.kind === "draft"
    ? { kind: "draft", draftId: source.draftId, scope }
    : { kind: "bundle", bundleId: source.bundleId, versionId: source.versionId, scope };
}

interface BundleManifestViewProps {
  manifest: BundleManifest;
  /**
   * Whether this build knows the engine of each component, by component id;
   * a component missing from the map is read as known. The record of the
   * catalogue gets it from `get_bundle`, the preview of the editor from the
   * registry.
   */
  engineKnown?: Record<string, boolean>;
  /** What the files can be looked into as; see `ManifestSource`. */
  source?: ManifestSource;
}

/**
 * --- slice: bundles ---
 *
 * The body of a bundle as a player reads it: one block per component —
 * engine, modes, what is laid over the release, the files of `home\`, the
 * configs and the launch line — then the shared files and configs.
 *
 * One component for the record in the catalogue and for the **Preview**
 * section of the editor, which hands it the manifest the draft would
 * publish as: what the author sees is what the player will.
 */
export function BundleManifestView({ manifest, engineKnown, source }: BundleManifestViewProps) {
  const { t } = useTranslation("bundles");
  return (
    <>
      {manifest.components.map((component) => (
        <ComponentBlock
          key={component.id}
          component={component}
          single={manifest.components.length === 1}
          known={engineKnown?.[component.id] !== false}
          origin={originOf(source, component.id)}
        />
      ))}

      {manifest.shared.files.length > 0 ? (
        <Section heading={t("details.sharedFiles")}>
          <FileGroups files={manifest.shared.files} origin={originOf(source, "shared")} />
        </Section>
      ) : null}

      {manifest.shared.configs.length > 0 ? (
        <Section heading={t("details.sharedConfigs")}>
          <ConfigList configs={manifest.shared.configs} />
        </Section>
      ) : null}
    </>
  );
}

/** One component: its engine and modes, its overlay, its files, its configs, its launch line. */
function ComponentBlock({
  component,
  single,
  known,
  origin,
}: {
  component: BundleComponent;
  /** True when the bundle has this one component: the heading says so instead of the label. */
  single: boolean;
  known: boolean;
  /** Where the files of this component can be looked into, or `null` for nowhere. */
  origin: FileActionsOrigin | null;
}) {
  const { t } = useTranslation("bundles");
  const engineName = useEngineName();
  const name = engineName(component.engine.engineId);
  const overlay = component.overlay;
  const { replaced, added, removed } = overlaySummary(overlay);
  const hasOverlay = overlay.files.length > 0 || removed > 0;

  return (
    <Section
      heading={single ? t("details.component") : t("details.componentNamed", { label: component.label })}
    >
      <div className="flex flex-col gap-12 rounded-lg border border-line-subtle p-12">
        {/* Engine, tag and modes on one row. */}
        <div className="flex items-center gap-12">
          <EngineLogo engineId={component.engine.engineId} name={name} size={32} />
          <div className="flex-1 min-w-0 flex flex-col">
            <span className="text-body-md-medium text-fg truncate">{name}</span>
            <span className="text-body-sm text-fg-muted">
              {component.engine.releaseTag
                ? t("details.engineRelease", { tag: component.engine.releaseTag })
                : t("details.engineLatest")}
            </span>
          </div>
          <div className="flex items-center gap-6">
            <ModeBadges modes={component.modes} />
          </div>
        </div>
        {!known ? (
          <Notice tone="warm">{t("details.engineUnknown", { engine: name })}</Notice>
        ) : null}

        {/* The overlay: a line with the counts, and the files on demand. */}
        {hasOverlay ? (
          <OverlayBlock
            files={overlay.files}
            remove={overlay.remove}
            replaced={replaced}
            added={added}
            removed={removed}
            origin={origin}
          />
        ) : (
          <p className="text-body-sm text-fg-muted">{t("details.noOverlay")}</p>
        )}

        {/* Files of home\ by folder. */}
        {component.files.length > 0 ? (
          <FileGroups files={component.files} origin={origin} />
        ) : (
          <p className="text-body-sm text-fg-muted">{t("details.noFiles")}</p>
        )}

        {component.configs.length > 0 ? (
          <div className="flex flex-col gap-4">
            <span className="text-body-sm-medium text-fg-secondary">{t("details.configs")}</span>
            <ConfigList configs={component.configs} />
          </div>
        ) : null}

        {/* Launch: the mod folder and the arguments. */}
        <div className="flex flex-col gap-2">
          <span className="text-body-sm-medium text-fg-secondary">{t("details.launch")}</span>
          <p className="text-mono-sm text-fg">
            {component.fsGame
              ? t("details.fsGame", { folder: component.fsGame })
              : t("details.fsGameBase")}
          </p>
          {component.launchArgs.trim() === "" ? (
            <span className="text-body-sm text-fg-muted">{t("details.noLaunchArgs")}</span>
          ) : (
            <span className="text-mono-sm text-fg break-all">{component.launchArgs}</span>
          )}
        </div>
      </div>
    </Section>
  );
}

/** «Replaced 5 · Added 2 · Removed 1», and the list of overlay files under it. */
function OverlayBlock({
  files,
  remove,
  replaced,
  added,
  removed,
  origin,
}: {
  files: BundleFile[];
  remove: string[];
  replaced: number;
  added: number;
  removed: number;
  origin: FileActionsOrigin | null;
}) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const line = [
    t("details.overlay.replaced", { count: replaced }),
    t("details.overlay.added", { count: added }),
    t("details.overlay.removed", { count: removed }),
  ].join(" · ");

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-6 text-body-sm text-fg-secondary hover:text-fg cursor-pointer select-none self-start"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{t("details.overlay.line", { summary: line })}</span>
      </button>
      {open ? (
        <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
          {files.map((file) => (
            <li key={file.path} className="flex flex-col gap-4 px-12 py-8">
              <div className="flex items-center gap-8 min-w-0">
                <span className="text-mono-sm text-fg truncate flex-1 min-w-0" title={file.path}>
                  {file.path}
                </span>
                <Badge tone={file.replaces ? "accent" : "success"} className="shrink-0">
                  {file.replaces ? t("details.overlay.replacedOne") : t("details.overlay.addedOne")}
                </Badge>
                <FileKindBadge file={file} />
                <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right">
                  {format.bytes(file.size)}
                </span>
                {origin ? <FileActions file={file} origin={origin} /> : null}
              </div>
              <HashLine sha256={file.sha256} executable={isExecutable(file.kind)} />
              {file.replaces ? (
                <span className="flex flex-wrap items-center gap-8 text-mono-xs text-fg-muted">
                  <span className="shrink-0">{t("details.overlay.replacesHash")}</span>
                  <span className="break-all">{file.replaces.sha256}</span>
                </span>
              ) : null}
            </li>
          ))}
          {remove.map((path) => (
            <li key={`remove:${path}`} className="flex items-center gap-8 px-12 py-8 min-w-0">
              <span className="text-mono-sm text-fg-muted line-through truncate flex-1 min-w-0" title={path}>
                {path}
              </span>
              <Badge tone="danger" className="shrink-0">
                {t("details.overlay.removedOne")}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The hash of a file, with the warning and the VirusTotal link of an executable. */
function HashLine({ sha256, executable }: { sha256: string; executable: boolean }) {
  const { t } = useTranslation("bundles");
  return (
    <div className="flex flex-col gap-4">
      {executable ? (
        <span className="flex items-start gap-6 text-body-sm text-fg-warm">
          <AlertTriangle size={14} className="shrink-0 mt-2" aria-hidden />
          {t("details.executableWarning")}
        </span>
      ) : null}
      <span className="flex flex-wrap items-center gap-8 text-mono-xs text-fg-muted">
        <span className="shrink-0">{t("details.sha256")}</span>
        <span className="break-all text-fg-secondary">{sha256}</span>
        {executable ? (
          <ExternalAnchor href={virusTotalUrl(sha256)} className="text-fg-accent shrink-0">
            <ExternalLink size={12} aria-hidden />
            {t("details.virusTotal")}
          </ExternalAnchor>
        ) : null}
      </span>
    </div>
  );
}

/** The files of `home\` grouped by folder, each with its badges. */
export function FileGroups({ files, origin = null }: { files: BundleFile[]; origin?: FileActionsOrigin | null }) {
  const groupLabel = useGroupLabel();
  return (
    <>
      {groupFiles(files).map((group) => (
        <div key={group.key} className="flex flex-col gap-4">
          <span className="text-body-sm-medium text-fg-secondary">{groupLabel(group)}</span>
          <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
            {group.files.map((file) => (
              <FileRow key={`${file.root}/${file.path}`} file={file} origin={origin} />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * One file of the manifest: name, kind, source, size, and what opens under it.
 *
 * A pk3 opens on its folders and maps; an executable stands with its warning
 * and its hash open from the start, because that is the line a player has to
 * read before pressing **Install**. A JKHub file the author changed says so:
 * the store serves it, and the original is one link away.
 */
function FileRow({ file, origin }: { file: BundleFile; origin: FileActionsOrigin | null }) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const name = fileNameInGroup(file);
  const expandable = file.kind === "pk3" && file.library != null;
  const executable = isExecutable(file.kind);

  return (
    <li className="flex flex-col gap-6 px-12 py-8">
      <div className="flex items-center gap-8 min-w-0">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={open ? t("details.hideContents", { file: name }) : t("details.showContents", { file: name })}
            className="inline-flex size-20 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:text-fg cursor-pointer select-none"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="size-20 shrink-0" aria-hidden="true" />
        )}
        <span className="text-mono-sm text-fg truncate flex-1 min-w-0" title={file.path}>
          {file.library?.displayName && file.library.displayName !== name ? (
            <>
              {file.library.displayName}
              <span className="text-fg-muted"> · {name}</span>
            </>
          ) : (
            name
          )}
        </span>
        <FileKindBadge file={file} />
        <FileSourceBadge source={file.source} />
        {file.origin?.modified ? (
          <Badge
            tone="warm"
            className="shrink-0"
            title={t("details.modifiedOrigin", { id: file.origin.fileId })}
          >
            {t("details.modified")}
          </Badge>
        ) : null}
        <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right">{format.bytes(file.size)}</span>
        {origin ? <FileActions file={file} origin={origin} /> : null}
      </div>
      {/* --- slice: pk3 contents --- what the pk3 holds beside its category, on a line of its own: the row above has no room. */}
      {file.library?.features?.length ? <FeatureBadges features={file.library.features} className="pl-28" /> : null}

      {expandable && open && file.library ? (
        <div className="flex flex-col gap-4 pl-28 text-body-sm text-fg-secondary">
          <span className="text-fg-muted">{t("details.entries", { count: file.library.entries })}</span>
          {Object.keys(file.library.folders).length > 0 ? (
            <ul className="flex flex-wrap gap-6">
              {Object.entries(file.library.folders).map(([folder, count]) => (
                <li key={folder}>
                  <Badge tone="neutral">
                    <span className="text-mono-xs normal-case tracking-normal">{folder}/</span>
                    <span>{t("details.folderCount", { count })}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {file.library.maps.length > 0 ? (
            <span>
              <span className="text-fg-muted">{t("details.maps")}: </span>
              <span className="text-mono-xs">{file.library.maps.join(", ")}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {executable ? (
        <div className="pl-28">
          <HashLine sha256={file.sha256} executable />
        </div>
      ) : null}
    </li>
  );
}

/** The config documents of a component or of the shared part, text on demand. */
function ConfigList({ configs }: { configs: BundleConfig[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
      {configs.map((config, index) => (
        <ConfigRow key={`${index}-${config.name}`} config={config} />
      ))}
    </ul>
  );
}

/** One config document: its name and priority, and its text on demand. */
function ConfigRow({ config }: { config: BundleConfig }) {
  const { t } = useTranslation("bundles");
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-6 px-12 py-8">
      <div className="flex items-center gap-8 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? t("details.hideConfig", { name: config.name }) : t("details.showConfig", { name: config.name })}
          className="inline-flex size-20 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:text-fg cursor-pointer select-none"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-body-sm text-fg truncate flex-1 min-w-0">{config.name}</span>
        <span className="text-mono-xs text-fg-muted shrink-0">
          {t("details.configPriority", { priority: config.priority })}
        </span>
      </div>
      {open ? (
        <pre className="ml-28 max-h-[240px] overflow-auto rounded-md bg-input p-8 text-mono-xs text-fg whitespace-pre-wrap break-all">
          {config.text}
        </pre>
      ) : null}
    </li>
  );
}
