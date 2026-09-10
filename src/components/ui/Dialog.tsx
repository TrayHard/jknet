import { useEffect, type ReactNode } from "react";

import { cn } from "../../lib/format";

/** `danger` is for a dialog whose confirming button destroys something. */
export type DialogVariant = "default" | "danger";

interface DialogProps {
  title: string;
  /** One or two sentences saying what the choice means. */
  body?: string;
  /** Buttons of the footer, right aligned. Keep it to one or two. */
  actions: ReactNode;
  /** Escape, a click on the overlay and the Cancel button all end here. */
  onClose: () => void;
  variant?: DialogVariant;
  /** Wider shell for a list, as the conflict dialog needs. */
  wide?: boolean;
  /** Anything between the body and the footer: a list, a form, a warning. */
  children?: ReactNode;
}

/**
 * The modal shell of the Dialog component in the Figma kit: overlay, card,
 * title, body, footer.
 *
 * One shell for every screen. The Library and the Account card each carried
 * their own copy while three slices were being written at once, and the two
 * had already drifted — only one of them took a `wide` list, and neither closed
 * on a click outside.
 *
 * The danger variant paints the border and the title rather than adding
 * anything: the eye lands on the title first, and the button that does the
 * destroying is already `variant="danger"` in the footer.
 */
export function Dialog({
  title,
  body,
  actions,
  onClose,
  variant = "default",
  wide = false,
  children,
}: DialogProps) {
  // Escape closes from anywhere, including while the focus sits on a button
  // deep inside the content.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const danger = variant === "danger";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-24"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // The overlay closes, the card does not: comparing the two nodes is what
      // keeps a click that started on a button inside from closing the dialog
      // as it travels up.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-full rounded-xl border bg-surface p-24 shadow-popover",
          danger ? "border-line-danger" : "border-line",
          wide ? "max-w-[720px]" : "max-w-[480px]",
        )}
      >
        <h2 className={cn("text-display-md", danger ? "text-fg-danger" : "text-fg")}>
          {title}
        </h2>
        {body ? <p className="text-body-sm text-fg-secondary pt-4">{body}</p> : null}
        {children}
        <div className="flex items-center justify-end gap-8 pt-24">{actions}</div>
      </div>
    </div>
  );
}
