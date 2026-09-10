import { Navigate, Outlet, useLocation } from "react-router";

import { useSettings } from "../../lib/queries";
import { isTauri } from "../../lib/runtime";

/** Where a player who has not finished the first run is sent. */
export const ONBOARDING_ROUTE = "/onboarding";

/**
 * Keeps a launcher that has never been set up on the first run.
 *
 * It wraps the screens rather than living inside them, so a hash typed by hand
 * — `#/servers` on a machine with no game folder — lands on the setup too.
 *
 * Two cases deliberately let the player through. A settings read that failed
 * says nothing about whether the setup ran, and holding a player on a wizard
 * whose every button fails helps nobody: the screens print the error
 * themselves. Outside the Tauri runtime the read cannot even be attempted, so
 * `npm run dev` in a browser goes straight to the screens and their error
 * alerts rather than to a blank frame that never resolves.
 *
 * The waiting frame is a blank drag region rather than a spinner: the answer
 * takes one IPC hop and a spinner would only flash, but the window still has
 * to be draggable while it happens.
 */
export function OnboardingGate() {
  const settings = useSettings();
  const location = useLocation();

  if (isTauri() && settings.isPending) {
    return <div className="h-full bg-app" data-tauri-drag-region />;
  }

  const unfinished = settings.data !== undefined && !settings.data.onboardingCompleted;
  if (unfinished && location.pathname !== ONBOARDING_ROUTE) {
    return <Navigate to={ONBOARDING_ROUTE} replace />;
  }

  return <Outlet />;
}
