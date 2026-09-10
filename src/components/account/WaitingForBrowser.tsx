import { ExternalLink, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui";
import type { SignInFlow } from "../../lib/queries";

interface WaitingForBrowserProps {
  flow: SignInFlow;
}

/**
 * What the launcher shows while the player is in their browser.
 *
 * The address is printed as well as opened. Opening it can fail quietly — no
 * default browser, a browser that swallowed the call, a player who closed the
 * tab — and without the address on screen the only way out would be to cancel
 * and start again.
 */
export function WaitingForBrowser({ flow }: WaitingForBrowserProps) {
  const { t } = useTranslation("account");
  const { t: tCommon } = useTranslation("common");

  return (
    <div className="rounded-lg border border-line bg-surface p-16">
      <div className="flex items-center gap-12">
        <Loader2 size={20} className="text-fg-accent animate-spin shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-body-md-medium text-fg">{t("waiting.title")}</p>
          <p className="text-body-sm text-fg-secondary">{t("waiting.text")}</p>
        </div>
        <Button variant="ghost" onClick={flow.cancel}>
          {tCommon("actions.cancel")}
        </Button>
      </div>

      {flow.url ? (
        <p className="flex items-start gap-8 text-mono-xs text-fg-muted break-all pt-12">
          <ExternalLink size={14} className="shrink-0 mt-2" />
          <span>{flow.url}</span>
        </p>
      ) : null}
    </div>
  );
}
