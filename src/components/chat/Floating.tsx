import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Which side of the anchor the layer opens on, and which edge it lines up with. */
export type FloatingPlacement = "top-start" | "top-end" | "bottom-start" | "bottom-end";

interface FloatingProps {
  /** What the layer hangs from. `null` keeps it closed. */
  anchor: HTMLElement | null;
  onClose: () => void;
  placement?: FloatingPlacement;
  /** Accessible name of the layer. */
  label: string;
  children: ReactNode;
}

/** Distance between the anchor and the layer, in pixels. */
const GAP = 6;
/** How close the layer may come to the edge of the window. */
const EDGE = 8;

/**
 * --- slice: chat ---
 *
 * A layer that floats next to a button: the emoji picker and the reaction
 * bar. The same mechanics as the list of `Menu` in the kit — a portal into
 * `document.body`, so the scrolling thread does not clip it, and it closes on
 * a press outside, on Escape and when the window loses focus — for content
 * that is not a list of actions.
 *
 * The layer flips to the other side of the anchor when it does not fit, and
 * is pushed inside the window across.
 */
export function Floating({ anchor, onClose, placement = "top-end", label, children }: FloatingProps) {
  const layer = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (anchor === null) return;
    const place = () => {
      const node = layer.current;
      if (node === null) return;
      const rect = anchor.getBoundingClientRect();
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const wantsTop = placement.startsWith("top");
      const roomAbove = rect.top - GAP - EDGE;
      const roomBelow = window.innerHeight - rect.bottom - GAP - EDGE;
      const top = wantsTop ? roomAbove >= height || roomAbove >= roomBelow : !(roomBelow >= height || roomBelow >= roomAbove);
      const y = top ? Math.max(EDGE, rect.top - GAP - height) : Math.min(window.innerHeight - EDGE - height, rect.bottom + GAP);
      const alignEnd = placement.endsWith("end");
      let x = alignEnd ? rect.right - width : rect.left;
      x = Math.min(Math.max(EDGE, x), window.innerWidth - EDGE - width);
      setStyle({ position: "fixed", left: x, top: y });
    };
    place();
    // The content may grow after it opens — the emoji picker loads its data
    // lazily — and a layer placed for its first size would hang off the edge.
    const observer = new ResizeObserver(place);
    if (layer.current !== null) observer.observe(layer.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, placement]);

  useEffect(() => {
    if (anchor === null) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (layer.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
        anchor.focus();
      }
    };
    const onBlur = () => close.current();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [anchor]);

  if (anchor === null) return null;
  return createPortal(
    <div ref={layer} role="dialog" aria-label={label} style={style} className="z-[70]">
      {children}
    </div>,
    document.body,
  );
}
