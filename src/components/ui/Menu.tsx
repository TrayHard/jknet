import { MoreHorizontal, MoreVertical } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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
// --- slice: selection context menu ---
/** The narrowest the list can be, which is what `min-w-[180px]` guarantees. */
const MIN_WIDTH = 180;

// --- slice: selection context menu ---
/**
 * The box the popover hangs from.
 *
 * A `DOMRect` is one, and so is the point of a right click: a rectangle of no
 * size at all, with `left` equal to `right` and `top` equal to `bottom`.
 */
interface MenuRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// --- slice: selection context menu ---
/**
 * Which edge of that box the list lines up with.
 *
 * `end` hangs the list off the right edge, which is where a trigger at the end
 * of a row wants it. `start` runs the list right from the point, the way every
 * context menu on the system does, and falls back to `end` when the narrowest
 * list it can be no longer fits there.
 */
type MenuAlign = "end" | "start";

/** Which line the keyboard lands on when the list opens. */
type MenuStart = "first" | "last";

/**
 * Where the popover sits.
 *
 * Either `top` or `bottom` is set, never both: the flipped menu is held by its
 * bottom edge, which places it without measuring its height first. `left` and
 * `right` work the same way across.
 */
interface Anchor {
  left?: number;
  right?: number;
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
 *
 * --- slice: selection context menu ---
 * The list itself lives in `useMenuLayer`, which this component drives from a
 * trigger and `useContextMenu` drives from the point of a right click. One
 * list, two ways of opening it: a screen that answers the dots and the right
 * click differently is a screen with two menus to keep in step.
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
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A menu with nothing in it has nothing to open, whoever built it.
  const locked = disabled || items.length === 0;

  // Follow the trigger while the page moves under it. `null` is a trigger that
  // has gone, and the layer closes on it.
  const track = useCallback(
    () => triggerRef.current?.getBoundingClientRect() ?? null,
    [],
  );
  const returnFocus = useCallback(() => triggerRef.current?.focus(), []);
  // The trigger is excluded from the press that closes the list, so its own
  // click keeps toggling rather than closing and reopening.
  const keepOpenOn = useCallback(
    (node: Node) => triggerRef.current?.contains(node) ?? false,
    [],
  );

  const layer = useMenuLayer({
    items,
    onSelect,
    ariaLabel,
    track,
    returnFocus,
    keepOpenOn,
  });

  const openList = (start: MenuStart) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    layer.openAt(rect, "end", start);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (locked || layer.open) return;
    switch (event.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        event.preventDefault();
        openList("first");
        return;
      case "ArrowUp":
        event.preventDefault();
        openList("last");
    }
  };

  const Dots = dots === "vertical" ? MoreVertical : MoreHorizontal;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={layer.open}
        aria-controls={layer.open ? layer.listId : undefined}
        disabled={locked}
        onClick={() => {
          if (layer.open) layer.closeAndReturn();
          else openList("first");
        }}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          // --- slice: selection context menu ---
          "inline-flex items-center justify-center shrink-0 select-none",
          "border transition-colors duration-150 cursor-pointer",
          "disabled:cursor-not-allowed disabled:text-fg-disabled",
          layer.open
            ? "border-line-focus bg-surface-hover text-fg"
            : "border-line bg-surface text-fg-secondary hover:bg-surface-hover hover:text-fg",
          SIZES[size],
          className,
        )}
      >
        <Dots size={16} aria-hidden />
      </button>

      {layer.popover}
    </>
  );
}

// --- slice: selection context menu ---
/**
 * The same menu, opened by a right click instead of a button.
 *
 * The launcher takes the webview's own menu off every window
 * (`blockNativeContextMenu` in `src/lib/selection.ts`), so a right click has to
 * answer with something. It answers with the actions the row already has: the
 * items are the ones behind the three dots, and they run the same handlers.
 *
 * One instance serves a whole list. The target of the press travels with the
 * press rather than living in the row, so a table of two hundred servers
 * carries one layer and not two hundred:
 *
 * ```tsx
 * const menu = useContextMenu<ServerInfo>({ ariaLabel, items, onSelect });
 * …
 * <Row onContextMenu={(event) => menu.open(event, server)} />
 * {menu.menu}
 * ```
 */
export function useContextMenu<T>({
  ariaLabel,
  items,
  onSelect,
}: {
  /** Accessible name of the list. */
  ariaLabel: string;
  /** The lines for the thing the player pressed on. */
  items: (target: T) => MenuItem[];
  onSelect: (id: string, target: T) => void;
}): {
  /** Give it to `onContextMenu` of the element the menu belongs to. */
  open: (event: ReactMouseEvent, target: T) => void;
  /** Render it once, anywhere inside that element: the list is a portal. */
  menu: ReactNode;
} {
  // Boxed, so that `null` and `undefined` are targets like any other: a card
  // that stands for one thing has nothing to name and passes its own object.
  const [target, setTarget] = useState<{ value: T } | null>(null);
  /** Where the focus was before the press, so Escape puts it back. */
  const previous = useRef<HTMLElement | null>(null);
  const lines = target === null ? NO_ITEMS : items(target.value);

  const returnFocus = useCallback(() => {
    previous.current?.focus();
    previous.current = null;
  }, []);

  const layer = useMenuLayer({
    items: lines,
    // The target of this render, which is the one the open list belongs to:
    // `commit` calls this before anything clears it.
    onSelect: (id) => {
      if (target !== null) onSelect(id, target.value);
    },
    ariaLabel,
    returnFocus,
  });

  // Nothing to hold on to once the list is down, and holding a row of a list
  // that has since been refreshed is a row nobody can see.
  const down = !layer.open;
  useEffect(() => {
    if (down) setTarget(null);
  }, [down]);

  const openAt = layer.openAt;
  const open = (event: ReactMouseEvent, next: T) => {
    if (items(next).length === 0) return;
    event.preventDefault();
    // A row inside a block inside a screen: the innermost menu is the one the
    // player meant, and it is the only one that opens.
    event.stopPropagation();
    previous.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTarget({ value: next });
    const point = {
      left: event.clientX,
      right: event.clientX,
      top: event.clientY,
      bottom: event.clientY,
    };
    openAt(point, "start", "first");
  };

  return { open, menu: layer.popover };
}

/** One array for every closed context menu, so no render builds a new one. */
const NO_ITEMS: MenuItem[] = [];

// --- slice: selection context menu ---
interface MenuLayerOptions {
  items: MenuItem[];
  onSelect: (id: string) => void;
  ariaLabel: string;
  /**
   * The box to place the list against again while the page moves under it.
   *
   * A trigger has one and the list follows it. The point of a click has none —
   * it belongs to a pixel of the window, not to an element — so a layer without
   * this closes on the first scroll, which is what every context menu does.
   */
  track?: () => MenuRect | null;
  /** Where the focus goes when the player closes the list. */
  returnFocus: () => void;
  /** A press that must not close the list: the trigger's own. */
  keepOpenOn?: (target: Node) => boolean;
}

interface MenuLayer {
  open: boolean;
  /** Id of the list, for `aria-controls` on a trigger. */
  listId: string;
  openAt: (rect: MenuRect, align: MenuAlign, start: MenuStart) => void;
  close: () => void;
  /** Closes and puts the focus back where the player left it. */
  closeAndReturn: () => void;
  /** The list itself, or `null` while it is down. Render it. */
  popover: ReactNode;
}

// --- slice: selection context menu ---
/**
 * The floating list: placing it, walking it, and the four ways it closes.
 *
 * Everything a menu does once it is up lives here, and what opens it does not:
 * that is the one difference between the three dots and a right click.
 */
function useMenuLayer({
  items,
  onSelect,
  ariaLabel,
  track,
  returnFocus,
  keepOpenOn,
}: MenuLayerOptions): MenuLayer {
  const id = useId();
  const listId = `${id}-menu`;
  const listRef = useRef<HTMLDivElement>(null);

  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [align, setAlign] = useState<MenuAlign>("end");
  const [start, setStart] = useState<MenuStart>("first");
  const [activeIndex, setActiveIndex] = useState(-1);
  const open = anchor !== null;

  const close = useCallback(() => {
    setAnchor(null);
    setActiveIndex(-1);
  }, []);

  // Through a ref: the caller rebuilds this function on every render, and an
  // effect that depended on it would tear the listeners down as often.
  const back = useRef(returnFocus);
  back.current = returnFocus;
  const closeAndReturn = useCallback(() => {
    close();
    back.current();
  }, [close]);

  const openAt = useCallback(
    (rect: MenuRect, at: MenuAlign, from: MenuStart) => {
      setAlign(at);
      setStart(from);
      setAnchor(place(rect, at));
      // Not the line itself: a context menu names its target in the same
      // event, so the items of that target only exist on the render after it.
      setActiveIndex(-1);
    },
    [],
  );

  const commit = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    closeAndReturn();
    onSelect(item.id);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = walk(items, activeIndex + 1, 1);
        setActiveIndex(next >= 0 ? next : edgeItem(items, false));
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = walk(items, activeIndex - 1, -1);
        setActiveIndex(previous >= 0 ? previous : edgeItem(items, true));
        return;
      }
      case "Home":
        event.preventDefault();
        setActiveIndex(edgeItem(items, false));
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(edgeItem(items, true));
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        // --- slice: connect dialog ---
        // The menu closes and the Escape stops here. `Dialog` listens on the
        // window, so without this one press would shut the popover and any
        // modal around it.
        event.stopPropagation();
        closeAndReturn();
        return;
      case "Tab":
        // The focus goes back to the trigger before the browser acts on the
        // key, so Tab carries on from the control the player opened rather
        // than from the end of the document, where the portal lives.
        closeAndReturn();
    }
  };

  // The first line becomes active once the list is up rather than when the
  // press is handled, because that is the render on which the items exist.
  useEffect(() => {
    if (!open || activeIndex >= 0) return;
    setActiveIndex(edgeItem(items, start === "last"));
  }, [open, activeIndex, items, start]);

  // Follow the trigger while the page moves under it, and give up when the
  // trigger itself has scrolled out of sight. `capture` is what catches the
  // scroll of an inner container, which does not bubble to the window. A list
  // opened at a point has nothing to follow, so the same events close it.
  useEffect(() => {
    if (!open) return;
    const follow = () => {
      if (track === undefined) {
        close();
        return;
      }
      const rect = track();
      if (rect === null) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        close();
        return;
      }
      setAnchor(place(rect, align));
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, close, track, align]);

  // A press anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (listRef.current?.contains(target)) return;
      if (keepOpenOn?.(target)) return;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, close, keepOpenOn]);

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

  const popover =
    open && anchor
      ? createPortal(
          <div
            ref={listRef}
            id={listId}
            role="menu"
            aria-label={ariaLabel}
            onKeyDown={onListKeyDown}
            style={{
              position: "fixed",
              left: anchor.left,
              right: anchor.right,
              top: anchor.top,
              bottom: anchor.bottom,
              maxHeight: anchor.maxHeight,
            }}
            className={cn(
              // --- slice: selection context menu --- a list of actions is
              // a list to press, never one to drag a cursor through.
              "z-50 min-w-[180px] max-w-[320px] overflow-y-auto py-4 select-none",
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
      : null;

  return { open, listId, openAt, close, closeAndReturn, popover };
}

/** First choosable item at or after `from`, walking by `delta`. */
function walk(items: MenuItem[], from: number, delta: number): number {
  for (let i = from; i >= 0 && i < items.length; i += delta) {
    if (!items[i].disabled) return i;
  }
  return -1;
}

/** The first choosable line of the list, or the last. */
function edgeItem(items: MenuItem[], last: boolean): number {
  return last ? walk(items, items.length - 1, -1) : walk(items, 0, 1);
}

/**
 * Turns the box the menu hangs from into the box of the popover.
 *
 * The list hangs below unless the room there is short of the full height and
 * the room above is larger; then it flips and is held by its bottom edge.
 *
 * --- slice: selection context menu ---
 * Across, it depends on what opened it. A trigger sits at the right end of a
 * row or beside a button, and a list that hangs to the left of it is the list
 * that stays inside the window. A right click is the other way round: the list
 * runs right from the point the way the system's own menus do, and turns back
 * on itself only when it would not fit.
 */
function place(rect: MenuRect, align: MenuAlign): Anchor {
  const below = window.innerHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const flip = below < MAX_HEIGHT && above > below;
  const room = flip ? above : below;

  const vertical = {
    top: flip ? undefined : rect.bottom + GAP,
    bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
    maxHeight: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, room)),
  };
  const toTheLeft = { right: Math.max(EDGE, window.innerWidth - rect.right) };

  if (align === "end") return { ...vertical, ...toTheLeft };
  const roomRight = window.innerWidth - rect.left - EDGE;
  return roomRight >= MIN_WIDTH
    ? { ...vertical, left: rect.left }
    : { ...vertical, ...toTheLeft };
}
