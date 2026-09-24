import { ChevronDown, ChevronLeft, ChevronRight, Image as ImageIcon, ImageOff, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useFormat, type Formatters } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type { FilePreviewEntry, FilePreviewSource } from "../../lib/ipc";
import { imageNotes, levelshotHasMap, subgroupKey, subgroupOf } from "../../lib/previewKinds";
import { useFilePreviewImage } from "../../lib/queries";
import { Button } from "../ui";
import { usePreviewOverlay } from "./previewOverlay";

/**
 * --- slice: pk3 contents ---
 * The pictures of an archive: a grid of thumbnails per group, split by
 * subfolder, and the enlarged view of one of them over the dialog.
 *
 * A thumbnail is asked of the core only once it scrolls into view, at
 * `THUMBNAIL_SIZE` on its longer side, and stays in the query cache of the
 * session; the enlarged view asks for the picture at its own size. Both go
 * through `get_file_preview_image`, which hands a TGA back as PNG.
 */

/** The longer side of a thumbnail, in pixels. */
const THUMBNAIL_SIZE = 192;

/** True once the element has scrolled to within a screen of the viewport, and from then on. */
function useVisible(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (visible || !node) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(found => {
      if (found.some(one => one.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "256px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, visible]);
  return visible;
}

/** `512×512 · JPG · 84.2 KB`: what the header of the picture says, and its weight. */
function imageCaption(entry: FilePreviewEntry, format: Formatters): string {
  const parts: string[] = [];
  if (entry.image && entry.image.width > 0 && entry.image.height > 0) parts.push(`${entry.image.width}×${entry.image.height}`);
  if (entry.image) parts.push(entry.image.format.toUpperCase());
  if (entry.size != null) parts.push(format.bytes(entry.size));
  return parts.join(" · ");
}

/**
 * What a caption says beside the size: the map of a level shot and whether
 * the archive brings it, the role of a splash picture, the console font,
 * and a texture the vanilla renderer refuses.
 */
function ImageNotes({ entry, all, className }: { entry: FilePreviewEntry; all: readonly FilePreviewEntry[]; className?: string }) {
  const { t } = useTranslation("library");
  const notes = imageNotes(entry);
  if (entry.kind !== "levelshot" && notes.length === 0) return null;
  return <span className={cn("flex flex-col gap-2 text-body-sm", className)}>
    {entry.kind === "levelshot" ? <>
      <span className="text-fg-secondary truncate" title={entry.map ?? undefined}>{t("preview.gallery.map", { map: entry.map ?? entry.label })}</span>
      {levelshotHasMap(entry, all)
        ? <span className="text-fg-success">{t("preview.gallery.mapInArchive")}</span>
        : <span className="text-fg-muted">{t("preview.gallery.mapNotInArchive")}</span>}
    </> : null}
    {notes.map(note => <span key={note.code} className={note.code === "notPowerOfTwo" ? "text-fg-warm" : "text-fg-secondary"}>
      {note.code === "titles" ? t("preview.gallery.titles", { language: note.language }) : t(`preview.gallery.${note.code}`)}
    </span>)}
  </span>;
}

/** One cell of the grid. Memoised: a pick re-renders the two cells it changes, not the two thousand around them. */
const Thumbnail = memo(function Thumbnail({ previewId, entry, all, selected, onPick, onEnlarge }: {
  previewId: string; entry: FilePreviewEntry; all: readonly FilePreviewEntry[]; selected: boolean;
  onPick: (id: string) => void; onEnlarge: (id: string) => void;
}) {
  const format = useFormat();
  const ref = useRef<HTMLLIElement>(null);
  const visible = useVisible(ref);
  const source = useMemo<FilePreviewSource>(() => ({ previewId, archive: entry.archive }), [previewId, entry.archive]);
  const image = useFilePreviewImage(source, entry.name, THUMBNAIL_SIZE, visible);
  // A pick made in the list brings its picture into view.
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return <li ref={ref}>
    <button type="button" onClick={() => { onPick(entry.id); onEnlarge(entry.id); }} aria-pressed={selected} title={entry.name}
      className={cn("w-full h-full flex flex-col gap-6 p-6 rounded-md border text-left cursor-pointer transition-colors duration-150",
        selected ? "border-line-focus bg-accent-subtle" : "border-transparent hover:bg-hover-overlay")}>
      <span className="relative block w-full aspect-square rounded-sm bg-elevated overflow-hidden">
        {image.data ? <img src={image.data.dataUrl} alt="" decoding="async" className="absolute inset-0 size-full object-contain" />
          : <span className="absolute inset-0 flex items-center justify-center text-fg-muted">
            {image.error ? <ImageOff size={24} aria-hidden="true" /> : <ImageIcon size={24} aria-hidden="true" />}
          </span>}
      </span>
      <span className="block min-w-0 w-full">
        <span className="block text-body-sm text-fg truncate">{entry.label}</span>
        <span className="block text-mono-xs text-fg-muted truncate">{imageCaption(entry, format)}</span>
        <ImageNotes entry={entry} all={all} className="pt-2" />
      </span>
    </button>
  </li>;
});

/**
 * How many cells the grid draws before **Load more**. The textures of a
 * large map pack run into the thousands; a cell each would be mounted at
 * once, observers and all, for pictures nobody has scrolled to.
 */
const GALLERY_PAGE = 240;

/**
 * The grid of one group of pictures, in Advanced a heading per subfolder that
 * folds it. The folded folders are those of the list: one set of keys, so a
 * folder folded on the left is folded here too. A folded folder mounts no
 * cell, so it asks the core for no thumbnail, and its pictures do not count
 * against the page.
 */
export function Gallery({ previewId, entries, all, selectedId, subgrouped, collapsed, onToggle, onPick, onEnlarge }: {
  previewId: string; entries: readonly FilePreviewEntry[]; all: readonly FilePreviewEntry[]; selectedId: string | undefined;
  subgrouped: boolean; collapsed: ReadonlySet<string>; onToggle: (key: string) => void;
  onPick: (id: string) => void; onEnlarge: (id: string) => void;
}) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const [shown, setShown] = useState(GALLERY_PAGE);
  useEffect(() => { setShown(GALLERY_PAGE); }, [entries]);
  const subgroups = useMemo(() => {
    const map = new Map<string, FilePreviewEntry[]>();
    for (const entry of entries) {
      const key = subgroupOf(entry);
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    return [...map.entries()];
  }, [entries]);
  const titled = subgrouped && subgroups.some(([name]) => name !== "");
  // The cells that can be drawn: the pictures of the folders left unfolded, cut to the page.
  // The selected picture is always drawn, so a pick in the list past the page brings its page in.
  const unfolded = useMemo(() => titled ? entries.filter(entry => !collapsed.has(subgroupKey(entry))) : entries, [entries, titled, collapsed]);
  const at = unfolded.findIndex(entry => entry.id === selectedId);
  const drawn = Math.min(unfolded.length, Math.max(shown, at + 1));
  const drawnIds = useMemo(() => new Set(unfolded.slice(0, drawn).map(entry => entry.id)), [unfolded, drawn]);
  const kind = entries[0]?.kind;
  const sections: [string, FilePreviewEntry[]][] = titled ? subgroups : [["", [...entries]]];
  return <div className="flex flex-col gap-16">
    {kind ? <p className="text-body-sm text-fg-secondary">
      {t(`preview.kind.${kind}`)}<span className="text-fg-muted"> · {t("preview.gallery.count", { count: entries.length })}</span>
    </p> : null}
    {sections.map(([name, rows]) => {
      const key = `${kind}/${name}`;
      const folded = titled && collapsed.has(key);
      const cells = rows.filter(entry => drawnIds.has(entry.id));
      // A folder past the page appears once **Load more** reaches it; a folded one stands at once, as a heading alone.
      if (!folded && cells.length === 0) return null;
      return <section key={name} className="flex flex-col gap-8" aria-label={name || t("preview.rootFolder")}>
        {titled ? <h4 className="text-label-xs text-fg-muted">
          <button type="button" aria-expanded={!folded} onClick={() => onToggle(key)} title={name || undefined}
            className="w-full flex items-center gap-8 py-4 text-left rounded-sm cursor-pointer select-none transition-colors duration-150 hover:text-fg">
            {folded ? <ChevronRight size={14} aria-hidden="true" className="shrink-0" /> : <ChevronDown size={14} aria-hidden="true" className="shrink-0" />}
            <span className="normal-case tracking-normal text-mono-xs truncate">{name || t("preview.rootFolder")}</span>
            <span className="text-mono-xs tabular-nums">{rows.length}</span>
          </button>
        </h4> : null}
        {!folded ? <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(168px,100%),1fr))] gap-8">
          {cells.map(entry => <Thumbnail key={entry.id} previewId={previewId} entry={entry} all={all} selected={entry.id === selectedId} onPick={onPick} onEnlarge={onEnlarge} />)}
        </ul> : null}
      </section>;
    })}
    {drawn < unfolded.length ? <div><Button size="sm" variant="ghost" onClick={() => setShown(value => value + GALLERY_PAGE)}>{common("actions.loadMore")}</Button></div> : null}
  </div>;
}

/**
 * One picture at its own size, over the dialog; the arrows and the keys walk
 * the group. Escape closes the picture alone: the frame stands aside while
 * the overlay is up, and the listener here stops the key before the dialog
 * under it sees it.
 */
export function Lightbox({ previewId, entries, all, index, onMove, onClose }: {
  previewId: string; entries: readonly FilePreviewEntry[]; all: readonly FilePreviewEntry[]; index: number;
  onMove: (index: number) => void; onClose: () => void;
}) {
  const { t } = useTranslation("library");
  const { t: common } = useTranslation("common");
  const format = useFormat();
  const errorText = useErrorText();
  const panel = useRef<HTMLDivElement>(null);
  const entry = entries[index];
  usePreviewOverlay(true);
  const source = useMemo<FilePreviewSource>(() => ({ previewId, archive: entry.archive }), [previewId, entry.archive]);
  const image = useFilePreviewImage(source, entry.name, undefined);
  const move = (step: number) => onMove((index + step + entries.length) % entries.length);

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") onClose();
      else if (entries.length > 1) onMove((index + (event.key === "ArrowRight" ? 1 : -1) + entries.length) % entries.length);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [onClose, onMove, index, entries.length]);

  // A small picture — an icon, a crosshair — is drawn enlarged so that it can be seen at all.
  const width = image.data?.width ?? 0;
  const scale = width > 0 && width <= 64 ? 6 : width > 0 && width <= 128 ? 4 : width > 0 && width <= 256 ? 2 : 1;
  return <div ref={panel} role="dialog" aria-modal="true" aria-label={entry.label}
    className="fixed inset-0 z-60 flex flex-col gap-12 bg-overlay p-24"
    onClick={event => { if (!(event.target as HTMLElement).closest("img, button, p, span")) onClose(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="flex items-start gap-12">
      <div className="flex-1 min-w-0">
        <p className="text-body-md-medium text-fg truncate">{entry.label}</p>
        <p className="text-mono-xs text-fg-muted truncate" title={entry.name}>{entry.name}{imageCaption(entry, format) ? ` · ${imageCaption(entry, format)}` : ""}</p>
      </div>
      <Button aria-label={common("actions.close")} onClick={onClose} className="px-8 shrink-0"><X size={20} aria-hidden="true" /></Button>
    </div>
    <div className="flex w-full flex-1 min-h-0 items-center justify-center gap-16">
      <Button aria-label={t("preview.previous")} title={t("preview.previous")} disabled={entries.length < 2} onClick={() => move(-1)} className="shrink-0 px-8"><ChevronLeft size={24} aria-hidden="true" /></Button>
      <div className="flex items-center justify-center min-w-0 h-full flex-1 overflow-hidden">
        {image.data ? <img key={entry.id} src={image.data.dataUrl} alt={entry.label} decoding="async"
          className="max-h-full max-w-full object-contain rounded-sm bg-elevated"
          style={{ width: scale > 1 ? image.data.width * scale : undefined, imageRendering: scale > 1 ? "pixelated" : "auto" }} />
          : (image.error ? <div role="alert" className="flex flex-col items-start gap-12 rounded-md bg-surface p-24">
            <p className="text-body-sm text-fg-danger">{errorText(image.error)}</p>
            <Button onClick={() => void image.refetch()}>{common("actions.tryAgain")}</Button>
          </div> : <p role="status" className="text-body-sm text-fg-muted">{t("preview.loading")}</p>)}
      </div>
      <Button aria-label={t("preview.next")} title={t("preview.next")} disabled={entries.length < 2} onClick={() => move(1)} className="shrink-0 px-8"><ChevronRight size={24} aria-hidden="true" /></Button>
    </div>
    <div className="flex items-end gap-12">
      <ImageNotes entry={entry} all={all} className="flex-1 min-w-0" />
      <p aria-live="polite" className="text-mono-xs text-fg-muted ml-auto whitespace-nowrap">{index + 1} / {entries.length}</p>
    </div>
  </div>;
}
