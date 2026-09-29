import { createContext, use } from "react";

/**
 * What a screen may ask of the layout around it without knowing which one
 * it is: the way up of the phone's back button, for a screen that draws its
 * own header (the thread), and whether the wide layout is on.
 */
export interface LayoutActions {
  /** The phone's way up (`history.ts`); `null` in the wide layout, which has no back button. */
  up: (() => void) | null;
  /**
   * Leaves the route for its parent by the same rule in every layout: back
   * when the entry before is the parent, a replace otherwise. Closing the
   * details column or sheet so adds no history entry that Back would reopen.
   */
  close: () => void;
  wide: boolean;
}

export const LayoutActionsContext = createContext<LayoutActions>({ up: null, close: () => {}, wide: false });

export function useLayoutActions(): LayoutActions {
  return use(LayoutActionsContext);
}
