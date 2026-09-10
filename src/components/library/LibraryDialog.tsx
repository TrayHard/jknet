import { useEffect, type ReactNode } from "react";

import { cn } from "../../lib/format";

interface LibraryDialogProps {
  title: string;
  /** One sentence under the title saying what the choice means. */
  body?: string;
  /** Buttons of the footer, right aligned. */
  actions: ReactNode;
  onClose: () => void;
  /** Wider shell for a list, as the conflict dialog needs. */
  wide?: boolean;
  children?: ReactNode;
}

/**
 * The modal shell of the Library screen: overlay, card, title, footer.
 *
 * The Figma kit has a Dialog component, but the UI kit in `components/ui`
 * does not yet, and three slices are being written at once. The shell lives
 * here until the branches meet, then it moves to the kit unchanged.
 */
export function LibraryDialog({
  title,
  body,
  actions,
  onClose,
  wide = false,
  children,
}: LibraryDialogProps) {
  // Escape closes from anywhere, including while the focus sits on a button
  // deep inside the list.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-24"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={cn(
          "w-full rounded-xl border border-line bg-surface p-24 shadow-popover",
          wide ? "max-w-[720px]" : "max-w-[480px]",
        )}
      >
        <h2 className="text-display-md text-fg">{title}</h2>
        {body ? <p className="text-body-sm text-fg-secondary pt-4">{body}</p> : null}
        {children}
        <div className="flex items-center justify-end gap-8 pt-24">{actions}</div>
      </div>
    </div>
  );
}
