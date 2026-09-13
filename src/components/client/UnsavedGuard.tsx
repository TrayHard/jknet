import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Button, Dialog } from "../ui";

/** What a form and a window ask of the guard. */
interface Guard {
  /**
   * Whether the form on screen holds edits nobody has saved.
   *
   * Called by the form as its draft changes, and with `false` as it unmounts:
   * a guard that outlived the form it was guarding would refuse to let the
   * window close over a draft that is no longer there.
   */
  setDirty: (dirty: boolean) => void;
  isDirty: () => boolean;
  /**
   * Runs `next` at once when nothing is unsaved, and after the player agrees
   * to lose the edits when something is.
   */
  ask: (next: () => void, cancel?: () => void) => void;
}

const GuardContext = createContext<Guard | null>(null);

/**
 * The guard when there is none.
 *
 * A window without a provider — the browser of `npm run dev`, or any host that
 * has not wrapped this tree — lets everything through rather than throwing.
 * Nothing is lost in that case: there is no window to close either.
 */
const NO_GUARD: Guard = {
  setDirty: () => undefined,
  isDirty: () => false,
  ask: (next) => next(),
};

/** The guard of the surrounding window. */
export function useUnsavedGuard(): Guard {
  return useContext(GuardContext) ?? NO_GUARD;
}

/**
 * Holds the confirmation between a form with unsaved edits and whatever wants
 * to take that form off the screen.
 *
 * Form cancellation, navigation, client/game selection and window closing
 * share one confirmation. A pending navigation also supplies its reset action
 * so staying on the form cannot leave the router blocked.
 *
 * The flag lives in a ref and not in state on purpose: the window's
 * `onCloseRequested` handler is registered once and reads the flag much later,
 * and a value captured in that closure would be the value from the first
 * render forever.
 */
export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("clients");
  const dirty = useRef(false);
  const request = useRef<{ next: () => void; cancel?: () => void } | null>(null);
  const [pending, setPending] = useState(false);
  const isDirty = useCallback(() => dirty.current, []);

  const keep = useCallback(() => {
    const previous = request.current;
    request.current = null;
    setPending(false);
    previous?.cancel?.();
  }, []);

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
    // A completed save or an unmounted form must not leave a stale action.
    if (!value) keep();
  }, [keep]);

  const ask = useCallback((next: () => void, cancel?: () => void) => {
    if (request.current !== null) {
      // The first intent wins while its dialog is open. Release any later
      // router attempt instead of leaving it blocked behind this question.
      if (request.current.next !== next) cancel?.();
      return;
    }
    if (!dirty.current) {
      next();
      return;
    }
    request.current = { next, cancel };
    setPending(true);
  }, []);

  const value = useMemo(() => ({ setDirty, isDirty, ask }), [setDirty, isDirty, ask]);

  const discard = () => {
    const previous = request.current;
    request.current = null;
    setPending(false);
    // The form clears dirty when it unmounts. An asynchronous game switch
    // can fail, in which case the still-visible draft must remain guarded.
    previous?.next();
  };

  return (
    <GuardContext.Provider value={value}>
      {children}
      {pending ? (
        <Dialog
          variant="danger"
          title={t("clientWindow.profiles.unsaved.title")}
          body={t("clientWindow.profiles.unsaved.body")}
          // Escape and a click outside mean «I did not mean to leave», which
          // is the safe half of this question.
          onClose={keep}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={keep}>
                {t("clientWindow.profiles.unsaved.keep")}
              </Button>
              <Button size="sm" variant="danger" onClick={discard}>
                {t("clientWindow.profiles.unsaved.discard")}
              </Button>
            </>
          }
        />
      ) : null}
    </GuardContext.Provider>
  );
}
