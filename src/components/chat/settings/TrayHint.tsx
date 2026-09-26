import { Settings as SettingsIcon } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useTrayHintEvent } from "../../../lib/queries";
import { useToasts } from "../../ToastsProvider";
import { Button } from "../../ui";

/** The id of the one toast. */
const TOAST_ID = "app:tray-hint";

/**
 * --- slice: chat notifications ---
 *
 * The first time the close button hides the launcher into the tray (D6),
 * the core shows a Windows notification saying where JKNet went and sends
 * `app:tray-hint`, once ever. This leaves a toast in the launcher window for
 * when the player brings it back: the same news, and the way to the switch
 * that makes the close button quit instead. It stays until dismissed — the
 * window is hidden when it arrives.
 *
 * Mounted by `AppShell`, inside the router, so **Settings** can go there.
 */
export function TrayHint() {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const { show, dismiss } = useToasts();

  const onHint = useCallback(() => {
    show(TOAST_ID, {
      variant: "info",
      title: t("trayHint.title"),
      text: t("trayHint.text"),
      onDismiss: () => dismiss(TOAST_ID),
      action: (
        <Button
          size="sm"
          variant="secondary"
          icon={<SettingsIcon size={14} />}
          onClick={() => {
            dismiss(TOAST_ID);
            void navigate("/settings?section=tray");
          }}
        >
          {t("trayHint.settings")}
        </Button>
      ),
    });
  }, [show, dismiss, navigate, t]);

  useTrayHintEvent(onHint);
  return null;
}
