import { createContext, use } from "react";

/**
 * What a screen may ask of the layout around it without knowing which one
 * it is: the way up of the phone's back button, for a screen that draws its
 * own header (the thread), and whether the wide layout is on.
 */
export interface LayoutActions {
  /** The phone's way up (`history.ts`); `null` in the wide layout, which has no back button. */
  up: (() => void) | null;
  wide: boolean;
}

export const LayoutActionsContext = createContext<LayoutActions>({ up: null, wide: false });

export function useLayoutActions(): LayoutActions {
  return use(LayoutActionsContext);
}
