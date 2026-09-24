import { open } from "@tauri-apps/plugin-dialog";
import { FilePlus, FolderOutput, FolderPlus, Pencil, Save, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { shortenPath } from "../../lib/format";
import type { Pk3EditorEntry, Pk3EditorTarget } from "../../lib/ipc";
import { usePk3EditorActions, usePk3EditorSession } from "../../lib/queries";
import { isTauri } from "../../lib/runtime";
import { useEscapeFirst } from "../bundles/bundleFiles";
import { Badge, Button, Dialog, Input, useContextMenu, type MenuItem } from "../ui";
import { Pk3EntryPanel, Pk3FolderPanel } from "./Pk3EntryPanel";
import { Pk3EntryTree } from "./Pk3EntryTree";
import {
  ancestorsOf,
  buildTree,
  findFolder,
  folderOf,
  folderPaths,
  isUnder,
  isValidEntryPath,
  isValidSegment,
  joinPath,
  tidyPath,
  wholeArchivePaths,
  type Pk3Selection,
} from "./pk3Tree";

/** Below this many entries the tree opens with every folder expanded. */
const EXPAND_ALL_BELOW = 40;

/** The extensions the file dialog offers for a picture, the formats the core converts between. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "tga"];

/** The small dialogs the editor opens over itself. */
type Prompt =
  | { kind: "rename"; target: Pk3Selection }
  | { kind: "newFolder"; parent: string }
  | { kind: "confirmClose" }
  | { kind: "confirmDiscard" };

interface Pk3EditorDialogProps {
  target: Pk3EditorTarget;
  /** The name of the archive, for the title. */
  title: string;
  onClose: () => void;
}

/**
 * --- slice: pk3 editor ---
 *
 * The editor of one pk3 archive: a file of a draft, or a file of the
 * library of a client.
 *
 * The core opens a session on the archive and keeps every edit beside it
 * until **Save**; the dialog shows the session as a tree of entries with
 * their states on the left and the picked entry on the right. Everything
 * that changes the archive is a command that answers with the session, so
 * the dialog holds only what the core cannot know: which row is picked,
 * which folders are open, the folders made and not filled yet, and the
 * texts typed and not applied. Closing with unsaved edits asks first;
 * closing ends the session, and with it the edits.
 */
export function Pk3EditorDialog({ target, title, onClose }: Pk3EditorDialogProps) {
  const { t } = useTranslation("pk3");
  const { t: common } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();

  const session = usePk3EditorSession(target);
  const sessionId = session.data?.id ?? null;
  const actions = usePk3EditorActions(target, sessionId);
  const entries = useMemo(() => session.data?.entries ?? [], [session.data]);
  const readOnly = session.data?.readOnly === true;

  const [selected, setSelected] = useState<Pk3Selection | null>(null);
  const [pendingFolders, setPendingFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [opened, setOpened] = useState<ReadonlySet<string> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const tree = useMemo(() => buildTree(entries, pendingFolders), [entries, pendingFolders]);
  // A short archive opens whole; a long one opens closed, and the player
  // opens what they came for.
  const expanded = useMemo<ReadonlySet<string>>(
    () => opened ?? new Set(entries.length < EXPAND_ALL_BELOW ? folderPaths(tree) : []),
    [opened, entries.length, tree],
  );
  const draftPaths = useMemo(() => new Set(drafts.keys()), [drafts]);

  const busy = Object.values(actions).some((mutation) => mutation.isPending);
  const locked = busy || readOnly || sessionId === null;
  const changes = entries.filter((entry) => entry.state !== "unchanged").length;
  const dirty = session.data?.dirty === true || drafts.size > 0;

  // A row that has gone — an added entry after **Discard**, a folder whose
  // last file was taken out — is no longer picked.
  useEffect(() => {
    if (selected === null) return;
    const stands =
      selected.kind === "entry"
        ? entries.some((entry) => entry.path === selected.path)
        : findFolder(tree, selected.path) !== null;
    if (!stands) setSelected(null);
  }, [selected, entries, tree]);

  const entryAt = (path: string): Pk3EditorEntry | undefined => entries.find((entry) => entry.path === path);

  const begin = () => {
    setFailure(null);
    setStatus(null);
  };
  const onError = (e: unknown) => setFailure(errorText(e));

  const openFolders = (paths: string[]) =>
    setOpened((current) => {
      const next = new Set(current ?? expanded);
      for (const path of paths) next.add(path);
      return next;
    });
  const toggleFolder = (path: string) =>
    setOpened((current) => {
      const next = new Set(current ?? expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** The folder a toolbar action works in: the picked folder, or the folder of the picked entry, or the root. */
  const currentFolder = selected === null ? "" : selected.kind === "folder" ? selected.path : folderOf(selected.path);

  const addFiles = async (folder: string) => {
    if (!isTauri()) return;
    begin();
    try {
      const picked = await open({
        multiple: true,
        title: folder === "" ? t("toolbar.addFilesRootTitle") : t("toolbar.addFilesTitle", { folder: `${folder}/` }),
      });
      if (!Array.isArray(picked) || picked.length === 0) return;
      actions.addFiles.mutate(
        { folder, sourcePaths: picked },
        {
          onError,
          onSuccess: () => openFolders([...ancestorsOf(joinPath(folder, "x")), ...(folder === "" ? [] : [folder])]),
        },
      );
    } catch (e) {
      onError(e);
    }
  };

  const replaceEntry = async (entry: Pk3EditorEntry) => {
    if (!isTauri()) return;
    begin();
    try {
      const picked = await open({
        multiple: false,
        title: t("entry.replaceTitle", { name: entry.path }),
        filters:
          entry.kind === "image"
            ? [
                { name: t("entry.replaceImageFilter"), extensions: IMAGE_EXTENSIONS },
                { name: t("entry.replaceAnyFilter"), extensions: ["*"] },
              ]
            : undefined,
      });
      if (typeof picked !== "string") return;
      actions.replace.mutate(
        { path: entry.path, sourcePath: picked },
        {
          onError,
          // The text typed over the old file no longer stands for anything.
          onSuccess: () => setDrafts((current) => without(current, entry.path)),
        },
      );
    } catch (e) {
      onError(e);
    }
  };

  const extract = async (what: Pk3Selection | null) => {
    if (!isTauri()) return;
    begin();
    try {
      const picked = await open({ directory: true, multiple: false, title: t("toolbar.extractTitle") });
      if (typeof picked !== "string") return;
      const paths =
        what === null ? wholeArchivePaths(tree) : what.kind === "folder" ? [`${what.path}/`] : [what.path];
      actions.extract.mutate(
        { paths, targetDir: picked },
        {
          onError,
          onSuccess: ({ files }) => setStatus(t("dialog.extracted", { count: files, folder: picked })),
        },
      );
    } catch (e) {
      onError(e);
    }
  };

  const removeTarget = (what: Pk3Selection) => {
    begin();
    const path = what.kind === "folder" ? `${what.path}/` : what.path;
    actions.remove.mutate([path], {
      onError,
      onSuccess: () => {
        setDrafts((current) => {
          const next = new Map(current);
          for (const key of current.keys()) {
            if (what.kind === "folder" ? isUnder(key, what.path) : key === what.path) next.delete(key);
          }
          return next;
        });
        if (what.kind === "folder") {
          setPendingFolders((current) => new Set([...current].filter((folder) => !isUnder(folder, what.path))));
        }
      },
    });
  };

  const renameTarget = (what: Pk3Selection, to: string) => {
    begin();
    const folder = what.kind === "folder";
    actions.rename.mutate(
      { from: folder ? `${what.path}/` : what.path, to: folder ? `${to}/` : to },
      {
        onError,
        onSuccess: () => {
          // Everything the dialog keeps by path follows the rename.
          const moved = (path: string) =>
            folder ? (isUnder(path, what.path) ? `${to}${path.slice(what.path.length)}` : path) : path === what.path ? to : path;
          setSelected({ kind: what.kind, path: to });
          setDrafts((current) => new Map([...current].map(([path, text]) => [moved(path), text])));
          setPendingFolders((current) => new Set([...current].map(moved)));
          setOpened(new Set([...expanded].map(moved).concat(ancestorsOf(to))));
          setPrompt(null);
        },
      },
    );
  };

  const makeFolder = (parent: string, name: string) => {
    const path = joinPath(parent, name);
    setPendingFolders((current) => new Set(current).add(path));
    openFolders(ancestorsOf(path).concat(parent === "" ? [] : [parent]));
    setSelected({ kind: "folder", path });
    setPrompt(null);
  };

  const applyText = (path: string, text: string) => {
    begin();
    actions.writeText.mutate(
      { path, text },
      { onError, onSuccess: () => setDrafts((current) => without(current, path)) },
    );
  };

  /**
   * **Save**: the texts typed and not applied go into the session first, one
   * by one, then the archive is written. A player who typed and pressed
   * **Save** meant the text to be saved, and a refusal on the way stops
   * before the archive is touched.
   */
  const save = async () => {
    begin();
    try {
      for (const [path, text] of drafts) {
        await actions.writeText.mutateAsync({ path, text });
        setDrafts((current) => without(current, path));
      }
      const { saved } = await actions.save.mutateAsync();
      setStatus(t("dialog.saved", { size: format.bytes(saved.size) }));
    } catch (e) {
      onError(e);
    }
  };

  const discard = () => {
    begin();
    actions.discard.mutate(undefined, {
      onError,
      onSuccess: () => {
        setDrafts(new Map());
        setPendingFolders(new Set());
        setPrompt(null);
      },
    });
  };

  const requestClose = useCallback(() => {
    if (dirty) setPrompt({ kind: "confirmClose" });
    else onClose();
  }, [dirty, onClose]);

  const menu = useContextMenu<Pk3Selection>({
    ariaLabel: t("tree.actions"),
    items: (what): MenuItem[] => {
      const removed = what.kind === "entry" && entryAt(what.path)?.state === "removed";
      return [
        { id: "rename", label: t("menu.rename"), icon: <Pencil size={14} />, disabled: locked || removed },
        { id: "extract", label: t("menu.extract"), icon: <FolderOutput size={14} />, disabled: busy || !isTauri() },
        {
          id: "remove",
          label: common("actions.remove"),
          icon: <Trash2 size={14} />,
          danger: true,
          disabled: locked || removed,
        },
      ];
    },
    onSelect: (id, what) => {
      if (id === "rename") setPrompt({ kind: "rename", target: what });
      else if (id === "extract") void extract(what);
      else if (id === "remove") removeTarget(what);
    },
  });
  const openMenu = (event: ReactMouseEvent, what: Pk3Selection) => menu.open(event, what);

  const selectedEntry = selected?.kind === "entry" ? entryAt(selected.path) : undefined;
  const selectedFolder = selected?.kind === "folder" ? findFolder(tree, selected.path) : null;

  return (
    <Dialog
      title={t("dialog.title", { file: title })}
      wide="preview"
      onClose={requestClose}
      actions={<Button onClick={requestClose}>{common("actions.close")}</Button>}
    >
      {menu.menu}
      {session.data ? (
        <p className="flex flex-wrap items-center gap-8 text-body-sm text-fg-muted pt-4">
          <span className="text-mono-xs" title={session.data.archivePath}>
            {shortenPath(session.data.archivePath, 72)}
          </span>
          <span>·</span>
          <span>{format.bytes(session.data.bytes)}</span>
          <span>·</span>
          <span>{t("dialog.entries", { count: entries.length })}</span>
          {readOnly ? (
            <Badge tone="warm" title={t("dialog.readOnlyText")}>
              {t("dialog.readOnly")}
            </Badge>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-8 pt-12">
        <Button size="sm" icon={<FilePlus size={14} />} disabled={locked} onClick={() => void addFiles(currentFolder)}>
          {t("toolbar.addFiles")}
        </Button>
        <Button
          size="sm"
          icon={<FolderPlus size={14} />}
          disabled={locked}
          onClick={() => setPrompt({ kind: "newFolder", parent: currentFolder })}
        >
          {t("toolbar.newFolder")}
        </Button>
        <Button
          size="sm"
          icon={<FolderOutput size={14} />}
          disabled={busy || sessionId === null || !isTauri()}
          title={
            selected === null
              ? t("toolbar.extractAllHint")
              : t("toolbar.extractOneHint", { name: selected.kind === "folder" ? `${selected.path}/` : selected.path })
          }
          onClick={() => void extract(selected)}
        >
          {t("toolbar.extract")}
        </Button>
        <span className="flex-1" />
        {dirty ? (
          <>
            <Badge tone="warm">{t("dialog.unsaved")}</Badge>
            <span className="text-body-sm text-fg-secondary select-none">
              {t("dialog.changes", { count: changes + [...draftPaths].filter((path) => entryAt(path)?.state === "unchanged").length })}
            </span>
          </>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 size={14} />}
          disabled={!dirty || busy || readOnly}
          onClick={() => setPrompt({ kind: "confirmDiscard" })}
        >
          {t("toolbar.discard")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Save size={14} />}
          disabled={!dirty || busy || readOnly}
          onClick={() => void save()}
        >
          {actions.save.isPending ? common("states.saving") : common("actions.save")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger pt-8">
          {failure}
        </p>
      ) : status ? (
        <p role="status" className="text-body-sm text-fg-success pt-8">
          {status}
        </p>
      ) : null}

      {session.isPending ? (
        <p role="status" className="text-body-sm text-fg-muted pt-16">
          {t("dialog.opening")}
        </p>
      ) : session.error ? (
        <div role="alert" className="flex flex-col items-start gap-12 pt-16">
          <p className="text-body-sm text-fg-danger">{errorText(session.error)}</p>
          <Button onClick={() => void session.refetch()}>{common("actions.tryAgain")}</Button>
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(260px,340px)_minmax(0,1fr)] gap-12 pt-12 h-[62vh] min-h-[360px]">
          <Pk3EntryTree
            tree={tree}
            total={entries.length}
            entries={entries}
            selected={selected}
            onSelect={setSelected}
            pending={draftPaths}
            expanded={expanded}
            onToggle={toggleFolder}
            onExpandAll={() => setOpened(new Set(folderPaths(tree)))}
            onCollapseAll={() => setOpened(new Set())}
            onMenu={openMenu}
          />
          <div className="min-h-0 overflow-hidden rounded-md border border-line-subtle p-12">
            {sessionId !== null && selectedEntry ? (
              <Pk3EntryPanel
                key={selectedEntry.path}
                sessionId={sessionId}
                entry={selectedEntry}
                draft={drafts.get(selectedEntry.path)}
                onDraft={(text) =>
                  setDrafts((current) => {
                    if (text === undefined) return without(current, selectedEntry.path);
                    const next = new Map(current);
                    next.set(selectedEntry.path, text);
                    return next;
                  })
                }
                onApply={(text) => applyText(selectedEntry.path, text)}
                onReplace={() => void replaceEntry(selectedEntry)}
                locked={locked}
              />
            ) : selectedFolder ? (
              <Pk3FolderPanel folder={selectedFolder} onAddFiles={() => void addFiles(selectedFolder.path)} locked={locked} />
            ) : (
              <p className="text-body-sm text-fg-muted">{t("entry.pick")}</p>
            )}
          </div>
        </div>
      )}

      {prompt?.kind === "rename" ? (
        <PathPrompt
          title={t("rename.title", { name: prompt.target.kind === "folder" ? `${prompt.target.path}/` : prompt.target.path })}
          body={t("rename.body")}
          label={prompt.target.kind === "folder" ? t("rename.folderLabel") : t("rename.label")}
          initial={prompt.target.path}
          busy={actions.rename.isPending}
          validate={(value) => {
            if (!isValidEntryPath(value)) return t("rename.invalid");
            if (value === prompt.target.path) return t("rename.unchanged");
            return null;
          }}
          onSubmit={(value) => renameTarget(prompt.target, value)}
          onClose={() => setPrompt(null)}
        />
      ) : null}

      {prompt?.kind === "newFolder" ? (
        <PathPrompt
          title={t("newFolder.title")}
          body={`${t("newFolder.body")} ${prompt.parent === "" ? t("newFolder.inRoot") : t("newFolder.in", { folder: `${prompt.parent}/` })}`}
          label={t("newFolder.label")}
          initial=""
          busy={false}
          validate={(value) => {
            if (!isValidSegment(value)) return t("newFolder.invalid");
            if (findFolder(tree, joinPath(prompt.parent, value)) !== null) return t("newFolder.exists");
            return null;
          }}
          onSubmit={(value) => makeFolder(prompt.parent, value)}
          onClose={() => setPrompt(null)}
        />
      ) : null}

      {prompt?.kind === "confirmClose" ? (
        <ConfirmDialog
          title={t("dialog.closeTitle")}
          body={t("dialog.closeBody")}
          confirm={t("dialog.closeConfirm")}
          busy={false}
          onConfirm={onClose}
          onClose={() => setPrompt(null)}
        />
      ) : null}

      {prompt?.kind === "confirmDiscard" ? (
        <ConfirmDialog
          title={t("dialog.discardTitle")}
          body={t("dialog.discardBody")}
          confirm={t("dialog.discardConfirm")}
          busy={actions.discard.isPending}
          onConfirm={discard}
          onClose={() => setPrompt(null)}
        />
      ) : null}
    </Dialog>
  );
}

/** The map without one key. */
function without(map: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/**
 * One field over the editor: the new path of an entry, the name of a new
 * folder. The value is checked as it is typed and the reason stands under
 * the field; Enter submits. Escape closes this dialog and not the editor
 * under it.
 */
function PathPrompt({
  title,
  body,
  label,
  initial,
  busy,
  validate,
  onSubmit,
  onClose,
}: {
  title: string;
  body: string;
  label: string;
  initial: string;
  busy: boolean;
  /** The sentence that says what is wrong, or `null` for a value the core may take. */
  validate: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const { t: common } = useTranslation("common");
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const tidy = tidyPath(value);
  const problem = validate(tidy);
  useEscapeFirst(onClose);
  const submit = () => {
    setTouched(true);
    if (problem === null && !busy) onSubmit(tidy);
  };
  return (
    <Dialog
      title={title}
      body={body}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {common("actions.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || (touched && problem !== null)} onClick={submit}>
            {busy ? common("states.saving") : common("actions.apply")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-8 pt-16"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          aria-label={label}
          placeholder={label}
          value={value}
          invalid={touched && problem !== null}
          spellCheck={false}
          autoFocus
          onChange={(event) => {
            setValue(event.target.value);
            setTouched(true);
          }}
        />
        {touched && problem !== null ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {problem}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** A question in front of an action that throws edits away. */
function ConfirmDialog({
  title,
  body,
  confirm,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t: common } = useTranslation("common");
  useEscapeFirst(onClose);
  return (
    <Dialog
      title={title}
      body={body}
      variant="danger"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {common("actions.cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    />
  );
}
