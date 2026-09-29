import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router";

import { useAccountState } from "../../../../src/lib/queries.ts";
import { DEFAULT_NEXT } from "../../core/session.ts";
import { useSignInStatus, useWebCore } from "../CoreContext.tsx";
import { SignInFrame } from "./SignInScreen.tsx";

/**
 * `/signin/done`: where the service's success page sends the tab back.
 *
 * The core polls the pending sign-in from the moment the app starts; this
 * page only waits for the token and then opens the path the player was on
 * the way to, replacing itself in the history.
 */
export function SignInDoneScreen() {
  const { t } = useTranslation("web");
  const core = useWebCore();
  const account = useAccountState().data;
  const status = useSignInStatus();

  // A tab opened here without a pending sign-in in this browser — the link
  // was followed on another device, or the pending one ran out — has nothing
  // to wait for.
  useEffect(() => {
    if (status.phase === "idle" && account?.onlineSignedIn === false) void core.session.watchPending();
  }, [account?.onlineSignedIn, core, status.phase]);

  if (account?.onlineSignedIn) {
    return <Navigate to={status.next ?? DEFAULT_NEXT} replace />;
  }

  const failed = status.phase === "expired" || status.phase === "error";
  // No sign-in of this browser to wait for. The sign-in may well have
  // finished: in the installed app, which keeps storage of its own, or in
  // the browser that started it. So it says so, and offers a new one.
  const idle = status.phase === "idle" && account !== undefined;
  const again = status.next === null ? "/signin" : `/signin?next=${encodeURIComponent(status.next)}`;

  if (idle && !failed) {
    return (
      <SignInFrame>
        <div className="flex flex-col gap-16" data-testid="signin-elsewhere">
          <p role="status" className="text-body-md text-fg-secondary">
            {t("signin.doneElsewhere")}
          </p>
          <Link
            to={again}
            replace
            className="inline-flex h-36 items-center justify-center rounded-md border border-line px-16 text-body-md-medium text-fg hover:bg-hover-overlay"
          >
            {t("signin.signInHere")}
          </Link>
        </div>
      </SignInFrame>
    );
  }

  return (
    <SignInFrame>
      {failed ? (
        <div className="flex flex-col gap-16">
          <div role="alert" className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle p-12">
            <AlertTriangle size={16} className="mt-2 shrink-0 text-fg-warm" />
            <span className="text-body-sm text-fg break-words">
              {status.error ?? (status.phase === "expired" ? t("signin.expired") : t("signin.failed"))}
            </span>
          </div>
          <Link
            to={again}
            replace
            className="inline-flex h-36 items-center justify-center rounded-md bg-accent px-16 text-body-md-medium text-fg-on-accent hover:bg-accent-hover"
          >
            {t("signin.retry")}
          </Link>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-10 text-body-md text-fg-secondary">
          <Loader2 size={18} className="animate-spin" />
          {t("signin.done")}
        </p>
      )}
    </SignInFrame>
  );
}
