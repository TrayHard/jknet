import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/format";

/** `danger` is for a dialog whose confirming button destroys something. */
export type DialogVariant = "default" | "danger";

/**
 * What a Tab stops on, in the order the browser walks them.
 *
 * Enough for the dialogs of the launcher: every control they hold is one of
 * these, a disabled one is left out by the same rule the browser uses, and the
 * card itself is excluded by the last clause, since it carries `tabIndex={-1}`.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The focusable children of the card, the hidden ones dropped.
 *
 * `offsetParent` is the cheap way to ask whether a node is drawn at all: a
 * control inside a collapsed block is in the markup and out of the tab order,
 * and a loop that counted it would stop one element short of the end.
 */
function focusableIn(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null,
  );
}

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
  const cardRef = useRef<HTMLDivElement>(null);

  // Escape closes from anywhere, including while the focus sits on a button
  // deep inside the content.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  /**
   * The focus goes into the card on open and back where it came from on close.
   *
   * Both halves matter. A modal that leaves the focus behind it is a modal the
   * keyboard never enters: the first Tab walks the screen underneath, which is
   * the very thing the overlay says is out of reach. And a modal that closes
   * without giving the focus back leaves it nowhere — the card takes its whole
   * subtree with it, the browser drops the focus on `<body>`, and the next Tab
   * starts over at the top of the window instead of at the button the player
   * pressed to open the dialog.
   *
   * The first focusable control gets it rather than the card, so that the
   * dialog is not only announced but ready to be answered. Every dialog of the
   * launcher puts **Cancel** before the button that acts, so this is never the
   * destructive one.
   */
  useEffect(() => {
    const opener = document.activeElement;
    const card = cardRef.current;
    const first: HTMLElement | undefined =
      card === null ? undefined : focusableIn(card)[0];
    (first ?? card)?.focus();
    return () => {
      // Only if it is still on the page: the dialog that deleted a client has
      // no row left to hand the focus back to.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
    // Once, when the dialog opens: the card stands until it closes.
  }, []);

  /**
   * Tab and Shift+Tab go round the card instead of out of it.
   *
   * A list of the focusable children and a wrap at either end — enough for a
   * card of one form, and short enough to stay true as the dialogs change.
   */
  const holdFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const card = cardRef.current;
    const active = document.activeElement;
    if (card === null || !(active instanceof HTMLElement)) return;
    // A `Select`, a `Combobox` or a `Menu` draws its popover in a portal of its
    // own and answers Tab itself, putting the focus back on its trigger inside
    // the card before this handler sees the key. A focus still outside belongs
    // to that popover, and the loop has no business moving it.
    if (!card.contains(active)) return;
    const items = focusableIn(card);
    const first: HTMLElement | undefined = items[0];
    const last: HTMLElement | undefined = items[items.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      card.focus();
      return;
    }
    if (event.shiftKey) {
      if (active !== first && active !== card) return;
      event.preventDefault();
      last.focus();
      return;
    }
    if (active !== last && active !== card) return;
    event.preventDefault();
    first.focus();
  };

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
        ref={cardRef}
        // The card takes the focus itself when it holds nothing that can, and
        // is the one node the loop can always fall back to.
        tabIndex={-1}
        onKeyDown={holdFocus}
        className={cn(
          "w-full rounded-xl border bg-surface p-24 shadow-popover outline-none",
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
