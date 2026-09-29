import { X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../../src/lib/format.ts";

interface DetailsProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

function DetailsHead({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useTranslation("web");
  return (
    <div className="flex h-64 shrink-0 items-center gap-8 border-b border-line-subtle pr-12 pl-16">
      <h2 className="min-w-0 flex-1 truncate text-heading-md text-fg">{title}</h2>
      <button
        type="button"
        aria-label={t("nav.closeDetails")}
        onClick={onClose}
        className="flex size-36 items-center justify-center rounded-md text-fg-secondary cursor-pointer hover:bg-hover-overlay hover:text-fg"
      >
        <X size={18} />
      </button>
    </div>
  );
}

/** The details column of a screen 1200 px and wider: a fourth column, 288 px. */
export function DetailsColumn({ title, onClose, children }: DetailsProps) {
  return (
    <aside
      data-testid="details-column"
      aria-label={title}
      className="flex w-288 shrink-0 flex-col border-l border-line-subtle bg-app"
    >
      <DetailsHead title={title} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </aside>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The details column between 900 and 1199 px: a sheet over the right edge of
 * the content pane, with a scrim. Escape and the scrim close it. It is modal:
 * Tab stays inside it, and closing it puts the focus back on what opened it.
 */
export function DetailsSheet({ title, onClose, children }: DetailsProps) {
  const panel = useRef<HTMLElement>(null);

  // The focus goes to the sheet, and back to its opener when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (opener !== null && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const holdFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || panel.current === null) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (event.shiftKey && (at === first || at === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="absolute inset-0 z-30" data-testid="details-sheet">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-overlay cursor-default"
      />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={holdFocus}
        className={cn(
          "details-sheet-in absolute inset-y-0 right-0 flex w-288 flex-col border-l border-line-subtle bg-app shadow-popover outline-none",
        )}
      >
        <DetailsHead title={title} onClose={onClose} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}
