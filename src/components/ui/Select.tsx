import { Check, ChevronDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/format";

export interface SelectOption {
  value: string;
  label: string;
  /** Listed and read out, but not choosable. */
  disabled?: boolean;
}

/** `sm` is 28 px high, `md` is 36 px — the two heights the Button kit uses. */
export type SelectSize = "sm" | "md";

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Accessible name: the control has no `<label>` of its own. */
  ariaLabel: string;
  /** Word drawn in front of the value, uppercased: `MODE`, `MOD`, `SORT BY`. */
  label?: string;
  /** Shown when no option carries `value`, as an empty list or a cleared one. */
  placeholder?: string;
  size?: SelectSize;
  disabled?: boolean;
  className?: string;
}

/** Distance between the trigger and the popover, in pixels. */
const GAP = 4;
/** How close the popover may come to the edge of the window. */
const EDGE = 8;
const MAX_LIST_HEIGHT = 320;
/** Below this the popover is cramped, so a flip is worth it. */
const MIN_LIST_HEIGHT = 96;
/** A pause this long starts a new type-ahead word. */
const TYPE_AHEAD_RESET = 600;

/**
 * Where the popover sits. Either `top` or `bottom` is set, never both: the
 * flipped list is anchored by its bottom edge, which places it without
 * measuring its height first.
 */
interface Anchor {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * The Select of the design system: a trigger in the shape of an Input and a
 * popover list of our own.
 *
 * A native `<select>` was the first shape of this control, and its popup is
 * drawn by the operating system, not by the page. WebView2 painted that popup
 * white under the dark text of the app, which left the Servers filters
 * unreadable. Nothing in CSS reaches inside an OS popup, so the list is ours.
 *
 * The list renders into `document.body` through a portal. Inside the flow it
 * would be clipped by the first ancestor that scrolls or hides its overflow —
 * the servers table and the details panel both do.
 *
 * Keyboard and ARIA follow the select-only combobox pattern: focus never
 * leaves the trigger, and the active option is named by `aria-activedescendant`
 * instead of being focused.
 */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  label,
  placeholder,
  size = "md",
  disabled = false,
  className,
}: SelectProps) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef({ buffer: "", at: 0 });

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  // An empty list has nothing to open, whoever built it.
  const locked = disabled || options.length === 0;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const text = selected?.label ?? placeholder ?? value;

  const close = useCallback(() => {
    setOpen(false);
    setAnchor(null);
    setActiveIndex(-1);
    searchRef.current.buffer = "";
  }, []);

  /** Closes and puts the caret back where the player left it. */
  const closeAndReturn = useCallback(() => {
    close();
    triggerRef.current?.focus();
  }, [close]);

  const openList = (start: number) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor(place(rect));
    setActiveIndex(start);
    setOpen(true);
    searchRef.current.buffer = "";
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeAndReturn();
  };

  /** First choosable option at or after `from`, walking by `delta`. */
  const walk = (from: number, delta: number) => {
    for (let i = from; i >= 0 && i < options.length; i += delta) {
      if (!options[i].disabled) return i;
    }
    return -1;
  };

  const edge = (last: boolean) =>
    last ? walk(options.length - 1, -1) : walk(0, 1);

  /**
   * Type-ahead over the labels, the way a native select behaves: letters
   * typed in quick succession form a word, and one letter pressed again and
   * again walks the options that start with it.
   */
  const search = (key: string, from: number) => {
    const now = Date.now();
    const stale = now - searchRef.current.at > TYPE_AHEAD_RESET;
    const buffer = (stale ? "" : searchRef.current.buffer) + key.toLowerCase();
    searchRef.current = { buffer, at: now };

    const repeated =
      buffer.length > 1 && [...buffer].every((char) => char === buffer[0]);
    const needle = repeated ? buffer[0] : buffer;
    // A one-letter word starts the search after the active option, so the
    // same letter keeps moving; a longer word re-reads from the active one.
    const offset = needle.length === buffer.length && buffer.length > 1 ? 0 : 1;

    for (let i = 0; i < options.length; i += 1) {
      const index = (from + offset + i + options.length) % options.length;
      const option = options[index];
      if (option.disabled) continue;
      if (option.label.toLowerCase().startsWith(needle)) return index;
    }
    return -1;
  };

  const searching = () =>
    searchRef.current.buffer !== "" &&
    Date.now() - searchRef.current.at <= TYPE_AHEAD_RESET;

  const isTypeAhead = (event: ReactKeyboardEvent) =>
    event.key.length === 1 &&
    event.key !== " " &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (locked) return;

    if (!open) {
      switch (event.key) {
        case "ArrowDown":
        case "Enter":
        case " ":
          event.preventDefault();
          openList(selectedIndex >= 0 ? selectedIndex : edge(false));
          return;
        case "ArrowUp":
          event.preventDefault();
          openList(selectedIndex >= 0 ? selectedIndex : edge(true));
          return;
        case "Home":
          event.preventDefault();
          openList(edge(false));
          return;
        case "End":
          event.preventDefault();
          openList(edge(true));
          return;
        default:
          if (isTypeAhead(event)) {
            event.preventDefault();
            const match = search(event.key, selectedIndex);
            openList(match >= 0 ? match : selectedIndex);
          }
          return;
      }
    }

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = walk(activeIndex + 1, 1);
        if (next >= 0) setActiveIndex(next);
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = walk(activeIndex - 1, -1);
        if (previous >= 0) setActiveIndex(previous);
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
        event.preventDefault();
        commit(activeIndex);
        return;
      case " ":
        event.preventDefault();
        // A space inside a word being typed belongs to the word.
        if (searching()) {
          const match = search(event.key, activeIndex);
          if (match >= 0) setActiveIndex(match);
        } else {
          commit(activeIndex);
        }
        return;
      case "Escape":
        event.preventDefault();
        // --- slice: connect dialog ---
        // The list closes and the Escape stops here. `Dialog` listens on the
        // window, so without this one press would shut the popover and the
        // modal around it.
        event.stopPropagation();
        closeAndReturn();
        return;
      case "Tab":
        // Tab commits and lets the focus travel on, as the pattern asks. The
        // second call matters when there is nothing to commit to.
        commit(activeIndex);
        close();
        return;
      default:
        if (isTypeAhead(event)) {
          event.preventDefault();
          const match = search(event.key, activeIndex);
          if (match >= 0) setActiveIndex(match);
        }
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

  // A press anywhere else closes the list. The trigger is excluded so that its
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
  // popover floating over the screen.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open, close]);

  // A route change while the list is open. Back and forward arrive as
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

  // Keep the active option inside the scrolled list.
  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        disabled={locked}
        // --- slice: i18n --- the value truncates, and a translated option is
        // often the one that no longer fits: German and Hungarian run about a
        // third longer than English. The tooltip is what makes the cut half
        // readable without widening every control in the design.
        title={text}
        onClick={() => {
          if (open) closeAndReturn();
          else openList(selectedIndex >= 0 ? selectedIndex : edge(false));
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "relative inline-flex items-center rounded-md cursor-pointer",
          "bg-input border transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:text-fg-disabled",
          open ? "border-line-focus" : "border-line hover:border-line-strong",
          size === "sm" ? "h-28 gap-6 pl-10 pr-28" : "h-36 gap-8 pl-12 pr-32",
          className,
        )}
      >
        {label ? (
          <span className="text-label-xs text-fg-muted shrink-0">{label}</span>
        ) : null}
        <span
          className={cn(
            "truncate",
            locked ? "text-fg-disabled" : selected ? "text-fg" : "text-fg-muted",
            label ? "text-body-sm-medium" : "text-body-md-medium",
          )}
        >
          {text}
        </span>
        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            "absolute text-fg-muted pointer-events-none",
            "transition-transform duration-150",
            size === "sm" ? "right-8" : "right-10",
            open ? "rotate-180" : "",
          )}
        />
      </button>

      {open && anchor
        ? createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              tabIndex={-1}
              style={{
                position: "fixed",
                left: anchor.left,
                top: anchor.top,
                bottom: anchor.bottom,
                minWidth: anchor.width,
                maxWidth: Math.max(
                  anchor.width,
                  window.innerWidth - anchor.left - EDGE,
                ),
                maxHeight: anchor.maxHeight,
              }}
              // The focus belongs to the trigger for the whole exchange, and a
              // press on an option must not steal it.
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                "z-50 overflow-y-auto py-4",
                "bg-elevated border border-line rounded-md shadow-popover",
              )}
            >
              {options.map((option, index) => {
                const isSelected = index === selectedIndex;
                const isActive = index === activeIndex;
                return (
                  <li
                    key={option.value}
                    id={optionId(index)}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onMouseEnter={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onClick={() => commit(index)}
                    className={cn(
                      "flex items-center gap-8 h-32 px-12 text-body-sm",
                      option.disabled
                        ? "text-fg-disabled cursor-not-allowed"
                        : "cursor-pointer",
                      !option.disabled && isActive ? "bg-hover-overlay" : "",
                      isSelected && !option.disabled
                        ? "bg-selected-overlay text-fg-accent"
                        : option.disabled
                          ? ""
                          : "text-fg",
                    )}
                  >
                    <span className="flex-1 min-w-0 truncate">{option.label}</span>
                    {isSelected ? (
                      <Check size={14} aria-hidden className="shrink-0" />
                    ) : null}
                  </li>
                );
              })}
            </ul>,
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
 * the room above is larger; then it flips and is anchored by its bottom edge.
 */
function place(rect: DOMRect): Anchor {
  const below = window.innerHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const flip = below < MAX_LIST_HEIGHT && above > below;
  const room = flip ? above : below;

  return {
    left: Math.max(
      EDGE,
      Math.min(rect.left, window.innerWidth - rect.width - EDGE),
    ),
    width: rect.width,
    top: flip ? undefined : rect.bottom + GAP,
    bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
    maxHeight: Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, room)),
  };
}
