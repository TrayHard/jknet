/**
 * Choosing a picture and putting it in the store of JKNet Online, the way the
 * host can: the launcher's core behind its own dialog (`pickImage`, the
 * command `community_pick_image`), or a file input whose file is checked and
 * hashed here and handed to the host's `putBlob` (the website). The logo and
 * the cover of the management screen and the cover of an event in its editor
 * go through this one hook; the web app gives neither and uploads nothing.
 *
 * The same picture can be dropped on its tile, {@link PictureDropZone}. The
 * launcher's webview gets the paths of a drop, never the bytes: the tile adds
 * itself to the host's `dropZones`, and the path of a drop on it goes to the
 * core's `dropImage`, which checks and uploads the file as its dialog does.
 * The website reads the files of the page's own drag events and sends them
 * the way of its file input.
 *
 * A refusal — too big, not a PNG, JPEG or WebP, several files dropped at
 * once — is an answer, not an error: the screen says it with
 * {@link usePictureRefusalText}. A failed upload is the error the host threw,
 * for the screen to put in its own sentence.
 */

import { AlertCircle, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { useSizeText } from "./manage/parts";
import { IMAGE_ACCEPT, uploadImageFile } from "./manage/upload";
import { draggedFiles, dropRefusal, type DropRefusal } from "./pictureDrop";
import { useCommunityPlatform, type PickedImage, type PictureKind, type UploadedImage } from "./platform";
import { useAction } from "./useRemote";

/** Why the last choice or drop did not give a picture: the checks refused it, or the upload failed. */
export type PictureProblem = { refused: DropRefusal } | { failed: unknown };

/** What was dropped on a tile: the paths of the launcher's drag, or the files of the page's. */
export type DroppedPictures = { paths: string[] } | { files: File[] };

export interface PictureUpload {
  /** The host can upload: the launcher's dialog or the website's file input. */
  canUpload: boolean;
  busy: boolean;
  problem: PictureProblem | null;
  /** Opens the dialog or the file input. */
  choose: () => void;
  /** The hidden file input of a host without the dialog; render it anywhere in the screen. */
  fileInput: ReactNode;
  /** How a drop reaches the picture: the launcher's paths, the page's files, or not at all. */
  dropVia: "paths" | "files" | null;
  /** Takes what was dropped on the tile, as `choose` takes a chosen file. */
  drop: (dropped: DroppedPictures) => void;
}

/**
 * One picture of a screen. `label` names the hidden file input for screen
 * readers; `onUploaded` gets the picture once it is in the store.
 */
export function usePictureUpload(kind: PictureKind, label: string, onUploaded: (image: UploadedImage) => void): PictureUpload {
  const platform = useCommunityPlatform();
  const action = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<PictureProblem | null>(null);
  const { pickImage, putBlob, dropImage, dropZones } = platform;

  /** The core's answer to its dialog or to a drop. */
  const fromCore = (ask: () => Promise<PickedImage>) => {
    void action.run(
      async () => {
        const result = await ask();
        if (result.outcome === "refused") setProblem({ refused: result });
        if (result.outcome === "uploaded") onUploaded(result);
      },
      (reason) => setProblem({ failed: reason }),
    );
  };

  const choose = () => {
    setProblem(null);
    if (pickImage) {
      fromCore(() => pickImage(kind));
      return;
    }
    input.current?.click();
  };

  const fromFile = (file: File | undefined) => {
    if (!file || !putBlob) return;
    void action.run(
      async () => {
        const result = await uploadImageFile(file, kind, putBlob);
        if ("refused" in result) setProblem({ refused: result.refused });
        else onUploaded(result.uploaded);
      },
      (reason) => setProblem({ failed: reason }),
    );
  };

  const dropVia = pickImage ? (dropImage && dropZones ? "paths" : null) : putBlob ? "files" : null;

  const drop = (dropped: DroppedPictures) => {
    setProblem(null);
    if ("paths" in dropped) {
      const refused = dropRefusal(
        dropped.paths.map((path) => ({ name: path })),
        kind,
      );
      const [path] = dropped.paths;
      if (refused) setProblem({ refused });
      else if (path !== undefined && dropImage) fromCore(() => dropImage(kind, path));
      return;
    }
    const refused = dropRefusal(dropped.files, kind);
    if (refused) setProblem({ refused });
    else fromFile(dropped.files[0]);
  };

  const fileInput =
    pickImage === undefined && putBlob ? (
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        aria-label={label}
        onChange={(event) => {
          fromFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    ) : null;

  return {
    canUpload: pickImage !== undefined || putBlob !== undefined,
    busy: action.busy,
    problem,
    choose,
    fileInput,
    dropVia,
    drop,
  };
}

/** The sentence of a refused file: the size it may take, the types the service takes, one file at a time. */
export function usePictureRefusalText(): (refused: DropRefusal) => string {
  const { t } = useTranslation("community");
  const sizeText = useSizeText();
  return useCallback(
    (refused: DropRefusal) =>
      refused.reason === "several"
        ? t("manage.images.several")
        : refused.reason === "tooBig"
          ? t("manage.images.tooBig", { name: refused.fileName, max: sizeText(refused.maxBytes) })
          : t("manage.images.notPicture", { name: refused.fileName }),
    [t, sizeText],
  );
}

/**
 * A picture's tile that takes a dropped file: the box of a logo or of a
 * cover. While a file is dragged over it, the tile is outlined in the accent
 * colour and says to let go; a drag of several files says to drop one. A
 * busy tile takes nothing until its upload ends. `framed` is a tile that
 * draws its own border, which the outline then covers.
 *
 * In the launcher the tile is a zone of the host's `dropZones`, which
 * hit-tests the drags of the window against its box. On the website it hears
 * the page's drag events, and while it is on the page a file dropped beside
 * every tile does nothing instead of opening in the browser over the form.
 */
export function PictureDropZone({
  upload,
  framed = false,
  className,
  children,
}: {
  upload: PictureUpload;
  framed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { dropZones } = useCommunityPlatform();
  const element = useRef<HTMLDivElement>(null);
  /** The files of the drag over the tile; `null` while none is. */
  const [files, setFiles] = useState<number | null>(null);
  const depth = useRef(0);
  const take = useRef(upload.drop);
  take.current = upload.drop;
  const { dropVia } = upload;
  const open = dropVia !== null && !upload.busy;

  useEffect(() => {
    if (!open || dropVia !== "paths" || !dropZones) return;
    return dropZones.add({
      box: () => element.current?.getBoundingClientRect() ?? null,
      shows: (point) => {
        const tile = element.current;
        const top = typeof document.elementFromPoint === "function" ? document.elementFromPoint(point.x, point.y) : null;
        return tile !== null && top !== null && tile.contains(top);
      },
      hover: setFiles,
      drop: (paths) => take.current({ paths }),
    });
  }, [open, dropVia, dropZones]);

  useEffect(() => {
    if (open) return;
    depth.current = 0;
    setFiles(null);
  }, [open]);

  useEffect(() => (dropVia === "files" ? guardPageDrops() : undefined), [dropVia]);

  const page = open && dropVia === "files";
  const handlers = page
    ? {
        onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => {
          const count = draggedFiles(event.dataTransfer);
          if (count === 0) return;
          event.preventDefault();
          depth.current += 1;
          setFiles(count);
        },
        onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
          if (draggedFiles(event.dataTransfer) === 0) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        // Every element of the tile the drag crosses is entered before the one
        // it leaves; the drag is off the tile when the count is back at none.
        onDragLeave: () => {
          if (depth.current === 0) return;
          depth.current -= 1;
          if (depth.current === 0) setFiles(null);
        },
        onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
          if (draggedFiles(event.dataTransfer) === 0) return;
          event.preventDefault();
          depth.current = 0;
          setFiles(null);
          take.current({ files: Array.from(event.dataTransfer.files) });
        },
      }
    : {};

  return (
    <div ref={element} className={cn("relative", className)} {...handlers}>
      {children}
      {files !== null ? <DropHint files={files} framed={framed} /> : null}
    </div>
  );
}

/** What a tile says while a drag is over it: let go, or drop one file. */
function DropHint({ files, framed }: { files: number; framed: boolean }) {
  const { t } = useTranslation("community");
  const one = files <= 1;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-10 flex flex-col items-center justify-center gap-6 rounded-[inherit] border-2 border-dashed px-12 text-center",
        framed ? "-inset-px" : "inset-0",
        one ? "border-line-accent bg-accent-subtle" : "border-line-warm bg-warm-subtle",
      )}
    >
      {one ? <Upload size={18} className="text-fg-accent" /> : <AlertCircle size={18} className="text-fg-warm" />}
      <span className="text-body-sm-medium text-fg">{one ? t("manage.images.dropHint") : t("manage.images.dropOne")}</span>
    </div>
  );
}

/** The tiles on the page that keep a stray drop of files from opening in the browser. */
let guards = 0;

function stopStrayDrop(event: DragEvent) {
  if (event.defaultPrevented || draggedFiles(event.dataTransfer) === 0) return;
  event.preventDefault();
  if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "none";
}

/**
 * While a tile is on the page, files dropped beside every tile do nothing:
 * the browser would open them in place of the page, and the edits of the
 * form would go with it. A tile, or the Markdown editor, that takes the drop
 * cancels the event first and is left alone. Answers the end of the guard.
 */
function guardPageDrops(): () => void {
  if (guards++ === 0) {
    window.addEventListener("dragover", stopStrayDrop);
    window.addEventListener("drop", stopStrayDrop);
  }
  return () => {
    if (--guards > 0) return;
    window.removeEventListener("dragover", stopStrayDrop);
    window.removeEventListener("drop", stopStrayDrop);
  };
}
