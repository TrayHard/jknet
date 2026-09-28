import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Import, Image, Film, Files } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../i18n/errors";
import { useFormat } from "../i18n/useFormat";
import {
  defaultClientPatch,
  resolveDefaultClientId,
  useGameNames,
} from "../lib/game";
import type { ClientImportResult } from "../lib/ipc";
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
  const [pickFailure, setPickFailure] = useState<string | null>(null);
  const inspection = useInspectClientImport(sourcePath);
  const preview = inspection.data;

  // Each picked folder starts from its own detected values. Edits made after
  // detection remain untouched until the player picks another folder.
  useEffect(() => {
    if (!preview) return;
    setName(preview.suggestedName);
    setFsGame(preview.recommendedFsGame ?? "");
    setMakeDefault(
      resolveDefaultClientId(settings.data, preview.game) === null,
    );
  }, [preview?.sourcePath, preview?.suggestedName, preview?.recommendedFsGame, preview?.game, settings.data]);

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

  const canSubmit = preview !== undefined && name.trim().length > 0;
  const submit = () => {
    if (!preview || !canSubmit) return;
    importClient.mutate(
      {
        sourcePath: preview.sourcePath,
        name: name.trim(),
        fsGame: fsGame === "" ? null : fsGame,
        launchArgs,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-24"
      role="dialog"
      aria-modal="true"
      aria-label={t("importDialog.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !importClient.isPending) onClose();
      }}
    >
      <div className="w-full max-w-[560px] max-h-[calc(100dvh-48px)] overflow-y-auto rounded-xl border border-line bg-surface p-24 shadow-popover">
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
            disabled={!isTauri() || importClient.isPending}
          >
            {t("importDialog.choose")}
          </Button>
        </div>
        <p className="text-body-sm text-fg-muted pt-8">
          {t("importDialog.sourceUntouched")}
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
                label={t("importDialog.files")}
                value={t("importDialog.fileSummary", {
                  count: format.number(preview.fileCount),
                  size: format.bytes(preview.sizeBytes),
                })}
              />
              <ImportFact
                icon={<Image size={14} />}
                label={t("importDialog.screenshots")}
                value={format.number(preview.screenshotCount)}
              />
              <ImportFact
                icon={<Film size={14} />}
                label={t("importDialog.demos")}
                value={format.number(preview.demoCount)}
              />
            </div>

            <label
              className="block text-label-xs text-fg-muted pt-24 pb-8"
              htmlFor="import-client-name"
            >
              {t("importDialog.name")}
            </label>
            <Input
              id="import-client-name"
              value={name}
              maxLength={48}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />

            <label className="block text-label-xs text-fg-muted pt-16 pb-8">
              {t("importDialog.modFolder")}
            </label>
            <Select
              value={fsGame}
              onChange={setFsGame}
              options={modOptions}
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
              onChange={(event) => setLaunchArgs(event.target.value)}
            />

            <div className="flex items-center justify-between gap-16 pt-20">
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
                onChange={setMakeDefault}
              />
            </div>
          </>
        ) : null}

        {failure ? (
          <p role="alert" className="text-body-sm text-fg-danger pt-16 break-words">
            {failure}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-8 pt-24">
          <Button onClick={onClose} disabled={importClient.isPending}>
            {tCommon("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            icon={<Import size={16} />}
            disabled={!canSubmit || importClient.isPending}
            onClick={submit}
          >
            {importClient.isPending
              ? t("importDialog.importing")
              : t("importDialog.import")}
          </Button>
        </div>
      </div>
    </div>
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
