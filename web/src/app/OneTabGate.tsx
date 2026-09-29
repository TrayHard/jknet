import { Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../../src/components/ui/index.ts";
import type { WebCore } from "../core/index.ts";
import { SignInFrame } from "./screens/SignInScreen.tsx";

type Phase = "checking" | "active" | "elsewhere";

/**
 * Starts the core in one tab only.
 *
 * The tab that gets the `jknet-active` lock starts the core and renders the
 * app. Any other tab shows "JKNet is open in another tab" with **Open
 * here**, which asks the holder to stop and takes the lock over; the tab that
 * lost it shows the same screen. A browser without Web Locks runs without
 * the gate.
 */
export function OneTabGate({ core, children }: { core: WebCore; children: ReactNode }) {
  const { t } = useTranslation("web");
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    let cancelled = false;
    const stop = core.tabs.subscribe((event) => {
      if (event === "lost") setPhase("elsewhere");
      // Another tab signed out: this one starts over on the sign-in.
      else window.location.reload();
    });
    // React runs this effect twice in development: both runs share the
    // gate's one lock request, and only the run still mounted starts the core.
    void core.tabs.tryAcquire().then(async (granted) => {
      if (cancelled) return;
      if (!granted) {
        setPhase("elsewhere");
        return;
      }
      await core.start();
      if (!cancelled) setPhase("active");
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [core]);

  if (phase === "active") return <>{children}</>;
  if (phase === "checking") return <div className="h-full bg-app" />;

  return (
    <SignInFrame>
      <div data-testid="tab-gate" className="flex flex-col gap-12">
        <h1 className="flex items-center gap-10 text-display-md text-fg">
          <Copy size={22} className="shrink-0 text-fg-secondary" />
          {t("tabs.title")}
        </h1>
        <p className="text-body-md text-fg-secondary">{t("tabs.body")}</p>
        <Button
          variant="primary"
          onClick={() => {
            setPhase("checking");
            void core.tabs
              .takeOver()
              .then(() => core.start())
              .then(() => setPhase("active"))
              .catch((error: unknown) => {
                console.warn("Taking the account over in this tab failed", error);
                setPhase("elsewhere");
              });
          }}
        >
          {t("tabs.takeOver")}
        </Button>
      </div>
    </SignInFrame>
  );
}
