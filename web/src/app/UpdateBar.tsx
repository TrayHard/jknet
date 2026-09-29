import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../../src/components/ui/index.ts";
import { applyUpdate, subscribeUpdate, updateState } from "./pwa.ts";

/**
 * **Update** while a new version waits, and a screen that blocks everything
 * when this build is older than the service allows.
 */
export function UpdateBar() {
  const { t } = useTranslation("web");
  const state = useSyncExternalStore(subscribeUpdate, updateState, updateState);
  const blocking = useRef<HTMLDivElement>(null);

  // The blocking screen takes the focus, and Tab stays on its one button:
  // nothing behind it may be used.
  useEffect(() => {
    if (!state.required) return;
    blocking.current?.querySelector("button")?.focus();
  }, [state.required]);

  if (state.required) {
    return (
      <div
        ref={blocking}
        role="alertdialog"
        aria-modal="true"
        aria-label={t("update.required")}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          blocking.current?.querySelector("button")?.focus();
        }}
        className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim px-24"
      >
        <div className="flex max-w-[360px] flex-col items-center gap-16 rounded-xl border border-line bg-surface p-24 text-center">
          <p className="text-body-md text-fg">{t("update.required")}</p>
          <Button variant="primary" icon={<RefreshCw size={16} />} onClick={applyUpdate}>
            {t("update.action")}
          </Button>
        </div>
      </div>
    );
  }
  if (!state.waiting) return null;
  return (
    <div
      role="status"
      data-testid="update-bar"
      className="flex shrink-0 items-center gap-12 border-b border-line-accent bg-accent-subtle px-16 py-8"
    >
      <span className="min-w-0 flex-1 text-body-sm text-fg">{t("update.available")}</span>
      <Button size="sm" variant="primary" onClick={applyUpdate}>
        {t("update.action")}
      </Button>
    </div>
  );
}
