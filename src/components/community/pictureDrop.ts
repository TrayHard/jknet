/**
 * Dropping a picture on its tile — the logo and the cover of the management
 * screen, the cover of an event in its editor — without React: where a drag
 * is, which tile is under it, and what a drop gives before a byte of it is
 * read.
 *
 * The launcher's webview gets no file of a drop: Tauri tells it the paths
 * and the position of the drag, in physical pixels of the window. Its host
 * turns the position into the page's pixels ({@link pagePoint}) and hands
 * every drag to one {@link createDropRouter}, where each tile adds itself as
 * a zone: the router tells a zone when a drag is over its box and gives it
 * the paths of a drop on it. The website has the files of the page's own
 * drag events: {@link draggedFiles} counts them while they are dragged.
 * Both check a drop with {@link dropRefusal} before anything is read.
 *
 * Pure: the tests run it in Node.
 */

import { IMAGE_MAX_BYTES } from "./manage/upload.ts";
import type { ImageRefusal, PictureKind } from "./platform.tsx";

/** A point of the page: CSS pixels from the top left corner of the viewport. */
export interface Point {
  x: number;
  y: number;
}

/** A box of the page, as `getBoundingClientRect` measures it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A position of Tauri's drag events — physical pixels from the top left
 * corner of the webview — in the page's CSS pixels. The device pixel ratio
 * is the scale of the display: 1.5 on a screen scaled to 150 %.
 */
export function pagePoint(position: Point, devicePixelRatio: number): Point {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

/**
 * Whether a box holds a point. Its left and top edges are in it, its right
 * and bottom edges belong to the box next to it, so two tiles side by side
 * never both hold the point between them.
 */
export function boxHolds(box: Box, point: Point): boolean {
  return point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;
}

/** A drag of files over the window, as the launcher's host hands it on. */
export type FileDrag =
  | { type: "enter"; paths: string[]; point: Point }
  | { type: "over"; point: Point }
  | { type: "drop"; paths: string[]; point: Point }
  | { type: "leave" };

/** One tile that takes dropped files. */
export interface DropZone {
  /** The tile's box now; `null` while it is not on the page. */
  box: () => Box | null;
  /**
   * Whether the tile itself, not something laid over it — a dialog, the
   * chat drawer, the save bar — is at the point. Without it the whole box
   * counts.
   */
  shows?: (point: Point) => boolean;
  /** A drag came over the tile with this many files, or left it: `null`. */
  hover: (files: number | null) => void;
  /** Files were dropped on the tile. */
  drop: (paths: string[]) => void;
}

/** Where the tiles of a window add themselves. `add` answers the function that takes the zone away. */
export interface DropZones {
  add: (zone: DropZone) => () => void;
}

export interface DropRouter extends DropZones {
  /** One drag of the window. */
  handle: (drag: FileDrag) => void;
}

/**
 * Hands the drags of one window to the tiles under them. A drag is over one
 * tile at most: the first whose box holds the point and which shows there.
 *
 * `claim` tells the host whether a drop now would land on a tile, so the
 * launcher's core keeps such a drop from the chat composer of the window.
 * It is called when that changes, not after a drop or a leave: the core ends
 * the claim with them by itself.
 */
export function createDropRouter(claim: (claimed: boolean) => void = () => undefined): DropRouter {
  const zones = new Set<DropZone>();
  /** The files of the drag over the window: 0 when none is, or when its start came before the first tile. */
  let files = 0;
  let current: DropZone | null = null;
  let claimed = false;

  const zoneAt = (point: Point): DropZone | null => {
    for (const zone of zones) {
      const box = zone.box();
      if (box !== null && boxHolds(box, point) && (zone.shows?.(point) ?? true)) return zone;
    }
    return null;
  };

  /** Moves the drag to `next`; `ended` when the drop or the leave closed it. */
  const moveTo = (next: DropZone | null, ended: boolean) => {
    if (next !== current) {
      const previous = current;
      current = next;
      previous?.hover(null);
      next?.hover(files);
    }
    if (ended) {
      claimed = false;
    } else if (claimed !== (next !== null)) {
      claimed = next !== null;
      claim(claimed);
    }
  };

  return {
    add(zone) {
      zones.add(zone);
      return () => {
        zones.delete(zone);
        if (current !== zone) return;
        current = null;
        if (claimed) {
          claimed = false;
          claim(false);
        }
      };
    },
    handle(drag) {
      switch (drag.type) {
        case "enter":
          files = drag.paths.length;
          moveTo(files > 0 ? zoneAt(drag.point) : null, false);
          return;
        case "over":
          moveTo(files > 0 ? zoneAt(drag.point) : null, false);
          return;
        case "drop": {
          const zone = drag.paths.length > 0 ? zoneAt(drag.point) : null;
          files = 0;
          moveTo(null, true);
          zone?.drop(drag.paths);
          return;
        }
        case "leave":
          files = 0;
          moveTo(null, true);
      }
    },
  };
}

/** What a drag event of the page shows of its contents before the drop. */
export interface DragContents {
  types: ArrayLike<string>;
  items?: ArrayLike<{ kind: string }> | null;
}

/**
 * How many files a drag of the page carries: 0 for a drag of text or a
 * link, which a tile leaves alone. Until the drop the page may not read the
 * files, but it sees an entry for each; a browser that hides even those
 * counts as one.
 */
export function draggedFiles(contents: DragContents | null | undefined): number {
  if (!contents || !Array.from(contents.types).includes("Files")) return 0;
  const entries = contents.items ? Array.from(contents.items).filter((item) => item.kind === "file").length : 0;
  return Math.max(1, entries);
}

/** A dropped file as a tile knows it before reading it: the launcher knows no size. */
export interface DroppedFile {
  name: string;
  size?: number;
}

/**
 * Why a drop gives no picture before a byte is read: one of the refusals of
 * a picked file, or more files than the tile takes.
 */
export type DropRefusal = ImageRefusal | { reason: "several" };

/**
 * The checks of a drop that need no bytes: one file, no larger than its
 * kind takes. `null` when the file goes on — its type is its first bytes',
 * as for a picked file, so `photo.jfif` holding a JPEG passes and
 * `notes.png` holding text does not — and for a drop of no file at all.
 */
export function dropRefusal(files: readonly DroppedFile[], kind: PictureKind): DropRefusal | null {
  if (files.length > 1) return { reason: "several" };
  const [file] = files;
  if (file === undefined) return null;
  const maxBytes = IMAGE_MAX_BYTES[kind];
  return file.size !== undefined && file.size > maxBytes ? { reason: "tooBig", fileName: file.name, maxBytes } : null;
}
