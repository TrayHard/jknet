import { Download, X } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Button } from "../../../src/components/ui/index.ts";
import { useWebCore } from "./CoreContext.tsx";
import { installState, needsHomeScreen, promptInstall, subscribeInstall } from "./install.ts";

/**
 * The install hint above the chat list, until the player installs the app
 * or puts the hint away (remembered on this device).
 *
 * - The browser offered the install (Chromium): **Install** asks it.
 * - iPhone or iPad in a tab: notifications need the app on the Home Screen;
 *   **Show me how** opens the steps.
 * - Anywhere else nothing shows: the browser's own menu installs.
 */
export function InstallPrompt() {
  const { t } = useTranslation("web");
  const core = useWebCore();
  const state = useSyncExternalStore(subscribeInstall, installState, installState);
  const [hidden, setHidden] = useState(() => core.prefs.get("installHintHidden") === true);

  const ios = needsHomeScreen(state);
  if (hidden || state.standalone || state.installed || !(state.canPrompt || ios)) return null;

  const hide = () => {
    setHidden(true);
    void core.prefs.set("installHintHidden", true);
  };

  return (
    <div
      role="status"
      data-testid="install-prompt"
      className="flex shrink-0 items-center gap-12 border-b border-line-accent bg-accent-subtle px-16 py-8"
    >
      <Download size={16} className="shrink-0 text-fg-accent" />
      <span className="min-w-0 flex-1 text-body-sm text-fg">{ios ? t("install.bannerIos") : t("install.banner")}</span>
      {ios ? (
        <Link to="/settings/install" className="shrink-0 text-body-sm-medium text-fg-accent hover:underline">
          {t("install.how")}
        </Link>
      ) : (
        <Button size="sm" variant="primary" onClick={() => void promptInstall().catch(() => undefined)}>
          {t("install.action")}
        </Button>
      )}
      <button
        type="button"
        onClick={hide}
        aria-label={t("install.hide")}
        title={t("install.hide")}
        className="flex size-32 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-hover-overlay"
      >
        <X size={16} />
      </button>
    </div>
  );
}
