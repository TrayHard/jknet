import { createContext, use, type ReactNode } from "react";

import { useLevelshotEvents, useSettings } from "../lib/queries";
import { useGameEvents, type GameEvents } from "../lib/useGameEvents";

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
});

export function GameEventsProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const events = useGameEvents(settings.data?.closeOnLaunch ?? false);
  // --- slice: maps ---
  // `levelshots:changed` belongs to the same one place above the screens: a
  // rebuild may give a map a picture while another screen is showing it.
  useLevelshotEvents();
  return <GameEventsContext value={events}>{children}</GameEventsContext>;
}

/** Install progress and the running game, as collected from the events. */
export function useGameEventsContext(): GameEvents {
  return use(GameEventsContext);
}
