import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, FilePlus, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { cn } from "../../../lib/format";
import type { Draft, DraftComponent, DraftFile, ReleaseFile, ReleaseFileState } from "../../../lib/ipc";
import { useDraftEngineFiles, type DraftActions } from "../../../lib/queries";
import { isTauri } from "../../../lib/runtime";
import { Badge, Button, Select, type BadgeTone, type SelectOption } from "../../ui";
import { FileActions } from "../FileActions";
import { Notice } from "../bundleFiles";

/** The tone of each state: the untouched release has no badge at all. */
const STATE_TONES: Record<Exclude<ReleaseFileState, "release">, BadgeTone> = {
  replaced: "accent",
  added: "success",
  removed: "danger",
};

/** The folder of a release path: everything before the last slash, empty at the root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * --- slice: bundles ---
 *
 * **Engine files**: the release archive of the component, file by file, with
 * what the overlay does to each.
 *
 * The list comes from `draft_engine_files`, which unpacks the archive out of
 * the cache or downloads it first, so the first open waits. Every row offers
 * what makes sense for its state: **Replace…** a release file with one from
 * the disk, **Exclude** it so the install deletes it, **Include** it again,
 * **Restore** a replacement or an addition. **Add files…** puts files from
 * the disk into the chosen folder of `engine\`. A pk3 or a cfg the overlay
 * adds or lays over the release offers **Contents** and **Preview** too:
 * the file is the draft's own, so the core can read it.
 */
export function EngineFilesTab({
  draft,
  component,
  actions,
}: {
  draft: Draft;
  component: DraftComponent;
  actions: DraftActions;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const view = useDraftEngineFiles(draft.id, component.id);
  const [folder, setFolder] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [failure, setFailure] = useState<string | null>(null);

  const files = useMemo(() => view.data?.files ?? [], [view.data]);
  const groups = useMemo(() => {
    const map = new Map<string, ReleaseFile[]>();
    for (const file of files) {
      const key = folderOf(file.path);
      const list = map.get(key);
      if (list) list.push(file);
      else map.set(key, [file]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);
  const folderOptions: SelectOption[] = [
    { value: "", label: t("editor.engineFiles.rootFolder") },
    ...groups
      .map(([key]) => key)
      .filter((key) => key !== "")
      .map((key) => ({ value: key, label: key })),
  ];

  const replaced = files.filter((file) => file.state === "replaced").length;
  const added = files.filter((file) => file.state === "added").length;
  const removed = files.filter((file) => file.state === "removed").length;
  const busy =
    actions.replaceEngineFile.isPending ||
    actions.addEngineFiles.isPending ||
    actions.excludeEngineFile.isPending ||
    actions.restoreEngineFile.isPending;

  const onError = (e: unknown) => setFailure(errorText(e));

  const replaceFile = async (path: string) => {
    if (!isTauri()) return;
    setFailure(null);
    try {
      const picked = await open({ multiple: false, title: t("editor.engineFiles.replaceTitle", { file: path }) });
      if (typeof picked !== "string") return;
      actions.replaceEngineFile.mutate({ componentId: component.id, path, sourcePath: picked }, { onError });
    } catch (e) {
      onError(e);
    }
  };

  const addFiles = async () => {
    if (!isTauri()) return;
    setFailure(null);
    try {
      const picked = await open({ multiple: true, title: t("editor.engineFiles.addTitle") });
      if (!Array.isArray(picked) || picked.length === 0) return;
      actions.addEngineFiles.mutate({ componentId: component.id, folder, paths: picked }, { onError });
    } catch (e) {
      onError(e);
    }
  };

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        <span className="text-body-sm text-fg-secondary flex-1 min-w-200">
          {view.data
            ? t("editor.engineFiles.summary", {
                replaced: t("details.overlay.replaced", { count: replaced }),
                added: t("details.overlay.added", { count: added }),
                removed: t("details.overlay.removed", { count: removed }),
              })
            : null}
        </span>
        <Select
          ariaLabel={t("editor.engineFiles.folder")}
          label={t("editor.engineFiles.folder")}
          options={folderOptions}
          value={folder}
          onChange={setFolder}
          size="sm"
          className="w-232"
        />
        <Button size="sm" icon={<FilePlus size={14} />} disabled={busy || !view.data} onClick={() => void addFiles()}>
          {t("editor.engineFiles.addFiles")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {failure}
        </p>
      ) : null}

      {view.isLoading ? (
        <p className="text-body-sm text-fg-muted">{t("editor.engineFiles.loading")}</p>
      ) : view.error ? (
        <Notice tone="danger">
          <span>{t("editor.engineFiles.failed")}</span>
          <span className="text-fg-secondary">{errorText(view.error)}</span>
          <Button size="sm" onClick={() => void view.refetch()}>
            {tCommon("actions.tryAgain")}
          </Button>
        </Notice>
      ) : (
        <div className="flex flex-col gap-8">
          {view.data?.releaseTag ? (
            <span className="text-body-sm text-fg-muted">
              {t("details.engineRelease", { tag: view.data.releaseTag })}
            </span>
          ) : null}
          {groups.map(([key, list]) => {
            const open = !collapsed.has(key);
            return (
              <div key={key} className="flex flex-col gap-4">
                <button
                  type="button"
                  onClick={() => toggleGroup(key)}
                  aria-expanded={open}
                  className="inline-flex items-center gap-6 text-body-sm-medium text-fg-secondary hover:text-fg cursor-pointer select-none self-start"
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="text-mono-sm normal-case">{key === "" ? t("editor.engineFiles.rootFolder") : `${key}/`}</span>
                  <span className="text-mono-xs text-fg-muted">{t("details.folderCount", { count: list.length })}</span>
                </button>
                {open ? (
                  <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
                    {list.map((file) => (
                      <ReleaseFileRow
                        key={file.path}
                        file={file}
                        overlay={component.overlay.files.find((entry) => entry.path === file.path) ?? null}
                        draftId={draft.id}
                        componentId={component.id}
                        busy={busy}
                        onReplace={() => void replaceFile(file.path)}
                        onExclude={(excluded) =>
                          actions.excludeEngineFile.mutate(
                            { componentId: component.id, path: file.path, excluded },
                            { onError },
                          )
                        }
                        onRestore={() =>
                          actions.restoreEngineFile.mutate({ componentId: component.id, path: file.path }, { onError })
                        }
                      />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One file of the release with its state and the actions its state allows. */
function ReleaseFileRow({
  file,
  overlay,
  draftId,
  componentId,
  busy,
  onReplace,
  onExclude,
  onRestore,
}: {
  file: ReleaseFile;
  /** The overlay file at this path — a replacement or an addition — or `null` for the release's own. */
  overlay: DraftFile | null;
  draftId: string;
  componentId: string;
  busy: boolean;
  onReplace: () => void;
  onExclude: (excluded: boolean) => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const state = file.state;
  return (
    <li className="flex items-center gap-8 px-12 py-6 min-w-0">
      <span
        className={cn(
          "text-mono-sm truncate flex-1 min-w-0",
          state === "removed" ? "text-fg-muted line-through" : "text-fg",
        )}
        title={`${file.path} · ${file.sha256}`}
      >
        {name}
      </span>
      {state !== "release" ? (
        <Badge tone={STATE_TONES[state]} className="shrink-0">
          {t(`editor.engineFiles.state.${state}`)}
        </Badge>
      ) : null}
      <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right">{format.bytes(file.size)}</span>
      {overlay ? <FileActions file={overlay} origin={{ kind: "draft", draftId, scope: componentId }} /> : null}
      <span className="flex items-center gap-4 shrink-0">
        {state === "release" || state === "replaced" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReplace}>
            {t("editor.engineFiles.replace")}
          </Button>
        ) : null}
        {state === "release" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onExclude(true)}>
            {t("editor.engineFiles.exclude")}
          </Button>
        ) : null}
        {state === "removed" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onExclude(false)}>
            {t("editor.engineFiles.include")}
          </Button>
        ) : null}
        {state === "replaced" || state === "added" ? (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} disabled={busy} onClick={onRestore}>
            {t("editor.engineFiles.restore")}
          </Button>
        ) : null}
      </span>
    </li>
  );
}
