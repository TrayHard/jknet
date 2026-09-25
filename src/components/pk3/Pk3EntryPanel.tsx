import { AlertTriangle, FilePlus, FolderOpen, ImageOff, Replace } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import type { Pk3EditorEntry } from "../../lib/ipc";
import { usePk3EditorImage, usePk3EditorText } from "../../lib/queries";
import { Badge, Button } from "../ui";
import { EntryIcon, StateBadge } from "./Pk3EntryTree";
import { Pk3TextEditor, lineBreakOf, sameText, withLineBreak } from "./Pk3TextEditor";
import { fileName, type Pk3Folder } from "./pk3Tree";

/**
 * --- slice: pk3 editor ---
 * The panel beside the tree: what the picked row is and what can be done
 * to it. A text entry is edited in place and **Apply** writes it into the
 * session; a picture is shown with its size and replaced by a file from
 * the disk; any other entry is named, weighed and replaced. A folder says
 * how much lies under it and takes files.
 */

/** The heading of every view: the name, the kind, the state, the path and a line of facts. */
function Heading({ entry, facts, pending }: { entry: Pk3EditorEntry; facts: (string | null)[]; pending: boolean }) {
  const { t } = useTranslation("pk3");
  const line = facts.filter((fact): fact is string => fact !== null && fact !== "");
  return (
    <div className="flex flex-col gap-4 shrink-0">
      <div className="flex items-center gap-8 min-w-0">
        <EntryIcon kind={entry.kind} className="text-fg-accent shrink-0" />
        <span className="text-body-md-medium text-fg truncate" title={fileName(entry.path)}>
          {fileName(entry.path)}
        </span>
        <Badge tone="neutral" className="shrink-0">
          {t(`entry.kind.${entry.kind}`)}
        </Badge>
        <StateBadge state={entry.state} pending={pending} />
      </div>
      <p className="text-mono-xs text-fg-muted break-all">{entry.path}</p>
      {entry.renamedFrom ? (
        <p className="text-mono-xs text-fg-muted break-all">{t("tree.renamedFrom", { path: entry.renamedFrom })}</p>
      ) : null}
      {line.length > 0 ? <p className="text-body-sm text-fg-secondary">{line.join(" · ")}</p> : null}
    </div>
  );
}

/** The refusal of a read, with a retry, or the wait. */
function ReadState({ error, refetch }: { error: unknown; refetch: () => void }) {
  const { t: common } = useTranslation("common");
  const errorText = useErrorText();
  if (error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-12 p-12">
        <p className="text-body-sm text-fg-danger">{errorText(error)}</p>
        <Button onClick={refetch}>{common("actions.tryAgain")}</Button>
      </div>
    );
  }
  return (
    <p role="status" className="p-12 text-body-sm text-fg-muted">
      {common("states.reading")}
    </p>
  );
}

/** `640×480` out of a header or a decoded picture; nothing for a header the core could not parse. */
function dimensions(image: { width: number; height: number } | null | undefined): string | null {
  return image && image.width > 0 && image.height > 0 ? `${image.width}×${image.height}` : null;
}

interface EntryPanelProps {
  sessionId: string;
  entry: Pk3EditorEntry;
  /** The text the player has typed and not applied, if any. */
  draft: string | undefined;
  onDraft: (text: string | undefined) => void;
  onApply: (text: string) => void;
  onReplace: () => void;
  /** Nothing can be changed: the session is read only, or an edit is in flight. */
  locked: boolean;
}

export function Pk3EntryPanel({ sessionId, entry, draft, onDraft, onApply, onReplace, locked }: EntryPanelProps) {
  const { t } = useTranslation("pk3");
  const format = useFormat();

  if (entry.state === "removed") {
    return (
      <div className="h-full flex flex-col gap-12">
        <Heading entry={entry} facts={[format.bytes(entry.size)]} pending={false} />
        <p className="text-body-sm text-fg-muted">{t("entry.removed")}</p>
      </div>
    );
  }

  const replaceButton = (
    <Button size="sm" icon={<Replace size={14} />} disabled={locked} onClick={onReplace}>
      {t("entry.replace")}
    </Button>
  );

  if (entry.kind === "text") {
    return (
      <TextPanel
        sessionId={sessionId}
        entry={entry}
        draft={draft}
        onDraft={onDraft}
        onApply={onApply}
        locked={locked}
        replaceButton={replaceButton}
      />
    );
  }

  if (entry.kind === "image") {
    return <ImagePanel sessionId={sessionId} entry={entry} replaceButton={replaceButton} />;
  }

  return (
    <div className="h-full flex flex-col gap-12">
      <Heading entry={entry} facts={[format.bytes(entry.size)]} pending={false} />
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-12 rounded-md border border-line bg-elevated p-24 text-center">
        <EntryIcon kind={entry.kind} className="text-fg-muted size-48" />
        <p className="text-body-sm text-fg-muted max-w-[420px]">{t("entry.replaceHint")}</p>
        {replaceButton}
      </div>
    </div>
  );
}

/**
 * A text entry: the editor over the text the core decoded, and **Apply**.
 *
 * The typed text lives in the dialog as a draft keyed by the path, so a
 * player who looks at another entry and comes back finds it; the editor
 * shows the draft when there is one and the text of the session otherwise.
 * A file the core cut short is shown but not edited: applying the beginning
 * of a file would write the beginning of a file. The editor keeps its lines
 * joined with `\n`; the draft goes back to the line breaks of the file, and
 * a text that differs from the file only in them is no draft at all.
 */
function TextPanel({
  sessionId,
  entry,
  draft,
  onDraft,
  onApply,
  locked,
  replaceButton,
}: {
  sessionId: string;
  entry: Pk3EditorEntry;
  draft: string | undefined;
  onDraft: (text: string | undefined) => void;
  onApply: (text: string) => void;
  locked: boolean;
  replaceButton: ReactNode;
}) {
  const { t } = useTranslation("pk3");
  const { t: common } = useTranslation("common");
  const format = useFormat();
  const query = usePk3EditorText(sessionId, entry.path);
  const loaded = query.data?.text;
  // Once per read, not per keystroke: a text runs up to 512 KiB.
  const lineBreak = useMemo(() => lineBreakOf(loaded ?? ""), [loaded]);
  const truncated = query.data?.truncated === true;
  const value = draft ?? loaded ?? "";
  const canApply = draft !== undefined && !truncated && !locked;
  return (
    <div className="h-full flex flex-col gap-12">
      <Heading
        entry={entry}
        facts={[format.bytes(entry.size), query.data?.encoding ?? entry.text?.encoding ?? null]}
        pending={draft !== undefined}
      />
      {truncated ? (
        <p role="status" className="flex items-start gap-6 text-body-sm text-fg-warm">
          <AlertTriangle size={14} className="shrink-0 mt-2" aria-hidden />
          {t("entry.truncated")}
        </p>
      ) : null}
      {loaded === undefined ? (
        <ReadState error={query.error} refetch={() => void query.refetch()} />
      ) : (
        <Pk3TextEditor
          value={value}
          readOnly={truncated || locked}
          onChange={(text) => {
            const kept = withLineBreak(text, lineBreak);
            onDraft(sameText(kept, loaded) ? undefined : kept);
          }}
          ariaLabel={t("entry.editor", { name: fileName(entry.path) })}
          className="flex-1 min-h-0"
        />
      )}
      <div className="flex items-center gap-8 shrink-0">
        <span className="text-body-sm text-fg-muted flex-1 min-w-0">
          {draft !== undefined ? t("entry.pendingText") : null}
        </span>
        {replaceButton}
        <Button size="sm" variant="primary" disabled={!canApply} onClick={() => draft !== undefined && onApply(draft)}>
          {common("actions.apply")}
        </Button>
      </div>
    </div>
  );
}

/** A picture: decoded by the core, drawn whole, and replaced by a file from the disk. */
function ImagePanel({
  sessionId,
  entry,
  replaceButton,
}: {
  sessionId: string;
  entry: Pk3EditorEntry;
  replaceButton: ReactNode;
}) {
  const { t } = useTranslation("pk3");
  const format = useFormat();
  const image = usePk3EditorImage(sessionId, entry.path);
  return (
    <div className="h-full flex flex-col gap-12">
      <Heading
        entry={entry}
        facts={[
          format.bytes(entry.size),
          dimensions(image.data) ?? dimensions(entry.image),
          entry.image ? entry.image.format.toUpperCase() : null,
        ]}
        pending={false}
      />
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto rounded-md border border-line bg-elevated p-12">
        {image.data ? (
          <img
            src={image.data.dataUrl}
            alt={t("entry.imageAlt", { name: fileName(entry.path) })}
            decoding="async"
            className="max-w-full max-h-full object-contain"
          />
        ) : image.error ? (
          <div role="alert" className="flex flex-col items-center gap-12 text-center">
            <ImageOff size={24} className="text-fg-muted" aria-hidden />
            <p className="text-body-sm text-fg-muted">{t("entry.imageFailed")}</p>
          </div>
        ) : (
          <ReadState error={null} refetch={() => void image.refetch()} />
        )}
      </div>
      <div className="flex items-center gap-8 shrink-0">
        <span className="text-body-sm text-fg-muted flex-1 min-w-0">{t("entry.replaceImageHint")}</span>
        {replaceButton}
      </div>
    </div>
  );
}

/** A folder of the tree: what lies under it, and the files it takes. */
export function Pk3FolderPanel({
  folder,
  onAddFiles,
  locked,
}: {
  folder: Pk3Folder;
  onAddFiles: () => void;
  locked: boolean;
}) {
  const { t } = useTranslation("pk3");
  const format = useFormat();
  return (
    <div className="h-full flex flex-col gap-12">
      <div className="flex flex-col gap-4 shrink-0">
        <div className="flex items-center gap-8 min-w-0">
          <FolderOpen size={14} className="text-fg-accent shrink-0" aria-hidden />
          <span className="text-body-md-medium text-fg truncate">
            {folder.path === "" ? t("entry.folder.root") : `${folder.name}/`}
          </span>
        </div>
        {folder.path !== "" ? <p className="text-mono-xs text-fg-muted break-all">{folder.path}/</p> : null}
        <p className="text-body-sm text-fg-secondary">
          {t("tree.folderCount", { count: folder.count })} · {format.bytes(folder.bytes)}
        </p>
      </div>
      {folder.pending ? <p className="text-body-sm text-fg-muted">{t("entry.folder.pending")}</p> : null}
      <div>
        <Button size="sm" icon={<FilePlus size={14} />} disabled={locked} onClick={onAddFiles}>
          {t("entry.folder.addHere")}
        </Button>
      </div>
    </div>
  );
}
