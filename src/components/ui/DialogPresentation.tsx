import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../../lib/format";

/**
 * How the kit presents a dialog, a menu and a floating layer.
 *
 * `dialog` is the launcher's way: a centred card, a list hanging from its
 * trigger. `sheet` is a phone's: a panel that slides up from the bottom edge,
 * as wide as the screen and at most 88 % as high, over a scrim. The phone
 * layout of the web app provides `sheet`; the launcher provides nothing, so
 * every one of its dialogs and menus is drawn exactly as before.
 */
export type DialogPresentation = "dialog" | "sheet";

export const DialogPresentationContext = createContext<DialogPresentation>("dialog");

export function useDialogPresentation(): DialogPresentation {
  return useContext(DialogPresentationContext);
}

/**
 * Where an open sheet tells the layout about itself: the layout pushes a
 * history entry for it, so the system back closes the sheet, and answers a
 * function that drops the entry again when the sheet closes by itself.
 * `close` is what the back press runs. Without a provider nothing happens.
 */
export type SheetRegistrar = (close: () => void) => () => void;

export const SheetHistoryContext = createContext<SheetRegistrar | null>(null);

/** Registers a sheet with the layout while `open`. */
export function useSheetEntry(open: boolean, close: () => void): void {
  const register = useContext(SheetHistoryContext);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || register === null) return;
    return register(() => latest.current());
  }, [open, register]);
}

/** How long a sheet takes to slide up. */
const SLIDE_MS = 180;

interface SheetPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  /** The node the focus loop, the outside press and the tests look for. */
  panelRef?: Ref<HTMLDivElement>;
}

/**
 * The panel of a sheet: flush with the bottom edge, rounded 18 px at the top,
 * a grab handle, at most 88 % of the height, padded clear of the home
 * indicator, sliding up when it opens. The scrim and the semantics belong to
 * the caller, which knows whether it is a dialog or a menu.
 */
export function SheetPanel({ children, panelRef, className, ...rest }: SheetPanelProps) {
  const own = useRef<HTMLDivElement>(null);

  // Through the animation API rather than a keyframe of the style sheet, so
  // the launcher's CSS stays what it was. A player who asked for less motion
  // gets the panel in place at once.
  useLayoutEffect(() => {
    const node = own.current;
    if (node === null || typeof node.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    node.animate([{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], {
      duration: SLIDE_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }, []);

  return (
    <div
      {...rest}
      ref={(node) => {
        own.current = node;
        if (typeof panelRef === "function") panelRef(node);
        else if (panelRef) (panelRef as { current: HTMLDivElement | null }).current = node;
      }}
      className={cn(
        "w-full max-h-[88dvh] overflow-y-auto rounded-t-[18px] border-t border-line bg-surface shadow-popover",
        "pb-[max(16px,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      <div aria-hidden="true" className="mx-auto mt-8 mb-8 h-4 w-40 rounded-full bg-line-strong" />
      {children}
    </div>
  );
}
