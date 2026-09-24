import { createContext, useContext, useEffect, type RefObject } from "react";

/**
 * --- slice: pk3 contents ---
 * Whether something stands over the preview dialog — the enlarged picture —
 * and owns Escape for the moment.
 *
 * The frame of the preview closes on Escape from a capture listener on the
 * window, registered when the frame mounted; a listener the overlay adds
 * later runs after it, and by then the whole preview would be gone. So the
 * frame reads this flag first and stands aside while it is set.
 */
export const PreviewOverlayContext = createContext<RefObject<boolean>>({ current: false });

/** Sets the flag while `open`, and clears it on the way out. */
export function usePreviewOverlay(open: boolean): void {
  const overlay = useContext(PreviewOverlayContext);
  useEffect(() => {
    if (!open) return;
    overlay.current = true;
    return () => { overlay.current = false; };
  }, [overlay, open]);
}
