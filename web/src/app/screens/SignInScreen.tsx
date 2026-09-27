import { AlertTriangle, Share } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router";

import { ProviderButtons } from "../../../../src/components/account/ProviderButtons.tsx";
import { Logo } from "../../../../src/components/Logo.tsx";
import { Button } from "../../../../src/components/ui/index.ts";
import { onlineErrorCode, onlineErrorMessage, type OnlineProvider, type SignInStart } from "../../../../src/lib/ipc.ts";
import { useAccountState } from "../../../../src/lib/queries.ts";
import { DEFAULT_NEXT, safeNext } from "../../core/session.ts";
import { useSignInStatus, useWebCore } from "../CoreContext.tsx";

/** Safari on an iPhone, outside the installed app: sign-in belongs in the app. */
function iphoneInBrowser(): boolean {
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iOS && !standalone;
}

/** The frame of both sign-in pages: the mark, a card, nothing else. */
export function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <div className="safe-top safe-bottom flex min-h-full items-center justify-center overflow-y-auto bg-app px-16 py-32">
      <div className="flex w-full max-w-[420px] flex-col gap-20 rounded-xl border border-line bg-surface p-24 shadow-card">
        <div className="flex items-center gap-10">
          <Logo size={32} />
          <span className="font-display text-[18px] leading-[24px] font-medium tracking-[0.12em] text-fg">JKNET</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * `/signin`: Discord, JKHub, and the Developer sign-in against a local
 * service. The tab goes to the provider; `/signin/done` picks the answer up.
 * `?next=` is where the player was going, kept only when it stays in the app.
 */
export function SignInScreen() {
  const { t } = useTranslation("web");
  const { t: tAccount } = useTranslation("account");
  const core = useWebCore();
  const account = useAccountState().data;
  const status = useSignInStatus();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (account?.onlineSignedIn) {
    return <Navigate to={status.next ?? next ?? DEFAULT_NEXT} replace />;
  }

  const pick = (provider: OnlineProvider) => {
    setBusy(true);
    setError(null);
    core.backend
      .invoke<SignInStart>("begin_sign_in", { provider, next })
      .then((session) => {
        window.location.assign(session.url);
      })
      .catch((failure: unknown) => {
        setBusy(false);
        setError(
          onlineErrorCode(failure) === "provider_error"
            ? tAccount("providers.notAvailable", {
                provider: provider === "discord" ? tAccount("providers.discord") : tAccount("providers.jkhub"),
              })
            : onlineErrorMessage(failure),
        );
      });
  };

  const waiting = status.phase === "waiting";
  const failed = status.phase === "expired" || status.phase === "error";

  return (
    <SignInFrame>
      <div className="flex flex-col gap-6">
        <h1 className="text-display-md text-fg">{t("signin.title")}</h1>
        <p className="text-body-md text-fg-secondary">{t("signin.intro")}</p>
      </div>

      {iphoneInBrowser() ? (
        <p
          data-testid="install-first"
          className="flex items-start gap-10 rounded-[10px] border border-line-warm bg-warm-subtle px-12 py-10 text-body-sm text-fg"
        >
          <Share size={16} className="mt-2 shrink-0 text-fg-warm" />
          <span>{t("signin.installFirst")}</span>
        </p>
      ) : null}

      {error !== null || failed ? (
        <div role="alert" className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle p-12">
          <AlertTriangle size={16} className="mt-2 shrink-0 text-fg-warm" />
          <span className="text-body-sm text-fg break-words">
            {error ?? status.error ?? (status.phase === "expired" ? t("signin.expired") : t("signin.failed"))}
          </span>
        </div>
      ) : null}

      {waiting ? (
        <div className="flex flex-col gap-12">
          <p role="status" className="text-body-md text-fg-secondary">
            {t("signin.waiting")}
          </p>
          <Button
            variant="ghost"
            onClick={() => {
              void core.session.cancel();
              setBusy(false);
            }}
          >
            {t("signin.retry")}
          </Button>
        </div>
      ) : (
        <ProviderButtons onPick={pick} busy={busy} localOnline={account?.localOnline ?? false} />
      )}
    </SignInFrame>
  );
}
