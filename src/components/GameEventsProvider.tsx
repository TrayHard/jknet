import { createContext, use, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { LaunchWarningCode } from "../lib/ipc";
import { useLevelshotEvents, useSettings } from "../lib/queries";
import { useGameEvents, type GameEvents } from "../lib/useGameEvents";
import { useToasts } from "./ToastsProvider";

/**
 * Holds the one subscription to the `launch:*` events.
 *
 * Engine installs report through an event, not through the answer of the
 * command, so a card that mounts halfway through an install still sees the
 * progress. That only works if somebody is listening the whole time, above
 * the screens — which is this.
 */
const GameEventsContext = createContext<GameEvents>({
  installs: {},
  clearInstall: () => {},
  warning: null,
});

export function GameEventsProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const events = useGameEvents(settings.data?.closeOnLaunch ?? false);
  // --- slice: maps ---
  // `levelshots:changed` belongs to the same one place above the screens: a
  // rebuild may give a map a picture while another screen is showing it.
  useLevelshotEvents();
  useLaunchWarningToast(events.warning);
  return <GameEventsContext value={events}>{children}</GameEventsContext>;
}

/** Install progress and the running game, as collected from the events. */
export function useGameEventsContext(): GameEvents {
  return use(GameEventsContext);
}

/**
 * The sentence behind a launch warning, by its code.
 *
 * A table rather than a key built out of the code: the codes are the core's
 * spelling and the keys are the catalog's, and a mapping written down is a
 * mapping `npm run typecheck` can check. A new code that nobody translated
 * fails to compile here, which is the right place to find out.
 */
const WARNING_KEYS = {
  eternaljk_s_initsound: "launchWarning.eternaljkSInitsound",
} as const satisfies Record<LaunchWarningCode, `launchWarning.${string}`>;

/**
 * Shows the core's warning about a command line as a toast.
 *
 * The launcher does not edit what the player typed into **Extra launch
 * arguments** and does not refuse to start the game over it. It says what it
 * knows and gets out of the way, which is what a toast is for.
 */
function useLaunchWarningToast(warning: GameEvents["warning"]): void {
  const { t } = useTranslation("clients");
  const toasts = useToasts();
  const show = toasts.show;

  useEffect(() => {
    if (warning === null) return;
    show(`launch-warning:${warning.clientId}`, {
      variant: "error",
      title: t("launchWarning.title"),
      text: t(WARNING_KEYS[warning.code]),
    });
  }, [show, t, warning]);
}
