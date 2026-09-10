/**
 * The launcher updating itself.
 *
 * The player installs JKNet once and never visits a download page again: the
 * running launcher asks GitHub Releases for a signed `latest.json`, and the
 * Tauri updater verifies the minisign signature before it hands the installer
 * anything. This hook is the whole frontend side of that — the check, the
 * download progress and the restart.
 *
 * Mount it once, in `AppUpdateProvider`. Outside the Tauri runtime it reports
 * "unsupported" and never calls anything: `npm run dev` in a browser has no
 * updater to ask.
 */

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "./ipc";
import { isTauri } from "./runtime";

/** How long the window has to itself before the first check goes out. */
const FIRST_CHECK_DELAY_MS = 5000;

export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

/** Bytes of the update package, as far as the download has reported them. */
export interface UpdateProgress {
  downloaded: number;
  /** `null` until the server sends a content length, which it may never do. */
  total: number | null;
}

export interface AppUpdate {
  /** Version of the running launcher, or `null` before it is read. */
  currentVersion: string | null;
  /** Version waiting on the server, set once a check finds one. */
  newVersion: string | null;
  /** Release notes of that version, when the manifest carries any. */
  notes: string | null;
  /** Whether the player closed the toast for this version. */
  dismissed: boolean;
  stage: UpdateStage;
  /** Message of the last failure, shown only after a manual check. */
  error: string | null;
  /** `Date.now()` of the last check that reached the endpoint, else `null`. */
  checkedAt: number | null;
  progress: UpdateProgress | null;
  /** True while a check or a download is in flight. */
  busy: boolean;
  /** Whether the runtime can update at all. False in a plain browser. */
  supported: boolean;
  /** Runs a check the player asked for: failures become visible. */
  check: () => void;
  /** Downloads the update, installs it and restarts the launcher. */
  install: () => void;
  /** Hides the toast until the next check finds the update again. */
  dismiss: () => void;
}

/**
 * Checks for an update once at startup and whenever `check()` is called.
 *
 * Two rules keep a broken endpoint harmless. The startup check swallows its
 * error into the log, because a player who did not ask a question must not be
 * shown an answer; and every call goes through `running`, so a second click
 * cannot start a second download of the same package.
 */
export function useAppUpdate(): AppUpdate {
  const supported = isTauri();

  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [stage, setStage] = useState<UpdateStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [pending, setPending] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  // A ref, not the stage: two clicks in the same frame would both read the
  // stage before either render lands and both start a download.
  const running = useRef(false);
  // Held across renders so a dismissed toast does not leak the update handle.
  const held = useRef<Update | null>(null);

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    getVersion()
      .then((version) => {
        if (!disposed) setCurrentVersion(version);
      })
      .catch((e: unknown) =>
        console.warn(`Reading the app version failed: ${errorMessage(e)}`),
      );
    return () => {
      disposed = true;
    };
  }, [supported]);

  /**
   * Asks the endpoint once.
   *
   * `quiet` is what separates the startup check from the button. The endpoint
   * may be a placeholder, the player may be offline, GitHub may be down: none
   * of that is worth a red toast nobody asked for.
   */
  const runCheck = useCallback(
    (quiet: boolean) => {
      if (!supported || running.current) return;
      running.current = true;
      setError(null);
      setStage("checking");
      check()
        .then((update) => {
          setCheckedAt(Date.now());
          if (update === null) {
            setStage("idle");
            setPending(null);
            return;
          }
          held.current?.close().catch(() => {});
          held.current = update;
          setPending(update);
          setDismissed(false);
          setStage("available");
        })
        .catch((e: unknown) => {
          const message = errorMessage(e);
          console.warn(`Update check failed: ${message}`);
          if (quiet) {
            setStage("idle");
            return;
          }
          setError(message);
          setStage("error");
        })
        .finally(() => {
          running.current = false;
        });
    },
    [supported],
  );

  // The window belongs to the player for the first seconds: a check competes
  // for the network with the server list the Home screen is already loading.
  useEffect(() => {
    if (!supported) return;
    const timer = window.setTimeout(() => runCheck(true), FIRST_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [supported, runCheck]);

  const install = useCallback(() => {
    const update = held.current;
    if (!supported || update === null || running.current) return;
    running.current = true;
    setError(null);
    setProgress({ downloaded: 0, total: null });
    setStage("downloading");

    let downloaded = 0;
    update
      .downloadAndInstall((event) => {
        if (event.event === "Started") {
          downloaded = 0;
          setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
          return;
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress((current) => ({
            downloaded,
            total: current?.total ?? null,
          }));
          return;
        }
        setStage("installing");
      })
      // On Windows this line is rarely reached: `downloadAndInstall` starts
      // the NSIS installer and exits the app, and the installer starts the new
      // build itself. It stays because it is the documented ending everywhere
      // else, and because an installer that returns without exiting must not
      // leave the old build running.
      .then(() => relaunch())
      .catch((e: unknown) => {
        setError(errorMessage(e));
        setStage("error");
        setProgress(null);
        running.current = false;
      });
  }, [supported]);

  const dismiss = useCallback(() => setDismissed(true), []);
  const checkNow = useCallback(() => runCheck(false), [runCheck]);

  return {
    currentVersion,
    newVersion: pending?.version ?? null,
    notes: pending?.body ?? null,
    dismissed,
    stage,
    error,
    checkedAt,
    progress,
    busy: stage === "checking" || stage === "downloading" || stage === "installing",
    supported,
    check: checkNow,
    install,
    dismiss,
  };
}
