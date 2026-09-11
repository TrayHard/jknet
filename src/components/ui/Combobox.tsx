import { Check, ChevronDown, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/format";
import type { SelectSize } from "./Select";

export interface ComboboxOption {
  value: string;
  label: string;
  /**
   * Second line under the label, and searched alongside it.
   *
   * The profile list is what asked for it: two profiles called «Duel» and
   * «Duel FFA» are told apart by the nickname they carry, not by their names.
   */
  hint?: string;
  /** Listed and read out, but not choosable. */
  disabled?: boolean;
}

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  /** Accessible name: the control has no `<label>` of its own. */
  ariaLabel: string;
  /** Placeholder and accessible name of the search field inside the popover. */
  searchLabel: string;
  /** Sentence for a search that matches nothing. */
  emptyText: string;
  /** Word drawn in front of the value, uppercased. */
  label?: string;
  /** Shown when no option carries `value`. */
  placeholder?: string;
  size?: SelectSize;
  disabled?: boolean;
  className?: string;
}

/** Distance between the trigger and the popover, in pixels. */
const GAP = 4;
/** How close the popover may come to the edge of the window. */
const EDGE = 8;
const MAX_HEIGHT = 360;
/** Below this the popover is cramped, so a flip is worth it. */
const MIN_HEIGHT = 140;

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
 * A `Select` with a search field: the same trigger, a popover that filters.
 *
 * The third floating control of the kit, and the one to reach for when the
 * list is long enough that the type-ahead of `Select` stops being an answer.
 * `Select` matches the *beginning* of a label one keystroke at a time and
 * forgets the word after 600 ms, which is right for six blade colours and
 * useless for forty player profiles whose names differ in the middle.
 *
 * Keyboard and ARIA follow the editable combobox pattern, which is what makes
 * a search field legal here at all: the focus moves into the field, the field
 * itself carries `role="combobox"`, and the highlighted option is named by
 * `aria-activedescendant` rather than focused. The trigger is a button outside
 * the pattern and hands the focus over on open, which is why it keeps no
 * `role` of its own while the list is up.
 *
 * The mechanics of the floating layer are the ones `Select` and `Menu` already
 * carry, repeated rather than lifted out of either: a portal into
 * `document.body`, because the first ancestor that scrolls or hides its
 * overflow would clip the list, and closing on a press outside, on Escape, on
 * the window losing focus and on a route change.
 */
export function Combobox({
  value,
  onChange,
  options,
  ariaLabel,
  searchLabel,
  emptyText,
  label,
  placeholder,
  size = "md",
  disabled = false,
  className,
}: ComboboxProps) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  // An empty list has nothing to open, whoever built it.
  const locked = disabled || options.length === 0;
  const selected = options.find((option) => option.value === value);
  const text = selected?.label ?? placeholder ?? value;

  const found = useMemo(() => matches(options, query), [options, query]);

  const close = useCallback(() => {
    setOpen(false);
    setAnchor(null);
    setActiveIndex(-1);
    setQuery("");
  }, []);

  /** Closes and puts the focus back where the player left it. */
  const closeAndReturn = useCallback(() => {
    close();
    triggerRef.current?.focus();
  }, [close]);

  const openList = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor(place(rect));
    setQuery("");
    // The selected option is where the walk starts, so the first arrow press
    // moves away from what the player already has rather than to the top.
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const commit = (index: number) => {
    const option = found[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeAndReturn();
  };

  /** First choosable option at or after `from`, walking by `delta`. */
  const walk = (from: number, delta: number) => {
    for (let i = from; i >= 0 && i < found.length; i += delta) {
      if (!found[i].disabled) return i;
    }
    return -1;
  };

  const edge = (last: boolean) =>
    last ? walk(found.length - 1, -1) : walk(0, 1);

  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
        // Only when the caret has nowhere to go: inside a typed word Home
        // belongs to the text, which is the field's own job.
        if (query !== "") return;
        event.preventDefault();
        setActiveIndex(edge(false));
        return;
      case "End":
        if (query !== "") return;
        event.preventDefault();
        setActiveIndex(edge(true));
        return;
      case "Enter":
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        // --- slice: connect dialog ---
        // The list closes and the Escape stops here. `Dialog` listens on the
        // window, so without this one press would shut the popover and the
        // modal around it, and the player would lose the form they were
        // filling in because they dismissed a dropdown.
        event.stopPropagation();
        closeAndReturn();
        return;
      case "Tab":
        // Tab leaves the list without choosing. Committing here would put a
        // profile on a server because the player tabbed past a control.
        closeAndReturn();
    }
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (locked || open) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        event.preventDefault();
        openList();
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

  // The caret belongs in the search field the moment the list appears: it is
  // what the control is for, and one press ahead of the player.
  useLayoutEffect(() => {
    if (open) fieldRef.current?.focus();
  }, [open]);

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
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={locked}
        // --- slice: i18n --- the value truncates, and a translated option is
        // often the one that no longer fits.
        title={text}
        onClick={() => {
          if (open) closeAndReturn();
          else openList();
        }}
        onKeyDown={onTriggerKeyDown}
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
            <div
              style={{
                position: "fixed",
                left: anchor.left,
                width: Math.max(
                  anchor.width,
                  Math.min(280, window.innerWidth - anchor.left - EDGE),
                ),
                top: anchor.top,
                bottom: anchor.bottom,
                maxHeight: anchor.maxHeight,
              }}
              className={cn(
                "z-50 flex flex-col overflow-hidden",
                "bg-elevated border border-line rounded-md shadow-popover",
              )}
            >
              <div className="flex items-center gap-8 h-36 px-12 border-b border-line shrink-0">
                <Search size={14} aria-hidden className="text-fg-muted shrink-0" />
                <input
                  ref={fieldRef}
                  type="text"
                  role="combobox"
                  aria-label={searchLabel}
                  aria-autocomplete="list"
                  aria-expanded
                  aria-controls={listId}
                  aria-activedescendant={
                    activeIndex >= 0 ? optionId(activeIndex) : undefined
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={searchLabel}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    // The highlight goes back to the top of what is left: the
                    // index it held points at a different option now.
                    setActiveIndex(0);
                  }}
                  onKeyDown={onFieldKeyDown}
                  className={cn(
                    "w-full bg-transparent outline-none text-body-sm text-fg",
                    "placeholder:text-fg-muted",
                  )}
                />
              </div>

              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={ariaLabel}
                tabIndex={-1}
                // The focus belongs to the search field for the whole exchange,
                // and a press on an option must not steal it.
                onMouseDown={(event) => event.preventDefault()}
                className="flex-1 min-h-0 overflow-y-auto py-4"
              >
                {found.length === 0 ? (
                  <li className="px-12 py-8 text-body-sm text-fg-muted">
                    {emptyText}
                  </li>
                ) : (
                  found.map((option, index) => {
                    const isSelected = option.value === value;
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
                          "flex items-center gap-8 px-12 py-6 text-body-sm",
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
                        <span className="flex-1 min-w-0 flex flex-col">
                          <span className="truncate">{option.label}</span>
                          {option.hint ? (
                            <span className="truncate text-label-xs text-fg-muted">
                              {option.hint}
                            </span>
                          ) : null}
                        </span>
                        {isSelected ? (
                          <Check size={14} aria-hidden className="shrink-0" />
                        ) : null}
                      </li>
                    );
                  })
                )}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The options a query leaves, matched anywhere in the label or the hint.
 *
 * Case-insensitive and a plain substring: the values here are names players
 * typed themselves, so `^1Kyle` has to be findable by `kyle` and a profile
 * called «Duel FFA» by `ffa`. An empty query keeps the list in the order the
 * caller built it.
 */
function matches(
  options: ComboboxOption[],
  query: string,
): ComboboxOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      (option.hint ?? "").toLowerCase().includes(needle),
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
  const flip = below < MAX_HEIGHT && above > below;
  const room = flip ? above : below;

  return {
    left: Math.max(
      EDGE,
      Math.min(rect.left, window.innerWidth - rect.width - EDGE),
    ),
    width: rect.width,
    top: flip ? undefined : rect.bottom + GAP,
    bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
    maxHeight: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, room)),
  };
}
