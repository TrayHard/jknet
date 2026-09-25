import { Download, RefreshCw } from "lucide-react";
import { createContext, use, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useFormat } from "../i18n/useFormat";
// --- slice: play with friends ---
import { useHostSession } from "../lib/queries";
import { useAppUpdate, type AppUpdate } from "../lib/useAppUpdate";
// --- slice: play with friends ---
import { isHostLive } from "./host/hostModel";
// --- slice: friends ---
import { ToastSlot } from "./ToastsProvider";
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

// --- slice: play with friends ---
/**
 * Whether installing an update has to wait for the private server.
 *
 * The install restarts the launcher, and the launcher going down stops the
 * server under the people on it. So while a server lives, **Install** is off
 * with **Stop your server to install the update.**, in the toast and on the
 * About card alike.
 */
export function useUpdateBlockedByHost(): boolean {
  return isHostLive(useHostSession().data);
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
  const { t } = useTranslation("update");
  const { t: tCommon } = useTranslation("common");
  // --- slice: play with friends ---
  const { t: tHost } = useTranslation("host");
  const hosting = useUpdateBlockedByHost();
  if (update.newVersion === null || update.dismissed) return null;

  const downloading =
    update.stage === "downloading" || update.stage === "installing";
  // An error here belongs in the toast: the button that failed is in it. The
  // failed check of the About card is a different story and stays there.
  const failed = update.stage === "error" && update.error !== null;

  return (
    // --- slice: friends ---
    // The corner moved into `ToastsProvider` so the update notice and an
    // invitation share one column instead of covering each other.
    <ToastSlot>
      <Toast
        variant={failed ? "error" : "info"}
        title={
          failed
            ? t("failedTitle", { version: update.newVersion })
            : t("available", { version: update.newVersion })
        }
        text={
          downloading ? (
            <DownloadProgress update={update} />
          ) : failed ? (
            update.error
          ) : hosting ? (
            // --- slice: play with friends ---
            tHost("update.blocked")
          ) : undefined
        }
        action={
          downloading ? undefined : (
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={14} />}
              // --- slice: play with friends ---
              disabled={hosting}
              title={hosting ? tHost("update.blocked") : undefined}
              onClick={update.install}
            >
              {failed ? tCommon("actions.tryAgain") : t("install")}
            </Button>
          )
        }
        // While the package downloads there is nothing to close: the toast is
        // the only place the progress is shown, and the download does not stop
        // with it.
        onDismiss={downloading ? undefined : update.dismiss}
      />
    </ToastSlot>
  );
}

/** The bar and the byte counter inside the toast. */
function DownloadProgress({ update }: { update: AppUpdate }) {
  const { t } = useTranslation("update");
  const format = useFormat();
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
            {t("installing")}
          </span>
        ) : total === null ? (
          t("downloading", { received: format.bytes(downloaded) })
        ) : (
          t("downloadingOf", {
            received: format.bytes(downloaded),
            total: format.bytes(total),
          })
        )}
      </span>
    </div>
  );
}
