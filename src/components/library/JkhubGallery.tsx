import { ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { JkhubScreenshot } from "../../lib/ipc";
import { Button } from "../ui";

export function JkhubGallery({ shots, initialIndex, onClose }: {
  shots: JkhubScreenshot[];
  initialIndex: number;
  onClose: () => void;
}) {
  const { t } = useTranslation("jkhub");
  const { t: tCommon } = useTranslation("common");
  const [index, setIndex] = useState(initialIndex);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const panel = useRef<HTMLDivElement>(null);
  const wheelAt = useRef(-Infinity);
  const currentIndex = Math.min(index, shots.length - 1);
  const move = (step: number) => setIndex(current => (Math.min(current, shots.length - 1) + step + shots.length) % shots.length);
  const url = shots[currentIndex].url;

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Escape") onClose();
        else setIndex(current => (Math.min(current, shots.length - 1) + (event.key === "ArrowRight" ? 1 : -1) + shots.length) % shots.length);
      }
    };
    // Capture before the underlying details dialog handles Escape.
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [onClose, shots.length]);

  return (
    <div ref={panel} role="dialog" aria-modal="true" aria-label={t("details.screenshot")}
      className="fixed inset-0 z-60 flex flex-col items-center justify-center gap-12 bg-overlay p-24"
      onClick={event => {
        if (!(event.target as HTMLElement).closest("img, button")) onClose();
      }}
      onWheel={event => {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (Math.abs(delta) >= 8 && event.timeStamp - wheelAt.current > 250) {
          wheelAt.current = event.timeStamp;
          move(delta > 0 ? 1 : -1);
        }
      }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="flex w-full items-center justify-end">
        <Button aria-label={tCommon("actions.close")} onClick={onClose} className="px-8"><X size={20} aria-hidden /></Button>
      </div>
      <div className="flex w-full flex-1 min-h-0 items-center justify-center gap-16">
        <Button aria-label={t("gallery.previous")} title={t("gallery.previous")} disabled={shots.length < 2} onClick={() => move(-1)} className="shrink-0 px-8"><ChevronLeft size={24} aria-hidden /></Button>
        <div className="flex items-center justify-center min-w-0 h-full flex-1">
          {broken.has(url) ? <p className="flex items-center gap-8 rounded-md bg-surface p-24 text-body-sm text-fg-muted"><ImageOff size={16} />{t("details.screenshotMissing")}</p> : (
            <img key={url} src={url} alt={t("gallery.position", { current: currentIndex + 1, total: shots.length })} decoding="async" referrerPolicy="no-referrer"
              onError={() => setBroken(current => new Set(current).add(url))} className="max-h-full max-w-full object-contain rounded-md" />
          )}
        </div>
        <Button aria-label={t("gallery.next")} title={t("gallery.next")} disabled={shots.length < 2} onClick={() => move(1)} className="shrink-0 px-8"><ChevronRight size={24} aria-hidden /></Button>
      </div>
      <p aria-live="polite" className="text-body-sm text-fg">{t("gallery.position", { current: currentIndex + 1, total: shots.length })}</p>
      <p className="text-body-sm text-fg-secondary">{t("gallery.hint")}</p>
    </div>
  );
}
