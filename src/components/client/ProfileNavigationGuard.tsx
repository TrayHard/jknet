import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { Outlet, useBlocker } from "react-router";

import { isTauri } from "../../lib/runtime";
import { logWindowFailure } from "../../lib/windowLog";
import { UnsavedGuardProvider, useUnsavedGuard } from "./UnsavedGuard";

/** Keeps the draft guard alive across all main-window navigation. */
export function ProfileNavigationGuard() {
  return (
    <UnsavedGuardProvider>
      <NavigationGuard />
      <Outlet />
    </UnsavedGuardProvider>
  );
}

function NavigationGuard() {
  const guard = useUnsavedGuard();
  const blocker = useBlocker(() => guard.isDirty());

  useEffect(() => {
    if (blocker.state === "blocked") guard.ask(blocker.proceed, blocker.reset);
  }, [blocker, guard]);

  useEffect(() => {
    let approved = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (approved || !guard.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    if (!isTauri()) return () => window.removeEventListener("beforeunload", beforeUnload);

    let gone = false;
    let stop: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow.onCloseRequested((event) => {
      event.preventDefault();
      guard.ask(() => {
        if (approved) return;
        approved = true;
        void appWindow.destroy().catch((error: unknown) => {
          approved = false;
          logWindowFailure("destroy", error);
        });
      });
    }).then((off) => {
      if (gone) off();
      else stop = off;
    }).catch((error: unknown) => logWindowFailure("onCloseRequested", error));
    return () => {
      gone = true;
      stop?.();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [guard]);

  return null;
}
