// --- slice: home client block ---
import { ChevronDown, Monitor, Play, Plus } from "lucide-react";
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
import { useTranslation } from "react-i18next";

import { cn } from "../lib/format";
import type { Client } from "../lib/ipc";
import { EngineLogo } from "./EngineLogo";
import { Button } from "./ui";

interface OtherClientsMenuProps {
  /**
   * The clients the menu offers, without the one the hero already names.
   *
   * The page filters: the hero's own buttons start the default client, or the
   * running one while a game is up, and a menu that repeats it would offer the
   * player the button they are already looking at.
   */
  clients: Client[];
  /** Registry name of an engine, with the id as the fallback. */
  engineName: (engineId: string) => string;
  /** Starts one client, exactly the way **Play** starts the hero's own. */
  onLaunch: (client: Client) => void;
  /** The way on to the Clients screen: the last line of the menu. */
  onNewClient: () => void;
  /** Nothing can start right now: a game is running, or one is starting. */
  launchDisabled?: boolean;
}

/** One line of the menu. */
type Row =
  | { kind: "client"; client: Client }
  | { kind: "new" };

/** Distance between the trigger and the popover, in pixels. */
const GAP = 4;
/** How close the popover may come to the edge of the window. */
const EDGE = 8;
const MAX_HEIGHT = 320;
/** Below this the popover is cramped, so a flip is worth it. */
const MIN_HEIGHT = 96;
/**
 * The width the placement reckons with, and the popover's own `max-w`.
 *
 * The box is measured before it exists, so the two have to agree: a popover
 * placed by a number smaller than it ends up being would hang off the window.
 */
const WIDTH = 340;

/**
 * Where the popover sits.
 *
 * Anchored by its left edge, under the button that opened it: this trigger is
 * a labelled button in the left half of the hero, not the three dots at the
 * right end of a row, so a list that hangs to the right of the label is the
 * one the eye follows. Either `top` or `bottom` is set, never both — the
 * flipped popover is held by its bottom edge, which places it without
 * measuring its height first.
 */
interface Anchor {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * **Other clients…**: the button of the Home hero and the menu behind it.
 *
 * The hero names one client and starts it. Everything else the player built is
 * a screen away, and the walk to Clients and back is the whole distance
 * between «play» and «play with the other one» — a player who keeps a plain
 * client for duels and a modded one for a single server crosses it every
 * session. So the other clients of the active game hang under the hero, and
 * each line starts its client on the spot.
 *
 * Not the kit's `Menu`, for one reason: a line here is two rows of text and a
 * mark — the client's name, then its engine with the engine's logo — beside a
 * **Launch** of its own, and `MenuItem` carries a single string. The mechanics
 * of the floating layer are the ones `Menu` established and are repeated
 * rather than lifted out of it: the list renders into `document.body` through
 * a portal, because the hero clips its overflow to keep the glow inside its
 * corners, and it closes on a press outside, on Escape, on the window losing
 * focus and on a route change. When the kit grows a menu item that can hold a
 * line of its own, this component becomes a call to it.
 */
export function OtherClientsMenu({
  clients,
  engineName,
  onLaunch,
  onNewClient,
  launchDisabled = false,
}: OtherClientsMenuProps) {
  const { t } = useTranslation("home");
  const id = useId();
  const listId = `${id}-menu`;

  // The kit's `Button` renders the element, so the box around it is what the
  // placement measures: the two rectangles are the same, and the button stays
  // a call to the kit rather than a copy of its classes.
  const triggerRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  // The last line is always there. The button that used to lead to the Clients
  // screen is this menu now, so the menu has to keep the way on — and it is
  // the whole answer for a game whose only client is the one in the hero.
  const rows: Row[] = [
    ...clients.map((client) => ({ kind: "client" as const, client })),
    { kind: "new" as const },
  ];

  /** A line the player cannot choose: only a launch, and only while one is. */
  const isDisabled = (row: Row) => row.kind === "client" && launchDisabled;

  const close = useCallback(() => {
    setOpen(false);
    setAnchor(null);
    setActiveIndex(-1);
  }, []);

  /** Closes and puts the focus back where the player left it. */
  const closeAndReturn = useCallback(() => {
    close();
    triggerRef.current?.querySelector("button")?.focus();
  }, [close]);

  /** First choosable line at or after `from`, walking by `delta`. */
  const walk = (from: number, delta: number) => {
    for (let i = from; i >= 0 && i < rows.length; i += delta) {
      if (!isDisabled(rows[i])) return i;
    }
    return -1;
  };

  const edge = (last: boolean) => (last ? walk(rows.length - 1, -1) : walk(0, 1));

  const openList = (start: number) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor(place(rect));
    setActiveIndex(start);
    setOpen(true);
  };

  const commit = (index: number) => {
    const row = rows[index];
    if (!row || isDisabled(row)) return;
    closeAndReturn();
    if (row.kind === "client") onLaunch(row.client);
    else onNewClient();
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
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
        // The menu closes and the Escape stops here, as it does in `Menu`: a
        // dialog listening on the window must not close with it.
        event.stopPropagation();
        closeAndReturn();
        return;
      case "Tab":
        // The focus goes back to the trigger before the browser acts on the
        // key, so Tab carries on from the hero rather than from the end of the
        // document, where the portal lives.
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

  // A route change while the menu is open. **New client…** navigates, and both
  // the back key and a link inside the app have to take the popover with them.
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

  // The focus lives on the active line while the menu is open: that is what
  // makes a screen reader read the line the arrow keys just moved to.
  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.focus();
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  return (
    <>
      <span ref={triggerRef} className="inline-flex">
        <Button
          size="lg"
          icon={<Monitor size={20} />}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => {
            if (open) closeAndReturn();
            else openList(edge(false));
          }}
          onKeyDown={onTriggerKeyDown}
        >
          {t("hero.otherClients")}
          <ChevronDown size={16} aria-hidden />
        </Button>
      </span>

      {open && anchor
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="menu"
              aria-label={t("hero.otherClients")}
              onKeyDown={onListKeyDown}
              style={{
                position: "fixed",
                left: anchor.left,
                top: anchor.top,
                bottom: anchor.bottom,
                maxHeight: anchor.maxHeight,
                maxWidth: WIDTH,
              }}
              className={cn(
                "z-50 min-w-[260px] overflow-y-auto py-4",
                "bg-elevated border border-line rounded-md shadow-popover",
              )}
            >
              {rows.map((row, index) =>
                row.kind === "client" ? (
                  <button
                    key={row.client.id}
                    type="button"
                    role="menuitem"
                    data-index={index}
                    tabIndex={-1}
                    disabled={launchDisabled}
                    onMouseEnter={() => {
                      if (!launchDisabled) setActiveIndex(index);
                    }}
                    onClick={() => commit(index)}
                    className={cn(
                      "flex items-center gap-12 w-full px-12 py-8 text-left",
                      "transition-colors duration-100",
                      launchDisabled
                        ? "cursor-not-allowed"
                        : "cursor-pointer hover:bg-hover-overlay focus:bg-hover-overlay outline-none",
                    )}
                  >
                    <span className="flex-1 min-w-0 flex flex-col gap-2">
                      <span
                        className={cn(
                          "text-body-sm-medium truncate",
                          launchDisabled ? "text-fg-disabled" : "text-fg",
                        )}
                      >
                        {row.client.name}
                      </span>
                      {/* The engine under the name, mark and all: the same
                          line the hero carries under its own client, so the
                          two clients are compared by the thing that makes
                          them different. */}
                      <span
                        className={cn(
                          "flex items-center gap-6 text-body-sm",
                          launchDisabled ? "text-fg-disabled" : "text-fg-muted",
                        )}
                      >
                        <EngineLogo
                          engineId={row.client.engineId}
                          name={engineName(row.client.engineId)}
                          size={16}
                        />
                        <span className="truncate">
                          {engineName(row.client.engineId)}
                        </span>
                      </span>
                    </span>
                    {/* The whole line starts the client, so this is a mark of
                        what the press does rather than a button of its own: a
                        button inside a button is not markup a browser keeps,
                        and two press targets in one line would be two
                        different answers to the same question. It is not
                        hidden from a screen reader either — «Zyk, EternalJK,
                        Launch» is the line saying what pressing it does. */}
                    <span
                      className={cn(
                        "inline-flex items-center gap-4 h-24 px-8 rounded-sm shrink-0",
                        "text-label-xs",
                        launchDisabled
                          ? "text-fg-disabled"
                          : "bg-accent-subtle text-fg-accent",
                      )}
                    >
                      <Play size={12} />
                      {t("hero.launch")}
                    </span>
                  </button>
                ) : (
                  <button
                    key="new"
                    type="button"
                    role="menuitem"
                    data-index={index}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(index)}
                    className={cn(
                      "flex items-center gap-8 w-full h-32 px-12 text-left",
                      "text-body-sm text-fg transition-colors duration-100",
                      "cursor-pointer hover:bg-hover-overlay focus:bg-hover-overlay outline-none",
                      // Only when there is something above it: a menu of one
                      // line needs no rule to separate it from nothing.
                      clients.length > 0 && "mt-4 border-t border-line-subtle",
                    )}
                  >
                    <span className="flex items-center shrink-0">
                      <Plus size={14} />
                    </span>
                    <span className="flex-1 min-w-0 truncate">
                      {t("hero.newClient")}
                    </span>
                  </button>
                ),
              )}
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
 * the room above is larger; then it flips and is held by its bottom edge. The
 * left edge is clamped so that a hero pushed against the right of a narrow
 * window still opens a list the window holds.
 */
function place(rect: DOMRect): Anchor {
  const below = window.innerHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const flip = below < MAX_HEIGHT && above > below;
  const room = flip ? above : below;

  return {
    left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - EDGE - WIDTH)),
    top: flip ? undefined : rect.bottom + GAP,
    bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
    maxHeight: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, room)),
  };
}
