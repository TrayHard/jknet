import { Package, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { onlineErrorCode, type BundleDetails, type BundleVersionSummary } from "../../lib/ipc";
import {
  useBundleDrafts,
  useCreateBundleDraftFromBundle,
  useDeleteBundle,
  useMyBundles,
} from "../../lib/queries";
import { EngineLogo } from "../EngineLogo";
import { Badge, Button, Dialog, EmptyState } from "../ui";
import { useBasedOnLine, useEngineName } from "./bundleFiles";

interface MyBundlesDialogProps {
  onClose: () => void;
  /** Opens the record of one bundle in the details dialog. */
  onOpen: (bundleId: string) => void;
  /** Opens the editor on a draft bound to one bundle. */
  onEdit: (draftId: string) => void;
}

/**
 * --- slice: bundles ---
 *
 * The bundles of the signed-in account: every version with its status, the
 * storage used out of the quota, **Edit** and **Delete** behind a question.
 *
 * Every status is here, `draft` and `rejected` included: the catalogue shows
 * only what is published, and this list is where an author learns that a
 * version is still waiting for an administrator or was sent back with a note.
 *
 * **Edit** opens the draft bound to the bundle when this disk has one, and
 * makes one out of the latest version otherwise — which downloads its files,
 * so the button says it is working until the editor opens.
 */
export function MyBundlesDialog({ onClose, onOpen, onEdit }: MyBundlesDialogProps) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const engineName = useEngineName();
  const basedOn = useBasedOnLine();
  const mine = useMyBundles();
  const drafts = useBundleDrafts();
  const remove = useDeleteBundle();
  const createDraft = useCreateBundleDraftFromBundle();
  const [pendingDelete, setPendingDelete] = useState<BundleDetails | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const edit = (bundle: BundleDetails) => {
    setFailure(null);
    const existing = drafts.data?.find((draft) => draft.bundleId === bundle.id);
    if (existing) {
      onEdit(existing.id);
      return;
    }
    createDraft.mutate(
      { bundleId: bundle.id },
      {
        onSuccess: (draft) => onEdit(draft.id),
        onError: (e) => setFailure(errorText(e)),
      },
    );
  };

  return (
    <>
      <div inert={pendingDelete !== null}>
        <Dialog
          title={t("mine.title")}
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
          {mine.error ? (
            <p role="alert" className="text-body-sm text-fg-danger pt-12">
              {onlineErrorCode(mine.error) === "not_found"
                ? t("list.unsupported")
                : errorText(mine.error)}
            </p>
          ) : null}

          {mine.data ? (
            <div className="flex flex-col gap-16 pt-16 max-h-[60vh] overflow-y-auto pr-4">
              <p className="text-body-sm text-fg-muted">
                {t("mine.quota", {
                  used: format.bytes(mine.data.usedBytes),
                  quota: format.bytes(mine.data.quotaBytes),
                })}
              </p>
              {mine.data.bundles.length === 0 ? (
                <EmptyState icon={<Package size={24} />} title={t("mine.title")} text={t("mine.empty")} />
              ) : (
                <ul className="flex flex-col gap-12">
                  {mine.data.bundles.map((bundle) => {
                    const bound = drafts.data?.some((draft) => draft.bundleId === bundle.id) === true;
                    const editing = createDraft.isPending && createDraft.variables?.bundleId === bundle.id;
                    return (
                      <li
                        key={bundle.id}
                        className="flex flex-col gap-8 rounded-lg border border-line bg-surface p-12"
                      >
                        <div className="flex items-center gap-12">
                          <EngineLogo engineId={bundle.engineId} name={engineName(bundle.engineId)} size={32} />
                          <div className="flex-1 min-w-0 flex flex-col">
                            <button
                              type="button"
                              onClick={() => onOpen(bundle.id)}
                              title={t("mine.open", { name: bundle.name })}
                              className="text-body-md-medium text-fg text-left truncate cursor-pointer hover:text-fg-accent hover:underline"
                            >
                              {bundle.name}
                            </button>
                            <span className="text-body-sm text-fg-muted truncate">
                              {/* A bundle without a published version has no engines yet. */}
                              {bundle.components.length > 0
                                ? `${basedOn(bundle.components)} · `
                                : bundle.engineId
                                  ? `${engineName(bundle.engineId)} · `
                                  : ""}
                              {t("mine.versions", { count: bundle.versions.length })}
                              {" · "}
                              {t("details.likes", { count: bundle.likes })}
                              {" · "}
                              {t("details.installs", { count: bundle.installs })}
                            </span>
                          </div>
                          <Button
                            size="sm"
                            icon={<Pencil size={14} />}
                            disabled={createDraft.isPending}
                            title={bound ? t("mine.editHint") : t("mine.editHintFetch")}
                            onClick={() => edit(bundle)}
                          >
                            {editing ? t("mine.editing") : t("mine.edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Trash2 size={14} />}
                            disabled={remove.isPending}
                            onClick={() => setPendingDelete(bundle)}
                          >
                            {t("mine.delete")}
                          </Button>
                        </div>
                        {bundle.versions.length > 0 ? (
                          <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
                            {bundle.versions.map((version) => (
                              <VersionLine key={version.id} version={version} />
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : mine.isLoading ? (
            <p className="text-body-sm text-fg-muted pt-16">{tCommon("states.loading")}</p>
          ) : null}
        </Dialog>
      </div>

      {pendingDelete !== null ? (
        <Dialog
          title={t("mine.confirmTitle", { bundle: pendingDelete.name })}
          body={t("mine.confirmBody")}
          variant="danger"
          onClose={() => setPendingDelete(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  setFailure(null);
                  remove.mutate(pendingDelete.id, {
                    onError: (e) => setFailure(errorText(e)),
                    onSettled: () => setPendingDelete(null),
                  });
                }}
              >
                {remove.isPending ? tCommon("states.deleting") : t("mine.confirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </>
  );
}

/** One version of one of my bundles: label, status, date, size, the reviewer's note. */
function VersionLine({ version }: { version: BundleVersionSummary }) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const tone =
    version.status === "published"
      ? "success"
      : version.status === "pending"
        ? "warm"
        : version.status === "rejected"
          ? "danger"
          : "neutral";
  return (
    <li className="flex flex-col gap-2 px-12 py-8">
      <div className="flex items-center gap-8 min-w-0">
        <span className="text-body-sm-medium text-fg truncate">{version.label}</span>
        <Badge tone={tone}>{t(`details.status.${version.status}`)}</Badge>
        <span className="text-mono-xs text-fg-muted shrink-0 ml-auto">
          {format.date(version.publishedAt ?? version.createdAt)}
        </span>
        <span className="text-mono-xs text-fg-muted shrink-0">
          {t("details.versionSize", { size: format.bytes(version.blobBytes), count: version.fileCount })}
        </span>
      </div>
      {version.reviewNote ? (
        <p className="text-body-sm text-fg-warm">{t("details.reviewNote", { note: version.reviewNote })}</p>
      ) : null}
    </li>
  );
}
