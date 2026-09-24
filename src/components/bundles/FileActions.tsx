import { Eye, ListTree } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { BundleFileSource } from "../../lib/ipc";
import { useBundlePreviewProgress, useJkhubDownloadProgress } from "../../lib/queries";
import { isTauri } from "../../lib/runtime";
import { FilePreviewDialog, type PreviewTarget } from "../library/FilePreviewDialog";
import { Button } from "../ui";
import { FileListingDialog, fileName, hasContents, type ContentsFile } from "./FileListingDialog";

/**
 * Where the file lives: a draft on this disk, or a published version. The
 * `scope` is the component id, or `shared`.
 */
export type FileActionsOrigin =
  | { kind: "draft"; draftId: string; scope: string }
  | { kind: "bundle"; bundleId: string; versionId: string; scope: string };

/** A file with, when it comes from a manifest, the source an install fetches it from. */
export interface ActionFile extends ContentsFile {
  source?: BundleFileSource;
}

/**
 * --- slice: bundles ---
 *
 * The two ways to look inside a file of a bundle, as icon buttons at the
 * end of its row: **Contents** lists what a pk3 holds or shows the text of
 * a cfg, **Preview** opens the objects of a pk3 — the characters, hilts,
 * weapons, maps and sounds — in the dialog the Library screen uses. A dll,
 * an exe and any other file offer neither. One component for the rows of
 * the editor and of the catalogue, so the two look inside a file the same
 * way.
 */
export function FileActions({ file, origin }: { file: ActionFile; origin: FileActionsOrigin }) {
  const { t } = useTranslation("bundles");
  const [contentsOpen, setContentsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const name = fileName(file.path);
  const contentsOrigin = origin.kind === "draft" ? origin : { kind: "bundle" as const };
  const contents = hasContents(file, contentsOrigin);
  const preview = file.kind === "pk3";
  if (!contents && !preview) return null;

  return (
    <>
      <span className="flex items-center gap-2 shrink-0">
        {contents ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<ListTree size={14} />}
            aria-label={t("contents.action", { file: name })}
            title={t("contents.action", { file: name })}
            className="px-6"
            onClick={() => setContentsOpen(true)}
          />
        ) : null}
        {preview ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Eye size={14} />}
            aria-label={t("contents.preview", { file: name })}
            title={isTauri() ? t("contents.preview", { file: name }) : t("contents.previewNeedsLauncher")}
            disabled={!isTauri()}
            className="px-6"
            onClick={() => setPreviewOpen(true)}
          />
        ) : null}
      </span>
      {contentsOpen ? (
        <FileListingDialog file={file} origin={contentsOrigin} onClose={() => setContentsOpen(false)} />
      ) : null}
      {previewOpen ? (
        <ObjectsPreview file={file} origin={origin} title={name} onClose={() => setPreviewOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * The preview of the objects of a pk3, with the bar of the download that
 * precedes it in the catalogue: the store reports through
 * `bundles:preview-progress` by hash, JKHub through `jkhub:download-progress`
 * by record. Mounted only while the dialog is open, so the rows of a long
 * list do not each listen for events.
 */
function ObjectsPreview({
  file,
  origin,
  title,
  onClose,
}: {
  file: ActionFile;
  origin: FileActionsOrigin;
  title: string;
  onClose: () => void;
}) {
  const store = useBundlePreviewProgress();
  const jkhub = useJkhubDownloadProgress();
  const target: PreviewTarget =
    origin.kind === "draft"
      ? { kind: "draft", draftId: origin.draftId, scope: origin.scope, root: file.root, path: file.path, title }
      : {
          kind: "bundle",
          bundleId: origin.bundleId,
          versionId: origin.versionId,
          scope: origin.scope,
          root: file.root,
          path: file.path,
          title,
        };
  const fromJkhub = file.source?.kind === "jkhub" ? jkhub.get(file.source.fileId) : undefined;
  const fromStore = store.get(file.sha256);
  const progress =
    origin.kind === "bundle"
      ? fromJkhub
        ? { received: fromJkhub.received, total: fromJkhub.total }
        : fromStore
          ? { received: fromStore.downloaded, total: fromStore.total }
          : null
      : null;
  return <FilePreviewDialog target={target} progress={progress} onClose={onClose} />;
}
