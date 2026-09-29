import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  FileCog,
  Files,
  Film,
  FolderOpen,
  Image,
  Import,
  Lock,
  Package,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
import {
  defaultClientPatch,
  resolveDefaultClientId,
  useGameNames,
} from "../lib/game";
import {
  clientEvents,
  type ClientImportFile,
  type ClientImportProgress,
  type ClientImportResult,
  type ClientImportSelection,
} from "../lib/ipc";
import {
  useImportClient,
  useInspectClientImport,
  useSettings,
  useUpdateSettings,
} from "../lib/queries";
import { isTauri } from "../lib/runtime";
import { Button, Input, Select, Toggle } from "./ui";

interface ImportClientDialogProps {
  onClose: () => void;
  onImported: (result: ClientImportResult) => void;
}

const ALL_SELECTED: ClientImportSelection = {
  screenshots: true,
  demos: true,
  configs: true,
  pk3: true,
  excludedConfigs: [],
  excludedPk3: [],
};

/** Copies a portable client folder into JKNet after showing what was found. */
export function ImportClientDialog({
  onClose,
  onImported,
}: ImportClientDialogProps) {
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const gameNames = useGameNames();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const importClient = useImportClient();

  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [fsGame, setFsGame] = useState("");
  const [launchArgs, setLaunchArgs] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [selection, setSelection] = useState<ClientImportSelection>(ALL_SELECTED);
  const [expandedFiles, setExpandedFiles] = useState<"required" | "configs" | "pk3" | null>(null);
  const [requiredSearch, setRequiredSearch] = useState("");
  const [configSearch, setConfigSearch] = useState("");
  const [pk3Search, setPk3Search] = useState("");
  const [upgradeEngine, setUpgradeEngine] = useState(true);
  const [deleteSource, setDeleteSource] = useState(false);
  const [pickFailure, setPickFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState<ClientImportProgress | null>(null);
  const activeRequest = useRef<string | null>(null);
  const inspection = useInspectClientImport(sourcePath);
  const preview = inspection.data;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<ClientImportProgress>(clientEvents.importProgress, (event) => {
      if (event.payload.requestId === activeRequest.current) {
        setProgress(event.payload);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Each picked folder starts from its own detected values. Edits made after
  // detection remain untouched until the player picks another folder.
  useEffect(() => {
    if (!preview) return;
    setName(preview.suggestedName);
    setFsGame(preview.recommendedFsGame ?? "");
    setMakeDefault(resolveDefaultClientId(settings.data, preview.game) === null);
    setSelection({ ...ALL_SELECTED, excludedConfigs: [], excludedPk3: [] });
    setExpandedFiles(null);
    setRequiredSearch("");
    setConfigSearch("");
    setPk3Search("");
    setUpgradeEngine(preview.canUpgradeEngine);
    setDeleteSource(false);
    setProgress(null);
  }, [
    preview?.sourcePath,
    preview?.suggestedName,
    preview?.recommendedFsGame,
    preview?.game,
    preview?.canUpgradeEngine,
    settings.data,
  ]);

  const modOptions = useMemo(
    () => [
      { value: "", label: t("importDialog.baseGame") },
      ...(preview?.modFolders ?? []).map((folder) => ({
        value: folder,
        label: folder,
      })),
    ],
    [preview?.modFolders, t],
  );

  const allSelected = selection.screenshots
    && selection.demos
    && selection.configs
    && selection.pk3
    && selection.excludedConfigs.length === 0
    && selection.excludedPk3.length === 0;
  const optionalCount = preview
    ? preview.screenshotCount + preview.demoCount + preview.configCount + preview.pk3Count
    : 0;
  const optionalBytes = preview
    ? preview.screenshotSizeBytes
      + preview.demoSizeBytes
      + preview.configSizeBytes
      + preview.pk3SizeBytes
    : 0;
  const requiredBytes = preview
    ? preview.requiredFiles.reduce((total, file) => total + file.sizeBytes, 0)
    : 0;
  const selectedOptionalCount = preview
    ? (selection.screenshots ? preview.screenshotCount : 0)
      + (selection.demos ? preview.demoCount : 0)
      + (selection.configs ? preview.configCount - selection.excludedConfigs.length : 0)
      + (selection.pk3 ? preview.pk3Count - selection.excludedPk3.length : 0)
    : 0;
  const selectedImportBytes = preview ? selectedBytes(preview, selection) : 0;

  const chooseFolder = async () => {
    setPickFailure(null);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: t("importDialog.pickTitle"),
      });
      if (typeof picked === "string") {
        setSourcePath(picked);
      }
    } catch (error) {
      setPickFailure(errorText(error));
    }
  };

  const canSubmit =
    preview !== undefined
    && name.trim().length > 0
    && (!deleteSource || allSelected);
  const submit = () => {
    if (!preview || !canSubmit) return;
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    setProgress({
      requestId,
      clientId: null,
      phase: "copy",
      processedBytes: 0,
      totalBytes: selectedBytes(preview, selection),
      currentFile: null,
    });
    importClient.mutate(
      {
        sourcePath: preview.sourcePath,
        name: name.trim(),
        fsGame: fsGame === "" ? null : fsGame,
        launchArgs,
        selection,
        deleteSource,
        upgradeEngine,
        requestId,
      },
      {
        onSuccess: (result) => {
          if (makeDefault) {
            updateSettings.mutate(defaultClientPatch(result.client));
          }
          onImported(result);
          onClose();
        },
      },
    );
  };

  const failure = pickFailure
    ?? (inspection.error ? errorText(inspection.error) : null)
    ?? (importClient.error ? errorText(importClient.error) : null);
  const busy = importClient.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-24"
      role="dialog"
      aria-modal="true"
      aria-label={t("importDialog.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
    >
      <div className="w-full max-w-[640px] max-h-[calc(100dvh-48px)] overflow-y-auto rounded-xl border border-line bg-surface p-24 shadow-popover">
        <h2 className="text-display-md text-fg">{t("importDialog.title")}</h2>
        <p className="text-body-sm text-fg-secondary pt-4">
          {t("importDialog.text")}
        </p>

        <label className="block text-label-xs text-fg-muted pt-24 pb-8">
          {t("importDialog.folder")}
        </label>
        <div className="flex items-center gap-8">
          <Input
            value={sourcePath ?? ""}
            readOnly
            placeholder={t("importDialog.folderPlaceholder")}
            icon={<FolderOpen size={16} />}
            className="flex-1"
          />
          <Button
            onClick={() => void chooseFolder()}
            disabled={!isTauri() || busy}
          >
            {t("importDialog.choose")}
          </Button>
        </div>
        <p className="text-body-sm text-fg-muted pt-8">
          {deleteSource
            ? t("importDialog.sourceDeleteEnabled")
            : t("importDialog.sourceUntouched")}
        </p>

        {inspection.isFetching ? (
          <p className="text-body-sm text-fg-muted pt-16">
            {t("importDialog.inspecting")}
          </p>
        ) : null}

        {preview ? (
          <>
            <div className="grid grid-cols-2 gap-8 pt-16">
              <ImportFact
                label={t("importDialog.detected")}
                value={`${preview.engineName} · ${gameNames.label(preview.game)}`}
              />
              <ImportFact
                icon={<Files size={14} />}
                label={t("importDialog.folderSize")}
                value={t("importDialog.fileSummary", {
                  count: format.number(preview.fileCount),
                  size: format.bytes(preview.sizeBytes),
                })}
              />
              <div className="col-span-2">
                <ImportFact
                  icon={<Import size={14} />}
                  label={t("importDialog.importSize")}
                  value={t("importDialog.fileSummary", {
                    count: format.number(preview.requiredFiles.length + selectedOptionalCount),
                    size: format.bytes(selectedImportBytes),
                  })}
                />
              </div>
            </div>

            <fieldset className="pt-20" disabled={busy}>
              <legend className="text-label-xs text-fg-muted pb-8">
                {t("importDialog.chooseContent")}
              </legend>
              <div className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
                <RequiredImportFiles
                  icon={<Lock size={15} />}
                  label={t("importDialog.requiredFiles")}
                  files={preview.requiredFiles}
                  expanded={expandedFiles === "required"}
                  search={requiredSearch}
                  searchPlaceholder={t("importDialog.searchRequired")}
                  noMatches={t("importDialog.noMatchingFiles")}
                  showFiles={t("importDialog.showFiles")}
                  hideFiles={t("importDialog.hideFiles")}
                  formatCount={format.number}
                  formatBytes={format.bytes}
                  onExpandedChange={(expanded) => {
                    setExpandedFiles(expanded ? "required" : null);
                  }}
                  onSearchChange={setRequiredSearch}
                />
                <ImportChoice
                  icon={<Files size={15} />}
                  label={t("importDialog.allContent")}
                  count={optionalCount}
                  bytes={optionalBytes}
                  checked={allSelected}
                  formatCount={format.number}
                  formatBytes={format.bytes}
                  onChange={(checked) => {
                    setSelection({
                      screenshots: checked,
                      demos: checked,
                      configs: checked,
                      pk3: checked,
                      excludedConfigs: [],
                      excludedPk3: [],
                    });
                    if (!checked) setDeleteSource(false);
                  }}
                />
                <ImportChoice
                  icon={<Film size={15} />}
                  label={t("importDialog.demos")}
                  count={preview.demoCount}
                  bytes={preview.demoSizeBytes}
                  checked={selection.demos}
                  formatCount={format.number}
                  formatBytes={format.bytes}
                  onChange={(checked) => {
                    setSelection((current) => ({ ...current, demos: checked }));
                    if (!checked) setDeleteSource(false);
                  }}
                />
                <ImportChoice
                  icon={<Image size={15} />}
                  label={t("importDialog.screenshots")}
                  count={preview.screenshotCount}
                  bytes={preview.screenshotSizeBytes}
                  checked={selection.screenshots}
                  formatCount={format.number}
                  formatBytes={format.bytes}
                  onChange={(checked) => {
                    setSelection((current) => ({ ...current, screenshots: checked }));
                    if (!checked) setDeleteSource(false);
                  }}
                />
                <ImportFileChoice
                  icon={<FileCog size={15} />}
                  label={t("importDialog.configs")}
                  files={preview.configFiles}
                  enabled={selection.configs}
                  excluded={selection.excludedConfigs}
                  expanded={expandedFiles === "configs"}
                  search={configSearch}
                  searchPlaceholder={t("importDialog.searchConfigs")}
                  noMatches={t("importDialog.noMatchingFiles")}
                  showFiles={t("importDialog.showFiles")}
                  hideFiles={t("importDialog.hideFiles")}
                  formatCount={format.number}
                  formatBytes={format.bytes}
                  onExpandedChange={(expanded) => {
                    setExpandedFiles(expanded ? "configs" : null);
                  }}
                  onSearchChange={setConfigSearch}
                  onChange={(enabled, excluded) => {
                    setSelection((current) => ({
                      ...current,
                      configs: enabled,
                      excludedConfigs: excluded,
                    }));
                    if (!enabled || excluded.length > 0) setDeleteSource(false);
                  }}
                />
                <ImportFileChoice
                  icon={<Package size={15} />}
                  label={t("importDialog.pk3")}
                  files={preview.pk3Files}
                  enabled={selection.pk3}
                  excluded={selection.excludedPk3}
                  expanded={expandedFiles === "pk3"}
                  search={pk3Search}
                  searchPlaceholder={t("importDialog.searchPk3")}
                  noMatches={t("importDialog.noMatchingFiles")}
                  showFiles={t("importDialog.showFiles")}
                  hideFiles={t("importDialog.hideFiles")}
                  formatCount={format.number}
                  formatBytes={format.bytes}
                  onExpandedChange={(expanded) => {
                    setExpandedFiles(expanded ? "pk3" : null);
                  }}
                  onSearchChange={setPk3Search}
                  onChange={(enabled, excluded) => {
                    setSelection((current) => ({
                      ...current,
                      pk3: enabled,
                      excludedPk3: excluded,
                    }));
                    if (!enabled || excluded.length > 0) setDeleteSource(false);
                  }}
                />
              </div>
              <p className="text-body-sm text-fg-muted pt-6">
                {t("importDialog.coreFilesAlways", {
                  count: format.number(preview.requiredFiles.length),
                  size: format.bytes(requiredBytes),
                })}
              </p>
            </fieldset>

            <label
              className="block text-label-xs text-fg-muted pt-20 pb-8"
              htmlFor="import-client-name"
            >
              {t("importDialog.name")}
            </label>
            <Input
              id="import-client-name"
              value={name}
              maxLength={48}
              autoFocus
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />

            <label className="block text-label-xs text-fg-muted pt-16 pb-8">
              {t("importDialog.modFolder")}
            </label>
            <Select
              value={fsGame}
              onChange={setFsGame}
              options={modOptions}
              disabled={busy}
              ariaLabel={t("importDialog.modFolder")}
              className="w-full"
            />

            <label
              className="block text-label-xs text-fg-muted pt-16 pb-8"
              htmlFor="import-client-args"
            >
              {t("importDialog.launchArgs")}
            </label>
            <Input
              id="import-client-args"
              value={launchArgs}
              placeholder={t("importDialog.launchArgsPlaceholder")}
              disabled={busy}
              onChange={(event) => setLaunchArgs(event.target.value)}
            />

            <div className="flex flex-col divide-y divide-line-subtle pt-12">
              <ImportOption
                icon={<RefreshCw size={16} />}
                label={t("importDialog.upgradeEngine")}
                text={t("importDialog.upgradeEngineText")}
                checked={upgradeEngine}
                disabled={!preview.canUpgradeEngine || busy}
                onChange={setUpgradeEngine}
              />
              <ImportOption
                icon={<Trash2 size={16} />}
                label={t("importDialog.deleteSource")}
                text={
                  allSelected
                    ? t("importDialog.deleteSourceText")
                    : t("importDialog.deleteSourceNeedsAll")
                }
                checked={deleteSource}
                disabled={!allSelected || busy}
                danger
                onChange={setDeleteSource}
              />
              <div className="flex items-center justify-between gap-16 py-12">
                <span className="flex flex-col">
                  <span className="text-body-md-medium text-fg">
                    {t("newDialog.makeDefault")}
                  </span>
                  <span className="text-body-sm text-fg-muted">
                    {t("newDialog.makeDefaultText")}
                  </span>
                </span>
                <Toggle
                  label={t("newDialog.makeDefaultSwitch")}
                  checked={makeDefault}
                  disabled={busy}
                  onChange={setMakeDefault}
                />
              </div>
            </div>
          </>
        ) : null}

        {busy && progress ? <ImportProgressView progress={progress} /> : null}

        {failure ? (
          <p role="alert" className="text-body-sm text-fg-danger pt-16 break-words">
            {failure}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-8 pt-24">
          <Button onClick={onClose} disabled={busy}>
            {tCommon("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            icon={<Import size={16} />}
            disabled={!canSubmit || busy}
            onClick={submit}
          >
            {busy ? t("importDialog.importing") : t("importDialog.import")}
          </Button>
        </div>
      </div>
    </div>
  );

  function ImportProgressView({ progress: value }: { progress: ClientImportProgress }) {
    const ratio =
      value.phase === "copy" && value.totalBytes > 0
        ? Math.min(1, value.processedBytes / value.totalBytes)
        : null;
    const label = t(`importDialog.progress.${value.phase}`);
    return (
      <div className="flex flex-col gap-6 pt-20" aria-live="polite">
        <div className="flex items-center justify-between gap-8">
          <span className="text-body-sm text-fg-secondary truncate" title={value.currentFile ?? undefined}>
            {value.currentFile ?? label}
          </span>
          <span className="text-mono-xs text-fg-muted shrink-0">
            {ratio === null
              ? label
              : `${format.bytes(value.processedBytes)} / ${format.bytes(value.totalBytes)}`}
          </span>
        </div>
        <div
          className="h-6 rounded-full bg-elevated overflow-hidden"
          role="progressbar"
          aria-label={label}
          aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={
              ratio === null
                ? "h-full w-full bg-accent animate-pulse"
                : "h-full bg-accent transition-[width] duration-200"
            }
            style={ratio === null ? undefined : { width: `${ratio * 100}%` }}
          />
        </div>
      </div>
    );
  }
}

function selectedBytes(
  preview: {
    screenshotSizeBytes: number;
    demoSizeBytes: number;
    configSizeBytes: number;
    pk3SizeBytes: number;
    configFiles: ClientImportFile[];
    pk3Files: ClientImportFile[];
    requiredFiles: ClientImportFile[];
  },
  selection: ClientImportSelection,
): number {
  const excludedConfigBytes = selectedFileBytes(
    preview.configFiles,
    selection.excludedConfigs,
  );
  const excludedPk3Bytes = selectedFileBytes(
    preview.pk3Files,
    selection.excludedPk3,
  );
  const requiredBytes = preview.requiredFiles.reduce(
    (total, file) => total + file.sizeBytes,
    0,
  );
  return requiredBytes
    + (selection.screenshots ? preview.screenshotSizeBytes : 0)
    + (selection.demos ? preview.demoSizeBytes : 0)
    + (selection.configs ? preview.configSizeBytes - excludedConfigBytes : 0)
    + (selection.pk3 ? preview.pk3SizeBytes - excludedPk3Bytes : 0);
}

function selectedFileBytes(files: ClientImportFile[], paths: string[]): number {
  const selected = new Set(paths);
  return files.reduce(
    (total, file) => total + (selected.has(file.path) ? file.sizeBytes : 0),
    0,
  );
}

function ImportFact({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-line bg-input p-12 min-w-0">
      <span className="flex items-center gap-6 text-label-xs text-fg-muted">
        {icon}
        {label}
      </span>
      <span className="block text-body-sm-medium text-fg pt-4 truncate" title={value}>
        {value}
      </span>
    </div>
  );
}

function ImportChoice({
  icon,
  label,
  count,
  bytes,
  checked,
  formatCount,
  formatBytes,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  bytes: number;
  checked: boolean;
  formatCount: (value: number) => string;
  formatBytes: (value: number) => string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-10 px-12 py-10 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-16 shrink-0 accent-accent cursor-pointer disabled:cursor-not-allowed"
      />
      <span className="text-fg-muted shrink-0">{icon}</span>
      <span className="text-body-sm text-fg flex-1">{label}</span>
      <span className="text-mono-xs text-fg-muted shrink-0">
        {formatCount(count)} · {formatBytes(bytes)}
      </span>
    </label>
  );
}

function RequiredImportFiles({
  icon,
  label,
  files,
  expanded,
  search,
  searchPlaceholder,
  noMatches,
  showFiles,
  hideFiles,
  formatCount,
  formatBytes,
  onExpandedChange,
  onSearchChange,
}: {
  icon: ReactNode;
  label: string;
  files: ClientImportFile[];
  expanded: boolean;
  search: string;
  searchPlaceholder: string;
  noMatches: string;
  showFiles: string;
  hideFiles: string;
  formatCount: (value: number) => string;
  formatBytes: (value: number) => string;
  onExpandedChange: (expanded: boolean) => void;
  onSearchChange: (value: string) => void;
}) {
  const query = search.trim().toLocaleLowerCase().replace(/\\/g, "/");
  const visible = query.length === 0
    ? files
    : files.filter((file) => file.path.toLocaleLowerCase().includes(query));
  const bytes = files.reduce((total, file) => total + file.sizeBytes, 0);

  return (
    <div>
      <div className="flex items-center gap-6 px-12 py-10">
        <div className="flex items-center gap-10 min-w-0 flex-1">
          <span className="flex size-16 shrink-0 items-center justify-center text-fg-muted">
            {icon}
          </span>
          <span className="text-body-sm text-fg flex-1">{label}</span>
          <span className="text-mono-xs text-fg-muted shrink-0">
            {formatCount(files.length)} · {formatBytes(bytes)}
          </span>
        </div>
        <button
          type="button"
          disabled={files.length === 0}
          className="flex h-24 shrink-0 items-center justify-center gap-3 rounded-sm px-6 text-label-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
          aria-label={expanded ? hideFiles : showFiles}
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span>{expanded ? hideFiles : showFiles}</span>
          <ChevronDown
            size={15}
            className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
          />
        </button>
      </div>
      {expanded ? (
        <div className="border-t border-line-subtle bg-input px-12 py-10">
          <Input
            value={search}
            icon={<Search size={14} />}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <div className="mt-8 max-h-160 overflow-y-auto rounded-sm border border-line-subtle bg-surface">
            {visible.length > 0 ? (
              visible.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center gap-8 border-b border-line-subtle px-10 py-8 last:border-b-0"
                  title={file.path}
                >
                  <span className="min-w-0 flex-1 truncate text-mono-xs text-fg-secondary">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-mono-xs text-fg-muted">
                    {formatBytes(file.sizeBytes)}
                  </span>
                </div>
              ))
            ) : (
              <p className="px-10 py-12 text-body-sm text-fg-muted">{noMatches}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ImportFileChoice({
  icon,
  label,
  files,
  enabled,
  excluded,
  expanded,
  search,
  searchPlaceholder,
  noMatches,
  showFiles,
  hideFiles,
  formatCount,
  formatBytes,
  onExpandedChange,
  onSearchChange,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  files: ClientImportFile[];
  enabled: boolean;
  excluded: string[];
  expanded: boolean;
  search: string;
  searchPlaceholder: string;
  noMatches: string;
  showFiles: string;
  hideFiles: string;
  formatCount: (value: number) => string;
  formatBytes: (value: number) => string;
  onExpandedChange: (expanded: boolean) => void;
  onSearchChange: (value: string) => void;
  onChange: (enabled: boolean, excluded: string[]) => void;
}) {
  const excludedSet = new Set(excluded);
  const selected = enabled
    ? files.filter((file) => !excludedSet.has(file.path))
    : [];
  const checked = enabled && selected.length === files.length;
  const indeterminate = selected.length > 0 && selected.length < files.length;
  const query = search.trim().toLocaleLowerCase().replace(/\\/g, "/");
  const visible = query.length === 0
    ? files
    : files.filter((file) => file.path.toLocaleLowerCase().includes(query));
  const selectedBytes = selected.reduce((total, file) => total + file.sizeBytes, 0);

  const setFileChecked = (path: string, include: boolean) => {
    const selectedPaths = new Set(selected.map((file) => file.path));
    if (include) selectedPaths.add(path);
    else selectedPaths.delete(path);
    if (selectedPaths.size === 0) {
      onChange(false, []);
      return;
    }
    onChange(
      true,
      files
        .filter((file) => !selectedPaths.has(file.path))
        .map((file) => file.path),
    );
  };

  return (
    <div>
      <div className="flex items-center gap-6 px-12 py-10">
        <label className="flex items-center gap-10 min-w-0 flex-1 cursor-pointer">
          <IndeterminateCheckbox
            checked={checked}
            indeterminate={indeterminate}
            onChange={(value) => onChange(value, [])}
          />
          <span className="text-fg-muted shrink-0">{icon}</span>
          <span className="text-body-sm text-fg flex-1">{label}</span>
          <span className="text-mono-xs text-fg-muted shrink-0">
            {formatCount(selected.length)} / {formatCount(files.length)} · {formatBytes(selectedBytes)}
          </span>
        </label>
        <button
          type="button"
          disabled={files.length === 0}
          className="flex h-24 shrink-0 items-center justify-center gap-3 rounded-sm px-6 text-label-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
          aria-label={expanded ? hideFiles : showFiles}
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span>{expanded ? hideFiles : showFiles}</span>
          <ChevronDown
            size={15}
            className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
          />
        </button>
      </div>
      {expanded ? (
        <div className="border-t border-line-subtle bg-input px-12 py-10">
          <Input
            value={search}
            icon={<Search size={14} />}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <div className="mt-8 max-h-160 overflow-y-auto rounded-sm border border-line-subtle bg-surface">
            {visible.length > 0 ? (
              visible.map((file) => (
                <label
                  key={file.path}
                  className="flex items-center gap-8 border-b border-line-subtle px-10 py-8 last:border-b-0 cursor-pointer"
                  title={file.path}
                >
                  <input
                    type="checkbox"
                    checked={enabled && !excludedSet.has(file.path)}
                    onChange={(event) => setFileChecked(file.path, event.target.checked)}
                    className="size-14 shrink-0 accent-accent cursor-pointer"
                  />
                  <span className="min-w-0 flex-1 truncate text-mono-xs text-fg-secondary">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-mono-xs text-fg-muted">
                    {formatBytes(file.sizeBytes)}
                  </span>
                </label>
              ))
            ) : (
              <p className="px-10 py-12 text-body-sm text-fg-muted">{noMatches}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="size-16 shrink-0 accent-accent cursor-pointer disabled:cursor-not-allowed"
    />
  );
}

function ImportOption({
  icon,
  label,
  text,
  checked,
  disabled,
  danger = false,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  text: string;
  checked: boolean;
  disabled: boolean;
  danger?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={
        disabled
          ? "flex items-start gap-10 py-12 cursor-not-allowed opacity-70"
          : "flex items-start gap-10 py-12 cursor-pointer"
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-16 mt-2 shrink-0 accent-accent cursor-pointer disabled:cursor-not-allowed"
      />
      <span className={danger ? "text-fg-danger mt-1" : "text-fg-muted mt-1"}>{icon}</span>
      <span className="flex flex-col">
        <span className={danger ? "text-body-md-medium text-fg-danger" : "text-body-md-medium text-fg"}>
          {label}
        </span>
        <span className="text-body-sm text-fg-muted">{text}</span>
      </span>
    </label>
  );
}
