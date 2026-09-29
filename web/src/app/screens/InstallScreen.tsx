import { CheckCircle2, Download, Info } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../../../src/components/ui/index.ts";
import { installState, needsHomeScreen, promptInstall, subscribeInstall } from "../install.ts";
import { HomeScreenSteps } from "../InstallSteps.tsx";

/**
 * Settings · Install the app. Installed, JKNet opens from the home screen in
 * its own window and gets notifications on every platform, the iPhone
 * included.
 *
 * - Installed already: says so.
 * - The browser offered the install (Chromium): **Install** asks it.
 * - iPhone or iPad in a tab: the Share → Add to Home Screen steps.
 * - Anything else: where the browser keeps its own install command.
 */
export function InstallScreen() {
  const { t } = useTranslation("web");
  const state = useSyncExternalStore(subscribeInstall, installState, installState);
  const [asking, setAsking] = useState(false);

  const install = () => {
    setAsking(true);
    void promptInstall()
      .catch((error: unknown) => console.warn("The install prompt failed", error))
      .finally(() => setAsking(false));
  };

  return (
    <div data-testid="install-screen" className="flex max-w-[640px] flex-col gap-16 px-16 py-24 sm:px-40 sm:py-32">
      {state.standalone || state.installed ? (
        <p role="status" className="flex items-start gap-8 text-body-md text-fg">
          <CheckCircle2 size={18} className="mt-2 shrink-0 text-fg-success" />
          <span>{t("install.installed")}</span>
        </p>
      ) : (
        <>
          <p className="text-body-md text-fg-secondary">{t("install.body")}</p>
          {needsHomeScreen(state) ? (
            <HomeScreenSteps />
          ) : state.canPrompt ? (
            <Button variant="primary" icon={<Download size={16} />} className="self-start" disabled={asking} onClick={install}>
              {t("install.action")}
            </Button>
          ) : (
            <p className="flex items-start gap-8 text-body-sm text-fg-muted">
              <Info size={16} className="mt-2 shrink-0" />
              <span>{t("install.manual")}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
