import { open } from "@tauri-apps/plugin-dialog";
import { FolderInput, Globe, HardDrive, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { clientsOfGame } from "../../../lib/game";
import { SHARED_SCOPE, type Draft, type DraftFile, type LibraryItem } from "../../../lib/ipc";
import { useClients, useLibrary, type DraftActions } from "../../../lib/queries";
import { isTauri } from "../../../lib/runtime";
import { FeatureBadges } from "../../library/FeatureBadges";
import { JkhubBrowser } from "../../library/JkhubBrowser";
import { Button, Dialog, Select, type SelectOption } from "../../ui";
import { FileActions } from "../FileActions";
import { FileKindBadge, FileOriginBadge, fileNameInGroup, groupFiles, useGroupLabel } from "../bundleFiles";
import { destinationFolders } from "./draftModel";

/**
 * --- slice: bundles ---
 *
 * **Files** of a component, or **Shared files** of the draft: the files of
 * `home\` by folder, and three ways to add one.
 *
 * A file goes into `base` or into the mod folder of the component, picked in
 * the bar. **Add from JKHub…** opens the catalogue in pick mode: the button of
 * a card adds the file, and the core downloads it with the same bar the
 * Library screen shows. **Add from disk…** takes any files; **Add from
 * client…** copies files of the library of one client with their origins, so
 * a JKHub file stays a JKHub link. Every pk3 offers **Contents**,
 * **Preview** and **Edit**, every cfg **Contents**, through `FileActions`.
 */
export function FilesTab({
  draft,
  scope,
  actions,
}: {
  draft: Draft;
  /** A component id, or `shared`. */
  scope: string;
  actions: DraftActions;
}) {
  const { t } = useTranslation("bundles");
  const errorText = useErrorText();
  const format = useFormat();
  const groupLabel = useGroupLabel();
  const [folder, setFolder] = useState("base");
  const [jkhubOpen, setJkhubOpen] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const files: DraftFile[] =
    scope === SHARED_SCOPE
      ? draft.shared.files
      : (draft.components.find((component) => component.id === scope)?.files ?? []);
  const folders = destinationFolders(draft, scope);
  const folderOptions: SelectOption[] = folders.map((entry) => ({ value: entry, label: entry }));
  const destination = folders.includes(folder) ? folder : (folders[0] ?? "base");
  const busy =
    actions.addFilesFromDisk.isPending ||
    actions.addFileFromJkhub.isPending ||
    actions.addFilesFromClient.isPending ||
    actions.removeFile.isPending;
  const onError = (e: unknown) => setFailure(errorText(e));

  // The JKHub records already in this scope, for the badge of pick mode.
  const pickedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const file of files) {
      if (file.origin.kind === "jkhub") ids.add(file.origin.fileId);
      if (file.origin.kind === "client" && file.origin.provenance) ids.add(file.origin.provenance.fileId);
    }
    return ids;
  }, [files]);

  const addFromDisk = async () => {
    if (!isTauri()) return;
    setFailure(null);
    try {
      const picked = await open({
        multiple: true,
        title: t("editor.files.diskTitle"),
        filters: [
          { name: t("editor.files.diskFilterPk3"), extensions: ["pk3"] },
          { name: t("editor.files.diskFilterAll"), extensions: ["*"] },
        ],
      });
      if (!Array.isArray(picked) || picked.length === 0) return;
      actions.addFilesFromDisk.mutate({ scope, folder: destination, paths: picked }, { onError });
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        <Select
          ariaLabel={t("editor.files.folder")}
          label={t("editor.files.folder")}
          options={folderOptions}
          value={destination}
          onChange={setFolder}
          size="sm"
          className="w-232"
        />
        <span className="flex-1" />
        <Button size="sm" icon={<Globe size={14} />} disabled={busy} onClick={() => setJkhubOpen(true)}>
          {t("editor.files.addJkhub")}
        </Button>
        <Button size="sm" icon={<HardDrive size={14} />} disabled={busy} onClick={() => void addFromDisk()}>
          {t("editor.files.addDisk")}
        </Button>
        <Button size="sm" icon={<FolderInput size={14} />} disabled={busy} onClick={() => setClientOpen(true)}>
          {t("editor.files.addClient")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {failure}
        </p>
      ) : null}

      {files.length === 0 ? (
        <p className="text-body-sm text-fg-muted">
          {scope === SHARED_SCOPE ? t("editor.files.emptyShared") : t("editor.files.empty")}
        </p>
      ) : (
        groupFiles(files).map((group) => (
          <div key={group.key} className="flex flex-col gap-4">
            <span className="text-body-sm-medium text-fg-secondary">{groupLabel(group)}</span>
            <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
              {group.files.map((file) => {
                const name = fileNameInGroup(file);
                return (
                  <li key={`${file.root}/${file.path}`} className="flex flex-col gap-4 px-12 py-6 min-w-0">
                    <div className="flex items-center gap-8 min-w-0">
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
                      <FileOriginBadge file={file} />
                      <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right">{format.bytes(file.size)}</span>
                      <FileActions file={file} origin={{ kind: "draft", draftId: draft.id, scope }} editable />
                      <button
                        type="button"
                        aria-label={t("editor.files.remove", { file: name })}
                        title={t("editor.files.remove", { file: name })}
                        disabled={busy}
                        onClick={() =>
                          actions.removeFile.mutate({ scope, root: file.root, path: file.path }, { onError })
                        }
                        className="inline-flex size-24 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:text-fg-danger cursor-pointer select-none disabled:cursor-not-allowed disabled:text-fg-disabled"
                      >
                        <X size={14} aria-hidden />
                      </button>
                    </div>
                    {/* --- slice: pk3 contents --- what the pk3 holds beside its category. */}
                    {file.library?.features?.length ? <FeatureBadges features={file.library.features} /> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      {jkhubOpen ? (
        <AddFromJkhubDialog
          draft={draft}
          pickedIds={pickedIds}
          busy={actions.addFileFromJkhub.isPending}
          onPick={(fileId) => {
            setFailure(null);
            actions.addFileFromJkhub.mutate({ scope, folder: destination, fileId }, { onError });
          }}
          onClose={() => setJkhubOpen(false)}
        />
      ) : null}

      {clientOpen ? (
        <AddFromClientDialog
          draft={draft}
          existing={files}
          busy={actions.addFilesFromClient.isPending}
          onAdd={(clientId, itemIds) => {
            setFailure(null);
            actions.addFilesFromClient.mutate(
              { scope, clientId, itemIds },
              {
                onError,
                onSuccess: () => setClientOpen(false),
              },
            );
          }}
          onClose={() => setClientOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The JKHub catalogue in pick mode, in a dialog as wide as the preview one.
 *
 * The browser draws its own rail, bar and grid; all the dialog adds is the
 * frame and **Done**. The download of a picked file runs in the core and
 * reports through the bar of the card, so the dialog can stay open while
 * the author picks the next one.
 */
function AddFromJkhubDialog({
  draft,
  pickedIds,
  busy,
  onPick,
  onClose,
}: {
  draft: Draft;
  pickedIds: ReadonlySet<number>;
  busy: boolean;
  onPick: (fileId: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const [search, setSearch] = useState("");
  return (
    <Dialog
      title={t("editor.files.jkhubTitle")}
      wide="preview"
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          {tCommon("actions.close")}
        </Button>
      }
    >
      <div className="pt-16">
        <JkhubBrowser
          clientId={null}
          clientName={draft.name}
          installed={[]}
          search={search}
          onSearch={setSearch}
          pick={{ label: t("editor.files.pick"), pickedLabel: t("editor.files.pickAgain"), pickedIds, busy, onPick }}
        />
      </div>
    </Dialog>
  );
}

/**
 * **Add from client…**: a client of the game and the files of its library.
 *
 * Files whose path this scope already holds are listed but locked: the core
 * would refuse the duplicate anyway, and a locked row says why before the
 * press. A disabled pk3 is offered too; it is the author's call.
 */
function AddFromClientDialog({
  draft,
  existing,
  busy,
  onAdd,
  onClose,
}: {
  draft: Draft;
  existing: DraftFile[];
  busy: boolean;
  onAdd: (clientId: string, itemIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const { t: tLibrary } = useTranslation("library");
  const errorText = useErrorText();
  const format = useFormat();
  const clients = useClients();
  const gameClients = clientsOfGame(clients.data, draft.game);
  const [pickedClient, setPickedClient] = useState<string | null>(null);
  const clientId = pickedClient ?? gameClients[0]?.id ?? null;
  const library = useLibrary(clientId);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());

  const taken = useMemo(() => new Set(existing.map((file) => file.path)), [existing]);
  const items = library.data ?? [];
  const pathOf = (item: LibraryItem) => `${item.folder}/${item.fileName}`;
  const chosen = items.filter((item) => ticked.has(item.id) && !taken.has(pathOf(item)));

  return (
    <Dialog
      title={t("editor.files.clientTitle")}
      wide
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || clientId === null || chosen.length === 0}
            onClick={() => clientId !== null && onAdd(clientId, chosen.map((item) => item.id))}
          >
            {busy ? tCommon("states.creating") : t("editor.files.clientAdd", { count: chosen.length })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12 pt-16">
        <Select
          ariaLabel={t("editor.files.clientPick")}
          label={t("editor.files.clientPick")}
          options={gameClients.map((client) => ({ value: client.id, label: client.name }))}
          value={clientId ?? ""}
          onChange={(value) => {
            setPickedClient(value);
            setTicked(new Set());
          }}
          placeholder={tCommon("select.nothingToChoose")}
          className="max-w-[360px]"
        />
        {library.error ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {errorText(library.error)}
          </p>
        ) : null}
        <div className="max-h-[50vh] overflow-y-auto pr-4">
          {library.isLoading ? (
            <p className="text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
          ) : items.length === 0 ? (
            <p className="text-body-sm text-fg-muted">{t("editor.files.clientEmpty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
              {items.map((item) => {
                const path = pathOf(item);
                const locked = taken.has(path);
                return (
                  <li key={item.id} className="flex items-center gap-8 px-12 py-6 min-w-0">
                    <input
                      type="checkbox"
                      checked={!locked && ticked.has(item.id)}
                      disabled={locked}
                      aria-label={t("editor.files.clientTick", { file: item.fileName })}
                      title={locked ? t("editor.files.clientTaken") : undefined}
                      onChange={(event) =>
                        setTicked((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        })
                      }
                      className="size-16 shrink-0 accent-accent cursor-pointer disabled:cursor-not-allowed"
                    />
                    <span className={`text-mono-sm truncate flex-1 min-w-0 ${locked ? "text-fg-muted" : "text-fg"}`} title={path}>
                      {item.displayName !== item.fileName ? (
                        <>
                          {item.displayName}
                          <span className="text-fg-muted"> · {path}</span>
                        </>
                      ) : (
                        path
                      )}
                    </span>
                    <span className="text-body-sm text-fg-muted shrink-0">
                      {tLibrary(`categoryOne.${item.category}`)}
                    </span>
                    {item.provenance ? (
                      <span className="text-mono-xs text-fg-purple shrink-0">{t("details.source.jkhub")}</span>
                    ) : null}
                    {!item.enabled ? (
                      <span className="text-mono-xs text-fg-muted shrink-0">{t("editor.files.clientDisabled")}</span>
                    ) : null}
                    <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right">{format.bytes(item.size)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
