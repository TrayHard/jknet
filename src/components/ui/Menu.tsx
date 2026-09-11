import { MoreHorizontal, MoreVertical } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/format";

/** One line of the menu. */
export interface MenuItem {
  /** Stable key, and what `onSelect` is handed. */
  id: string;
  label: string;
  /** Drawn before the label. Pass a lucide icon at `size-14`. */
  icon?: ReactNode;
  /** Listed and read out, but not choosable. */
  disabled?: boolean;
  /** Draws the line in the danger colour, for an action that takes away. */
  danger?: boolean;
}

/** The square trigger, at the three heights of `Button`: 28, 36 and 44 px. */
export type MenuSize = "sm" | "md" | "lg";

const SIZES: Record<MenuSize, string> = {
  sm: "size-28 rounded-sm",
  md: "size-36 rounded-md",
  lg: "size-44 rounded-md",
};

interface MenuProps {
  items: MenuItem[];
  onSelect: (id: string) => void;
  /** Accessible name of the trigger: it has no visible label of its own. */
  ariaLabel: string;
  /** Three dots across, or stacked. Across is the default. */
  dots?: "horizontal" | "vertical";
  size?: MenuSize;
  disabled?: boolean;
  className?: string;
}

/** Distance between the trigger and the popover, in pixels. */
const GAP = 4;
/** How close the popover may come to the edge of the window. */
const EDGE = 8;
const MAX_HEIGHT = 320;
/** Below this the popover is cramped, so a flip is worth it. */
const MIN_HEIGHT = 72;

/**
 * Where the popover sits.
 *
 * Anchored by its right edge, because the trigger sits at the right end of a
 * row or beside a button and a list that hangs to the left of it is the list
 * that stays inside the window. Either `top` or `bottom` is set, never both:
 * the flipped menu is held by its bottom edge, which places it without
 * measuring its height first.
 */
interface Anchor {
  right: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * The three-dot menu of the kit: a trigger and a short list of actions.
 *
 * The second popover of the launcher, after `Select`, and deliberately not the
 * same control. `Select` is a combobox — it carries a value, keeps the focus on
 * its trigger and names the active option through `aria-activedescendant`. This
 * is a menu button: it chooses nothing and holds no value, so the focus moves
 * into the list and walks it, which is the pattern a screen reader announces as
 * a menu.
 *
 * What the two share is the mechanics of a floating layer, and those are
 * repeated here rather than lifted out of `Select`: the list renders into
 * `document.body` through a portal, because inside the flow the first ancestor
 * that scrolls or hides its overflow clips it — the server table and the
 * details panel both do — and it closes on a press outside, on Escape, on the
 * window losing focus and on a route change.
 */
export function Menu({
  items,
  onSelect,
  ariaLabel,
  dots = "horizontal",
  size = "md",
  disabled = false,
  className,
}: MenuProps) {
  const id = useId();
  const listId = `${id}-menu`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  // A menu with nothing in it has nothing to open, whoever built it.
  const locked = disabled || items.length === 0;

  const close = useCallback(() => {
    setOpen(false);
    setAnchor(null);
    setActiveIndex(-1);
  }, []);

  /** Closes and puts the focus back where the player left it. */
  const closeAndReturn = useCallback(() => {
    close();
    triggerRef.current?.focus();
  }, [close]);

  /** First choosable item at or after `from`, walking by `delta`. */
  const walk = (from: number, delta: number) => {
    for (let i = from; i >= 0 && i < items.length; i += delta) {
      if (!items[i].disabled) return i;
    }
    return -1;
  };

  const edge = (last: boolean) => (last ? walk(items.length - 1, -1) : walk(0, 1));

  const openList = (start: number) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor(place(rect));
    setActiveIndex(start);
    setOpen(true);
  };

  const commit = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    closeAndReturn();
    onSelect(item.id);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (locked || open) return;
    switch (event.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        event.preventDefault();
        openList(edge(false));
        return;
      case "ArrowUp":
        event.preventDefault();
        openList(edge(true));
    }
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = walk(activeIndex + 1, 1);
        setActiveIndex(next >= 0 ? next : edge(false));
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = walk(activeIndex - 1, -1);
        setActiveIndex(previous >= 0 ? previous : edge(true));
        return;
      }
      case "Home":
        event.preventDefault();
        setActiveIndex(edge(false));
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(edge(true));
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        closeAndReturn();
        return;
      case "Tab":
        // The focus goes back to the trigger before the browser acts on the
        // key, so Tab carries on from the control the player opened rather
        // than from the end of the document, where the portal lives.
        closeAndReturn();
    }
  };

  // Follow the trigger while the page moves under it, and give up when the
  // trigger itself has scrolled out of sight. `capture` is what catches the
  // scroll of an inner container, which does not bubble to the window.
  useEffect(() => {
    if (!open) return;
    const follow = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        close();
        return;
      }
      setAnchor(place(rect));
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, close]);

  // A press anywhere else closes the menu. The trigger is excluded so that its
  // own click keeps toggling rather than closing and reopening.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, close]);

  // The window losing focus — alt-tab, the game starting — must not leave a
  // menu floating over the screen.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open, close]);

  // A route change while the menu is open. Back and forward arrive as
  // `popstate`; a link inside the app goes through `pushState`, which fires
  // neither `popstate` nor `hashchange`, so the Navigation API is what reports
  // it in a Chromium webview.
  useEffect(() => {
    if (!open) return;
    const navigation = (window as unknown as { navigation?: EventTarget })
      .navigation;
    window.addEventListener("popstate", close);
    window.addEventListener("hashchange", close);
    navigation?.addEventListener("navigate", close);
    return () => {
      window.removeEventListener("popstate", close);
      window.removeEventListener("hashchange", close);
      navigation?.removeEventListener("navigate", close);
    };
  }, [open, close]);

  // The focus lives on the active item while the menu is open: that is what
  // makes a screen reader read the line the arrow keys just moved to.
  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.focus();
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const Dots = dots === "vertical" ? MoreVertical : MoreHorizontal;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={locked}
        onClick={() => {
          if (open) closeAndReturn();
          else openList(edge(false));
        }}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "inline-flex items-center justify-center shrink-0",
          "border transition-colors duration-150 cursor-pointer",
          "disabled:cursor-not-allowed disabled:text-fg-disabled",
          open
            ? "border-line-focus bg-surface-hover text-fg"
            : "border-line bg-surface text-fg-secondary hover:bg-surface-hover hover:text-fg",
          SIZES[size],
          className,
        )}
      >
        <Dots size={16} aria-hidden />
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="menu"
              aria-label={ariaLabel}
              onKeyDown={onListKeyDown}
              style={{
                position: "fixed",
                right: anchor.right,
                top: anchor.top,
                bottom: anchor.bottom,
                maxHeight: anchor.maxHeight,
              }}
              className={cn(
                "z-50 min-w-[180px] max-w-[320px] overflow-y-auto py-4",
                "bg-elevated border border-line rounded-md shadow-popover",
              )}
            >
              {items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  data-index={index}
                  tabIndex={-1}
                  disabled={item.disabled}
                  onMouseEnter={() => {
                    if (!item.disabled) setActiveIndex(index);
                  }}
                  onClick={() => commit(index)}
                  className={cn(
                    "flex items-center gap-8 w-full h-32 px-12 text-left",
                    "text-body-sm transition-colors duration-100",
                    item.disabled
                      ? "text-fg-disabled cursor-not-allowed"
                      : "cursor-pointer hover:bg-hover-overlay focus:bg-hover-overlay outline-none",
                    item.disabled
                      ? ""
                      : item.danger
                        ? "text-fg-danger"
                        : "text-fg",
                  )}
                >
                  {item.icon ? (
                    <span className="flex items-center shrink-0">{item.icon}</span>
                  ) : null}
                  <span className="flex-1 min-w-0 truncate">{item.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Turns the rectangle of the trigger into the box of the popover.
 *
 * The list hangs below unless the room there is short of the full height and
 * the room above is larger; then it flips and is held by its bottom edge.
 */
function place(rect: DOMRect): Anchor {
  const below = window.innerHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const flip = below < MAX_HEIGHT && above > below;
  const room = flip ? above : below;

  return {
    right: Math.max(EDGE, window.innerWidth - rect.right),
    top: flip ? undefined : rect.bottom + GAP,
    bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
    maxHeight: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, room)),
  };
}
