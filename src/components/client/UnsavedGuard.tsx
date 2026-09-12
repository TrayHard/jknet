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
  /**
   * Runs `next` at once when nothing is unsaved, and after the player agrees
   * to lose the edits when something is.
   */
  ask: (next: () => void) => void;
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
 * Two things want to: the **Cancel** button of the profile form, which is how
 * a player goes back to the list and on to another profile, and the close
 * button of the window, which takes the whole page with it. Both ask the same
 * question through [`Guard.ask`], and both get the same dialog, because losing
 * a half-written profile feels the same either way.
 *
 * The flag lives in a ref and not in state on purpose: the window's
 * `onCloseRequested` handler is registered once and reads the flag much later,
 * and a value captured in that closure would be the value from the first
 * render forever.
 */
export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("clients");
  const dirty = useRef(false);
  /** What runs once the player says the edits may go. */
  const [pending, setPending] = useState<(() => void) | null>(null);

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  const ask = useCallback((next: () => void) => {
    if (!dirty.current) {
      next();
      return;
    }
    // Wrapped in a function of its own: `useState` calls a function it is
    // handed rather than storing it.
    setPending(() => next);
  }, []);

  const value = useMemo(() => ({ setDirty, ask }), [setDirty, ask]);

  const discard = () => {
    const next = pending;
    // Before the action, not after: closing the window unmounts nothing in
    // time, and a flag still raised would meet the next close request.
    dirty.current = false;
    setPending(null);
    next?.();
  };

  return (
    <GuardContext.Provider value={value}>
      {children}
      {pending !== null ? (
        <Dialog
          variant="danger"
          title={t("clientWindow.profiles.unsaved.title")}
          body={t("clientWindow.profiles.unsaved.body")}
          // Escape and a click outside mean «I did not mean to leave», which
          // is the safe half of this question.
          onClose={() => setPending(null)}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
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
