import { Download, RefreshCw } from "lucide-react";
import { createContext, use, type ReactNode } from "react";

import { formatBytes } from "../lib/format";
import { useAppUpdate, type AppUpdate } from "../lib/useAppUpdate";
import { Button, Toast } from "./ui";

/**
 * Holds the one update check and draws its toast.
 *
 * The check has to survive a route change — the download runs for as long as
 * the package takes — so it lives above the router, next to the launch events.
 * The Settings screen reads the same state through the context instead of
 * starting a second check of its own.
 */
const AppUpdateContext = createContext<AppUpdate | null>(null);

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const update = useAppUpdate();
  return (
    <AppUpdateContext value={update}>
      {children}
      <UpdateToastHost update={update} />
    </AppUpdateContext>
  );
}

/**
 * The update state, or `null` outside the provider.
 *
 * `null` is a real answer, not a failure: a component may render in a test or
 * in a story without the provider around it.
 */
export function useAppUpdateContext(): AppUpdate | null {
  return use(AppUpdateContext);
}

/**
 * The toast in the bottom right corner.
 *
 * It appears only when a check found a version and the player has not closed
 * it. A failed check shows nothing here — that message belongs to the button
 * that asked for it, on the Settings screen — but a failed install does, for
 * the same reason: its button is in this toast.
 */
function UpdateToastHost({ update }: { update: AppUpdate }) {
  if (update.newVersion === null || update.dismissed) return null;

  const downloading =
    update.stage === "downloading" || update.stage === "installing";
  // An error here belongs in the toast: the button that failed is in it. The
  // failed check of the About card is a different story and stays there.
  const failed = update.stage === "error" && update.error !== null;

  return (
    <div className="fixed bottom-24 right-24 z-50 flex flex-col gap-12">
      <Toast
        variant={failed ? "error" : "info"}
        title={
          failed
            ? `Updating to JKNet ${update.newVersion} failed`
            : `JKNet ${update.newVersion} is available`
        }
        text={
          downloading ? (
            <DownloadProgress update={update} />
          ) : failed ? (
            update.error
          ) : undefined
        }
        action={
          downloading ? undefined : (
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={14} />}
              onClick={update.install}
            >
              {failed ? "Try again" : "Install and restart"}
            </Button>
          )
        }
        // While the package downloads there is nothing to close: the toast is
        // the only place the progress is shown, and the download does not stop
        // with it.
        onDismiss={downloading ? undefined : update.dismiss}
      />
    </div>
  );
}

/** The bar and the byte counter inside the toast. */
function DownloadProgress({ update }: { update: AppUpdate }) {
  const { downloaded, total } = update.progress ?? {
    downloaded: 0,
    total: null,
  };
  // A server that sends no content length leaves the bar full-width and the
  // counter honest: "12.4 MB", not a percentage invented out of nothing.
  const percent =
    total !== null && total > 0
      ? Math.min(100, Math.round((downloaded / total) * 100))
      : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="h-4 rounded-full bg-elevated overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-150"
          style={{ width: percent === null ? "100%" : `${percent}%` }}
        />
      </div>
      <span className="text-mono-xs text-fg-muted">
        {update.stage === "installing" ? (
          <span className="inline-flex items-center gap-4">
            <RefreshCw size={12} className="animate-spin" />
            Starting the installer…
          </span>
        ) : total === null ? (
          `Downloading… ${formatBytes(downloaded)}`
        ) : (
          `Downloading… ${formatBytes(downloaded)} of ${formatBytes(total)}`
        )}
      </span>
    </div>
  );
}
