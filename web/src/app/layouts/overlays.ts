/**
 * The history entries of the phone's overlays, and the app's own record of
 * the history for the back button.
 *
 * The rules are in `history.ts`; these hooks hold the state between renders.
 */

import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType, type Location } from "react-router";

import type { SheetRegistrar } from "../../../../src/components/ui/DialogPresentation.tsx";
import {
  initialHistory,
  overlayOf,
  sheetsClosedBy,
  track,
  upAction,
  type HistoryModel,
} from "./history.ts";

/** Folds every navigation of the router into the app's record of the history. */
export function useHistoryModel(): { readonly current: HistoryModel } {
  const location = useLocation();
  const kind = useNavigationType();
  const model = useRef<HistoryModel | null>(null);
  const seen = useRef(location.key);
  if (model.current === null) model.current = initialHistory(location.key, location.pathname);

  useEffect(() => {
    if (location.key === seen.current || model.current === null) return;
    seen.current = location.key;
    model.current = track(model.current, kind, location.key, location.pathname);
  }, [location.key, location.pathname, kind]);

  return model as { readonly current: HistoryModel };
}

/** The phone's back button: back to the parent the app pushed, or a replace with it. */
export function useUp(model: { readonly current: HistoryModel }, parent: string | undefined): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    if (parent === undefined) return;
    const action = upAction(model.current, parent);
    if (action.kind === "back") void navigate(-1);
    else void navigate(action.path, { replace: true });
  }, [model, navigate, parent]);
}

function here(location: Location): string {
  return `${location.pathname}${location.search}`;
}

/**
 * The drawer of the phone as a history entry: opening pushes the same
 * address with `state.drawer`, the system back pops it, a close by the user
 * goes back, and a chosen section replaces the entry, so back from that
 * section returns to where the drawer was opened.
 */
export function useDrawerHistory() {
  const navigate = useNavigate();
  const location = useLocation();
  const open = overlayOf(location.state).drawer === true;

  const openDrawer = useCallback(() => {
    if (open) return;
    void navigate(here(location), { state: { drawer: true } });
  }, [location, navigate, open]);

  const closeDrawer = useCallback(() => {
    if (open) void navigate(-1);
  }, [navigate, open]);

  const choose = useCallback(
    (path: string) => {
      if (!open) {
        void navigate(path);
        return;
      }
      if (path === location.pathname) void navigate(-1);
      else void navigate(path, { replace: true });
    },
    [location.pathname, navigate, open],
  );

  return { open, openDrawer, closeDrawer, choose };
}

interface OpenSheet {
  token: string;
  close: () => void;
  pushed: boolean;
}

let sheetCounter = 0;

/**
 * The phone's registrar of sheets: each open sheet gets a history entry of
 * its own, the system back closes the one on top, and a sheet that closes by
 * itself takes its entry back.
 */
export function useSheetRegistrar(): SheetRegistrar {
  const navigate = useNavigate();
  const location = useLocation();
  const latest = useRef(location);
  latest.current = location;
  const stack = useRef<OpenSheet[]>([]);

  useEffect(() => {
    const current = overlayOf(location.state).sheet;
    for (const sheet of stack.current) {
      if (sheet.token === current) sheet.pushed = true;
    }
    const closed = sheetsClosedBy(stack.current, current);
    if (closed.length === 0) return;
    const closing = stack.current.filter((sheet) => closed.includes(sheet.token));
    stack.current = stack.current.filter((sheet) => !closed.includes(sheet.token));
    for (const sheet of closing.reverse()) sheet.close();
  }, [location]);

  // Leaving the phone layout closes nothing by itself: the entries of open
  // sheets go with it.
  useEffect(
    () => () => {
      stack.current = [];
    },
    [],
  );

  return useCallback(
    (close: () => void) => {
      sheetCounter += 1;
      const token = `sheet-${Date.now().toString(36)}-${sheetCounter}`;
      stack.current.push({ token, close, pushed: false });
      const at = latest.current;
      const state = at.state !== null && typeof at.state === "object" ? (at.state as Record<string, unknown>) : {};
      void navigate(here(at), { state: { ...state, sheet: token } });
      return () => {
        const index = stack.current.findIndex((sheet) => sheet.token === token);
        if (index < 0) return;
        stack.current.splice(index, 1);
        if (overlayOf(latest.current.state).sheet === token) void navigate(-1);
      };
    },
    [navigate],
  );
}
