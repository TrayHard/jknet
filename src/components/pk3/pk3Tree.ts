import type { Pk3EditorEntry } from "../../lib/ipc";

/**
 * --- slice: pk3 editor ---
 * The tree of an open archive, out of the paths of its entries: pure
 * functions the dialog and the tree share, with no React in them.
 */

/** What a row of the tree stands for, and what the panel on the right shows. */
export type Pk3Selection = { kind: "entry"; path: string } | { kind: "folder"; path: string };

/** One folder of the tree. */
export interface Pk3Folder {
  name: string;
  /** Inside the archive, without a trailing slash; empty for the root. */
  path: string;
  folders: Pk3Folder[];
  files: Pk3EditorEntry[];
  /** Files under the folder at every depth, the ones marked for removal left out. */
  count: number;
  /** Bytes of those files. */
  bytes: number;
  /**
   * A folder no entry lies in yet: made by **New folder**, and drawn until a
   * file is added to it. An archive holds files, not folders, so nothing is
   * written for it.
   */
  pending: boolean;
}

/** The longest path the archive accepts, the limit of the manifest rules. */
export const MAX_PATH = 260;

/** The folder of a path: everything before the last slash, empty at the root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The name of a path: the last segment. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Two segments of a path joined, with no slash left behind at the root. */
export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** Whether `path` is `folder` itself or lies under it. */
export function isUnder(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

/**
 * The tree of an archive out of its entries and the folders the player has
 * made and not filled yet.
 *
 * The entries name files only; the folders are what the paths say, plus
 * `pendingFolders`. Each folder counts the files under it at every depth
 * that are not marked for removal, which is the number the row prints
 * beside the name. Folders come before files, both in the order of their
 * names.
 */
export function buildTree(entries: readonly Pk3EditorEntry[], pendingFolders: ReadonlySet<string>): Pk3Folder {
  const root: Pk3Folder = { name: "", path: "", folders: [], files: [], count: 0, bytes: 0, pending: false };
  const index = new Map<string, Pk3Folder>([["", root]]);
  const folderAt = (path: string): Pk3Folder => {
    const found = index.get(path);
    if (found) return found;
    const parent = folderAt(folderOf(path));
    const folder: Pk3Folder = {
      name: fileName(path),
      path,
      folders: [],
      files: [],
      count: 0,
      bytes: 0,
      pending: true,
    };
    parent.folders.push(folder);
    index.set(path, folder);
    return folder;
  };
  for (const entry of entries) {
    const folder = folderAt(folderOf(entry.path));
    folder.files.push(entry);
    // A folder that holds a file is a real one, whatever it was made as.
    for (let current: Pk3Folder | undefined = folder; current !== undefined; ) {
      current.pending = false;
      if (entry.state !== "removed") {
        current.count += 1;
        current.bytes += entry.size;
      }
      current = current.path === "" ? undefined : index.get(folderOf(current.path));
    }
  }
  for (const path of pendingFolders) folderAt(path);
  const sort = (folder: Pk3Folder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => a.path.localeCompare(b.path));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** The paths of every folder of the tree but the root, for **Expand all**. */
export function folderPaths(root: Pk3Folder): string[] {
  const paths: string[] = [];
  const walk = (folder: Pk3Folder) => {
    for (const child of folder.folders) {
      paths.push(child.path);
      walk(child);
    }
  };
  walk(root);
  return paths;
}

/** The folders above a path, nearest last, for opening the way down to it. */
export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let folder = folderOf(path); folder !== ""; folder = folderOf(folder)) ancestors.unshift(folder);
  return ancestors;
}

/**
 * Whether a path may name an entry of the archive: the rules of the
 * manifest. Relative, forward slashes, no empty segment, no `.` or `..`
 * segment, at most `MAX_PATH` characters. The core checks the same rules
 * again; this is what lets the field say no before the round trip.
 */
export function isValidEntryPath(path: string): boolean {
  if (path === "" || path.length > MAX_PATH) return false;
  if (path.includes("\\") || path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Whether a name may be one segment of a path: one folder, one file. */
export function isValidSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && name.length <= MAX_PATH;
}

/** Windows separators made forward, and the ends trimmed. */
export function tidyPath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

/** The folder of the tree at a path, or `null` when no row stands there. */
export function findFolder(root: Pk3Folder, path: string): Pk3Folder | null {
  if (path === "") return root;
  let current = root;
  for (const segment of path.split("/")) {
    const next = current.folders.find((folder) => folder.name === segment);
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

/**
 * What to hand `pk3_editor_extract` for the whole archive: every top-level
 * folder by a trailing slash and every file at the root, rather than fifty
 * thousand paths.
 */
export function wholeArchivePaths(root: Pk3Folder): string[] {
  return [
    ...root.folders.filter((folder) => !folder.pending).map((folder) => `${folder.path}/`),
    ...root.files.filter((entry) => entry.state !== "removed").map((entry) => entry.path),
  ];
}
