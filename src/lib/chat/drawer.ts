/**
 * --- slice: chat layout ---
 *
 * The state of the chat drawer of the main window (layout B), as a reducer
 * with no React in it, so the rules can be tested on their own:
 *
 * - **Message**, a toast, the core's `chat:open`: the drawer opens on that
 *   conversation, or on the list without one.
 * - The title-bar button toggles it, and reopening keeps the level it was
 *   closed on: the same thread, or the list.
 * - Every request to show the drawer counts, so the drawer moves the focus in
 *   even when it was open already.
 * - **Pin** clicked in this run wins over the setting read from
 *   `settings.json` until the next launch; before the first click the setting
 *   decides. Whether the drawer is open is never kept.
 */

export interface DrawerState {
  open: boolean;
  /** The conversation of the thread level, or `null` for the list. */
  conversationId: string | null;
  /** Grows by one on every request to show the drawer. */
  openCount: number;
  /** The pin as clicked in this run, or `null` before any click. */
  pinnedHere: boolean | null;
}

export type DrawerAction =
  | { type: "open"; conversationId: string | null }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "select"; conversationId: string | null }
  | { type: "pin"; pinned: boolean };

export const INITIAL_DRAWER: DrawerState = {
  open: false,
  conversationId: null,
  openCount: 0,
  pinnedHere: null,
};

export function drawerReducer(state: DrawerState, action: DrawerAction): DrawerState {
  switch (action.type) {
    case "open":
      return {
        ...state,
        open: true,
        conversationId: action.conversationId,
        openCount: state.openCount + 1,
      };
    case "close":
      return state.open ? { ...state, open: false } : state;
    case "toggle":
      return state.open
        ? { ...state, open: false }
        : { ...state, open: true, openCount: state.openCount + 1 };
    case "select":
      return state.conversationId === action.conversationId
        ? state
        : { ...state, conversationId: action.conversationId };
    case "pin":
      return state.pinnedHere === action.pinned ? state : { ...state, pinnedHere: action.pinned };
  }
}

/**
 * Whether the drawer is docked beside the page: the click of this run, else
 * `chatDrawerPinned` of the settings. A missing setting — a core that
 * predates the field, or settings not read yet — reads as floating.
 */
export function drawerPinned(state: DrawerState, saved: boolean | undefined): boolean {
  return state.pinnedHere ?? saved === true;
}
