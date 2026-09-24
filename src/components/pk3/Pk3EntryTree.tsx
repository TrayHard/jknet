import {
  Box,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  File,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Map,
  Music,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type { Pk3EditorEntry, Pk3EntryKind, Pk3EntryState } from "../../lib/ipc";
import { hasTextSelection } from "../../lib/selection";
import { Badge, Button, Input, type BadgeTone } from "../ui";
import { fileName, type Pk3Folder, type Pk3Selection } from "./pk3Tree";

/**
 * --- slice: pk3 editor ---
 * The entries of an open archive as a tree of folders, with a search over
 * the paths.
 *
 * The same shape as the **Contents** tree of a bundle file, with three
 * things a listing does not have: a row can be picked, and the panel beside
 * the tree shows what was picked; a row carries the state the session gave
 * its entry; and a right click opens the actions of the row. The folders
 * open and close with the chevron, **Collapse all** and **Expand all**; the
 * state lives in the dialog, which opens the way down to a folder it made or
 * a file it added.
 */

/** The most matches the search lists: an archive has up to 50 000 entries. */
const MATCH_LIMIT = 500;

/** How long the search waits after a keystroke before it walks the entries. */
const SEARCH_DELAY_MS = 300;

/** How many files of one folder are drawn at once; the rest come in pages of this size on a press. */
const FILES_PAGE = 200;

/** The tone of each state: an untouched entry has no badge at all. */
const STATE_TONES: Record<Exclude<Pk3EntryState, "unchanged">, BadgeTone> = {
  modified: "accent",
  added: "success",
  renamed: "purple",
  removed: "danger",
};

/** The icon of an entry, by what the core says it is. */
export function EntryIcon({ kind, className }: { kind: Pk3EntryKind; className?: string }) {
  const props = { size: 14, className, "aria-hidden": true as const };
  switch (kind) {
    case "image":
      return <Image {...props} />;
    case "text":
      return <FileText {...props} />;
    case "model":
      return <Box {...props} />;
    case "sound":
      return <Music {...props} />;
    case "map":
      return <Map {...props} />;
    default:
      return <File {...props} />;
  }
}

/** The badge of a state, or of a text the player has not applied yet. */
export function StateBadge({ state, pending }: { state: Pk3EntryState; pending: boolean }) {
  const { t } = useTranslation("pk3");
  if (pending) {
    return (
      <Badge tone="warm" className="shrink-0">
        {t("tree.state.pending")}
      </Badge>
    );
  }
  if (state === "unchanged") return null;
  return (
    <Badge tone={STATE_TONES[state]} className="shrink-0">
      {t(`tree.state.${state}`)}
    </Badge>
  );
}

interface TreeProps {
  tree: Pk3Folder;
  /** How many entries the archive holds, for the badge beside the search. */
  total: number;
  entries: readonly Pk3EditorEntry[];
  selected: Pk3Selection | null;
  onSelect: (selection: Pk3Selection) => void;
  /** Paths of the text entries whose edited text is not applied yet. */
  pending: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Give it to the right click of a row: the dialog draws the menu. */
  onMenu: (event: ReactMouseEvent, target: Pk3Selection) => void;
}

export function Pk3EntryTree({
  tree,
  total,
  entries,
  selected,
  onSelect,
  pending,
  expanded,
  onToggle,
  onExpandAll,
  onCollapseAll,
  onMenu,
}: TreeProps) {
  const { t } = useTranslation("pk3");
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");

  // The search waits out a burst of typing: every keystroke would otherwise
  // walk the whole archive.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const needle = query.toLowerCase();
  const matches = useMemo(
    () => (needle === "" ? [] : entries.filter((entry) => entry.path.toLowerCase().includes(needle))),
    [entries, needle],
  );

  const rowProps = (target: Pk3Selection) => ({
    onClick: () => {
      if (hasTextSelection()) return;
      onSelect(target);
    },
    onContextMenu: (event: ReactMouseEvent) => {
      onSelect(target);
      onMenu(event, target);
    },
  });

  return (
    <div className="flex flex-col gap-8 min-h-0 h-full">
      <div className="flex items-center gap-8 shrink-0">
        <Input
          icon={<Search size={16} />}
          aria-label={t("toolbar.search")}
          placeholder={t("toolbar.search")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          spellCheck={false}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<ChevronsUpDown size={14} />}
          aria-label={t("toolbar.expandAll")}
          title={t("toolbar.expandAll")}
          className="px-6"
          disabled={needle !== ""}
          onClick={onExpandAll}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<ChevronsDownUp size={14} />}
          aria-label={t("toolbar.collapseAll")}
          title={t("toolbar.collapseAll")}
          className="px-6"
          disabled={needle !== ""}
          onClick={onCollapseAll}
        />
      </div>
      <div
        role="tree"
        aria-label={t("tree.label")}
        className="flex-1 min-h-0 overflow-y-auto rounded-md border border-line-subtle"
      >
        {needle !== "" ? (
          matches.length === 0 ? (
            <p className="text-body-sm text-fg-muted p-12">{t("tree.noMatches")}</p>
          ) : (
            <ul role="none" className="flex flex-col py-4">
              <li role="none" className="px-12 py-4 text-mono-xs text-fg-muted select-none">
                {t("tree.matches", { count: matches.length })}
              </li>
              {matches.slice(0, MATCH_LIMIT).map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  fullPath
                  selected={selected?.kind === "entry" && selected.path === entry.path}
                  pending={pending.has(entry.path)}
                  {...rowProps({ kind: "entry", path: entry.path })}
                />
              ))}
              {matches.length > MATCH_LIMIT ? (
                <li className="px-12 py-6 text-body-sm text-fg-muted">
                  {t("tree.moreMatches", { shown: MATCH_LIMIT, count: matches.length })}
                </li>
              ) : null}
            </ul>
          )
        ) : total === 0 && tree.folders.length === 0 ? (
          <p className="text-body-sm text-fg-muted p-12">{t("tree.empty")}</p>
        ) : (
          <ul role="none" className="flex flex-col py-4">
            {tree.folders.map((folder) => (
              <FolderRow
                key={folder.path}
                folder={folder}
                depth={0}
                selected={selected}
                pending={pending}
                expanded={expanded}
                onToggle={onToggle}
                rowProps={rowProps}
              />
            ))}
            <FileRows files={tree.files} depth={0} selected={selected} pending={pending} rowProps={rowProps} />
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One folder of the tree: its name, its counts, and its children when open.
 *
 * The row is a `div` with handlers rather than a `button`, so the name of
 * the folder can be selected and copied like the path of a file. A press on
 * the row picks the folder, the chevron opens and closes it, and the arrow
 * keys do the same from the keyboard. The children are mounted only while
 * the folder is open.
 */
function FolderRow({
  folder,
  depth,
  selected,
  pending,
  expanded,
  onToggle,
  rowProps,
}: {
  folder: Pk3Folder;
  depth: number;
  selected: Pk3Selection | null;
  pending: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  rowProps: (target: Pk3Selection) => { onClick: () => void; onContextMenu: (event: ReactMouseEvent) => void };
}) {
  const { t } = useTranslation("pk3");
  const format = useFormat();
  const open = expanded.has(folder.path);
  const picked = selected?.kind === "folder" && selected.path === folder.path;
  const target: Pk3Selection = { kind: "folder", path: folder.path };
  const { onClick, onContextMenu } = rowProps(target);
  return (
    <li role="none" className="flex flex-col">
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={open}
        aria-selected={picked}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onDoubleClick={() => onToggle(folder.path)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          } else if (event.key === "ArrowRight" && !open) {
            event.preventDefault();
            onToggle(folder.path);
          } else if (event.key === "ArrowLeft" && open) {
            event.preventDefault();
            onToggle(folder.path);
          }
        }}
        className={cn(
          "flex items-center gap-8 h-28 pr-12 min-w-0 rounded-sm text-left cursor-pointer outline-none",
          "focus-visible:bg-hover-overlay",
          picked ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
        )}
        style={{ paddingLeft: 8 + depth * 20 }}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? t("tree.collapse", { folder: folder.name }) : t("tree.expand", { folder: folder.name })}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(folder.path);
          }}
          className="inline-flex items-center justify-center size-20 shrink-0 rounded-xs cursor-pointer select-none text-fg-muted hover:text-fg"
        >
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </button>
        {open ? (
          <FolderOpen size={14} className="text-fg-accent shrink-0" aria-hidden />
        ) : (
          <Folder size={14} className="text-fg-accent shrink-0" aria-hidden />
        )}
        <span className="text-mono-sm truncate flex-1 min-w-0" title={folder.path}>
          {folder.name}/
        </span>
        {folder.pending ? (
          <Badge tone="neutral" className="shrink-0">
            {t("tree.emptyFolder")}
          </Badge>
        ) : (
          <span className="text-mono-xs text-fg-muted shrink-0 select-none">
            {t("tree.folderCount", { count: folder.count })} · {format.bytes(folder.bytes)}
          </span>
        )}
      </div>
      {open ? (
        <ul role="group" className="flex flex-col">
          {folder.folders.map((child) => (
            <FolderRow
              key={child.path}
              folder={child}
              depth={depth + 1}
              selected={selected}
              pending={pending}
              expanded={expanded}
              onToggle={onToggle}
              rowProps={rowProps}
            />
          ))}
          <FileRows files={folder.files} depth={depth + 1} selected={selected} pending={pending} rowProps={rowProps} />
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The files of one folder, `FILES_PAGE` at a time: the first page is drawn
 * at once, each press of the last row adds another.
 */
function FileRows({
  files,
  depth,
  selected,
  pending,
  rowProps,
}: {
  files: readonly Pk3EditorEntry[];
  depth: number;
  selected: Pk3Selection | null;
  pending: ReadonlySet<string>;
  rowProps: (target: Pk3Selection) => { onClick: () => void; onContextMenu: (event: ReactMouseEvent) => void };
}) {
  const { t } = useTranslation("pk3");
  const [shown, setShown] = useState(FILES_PAGE);
  const rest = files.length - shown;
  return (
    <>
      {(rest > 0 ? files.slice(0, shown) : files).map((entry) => (
        <FileRow
          key={entry.path}
          entry={entry}
          depth={depth}
          selected={selected?.kind === "entry" && selected.path === entry.path}
          pending={pending.has(entry.path)}
          {...rowProps({ kind: "entry", path: entry.path })}
        />
      ))}
      {rest > 0 ? (
        <li role="none" className="flex items-center h-28 pr-12" style={{ paddingLeft: 8 + 20 + 8 + depth * 20 }}>
          <Button size="sm" variant="ghost" onClick={() => setShown((current) => current + FILES_PAGE)}>
            {t("tree.showMore", { count: Math.min(rest, FILES_PAGE) })}
          </Button>
        </li>
      ) : null}
    </>
  );
}

/** One file of the tree: its icon, its name, its state and its size. */
function FileRow({
  entry,
  depth,
  fullPath = false,
  selected,
  pending,
  onClick,
  onContextMenu,
}: {
  entry: Pk3EditorEntry;
  depth: number;
  /** In the list of matches the whole path is the name. */
  fullPath?: boolean;
  selected: boolean;
  pending: boolean;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const { t } = useTranslation("pk3");
  const format = useFormat();
  const removed = entry.state === "removed";
  const title: string = entry.renamedFrom ? `${entry.path} · ${t("tree.renamedFrom", { path: entry.renamedFrom })}` : entry.path;
  const label: ReactNode = fullPath ? entry.path : fileName(entry.path);
  return (
    <li
      role="treeitem"
      tabIndex={0}
      aria-selected={selected}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex items-center gap-8 h-28 pr-12 min-w-0 rounded-sm cursor-pointer outline-none",
        "focus-visible:bg-hover-overlay",
        selected ? "bg-selected-overlay" : "hover:bg-hover-overlay",
      )}
      style={{ paddingLeft: 8 + 20 + 8 + depth * 20 }}
    >
      <EntryIcon kind={entry.kind} className={cn("shrink-0", removed ? "text-fg-disabled" : "text-fg-muted")} />
      <span
        className={cn("text-mono-sm truncate flex-1 min-w-0", removed ? "text-fg-muted line-through" : "text-fg")}
        title={title}
      >
        {label}
      </span>
      <StateBadge state={entry.state} pending={pending} />
      <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right select-none">{format.bytes(entry.size)}</span>
    </li>
  );
}
