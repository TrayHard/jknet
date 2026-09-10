import { useEffect, type ReactNode } from "react";

interface AccountDialogProps {
  title: string;
  /** One or two sentences saying what the choice means. */
  body: string;
  /** Buttons of the footer, right aligned. */
  actions: ReactNode;
  onClose: () => void;
}

/**
 * The modal shell of the account card: overlay, card, title, footer.
 *
 * A copy of the shell the Library screen uses, and deliberately so while three
 * slices are being written at once: the Figma kit has a Dialog component, the
 * UI kit in `components/ui` does not yet, and two branches adding the same new
 * file to it would collide. Move both into the kit once they meet.
 */
export function AccountDialog({
  title,
  body,
  actions,
  onClose,
}: AccountDialogProps) {
  // Escape closes from anywhere, including while the focus sits on a button.
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
      <div className="w-full max-w-[480px] rounded-xl border border-line bg-surface p-24 shadow-popover">
        <h2 className="text-display-md text-fg">{title}</h2>
        <p className="text-body-sm text-fg-secondary pt-4">{body}</p>
        <div className="flex items-center justify-end gap-8 pt-24">{actions}</div>
      </div>
    </div>
  );
}
