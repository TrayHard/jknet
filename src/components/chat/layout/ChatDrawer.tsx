import { ExternalLink, Pin, PinOff, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../lib/format";
import { useOpenChatWindow } from "../../../lib/queries";
import { ChatSurface } from "../ChatSurface";

interface ChatDrawerProps {
  /** The conversation of the thread level, or `null` for the list. */
  conversationId: string | null;
  onSelect: (conversationId: string | null) => void;
  /** Docked beside the page instead of floating over it. */
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onClose: () => void;
  /** Changes on every request to show the drawer, which moves the focus in. */
  focusKey: number;
}

/**
 * --- slice: chat ---
 *
 * The chat drawer of the main window (layout B): 380 px on the right, under
 * the title bar, with the chat surface stacked inside — the list of chats,
 * then one thread with a back arrow.
 *
 * Floating, it lies over the right edge of the page with a shadow and no
 * scrim: the page underneath stays usable. Pinned, `AppShell` lays it out
 * as a column after the page, which narrows instead of being covered.
 *
 * Both levels carry the same three buttons: **Pop out** moves the chat into
 * its own window and closes the drawer, **Pin** docks or floats it, and
 * **Close** closes it. `Escape` closes it too while the focus is inside; a
 * menu, a picker or a dialog of the chat takes its own `Escape` first. The
 * draft stays in the core, so closing loses nothing.
 */
export function ChatDrawer({
  conversationId,
  onSelect,
  pinned,
  onPinnedChange,
  onClose,
  focusKey,
}: ChatDrawerProps) {
  const { t } = useTranslation("chat");
  const openWindow = useOpenChatWindow().mutate;
  const root = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // Every request to show the drawer moves the focus in, so `Escape` works at
  // once: onto the composer of a thread, or onto the drawer for the list.
  useEffect(() => {
    const node = root.current;
    if (node === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !node.contains(active)) {
      returnTo.current = active;
    }
    const frame = requestAnimationFrame(() => {
      const field = node.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)");
      (field ?? node).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);

  // Closed from inside, the focus would fall to the page: it goes back to
  // what opened the drawer — the title-bar button, a **Message** button.
  useEffect(
    () => () => {
      const target = returnTo.current;
      const active = document.activeElement;
      if (target !== null && target.isConnected && (active === null || active === document.body)) {
        target.focus({ preventScroll: true });
      }
    },
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target;
    // A portal of the chat — the emoji picker, a menu — bubbles through here
    // in React while it lives elsewhere in the page; a dialog opened from the
    // chat closes on its own `Escape`.
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    if (target.closest('[aria-modal="true"]') !== null) return;
    event.preventDefault();
    onClose();
  };

  const popOut = () => {
    openWindow({ conversationId });
    onClose();
  };

  const tools = (
    <>
      <DrawerButton label={t("drawer.popOut")} onClick={popOut}>
        <ExternalLink size={14} />
      </DrawerButton>
      <DrawerButton
        label={pinned ? t("drawer.unpin") : t("drawer.pin")}
        pressed={pinned}
        onClick={() => onPinnedChange(!pinned)}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </DrawerButton>
      <DrawerButton label={t("drawer.close")} onClick={onClose}>
        <X size={16} />
      </DrawerButton>
    </>
  );

  return (
    <aside
      ref={root}
      aria-label={t("drawer.label")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-chat-drawer={pinned ? "pinned" : "floating"}
      className={cn(
        "flex w-380 min-h-0 flex-col overflow-hidden border-l border-line bg-surface outline-none",
        pinned
          ? "relative shrink-0"
          : "absolute inset-y-0 right-0 z-30 shadow-popover transition-opacity duration-150 starting:opacity-0",
      )}
    >
      <ChatSurface
        variant="stacked"
        conversationId={conversationId}
        onSelect={onSelect}
        threadActions={tools}
        listHeader={
          <div className="flex h-52 shrink-0 items-center gap-8 border-b border-line-subtle pr-12 pl-16">
            <h2 className="min-w-0 flex-1 truncate text-heading-sm text-fg">{t("drawer.title")}</h2>
            <div className="flex shrink-0 items-center gap-2">{tools}</div>
          </div>
        }
        className="min-h-0 flex-1"
      />
    </aside>
  );
}

interface DrawerButtonProps {
  label: string;
  onClick: () => void;
  /** Set for a toggle: **Pin**. */
  pressed?: boolean;
  children: ReactNode;
}

/** One icon button of the drawer's header, the size of the thread header's own. */
function DrawerButton({ label, onClick, pressed, children }: DrawerButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex size-28 shrink-0 items-center justify-center rounded-sm cursor-pointer select-none",
        "transition-colors duration-150 hover:bg-hover-overlay hover:text-fg",
        pressed ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary",
      )}
    >
      {children}
    </button>
  );
}
