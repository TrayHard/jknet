/**
 * The history the app made, and the rule of the phone's back button.
 *
 * The browser keeps no list of its entries a page may read, so the layout
 * keeps its own: every navigation the router reports is folded in with
 * `track`, keyed by the router's entry key. A reload starts the list over.
 *
 * The back button of the phone's top bar goes up, to the route's parent:
 * back through history when the entry before this one is the parent the app
 * itself put there, otherwise a replace with the parent. A thread opened from
 * a notification therefore goes up to the chat list instead of out of the
 * app, and a thread opened from the list goes back to the list with its
 * scroll position. The system back button walks the history as usual.
 *
 * The overlays of the phone — the drawer and the sheets — are history
 * entries of their own at the same address, told apart by `state.drawer` and
 * `state.sheet`, so the system back closes them. The hooks that manage them
 * are in `overlays.ts`; the rules are here, pure.
 */

export interface HistoryEntry {
  /** The router's key of the entry. */
  key: string;
  /** `pathname` of the entry; the query string does not make a new place. */
  path: string;
}

export interface HistoryModel {
  entries: HistoryEntry[];
  index: number;
}

export type NavigationKind = "PUSH" | "REPLACE" | "POP";

export function initialHistory(key: string, path: string): HistoryModel {
  return { entries: [{ key, path }], index: 0 };
}

/** The model after one navigation. */
export function track(model: HistoryModel, kind: NavigationKind, key: string, path: string): HistoryModel {
  if (kind === "PUSH") {
    const entries = [...model.entries.slice(0, model.index + 1), { key, path }];
    return { entries, index: entries.length - 1 };
  }
  if (kind === "REPLACE") {
    const entries = [...model.entries];
    entries[model.index] = { key, path };
    return { entries, index: model.index };
  }
  const found = model.entries.findIndex((entry) => entry.key === key);
  // An entry this page never saw: history from before a reload. The list
  // starts over from it, and "up" replaces until the app pushes again.
  if (found < 0) return initialHistory(key, path);
  return { entries: model.entries, index: found };
}

/** The path part of an address, for comparing places. */
export function pathOnly(address: string): string {
  const cut = address.search(/[?#]/);
  return cut < 0 ? address : address.slice(0, cut);
}

export type UpAction = { kind: "back" } | { kind: "replace"; path: string };

/** What the top bar's back button does on a route whose parent is `parent`. */
export function upAction(model: HistoryModel, parent: string): UpAction {
  const previous = model.index > 0 ? model.entries[model.index - 1] : undefined;
  if (previous !== undefined && pathOnly(previous.path) === pathOnly(parent)) return { kind: "back" };
  return { kind: "replace", path: parent };
}

/** The history state the phone's overlays keep on their entries. */
export interface OverlayState {
  drawer?: true;
  sheet?: string;
}

/** The overlay part of a router location's state, whatever else it holds. */
export function overlayOf(state: unknown): OverlayState {
  if (state === null || typeof state !== "object") return {};
  const value = state as Record<string, unknown>;
  const overlay: OverlayState = {};
  if (value.drawer === true) overlay.drawer = true;
  if (typeof value.sheet === "string") overlay.sheet = value.sheet;
  return overlay;
}

/**
 * Which open sheets a move through history closed: every sheet above the one
 * the current entry names, all of them when it names none. Sheets whose own
 * entry has not been pushed yet stay.
 */
export function sheetsClosedBy(stack: ReadonlyArray<{ token: string; pushed: boolean }>, current: string | undefined): string[] {
  const at = current === undefined ? -1 : stack.findIndex((sheet) => sheet.token === current);
  return stack
    .slice(at + 1)
    .filter((sheet) => sheet.pushed)
    .map((sheet) => sheet.token);
}
