import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type {
  BundleFileKind,
  BundleFileRoot,
  BundleListingRef,
  Listing,
  ListingEntry,
} from "../../lib/ipc";
import {
  useBundleFileListing,
  useBundleFileText,
  useDraftFileListing,
  useDraftFileText,
} from "../../lib/queries";
import { hasTextSelection } from "../../lib/selection";
import { Badge, Button, Dialog, Input } from "../ui";
import { useEscapeFirst } from "./bundleFiles";

/**
 * Where a file is read from: the folder of a draft, by scope and path, or
 * the store of the service, by hash.
 */
export type FileContentsOrigin =
  | { kind: "draft"; draftId: string; scope: string }
  | { kind: "bundle" };

/** The least a file needs for the dialog: a manifest file or a draft file. */
export interface ContentsFile {
  root: BundleFileRoot;
  path: string;
  kind: BundleFileKind;
  size: number;
  sha256: string;
  listing?: BundleListingRef | null;
}

/**
 * Whether **Contents** has anything to show for a file.
 *
 * A pk3 has a table of contents — always in a draft, where the core reads
 * the archive on the way in; in the catalogue only when the manifest names
 * the listing file. A cfg is text. A dll, an exe and anything else have no
 * contents to show.
 */
export function hasContents(file: ContentsFile, origin: FileContentsOrigin): boolean {
  if (file.kind === "cfg") return true;
  if (file.kind !== "pk3") return false;
  return origin.kind === "draft" || file.listing != null;
}

/** The name of a file: the last segment of its path. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The most matches the search lists: an archive has up to 50 000 entries. */
const MATCH_LIMIT = 500;

/** How long the search waits after a keystroke before it walks the entries, as the catalogue search does. */
const SEARCH_DELAY_MS = 300;

/**
 * How many files of one folder are drawn at once. An archive may keep its
 * 50 000 entries in one folder, and a row per entry would take seconds to
 * mount; the rest come in pages of this size on a press.
 */
const FILES_PAGE = 200;

/** One folder of the tree the dialog builds out of the paths. */
interface TreeFolder {
  name: string;
  /** The path of the folder inside the archive, without a trailing slash. */
  path: string;
  folders: TreeFolder[];
  files: ListingEntry[];
  /** Files under the folder, at every depth. */
  count: number;
  /** Bytes of those files. */
  bytes: number;
}

/**
 * The tree of an archive out of its entries.
 *
 * The listing names files only, sorted by path; the folders are what the
 * paths say. Each folder counts the files under it at every depth, which
 * is the number the row prints beside the name.
 */
function buildTree(entries: readonly ListingEntry[]): TreeFolder {
  const root: TreeFolder = { name: "", path: "", folders: [], files: [], count: 0, bytes: 0 };
  const index = new Map<string, TreeFolder>([["", root]]);
  const folderOf = (path: string): TreeFolder => {
    const found = index.get(path);
    if (found) return found;
    const slash = path.lastIndexOf("/");
    const parent = folderOf(slash < 0 ? "" : path.slice(0, slash));
    const folder: TreeFolder = {
      name: path.slice(slash + 1),
      path,
      folders: [],
      files: [],
      count: 0,
      bytes: 0,
    };
    parent.folders.push(folder);
    index.set(path, folder);
    return folder;
  };
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    const folder = folderOf(slash < 0 ? "" : entry.path.slice(0, slash));
    folder.files.push(entry);
    // Every folder on the way up counts the file.
    let current: TreeFolder | undefined = folder;
    while (current !== undefined) {
      current.count += 1;
      current.bytes += entry.size;
      const up = current.path.lastIndexOf("/");
      current = current.path === "" ? undefined : index.get(up < 0 ? "" : current.path.slice(0, up));
    }
  }
  const sort = (folder: TreeFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => a.path.localeCompare(b.path));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Below this many entries the tree opens with every folder expanded. */
const EXPAND_ALL_BELOW = 40;

/** The tree of one archive, with a search over the paths. */
function ListingTree({ listing }: { listing: Listing }) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const tree = useMemo(() => buildTree(listing.entries), [listing]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    if (listing.entries.length >= EXPAND_ALL_BELOW) return new Set();
    const all = new Set<string>();
    const walk = (folder: TreeFolder) => {
      all.add(folder.path);
      folder.folders.forEach(walk);
    };
    walk(tree);
    return all;
  });
  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // The search waits out a burst of typing: every keystroke would otherwise
  // walk the whole listing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const needle = query.toLowerCase();
  const matches = useMemo(
    () => (needle === "" ? [] : listing.entries.filter((entry) => entry.path.toLowerCase().includes(needle))),
    [listing, needle],
  );

  return (
    <div className="flex flex-col gap-12 pt-16">
      <div className="flex items-center gap-8">
        <Input
          icon={<Search size={16} />}
          aria-label={t("contents.search")}
          placeholder={t("contents.search")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          spellCheck={false}
          className="flex-1"
        />
        <Badge>{needle === "" ? t("contents.entries", { count: listing.total }) : t("contents.matches", { count: matches.length })}</Badge>
        <span className="text-mono-xs text-fg-muted shrink-0">{format.bytes(listing.bytes)}</span>
      </div>
      <div className="max-h-[56vh] min-h-[240px] overflow-y-auto pr-4 rounded-md border border-line-subtle">
        {needle !== "" ? (
          matches.length === 0 ? (
            <p className="text-body-sm text-fg-muted p-12">{t("contents.noMatches")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-subtle">
              {matches.slice(0, MATCH_LIMIT).map((entry) => (
                <li key={entry.path} className="flex items-center gap-8 px-12 py-6 min-w-0">
                  <File size={14} className="text-fg-muted shrink-0" aria-hidden />
                  <span className="text-mono-sm text-fg truncate flex-1 min-w-0" title={entry.path}>
                    {entry.path}
                  </span>
                  <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right">{format.bytes(entry.size)}</span>
                </li>
              ))}
              {matches.length > MATCH_LIMIT ? (
                <li className="px-12 py-6 text-body-sm text-fg-muted">
                  {t("contents.moreMatches", { shown: MATCH_LIMIT, count: matches.length })}
                </li>
              ) : null}
            </ul>
          )
        ) : (
          <ul className="flex flex-col py-4">
            {tree.folders.map((folder) => (
              <FolderRow key={folder.path} folder={folder} depth={0} expanded={expanded} onToggle={toggle} />
            ))}
            <FileRows files={tree.files} depth={0} />
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One folder of the tree: its name, its counts, and its children when open.
 *
 * The row is a `div` with a click handler rather than a `button`, so the
 * name of the folder can be selected and copied like the path of a file:
 * a drag that ends on the row is a selection, not a press. The children
 * are mounted only while the folder is open.
 */
function FolderRow({
  folder,
  depth,
  expanded,
  onToggle,
}: {
  folder: TreeFolder;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const open = expanded.has(folder.path);
  return (
    <li className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => {
          if (hasTextSelection()) return;
          onToggle(folder.path);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(folder.path);
          }
        }}
        className={cn(
          "flex items-center gap-8 h-28 pr-12 min-w-0 rounded-sm text-left cursor-pointer",
          "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
        )}
        style={{ paddingLeft: 12 + depth * 20 }}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0" aria-hidden />
        ) : (
          <ChevronRight size={14} className="shrink-0" aria-hidden />
        )}
        {open ? (
          <FolderOpen size={14} className="text-fg-accent shrink-0" aria-hidden />
        ) : (
          <Folder size={14} className="text-fg-accent shrink-0" aria-hidden />
        )}
        <span className="text-mono-sm truncate flex-1 min-w-0" title={folder.path}>
          {folder.name}/
        </span>
        <span className="text-mono-xs text-fg-muted shrink-0 select-none">
          {t("details.folderCount", { count: folder.count })} · {format.bytes(folder.bytes)}
        </span>
      </div>
      {open ? (
        <ul className="flex flex-col">
          {folder.folders.map((child) => (
            <FolderRow key={child.path} folder={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
          ))}
          <FileRows files={folder.files} depth={depth + 1} />
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The files of one folder, `FILES_PAGE` at a time: the first page is drawn
 * at once, each press of the last row adds another.
 */
function FileRows({ files, depth }: { files: ListingEntry[]; depth: number }) {
  const { t } = useTranslation("bundles");
  const [shown, setShown] = useState(FILES_PAGE);
  const rest = files.length - shown;
  return (
    <>
      {(rest > 0 ? files.slice(0, shown) : files).map((entry) => (
        <FileRow key={entry.path} entry={entry} depth={depth} />
      ))}
      {rest > 0 ? (
        <li className="flex items-center h-28 pr-12" style={{ paddingLeft: 12 + 14 + 8 + depth * 20 }}>
          <Button size="sm" variant="ghost" onClick={() => setShown((current) => current + FILES_PAGE)}>
            {t("contents.showMore", { count: Math.min(rest, FILES_PAGE) })}
          </Button>
        </li>
      ) : null}
    </>
  );
}

/** One file of the tree: its name and its size. */
function FileRow({ entry, depth }: { entry: ListingEntry; depth: number }) {
  const format = useFormat();
  return (
    <li className="flex items-center gap-8 h-28 pr-12 min-w-0" style={{ paddingLeft: 12 + 14 + 8 + depth * 20 }}>
      <File size={14} className="text-fg-muted shrink-0" aria-hidden />
      <span className="text-mono-sm text-fg truncate flex-1 min-w-0" title={entry.path}>
        {fileName(entry.path)}
      </span>
      <span className="text-mono-xs text-fg-muted shrink-0 w-72 text-right">{format.bytes(entry.size)}</span>
    </li>
  );
}

/** The table of contents of a pk3: read, then drawn as a tree. */
function ListingContents({ file, origin }: { file: ContentsFile; origin: FileContentsOrigin }) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const draft = useDraftFileListing(
    origin.kind === "draft" ? origin.draftId : "",
    origin.kind === "draft" ? origin.scope : "",
    file.root,
    file.path,
    origin.kind === "draft",
  );
  const bundle = useBundleFileListing(
    origin.kind === "bundle" ? (file.listing?.sha256 ?? null) : null,
    origin.kind === "bundle",
  );
  const query = origin.kind === "draft" ? draft : bundle;

  if (origin.kind === "bundle" && file.listing == null) {
    return <p className="text-body-sm text-fg-muted pt-16">{t("contents.noListing")}</p>;
  }
  if (query.error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-12 pt-16">
        <p className="text-body-sm text-fg-danger">{errorText(query.error)}</p>
        <Button onClick={() => void query.refetch()}>{tCommon("actions.tryAgain")}</Button>
      </div>
    );
  }
  if (!query.data) {
    return (
      <p role="status" className="text-body-sm text-fg-muted pt-16">
        {origin.kind === "bundle" ? t("contents.downloading") : tCommon("states.loading")}
      </p>
    );
  }
  if (query.data.entries.length === 0) {
    return <p className="text-body-sm text-fg-muted pt-16">{t("contents.emptyArchive")}</p>;
  }
  return <ListingTree listing={query.data} />;
}

/** The text of a cfg: read, then shown as it is. */
function TextContents({ file, origin }: { file: ContentsFile; origin: FileContentsOrigin }) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const draft = useDraftFileText(
    origin.kind === "draft" ? origin.draftId : "",
    origin.kind === "draft" ? origin.scope : "",
    file.root,
    file.path,
    origin.kind === "draft",
  );
  const bundle = useBundleFileText(origin.kind === "bundle" ? file.sha256 : null, file.path, origin.kind === "bundle");
  const query = origin.kind === "draft" ? draft : bundle;

  if (query.error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-12 pt-16">
        <p className="text-body-sm text-fg-danger">{errorText(query.error)}</p>
        <Button onClick={() => void query.refetch()}>{tCommon("actions.tryAgain")}</Button>
      </div>
    );
  }
  if (query.data === undefined) {
    return (
      <p role="status" className="text-body-sm text-fg-muted pt-16">
        {origin.kind === "bundle" ? t("contents.downloading") : tCommon("states.loading")}
      </p>
    );
  }
  return (
    <pre className="mt-16 max-h-[60vh] min-h-[120px] overflow-auto rounded-md bg-input p-12 text-mono-xs text-fg whitespace-pre-wrap break-all">
      {query.data === "" ? <span className="text-fg-muted">{t("contents.emptyText")}</span> : query.data}
    </pre>
  );
}

interface FileListingDialogProps {
  file: ContentsFile;
  origin: FileContentsOrigin;
  onClose: () => void;
}

/**
 * --- slice: bundles ---
 *
 * **Contents** of one file of a bundle: the tree of a pk3, or the text of
 * a cfg.
 *
 * The tree comes out of the listing the core wrote when the archive was
 * added — `draft_file_listing` reads the draft's copy, `bundle_file_listing`
 * fetches the store's — so the catalogue lists an archive without
 * downloading it. Folders open on a click and say how many files and how
 * many bytes are under them; the search flattens the tree to the paths
 * that contain the word. A cfg is read as text, up to 64 KiB.
 */
export function FileListingDialog({ file, origin, onClose }: FileListingDialogProps) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();
  const name = fileName(file.path);
  // Over the record of the bundle: Escape closes the contents, not the record.
  useEscapeFirst(onClose);
  return (
    <Dialog
      title={t("contents.title", { file: name })}
      wide
      onClose={onClose}
      actions={<Button onClick={onClose}>{tCommon("actions.close")}</Button>}
    >
      <p className="text-body-sm text-fg-muted pt-4">
        <span className="text-mono-xs">{file.root === "engine" ? file.path : `${file.root}/${file.path}`}</span>
        {" · "}
        {format.bytes(file.size)}
      </p>
      {file.kind === "cfg" ? <TextContents file={file} origin={origin} /> : <ListingContents file={file} origin={origin} />}
    </Dialog>
  );
}
